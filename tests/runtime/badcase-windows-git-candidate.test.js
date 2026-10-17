const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
const { readWindowsGitFileCandidate } = require('../../build/server/domain/runtime/badcase-capture/windows-git-candidate');
const { encodeWindowsHelperRequest: encode, parseWindowsHelperResponse: parse } = require('../../build/server/domain/runtime/badcase-capture/windows-helper');
const native = { skip: process.platform !== 'win32' ? 'real Windows NTFS required' : false };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = { volumeSerial: '1', fileId: 'a'.repeat(32), creationTime: '2' };
const baseRequest = { version: 1, root: 'C:/worktree', expected: identity, excluded: [] };
const entry = (name, type = 'file', size = '1') => ({ path: name, type, size: type === 'directory' ? '0' : size,
  identity, lastWriteTime: '0', changeTime: '0' });
function wire(entries, files) {
  const records = files.map(([name, content]) => ({ path: name, size: String(content.length), identity, sha256: hash(content) }));
  return Buffer.concat([Buffer.from(JSON.stringify({ version: 1, ok: true, identity, entries, files: records }) + '\n'), ...files.map(v => v[1])]);
}

test('selected snapshot and git metadata have independent closed request/response sets', () => {
  const selected = { ...baseRequest, op: 'selectedSnapshot', paths: ['safe'] };
  const meta = { ...baseRequest, op: 'gitMetadata' };
  assert.ok(encode(meta)); assert.ok(encode(selected));
  assert.equal(encode({ ...meta, paths: [] }), null);
  assert.equal(encode({ ...selected, paths: undefined }), null);
  assert.equal(encode({ ...selected, paths: ['safe', 'safe'] }), null);
  const entries = [entry('.git', 'directory'), entry('.git/index'), entry('ignored'), entry('safe')];
  assert.equal(parse(wire(entries, [['.git/index', Buffer.from('i')]]), meta).ok, true);
  assert.equal(parse(wire(entries, [['safe', Buffer.from('s')]]), selected).ok, true);
  assert.equal(parse(wire(entries, [['ignored', Buffer.from('x')], ['safe', Buffer.from('s')]]), selected).ok, false);
  assert.equal(parse(wire(entries, []), selected).ok, false);
  assert.equal(parse(wire(entries, [['safe', Buffer.from('s')]]), meta).ok, false);
  const bad = [entry('.git', 'directory'), entry('.git/hooks', 'directory'), entry('.git/hooks/private')];
  assert.equal(parse(wire(bad, []), meta).ok, false);
});

function isolated(scope, helper) {
  const filename = path.join(__dirname, '../../build/server/domain/runtime/badcase-capture/windows-git-candidate.js');
  const local = require('node:module').createRequire(filename), exports = {};
  require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, module: { exports }, Buffer, Map, Set,
    require: name => name === './windows-estimate' ? { prepareWindowsMetadataScope: scope }
      : name === './windows-helper' ? { invokeWindowsHelper: helper, encodeWindowsHelperRequest: encode } : local(name) }, { filename });
  return exports;
}
function gitIndex(names) {
  const chunks = [Buffer.from('DIRC00000000', 'ascii')];
  chunks[0].writeUInt32BE(2, 4); chunks[0].writeUInt32BE(names.length, 8);
  for (const name of names) {
    const n = Buffer.from(name), value = Buffer.alloc(Math.ceil((62 + n.length + 1) / 8) * 8);
    value.writeUInt32BE(0o100755, 24); value.writeUInt16BE(n.length, 60); n.copy(value, 62); chunks.push(value);
  }
  const bytes = Buffer.concat(chunks); return Buffer.concat([bytes, crypto.createHash('sha1').update(bytes).digest()]);
}
function metadata(overrides = {}) {
  const contents = new Map([['.git/config', Buffer.from('[core]\nignorecase = false\n')],
    ['.git/index', gitIndex(['tracked.log'])], ['.gitignore', Buffer.from('*.log\n')]]);
  const entries = [entry('.git', 'directory'), ...[...contents].map(([name, bytes]) => entry(name, 'file', String(bytes.length))),
    entry('ignored.log'), entry('tracked.log'), entry('untracked')];
  return { ok: true, identity, entries, files: [...contents].map(([p, bytes]) => ({ path: p, size: String(bytes.length), sha256: hash(bytes), identity, content: bytes })), ...overrides };
}
const scope = () => ({ ok: true, helperPath: 'fixed.py', request: { ...baseRequest, op: 'estimate' } });

test('local Git metadata rejects missing/bad/unsupported sources before ordinary content, no fallback to raw snapshot', () => {
  const bad = [metadata({ entries: [] }), metadata({ entries: [entry('.git')] }),
    metadata({ files: [] }), metadata({ entries: [...metadata().entries, entry('.git/commondir')] })];
  for (const text of ['[include]\npath = ../private\n', '[core]\nignorecase = true\n', '[core]\nexcludesfile = ../private\n']) {
    const value = metadata(); value.files.find(f => f.path === '.git/config').content = Buffer.from(text); bad.push(value);
  }
  for (const change of ['stage', 'symlink', 'duplicate', 'utf8']) {
    const value = metadata(), index = value.files.find(f => f.path === '.git/index');
    if (change === 'duplicate') index.content = gitIndex(['tracked.log', 'tracked.log']);
    else if (change === 'utf8') value.files.find(f => f.path === '.gitignore').content = Buffer.from([255]);
    else {
      const data = Buffer.from(index.content.subarray(0, -20));
      if (change === 'stage') data.writeUInt16BE(data.readUInt16BE(72) | 0x1000, 72);
      else data.writeUInt32BE(0o120000, 36);
      index.content = Buffer.concat([data, crypto.createHash('sha1').update(data).digest()]);
    }
    bad.push(value);
  }
  for (const change of ['checksum', 'ignore', 'secret']) {
    const value = metadata();
    const p = change === 'checksum' ? '.git/index' : '.gitignore';
    value.files.find(f => f.path === p).content = Buffer.from(change === 'secret' ? 'sk-SENTINELabcdefghijk' : change === 'ignore' ? '[[:alpha:]]' : 'bad'); bad.push(value);
  }
  for (const value of bad) {
    const ops = [], api = isolated(scope, (_, __, req) => { ops.push(req.op); return value; });
    const result = api.readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } });
    assert.equal(result.ok, false); assert.deepEqual(ops, ['gitMetadata']);
    assert.doesNotMatch(JSON.stringify(result), /sk-SENTINEL/);
    assert.equal(Object.hasOwn(result, 'files'), false);
  }
  let calls = 0;
  assert.equal(isolated(() => ({ ok: false, reason: 'unpinned' }), () => calls++).readWindowsGitFileCandidate({}).reason, 'unpinned');
  assert.equal(calls, 0);
});

test('classification limits, invalid include policy and helper refusals expose no partial plans', () => {
  let calls = 0;
  const api = isolated(scope, () => { calls++; return metadata(); });
  for (const patterns of [null, ['../outside'], ['*.log'], [''], [true]]) {
    assert.equal(api.readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: patterns } }).reason, 'git_policy_invalid');
  }
  assert.equal(calls, 0);
  const many = metadata(); many.entries.push(...Array.from({ length: 2049 }, (_, i) => entry(`extra-${i}`)));
  assert.equal(isolated(scope, () => { calls++; return many; }).readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } }).reason, 'git_selection_limit');
  assert.equal(calls, 1, 'no ordinary content transport after a selection-limit failure');
  for (const failAt of [1, 2, 3]) {
    let count = 0; const first = metadata();
    const instance = isolated(scope, (_, __, req) => {
      if (++count === failAt) return { ok: false, reason: 'snapshot_changed' };
      return req.op === 'gitMetadata' ? first : { ok: true, entries: first.entries.filter(e => e.path !== '.git' && !e.path.startsWith('.git/')), files: [] };
    });
    const result = instance.readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } });
    assert.equal(result.reason, 'snapshot_changed'); assert.equal(count, failAt); assert.equal(Object.hasOwn(result, 'files'), false);
  }
});

test('classified selection precedes reads, preserves tracked mode, rescans metadata, excludes sentinel backing', () => {
  const ops = [], first = metadata(), secret = Buffer.from('sk-SENTINELabcdefghijk');
  const backing = Buffer.concat([Buffer.from('x'), secret]), safe = backing.subarray(0, 1);
  const response = { ok: true, entries: first.entries.filter(e => !e.path.startsWith('.git/') && e.path !== '.git'),
    files: ['.gitignore', 'tracked.log', 'untracked'].map(p => ({ path: p, size: String(p === 'untracked' ? secret.length : 1), sha256: hash(p === 'untracked' ? secret : safe), content: p === 'untracked' ? secret : safe })) };
  function api(changed = false) {
    let metaCalls = 0;
    return isolated(scope, (_, __, req) => {
      ops.push(req.op);
      if (req.op === 'gitMetadata') return ++metaCalls === 2 && changed ? metadata({ entries: [...first.entries, entry('late')] }) : first;
      assert.equal(req.op, 'selectedSnapshot'); assert.deepEqual([...req.paths], ['.gitignore', 'tracked.log', 'untracked']); return response;
    });
  }
  const value = api().readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } });
  assert.equal(value.ok, true, value.reason); assert.deepEqual(ops, ['gitMetadata', 'selectedSnapshot', 'gitMetadata']);
  assert.equal(value.files['tracked.log'].mode, 0o100755);
  assert.equal(value.files.untracked.secretExcluded, true); assert.equal(value.blobs.has(hash(secret)), false);
  assert.equal(value.blobs.get(hash(safe)).buffer.byteLength, 1);
  assert.equal(Buffer.from(value.blobs.get(hash(safe)).buffer).includes(secret), false);
  for (const name of ['complete', 'strictEvalEligible', 'captureAvailable']) assert.equal(value[name], false);
  const rejected = api(true).readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } });
  assert.equal(rejected.reason, 'git_metadata_changed'); assert.equal(Object.hasOwn(rejected, 'files'), false);
  let metaCount = 0;
  const hashChange = isolated(scope, (_, __, req) => {
    if (req.op !== 'gitMetadata') return response;
    return ++metaCount === 1 ? first : { ...first, files: first.files.map(f => ({ ...f, sha256: '0'.repeat(64) })) };
  });
  assert.equal(hashChange.readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } }).reason, 'git_metadata_changed');
  const mismatch = isolated(scope, (_, __, req) => req.op === 'gitMetadata' ? first : { ...response, entries: [] });
  assert.equal(mismatch.readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } }).reason, 'git_metadata_changed');
});

test('native local Git subset selects dirty/tracked/untracked/explicit ignored, blocks external Git metadata', native, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wingit-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'worktree'), captureRoot = path.join(base, 'storage'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'no-global'), GIT_TEMPLATE_DIR: '' } });
  git('init', '-q'); git('config', 'core.ignorecase', 'false');
  fs.writeFileSync(path.join(root, '.gitignore'), '*.log\nignored-dir/\n');
  fs.writeFileSync(path.join(root, 'tracked.log'), 'original'); git('add', '-f', 'tracked.log', '.gitignore');
  fs.writeFileSync(path.join(root, 'tracked.log'), 'dirty');
  fs.writeFileSync(path.join(root, 'ignored.log'), 'IGNORED_NOT_AUTHORIZED');
  fs.writeFileSync(path.join(root, 'included.log'), 'included');
  fs.writeFileSync(path.join(root, 'untracked'), 'new');
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '*.tmp\n');
  fs.writeFileSync(path.join(root, 'private.tmp'), 'info-excluded');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', '.gitignore'), '*.cache\n!keep.cache\n');
  fs.writeFileSync(path.join(root, 'nested', 'hidden.cache'), 'nested-excluded');
  fs.writeFileSync(path.join(root, 'nested', 'keep.cache'), 'kept');
  fs.mkdirSync(path.join(root, 'ignored-dir')); fs.writeFileSync(path.join(root, 'ignored-dir', 'child'), 'ignored child');
  const service = createBadcaseCaptureService({ captureRoot });
  service.savePolicy('p', { authorizedDirs: [root], authorizedInputDirs: [], excludedPatterns: [], includedIgnoredPatterns: ['included.log'] });
  service.authorizeProject('p');
  const options = () => ({ policy: service.loadPolicy('p'), targetDir: root, captureRoot });
  const value = readWindowsGitFileCandidate(options()); assert.equal(value.ok, true, value.reason);
  const oracle = git('ls-files', '-c', '-o', '--exclude-standard', '-z').split('\0').filter(Boolean).concat('included.log').sort();
  assert.deepEqual(Object.keys(value.files).sort(), oracle);
  assert.equal(value.files['tracked.log'].hash, hash('dirty')); assert.equal(value.blobs.has(hash('IGNORED_NOT_AUTHORIZED')), false);
  assert.equal(value.files.untracked.hash, hash('new')); assert.equal(value.files['included.log'].hash, hash('included'));
  assert.equal(service.store.listCheckpoints('p').length, 0); assert.equal(service.loadPolicy('p').status, 'disabled');
  // Default exclusion of .git is not overridden merely to make classification work.
  service.savePolicy('p', { ...service.loadPolicy('p'), excludedPatterns: ['.git'] });
  assert.equal(readWindowsGitFileCandidate(options()).ok, false);
  service.savePolicy('p', { ...service.loadPolicy('p'), excludedPatterns: [] });
  fs.renameSync(path.join(root, '.git'), path.join(base, 'external-git'));
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../external-git\n');
  assert.equal(readWindowsGitFileCandidate(options()).reason, 'git_metadata_unsupported');
  assert.equal(service.store.listCheckpoints('p').length, 0);
});
