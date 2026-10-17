// Pure, explicit working-copy path mapping. No source-path I/O, SDK, launch,
// credential replacement or dependency-completeness claim. Archives stay intact.
import crypto from 'node:crypto';
import { planModePreservingReplayCapsule } from './capsule-materialization';
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const fail = () => Object.assign(Error('replay_worktree_mapping_invalid'), { code: 'replay_worktree_mapping_invalid' });
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: any, keys: string[]) => object(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const DESTINATION = '/work/restored/snapshot';
// Deliberately conservative lexical subset. No host resolve/realpath, Windows
// case folding for authority, UNC/device/drive-relative paths, aliases or dot segments.
function canonicalPath(v: any, platform: string) {
  if (typeof v !== 'string' || v.length > 4096 || !/^[\x20-\x7e]+$/.test(v)) throw fail();
  let parts: string[];
  if (platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(v) || (v.includes('\\') && v.includes('/'))) throw fail();
    parts = v.slice(3).split(v[2]);
  } else {
    if (!v.startsWith('/') || v.includes('\\')) throw fail();
    parts = v.slice(1).split('/');
  }
  if (!parts.length || parts.length > 64 || parts.some(p => !p || p === '.' || p === '..' || p.length > 255
    || !/^[A-Za-z0-9_.@ -]+$/.test(p) || p.trim() !== p || (platform === 'win32' && p.endsWith('.')))) throw fail();
  return v;
}
function utf8(b: Buffer | undefined) {
  if (!b) throw fail();
  const s = b.toString('utf8');
  if (s.includes('\0') || !Buffer.from(s).equals(b)) throw fail();
  return s;
}
// Only these string fields may be altered. Never session IDs, roles, model
// settings, tool names/results, bash commands or arbitrary extension state.
function sessionField(entry: any, line: number, pointer: any) {
  if (typeof pointer !== 'string') throw fail();
  if (line === 0 && pointer === '/cwd') return { value: entry.cwd, whole: true };
  if (entry.type !== 'message' || !object(entry.message)) throw fail();
  if (pointer === '/message/content') {
    if (entry.message.role !== 'user') throw fail();
    return { value: entry.message.content, whole: false };
  }
  const match = /^\/message\/content\/(0|[1-9][0-9]{0,4})\/(text|arguments\/path)$/.exec(pointer);
  if (!match || !Array.isArray(entry.message.content)) throw fail();
  const block = entry.message.content[Number(match[1])];
  if (!object(block)) throw fail();
  if (match[2] === 'text' && block.type === 'text' && ['user', 'assistant'].includes(entry.message.role)) {
    return { value: block.text, whole: false };
  }
  if (match[2] === 'arguments/path' && entry.message.role === 'assistant' && block.type === 'toolCall'
    && ['read', 'write', 'edit'].includes(block.name) && object(block.arguments)) return { value: block.arguments.path, whole: true };
  throw fail();
}
// Detect leftover spellings of THIS source root, including Windows separator/
// case variants. Not a general host-path detector, secret scanner or sandbox.
function residual(value: any, root: string, platform: string): boolean {
  const fold = (s: string) => platform === 'win32' ? s.replaceAll('\\', '/').toLowerCase() : s;
  const stack = [value]; let visited = 0;
  while (stack.length) {
    if (++visited > 100000) throw fail();
    const v = stack.pop();
    if (typeof v === 'string') { if (fold(v).includes(fold(root))) return true; }
    else if (Array.isArray(v)) {
      if (v.length + stack.length + visited > 100000) throw fail();
      for (const item of v) stack.push(item);
    } else if (object(v)) {
      const items = Object.entries(v);
      if (items.length * 2 + stack.length + visited > 100000) throw fail();
      for (const [k, item] of items) stack.push(k, item);
    }
  }
  return false;
}

export function prepareWorktreeReplayInputs(capsule: any, expected: any, declaration: any) {
  // Recheck all archive bytes/modes before consuming any declaration. This is
  // still only preparation: no materialization, authorizing or provider calls.
  const material = planModePreservingReplayCapsule(capsule, expected);
  const cp = JSON.parse(utf8(material.files.find(f => f.path === 'materials/checkpoint.json')?.bytes));
  const r = cp.replayInput;
  if (!exact(declaration, ['schemaVersion', 'sourcePlatform', 'sourceRoot', 'mappings']) || declaration.schemaVersion !== 1
    || !['linux', 'win32'].includes(declaration.sourcePlatform) || !Array.isArray(declaration.mappings)
    || declaration.mappings.length > 256 || declaration.sourceRoot !== cp.targetDir
    || (cp.integrity?.platform !== undefined && cp.integrity.platform !== declaration.sourcePlatform)
    || r.invocationImageCount !== 0 || !Array.isArray(r.unverifiedDimensions) || r.unverifiedDimensions.length !== 0
    || (r.secretExcludedPaths !== undefined && (!Array.isArray(r.secretExcludedPaths) || r.secretExcludedPaths.length !== 0))) throw fail();
  const { sourcePlatform: platform } = declaration;
  const root = canonicalPath(declaration.sourceRoot, platform);
  const separator = platform === 'win32' ? root[2] : '/';
  // A Windows case alias would address the original file on NT but a different
  // file after Linux restoration. Never silently convert it or invent identity.
  const spellings = new Map<string, string>();
  if (platform === 'win32') {
    for (const name of [...Object.keys(cp.files), ...cp.deletions]) {
      const parts = name.split('/');
      if (parts.length > 64) throw fail();
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/'), key = prefix.toLowerCase();
        if (spellings.has(key) && spellings.get(key) !== prefix) throw fail();
        spellings.set(key, prefix);
        if (spellings.size > 100000) throw fail();
      }
    }
  }
  const read = (h: any) => utf8(material.files.find(f => f.path === 'materials/blobs/' + h)?.bytes);
  const prompt = read(r.promptBlobHash);
  const session = r.deliveryMode === 'resume' ? read(r.sessionBlobHash) : null;
  // Keep original line terminators and every non-declared byte, never stringify
  // the session as a whole or silently make an unsupported resume fresh.
  const lines = session === null ? [] : session.split('\n');
  let entries: any[] = [];
  if (session !== null) {
    if (!session.endsWith('\n') || lines.length > 100001) throw fail();
    try { entries = lines.slice(0, -1).map(s => JSON.parse(s)); } catch { throw fail(); }
    if (!entries.length || entries.some(e => !object(e)) || entries[0].type !== 'session'
      || entries[0].version !== 3 || entries[0].cwd !== root) throw fail();
  }
  let harness: any;
  try { harness = JSON.parse(read(r.harness.configSnapshotHash)); } catch { throw fail(); }
  if (!object(harness) || harness.deliveryMode !== r.deliveryMode) throw fail();
  const groups = new Map<string, { input: string; line: number; value: string; whole: boolean; edits: any[] }>();
  let cwdMapped = false;
  for (const item of declaration.mappings) {
    const isSession = item?.input === 'session';
    if (!exact(item, isSession ? ['input', 'line', 'pointer', 'start', 'end', 'sourcePath'] : ['input', 'start', 'end', 'sourcePath'])
      || !['prompt', 'session'].includes(item.input)) throw fail();
    let value: any = prompt, whole = false, line = -1;
    if (isSession) {
      if (session === null || !Number.isSafeInteger(item.line) || item.line < 0 || item.line >= entries.length) throw fail();
      line = item.line;
      ({ value, whole } = sessionField(entries[line], line, item.pointer));
      if (line === 0 && item.pointer === '/cwd') cwdMapped = true;
    }
    if (typeof value !== 'string' || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)
      || item.start < 0 || item.end <= item.start || item.end > value.length
      || value.slice(item.start, item.end) !== item.sourcePath || (whole && (item.start !== 0 || item.end !== value.length))) throw fail();
    // Text spans need explicit ASCII whitespace or string edges on BOTH sides.
    // A denylist of path characters missed punctuation (e.g. root$other), so
    // unknown delimiters, quotes and Unicode whitespace fail rather than guess.
    // This is not shell/prose parsing; spaces INSIDE a declared path stay intact.
    const delimiter = /^[ \t\r\n]$/;
    if (!whole && ((item.start > 0 && !delimiter.test(value[item.start - 1]))
      || (item.end < value.length && !delimiter.test(value[item.end])))) throw fail();
    const source = canonicalPath(item.sourcePath, platform);
    if (source !== root && !source.startsWith(root + separator)) throw fail();
    const suffix = source.slice(root.length).split(separator).join('/');
    if (platform === 'win32' && suffix) {
      const parts = suffix.slice(1).split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/'), spelling = spellings.get(prefix.toLowerCase());
        if (spelling !== undefined && spelling !== prefix) throw fail();
      }
    }
    const key = isSession ? `${line}:${item.pointer}` : 'prompt';
    let group = groups.get(key);
    if (!group) { group = { input: item.input, line, value, whole, edits: [] }; groups.set(key, group); }
    group.edits.push({ start: item.start, end: item.end, replacement: DESTINATION + suffix });
  }
  if (session !== null && !cwdMapped) throw fail();
  let invocation = prompt;
  const lineEdits = new Map<number, { start: number; end: number; replacement: string }[]>();
  for (const group of groups.values()) {
    group.edits.sort((a, b) => a.start - b.start);
    if (group.edits.some((e, i, a) => i > 0 && e.start < a[i - 1].end)) throw fail();
    let value = group.value;
    for (const edit of [...group.edits].reverse()) value = value.slice(0, edit.start) + edit.replacement + value.slice(edit.end);
    if (group.input === 'prompt') invocation = value;
    else {
      // A canonical JSON string token must occur exactly once in its source
      // line. Ambiguous/alternate escaping fails instead of guessing offsets
      // or reserializing undeclared data. Quoted text inside strings cannot
      // match this token: JSON escapes those inner quotes.
      const token = JSON.stringify(group.value), line = lines[group.line], start = line.indexOf(token);
      if (start < 0 || line.indexOf(token, start + 1) !== -1) throw fail();
      const edits = lineEdits.get(group.line) || [];
      edits.push({ start, end: start + token.length, replacement: JSON.stringify(value) });
      lineEdits.set(group.line, edits);
    }
  }
  for (const [line, edits] of lineEdits) {
    edits.sort((a, b) => a.start - b.start);
    if (edits.some((e, i, a) => i > 0 && e.start < a[i - 1].end)) throw fail();
    for (const e of edits.reverse()) lines[line] = lines[line].slice(0, e.start) + e.replacement + lines[line].slice(e.end);
  }
  const sessionText = session === null ? null : lines.join('\n');
  if (sessionText !== null) {
    try { entries = lines.slice(0, -1).map(s => JSON.parse(s)); } catch { throw fail(); }
    if (entries[0].cwd !== DESTINATION) throw fail();
  }
  if (residual(invocation, root, platform) || residual(entries, root, platform)) throw fail();
  // Detach metadata. Retain full harness/skills/config/replacement declarations;
  // their execution semantics and external dependencies are NOT validated here.
  return { deliveryMode: r.deliveryMode, workingCwd: DESTINATION, invocation, sessionText,
    runConfig: structuredClone(r.runConfig), harness,
    skillSnapshots: structuredClone(r.harness.skillSnapshots), controlledReplacements: structuredClone(r.controlledReplacements),
    archive: { capsuleHash: expected.capsuleHash, checkpointChecksum: expected.checkpointChecksum,
      promptBlobHash: r.promptBlobHash, sessionBlobHash: r.sessionBlobHash, configSnapshotHash: r.harness.configSnapshotHash },
    receipt: { kind: 'explicit-worktree-input-mapping-v1', deliveryMode: r.deliveryMode,
      declarationHash: hash(JSON.stringify(declaration)), mappingCount: declaration.mappings.length,
      invocationHash: hash(invocation), sessionHash: sessionText === null ? '' : hash(sessionText),
      materializedHash: material.expectedReceipt.materializedHash, modeInventoryHash: material.expectedReceipt.modeInventoryHash,
      piExecuted: false, launchAuthorized: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false } };
}
