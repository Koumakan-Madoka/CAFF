// Shared input preparation and Windows session->material publication, not turn replay proof.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const base = '../../build/server/domain/runtime/badcase-capture/';
let shared = {}, windows = {};
try { shared = require(base + 'replay-input-preparation'); windows = require(base + 'windows-replay-input'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const secret = 'sk-' + 'x'.repeat(40);
function input(mode = 'resume') {
  return { deliveryMode: mode, prompt: 'question', sessionPath: 'C:/sessions/turn.jsonl',
    runConfig: { provider: 'test', model: 'test-model', promptVersion: 'v1', skillIds: [], conversationSkillIds: [] },
    harness: { serverVersion: 'fixture', configSnapshot: { agentPromptVersion: 'v1', toolBridgeEnabled: true,
      piVersion: '0.85.1', deliveryMode: mode, agentName: 'fixture' }, skillSnapshots: [] } };
}
const root = path.resolve('fixture-worktree');
const session = (more = [], cwd = root) => Buffer.from([
  { type: 'session', version: 3, id: 's', cwd },
  { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'hello', timestamp: 1 } },
  ...more,
].map(v => JSON.stringify(v)).join('\r\n') + '\r\n');
const read = bytes => () => ({ ok: true, content: bytes });
function loadWindows(readSession, clock = () => 0) {
  const filename = require.resolve(base + 'windows-replay-input'), exports = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, Buffer, structuredClone, process: { platform: 'win32' },
    require: id => id === './windows-session-input' ? { readWindowsSessionInput: readSession }
      : id === 'node:perf_hooks' ? { performance: { now: clock } }
      : require(require.resolve(id, { paths: [path.dirname(filename)] })) }, { filename });
  return exports;
}
const options = (value = input()) => ({ input: value, authorizedRoot: 'C:/worktree', captureRoot: 'C:/capture', policy: {} });
function assertPlans(result) {
  for (const p of result.plans) {
    assert.equal(sha(p.content), p.hash);
    assert.equal(p.content.buffer.byteLength, p.content.length, 'each plan owns its exact non-pooled backing');
    assert.equal(p.content.includes(secret), false);
  }
}

test('shared preparation preserves complete fresh/resume, exact CRLF bytes and zero reader calls for fresh', () => {
  for (const mode of ['fresh', 'resume']) {
    let reads = 0; const value = input(mode), before = JSON.stringify(value), bytes = session();
    const result = shared.prepareReplayInput(value, mode, root, p => { reads++; assert.equal(p, value.sessionPath); return { ok: true, content: bytes }; });
    assert.equal(reads, mode === 'resume' ? 1 : 0); assert.equal(result.replayInput.deliveryMode, mode);
    assert.equal(result.replayInput.complete, true, JSON.stringify(result.replayInput));
    assert.equal(JSON.stringify(value), before); assertPlans(result);
    if (mode === 'resume') {
      assert.equal(result.replayInput.sessionBlobHash, sha(bytes));
      assert.deepEqual(result.plans.find(p => p.hash === sha(bytes)).content, bytes);
    } else assert.equal(result.replayInput.sessionBlobHash, '');
  }
});

test('shared preparation preserves controlled substitution and fixed harness/skill material, never source credential bytes', () => {
  const value = input(), skill = '# allowed skill\n';
  value.prompt = `invoke ${secret}`; value.controlledValues = { CAFF_CHAT_CALLBACK_TOKEN: secret, NOT_ALLOWED: 'hello' };
  const bytes = session([{ type: 'message', id: 'u2', parentId: 'u', message: { role: 'user', content: `callback ${secret}`, timestamp: 2 } }]);
  value.runConfig.skillIds = ['skill']; value.harness.skillSnapshots = [{ id: 'skill', content: skill, sha256: sha(skill), source: 'fixture' }];
  const result = shared.prepareReplayInput(value, 'resume', root, read(bytes));
  assert.equal(result.replayInput.complete, true); assertPlans(result);
  assert.equal(result.replayInput.controlledReplacements.length, 2);
  assert.equal(result.plans.find(p => p.hash === result.replayInput.promptBlobHash).content.toString(), 'invoke {{CAFF_CHAT_CALLBACK_TOKEN}}');
  assert.equal(result.replayInput.harness.skillSnapshots.length, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

for (const kind of ['missing', 'denied', 'broken-chain', 'empty', 'secret', 'utf8']) test(`resume ${kind} never archives damaged/private session or downgrades fresh`, () => {
  const value = input(); let reader = read(session());
  const expected = { missing: 'session_missing', denied: 'session_not_authorized', 'broken-chain': 'session_chain_broken:line_3',
    empty: 'session_empty', secret: 'session_contains_secret', utf8: 'session_utf8_invalid' }[kind];
  if (kind === 'missing') { value.sessionPath = ''; reader = () => assert.fail('missing path cannot invoke reader'); }
  if (kind === 'denied') reader = () => ({ ok: false, reason: expected });
  if (kind === 'broken-chain') reader = read(session([{ type: 'message', id: 'bad', parentId: 'absent', message: { role: 'user', content: 'hi' } }]));
  if (kind === 'empty') reader = read(Buffer.alloc(0));
  if (kind === 'secret') reader = read(session([{ type: 'message', id: 'u2', parentId: 'u', message: { role: 'user', content: secret } }]));
  if (kind === 'utf8') {
    const malformed = session(); malformed[malformed.indexOf('hello')] = 0xff;
    reader = read(malformed); // Old lossy decoding archived U+FFFD inside an otherwise valid JSON string.
  }
  const result = shared.prepareReplayInput(value, 'resume', root, reader);
  assert.equal(result.replayInput.deliveryMode, 'resume'); assert.equal(result.replayInput.complete, false);
  assert.equal(result.replayInput.sessionBlobHash, ''); assert.ok(result.replayInput.incompleteReasons.includes(expected), JSON.stringify(result.replayInput));
  assertPlans(result);
});

test('unverified extension/image dependencies may archive structurally valid bytes but cannot claim complete', () => {
  const bytes = session([{ type: 'custom', id: 'x', parentId: 'u', customType: 'fixture', data: {} }]);
  const result = shared.prepareReplayInput({ ...input(), images: [{ data: 'PRIVATE_IMAGE' }] }, 'resume', root, read(bytes));
  assert.equal(result.replayInput.complete, false); assert.equal(result.replayInput.sessionBlobHash, sha(bytes));
  assert.ok(result.replayInput.unverifiedDimensions.length); assert.ok(result.replayInput.incompleteReasons.includes('invocation_images_not_archived'));
  assert.equal(result.replayInput.invocationImageCount, 1); assert.equal(JSON.stringify(result.replayInput).includes('PRIVATE_IMAGE'), false);
});

test('historical image bytes and tool dependencies retain their validator-specific incomplete dimensions', () => {
  const tool = (name, args) => ({ type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', api: 'a', provider: 'p', model: 'm',
    usage: {}, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call', name, arguments: args }] } });
  const cases = [
    [tool('read', { path: path.resolve(root, '../outside.txt') }), 'out_of_scope_path_dependency:read', true],
    [tool('bash', { command: 'ls' }), 'unanalyzable_tool_dependencies:bash', true],
    [{ type: 'message', id: 'img', parentId: 'u', message: { role: 'user', content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }] } }, 'image_content_unverified', true],
    [{ type: 'message', id: 'img', parentId: 'u', message: { role: 'user', content: [{ type: 'image', data: '???', mimeType: 'image/png' }] } }, 'session_invalid_content_block:line_3:session_attachment_malformed', false],
  ];
  for (const [entry, dimension, archive] of cases) {
    const bytes = session([entry]);
    const result = shared.prepareReplayInput(input(), 'resume', root, read(bytes));
    assert.equal(result.replayInput.complete, false); assert.ok(result.replayInput.incompleteReasons.includes(dimension), JSON.stringify(result.replayInput));
    assert.equal(result.replayInput.sessionBlobHash, archive ? sha(bytes) : ''); assertPlans(result);
  }
});

test('shared harness mismatches, missing skills and secret prompt remain incomplete with no unsafe plan', () => {
  const value = input('fresh'); value.prompt = secret; value.runConfig.skillIds = ['missing'];
  value.harness.configSnapshot.deliveryMode = 'resume'; value.harness.configSnapshot.piVersion = '999';
  const result = shared.prepareReplayInput(value, 'fresh', root, () => assert.fail('fresh reader'));
  assert.equal(result.replayInput.promptBlobHash, ''); assert.equal(result.replayInput.complete, false); assertPlans(result);
  for (const reason of ['prompt_contains_secret', 'harness_delivery_mode_mismatch', 'harness_version_unverified', 'skill_snapshot_missing:missing']) {
    assert.ok(result.replayInput.incompleteReasons.includes(reason), reason);
  }
});

test('Windows preparation uses the independent reader exactly once and matches shared preparation without changing mode/config', async () => {
  const bytes = session([], 'C:/worktree'); let calls = 0, observed;
  const api = loadWindows(async value => { calls++; observed = value; return { ok: true, content: bytes }; });
  for (const mode of ['fresh', 'resume']) {
    calls = 0; const opts = options(input(mode)), before = JSON.stringify(opts);
    const result = await api.prepareWindowsReplayInput(opts);
    assert.equal(result.ok, true, result.reason); assert.equal(calls, mode === 'resume' ? 1 : 0);
    const expected = shared.prepareReplayInput(opts.input, mode, opts.authorizedRoot, read(bytes));
    assert.deepEqual(JSON.parse(JSON.stringify(result.replayInput)), expected.replayInput);
    assert.deepEqual(result.plans.map(p => [p.hash, p.content.toString('hex')]), expected.plans.map(p => [p.hash, p.content.toString('hex')]));
    assert.equal(JSON.stringify(opts), before); assertPlans(result);
    if (mode === 'resume') { assert.equal(observed.policy, opts.policy); assert.equal(observed.captureRoot, opts.captureRoot); assert.equal(observed.inputPath, opts.input.sessionPath); }
  }
});

test('Windows preparation latches invocation and worktree root before awaiting the independently authorized reader', async () => {
  let release, entered;
  const wait = new Promise(r => { release = r; }), began = new Promise(r => { entered = r; });
  const bytes = session([], 'C:/worktree');
  const api = loadWindows(async () => { entered(); await wait; return { ok: true, content: bytes }; });
  const opts = options(), before = structuredClone(opts.input);
  const pending = api.prepareWindowsReplayInput(opts); await began;
  opts.input.prompt = 'later prompt'; opts.input.deliveryMode = 'fresh'; opts.input.sessionPath = 'C:/elsewhere.jsonl';
  opts.input.harness.configSnapshot.toolBridgeEnabled = false; opts.authorizedRoot = 'C:/different';
  release(); const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.replayInput.deliveryMode, 'resume');
  const expected = shared.prepareReplayInput(before, 'resume', 'C:/worktree', read(bytes));
  assert.deepEqual(JSON.parse(JSON.stringify(result.replayInput)), expected.replayInput);
  assert.deepEqual(result.plans.map(p => p.hash), expected.plans.map(p => p.hash));
});

test('Windows reader refusal, missing path and exception cannot become fresh/complete or leak exception text', async () => {
  for (const kind of ['missing', 'denied', 'exception']) {
    let calls = 0;
    const api = loadWindows(async () => { calls++; if (kind === 'exception') throw Error('PRIVATE_SENTINEL'); return { ok: false, reason: 'session_not_authorized' }; });
    const opts = options(); if (kind === 'missing') opts.input.sessionPath = '';
    const result = await api.prepareWindowsReplayInput(opts);
    assert.equal(result.ok, true); assert.equal(result.replayInput.deliveryMode, 'resume'); assert.equal(result.replayInput.complete, false);
    assert.equal(result.replayInput.sessionBlobHash, ''); assert.equal(calls, kind === 'missing' ? 0 : 1);
    assert.ok(result.replayInput.incompleteReasons.includes(kind === 'missing' ? 'session_missing' : kind === 'exception' ? 'session_input_unavailable' : 'session_not_authorized'));
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
  }
});

test('Windows preparation refuses platform/invalid mode and observes one overall deadline before material use and after preparation', async () => {
  let calls = 0; const readSession = async () => { calls++; return { ok: true, get content() { assert.fail('late bytes consumed'); } }; };
  for (const mode of [undefined, '', 'other']) {
    const opts = options(); opts.input.deliveryMode = mode;
    assert.equal((await loadWindows(readSession).prepareWindowsReplayInput(opts)).reason, 'replay_input_invalid');
  }
  if (process.platform !== 'win32') assert.equal((await windows.prepareWindowsReplayInput(options())).reason, 'windows_required');
  let now = 0;
  const late = loadWindows(async () => { calls++; now = 25000; return { ok: true, get content() { assert.fail('late bytes consumed'); } }; }, () => now);
  assert.equal((await late.prepareWindowsReplayInput(options())).reason, 'replay_input_timeout');
  let ticks = 0;
  const final = loadWindows(async () => ({ ok: true, content: session() }), () => ++ticks >= 4 ? 25000 : 0);
  assert.equal((await final.prepareWindowsReplayInput(options())).reason, 'replay_input_timeout'); assert.equal(calls, 1);
});

test('real Linux collector rejects malformed UTF-8 inside otherwise valid session JSON without archiving replacement bytes', { skip: process.platform !== 'linux' }, t => {
  const { createBadcaseCaptureService } = require(base + 'index');
  const { detectCaptureCapability } = require(base + 'safe-read');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-linux-session-utf8-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const target = path.join(dir, 'target'), sessions = path.join(dir, 'sessions'), captureRoot = path.join(dir, 'capture');
  fs.mkdirSync(target); fs.mkdirSync(sessions); fs.writeFileSync(path.join(target, 'file'), 'fixture');
  if (!detectCaptureCapability({ captureRoot }).ok) { t.skip('constrained Linux read unavailable'); return; }
  const inputPath = path.join(sessions, 'turn.jsonl'), malformed = session([], target);
  malformed[malformed.indexOf('hello')] = 0xff; fs.writeFileSync(inputPath, malformed);
  const service = createBadcaseCaptureService({ captureRoot });
  service.savePolicy('p', { authorizedDirs: [target], authorizedInputDirs: [sessions] });
  const policy = service.authorizeProject('p'); service.store.savePolicy({ ...policy, status: 'enabled' });
  const result = service.captureTurnCheckpoint({ ...input(), sessionPath: inputPath, projectId: 'p', targetDir: target,
    conversationId: 'c', turnId: 't', agentId: 'a' });
  assert.equal(result.captured, true, result.reason); assert.equal(result.checkpoint.replayInput.deliveryMode, 'resume');
  assert.equal(result.checkpoint.replayInput.complete, false); assert.equal(result.checkpoint.replayInput.sessionBlobHash, '');
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('session_utf8_invalid'));
});

test('real Windows authorized session->shared validation->publisher retains resume and exact archived bytes after store reopen', { skip: process.platform !== 'win32' }, async t => {
  const { createBadcaseCaptureService } = require(base + 'index');
  const { createCaptureStore } = require(base + 'capture-store');
  const { publishPreparedCheckpoint } = require(base + 'checkpoint-publication');
  const { withAsyncProjectWriteLease } = require(base + 'project-write-lock');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-session-preparation-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const sessions = path.join(dir, 'sessions'), target = path.join(dir, 'target'), captureRoot = path.join(dir, 'capture');
  fs.mkdirSync(sessions); fs.mkdirSync(target); const inputPath = path.join(sessions, 'turn.jsonl'), bytes = session([], target);
  fs.writeFileSync(inputPath, bytes);
  const service = createBadcaseCaptureService({ captureRoot }); service.savePolicy('p', { authorizedInputDirs: [sessions] });
  const policy = service.authorizeProject('p'); assert.equal(policy.status, 'disabled');
  const opts = { input: { ...input(), sessionPath: inputPath }, policy, captureRoot, authorizedRoot: target };
  const prepared = await windows.prepareWindowsReplayInput(opts);
  assert.equal(prepared.ok, true, prepared.reason); assert.equal(prepared.replayInput.complete, true, JSON.stringify(prepared.replayInput));
  assert.equal(service.store.computeUsage('p').blobCount, 0, 'preparation is memory-only');
  // Test-only writer status, not management enable and never production turn capture.
  service.store.savePolicy({ ...policy, status: 'enabled' });
  const checkpoint = { schemaVersion: 1, checkpointId: 'cp', projectId: 'p', conversationId: 'c', turnId: 't', agentId: 'a',
    createdAt: new Date().toISOString(), status: 'staged', targetDir: target, files: {}, deletions: [], strictEvalEligible: false,
    strictEvalBlockedReason: 'no_independent_consistency_evidence', replayInput: prepared.replayInput, stats: {} };
  const result = await withAsyncProjectWriteLease(captureRoot, 'p', async writeSync => writeSync(() => publishPreparedCheckpoint({
    store: service.store, checkpoint, blobs: new Map(prepared.plans.map(p => [p.hash, p.content])),
  })));
  assert.equal(result.captured, true, result.reason);
  const reopened = createCaptureStore({ captureRoot }), cp = reopened.loadCheckpoint('p', 'cp');
  assert.equal(cp.replayInput.deliveryMode, 'resume'); assert.equal(cp.strictEvalEligible, false);
  assert.deepEqual(reopened.readBlob('p', cp.replayInput.sessionBlobHash), bytes);
  fs.writeFileSync(inputPath, 'invalid');
  const broken = await windows.prepareWindowsReplayInput(opts); assert.equal(broken.replayInput.complete, false);
  assert.equal(broken.replayInput.deliveryMode, 'resume'); assert.equal(broken.replayInput.sessionBlobHash, '');
  assert.deepEqual(reopened.readBlob('p', cp.replayInput.sessionBlobHash), bytes, 'source changes cannot rewrite archived evidence');
});
