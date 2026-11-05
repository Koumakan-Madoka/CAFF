// Personal local best-effort snapshot. Git owns repository interpretation;
// no native reader, pin, second scan, index refresh or source writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { matchesRelativePattern, pathsEqual } from './capture-policy';
import { redactKnownKeyValues } from './secrets';
import { CAPTURE_TIME_LIMIT_MS, createCaptureTimeBudget, isCaptureTimeLimit, type CaptureTimeBudget } from './capture-time-budget';
const execute = promisify(execFile);
export const GIT_SNAPSHOT_LIMITS = { fileBytes: 10 * 1024 * 1024, untrackedBytes: 200 * 1024 * 1024 };
const hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
// Split NUL records before decoding. A lossy UTF-8 conversion can otherwise
// alias an unrelated, valid U+FFFD filename. Round-trip validation also preserves
// a leading BOM (unlike TextDecoder's default). Metadata prefixes are ASCII.
export function snapshotGitNames(bytes: Buffer, gap: (name: string, reason: string) => void, metadata = false): string[] {
  const result: string[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = bytes.indexOf(0, start); if (end < 0) end = bytes.length;
    const record = bytes.subarray(start, end); start = end + 1;
    if (!record.length) continue;
    const decoded = record.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(record)) {
      const rawName = metadata ? record.subarray(record.indexOf(9) + 1) : record;
      // Diagnostic identity, NOT a replay path: ':' is forbidden by the replay
      // path validator. Keep raw bytes distinct, never blacklist a valid alias.
      gap('invalid-utf8:' + rawName.toString('hex'), 'invalid_utf8_name');
      continue;
    }
    result.push(decoded);
  }
  return result;
}

// Explicit -C must win over an SDK/CI shell's repository-routing variables.
// Normal user Git ignore/config rules remain in effect. Optional locks off:
// even an incidental Git index refresh must not write to the captured source.
export async function readSnapshotGit(cwd: string, args: string[], budget?: CaptureTimeBudget): Promise<Buffer> {
  budget?.check();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key];
  try {
    const result = await execute('git', ['--no-pager', '-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
      env, encoding: 'buffer', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
      timeout: budget ? Math.max(1, Math.ceil(budget.remainingMs())) : CAPTURE_TIME_LIMIT_MS,
    });
    budget?.check();
    return result.stdout as Buffer;
  } catch (error: any) {
    if (budget && error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') budget.expire();
    budget?.check();
    throw error;
  }
}

export async function inspectSnapshotRepository(cwd: string, budget?: CaptureTimeBudget): Promise<any> {
  try {
    const root = (await readSnapshotGit(cwd, ['rev-parse', '--show-toplevel'], budget)).toString('utf8').trim();
    if (!root) return { ok: false, reason: 'not_git_repository' };
    if (!pathsEqual(root, cwd)) return { ok: false, reason: 'target_not_repository_root' };
    const commonDir = (await readSnapshotGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], budget)).toString('utf8').trim();
    return { ok: true, root: path.resolve(root), commonDir: path.resolve(commonDir) };
  } catch (error) {
    if (isCaptureTimeLimit(error)) throw error;
    return { ok: false, reason: 'not_git_repository' };
  }
}

// This is ordinary lstat, NOT race-proof access. Check all components so Git's
// untracked inventory cannot lead us through a junction to its descendants.
// Invalid Windows names are skipped on every OS for replay portability.
function inspectFile(root: string, relative: string, budget: CaptureTimeBudget): any {
  budget.check();
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
      budget.check();
      if (stat.isSymbolicLink()) return { reason: 'reparse_point_skipped', path: prefix };
      if (i === parts.length - 1) return { stat, absolute: current, path: relative.replace(/\/$/, '') };
      if (!stat.isDirectory()) return { reason: 'not_a_directory', path: prefix };
    } catch (error: any) {
      budget.check();
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

function createFileArchive(options: any) {
  const keys: string[] = options.knownKeyValues || [], limits = { ...GIT_SNAPSHOT_LIMITS, ...options.limits };
  const budget: CaptureTimeBudget = options.budget || createCaptureTimeBudget(options);
  const uncaptured: any[] = [], gapKeys = new Set<string>(), blobs = new Map<string, Buffer>();
  const gap = (p: string, reason: string, scope = 'repository') => {
    const key = `${scope}:${p}:${reason}`;
    if (!gapKeys.has(key)) { gapKeys.add(key); uncaptured.push({ path: p, reason, ...(scope !== 'repository' ? { scope } : {}) }); }
  };
  const put = (bytes: Buffer) => { const digest = hash(bytes); blobs.set(digest, bytes); return digest; };
  const fileEntry = (bytes: Buffer, stat: any, origin: string) => {
    budget.check();
    const safe = redactKnownKeyValues(bytes, keys);
    budget.check();
    return { type: 'file', hash: put(safe.content), size: safe.content.length, mode: stat.mode, origin,
      ...(safe.redactionCount ? { secretRedacted: true, originalSize: bytes.length, redactionCount: safe.redactionCount } : {}) };
  };
  const readFile = (root: string, relative: string, scope = 'repository'): any => {
    const info = inspectFile(root, relative, budget);
    if (info.reason) { gap(info.path, info.reason, scope); return null; }
    if (!info.stat.isFile()) {
      gap(info.path, info.stat.isDirectory() ? 'nested_repository_or_directory_skipped' : 'special_file', scope); return null;
    }
    if (info.stat.size > limits.fileBytes) { gap(relative, 'file_size_limit', scope); return null; }
    try {
      const bytes = fs.readFileSync(info.absolute);
      budget.check();
      if (bytes.length > limits.fileBytes) { gap(relative, 'file_size_limit', scope); return null; }
      return { bytes, stat: info.stat };
    } catch (error: any) { budget.check(); gap(relative, error.code === 'ENAMETOOLONG' ? 'path_too_long' : 'file_unreadable', scope); return null; }
  };
  return { keys, limits, uncaptured, blobs, gap, put, fileEntry, readFile, budget };
}

function archiveProjectSkills(roots: string[], archive: ReturnType<typeof createFileArchive>): any[] {
  const { gap, readFile, fileEntry, limits, budget } = archive;
  const projectSkills: any[] = [];
  let totalBytes = 0;
  try {
    for (const originalPath of [...new Set<string>(roots.filter(p => typeof p === 'string' && path.isAbsolute(p)).map(p => path.resolve(p)))]) {
      budget.check();
      const archived: any = {}, scope = originalPath;
      const record = { originalPath, rootKind: 'directory', files: archived };
      projectSkills.push(record); // keep any already-archived resources on timeout
      const walk = (root: string, relative: string) => {
        const info = inspectFile(root, relative, budget);
        if (info.reason) { gap(info.path, info.reason, scope); return; }
        if (info.absolute === originalPath) record.rootKind = info.stat.isDirectory() ? 'directory' : 'file';
        if (info.stat.isDirectory()) {
          let children: string[];
          try { children = fs.readdirSync(info.absolute).sort(); } catch { budget.check(); gap(relative, 'directory_unreadable', scope); return; }
          budget.check();
          for (const child of children) if (child !== '.git' && child !== 'node_modules') walk(root, `${relative}/${child}`);
        } else {
          if (totalBytes + info.stat.size > limits.untrackedBytes) { gap(relative, 'skill_total_size_limit', scope); return; }
          const file = readFile(root, relative, scope);
          if (file) {
            if (totalBytes + file.bytes.length > limits.untrackedBytes) { gap(relative, 'skill_total_size_limit', scope); return; }
            totalBytes += file.bytes.length;
            archived[path.relative(originalPath, info.absolute).replaceAll('\\', '/') || path.basename(originalPath)] = fileEntry(file.bytes, file.stat, 'project-skill');
          }
        }
      };
      walk(path.parse(originalPath).root, path.relative(path.parse(originalPath).root, originalPath).replaceAll('\\', '/'));
    }
    budget.check();
  } catch (error) {
    if (!isCaptureTimeLimit(error)) throw error;
    gap('.', 'capture_time_limit', 'sdk');
  }
  return projectSkills;
}

// The runtime supplies its post-filter SDK list, not discovery roots guessed
// from cwd. A root Markdown skill is one file, not its entire parent directory.
export function collectLoadedProjectSkills(options: any): any {
  const archive = createFileArchive(options), loadedSkills: any[] = [], roots: string[] = [];
  for (const skill of options.skills || []) {
    if (typeof skill?.filePath !== 'string' || !path.isAbsolute(skill.filePath)) {
      archive.gap('.', 'project_skill_path_invalid', 'sdk'); continue;
    }
    const filePath = path.resolve(skill.filePath), baseDir = path.dirname(filePath);
    loadedSkills.push({ name: String(skill.name || ''), filePath, baseDir });
    roots.push(path.basename(filePath).toLowerCase() === 'skill.md' ? baseDir : filePath);
  }
  return { loadedSkills, projectSkills: archiveProjectSkills(roots, archive), uncaptured: archive.uncaptured, blobs: archive.blobs,
    captureTimeRemainingMs: archive.budget.remainingMs() };
}

export async function collectGitSnapshot(options: any): Promise<any> {
  const budget: CaptureTimeBudget = options.budget || createCaptureTimeBudget(options);
  // The optional reader is a trusted offline/test seam, never turn input.
  const git = async (args: string[]) => {
    budget.check();
    const bytes = await (options.readGit || readSnapshotGit)(path.resolve(options.targetDir), args, budget);
    budget.check();
    return bytes;
  };
  const cwd = path.resolve(options.targetDir);
  let repository: any;
  try { repository = options.repository || await inspectSnapshotRepository(cwd, budget); }
  catch (error) {
    if (!isCaptureTimeLimit(error)) throw error;
    return { ok: false, reason: 'capture_time_limit' };
  }
  if (!repository.ok) return repository;
  let head: string;
  try { head = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim(); }
  catch (error) { return { ok: false, reason: isCaptureTimeLimit(error) ? 'capture_time_limit' : 'head_unreadable' }; }
  const archive = createFileArchive({ ...options, budget });
  const { keys, limits, uncaptured, blobs, gap, put, fileEntry, readFile } = archive;
  const names = (bytes: Buffer, metadata = false) => snapshotGitNames(bytes, gap, metadata);
  const files: any = {};
  const excluded = [...new Set(['.git', 'node_modules', ...(options.excludedPatterns || [])])];
  const inScope = (p: string) => !p.replaceAll('\\', '/').split('/').some(part => part === '.git' || part === 'node_modules')
    && !matchesRelativePattern(p, excluded);
  let branch = '', baseFileCount = 0, untrackedBytes = 0, projectSkills: any[] = [];
  const patches: Buffer[] = [], deletions: string[] = [], crlfPaths: string[] = [], mixedEolPaths: string[] = [];
  try {
    try { branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).toString('utf8').trim(); } catch { budget.check(); /* detached */ }
    try {
      for (const record of names(await git(['ls-tree', '-r', '-z', head]), true)) {
        budget.check();
        const tab = record.indexOf('\t'), relative = record.slice(tab + 1), mode = record.slice(0, 6);
        if (tab < 0 || !inScope(relative)) continue;
        if (mode === '120000' || mode === '160000') gap(relative, mode === '120000' ? 'reparse_point_skipped' : 'submodule_unsupported');
        else baseFileCount++;
      }
    } catch { budget.check(); gap('.', 'head_inventory_unavailable'); }
    // Git deliberately hides these worktree paths from ordinary diff/status.
    // Do not refresh/reset their index flags or pretend HEAD is their content.
    try {
      const flags = await git(['ls-files', '-v', '-z']);
      for (let start = 0; start < flags.length;) {
        let end = flags.indexOf(0, start); if (end < 0) end = flags.length;
        const record = flags.subarray(start, end); start = end + 1;
        if (record.length < 3) continue;
        const tag = String.fromCharCode(record[0]);
        if (!/[a-z]/.test(tag) && tag !== 'S') continue;
        for (const name of names(Buffer.concat([record.subarray(2), Buffer.from([0])]))) if (inScope(name)) {
          if (/[a-z]/.test(tag)) gap(name, 'index_assume_unchanged');
          if (tag.toUpperCase() === 'S') gap(name, 'index_skip_worktree');
        }
      }
    } catch { budget.check(); gap('.', 'index_flags_unavailable'); }
    const hidden = (p: string) => uncaptured.some(g => !g.scope && g.path === p && /^index_/.test(g.reason));
    // HEAD blobs and diff use Git's normalized bytes. Record actual CRLF paths
    // instead of assuming all Windows files have CRLF. Mixed EOL needs a full
    // overlay because normalization loses the positions of individual CRs.
    try {
      for (const record of names(await git(['ls-files', '--eol', '-z']), true)) {
        const tab = record.indexOf('\t'), relative = record.slice(tab + 1), match = /\bw\/(crlf|mixed)\b/.exec(record.slice(0, tab));
        if (tab < 0 || !inScope(relative) || !match) continue;
        (match[1] === 'crlf' ? crlfPaths : mixedEolPaths).push(relative);
      }
    } catch { budget.check(); gap('.', 'worktree_eol_unavailable'); }
    let changed: string[] = [];
    try { changed = names(await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'HEAD', '--'])); }
    catch {
      budget.check();
      // A single unreadable dirty file may make name-only diff fail. Fall back
      // to Git's index inventory and isolate errors in individual path diffs.
      try { changed = names(await git(['ls-files', '--cached', '-z'])); }
      catch { budget.check(); gap('.', 'tracked_inventory_unavailable'); }
    }
    for (const relative of [...new Set(changed)].sort().filter(inScope)) {
      if (hidden(relative)) continue;
      const info = inspectFile(cwd, relative, budget);
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
        const base = keys.length ? await git(['show', `${head}:${relative}`]).catch(() => { budget.check(); return Buffer.alloc(0); }) : Buffer.alloc(0);
        if (redactKnownKeyValues(base, keys).redactionCount || current && redactKnownKeyValues(current.bytes, keys).redactionCount) {
          if (current) files[relative] = fileEntry(current.bytes, current.stat, 'redacted-tracked');
          else deletions.push(relative);
          continue;
        }
        const patch = await git(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--', relative]);
        patches.push(patch);
        if (!current && patch.length) deletions.push(relative);
      } catch { budget.check(); gap(relative, 'git_diff_unavailable'); }
    }
    for (const relative of mixedEolPaths) {
      if (hidden(relative) || files[relative] || deletions.includes(relative)) continue;
      const current = readFile(cwd, relative);
      if (current) files[relative] = fileEntry(current.bytes, current.stat, 'mixed-eol-tracked');
    }
    let untracked: string[] = [];
    try { untracked = names(await git(['ls-files', '--others', '--exclude-standard', '-z'])); }
    catch { budget.check(); gap('.', 'untracked_inventory_unavailable'); }
    for (const relative of [...new Set(untracked)].sort().filter(inScope)) {
      const info = inspectFile(cwd, relative, budget);
      if (!info.reason && info.stat.isFile() && untrackedBytes + info.stat.size > limits.untrackedBytes) { gap(relative, 'untracked_total_size_limit'); continue; }
      const file = readFile(cwd, relative);
      if (!file) continue;
      if (untrackedBytes + file.bytes.length > limits.untrackedBytes) { gap(relative, 'untracked_total_size_limit'); continue; }
      untrackedBytes += file.bytes.length; files[relative] = fileEntry(file.bytes, file.stat, 'untracked');
    }
    // Live turns pass [] and fill this from the SDK's actual loaded list before
    // prompting. Explicit roots remain useful for offline snapshots/previews.
    const config = options.sdkStartConfig || {};
    const roots = Array.isArray(options.projectSkillPaths) ? options.projectSkillPaths
      : [...['.agents/skills', '.pi/skills'].map(p => path.join(cwd, p)), ...(config.additionalSkillPaths || [])].filter(p => fs.existsSync(p));
    projectSkills = archiveProjectSkills(roots, archive);
    // Skill archive returns its partial prefix itself, without throwing it away.
    if (budget.remainingMs() === 0 && !uncaptured.some(g => g.reason === 'capture_time_limit')) budget.expire();
  } catch (error) {
    if (!isCaptureTimeLimit(error)) throw error;
    gap('.', 'capture_time_limit');
  }
  const patch = Buffer.concat(patches), patchBlobHash = put(patch);
  uncaptured.sort((a, b) => (a.scope || '').localeCompare(b.scope || '') || a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));
  return { ok: true, files, deletions: deletions.sort(), uncaptured, blobs,
    gitSnapshot: { kind: 'git-snapshot-v1', sourceRepository: repository.root, commonDir: repository.commonDir, head, branch,
      patchBlobHash, patchBytes: patch.length, baseFileCount, untrackedBytes, crlfPaths: crlfPaths.sort(), excludedPatterns: excluded, projectSkills,
      captureTimeRemainingMs: budget.remainingMs() } };
}
