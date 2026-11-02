// Internal collector composition only. The service/management gate stays closed.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createCaptureStore } = require(base + 'capture-store');
const { withProjectWriteLock } = require(base + 'project-write-lock');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const latch = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const file = Buffer.from('before turn'), prompt = Buffer.from('question');
function candidate() { return { ok: true, observation: { scopeHash: sha('native-scope'), presentPaths: ['file', 'secret', 'ignored', 'now-dir', 'oldcase'] }, files: { file: { type: 'file', size: file.length, hash: sha(file), mode: 0o100644 },
  secret: { type: 'file', size: 20, secretExcluded: true, mode: 0o100644 } }, blobs: new Map([[sha(file), file]]),
  complete: false, strictEvalEligible: false, captureAvailable: false, classification: 'bounded_local_git_subset_v1',
  limitations: ['no_atomic_snapshot', 'windows_turn_collector_not_connected', 'session_and_invocation_not_collected', 'deletion_history_not_collected'] }; }
function prepared(mode = 'resume') { return { ok: true, replayInput: { deliveryMode: mode, complete: true, incompleteReasons: [],
  promptBlobHash: sha(prompt), sessionBlobHash: '', harness: { skillSnapshots: [] } }, plans: [{ hash: sha(prompt), content: prompt }] }; }
function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-win-turn-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root }); store.savePolicy({ ...store.loadPolicy('p'), status: 'enabled' });
  const seen = [], deps = {
    './windows-git-candidate': { readWindowsGitFileCandidateAsync: async opts => { seen.push(['files', opts]); return candidate(); } },
    './windows-replay-input': { prepareWindowsReplayInput: async opts => { seen.push(['input', opts]); return prepared(opts.input.deliveryMode); } },
    './checkpoint-publication': { publishPreparedCheckpoint: opts => { seen.push(['publish', opts]); return { captured: true,
      checkpointId: opts.checkpoint.checkpointId, checkpoint: opts.checkpoint, reason: '' }; } },
    ...overrides.deps,
  };
  let api = {};
  const filename = path.resolve(__dirname, base, 'windows-turn-collector.js');
  if (fs.existsSync(filename)) vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports: api, Buffer, structuredClone, process: { platform: overrides.platform || 'win32' },
    require: id => deps[id] || (id === 'node:perf_hooks' ? { performance: { now: overrides.clock || (() => 0) } }
      : require(require.resolve(id, { paths: [path.dirname(filename)] }))),
  }, { filename });
  assert.equal(typeof api.createWindowsTurnCollector, 'function');
  const collector = api.createWindowsTurnCollector({ store, agentDir: 'C:/app', privateDirs: ['C:/private'], ...overrides.options });
  const input = { projectId: 'p', conversationId: 'c', turnId: 't', agentId: 'a', targetDir: 'C:/worktree',
    deliveryMode: 'resume', prompt: 'question', sessionPath: 'C:/sessions/turn.jsonl', environment: { template: 'not-pinned' } };
  return { root, store, seen, input, collector };
}
test('trusted environment rejection occurs under the lease before files, and drift after files prevents inputs/publication', async t => {
  let ready = false, checks = 0, drift = 'files';
  const h = setup(t, { options: { checkEnvironment: () => { checks++; return ready; } }, deps: {
    './windows-git-candidate': { readWindowsGitFileCandidateAsync: async opts => { h.seen.push(['files', opts]); if (drift === 'files') ready = false; return candidate(); } },
    './windows-replay-input': { prepareWindowsReplayInput: async opts => { h.seen.push(['input', opts]); if (drift === 'input') ready = false; return prepared(); } },
  } });
  assert.equal((await h.collector.captureTurnCheckpoint(h.input)).reason, 'windows_git_environment_unsupported');
  assert.equal(checks, 1); assert.deepEqual(h.seen, []);
  ready = true;
  const changed = await h.collector.captureTurnCheckpoint(h.input);
  assert.equal(changed.captured, false); assert.equal(changed.reason, 'windows_git_environment_unsupported');
  assert.deepEqual(h.seen.map(([kind]) => kind), ['files']); noLock(h);
  h.seen.length = 0; ready = true; drift = 'input';
  const beforePublication = await h.collector.captureTurnCheckpoint(h.input);
  assert.equal(beforePublication.captured, false); assert.equal(beforePublication.reason, 'windows_git_environment_unsupported');
  assert.deepEqual(h.seen.map(([kind]) => kind), ['files', 'input']); noLock(h);
});

test('Windows Git environment accepts only explicitly disabled ambient config and no injected Git selectors', () => {
  const { supportsWindowsGitEnvironment: supported } = require(base + 'windows-git-environment');
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_BASH_PATH: 'C:/Git/bin/bash.exe', OTHER: 'unchanged' };
  assert.equal(supported(env), true);
  for (const change of [{ GIT_CONFIG_GLOBAL: '' }, { GIT_CONFIG_GLOBAL: 'C:/missing-config' }, { GIT_CONFIG_NOSYSTEM: '0' },
    { GIT_CONFIG_COUNT: '0' }, { GIT_CONFIG_PARAMETERS: 'PRIVATE_SENTINEL' }, { GIT_DIR: 'C:/different' },
    { GIT_WORK_TREE: 'C:/different' }, { GIT_INDEX_FILE: 'C:/different' }, { git_config_global: 'NUL' }]) {
    assert.equal(supported({ ...env, ...change }), false);
  }
  assert.equal(supported({}), false); assert.equal(supported(null), false);
  assert.equal(env.OTHER, 'unchanged'); assert.equal(Object.keys(env).length, 4, 'checker must not rewrite the environment');
});

test('native Git for Windows applies the explicitly selected NUL global config instead of the fixture default', { skip: process.platform !== 'win32' }, t => {
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-win-git-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.gitconfig'), '[user]\nname = fixture-global\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: '1' });
  const git = env => execFileSync('git', ['config', '--list', '--show-origin'], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  assert.match(git(env), /user.name=fixture-global/);
  env.GIT_CONFIG_GLOBAL = 'NUL'; assert.equal(git(env), '');
});

test('collector selects external roots ONLY from locked policy at exact actual worktree, not invocation parameters', async t => {
  const h = setup(t), entry = { worktree: 'C:/worktree', metadataRoot: 'C:/main/.git/worktrees/work', commonRoot: 'C:/main/.git' };
  const policy = { ...h.store.loadPolicy('p'), authorizedDirs: [entry.worktree],
    authorizedInputDirs: [entry.metadataRoot, entry.commonRoot], windowsExternalGit: [entry] };
  h.store.loadPolicy = () => policy; // VM Windows semantics on every host
  h.input.externalGit = { metadataRoot: 'C:/UNTRUSTED', commonRoot: 'C:/UNTRUSTED' };
  assert.equal((await h.collector.captureTurnCheckpoint(h.input)).captured, true);
  const selected = h.seen.find(x => x[0] === 'files')[1].externalGit;
  assert.deepEqual(JSON.parse(JSON.stringify(selected)), { metadataRoot: path.win32.resolve(entry.metadataRoot), commonRoot: path.win32.resolve(entry.commonRoot) });
  h.seen.length = 0;
  await h.collector.captureTurnCheckpoint({ ...h.input, targetDir: 'C:/worktree/sub' });
  assert.equal(h.seen.find(x => x[0] === 'files')[1].externalGit, undefined);
});

const collect = h => h.collector.captureTurnCheckpoint(h.input);
const noLock = h => assert.equal(fs.existsSync(path.join(h.root, 'projects/p/.writer-lock')), false);

test('composition owns one lease through files/input/publication; latches materials and never upgrades completeness', async t => {
  const entered = latch(), release = latch(); let h, observed, firstPolicy;
  h = setup(t, { deps: { './windows-git-candidate': { readWindowsGitFileCandidateAsync: async opts => {
    firstPolicy = opts.policy; entered.resolve(); await release.promise; return candidate();
  } }, './windows-replay-input': { prepareWindowsReplayInput: async opts => { observed = opts; return prepared(); } } } });
  const pending = collect(h); await entered.promise;
  try {
    assert.throws(() => h.store.savePolicy({ ...h.store.loadPolicy('p'), status: 'disabled' }), /capture_writer_busy/);
    assert.throws(() => withProjectWriteLock(h.root, 'p', () => {}), /capture_writer_busy/);
    assert.equal((await collect(h)).reason, 'capture_writer_busy');
    h.input.prompt = 'later'; h.input.deliveryMode = 'fresh'; h.input.targetDir = 'C:/other'; h.input.environment.template = 'later';
  } finally { release.resolve(); }
  const result = await pending;
  assert.equal(result.captured, true); assert.equal(observed.input.prompt, 'question'); assert.equal(observed.input.deliveryMode, 'resume');
  assert.equal(observed.authorizedRoot, 'C:\\worktree'); assert.equal(observed.policy, firstPolicy);
  assert.equal(observed.privateDirs[0], 'C:/private'); assert.equal(observed.deadline, 25000);
  const cp = result.checkpoint;
  assert.equal(cp.targetDir, 'C:\\worktree'); assert.equal(cp.turnId, 't'); assert.equal(cp.environment.template, 'not-pinned');
  assert.equal(cp.replayInput.deliveryMode, 'resume'); assert.equal(cp.replayInput.complete, false); assert.equal(cp.strictEvalEligible, false);
  assert.ok(cp.replayInput.incompleteReasons.includes('windows_capture_subset_unverified'));
  assert.ok(cp.replayInput.incompleteReasons.includes('files_contain_secret')); assert.deepEqual([...cp.replayInput.secretExcludedPaths], ['secret']);
  assert.equal(cp.integrity.platform, 'win32'); assert.match(cp.integrity.manifestHash, /^[0-9a-f]{64}$/);
  assert.equal(cp.integrity.knownLimitations.includes('session_and_invocation_not_collected'), false);
  assert.equal(cp.integrity.knownLimitations.includes('windows_turn_collector_not_connected'), false);
  assert.equal(cp.integrity.knownLimitations.includes('windows_management_enable_not_connected'), false);
  assert.deepEqual([...cp.deletions], []); assert.equal(h.seen.at(-1)[0], 'publish'); noLock(h);
});

test('lease cleanup rejection after publisher success still withholds the checkpoint association', async t => {
  const original = require(base + 'project-write-lock');
  const h = setup(t, { deps: { './project-write-lock': { withAsyncProjectWriteLease: async (...args) => {
    await original.withAsyncProjectWriteLease(...args); throw Error('PRIVATE_RELEASE_SENTINEL');
  } } } });
  const result = await collect(h); assert.equal(h.seen.at(-1)[0], 'publish');
  assert.equal(result.captured, false); assert.equal(result.checkpointId, ''); assert.equal(result.reason, 'windows_capture_unavailable');
  assert.equal(JSON.stringify(result).includes('PRIVATE_RELEASE_SENTINEL'), false); noLock(h);
});

for (const status of ['disabled', 'suspended']) test(`policy ${status} refuses before any reader/publication`, async t => {
  const h = setup(t); h.store.savePolicy({ ...h.store.loadPolicy('p'), status });
  assert.equal((await collect(h)).reason, 'policy_not_enabled'); assert.equal(h.seen.length, 0); noLock(h);
});
for (const phase of ['files', 'input', 'publication', 'throw']) test(`${phase} failure is final and cannot return a successful association`, async t => {
  let inputCalls = 0, publishes = 0;
  const h = setup(t, { deps: {
    './windows-git-candidate': { readWindowsGitFileCandidateAsync: async () => {
      if (phase === 'throw') throw Error('PRIVATE_SENTINEL'); return phase === 'files' ? { ok: false, reason: 'git_metadata_unsupported' } : candidate();
    } }, './windows-replay-input': { prepareWindowsReplayInput: async () => { inputCalls++; return phase === 'input' ? { ok: false, reason: 'replay_input_timeout' } : prepared(); } },
    './checkpoint-publication': { publishPreparedCheckpoint: () => { publishes++; return { captured: false, checkpointId: '', reason: 'checkpoint_write_failed' }; } },
  } });
  const result = await collect(h); assert.equal(result.captured, false); assert.equal(result.checkpointId, '');
  assert.equal(result.reason, { files: 'git_metadata_unsupported', input: 'replay_input_timeout', publication: 'checkpoint_write_failed', throw: 'windows_capture_unavailable' }[phase]);
  assert.equal(inputCalls, phase === 'files' || phase === 'throw' ? 0 : 1); assert.equal(publishes, phase === 'publication' ? 1 : 0);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false); noLock(h);
});
for (const phase of ['files', 'input', 'before-publish']) test(`one overall deadline rejects late ${phase} before publication`, async t => {
  let now = 0, inputCalls = 0, published = false;
  const late = { ok: true, get files() { assert.fail('late files consumed'); }, get replayInput() { assert.fail('late input consumed'); } };
  const h = setup(t, { clock: () => now, deps: {
    './windows-git-candidate': { readWindowsGitFileCandidateAsync: async opts => { assert.equal(opts.deadline, 25000);
      if (phase === 'files') { now = 25000; return late; } return candidate(); } },
    './windows-replay-input': { prepareWindowsReplayInput: async opts => { inputCalls++; assert.equal(opts.deadline, 25000);
      if (phase === 'input') { now = 25000; return late; }
      const p = prepared(); if (phase === 'before-publish') Object.defineProperty(p, 'plans', { get() { now = 25000; return []; } }); return p; } },
    './checkpoint-publication': { publishPreparedCheckpoint: () => { published = true; assert.fail('late publication'); } },
  } });
  assert.equal((await collect(h)).reason, 'windows_capture_timeout'); assert.equal(published, false);
  assert.equal(inputCalls, phase === 'files' ? 0 : 1); noLock(h);
});

test('invalid platform/mode/target/project fails before filesystem lock or readers', async t => {
  const h = setup(t, { platform: 'linux' }); assert.equal((await collect(h)).reason, 'windows_required'); assert.equal(h.seen.length, 0); noLock(h);
  const other = setup(t);
  for (const patch of [{ projectId: '../escape' }, { targetDir: '' }, { targetDir: '//remote/share' }, { deliveryMode: 'other' }]) {
    assert.equal((await other.collector.captureTurnCheckpoint({ ...other.input, ...patch })).captured, false); assert.equal(other.seen.length, 0); noLock(other);
  }
});

test('deletions require a comparable native observation and actual absence, not selection absence', async t => {
  const h = setup(t);
  const previous = { schemaVersion: 1, checkpointId: 'previous', projectId: 'p', targetDir: 'C:\\worktree',
    integrity: { platform: 'win32', windowsObservationScopeHash: sha('native-scope') },
    files: Object.fromEntries(['gone', 'dir/lost', 'ignored', 'now-dir', 'OldCase', 'old-secret'].map(p => [p,
      { type: 'file', hash: sha('old'), size: 3, secretExcluded: p === 'old-secret' }])) };
  let calls = 0;
  h.store.loadLatestCheckpoint = (projectId, targetDir) => {
    calls++; assert.equal(projectId, 'p'); assert.equal(targetDir, 'C:\\worktree');
    assert.throws(() => withProjectWriteLock(h.root, 'p', () => {}), /capture_writer_busy/);
    return previous;
  };
  const result = await collect(h), cp = result.checkpoint;
  assert.equal(result.captured, true); assert.equal(calls, 1);
  assert.deepEqual([...cp.deletions], ['dir/lost', 'gone']);
  assert.equal(cp.integrity.windowsObservationScopeHash, sha('native-scope'));
  assert.equal(cp.integrity.deletionHistoryBaselineId, 'previous');
  assert.equal(cp.integrity.knownLimitations.includes('deletion_history_not_collected'), false);
  assert.ok(cp.integrity.knownLimitations.includes('deletion_history_only_from_comparable_previous_checkpoint'));
  const files = cp.files, deletions = ['dir/lost', 'gone'];
  assert.equal(cp.integrity.manifestHash, sha(JSON.stringify({ files: Object.keys(files).sort().map(p =>
    [p, files[p].hash || '', files[p].size || 0, files[p].secretExcluded === true]), deletions })));
  assert.equal(cp.strictEvalEligible, false); assert.equal(cp.replayInput.complete, false); noLock(h);
});

test('verified index absences work without history and merge with comparable history once, but never prior secrets', async t => {
  for (const withHistory of [false, true]) {
    const h = setup(t, { deps: { './windows-git-candidate': { readWindowsGitFileCandidateAsync: async () => ({
      ...candidate(), indexDeletions: ['old-secret', 'same', 'first.txt'], indexDeletionsVerified: true,
    }) } } });
    h.store.loadLatestCheckpoint = () => withHistory ? ({ schemaVersion: 1, checkpointId: 'previous', projectId: 'p', targetDir: 'C:\\worktree',
      integrity: { platform: 'win32', windowsObservationScopeHash: sha('native-scope') },
      files: { historical: { type: 'file' }, SAME: { type: 'file' }, 'OLD-SECRET': { type: 'file', secretExcluded: true } } }) : null;
    const cp = (await collect(h)).checkpoint;
    assert.deepEqual([...cp.deletions], withHistory ? ['first.txt', 'historical', 'same'] : ['first.txt', 'old-secret', 'same']);
    assert.equal(cp.integrity.indexedDeletionEvidence, 'verified_index_visible_ascii_v1');
    assert.equal(cp.integrity.knownLimitations.includes('tracked_deletions_before_first_checkpoint_not_inferred'), false);
    assert.equal(cp.strictEvalEligible, false); assert.equal(cp.replayInput.complete, false);
    assert.equal(cp.integrity.manifestHash, sha(JSON.stringify({ files: Object.keys(cp.files).sort().map(p =>
      [p, cp.files[p].hash || '', cp.files[p].size || 0, cp.files[p].secretExcluded === true]), deletions: [...cp.deletions] })));
  }
});

test('unverified index absences cannot be promoted to deletion evidence or erase missing-history limitations', async t => {
  for (const indexDeletionsVerified of [undefined, false]) {
    const h = setup(t, { deps: { './windows-git-candidate': { readWindowsGitFileCandidateAsync: async () => ({
      ...candidate(), indexDeletions: ['unproven'], indexDeletionsVerified,
    }) } } });
    const cp = (await collect(h)).checkpoint;
    assert.deepEqual([...cp.deletions], []); assert.equal(cp.integrity.indexedDeletionEvidence, '');
    assert.ok(cp.integrity.knownLimitations.includes('tracked_deletions_before_first_checkpoint_not_inferred'));
  }
});

test('missing/mismatched/foreign/legacy history never fabricates deletions or a baseline association', async t => {
  for (const patch of [null, { integrity: {} }, { files: null }, { files: [] }, { files: { 'caf\u00e9': { type: 'file' } } },
    { schemaVersion: 2 }, { projectId: 'other' }, { targetDir: 'C:\\other' },
    { checkpointId: '../bad' }, { integrity: { platform: 'linux', windowsObservationScopeHash: sha('native-scope') } },
    { integrity: { platform: 'win32', windowsObservationScopeHash: sha('changed-scope') } }]) {
    const h = setup(t);
    h.store.loadLatestCheckpoint = () => patch === null ? null : ({ schemaVersion: 1, checkpointId: 'previous',
      projectId: 'p', targetDir: 'C:\\worktree', files: { gone: { type: 'file', hash: sha('old') } },
      integrity: { platform: 'win32', windowsObservationScopeHash: sha('native-scope') }, ...patch });
    const cp = (await collect(h)).checkpoint;
    assert.deepEqual([...cp.deletions], []); assert.equal(cp.integrity.deletionHistoryBaselineId, '');
    assert.ok(cp.integrity.knownLimitations.includes('deletion_history_baseline_unavailable')); noLock(h);
  }
});

test('missing or malformed observation cannot borrow a historical scope proof', async t => {
  for (const observation of [undefined, { scopeHash: '' }, { scopeHash: sha('native-scope'), presentPaths: null },
    { scopeHash: sha('native-scope'), presentPaths: [null] }, { scopeHash: 'not-a-hash', presentPaths: [] }]) {
    const h = setup(t, { deps: { './windows-git-candidate': { readWindowsGitFileCandidateAsync: async () => ({ ...candidate(), observation }) } } });
    h.store.loadLatestCheckpoint = () => ({ schemaVersion: 1, checkpointId: 'previous', projectId: 'p', targetDir: 'C:\\worktree',
      integrity: { platform: 'win32', windowsObservationScopeHash: observation?.scopeHash || sha('native-scope') }, files: { gone: { type: 'file' } } });
    const result = await collect(h); assert.equal(result.captured, true);
    assert.deepEqual([...result.checkpoint.deletions], []); assert.equal(result.checkpoint.integrity.deletionHistoryBaselineId, '');
  }
});

test('Unicode observation does not guess native Unicode case equivalence for deletion history', async t => {
  const h = setup(t, { deps: { './windows-git-candidate': { readWindowsGitFileCandidateAsync: async () => {
    const c = candidate(); c.observation.presentPaths.push('caf\u00e9'); return c;
  } } } });
  h.store.loadLatestCheckpoint = () => ({ schemaVersion: 1, checkpointId: 'previous', projectId: 'p', targetDir: 'C:\\worktree',
    integrity: { platform: 'win32', windowsObservationScopeHash: sha('native-scope') }, files: { gone: { type: 'file' } } });
  const cp = (await collect(h)).checkpoint;
  assert.deepEqual([...cp.deletions], []); assert.equal(cp.integrity.deletionHistoryBaselineId, '');
  assert.ok(cp.integrity.knownLimitations.includes('deletion_history_baseline_unavailable'));
});

test('native Windows files and independently authorized resume enter real publisher, reopen and restore twice (self-built fixture)',
  { skip: process.platform !== 'win32' }, async t => {
  const { createWindowsTurnCollector } = require(base + 'windows-turn-collector');
  const { createBadcaseCaptureService } = require(base + 'index');
  const { restoreCheckpoint } = require(base + 'restore');
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-win-turn-native-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'worktree'), sessions = path.join(root, 'sessions'), captureRoot = path.join(root, 'capture');
  fs.mkdirSync(target); fs.mkdirSync(sessions);
  const git = (...args) => execFileSync('git', ['-C', target, ...args], { windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'absent-global'), GIT_TEMPLATE_DIR: '' } });
  git('init', '-q'); git('config', 'core.ignorecase', 'false'); fs.writeFileSync(path.join(target, 'tracked'), 'original'); git('add', 'tracked');
  fs.writeFileSync(path.join(target, 'preMissing'), 'already gone'); git('add', 'preMissing'); fs.unlinkSync(path.join(target, 'preMissing'));
  const privateDir = path.join(target, 'private'); fs.mkdirSync(privateDir);
  fs.writeFileSync(path.join(privateDir, 'hidden'), 'not authorized'); fs.writeFileSync(path.join(target, '.env'), 'not archived');
  git('add', '-f', 'private/hidden', '.env'); fs.unlinkSync(path.join(privateDir, 'hidden')); fs.unlinkSync(path.join(target, '.env'));
  fs.writeFileSync(path.join(target, 'tracked'), 'dirty'); fs.writeFileSync(path.join(target, 'untracked'), 'new');
  fs.writeFileSync(path.join(target, 'secret'), 'sk-SENTINELabcdefghijk');
  for (const p of ['gone', 'becomesDir', 'CaseBefore']) fs.writeFileSync(path.join(target, p), 'before');
  fs.writeFileSync(path.join(target, '.gitignore'), '');
  const bytes = Buffer.from([ { type: 'session', version: 3, id: 's', cwd: target },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'hello', timestamp: 1 } } ].map(x => JSON.stringify(x)).join('\r\n') + '\r\n');
  const sessionPath = path.join(sessions, 'turn.jsonl'); fs.writeFileSync(sessionPath, bytes);
  const service = createBadcaseCaptureService({ captureRoot }); service.savePolicy('p', { authorizedDirs: [target], authorizedInputDirs: [sessions], excludedPatterns: [] });
  const policy = service.authorizeProject('p'); assert.equal(policy.status, 'disabled');
  const collector = createWindowsTurnCollector({ store: service.store, privateDirs: [privateDir] });
  const input = { projectId: 'p', conversationId: 'c', turnId: 't', agentId: 'a', targetDir: target, sessionPath, deliveryMode: 'resume', prompt: 'question',
    runConfig: { provider: 'test', model: 'test', skillIds: [], conversationSkillIds: [] },
    harness: { configSnapshot: { toolBridgeEnabled: true, deliveryMode: 'resume', piVersion: '0.85.1' }, skillSnapshots: [] } };
  assert.equal((await collector.captureTurnCheckpoint(input)).reason, 'policy_not_enabled');
  // Test-only status, not management enable of any real project.
  service.store.savePolicy({ ...policy, status: 'enabled' });
  const result = await collector.captureTurnCheckpoint(input); assert.equal(result.captured, true, result.reason);
  const reopened = createCaptureStore({ captureRoot }), cp = reopened.loadCheckpoint('p', result.checkpointId);
  assert.deepEqual(cp, result.checkpoint); assert.deepEqual(cp.deletions, ['preMissing']);
  assert.equal(cp.integrity.indexedDeletionEvidence, 'verified_index_visible_ascii_v1');
  assert.equal(cp.replayInput.deliveryMode, 'resume'); assert.equal(cp.replayInput.complete, false);
  assert.deepEqual(reopened.readBlob('p', cp.replayInput.sessionBlobHash), bytes); assert.equal(cp.strictEvalEligible, false);
  assert.equal(cp.files.tracked.hash, sha('dirty')); assert.equal(cp.files.untracked.hash, sha('new')); assert.equal(cp.files.secret.secretRedacted, true);
  assert.deepEqual(cp.replayInput.secretRedactedPaths, ['secret']); assert.equal(cp.stats.secretRedactedFiles, 1);
  assert.equal(cp.replayInput.incompleteReasons.includes('files_contain_secret'), false);
  assert.equal(reopened.hasBlob('p', sha('sk-SENTINELabcdefghijk')), false);
  const lists = [];
  for (const n of [1, 2]) {
    const dest = path.join(root, `restored-${n}`), restored = restoreCheckpoint({ store: reopened, projectId: 'p', checkpointId: cp.checkpointId, targetDir: dest });
    assert.equal(restored.ok, true, restored.reason); assert.equal(restored.replayInputComplete, false);
    assert.equal(fs.readFileSync(path.join(dest, 'tracked'), 'utf8'), 'dirty'); assert.equal(fs.readFileSync(path.join(dest, 'untracked'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(dest, 'secret'), 'utf8'), '[*]');
    assert.equal(restored.redactedFiles[0].byteIdenticalToSource, false); lists.push(restored.restoredFiles);
  }
  assert.deepEqual(lists[0], lists[1]);
  assert.equal(reopened.computeUsage('p').totalBytes, cp.stats.totalNewBytes); assert.equal(fs.existsSync(path.join(captureRoot, 'projects/p/.writer-lock')), false);
  assert.equal(cp.integrity.deletionHistoryBaselineId, '');
  assert.ok(cp.integrity.knownLimitations.includes('deletion_history_baseline_unavailable'));

  // Real content disappears vs selection-only change, ASCII case-only rename,
  // file->directory replacement, and an actually deleted redacted file are distinct.
  for (const p of ['gone', 'tracked', 'secret', 'becomesDir']) fs.unlinkSync(path.join(target, p));
  fs.mkdirSync(path.join(target, 'becomesDir')); fs.writeFileSync(path.join(target, 'becomesDir/child'), 'new child');
  fs.renameSync(path.join(target, 'CaseBefore'), path.join(target, 'tmp-case'));
  fs.renameSync(path.join(target, 'tmp-case'), path.join(target, 'casebefore'));
  fs.writeFileSync(path.join(target, '.gitignore'), 'untracked\n');
  const next = await collector.captureTurnCheckpoint({ ...input, turnId: 'next' });
  assert.equal(next.captured, true, next.reason);
  const cp2 = createCaptureStore({ captureRoot }).loadCheckpoint('p', next.checkpointId);
  assert.deepEqual(cp2.deletions, ['gone', 'preMissing', 'secret', 'tracked']);
  assert.equal(cp2.integrity.deletionHistoryBaselineId, cp.checkpointId);
  assert.equal(cp2.integrity.windowsObservationScopeHash, cp.integrity.windowsObservationScopeHash);
  assert.equal(cp2.files.untracked, undefined); assert.equal(fs.existsSync(path.join(target, 'untracked')), true);
  assert.equal(cp2.strictEvalEligible, false); assert.equal(cp2.replayInput.complete, false);
  const secondLists = [];
  for (const n of [1, 2]) {
    const dest = path.join(root, `next-restored-${n}`);
    const restored = restoreCheckpoint({ store: reopened, projectId: 'p', checkpointId: cp2.checkpointId, targetDir: dest });
    assert.equal(restored.ok, true, restored.reason);
    assert.equal(fs.existsSync(path.join(dest, 'gone')), false); assert.equal(fs.existsSync(path.join(dest, 'tracked')), false);
    assert.equal(fs.readFileSync(path.join(dest, 'casebefore'), 'utf8'), 'before');
    assert.equal(fs.readFileSync(path.join(dest, 'becomesDir/child'), 'utf8'), 'new child');
    secondLists.push(restored.restoredFiles);
  }
  assert.deepEqual(secondLists[0], secondLists[1]);

  // Same identity but changed compiled exclusions has no comparable baseline.
  service.store.savePolicy({ ...service.store.loadPolicy('p'), excludedPatterns: ['excludedLater'] });
  fs.unlinkSync(path.join(target, 'casebefore'));
  const changed = await collector.captureTurnCheckpoint({ ...input, turnId: 'scope-changed' });
  assert.equal(changed.captured, true, changed.reason); assert.deepEqual(changed.checkpoint.deletions, ['preMissing', 'tracked']);
  assert.notEqual(changed.checkpoint.integrity.windowsObservationScopeHash, cp2.integrity.windowsObservationScopeHash);
  assert.equal(changed.checkpoint.integrity.deletionHistoryBaselineId, '');
});

test('trusted callback source runs under the lease only after native file validation; caller packets cannot override it', async t => {
  let calls = 0, failFiles = true, h;
  const sourcePacket = { trace: 'owned source bytes', expectedTraceHash: sha('owned source bytes') };
  h = setup(t, { options: { readCallbackInput: (input, policy) => {
    calls++; assert.equal(policy.status, 'enabled'); assert.equal(input.projectId, 'p');
    assert.throws(() => withProjectWriteLock(h.root, 'p', () => {}), /capture_writer_busy/);
    return sourcePacket;
  } }, deps: { './windows-git-candidate': { readWindowsGitFileCandidateAsync: async () => failFiles ? { ok: false, reason: 'root_replaced' } : candidate() } } });
  h.input.callbackInput = { trace: 'UNTRUSTED_INVOCATION_PACKET' };
  assert.equal((await collect(h)).reason, 'root_replaced'); assert.equal(calls, 0);
  failFiles = false; assert.equal((await collect(h)).captured, true); assert.equal(calls, 1);
  assert.deepEqual(h.seen.find(x => x[0] === 'input')[1].input.callbackInput, sourcePacket);
  h.store.savePolicy({ ...h.store.loadPolicy('p'), status: 'disabled' });
  assert.equal((await collect(h)).reason, 'policy_not_enabled'); assert.equal(calls, 1);
});
