// Trusted local/offline v2 adapter. Read Git objects at the recorded HEAD, apply
// archived bytes in a disposable directory, never check out or modify source.
// Skills remain detached bytes + original paths until the caller maps them into
// its own isolated workspace; this function never writes an original skill path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { matchesRelativePattern } from './capture-policy';
import { knownCaptureKeyValues } from './git-snapshot';
import { redactKnownKeyValues } from './secrets';
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const relative = (s: any): s is string => typeof s === 'string' && s.length > 0 && !s.includes('\\')
  && !s.startsWith('/') && s.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git'
    && !/[ .]$|[<>:"|?*\x00-\x1f]/.test(p) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
const within = (p: string, paths: typeof path.posix) => p === '' || p !== '..' && !p.startsWith('../') && !p.startsWith('..\\') && !paths.isAbsolute(p);
export function snapshotSkillLocation(cwd: string, originalPath: string) {
  const paths = /^[A-Za-z]:[\\/]/.test(originalPath) ? path.win32 : path.posix;
  if (!paths.isAbsolute(originalPath) || !paths.isAbsolute(cwd)) throw fail('git_snapshot_skill_invalid');
  const rel = paths.relative(cwd, originalPath).replaceAll('\\', '/');
  if (within(rel, paths)) return { internal: true, relativePath: rel };
  const normalized = paths.normalize(originalPath).replaceAll('\\', '/');
  const mirrorPath = paths === path.win32 ? 'windows/' + normalized[0].toUpperCase() + '/' + normalized.slice(3) : 'posix/' + normalized.slice(1);
  if (!relative(mirrorPath)) throw fail('git_snapshot_skill_invalid');
  return { internal: false, relativePath: mirrorPath };
}
function git(cwd: string, args: string[], input?: Buffer | string, maxBuffer = 256 * 1024 * 1024): Buffer {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' });
  return execFileSync('git', ['--no-replace-objects', '-C', cwd, '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'protocol.allow=never', ...args],
  { env, input, maxBuffer, timeout: 120000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
export function materializeGitSnapshot(options: any): any {
  const cp = options.checkpoint, snapshot = cp?.gitSnapshot;
  if (cp?.schemaVersion !== 2 || snapshot?.kind !== 'git-snapshot-v1' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.head)
    || !path.isAbsolute(snapshot.sourceRepository || '') || !Array.isArray(snapshot.projectSkills)) throw fail('git_snapshot_manifest_invalid');
  let source = snapshot.sourceRepository;
  try { git(source, ['rev-parse', '--git-dir']); } catch {
    // A removed room need not remove its project's shared object database.
    // Use only the recorded common dir, never a guessed current checkout/HEAD.
    if (!path.isAbsolute(snapshot.commonDir || '')) throw fail('git_snapshot_source_unavailable');
    source = snapshot.commonDir;
    try { git(source, ['rev-parse', '--git-dir']); } catch { throw fail('git_snapshot_source_unavailable'); }
  }
  try { if (git(source, ['cat-file', '-t', snapshot.head]).toString().trim() !== 'commit') throw Error(); }
  catch { throw fail('git_snapshot_head_unavailable'); }
  const readBlob = (entry: any) => {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.hash || '') || !Number.isSafeInteger(entry.size) || entry.size < 0) throw fail('git_snapshot_manifest_invalid');
    let bytes: any;
    try { bytes = options.store.readBlob(cp.projectId, entry.hash); } catch { throw fail('git_snapshot_blob_missing'); }
    if (!Buffer.isBuffer(bytes)) throw fail('git_snapshot_blob_missing');
    if (bytes.length !== entry.size || hash(bytes) !== entry.hash) throw fail('git_snapshot_blob_corrupt');
    return bytes;
  };
  const patch = readBlob({ hash: snapshot.patchBlobHash, size: snapshot.patchBytes });
  const readFiles = (records: any) => {
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw fail('git_snapshot_manifest_invalid');
    return Object.fromEntries(Object.entries(records).map(([name, record]: any) => {
      if (!relative(name) || record.type !== 'file' || record.secretExcluded) throw fail('git_snapshot_manifest_invalid');
      return [name, { ...record, content: readBlob(record) }];
    }));
  };
  const overlays = readFiles(cp.files), skills = snapshot.projectSkills.map((s: any) => {
    if (!s || !['file', 'directory'].includes(s.rootKind)) throw fail('git_snapshot_skill_invalid');
    const files = readFiles(s.files);
    if (s.rootKind === 'file' && (Object.keys(files).length > 1 || Object.keys(files).some(name => name !== s.originalPath.replaceAll('\\', '/').split('/').at(-1)))) throw fail('git_snapshot_skill_invalid');
    return { originalPath: s.originalPath, rootKind: s.rootKind, ...snapshotSkillLocation(cp.targetDir, s.originalPath), files };
  });
  if (!Array.isArray(cp.deletions) || cp.deletions.some((p: any) => !relative(p))) throw fail('git_snapshot_manifest_invalid');
  const knownValues = typeof options.getKnownKeyValues === 'function' ? options.getKnownKeyValues()
    : options.knownKeyValues || knownCaptureKeyValues(options.agentDir);
  const gaps: any[] = structuredClone(cp.uncaptured || []);
  const gap = (name: string, reason: string) => { if (!gaps.some(g => !g.scope && g.path === name && g.reason === reason)) gaps.push({ path: name, reason }); };
  const skipped = (p: string) => gaps.some(g => !g.scope && g.path !== '.' && (p === g.path || p.startsWith(g.path + '/')));
  const excluded = (p: string) => p.split('/').some(n => n === '.git' || n === 'node_modules') || matchesRelativePattern(p, snapshot.excludedPatterns || []);
  const scopedOmissions: string[] = [];
  for (const item of gaps) if (skills.some((s: any) => s.internal && s.originalPath === item.scope)) {
    // Skill gaps are relative to the archived path's drive/filesystem root,
    // not cwd. Translate them only for omission in this detached working tree.
    const paths = /^[A-Za-z]:[\\/]/.test(item.scope) ? path.win32 : path.posix;
    const absolute = paths.join(paths.parse(item.scope).root, item.path), location = snapshotSkillLocation(cp.targetDir, absolute);
    if (location.internal && relative(location.relativePath)) scopedOmissions.push(location.relativePath);
  }
  let temporary: string | undefined;
  try {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-snapshot-materialize-'));
    const workspace = temporary;
    const write = (name: string, bytes: Buffer, mode?: number) => {
      const dest = path.join(workspace, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes);
      if (Number.isSafeInteger(mode)) { try { fs.chmodSync(dest, mode! & 0o777); } catch { /* platform mode support */ } }
    };
    // ls-tree + cat-file --batch read objects, not checkout filters, source
    // working files, export-ignore or export-subst archive transformations.
    let listing: Buffer;
    try { listing = git(source, ['ls-tree', '-rlz', '--full-tree', snapshot.head]); } catch { throw fail('git_snapshot_head_unavailable'); }
    const rows: any[] = [];
    for (const record of listing.toString('utf8').split('\0').filter(Boolean)) {
      const m = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\s+(\d+|-)\t([\s\S]+)$/.exec(record);
      if (!m) throw fail('git_snapshot_tree_invalid');
      const [, mode, type, oid, size, name] = m;
      if (excluded(name) || skipped(name)) continue;
      if (!relative(name)) { gap(name, 'windows_reserved_or_invalid_name'); continue; }
      if (mode === '120000' || mode === '160000' || type !== 'blob') { gap(name, mode === '120000' ? 'reparse_point_skipped' : 'submodule_unsupported'); continue; }
      if (!['100644', '100755'].includes(mode) || !Number.isSafeInteger(Number(size)) || Number(size) > 64 * 1024 * 1024) throw fail('git_snapshot_file_size_limit');
      rows.push({ name, oid, size: Number(size), mode: mode === '100755' ? 0o100755 : 0o100644 });
    }
    // Bound memory per batch, not total repository bytes. Every ordinary HEAD
    // file still materializes; no per-file Git subprocess amplification.
    for (let start = 0; start < rows.length;) {
      let end = start, bytes = 0;
      while (end < rows.length && (end === start || bytes + rows[end].size <= 64 * 1024 * 1024)) bytes += rows[end++].size;
      const batch = rows.slice(start, end);
      let output: Buffer;
      try { output = git(source, ['cat-file', '--batch'], batch.map(r => r.oid).join('\n') + '\n', bytes + batch.length * 200 + 1); }
      catch { throw fail('git_snapshot_head_unavailable'); }
      let offset = 0;
      for (const row of batch) {
        const newline = output.indexOf(10, offset), header = output.subarray(offset, newline).toString('ascii');
        if (newline < offset || header !== `${row.oid} blob ${row.size}`) throw fail('git_snapshot_tree_invalid');
        offset = newline + 1;
        if (offset + row.size >= output.length || output[offset + row.size] !== 10) throw fail('git_snapshot_tree_invalid');
        write(row.name, output.subarray(offset, offset + row.size), row.mode); offset += row.size + 1;
      }
      if (offset !== output.length) throw fail('git_snapshot_tree_invalid');
      start = end;
    }
    // git apply needs only the detached baseline files; initialize a disposable
    // repo to avoid accidentally discovering an ancestor repository in TEMP.
    git(workspace, ['init', '-q', '--template=', '--initial-branch=replay-baseline']);
    if (patch.length) {
      try { git(workspace, ['apply', '--binary', '--whitespace=nowarn', '-'], patch); }
      catch { throw fail('git_snapshot_patch_invalid'); }
    }
    for (const name of cp.deletions) fs.rmSync(path.join(workspace, name), { force: true });
    for (const [name, entry] of Object.entries(overlays) as any[]) if (!excluded(name) && !skipped(name)) write(name, entry.content, entry.mode);
    const archivedFiles = { ...overlays };
    for (const skill of skills) if (skill.internal) {
      for (const [name, entry] of Object.entries(skill.files) as any[]) {
        const dest = skill.rootKind === 'file' ? skill.relativePath : [skill.relativePath, name].filter(Boolean).join('/');
        if (!relative(dest)) throw fail('git_snapshot_skill_invalid');
        write(dest, entry.content, entry.mode); archivedFiles[dest] = entry;
      }
    }
    // Gaps are absent, not stale HEAD files masquerading as captured bytes.
    for (const name of [...gaps.filter(g => !g.scope).map(g => g.path), ...scopedOmissions]) {
      if (relative(name)) fs.rmSync(path.join(workspace, name), { recursive: true, force: true });
    }
    const files: any = {}, redactedFiles: any[] = [], crlf = new Set(snapshot.crlfPaths || []);
    const finalize = (name: string, entry: any) => {
      const safe = redactKnownKeyValues(entry.content, knownValues);
      const content = !archivedFiles[name] && crlf.has(name) && !safe.content.includes(0) ? Buffer.from(safe.content.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1') : safe.content;
      const archived = archivedFiles[name];
      if (safe.redactionCount || archived?.secretRedacted) redactedFiles.push({ path: name, byteIdenticalToSource: false,
        originalSize: archived?.originalSize ?? entry.content.length, restoredSize: content.length, redactionCount: safe.redactionCount || archived.redactionCount });
      return { type: 'file', content, hash: hash(content), size: content.length, mode: entry.mode };
    };
    const walk = (dir: string, prefix = '') => {
      for (const name of fs.readdirSync(dir).sort()) {
        const rel = prefix + name; if (excluded(rel)) continue;
        const absolute = path.join(dir, name), stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) { gap(rel, 'reparse_point_skipped'); continue; }
        if (stat.isDirectory()) walk(absolute, rel + '/');
        else if (stat.isFile()) files[rel] = finalize(rel, { content: fs.readFileSync(absolute), mode: stat.mode });
        else gap(rel, 'special_file');
      }
    };
    walk(workspace);
    for (const skill of skills) if (!skill.internal) {
      for (const [name, entry] of Object.entries(skill.files) as any[]) {
        const safe = redactKnownKeyValues(entry.content, knownValues), content = safe.content;
        if (safe.redactionCount || entry.secretRedacted) redactedFiles.push({ path: skill.originalPath + (skill.rootKind === 'file' ? '' : '/' + name),
          scope: 'project-skill', byteIdenticalToSource: false, originalSize: entry.originalSize ?? entry.content.length,
          restoredSize: content.length, redactionCount: safe.redactionCount || entry.redactionCount });
        skill.files[name] = { ...entry, content, hash: hash(content), size: content.length };
      }
    }
    return { files, projectSkills: skills, sourceHead: snapshot.head, sourceRepository: source, redactedFiles, uncaptured: gaps,
      lineEndingEvidence: Array.isArray(snapshot.crlfPaths) ? 'captured-eol' : 'legacy-v2-head-bytes' };
  } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
}
