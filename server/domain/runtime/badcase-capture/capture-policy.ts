// CapturePolicy：项目级 badcase 采集授权（契约 §1/§2.1/§3）。
//
// - 默认 disabled：未显式开启的项目不做任何扫描。
// - authorizedDirs：仅这些目录（及子目录）允许采集；目标目录不在清单内时不采集。
// - excludedPatterns / includedIgnoredPatterns：相对授权目录的路径模式（** 后缀表前缀匹配）。

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STAGING_RETENTION_DAYS = 7;
const DEFAULT_STAGING_QUOTA_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB，可配置初值（Goal P1）

// 默认排除：体积大且可由其他方式重建的目录。 ignored 文件默认不采集，
// 须通过 includedIgnoredPatterns 显式纳入（契约 §2.2）。
const DEFAULT_EXCLUDED_PATTERNS = [
  '.git',
  'node_modules',
];

function normalizeDirList(value: any) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of list) {
    const resolved = path.resolve(String(entry || '').trim());
    if (!resolved || seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function normalizePatternList(value: any, fallback: any) {
  if (!Array.isArray(value)) {
    return fallback.slice();
  }
  return value
    .map((entry: any) => String(entry || '').trim().replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
}

function normalizePositiveInteger(value: any, fallback: any) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

// 授权目录 pin 表的 key（Windows 不区分大小写）。
export function pinKey(dir: any) {
  const resolved = path.resolve(String(dir || '').trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeDirPins(value: any) {
  const pins: Record<string, string> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, pinned] of Object.entries(value)) {
      const normalizedKey = pinKey(key);
      const pinnedValue = String(pinned || '').trim();
      if (normalizedKey && pinnedValue) {
        pins[normalizedKey] = pinnedValue;
      }
    }
  }
  return pins;
}

// 保存（授权）策略时固定授权根身份：把每个授权目录解析为真实路径并持久化。
// 解析失败（目录不存在等）记为空串——normalize 会丢弃空 pin，该根在采集时按
// authorized_root_unpinned 拒绝（失败关闭，不回退为采集时现场解析）。
export function pinAuthorizedDirs(policy: any) {
  const source = policy && typeof policy === 'object' ? policy : {};
  const pins: Record<string, string> = {};
  const dirs = Array.isArray(source.authorizedDirs) ? source.authorizedDirs : [];
  for (const dir of dirs) {
    const raw = String(dir || '').trim();
    if (!raw) {
      continue;
    }
    try {
      pins[pinKey(raw)] = fs.realpathSync(path.resolve(raw));
    } catch {
      pins[pinKey(raw)] = '';
    }
  }
  return { ...source, authorizedDirPins: pins };
}

export function defaultCapturePolicy(projectId: any) {
  return {
    projectId: String(projectId || '').trim(),
    status: 'disabled',
    authorizedDirs: [] as string[],
    // 授权根身份固定（GPT 复审 #1）：保存策略时把每个授权目录解析为真实路径并固定。
    // 采集时若当前 realpath 与固定值不符（根被替换成 junction/symlink），拒绝采集，
    // 不得跟着新目标继续。map key 为 pinKey(dir)。
    authorizedDirPins: {} as Record<string, string>,
    includedIgnoredPatterns: [] as string[],
    // 注意：本阶段不提供秘密豁免机制（secretAllowlistPatterns 已移除）。命中哨兵一律排除；
    // 已知假阳性路径只能用 excludedPatterns 整体排除，或经评审修订哨兵模式集。
    excludedPatterns: DEFAULT_EXCLUDED_PATTERNS.slice(),
    stagingRetentionDays: DEFAULT_STAGING_RETENTION_DAYS,
    stagingQuotaBytes: DEFAULT_STAGING_QUOTA_BYTES,
    suspendReason: '',
    updatedAt: '',
  };
}

export function normalizeCapturePolicy(raw: any, projectId: any) {
  const base = defaultCapturePolicy(projectId);
  const source = raw && typeof raw === 'object' ? raw : {};
  const status = ['disabled', 'enabled', 'suspended'].includes(String(source.status || '').trim())
    ? String(source.status).trim()
    : (source.enabled === true ? 'enabled' : base.status);
  return {
    projectId: String(source.projectId || projectId || '').trim(),
    status,
    authorizedDirs: normalizeDirList(source.authorizedDirs),
    authorizedDirPins: normalizeDirPins(source.authorizedDirPins),
    includedIgnoredPatterns: normalizePatternList(source.includedIgnoredPatterns, []),
    // secretAllowlistPatterns 已移除：即使调用方传入也不保留、不生效（GPT 复审 #6）。
    excludedPatterns: normalizePatternList(source.excludedPatterns, DEFAULT_EXCLUDED_PATTERNS),
    stagingRetentionDays: normalizePositiveInteger(source.stagingRetentionDays, DEFAULT_STAGING_RETENTION_DAYS),
    stagingQuotaBytes: normalizePositiveInteger(source.stagingQuotaBytes, DEFAULT_STAGING_QUOTA_BYTES),
    suspendReason: String(source.suspendReason || '').trim(),
    updatedAt: String(source.updatedAt || '').trim(),
  };
}

function isSamePath(left: any, right: any) {
  const a = path.resolve(String(left || '').trim());
  const b = path.resolve(String(right || '').trim());
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// 导出的路径相等判定（Windows 不区分大小写），用于采集期间校验授权根身份未被替换。
export function pathsEqual(left: any, right: any) {
  return isSamePath(left, right);
}

// 解析真实路径（穿透 junction/symlink）；路径不存在时回退为字符串 resolve。
// 授权判定必须基于真实路径，否则授权目录内的 junction/符号链接可用字符串前缀绕过边界。
export function realpathOrResolved(target: any) {
  const resolved = path.resolve(String(target || '').trim());
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// 目标目录是否命中授权清单（自身或任一授权目录的子路径）。
// 两侧都先穿透 junction/symlink 到真实路径再比较，防止链接路径用字符串前缀冒充界内。
export function isAuthorizedDir(policy: any, targetDir: any) {
  const resolved = realpathOrResolved(targetDir);
  if (!resolved) {
    return false;
  }
  const dirs = Array.isArray(policy && policy.authorizedDirs) ? policy.authorizedDirs : [];
  return dirs.some((dir: any) => {
    const authorized = realpathOrResolved(dir);
    if (!authorized) {
      return false;
    }
    if (isSamePath(resolved, authorized)) {
      return true;
    }
    const relative = path.relative(authorized, resolved);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

// 单个文件的真实路径是否位于授权根的真实路径之内（采集读文件前的逐文件边界校验）。
export function isPathWithinRoot(rootDir: any, targetPath: any) {
  const root = realpathOrResolved(rootDir);
  const target = realpathOrResolved(targetPath);
  return isSameOrUnderPath(root, target);
}

// 纯字符串的 "相等或位于其下" 判定（Windows 不区分大小写），不做任何文件系统解析。
function isSameOrUnderPath(root: any, target: any) {
  let rootPath = String(root || '').trim();
  let targetPathStr = String(target || '').trim();
  if (!rootPath || !targetPathStr) {
    return false;
  }
  if (process.platform === 'win32') {
    rootPath = rootPath.toLowerCase();
    targetPathStr = targetPathStr.toLowerCase();
  }
  if (rootPath === targetPathStr) {
    return true;
  }
  const relative = path.relative(rootPath, targetPathStr);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// 目标路径是否位于“已固定真实路径”的根之内。只解析目标，不重新解析根：
// 采集窗口内根路径被替换成 junction/symlink 时，比较基准不得跟着链接移动（GPT 复审 #1）。
export function isPathWithinPinnedRoot(pinnedRootRealPath: any, targetPath: any) {
  const root = String(pinnedRootRealPath || '').trim();
  if (!root) {
    return false;
  }
  return isSameOrUnderPath(root, realpathOrResolved(targetPath));
}

// 对已解析路径做纯字符串界内判定（fd 绑定读取协议用：realpath 只做一次，
// 避免“检查一次、打开前再解析一次”的双解析窗口）。
export function isSameOrUnderPathString(pinnedRootRealPath: any, resolvedTargetPath: any) {
  const root = String(pinnedRootRealPath || '').trim();
  if (!root) {
    return false;
  }
  return isSameOrUnderPath(root, resolvedTargetPath);
}

// 授权判定 + 授权根身份校验（GPT 复审 #1）。
// - 边界比较基于保存策略时固定的真实路径（authorizedDirPins），不重新跟随根；
// - 授权后根被替换（realpath 与 pin 不符）→ authorized_root_replaced；
// - 缺 pin（未经过授权保存流程的策略）→ authorized_root_unpinned，失败关闭；
// - 目标经链接越出已固定根 → dir_not_authorized。
export function authorizeTargetDir(policy: any, targetDir: any) {
  const resolvedTarget = realpathOrResolved(targetDir);
  const stringTarget = path.resolve(String(targetDir || '').trim());
  const dirs = Array.isArray(policy && policy.authorizedDirs) ? policy.authorizedDirs : [];
  const pins = policy && policy.authorizedDirPins && typeof policy.authorizedDirPins === 'object'
    ? policy.authorizedDirPins
    : {};
  for (const dir of dirs) {
    const raw = String(dir || '').trim();
    if (!raw) {
      continue;
    }
    const rawResolved = path.resolve(raw);
    const pinned = String((pins as any)[pinKey(raw)] || '').trim();
    // 字符串包含（未解析）用于定位“目标名义上命中的授权根”，真实包含用于边界判定。
    const stringContained = isSameOrUnderPath(rawResolved, stringTarget);
    const baseline = pinned || realpathOrResolved(raw);
    const realContained = isSameOrUnderPath(baseline, resolvedTarget);
    if (!stringContained && !realContained) {
      continue;
    }
    if (!pinned) {
      return { ok: false, reason: 'authorized_root_unpinned', dir: rawResolved };
    }
    if (!pathsEqual(realpathOrResolved(raw), pinned)) {
      return { ok: false, reason: 'authorized_root_replaced', dir: rawResolved };
    }
    if (realContained) {
      // 返回本次验证过的目标真实路径：调用方必须直接把它作为 pinnedRoot 使用，
      // 不得二次 realpath（授权结论与使用之间的二次解析是 pin 竞态入口，GPT 复审 #1）。
      return { ok: true, reason: '', resolvedTarget };
    }
    // 字符串命中但真实路径越界（目标是根内的链接路径指向外部）：继续检查其余根，
    // 最终按 dir_not_authorized 拒绝。
  }
  return { ok: false, reason: 'dir_not_authorized' };
}

// 简单路径模式匹配：精确相等，或以 "pattern/" 为前缀；末尾的 ** 或 * 后缀表示前缀匹配。
// 模式相对授权目录根。
export function matchesRelativePattern(relativePath: any, patterns: any) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    return false;
  }
  const list = Array.isArray(patterns) ? patterns : [];
  return list.some((pattern: any) => {
    let p = String(pattern || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!p) {
      return false;
    }
    p = p.replace(/\/(\*\*|\*)$/g, '');
    if (!p) {
      return false;
    }
    return normalized === p || normalized.startsWith(`${p}/`);
  });
}

export const CAPTURE_POLICY_DEFAULTS = {
  stagingRetentionDays: DEFAULT_STAGING_RETENTION_DAYS,
  stagingQuotaBytes: DEFAULT_STAGING_QUOTA_BYTES,
  excludedPatterns: DEFAULT_EXCLUDED_PATTERNS.slice(),
};
