// 受限读取（契约 §2.3，GPT 复审 #1 第五轮设计）：
//
// 授权不绑定路径名，绑定"已打开的目录对象"：父进程持有授权根目录 fd，子进程
// helper 用 openat2(rootfd, relpath, …) 让内核在该对象子树内原子完成路径解析
// （RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV）。
// 路径改名/替换/ABA 时序与结论无关——fd 指向的对象不因名字变化而变化。
//
// 职责分层（互不冒充）：
// - openat2 限制域：解决"是否授权"（身份，内核强制）；
// - helper 内同 fd 前后 fstat：解决"读取期间是否变化"（一致性检测）；
// - staging + 原子提交（capture-store）：只负责崩溃卫生。
//
// 平台支持：
// - linux：内核 >= 5.6（openat2）+ python3（ctypes 直调 syscall，无编译依赖）。
//   helper 源码内嵌于 helper-source.ts（与 helpers/badcase-capture/capture_helper.py
//   一致，embed-helper.js 生成），运行时写入采集存储内的受信位置并逐字节校验
//   SHA-256；被采集 agent 对采集存储无写权限是部署前提。
// - win32 / darwin / 其他：v1 不支持。受限逐级相对打开在 win32 需要 NtCreateFile +
//   RootDirectory + OBJ_DONT_REPARSE（Win32 无等价物），本阶段无法证明正确性，
//   能力探测直接失败 → 采集拒绝，且在扫描用户目录之前返回（零目标内容读取）。
//
// 能力自检在采集存储根内的隔离探针目录进行（gitignored、目标树之外），绝不向
// 用户项目写临时文件。自检失败 → 策略级 capture_unavailable，无回退读取路径。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
import { HELPER_SOURCE, HELPER_SOURCE_SHA256 } from './helper-source';

const MIN_KERNEL_MAJOR = 5;
const MIN_KERNEL_MINOR = 6;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 10 * 60 * 1000;

function parseKernelRelease(release: any) {
  const match = String(release || '').match(/^(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function kernelSupportsOpenat2() {
  const parsed = parseKernelRelease(os.release());
  if (!parsed) {
    return false;
  }
  return parsed.major > MIN_KERNEL_MAJOR
    || (parsed.major === MIN_KERNEL_MAJOR && parsed.minor >= MIN_KERNEL_MINOR);
}

function findPython() {
  for (const candidate of ['python3', 'python']) {
    try {
      const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000 });
      if (!result.error && result.status === 0) {
        return candidate;
      }
    } catch {}
  }
  return '';
}

// 手写 mkdir -p：Node 的 recursive mkdir 在 procfs 等伪文件系统上可能长时间阻塞，
// 能力路径必须快速失败。
function mkdirpSafe(dir: any) {
  const resolved = path.resolve(String(dir || ''));
  const parts = resolved.split(path.sep);
  let current = resolved.startsWith(path.sep) ? path.sep : parts.shift() || '';
  for (const part of parts) {
    if (!part) {
      continue;
    }
    current = current === path.sep ? `${path.sep}${part}` : path.join(current, part);
    try {
      const stat = fs.statSync(current);
      if (!stat.isDirectory()) {
        throw new Error('not_a_directory');
      }
      continue;
    } catch (error: any) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
    fs.mkdirSync(current);
  }
}

// helper 落盘位置：采集存储内的受信缓存。每次使用前逐字节校验 SHA-256，
// 与内嵌源码不一致即重写；写入失败即能力不可用（无回退读取）。
function ensureHelperInstalled(captureRoot: any) {
  const dir = path.join(String(captureRoot || ''), 'helper');
  const helperPath = path.join(dir, `capture_helper.${HELPER_SOURCE_SHA256.slice(0, 16)}.py`);
  const verify = () => {
    try {
      const onDisk = fs.readFileSync(helperPath, 'utf8');
      return crypto.createHash('sha256').update(onDisk, 'utf8').digest('hex') === HELPER_SOURCE_SHA256;
    } catch {
      return false;
    }
  };
  if (!verify()) {
    try {
      mkdirpSafe(dir);
      const tmpPath = `${helperPath}.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmpPath, HELPER_SOURCE, { encoding: 'utf8', mode: 0o755 });
      fs.renameSync(tmpPath, helperPath);
    } catch {
      return { ok: false, reason: 'helper_install_failed' };
    }
    if (!verify()) {
      return { ok: false, reason: 'helper_integrity_failed' };
    }
  }
  return { ok: true, helperPath, sourceSha256: HELPER_SOURCE_SHA256 };
}

// 根目录 fd 经 stdio 数组第 4 项传入子进程，子进程内固定为 fd 3。
const CHILD_ROOT_FD = 3;

function spawnHelper(python: any, helperPath: any, rootFd: any, requests: any[], timeoutMs: any) {
  const input = Buffer.from(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n{"op":"end"}\n`, 'utf8');
  return spawnSync(python, [helperPath, String(CHILD_ROOT_FD)], {
    input,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 1024,
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe', rootFd],
  });
}

// 解析 helper 输出：JSON 头行 + （read 成功时）紧随的 size 字节内容与换行。
function parseHelperOutput(stdout: any, requests: any[]) {
  const results: any[] = [];
  let offset = 0;
  const readLine = () => {
    const end = stdout.indexOf(0x0a, offset);
    if (end < 0) {
      return null;
    }
    const line = stdout.slice(offset, end).toString('utf8');
    offset = end + 1;
    return line;
  };
  while (offset < stdout.length) {
    const line = readLine();
    if (line === null || !line.trim()) {
      break;
    }
    let header: any;
    try {
      header = JSON.parse(line);
    } catch {
      return { ok: false, reason: 'helper_output_corrupt', results };
    }
    if (header.ok === true && Number.isInteger(header.size) && Object.prototype.hasOwnProperty.call(header, 'sha256')) {
      const size = Number(header.size);
      if (offset + size + 1 > stdout.length) {
        return { ok: false, reason: 'helper_output_truncated', results };
      }
      const content = stdout.slice(offset, offset + size);
      offset += size + 1; // 跳过结尾换行
      results.push({ ...header, content });
    } else {
      results.push(header);
    }
  }
  return { ok: true, results };
}

export type Capability = {
  ok: boolean;
  platform: string;
  reason: string;
  python?: string;
  helperPath?: string;
  helperSha256?: string;
  kernelRelease?: string;
};

// 能力探测 + 自检。probeRoot 必须指向采集存储内的隔离目录（目标树之外）。
// 失败关闭：返回 ok:false 时调用方必须在扫描用户目录之前拒绝采集。
export function detectCaptureCapability(options: any = {}): Capability {
  const platform = process.platform;
  if (platform !== 'linux') {
    // win32/darwin v1 不支持：受限逐级相对打开需要 NT 内核原语，本阶段无法证明
    // 正确性。明确拒绝，不做尽力读取，不扫描目标目录。
    return { ok: false, platform, reason: `safe_read_capability_missing:${platform}` };
  }
  if (!kernelSupportsOpenat2()) {
    return { ok: false, platform, reason: 'safe_read_capability_missing:kernel_lt_5.6', kernelRelease: os.release() };
  }
  const python = findPython();
  if (!python) {
    return { ok: false, platform, reason: 'safe_read_capability_missing:python3' };
  }
  const captureRoot = String(options.captureRoot || '').trim();
  if (!captureRoot) {
    return { ok: false, platform, reason: 'safe_read_capability_missing:capture_root' };
  }
  const installed = ensureHelperInstalled(captureRoot);
  if (!installed.ok) {
    return { ok: false, platform, reason: `safe_read_capability_missing:${installed.reason}` };
  }

  // 隔离自检：探针目录位于采集存储内（gitignored、目标树之外），绝不写入用户项目。
  // Async management children may probe concurrently with each other or a
  // capture. Never delete another invocation's probe/fds out from under it.
  const probeRoot = path.join(captureRoot, `capability-probe-${crypto.randomUUID()}`);
  try {
    mkdirpSafe(path.join(probeRoot, 'sub'));
    fs.writeFileSync(path.join(probeRoot, 'sub', 'known.txt'), 'badcase-capture-probe\n');
    try {
      fs.symlinkSync('/etc/hostname', path.join(probeRoot, 'escape-link'));
    } catch {}
    const probeFd = fs.openSync(probeRoot, 'r');
    try {
      // 1) statx 必须支持 btime（跨重启根身份钉住依赖它）。
      const identity = spawnHelper(python, installed.helperPath, probeFd, [{ op: 'statx_root' }], 30000);
      const parsedIdentity = identity.status === 0 ? parseHelperOutput(identity.stdout, []) : null;
      const statxResult = parsedIdentity && parsedIdentity.ok ? parsedIdentity.results[0] : null;
      if (!statxResult || statxResult.ok !== true) {
        return { ok: false, platform, reason: 'safe_read_capability_missing:statx_failed' };
      }
      if (statxResult.btimeSupported !== true) {
        return { ok: false, platform, reason: 'safe_read_capability_missing:btime_unsupported' };
      }
      // 2) 普通文件读取内容必须逐字节正确。
      // 3) 符号链接必须被内核拒绝（RESOLVE_NO_SYMLINKS）。
      // 4) ".." 逃逸必须被内核拒绝（RESOLVE_BENEATH）。
      const reads = spawnHelper(python, installed.helperPath, probeFd, [
        { op: 'read', path: 'sub/known.txt', maxBytes: MAX_FILE_BYTES },
        { op: 'read', path: 'escape-link', maxBytes: MAX_FILE_BYTES },
        { op: 'read', path: 'sub/../../etc/hostname', maxBytes: MAX_FILE_BYTES },
      ], 30000);
      if (reads.status !== 0) {
        return { ok: false, platform, reason: 'safe_read_capability_missing:helper_probe_failed' };
      }
      const parsed = parseHelperOutput(reads.stdout, []);
      if (!parsed.ok || parsed.results.length !== 3) {
        return { ok: false, platform, reason: 'safe_read_capability_missing:helper_probe_failed' };
      }
      const [known, escapeLink, dotdot] = parsed.results;
      if (known.ok !== true || known.content.toString('utf8') !== 'badcase-capture-probe\n') {
        return { ok: false, platform, reason: 'safe_read_capability_missing:read_integrity' };
      }
      if (escapeLink.ok !== false || escapeLink.code !== 'symlink_rejected') {
        return { ok: false, platform, reason: 'safe_read_capability_missing:symlink_not_rejected' };
      }
      if (dotdot.ok !== false || dotdot.code !== 'escapes_root_or_mount') {
        return { ok: false, platform, reason: 'safe_read_capability_missing:beneath_not_enforced' };
      }
    } finally {
      try { fs.closeSync(probeFd); } catch {}
    }
  } catch (error: any) {
    const detail = error && error.message ? String(error.message).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120) : 'unknown';
    return { ok: false, platform, reason: `safe_read_capability_missing:probe_error:${detail}` };
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
  return {
    ok: true,
    platform,
    reason: '',
    python,
    helperPath: installed.helperPath,
    helperSha256: HELPER_SOURCE_SHA256,
    kernelRelease: os.release(),
  };
}

export type RootIdentity = {
  devMajor: number;
  devMinor: number;
  ino: number;
  btimeSec: number;
  btimeNsec: number;
};

function identityEquals(left: any, right: any) {
  return Boolean(left && right)
    && Number(left.devMajor) === Number(right.devMajor)
    && Number(left.devMinor) === Number(right.devMinor)
    && Number(left.ino) === Number(right.ino)
    && Number(left.btimeSec) === Number(right.btimeSec)
    && Number(left.btimeNsec) === Number(right.btimeNsec);
}

// 在已持有的目录 fd 上查询 statx 身份（不重新按路径打开）。
// 身份查询与内容读取必须绑定同一个已打开对象（GPT 复审 #1 第六轮）：
// 打开一次、按路径再开一次会给“两次打开之间换根”留下确定性窗口。
function statxRootIdentityOnFd(capability: Capability, fd: any): { ok: boolean; identity?: RootIdentity; reason?: string } {
  const result = spawnHelper(String(capability.python), String(capability.helperPath), fd, [{ op: 'statx_root' }], 30000);
  if (result.status !== 0) {
    return { ok: false, reason: 'statx_failed' };
  }
  const parsed = parseHelperOutput(result.stdout, []);
  const statx = parsed.ok ? parsed.results[0] : null;
  if (!statx || statx.ok !== true || statx.btimeSupported !== true) {
    return { ok: false, reason: 'statx_failed' };
  }
  return {
    ok: true,
    identity: {
      devMajor: statx.devMajor,
      devMinor: statx.devMinor,
      ino: statx.ino,
      btimeSec: statx.btimeSec,
      btimeNsec: statx.btimeNsec,
    },
  };
}

// 查询任意目录的 statx 身份（授权动作钉 pin 用）。打开目录 fd → 同一 fd 上 statx → 关闭。
export function statxDirectoryIdentity(capability: Capability, dir: any): { ok: boolean; identity?: RootIdentity; reason?: string } {
  if (!capability.ok) {
    return { ok: false, reason: capability.reason || 'capability_unavailable' };
  }
  let fd = -1;
  try {
    fd = fs.openSync(path.resolve(String(dir || '')), 'r');
  } catch {
    return { ok: false, reason: 'open_failed' };
  }
  try {
    return statxRootIdentityOnFd(capability, fd);
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// 打开受限根：父进程持有根目录 fd（整个采集期间不关闭，钉住目录对象），
// 之后所有目标树内容读取都以该对象为基准经 openat2 完成。
export function openConstrainedRoot(capability: Capability, rootDir: any) {
  if (!capability.ok) {
    return { ok: false, reason: capability.reason || 'capability_unavailable' };
  }
  const resolved = path.resolve(String(rootDir || ''));
  let fd = -1;
  try {
    fd = fs.openSync(resolved, 'r');
  } catch {
    return { ok: false, reason: 'root_open_failed' };
  }
  // statx 必须在已持有的同一个 fd 上完成：禁止按路径二次打开（GPT 复审 #1 第六轮
  // 探针：第一次 open 持有外部根、第二次 open 取得授权根 → 身份比对被骗过）。
  const identityResult = statxRootIdentityOnFd(capability, fd);
  if (!identityResult.ok) {
    try { fs.closeSync(fd); } catch {}
    return { ok: false, reason: identityResult.reason || 'statx_failed' };
  }
  const identity = identityResult.identity;

  const python = String(capability.python);
  const helperPath = String(capability.helperPath);

  function close() {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch {}
      fd = -1;
    }
  }

  // 枚举身份校验：枚举（git ls-files / readdir）按路径名进行，读取按 fd 进行。
  // 枚举前确认"路径当前解析到的对象"与"持有的根对象"一致（dev+ino），不一致即
  // 根已被替换 → 拒绝本轮，绝不在错误树上枚举。枚举后的每次读取仍由内核限制域
  // 约束到持有的对象：即便枚举后被换树，读到的仍是已授权对象或读取失败触发重试。
  function enumerationIntact() {
    try {
      const named = fs.statSync(resolved);
      const held = fs.fstatSync(fd);
      return named.dev === held.dev && named.ino === held.ino;
    } catch {
      return false;
    }
  }

  // 批量受限读取：单次 helper 进程处理整批路径（避免每文件一次进程启动）。
  // 返回 Map<relPath, {ok, content?, size?, mode?, mtimeNs?, sha256?, code?}>。
  function readBatch(relativePaths: string[]) {
    const results = new Map<string, any>();
    if (relativePaths.length === 0) {
      return { ok: true, results };
    }
    const requests = relativePaths.map((rel) => ({ op: 'read', path: rel, maxBytes: MAX_FILE_BYTES }));
    const spawned = spawnHelper(python, helperPath, fd, requests, HELPER_TIMEOUT_MS);
    if (spawned.error || spawned.status !== 0) {
      return {
        ok: false,
        reason: spawned.error && (spawned.error as any).code === 'ETIMEDOUT' ? 'helper_timeout' : 'helper_failed',
        results,
      };
    }
    const parsed = parseHelperOutput(spawned.stdout, requests);
    if (!parsed.ok || parsed.results.length !== relativePaths.length) {
      return { ok: false, reason: parsed.ok ? 'helper_output_mismatch' : String(parsed.reason || 'helper_output_corrupt'), results };
    }
    for (let index = 0; index < relativePaths.length; index += 1) {
      results.set(relativePaths[index], parsed.results[index]);
    }
    return { ok: true, results };
  }

  function walk(patterns: string[] = []) {
    // Same prefix-only policy grammar as matchesRelativePattern (not Git globs).
    const excluded = patterns.map((p) => String(p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/(\*\*|\*)$/g, '')).filter(Boolean);
    const spawned = spawnHelper(python, helperPath, fd, [{ op: 'walk', excluded }], HELPER_TIMEOUT_MS);
    if (spawned.error || spawned.status !== 0) return { ok: false, reason: 'helper_walk_failed' };
    const parsed = parseHelperOutput(spawned.stdout, []);
    const result = parsed.ok && parsed.results.length === 1 ? parsed.results[0] : null;
    if (!result || result.ok !== true || !Array.isArray(result.entries) || !Array.isArray(result.unreadableDirs)) {
      return { ok: false, reason: result?.code || 'helper_walk_invalid' };
    }
    return result;
  }

  return {
    ok: true,
    rootDir: resolved,
    identity,
    identityEquals: (other: any) => identityEquals(identity, other),
    enumerationIntact,
    readBatch,
    walk,
    close,
  };
}

export const SAFE_READ_LIMITS = {
  maxFileBytes: MAX_FILE_BYTES,
  helperTimeoutMs: HELPER_TIMEOUT_MS,
};
