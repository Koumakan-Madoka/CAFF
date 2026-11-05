// W2 中间审查阻断项回归（GPT E3）。每项先红后绿。
// 覆盖：R1 秘密落盘（prompt/session/TOCTOU/二进制与大文件）、R2 授权边界 junction 绕过、
// R3 mtime 快速路径冒充严格对照、R4 session/模型配置完整性、R5 配额与元数据核算。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const { withTempDir } = require('../helpers/temp-dir');
const { capSkip } = require('../helpers/capture-capability');
// Retained offline v1 protections, not the new turn's v2 contract.
const {
  createLegacyNativeCaptureService: createBadcaseCaptureService,
} = require('../helpers/legacy-native-capture');

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

// 普通保存 + 显式授权（钉住根身份）。savePolicy 不再钉住新对象，
// 授权是独立动作（GPT 复审 #1 第六轮）。
function authorize(service, projectId, policy) {
  service.savePolicy(projectId, policy);
  // 旧构建无 authorizeProject（savePolicy 即授权）；新构建必须显式授权。
  if (typeof service.authorizeProject === 'function') {
    service.authorizeProject(projectId);
  }
}

function enabledPolicy(projectDir, overrides = {}) {
  return {
    status: 'enabled',
    authorizedDirs: [projectDir],
    // 树外回放输入（session 夹具）的独立授权边界：默认授权整个临时目录。
    authorizedInputDirs: [path.dirname(projectDir)],
    ...overrides,
  };
}

// configSnapshot 必填键全集（空对象/缺键会被降级为 harness_tool_config_unverified）。
function validConfigSnapshot(overrides = {}) {
  return {
    agentPromptVersion: 'test-v1',
    toolBridgeEnabled: true,
    piVersion: '0.85.1',
    deliveryMode: 'fresh',
    agentName: 'test-agent',
    ...overrides,
  };
}

function captureArgs(projectDir, overrides = {}) {
  // configSnapshot.deliveryMode 必须与实际采集模式一致（harness 跨字段校验）。
  const actualMode = overrides.deliveryMode === 'resume' ? 'resume' : 'fresh';
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
      configSnapshot: validConfigSnapshot({ deliveryMode: actualMode }),
      skillSnapshots: [],
    },
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

test('R1a: prompt 命中未列入受控替换的秘密哨兵时拒绝归档 prompt', { skip: capSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
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

test('R1b: session 命中秘密哨兵时拒绝归档 session，禁止带秘密落盘', { skip: capSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const sessionPath = path.join(tempDir, 'session.jsonl');
  fs.writeFileSync(sessionPath,
    `{"type":"session","version":3,"id":"s1"}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"user","content":[{"type":"text","text":"use ${SENTINEL} here"}]}}\n`);

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
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

test('R1c: 扫描后、写 CAS 前注入秘密哨兵（TOCTOU），秘密不得落盘', { skip: capSkip }, () => {
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
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  assert.equal(result.checkpoint.files['clean.txt'].secretRedacted, true, '写时重扫必须在落盘前检出并占位替换');
  assert.equal(service.store.readBlob('project-1', result.checkpoint.files['clean.txt'].hash).toString(), 'injected [*]');
  assert.equal(result.checkpoint.strictEvalEligible, false);
  assert.notEqual(result.checkpoint.consistency.evidence, 'content-verified', '检出异常后不得宣称内容级一致');
  assertNoBlobContains(tempDir, SENTINEL);
});

test('R1d: 二进制与超过 16 MiB 的文件不跳过秘密扫描', { skip: capSkip }, () => {
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
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  assert.equal(result.checkpoint.files['blob.bin'].secretRedacted, true, '二进制文件须按高置信哨兵集扫描');
  assert.equal(result.checkpoint.files['big.log'].secretRedacted, true, '大文件不得跳过扫描');
  assert.equal(result.checkpoint.strictEvalEligible, false);
  assertNoBlobContains(tempDir, SENTINEL);
});

test('R2: junction/目录链接不能绕过授权目录边界', { skip: capSkip }, (t) => {
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
  authorize(service, 'project-1', enabledPolicy(projectDir));

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

test('R3: 同长度改写并恢复 mtime 不得复用旧内容充当严格对照', { skip: capSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, 'a.txt');
  fs.writeFileSync(filePath, 'aaa');

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const first = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(first.captured, true);
  assert.equal(first.checkpoint.consistency.evidence, 'content-verified');
  // v1 无独立一致性依据：即使内容级双扫零异常，严格资格也必须为 false（GPT 复审 #2）。
  assert.equal(first.checkpoint.strictEvalEligible, false);

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

  // 第三次采集（无变化）：内容级双扫仍未检测到变化，但双扫不等于现场一致——严格资格保持 false。
  const third = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-3' }));
  assert.equal(third.checkpoint.consistency.evidence, 'content-verified');
  assert.equal(third.checkpoint.strictEvalEligible, false);
});

test('R4a: 非法 JSONL 或空 session 标记不可完整回放，不归档未验证材料', { skip: capSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const invalidSession = path.join(tempDir, 'invalid.jsonl');
  fs.writeFileSync(invalidSession, '{"type":"session","version":3,"id":"s1"}\n{not json}\n');
  const emptySession = path.join(tempDir, 'empty.jsonl');
  fs.writeFileSync(emptySession, '\n  \n');

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

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

test('R4b: 缺模型/harness 配置时标记不可完整回放', { skip: capSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir, { runConfig: { provider: 'test-provider' } }));
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('model_config_missing'));
  assert.equal(result.checkpoint.strictEvalEligible, false);
});

test('R5a: 配额核算包含 session/prompt/清单：小配额 + 大 session 必须失败且零落盘', { skip: capSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const sessionPath = path.join(tempDir, 'session.jsonl');
  fs.writeFileSync(sessionPath,
    `{"type":"session","version":3,"id":"s1"}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"user","content":[{"type":"text","text":"${'x'.repeat(1000)}"}]}}\n`);

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir, { stagingQuotaBytes: 100 }));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir, { deliveryMode: 'resume', sessionPath }));
  assert.equal(result.captured, false, 'session 字节必须计入配额，不得超额成功');
  assert.equal(result.reason, 'quota_exceeded');
  assert.equal(service.loadPolicy('project-1').status, 'suspended');
  assert.equal(service.store.listCheckpoints('project-1').length, 0);
  assert.equal(service.computeUsage('project-1').totalBytes, 0, '配额失败不得写入任何 blob 或清单');
});

test('R5b: 占用统计计入清单等元数据，与检查点自报新增字节一致', { skip: capSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const before = service.computeUsage('project-1');
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  const after = service.computeUsage('project-1');
  const stats = result.checkpoint.stats;
  assert.ok(stats.newManifestBytes > 0, '清单字节必须单独计量');
  assert.equal(stats.totalNewBytes, stats.newBlobBytes + stats.newManifestBytes);
  assert.equal(after.totalBytes - before.totalBytes, stats.totalNewBytes, '自报新增必须等于实际占用增长（含元数据）');
});

test('R6: 秘密豁免机制已移除——policy 中的 secretAllowlistPatterns 被忽略，夹具哨兵照常脱敏', { skip: capSkip }, () => {
  // GPT 复审 #6：目录级永久豁免会放行后续加入的真实凭据，本阶段移除该机制。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(path.join(projectDir, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'fixtures', 'fake-key.txt'), `fake ${SENTINEL} fixture`);

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir, { secretAllowlistPatterns: ['fixtures/**'] }));
  const policy = service.loadPolicy('project-1');
  assert.ok(!policy.secretAllowlistPatterns || policy.secretAllowlistPatterns.length === 0,
    '豁免配置不得生效');

  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  const entry = result.checkpoint.files['fixtures/fake-key.txt'];
  assert.equal(entry.secretRedacted, true, '命中哨兵一律脱敏，无豁免路径');
  assert.equal(entry.secretAllowlisted, undefined);
  assert.equal(service.store.readBlob('project-1', entry.hash).toString(), 'fake [*] fixture', '仅记录安全字节的 hash');
  assert.equal(result.checkpoint.replayInput.complete, false);
  assertNoBlobContains(tempDir, SENTINEL);
});

test('R7: 采集窗口内授权根路径被替换——fd 钉住原对象，外部内容不可读、零落盘', { skip: capSkip }, () => {
  // GPT 复审 #1 第五轮：授权绑定“已打开的目录对象”而非路径名。首扫后把根重命名、
  // 在原路径建立指向未授权目录的链接：受限根 fd 仍指向原目录对象，openat2 相对
  // 该对象解析——外部内容根本不会被读取；采集以正确内容完成，恢复结果必须是
  // 授权内容。路径层面的替换与结论无关（ABA 类竞态由构造消除）。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideContent = 'external-fake-real-content';
  fs.writeFileSync(path.join(outsideDir, 'real.txt'), outsideContent);
  fs.writeFileSync(path.join(projectDir, 'real.txt'), 'real');
  gitInit(projectDir);
  gitAddAll(projectDir);

  const service = makeService(tempDir, {
    afterScan: (dir, attempt) => {
      if (attempt !== 0) {
        return;
      }
      fs.renameSync(dir, `${dir}-orig`);
      fs.symlinkSync(outsideDir, dir, 'dir');
    },
  });
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  try {
    assert.equal(result.captured, true, `fd 钉住根对象，采集应以授权内容完成：${result.reason}`);
    assert.equal(result.checkpoint.files['real.txt'].type, 'file');
    assertNoBlobContains(tempDir, outsideContent);
    const restoreDir = path.join(tempDir, 'restore');
    service.restoreCheckpoint({ projectId: 'project-1', checkpointId: result.checkpointId, targetDir: restoreDir });
    assert.equal(fs.readFileSync(path.join(restoreDir, 'real.txt'), 'utf8'), 'real', '归档的必须是授权内容');
  } finally {
    if (fs.existsSync(projectDir)) {
      fs.unlinkSync(projectDir);
    }
    fs.renameSync(`${projectDir}-orig`, projectDir);
  }
});

test('R8: 双扫无差异不得兑换严格资格——写入者全程搅动，严格资格仍恒为 false', { skip: capSkip }, () => {
  // GPT 复审 #2：内容级双扫只能记录“未检测到变化”，不能证明现场一致。旧探针用
  // fs 读编排演示“两扫读到从未同时存在的状态”；受限读取改由独立 helper 进程执行后，
  // 进程内 fs hook 不再能编排读取（这本身也是设计意图的一部分）。本用例退而断言
  // 不变量：无论双扫结果如何，strictEvalEligible 恒为 false。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), '0');
  fs.writeFileSync(path.join(projectDir, 'b.txt'), '1');

  // 后台写入者持续交换两文件内容，制造采集窗口内的真实并发写。
  const writer = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const a = process.argv[1]; const b = process.argv[2];
    const end = Date.now() + Number(process.argv[3]);
    let i = 0;
    while (Date.now() < end) {
      fs.writeFileSync(a, String(i % 2));
      fs.writeFileSync(b, String((i + 1) % 2));
      i += 1;
    }
  `, path.join(projectDir, 'a.txt'), path.join(projectDir, 'b.txt'), '400'], { stdio: 'ignore' });

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  return new Promise((resolve, reject) => {
    writer.on('exit', () => {
      try {
        assert.equal(result.captured, true);
        assert.equal(result.checkpoint.strictEvalEligible, false,
          '无论双扫是否检测到变化，严格对照资格都必须为 false');
        assert.ok(['content-verified', 'corrected-after-retry', 'write-during-capture']
          .includes(result.checkpoint.consistency.evidence));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
});

test('R9: session 结构校验——非对象行/缺头/断链/未识别内容类型一律不完整', { skip: capSkip }, () => {
  // GPT 复审 #3：合法 JSONL 语法 ≠ 完整 session。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  const writeSession = (name, text) => {
    const p = path.join(tempDir, name);
    fs.writeFileSync(p, text);
    return p;
  };
  const HEADER = '{"type":"session","version":3,"id":"s1"}';

  const cases = [
    ['null-line.jsonl', 'null\n', 'session_non_object_entry:line_1'],
    ['no-header.jsonl', '{"type":"message","id":"m1","parentId":null}\n', 'session_header_invalid'],
    ['broken-chain.jsonl', `${HEADER}\n{"type":"message","id":"m1","parentId":"missing"}\n`, 'session_chain_broken:line_2'],
    ['array-line.jsonl', `${HEADER}\n[1,2]\n`, 'session_non_object_entry:line_2'],
    ['unknown-content.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"user","content":[{"type":"video","url":"file:///x.mp4"}]}}\n`,
      'session_invalid_content_block:line_2:unverified_block_type:video'],
  ];
  let turn = 0;
  for (const [name, text, reason] of cases) {
    turn += 1;
    const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
      turnId: `turn-${turn}`,
      deliveryMode: 'resume',
      sessionPath: writeSession(name, text),
    }));
    assert.equal(result.captured, true);
    assert.equal(result.checkpoint.replayInput.complete, false, name);
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes(reason),
      `${name} 期望 ${reason}，实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
    assert.equal(result.checkpoint.replayInput.sessionBlobHash, '', `${name} 未验证材料不得归档`);
    assert.equal(result.checkpoint.strictEvalEligible, false);
  }

  // 合法最小 session（头 + model_change 全字段 + message）可以归档，但严格资格仍为 false。
  const okSession = writeSession('ok.jsonl',
    `${HEADER}\n{"type":"model_change","id":"c1","parentId":null,"provider":"test-provider","modelId":"test-model"}\n{"type":"message","id":"m1","parentId":"c1","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n`);
  const ok = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-ok',
    deliveryMode: 'resume',
    sessionPath: okSession,
  }));
  assert.equal(ok.checkpoint.replayInput.complete, true, ok.checkpoint.replayInput.incompleteReasons.join(','));
  assert.ok(ok.checkpoint.replayInput.sessionBlobHash);
  assert.equal(ok.checkpoint.strictEvalEligible, false);
});

test('R10: PEM 私钥头在行首/换行后/二进制前缀中必须命中哨兵', { skip: capSkip }, () => {
  // GPT 复审 #4：\\b 在连字符前要求前置单词字符，行首/换行后的 PEM 头被漏检。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'head.pem'), '-----BEGIN PRIVATE KEY-----\nfake-body\n-----END PRIVATE KEY-----\n');
  fs.writeFileSync(path.join(projectDir, 'mid.pem'), 'config line\n-----BEGIN RSA PRIVATE KEY-----\nfake\n');
  fs.writeFileSync(path.join(projectDir, 'bin.pem'),
    Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from('-----BEGIN EC PRIVATE KEY-----'), Buffer.alloc(8, 0)]));

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  for (const name of ['head.pem', 'mid.pem', 'bin.pem']) {
    assert.equal(result.checkpoint.files[name].secretRedacted, true, `${name} 必须命中哨兵并保留占位文件`);
  }
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.equal(result.checkpoint.strictEvalEligible, false);
  assertNoBlobContains(tempDir, 'PRIVATE KEY');
});

test('R11: 扫描后文件膨胀超限必须在落盘前阻断，CAS 不得先写入超限内容', { skip: capSkip }, () => {
  // GPT 复审 #5：写时读到的实际字节必须在写盘前重新核算配额。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'x'.repeat(100));

  const service = makeService(tempDir, {
    afterScan: (dir, attempt) => {
      if (attempt === 0) {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'y'.repeat(20000));
      }
    },
  });
  authorize(service, 'project-1', enabledPolicy(projectDir, { stagingQuotaBytes: 10000 }));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, false);
  assert.equal(result.reason, 'quota_exceeded');
  assert.equal(service.loadPolicy('project-1').status, 'suspended');
  const usage = service.computeUsage('project-1');
  assert.ok(usage.totalBytes <= 10000, `超限内容不得落盘，实际占用 ${usage.totalBytes}`);
});

test('R12: harness/skill 配置未验证必须降级，不得宣称完整', { skip: capSkip }, () => {
  // GPT 复审 #3：runConfig 只有 model 必填不够，harness/tool/skill 内容版本未固定时必须降级。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  // 1) 缺 harness → harness_config_unverified
  let result = service.captureTurnCheckpoint(captureArgs(projectDir, { harness: undefined }));
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('harness_config_unverified'));

  // 2) 缺 promptVersion → run_config_incomplete
  result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-2',
    runConfig: { provider: 'test-provider', model: 'test-model' },
  }));
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('run_config_incomplete'));

  // 3) 声明 skill 但无内容快照 → skill_snapshot_missing
  result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-3',
    runConfig: { provider: 'p', model: 'm', promptVersion: 'v1', skillIds: ['demo-skill'] },
  }));
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('skill_snapshot_missing:demo-skill'));

  // 4) 提供内容快照 + harness 配置快照 → 快照归档进 CAS，输入完整（严格资格仍 false）
  const crypto = require('node:crypto');
  const skillContent = '# demo skill body\n';
  const skillHash = crypto.createHash('sha256').update(skillContent).digest('hex');
  result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-4',
    runConfig: { provider: 'p', model: 'm', promptVersion: 'v1', skillIds: ['demo-skill'] },
    harness: {
      serverVersion: 'test-server',
      configSnapshot: validConfigSnapshot({ agentPromptVersion: 'v1' }),
      skillSnapshots: [{ id: 'demo-skill', source: 'project', sha256: skillHash, content: skillContent }],
    },
  }));
  assert.equal(result.checkpoint.replayInput.complete, true, result.checkpoint.replayInput.incompleteReasons.join(','));
  assert.equal(result.checkpoint.replayInput.harness.skillSnapshots[0].blobHash, skillHash);
  assert.ok(service.store.hasBlob('project-1', skillHash), 'skill 内容必须归档进 CAS');
  assert.equal(result.checkpoint.strictEvalEligible, false);

  // 5) 快照 hash 与内容不符 → 拒绝归档
  result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-5',
    runConfig: { provider: 'p', model: 'm', promptVersion: 'v1', skillIds: ['demo-skill'] },
    harness: {
      serverVersion: 'test-server',
      configSnapshot: validConfigSnapshot({ agentPromptVersion: 'v1' }),
      skillSnapshots: [{ id: 'demo-skill', source: 'project', sha256: '0'.repeat(64), content: skillContent }],
    },
  }));
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('skill_snapshot_hash_mismatch:demo-skill'));

  // 6) 快照内容命中哨兵 → 拒绝归档
  const secretSkill = `use ${SENTINEL} now`;
  result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-6',
    runConfig: { provider: 'p', model: 'm', promptVersion: 'v1', skillIds: ['demo-skill'] },
    harness: {
      serverVersion: 'test-server',
      configSnapshot: validConfigSnapshot({ agentPromptVersion: 'v1' }),
      skillSnapshots: [{ id: 'demo-skill', source: 'project', sha256: crypto.createHash('sha256').update(secretSkill).digest('hex'), content: secretSkill }],
    },
  }));
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('skill_contains_secret:demo-skill'));
  assertNoBlobContains(tempDir, SENTINEL);

  // 7) 缺 harness 工具配置快照 → harness_tool_config_unverified（serverVersion 非空不够）
  result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-7',
    harness: { serverVersion: 'test-server', skillSnapshots: [] },
  }));
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('harness_tool_config_unverified'));
});

test('R13a: 首扫后替换授权根（写盘阶段竞态）——受限读取不受影响，外部内容零落盘', { skip: capSkip }, () => {
  // GPT 复审 #1 探针演进：旧探针在写 CAS 重读 a.txt 前换根，旧实现经 junction 读到
  // 外部内容。受限读取（openat2 相对持有的根 fd）使换根与读取结论无关：写盘阶段
  // 读到的仍是已授权树的内容；外部内容不会被读取，更不会到 staging/CAS。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideContent = 'external-content-must-never-reach-cas';
  fs.writeFileSync(path.join(outsideDir, 'a.txt'), outsideContent);
  const aPath = path.join(projectDir, 'a.txt');
  fs.writeFileSync(aPath, 'real');

  const service = makeService(tempDir, {
    afterScan: (dir, attempt) => {
      if (attempt === 0) {
        fs.renameSync(dir, `${dir}-orig`);
        fs.symlinkSync(outsideDir, dir, 'dir');
      }
    },
  });
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  try {
    assert.equal(result.captured, true, `受限读取不受路径替换影响：${result.reason}`);
    assertNoBlobContains(tempDir, outsideContent);
    const restoreDir = path.join(tempDir, 'restore');
    service.restoreCheckpoint({ projectId: 'project-1', checkpointId: result.checkpointId, targetDir: restoreDir });
    assert.equal(fs.readFileSync(path.join(restoreDir, 'a.txt'), 'utf8'), 'real', '归档的必须是授权内容');
  } finally {
    if (fs.existsSync(projectDir)) {
      fs.unlinkSync(projectDir);
    }
    fs.renameSync(`${projectDir}-orig`, projectDir);
  }
});

test('R13b: 授权保存后、turn 开始前替换授权根 → 拒绝采集', { skip: capSkip }, () => {
  // GPT 复审 #1 探针复现：策略保存时根是真实的；之后根被换成外部 junction，
  // 授权检查若重新解析授权路径就会把外部目录当成已授权。
  // 修复后：授权根身份在 savePolicy 时固定（authorizedDirPins），当前 realpath
  // 与 pin 不符即 authorized_root_replaced。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideContent = 'post-authorization-swap-content';
  fs.writeFileSync(path.join(outsideDir, 'external.txt'), outsideContent);
  fs.writeFileSync(path.join(projectDir, 'real.txt'), 'real');

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  // 对照：替换前采集成功，证明 pin 与根身份最初是满足的。
  const before = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(before.captured, true);

  fs.renameSync(projectDir, `${projectDir}-orig`);
  fs.symlinkSync(outsideDir, projectDir, 'dir');

  const after = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-2' }));
  try {
    assert.equal(after.captured, false, '授权后根被替换必须拒绝采集');
    assert.equal(after.reason, 'authorized_root_replaced', `实际原因 ${after.reason}`);
    assertNoBlobContains(tempDir, outsideContent);
  } finally {
    fs.unlinkSync(projectDir);
    fs.renameSync(`${projectDir}-orig`, projectDir);
  }
});

test('R14: session 未知/损坏维度一律降级——null message、未知条目、compaction 断引用、重复 id', { skip: capSkip }, () => {
  // GPT 复审 #3 的四个探针：这些输入此前全部 complete=true 且被归档。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  const HEADER = '{"type":"session","version":3,"id":"s1"}';
  const MSG = (id, parent, text) =>
    `{"type":"message","id":"${id}","parentId":"${parent}","message":{"role":"user","content":[{"type":"text","text":"${text}"}]}}`;
  const cases = [
    ['null-message.jsonl', `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":null}\n`,
      'session_invalid_message:line_2'],
    ['unknown-type.jsonl', `${HEADER}\n{"type":"attachment_ref","id":"a1","parentId":"s1","path":"/tmp/secret.png"}\n`,
      'session_unverified_entry_type:line_2:attachment_ref'],
    ['compaction-broken.jsonl',
      `${HEADER}\n${MSG('m1', 's1', 'hi')}\n{"type":"compaction","id":"c1","parentId":"m1","summary":"s","firstKeptEntryId":"nonexistent"}\n`,
      'session_compaction_ref_broken:line_3'],
    ['dup-id.jsonl', `${HEADER}\n${MSG('m1', 's1', 'a')}\n${MSG('m1', 'm1', 'b')}\n`,
      'session_duplicate_entry_id:line_3'],
  ];
  let turn = 0;
  for (const [name, text, reason] of cases) {
    turn += 1;
    const sessionPath = path.join(tempDir, name);
    fs.writeFileSync(sessionPath, text);
    const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
      turnId: `turn-r14-${turn}`,
      deliveryMode: 'resume',
      sessionPath,
    }));
    assert.equal(result.captured, true, name);
    assert.equal(result.checkpoint.replayInput.complete, false, name);
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes(reason),
      `${name} 期望 ${reason}，实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
    assert.equal(result.checkpoint.replayInput.sessionBlobHash, '', `${name} 未验证材料不得归档`);
    assert.equal(result.checkpoint.strictEvalEligible, false);
  }

  // 合法 compaction（firstKeptEntryId 指向存在的条目）可以归档。
  const okPath = path.join(tempDir, 'ok-compaction.jsonl');
  fs.writeFileSync(okPath,
    `${HEADER}\n${MSG('m1', 's1', 'hi')}\n${MSG('m2', 'm1', 'keep me')}\n{"type":"compaction","id":"c1","parentId":"m2","summary":"summarized","firstKeptEntryId":"m2"}\n`);
  const ok = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-r14-ok',
    deliveryMode: 'resume',
    sessionPath: okPath,
  }));
  assert.equal(ok.checkpoint.replayInput.complete, true, ok.checkpoint.replayInput.incompleteReasons.join(','));
  assert.ok(ok.checkpoint.replayInput.sessionBlobHash);
  assert.equal(ok.checkpoint.strictEvalEligible, false);
});

test('R15: skill 空内容不得绕过校验——声明集合与归档集合必须对账', { skip: capSkip }, () => {
  // GPT 复审 #3：非空 sha256 + content="" 曾绕过缺失检查，complete=true 且归档数为 0。
  const crypto = require('node:crypto');
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  const runConfig = { provider: 'p', model: 'm', promptVersion: 'v1', skillIds: ['demo-skill'] };
  const configSnapshot = validConfigSnapshot({ agentPromptVersion: 'v1' });

  // 1) 空内容 + 非空内容hash → hash 不匹配，拒绝归档
  let result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    runConfig,
    harness: {
      serverVersion: 'test-server',
      configSnapshot,
      skillSnapshots: [{ id: 'demo-skill', source: 'project', sha256: crypto.createHash('sha256').update('non-empty').digest('hex'), content: '' }],
    },
  }));
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('skill_snapshot_hash_mismatch:demo-skill'));
  assert.equal(result.checkpoint.replayInput.harness.skillSnapshots.length, 0, '未通过校验的快照不得出现在归档清单');

  // 2) 合法的空 skill（内容为空串且 hash 匹配）可以归档
  const emptyHash = crypto.createHash('sha256').update('').digest('hex');
  result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-2',
    runConfig,
    harness: {
      serverVersion: 'test-server',
      configSnapshot,
      skillSnapshots: [{ id: 'demo-skill', source: 'project', sha256: emptyHash, content: '' }],
    },
  }));
  assert.equal(result.checkpoint.replayInput.complete, true, result.checkpoint.replayInput.incompleteReasons.join(','));
  assert.equal(result.checkpoint.replayInput.harness.skillSnapshots[0].blobHash, emptyHash);
  assert.equal(result.checkpoint.strictEvalEligible, false);
});


test('R16a: ABA 竞态（首扫后换根、二扫前换回）——fd 钉住对象，外部内容不可读', { skip: capSkip }, () => {
  // GPT 复审 #1 ABA 探针演进：旧实现用“读后 lstat 与 fstat 比 dev/ino”拦截换根，
  // 但换根横跨单次读取且及时换回仍可骗过路径名检查。受限读取把授权绑定到目录
  // 对象本身：路径如何换/换回，openat2 始终相对持有的根 fd 解析——ABA 时序与结论
  // 无关，外部内容不会被读取。采集以授权内容完成（content-verified）。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideContent = 'aba-external-content-must-not-persist';
  fs.writeFileSync(path.join(outsideDir, 'a.txt'), outsideContent);
  const aPath = path.join(projectDir, 'a.txt');
  fs.writeFileSync(aPath, 'real');

  const service = makeService(tempDir, {
    afterScan: (dir, attempt) => {
      if (attempt === 0) {
        fs.renameSync(dir, `${dir}-orig`);
        fs.symlinkSync(outsideDir, dir, 'dir');
      }
    },
    afterFirstScan: (dir, attempt) => {
      if (attempt === 0 && fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
        fs.unlinkSync(dir);
        fs.renameSync(`${dir}-orig`, dir);
      }
    },
  });
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  try {
    assert.equal(result.captured, true, `ABA 与受限读取结论无关：${result.reason}`);
    assertNoBlobContains(tempDir, outsideContent);
    const restoreDir = path.join(tempDir, 'restore');
    service.restoreCheckpoint({ projectId: 'project-1', checkpointId: result.checkpointId, targetDir: restoreDir });
    assert.equal(fs.readFileSync(path.join(restoreDir, 'a.txt'), 'utf8'), 'real', '归档的必须是授权内容');
  } finally {
    if (fs.existsSync(projectDir) && fs.lstatSync(projectDir).isSymbolicLink()) {
      fs.unlinkSync(projectDir);
      fs.renameSync(`${projectDir}-orig`, projectDir);
    }
  }
});

test('R16b: 换根横跨整个写盘阶段、attempt 末换回——受限读取与暂存提交均不受骗', { skip: capSkip }, () => {
  // 持续窗口探针：旧实现中换根横跨 open→read→读后检查可让外部内容进 staging，
  // 仅靠阶段末检查+回滚兜底（staging 本身已是落盘）。受限读取下外部内容不会到达
  // helper 输出，staging 里根本不存在越权字节。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideContent = 'sustained-swap-content-must-not-persist';
  fs.writeFileSync(path.join(outsideDir, 'a.txt'), outsideContent);
  const aPath = path.join(projectDir, 'a.txt');
  fs.writeFileSync(aPath, 'real');

  const service = makeService(tempDir, {
    afterScan: (dir, attempt) => {
      if (attempt === 0) {
        fs.renameSync(dir, `${dir}-orig`);
        fs.symlinkSync(outsideDir, dir, 'dir');
      }
    },
    afterFirstScan: (dir, attempt) => {
      if (attempt === 0 && fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
        fs.unlinkSync(dir);
        fs.renameSync(`${dir}-orig`, dir);
      }
    },
  });
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  try {
    assert.equal(result.captured, true, `受限读取不受持续换根影响：${result.reason}`);
    assertNoBlobContains(tempDir, outsideContent);
    const restoreDir = path.join(tempDir, 'restore');
    service.restoreCheckpoint({ projectId: 'project-1', checkpointId: result.checkpointId, targetDir: restoreDir });
    assert.equal(fs.readFileSync(path.join(restoreDir, 'a.txt'), 'utf8'), 'real');
  } finally {
    if (fs.existsSync(projectDir) && fs.lstatSync(projectDir).isSymbolicLink()) {
      fs.unlinkSync(projectDir);
      fs.renameSync(`${projectDir}-orig`, projectDir);
    }
  }
});

test('R17: session 版本未钉死——缺版本/不支持版本一律不完整且不归档', { skip: capSkip }, () => {
  // GPT 复审 #3：version=999 曾 complete=true 且归档。版本钉死 pi CURRENT_SESSION_VERSION=3。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  const MSG = '{"type":"message","id":"m1","parentId":"s1","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}';
  const cases = [
    ['version-999.jsonl', `{"type":"session","version":999,"id":"s1"}\n${MSG}\n`, 'session_unsupported_version'],
    ['version-missing.jsonl', `{"type":"session","id":"s1"}\n${MSG}\n`, 'session_header_version_missing'],
    ['version-2.jsonl', `{"type":"session","version":2,"id":"s1"}\n${MSG}\n`, 'session_unsupported_version'],
  ];
  let turn = 0;
  for (const [name, text, reason] of cases) {
    turn += 1;
    const sessionPath = path.join(tempDir, name);
    fs.writeFileSync(sessionPath, text);
    const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
      turnId: `turn-r17-${turn}`,
      deliveryMode: 'resume',
      sessionPath,
    }));
    assert.equal(result.checkpoint.replayInput.complete, false, name);
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes(reason),
      `${name} 期望 ${reason}，实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
    assert.equal(result.checkpoint.replayInput.sessionBlobHash, '', `${name} 未验证材料不得归档`);
  }
});

test('R18: message role 白名单与内容块逐字段校验——未知 role/缺字段一律不完整', { skip: capSkip }, () => {
  // GPT 复审 #3：未知 role + 缺 text 字段的 text 块曾 complete=true。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  const HEADER = '{"type":"session","version":3,"id":"s1"}';
  const cases = [
    ['unknown-role.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"system","content":[{"type":"text","text":"x"}]}}\n`,
      'session_unverified_message_role:line_2:system'],
    ['text-missing-text.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"user","content":[{"type":"text"}]}}\n`,
      'session_invalid_content_block:line_2:text_missing_text'],
    ['toolcall-missing-arguments.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"assistant","api":"openai-responses","provider":"openai","model":"m","usage":{},"stopReason":"stop","content":[{"type":"toolCall","id":"t1","name":"read"}]}}\n`,
      'session_invalid_content_block:line_2:toolcall_missing_arguments'],
    ['thinking-missing-thinking.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"assistant","api":"openai-responses","provider":"openai","model":"m","usage":{},"stopReason":"stop","content":[{"type":"thinking"}]}}\n`,
      'session_invalid_content_block:line_2:thinking_missing_thinking'],
    ['image-missing-data.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"user","content":[{"type":"image","url":"file:///x.png"}]}}\n`,
      'session_invalid_content_block:line_2:image_missing_data'],
    ['toolresult-missing-call-id.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"toolResult","toolName":"read","isError":false,"content":[{"type":"text","text":"ok"}]}}\n`,
      'session_invalid_content_block:line_2:toolresult_missing_toolCallId'],
  ];
  let turn = 0;
  for (const [name, text, reason] of cases) {
    turn += 1;
    const sessionPath = path.join(tempDir, name);
    fs.writeFileSync(sessionPath, text);
    const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
      turnId: `turn-r18-${turn}`,
      deliveryMode: 'resume',
      sessionPath,
    }));
    assert.equal(result.checkpoint.replayInput.complete, false, name);
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes(reason),
      `${name} 期望 ${reason}，实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
    assert.equal(result.checkpoint.replayInput.sessionBlobHash, '', `${name} 未验证材料不得归档`);
  }

  // 正例：assistant toolCall + toolResult 全字段可归档（strict 仍 false）。
  const okPath = path.join(tempDir, 'ok-tool.jsonl');
  fs.writeFileSync(okPath,
    `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"assistant","api":"openai-responses","provider":"openai","model":"m","usage":{},"stopReason":"toolUse","content":[{"type":"toolCall","id":"t1","name":"read","arguments":{"path":"a.txt"}}]}}\n{"type":"message","id":"m2","parentId":"m1","message":{"role":"toolResult","toolCallId":"t1","toolName":"read","isError":false,"content":[{"type":"text","text":"aaa"}]}}\n`);
  const ok = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-r18-ok',
    deliveryMode: 'resume',
    sessionPath: okPath,
  }));
  assert.equal(ok.checkpoint.replayInput.complete, true, ok.checkpoint.replayInput.incompleteReasons.join(','));
  assert.ok(ok.checkpoint.replayInput.sessionBlobHash);
});

test('R19: compaction firstKeptEntryId 自引用/前向引用一律拒绝', { skip: capSkip }, () => {
  // GPT 复审 #3：firstKeptEntryId 引用自身曾 complete=true。引用必须指向该行之前出现的条目。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  const HEADER = '{"type":"session","version":3,"id":"s1"}';
  const MSG = (id, parent, text) =>
    `{"type":"message","id":"${id}","parentId":"${parent}","message":{"role":"user","content":[{"type":"text","text":"${text}"}]}}`;
  const cases = [
    ['self-ref.jsonl',
      `${HEADER}\n${MSG('m1', 's1', 'hi')}\n{"type":"compaction","id":"c1","parentId":"m1","summary":"s","firstKeptEntryId":"c1"}\n`,
      'session_compaction_ref_broken:line_3'],
    ['forward-ref.jsonl',
      `${HEADER}\n${MSG('m1', 's1', 'hi')}\n{"type":"compaction","id":"c1","parentId":"m1","summary":"s","firstKeptEntryId":"m2"}\n${MSG('m2', 'c1', 'later')}\n`,
      'session_compaction_ref_broken:line_3'],
  ];
  let turn = 0;
  for (const [name, text, reason] of cases) {
    turn += 1;
    const sessionPath = path.join(tempDir, name);
    fs.writeFileSync(sessionPath, text);
    const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
      turnId: `turn-r19-${turn}`,
      deliveryMode: 'resume',
      sessionPath,
    }));
    assert.equal(result.checkpoint.replayInput.complete, false, name);
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes(reason),
      `${name} 期望 ${reason}，实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
    assert.equal(result.checkpoint.replayInput.sessionBlobHash, '');
  }
});

test('R20: branch_summary 缺 summary 或 fromId 悬空一律不完整；合法条目可归档', { skip: capSkip }, () => {
  // GPT 复审 #3：缺 summary 的 branch_summary 曾 complete=true（校验被条件跳过）。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  const HEADER = '{"type":"session","version":3,"id":"s1"}';
  const MSG = (id, parent, text) =>
    `{"type":"message","id":"${id}","parentId":"${parent}","message":{"role":"user","content":[{"type":"text","text":"${text}"}]}}`;
  const cases = [
    ['missing-summary.jsonl',
      `${HEADER}\n${MSG('m1', 's1', 'hi')}\n{"type":"branch_summary","id":"b1","parentId":"m1","fromId":"m1"}\n`,
      'session_branch_summary_incomplete:line_3'],
    ['dangling-from.jsonl',
      `${HEADER}\n${MSG('m1', 's1', 'hi')}\n{"type":"branch_summary","id":"b1","parentId":"m1","summary":"s","fromId":"nonexistent"}\n`,
      'session_branch_ref_broken:line_3'],
    ['self-from.jsonl',
      `${HEADER}\n${MSG('m1', 's1', 'hi')}\n{"type":"branch_summary","id":"b1","parentId":"m1","summary":"s","fromId":"b1"}\n`,
      'session_branch_ref_broken:line_3'],
  ];
  let turn = 0;
  for (const [name, text, reason] of cases) {
    turn += 1;
    const sessionPath = path.join(tempDir, name);
    fs.writeFileSync(sessionPath, text);
    const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
      turnId: `turn-r20-${turn}`,
      deliveryMode: 'resume',
      sessionPath,
    }));
    assert.equal(result.checkpoint.replayInput.complete, false, name);
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes(reason),
      `${name} 期望 ${reason}，实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
    assert.equal(result.checkpoint.replayInput.sessionBlobHash, '');
  }

  const okPath = path.join(tempDir, 'ok-branch.jsonl');
  fs.writeFileSync(okPath,
    `${HEADER}\n${MSG('m1', 's1', 'hi')}\n${MSG('m2', 'm1', 'branch point')}\n{"type":"branch_summary","id":"b1","parentId":"m2","summary":"summarized branch","fromId":"m2"}\n`);
  const ok = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-r20-ok',
    deliveryMode: 'resume',
    sessionPath: okPath,
  }));
  assert.equal(ok.checkpoint.replayInput.complete, true, ok.checkpoint.replayInput.incompleteReasons.join(','));
  assert.ok(ok.checkpoint.replayInput.sessionBlobHash);
});

test('R21: configSnapshot 空对象或缺必填键一律 harness_tool_config_unverified', { skip: capSkip }, () => {
  // GPT 复审 #3：configSnapshot={} 曾 complete=true。空对象不是有效配置快照。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  const cases = [
    ['empty object', {}],
    ['missing piVersion', { agentPromptVersion: 'v1', toolBridgeEnabled: true, deliveryMode: 'fresh', agentName: 'a' }],
    ['missing deliveryMode', { agentPromptVersion: 'v1', toolBridgeEnabled: true, piVersion: '1.0.0', agentName: 'a' }],
    ['empty piVersion', { agentPromptVersion: 'v1', toolBridgeEnabled: true, piVersion: '  ', deliveryMode: 'fresh', agentName: 'a' }],
    ['wrong toolBridgeEnabled type', { agentPromptVersion: 'v1', toolBridgeEnabled: 'yes', piVersion: '1.0.0', deliveryMode: 'fresh', agentName: 'a' }],
    ['bad deliveryMode enum', { agentPromptVersion: 'v1', toolBridgeEnabled: true, piVersion: '1.0.0', deliveryMode: 'unknown', agentName: 'a' }],
  ];
  let turn = 0;
  for (const [name, snapshot] of cases) {
    turn += 1;
    const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
      turnId: `turn-r21-${turn}`,
      harness: { serverVersion: 'test-server', configSnapshot: snapshot, skillSnapshots: [] },
    }));
    assert.equal(result.checkpoint.replayInput.complete, false, name);
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('harness_tool_config_unverified'),
      `${name} 实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
    assert.equal(result.checkpoint.replayInput.harness.configSnapshotHash, undefined, `${name} 无效快照不得归档`);
  }

  // 正例：全字段快照归档并记录 hash。
  const ok = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-r21-ok' }));
  assert.equal(ok.checkpoint.replayInput.complete, true, ok.checkpoint.replayInput.incompleteReasons.join(','));
  assert.ok(ok.checkpoint.replayInput.harness.configSnapshotHash, '有效快照必须归档并记录 hash');
});

// ---------- 第七轮阻断项（GPT E3 rev19）：Git 读取边界 + 漏采完整性 ----------

test('R33: 采集与容量预估不走目标路径 readdir（枚举也必须绑定受限根）', { skip: capSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(path.join(projectDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sub', 'ok.txt'), 'safe');
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const original = fs.readdirSync;
  fs.readdirSync = function (target, ...args) {
    if (typeof target === 'string' && (target === projectDir || target.startsWith(projectDir + path.sep))) {
      throw new Error('unconstrained_target_enumeration');
    }
    return original.call(this, target, ...args);
  };
  try {
    const result = service.captureTurnCheckpoint(captureArgs(projectDir));
    assert.equal(result.captured, true, result.reason);
    assert.ok(result.checkpoint.files['sub/ok.txt'], 'cannot silently turn enumeration failure into an empty snapshot');
    const estimate = service.estimateDirectory('project-1', projectDir);
    assert.equal(estimate.ok, true, estimate.reason);
    assert.equal(estimate.fileCount, 1);
  } finally { fs.readdirSync = original; }
});

// 权限拒绝是稳定状态的前提是 DAC 拒绝真的生效（root 带 CAP_DAC_OVERRIDE 时 chmod 000
// 仍可读）。探测一次，不具备条件即明确跳过（缺证据），不冒充测试通过。
function dacDeniedProbe(t) {
  const tempDir = withTempDir();
  const probe = path.join(tempDir, 'probe.txt');
  fs.writeFileSync(probe, 'x');
  fs.chmodSync(probe, 0o000);
  try {
    fs.readFileSync(probe);
    t.skip('当前身份可读取 chmod 000 文件（DAC override），无法验证权限拒绝路径');
    return false;
  } catch {
    return true;
  } finally {
    fs.chmodSync(probe, 0o644);
  }
}

test('R28: 授权文件读取被拒（chmod 000）必须显式降级——清单留缺口、恢复不再宣称完整', { skip: capSkip }, (t) => {
  // GPT 复审 #2 第七轮探针复现：denied.txt 三轮读取被拒后不进清单，却
  // captured=true / complete=true / incompleteReasons=[]，恢复 ok=true 且
  // replayInputComplete=true（实际只有 ok.txt）。修复后：缺口入清单、complete=false、
  // 恢复侧如实上报；稳定拒绝不得触发重试风暴。
  if (!dacDeniedProbe(t)) {
    return;
  }
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'ok.txt'), 'ok-content');
  fs.writeFileSync(path.join(projectDir, 'denied.txt'), 'denied-content');
  gitInit(projectDir);
  execFileSync('git', ['add', 'ok.txt'], { cwd: projectDir }); // denied.txt 保持 untracked
  fs.chmodSync(path.join(projectDir, 'denied.txt'), 0o000);

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  try {
    assert.equal(result.captured, true, `可读文件仍应采集：${result.reason}`);
    assert.equal(result.checkpoint.replayInput.complete, false, '漏采材料不得宣称完整');
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('file_unreadable:denied.txt'),
      `实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
    const uncaptured = result.checkpoint.uncaptured || [];
    assert.ok(uncaptured.some((entry) => entry.path === 'denied.txt' && entry.reason === 'denied'),
      `uncaptured 清单必须包含 denied.txt：${JSON.stringify(uncaptured)}`);
    assert.equal(result.checkpoint.stats.unreadableFiles, 1);
    assert.equal(result.checkpoint.consistency.retries, 0, '稳定权限拒绝不得触发重试');
    assert.equal(result.checkpoint.files['ok.txt'].type, 'file');
    assert.equal(result.checkpoint.files['denied.txt'], undefined, '未采集文件不得携带内容 hash 进清单');

    const restoreDir = path.join(tempDir, 'restore');
    const restored = service.restoreCheckpoint({ projectId: 'project-1', checkpointId: result.checkpointId, targetDir: restoreDir });
    assert.equal(restored.ok, true, '已采集内容的包内校验可成功');
    assert.equal(restored.replayInputComplete, false, '恢复侧不得再上报输入完整');
    assert.ok((restored.uncapturedInScope || []).some((entry) => entry.path === 'denied.txt'),
      '恢复侧必须报告缺口清单');
    assert.equal(fs.readFileSync(path.join(restoreDir, 'ok.txt'), 'utf8'), 'ok-content');
  } finally {
    fs.chmodSync(path.join(projectDir, 'denied.txt'), 0o644);
  }
});

test('R29: FIFO 等特殊文件必须显式降级——special_file_not_captured', { skip: capSkip }, () => {
  // GPT 复审 #2 第七轮：FIFO 被跳过却 complete=true。修复后：未忽略的特殊文件
  // 进 uncaptured 缺口清单并使 complete=false。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  execFileSync('mkfifo', [path.join(projectDir, 'fifo1')]);

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true, result.reason);
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('special_file_not_captured:fifo1'),
    `实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
  assert.ok((result.checkpoint.uncaptured || []).some((entry) => entry.path === 'fifo1' && entry.reason === 'special_file'));
  assert.equal(result.checkpoint.consistency.retries, 0, '特殊文件是稳定状态，不得触发重试');

  const restoreDir = path.join(tempDir, 'restore');
  const restored = service.restoreCheckpoint({ projectId: 'project-1', checkpointId: result.checkpointId, targetDir: restoreDir });
  assert.equal(restored.replayInputComplete, false);
  assert.ok((restored.uncapturedInScope || []).some((entry) => entry.path === 'fifo1'));
});

test('R30: 不可读子目录必须显式降级——directory_unreadable，不静默丢内容', { skip: capSkip }, (t) => {
  if (!dacDeniedProbe(t)) {
    return;
  }
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(path.join(projectDir, 'sealed'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'sealed', 'inside.txt'), 'unreachable');
  fs.writeFileSync(path.join(projectDir, 'ok.txt'), 'ok');
  fs.chmodSync(path.join(projectDir, 'sealed'), 0o000);

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  try {
    assert.equal(result.captured, true, `可读部分仍应采集：${result.reason}`);
    assert.equal(result.checkpoint.replayInput.complete, false);
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('directory_unreadable:sealed'),
      `实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
    assert.ok((result.checkpoint.uncaptured || []).some((entry) => entry.path === 'sealed' && entry.reason === 'directory_unreadable'));
    assert.equal(result.checkpoint.files['ok.txt'].type, 'file');
    assert.equal(result.checkpoint.files['sealed/inside.txt'], undefined, '不可读目录内容不得出现在清单');
  } finally {
    fs.chmodSync(path.join(projectDir, 'sealed'), 0o755);
  }
});

test('R31: 采集路径不依赖 git 可执行文件——PATH 无 git 时分类仍正确', { skip: capSkip }, () => {
  // 修复前：git 缺失时回退全量遍历，ignored.log 会被错误采集（分类丢失）。
  // 修复后：index/gitignore 由内置解析器经受限读取处理，与 git 可执行文件无关。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'tracked.txt'), 'tracked');
  fs.writeFileSync(path.join(projectDir, 'ignored.log'), 'ignored');
  fs.writeFileSync(path.join(projectDir, 'free.txt'), 'free');
  fs.writeFileSync(path.join(projectDir, '.gitignore'), 'ignored.log\n');
  gitInit(projectDir);
  execFileSync('git', ['add', 'tracked.txt'], { cwd: projectDir });

  // PATH 只保留 python3（helper 需要），不含 git。
  const fakeBin = path.join(tempDir, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const pythonPath = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
  fs.symlinkSync(pythonPath, path.join(fakeBin, 'python3'));

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const originalPath = process.env.PATH;
  process.env.PATH = fakeBin;
  let result;
  try {
    result = service.captureTurnCheckpoint(captureArgs(projectDir));
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(result.captured, true, `无 git 可执行文件时采集应正常：${result.reason}`);
  assert.ok(result.checkpoint.files['tracked.txt'], 'tracked 文件在清单');
  assert.ok(result.checkpoint.files['free.txt'], 'untracked 未忽略文件在清单');
  assert.equal(result.checkpoint.files['ignored.log'], undefined, '内置解析器必须正确应用 ignore 规则');
  assert.equal(result.checkpoint.gitMetadata, 'ok', `git 元数据状态：${result.checkpoint.gitMetadata}`);
  assert.equal(result.checkpoint.replayInput.complete, true,
    `内部元数据完整可读时不应降级：${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
});

test('R32: gitfile 外置元数据不自动获授权——须 authorizedInputDirs 显式授权', { skip: capSkip }, () => {
  // git worktree 形态的 .git 是 gitfile，指向主仓库的外部 gitdir。
  // 未授权：降级采集（全部按未知 tracked 状态多采）+ git_metadata_not_authorized；
  // 显式授权主仓库 .git 后：分类正确（ignore 规则生效），不再降级。
  const tempDir = withTempDir();
  const mainRepo = path.join(tempDir, 'main');
  fs.mkdirSync(mainRepo, { recursive: true });
  fs.writeFileSync(path.join(mainRepo, 'tracked.txt'), 'tracked');
  fs.writeFileSync(path.join(mainRepo, '.gitignore'), 'ignored.log\n');
  gitInit(mainRepo);
  execFileSync('git', ['add', '-A'], { cwd: mainRepo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: mainRepo });
  const worktreeDir = path.join(tempDir, 'wt');
  execFileSync('git', ['worktree', 'add', worktreeDir], { cwd: mainRepo });
  fs.writeFileSync(path.join(worktreeDir, 'ignored.log'), 'ignored-in-worktree');
  fs.writeFileSync(path.join(worktreeDir, 'dirty.txt'), 'dirty-untracked');

  // 子情形 A：无输入授权 → 外置 gitdir 不读，降级多采。
  const serviceA = makeService(tempDir, { captureRoot: path.join(tempDir, 'capture-root-a') });
  serviceA.savePolicy('project-1', {
    status: 'enabled',
    authorizedDirs: [worktreeDir],
    authorizedInputDirs: [],
  });
  serviceA.authorizeProject('project-1');
  const unauth = serviceA.captureTurnCheckpoint(captureArgs(worktreeDir));
  assert.equal(unauth.captured, true, `降级采集仍应完成：${unauth.reason}`);
  assert.equal(unauth.checkpoint.replayInput.complete, false);
  assert.ok(unauth.checkpoint.replayInput.incompleteReasons.includes('git_metadata_not_authorized'),
    `实际 ${unauth.checkpoint.replayInput.incompleteReasons.join(',')}`);
  assert.ok(unauth.checkpoint.files['tracked.txt'], 'tracked 文件仍采集');
  assert.ok(unauth.checkpoint.files['ignored.log'], '无分类依据时宁多采（ignored.log 也在清单）');
  assert.equal(unauth.checkpoint.gitMetadata, 'degraded');

  // 子情形 B：显式授权主仓库 .git → 分类正确。
  const serviceB = makeService(tempDir, { captureRoot: path.join(tempDir, 'capture-root-b') });
  serviceB.savePolicy('project-1', {
    status: 'enabled',
    authorizedDirs: [worktreeDir],
    authorizedInputDirs: [path.join(mainRepo, '.git')],
  });
  serviceB.authorizeProject('project-1');
  const authed = serviceB.captureTurnCheckpoint(captureArgs(worktreeDir));
  assert.equal(authed.captured, true, `授权后采集应正常：${authed.reason}`);
  assert.ok(authed.checkpoint.files['tracked.txt']);
  assert.ok(authed.checkpoint.files['dirty.txt']);
  assert.equal(authed.checkpoint.files['ignored.log'], undefined, '授权后 ignore 规则正确生效');
  assert.equal(authed.checkpoint.gitMetadata, 'ok', `实际 ${authed.checkpoint.gitMetadata}`);
  assert.equal(authed.checkpoint.replayInput.complete, true,
    `实际 ${authed.checkpoint.replayInput.incompleteReasons.join(',')}`);
});
