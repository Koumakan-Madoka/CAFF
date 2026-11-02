// Trusted host preparation, NOT a source-repository copy. Only authorized
// snapshot/deletion paths at an explicitly recorded commit are read. Raw source
// blobs stay in memory; only redacted bytes enter a new history-free Git repo.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { redactFileSecrets } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const fail = code => Object.assign(Error(code), { code });
const hex = s => typeof s === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s);
const safePath = s => typeof s === 'string' && /^[A-Za-z0-9_.@/-]+$/.test(s) && s.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git');
function gitEnvironment() {
  const env = {};
  for (const k of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'GPT', GIT_AUTHOR_EMAIL: 'gpt@caff.local', GIT_COMMITTER_NAME: 'GPT', GIT_COMMITTER_EMAIL: 'gpt@caff.local',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2000-01-01T00:00:00+00:00' };
}
function prepareReplayGit(recipe, input, { knownValues = [] } = {}) {
  let temporary;
  try {
    if (!recipe || Object.keys(recipe).sort().join(',') !== 'head,sourceRoot' || !hex(recipe.head)
      || !path.isAbsolute(recipe.sourceRoot || '') || !Array.isArray(input?.files) || input.files.length > 1024
      || !Array.isArray(input.deletions) || input.deletions.length > 2048 || !Array.isArray(knownValues)
      || knownValues.some(v => typeof v !== 'string')) throw Error();
    const allowed = new Set([...input.files.map(f => f.path), ...input.deletions]);
    if ([...allowed].some(p => !safePath(p))) throw Error();
    const source = path.resolve(recipe.sourceRoot), sourceStat = fs.lstatSync(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || fs.realpathSync(source) !== source) throw Error();
    const env = gitEnvironment();
    // No ambient Git selectors/auth, replacement objects, lazy fetch, hooks,
    // credential prompts or network protocols. Never return Git stderr/stdout
    // on failure: cat-file output can contain original secret bytes.
    const git = (cwd, args, options = {}) => execFileSync('git', ['--no-replace-objects', '-C', cwd,
      '-c', 'protocol.allow=never', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', ...args],
    { env, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    if (fs.realpathSync(git(source, ['rev-parse', '--show-toplevel']).toString().trim()) !== source
      || git(source, ['cat-file', '-t', recipe.head]).toString().trim() !== 'commit') throw Error();
    const listing = git(source, ['ls-tree', '-rlz', '--full-tree', recipe.head]);
    const rows = []; let omittedSourceFiles = 0, total = 0;
    for (const record of listing.toString('utf8').split('\0').filter(Boolean)) {
      const m = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\s+(\d+|-)\t(.+)$/.exec(record);
      if (!m) throw Error();
      const [, mode, type, oid, size, name] = m;
      if (!allowed.has(name)) { omittedSourceFiles++; continue; }
      if (!safePath(name) || type !== 'blob' || !['100644', '100755'].includes(mode) || !hex(oid)
        || !Number.isSafeInteger(Number(size)) || Number(size) > 64 * 1024 * 1024) throw Error();
      rows.push({ path: name, mode, oid, size: Number(size) }); total += Number(size) + 256;
    }
    if (!Number.isSafeInteger(total) || rows.length > 3072) throw Error();
    // One raw object batch avoids a subprocess per file. No raw content is
    // written to temp files, archives, logs, error messages or return values.
    const raw = rows.length ? git(source, ['cat-file', '--batch'], { input: rows.map(r => r.oid).join('\n') + '\n', maxBuffer: Math.max(total + 1, 1024) }) : Buffer.alloc(0);
    let offset = 0; const safe = [], redactedFiles = [];
    for (const row of rows) {
      const end = raw.indexOf(10, offset); if (end < offset) throw Error();
      if (raw.subarray(offset, end).toString('ascii') !== row.oid + ' blob ' + row.size) throw Error();
      const start = end + 1; offset = start + row.size + 1;
      if (raw[offset - 1] !== 10) throw Error();
      const { content, redactionCount } = redactFileSecrets(raw.subarray(start, offset - 1), knownValues);
      safe.push({ path: row.path, mode: row.mode, bytes: content });
      if (redactionCount) redactedFiles.push({ path: row.path, originalSize: row.size, restoredSize: content.length,
        redactionCount, byteIdenticalToSource: false });
    }
    if (offset !== raw.length) throw Error();
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-replay-git-'));
    git(temporary, ['init', '-q', '--template=', '--initial-branch=replay-baseline']);
    // Fixed config: no source remotes, include directives, filters, hooks,
    // reflogs or original identity/config. No host path enters the result.
    fs.writeFileSync(path.join(temporary, '.git/config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = false\n\tautocrlf = false\n', { mode: 0o600 });
    git(temporary, ['read-tree', '--empty']);
    for (const f of safe) { const dest = path.join(temporary, f.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, f.bytes, { flag: 'wx', mode: 0o600 }); }
    // --no-filters also bypasses tracked .gitattributes transformations. Index
    // modes come from the recorded tree, not the current host's chmod support.
    const oids = safe.length ? git(temporary, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: safe.map(f => f.path).join('\n') + '\n' }).toString().trim().split('\n') : [];
    if (oids.length !== safe.length || oids.some(s => !hex(s))) throw Error();
    if (safe.length) git(temporary, ['update-index', '-z', '--index-info'], { input: safe.map((f, i) => f.mode + ' ' + oids[i] + '\t' + f.path + '\0').join('') });
    const tree = git(temporary, ['write-tree']).toString().trim(); if (!hex(tree)) throw Error();
    const restoredHead = git(temporary, ['commit-tree', tree], { input: 'Sanitized replay baseline\n\nSource HEAD: ' + recipe.head + '\n' }).toString().trim();
    if (!hex(restoredHead) || restoredHead === recipe.head) throw Error();
    git(temporary, ['update-ref', 'refs/heads/replay-baseline', restoredHead]);
    git(temporary, ['repack', '-a', '-d', '-q', '--window=0', '--depth=0']);
    const packs = fs.readdirSync(path.join(temporary, '.git/objects/pack')).filter(n => /^pack-[a-f0-9]+\.(pack|idx)$/.test(n)).sort();
    if (packs.length !== 2 || packs[0].split('.')[0] !== packs[1].split('.')[0]) throw Error();
    const names = ['.git/HEAD', '.git/config', '.git/index', '.git/refs/heads/replay-baseline', ...packs.map(n => '.git/objects/pack/' + n)];
    const gitFiles = names.sort().map(name => { const bytes = fs.readFileSync(path.join(temporary, name)); return { path: name, base64: bytes.toString('base64'), sha256: hash(bytes) }; });
    const report = { kind: 'sanitized-root-git-v1', sourceHead: recipe.head, sourceHeadEvidence: 'explicit-operator-record', restoredHead, historyIncluded: false,
      headIdenticalToSource: false, baselineFileCount: safe.length, omittedSourceFiles, redactedFiles };
    return { gitFiles, report, checkKnownValues(values) {
      if (safe.some(f => values.some(value => typeof value === 'string' && value && f.bytes.includes(value)))) throw fail('evaluation_input_contains_key');
    } };
  } catch { throw fail('evaluation_repository_unavailable_or_invalid'); }
  finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { prepareReplayGit, gitEnvironment };
