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

export function defaultCapturePolicy(projectId: any) {
  return {
    projectId: String(projectId || '').trim(),
    status: 'disabled',
    authorizedDirs: [] as string[],
    includedIgnoredPatterns: [] as string[],
    secretAllowlistPatterns: [] as string[],
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
    includedIgnoredPatterns: normalizePatternList(source.includedIgnoredPatterns, []),
    // 已知假阳性路径的显式秘密豁免（默认空）。命中的文件照常归档内容并在清单中
    // 记录 secretAllowlisted 审计标记；配置方自行承担豁免风险。
    secretAllowlistPatterns: normalizePatternList(source.secretAllowlistPatterns, []),
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
  if (isSamePath(root, target)) {
    return true;
  }
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
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
