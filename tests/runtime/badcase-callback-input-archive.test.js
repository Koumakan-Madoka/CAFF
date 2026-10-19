// Explicit trusted memory input -> CAS/retention/capsule -> isolated callback.
// No production DB, project authorization, SDK, agent or model execution.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { prepareReplayInput } = require(base + 'replay-input-preparation');
const { checkpointBlobHashes } = require(base + 'checkpoint-retention');
const { prepareRetainedInitializationCapsule } = require(base + 'retained-initialization');
const { decodeInitializationCapsule } = require(base + 'capsule-materialization');
const { inspectRetainedReplayInputs } = require(base + 'replay-input-preflight');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const plan = (...a) => require(base + 'retained-callback-input').planRetainedEvaluationCallback(...a);
const association = () => ({ projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1', userMessageId: 'user1', assistantMessageId: 'msg1' });
function trace() {
  return { schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association: association(), assistantCreatedAt: '2026-01-01T00:00:03.000Z',
    conversation: { title: 'Archived callback Room', type: 'standard', metadata: { inputMarker: 'PRE_TURN_ROOM' } },
    participants: [{ id: 'a1', name: 'Archived Agent', description: 'Archived description' }], publicMessages: [
      { id: 'user1', turnId: 't1', role: 'user', agentId: null, senderName: 'Original User', content: 'Original question.', status: 'completed',
        createdAt: '2026-01-01T00:00:01.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] },
      { id: 'prior1', turnId: 'prior-turn', role: 'assistant', agentId: 'a1', senderName: 'Archived Agent', content: 'Original earlier reply.', status: 'completed',
        createdAt: '2026-01-01T00:00:02.000Z', publicPostedAt: '2026-01-01T00:00:02.000Z', publicPostCount: 1, publicPostMode: 'replace', mentions: [] },
    ], privateMessages: [], pendingDelegations: [] };
}
function input(v = trace()) {
  const raw = JSON.stringify(v);
  return { ...association(), prompt: 'Original question.', runConfig: { provider: 'test', model: 'test', promptVersion: 'v1' },
    harness: { serverVersion: 'test', configSnapshot: { piVersion: '0.85.1', agentPromptVersion: 'v1', toolBridgeEnabled: true, deliveryMode: 'fresh', agentName: 'Archived Agent' } },
    callbackInput: { trace: raw, expectedTraceHash: hash(raw) } };
}
function prepared(value = input()) { return prepareReplayInput(value, 'fresh', '/source', () => assert.fail('fresh session read')); }
function retained(t, mode = 'fresh', change = () => {}) {
  const p = prepared();
  assert.ok(p.replayInput.callbackInput, 'new channel must archive an explicit callback reference');
  const h = fixture(t, mode, ({ r, put, cp }) => {
    r.callbackInput = p.replayInput.callbackInput;
    const blob = p.plans.find(b => b.hash === r.callbackInput.blobHash);
    assert.equal(put(blob.content), r.callbackInput.blobHash); change({ r, cp, put });
  });
  const c = prepareRetainedInitializationCapsule(h.request);
  return { h, c, expected: { capsuleHash: c.capsuleHash, checkpointChecksum: c.provenance.checkpointChecksum } };
}
function repack(data) {
  const capsule = JSON.stringify(data);
  return { capsule, expected: { capsuleHash: hash(capsule), checkpointChecksum: hash(JSON.stringify(data.checkpoint)) } };
}

test('explicit callback bytes are validated before planning, scoped to all six server associations and independently owned', () => {
  const value = input(), result = prepared(value), ref = result.replayInput.callbackInput;
  assert.ok(ref, 'callback reference is required when explicitly supplied');
  assert.equal(result.replayInput.complete, true); assert.equal(ref.schemaVersion, 1);
  assert.equal(ref.kind, 'caff-evaluation-callback-input-reference-v1'); assert.deepEqual(ref.association, association());
  assert.equal(ref.blobHash, value.callbackInput.expectedTraceHash);
  const b = result.plans.find(p => p.hash === ref.blobHash);
  assert.equal(b.content.toString(), value.callbackInput.trace); assert.equal(b.content.buffer.byteLength, b.content.length);
  value.callbackInput.trace = 'caller changed'; value.agentId = 'later';
  assert.deepEqual(ref.association, association()); assert.equal(b.content.toString(), JSON.stringify(trace()));
  const cp = { schemaVersion: 1, ...association(), files: {}, replayInput: result.replayInput };
  assert.ok(checkpointBlobHashes(cp).includes(ref.blobHash));
});

test('all association mismatches, malformed packets and unsupported/secret states are incomplete with no rejected bytes or hashes', () => {
  const changes = [
    ...Object.keys(association()).map(key => v => { v[key] = 'other'; }),
    v => { v.callbackInput.expectedTraceHash = '0'.repeat(64); }, v => { v.callbackInput.trace = undefined; },
    v => { v.callbackInput = undefined; }, v => { v.callbackInput.extra = true; },
    v => { const x = trace(); x.privateMessages.push({ content: 'PRIVATE_CANARY' }); v.callbackInput.trace = JSON.stringify(x); v.callbackInput.expectedTraceHash = hash(v.callbackInput.trace); },
    v => { const x = trace(); x.pendingDelegations.push({ id: 'pending' }); v.callbackInput.trace = JSON.stringify(x); v.callbackInput.expectedTraceHash = hash(v.callbackInput.trace); },
    v => { const x = trace(); x.publicMessages[0].content = 'api_key=PRIVATE_CANARY'; v.callbackInput.trace = JSON.stringify(x); v.callbackInput.expectedTraceHash = hash(v.callbackInput.trace); },
    v => { const x = trace(); x.publicMessages[0].images = []; v.callbackInput.trace = JSON.stringify(x); v.callbackInput.expectedTraceHash = hash(v.callbackInput.trace); },
    v => { v.callbackInput.trace = ' '.repeat(4 * 1024 * 1024 + 1); v.callbackInput.expectedTraceHash = hash(v.callbackInput.trace); },
  ];
  for (const change of changes) {
    const value = input(); change(value); const result = prepared(value);
    assert.equal(result.replayInput.complete, false, 'requested bad callback input cannot be silently ignored');
    assert.equal(result.replayInput.callbackInput, undefined);
    assert.deepEqual(result.replayInput.incompleteReasons, ['callback_input_unavailable']);
    assert.equal(JSON.stringify(result).includes('PRIVATE_CANARY'), false);
    const rejectedHash = value.callbackInput?.expectedTraceHash;
    assert.equal(result.plans.some(p => p.hash === rejectedHash), false);
  }
});

test('legacy absence is not invented into a callback source; explicit request with no source is incomplete', t => {
  const value = input(); delete value.callbackInput;
  assert.equal(prepared(value).replayInput.callbackInput, undefined);
  assert.equal(prepared(value).replayInput.complete, true, 'legacy diagnostics keep their old input dimensions');
  const h = fixture(t), c = prepareRetainedInitializationCapsule(h.request);
  assert.throws(() => plan(c.capsule, { capsuleHash: c.capsuleHash, checkpointChecksum: c.provenance.checkpointChecksum }, association()), { code: 'callback_input_missing' });
  assert.equal(prepared({ ...value, callbackInput: null }).replayInput.complete, false);
});

test('fresh/resume source survives live-manifest removal, retains the exact CAS closure and revalidates callback bytes in preflight/capsule', t => {
  for (const mode of ['fresh', 'resume']) {
    const { h, c, expected } = retained(t, mode), data = JSON.parse(c.capsule), ref = h.r.callbackInput;
    fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
    const preparedAgain = prepareRetainedInitializationCapsule(h.request);
    assert.equal(preparedAgain.capsule, c.capsule);
    assert.ok(data.blobs.some(b => b.sha256 === ref.blobHash));
    assert.deepEqual(data.blobs.map(b => b.sha256), checkpointBlobHashes(h.cp));
    const inspected = inspectRetainedReplayInputs({ captureRoot: h.root, association: h.request.association, flagId: h.request.flagId });
    assert.equal(inspected.callbackInputHash, ref.blobHash);
    assert.ok(decodeInitializationCapsule(c.capsule, expected).files.some(f => f.path === 'materials/blobs/' + ref.blobHash));
    const p = plan(c.capsule, expected, association());
    assert.deepEqual(p.callbackInput, { trace: JSON.stringify(trace()), expectedTraceHash: ref.blobHash, association: association() });
    assert.equal(p.receipt.deliveryMode, mode); assert.equal(p.receipt.checkpointChecksum, expected.checkpointChecksum);
    for (const k of ['launchAuthorized', 'runnable', 'faithfulReplay', 'strictEvalEligible']) assert.equal(p.receipt[k], false);
    fs.writeFileSync(h.blobPath(ref.blobHash), 'corrupt');
    assert.throws(() => prepareRetainedInitializationCapsule(h.request), { code: 'replay_blob_corrupt' });
    assert.deepEqual(plan(c.capsule, expected, association()), p, 'returned capsule never consults live DB/blob/session paths');
  }
});

test('missing CAS refuses sealing and malformed/cross-checkpoint references refuse retention', t => {
  const p = prepared(); assert.ok(p.replayInput.callbackInput);
  assert.throws(() => fixture(t, 'fresh', ({ r }) => { r.callbackInput = p.replayInput.callbackInput; }), { code: 'retention_blob_missing' });
  for (const change of [r => { r.schemaVersion = 2; }, r => { r.kind = 'unknown'; }, r => { r.extra = 'ignored'; },
    r => { r.blobHash = ''; }, r => { r.association.agentId = 'other'; }, r => { r.association.extra = true; }]) {
    const result = prepared(), ref = structuredClone(result.replayInput.callbackInput); change(ref);
    assert.throws(() => checkpointBlobHashes({ schemaVersion: 1, ...association(), files: {}, replayInput: { ...result.replayInput, callbackInput: ref } }), { code: 'retention_manifest_invalid' });
  }
});

test('independently re-signed capsules cannot hide malformed callback bytes, reference drift, extras or caller association drift', t => {
  const { c, expected } = retained(t), original = JSON.parse(c.capsule);
  for (const change of [
    d => { d.checkpoint.replayInput.callbackInput.association.turnId = 'wrong'; },
    d => { d.checkpoint.replayInput.callbackInput.extra = true; },
    d => { d.blobs = d.blobs.filter(b => b.sha256 !== d.checkpoint.replayInput.callbackInput.blobHash); },
    d => { d.blobs.push({ sha256: hash('extra'), base64: Buffer.from('extra').toString('base64') }); },
    d => { const old = d.checkpoint.replayInput.callbackInput.blobHash; const v = trace(); v.pendingDelegations.push({ id: 'not-supported' });
      const bytes = JSON.stringify(v), digest = hash(bytes); d.blobs.find(b => b.sha256 === old).sha256 = digest;
      d.blobs.find(b => b.sha256 === digest).base64 = Buffer.from(bytes).toString('base64'); d.checkpoint.replayInput.callbackInput.blobHash = digest; },
  ]) {
    const d = structuredClone(original); change(d); const altered = repack(d);
    assert.throws(() => decodeInitializationCapsule(altered.capsule, altered.expected));
    assert.throws(() => plan(altered.capsule, altered.expected, association()));
  }
  for (const key of Object.keys(association())) assert.throws(() => plan(c.capsule, expected, { ...association(), [key]: 'other' }));
  assert.throws(() => plan(c.capsule + ' ', expected, association()));
});

test('sealed message association must match callback assistant even when every manifest/blob checksum is valid', t => {
  const p = prepared(); assert.ok(p.replayInput.callbackInput);
  const other = trace(); other.association.assistantMessageId = 'other-assistant';
  const q = prepared({ ...input(other), assistantMessageId: 'other-assistant' });
  const h = fixture(t, 'fresh', ({ r, put }) => {
    r.callbackInput = q.replayInput.callbackInput;
    put(q.plans.find(p => p.hash === r.callbackInput.blobHash).content);
  });
  assert.throws(() => prepareRetainedInitializationCapsule(h.request), { code: 'callback_input_association_mismatch' });
  assert.equal(fs.existsSync(h.runDir), false);
});

test('real publisher stages/deduplicates callback bytes, accounts usage, reopens and seals; bad raw writer plans persist nothing', t => {
  const os = require('node:os'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-callback-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const { createCaptureStore } = require(base + 'capture-store'), { publishPreparedCheckpoint } = require(base + 'checkpoint-publication');
  const { saveSealedCase } = require(base + 'sealed-case');
  const store = createCaptureStore({ captureRoot: path.join(root, 'capture') });
  // Explicit test-only raw writer policy, not management authorization/enable.
  store.savePolicy({ ...store.loadPolicy('p1'), status: 'enabled' });
  const p = prepared(), cp = { schemaVersion: 1, checkpointId: 'cp1', ...association(), createdAt: new Date().toISOString(),
    status: 'staged', targetDir: root, files: {}, deletions: [], strictEvalEligible: false, replayInput: p.replayInput, stats: {} };
  const blobs = new Map(p.plans.map(b => [b.hash, b.content]));
  const bad = structuredClone(cp), unsafe = trace(); unsafe.pendingDelegations.push({ id: 'unsupported-pending' });
  const badBytes = Buffer.from(JSON.stringify(unsafe)); bad.replayInput.callbackInput.blobHash = hash(badBytes);
  const badBlobs = new Map(blobs); badBlobs.delete(p.replayInput.callbackInput.blobHash); badBlobs.set(hash(badBytes), badBytes);
  const refused = publishPreparedCheckpoint({ store, checkpoint: bad, blobs: badBlobs });
  assert.equal(refused.reason, 'checkpoint_material_invalid'); assert.equal(store.computeUsage('p1').blobCount, 0);
  assert.equal(store.loadCheckpoint('p1', 'cp1'), null);
  const result = publishPreparedCheckpoint({ store, checkpoint: cp, blobs });
  assert.equal(result.captured, true, result.reason); assert.equal(store.computeUsage('p1').blobCount, blobs.size);
  assert.equal(result.checkpoint.stats.newBlobBytes, [...blobs.values()].reduce((n, b) => n + b.length, 0));
  const restarted = createCaptureStore({ captureRoot: store.captureRoot });
  assert.deepEqual(restarted.loadCheckpoint('p1', 'cp1').replayInput.callbackInput, p.replayInput.callbackInput);
  const second = publishPreparedCheckpoint({ store: restarted, checkpoint: { ...cp, checkpointId: 'cp2' }, blobs });
  assert.equal(second.captured, true, second.reason); assert.equal(second.checkpoint.stats.newBlobBytes, 0);
  assert.equal(restarted.computeUsage('p1').blobCount, blobs.size);
  const sealAssociation = { projectId: 'p1', checkpointId: 'cp1', conversationId: 'c1', messageId: 'msg1', turnId: 't1', agentId: 'a1', taskId: 'task1', runId: 1 };
  const request = { captureRoot: store.captureRoot, association: sealAssociation, flagId: 'flag-' + hash('p1\0msg1'), replayRunId: 'new-run' };
  saveSealedCase(request); const c = prepareRetainedInitializationCapsule(request);
  assert.equal(plan(c.capsule, { capsuleHash: c.capsuleHash, checkpointChecksum: c.provenance.checkpointChecksum }, association()).callbackInput.trace, JSON.stringify(trace()));
  // Retention also revalidates real callback bytes, not only CAS digest/sentinel.
  const corrupt = { ...bad, checkpointId: 'bad-raw' }; restarted.writeBlob('p1', hash(badBytes), badBytes); restarted.saveCheckpoint('p1', corrupt);
  assert.throws(() => saveSealedCase({ ...request, association: { ...sealAssociation, checkpointId: 'bad-raw', messageId: 'bad-msg' },
    flagId: 'flag-' + hash('p1\0bad-msg') }), { code: 'retention_manifest_invalid' });
});

test('fixed distribution supplies shared callback validation needed by the retained restore entry exactly once', () => {
  const inventory = require('../../scripts/badcase-capture/evaluation-bridge-files.json');
  for (const name of ['callback-input', 'evaluation-trace']) assert.equal(inventory.build.filter(p => p === 'build/server/domain/runtime/badcase-capture/' + name + '.js').length, 1);
});

test('the same sealed callback input launches two independent mutable callback DBs without model/SDK access or source changes', async t => {
  const { h, c, expected } = retained(t, 'resume'), before = c.capsule, p = plan(c.capsule, expected, association());
  const { startEvaluationCallback } = require(base + 'evaluation-callback'), services = [];
  t.after(async () => { for (const s of services) await s.stop(); });
  // Register stop before fixture cleanup; the callback sources are synthetic owned inputs.
  const start = async suffix => { const s = await startEvaluationCallback({ ...p.callbackInput, directory: path.join(h.root, suffix), lifetimeMs: 10000 }); services.push(s); return s; };
  const a = await start('callback-a'), b = await start('callback-b');
  assert.notEqual(a.databasePath, b.databasePath); assert.notDeepEqual(a.credentials, b.credentials);
  async function read(s) { const u = new URL(s.apiUrl + '/api/agent-tools/context'); for (const [k, v] of Object.entries(s.credentials)) u.searchParams.set(k, v);
    const r = await fetch(u, { headers: { Connection: 'close' } }); assert.equal(r.status, 200); return r.json(); }
  const initial = await read(a);
  assert.deepEqual(initial.publicMessages.map(m => m.content), trace().publicMessages.map(m => m.content));
  assert.equal(initial.conversation.metadata.inputMarker, 'PRE_TURN_ROOM');
  const r = await fetch(a.apiUrl + '/api/agent-tools/post-message', { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ ...a.credentials, visibility: 'public', content: 'Only A changed.', noFinalize: true }) });
  assert.equal(r.status, 200); await r.json();
  assert.equal((await read(a)).publicMessages.at(-1).content, 'Only A changed.');
  assert.equal(JSON.stringify(await read(b)).includes('Only A changed.'), false);
  await a.stop(); await b.stop();
  assert.equal(c.capsule, before); assert.deepEqual(plan(c.capsule, expected, association()), p);
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const store = createChatAppStore({ agentDir: path.dirname(a.databasePath), sqlitePath: a.databasePath });
  try { assert.equal(store.getMessage('msg1').content, 'Only A changed.'); assert.equal(store.getMessage('user1').content, 'Original question.'); }
  finally { store.close(); }
});
