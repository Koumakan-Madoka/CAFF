const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { withTempDir } = require('../helpers/temp-dir');
const {
  createBadcaseCaptureService,
} = require('../../build/server/domain/runtime/badcase-capture/index');
const {
  normalizeCapturePolicy,
  isAuthorizedDir,
  CAPTURE_POLICY_DEFAULTS,
} = require('../../build/server/domain/runtime/badcase-capture/capture-policy');
const {
  containsSecretSentinel,
  replaceControlledVariables,
  listControlledReplayVariables,
} = require('../../build/server/domain/runtime/badcase-capture/secrets');

const SENTINEL = 'sk-testsecret0123456789abcdef';

function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

function gitAddAll(dir) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
}

function makeService(tempDir, serviceOptions = {}) {
  return createBadcaseCaptureService({
    captureRoot: path.join(tempDir, 'capture-root'),
    ...serviceOptions,
  });
}

function enabledPolicy(projectDir, overrides = {}) {
  return {
    status: 'enabled',
    authorizedDirs: [projectDir],
    ...overrides,
  };
}

function captureArgs(projectDir, overrides = {}) {
  return {
    projectId: 'project-1',
    targetDir: projectDir,
    conversationId: 'conv-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    deliveryMode: 'fresh',
    prompt: 'hello prompt',
    controlledValues: {},
    environment: { platform: process.platform },
    runConfig: { provider: 'test-provider', model: 'test-model', promptVersion: 'test-v1' },
    harness: {
      serverVersion: 'test-server',
      configSnapshot: { agentPromptVersion: 'test-v1', toolBridgeEnabled: true },
      skillSnapshots: [],
    },
    ...overrides,
  };
}

test('policy 默认 disabled 且含默认期限/配额/排除清单', () => {
  const policy = normalizeCapturePolicy({}, 'project-1');
  assert.equal(policy.status, 'disabled');
  assert.equal(policy.stagingRetentionDays, CAPTURE_POLICY_DEFAULTS.stagingRetentionDays);
  assert.equal(policy.stagingQuotaBytes, CAPTURE_POLICY_DEFAULTS.stagingQuotaBytes);
  assert.deepEqual(policy.excludedPatterns, ['.git', 'node_modules']);

  const enabled = normalizeCapturePolicy({ enabled: true, authorizedDirs: ['x'] }, 'project-1');
  assert.equal(enabled.status, 'enabled');
});

test('未开启策略或未授权目录时不做任何扫描', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const service = makeService(tempDir);
  // 未保存策略 → 默认 disabled
  let result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, false);
  assert.equal(result.reason, 'policy_not_enabled');

  // enabled 但未授权该目录
  service.savePolicy('project-1', enabledPolicy(path.join(tempDir, 'other')));
  result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, false);
  assert.equal(result.reason, 'dir_not_authorized');

  // 授权后成功
  service.savePolicy('project-1', enabledPolicy(projectDir));
  result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  assert.ok(result.checkpointId);
});

test('首次采集写入 CAS；二次采集内容去重，未变化文件不重复占用', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  fs.writeFileSync(path.join(projectDir, 'b.txt'), 'bbb');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));

  const first = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(first.captured, true);
  const usageAfterFirst = service.computeUsage('project-1');
  assert.ok(usageAfterFirst.totalBytes >= 6);

  // 无变化第二次采集：新 blob 字节应为 prompt blob 的小字节数（文件全部复用）
  const second = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-2' }));
  assert.equal(second.captured, true);
  assert.equal(second.checkpoint.stats.reusedHashFiles, 2);
  assert.equal(second.checkpoint.stats.hashedFiles, 0);
  const usageAfterSecond = service.computeUsage('project-1');
  // 占用增长必须恰好等于检查点自报的新增总字节（blob + 清单元数据），
  // "零新增 CAS 字节"不等于"零新增总空间"。
  assert.equal(usageAfterSecond.totalBytes - usageAfterFirst.totalBytes, second.checkpoint.stats.totalNewBytes);
  assert.ok(second.checkpoint.stats.newManifestBytes > 0, '清单字节必须计入新增空间');

  // 修改一个文件：只有该文件新增 blob
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa-modified');
  const third = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-3' }));
  assert.equal(third.captured, true);
  assert.equal(third.checkpoint.stats.hashedFiles, 1);
  assert.equal(third.checkpoint.stats.reusedHashFiles, 1);
});

test('删除状态记录在检查点清单中', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'keep.txt'), 'k');
  fs.writeFileSync(path.join(projectDir, 'gone.txt'), 'g');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  service.captureTurnCheckpoint(captureArgs(projectDir));

  fs.unlinkSync(path.join(projectDir, 'gone.txt'));
  const second = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-2' }));
  assert.deepEqual(second.checkpoint.deletions, ['gone.txt']);
});

test('采集期间并发写入被检测并降级，阻断严格对照资格', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  for (let index = 0; index < 20; index += 1) {
    fs.writeFileSync(path.join(projectDir, `f${index}.txt`), `content-${index}`);
  }

  const service = makeService(tempDir, {
    // 注入并发写入者：首扫之后、二扫之前修改文件，且每次重试都继续改
    afterFirstScan: (dir) => {
      fs.writeFileSync(path.join(dir, 'f0.txt'), `mutated-${Date.now()}-${Math.random()}`);
    },
  });
  service.savePolicy('project-1', enabledPolicy(projectDir));

  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  assert.equal(result.checkpoint.consistency.evidence, 'write-during-capture');
  assert.ok(result.checkpoint.consistency.differingPaths.includes('f0.txt'));
  assert.equal(result.checkpoint.strictEvalEligible, false);
  assert.ok(result.checkpoint.consistency.retries >= 1);
});

test('越界符号链接不跟随；界内符号链接可恢复', (t) => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'inside'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret-data.txt'), 'outside-content');
  fs.writeFileSync(path.join(projectDir, 'inside', 'real.txt'), 'real');
  try {
    fs.symlinkSync(path.join(outsideDir, 'secret-data.txt'), path.join(projectDir, 'escape-link'));
    fs.symlinkSync(path.join('inside', 'real.txt'), path.join(projectDir, 'ok-link'));
  } catch (error) {
    // Windows 默认需要开发者模式/管理员权限才能创建符号链接。
    t.skip(`symlink unavailable: ${error && error.code ? error.code : error}`);
    return;
  }

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  assert.equal(result.checkpoint.files['escape-link'].escapes, true);
  assert.equal(result.checkpoint.stats.symlinkEscapes, 1);
  assert.equal(result.checkpoint.files['ok-link'].type, 'symlink');

  // 恢复：越界链接不进恢复结果，界内链接重建
  const restoreDir = path.join(tempDir, 'restore');
  const restored = service.restoreCheckpoint({
    projectId: 'project-1',
    checkpointId: result.checkpointId,
    targetDir: restoreDir,
  });
  assert.equal(fs.existsSync(path.join(restoreDir, 'escape-link')), false);
  assert.equal(fs.readlinkSync(path.join(restoreDir, 'ok-link')).replace(/\\/g, '/'), 'inside/real.txt');
  assert.ok(restored.mismatches.some((m) => m.path === 'escape-link'));
});

test('秘密哨兵文件不进入 CAS；prompt 中的受控变量值被占位替换', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'clean.txt'), 'clean content');
  fs.writeFileSync(path.join(projectDir, 'leaky.env'), `API_KEY=${SENTINEL}`);

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    prompt: `callback ${SENTINEL} via https://callback.example/hook keep=keepme-value`,
    controlledValues: {
      CAFF_CHAT_CALLBACK_TOKEN: SENTINEL,
      CAFF_CHAT_API_URL: 'https://callback.example/hook',
      NOT_ALLOWED_VAR: 'keepme-value',
    },
  }));
  assert.equal(result.captured, true);
  assert.equal(result.checkpoint.stats.secretExcludedFiles, 1);
  assert.deepEqual(result.checkpoint.replayInput.secretExcludedPaths, ['leaky.env']);

  // 哨兵绝不出现在 CAS 的任何 blob 中（先扫描后落盘，而非先写后脱敏）
  const blobsRoot = path.join(tempDir, 'capture-root', 'projects', 'project-1', 'blobs');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  for (const blobPath of walk(blobsRoot)) {
    assert.equal(fs.readFileSync(blobPath, 'utf8').includes(SENTINEL), false, `sentinel leaked into ${blobPath}`);
  }

  // prompt blob 中受控变量已替换为占位符
  const promptBlob = service.store.readBlob('project-1', result.checkpoint.replayInput.promptBlobHash).toString('utf8');
  assert.ok(promptBlob.includes('{{CAFF_CHAT_CALLBACK_TOKEN}}'));
  assert.ok(promptBlob.includes('{{CAFF_CHAT_API_URL}}'));
  assert.ok(promptBlob.includes('keepme-value'), '清单外变量不得替换');
  assert.equal(result.checkpoint.replayInput.controlledReplacements.length >= 2, true);
});

test('resume 缺 session 时标记不可完整回放，禁止静默降级 fresh', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    deliveryMode: 'resume',
    sessionPath: path.join(tempDir, 'missing-session.jsonl'),
  }));
  assert.equal(result.captured, true);
  assert.equal(result.checkpoint.replayInput.deliveryMode, 'resume');
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('session_missing'));
  assert.equal(result.checkpoint.strictEvalEligible, false);
});

test('resume session 归档进 CAS，受控变量值被替换', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const sessionPath = path.join(tempDir, 'session.jsonl');
  fs.writeFileSync(sessionPath,
    '{"type":"session","version":3,"id":"s1"}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"user","content":[{"type":"text","text":"token abc-callback-token-value"}]}}\n');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    deliveryMode: 'resume',
    sessionPath,
    controlledValues: { CAFF_CHAT_CALLBACK_TOKEN: 'abc-callback-token-value' },
  }));
  assert.equal(result.captured, true);
  assert.equal(result.checkpoint.replayInput.complete, true);
  const sessionBlob = service.store.readBlob('project-1', result.checkpoint.replayInput.sessionBlobHash).toString('utf8');
  assert.ok(sessionBlob.includes('{{CAFF_CHAT_CALLBACK_TOKEN}}'));
  assert.equal(sessionBlob.includes('abc-callback-token-value'), false);
});

test('恢复两次清单一致；篡改 blob 导致校验失败', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(path.join(projectDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  fs.writeFileSync(path.join(projectDir, 'sub', 'b.txt'), 'bbb');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const captured = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(captured.captured, true);

  const restoreA = path.join(tempDir, 'restore-a');
  const restoreB = path.join(tempDir, 'restore-b');
  const resultA = service.restoreCheckpoint({ projectId: 'project-1', checkpointId: captured.checkpointId, targetDir: restoreA });
  const resultB = service.restoreCheckpoint({ projectId: 'project-1', checkpointId: captured.checkpointId, targetDir: restoreB });
  assert.equal(resultA.ok, true, JSON.stringify(resultA.mismatches));
  assert.equal(resultB.ok, true, JSON.stringify(resultB.mismatches));
  assert.deepEqual(resultA.restoredFiles, resultB.restoredFiles);
  // v1 无独立一致性依据，严格资格恒为 false；此处只断言两次恢复清单一致。
  assert.equal(resultA.strictEvalEligible, false);

  // 篡改 blob：恢复必须报 hash 不一致，不得静默成功
  const entry = captured.checkpoint.files['a.txt'];
  const blobsRoot = path.join(tempDir, 'capture-root', 'projects', 'project-1', 'blobs');
  const blobFile = path.join(blobsRoot, entry.hash.slice(0, 2), entry.hash);
  fs.writeFileSync(blobFile, 'tampered');
  const restoreC = path.join(tempDir, 'restore-c');
  const resultC = service.restoreCheckpoint({ projectId: 'project-1', checkpointId: captured.checkpointId, targetDir: restoreC });
  assert.equal(resultC.ok, false);
  assert.ok(resultC.mismatches.some((m) => m.reason === 'blob_hash_mismatch' && m.path === 'a.txt'));
});

test('git 仓库：tracked/dirty/untracked 纳入，ignored 默认排除、显式纳入可恢复', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  gitInit(projectDir);
  fs.writeFileSync(path.join(projectDir, 'tracked.txt'), 'tracked');
  fs.writeFileSync(path.join(projectDir, '.gitignore'), 'ignored-dir/\n');
  gitAddAll(projectDir);
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: projectDir });
  // dirty + untracked + ignored
  fs.writeFileSync(path.join(projectDir, 'tracked.txt'), 'tracked-dirty');
  fs.writeFileSync(path.join(projectDir, 'untracked.txt'), 'untracked');
  fs.mkdirSync(path.join(projectDir, 'ignored-dir'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'ignored-dir', 'fixture.txt'), 'ignored-fixture');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  let result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  assert.ok(result.checkpoint.files['tracked.txt']);
  assert.ok(result.checkpoint.files['untracked.txt']);
  assert.equal(result.checkpoint.files['ignored-dir/fixture.txt'], undefined, 'ignored 文件默认不采集');

  // 显式纳入 ignored 模式后可采集并恢复
  service.savePolicy('project-1', enabledPolicy(projectDir, { includedIgnoredPatterns: ['ignored-dir/**'] }));
  result = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-2' }));
  assert.ok(result.checkpoint.files['ignored-dir/fixture.txt']);
  const restoreDir = path.join(tempDir, 'restore');
  const restored = service.restoreCheckpoint({ projectId: 'project-1', checkpointId: result.checkpointId, targetDir: restoreDir });
  assert.equal(restored.ok, true, JSON.stringify(restored.mismatches));
  assert.equal(fs.readFileSync(path.join(restoreDir, 'ignored-dir', 'fixture.txt'), 'utf8'), 'ignored-fixture');
  assert.equal(fs.readFileSync(path.join(restoreDir, 'tracked.txt'), 'utf8'), 'tracked-dirty');
});

test('配额不足时策略挂起且采集失败，不伪造检查点', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const service = makeService(tempDir);
  // 配额小于首个检查点的实际内容量 → 扫描后预检失败，不落任何 blob/清单
  service.savePolicy('project-1', enabledPolicy(projectDir, { stagingQuotaBytes: 4 }));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, false);
  assert.equal(result.reason, 'quota_exceeded');
  assert.equal(service.loadPolicy('project-1').status, 'suspended');
  assert.equal(service.store.listCheckpoints('project-1').length, 0);
  assert.equal(service.computeUsage('project-1').totalBytes, 0, '配额失败不得写入任何 blob');
});

test('容量预估不读取内容、不落盘，并标注授权状态', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  fs.writeFileSync(path.join(projectDir, 'b.txt'), 'bbbb');

  const service = makeService(tempDir);
  const estimate = service.estimateDirectory('project-1', projectDir);
  assert.equal(estimate.ok, true);
  assert.equal(estimate.fileCount, 2);
  assert.equal(estimate.totalBytes, 7);
  assert.equal(estimate.authorized, false, '未授权时预估标注 authorized=false');
  assert.equal(fs.existsSync(path.join(tempDir, 'capture-root', 'projects', 'project-1', 'blobs')), false);
});

test('受控变量替换仅作用于清单内变量', () => {
  const { text, replacements } = replaceControlledVariables('url=https://x token=t1 keep=zzz', {
    CAFF_CHAT_API_URL: 'https://x',
    CAFF_CHAT_CALLBACK_TOKEN: 't1',
    SOME_OTHER: 'zzz',
  });
  assert.equal(text, 'url={{CAFF_CHAT_API_URL}} token={{CAFF_CHAT_CALLBACK_TOKEN}} keep=zzz');
  assert.equal(replacements.length, 2);
  assert.ok(listControlledReplayVariables().includes('CAFF_CHAT_CALLBACK_TOKEN'));
  assert.equal(containsSecretSentinel(Buffer.from(`key: ${SENTINEL}`)), true);
  assert.equal(containsSecretSentinel(Buffer.from('plain text')), false);
});

