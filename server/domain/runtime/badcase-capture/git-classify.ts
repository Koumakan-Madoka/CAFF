// git-classify：采集路径的 Git 分类语义内置实现（契约 §2.2，GPT 复审 #1 第七轮）。
//
// 背景：采集路径不得执行 git——命令行 -c 黑名单只能禁止 git **执行**仓库指定程序，
// 不能禁止 git **读取**未授权内容（include.path / info/exclude 符号链接指向树外）。
// 因此 tracked/untracked/ignored 分类由本模块复现：
// - .git/index 解析（v2/v3/v4，sha1/sha256，严格扩展走查；损坏即失败关闭 → 降级多采）；
// - .gitignore 模式语法（注释/否定/目录限定/锚定/**/字符类/转义）与优先级链
//   （深层覆盖浅层、同文件后命中覆盖先命中、已忽略目录不深入）；
// - .git/config 最小子集（extensions.objectformat → index 哈希长度、core.excludesFile、
//   include 检测——include 目标不读取，只降级标记）。
//
// 所有元数据字节由调用方经受限根读取后传入；本模块本身不做任何文件系统访问。
// 语义与真实 git ls-files -c -o --exclude-standard 的差集对照见
// tests/runtime/badcase-capture-safe-read.test.js S14e。

// ---------------- gitignore 模式 ----------------

function escapeRegExpChar(ch: any) {
  return String(ch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 去掉未被反斜杠转义的行尾空格（gitignore 语义）。
function stripTrailingSpaces(line: any) {
  let out = String(line);
  while (out.endsWith(' ') && !out.endsWith('\\ ')) {
    out = out.slice(0, -1);
  }
  return out;
}

// Compile only one-byte predicates to RegExp. '*' is evaluated by dynamic
// programming, never by an untrusted backtracking regexp (e.g. '*a' repeated).
function compileSegment(text: string) {
  const tokens: Array<RegExp | null> = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '*') {
      if (tokens.length === 0 || tokens[tokens.length - 1] !== null) tokens.push(null);
    } else if (ch === '\\' && i + 1 < text.length) {
      tokens.push(new RegExp(`^${escapeRegExpChar(text[++i])}$`));
    } else if (ch === '?') {
      tokens.push(/^[^/]$/);
    } else if (ch === '[' && text.indexOf(']', i + 1) > i + 1) {
      const end = text.indexOf(']', i + 1);
      const cls = text.slice(i + 1, end);
      tokens.push(new RegExp(`^(?!/)[${cls.startsWith('!') ? '^' + cls.slice(1) : cls}]$`));
      i = end;
    } else {
      tokens.push(new RegExp(`^${escapeRegExpChar(ch)}$`));
    }
  }
  return (candidate: string) => {
    let reachable = new Uint8Array(candidate.length + 1);
    reachable[0] = 1;
    for (const token of tokens) {
      const next = new Uint8Array(candidate.length + 1);
      if (token === null) {
        let active = 0;
        for (let j = 0; j <= candidate.length; j += 1) {
          active |= reachable[j];
          next[j] = active;
        }
      } else {
        for (let j = 0; j < candidate.length; j += 1) {
          if (reachable[j] && token.test(candidate[j])) next[j + 1] = 1;
        }
      }
      reachable = next;
    }
    return reachable[candidate.length] === 1;
  };
}

// The outer DP handles whole-segment '**'. Trailing '/**' requires at least
// one child; internal/leading '**/' can match zero segments. Git wildmatch
// uses UTF-8 bytes, not JS UTF-16 code units (e.g. '?' must not consume 'é').
function compileAnchoredPattern(pattern: string) {
  const parts = Buffer.from(pattern, 'utf8').toString('latin1').split('/');
  const matchers = parts.map((part: string) => part === '**' ? null : compileSegment(part));
  return { test(candidate: string) {
    const segments = candidate.split('/');
    let reachable = new Uint8Array(segments.length + 1);
    reachable[0] = 1;
    for (let i = 0; i < matchers.length; i += 1) {
      const matcher = matchers[i];
      const next = new Uint8Array(segments.length + 1);
      if (matcher === null) {
        const min = i === matchers.length - 1 && i > 0 ? 1 : 0;
        let active = 0;
        for (let j = min; j <= segments.length; j += 1) {
          active |= reachable[j - min];
          next[j] = active;
        }
      } else {
        for (let j = 0; j < segments.length; j += 1) {
          if (reachable[j] && matcher(segments[j])) next[j + 1] = 1;
        }
      }
      reachable = next;
    }
    return reachable[segments.length] === 1;
  } };
}

export type GitignoreRule = {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: any;
  source: string;
};

// 解析 .gitignore / info/exclude / excludesFile 文本为规则数组（顺序保留，
// 同文件内后命中覆盖先命中）。
export function parseGitignoreRules(text: any): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  // This is a deliberately bounded subset, not a replacement for Git wildmatch.
  // Caller must downgrade classification if any rule cannot be verified.
  (rules as any).verified = true;
  const lines = String(text || '').split('\n');
  // Bound parser allocations as well as matcher complexity on untrusted input.
  if (lines.length > 4096 || lines.some((line: string) => Buffer.byteLength(line) > 4096)) {
    (rules as any).verified = false;
    return rules;
  }
  for (const rawLine of lines) {
    let line = stripTrailingSpaces(String(rawLine).replace(/\r$/, ''));
    if (/[\0\ufeff]/.test(line) || line.endsWith('\\') || /\[[^\]]*\//.test(line)) {
      (rules as any).verified = false;
      continue;
    }
    if (!line || line.startsWith('#')) {
      continue;
    }
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    if (!line) {
      continue;
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) {
      continue;
    }
    let anchored = line.includes('/');
    if (line.startsWith('/')) {
      line = line.slice(1);
      anchored = true;
    }
    if (!line) {
      continue;
    }
    try {
      // POSIX character classes, complex bracket escapes and backslash parity
      // need Git wildmatch semantics; do not silently claim to implement them.
      if (line.includes('[[:') || line.includes('[^') || line.includes('[]') || line.includes('\\\\') || line.includes('[\\')) {
        (rules as any).verified = false;
        continue;
      }
      rules.push({ negated, dirOnly, anchored, regex: compileAnchoredPattern(line), source: line });
    } catch {
      (rules as any).verified = false;
    }
  }
  return rules;
}

export type IgnoreSource = {
  base: string;
  rules: GitignoreRule[];
};

// 按优先级链匹配：sources 按低→高优先级排列（全局 exclude < info/exclude <
// 浅层 .gitignore < 深层 .gitignore），反向迭代，首个命中的规则决定结果。
// 返回 true（忽略）/ false（否定命中，不忽略）/ undefined（无规则命中）。
export function matchIgnoreSources(sources: any, relPath: any, isDir: any): any {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    return undefined;
  }
  const list = Array.isArray(sources) ? sources : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const source = list[i];
    const base = String(source && source.base || '').replace(/^\/+|\/+$/g, '');
    let rel = normalized;
    if (base) {
      if (normalized === base || !normalized.startsWith(`${base}/`)) {
        continue;
      }
      rel = normalized.slice(base.length + 1);
    }
    const rules = Array.isArray(source.rules) ? source.rules : [];
    for (let j = rules.length - 1; j >= 0; j -= 1) {
      const rule = rules[j];
      if (rule.dirOnly && !isDir) {
        continue;
      }
      const candidate = rule.anchored ? rel : rel.slice(rel.lastIndexOf('/') + 1);
      if (rule.regex.test(Buffer.from(candidate, 'utf8').toString('latin1'))) {
        return !rule.negated;
      }
    }
  }
  return undefined;
}

// ---------------- 遍历条目分类 ----------------

export type WalkEntry = {
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
};

// 将扁平遍历条目分类为采集候选与缺口。git 语义要点：
// - tracked 文件即使命中 ignore 规则也必须采集（ignore 只作用于 untracked）；
// - 已忽略目录不深入（其内 .gitignore 的否定不生效），但 tracked 文件与其例外
//   （isIncludedIgnored 的策略级显式纳入）仍采集；
// - 特殊文件（FIFO/socket/设备等）进入 uncaptured 缺口清单——除非它本身被
//   ignore 规则排除（git 本来也不会列出它）；
// - tracked=null（元数据不可用）→ 不应用任何 ignore 规则，全部普通文件成为候选
//   （宁多采不漏采，由调用方补降级原因）。
export function classifyWalkEntries(entries: any, options: any = {}) {
  const tracked = options.tracked instanceof Set ? options.tracked : null;
  const applyIgnore = options.applyIgnore === true;
  const gitignoreByDir = options.gitignoreByDir instanceof Map ? options.gitignoreByDir : new Map();
  const globalSources = Array.isArray(options.globalIgnoreSources) ? options.globalIgnoreSources : [];
  const isIncludedIgnored = typeof options.isIncludedIgnored === 'function' ? options.isIncludedIgnored : () => false;

  const candidates: WalkEntry[] = [];
  const uncaptured: any[] = [];
  const dirInfo = new Map<string, any>();
  const ignoredDirs = new Set<string>();

  const sorted = (Array.isArray(entries) ? entries : []).slice().sort((a: any, b: any) => (
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  ));

  const underIgnoredDir = (relPath: string) => {
    const segments = relPath.split('/');
    let dir = '';
    for (let i = 0; i < segments.length - 1; i += 1) {
      dir = dir ? `${dir}/${segments[i]}` : segments[i];
      if (ignoredDirs.has(dir)) {
        return true;
      }
    }
    return false;
  };

  // 该路径适用的规则源：全局 < 根 .gitignore < 逐级深层（已忽略目录内的规则不生效）。
  const sourcesFor = (relPath: string) => {
    const sources: IgnoreSource[] = [...globalSources];
    const rootRules = gitignoreByDir.get('');
    if (rootRules) {
      sources.push({ base: '', rules: rootRules });
    }
    const segments = relPath.split('/');
    let dir = '';
    for (let i = 0; i < segments.length - 1; i += 1) {
      dir = dir ? `${dir}/${segments[i]}` : segments[i];
      if (ignoredDirs.has(dir)) {
        break;
      }
      const rules = gitignoreByDir.get(dir);
      if (rules) {
        sources.push({ base: dir, rules });
      }
    }
    return sources;
  };

  for (const entry of sorted) {
    const relPath = String(entry.path || '');
    if (!relPath) {
      continue;
    }
    if (entry.type === 'dir') {
      let ignored = underIgnoredDir(relPath);
      if (!ignored && applyIgnore) {
        ignored = matchIgnoreSources(sourcesFor(relPath), relPath, true) === true;
      }
      dirInfo.set(relPath, { ignored });
      if (ignored) {
        ignoredDirs.add(relPath);
      }
      continue;
    }
    const isTracked = tracked !== null && tracked.has(relPath);
    const pushEntry = () => {
      if (entry.type === 'other') {
        uncaptured.push({ path: relPath, reason: 'special_file' });
      } else {
        candidates.push(entry);
      }
    };
    if (isTracked) {
      pushEntry();
      continue;
    }
    if (underIgnoredDir(relPath)) {
      // git 不深入已忽略目录；仅策略级显式纳入可例外（等效 ls-files 的 dir/** 强制展开）。
      if (isIncludedIgnored(relPath)) {
        pushEntry();
      }
      continue;
    }
    if (applyIgnore) {
      const decision = matchIgnoreSources(sourcesFor(relPath), relPath, false);
      if (decision === true && !isIncludedIgnored(relPath)) {
        continue;
      }
    }
    pushEntry();
  }

  return { candidates, uncaptured, dirInfo };
}

// ---------------- .git/config 最小子集 ----------------

// 只提取采集分类所需的三件事：objectformat（index 哈希长度）、core.excludesFile、
// include 检测（include 目标绝不读取，仅作降级标记）。
export function parseGitConfigSubset(text: any) {
  let section = '';
  let objectFormat = '';
  let excludesFile = '';
  let hasInclude = /\[\s*include(?:if)?(?:\s|\])/i.test(String(text || ''));
  let verified = true;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const sec = line.match(/^\[([^\]"]+)(?:\s+"([^"]*)")?\]\s*$/);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      // Deprecated dotted subsections are outside this grammar.
      if (!/^[a-z][a-z0-9-]*$/.test(section)
        || (['core', 'extensions'].includes(section) && sec[2] !== undefined)) verified = false;
      if (/^include(?:if)?(?:\.|$)/.test(section)) hasInclude = true;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9.-]+)\s*=\s*(.*)$/);
    if (!kv) {
      // Git permits bare booleans and continuations; this subset does not.
      verified = false;
      continue;
    }
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();
    if (value.includes('\\') || (section === 'extensions' && key !== 'objectformat')
      || (section === 'core' && ['ignorecase', 'sparsecheckout', 'sparsecheckoutcone'].includes(key) && !/^(false|0|no)$/i.test(value))) verified = false;
    if (value.startsWith('"')) {
      const quoted = value.match(/^"([^"\\\0]*)"\s*(?:[#;].*)?$/);
      if (!quoted) { verified = false; continue; }
      value = quoted[1];
    } else {
      value = value.replace(/[#;].*$/, '').trim();
      if (/["\0]/.test(value)) { verified = false; continue; }
    }
    if (!section || (section === 'core' && (
      key === 'worktree'
      || (key === 'bare' && !/^(false|0|no)$/i.test(value))
      || (key === 'repositoryformatversion' && !/^[01]$/.test(value))
    ))) verified = false;
    if (section === 'extensions' && key === 'objectformat') {
      objectFormat = value.toLowerCase();
    }
    if (section === 'core' && key === 'excludesfile') {
      excludesFile = value;
    }
    if (section === 'include' && key === 'path') {
      hasInclude = true;
    }
    if (section === 'includeif') {
      hasInclude = true;
    }
  }
  return { objectFormat, excludesFile, hasInclude, verified };
}

// ---------------- .git/index 解析 ----------------

// 解析 git index（v2/v3/v4，sha1=20B/sha256=32B）。严格走查：条目数、名字 NUL
// 终止、v2/v3 的 8 字节对齐、扩展区 sig+size 逐帧推进、结尾恰为整索引校验 hash。
// 任何损坏 → ok:false（调用方失败关闭：降级多采并标记不完整，绝不静默猜测）。
export function parseGitIndex(buffer: any, hashLen: any) {
  const fail = (reason: string) => ({ ok: false, reason, entries: [] as any[] });
  const hashBytes = Number(hashLen) === 32 ? 32 : 20;
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 + hashBytes) {
    return fail('index_too_small');
  }
  if (buffer.toString('latin1', 0, 4) !== 'DIRC') {
    return fail('index_bad_magic');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3 && version !== 4) {
    return fail('index_unsupported_version');
  }
  const count = buffer.readUInt32BE(8);
  const entries: any[] = [];
  let offset = 12;
  let prevName = Buffer.alloc(0);
  const limit = buffer.length - hashBytes;
  const digest = require('node:crypto').createHash(hashBytes === 32 ? 'sha256' : 'sha1').update(buffer.subarray(0, limit)).digest();
  if (!digest.equals(buffer.subarray(limit))) return fail('index_checksum_mismatch');

  for (let i = 0; i < count; i += 1) {
    const fixedLen = 40 + hashBytes + 2;
    if (offset + fixedLen > limit) {
      return fail('index_truncated');
    }
    const entryStart = offset;
    const mode = buffer.readUInt32BE(offset + 24);
    // Gitlinks require a separately verified submodule checkout and dependencies.
    if (![0o100644, 0o100755, 0o120000].includes(mode)) return fail('index_unsupported_mode');
    const flags = buffer.readUInt16BE(offset + fixedLen - 2);
    offset += fixedLen;
    if (flags & 0x4000) {
      // extended 标志仅 v3+ 合法，多 2 字节扩展标志位。
      if (version < 3) {
        return fail('index_bad_flags');
      }
      if (offset + 2 > limit) {
        return fail('index_truncated');
      }
      // skip-worktree / intent-to-add and reserved bits are not verified.
      if (buffer.readUInt16BE(offset) !== 0) return fail('index_unverified_flags');
      offset += 2;
    }
    let name = '';
    if (version === 4) {
      // v4 前缀压缩：git offset-varint（剥离字符数）+ NUL 结尾后缀。
      // offset 编码：首字节取低 7 位；每个带续位的前序字节使后续值 ((v+1)<<7)|bits。
      if (offset >= limit) {
        return fail('index_truncated');
      }
      let byte = buffer[offset];
      offset += 1;
      let strip = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= limit) {
          return fail('index_truncated');
        }
        byte = buffer[offset];
        offset += 1;
        strip = (strip + 1) * 128 + (byte & 0x7f);
        if (!Number.isSafeInteger(strip) || strip > prevName.length) return fail('index_bad_prefix');
      }
      const nul = buffer.indexOf(0, offset);
      if (nul < 0 || nul >= limit) {
        return fail('index_truncated');
      }
      if (strip > prevName.length) return fail('index_bad_prefix');
      const bytes = Buffer.concat([prevName.subarray(0, prevName.length - strip), buffer.subarray(offset, nul)]);
      name = bytes.toString('utf8');
      if (!Buffer.from(name).equals(bytes)) return fail('index_unsupported_encoding');
      if ((flags & 0x0fff) !== Math.min(bytes.length, 0x0fff)) return fail('index_bad_name_length');
      offset = nul + 1;
    } else {
      const nameLen = flags & 0x0fff;
      let actualNameLen = nameLen;
      if (nameLen === 0x0fff) {
        const nul = buffer.indexOf(0, offset);
        if (nul < 0 || nul >= limit) {
          return fail('index_truncated');
        }
        actualNameLen = nul - offset;
      }
      if (offset + actualNameLen >= limit) {
        return fail('index_truncated');
      }
      if (buffer[offset + actualNameLen] !== 0) {
        return fail('index_corrupt');
      }
      const bytes = buffer.subarray(offset, offset + actualNameLen);
      name = bytes.toString('utf8');
      if (!Buffer.from(name).equals(bytes)) return fail('index_unsupported_encoding');
      // 条目（含 NUL 终止）自 entryStart 起 8 字节对齐。
      const entryLen = Math.ceil((offset - entryStart + actualNameLen + 1) / 8) * 8;
      const entryEnd = entryStart + entryLen;
      if (entryEnd > limit || buffer.subarray(offset + actualNameLen, entryEnd).some((byte: number) => byte !== 0)) return fail('index_bad_padding');
      offset = entryEnd;
    }
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').some((part: string) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) return fail('index_bad_path');
    prevName = Buffer.from(name);
    entries.push({ path: name, mode });
  }

  // 扩展区严格走查：signature(4) + size(4) + data(size)，直至恰剩整索引 hash。
  while (offset < limit) {
    if (offset + 8 > limit) {
      return fail('index_corrupt_extension');
    }
    // Lower-case signatures are mandatory. In particular split index ('link')
    // cannot be treated as a complete tracked set without its shared index.
    if (buffer[offset] < 65 || buffer[offset] > 90) return fail('index_unsupported_extension');
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8 + size;
    if (offset > limit) {
      return fail('index_corrupt_extension');
    }
  }
  if (offset !== limit) {
    return fail('index_corrupt');
  }
  return { ok: true, reason: '', entries };
}
