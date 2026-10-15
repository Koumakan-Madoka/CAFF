// No SDK on host: only data planning and injected transport receipts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const { planRetainedSdkDiagnostic, diagnosticReceipt, observedDiagnosticReceipt, verifyDiagnosticSessionCopy } = require('../../build/server/domain/runtime/badcase-capture/retained-sdk-diagnostic');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function prepared(t, mode = 'fresh', change) {
  const h = fixture(t, mode, change), p = prepareRetainedInitializationCapsule(h.request);
  return { h, p, expected: { capsuleHash: p.capsuleHash, checkpointChecksum: p.provenance.checkpointChecksum } };
}
function modify(p, mutate) {
  const d = JSON.parse(p.capsule);
  const replace = (old, text) => { const b = d.blobs.find(b => b.sha256 === old); b.sha256 = hash(text); b.base64 = Buffer.from(text).toString('base64'); return b.sha256; };
  mutate(d.checkpoint.replayInput, replace);
  const capsule = JSON.stringify(d);
  return { capsule, expected: { capsuleHash: hash(capsule), checkpointChecksum: hash(JSON.stringify(d.checkpoint)) } };
}
test('diagnostic plan retains invocation separately, mode, pure history and model without launch permission', t => {
  for (const mode of ['fresh', 'resume']) {
    const { p, expected } = prepared(t, mode);
    const a = planRetainedSdkDiagnostic(p.capsule, expected);
    assert.equal(a.mode, mode); assert.equal(a.invocation, 'synthetic retained invocation');
    assert.equal(a.provider, 'anthropic'); assert.equal(a.model, 'claude-sonnet-4-5');
    assert.deepEqual(a.messages, mode === 'resume' ? [{ role: 'user', content: 'synthetic retained history', timestamp: 1 }] : []);
    assert.equal(a.sessionId, mode === 'resume' ? 'synthetic-session' : null);
    assert.equal(a.sessionText === null, mode === 'fresh');
    const r = diagnosticReceipt(a);
    assert.equal(r.sessionObservationVersion, 1);
    assert.equal(r.invocationHash, hash(a.invocation));
    assert.equal(r.historyHash, hash(JSON.stringify(a.messages)));
    assert.equal(r.historyMessages, mode === 'resume' ? 1 : 0);
    assert.equal(r.diagnosticSystemPrompt, true); assert.equal(r.sdkInitialized, true);
    for (const k of ['invocationSubmitted', 'runnable', 'reproduced', 'evaluable', 'strictEvalEligible']) assert.equal(r[k], false);
    assert.equal(r.modelCalls, 0); assert.equal(r.networkCalls, 0);
    assert.equal(Object.hasOwn(r, 'invocation'), false); assert.equal(Object.hasOwn(r, 'sessionText'), false);
  }
});
test('unsupported skills, bridge and replacements are refused instead of discarded', t => {
  const { p } = prepared(t);
  const changes = [
    (r, replace) => { r.harness.configSnapshotHash = replace(r.harness.configSnapshotHash, JSON.stringify({ piVersion: 'pi:0.85.1', agentPromptVersion: 'v1', toolBridgeEnabled: true, deliveryMode: 'fresh', agentName: 'synthetic' })); },
    r => { r.runConfig.skillIds = ['unarchived']; },
    r => { r.runConfig.conversationSkillIds = ['unarchived']; },
    r => { r.controlledReplacements = [{ name: 'CAFF_CHAT_API_URL', count: 1 }]; },
  ];
  for (const change of changes) { const m = modify(p, change); assert.throws(() => planRetainedSdkDiagnostic(m.capsule, m.expected), { code: 'sdk_diagnostic_unsupported' }); }
});
test('container-side semantic check refuses incomplete replay flags and mismatched configuration', t => {
  const { p } = prepared(t);
  for (const change of [r => { r.unverifiedDimensions = ['unknown']; }, r => { r.invocationImageCount = 1; },
    r => { r.secretExcludedPaths = ['hidden']; }, r => { r.runConfig.provider = ''; },
    r => { r.runConfig.promptVersion = 'mismatch'; },
    (r, replace) => { r.harness.configSnapshotHash = replace(r.harness.configSnapshotHash, '{broken'); }]) {
    const m = modify(p, change); assert.throws(() => planRetainedSdkDiagnostic(m.capsule, m.expected), { code: 'sdk_diagnostic_unsupported' });
  }
});
test('resume rejects complex, non-linear, extra-field or corrupt history; never falls back to fresh', t => {
  const { p } = prepared(t, 'resume');
  const session = JSON.parse(p.capsule).blobs.find(b => b.sha256 === JSON.parse(p.capsule).checkpoint.replayInput.sessionBlobHash);
  const base = Buffer.from(session.base64, 'base64').toString().trim().split('\n').map(JSON.parse);
  for (const change of [e => { e[0].version = 2; }, e => { e[0].parentSession = '/host/private'; },
    e => { e[1].message.content = [{ type: 'image', data: 'AA==', mimeType: 'image/png' }]; },
    e => { e[1].parentId = 'missing'; }, e => { e[1].message.role = 'custom'; },
    e => { e.push({ type: 'thinking_level_change', id: 't2', parentId: 'm1', timestamp: '2026-01-01T00:00:00.003Z', thinkingLevel: 'high' }); },
    e => { e[1].message.extra = 'not silently dropped'; }]) {
    const entries = structuredClone(base); change(entries);
    const m = modify(p, (r, replace) => { r.sessionBlobHash = replace(r.sessionBlobHash, entries.map(e => JSON.stringify(e)).join('\n') + '\n'); });
    assert.throws(() => planRetainedSdkDiagnostic(m.capsule, m.expected), { code: 'sdk_diagnostic_unsupported' });
  }
});
test('working resume may append only the explicit off setting; archived bytes and history must not change', t => {
  const { p, expected } = prepared(t, 'resume'), plan = planRetainedSdkDiagnostic(p.capsule, expected);
  const extra = { type: 'thinking_level_change', id: 'new-id', parentId: 'm1', timestamp: '2026-01-01T00:00:01.000Z', thinkingLevel: 'off' };
  const actual = plan.sessionText + JSON.stringify(extra) + '\n';
  assert.doesNotThrow(() => verifyDiagnosticSessionCopy(plan, actual));
  for (const s of [plan.sessionText, actual.replace('synthetic retained history', 'synthetic retained historX'),
    plan.sessionText + JSON.stringify({ ...extra, thinkingLevel: 'high' }), plan.sessionText + JSON.stringify({ ...extra, parentId: null }), actual + JSON.stringify(extra)]) {
    assert.throws(() => verifyDiagnosticSessionCopy(plan, s), { code: 'sdk_diagnostic_unsupported' });
  }
  const complete = { ...plan, sessionText: actual, hasThinkingOff: true };
  assert.doesNotThrow(() => verifyDiagnosticSessionCopy(complete, actual));
  assert.throws(() => verifyDiagnosticSessionCopy(complete, actual + '\n'), { code: 'sdk_diagnostic_unsupported' });
  assert.equal(diagnosticReceipt(plan).workingSessionAppendedThinkingOff, true);
  assert.equal(diagnosticReceipt(plan).archivedSessionBytesUnchanged, true);
  assert.equal(diagnosticReceipt(complete).workingSessionAppendedThinkingOff, false);
});
test('observed receipt requires measured archive, working copy and missing-open results', t => {
  for (const mode of ['fresh', 'resume']) {
    const { p, expected } = prepared(t, mode), plan = planRetainedSdkDiagnostic(p.capsule, expected);
    const off = JSON.stringify({ type: 'thinking_level_change', id: 'new-id', parentId: 'm1', timestamp: '2026-01-01T00:00:01.000Z', thinkingLevel: 'off' }) + '\n';
    const observations = { archivedSessionBytes: mode === 'resume' ? Buffer.from(plan.sessionText) : null,
      workingSessionBytes: mode === 'resume' ? Buffer.from(plan.sessionText + off) : null,
      missingSessionId: 'observed-new-id', missingEntries: [], missingMessages: [] };
    assert.deepEqual(observedDiagnosticReceipt(plan, observations), diagnosticReceipt(plan));
    if (mode === 'resume') {
      const complete = { ...plan, sessionText: observations.workingSessionBytes.toString(), hasThinkingOff: true };
      assert.equal(observedDiagnosticReceipt(complete, { ...observations, archivedSessionBytes: Buffer.from(complete.sessionText) }).workingSessionAppendedThinkingOff, false);
      assert.throws(() => observedDiagnosticReceipt(plan, { ...observations, workingSessionBytes: Buffer.from(plan.sessionText) }), { code: 'sdk_diagnostic_unsupported' });
      assert.throws(() => observedDiagnosticReceipt(plan, { ...observations, workingSessionBytes: Buffer.concat([observations.workingSessionBytes, Buffer.from([0xff])]) }), { code: 'sdk_diagnostic_unsupported' });
    }
    for (const mutate of [o => { delete o.missingEntries; }, o => { o.missingEntries = [{}]; },
      o => { o.missingMessages = [{}]; }, o => { o.missingSessionId = ''; }, o => { o.missingSessionId = null; },
      o => { o.archivedSessionBytes = Buffer.from('changed archive'); }, o => { o.workingSessionBytes = Buffer.from('changed working copy'); },
      o => { o.unexpected = true; }]) {
      const changed = { ...observations }; mutate(changed);
      assert.throws(() => observedDiagnosticReceipt(plan, changed), { code: 'sdk_diagnostic_unsupported' });
    }
    for (const missing of [undefined, null, {}]) assert.throws(() => observedDiagnosticReceipt(plan, missing), { code: 'sdk_diagnostic_unsupported' });
  }
});
test('independent semantic boundaries reject unknown entries, mismatched delivery and missing newline', t => {
  const { p } = prepared(t, 'resume');
  const d = JSON.parse(p.capsule), r = d.checkpoint.replayInput;
  const read = h => Buffer.from(d.blobs.find(b => b.sha256 === h).base64, 'base64').toString();
  const session = read(r.sessionBlobHash), config = JSON.parse(read(r.harness.configSnapshotHash));
  const entries = session.trim().split('\n').map(JSON.parse);
  const unknown = structuredClone(entries); unknown[1] = { type: 'unknown', id: 'm1', parentId: null, timestamp: entries[1].timestamp };
  const changes = [
    (r, replace) => { r.sessionBlobHash = replace(r.sessionBlobHash, unknown.map(e => JSON.stringify(e)).join('\n') + '\n'); },
    (r, replace) => { r.harness.configSnapshotHash = replace(r.harness.configSnapshotHash, JSON.stringify({ ...config, deliveryMode: 'fresh' })); },
    (r, replace) => { r.sessionBlobHash = replace(r.sessionBlobHash, session.slice(0, -1)); },
  ];
  for (const change of changes) {
    const m = modify(p, change);
    assert.throws(() => planRetainedSdkDiagnostic(m.capsule, m.expected), { code: 'sdk_diagnostic_unsupported' });
  }
});
test('unsupported bridge stops before transport but keeps newly protected reference', async t => {
  const { runRetainedSdkDiagnostic } = require('../../scripts/badcase-capture/retained-sdk-diagnostic.cjs');
  const h = fixture(t, 'fresh', ({ r, config, put }) => { config.toolBridgeEnabled = true; r.harness.configSnapshotHash = put(JSON.stringify(config)); });
  let calls = 0;
  await assert.rejects(runRetainedSdkDiagnostic(h.request, {}, { runProbe: async () => { calls++; } }), { code: 'sdk_diagnostic_unsupported' });
  assert.equal(calls, 0); assert.equal(fs.readdirSync(h.runDir).length, 1);
});
test('new container entry refuses host before SDK import', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['scripts/badcase-capture/retained-sdk-container.cjs'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'retained_sdk_diagnostic_failed\n');
});
test('host wrapper protects before transport and returns only exact validated receipt, never raw text', async t => {
  const { runRetainedSdkDiagnostic } = require('../../scripts/badcase-capture/retained-sdk-diagnostic.cjs');
  const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
  const h = fixture(t, 'resume'); let calls = 0;
  const image = { imageId: 'sha256:' + 'a'.repeat(64), repositoryDigest: 'node@sha256:' + 'b'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
  const transport = async (_image, files, mutate = () => {}) => {
    calls++; assert.equal(fs.readdirSync(h.runDir).length, 1);
    const text = name => files.find(f => f.path === name).bytes.toString();
    assert.ok(!files.some(f => f.path.startsWith('snapshot/') || f.path === 'resume.jsonl'));
    const plan = planRetainedSdkDiagnostic(text('capsule.json'), JSON.parse(text('expected.json')));
    const manifest = manifestFor(files);
    const receipt = { ...diagnosticReceipt(plan), inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash };
    const run = { result: { code: 0, stdout: JSON.stringify(receipt) + '\n', stderr: '' }, manifest, containerId: 'c'.repeat(64) };
    mutate(run); return run;
  };
  const a = await runRetainedSdkDiagnostic(h.request, image, { runProbe: transport });
  assert.equal(a.sdkInitialized, true); assert.equal(a.cleaned, true); assert.equal(a.provenance.launchAuthorized, false);
  assert.equal(Object.hasOwn(a, 'stdout'), false); assert.equal(Object.hasOwn(a, 'stderr'), false);
  for (const mutate of [r => { r.result.code = 1; }, r => { r.result.failure = 'timeout'; }, r => { r.result.stdout += 'extra'; },
    r => { r.result.stderr = 'private'; }, r => { r.manifest.inputHash = 'bad'; }, r => { r.containerId = 'short'; },
    r => { const v = JSON.parse(r.result.stdout); v.runnable = true; r.result.stdout = JSON.stringify(v) + '\n'; },
    r => { const v = JSON.parse(r.result.stdout); delete v.sessionObservationVersion; r.result.stdout = JSON.stringify(v) + '\n'; }]) {
    await assert.rejects(runRetainedSdkDiagnostic(h.request, image, { runProbe: (i, f) => transport(i, f, mutate) }), { code: 'sdk_diagnostic_failed' });
    assert.equal(fs.readdirSync(h.runDir).length, 1);
  }
  const before = calls; fs.unlinkSync(h.blobPath(h.r.sessionBlobHash));
  await assert.rejects(runRetainedSdkDiagnostic(h.request, image, { runProbe: transport }), { code: 'replay_blob_missing' });
  assert.equal(calls, before);
});
