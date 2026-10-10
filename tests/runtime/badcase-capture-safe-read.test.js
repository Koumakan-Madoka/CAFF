// W2 第五轮：受限读取（openat2 受限域）与 session 维度清单的专项回归。
//
// - win32：能力探测失败关闭，拒绝采集且零目标内容读取（GPT 复审边界：能力缺失
//   应在扫描用户目录前返回不可用）。
// - linux：真实文件系统上的根/中间目录替换、绝对符号链接逃逸、bind mount 穿越、
//   helper 故障、能力缺失——全部在 Linux（容器）内跑真，不以 Windows 夹具冒充。
// - session 维度：最小已验证子集的正反例（钉 pi 0.85.1 实现）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { withTempDir } = require('../helpers/temp-dir');
const { capability, capSkip } = require('../helpers/capture-capability');
const {
  createBadcaseCaptureService,
} = require('../../build/server/domain/runtime/badcase-capture/index');
const { detectCaptureCapability } = require('../../build/server/domain/runtime/badcase-capture/safe-read');

const winSkip = process.platform === 'win32' ? false : 'win32-only test';
const linuxSkip = process.platform === 'linux' ? capSkip : 'linux-only test';

function makeService(tempDir, serviceOptions = {}) {
  return createBadcaseCaptureService({
    captureRoot: path.join(tempDir, 'capture-root'),
    ...serviceOptions,
  });
}

function enabledPolicy(projectDir, overrides = {}) {
  return { status: 'enabled', authorizedDirs: [projectDir], ...overrides };
}

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
      configSnapshot: validConfigSnapshot(),
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

const HEADER = '{"type":"session","version":3,"id":"s1"}';
const USER_MSG = (id, parent, text) =>
  `{"type":"message","id":"${id}","parentId":"${parent}","message":{"role":"user","content":[{"type":"text","text":"${text}"}]}}`;
const ASSISTANT_TEXT = (id, parent, text) =>
  `{"type":"message","id":"${id}","parentId":"${parent}","message":{"role":"assistant","api":"openai-responses","provider":"openai","model":"m","usage":{},"stopReason":"stop","content":[{"type":"text","text":"${text}"}]}}`;

// ---------- S1: win32 失败关闭 ----------

test('S1: win32 能力缺失 → 拒绝采集且零目标内容读取', { skip: winSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  fs.writeFileSync(path.join(projectDir, 'b.txt'), 'bbb');

  // 统计对目标树内容的任何读取（元数据 lstat/readdir 允许，内容读取不允许）。
  let targetContentReads = 0;
  const originalReadFileSync = fs.readFileSync;
  const originalOpenSync = fs.openSync;
  const originalCreateReadStream = fs.createReadStream;
  fs.readFileSync = function (p, ...args) {
    if (typeof p === 'string' && p.startsWith(projectDir)) {
      targetContentReads += 1;
    }
    return originalReadFileSync.call(this, p, ...args);
  };
  fs.openSync = function (p, ...args) {
    if (typeof p === 'string' && p.startsWith(projectDir) && !p.endsWith('project')) {
      targetContentReads += 1;
    }
    return originalOpenSync.call(this, p, ...args);
  };
  fs.createReadStream = function (p, ...args) {
    if (typeof p === 'string' && p.startsWith(projectDir)) {
      targetContentReads += 1;
    }
    return originalCreateReadStream.call(this, p, ...args);
  };

  try {
    const service = makeService(tempDir);
    service.savePolicy('project-1', enabledPolicy(projectDir));
    const result = service.captureTurnCheckpoint(captureArgs(projectDir));
    assert.equal(result.captured, false);
    assert.ok(result.reason.startsWith('capture_unavailable:safe_read_capability_missing:win32'),
      `实际原因 ${result.reason}`);
    assert.equal(targetContentReads, 0, '能力缺失时不得读取任何目标文件内容');
    assert.equal(service.store.listCheckpoints('project-1').length, 0);
    // 策略不被挂起（这不是配额/写失败），保持 enabled 但采集不可用。
    assert.equal(service.loadPolicy('project-1').status, 'enabled');
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.openSync = originalOpenSync;
    fs.createReadStream = originalCreateReadStream;
  }
});

// ---------- S2: 能力缺失（helper 无法安装） ----------

test('S2: helper 无法安装到采集存储 → capture_unavailable，无回退读取', { skip: linuxSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  // /proc 不可写 → helper 安装失败 → 能力探测失败关闭。
  const service = createBadcaseCaptureService({ captureRoot: '/proc/badcase-capture-impossible' });
  // savePolicy 也会因存储不可写失败——直接探测能力本身。
  const cap = detectCaptureCapability({ captureRoot: '/proc/badcase-capture-impossible' });
  assert.equal(cap.ok, false);
  assert.ok(cap.reason.startsWith('safe_read_capability_missing:'), `实际原因 ${cap.reason}`);
  void service;
});

// ---------- S3: 授权后根对象被替换（真实目录，非链接） ----------

test('S3: 授权后根目录对象被重建（同路径新对象）→ authorized_root_replaced', { skip: linuxSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'authorized-content');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const before = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(before.captured, true, `基线采集应成功：${before.reason}`);

  // 同路径重建：新目录对象（新 ino/btime），即便 realpath 字符串不变也必须拒绝。
  fs.renameSync(projectDir, `${projectDir}-old`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'rebuilt-content-must-not-be-captured');

  const after = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-2' }));
  try {
    assert.equal(after.captured, false);
    assert.equal(after.reason, 'authorized_root_replaced', `实际原因 ${after.reason}`);
    assertNoBlobContains(tempDir, 'rebuilt-content-must-not-be-captured');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.renameSync(`${projectDir}-old`, projectDir);
  }
});

// ---------- S4: helper 故障 ----------

test('S4: helper 被篡改/损坏 → capture_unavailable:helper_failed，不伪造成功', { skip: linuxSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const first = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(first.captured, true, `基线采集应成功：${first.reason}`);
  const usageBefore = service.computeUsage('project-1').totalBytes;

  // 篡改已安装的 helper（collector 缓存的能力仍指向该路径；spawn 必失败）。
  const helperDir = path.join(tempDir, 'capture-root', 'helper');
  const helperFiles = fs.readdirSync(helperDir).filter((name) => name.endsWith('.py'));
  assert.equal(helperFiles.length, 1);
  fs.writeFileSync(path.join(helperDir, helperFiles[0]), 'this is not python {{{\n');

  const usageAfterTamper = service.computeUsage('project-1').totalBytes;
  const second = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-2' }));
  assert.equal(second.captured, false);
  assert.ok(second.reason.startsWith('capture_unavailable:'), `实际原因 ${second.reason}`);
  assert.equal(service.computeUsage('project-1').totalBytes, usageAfterTamper,
    'helper 故障不得写入任何新字节');
  assert.equal(service.store.listCheckpoints('project-1').length, 1, '故障不得伪造新检查点');
  void usageBefore;
});

// ---------- S5: bind mount 穿越（缺特权时明确缺证据） ----------

test('S5: 树内 bind mount 指向外部 → 内核拒绝读取，外部内容零落盘', { skip: linuxSkip }, (t) => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(path.join(projectDir, 'mounted'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideContent = 'bind-mounted-content-must-not-be-captured';
  fs.writeFileSync(path.join(outsideDir, 'data.txt'), outsideContent);
  fs.writeFileSync(path.join(projectDir, 'real.txt'), 'real');

  let mounted = false;
  try {
    execFileSync('mount', ['--bind', outsideDir, path.join(projectDir, 'mounted')], { stdio: 'pipe' });
    mounted = true;
  } catch {
    t.skip('bind mount unavailable (needs CAP_SYS_ADMIN) — 本环境缺该测试能力，明确缺证据');
    return;
  }

  try {
    const service = makeService(tempDir);
    service.savePolicy('project-1', enabledPolicy(projectDir));
    const result = service.captureTurnCheckpoint(captureArgs(projectDir));
    // RESOLVE_NO_XDEV：mounted/data.txt 的读取被内核拒绝 → 一致性异常 → 重试耗尽后
    // 诚实降级（write-during-capture）或失败；任何结局外部内容不得进 CAS。
    if (result.captured) {
      assert.notEqual(result.checkpoint.consistency.evidence, 'content-verified',
        'bind mount 异常必须留下痕迹，不得宣称无异常');
      assert.equal(result.checkpoint.replayInput.complete, false);
      assert.equal(result.checkpoint.strictEvalEligible, false);
    } else {
      assert.ok(result.reason.length > 0);
    }
    assertNoBlobContains(tempDir, outsideContent);
  } finally {
    if (mounted) {
      try { execFileSync('umount', [path.join(projectDir, 'mounted')], { stdio: 'pipe' }); } catch {}
    }
  }
});

// ---------- S6: 绝对符号链接逃逸 ----------

test('S6: 树内绝对符号链接指向 /etc/hostname → 标记越界，外部内容零落盘', { skip: linuxSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'real.txt'), 'real');
  fs.symlinkSync('/etc/hostname', path.join(projectDir, 'abs-link'));

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true);
  assert.equal(result.checkpoint.files['abs-link'].escapes, true);
  assert.equal(result.checkpoint.stats.symlinkEscapes, 1);
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('symlink_escape_present'));
  const hostname = fs.readFileSync('/etc/hostname');
  assertNoBlobContains(tempDir, hostname);
});

// ---------- S7: session 维度清单（正反例） ----------

test('S7a: 最小已验证子集正例——user+assistant 文本 session 可达 complete=true', { skip: linuxSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const sessionPath = path.join(tempDir, 'ok.jsonl');
  fs.writeFileSync(sessionPath, `${HEADER}\n${USER_MSG('m1', 's1', 'hello')}\n${ASSISTANT_TEXT('m2', 'm1', 'hi there')}\n`);

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    deliveryMode: 'resume',
    sessionPath,
  }));
  assert.equal(result.captured, true, result.reason);
  assert.equal(result.checkpoint.replayInput.complete, true,
    `正例必须完整：${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
  assert.ok(result.checkpoint.replayInput.sessionBlobHash);
  assert.ok(result.checkpoint.replayInput.verifiedDimensions.includes('session_header_version'));
  assert.deepEqual(result.checkpoint.replayInput.unverifiedDimensions, []);
  assert.equal(result.checkpoint.strictEvalEligible, false, 'complete 不等于严格对照资格');
});

test('S7b: 维度降级——bashExecution/合法 base64 图像/custom 扩展状态/越界工具路径', { skip: linuxSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));

  // 合法 1x1 PNG 的严格 base64（编码形态良构，像素未验证）。
  const pngBase64 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]).toString('base64');

  const cases = [
    // [名称, session 体, 期望 unverified 维度, 是否归档]
    ['bash-execution.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"bashExecution","command":"ls -la","output":"ok","exitCode":0,"cancelled":false,"truncated":false,"timestamp":1}}\n`,
      'unanalyzable_tool_dependencies:bashExecution', true],
    ['image-valid.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"user","content":[{"type":"image","data":"${pngBase64}","mimeType":"image/png"}]}}\n`,
      'image_content_unverified', true],
    ['custom-entry.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"custom","id":"x1","parentId":"m1","customType":"myExtension","data":{"state":1}}\n`,
      'extension_state_unverified:myExtension', true],
    ['tool-out-of-scope.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"assistant","api":"a","provider":"p","model":"m","usage":{},"stopReason":"toolUse","content":[{"type":"toolCall","id":"t1","name":"read","arguments":{"path":"/etc/hostname"}}]}}\n`,
      'out_of_scope_path_dependency:read', true],
    ['tool-bash.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"assistant","api":"a","provider":"p","model":"m","usage":{},"stopReason":"toolUse","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls"}}]}}\n`,
      'unanalyzable_tool_dependencies:bash', true],
  ];

  let turn = 0;
  for (const [name, text, dimension, shouldArchive] of cases) {
    turn += 1;
    const sessionPath = path.join(tempDir, name);
    fs.writeFileSync(sessionPath, text);
    const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
      turnId: `turn-s7b-${turn}`,
      deliveryMode: 'resume',
      sessionPath,
    }));
    assert.equal(result.captured, true, name);
    assert.equal(result.checkpoint.replayInput.complete, false, name);
    assert.ok(result.checkpoint.replayInput.unverifiedDimensions.includes(dimension),
      `${name} 期望维度 ${dimension}，实际 ${result.checkpoint.replayInput.unverifiedDimensions.join(',')}`);
    if (shouldArchive) {
      assert.ok(result.checkpoint.replayInput.sessionBlobHash, `${name} 可归档但 complete=false`);
    }
    assert.equal(result.checkpoint.strictEvalEligible, false);
  }
});

test('S7c: 结构损坏一律拒绝归档——compaction 指向头/tool 链断裂/非法 base64/model_change 缺字段', { skip: linuxSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));

  const cases = [
    // GPT 复审 #3 探针：compaction firstKeptEntryId 指向 session 头——集合存在 ≠ 合法历史引用。
    ['compaction-to-header.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"compaction","id":"c1","parentId":"m1","summary":"s","firstKeptEntryId":"s1"}\n`,
      'session_compaction_ref_broken:line_3'],
    // toolResult 引用不存在的 toolCall（链断裂）。
    ['tool-chain-broken.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"message","id":"m2","parentId":"m1","message":{"role":"toolResult","toolCallId":"nonexistent","toolName":"read","isError":false,"content":[{"type":"text","text":"x"}]}}\n`,
      'session_tool_chain_broken:line_3'],
    // 非法 base64 图像（非空字符串 ≠ 附件有效）。
    ['image-bad-base64.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"user","content":[{"type":"image","data":"%%%not-base64%%%","mimeType":"image/png"}]}}\n`,
      'session_invalid_content_block:line_2:session_attachment_malformed'],
    // model_change 缺 provider/modelId（类型名通过 ≠ 字段完整）。
    ['model-change-incomplete.jsonl',
      `${HEADER}\n{"type":"model_change","id":"c1","parentId":null}\n`,
      'session_model_change_incomplete:line_2'],
    // 投影期角色不得作为存储条目出现。
    ['projection-role.jsonl',
      `${HEADER}\n{"type":"message","id":"m1","parentId":"s1","message":{"role":"compactionSummary","summary":"s","tokensBefore":1,"timestamp":1}}\n`,
      'session_unverified_message_role:line_2:compactionSummary'],
  ];

  let turn = 0;
  for (const [name, text, reason] of cases) {
    turn += 1;
    const sessionPath = path.join(tempDir, name);
    fs.writeFileSync(sessionPath, text);
    const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
      turnId: `turn-s7c-${turn}`,
      deliveryMode: 'resume',
      sessionPath,
    }));
    assert.equal(result.captured, true, name);
    assert.equal(result.checkpoint.replayInput.complete, false, name);
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes(reason),
      `${name} 期望 ${reason}，实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
    assert.equal(result.checkpoint.replayInput.sessionBlobHash, '', `${name} 未验证材料不得归档`);
  }
});

test('S7d: branch_summary fromId 字面量 "root" 合法（pi branchWithSummary 实证）', { skip: linuxSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const sessionPath = path.join(tempDir, 'root-branch.jsonl');
  // session-manager.js branchWithSummary: fromId = leafId ?? "root"——leaf 为 null 时
  // 写字面量 "root"，此前“fromId 必须指向已存在条目”的规则会误拒合法 session。
  fs.writeFileSync(sessionPath,
    `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"branch_summary","id":"b1","parentId":"m1","fromId":"root","summary":"abandoned branch"}\n`);

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
    deliveryMode: 'resume',
    sessionPath,
  }));
  assert.equal(result.checkpoint.replayInput.complete, true,
    `fromId="root" 是合法 pi 输出：${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
  assert.ok(result.checkpoint.replayInput.sessionBlobHash);
});

// ---------- S8: 能力探测自检 ----------

test('S8: Linux 能力探测自检通过（内核/openat2/statx btime/symlink/逃逸拒绝）', { skip: linuxSkip }, () => {
  assert.equal(capability.ok, true, `能力探测应通过：${capability.reason}`);
  assert.ok(capability.helperSha256 && capability.helperSha256.length === 64);
});

test('S11: 内嵌 helper 副本与仓库审计源文件一致（embed-helper.js 防漂移）', () => {
  const crypto = require('node:crypto');
  const helperSourcePath = path.resolve(__dirname, '..', '..', 'helpers', 'badcase-capture', 'capture_helper.py');
  const onDisk = fs.readFileSync(helperSourcePath, 'utf8').replace(/\r\n/g, '\n');
  const sha = crypto.createHash('sha256').update(onDisk, 'utf8').digest('hex');
  const { HELPER_SOURCE_SHA256, HELPER_SOURCE } = require('../../build/server/domain/runtime/badcase-capture/helper-source');
  assert.equal(sha, HELPER_SOURCE_SHA256,
    'capture_helper.py 已修改但未重新生成内嵌副本：运行 node scripts/badcase-capture/embed-helper.js');
  assert.equal(HELPER_SOURCE, onDisk);
});

test('S9: 采集目标必须是授权根本身（子目录目标无独立身份 pin → 拒绝）', { skip: linuxSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const subDir = path.join(projectDir, 'sub');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'a.txt'), 'aaa');

  const service = makeService(tempDir);
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(subDir));
  assert.equal(result.captured, false);
  assert.equal(result.reason, 'target_must_be_authorized_root', `实际原因 ${result.reason}`);
});

test('S10: 中间目录在采集窗口内被替换——受限读取仍指向已授权对象', { skip: linuxSkip }, () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(path.join(projectDir, 'mid'), { recursive: true });
  fs.mkdirSync(path.join(outsideDir, 'mid'), { recursive: true });
  const outsideContent = 'intermediate-swap-content-must-not-leak';
  fs.writeFileSync(path.join(outsideDir, 'mid', 'file.txt'), outsideContent);
  fs.writeFileSync(path.join(projectDir, 'mid', 'file.txt'), 'real');

  const service = makeService(tempDir, {
    afterScan: (dir, attempt) => {
      if (attempt === 0) {
        // 替换中间目录（根本身不动）。
        fs.renameSync(path.join(dir, 'mid'), path.join(dir, 'mid-orig'));
        fs.symlinkSync(path.join(outsideDir, 'mid'), path.join(dir, 'mid'), 'dir');
      }
    },
    afterFirstScan: (dir, attempt) => {
      const midPath = path.join(dir, 'mid');
      if (attempt === 0 && fs.existsSync(midPath) && fs.lstatSync(midPath).isSymbolicLink()) {
        fs.unlinkSync(midPath);
        fs.renameSync(path.join(dir, 'mid-orig'), midPath);
      }
    },
  });
  service.savePolicy('project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  try {
    assert.equal(result.captured, true, `中间目录替换与受限读取无关：${result.reason}`);
    assertNoBlobContains(tempDir, outsideContent);
    const restoreDir = path.join(tempDir, 'restore');
    service.restoreCheckpoint({ projectId: 'project-1', checkpointId: result.checkpointId, targetDir: restoreDir });
    assert.equal(fs.readFileSync(path.join(restoreDir, 'mid', 'file.txt'), 'utf8'), 'real');
  } finally {
    const midPath = path.join(projectDir, 'mid');
    if (fs.existsSync(midPath) && fs.lstatSync(midPath).isSymbolicLink()) {
      fs.unlinkSync(midPath);
      fs.renameSync(path.join(projectDir, 'mid-orig'), midPath);
    }
  }
});
