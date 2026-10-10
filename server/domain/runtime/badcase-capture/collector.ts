// Turn 执行前检查点采集器（契约 §2）。
//
// 流程：授权检查（pin 表 + 授权时固定的根身份；pinnedRoot 直接取授权判定验证过的
// resolvedTarget，不二次 realpath）→ 回放输入准备（受控替换 + 最终字节秘密扫描 +
// session 结构校验 + harness/skill 快照校验）→ 采集循环[ 根身份检查 → 首次扫描 M1
// （fd 绑定读取、扫描即秘密检测）→ 配额预检 → 写 staging（fd 绑定重读、重校 hash、
//   重扫秘密、逐 blob 写前配额核算）→ 二次扫描 M2（全量内容重 hash）→ 一致性定级
//   → staging 原子提交 CAS 或整体回滚 ] → 配额终检 → 落盘清单。
//
// 诚实性约束：
// - 秘密先扫描后落盘：扫描到的内容、最终写入 CAS 的内容都必须过哨兵检测；命中即拒绝
//   归档该输入并标记输入损失（complete=false），绝不先写 CAS 再脱敏。无大小/二进制跳检。
//   本阶段无豁免机制：命中哨兵一律排除。
// - 一致性证据三级：content-verified（内容级双扫零异常）/ corrected-after-retry
//   （检出异常后重试稳定）/ write-during-capture（重试耗尽仍不一致）。三级都只是
//   "未检测到变化"的检测记录，不是现场一致性证明：协调写入可以让两次扫描读到从未同时
//   存在的状态。v1 没有独立的一致性依据，strictEvalEligible 恒为 false（契约 §2.3）。
// - 授权根身份在授权判定时固定（pinnedRoot）；采集窗口内根被替换（junction/symlink 换根）
//   → target_root_replaced 失败，拒绝采集。
// - fd 绑定读取（GPT 复审 #1）：所有从目标树读内容的路径统一为 realpath 一次 → 纯字符串
//   界内校验（不重新解析根）→ openSync 后只从 fd 读 → 字节数与 fstat 比对 → 读后 lstat
//   与 fstat 比 dev+ino（路径名当前指向的对象必须是读过的对象）。任何一步失败即拒绝该
//   文件并触发一致性异常，绝不按路径名重读。
// - 逐 attempt 暂存：blob 先写 staging，attempt 通过根身份复检 + 一致性定级后才原子提交
//   进 CAS，重试/失败整体回滚——越权内容即使赢下读取链路的残余竞态也不持久化。
// - resume 缺 session / session 结构校验失败（版本未钉死、未知 role、内容块缺字段、
//   自引用/前向引用等）→ complete=false，未验证材料不归档，禁止静默降级 fresh。
// - runConfig 缺 provider/model/promptVersion 或 harness/skill 快照未验证 → complete=false，
//   不以 ID 列表或空对象冒充内容固定。
// - 配额按实际新增去重内容 + 清单元数据核算，覆盖每个重试 attempt；写时读到的实际字节
//   在落盘前重新核算（文件膨胀不得先突破配额再失败）；超额 → 策略 suspended，不落盘、
//   不伪造成功。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
import { authorizeTargetDir, isPathWithinPinnedRoot, isSameOrUnderPathString, matchesRelativePattern, pathsEqual, realpathOrResolved } from './capture-policy';
import { containsSecretSentinel, replaceControlledVariables } from './secrets';

function sha256Buffer(content: any) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

const MAX_CONSISTENCY_RETRIES = 2;
const MANIFEST_ESTIMATE_RESERVE_BYTES = 4096;

// v1 常驻的机器可读限制声明（写进每个检查点，不是文档级披露）：这些维度在 v1 无法
// 固定或独立验证，strictEvalEligible 恒为 false 之外，回放/评测消费方必须能看到。
const KNOWN_LIMITATIONS = [
  'no_atomic_snapshot', // 采集非原子快照，双扫只是“未检测到变化”的检测记录
  'no_independent_consistency_evidence', // 无独立源现场一致性依据，严格对照资格恒 false
  'path_identity_race_residual', // Node 无法 handle→path 反查；换根恰好横跨单个 fd 读取且在 attempt 结束前换回的残余窗口无法完全消除（fd 身份校验 + 暂存回滚拦截已知编排）
  'harness_config_caller_asserted', // harness/tool 配置快照由调用方声明，采集方不独立验证其来源
  'environment_not_pinned', // 环境模板/镜像 digest 固定属后续工作项（W4）
  'external_service_state_not_pinned', // 模型端点与外部服务状态不可固定
];

function isGitWorkTree(targetDir: any) {
  try {
    const out = execFileSync('git', ['-C', targetDir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out || '').trim() === 'true';
  } catch {
    return false;
  }
}

function gitListFiles(targetDir: any, extraArgs: any) {
  const out = execFileSync(
    'git',
    ['-C', targetDir, 'ls-files', '-z', ...extraArgs],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return Buffer.from(out)
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

// 候选文件清单：tracked + 未被 ignore 的 untracked；includedIgnoredPatterns 命中的
// ignored 文件显式追加。非 git 目录回退为全量遍历（排除 excludedPatterns）。
// 注意：git 在 core.symlinks=false（Windows 默认）下会把 junction 当普通目录展开，
// 因此清单层面无法依赖 git 识别链接，读取前的 realpath 边界校验是必需防线。
export function listCandidatePaths(targetDir: any, policy: any) {
  const excluded = policy && Array.isArray(policy.excludedPatterns) ? policy.excludedPatterns : [];
  const includedIgnored = policy && Array.isArray(policy.includedIgnoredPatterns) ? policy.includedIgnoredPatterns : [];
  let candidates: string[] = [];

  if (isGitWorkTree(targetDir)) {
    candidates = gitListFiles(targetDir, ['-c', '-o', '--exclude-standard']);
    if (includedIgnored.length > 0) {
      try {
        const ignored = gitListFiles(targetDir, ['-o', '-i', '--exclude-standard', '--', ...includedIgnored]);
        const seen = new Set(candidates);
        for (const entry of ignored) {
          if (!seen.has(entry)) {
            seen.add(entry);
            candidates.push(entry);
          }
        }
      } catch {
        // 显式纳入清单匹配失败不阻断主清单；记录为空即可。
      }
    }
  } else {
    const walk = (relativeDir: any) => {
      const absoluteDir = relativeDir ? path.join(targetDir, relativeDir) : targetDir;
      for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (matchesRelativePattern(relativePath, excluded)) {
          continue;
        }
        if (entry.isSymbolicLink()) {
          // 链接（含 Windows junction）本身作为清单条目，不展开跟随。
          candidates.push(relativePath);
        } else if (entry.isDirectory()) {
          walk(relativePath);
        } else {
          candidates.push(relativePath);
        }
      }
    };
    walk('');
  }

  return candidates
    .map((entry: any) => String(entry || '').replace(/\\/g, '/'))
    .filter((entry: any) => entry && !matchesRelativePattern(entry, excluded))
    .sort();
}

function lstatEntry(targetDir: any, relativePath: any) {
  const absolutePath = path.join(targetDir, relativePath);
  try {
    return { absolutePath, stat: fs.lstatSync(absolutePath) };
  } catch {
    return { absolutePath, stat: null };
  }
}

// 符号链接/junction：越界目标不跟随、不读取；界内链接记录相对目标，恢复时重建。
// 边界基准是授权时固定的 pinnedRoot，不是每次重新解析的 targetDir。
function resolveSymlink(pinnedRoot: any, relativePath: any, linkAbsolutePath: any) {
  let rawTarget = '';
  try {
    rawTarget = fs.readlinkSync(linkAbsolutePath);
  } catch {
    return { type: 'symlink', escapes: true, linkTarget: '' };
  }
  const resolvedTarget = path.resolve(path.dirname(linkAbsolutePath), rawTarget);
  const relative = path.relative(pinnedRoot, resolvedTarget);
  const escapes = relative.startsWith('..') || path.isAbsolute(relative);
  return {
    type: 'symlink',
    escapes,
    linkTarget: escapes ? '' : rawTarget.replace(/\\/g, '/'),
  };
}

function buildManifestHash(files: any, deletions: any) {
  const canonical = JSON.stringify({
    files: Object.keys(files).sort().map((name) => [name, files[name].hash || '', files[name].size || 0, files[name].secretExcluded === true]),
    deletions: (Array.isArray(deletions) ? deletions.slice() : []).sort(),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// session 文件结构校验（契约 §2.4：存在 ≠ 完整，语法合法 ≠ 结构可信，默认拒绝未验证维度）。
// 校验维度：非空；每行是合法 JSON 且为普通对象；首行必须是 session 头且 version 钉死
// SUPPORTED_SESSION_VERSION（pi CURRENT_SESSION_VERSION；版本演进一律诚实降级而不是
// 按旧规则放行）；后续条目 type 在 pi v3 白名单内；id 唯一；parentId 引用前面已出现的 id；
// message 的 role 在已知白名单内且内容块逐字段校验（text.text / thinking.thinking /
// toolCall.id+name+arguments / image.data+mimeType；toolResult 还要求 toolCallId/toolName）；
// compaction 的 firstKeptEntryId 与 branch_summary 的 fromId 必须引用该行**之前**出现的
// 条目（自引用/前向引用一律拒绝），branch_summary 必须有非空 summary。未通过校验的材料不归档。
// pi v3 条目类型与内容块结构依据 node_modules/@earendil-works/pi-coding-agent
// session-manager.js 与 pi-ai types.d.ts；格式演进出现新类型/新 role/新块类型时诚实降级。
const SUPPORTED_SESSION_VERSION = 3;
const KNOWN_MESSAGE_ROLES = new Set(['user', 'assistant', 'toolResult', 'custom']);
const KNOWN_MESSAGE_CONTENT_TYPES = new Set(['text', 'thinking', 'toolCall', 'image']);
const KNOWN_SESSION_ENTRY_TYPES = new Set([
  'session',
  'message',
  'model_change',
  'compaction',
  'custom',
  'custom_message',
  'label',
  'branch_summary',
  'session_info',
  'thinking_level_change',
]);

// 内容块逐字段校验（GPT 复审 #3：类型名已知 ≠ 结构已验证；text 块缺 text 曾 complete=true）。
// 返回空串表示通过，否则返回具体缺陷 detail。
function validateContentBlock(block: any, role: any) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return 'block_not_object';
  }
  const type = block.type;
  if (type === 'text') {
    return typeof block.text === 'string' ? '' : 'text_missing_text';
  }
  if (type === 'thinking') {
    if (role !== 'assistant') {
      return 'thinking_not_allowed_for_role';
    }
    return typeof block.thinking === 'string' ? '' : 'thinking_missing_thinking';
  }
  if (type === 'toolCall') {
    if (role !== 'assistant') {
      return 'toolcall_not_allowed_for_role';
    }
    if (typeof block.id !== 'string' || !block.id) {
      return 'toolcall_missing_id';
    }
    if (typeof block.name !== 'string' || !block.name) {
      return 'toolcall_missing_name';
    }
    if (!block.arguments || typeof block.arguments !== 'object' || Array.isArray(block.arguments)) {
      return 'toolcall_missing_arguments';
    }
    return '';
  }
  if (type === 'image') {
    if (role === 'assistant') {
      return 'image_not_allowed_for_role';
    }
    if (typeof block.data !== 'string' || !block.data) {
      return 'image_missing_data';
    }
    if (typeof block.mimeType !== 'string' || !block.mimeType) {
      return 'image_missing_mimetype';
    }
    return '';
  }
  return `unverified_block_type:${String(type)}`;
}

function validateSessionStructure(text: any) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { ok: false, reason: 'session_empty', lineCount: 0 };
  }
  const seenIds = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    let entry: any;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      return { ok: false, reason: `session_invalid_jsonl:line_${index + 1}`, lineCount: lines.length };
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: `session_non_object_entry:line_${index + 1}`, lineCount: lines.length };
    }
    if (index === 0) {
      if (entry.type !== 'session' || typeof entry.id !== 'string' || !entry.id) {
        return { ok: false, reason: 'session_header_invalid', lineCount: lines.length };
      }
      // 版本钉死（GPT 复审 #3：version=999 曾 complete=true 且归档）：只接受已验证的
      // session 格式版本；缺版本/旧版本/未来版本一律不完整，不按猜测规则解析。
      if (entry.version === undefined || entry.version === null) {
        return { ok: false, reason: 'session_header_version_missing', lineCount: lines.length };
      }
      if (Number(entry.version) !== SUPPORTED_SESSION_VERSION) {
        return { ok: false, reason: 'session_unsupported_version', lineCount: lines.length };
      }
      seenIds.add(entry.id);
      continue;
    }
    const entryType = entry.type;
    if (typeof entryType !== 'string' || !entryType) {
      return { ok: false, reason: `session_entry_type_missing:line_${index + 1}`, lineCount: lines.length };
    }
    if (!KNOWN_SESSION_ENTRY_TYPES.has(entryType)) {
      return { ok: false, reason: `session_unverified_entry_type:line_${index + 1}:${entryType}`, lineCount: lines.length };
    }
    if (typeof entry.id !== 'string' || !entry.id) {
      return { ok: false, reason: `session_entry_id_missing:line_${index + 1}`, lineCount: lines.length };
    }
    if (seenIds.has(entry.id)) {
      return { ok: false, reason: `session_duplicate_entry_id:line_${index + 1}`, lineCount: lines.length };
    }
    // 注意：seenIds 此刻不包含本行 id。parentId 与 compaction/branch 引用都必须是
    // 后向引用（指向之前出现的条目）；自引用/前向引用在这里被确定性拒绝（GPT 复审 #3）。
    const parentId = entry.parentId === null || entry.parentId === undefined ? null : String(entry.parentId);
    if (parentId !== null && !seenIds.has(parentId)) {
      return { ok: false, reason: `session_chain_broken:line_${index + 1}`, lineCount: lines.length };
    }
    if (entryType === 'message') {
      const message = entry.message;
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || typeof message.role !== 'string' || !message.role) {
        return { ok: false, reason: `session_invalid_message:line_${index + 1}`, lineCount: lines.length };
      }
      if (!KNOWN_MESSAGE_ROLES.has(message.role)) {
        return { ok: false, reason: `session_unverified_message_role:line_${index + 1}:${message.role}`, lineCount: lines.length };
      }
      if (message.role === 'toolResult') {
        if (typeof message.toolCallId !== 'string' || !message.toolCallId) {
          return { ok: false, reason: `session_invalid_toolresult:line_${index + 1}:toolCallId`, lineCount: lines.length };
        }
        if (typeof message.toolName !== 'string' || !message.toolName) {
          return { ok: false, reason: `session_invalid_toolresult:line_${index + 1}:toolName`, lineCount: lines.length };
        }
      }
      if (message.content === null || message.content === undefined) {
        // pi 对 null content 容忍为 []，但采集侧无法区分“旧格式”与“内容丢失”，诚实降级。
        return { ok: false, reason: `session_message_content_null:line_${index + 1}`, lineCount: lines.length };
      }
      if (typeof message.content === 'string') {
        // 字符串内容只对 user/custom 合法；assistant/toolResult 必须是块数组。
        if (message.role === 'assistant' || message.role === 'toolResult') {
          return { ok: false, reason: `session_invalid_message:line_${index + 1}`, lineCount: lines.length };
        }
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          const blockType = block && block.type;
          if (!KNOWN_MESSAGE_CONTENT_TYPES.has(blockType)) {
            return { ok: false, reason: `session_unverified_content:line_${index + 1}:${String(blockType)}`, lineCount: lines.length };
          }
          const detail = validateContentBlock(block, message.role);
          if (detail) {
            return { ok: false, reason: `session_invalid_content_block:line_${index + 1}:${detail}`, lineCount: lines.length };
          }
        }
      } else {
        return { ok: false, reason: `session_invalid_message:line_${index + 1}`, lineCount: lines.length };
      }
    }
    if (entryType === 'custom_message' && entry.content !== null && entry.content !== undefined) {
      if (!Array.isArray(entry.content)) {
        return { ok: false, reason: `session_invalid_custom_message:line_${index + 1}`, lineCount: lines.length };
      }
      for (const block of entry.content) {
        const blockType = block && block.type;
        if (!KNOWN_MESSAGE_CONTENT_TYPES.has(blockType)) {
          return { ok: false, reason: `session_unverified_content:line_${index + 1}:${String(blockType)}`, lineCount: lines.length };
        }
        const detail = validateContentBlock(block, 'custom');
        if (detail) {
          return { ok: false, reason: `session_invalid_content_block:line_${index + 1}:${detail}`, lineCount: lines.length };
        }
      }
    }
    if (entryType === 'compaction') {
      if (typeof entry.summary !== 'string' || !entry.summary) {
        return { ok: false, reason: `session_compaction_incomplete:line_${index + 1}`, lineCount: lines.length };
      }
      if (typeof entry.firstKeptEntryId !== 'string' || !entry.firstKeptEntryId) {
        return { ok: false, reason: `session_compaction_ref_missing:line_${index + 1}`, lineCount: lines.length };
      }
      if (!seenIds.has(entry.firstKeptEntryId)) {
        return { ok: false, reason: `session_compaction_ref_broken:line_${index + 1}`, lineCount: lines.length };
      }
    }
    if (entryType === 'branch_summary') {
      // 缺 summary 不得跳过校验（GPT 复审 #3：条件跳过曾让缺 summary 条目 complete=true）。
      if (typeof entry.summary !== 'string' || !entry.summary) {
        return { ok: false, reason: `session_branch_summary_incomplete:line_${index + 1}`, lineCount: lines.length };
      }
      const fromId = entry.fromId === null || entry.fromId === undefined ? null : String(entry.fromId);
      if (fromId !== null && !seenIds.has(fromId)) {
        return { ok: false, reason: `session_branch_ref_broken:line_${index + 1}`, lineCount: lines.length };
      }
    }
    seenIds.add(entry.id);
  }
  return { ok: true, reason: '', lineCount: lines.length };
}

// 只挑选白名单字段，避免把调用方对象里的任意内容归档进检查点。
function sanitizeRunConfig(raw: any) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const pick = (value: any) => String(value || '').trim();
  return {
    provider: pick(source.provider),
    model: pick(source.model),
    modelProfileId: pick(source.modelProfileId),
    modelProfileName: pick(source.modelProfileName),
    promptVersion: pick(source.promptVersion),
    skillIds: Array.isArray(source.skillIds) ? source.skillIds.map(String) : [],
    conversationSkillIds: Array.isArray(source.conversationSkillIds) ? source.conversationSkillIds : [],
  };
}

// configSnapshot 必填键与类型（GPT 复审 #3：空对象曾 complete=true）。
// 只有具体验证依据的维度才可升级；缺键/空串/类型错误一律 harness_tool_config_unverified。
const CONFIG_SNAPSHOT_REQUIRED_KEYS = [
  ['piVersion', (value: any) => typeof value === 'string' && value.trim().length > 0],
  ['agentPromptVersion', (value: any) => typeof value === 'string' && value.trim().length > 0],
  ['toolBridgeEnabled', (value: any) => typeof value === 'boolean'],
  ['deliveryMode', (value: any) => value === 'fresh' || value === 'resume'],
  ['agentName', (value: any) => typeof value === 'string'],
];

function isValidConfigSnapshot(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).length === 0) {
    return false;
  }
  return CONFIG_SNAPSHOT_REQUIRED_KEYS.every(([key, check]: any) => check(value[key]));
}

export function createCollector(options: any = {}) {
  const store = options.store;
  const trustMtime = options.trustMtime !== false;

  // fd 绑定读取（GPT 复审 #1）：内容只从打开的句柄读取，不再按路径名重读。
  // 1) realpath 只做一次并做纯字符串界内校验（不重新解析根，双解析窗口不存在）；
  // 2) openSync 取得 fd 后只从 fd 读；字节数与 fstat 不符（读期间增长/收缩）→ 拒绝；
  // 3) 读后 lstat 与 fstat 比 dev+ino：路径名当前指向的对象必须是读过的对象——
  //    ABA（读期间换根、读后换回）在这里被确定性拦截（换回后 ino 必然不等）；
  // 4) 任一步失败即失败关闭：该文件不读取、不计入清单，并作为一致性异常触发重试。
  function readFileBound(pinnedRoot: any, absolutePath: any): any {
    let resolved = '';
    try {
      resolved = fs.realpathSync(absolutePath);
    } catch {
      return { ok: false, reason: 'resolve_failed' };
    }
    if (!isSameOrUnderPathString(pinnedRoot, resolved)) {
      return { ok: false, reason: 'path_escapes_target' };
    }
    let fd = -1;
    try {
      fd = fs.openSync(resolved, 'r');
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) {
        return { ok: false, reason: 'not_a_file' };
      }
      const content = fs.readFileSync(fd);
      if (content.length !== opened.size) {
        return { ok: false, reason: 'changed_during_read' };
      }
      let namedNow;
      try {
        namedNow = fs.lstatSync(resolved);
      } catch {
        return { ok: false, reason: 'path_unstable' };
      }
      if (namedNow.dev !== opened.dev || namedNow.ino !== opened.ino) {
        return { ok: false, reason: 'path_identity_changed' };
      }
      return { ok: true, content, stat: { size: opened.size, mode: opened.mode, mtimeMs: opened.mtimeMs } };
    } catch {
      return { ok: false, reason: 'read_failed' };
    } finally {
      if (fd >= 0) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }

  // 扫描 + 读前/读后 realpath 边界校验 + 读取 + 秘密哨兵 + 计算 hash。
  // pinnedRoot 是授权时固定的根真实路径：扫描期间根或中间目录被替换成链接时，
  // realpath 解析结果越出 pinnedRoot，读取被拒绝（不跟随新根）。
  // previousFiles 提供 mtime 快速路径（只加速本首扫；二扫永远全量重 hash）。
  function scanFiles(targetDir: any, pinnedRoot: any, policy: any, previousFiles: any, attempt: any) {
    const files: any = {};
    const skipped: any[] = [];
    const unstable: any[] = [];
    const stats = { hashed: 0, reusedHash: 0, secretExcluded: 0, symlinkEscapes: 0, outOfBounds: 0, missing: 0, readUnstable: 0 };
    const candidates = listCandidatePaths(targetDir, policy);

    for (const relativePath of candidates) {
      const { absolutePath, stat } = lstatEntry(targetDir, relativePath);
      if (!stat) {
        stats.missing += 1;
        continue;
      }
      if (stat.isSymbolicLink()) {
        const link = resolveSymlink(pinnedRoot, relativePath, absolutePath);
        if (link.escapes) {
          stats.symlinkEscapes += 1;
        }
        files[relativePath] = {
          type: 'symlink',
          size: 0,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
          linkTarget: link.linkTarget,
          escapes: link.escapes === true,
        };
        continue;
      }
      if (!stat.isFile()) {
        skipped.push({ path: relativePath, reason: stat.isDirectory() ? 'directory-entry' : 'special-file' });
        continue;
      }
      // 读取前的逐文件真实路径边界校验：git 在 core.symlinks=false 下会把 junction
      // 展开成普通文件候选；中间目录被替换成链接时 realpath 越出 pinnedRoot。越界一律不读取。
      // 边界基准 pinnedRoot 是授权时固定的真实路径字符串，比较时不重新解析根（GPT 复审 #1）。
      if (!isPathWithinPinnedRoot(pinnedRoot, absolutePath)) {
        stats.outOfBounds += 1;
        skipped.push({ path: relativePath, reason: 'path_escapes_target' });
        continue;
      }

      const previous = previousFiles && previousFiles[relativePath];
      const reusable = trustMtime
        && previous
        && previous.type === 'file'
        && previous.secretExcluded !== true
        && Number(previous.size) === stat.size
        && Number(previous.mtimeMs) === stat.mtimeMs
        && Number(previous.mode) === stat.mode
        && previous.hash;

      if (reusable) {
        files[relativePath] = {
          type: 'file',
          size: stat.size,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
          hash: previous.hash,
          hashReused: true,
        };
        stats.reusedHash += 1;
        continue;
      }

      const read = readFileBound(pinnedRoot, absolutePath);
      if (!read.ok) {
        // 读取链路任何不稳定信号都失败关闭：不进清单，并作为一致性异常触发重试，
        // 不允许静默跳过（静默跳过会让清单看起来“无此文件”，冒充干净现场）。
        if (read.reason === 'path_escapes_target') {
          stats.outOfBounds += 1;
        } else {
          stats.readUnstable += 1;
        }
        skipped.push({ path: relativePath, reason: read.reason });
        unstable.push({ path: relativePath, reason: read.reason });
        continue;
      }
      if (typeof options.onFileRead === 'function') {
        options.onFileRead(targetDir, relativePath, 'scan', attempt);
      }
      const content = read.content;
      const secretHit = containsSecretSentinel(content);
      const hash = sha256Buffer(content);
      // 秘密命中：不记录内容 hash（低熵秘密的 hash 可被暴力反推），只记录排除事实；无豁免路径。
      // 清单记录的是实际读到的对象（fstat），不是路径的 lstat。
      files[relativePath] = secretHit
        ? { type: 'file', size: read.stat.size, mode: read.stat.mode, mtimeMs: read.stat.mtimeMs, secretExcluded: true }
        : { type: 'file', size: read.stat.size, mode: read.stat.mode, mtimeMs: read.stat.mtimeMs, hash };
      stats.hashed += 1;
      if (secretHit) {
        stats.secretExcluded += 1;
      }
    }

    return { files, skipped, stats, unstable };
  }

  // 二扫：全量重新读取并重 hash，与 M1 逐项比对。stat/mtime 级比对不能发现
  // “同长度改写 + 恢复 mtime”，只有内容级重扫能作为检测依据。
  // 注意：即便 M1==M2 也只是“未检测到变化”——协调写入可让两扫读到从未同时存在的状态，
  // 双扫结果不得兑换严格对照资格（契约 §2.3）。
  function rescanAndDiff(targetDir: any, pinnedRoot: any, policy: any, beforeFiles: any, attempt: any) {
    const differing: string[] = [];
    const seen = new Set<string>();
    for (const relativePath of listCandidatePaths(targetDir, policy)) {
      seen.add(relativePath);
      const before = beforeFiles[relativePath];
      const { absolutePath, stat } = lstatEntry(targetDir, relativePath);
      if (!stat) {
        if (before) {
          differing.push(relativePath);
        }
        continue;
      }
      let actual = '';
      if (stat.isSymbolicLink()) {
        const link = resolveSymlink(pinnedRoot, relativePath, absolutePath);
        actual = link.escapes ? 'link:escapes' : `link:${link.linkTarget}`;
      } else if (stat.isFile()) {
        const read = readFileBound(pinnedRoot, absolutePath);
        if (typeof options.onFileRead === 'function') {
          options.onFileRead(targetDir, relativePath, 'rescan', attempt);
        }
        // 读取失败（越界/身份不稳/读期间变化）一律是异常标记，必然不等于 expected → 触发重试。
        actual = !read.ok
          ? `read-unstable:${read.reason}`
          : (containsSecretSentinel(read.content) ? 'secret-excluded' : sha256Buffer(read.content));
      } else {
        actual = 'other';
      }
      if (!before) {
        differing.push(relativePath);
        continue;
      }
      let expected = '';
      if (before.type === 'symlink') {
        expected = before.escapes === true ? 'link:escapes' : `link:${before.linkTarget}`;
      } else if (before.secretExcluded === true) {
        expected = 'secret-excluded';
      } else {
        expected = before.hash || '';
      }
      if (actual !== expected) {
        differing.push(relativePath);
      }
    }
    for (const name of Object.keys(beforeFiles)) {
      if (!seen.has(name)) {
        differing.push(name);
      }
    }
    return differing.sort();
  }

  // 回放输入准备（采集循环前一次性完成）：受控变量替换 → 最终字节秘密扫描 →
  // session 结构校验 → harness/skill 快照校验。任何一步命中都拒绝归档对应输入并记录
  // 不完整原因。未验证的维度一律降级，不得以“存在文件/有 ID 列表”冒充完整。
  function prepareReplayInput(input: any, deliveryMode: any) {
    const replayInput: any = {
      deliveryMode,
      complete: true,
      incompleteReasons: [] as string[],
      controlledReplacements: [] as any[],
      promptBlobHash: '',
      normalizedPromptHash: '',
      sessionBlobHash: '',
      sessionLineCount: 0,
      runConfig: sanitizeRunConfig(input.runConfig),
      harness: { serverVersion: '', skillSnapshots: [] as any[] },
    };
    const plans: any[] = [];
    const markIncomplete = (reason: string) => {
      replayInput.complete = false;
      if (!replayInput.incompleteReasons.includes(reason)) {
        replayInput.incompleteReasons.push(reason);
      }
    };

    const promptText = String(input.prompt || '');
    const replaced = replaceControlledVariables(promptText, input.controlledValues);
    replayInput.controlledReplacements = replaced.replacements;
    const promptBuffer = Buffer.from(replaced.text, 'utf8');
    if (containsSecretSentinel(promptBuffer)) {
      markIncomplete('prompt_contains_secret');
    } else {
      const promptHash = sha256Buffer(promptBuffer);
      plans.push({ hash: promptHash, content: promptBuffer });
      replayInput.promptBlobHash = promptHash;
      replayInput.normalizedPromptHash = promptHash;
    }

    if (deliveryMode === 'resume') {
      const sessionPath = String(input.sessionPath || '').trim();
      if (!sessionPath || !fs.existsSync(sessionPath)) {
        // 禁止静默降级 fresh：deliveryMode 保持 resume，标记不可完整回放。
        markIncomplete('session_missing');
      } else {
        const sessionRaw = fs.readFileSync(sessionPath);
        const sessionReplaced = replaceControlledVariables(sessionRaw.toString('utf8'), input.controlledValues);
        replayInput.controlledReplacements = replayInput.controlledReplacements.concat(sessionReplaced.replacements);
        const sessionBuffer = Buffer.from(sessionReplaced.text, 'utf8');
        const validation = validateSessionStructure(sessionReplaced.text);
        replayInput.sessionLineCount = validation.lineCount;
        if (!validation.ok) {
          markIncomplete(validation.reason);
        }
        if (containsSecretSentinel(sessionBuffer)) {
          markIncomplete('session_contains_secret');
        }
        if (validation.ok && !replayInput.incompleteReasons.includes('session_contains_secret')) {
          const sessionHash = sha256Buffer(sessionBuffer);
          plans.push({ hash: sessionHash, content: sessionBuffer });
          replayInput.sessionBlobHash = sessionHash;
        }
      }
    }

    if (!replayInput.runConfig.model) {
      markIncomplete('model_config_missing');
    }
    if (!replayInput.runConfig.provider || !replayInput.runConfig.promptVersion) {
      markIncomplete('run_config_incomplete');
    }

    // harness/skill 内容固定（契约 §2.4/§5：skill ID 列表不等于内容固定）。
    // 每个声明的 skill 必须有调用方解析的内容快照；快照内容校验 hash、过哨兵后归档进 CAS，
    // 使回放包自包含，不依赖回放时宿主机上的 skill 文件。
    const harnessInput = input.harness && typeof input.harness === 'object' ? input.harness : {};
    replayInput.harness.serverVersion = String(harnessInput.serverVersion || '').trim();
    if (!replayInput.harness.serverVersion) {
      markIncomplete('harness_config_unverified');
    }
    // harness/tool 配置内容固定（GPT 复审 #3：serverVersion 非空不能替代未验证的
    // harness/tool 完整性依据；空对象不是有效配置快照）。调用方必须提供含必填键的
    // 有效配置快照对象；快照经哨兵扫描后归档进 CAS，hash 记入清单。
    // 空对象/缺必填键/类型错误 → harness_tool_config_unverified。
    const configSnapshot = harnessInput.configSnapshot;
    if (isValidConfigSnapshot(configSnapshot)) {
      const configBuffer = Buffer.from(JSON.stringify(configSnapshot), 'utf8');
      if (containsSecretSentinel(configBuffer)) {
        markIncomplete('harness_config_contains_secret');
      } else {
        const configHash = sha256Buffer(configBuffer);
        plans.push({ hash: configHash, content: configBuffer });
        replayInput.harness.configSnapshotHash = configHash;
      }
    } else {
      markIncomplete('harness_tool_config_unverified');
    }
    const snapshots = Array.isArray(harnessInput.skillSnapshots) ? harnessInput.skillSnapshots : [];
    const snapshotsById = new Map<string, any>();
    for (const snap of snapshots) {
      const id = String(snap && snap.id || '').trim();
      if (id && !snapshotsById.has(id)) {
        snapshotsById.set(id, snap);
      }
    }
    const declaredSkillIds = new Set<string>([
      ...replayInput.runConfig.skillIds,
      ...replayInput.runConfig.conversationSkillIds,
    ].map((id: any) => String(id || '').trim()).filter(Boolean));
    for (const id of declaredSkillIds) {
      const snap = snapshotsById.get(id);
      // content 必须是字符串（空串也是合法内容，由 hash 校验判定）；缺快照/缺 hash → 不完整。
      if (!snap || !String(snap.sha256 || '').trim() || typeof snap.content !== 'string') {
        markIncomplete(`skill_snapshot_missing:${id}`);
      }
    }
    const archivedSkillIds = new Set<string>();
    for (const [id, snap] of snapshotsById) {
      const declaredSha = String(snap.sha256 || '').trim().toLowerCase();
      if (!declaredSha || typeof snap.content !== 'string') {
        continue; // 缺 hash/缺内容已在上方按声明清单标记
      }
      // 空内容不得跳过校验（GPT 复审 #3：content="" + 非空 sha 曾绕过检查）：
      // 照常计算内容 hash 与声明值比对，不一致即拒绝归档。
      const contentBuffer = Buffer.from(snap.content, 'utf8');
      const actualSha = sha256Buffer(contentBuffer);
      if (actualSha !== declaredSha) {
        markIncomplete(`skill_snapshot_hash_mismatch:${id}`);
        continue;
      }
      if (containsSecretSentinel(contentBuffer)) {
        markIncomplete(`skill_contains_secret:${id}`);
        continue;
      }
      plans.push({ hash: actualSha, content: contentBuffer });
      replayInput.harness.skillSnapshots.push({
        id,
        source: String(snap.source || '').trim(),
        sha256: actualSha,
        blobHash: actualSha,
      });
      archivedSkillIds.add(id);
    }
    // 声明集合与实际归档集合对账：声明的 skill 未归档且无更具体原因时，显式标记。
    for (const id of declaredSkillIds) {
      if (!archivedSkillIds.has(id)
        && !replayInput.incompleteReasons.some((reason: string) => (
          reason === `skill_snapshot_missing:${id}`
          || reason === `skill_snapshot_hash_mismatch:${id}`
          || reason === `skill_contains_secret:${id}`
        ))) {
        markIncomplete(`skill_snapshot_not_archived:${id}`);
      }
    }

    return { replayInput, plans };
  }

  function captureTurnCheckpoint(input: any = {}) {
    const startedAt = Date.now();
    const projectId = String(input.projectId || '').trim();
    const targetDir = path.resolve(String(input.targetDir || '').trim() || '.');
    const deliveryMode = input.deliveryMode === 'resume' ? 'resume' : 'fresh';
    const checkpointId = crypto.randomUUID();

    const fail = (reason: any, extra: any = {}) => ({
      captured: false,
      checkpointId: '',
      reason,
      durationMs: Date.now() - startedAt,
      ...extra,
    });

    if (!store) {
      return fail('store_unavailable');
    }
    if (!projectId) {
      return fail('project_id_missing');
    }
    if (!fs.existsSync(targetDir)) {
      return fail('target_dir_missing');
    }

    const policy = store.loadPolicy(projectId);
    if (policy.status !== 'enabled') {
      return fail('policy_not_enabled', { policyStatus: policy.status });
    }
    // 授权判定基于保存策略时固定的根身份（authorizedDirPins）；授权后根被替换、
    // 策略未经固定流程保存、目标经链接越界，分别显式拒绝，不跟随新目标（GPT 复审 #1）。
    const authorization = authorizeTargetDir(policy, targetDir);
    if (!authorization.ok) {
      return fail(authorization.reason, authorization.dir ? { authorizedDir: authorization.dir } : {});
    }
    // 采集窗口内的根身份基准：pinnedRoot 直接取授权判定验证过的 resolvedTarget，
    // 不做第二次 realpath（授权结论与使用之间的二次解析是 pin 竞态入口，GPT 复审 #1）。
    // 后续所有逐文件校验都以该字符串为基准；根身份在窗口内变化 → target_root_replaced 失败。
    const pinnedRoot = String(authorization.resolvedTarget || '').trim();
    if (!pinnedRoot) {
      return fail('authorized_root_unresolved');
    }
    const rootIntact = () => pathsEqual(realpathOrResolved(targetDir), pinnedRoot);
    // 防止采集存储自身被纳入采集范围（递归/自引用）。
    const rootRelative = path.relative(pinnedRoot, realpathOrResolved(store.captureRoot));
    if (rootRelative === '' || (!rootRelative.startsWith('..') && !path.isAbsolute(rootRelative))) {
      return fail('capture_root_inside_target');
    }

    const previous = store.loadLatestCheckpoint(projectId, targetDir);
    const previousFiles = previous && previous.files ? previous.files : null;
    const { replayInput, plans } = prepareReplayInput(input, deliveryMode);

    let consistency: any = null;
    let scanResult: any = null;
    let deletions: string[] = [];
    let newBlobBytes = 0;
    let retries = 0;
    let anyAnomaly = false;

    for (let attempt = 0; attempt <= MAX_CONSISTENCY_RETRIES; attempt += 1) {
      // 逐 attempt 暂存：本轮读到的 blob 只写入 staging，通过根身份复检 + 一致性定级后
      // 才原子提交进 CAS；重试/失败整体回滚（GPT 复审 #1：阶段末才报失败但外部 blob
      // 已落盘的结构不再可能）。
      const stagingId = `${checkpointId}-attempt-${attempt}`;
      const stagedHashes = new Set<string>();
      let attemptStagedBytes = 0;
      const rollback = () => {
        try { store.rollbackStaging(projectId, stagingId); } catch {}
      };
      const commit = () => {
        store.commitStaging(projectId, stagingId);
        newBlobBytes = attemptStagedBytes;
      };

      if (!rootIntact()) {
        rollback();
        return fail('target_root_replaced', { phase: 'before-scan', attempt });
      }
      scanResult = scanFiles(targetDir, pinnedRoot, policy, attempt === 0 ? previousFiles : null, attempt);

      // 删除状态：相对上一检查点消失的路径。
      const currentPaths = new Set(Object.keys(scanResult.files));
      deletions = previousFiles
        ? Object.keys(previousFiles).filter((name) => !currentPaths.has(name)).sort()
        : [];

      // 测试注入点 A：首扫之后、staging 写入之前（模拟扫描-写入间并发修改/秘密注入/根替换）。
      if (typeof options.afterScan === 'function') {
        options.afterScan(targetDir, attempt);
      }
      if (!rootIntact()) {
        rollback();
        return fail('target_root_replaced', { phase: 'after-scan', attempt });
      }

      // 配额预检（每个 attempt 都执行，扫描后、任何写盘前）：
      // 已有占用 + 新文件 blob + prompt/session/skill 计划字节 + 清单估值 超额 → 挂起策略，
      // 不落任何 blob/清单，不伪造成功。
      const usage = store.computeUsage(projectId);
      let estimatedNewBytes = 0;
      for (const relativePath of Object.keys(scanResult.files)) {
        const entry = scanResult.files[relativePath];
        if (entry.type === 'file' && entry.secretExcluded !== true && entry.hash && !store.hasBlob(projectId, entry.hash)) {
          estimatedNewBytes += Number(entry.size) || 0;
        }
      }
      let pendingPlanBytes = 0;
      for (const plan of plans) {
        if (plan && !store.hasBlob(projectId, plan.hash)) {
          pendingPlanBytes += plan.content.length;
          estimatedNewBytes += plan.content.length;
        }
      }
      estimatedNewBytes += Buffer.byteLength(JSON.stringify({ files: scanResult.files, deletions, replayInput }), 'utf8')
        + MANIFEST_ESTIMATE_RESERVE_BYTES;
      if (usage.totalBytes + estimatedNewBytes > policy.stagingQuotaBytes) {
        rollback();
        store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'quota_exceeded' });
        return fail('quota_exceeded', {
          policyStatus: 'suspended',
          usageBytes: usage.totalBytes,
          estimatedNewBytes,
        });
      }

      // 写 staging：fd 绑定重读、重校 hash、重扫秘密哨兵，检测扫描与读取之间的变化。
      // 逐 blob 落盘前按写时实际字节重新核算配额：扫描后文件膨胀不得先突破配额再失败
      // （GPT 复审 #5）。预检是估计，这里是硬上限。
      const attemptBaseBytes = usage.totalBytes;
      let attemptWrittenBytes = 0;
      const writeMismatches: string[] = [];
      for (const relativePath of Object.keys(scanResult.files)) {
        const entry = scanResult.files[relativePath];
        if (entry.type !== 'file' || entry.secretExcluded === true || !entry.hash) {
          continue;
        }
        if (store.hasBlob(projectId, entry.hash) || stagedHashes.has(entry.hash)) {
          continue;
        }
        const absolutePath = path.join(targetDir, relativePath);
        const read = readFileBound(pinnedRoot, absolutePath);
        if (!read.ok) {
          // 读取链路不稳定：已读内容（若有）必须丢弃，绝不落 staging。
          writeMismatches.push(relativePath);
          continue;
        }
        const content = read.content;
        const writeSecretHit = containsSecretSentinel(content);
        if (writeSecretHit) {
          // TOCTOU 防线：首扫后注入的秘密绝不落盘；标记排除并触发重试，
          // 由下一轮扫描在扫描阶段正式排除。无豁免路径。
          delete entry.hash;
          entry.secretExcluded = true;
          scanResult.stats.secretExcluded += 1;
          writeMismatches.push(relativePath);
          continue;
        }
        const actualHash = sha256Buffer(content);
        if (actualHash !== entry.hash) {
          writeMismatches.push(relativePath);
          entry.hash = actualHash;
          entry.size = content.length;
        }
        const alreadyAvailable = store.hasBlob(projectId, actualHash) || stagedHashes.has(actualHash);
        const pendingBlobBytes = alreadyAvailable ? 0 : content.length;
        if (pendingBlobBytes > 0
          && attemptBaseBytes + attemptWrittenBytes + pendingBlobBytes + pendingPlanBytes + MANIFEST_ESTIMATE_RESERVE_BYTES > policy.stagingQuotaBytes) {
          rollback();
          store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'quota_exceeded' });
          return fail('quota_exceeded', {
            policyStatus: 'suspended',
            duringWrite: true,
            path: relativePath,
            usageBytes: attemptBaseBytes + attemptWrittenBytes,
          });
        }
        if (!alreadyAvailable) {
          try {
            const staged = store.stageBlob(projectId, stagingId, actualHash, content);
            stagedHashes.add(actualHash);
            attemptWrittenBytes += staged.bytes;
            attemptStagedBytes += staged.bytes;
          } catch (error: any) {
            rollback();
            store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'write_failed' });
            return fail('write_failed', {
              policyStatus: 'suspended',
              error: error && error.message ? String(error.message) : String(error),
            });
          }
        }
      }

      // 测试注入点 B：staging 写入之后、二扫之前（模拟采集窗口内的并发写入者）。
      if (typeof options.afterFirstScan === 'function') {
        options.afterFirstScan(targetDir, attempt);
      }
      if (!rootIntact()) {
        rollback();
        return fail('target_root_replaced', { phase: 'after-write', attempt });
      }

      const differing = rescanAndDiff(targetDir, pinnedRoot, policy, scanResult.files, attempt);
      // 扫描/写入期间的读取不稳定同样是异常：必须触发重试或降级，不得静默通过。
      const unstablePaths = Array.isArray(scanResult.unstable) ? scanResult.unstable.map((entry: any) => entry.path) : [];
      const changed = Array.from(new Set([...differing, ...writeMismatches, ...unstablePaths])).sort();

      if (changed.length === 0) {
        try {
          commit();
        } catch (error: any) {
          rollback();
          store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'write_failed' });
          return fail('write_failed', {
            policyStatus: 'suspended',
            error: error && error.message ? String(error.message) : String(error),
          });
        }
        consistency = {
          evidence: anyAnomaly ? 'corrected-after-retry' : 'content-verified',
          atomicityGuaranteed: false,
          secondScanMode: 'full-hash',
          differingPaths: [],
        };
        break;
      }
      anyAnomaly = true;
      retries = attempt + 1;
      consistency = {
        evidence: 'write-during-capture',
        atomicityGuaranteed: false,
        secondScanMode: 'full-hash',
        differingPaths: changed,
      };
      if (attempt === MAX_CONSISTENCY_RETRIES) {
        // 降级包：保留最后一轮读取的内容 blob（清单引用它们才能恢复），证据级别如实披露。
        try {
          commit();
        } catch (error: any) {
          rollback();
          store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'write_failed' });
          return fail('write_failed', {
            policyStatus: 'suspended',
            error: error && error.message ? String(error.message) : String(error),
          });
        }
      } else {
        rollback();
      }
    }

    // 内容缺口一律标记回放输入不完整（契约 §2.5：脱敏/排除导致关键输入缺失必须显式标记）。
    const secretExcludedPaths = Object.keys(scanResult.files)
      .filter((name) => scanResult.files[name].secretExcluded === true)
      .sort();
    if (secretExcludedPaths.length > 0) {
      replayInput.secretExcludedPaths = secretExcludedPaths;
      replayInput.complete = false;
      replayInput.incompleteReasons.push('files_contain_secret');
    }
    if (scanResult.stats.symlinkEscapes > 0) {
      replayInput.complete = false;
      replayInput.incompleteReasons.push('symlink_escape_present');
    }
    if (scanResult.stats.outOfBounds > 0) {
      replayInput.complete = false;
      replayInput.incompleteReasons.push('out_of_bounds_path');
    }

    // 一致性稳定后写入 prompt/session/skill 计划 blob；每个 blob 落盘前仍按实际字节
    // 重新核算配额（计划字节已在预检估计，这里是硬上限的最后一道）。
    try {
      for (const plan of plans) {
        if (!plan || store.hasBlob(projectId, plan.hash)) {
          continue;
        }
        const usageBeforePlan = store.computeUsage(projectId);
        if (usageBeforePlan.totalBytes + plan.content.length + MANIFEST_ESTIMATE_RESERVE_BYTES > policy.stagingQuotaBytes) {
          store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'quota_exceeded' });
          return fail('quota_exceeded', {
            policyStatus: 'suspended',
            duringWrite: true,
            usageBytes: usageBeforePlan.totalBytes,
          });
        }
        const written = store.writeBlob(projectId, plan.hash, plan.content);
        newBlobBytes += written.bytes;
      }
    } catch (error: any) {
      store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'write_failed' });
      return fail('write_failed', {
        policyStatus: 'suspended',
        error: error && error.message ? String(error.message) : String(error),
      });
    }

    const integrityManifestHash = buildManifestHash(scanResult.files, deletions);
    // v1 没有独立的源现场一致性依据（契约 §2.3）：双扫三级证据只是"未检测到变化"的
    // 检测记录，协调写入可以骗过任意次数的内容比对。严格对照资格恒为 false；
    // 包可保存、可标记、可作 best-effort 回放，但不得进入严格对照评测。
    const strictEvalEligible = false;
    const strictEvalBlockedReason = 'no_independent_consistency_evidence';

    const checkpoint = {
      schemaVersion: 1,
      checkpointId,
      projectId,
      conversationId: String(input.conversationId || '').trim(),
      turnId: String(input.turnId || '').trim(),
      agentId: String(input.agentId || '').trim(),
      createdAt: nowIso(),
      targetDir,
      status: 'staged',
      files: scanResult.files,
      deletions,
      skipped: scanResult.skipped,
      integrity: {
        algorithm: 'sha256',
        manifestHash: integrityManifestHash,
        knownLimitations: KNOWN_LIMITATIONS.slice(),
      },
      consistency: { ...consistency, retries },
      replayInput,
      environment: input.environment && typeof input.environment === 'object' ? input.environment : {},
      strictEvalEligible,
      strictEvalBlockedReason,
      stats: {
        fileCount: Object.keys(scanResult.files).length,
        totalBytes: Object.values(scanResult.files).reduce((sum: any, entry: any) => sum + (Number((entry as any).size) || 0), 0),
        newBlobBytes,
        newManifestBytes: 0,
        totalNewBytes: 0,
        hashedFiles: scanResult.stats.hashed,
        reusedHashFiles: scanResult.stats.reusedHash,
        secretExcludedFiles: scanResult.stats.secretExcluded,
        symlinkEscapes: scanResult.stats.symlinkEscapes,
        outOfBoundsFiles: scanResult.stats.outOfBounds,
        readUnstableFiles: scanResult.stats.readUnstable,
        durationMs: Date.now() - startedAt,
      },
    };

    // latest 指针的增量字节可预先精确计算（内容定长，见 store.latestPointerJsonSize）。
    const latestBytesBefore = store.latestPointerSize(projectId, targetDir);
    const latestDelta = Math.max(0, store.latestPointerJsonSize(projectId, targetDir, checkpointId) - latestBytesBefore);

    // stats 自报字节是清单内容的一部分，用定点迭代使自报值与最终落盘字节一致。
    let manifestBytes = 0;
    let newManifestBytes = 0;
    let totalNewBytes = 0;
    for (let iteration = 0; iteration < 6; iteration += 1) {
      checkpoint.stats.newManifestBytes = newManifestBytes;
      checkpoint.stats.totalNewBytes = totalNewBytes;
      manifestBytes = Buffer.byteLength(`${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
      const nextManifest = manifestBytes + latestDelta;
      const nextTotal = newBlobBytes + nextManifest;
      if (nextManifest === newManifestBytes && nextTotal === totalNewBytes) {
        break;
      }
      newManifestBytes = nextManifest;
      totalNewBytes = nextTotal;
    }

    // 配额终检：blob 已落盘，按实际清单 + latest 指针字节做最后一次核算；超额则挂起
    // 且不落清单（可能留下无清单引用的孤儿 blob，由 GC 回收，但不伪造检查点）。
    const usageBeforeManifest = store.computeUsage(projectId);
    if (usageBeforeManifest.totalBytes + newManifestBytes > policy.stagingQuotaBytes) {
      store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'quota_exceeded' });
      return fail('quota_exceeded', {
        policyStatus: 'suspended',
        usageBytes: usageBeforeManifest.totalBytes,
        manifestBytes: newManifestBytes,
        afterWrite: true,
      });
    }

    try {
      store.saveCheckpoint(projectId, checkpoint);
      store.saveLatestCheckpointId(projectId, targetDir, checkpointId);
    } catch (error: any) {
      store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'write_failed' });
      return fail('write_failed', {
        policyStatus: 'suspended',
        error: error && error.message ? String(error.message) : String(error),
      });
    }

    return {
      captured: true,
      checkpointId,
      checkpoint,
      reason: '',
      durationMs: Date.now() - startedAt,
    };
  }

  return { captureTurnCheckpoint, scanFiles, listCandidatePaths };
}
