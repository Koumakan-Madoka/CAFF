// W2 中间审查阻断项回归（GPT E3）。每项先红后绿。
// 覆盖：R1 秘密落盘（prompt/session/TOCTOU/二进制与大文件）、R2 授权边界 junction 绕过、
// R3 mtime 快速路径冒充严格对照、R4 session/模型配置完整性、R5 配额与元数据核算。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { withTempDir } = require('../helpers/temp-dir');
const {
  createBadcaseCaptureService,
} = require('../../build/server/domain/runtime/badcase-capture/index');

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
    ...overrides,
  };
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

function assertNoBlobContains(tempDir, needle) {
  const blobsRoot = path.join(tempDir, 'capture-root', 'projects', 'project-1', 'blobs');
  for (const blobPath of walkFiles(blobsRoot)) {
    assert.equal(fs.readFileSync(blobPath).includes(needle), false, `forbidden content leaked into ${blobPath}`);
  }
}

test('R1a: prompt 命中未列入受控替换的秘密哨兵时拒绝归档 prompt', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    prompt: `please use ${SENTINEL} to call the API`,
  }));
  assert.equal(result.captured, true, '文件现场仍可采集，但回放输入必须标记不完整');
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('prompt_contains_secret'));
  assert.equal(result.checkpoint.replayInput.promptBlobHash, '', '含秘密的 prompt 不得归档');
  assert.equal(result.checkpoint.strictEvalEligible, false);
  assertNoBlobContains(tempDir, SENTINEL);
});

test('R1b: session 命中秘密哨兵时拒绝归档 session，禁止带秘密落盘', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const sessionPath = path.join(tempDir, 'session.jsonl');
  fs.writeFileSync(sessionPath, `{"type":"message","text":"use ${SENTINEL} here"}\n`);

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    deliveryMode: 'resume',
    sessionPath,
  }));
  assert.equal(result.captured, true);
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('session_contains_secret'));
  assert.equal(result.checkpoint.replayInput.sessionBlobHash, '', '含秘密的 session 不得归档');
  assert.equal(result.checkpoint.strictEvalEligible, false);
  assertNoBlobContains(tempDir, SENTINEL);
});

test('R1c: 扫描后、写 CAS 前注入秘密哨兵（TOCTOU），秘密不得落盘', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'clean.txt'), 'clean');

  const service = makeService(tempDir, {
    // 注入点：首次扫描之后、CAS 写入之前，把哨兵写进刚扫过的干净文件。
    afterScan: (dir, attempt) => {
      if (attempt === 0) {
        fs.writeFileSync(path.join(dir, 'clean.txt'), `injected ${SENTINEL}`);
      }
    },
  });
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  assert.equal(result.checkpoint.files['clean.txt'].secretExcluded, true, '写时重扫必须检出哨兵并排除');
  assert.equal(result.checkpoint.strictEvalEligible, false);
  assert.notEqual(result.checkpoint.consistency.evidence, 'content-verified', '检出异常后不得宣称内容级一致');
  assertNoBlobContains(tempDir, SENTINEL);
});

test('R1d: 二进制与超过 16 MiB 的文件不跳过秘密扫描', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  // 含 NUL 的二进制内容 + 高置信哨兵
  const binaryContent = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x00]), Buffer.from(SENTINEL), Buffer.alloc(64, 0x00)]);
  fs.writeFileSync(path.join(projectDir, 'blob.bin'), binaryContent);
  // 超过 16 MiB 的文本文件，秘密放在末尾（用换行分隔保证词边界）
  const bigContent = Buffer.concat([Buffer.alloc(17 * 1024 * 1024, 0x61), Buffer.from(`\n${SENTINEL}\n`)]);
  fs.writeFileSync(path.join(projectDir, 'big.log'), bigContent);

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  assert.equal(result.checkpoint.files['blob.bin'].secretExcluded, true, '二进制文件须按高置信哨兵集扫描');
  assert.equal(result.checkpoint.files['big.log'].secretExcluded, true, '大文件不得跳过扫描');
  assert.equal(result.checkpoint.strictEvalEligible, false);
  assertNoBlobContains(tempDir, SENTINEL);
});

test('R2: junction/目录链接不能绕过授权目录边界', (t) => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideContent = 'outside-content-not-authorized';
  fs.writeFileSync(path.join(outsideDir, 'data.txt'), outsideContent);
  fs.writeFileSync(path.join(projectDir, 'real.txt'), 'real');
  // 授权目录内的链接子路径指向未授权目录。Windows 用 junction（无需特权），POSIX 用目录符号链接。
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(outsideDir, path.join(projectDir, 'link-out'), linkType);
  } catch (error) {
    t.skip(`link unavailable: ${error && error.code ? error.code : error}`);
    return;
  }
  gitInit(projectDir);
  gitAddAll(projectDir);

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));

  // 1) 从授权根采集：link-out 必须被识别为越界，外部内容不得进入清单或 CAS。
  //    两种形态都合法：链接本身作为 escapes 条目（lstat 识别），或 git 展开链接目录后
  //    由读前 realpath 边界校验拦截（skipped: path_escapes_target）。
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  const linkPaths = Object.keys(result.checkpoint.files).filter((p) => p === 'link-out' || p.startsWith('link-out/'));
  for (const p of linkPaths) {
    assert.equal(result.checkpoint.files[p].escapes, true, `${p} 必须标记越界`);
  }
  const boundarySignal = result.checkpoint.stats.symlinkEscapes > 0
    || result.checkpoint.stats.outOfBoundsFiles > 0
    || result.checkpoint.skipped.some((s) => s.reason === 'path_escapes_target');
  assert.ok(boundarySignal, '必须留下越界拦截证据');
  assert.equal(result.checkpoint.strictEvalEligible, false, '存在越界路径时阻断严格对照');
  assertNoBlobContains(tempDir, outsideContent);

  // 2) 目标目录本身就是越界链接路径：字符串前缀相同也必须拒绝授权。
  const viaJunction = service.captureTurnCheckpoint(captureArgs(path.join(projectDir, 'link-out'), { turnId: 'turn-2' }));
  assert.equal(viaJunction.captured, false);
  assert.equal(viaJunction.reason, 'dir_not_authorized');
});

test('R3: 同长度改写并恢复 mtime 不得复用旧内容充当严格对照', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, 'a.txt');
  fs.writeFileSync(filePath, 'aaa');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const first = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(first.captured, true);
  assert.equal(first.checkpoint.consistency.evidence, 'content-verified');
  assert.equal(first.checkpoint.strictEvalEligible, true);

  // 同长度改写 + 恢复 mtime/mode：mtime 快速路径会被骗过，内容级二扫必须检出。
  // NTFS/utimes 的亚毫秒精度往返不稳定，直接把上一检查点中记录的 stat 签名
  // 对齐到改写后的实际值——对采集器而言这与"完美的 mtime 恢复"不可区分。
  const statBefore = fs.statSync(filePath);
  fs.writeFileSync(filePath, 'bbb');
  fs.utimesSync(filePath, statBefore.atimeMs / 1000, statBefore.mtimeMs / 1000);
  const statAfter = fs.statSync(filePath);
  const checkpointPath = path.join(tempDir, 'capture-root', 'projects', 'project-1', 'checkpoints', `${first.checkpointId}.json`);
  const storedCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  storedCheckpoint.files['a.txt'].mtimeMs = statAfter.mtimeMs;
  storedCheckpoint.files['a.txt'].size = statAfter.size;
  storedCheckpoint.files['a.txt'].mode = statAfter.mode;
  fs.writeFileSync(checkpointPath, `${JSON.stringify(storedCheckpoint, null, 2)}\n`);

  const second = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-2' }));
  assert.equal(second.captured, true);
  assert.equal(second.checkpoint.consistency.evidence, 'corrected-after-retry', '检出内容不符后重试修正，不得宣称无异常');
  assert.equal(second.checkpoint.strictEvalEligible, false);

  // 恢复出来的必须是新内容，不是被复用的旧 blob。
  const restoreDir = path.join(tempDir, 'restore');
  service.restoreCheckpoint({ projectId: 'project-1', checkpointId: second.checkpointId, targetDir: restoreDir });
  assert.equal(fs.readFileSync(path.join(restoreDir, 'a.txt'), 'utf8'), 'bbb');

  // 第三次采集（无变化）：内容级双扫通过，恢复严格对照资格。
  const third = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-3' }));
  assert.equal(third.checkpoint.consistency.evidence, 'content-verified');
  assert.equal(third.checkpoint.strictEvalEligible, true);
});

test('R4a: 非法 JSONL 或空 session 标记不可完整回放，不归档未验证材料', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const invalidSession = path.join(tempDir, 'invalid.jsonl');
  fs.writeFileSync(invalidSession, '{"type":"message"}\n{not json}\n');
  const emptySession = path.join(tempDir, 'empty.jsonl');
  fs.writeFileSync(emptySession, '\n  \n');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));

  const invalid = service.captureTurnCheckpoint(captureArgs(projectDir, { deliveryMode: 'resume', sessionPath: invalidSession }));
  assert.equal(invalid.checkpoint.replayInput.complete, false);
  assert.ok(invalid.checkpoint.replayInput.incompleteReasons.some((r) => r.startsWith('session_invalid_jsonl')));
  assert.equal(invalid.checkpoint.replayInput.sessionBlobHash, '');
  assert.equal(invalid.checkpoint.strictEvalEligible, false);

  const empty = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-2', deliveryMode: 'resume', sessionPath: emptySession }));
  assert.equal(empty.checkpoint.replayInput.complete, false);
  assert.ok(empty.checkpoint.replayInput.incompleteReasons.includes('session_empty'));
  assert.equal(empty.checkpoint.replayInput.sessionBlobHash, '');
});

test('R4b: 缺模型/harness 配置时标记不可完整回放', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir, { runConfig: { provider: 'test-provider' } }));
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('model_config_missing'));
  assert.equal(result.checkpoint.strictEvalEligible, false);
});

test('R5a: 配额核算包含 session/prompt/清单：小配额 + 大 session 必须失败且零落盘', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const sessionPath = path.join(tempDir, 'session.jsonl');
  fs.writeFileSync(sessionPath, `{"type":"message","text":"${'x'.repeat(1000)}"}\n`);

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir, { stagingQuotaBytes: 100 }));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir, { deliveryMode: 'resume', sessionPath }));
  assert.equal(result.captured, false, 'session 字节必须计入配额，不得超额成功');
  assert.equal(result.reason, 'quota_exceeded');
  assert.equal(service.loadPolicy('project-1').status, 'suspended');
  assert.equal(service.store.listCheckpoints('project-1').length, 0);
  assert.equal(service.computeUsage('project-1').totalBytes, 0, '配额失败不得写入任何 blob 或清单');
});

test('R5b: 占用统计计入清单等元数据，与检查点自报新增字节一致', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const before = service.computeUsage('project-1');
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  const after = service.computeUsage('project-1');
  const stats = result.checkpoint.stats;
  assert.ok(stats.newManifestBytes > 0, '清单字节必须单独计量');
  assert.equal(stats.totalNewBytes, stats.newBlobBytes + stats.newManifestBytes);
  assert.equal(after.totalBytes - before.totalBytes, stats.totalNewBytes, '自报新增必须等于实际占用增长（含元数据）');
});

test('R6: 显式秘密豁免路径照常归档并留审计标记；默认策略无豁免', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(path.join(projectDir, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'fixtures', 'fake-key.txt'), `fake ${SENTINEL} fixture`);

  const service = makeService(tempDir);
  // 默认无豁免：豁免前命中即排除
  service.savePolicy('project-1', enabledPolicy(projectDir));
  let result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.checkpoint.files['fixtures/fake-key.txt'].secretExcluded, true);
  assert.equal(result.checkpoint.replayInput.complete, false);

  // 显式豁免后：内容照常归档，清单留 secretAllowlisted 审计标记
  service.savePolicy('project-1', enabledPolicy(projectDir, { secretAllowlistPatterns: ['fixtures/**'] }));
  result = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-2' }));
  const entry = result.checkpoint.files['fixtures/fake-key.txt'];
  assert.equal(entry.secretExcluded, undefined);
  assert.equal(entry.secretAllowlisted, true);
  assert.ok(entry.hash, '豁免路径保留内容 hash');
  assert.equal(result.checkpoint.stats.secretAllowlistedFiles, 1);
  assert.equal(result.checkpoint.replayInput.complete, true);
  assert.equal(result.checkpoint.strictEvalEligible, true);

  const restoreDir = path.join(tempDir, 'restore');
  const restored = service.restoreCheckpoint({ projectId: 'project-1', checkpointId: result.checkpointId, targetDir: restoreDir });
  assert.equal(restored.ok, true, JSON.stringify(restored.mismatches));
  assert.ok(fs.readFileSync(path.join(restoreDir, 'fixtures', 'fake-key.txt'), 'utf8').includes(SENTINEL));
});
