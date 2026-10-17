// Internal collector composition only. The service/management gate stays closed.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createCaptureStore } = require(base + 'capture-store');
const { withProjectWriteLock } = require(base + 'project-write-lock');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const latch = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const file = Buffer.from('before turn'), prompt = Buffer.from('question');
function candidate() { return { ok: true, files: { file: { type: 'file', size: file.length, hash: sha(file), mode: 0o100644 },
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
  const collector = api.createWindowsTurnCollector({ store, agentDir: 'C:/app', privateDirs: ['C:/private'] });
  const input = { projectId: 'p', conversationId: 'c', turnId: 't', agentId: 'a', targetDir: 'C:/worktree',
    deliveryMode: 'resume', prompt: 'question', sessionPath: 'C:/sessions/turn.jsonl', environment: { template: 'not-pinned' } };
  return { root, store, seen, input, collector };
}
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
  assert.ok(cp.integrity.knownLimitations.includes('windows_management_enable_not_connected'));
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
  fs.writeFileSync(path.join(target, 'tracked'), 'dirty'); fs.writeFileSync(path.join(target, 'untracked'), 'new');
  fs.writeFileSync(path.join(target, 'secret'), 'sk-SENTINELabcdefghijk');
  const bytes = Buffer.from([ { type: 'session', version: 3, id: 's', cwd: target },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'hello', timestamp: 1 } } ].map(x => JSON.stringify(x)).join('\r\n') + '\r\n');
  const sessionPath = path.join(sessions, 'turn.jsonl'); fs.writeFileSync(sessionPath, bytes);
  const service = createBadcaseCaptureService({ captureRoot }); service.savePolicy('p', { authorizedDirs: [target], authorizedInputDirs: [sessions], excludedPatterns: [] });
  const policy = service.authorizeProject('p'); assert.equal(policy.status, 'disabled');
  const collector = createWindowsTurnCollector({ store: service.store });
  const input = { projectId: 'p', conversationId: 'c', turnId: 't', agentId: 'a', targetDir: target, sessionPath, deliveryMode: 'resume', prompt: 'question',
    runConfig: { provider: 'test', model: 'test', skillIds: [], conversationSkillIds: [] },
    harness: { configSnapshot: { toolBridgeEnabled: true, deliveryMode: 'resume', piVersion: '0.85.1' }, skillSnapshots: [] } };
  assert.equal((await collector.captureTurnCheckpoint(input)).reason, 'policy_not_enabled');
  // Test-only status, not management enable of any real project.
  service.store.savePolicy({ ...policy, status: 'enabled' });
  const result = await collector.captureTurnCheckpoint(input); assert.equal(result.captured, true, result.reason);
  const reopened = createCaptureStore({ captureRoot }), cp = reopened.loadCheckpoint('p', result.checkpointId);
  assert.deepEqual(cp, result.checkpoint); assert.equal(cp.replayInput.deliveryMode, 'resume'); assert.equal(cp.replayInput.complete, false);
  assert.deepEqual(reopened.readBlob('p', cp.replayInput.sessionBlobHash), bytes); assert.equal(cp.strictEvalEligible, false);
  assert.equal(cp.files.tracked.hash, sha('dirty')); assert.equal(cp.files.untracked.hash, sha('new')); assert.equal(cp.files.secret.secretExcluded, true);
  assert.equal(reopened.hasBlob('p', sha('sk-SENTINELabcdefghijk')), false);
  const lists = [];
  for (const n of [1, 2]) {
    const dest = path.join(root, `restored-${n}`), restored = restoreCheckpoint({ store: reopened, projectId: 'p', checkpointId: cp.checkpointId, targetDir: dest });
    assert.equal(restored.ok, true, restored.reason); assert.equal(restored.replayInputComplete, false);
    assert.equal(fs.readFileSync(path.join(dest, 'tracked'), 'utf8'), 'dirty'); assert.equal(fs.readFileSync(path.join(dest, 'untracked'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(dest, 'secret')), false); lists.push(restored.restoredFiles);
  }
  assert.deepEqual(lists[0], lists[1]);
  assert.equal(reopened.computeUsage('p').totalBytes, cp.stats.totalNewBytes); assert.equal(fs.existsSync(path.join(captureRoot, 'projects/p/.writer-lock')), false);
});
