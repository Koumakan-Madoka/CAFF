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

test('R23: Git 元数据读取必须经受限根——外部 include/exclude 不被读取、规则不生效', { skip: linuxSkip }, () => {
  // GPT 复审 #1 第七轮探针复现：命令行 -c 黑名单只能禁止 git **执行**仓库指定程序，
  // 不能禁止 git **读取**未授权内容——旧构建的 git ls-files 真实读取了 include.path
  // 指向的外部配置与 info/exclude 符号链接指向的外部规则文件（atime 从 2000 年被
  // 更新），hidden.txt 还按外部规则从清单消失。修复后采集路径不执行 git：所有
  // 元数据字节经受限根读取，树外目标不读取、规则不生效、显式降级 complete=false。
  const tempDir = withTempDir();
  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'tracked-content');
  fs.writeFileSync(path.join(projectDir, 'hidden.txt'), 'untracked-but-present');
  fs.writeFileSync(path.join(projectDir, 'ignored.log'), 'ignored-by-in-tree-rule');
  fs.writeFileSync(path.join(projectDir, '.gitignore'), 'ignored.log\n');
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: projectDir });
  execFileSync('git', ['add', 'a.txt'], { cwd: projectDir });

  // 外部文件（授权树之外）：include 目标配置 + info/exclude 符号链接目标。
  const marker = path.join(tempDir, 'fsmonitor-executed.marker');
  const hookPath = path.join(tempDir, 'evil-fsmonitor.sh');
  fs.writeFileSync(hookPath, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
  const includeCfg = path.join(tempDir, 'external-include.cfg');
  fs.writeFileSync(includeCfg, `[core]\n\tfsmonitor = ${hookPath}\n`);
  const externalExcludes = path.join(tempDir, 'external-excludes.txt');
  fs.writeFileSync(externalExcludes, 'hidden.txt\n');
  execFileSync('git', ['config', 'include.path', includeCfg], { cwd: projectDir });
  fs.rmSync(path.join(projectDir, '.git', 'info', 'exclude'), { force: true });
  fs.symlinkSync(externalExcludes, path.join(projectDir, '.git', 'info', 'exclude'));

  // atime 探针：把外部文件的 atime/mtime 设到 2000 年，任何后续读取都会更新 atime。
  const epoch = new Date('2000-01-01T00:00:00Z');
  for (const probe of [includeCfg, externalExcludes]) {
    fs.utimesSync(probe, epoch, epoch);
  }

  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(projectDir));
  const result = service.captureTurnCheckpoint(captureArgs(projectDir));
  assert.equal(result.captured, true, `采集应正常完成：${result.reason}`);
  assert.equal(fs.existsSync(marker), false, '不得执行仓库指定的任何程序');
  for (const probe of [includeCfg, externalExcludes]) {
    assert.equal(fs.statSync(probe).atimeMs, epoch.getTime(), `${probe} 不得被读取（atime 不得变化）`);
  }
  assert.ok(result.checkpoint.files['a.txt'], 'tracked 文件正常采集');
  assert.ok(result.checkpoint.files['.gitignore'], '树内 .gitignore 本身正常采集');
  assert.ok(result.checkpoint.files['hidden.txt'], '外部 exclude 规则不得生效（hidden.txt 必须在清单中）');
  assert.equal(result.checkpoint.files['ignored.log'], undefined, '树内 .gitignore 规则正常生效');
  assert.equal(result.checkpoint.replayInput.complete, false, '元数据缺陷必须显式降级');
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('git_exclude_unreadable'),
    `实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('git_config_include_unverified'),
    `实际 ${result.checkpoint.replayInput.incompleteReasons.join(',')}`);
  assert.equal(result.checkpoint.strictEvalEligible, false);
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

// ---------- S14: git-classify 单元与差集测试（全平台；差集部分需 git 可用） ----------
//
// 采集路径不执行 git（R23），git index 与 gitignore 语义由内置解析器复现。
// 本组用例：模式语法单元 + index 解析单元 + 与真实 git ls-files 的差集对照
// （差集中 git 只运行在测试侧受信夹具上，不在采集路径上）。

const {
  parseGitIndex,
  parseGitignoreRules,
  matchIgnoreSources,
  classifyWalkEntries,
  parseGitConfigSubset,
} = require('../../build/server/domain/runtime/badcase-capture/git-classify');
// Unrestricted walk is test-only; production enumeration must use the root fd.
function walkProjectTree(root, skipDirs) {
  const entries = [];
  const walk = (base) => {
    for (const entry of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
      if (skipDirs.includes(entry.name)) continue;
      const name = base ? `${base}/${entry.name}` : entry.name;
      entries.push({ path: name, type: entry.isDirectory() ? 'dir' : 'file' });
      if (entry.isDirectory()) walk(name);
    }
  };
  walk('');
  return { entries };
}

test('S14a: gitignore 模式语法（注释/否定/目录限定/锚定/**/字符类/转义）', () => {
  const match = (text, relPath, isDir = false) => {
    const rules = parseGitignoreRules(text);
    return matchIgnoreSources([{ base: '', rules }], relPath, isDir);
  };
  // 基础：非锚定匹配 basename
  assert.equal(match('foo', 'foo'), true);
  assert.equal(match('foo', 'a/b/foo'), true);
  assert.equal(match('foo', 'foobar'), undefined);
  // *.log 与否定
  assert.equal(match('*.log', 'a/b.log'), true);
  assert.equal(match('*.log\n!keep.log', 'keep.log'), false);
  assert.equal(match('*.log\n!keep.log', 'sub/keep.log'), false);
  assert.equal(match('*.log\n!keep.log', 'other.log'), true);
  // 目录限定：只匹配目录
  assert.equal(match('build/', 'build', true), true);
  assert.equal(match('build/', 'build', false), undefined);
  assert.equal(match('build/', 'src/build', true), true);
  // 锚定：含 / 或前导 /
  assert.equal(match('/rooted.txt', 'rooted.txt'), true);
  assert.equal(match('/rooted.txt', 'sub/rooted.txt'), undefined);
  assert.equal(match('doc/*.html', 'doc/a.html'), true);
  assert.equal(match('doc/*.html', 'doc/sub/a.html'), undefined);
  assert.equal(match('doc/*.html', 'x/doc/a.html'), undefined);
  // ** 三种形态
  assert.equal(match('**/tmp', 'a/b/tmp'), true);
  assert.equal(match('**/tmp', 'tmp'), true);
  assert.equal(match('a/**/b', 'a/b'), true);
  assert.equal(match('a/**/b', 'a/x/y/b'), true);
  assert.equal(match('a/**/b', 'a/x/c'), undefined);
  assert.equal(match('abc/**', 'abc/x/y/z'), true);
  assert.equal(match('abc/**', 'abc'), undefined);
  // 字符类与 ?
  assert.equal(match('[ab].txt', 'a.txt'), true);
  assert.equal(match('[ab].txt', 'c.txt'), undefined);
  assert.equal(match('[!ab].txt', 'c.txt'), true);
  assert.equal(match('file?.txt', 'file1.txt'), true);
  assert.equal(match('file?.txt', 'file/1.txt'), undefined);
  // 注释、转义、行尾空格
  assert.equal(match('# comment', '# comment'), undefined);
  assert.equal(match('\\#file', '#file'), true);
  assert.equal(match('\\!file', '!file'), true);
  assert.equal(match('name   \n', 'name'), true);
  assert.equal(match('name\\ ', 'name '), true);
  // 未命中返回 undefined
  assert.equal(match('*.log', 'a.txt'), undefined);
});

test('S14b: gitignore 优先级链——深层覆盖浅层、后命中覆盖先命中、已忽略目录不深入', () => {
  const sources = [
    { base: '', rules: parseGitignoreRules('*.log\nlogs/\n') },
    { base: 'sub', rules: parseGitignoreRules('!keep.log\n') },
  ];
  assert.equal(matchIgnoreSources(sources, 'a.log', false), true);
  assert.equal(matchIgnoreSources(sources, 'sub/keep.log', false), false, '深层否定覆盖浅层通配');
  assert.equal(matchIgnoreSources(sources, 'sub/x.log', false), true, '深层未命中回落浅层');

  // classify：已忽略目录内的 .gitignore 不生效（git 不深入）
  const entries = [
    { path: 'logs', type: 'dir' },
    { path: 'logs/.gitignore', type: 'file' },
    { path: 'logs/keep.txt', type: 'file' },
    { path: 'src', type: 'dir' },
    { path: 'src/app.js', type: 'file' },
  ];
  const gitignoreByDir = new Map([
    ['', parseGitignoreRules('logs/\n')],
    ['logs', parseGitignoreRules('!keep.txt\n')],
  ]);
  const classified = classifyWalkEntries(entries, {
    tracked: new Set(),
    applyIgnore: true,
    gitignoreByDir,
  });
  const candidatePaths = classified.candidates.map((entry) => entry.path);
  assert.deepEqual(candidatePaths, ['src/app.js'], '已忽略目录内全部排除（其 .gitignore 的否定不生效）');
  assert.equal(classified.dirInfo.get('logs').ignored, true);
});

test('S14c: classify 的 tracked 语义与缺口路由', () => {
  const entries = [
    { path: 'tracked-ignored.txt', type: 'file' },
    { path: 'untracked-ignored.txt', type: 'file' },
    { path: 'free.txt', type: 'file' },
    { path: 'pipe', type: 'other' },
  ];
  const gitignoreByDir = new Map([['', parseGitignoreRules('*-ignored.txt\n')]]);
  // tracked 集合包含 tracked-ignored.txt：ignore 规则只作用于 untracked
  const classified = classifyWalkEntries(entries, {
    tracked: new Set(['tracked-ignored.txt']),
    applyIgnore: true,
    gitignoreByDir,
    isIncludedIgnored: (p) => p === 'untracked-ignored.txt',
  });
  const candidatePaths = classified.candidates.map((entry) => entry.path);
  assert.ok(candidatePaths.includes('tracked-ignored.txt'), 'tracked 文件即使命中 ignore 规则也必须采集');
  assert.ok(candidatePaths.includes('untracked-ignored.txt'), 'includedIgnored 显式重纳入');
  assert.ok(candidatePaths.includes('free.txt'));
  assert.deepEqual(classified.uncaptured, [{ path: 'pipe', reason: 'special_file' }],
    '未忽略的特殊文件必须进入 uncaptured 缺口清单');

  // tracked=null（元数据不可用）→ 不应用任何 ignore 规则，全部成为候选（宁多采不漏采）
  const degraded = classifyWalkEntries(entries, { tracked: null, applyIgnore: false });
  assert.equal(degraded.candidates.length, 3, '降级模式采集全部普通文件/链接');
  assert.deepEqual(degraded.uncaptured, [{ path: 'pipe', reason: 'special_file' }]);

  // 被 ignore 的特殊文件不进 uncaptured（git 本来也不会列出它）
  const ignoredSpecial = classifyWalkEntries(
    [{ path: 'pipe', type: 'other' }],
    { tracked: new Set(), applyIgnore: true, gitignoreByDir: new Map([['', parseGitignoreRules('pipe\n')]]) },
  );
  assert.deepEqual(ignoredSpecial.uncaptured, []);
  assert.deepEqual(ignoredSpecial.candidates, []);
});

test('S14d: git index 解析——v2/v3/v4、sha256、损坏输入', () => {
  const crypto = require('node:crypto');
  const buildV2 = (paths, hashLen = 20) => {
    const fixedLen = 40 + hashLen + 2;
    const parts = [];
    for (const p of paths) {
      const name = Buffer.from(p, 'utf8');
      const fixed = Buffer.alloc(fixedLen);
      fixed.writeUInt32BE(0o100644, 24); // mode
      fixed.writeUInt16BE(name.length, fixedLen - 2); // flags: nameLen
      const unpadded = fixedLen + name.length;
      const padded = Math.ceil((unpadded + 1) / 8) * 8;
      const entry = Buffer.alloc(padded);
      fixed.copy(entry, 0);
      name.copy(entry, fixedLen);
      parts.push(entry);
    }
    const header = Buffer.alloc(12);
    header.write('DIRC', 0, 'latin1');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(paths.length, 8);
    const body = Buffer.concat([header, ...parts]);
    return Buffer.concat([body, crypto.createHash(hashLen === 32 ? 'sha256' : 'sha1').update(body).digest()]);
  };
  const parsed = parseGitIndex(buildV2(['a.txt', 'sub/b.txt']), 20);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.deepEqual(parsed.entries.map((entry) => entry.path), ['a.txt', 'sub/b.txt']);
  assert.equal(parsed.entries[0].mode, 0o100644);

  const parsed256 = parseGitIndex(buildV2(['x.txt'], 32), 32);
  assert.equal(parsed256.ok, true, parsed256.reason);
  assert.deepEqual(parsed256.entries.map((entry) => entry.path), ['x.txt']);

  // v4 前缀压缩：每个条目都是 varint strip + NUL 结尾后缀。
  // entry1: strip=0 + 'dir/a.txt'；entry2: strip=5 → 'dir/' + 'b.txt'
  const buildV4 = () => {
    const hashLen = 20;
    const fixedLen = 40 + hashLen + 2;
    const fixed1 = Buffer.alloc(fixedLen);
    fixed1.writeUInt32BE(0o100644, 24);
    fixed1.writeUInt16BE(9, fixedLen - 2);
    const entry1 = Buffer.concat([fixed1, Buffer.from([0]), Buffer.from('dir/a.txt\0')]);
    const fixed2 = Buffer.alloc(fixedLen);
    fixed2.writeUInt32BE(0o100644, 24);
    fixed2.writeUInt16BE(9, fixedLen - 2);
    const entry2 = Buffer.concat([fixed2, Buffer.from([5]), Buffer.from('b.txt\0')]);
    const header = Buffer.alloc(12);
    header.write('DIRC', 0, 'latin1');
    header.writeUInt32BE(4, 4);
    header.writeUInt32BE(2, 8);
    const body = Buffer.concat([header, entry1, entry2]);
    return Buffer.concat([body, crypto.createHash('sha1').update(body).digest()]);
  };
  const parsedV4 = parseGitIndex(buildV4(), 20);
  assert.equal(parsedV4.ok, true, parsedV4.reason);
  assert.deepEqual(parsedV4.entries.map((entry) => entry.path), ['dir/a.txt', 'dir/b.txt']);

  // 校验 hash 不只是占位长度；split/sparse-index 等必要扩展没有实现就拒绝。
  const changed = buildV2(['a.txt']);
  changed[12] ^= 1;
  assert.equal(parseGitIndex(changed, 20).ok, false, 'checksum mismatch must fail');
  const base = buildV2(['a.txt']).subarray(0, -20);
  const extension = Buffer.alloc(8);
  extension.write('link');
  const withSplit = Buffer.concat([base, extension]);
  assert.equal(parseGitIndex(Buffer.concat([withSplit, crypto.createHash('sha1').update(withSplit).digest()]), 20).ok,
    false, 'unimplemented mandatory index extension must fail');

  // 损坏输入
  assert.equal(parseGitIndex(Buffer.from('nope'), 20).ok, false);
  const badVersion = buildV2(['a.txt']);
  badVersion.writeUInt32BE(5, 4);
  assert.equal(parseGitIndex(badVersion, 20).ok, false);
  assert.equal(parseGitIndex(buildV2(['a.txt']).slice(0, -5), 20).ok, false, '截断必须报错');
  assert.equal(parseGitIndex(buildV2(['a.txt']), 32).ok, false, 'hash 长度错配必须报错（不静默猜测）');

  // config 子集：objectformat / excludesFile / include 检测
  const cfg = parseGitConfigSubset('[core]\n\texcludesFile = /x/ex\n[extensions]\n\tobjectformat = sha256\n[include]\n\tpath = /etc/evil\n');
  assert.equal(cfg.objectFormat, 'sha256');
  assert.equal(cfg.excludesFile, '/x/ex');
  assert.equal(cfg.hasInclude, true);
});

test('S14e: 与真实 git ls-files 的差集对照（测试侧受信夹具）', (t) => {
  // git 可用性探测：不可用时跳过差集（单元用例 S14a-d 不受影响）。
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    t.skip('git unavailable: differential test not run');
    return;
  }
  const tempDir = withTempDir();
  const repoDir = path.join(tempDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'sub', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'doc'), { recursive: true });

  fs.writeFileSync(path.join(repoDir, '.gitignore'), '*.log\n!keep.log\nlogs/\ndoc/*.html\n');
  fs.writeFileSync(path.join(repoDir, 'sub', '.gitignore'), '!deep/local.log\n');
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'tracked');
  fs.writeFileSync(path.join(repoDir, 'keep.log'), 'negated-keep');
  fs.writeFileSync(path.join(repoDir, 'drop.log'), 'dropped');
  fs.writeFileSync(path.join(repoDir, 'sub', 'deep', 'local.log'), 're-included-by-sub-rule');
  fs.writeFileSync(path.join(repoDir, 'sub', 'deep', 'other.log'), 'dropped-deep');
  fs.writeFileSync(path.join(repoDir, 'logs', 'x.txt'), 'inside-ignored-dir');
  fs.writeFileSync(path.join(repoDir, 'doc', 'a.html'), 'anchored-drop');
  fs.writeFileSync(path.join(repoDir, 'doc', 'b.txt'), 'kept');
  fs.writeFileSync(path.join(repoDir, 'free space.txt'), 'space-name');

  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir });
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repoDir });
  // tracked 但命中 ignore 规则的文件（git add -f）：ignore 规则不得作用于它
  fs.writeFileSync(path.join(repoDir, 'force.log'), 'tracked-despite-ignore');
  execFileSync('git', ['add', '-f', 'force.log'], { cwd: repoDir });

  // 测试侧以普通 fs 读取元数据（采集侧会经受限根，这里验证的是分类语义本身）。
  const indexBuffer = fs.readFileSync(path.join(repoDir, '.git', 'index'));
  const parsed = parseGitIndex(indexBuffer, 20);
  assert.equal(parsed.ok, true, parsed.reason);
  const tracked = new Set(parsed.entries.map((entry) => entry.path));
  assert.ok(tracked.has('tracked.txt') && tracked.has('force.log'));

  const { entries } = walkProjectTree(repoDir, ['.git', 'node_modules']);
  const gitignoreByDir = new Map();
  for (const entry of entries) {
    if (entry.type === 'file' && (entry.path === '.gitignore' || entry.path.endsWith('/.gitignore'))) {
      const dir = entry.path === '.gitignore' ? '' : entry.path.slice(0, entry.path.length - '.gitignore'.length - 1);
      gitignoreByDir.set(dir, parseGitignoreRules(fs.readFileSync(path.join(repoDir, entry.path), 'utf8')));
    }
  }
  const classified = classifyWalkEntries(entries, {
    tracked,
    applyIgnore: true,
    gitignoreByDir,
    isIncludedIgnored: () => false,
  });
  const ours = new Set(classified.candidates.map((entry) => entry.path));

  const gitOut = execFileSync('git', ['-C', repoDir, 'ls-files', '-c', '-o', '--exclude-standard', '-z'], { encoding: 'buffer' });
  const gitSet = new Set(Buffer.from(gitOut).toString('utf8').split('\0').filter(Boolean));

  assert.deepEqual([...ours].sort(), [...gitSet].sort(),
    `差集必须为空。ours-git=${[...ours].filter((p) => !gitSet.has(p))} git-ours=${[...gitSet].filter((p) => !ours.has(p))}`);
  // 关键语义点抽查
  assert.ok(ours.has('keep.log') && ours.has('sub/deep/local.log') && ours.has('force.log'));
  assert.ok(!ours.has('drop.log') && !ours.has('logs/x.txt') && !ours.has('doc/a.html') && !ours.has('sub/deep/other.log'));
});

test('S18: malformed Git material downgrades capture and restore end to end', { skip: linuxSkip }, () => {
  const tempDir = withTempDir();
  const repo = path.join(tempDir, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked');
  fs.writeFileSync(path.join(repo, 'ignored.log'), 'not silently lost');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', 'tracked.txt']);
  const config = fs.readFileSync(path.join(repo, '.git/config'));
  const index = fs.readFileSync(path.join(repo, '.git/index'));
  const service = makeService(tempDir);
  authorize(service, 'project-1', enabledPolicy(repo));
  const mutations = [
    ['git_index_unreadable', () => { const bad = Buffer.from(index); bad[12] ^= 1; fs.writeFileSync(path.join(repo, '.git/index'), bad); }],
    ['git_config_unverified', () => fs.appendFileSync(path.join(repo, '.git/config'), '\n[core]\nworktree = /outside\n')],
    ['git_ignore_unverified', () => fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\na[!x/]b\n')],
  ];
  for (const [reason, mutate] of mutations) {
    fs.writeFileSync(path.join(repo, '.git/config'), config);
    fs.writeFileSync(path.join(repo, '.git/index'), index);
    fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
    mutate();
    const result = service.captureTurnCheckpoint(captureArgs(repo, { turnId: reason }));
    assert.equal(result.captured, true, result.reason);
    assert.equal(result.checkpoint.replayInput.complete, false);
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes(reason), result.checkpoint.replayInput.incompleteReasons.join(','));
    assert.ok(result.checkpoint.files['ignored.log'], 'unverified rules must not discard files');
    assert.ok(result.checkpoint.files['tracked.txt']);
    const restored = service.restoreCheckpoint({ projectId: 'project-1', checkpointId: result.checkpointId, targetDir: path.join(tempDir, reason) });
    assert.equal(restored.ok, true);
    assert.equal(restored.replayInputComplete, false);
  }
});

// Malformed bytes must not become a trusted tracked set, even with a valid hash.
function indexFixture({ version = 2, name = 'a', mode = 0o100644, extended = null } = {}) {
  const flags = Buffer.byteLength(name) | (extended === null ? 0 : 0x4000);
  const fixed = Buffer.alloc(62 + (extended === null ? 0 : 2));
  fixed.writeUInt32BE(mode, 24);
  fixed.writeUInt16BE(flags, 60);
  if (extended !== null) fixed.writeUInt16BE(extended, 62);
  let entry = Buffer.concat([fixed, ...(version === 4 ? [Buffer.from([0])] : []), Buffer.from(`${name}\0`)]);
  if (version !== 4) entry = Buffer.concat([entry, Buffer.alloc((8 - entry.length % 8) % 8)]);
  const header = Buffer.alloc(12);
  header.write('DIRC'); header.writeUInt32BE(version, 4); header.writeUInt32BE(1, 8);
  return Buffer.concat([header, entry]);
}
function indexWithHash(body) {
  return Buffer.concat([body, require('node:crypto').createHash('sha1').update(body).digest()]);
}

test('S15a: valid-checksum index rejects interior NUL and nonzero padding', () => {
  const nul = indexFixture({ name: 'a\0b' });
  assert.equal(parseGitIndex(indexWithHash(nul), 20).ok, false, 'interior NUL');
  const padding = indexFixture({ name: 'ab' });
  padding[padding.length - 1] = 1;
  assert.equal(parseGitIndex(indexWithHash(padding), 20).ok, false, 'nonzero padding');
});

test('S15b: unverified index modes, extended flags and administrative paths fail closed', () => {
  for (const fixture of [
    { mode: 0 }, { mode: 0o040000 }, { mode: 0o160000 }, { name: '.git/config' }, { name: 'x/.git/y' },
    { version: 3, extended: 1 }, { version: 3, extended: 0x4000 },
  ]) assert.equal(parseGitIndex(indexWithHash(indexFixture(fixture)), 20).ok, false, JSON.stringify(fixture));
  assert.equal(parseGitIndex(indexWithHash(indexFixture({ version: 3, extended: 0 })), 20).ok, true);
});

test('S15c: v4 name length and prefix overflow cannot be silently accepted', () => {
  const wrongLength = indexFixture({ version: 4 });
  wrongLength.writeUInt16BE(99, 12 + 60);
  assert.equal(parseGitIndex(indexWithHash(wrongLength), 20).ok, false, 'v4 flags length mismatch');
  const overflow = indexFixture({ version: 4 });
  overflow[12 + 62] = 255;
  assert.equal(parseGitIndex(indexWithHash(overflow), 20).ok, false, 'invalid prefix strip');
});

test('S15d: config unsupported quoting/sections are not verified', () => {
  for (const text of [
    '[include.path]\npath = /outside\n', '[core]\nexcludesFile = "unfinished\n',
    '[core]\nexcludesFile = "a""b"\n', '[core]\nworktree = /outside\n',
    '[core]\nrepositoryformatversion = 99\n', '[core]\nbare = true\n',
    '[core "subsection"]\nexcludesFile = other\n',
  ]) assert.equal(parseGitConfigSubset(text).verified, false, text);
  const quoted = parseGitConfigSubset('[core]\nexcludesFile = "inside file" # comment\n');
  assert.equal(quoted.verified, true);
  assert.equal(quoted.excludesFile, 'inside file');
  assert.equal(parseGitConfigSubset('[core]\nexcludesFile = inside#comment\n').excludesFile, 'inside');
});

test('S15e: unsupported wildmatch syntax is explicitly unverified', () => {
  for (const rule of ['a[!x/]b', '[a/b]', 'tail' + String.fromCharCode(92), '\ufeff*.log', 'a\0b', 'a'.repeat(4097), 'a\n'.repeat(4097)]) {
    assert.equal(parseGitignoreRules(rule).verified, false, JSON.stringify(rule));
  }
});

test('S17: hostile wildcard repetition has bounded matching cost', () => {
  const modulePath = path.resolve(__dirname, '../../build/server/domain/runtime/badcase-capture/git-classify');
  const source = `const m = require(${JSON.stringify(modulePath)}); const rules = m.parseGitignoreRules('*a'.repeat(30) + 'b');
    if (rules.verified) { if (m.matchIgnoreSources([{base:'', rules}], 'a'.repeat(200), false) !== undefined) process.exit(2); }`;
  execFileSync(process.execPath, ['-e', source], { timeout: 2000, stdio: 'pipe' });
});

test('S16: supported ignore subset agrees with real Git across pattern/path matrix', () => {
  const tempDir = withTempDir();
  const repo = path.join(tempDir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', `core.excludesFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  const paths = ['a.txt', 'b.txt', 'c.txt', 'keep.log', 'drop.log', '#file', '!file', 'a space',
    'sub/a.txt', 'sub/b.log', 'sub/deep/a.txt', 'sub/deep/b.log', 'doc/a.html', 'doc/deep/a.html', 'abc/x/y/z',
    'é.txt', '你.txt', 'sub/a/b/z'];
  for (const name of paths) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), name);
  }
  const patterns = ['*.log', '*.log\n!keep.log', '/a.txt', '[ab].txt', '[!ab].txt', '?.txt',
    'sub/', 'sub/*', 'sub/**', '**/a.txt', 'sub/**/a.txt', 'doc/*.html', '**/*.html',
    'abc/**', '**', '*\n!sub/\n!sub/**', 'sub/\n!sub/a.txt', 'a space   ', '\\#file', '\\!file',
    'a**.txt', 's?b/**/?.txt', 'sub/**/deep/**', 'sub/**/**/a.txt', 'é.txt', '??.txt', 'sub/a[!x]b/z'];
  const entries = walkProjectTree(repo, ['.git']).entries;
  for (const pattern of patterns) {
    fs.writeFileSync(path.join(repo, '.gitignore'), pattern + '\n');
    const rules = parseGitignoreRules(pattern);
    assert.equal(rules.verified, true, pattern);
    const ours = classifyWalkEntries(entries, { tracked: new Set(), applyIgnore: true, gitignoreByDir: new Map([['', rules]]) })
      .candidates.map((entry) => entry.path).sort();
    const expected = git('ls-files', '-o', '--exclude-standard', '-z').split('\0').filter((name) => name && name !== '.gitignore').sort();
    assert.deepEqual(ours, expected, JSON.stringify(pattern));
  }
});
