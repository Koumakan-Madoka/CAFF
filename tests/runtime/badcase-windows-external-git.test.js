const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const identity = { volumeSerial: '1', fileId: 'a'.repeat(32), creationTime: '2' };
const { encodeWindowsHelperRequest: encode } = require('../../build/server/domain/runtime/badcase-capture/windows-helper');
const filename = path.join(__dirname, '../../build/server/domain/runtime/badcase-capture/windows-git-candidate.js');
const local = require('node:module').createRequire(filename);
const roots = { metadataRoot: 'C:/main/.git/worktrees/w', commonRoot: 'C:/main/.git' };
const key = p => path.win32.resolve(p).toLowerCase();
function index(names) {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(names.length, 8);
  const chunks = names.map(name => {
    const bytes = Buffer.from(name), e = Buffer.alloc(Math.ceil((63 + bytes.length) / 8) * 8);
    e.writeUInt32BE(0o100755, 24); e.writeUInt16BE(bytes.length, 60); bytes.copy(e, 62); return e;
  });
  const bytes = Buffer.concat([header, ...chunks]); return Buffer.concat([bytes, crypto.createHash('sha1').update(bytes).digest()]);
}
function fixture() {
  const record = (p, b) => ({ path: p, size: String(b.length), sha256: hash(b), identity, content: b });
  const sources = new Map([['commondir', Buffer.from('../..\r\n')], ['gitdir', Buffer.from('C:/w/.git\n')],
    ['index', index(['tracked.log', 'deleted'])], ['config', Buffer.from('[core]\nignorecase = false\n')],
    ['info/exclude', Buffer.from('*.tmp\r\n')]]);
  const files = [record('.git', Buffer.from('gitdir: C:/main/.git/worktrees/w\r\n')),
    record('.gitignore', Buffer.from('*.log\n'))];
  const names = ['.git', '.gitignore', 'ignored.log', 'included.log', 'tracked.log', 'untracked', 'private.tmp'];
  const entries = names.map(p => ({ path: p, type: 'file', size: files.find(f => f.path === p)?.size || '1', identity, lastWriteTime: '0', changeTime: '0' }));
  const policy = { includedIgnoredPatterns: ['included.log'], authorizedInputDirs: Object.values(roots),
    authorizedInputPins: Object.fromEntries(Object.values(roots).map(p => [key(p), { realpath: p, identity: { ...identity } }])) };
  return { sources, before: { ok: true, identity, entries, files }, policy, record };
}
function isolated({ tree, read, replace = s => s, clock = { now: () => 0 }, scope = () => ({ ok: true, helperPath: 'fixed', request: {
  version: 1, op: 'estimate', root: 'C:/w', expected: identity, excluded: [] } }) }) {
  const exports = {};
  require('node:vm').runInNewContext(replace(fs.readFileSync(filename, 'utf8')), { exports, module: { exports }, Buffer, Map, Set, structuredClone,
    require: name => name === './windows-estimate' ? { prepareWindowsMetadataScope: scope }
      : name === './windows-helper' ? { encodeWindowsHelperRequest: encode, invokeWindowsGitHelper: tree,
        invokeWindowsHelper() { assert.fail('no synchronous fallback'); } }
        : name === './windows-git-input' ? { readWindowsGitMetadataInput: read }
          : name === 'node:perf_hooks' ? { performance: clock } : local(name) }, { filename });
  return exports;
}
function harness(f, adjust = {}) {
  const ops = [], requests = [];
  const api = isolated({ tree: async (_p, _h, request, deadline) => {
    ops.push(request.op); assert.equal(deadline, 25000);
    if (request.op === 'gitMetadata') return f.before;
    assert.equal(request.op, 'selectedSnapshot');
    return { ok: true, entries: f.before.entries.filter(e => e.path !== '.git'), files: request.paths.map(p => f.record(p,
      Buffer.from(p === 'untracked' ? 'sk-SENTINELabcdefghijk' : p === 'tracked.log' ? 'dirty' : 'safe'))) };
  }, read: async opts => {
    requests.push(opts); ops.push(opts.metadataPath); assert.equal(opts.deadline, 25000);
    return { ok: true, content: f.sources.get(opts.metadataPath) };
  }, ...adjust });
  return { api, ops, requests, run: (opts = {}) => api.readWindowsGitFileCandidateAsync({ policy: f.policy, targetDir: 'C:/w',
    captureRoot: 'C:/capture', externalGit: roots, ...opts }) };
}

test('explicit external roots bind gitfile/commondir/backlink before classified reads and are revalidated afterwards', async () => {
  const f = fixture(), h = harness(f), r = await h.run({ agentDir: 'C:/agent', privateDirs: ['C:/private'] });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.classification, 'bounded_external_git_subset_v1');
  assert.deepEqual(Object.keys(r.files).sort(), ['.gitignore', 'included.log', 'tracked.log', 'untracked']);
  assert.equal(r.files['tracked.log'].mode, 0o100755); assert.equal(r.files['tracked.log'].hash, hash('dirty'));
  assert.equal(r.files.untracked.secretRedacted, true); assert.equal(r.blobs.has(hash('sk-SENTINELabcdefghijk')), false);
  assert.equal(r.blobs.get(r.files.untracked.hash).toString(), '[*]');
  assert.equal(r.blobs.get(hash('dirty')).buffer.byteLength, 5);
  assert.deepEqual(h.ops, ['gitMetadata', 'commondir', 'gitdir', 'config', 'index', 'info/exclude', 'selectedSnapshot',
    'gitMetadata', 'commondir', 'gitdir', 'config', 'index', 'info/exclude']);
  for (const opts of h.requests) {
    assert.equal(opts.metadataRoot, ['commondir', 'gitdir', 'index'].includes(opts.metadataPath) ? roots.metadataRoot : roots.commonRoot);
    assert.equal(opts.captureRoot, 'C:/capture'); assert.deepEqual([...opts.privateDirs], ['C:/private', 'C:/agent']);
  }
  for (const k of ['complete', 'strictEvalEligible', 'captureAvailable']) assert.equal(r[k], false);
  assert.ok(r.limitations.includes('external_info_exclude_required'));
  assert.ok(r.limitations.includes('deletion_history_not_collected'));
  assert.equal(Object.hasOwn(r.files, 'deleted'), false);
  assert.deepEqual([...r.indexDeletions], ['deleted']);
});

test('external selection requires BOTH exact independent root grants and original valid pins; no pointer-derived grants', async () => {
  for (const mutation of [
    f => f.policy.authorizedInputDirs.pop(), f => f.policy.authorizedInputDirs.shift(),
    f => { f.policy.authorizedDirs = Object.values(roots); f.policy.authorizedInputDirs = []; },
    f => { f.policy.authorizedInputDirs = ['C:/main']; },
    f => { delete f.policy.authorizedInputPins[key(roots.commonRoot)]; },
    f => { f.policy.authorizedInputPins[key(roots.metadataRoot)].realpath = 'C:/alias'; },
    f => { f.policy.authorizedInputPins[key(roots.commonRoot)].identity.fileId = 'bad'; },
  ]) {
    const f = fixture(); mutation(f); const h = harness(f), r = await h.run();
    assert.equal(r.reason, 'git_external_not_authorized'); assert.deepEqual(h.ops, ['gitMetadata']);
    assert.equal(Object.hasOwn(r, 'files'), false);
  }
  for (const externalGit of [null, {}, { ...roots, extra: true }, { ...roots, commonRoot: '\\\\host\\share' },
    { ...roots, commonRoot: 'C:relative' }, { ...roots, commonRoot: roots.metadataRoot }, { ...roots, metadataRoot: 'C:/w/nested' }]) {
    const h = harness(fixture()); assert.equal((await h.run({ externalGit })).ok, false); assert.deepEqual(h.ops, ['gitMetadata']);
  }
});

test('external roots inside the worktree and an external selection on a directory marker are rejected before input reads', async () => {
  const f = fixture(), selected = { ...roots, metadataRoot: 'C:/w/nested' };
  f.policy.authorizedInputDirs.push(selected.metadataRoot);
  f.policy.authorizedInputPins[key(selected.metadataRoot)] = { realpath: selected.metadataRoot, identity };
  f.before.files[0].content = Buffer.from('gitdir: C:/w/nested\n');
  let h = harness(f); assert.equal((await h.run({ externalGit: selected })).reason, 'git_external_not_authorized'); assert.deepEqual(h.ops, ['gitMetadata']);
  const directory = fixture(); directory.before.entries.find(e => e.path === '.git').type = 'directory';
  h = harness(directory); assert.equal((await h.run()).reason, 'git_external_pointer_invalid'); assert.deepEqual(h.ops, ['gitMetadata']);
});

test('external gitfile pointers are strict UTF8 single lines, compared only to explicit selected roots before external reads', async () => {
  for (const text of ['gitdir: C:/other\n', 'gitdir: \\\\host\\share\n', 'gitdir: C:relative\n', 'gitdir: /main/.git\n',
    'gitdir: C:/main/.git/worktrees/w\nextra\n', 'gitdir: C:/main/.git/worktrees/w\0\n',
    '\ufeffgitdir: C:/main/.git/worktrees/w\n', 'gitdir: C:/' + 'a/../'.repeat(6600) + 'main/.git/worktrees/w', '', Buffer.from([255])]) {
    const f = fixture(); f.before.files[0].content = Buffer.isBuffer(text) ? text : Buffer.from(text);
    const h = harness(f), r = await h.run(); assert.equal(r.reason, 'git_external_pointer_invalid'); assert.deepEqual(h.ops, ['gitMetadata']);
  }
  const f = fixture(); f.before.files[0].content = Buffer.from('gitdir: ../main/.git/worktrees/w\r\n');
  assert.equal((await harness(f).run()).ok, true, 'relative gitfile resolves against worktree but never grants a new root');
});

test('normalization cannot erase forbidden pointer syntax into an otherwise matching root (E110 P3)', async () => {
  const resolve = (base, text) => path.win32.resolve(base, text).toLowerCase();
  for (const control of ['\x00', '\x01', '\x1f', '\x7f', '\ufeff']) {
    for (const field of ['marker', 'commondir', 'gitdir']) {
      const f = fixture();
      const expected = field === 'marker' ? roots.metadataRoot : field === 'commondir' ? roots.commonRoot : 'C:/w/.git';
      const text = `${expected}/${control}/..`;
      assert.equal(resolve(field === 'marker' ? 'C:/w' : roots.metadataRoot, text), resolve('C:/', expected), 'only syntax guard can reject');
      if (field === 'marker') f.before.files[0].content = Buffer.from(`gitdir: ${text}\n`);
      else f.sources.set(field, Buffer.from(`${text}\n`));
      const h = harness(f), r = await h.run();
      assert.equal(r.reason, 'git_external_pointer_invalid', field);
      assert.deepEqual(h.ops, field === 'marker' ? ['gitMetadata'] : field === 'commondir' ? ['gitMetadata', 'commondir'] : ['gitMetadata', 'commondir', 'gitdir']);
      assert.equal(Object.hasOwn(r, 'blobs'), false);
    }
  }
  for (const text of [` ${roots.metadataRoot}`, `${roots.metadataRoot} `, 'C:../main/.git/worktrees/w', '/main/.git/worktrees/w']) {
    assert.equal(resolve('C:/w', text.trim()), resolve('C:/', roots.metadataRoot));
    const f = fixture(); f.before.files[0].content = Buffer.from(`gitdir: ${text}\n`);
    const h = harness(f); assert.equal((await h.run()).reason, 'git_external_pointer_invalid'); assert.deepEqual(h.ops, ['gitMetadata']);
  }
});

test('commondir and backlink mismatch/unsupported bytes stop before common config/index and ordinary file reads', async () => {
  for (const [p, bytes] of [['commondir', 'C:/other'], ['gitdir', 'C:/other/.git'], ['commondir', '../..\nextra'],
    ['gitdir', '/w/.git'], ['gitdir', 'C:relative'], ['commondir', 'sk-SENTINELabcdefghijk'], ['commondir', Buffer.from([255])]]) {
    const f = fixture(); f.sources.set(p, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); const h = harness(f), r = await h.run();
    assert.equal(r.ok, false); assert.ok(h.ops.includes(p), 'the intended external pointer was actually read');
    assert.ok(!h.ops.includes('config')); assert.ok(!h.ops.includes('index')); assert.ok(!h.ops.includes('selectedSnapshot'));
    assert.equal(Object.hasOwn(r, 'blobs'), false); assert.doesNotMatch(JSON.stringify(r), /SENTINEL/);
  }
});

test('external source failures, missing exclude, corrupt index or unsupported config never broaden to all files', async () => {
  for (const p of ['commondir', 'gitdir', 'config', 'index', 'info/exclude']) {
    const f = fixture(), h = harness(f, { read: async opts => opts.metadataPath === p ? { ok: false, reason: 'PRIVATE_SENTINEL', content: f.sources.get(p) }
      : { ok: true, content: f.sources.get(opts.metadataPath) } });
    const r = await h.run(); assert.equal(r.reason, 'git_external_input_unavailable'); assert.ok(!h.ops.includes('selectedSnapshot'));
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE_SENTINEL/);
  }
  for (const [p, value] of [['config', '[include]\npath = ../private\n'], ['config', '[core]\nignorecase = unknown\n'],
    ['config', '[extensions]\nworktreeconfig = true\n'], ['config', '[core]\nexcludesfile = ../secret\n'],
    ['index', 'broken'], ['info/exclude', '[[:alpha:]]'], ['config', 'sk-SENTINELabcdefghijk']]) {
    const f = fixture(); f.sources.set(p, Buffer.from(value)); const h = harness(f), r = await h.run();
    assert.equal(r.ok, false); assert.ok(!h.ops.includes('selectedSnapshot')); assert.equal(Object.hasOwn(r, 'files'), false);
  }
});

test('every external source is reread after selection; any changed content refuses all plans', async () => {
  for (const p of ['commondir', 'gitdir', 'config', 'index', 'info/exclude']) {
    const f = fixture(), counts = {};
    const h = harness(f, { read: async opts => {
      const n = counts[opts.metadataPath] = (counts[opts.metadataPath] || 0) + 1;
      return { ok: true, content: n === 2 && opts.metadataPath === p ? Buffer.concat([f.sources.get(p), Buffer.from('x')]) : f.sources.get(opts.metadataPath) };
    } });
    const r = await h.run(); assert.equal(r.ok, false, p); assert.ok(h.ops.includes('selectedSnapshot'));
    assert.equal(Object.hasOwn(r, 'files'), false); assert.equal(Object.hasOwn(r, 'blobs'), false);
  }
});

test('external chain locks selected roots/policy before await and never consumes a late external response', async () => {
  const f = fixture(); let resolve, requests = [], time = 0;
  const api = isolated({ tree: async (_p, _h, req) => {
    if (req.op === 'gitMetadata') return await new Promise(r => { resolve = r; });
    assert.fail('late external input cannot reach selection');
  }, read: async opts => {
    requests.push(opts); time = 25000;
    return { get ok() { assert.fail('late response consumed'); } };
  }, clock: { now: () => time } });
  const opts = { policy: f.policy, externalGit: { ...roots }, targetDir: 'C:/w', captureRoot: 'C:/capture' };
  const pending = api.readWindowsGitFileCandidateAsync(opts);
  opts.externalGit.commonRoot = 'C:/changed'; opts.policy.authorizedInputDirs = []; opts.targetDir = 'C:/changed';
  resolve(f.before);
  const r = await pending; assert.equal(r.reason, 'git_capture_timeout'); assert.equal(requests.length, 1);
  assert.equal(requests[0].metadataRoot, roots.metadataRoot); assert.equal(requests[0].deadline, 25000);
  assert.equal(requests[0].policy.authorizedInputDirs.length, 2);
  const sync = harness(fixture());
  assert.equal(sync.api.readWindowsGitFileCandidate({ externalGit: roots }).reason, 'git_external_async_required');
  assert.deepEqual(sync.ops, []);
  assert.equal(sync.api.readWindowsGitFileCandidate(null).reason, 'windows_git_candidate_unavailable');
  assert.equal(sync.api.readWindowsGitFileCandidate({ get externalGit() { throw Error('PRIVATE_SENTINEL'); } }).reason, 'windows_git_candidate_unavailable');
});

test('external read chain stops at every failure/late result and bounds aggregate metadata bytes', async () => {
  for (const failAt of Array.from({ length: 10 }, (_, i) => i + 1)) {
    for (const mode of ['refusal', 'late']) {
      const f = fixture(); let n = 0, time = 0;
      const h = harness(f, { clock: { now: () => time }, read: async opts => {
        assert.equal(opts.deadline, 25000);
        if (++n !== failAt) return { ok: true, content: f.sources.get(opts.metadataPath) };
        if (mode === 'refusal') return { ok: false, reason: 'PRIVATE_SENTINEL' };
        time = 25000; return { get ok() { assert.fail('late source consumed'); } };
      } });
      const r = await h.run(); assert.equal(r.reason, mode === 'late' ? 'git_capture_timeout' : 'git_external_input_unavailable');
      assert.equal(n, failAt); assert.equal(Object.hasOwn(r, 'blobs'), false); assert.equal(Object.hasOwn(r, 'files'), false);
    }
  }
  const f = fixture(), h = harness(f, { replace: s => s.replace('totalBytes > 128 * 1024 * 1024', 'totalBytes > 24') });
  assert.equal((await h.run()).reason, 'git_external_input_limit'); assert.ok(!h.ops.includes('selectedSnapshot'));
});

test('legacy offline linked-worktree classifies independently pinned external inputs, restores twice, refuses changed binding', {
  skip: process.platform !== 'win32' ? 'real Windows NTFS required' : false,
}, async t => {
  require('../helpers/windows-capture-environment').isolateWindowsCaptureEnvironment(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-winext-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, 'main'), work = path.join(base, 'work'), captureRoot = path.join(base, 'storage'); fs.mkdirSync(main);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'no-global'), GIT_TEMPLATE_DIR: '' };
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', windowsHide: true });
  git(main, 'init', '-q'); git(main, 'config', 'core.ignorecase', 'true'); git(main, 'config', 'user.name', 'fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(main, '.gitignore'), '*.log\n'); fs.writeFileSync(path.join(main, 'tracked.log'), 'original'); fs.writeFileSync(path.join(main, 'deleted'), 'gone');
  git(main, 'add', '-f', '.gitignore', 'tracked.log', 'deleted'); git(main, 'commit', '-qm', 'fixture'); git(main, 'worktree', 'add', '-qb', 'fixture-work', work);
  fs.writeFileSync(path.join(work, 'tracked.log'), 'dirty'); fs.rmSync(path.join(work, 'deleted'));
  fs.writeFileSync(path.join(work, 'ignored.log'), 'IGNORE_SENTINEL'); fs.writeFileSync(path.join(work, 'included.log'), 'include');
  fs.writeFileSync(path.join(work, 'untracked'), 'new'); fs.writeFileSync(path.join(work, 'secret'), 'sk-SENTINELabcdefghijk');
  const externalGit = { metadataRoot: path.join(main, '.git', 'worktrees', 'work'), commonRoot: path.join(main, '.git') };
  fs.mkdirSync(path.join(externalGit.commonRoot, 'info'), { recursive: true }); fs.writeFileSync(path.join(externalGit.commonRoot, 'info/exclude'), '*.tmp\r\n');
  fs.writeFileSync(path.join(work, 'private.tmp'), 'exclude');
  const { createLegacyNativeCaptureService: createBadcaseCaptureService } = require('../helpers/legacy-native-capture');
  const service = createBadcaseCaptureService({ captureRoot });
  service.savePolicy('p', { authorizedDirs: [work], authorizedInputDirs: Object.values(externalGit), excludedPatterns: [], includedIgnoredPatterns: ['included.log'] });
  service.authorizeProject('p');
  const { readWindowsGitFileCandidateAsync } = require(filename);
  const options = () => ({ policy: service.loadPolicy('p'), targetDir: work, captureRoot, externalGit });
  const started = performance.now();
  const r = await readWindowsGitFileCandidateAsync(options()); assert.equal(r.ok, true, r.reason);
  const candidateDurationMs = Math.round(performance.now() - started);
  const oracle = git(work, 'ls-files', '-c', '-o', '--exclude-standard', '-z').split('\0').filter(p => p && p !== 'deleted').concat('included.log').sort();
  assert.deepEqual(Object.keys(r.files).sort(), oracle); assert.equal(r.files['tracked.log'].hash, hash('dirty'));
  assert.ok(r.limitations.includes('windows_ignorecase_ascii_projection'));
  assert.deepEqual([...r.indexDeletions], ['deleted']);
  const { restoreCheckpoint } = require('../../build/server/domain/runtime/badcase-capture/restore');
  // Test-only CAS writer, NOT enable or a real turn. Manifest shape matches the file restore contract.
  for (const [digest, bytes] of r.blobs) service.store.stageBlob('p', 'fixture', digest, bytes);
  service.store.commitStaging('p', 'fixture');
  service.store.saveCheckpoint('p', { checkpointId: 'fixture', targetDir: work, files: r.files, deletions: [],
    strictEvalEligible: false, replayInput: { complete: false }, limitations: r.limitations });
  for (const name of ['a', 'b']) {
    const dest = path.join(base, name); const restored = restoreCheckpoint({ store: service.store, projectId: 'p', checkpointId: 'fixture', targetDir: dest });
    assert.equal(restored.ok, true, restored.reason); assert.equal(fs.readFileSync(path.join(dest, 'tracked.log'), 'utf8'), 'dirty');
    assert.equal(fs.readFileSync(path.join(dest, 'secret'), 'utf8'), '[*]'); assert.equal(fs.existsSync(path.join(dest, 'deleted')), false);
  }
  const manifest = dir => fs.readdirSync(dir).sort().map(p => [p, hash(fs.readFileSync(path.join(dir, p)))]);
  assert.deepEqual(manifest(path.join(base, 'a')), manifest(path.join(base, 'b')));
  t.diagnostic(JSON.stringify({ fixtureOnly: true, candidateDurationMs, files: Object.keys(r.files).length,
    safeBlobBytes: [...r.blobs.values()].reduce((n, b) => n + b.length, 0), classification: r.classification,
    complete: r.complete, strictEvalEligible: r.strictEvalEligible, captureAvailable: r.captureAvailable }));
  assert.equal(service.loadPolicy('p').status, 'disabled'); assert.equal(service.store.listCheckpoints('p').length, 1, 'only the explicit test writer persisted a fixture');
  // Explicit retained native v1 collector, real async publication/restore.
  // Not evidence that the new turn facade still selects external native inputs.
  const serviceRoot = path.join(base, 'service-storage'), sessions = path.join(base, 'sessions'); fs.mkdirSync(sessions);
  const selectedService = createBadcaseCaptureService({ captureRoot: serviceRoot });
  selectedService.savePolicy('p', { authorizedDirs: [work], authorizedInputDirs: [...Object.values(externalGit), sessions],
    windowsExternalGit: [{ worktree: work, ...externalGit }], excludedPatterns: [], includedIgnoredPatterns: ['included.log'] });
  const authorized = selectedService.authorizeProject('p');
  assert.equal(authorized.status, 'disabled');
  const preview = await selectedService.estimateDirectoryAsync('p', work); assert.equal(preview.ok, true); assert.equal(preview.captureAvailable, true);
  assert.equal(preview.exclusionPolicy, 'windows-git-classified-v1');
  const turn = { projectId: 'p', conversationId: 'fixture-c', turnId: 'fixture-t', agentId: 'fixture-a', targetDir: work,
    deliveryMode: 'fresh', prompt: 'question', externalGit: { metadataRoot: 'C:/untrusted', commonRoot: 'C:/untrusted' },
    runConfig: { provider: 'test', model: 'test', skillIds: [], conversationSkillIds: [] },
    harness: { configSnapshot: { toolBridgeEnabled: true, deliveryMode: 'fresh', piVersion: '0.85.1' }, skillSnapshots: [] } };
  assert.equal((await selectedService.captureTurnCheckpoint(turn)).reason, 'policy_not_enabled');
  selectedService.store.savePolicy({ ...authorized, status: 'enabled' });
  const reopenedService = createBadcaseCaptureService({ captureRoot: serviceRoot });
  const sessionBytes = Buffer.from([{ type: 'session', version: 3, id: 's', cwd: work },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'hello', timestamp: 1 } }].map(x => JSON.stringify(x)).join('\r\n') + '\r\n');
  const sessionPath = path.join(sessions, 'turn.jsonl'); fs.writeFileSync(sessionPath, sessionBytes);
  const serviceStart = performance.now();
  for (const deliveryMode of ['fresh', 'resume']) {
    const input = { ...turn, deliveryMode, sessionPath, harness: { ...turn.harness, configSnapshot: { ...turn.harness.configSnapshot, deliveryMode } } };
    const captured = await reopenedService.captureTurnCheckpoint(input); assert.equal(captured.captured, true, captured.reason);
    const cp = reopenedService.store.loadCheckpoint('p', captured.checkpointId);
    assert.equal(cp.gitMetadata, 'bounded_external_git_subset_v1'); assert.equal(cp.replayInput.deliveryMode, deliveryMode);
    assert.equal(cp.replayInput.complete, false); assert.equal(cp.strictEvalEligible, false);
    assert.equal(cp.files['tracked.log'].hash, hash('dirty')); assert.equal(cp.files.secret.secretRedacted, true);
    assert.deepEqual(cp.replayInput.secretRedactedPaths, ['secret']);
    assert.equal(cp.replayInput.incompleteReasons.includes('files_contain_secret'), false);
    assert.ok(cp.integrity.knownLimitations.includes('windows_ignorecase_ascii_projection'));
    assert.deepEqual(cp.deletions, ['deleted']);
    assert.equal(cp.integrity.indexedDeletionEvidence, 'verified_index_visible_ascii_v1');
    if (deliveryMode === 'resume') assert.deepEqual(reopenedService.store.readBlob('p', cp.replayInput.sessionBlobHash), sessionBytes);
    const restoredLists = [];
    for (const n of [1, 2]) {
      const targetDir = path.join(base, `service-${deliveryMode}-${n}`);
      const restored = reopenedService.restoreCheckpoint({ projectId: 'p', checkpointId: cp.checkpointId, targetDir });
      assert.equal(restored.ok, true, restored.reason); restoredLists.push(manifest(targetDir));
      assert.equal(fs.readFileSync(path.join(targetDir, 'secret'), 'utf8'), '[*]'); assert.equal(fs.existsSync(path.join(targetDir, '.git')), false);
    }
    assert.deepEqual(restoredLists[0], restoredLists[1]);
  }
  assert.equal(reopenedService.store.listCheckpoints('p').length, 2);
  const wrongRoot = await reopenedService.captureTurnCheckpoint({ ...turn, targetDir: main }); assert.equal(wrongRoot.captured, false);
  assert.equal(reopenedService.store.listCheckpoints('p').length, 2);
  t.diagnostic(JSON.stringify({ fixtureOnly: true, serviceTwoModesMs: Math.round(performance.now() - serviceStart),
    usageBytes: reopenedService.computeUsage('p').totalBytes, platform: process.platform, managementEnable: false }));
  const savedExclude = fs.readFileSync(path.join(externalGit.commonRoot, 'info/exclude'));
  fs.rmSync(path.join(externalGit.commonRoot, 'info/exclude'));
  assert.equal((await readWindowsGitFileCandidateAsync(options())).reason, 'git_external_input_unavailable');
  fs.writeFileSync(path.join(externalGit.commonRoot, 'info/exclude'), savedExclude);
  // Exclusions are not bypassed merely to make external classification work.
  service.savePolicy('p', { ...service.loadPolicy('p'), excludedPatterns: ['.git'] });
  assert.equal((await readWindowsGitFileCandidateAsync(options())).ok, false);
  service.savePolicy('p', { ...service.loadPolicy('p'), excludedPatterns: [] });
  const savedConfig = fs.readFileSync(path.join(externalGit.commonRoot, 'config'));
  fs.appendFileSync(path.join(externalGit.commonRoot, 'config'), '\n[extensions]\nworktreeconfig = true\n');
  fs.writeFileSync(path.join(externalGit.metadataRoot, 'config.worktree'), '[core]\nexcludesfile = C:/private\n');
  assert.equal((await readWindowsGitFileCandidateAsync(options())).reason, 'git_metadata_unsupported');
  fs.writeFileSync(path.join(externalGit.commonRoot, 'config'), savedConfig);
  fs.writeFileSync(path.join(externalGit.metadataRoot, 'commondir'), '../other\n');
  assert.equal((await readWindowsGitFileCandidateAsync(options())).ok, false);
});
