// Personal local best-effort snapshot. Git owns repository interpretation;
// no native reader, pin, second scan, index refresh or source writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { matchesRelativePattern, pathsEqual } from './capture-policy';
import { redactKnownKeyValues } from './secrets';
const execute = promisify(execFile);
export const GIT_SNAPSHOT_LIMITS = { fileBytes: 10 * 1024 * 1024, untrackedBytes: 200 * 1024 * 1024 };
const hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const names = (b: Buffer): string[] => b.toString('utf8').split('\0').filter(Boolean);

// Explicit -C must win over an SDK/CI shell's repository-routing variables.
// Normal user Git ignore/config rules remain in effect. Optional locks off:
// even an incidental Git index refresh must not write to the captured source.
export async function readSnapshotGit(cwd: string, args: string[]): Promise<Buffer> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key];
  const result = await execute('git', ['--no-pager', '-C', cwd, ...args], {
    env, encoding: 'buffer', windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 25000,
  });
  return result.stdout as Buffer;
}

export async function inspectSnapshotRepository(cwd: string): Promise<any> {
  try {
    const root = (await readSnapshotGit(cwd, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
    if (!root) return { ok: false, reason: 'not_git_repository' };
    if (!pathsEqual(root, cwd)) return { ok: false, reason: 'target_not_repository_root' };
    const commonDir = (await readSnapshotGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString('utf8').trim();
    return { ok: true, root: path.resolve(root), commonDir: path.resolve(commonDir) };
  } catch { return { ok: false, reason: 'not_git_repository' }; }
}

// This is ordinary lstat, NOT race-proof access. Check all components so Git's
// untracked inventory cannot lead us through a junction to its descendants.
// Invalid Windows names are skipped on every OS for replay portability.
function inspectFile(root: string, relative: string): any {
  const parts = relative.replaceAll('\\', '/').split('/').filter(Boolean);
  if (!parts.length || parts.some(p => p === '.' || p === '..')) return { reason: 'path_invalid', path: relative };
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i], prefix = parts.slice(0, i + 1).join('/');
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[ .]$|[<>:"|?*\x00-\x1f]/.test(part)) {
      return { reason: 'windows_reserved_or_invalid_name', path: prefix };
    }
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return { reason: 'reparse_point_skipped', path: prefix };
      if (i === parts.length - 1) return { stat, absolute: current, path: relative.replace(/\/$/, '') };
      if (!stat.isDirectory()) return { reason: 'not_a_directory', path: prefix };
    } catch (error: any) {
      return { reason: error.code === 'ENOENT' ? 'missing' : error.code === 'ENAMETOOLONG' ? 'path_too_long' : 'file_unreadable', path: prefix };
    }
  }
}

// Read ONLY this service's configured agent files and already-present env values.
// Never discover another sandbox, execute ! commands, refresh auth or open a DB.
export function knownCaptureKeyValues(agentDir?: string): string[] {
  const values = new Set<string>();
  const add = (value: any) => {
    if (typeof value !== 'string' || !value || value.startsWith('!')) return;
    const literal = /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? process.env[value.slice(1)] : value;
    if (literal) values.add(literal);
  };
  for (const [key, value] of Object.entries(process.env)) if (/(?:API_?KEY|ACCESS_TOKEN|REFRESH_TOKEN|CALLBACK_TOKEN)$/.test(key)) add(value);
  const walk = (value: any) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:key|token|api_?key|access|refresh|access_?token|refresh_?token)$/i.test(key)) add(entry);
      if (entry && typeof entry === 'object') walk(entry);
    }
  };
  if (agentDir) for (const name of ['models.json', 'auth.json']) {
    try { walk(JSON.parse(fs.readFileSync(path.join(agentDir, name), 'utf8'))); } catch { /* not configured */ }
  }
  return [...values];
}

export async function collectGitSnapshot(options: any): Promise<any> {
  const cwd = path.resolve(options.targetDir), repository = await inspectSnapshotRepository(cwd);
  if (!repository.ok) return repository;
  let head: string;
  try { head = (await readSnapshotGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim(); }
  catch { return { ok: false, reason: 'head_unreadable' }; }
  const keys: string[] = options.knownKeyValues || [], limits = { ...GIT_SNAPSHOT_LIMITS, ...options.limits };
  const excluded = [...new Set(['.git', 'node_modules', ...(options.excludedPatterns || [])])];
  const inScope = (p: string) => !p.replaceAll('\\', '/').split('/').some(part => part === '.git' || part === 'node_modules')
    && !matchesRelativePattern(p, excluded);
  const uncaptured: any[] = [], gapKeys = new Set<string>(), blobs = new Map<string, Buffer>(), files: any = {};
  const gap = (p: string, reason: string, scope = 'repository') => {
    const key = `${scope}:${p}:${reason}`;
    if (!gapKeys.has(key)) { gapKeys.add(key); uncaptured.push({ path: p, reason, ...(scope !== 'repository' ? { scope } : {}) }); }
  };
  const put = (bytes: Buffer) => { const digest = hash(bytes); blobs.set(digest, bytes); return digest; };
  const fileEntry = (bytes: Buffer, stat: any, origin: string) => {
    const safe = redactKnownKeyValues(bytes, keys);
    return { type: 'file', hash: put(safe.content), size: safe.content.length, mode: stat.mode, origin,
      ...(safe.redactionCount ? { secretRedacted: true, originalSize: bytes.length, redactionCount: safe.redactionCount } : {}) };
  };
  const readFile = (root: string, relative: string, scope = 'repository'): any => {
    const info = inspectFile(root, relative);
    if (info.reason) { gap(info.path, info.reason, scope); return null; }
    if (!info.stat.isFile()) {
      gap(info.path, info.stat.isDirectory() ? 'nested_repository_or_directory_skipped' : 'special_file', scope); return null;
    }
    if (info.stat.size > limits.fileBytes) { gap(relative, 'file_size_limit', scope); return null; }
    try {
      const bytes = fs.readFileSync(info.absolute);
      if (bytes.length > limits.fileBytes) { gap(relative, 'file_size_limit', scope); return null; }
      return { bytes, stat: info.stat };
    } catch (error: any) { gap(relative, error.code === 'ENAMETOOLONG' ? 'path_too_long' : 'file_unreadable', scope); return null; }
  };
  let branch = '', baseFileCount = 0;
  try { branch = (await readSnapshotGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).toString('utf8').trim(); } catch { /* detached */ }
  try {
    for (const record of names(await readSnapshotGit(cwd, ['ls-tree', '-r', '-z', head]))) {
      const tab = record.indexOf('\t'), relative = record.slice(tab + 1), mode = record.slice(0, 6);
      if (tab < 0 || !inScope(relative)) continue;
      if (mode === '120000' || mode === '160000') gap(relative, mode === '120000' ? 'reparse_point_skipped' : 'submodule_unsupported');
      else baseFileCount++;
    }
  } catch { gap('.', 'head_inventory_unavailable'); }
  let changed: string[] = [];
  try { changed = names(await readSnapshotGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'HEAD', '--'])); }
  catch {
    // A single unreadable dirty file may make name-only diff fail. Fall back
    // to Git's index inventory and isolate errors in individual path diffs.
    try { changed = names(await readSnapshotGit(cwd, ['ls-files', '--cached', '-z'])); }
    catch { gap('.', 'tracked_inventory_unavailable'); }
  }
  const patches: Buffer[] = [], deletions: string[] = [];
  for (const relative of [...new Set(changed)].sort().filter(inScope)) {
    const info = inspectFile(cwd, relative);
    if (info.reason && info.reason !== 'missing') { gap(info.path, info.reason); continue; }
    if (!info.reason && (!info.stat.isFile() || info.stat.size > limits.fileBytes)) {
      gap(relative, info.stat.isSymbolicLink() ? 'reparse_point_skipped' : info.stat.isFile() ? 'file_size_limit' : 'special_file'); continue;
    }
    const current = info.reason === 'missing' ? null : readFile(cwd, relative);
    if (!current && info.reason !== 'missing') continue;
    try {
      // Literal replacement of patch context/binary data would corrupt a Git
      // patch. If either side contains a known key, archive a sanitized full
      // overlay (or explicit deletion) instead. Source/index remain untouched.
      const base = keys.length ? await readSnapshotGit(cwd, ['show', `${head}:${relative}`]).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
      if (redactKnownKeyValues(base, keys).redactionCount || current && redactKnownKeyValues(current.bytes, keys).redactionCount) {
        if (current) files[relative] = fileEntry(current.bytes, current.stat, 'redacted-tracked');
        else deletions.push(relative);
        continue;
      }
      const patch = await readSnapshotGit(cwd, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--', relative]);
      patches.push(patch);
      if (!current && patch.length) deletions.push(relative);
    } catch { gap(relative, 'git_diff_unavailable'); }
  }
  let untracked: string[] = [], untrackedBytes = 0;
  try { untracked = names(await readSnapshotGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])); }
  catch { gap('.', 'untracked_inventory_unavailable'); }
  for (const relative of [...new Set(untracked)].sort().filter(inScope)) {
    const info = inspectFile(cwd, relative);
    if (!info.reason && info.stat.isFile() && untrackedBytes + info.stat.size > limits.untrackedBytes) { gap(relative, 'untracked_total_size_limit'); continue; }
    const file = readFile(cwd, relative);
    if (!file) continue;
    if (untrackedBytes + file.bytes.length > limits.untrackedBytes) { gap(relative, 'untracked_total_size_limit'); continue; }
    untrackedBytes += file.bytes.length; files[relative] = fileEntry(file.bytes, file.stat, 'untracked');
  }
  // Resource roots come from the exact SDK start descriptor (explicit contract
  // roots) and the session project's default discovery roots. No home/agent
  // scope skills are reintroduced. Preserve resource files, not just SKILL.md.
  const config = options.sdkStartConfig || {}, roots = [...(Array.isArray(options.projectSkillPaths) ? options.projectSkillPaths : []),
    ...['.agents/skills', '.pi/skills'].map(p => path.join(cwd, p)), ...(config.additionalSkillPaths || [])];
  const projectSkills: any[] = [];
  for (const originalPath of [...new Set<string>(roots.filter((p: any) => typeof p === 'string' && path.isAbsolute(p)).map((p: string) => path.resolve(p)))]) {
    if (!fs.existsSync(originalPath)) continue;
    const archived: any = {}, scope = originalPath;
    const walk = (root: string, relative: string) => {
      const info = inspectFile(root, relative);
      if (info.reason) { gap(info.path, info.reason, scope); return; }
      if (info.stat.isDirectory()) {
        let children: string[];
        try { children = fs.readdirSync(info.absolute).sort(); } catch { gap(relative, 'directory_unreadable', scope); return; }
        for (const child of children) if (child !== '.git' && child !== 'node_modules') walk(root, `${relative}/${child}`);
      } else {
        const file = readFile(root, relative, scope);
        if (file) archived[path.relative(originalPath, info.absolute).replaceAll('\\', '/') || path.basename(originalPath)] = fileEntry(file.bytes, file.stat, 'project-skill');
      }
    };
    walk(path.parse(originalPath).root, path.relative(path.parse(originalPath).root, originalPath).replaceAll('\\', '/'));
    projectSkills.push({ originalPath, files: archived });
  }
  const patch = Buffer.concat(patches), patchBlobHash = put(patch);
  uncaptured.sort((a, b) => (a.scope || '').localeCompare(b.scope || '') || a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));
  return { ok: true, files, deletions: deletions.sort(), uncaptured, blobs,
    gitSnapshot: { kind: 'git-snapshot-v1', sourceRepository: repository.root, commonDir: repository.commonDir, head, branch,
      patchBlobHash, patchBytes: patch.length, baseFileCount, untrackedBytes, excludedPatterns: excluded, projectSkills } };
}
