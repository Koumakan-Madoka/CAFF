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
  return { status: 'enabled', authorizedDirs: [projectDir], authorizedInputDirs: [path.dirname(projectDir)], ...overrides };
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
    authorize(service, 'project-1', enabledPolicy(projectDir));
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
  authorize(service, 'project-1', enabledPolicy(projectDir));
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
  authorize(service, 'project-1', enabledPolicy(projectDir));
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
    authorize(service, 'project-1', enabledPolicy(projectDir));
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
  authorize(service, 'project-1', enabledPolicy(projectDir));
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
  authorize(service, 'project-1', enabledPolicy(projectDir));
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
  authorize(service, 'project-1', enabledPolicy(projectDir));

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
  authorize(service, 'project-1', enabledPolicy(projectDir));

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
  authorize(service, 'project-1', enabledPolicy(projectDir));
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
  authorize(service, 'project-1', enabledPolicy(projectDir));
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
  authorize(service, 'project-1', enabledPolicy(projectDir));
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


// ---------- 第六轮：GPT 复审 #1/#3 阻断回归 ----------

test('R22: 根身份 statx 必须绑定已持有的同一 fd（禁止按路径二次打开）', { skip: linuxSkip }, () => {
  // GPT 复审 #1 探针复现：旧实现 openConstrainedRoot 先 open（持有 fd）、再按路径
  // open 第二次做 statx。编排“第一次 open 拿到外部根、第二次 open 拿到授权根、
  // 随后路径再指向外部根”，旧实现身份比对与枚举检查均被骗过，外部内容进 CAS。
  // 修复后只有一次 open，statx 在持有 fd 上 → 外部对象身份 ≠ pin → 拒绝。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'authorized-content');
  const outsideContent = 'two-open-swap-content-must-not-leak';
  fs.writeFileSync(path.join(outsideDir, 'a.txt'), outsideContent);

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  const originalOpenSync = fs.openSync;
  const originalStatSync = fs.statSync;
  let rootOpens = 0;
  fs.openSync = function (p, ...args) {
    if (typeof p === 'string' && path.resolve(p) === projectDir) {
      rootOpens += 1;
      if (rootOpens === 1) {
        // 第一次 open（旧实现的“持有 fd”）取得外部根。
        return originalOpenSync.call(this, outsideDir, ...args);
      }
    }
    return originalOpenSync.call(this, p, ...args);
  };
  // 路径随后再指向外部根：按路径的 stat 看到外部对象（与持有 fd 一致）。
  fs.statSync = function (p, ...args) {
    if (typeof p === 'string' && path.resolve(p) === projectDir) {
      return originalStatSync.call(this, outsideDir, ...args);
    }
    return originalStatSync.call(this, p, ...args);
  };
  try {
    const result = service.captureTurnCheckpoint(captureArgs(projectDir));
    assert.equal(result.captured, false, '同一 fd 身份校验必须拒绝被替换的根');
    assert.equal(result.reason, 'authorized_root_replaced', `实际原因 ${result.reason}`);
    assert.equal(rootOpens >= 1, true);
    assertNoBlobContains(tempDir, outsideContent);
    assert.equal(service.store.listCheckpoints('project-1').length, 0, '拒绝采集不得留下检查点');
  } finally {
    fs.openSync = originalOpenSync;
    fs.statSync = originalStatSync;
  }
});

test('R23: Git 枚举不得执行仓库指定的程序（core.fsmonitor / include 注入）', { skip: linuxSkip }, () => {
  // GPT 复审 #1 探针复现：仓库 .git/config 的 core.fsmonitor 指向外部脚本时，
  // 旧实现的 git ls-files 真实执行了该脚本。修复后 Git 以隔离配置执行：
  // 命令行 -c 覆盖 + system/global/xdg 配置置空 + GIT_* 环境剥除。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'tracked-content');
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: projectDir });

  const marker = path.join(tempDir, 'fsmonitor-executed.marker');
  const hookPath = path.join(tempDir, 'evil-fsmonitor.sh');
  fs.writeFileSync(hookPath, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
  // 直接注入 + include 链间接注入（include 展开的值同样必须被命令行 -c 覆盖）。
  const includeCfg = path.join(tempDir, 'external-include.cfg');
  fs.writeFileSync(includeCfg, `[core]\n\tfsmonitor = ${hookPath}\n`);
  execFileSync('git', ['config', 'core.fsmonitor', hookPath], { cwd: projectDir });
  execFileSync('git', ['config', 'include.path', includeCfg], { cwd: projectDir });

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true, `隔离配置下采集应正常完成：${result.reason}`);
  assert.equal(fs.existsSync(marker), false, 'Git 枚举不得执行仓库指定的 fsmonitor 程序');
  assert.ok(result.checkpoint.files['a.txt'], '正常文件清单不受影响');
});

test('R24: 普通 savePolicy 不得重新钉住被替换的根；显式 authorize 才可重新授权', { skip: linuxSkip }, () => {
  // GPT 复审 #1 探针复现：旧实现 service.savePolicy 无条件 pinAuthorizedDirs——
  // 同路径换根后仅改保留天数并保存，采集就把替换目录当成已授权。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideContent = 'repin-via-save-content-must-not-leak-before-authorize';
  fs.writeFileSync(path.join(outsideDir, 'external.txt'), outsideContent);
  fs.writeFileSync(path.join(projectDir, 'real.txt'), 'real');

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const before = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(before.captured, true, `基线采集应成功：${before.reason}`);

  // 同路径换根。
  fs.renameSync(projectDir, `${projectDir}-orig`);
  fs.symlinkSync(outsideDir, projectDir, 'dir');
  try {
    const swapped = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-2' }));
    assert.equal(swapped.captured, false);
    assert.equal(swapped.reason, 'authorized_root_replaced', `实际原因 ${swapped.reason}`);

    // 普通配置保存（仅改保留天数）不得把新对象钉成已授权。
    const current = service.loadPolicy('project-1');
    service.savePolicy('project-1', { ...current, stagingRetentionDays: current.stagingRetentionDays + 1 });
    const afterPlainSave = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-3' }));
    assert.equal(afterPlainSave.captured, false, '普通保存后仍必须拒绝被替换的根');
    assert.equal(afterPlainSave.reason, 'authorized_root_replaced', `实际原因 ${afterPlainSave.reason}`);
    assertNoBlobContains(tempDir, outsideContent);

    // 显式授权动作才重新钉住：此后采集的是“已被用户明确授权的新对象”。
    service.authorizeProject('project-1');
    const afterAuthorize = service.captureTurnCheckpoint(captureArgs(projectDir, { turnId: 'turn-4' }));
    assert.equal(afterAuthorize.captured, true, `显式授权后应可采集：${afterAuthorize.reason}`);
    assert.ok(afterAuthorize.checkpoint.files['external.txt'], '新授权对象的内容在清单中');
  } finally {
    if (fs.existsSync(projectDir) && fs.lstatSync(projectDir).isSymbolicLink()) {
      fs.unlinkSync(projectDir);
    }
    fs.renameSync(`${projectDir}-orig`, projectDir);
  }
});

test('R25: 树外 session 必须有独立授权边界——未授权目录/符号链接一律不归档', { skip: linuxSkip }, () => {
  // GPT 复审 #1 探针复现：旧实现裸 readFileSync(sessionPath)，树外符号链接也被读取归档。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const sessionText = `${HEADER}\n${USER_MSG('m1', 's1', 'hello')}\n`;

  // 案例 1：策略不含任何输入授权目录 → session_not_authorized。
  const service1 = makeService(tempDir, { captureRoot: path.join(tempDir, 'capture-root-1') });
  const sessionPath1 = path.join(tempDir, 'unauthorized-session.jsonl');
  fs.writeFileSync(sessionPath1, sessionText);
  service1.savePolicy('project-1', {
    status: 'enabled',
    authorizedDirs: [projectDir],
    authorizedInputDirs: [],
  });
  service1.authorizeProject('project-1');
  const noInputAuth = service1.captureTurnCheckpoint(captureArgs(projectDir, {
    deliveryMode: 'resume',
    sessionPath: sessionPath1,
  }));
  assert.equal(noInputAuth.captured, true, noInputAuth.reason);
  assert.equal(noInputAuth.checkpoint.replayInput.complete, false);
  assert.ok(noInputAuth.checkpoint.replayInput.incompleteReasons.includes('session_not_authorized'),
    `实际 ${noInputAuth.checkpoint.replayInput.incompleteReasons.join(',')}`);
  assert.equal(noInputAuth.checkpoint.replayInput.sessionBlobHash, '', '未授权 session 不得归档');

  // 案例 2：授权输入目录内的符号链接指向目录外 → realpath 越界 → session_not_authorized。
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'badcase-outside-'));
  const outsideSession = path.join(outsideDir, 'real-session.jsonl');
  fs.writeFileSync(outsideSession, sessionText);
  const linkSession = path.join(tempDir, 'link-session.jsonl');
  fs.symlinkSync(outsideSession, linkSession);

  const service2 = makeService(tempDir, { captureRoot: path.join(tempDir, 'capture-root-2') });
  authorize(service2, 'project-1', enabledPolicy(projectDir));
  const viaLink = service2.captureTurnCheckpoint(captureArgs(projectDir, {
    deliveryMode: 'resume',
    sessionPath: linkSession,
  }));
  assert.equal(viaLink.captured, true, viaLink.reason);
  assert.equal(viaLink.checkpoint.replayInput.complete, false);
  assert.ok(viaLink.checkpoint.replayInput.incompleteReasons.includes('session_not_authorized'),
    `实际 ${viaLink.checkpoint.replayInput.incompleteReasons.join(',')}`);
  assert.equal(viaLink.checkpoint.replayInput.sessionBlobHash, '', '链接 session 不得归档');
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

test('R26: thinking_level_change/label/session_info 各有验证器——非法值拒绝归档', { skip: linuxSkip }, () => {
  // GPT 复审 #3 探针复现：thinking_level_change 缺字段或对象值此前 complete=true 且归档；
  // 固定 pi 版本会把该对象原样作为 thinkingLevel 使用。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  const cases = [
    // [名称, session 体, 期望原因(null=正例)]
    ['thinking-valid.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"thinking_level_change","id":"t1","parentId":"m1","thinkingLevel":"high"}\n`,
      null],
    ['thinking-missing.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"thinking_level_change","id":"t1","parentId":"m1"}\n`,
      'session_thinking_level_invalid:line_3'],
    ['thinking-object.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"thinking_level_change","id":"t1","parentId":"m1","thinkingLevel":{"level":"high"}}\n`,
      'session_thinking_level_invalid:line_3'],
    ['thinking-unknown.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"thinking_level_change","id":"t1","parentId":"m1","thinkingLevel":"ultra"}\n`,
      'session_thinking_level_invalid:line_3'],
    ['label-valid.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"label","id":"l1","parentId":"m1","targetId":"m1","label":"bookmark"}\n`,
      null],
    ['label-forward.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"label","id":"l1","parentId":"m1","targetId":"nonexistent","label":"x"}\n`,
      'session_label_target_unknown:line_3'],
    ['label-header.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"label","id":"l1","parentId":"m1","targetId":"s1","label":"x"}\n`,
      'session_label_target_unknown:line_3'],
    ['session-info-valid.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"session_info","id":"i1","parentId":"m1","name":"display name"}\n`,
      null],
    ['session-info-bad.jsonl',
      `${HEADER}\n${USER_MSG('m1', 's1', 'hi')}\n{"type":"session_info","id":"i1","parentId":"m1","name":42}\n`,
      'session_session_info_invalid:line_3'],
  ];
  let turn = 0;
  for (const [name, text, reason] of cases) {
    turn += 1;
    const sessionPath = path.join(tempDir, name);
    fs.writeFileSync(sessionPath, text);
    const result = service.captureTurnCheckpoint(captureArgs(projectDir, {
      turnId: `turn-r26-${turn}`,
      deliveryMode: 'resume',
      sessionPath,
    }));
    assert.equal(result.captured, true, name);
    if (reason === null) {
      assert.equal(result.checkpoint.replayInput.complete, true,
        `${name} 正例必须完整：${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
      assert.ok(result.checkpoint.replayInput.sessionBlobHash, `${name} 正例必须归档`);
    } else {
      assert.equal(result.checkpoint.replayInput.complete, false, name);
      assert.ok(result.checkpoint.replayInput.incompleteReasons.includes(reason),
        `${name} 期望 ${reason}，实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
      assert.equal(result.checkpoint.replayInput.sessionBlobHash, '', `${name} 未验证材料不得归档`);
    }
  }
});

test('R27: harness 版本与 deliveryMode 跨字段一致性——不符一律 incomplete', { skip: linuxSkip }, () => {
  // GPT 复审 #3 探针复现：piVersion=999.0.0、声明 fresh 实际 resume 此前 complete=true。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'aaa');
  const sessionPath = path.join(tempDir, 'ok.jsonl');
  fs.writeFileSync(sessionPath, `${HEADER}\n${USER_MSG('m1', 's1', 'hello')}\n`);
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));

  const badVersion = service.captureTurnCheckpoint(captureArgs(projectDir, {
    harness: {
      serverVersion: 'test-server',
      configSnapshot: validConfigSnapshot({ piVersion: '999.0.0' }),
      skillSnapshots: [],
    },
  }));
  assert.equal(badVersion.checkpoint.replayInput.complete, false);
  assert.ok(badVersion.checkpoint.replayInput.incompleteReasons.includes('harness_version_unverified'),
    `实际 ${badVersion.checkpoint.replayInput.incompleteReasons.join(',')}`);

  const modeMismatch = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-2',
    deliveryMode: 'resume',
    sessionPath,
    harness: {
      serverVersion: 'test-server',
      configSnapshot: validConfigSnapshot({ deliveryMode: 'fresh' }),
      skillSnapshots: [],
    },
  }));
  assert.equal(modeMismatch.checkpoint.replayInput.complete, false);
  assert.ok(modeMismatch.checkpoint.replayInput.incompleteReasons.includes('harness_delivery_mode_mismatch'),
    `实际 ${modeMismatch.checkpoint.replayInput.incompleteReasons.join(',')}`);

  // 正例：agent-executor 的 "pi:<version>" 上报形式与 resume 模式一致声明。
  const ok = service.captureTurnCheckpoint(captureArgs(projectDir, {
    turnId: 'turn-3',
    deliveryMode: 'resume',
    sessionPath,
    harness: {
      serverVersion: 'test-server',
      configSnapshot: validConfigSnapshot({ piVersion: 'pi:0.85.1', deliveryMode: 'resume' }),
      skillSnapshots: [],
    },
  }));
  assert.equal(ok.checkpoint.replayInput.complete, true,
    `正例必须完整：${ok.checkpoint.replayInput.incompleteReasons.join(',')}`);
});

// ---------- 平台无关单元：校验器与 pin 语义 ----------

test('S12: session 校验器单元——thinking_level_change/label/session_info（全平台）', () => {
  const { validateSessionV2 } = require('../../build/server/domain/runtime/badcase-capture/session-validator');
  const header = '{"type":"session","version":3,"id":"s1"}';
  const user = '{"type":"message","id":"m1","parentId":"s1","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}';

  const okThinking = validateSessionV2(`${header}\n${user}\n{"type":"thinking_level_change","id":"t1","parentId":"m1","thinkingLevel":"max"}\n`);
  assert.equal(okThinking.ok, true, okThinking.reason);
  assert.ok(okThinking.verifiedDimensions.includes('thinking_level'));

  for (const bad of [
    '{"type":"thinking_level_change","id":"t1","parentId":"m1"}',
    '{"type":"thinking_level_change","id":"t1","parentId":"m1","thinkingLevel":{"level":"high"}}',
    '{"type":"thinking_level_change","id":"t1","parentId":"m1","thinkingLevel":3}',
  ]) {
    const result = validateSessionV2(`${header}\n${user}\n${bad}\n`);
    assert.equal(result.ok, false);
    assert.ok(result.reason.startsWith('session_thinking_level_invalid'), `实际 ${result.reason}`);
  }

  const okLabel = validateSessionV2(`${header}\n${user}\n{"type":"label","id":"l1","parentId":"m1","targetId":"m1"}\n`);
  assert.equal(okLabel.ok, true, okLabel.reason);
  const badLabel = validateSessionV2(`${header}\n${user}\n{"type":"label","id":"l1","parentId":"m1","targetId":"s1","label":"x"}\n`);
  assert.equal(badLabel.ok, false);
  assert.ok(badLabel.reason.startsWith('session_label_target_unknown'), `实际 ${badLabel.reason}`);

  const badInfo = validateSessionV2(`${header}\n${user}\n{"type":"session_info","id":"i1","parentId":"m1","name":{"x":1}}\n`);
  assert.equal(badInfo.ok, false);
  assert.ok(badInfo.reason.startsWith('session_session_info_invalid'), `实际 ${badInfo.reason}`);
});

test('S13: 普通 savePolicy 保留既有 pin、不钉新对象（全平台）', () => {
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  const otherDir = path.join(tempDir, 'other');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const pinned = service.loadPolicy('project-1');
  assert.ok(Object.keys(pinned.authorizedDirPins).length > 0, '显式授权后必须有 pin');

  // 普通保存（改保留天数）：pin 逐字节保留。
  service.savePolicy('project-1', { ...pinned, stagingRetentionDays: pinned.stagingRetentionDays + 1 });
  const afterSave = service.loadPolicy('project-1');
  assert.deepEqual(afterSave.authorizedDirPins, pinned.authorizedDirPins, '普通保存不得改动既有 pin');
  assert.equal(afterSave.stagingRetentionDays, pinned.stagingRetentionDays + 1);

  // 普通保存新增目录：新目录保持未钉住（失败关闭），不会被悄悄授权。
  service.savePolicy('project-1', { ...afterSave, authorizedDirs: [projectDir, otherDir] });
  const withNewDir = service.loadPolicy('project-1');
  const { authorizeTargetDir } = require('../../build/server/domain/runtime/badcase-capture/capture-policy');
  const newDirAuth = authorizeTargetDir(withNewDir, otherDir);
  assert.equal(newDirAuth.ok, false);
  assert.equal(newDirAuth.reason, 'authorized_root_unpinned', `实际原因 ${newDirAuth.reason}`);
  // 原目录的 pin 仍在。
  const oldDirAuth = authorizeTargetDir(withNewDir, projectDir);
  assert.equal(oldDirAuth.ok, true, `原目录 pin 应保留：${oldDirAuth.reason}`);

  // 显式授权后新目录才有 pin。
  service.authorizeProject('project-1');
  const reauthorized = service.loadPolicy('project-1');
  assert.equal(authorizeTargetDir(reauthorized, otherDir).ok, true, '显式授权后新目录才可用');
});
