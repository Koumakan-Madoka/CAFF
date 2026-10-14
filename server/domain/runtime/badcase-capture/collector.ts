// Turn 执行前检查点采集器（契约 §2）。
//
// 流程：能力探测（受限读取原语可用性，失败即在扫描用户目录前拒绝）→ 授权检查
// （pin 表 + 授权时固定的根身份；v1 目标必须恰为授权根本身）→ 打开受限根
// （父进程持有根目录 fd，statx 身份与 pin 比对）→ 回放输入准备（受控替换 +
// 最终字节秘密扫描 + session 维度校验 + harness/skill 快照校验）→ 采集循环
// [ 枚举身份检查 → 首次扫描 M1（受限枚举 + openat2 受限批量读取、扫描即秘密检测）
//   → 配额预检 → 写 staging（受限重读、重校 hash、重扫秘密、逐 blob 写前配额核算）
//   → 二次扫描 M2（全量内容重 hash）→ 一致性定级 → staging 原子提交或回滚 ]
// → 配额终检 → 落盘清单。
//
// 诚实性约束：
// - 授权绑定"已打开的目录对象"而非路径名（GPT 复审 #1 第五轮）：所有目标树内容
//   读取由 helper 以 openat2(rootfd, …, RESOLVE_BENEATH|NO_SYMLINKS|NO_MAGICLINKS|
//   NO_XDEV) 完成，解析在内核中相对对象原子发生；路径改名/替换/ABA 与结论无关，
//   越权内容不会被读取，更不会到达 staging。仅 Linux 支持（内核 >= 5.6 + statx
//   btime）；win32/darwin 能力探测失败关闭，拒绝采集且零目标内容读取。
// - 秘密先扫描后落盘：扫描到的内容、最终写入 CAS 的内容都必须过哨兵检测；命中即
//   拒绝归档该输入并标记输入损失（complete=false）。无大小/二进制跳检，无豁免机制。
// - 一致性证据三级都只是"未检测到变化"的检测记录，不是现场一致性证明；v1 无独立
//   一致性依据，strictEvalEligible 恒为 false（契约 §2.3）。
// - 采集路径不执行 git（GPT 复审 #1 第七轮）：命令行 -c 黑名单只能禁止 git 执行
//   仓库指定程序，不能禁止 git 读取未授权内容（include.path / info/exclude 符号
//   链接指向树外）。tracked/ignored 分类由 git-classify 内置解析器复现，.git/index、
//   .git/config、.git/info/exclude、.gitignore 全部经受限根读取；树外元数据
//   （gitfile 外置 gitdir、绝对 excludesFile）不自动获授权，须 authorizedInputDirs
//   显式授权，否则降级多采并标记不完整。
// - 纳入范围但无法采集的材料（权限拒绝、特殊文件、不可读目录、元数据缺陷）一律
//   进入 uncaptured 缺口清单并使 complete=false；恢复侧如实上报缺口，不得宣称
//   回放输入完整（GPT 复审 #2 第七轮）。用户显式排除（excludedPatterns/ignore
//   规则）不属于缺口。
// - session 维度清单制（session-validator.ts）：未验证维度默认 incomplete；
//   结构损坏的材料不归档，禁止静默降级 fresh。
// - 配额按实际新增去重内容 + 清单元数据核算，覆盖每个重试 attempt；超额 → 策略
//   suspended，不落盘、不伪造成功。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
import { authorizeTargetDir, matchesRelativePattern, pathsEqual, isSameOrUnderPathString } from './capture-policy';
import { containsSecretSentinel, replaceControlledVariables } from './secrets';
import { detectCaptureCapability, openConstrainedRoot, SAFE_READ_LIMITS } from './safe-read';
import { validateSessionV2, PI_VERSION_PIN } from './session-validator';
import { withProjectWriteLock } from './project-write-lock';
import {
  parseGitIndex,
  parseGitignoreRules,
  classifyWalkEntries,
  parseGitConfigSubset,
} from './git-classify';

function sha256Buffer(content: any) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

const MAX_CONSISTENCY_RETRIES = 2;
const MANIFEST_ESTIMATE_RESERVE_BYTES = 4096;

// v1 常驻的机器可读限制声明（写进每个检查点，不是文档级披露）。
const KNOWN_LIMITATIONS = [
  'no_atomic_snapshot', // 采集非原子快照，双扫只是“未检测到变化”的检测记录
  'no_independent_consistency_evidence', // 无独立源现场一致性依据，严格对照资格恒 false
  'linux_only_capture_v1', // 受限读取原语仅 Linux 实现；win32/darwin 失败关闭
  'enumeration_non_atomic', // 枚举与内容均使用受限根 fd，但整个多文件采集仍不是原子快照
  'inode_reuse_residual', // 跨重启根身份以 dev+ino+btime 三元组核对，收敛但非数学消除 inode 复用
  'helper_trusted_compute_base', // helper（python3 + 内嵌脚本，SHA-256 固定）与采集存储的不可写性是部署前提，记入 TCB
  'harness_config_caller_asserted', // harness/tool 配置快照由调用方声明，采集方不独立验证其来源
  'environment_not_pinned', // 环境模板/镜像 digest 固定属后续工作项（W4）
  'external_service_state_not_pinned', // 模型端点与外部服务状态不可固定
];

// 外置 gitdir（gitfile/符号链接形态的 .git）的独立授权边界：与 session 输入同一
// 语义——必须位于 authorizedInputPins 固定的目录内，身份比对通过后才打开受限根。
// 不因“属于 git 元数据”自动获授权（GPT 复审 #1 第七轮）。
function openGitdirBoundary(policy: any, capability: any, gitdirAbsolute: any) {
  const pins = policy && policy.authorizedInputPins && typeof policy.authorizedInputPins === 'object'
    ? policy.authorizedInputPins
    : {};
  let real = '';
  try {
    real = fs.realpathSync(String(gitdirAbsolute || ''));
  } catch {
    return { ok: false, reason: 'git_metadata_not_authorized' };
  }
  for (const key of Object.keys(pins)) {
    const pin = (pins as any)[key];
    const pinReal = String(pin && pin.realpath || '').trim();
    if (!pinReal || !isSameOrUnderPathString(pinReal, real)) {
      continue;
    }
    if (!pin.identity || typeof pin.identity !== 'object') {
      return { ok: false, reason: 'git_metadata_not_authorized' };
    }
    const handle: any = openConstrainedRoot(capability, pinReal);
    if (!handle.ok) {
      return { ok: false, reason: `git_metadata_unavailable:${handle.reason}` };
    }
    if (!handle.identityEquals(pin.identity)) {
      handle.close();
      return { ok: false, reason: 'git_metadata_root_replaced' };
    }
    const base = path.relative(pinReal, real).replace(/\\/g, '/');
    return { ok: true, reason: '', handle, base };
  }
  return { ok: false, reason: 'git_metadata_not_authorized' };
}

// 读取分类元数据（.git/config、index、info/exclude、树内 .gitignore），全部经受限根。
// 任何缺陷（include 指令、excludesFile 越界、index 损坏、exclude 不可读）只降级
// 标记，不把降级结果宣称为完整分类，绝不跟随到授权边界之外。
function readGitMetadata(targetDir: any, pinnedRoot: any, policy: any, rootHandle: any, capability: any, walkEntries: any, excluded: any) {
  const result: any = {
    status: 'absent',
    tracked: null,
    applyIgnore: false,
    globalSources: [] as any[],
    gitignoreByDir: new Map<string, any>(),
    reasons: [] as string[],
    helperFailure: '',
  };
  const addReason = (reason: string) => {
    if (!result.reasons.includes(reason)) {
      result.reasons.push(reason);
    }
  };
  const dotGit = walkEntries.find((entry: any) => entry.path === '.git');
  if (!dotGit) {
    // 边界内无 .git：不读取父目录（越界）。无分类依据 → 全量采集（宁多采），
    // 完整语义不受影响（没有任何材料因分类规则被丢弃）。
    return result;
  }
  result.status = 'ok';

  // gitdir 读取边界：{ handle, base }，base 为相对 handle 根的路径前缀。
  let boundary: any = null;
  let ownedHandle: any = null;
  if (dotGit.type === 'dir') {
    boundary = { handle: rootHandle, base: '.git' };
  } else if (dotGit.type === 'file') {
    let gitdirRef = '';
    {
      const batch = rootHandle.readBatch(['.git']);
      if (!batch.ok) {
        result.helperFailure = batch.reason || 'helper_failed';
        return result;
      }
      const res = batch.results.get('.git');
      if (res && res.ok === true) {
        const match = res.content.toString('utf8').match(/^gitdir:\s*(.+)$/m);
        gitdirRef = match ? match[1].trim() : '';
      }
    }
    if (!gitdirRef) {
      addReason('git_metadata_unreadable');
      result.status = 'degraded';
      return result;
    }
    const opened = openGitdirBoundary(policy, capability, path.resolve(targetDir, gitdirRef));
    if (!opened.ok) {
      addReason(opened.reason === 'git_metadata_root_replaced' ? 'git_metadata_root_replaced' : 'git_metadata_not_authorized');
      result.status = 'degraded';
      return result;
    }
    boundary = { handle: opened.handle, base: opened.base };
    ownedHandle = opened.handle;
  } else {
    addReason('git_metadata_unreadable');
    result.status = 'degraded';
    return result;
  }

  try {
    const rel = (name: string, base: any = boundary.base) => {
      const prefix = typeof base === 'string' ? base : boundary.base;
      return prefix ? `${prefix}/${name}` : name;
    };
    const firstBatch = boundary.handle.readBatch([
      rel('config'), rel('index'), rel('commondir'), rel('info/exclude'),
    ]);
    if (!firstBatch.ok) {
      result.helperFailure = firstBatch.reason || 'helper_failed';
      return result;
    }
    const first = (name: string) => firstBatch.results.get(rel(name)) || { ok: false, code: 'helper_output_missing' };

    // commondir（worktree 形态）：config 与 info/exclude 位于公共目录。引用必须仍在
    // 同一授权边界内（相对 gitdir 解析后以 '..' 越界即拒绝，不读取）。
    let commonBase: any = null;
    const commondirResult = first('commondir');
    if (commondirResult.ok === true) {
      const ref = commondirResult.content.toString('utf8').trim().replace(/\\/g, '/');
      const joined = path.posix.normalize(`${boundary.base ? `${boundary.base}/` : ''}${ref}`).replace(/\/+$/, '');
      if (path.isAbsolute(ref) || joined === '..' || joined.startsWith('../')) {
        addReason('git_metadata_not_authorized');
        result.status = 'degraded';
        return result;
      }
      commonBase = joined === '.' ? '' : joined;
    } else if (commondirResult.code !== 'missing') {
      addReason('git_metadata_unreadable');
    }

    let configResult = first('config');
    let excludeResult = first('info/exclude');
    if (commonBase !== null) {
      const commonBatch = boundary.handle.readBatch([rel('config', commonBase), rel('info/exclude', commonBase)]);
      if (!commonBatch.ok) {
        result.helperFailure = commonBatch.reason || 'helper_failed';
        return result;
      }
      const commonConfig = commonBatch.results.get(rel('config', commonBase));
      const commonExclude = commonBatch.results.get(rel('info/exclude', commonBase));
      if (commonConfig) configResult = commonConfig;
      excludeResult = commonExclude && commonExclude.ok !== undefined ? commonExclude : excludeResult;
      if (commonExclude && commonExclude.ok === false && commonExclude.code === 'missing') {
        // commondir 无独立 exclude：正常（缺失不降级）。
        excludeResult = commonExclude;
      }
    }

    // config 子集：objectformat（index 哈希长度）、excludesFile、include 检测。
    let hashLen = 20;
    let configReadable = false;
    if (configResult.ok === true) {
      configReadable = true;
      const subset = parseGitConfigSubset(configResult.content.toString('utf8'));
      if (!subset.verified) addReason('git_config_unverified');
      if (subset.hasInclude) {
        // include 目标可能位于授权边界之外——绝不展开读取；配置完整性不可验证。
        addReason('git_config_include_unverified');
      }
      if (subset.objectFormat === 'sha256') {
        hashLen = 32;
      } else if (subset.objectFormat && subset.objectFormat !== 'sha1') {
        addReason('git_config_unverified');
      }
      if (subset.excludesFile) {
        // 外置 exclude 文件：仅当位于已授权树内才经受限根读取；越界/不可读不跟随。
        const rawExcludes = String(subset.excludesFile);
        const excludesAbsolute = path.isAbsolute(rawExcludes)
          ? rawExcludes
          : (rawExcludes.startsWith('~') ? '' : path.resolve(targetDir, rawExcludes));
        let excludesHandled = false;
        if (excludesAbsolute && isSameOrUnderPathString(pinnedRoot, excludesAbsolute)) {
          const relExcludes = path.relative(pinnedRoot, excludesAbsolute).replace(/\\/g, '/');
          if (relExcludes && !relExcludes.startsWith('..')) {
            const excludesBatch = rootHandle.readBatch([relExcludes]);
            if (!excludesBatch.ok) {
              result.helperFailure = excludesBatch.reason || 'helper_failed';
              return result;
            }
            const excludesRead = excludesBatch.results.get(relExcludes);
            if (excludesRead && excludesRead.ok === true) {
              result.globalSources.push({ base: '', rules: parseGitignoreRules(excludesRead.content.toString('utf8')) });
              excludesHandled = true;
            }
          }
        }
        if (!excludesHandled) {
          // 未读取的规则不生效 → 保守多采；配置指向的材料不可得，显式降级。
          addReason('git_excludes_file_unverified');
        }
      }
    } else if (configResult.code !== 'missing') {
      addReason('git_config_unreadable');
    }

    // index：缺失 = 有效空仓库（tracked 为空集，ignore 规则仍生效）；
    // 损坏/不可读 = tracked 未知 → 不应用 ignore 规则，全量多采并降级。
    const indexResult = first('index');
    if (indexResult.ok === true) {
      let parsed = parseGitIndex(indexResult.content, hashLen);
      if (!parsed.ok && !subset_hasExplicitFormat(configReadable, configResult)) {
        // 配置未明示 objectformat 时尝试另一哈希长度（include 可能隐藏真实格式）。
        const alternate = parseGitIndex(indexResult.content, hashLen === 20 ? 32 : 20);
        if (alternate.ok) {
          parsed = alternate;
          addReason('git_config_include_unverified');
        }
      }
      if (parsed.ok) {
        result.tracked = new Set(parsed.entries.map((entry: any) => entry.path));
      } else {
        addReason('git_index_unreadable');
      }
    } else if (indexResult.code === 'missing') {
      result.tracked = new Set();
    } else {
      addReason('git_index_unreadable');
    }

    // info/exclude：缺失正常；不可读（如符号链接被内核拒绝）→ 规则不生效 + 降级。
    if (excludeResult && excludeResult.ok === true) {
      result.globalSources.push({ base: '', rules: parseGitignoreRules(excludeResult.content.toString('utf8')) });
    } else if (excludeResult && excludeResult.code && excludeResult.code !== 'missing') {
      addReason('git_exclude_unreadable');
    }

    // 树内 .gitignore：经受限根批量读取；不可读 → 该目录规则缺失（多采）+ 降级。
    if (result.tracked !== null) {
      const gitignorePaths = walkEntries
        .filter((entry: any) => entry.type !== 'dir'
          && (entry.path === '.gitignore' || entry.path.endsWith('/.gitignore'))
          && !matchesRelativePattern(entry.path, excluded))
        .map((entry: any) => entry.path);
      if (gitignorePaths.length > 0) {
        const batch = rootHandle.readBatch(gitignorePaths);
        if (!batch.ok) {
          result.helperFailure = batch.reason || 'helper_failed';
          return result;
        }
        for (const gitignorePath of gitignorePaths) {
          const res = batch.results.get(gitignorePath);
          if (res && res.ok === true) {
            const dir = gitignorePath === '.gitignore' ? '' : gitignorePath.slice(0, gitignorePath.length - '/.gitignore'.length);
            result.gitignoreByDir.set(dir, parseGitignoreRules(res.content.toString('utf8')));
          } else {
            addReason('git_exclude_unreadable');
          }
        }
      }
    }
  } finally {
    if (ownedHandle) {
      ownedHandle.close();
    }
  }

  const ruleSets = [...result.globalSources.map((source: any) => source.rules), ...result.gitignoreByDir.values()];
  if (ruleSets.some((rules: any) => rules.verified === false)) addReason('git_ignore_unverified');
  // Unknown metadata must not silently discard a potentially tracked file.
  result.applyIgnore = result.tracked !== null && !result.reasons.some((reason: string) => ['git_ignore_unverified', 'git_config_unverified', 'git_index_unreadable', 'git_metadata_unreadable'].includes(reason));
  if (result.reasons.length > 0) {
    result.status = 'degraded';
  }
  return result;
}

function subset_hasExplicitFormat(configReadable: any, configResult: any) {
  if (!configReadable || !configResult || configResult.ok !== true) {
    return false;
  }
  return Boolean(parseGitConfigSubset(configResult.content.toString('utf8')).objectFormat);
}

// 受限枚举：遍历（路径名）+ 分类元数据（受限根读取）+ git 语义分类。
// 返回候选路径与缺口清单；helper 进程级失败返回 helperFailure 由调用方失败关闭。
function enumerateCaptureTree(targetDir: any, pinnedRoot: any, policy: any, rootHandle: any, capability: any) {
  const excluded = policy && Array.isArray(policy.excludedPatterns) ? policy.excludedPatterns : [];
  const includedIgnored = policy && Array.isArray(policy.includedIgnoredPatterns) ? policy.includedIgnoredPatterns : [];
  const walk = rootHandle.walk(excluded);
  if (!walk.ok) return { helperFailure: walk.reason || 'helper_walk_failed' };
  const metadata = readGitMetadata(targetDir, pinnedRoot, policy, rootHandle, capability, walk.entries, excluded);
  if (metadata.helperFailure) {
    return { helperFailure: metadata.helperFailure };
  }
  const captureEntries = walk.entries.filter((entry: any) => entry.path !== '.git' && !entry.path.endsWith('/.git'));
  const classified = classifyWalkEntries(captureEntries, {
    tracked: metadata.tracked,
    applyIgnore: metadata.applyIgnore,
    gitignoreByDir: metadata.gitignoreByDir,
    globalIgnoreSources: metadata.globalSources,
    isIncludedIgnored: (entryPath: any) => matchesRelativePattern(entryPath, includedIgnored),
  });
  // 用户显式排除（excludedPatterns）不属于缺口；ignore 规则排除同理（git 也不会列出）。
  const inScope = (entryPath: any) => !matchesRelativePattern(entryPath, excluded);
  const candidatePaths = classified.candidates
    .map((entry: any) => entry.path)
    .filter(inScope);
  const uncaptured: any[] = [];
  const seenGaps = new Set<string>();
  const pushGap = (gap: any) => {
    const key = `${gap.reason}:${gap.path}`;
    if (seenGaps.has(key) || !inScope(gap.path)) {
      return;
    }
    seenGaps.add(key);
    uncaptured.push(gap);
  };
  for (const gap of classified.uncaptured) {
    pushGap(gap);
  }
  for (const gap of walk.unreadableDirs) {
    pushGap(gap);
  }
  return {
    helperFailure: '',
    candidatePaths,
    uncaptured,
    gitMetadata: metadata.status,
    gitReasons: metadata.reasons,
    entriesByPath: new Map(walk.entries.map((entry: any) => [entry.path, entry])),
  };
}

function entryStat(info: any) {
  return info && {
    ...info,
    isFile: () => info.type === 'file',
    isSymbolicLink: () => info.type === 'symlink',
  };
}

// 符号链接：只记元数据（linkTarget 供恢复重建）；链接目标绝不跟随读取
// （helper 的 RESOLVE_NO_SYMLINKS 在内核层强制，这里的字符串判定只用于清单记录）。
function resolveSymlink(pinnedRoot: any, relativePath: any, linkAbsolutePath: any, rawTarget: string) {
  if (!rawTarget) return { type: 'symlink', escapes: true, linkTarget: '' };
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

// configSnapshot 必填键与类型。只有具体验证依据的维度才可升级；
// 缺键/空串/类型错误一律 harness_tool_config_unverified。
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
  let cachedCapability: any = null;

  // 能力探测（每次采集前执行；结果缓存于进程内，采集存储变化时由调用方重建 collector）。
  // 失败关闭：ok=false 时采集在扫描用户目录之前拒绝，零目标内容读取。
  function getCapability() {
    if (!cachedCapability) {
      cachedCapability = detectCaptureCapability({ captureRoot: store && store.captureRoot });
    }
    return cachedCapability;
  }

  // 受限批量读取 + 逐文件钩子 + 秘密哨兵 + hash。helper 失败（进程级）返回
  // { helperFailure } 由调用方按 capture_unavailable 失败关闭；单文件失败按 code 分类。
  function constrainedReadBatch(rootHandle: any, relativePaths: string[], targetDir: any, phase: any, attempt: any) {
    const batch = rootHandle.readBatch(relativePaths);
    if (!batch.ok) {
      return { helperFailure: batch.reason || 'helper_failed', reads: new Map() };
    }
    const reads = new Map<string, any>();
    for (const relativePath of relativePaths) {
      const result = batch.results.get(relativePath) || { ok: false, code: 'helper_output_missing' };
      if (typeof options.onFileRead === 'function') {
        options.onFileRead(targetDir, relativePath, phase, attempt, result);
      }
      reads.set(relativePath, result);
    }
    return { helperFailure: '', reads };
  }

  // 扫描：lstat 元数据分类 → 受限批量读取（hash + 秘密检测）。
  // previousFiles 提供 mtime 快速路径（只加速本首扫；二扫永远全量重 hash）。
  function scanFiles(targetDir: any, pinnedRoot: any, policy: any, previousFiles: any, attempt: any, rootHandle: any) {
    const files: any = {};
    const skipped: any[] = [];
    const unstable: any[] = [];
    const stats = {
      hashed: 0, reusedHash: 0, secretExcluded: 0, symlinkEscapes: 0,
      outOfBounds: 0, missing: 0, readUnstable: 0, oversized: 0,
    };
    const enumeration: any = enumerateCaptureTree(targetDir, pinnedRoot, policy, rootHandle, getCapability());
    const uncaptured: any[] = enumeration.uncaptured || [];
    const finish = (helperFailure = '') => ({
      helperFailure, files, skipped, stats, unstable, uncaptured,
      gitMetadata: enumeration.gitMetadata, gitReasons: enumeration.gitReasons || [],
    });
    if (enumeration.helperFailure) return finish(enumeration.helperFailure);
    const candidates = enumeration.candidatePaths;
    const needRead: string[] = [];

    for (const relativePath of candidates) {
      const info: any = enumeration.entriesByPath.get(relativePath);
      const absolutePath = path.join(targetDir, relativePath);
      const stat = entryStat(info);
      if (!stat) {
        stats.missing += 1;
        uncaptured.push({ path: relativePath, reason: 'missing' });
        unstable.push({ path: relativePath, reason: 'missing' });
        continue;
      }
      if (stat.isSymbolicLink()) {
        const link = resolveSymlink(pinnedRoot, relativePath, absolutePath, info.linkTarget);
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
        skipped.push({ path: relativePath, reason: 'special_file' });
        uncaptured.push({ path: relativePath, reason: 'special_file' });
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
      needRead.push(relativePath);
    }

    const { helperFailure, reads } = constrainedReadBatch(rootHandle, needRead, targetDir, 'scan', attempt);
    if (helperFailure) {
      return finish(helperFailure);
    }
    for (const relativePath of needRead) {
      const result = reads.get(relativePath);
      // Same Python-derived milliseconds as walk; ns decoded as a JS number
      // has already lost precision, so dividing it again can differ by 1 ULP.
      const meta = result?.ok === true
        ? { size: result.size, mode: result.mode | 0o100000, mtimeMs: result.mtimeMs }
        : { size: 0, mode: 0, mtimeMs: 0 };
      if (!result || result.ok !== true) {
        const code = result && result.code ? String(result.code) : 'read_failed';
        uncaptured.push({ path: relativePath, reason: code });
        if (code === 'denied') {
          skipped.push({ path: relativePath, reason: code });
          continue;
        }
        if (code === 'missing') {
          stats.missing += 1;
          unstable.push({ path: relativePath, reason: code });
          continue;
        }
        if (code === 'symlink_rejected' || code === 'escapes_root_or_mount') {
          // 枚举-读取窗口内文件被换成链接/越界：不读取、不进清单，按异常触发重试。
          stats.outOfBounds += 1;
          skipped.push({ path: relativePath, reason: code });
          unstable.push({ path: relativePath, reason: code });
          continue;
        }
        if (code === 'not_a_file' || code === 'too_large') {
          if (code === 'too_large') {
            stats.oversized += 1;
          }
          skipped.push({ path: relativePath, reason: code });
          continue;
        }
        // changed_during_read / short_read / 其他：一致性异常，触发重试，不静默跳过。
        stats.readUnstable += 1;
        skipped.push({ path: relativePath, reason: code });
        unstable.push({ path: relativePath, reason: code });
        continue;
      }
      const content = result.content;
      const secretHit = containsSecretSentinel(content);
      const hash = sha256Buffer(content);
      // 秘密命中：不记录内容 hash（低熵秘密的 hash 可被暴力反推），只记录排除事实。
      files[relativePath] = secretHit
        ? { type: 'file', size: meta.size, mode: meta.mode, mtimeMs: meta.mtimeMs, secretExcluded: true }
        : { type: 'file', size: meta.size, mode: meta.mode, mtimeMs: meta.mtimeMs, hash };
      stats.hashed += 1;
      if (secretHit) {
        stats.secretExcluded += 1;
      }
    }

    return finish();
  }

  // 二扫：全量重新受限读取并重 hash，与 M1 逐项比对。
  // 即便 M1==M2 也只是"未检测到变化"——协调写入可让两扫读到从未同时存在的状态，
  // 双扫结果不得兑换严格对照资格（契约 §2.3）。
  function rescanAndDiff(targetDir: any, pinnedRoot: any, policy: any, beforeFiles: any, attempt: any, rootHandle: any, beforeGaps: any[]) {
    const differing: string[] = [];
    const seen = new Set<string>();
    const enumeration: any = enumerateCaptureTree(targetDir, pinnedRoot, policy, rootHandle, getCapability());
    if (enumeration.helperFailure) return { helperFailure: enumeration.helperFailure, differing };
    const candidates = enumeration.candidatePaths;
    const uncaptured: any[] = enumeration.uncaptured;
    const regularPaths: string[] = [];
    const metaByPath = new Map<string, any>();

    for (const relativePath of candidates) {
      seen.add(relativePath);
      const info: any = enumeration.entriesByPath.get(relativePath);
      const absolutePath = path.join(targetDir, relativePath);
      const stat = entryStat(info);
      if (!stat) {
        if (beforeFiles[relativePath]) {
          differing.push(relativePath);
        }
        continue;
      }
      if (stat.isSymbolicLink()) {
        const link = resolveSymlink(pinnedRoot, relativePath, absolutePath, info.linkTarget);
        metaByPath.set(relativePath, link.escapes ? 'link:escapes' : `link:${link.linkTarget}`);
        continue;
      }
      if (!stat.isFile()) {
        metaByPath.set(relativePath, 'other');
        continue;
      }
      regularPaths.push(relativePath);
    }

    const { helperFailure, reads } = constrainedReadBatch(rootHandle, regularPaths, targetDir, 'rescan', attempt);
    if (helperFailure) {
      return { helperFailure, differing };
    }
    for (const relativePath of regularPaths) {
      const result = reads.get(relativePath);
      if (!result || result.ok !== true) {
        const code = result && result.code ? result.code : 'read_failed';
        uncaptured.push({ path: relativePath, reason: code });
        // A stable refusal is still incomplete, but not a content change.
        if (!beforeFiles[relativePath] && beforeGaps.some((gap: any) => gap.path === relativePath && gap.reason === code)) continue;
        metaByPath.set(relativePath, `read-unstable:${code}`);
      } else {
        metaByPath.set(relativePath, containsSecretSentinel(result.content) ? 'secret-excluded' : sha256Buffer(result.content));
      }
    }

    for (const relativePath of candidates) {
      const actual = metaByPath.get(relativePath);
      if (actual === undefined) {
        continue;
      }
      const before = beforeFiles[relativePath];
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
    return { helperFailure: '', differing: differing.sort(), uncaptured, gitReasons: enumeration.gitReasons || [], gitMetadata: enumeration.gitMetadata };
  }

  // session 等树外回放输入的独立授权边界（GPT 复审 #1 第六轮）：
  // 输入文件必须位于策略 authorizedInputPins 固定的某个目录内，且经受限根读取——
  // 不因“属于回放材料”自动获授权，符号链接/越界路径一律拒绝。
  function readAuthorizedReplayInput(sessionAccess: any, inputPath: any) {
    const policy = sessionAccess && sessionAccess.policy;
    const capability = sessionAccess && sessionAccess.capability;
    const pins = policy && policy.authorizedInputPins && typeof policy.authorizedInputPins === 'object'
      ? policy.authorizedInputPins
      : {};
    let real = '';
    try {
      real = fs.realpathSync(String(inputPath || ''));
    } catch {
      return { ok: false, reason: 'session_missing' };
    }
    for (const key of Object.keys(pins)) {
      const pin = (pins as any)[key];
      const pinReal = String(pin && pin.realpath || '').trim();
      if (!pinReal || !isSameOrUnderPathString(pinReal, real)) {
        continue;
      }
      if (!pin.identity || typeof pin.identity !== 'object') {
        return { ok: false, reason: 'session_input_root_unpinned' };
      }
      const handle: any = openConstrainedRoot(capability, pinReal);
      if (!handle.ok) {
        return { ok: false, reason: `session_input_unavailable:${handle.reason}` };
      }
      try {
        if (!handle.identityEquals(pin.identity)) {
          return { ok: false, reason: 'session_input_root_replaced' };
        }
        const relative = path.relative(pinReal, real).replace(/\\/g, '/');
        if (!relative || relative.startsWith('..')) {
          return { ok: false, reason: 'session_not_authorized' };
        }
        const batch = handle.readBatch([relative]);
        if (!batch.ok) {
          return { ok: false, reason: `session_input_unavailable:${batch.reason}` };
        }
        const result = batch.results.get(relative);
        if (!result || result.ok !== true) {
          return { ok: false, reason: `session_read_failed:${result && result.code ? result.code : 'read_failed'}` };
        }
        return { ok: true, reason: '', content: result.content };
      } finally {
        handle.close();
      }
    }
    return { ok: false, reason: 'session_not_authorized' };
  }

  // 回放输入准备（采集循环前一次性完成）：受控变量替换 → 最终字节秘密扫描 →
  // session 维度校验（未验证维度默认 incomplete）→ harness/skill 快照校验。
  function prepareReplayInput(input: any, deliveryMode: any, authorizedRoot: any, sessionAccess: any) {
    const replayInput: any = {
      deliveryMode,
      complete: true,
      incompleteReasons: [] as string[],
      verifiedDimensions: [] as string[],
      unverifiedDimensions: [] as string[],
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

    // Runtime images are distinct from both prompt text and the pre-turn
    // resume session. Until authorized attachment archival is implemented,
    // retain only their count and explicitly block complete replay. Never
    // persist base64 bytes, paths, MIME metadata or hashes via this channel.
    replayInput.invocationImageCount = Array.isArray(input.images) ? input.images.length : 0;
    if (input.images !== undefined && !Array.isArray(input.images)) {
      replayInput.invocationImageCount = null;
      markIncomplete('invocation_images_invalid');
    } else if (replayInput.invocationImageCount > 0) {
      markIncomplete('invocation_images_not_archived');
    }

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
      if (!sessionPath) {
        // 禁止静默降级 fresh：deliveryMode 保持 resume，标记不可完整回放。
        markIncomplete('session_missing');
      } else {
        const access = readAuthorizedReplayInput(sessionAccess, sessionPath);
        if (!access.ok) {
          // 未授权/不可受限读取的 session 不归档（缺失、越界、链接、根替换各有其原因）。
          markIncomplete(access.reason);
        } else {
          const sessionRaw = access.content;
          const sessionReplaced = replaceControlledVariables(sessionRaw.toString('utf8'), input.controlledValues);
        replayInput.controlledReplacements = replayInput.controlledReplacements.concat(sessionReplaced.replacements);
        const sessionBuffer = Buffer.from(sessionReplaced.text, 'utf8');
        const validation = validateSessionV2(sessionReplaced.text, { authorizedRoot });
        replayInput.sessionLineCount = validation.lineCount;
        replayInput.verifiedDimensions = validation.verifiedDimensions;
        replayInput.unverifiedDimensions = validation.unverifiedDimensions;
        if (!validation.ok) {
          // 结构损坏/未验证格式的材料不归档（禁止以未验证材料充当回放输入）。
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
        // 可归档但未验证的维度：complete=false（GPT 复审边界 2/3）。
        for (const dimension of validation.unverifiedDimensions) {
          markIncomplete(dimension);
        }
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
    const harnessInput = input.harness && typeof input.harness === 'object' ? input.harness : {};
    replayInput.harness.serverVersion = String(harnessInput.serverVersion || '').trim();
    if (!replayInput.harness.serverVersion) {
      markIncomplete('harness_config_unverified');
    }
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
      // 跨字段一致性（GPT 复审 #3 第六轮）：非空字段 ≠ 已验证。
      // - piVersion 必须等于本采集器钉住的 harness 版本（session 校验规则、上下文构建
      //   语义都钉在该版本的真实实现上；agent-executor 以 "pi:<version>" 形式上报）。
      // - 声明的 deliveryMode 必须与实际采集模式一致。
      const declaredPiVersion = String((configSnapshot as any).piVersion || '').trim().replace(/^pi:/, '');
      if (declaredPiVersion !== PI_VERSION_PIN) {
        markIncomplete('harness_version_unverified');
      }
      if (String((configSnapshot as any).deliveryMode) !== deliveryMode) {
        markIncomplete('harness_delivery_mode_mismatch');
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
      if (!snap || !String(snap.sha256 || '').trim() || typeof snap.content !== 'string') {
        markIncomplete(`skill_snapshot_missing:${id}`);
      }
    }
    const archivedSkillIds = new Set<string>();
    for (const [id, snap] of snapshotsById) {
      const declaredSha = String(snap.sha256 || '').trim().toLowerCase();
      if (!declaredSha || typeof snap.content !== 'string') {
        continue;
      }
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

    const authorization = authorizeTargetDir(policy, targetDir);
    if (!authorization.ok) {
      return fail(authorization.reason, authorization.dir ? { authorizedDir: authorization.dir } : {});
    }
    const pinnedRoot = String(authorization.resolvedTarget || '').trim();
    if (!pinnedRoot) {
      return fail('authorized_root_unresolved');
    }
    // v1 保守边界：采集目标必须恰为授权根本身（授权动作钉住的是根的目录对象身份；
    // 子目录目标没有独立 pin，无法用 statx 核对 → 拒绝而不是降级为路径信任）。
    const pinRealpath = String(authorization.pin && authorization.pin.realpath || '').trim();
    if (!pinRealpath || !pathsEqual(pinRealpath, pinnedRoot)) {
      return fail('target_must_be_authorized_root', { authorizedDir: authorization.dir });
    }

    // 能力门（GPT 复审 #1 第五轮：能力缺失应在扫描用户目录前返回不可用）。
    // 授权判定只是路径元数据检查，未读取目标内容；win32/darwin v1 不支持受限读取
    // → 拒绝采集，零目标内容读取。
    const capability = getCapability();
    if (!capability.ok) {
      return fail(`capture_unavailable:${capability.reason}`, { platform: capability.platform });
    }

    // 打开受限根：父进程持有根目录 fd（整个采集期间钉住目录对象），
    // statx 身份与授权 pin 比对——跨 turn/重启的根对象替换在此被拒。
    const rootHandle: any = openConstrainedRoot(capability, targetDir);
    if (!rootHandle.ok) {
      return fail(`capture_unavailable:${rootHandle.reason}`);
    }
    try {
      const pinIdentity = authorization.pin && authorization.pin.identity;
      if (!pinIdentity || typeof pinIdentity !== 'object') {
        return fail('authorized_root_identity_missing', { authorizedDir: authorization.dir });
      }
      if (!rootHandle.identityEquals(pinIdentity)) {
        return fail('authorized_root_replaced', { authorizedDir: authorization.dir });
      }

      // 防止采集存储自身被纳入采集范围（递归/自引用）。
      if (!rootHandle.enumerationIntact()) {
        return fail('target_root_replaced', { phase: 'open' });
      }

      const previous = store.loadLatestCheckpoint(projectId, targetDir);
      const previousFiles = previous && previous.files ? previous.files : null;
      const { replayInput, plans } = prepareReplayInput(input, deliveryMode, pinnedRoot, { capability, policy });

      let consistency: any = null;
      let scanResult: any = null;
      let deletions: string[] = [];
      let newBlobBytes = 0;
      let retries = 0;
      let anyAnomaly = false;

      for (let attempt = 0; attempt <= MAX_CONSISTENCY_RETRIES; attempt += 1) {
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

        // 枚举身份校验：路径当前解析到的对象必须仍是持有的根对象。
        if (!rootHandle.enumerationIntact()) {
          rollback();
          return fail('target_root_replaced', { phase: 'before-scan', attempt });
        }
        scanResult = scanFiles(targetDir, pinnedRoot, policy, attempt === 0 ? previousFiles : null, attempt, rootHandle);
        if (scanResult.helperFailure) {
          rollback();
          return fail(`capture_unavailable:${scanResult.helperFailure}`, { phase: 'scan', attempt });
        }

        // 删除状态：相对上一检查点消失的路径。
        const currentPaths = new Set(Object.keys(scanResult.files));
        deletions = previousFiles
          ? Object.keys(previousFiles).filter((name) => !currentPaths.has(name)).sort()
          : [];

        // 测试注入点 A：首扫之后、staging 写入之前。
        if (typeof options.afterScan === 'function') {
          options.afterScan(targetDir, attempt);
        }

        // 配额预检（每个 attempt 都执行，扫描后、任何写盘前）。
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

        // 写 staging：受限重读、重校 hash、重扫秘密哨兵；逐 blob 落盘前按写时实际
        // 字节重新核算配额（硬上限）。越权内容不会到达 helper 输出，更不会到 staging。
        const needWrite = Object.keys(scanResult.files).filter((relativePath) => {
          const entry = scanResult.files[relativePath];
          return entry.type === 'file' && entry.secretExcluded !== true && entry.hash
            && !store.hasBlob(projectId, entry.hash);
        });
        const writeReads = constrainedReadBatch(rootHandle, needWrite, targetDir, 'write', attempt);
        if (writeReads.helperFailure) {
          rollback();
          return fail(`capture_unavailable:${writeReads.helperFailure}`, { phase: 'write', attempt });
        }

        const attemptBaseBytes = usage.totalBytes;
        let attemptWrittenBytes = 0;
        const writeMismatches: string[] = [];
        for (const relativePath of needWrite) {
          const entry = scanResult.files[relativePath];
          if (stagedHashes.has(entry.hash)) {
            continue;
          }
          const result = writeReads.reads.get(relativePath);
          if (!result || result.ok !== true) {
            // 读取不稳定/越界：绝不落 staging，触发重试。
            writeMismatches.push(relativePath);
            scanResult.uncaptured.push({ path: relativePath, reason: result?.code || 'read_failed' });
            delete scanResult.files[relativePath];
            continue;
          }
          const content = result.content;
          if (containsSecretSentinel(content)) {
            // TOCTOU 防线：首扫后注入的秘密绝不落盘；标记排除并触发重试。
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

        // 测试注入点 B：staging 写入之后、二扫之前。
        if (typeof options.afterFirstScan === 'function') {
          options.afterFirstScan(targetDir, attempt);
        }

        const rescan = rescanAndDiff(targetDir, pinnedRoot, policy, scanResult.files, attempt, rootHandle, scanResult.uncaptured);
        if (rescan.helperFailure) {
          rollback();
          return fail(`capture_unavailable:${rescan.helperFailure}`, { phase: 'rescan', attempt });
        }
        scanResult.uncaptured.push(...(rescan.uncaptured || []));
        scanResult.gitReasons.push(...(rescan.gitReasons || []));
        if (rescan.gitMetadata === 'degraded') scanResult.gitMetadata = 'degraded';
        const unstablePaths = Array.isArray(scanResult.unstable) ? scanResult.unstable.map((entry: any) => entry.path) : [];
        const changed = Array.from(new Set([...rescan.differing, ...writeMismatches, ...unstablePaths])).sort();

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

      // Stable exclusions by policy are not gaps; every in-scope failure is.
      const uncaptured: any[] = Array.from(new Map<string, any>(scanResult.uncaptured.map((gap: any) => [`${gap.path}:${gap.reason}`, gap])).values());
      for (const gap of uncaptured) {
        const kind = gap.reason === 'special_file' ? 'special_file_not_captured'
          : gap.reason === 'directory_unreadable' ? 'directory_unreadable' : 'file_unreadable';
        replayInput.incompleteReasons.push(`${kind}:${gap.path}`);
      }
      replayInput.incompleteReasons.push(...scanResult.gitReasons);
      replayInput.incompleteReasons = Array.from(new Set(replayInput.incompleteReasons));
      if (replayInput.incompleteReasons.length > 0) replayInput.complete = false;
      // An inaccessible path (including descendants of an inaccessible directory)
      // is unknown, not a confirmed deletion.
      deletions = deletions.filter((name) => !uncaptured.some((gap: any) => name === gap.path || name.startsWith(`${gap.path}/`) || gap.path === '.'));

      // 内容缺口一律标记回放输入不完整。
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
      if (scanResult.stats.oversized > 0) {
        replayInput.complete = false;
        replayInput.incompleteReasons.push('files_exceed_size_limit');
      }

      // 一致性稳定后写入 prompt/session/skill 计划 blob；每个 blob 落盘前仍按实际
      // 字节重新核算配额。
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
      // v1 没有独立的源现场一致性依据（契约 §2.3）：严格对照资格恒为 false；
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
        uncaptured,
        gitMetadata: scanResult.gitMetadata,
        integrity: {
          algorithm: 'sha256',
          manifestHash: integrityManifestHash,
          knownLimitations: KNOWN_LIMITATIONS.slice(),
          helperSha256: capability.helperSha256 || '',
          platform: capability.platform,
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
          oversizedFiles: scanResult.stats.oversized,
          unreadableFiles: uncaptured.filter((gap: any) => gap.reason !== 'special_file' && gap.reason !== 'directory_unreadable').length,
          durationMs: Date.now() - startedAt,
        },
      };

      // latest 指针的增量字节可预先精确计算。
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

      // 配额终检。
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
    } finally {
      rootHandle.close();
    }
  }

  // Explicit pre-enable preview, NOT pre-authorization. Match capture's pinned
  // root boundary even while disabled; metadata also requires directory consent.
  // No Git/config/content reads and no checkpoint; ignored files may overestimate.
  function estimateTree(targetDir: string, policy: any) {
    const authorization = authorizeTargetDir(policy, targetDir);
    if (!authorization.ok) return { ok: false, reason: authorization.reason };
    const pinnedRoot = String(authorization.resolvedTarget || '').trim();
    if (!pinnedRoot) return { ok: false, reason: 'authorized_root_unresolved' };
    const pinRealpath = String(authorization.pin && authorization.pin.realpath || '').trim();
    if (!pinRealpath || !pathsEqual(pinRealpath, pinnedRoot)) {
      return { ok: false, reason: 'target_must_be_authorized_root' };
    }
    const capability = getCapability();
    if (!capability.ok) return { ok: false, reason: `capture_unavailable:${capability.reason}` };
    const root: any = openConstrainedRoot(capability, targetDir);
    if (!root.ok) return root;
    try {
      const pinIdentity = authorization.pin && authorization.pin.identity;
      if (!pinIdentity || typeof pinIdentity !== 'object') {
        return { ok: false, reason: 'authorized_root_identity_missing' };
      }
      // Compare the identity from the SAME held fd used by walk. Checking just
      // path/realpath (or another fd) would allow an authorization-to-open swap.
      if (!root.identityEquals(pinIdentity)) return { ok: false, reason: 'authorized_root_replaced' };
      if (!root.enumerationIntact()) return { ok: false, reason: 'target_root_replaced' };
      return root.walk(policy.excludedPatterns);
    } finally { root.close(); }
  }

  return { captureTurnCheckpoint(input: any = {}) {
    const projectId = String(input.projectId || '').trim();
    if (!store?.captureRoot || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return captureTurnCheckpoint(input);
    try { return withProjectWriteLock(store.captureRoot, projectId, () => captureTurnCheckpoint(input)); }
    catch (error: any) {
      if (error?.code === 'capture_writer_busy') return { captured: false, checkpointId: '', reason: 'capture_writer_busy', durationMs: 0 };
      throw error;
    }
  }, scanFiles, estimateTree };
}
