const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
const { readWindowsGitFileCandidate, readWindowsGitFileCandidateAsync } = require('../../build/server/domain/runtime/badcase-capture/windows-git-candidate');
const { encodeWindowsHelperRequest: encode, parseWindowsHelperResponse: parse, WINDOWS_HELPER_LIMITS: limits } = require('../../build/server/domain/runtime/badcase-capture/windows-helper');
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

function isolated(scope, helper, clock = require('node:perf_hooks').performance) {
  const filename = path.join(__dirname, '../../build/server/domain/runtime/badcase-capture/windows-git-candidate.js');
  const local = require('node:module').createRequire(filename), exports = {};
  require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, module: { exports }, Buffer, Map, Set, structuredClone,
    require: name => name === './windows-estimate' ? { prepareWindowsMetadataScope: scope }
      : name === './windows-helper' ? { invokeWindowsHelper: helper, invokeWindowsGitHelper: helper, encodeWindowsHelperRequest: encode, WINDOWS_HELPER_LIMITS: limits }
        : name === 'node:perf_hooks' ? { performance: clock } : local(name) }, { filename });
  return exports;
}
test('async Git chain accepts only finite outer deadlines, never extends its own cap or consumes late data', async () => {
  let now = 100, scopes = 0, calls = 0;
  const api = isolated(() => { scopes++; return scope(); }, async (_python, _helper, _request, deadline) => {
    calls++; assert.equal(deadline, 150); now = 150;
    return { get ok() { assert.fail('late metadata consumed'); } };
  }, { now: () => now });
  assert.equal((await api.readWindowsGitFileCandidateAsync({ deadline: 150, policy: { includedIgnoredPatterns: [] } })).reason, 'git_capture_timeout');
  assert.equal(calls, 1); assert.equal(scopes, 1);
  for (const deadline of [100, -1, NaN, Infinity, '150']) {
    now = 100; assert.equal((await api.readWindowsGitFileCandidateAsync({ deadline })).ok, false);
  }
  assert.equal(calls, 1); assert.equal(scopes, 1, 'expired/invalid requests cannot compile or read scope');
  now = 100;
  const cap = isolated(scope, async (_p, _h, _r, deadline) => { assert.equal(deadline, 25100); return { ok: false, reason: 'expected' }; }, { now: () => now });
  assert.equal((await cap.readWindowsGitFileCandidateAsync({ deadline: 100000, policy: { includedIgnoredPatterns: [] } })).reason, 'expected');
});

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
  for (const text of ['[include]\npath = ../private\n', '[core]\nignorecase = unknown\n', '[core]\nexcludesfile = ../private\n']) {
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
  // Cover the ENTIRE observed non-Git tree, not just selected content.
  const { WINDOWS_HELPER_SOURCE_SHA256 } = require('../../build/server/domain/runtime/badcase-capture/windows-helper-source');
  assert.equal(value.observation.scopeHash, hash(JSON.stringify({ request: scope().request, helperSha256: WINDOWS_HELPER_SOURCE_SHA256 })));
  assert.deepEqual([...value.observation.presentPaths], first.entries.filter(e => e.path !== '.git' && !e.path.startsWith('.git/')).map(e => e.path));
  assert.ok(value.observation.presentPaths.includes('ignored.log'));
  assert.equal(value.files['tracked.log'].mode, 0o100755);
  assert.equal(value.files.untracked.secretExcluded, true); assert.equal(value.blobs.has(hash(secret)), false);
  assert.equal(value.blobs.get(hash(safe)).buffer.byteLength, 1);
  assert.equal(Buffer.from(value.blobs.get(hash(safe)).buffer).includes(secret), false);
  for (const name of ['complete', 'strictEvalEligible', 'captureAvailable']) assert.equal(value[name], false);
  const rejected = api(true).readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } });
  assert.equal(rejected.reason, 'git_metadata_changed'); assert.equal(Object.hasOwn(rejected, 'files'), false);
  assert.equal(Object.hasOwn(rejected, 'observation'), false, 'a changed tree cannot emit absence evidence');
  let metaCount = 0;
  const hashChange = isolated(scope, (_, __, req) => {
    if (req.op !== 'gitMetadata') return response;
    return ++metaCount === 1 ? first : { ...first, files: first.files.map(f => ({ ...f, sha256: '0'.repeat(64) })) };
  });
  assert.equal(hashChange.readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } }).reason, 'git_metadata_changed');
  const mismatch = isolated(scope, (_, __, req) => req.op === 'gitMetadata' ? first : { ...response, entries: [] });
  assert.equal(mismatch.readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } }).reason, 'git_metadata_changed');
});

test('classified preview brackets Git sources without ordinary content reads or CAS plans and respects selection byte limits', async () => {
  const run = async (before, changed = false) => {
    let reads = 0;
    const api = isolated(scope, async (_p, _h, request) => {
      assert.equal(request.op, 'gitMetadata', 'pre-enable preview must never request selectedSnapshot');
      return ++reads === 2 && changed ? metadata({ entries: [...before.entries, entry('late')] }) : before;
    });
    const result = await api.estimateWindowsGitDirectoryAsync({ policy: { includedIgnoredPatterns: [] } });
    return { result, reads };
  };
  const { result, reads } = await run(metadata());
  assert.equal(result.ok, true, result.reason); assert.equal(reads, 2);
  assert.equal(result.fileCount, 3); assert.equal(result.totalBytes, 8);
  assert.equal(result.captureAvailable, false, 'metadata primitive cannot authorize the host runtime'); assert.equal(result.complete, true); assert.equal(result.strictEvalEligible, false);
  assert.ok(result.limitations.includes('content_not_scanned'));
  for (const key of ['files', 'blobs', 'observation', 'indexDeletions']) assert.equal(Object.hasOwn(result, key), false);
  assert.equal((await run(metadata(), true)).result.reason, 'git_metadata_changed');
  const large = metadata(); large.entries.push(entry('huge', 'file', String(limits.fileBytes + 1)));
  assert.equal((await run(large)).result.reason, 'too_large');
  const aggregate = metadata();
  for (const name of ['big-a', 'big-b', 'big-c']) aggregate.entries.push(entry(name, 'file', String(49 * 1024 * 1024)));
  assert.equal((await run(aggregate)).result.reason, 'too_large');
});

function missingCandidate(names, { excluded = [], extra = [], ignoreCase = false, changeAfter = false } = {}) {
  const first = metadata();
  first.files.find(f => f.path === '.git/index').content = gitIndex(names);
  first.files.find(f => f.path === '.git/config').content = Buffer.from(`[core]\nignorecase = ${ignoreCase}\n`);
  for (const f of first.files) {
    f.size = String(f.content.length); f.sha256 = hash(f.content);
    first.entries.find(e => e.path === f.path).size = f.size;
  }
  first.entries.push(...extra);
  let reads = 0;
  return isolated(() => ({ ...scope(), request: { ...scope().request, excluded } }), (_, __, req) => {
    if (req.op === 'gitMetadata') return ++reads === 2 && changeAfter ? metadata() : first;
    return { ok: true, entries: first.entries.filter(e => !e.path.startsWith('.git/') && e.path !== '.git'), files: [] };
  }).readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } });
}

test('verified index records first-checkpoint visible ASCII absences, never case or type replacements', () => {
  for (const ignoreCase of [false, true]) {
    const r = missingCandidate(['z.log', 'dir/gone.txt', 'TRACKED.LOG', 'now-dir', 'parent/child', 'a.txt'], {
      ignoreCase, extra: [entry('now-dir', 'directory'), entry('parent')],
    });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual([...r.indexDeletions], ['a.txt', 'dir/gone.txt', 'z.log']);
    assert.ok(r.limitations.includes('indexed_deletions_visible_ascii_only'));
    assert.equal(r.complete, false); assert.equal(r.strictEvalEligible, false);
  }
  const changed = missingCandidate(['gone'], { changeAfter: true });
  assert.equal(changed.ok, false); assert.equal(Object.hasOwn(changed, 'indexDeletions'), false);
});

test('indexed absence preserves uppercase disk names for lowercase index names in both Git case modes', () => {
  for (const ignoreCase of [false, true]) {
    const r = missingCandidate(['x.log'], { ignoreCase, extra: [entry('X.LOG')] });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.indexDeletionsVerified, true);
    assert.deepEqual([...r.indexDeletions], []);
    assert.ok(r.observation.presentPaths.includes('X.LOG'));
  }
});

test('indexed absence excludes native deny names, explicit/protected prefixes and short-name uncertainty', () => {
  // Keep the host conservative visibility predicate synchronized with the fixed
  // native pruning policy; source drift must fail before another release.
  const source = require('../../build/server/domain/runtime/badcase-capture/windows-helper-source').WINDOWS_HELPER_SOURCE;
  const deny = [...source.match(/METADATA_DENY_NAMES = \(([\s\S]*?)\)/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(deny, ['.git', '.pi', '.pi-sandbox', '.ssh', '.aws', '.azure', '.gnupg', '.env', 'auth.json', 'credentials.json']);
  // .git paths are already rejected by the independent index parser.
  const blocked = deny.filter(p => p !== '.git').flatMap(p => [p, `nested/${p}/hidden`]);
  const r = missingCandidate([...blocked, '.ENV.dev', 'nested/.env.prod', 'PRIVATE/file', 'storage/blob', 'LONGNA~1/file', 'privates/safe', 'good.txt'], {
    excluded: ['private', 'storage'],
  });
  assert.equal(r.ok, true, r.reason); assert.deepEqual([...r.indexDeletions], ['good.txt', 'privates/safe']);
  const control = missingCandidate(['PRIVATE/file', 'storage/blob', 'good.txt']);
  assert.deepEqual([...control.indexDeletions], ['PRIVATE/file', 'good.txt', 'storage/blob']);
});

test('Unicode visibility uncertainty suppresses index deletion inference, not ordinary capture', () => {
  for (const options of [{ excluded: ['caf\u00e9'] }, { extra: [entry('caf\u00e9')] }]) {
    const r = missingCandidate(['gone'], options); assert.equal(r.ok, true, r.reason);
    assert.deepEqual([...r.indexDeletions], []);
    assert.ok(r.limitations.includes('indexed_deletions_namespace_unverified'));
  }
  const r = missingCandidate(['caf\u00e9', 'gone']); assert.equal(r.ok, true, r.reason);
  assert.deepEqual([...r.indexDeletions], []); assert.equal(r.indexDeletionsVerified, false);
  // Even ignorecase=false must not infer ambiguous NT component identities.
  const ambiguous = missingCandidate(['Dir/one', 'dir/two']);
  assert.equal(ambiguous.ok, true); assert.deepEqual([...ambiguous.indexDeletions], []);
});

test('indexed deletion output is bounded and cannot return a partial batch', () => {
  assert.equal(missingCandidate(Array.from({ length: 2048 }, (_, i) => `gone-${i}`)).indexDeletions.length, 2048);
  const r = missingCandidate(Array.from({ length: 2049 }, (_, i) => `gone-${i}`));
  assert.equal(r.reason, 'git_deletion_limit'); assert.equal(Object.hasOwn(r, 'files'), false);
  assert.equal(Object.hasOwn(r, 'indexDeletions'), false);
});

test('observation scope binds native root identity, literal root, exclusions and fixed helper source', () => {
  const first = metadata();
  function read(request) {
    return isolated(() => ({ ...scope(), request }), (_, __, req) => req.op === 'gitMetadata' ? first
      : { ok: true, entries: first.entries.filter(e => e.path !== '.git' && !e.path.startsWith('.git/')), files: [] })
      .readWindowsGitFileCandidate({ policy: { includedIgnoredPatterns: [] } });
  }
  const initial = read(scope().request);
  assert.equal(initial.ok, true); assert.match(initial.observation.scopeHash, /^[a-f0-9]{64}$/);
  for (const change of [{ root: 'C:/other' }, { expected: { ...identity, fileId: 'b'.repeat(32) } }, { excluded: ['private'] }]) {
    const changed = read({ ...scope().request, ...change });
    assert.equal(changed.ok, true); assert.notEqual(changed.observation.scopeHash, initial.observation.scopeHash);
  }
});

test('async Git candidate shares one 25s deadline across classification, selection and revalidation; no sync fallback', async () => {
  let time = 50, calls = 0;
  const first = metadata(), deadlines = [], ops = [];
  const api = isolated(scope, async (_, __, req, deadline) => {
    calls++; deadlines.push(deadline); ops.push(req.op);
    time += 100;
    return req.op === 'gitMetadata' ? first : { ok: true, entries: first.entries.filter(e => e.path !== '.git' && !e.path.startsWith('.git/')),
      files: req.paths.map(p => ({ path: p, size: '1', sha256: hash('x'), content: Buffer.from('x') })) };
  }, { now: () => time });
  const value = await api.readWindowsGitFileCandidateAsync({ policy: { includedIgnoredPatterns: [] } });
  assert.equal(value.ok, true, value.reason);
  assert.deepEqual(ops, ['gitMetadata', 'selectedSnapshot', 'gitMetadata']);
  assert.deepEqual(deadlines, [25050, 25050, 25050]);
  assert.equal(value.files['tracked.log'].mode, 0o100755);
  for (const key of ['complete', 'strictEvalEligible', 'captureAvailable']) assert.equal(value[key], false);
  assert.ok(value.limitations.includes('async_git_chain_25s_observed_deadline'));
  assert.equal(calls, 3);
  // Every terminal failure stops the chain and exposes neither files nor blobs.
  for (const failAt of [1, 2, 3]) {
    let n = 0;
    const refused = isolated(scope, async (_, __, req) => {
      if (++n === failAt) return { ok: false, reason: 'snapshot_changed' };
      return req.op === 'gitMetadata' ? first : { ok: true, entries: first.entries.filter(e => !e.path.startsWith('.git/') && e.path !== '.git'), files: [] };
    }, { now: () => 0 });
    const result = await refused.readWindowsGitFileCandidateAsync({ policy: { includedIgnoredPatterns: [] } });
    assert.equal(result.reason, 'snapshot_changed'); assert.equal(n, failAt);
    assert.equal(Object.hasOwn(result, 'files'), false); assert.equal(Object.hasOwn(result, 'blobs'), false);
  }
});

test('async Git candidate checks elapsed scope/parsing time and late helper success without extending budget', async () => {
  const first = metadata();
  for (const expiresAt of ['scope', 1, 2, 3, 'blobs']) {
    let time = 0, calls = 0;
    const api = isolated(() => { if (expiresAt === 'scope') time = 25000; return scope(); }, async (_, __, req) => {
      if (++calls === expiresAt) time = 25000;
      const files = req.op === 'gitMetadata' ? first.files : [{ path: 'tracked.log', size: '1', sha256: hash('x'),
        get content() { if (expiresAt === 'blobs') time = 25000; return Buffer.from('x'); } }];
      return { ...first, entries: req.op === 'gitMetadata' ? first.entries : first.entries.filter(e => !e.path.startsWith('.git/') && e.path !== '.git'), files };
    }, { now: () => time });
    const result = await api.readWindowsGitFileCandidateAsync({ policy: { includedIgnoredPatterns: [] } });
    assert.equal(result.reason, 'git_capture_timeout', String(expiresAt));
    assert.equal(calls, expiresAt === 'scope' ? 0 : expiresAt === 'blobs' ? 3 : expiresAt);
    assert.equal(Object.hasOwn(result, 'files'), false); assert.equal(Object.hasOwn(result, 'blobs'), false);
  }
  let lateTime = 0, lateReads = 0;
  const lateMetadata = metadata();
  const lateConfig = lateMetadata.files.find(f => f.path === '.git/config');
  Object.defineProperty(lateConfig, 'content', { get() { lateReads++; return Buffer.from('[core]\nignorecase = false\n'); } });
  const late = isolated(scope, async () => { lateTime = 25000; return lateMetadata; }, { now: () => lateTime });
  assert.equal((await late.readWindowsGitFileCandidateAsync({ policy: { includedIgnoredPatterns: [] } })).reason, 'git_capture_timeout');
  assert.equal(lateReads, 0, 'a late response is discarded before classification/content scanning');
  let parseTime = 0, parseCalls = 0;
  const slowMetadata = metadata();
  const config = slowMetadata.files.find(f => f.path === '.git/config');
  Object.defineProperty(config, 'content', { get() { parseTime = 25000; return Buffer.from('[core]\nignorecase = false\n'); } });
  const parsing = isolated(scope, async () => { parseCalls++; return slowMetadata; }, { now: () => parseTime });
  assert.equal((await parsing.readWindowsGitFileCandidateAsync({ policy: { includedIgnoredPatterns: [] } })).reason, 'git_capture_timeout');
  assert.equal(parseCalls, 1, 'expired synchronous classification cannot start selection');
  let calls = 0;
  const bad = isolated(() => ({ ok: false, reason: 'unpinned' }), async () => { calls++; });
  assert.equal((await bad.readWindowsGitFileCandidateAsync({})).reason, 'unpinned'); assert.equal(calls, 0);
  const unsupported = isolated(scope, async () => { calls++; return metadata({ files: [] }); });
  assert.equal((await unsupported.readWindowsGitFileCandidateAsync({ policy: { includedIgnoredPatterns: [] } })).reason, 'git_metadata_missing');
  assert.equal(calls, 1);
});

function transport({ behavior, clock, timers, spawnOverride, replace = s => s } = {}) {
  const file = path.join(__dirname, '../../build/server/domain/runtime/badcase-capture/windows-helper.js');
  const local = require('node:module').createRequire(file), exports = {}, children = [];
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  require('node:vm').runInNewContext(replace(fs.readFileSync(file, 'utf8')), { exports, module: { exports }, Buffer,
    process: { platform: 'win32' }, setTimeout: timers?.setTimeout || setTimeout, clearTimeout: timers?.clearTimeout || clearTimeout,
    require: name => name === 'node:child_process' ? { spawn(python, args, options) {
      if (spawnOverride) { const c = spawnOverride(python, args, options); children.push(c); return c; }
      const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kills = 0;
      c.kill = signal => { assert.equal(signal, 'SIGKILL'); c.kills++; return true; };
      c.stdin.on('finish', () => behavior(c, { python, args, options })); children.push(c); return c;
    } } : name === 'node:perf_hooks' && clock ? { performance: clock } : local(name),
  }, { filename: file });
  return { api: exports, children };
}

function helperFile(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wingit-async-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, 'helper.py');
  fs.writeFileSync(file, require('../../build/server/domain/runtime/badcase-capture/windows-helper-source').WINDOWS_HELPER_SOURCE);
  return file;
}
const empty = () => wire([], []);

test('async Git transport closed ops, bound output, integrity before spawn and admission held until close', async t => {
  const file = helperFile(t), req = { ...baseRequest, op: 'gitMetadata' };
  let behavior = c => { c.stdout.emit('data', empty()); c.emit('close', 0); };
  const { api, children } = transport({ behavior: (...args) => behavior(...args), clock: { now: () => 0 },
    replace: s => s.replace('headerBytes: 32 * 1024 * 1024', 'headerBytes: 512').replace('bodyBytes: 128 * 1024 * 1024', 'bodyBytes: 8') });
  t.after(() => { for (const c of children) c.emit('close', 1); });
  const run = (request = req, deadline = 25000) => api.invokeWindowsGitHelper('python', file, request, deadline);
  for (const op of ['identity', 'capture', 'estimate', 'snapshot']) assert.equal((await run({ ...baseRequest, op })).reason, 'request_invalid');
  for (const deadline of [0, -1, 25001, Infinity, NaN, '25000']) assert.equal((await run(req, deadline)).reason, 'git_capture_timeout');
  assert.equal(children.length, 0);
  const original = fs.readFileSync(file);
  for (const bytes of [Buffer.from('# modified'), Buffer.alloc(1024 * 1024 + 1)]) {
    fs.writeFileSync(file, bytes);
    assert.equal((await run()).reason, 'helper_integrity_failed');
  }
  assert.equal(children.length, 0); fs.writeFileSync(file, original);
  assert.equal((await run()).ok, true);
  for (const [act, why] of [
    [c => { c.stderr.emit('data', Buffer.from('PRIVATE_SENTINEL')); c.emit('close', 0); }, 'helper_process_failed'],
    [c => { c.stdout.emit('data', Buffer.alloc(522)); c.emit('close', 0); }, 'git_capture_output_limit'],
    [c => { c.emit('error', Error('PRIVATE_SENTINEL')); c.emit('close', 0); }, 'helper_process_failed'],
    [c => c.emit('close', 1), 'helper_process_failed'],
    [c => { c.kill = () => false; c.stderr.emit('data', Buffer.from('PRIVATE_SENTINEL')); c.emit('close', 0); }, 'git_capture_cleanup_failed'],
    [c => { c.kill = () => { throw Error('PRIVATE_SENTINEL'); }; c.stderr.emit('data', Buffer.from('x')); c.emit('close', 0); }, 'git_capture_cleanup_failed'],
    [c => { c.stdout.emit('data', Buffer.from('invalid')); c.emit('close', 0); }, 'helper_output_invalid'],
  ]) {
    behavior = act; const result = await run(); assert.equal(result.reason, why);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
  }
  let pendingCount = 0;
  behavior = c => { if (++pendingCount > 2) { c.stdout.emit('data', empty()); c.emit('close', 0); } };
  const a = run(), b = run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await run()).reason, 'git_capture_busy');
  const [one, two] = children.slice(-2);
  one.stderr.emit('data', Buffer.from('PRIVATE_SENTINEL'));
  assert.equal(one.kills, 1);
  assert.equal((await run()).reason, 'git_capture_busy', 'kill is not close; permit must remain held');
  one.emit('close', 0); two.stdout.emit('data', empty()); two.emit('close', 0);
  assert.equal((await a).reason, 'helper_process_failed'); assert.equal((await b).ok, true);
  behavior = (c, info) => {
    assert.equal(info.python, 'python'); assert.deepEqual([...info.args], ['-I', '-B', file]);
    assert.deepEqual([...info.options.stdio], ['pipe', 'pipe', 'pipe']);
    c.stdout.emit('data', empty()); c.emit('close', 0);
  };
  assert.equal((await run()).ok, true);
});

test('async Git transport timer uses remaining shared deadline and late output cannot become success', async t => {
  const file = helperFile(t), req = { ...baseRequest, op: 'selectedSnapshot', paths: [] };
  for (const mode of ['timely', 'late', 'timer']) {
    let time = 20000, callback, clears = 0;
    const { api, children } = transport({ clock: { now: () => time },
      timers: { setTimeout(fn, ms) { assert.equal(ms, 5000); callback = fn; return 'owned'; },
        clearTimeout(id) { assert.equal(id, 'owned'); clears++; } },
      behavior(c) {
        if (mode === 'timer') callback();
        time = mode === 'late' ? 25000 : 20001;
        c.stdout.emit('data', empty()); c.emit('close', 0);
      } });
    const result = await api.invokeWindowsGitHelper('python', file, req, 25000);
    assert.equal(result.ok, mode === 'timely');
    if (mode !== 'timely') assert.equal(result.reason, 'git_capture_timeout');
    assert.equal(clears, 1); assert.equal(children[0].kills, mode === 'timer' ? 1 : 0);
  }
});

test('async Git transport refuses expiry during integrity check and spawn throw without leaking capacity', async t => {
  const file = helperFile(t), req = { ...baseRequest, op: 'gitMetadata' };
  const ticks = [0, 25000];
  const expired = transport({ clock: { now: () => ticks.shift() ?? 25000 }, behavior() {} });
  assert.equal((await expired.api.invokeWindowsGitHelper('python', file, req, 25000)).reason, 'git_capture_timeout');
  assert.equal(expired.children.length, 0);
  let throws = true, spawns = 0;
  const instance = transport({ clock: { now: () => 0 }, spawnOverride() {
    spawns++;
    if (throws) throw Error('PRIVATE_SENTINEL');
    const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
    const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.stdin.on('finish', () => { c.stdout.emit('data', empty()); c.emit('close', 0); }); return c;
  } });
  for (let n = 0; n < 3; n++) {
    const result = await instance.api.invokeWindowsGitHelper('python', file, req, 25000);
    assert.equal(result.reason, 'helper_process_failed'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
  }
  throws = false;
  assert.equal((await instance.api.invokeWindowsGitHelper('python', file, req, 25000)).ok, true); assert.equal(spawns, 4);
});

test('async Git transport rejects success whose wire validation consumes remaining budget', async t => {
  const file = helperFile(t), ticks = [0, 0, 0, 24999, 25000];
  const { api } = transport({ clock: { now: () => ticks.shift() ?? 25000 },
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
    behavior(c) { c.stdout.emit('data', empty()); c.emit('close', 0); } });
  const result = await api.invokeWindowsGitHelper('python', file, { ...baseRequest, op: 'gitMetadata' }, 25000);
  assert.equal(result.reason, 'git_capture_timeout');
});

test('async Git transport real sleeper does not block loop, terminates and waits for actual close', native, async t => {
  const file = helperFile(t), http = require('node:http');
  const server = http.createServer((_, response) => response.end('isolated-ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let closed = false, child;
  const { api } = transport({ spawnOverride() {
    // Test-only chosen child/short deadline. This proves transport termination,
    // not that the audited Python helper really hung or a process-tree sandbox.
    child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.on('close', () => { closed = true; });
    return child;
  } });
  t.after(() => { if (child && !closed) child.kill('SIGKILL'); });
  const pending = api.invokeWindowsGitHelper('python', file, { ...baseRequest, op: 'gitMetadata' },
    require('node:perf_hooks').performance.now() + 1500);
  const healthy = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}`, response => {
    let body = ''; response.on('data', b => { body += b; }); response.on('end', () => resolve(body));
  }).on('error', reject));
  assert.equal(healthy, 'isolated-ok'); assert.equal(closed, false, 'health completes while child is still alive');
  assert.equal((await pending).reason, 'git_capture_timeout'); assert.equal(closed, true, 'not returned before actual child close');
});

test('native local Git subset selects dirty/tracked/untracked/explicit ignored, blocks external Git metadata', native, async t => {
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
  fs.writeFileSync(path.join(root, 'secret-sentinel'), 'sk-SENTINELabcdefghijk');
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
  const asyncValue = await readWindowsGitFileCandidateAsync(options()); assert.equal(asyncValue.ok, true, asyncValue.reason);
  assert.deepEqual(asyncValue.files, value.files); assert.deepEqual(asyncValue.blobs, value.blobs);
  assert.ok(asyncValue.limitations.includes('async_git_chain_25s_observed_deadline'));
  assert.equal(asyncValue.files['secret-sentinel'].secretExcluded, true);
  assert.equal(asyncValue.blobs.has(hash('sk-SENTINELabcdefghijk')), false);
  const oracle = git('ls-files', '-c', '-o', '--exclude-standard', '-z').split('\0').filter(Boolean).concat('included.log').sort();
  assert.deepEqual(Object.keys(value.files).sort(), oracle);
  assert.equal(value.files['tracked.log'].hash, hash('dirty')); assert.equal(value.blobs.has(hash('IGNORED_NOT_AUTHORIZED')), false);
  assert.equal(value.files.untracked.hash, hash('new')); assert.equal(value.files['included.log'].hash, hash('included'));
  assert.equal(service.store.listCheckpoints('p').length, 0); assert.equal(service.loadPolicy('p').status, 'disabled');
  // E115 P3: pin the reverse case-only direction using real NTFS spelling.
  fs.writeFileSync(path.join(root, 'x.log'), 'case-only'); git('add', '-f', 'x.log');
  fs.renameSync(path.join(root, 'x.log'), path.join(root, 'case-temp'));
  fs.renameSync(path.join(root, 'case-temp'), path.join(root, 'X.LOG'));
  assert.ok(fs.readdirSync(root).includes('X.LOG'));
  for (const ignoreCase of ['false', 'true']) {
    git('config', 'core.ignorecase', ignoreCase);
    const caseOnly = await readWindowsGitFileCandidateAsync(options());
    assert.equal(caseOnly.ok, true, caseOnly.reason);
    assert.equal(caseOnly.indexDeletionsVerified, true);
    assert.equal(caseOnly.indexDeletions.includes('x.log'), false);
    assert.equal(caseOnly.files['X.LOG'].hash, hash('case-only'));
  }
  git('config', 'core.ignorecase', 'false');
  // Default exclusion of .git is not overridden merely to make classification work.
  service.savePolicy('p', { ...service.loadPolicy('p'), excludedPatterns: ['.git'] });
  assert.equal(readWindowsGitFileCandidate(options()).ok, false);
  service.savePolicy('p', { ...service.loadPolicy('p'), excludedPatterns: [] });
  fs.renameSync(path.join(root, '.git'), path.join(base, 'external-git'));
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../external-git\n');
  assert.equal(readWindowsGitFileCandidate(options()).reason, 'git_metadata_unsupported');
  assert.equal(service.store.listCheckpoints('p').length, 0);
});
