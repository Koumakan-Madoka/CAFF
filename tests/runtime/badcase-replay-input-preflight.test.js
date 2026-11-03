const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCaptureStore, sha256Hex: hash } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { saveSealedCase } = require('../../build/server/domain/runtime/badcase-capture/sealed-case');
const { inspectRetainedReplayInputs } = require('../../build/server/domain/runtime/badcase-capture/replay-input-preflight');
function fixture(t, mode = 'fresh', change = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-input-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root });
  const put = value => { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); const h = hash(b); store.writeBlob('p1', h, b); return h; };
  const config = { piVersion: 'pi:0.85.1', agentPromptVersion: 'v1', toolBridgeEnabled: true, deliveryMode: mode, agentName: 'synthetic' };
  const session = [{ type: 'session', version: 3, id: 's1', cwd: '/synthetic' },
    { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'previous synthetic instruction' } }];
  const r = { deliveryMode: mode, complete: true, incompleteReasons: [], verifiedDimensions: [], unverifiedDimensions: [],
    invocationImageCount: 0, controlledReplacements: [], promptBlobHash: put('synthetic next instruction'),
    sessionBlobHash: mode === 'resume' ? put(session.map(x => JSON.stringify(x)).join('\n')) : '',
    runConfig: { provider: 'synthetic', model: 'no-model-call', promptVersion: 'v1', skillIds: ['s1'], conversationSkillIds: [] },
    harness: { serverVersion: 'fixture-v1', configSnapshotHash: put(JSON.stringify(config)),
      skillSnapshots: [{ id: 's1', source: 'synthetic', sha256: put('skill body'), blobHash: put('skill body') }] } };
  r.normalizedPromptHash = r.promptBlobHash;
  const cp = { schemaVersion: 1, projectId: 'p1', checkpointId: 'cp1', conversationId: 'c1', turnId: 't1', agentId: 'a1',
    files: {}, deletions: [], uncaptured: [], targetDir: '/synthetic', replayInput: r };
  change({ r, cp, config, session, put });
  store.saveCheckpoint('p1', cp);
  const association = { projectId: 'p1', checkpointId: 'cp1', conversationId: 'c1', messageId: 'msg1', turnId: 't1', agentId: 'a1', taskId: 'task1', runId: 1 };
  const request = { captureRoot: root, association, flagId: 'flag-' + hash('p1\0msg1') };
  saveSealedCase(request);
  const source = path.join(root, 'projects/p1/retention', hash(request.flagId) + '.json');
  const blobPath = h => path.join(root, 'projects/p1/blobs', h.slice(0, 2), h);
  return { request, root, r, cp, store, source, blobPath };
}
function rewrite(h, change) {
  const e = JSON.parse(fs.readFileSync(h.source)); change(e.record.checkpoint);
  e.checksum = hash(JSON.stringify(e.record)); fs.writeFileSync(h.source, JSON.stringify(e));
}
test('fresh/resume use only frozen inputs; inspection is read-only and not launch authority', t => {
  for (const mode of ['fresh', 'resume']) {
    const h = fixture(t, mode); fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
    const before = h.store.computeUsage('p1'); const source = fs.readFileSync(h.source);
    const result = inspectRetainedReplayInputs(h.request);
    assert.equal(result.deliveryMode, mode); assert.equal(result.inputMaterialsVerified, true);
    assert.equal(result.sessionBlobHash, h.r.sessionBlobHash); assert.equal(result.promptBlobHash, h.r.promptBlobHash);
    for (const key of ['runnable', 'reproduced', 'evaluable', 'strictEvalEligible', 'launchAuthorized']) assert.equal(result[key], false);
    assert.deepEqual(inspectRetainedReplayInputs(h.request), result);
    assert.deepEqual(h.store.computeUsage('p1'), before); assert.deepEqual(fs.readFileSync(h.source), source);
    assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/runReferences')), false);
    assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/.writer-lock')), false);
    assert.equal(JSON.stringify(result).includes('synthetic next instruction'), false);
    assert.equal(JSON.stringify(result).includes('previous synthetic instruction'), false);
    assert.equal(result.checkpointChecksum, hash(JSON.stringify(h.cp)));
  }
});
test('missing case/retention never recreates from live checkpoint', t => {
  for (const which of ['case', 'retention']) {
    const h = fixture(t); const dest = which === 'retention' ? h.source : path.join(h.root, 'projects/p1/cases', hash('msg1') + '.json');
    fs.unlinkSync(dest);
    assert.throws(() => inspectRetainedReplayInputs(h.request), { code: which === 'case' ? 'replay_case_missing' : 'replay_source_missing' });
    assert.equal(fs.existsSync(dest), false);
  }
});
test('all retained blobs are rechecked for missing/corrupt data on each inspection', t => {
  for (const kind of ['prompt', 'session', 'config', 'skill']) for (const missing of [true, false]) {
    const h = fixture(t, 'resume'); inspectRetainedReplayInputs(h.request);
    const digest = { prompt: h.r.promptBlobHash, session: h.r.sessionBlobHash, config: h.r.harness.configSnapshotHash, skill: h.r.harness.skillSnapshots[0].blobHash }[kind];
    if (missing) fs.unlinkSync(h.blobPath(digest)); else fs.writeFileSync(h.blobPath(digest), 'corrupted');
    assert.throws(() => inspectRetainedReplayInputs(h.request), { code: missing ? 'replay_blob_missing' : 'replay_blob_corrupt' });
  }
});
test('resume missing session blocks without changing mode; fresh with a session also rejects', t => {
  const h = fixture(t, 'resume', ({ r }) => { r.sessionBlobHash = ''; });
  const before = fs.readFileSync(h.source);
  assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_session_missing' });
  assert.deepEqual(fs.readFileSync(h.source), before);
  const fresh = fixture(t, 'fresh', ({ r, put }) => { r.sessionBlobHash = put('unexpected session'); });
  assert.throws(() => inspectRetainedReplayInputs(fresh.request), { code: 'replay_mode_conflict' });
});
test('complete declaration never overrides gaps, attachments or unverified dimensions', t => {
  for (const change of [
    ({ r }) => { r.complete = false; }, ({ r }) => { r.incompleteReasons = ['missing']; },
    ({ r }) => { r.unverifiedDimensions = ['unknown']; }, ({ r }) => { delete r.unverifiedDimensions; },
    ({ r }) => { r.invocationImageCount = 1; }, ({ r }) => { delete r.invocationImageCount; },
    ({ cp }) => { cp.uncaptured = [{ path: 'missing' }]; },
    ({ cp }) => { cp.files = { excluded: { type: 'file', secretExcluded: true } }; },
    ({ r }) => { r.secretExcludedPaths = ['missing']; },
    ({ cp }) => { cp.files = { linked: { type: 'symlink', linkTarget: 'missing' } }; },
  ]) {
    const h = fixture(t, 'fresh', change);
    assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_inputs_incomplete' });
  }
});
test('harness identity, prompt version and delivery mode must agree', t => {
  for (const change of [
    c => { c.piVersion = '999.0.0'; }, c => { c.deliveryMode = 'resume'; },
    c => { c.agentPromptVersion = 'other'; }, c => { delete c.toolBridgeEnabled; }, c => { c.agentName = null; },
  ]) {
    const h = fixture(t, 'fresh', ({ r, config, put }) => { change(config); r.harness.configSnapshotHash = put(JSON.stringify(config)); });
    assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_harness_invalid' });
  }
  const h = fixture(t, 'fresh', ({ r }) => { r.harness.configSnapshotHash = ''; });
  assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_harness_missing' });
});
test('prompt digest, required model metadata and exact skill inventory are enforced', t => {
  for (const change of [
    ({ r }) => { r.normalizedPromptHash = 'a'.repeat(64); },
    ({ r }) => { r.runConfig.provider = ''; }, ({ r }) => { r.runConfig.model = ''; },
    ({ r }) => { r.runConfig.skillIds = ['absent']; },
    ({ r }) => { r.harness.skillSnapshots.push({ ...r.harness.skillSnapshots[0] }); },
    ({ r }) => { r.runConfig.skillIds = []; },
    ({ r }) => { r.harness.skillSnapshots[0].source = ''; },
  ]) { const h = fixture(t, 'fresh', change); assert.throws(() => inspectRetainedReplayInputs(h.request), /replay_(prompt|config|skills)_invalid/); }
});
test('resume structure and dependencies are independently revalidated, not trusted from complete=true', t => {
  for (const which of ['broken', 'unknown', 'image', 'file-tool']) {
    const h = fixture(t, 'resume', ({ r, session, put }) => {
      if (which === 'broken') session[1].parentId = 'absent';
      if (which === 'unknown') session.push({ type: 'custom', id: 'x', parentId: 'm1', customType: 'unverified' });
      if (which === 'image') session[1].message.content = [{ type: 'image', data: 'eA==', mimeType: 'image/png' }];
      if (which === 'file-tool') session.push({ type: 'message', id: 'x', parentId: 'm1', message: { role: 'assistant', api: 'synthetic', provider: 'synthetic', model: 'no-model-call', usage: {}, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tc', name: 'read', arguments: { path: '/synthetic/data.txt' } }] } });
      r.sessionBlobHash = put(session.map(x => JSON.stringify(x)).join('\n'));
    });
    if (which === 'file-tool') assert.doesNotThrow(() => inspectRetainedReplayInputs(h.request));
    else assert.throws(() => inspectRetainedReplayInputs(h.request), { code: which === 'broken' ? 'replay_session_invalid' : 'replay_session_dependencies_unverified' });
  }
});
test('replacement inventory aggregates prompt/session counts; it does not reissue values', t => {
  const h = fixture(t, 'resume', ({ r, session, put }) => {
    r.promptBlobHash = r.normalizedPromptHash = put('use {{CAFF_CHAT_API_URL}}');
    session[1].message.content = 'old {{CAFF_CHAT_API_URL}}'; r.sessionBlobHash = put(session.map(x => JSON.stringify(x)).join('\n'));
    r.controlledReplacements = [{ name: 'CAFF_CHAT_API_URL', count: 1 }, { name: 'CAFF_CHAT_API_URL', count: 1 }];
  });
  assert.deepEqual(inspectRetainedReplayInputs(h.request).requiredReplacements, [{ name: 'CAFF_CHAT_API_URL', count: 2 }]);
  for (const records of [[], [{ name: 'CAFF_CHAT_API_URL', count: 1 }], [{ name: 'UNAPPROVED', count: 2 }], [{ name: 'CAFF_CHAT_API_URL', count: 2, value: 'disallowed' }]]) {
    rewrite(h, cp => { cp.replayInput.controlledReplacements = records; });
    assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_replacements_invalid' });
  }
});
test('UTF-8 loss, NUL and missing prompt cannot be treated as intact inputs', t => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from('a\0b')]) {
    const h = fixture(t, 'fresh', ({ r, put }) => { r.promptBlobHash = r.normalizedPromptHash = put(bytes); });
    assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_text_invalid' });
  }
  const h = fixture(t, 'fresh', ({ r }) => { r.promptBlobHash = ''; });
  assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_prompt_missing' });
});
test('metadata secrets are refused with fixed errors without echo; source remains untouched', t => {
  const h = fixture(t); rewrite(h, cp => { cp.replayInput.runConfig.model = 'sk-' + 'SYNTHETIC_ONLY_123456'; });
  const before = fs.readFileSync(h.source);
  assert.throws(() => inspectRetainedReplayInputs(h.request), e => e.code === 'replay_contains_secret' && e.message === e.code);
  assert.deepEqual(fs.readFileSync(h.source), before);
});
test('valid-hash secret bytes and aggregate size limit reject without writing', t => {
  for (const which of ['secret', 'size']) {
    const h = fixture(t), content = which === 'secret' ? Buffer.from('sk-' + 'SYNTHETIC_ONLY_123456') : Buffer.alloc(16 * 1024 * 1024, 'x');
    const digest = hash(content); h.store.writeBlob('p1', digest, content);
    const envelope = JSON.parse(fs.readFileSync(h.source));
    const r = envelope.record.checkpoint.replayInput, old = r.promptBlobHash;
    r.promptBlobHash = r.normalizedPromptHash = digest;
    envelope.record.blobHashes = envelope.record.blobHashes.map(h => h === old ? digest : h).sort();
    envelope.checksum = hash(JSON.stringify(envelope.record)); fs.writeFileSync(h.source, JSON.stringify(envelope));
    const before = h.store.computeUsage('p1');
    assert.throws(() => inspectRetainedReplayInputs(h.request), { code: which === 'secret' ? 'replay_contains_secret' : 'replay_size_limit' });
    assert.deepEqual(h.store.computeUsage('p1'), before);
  }
});
test('missing/future session versions and config JSON do not pass syntactic preflight', t => {
  for (const version of [undefined, 99]) {
    const h = fixture(t, 'resume', ({ r, session, put }) => {
      session[0].version = version; r.sessionBlobHash = put(session.map(x => JSON.stringify(x)).join('\n'));
    });
    assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_session_invalid' });
  }
  const h = fixture(t, 'fresh', ({ r, put }) => { r.harness.configSnapshotHash = put('not JSON'); });
  assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_harness_invalid' });
});
test('declared skill without archived snapshot rejects independently of extra snapshot checks', t => {
  const h = fixture(t, 'fresh', ({ r }) => { r.runConfig.skillIds.push('missing-snapshot'); });
  assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_skills_invalid' });
});
test('unapproved replacement name rejects even when its actual placeholder count agrees', t => {
  const h = fixture(t, 'fresh', ({ r, put }) => {
    r.promptBlobHash = r.normalizedPromptHash = put('{{UNAPPROVED}}');
    r.controlledReplacements = [{ name: 'UNAPPROVED', count: 1 }];
  });
  assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_replacements_invalid' });
});
test('empty server version is not sufficient harness identity', t => {
  const h = fixture(t, 'fresh', ({ r }) => { r.harness.serverVersion = ' '; });
  assert.throws(() => inspectRetainedReplayInputs(h.request), { code: 'replay_harness_missing' });
});
test('returned closure byte count and configuration hashes match independently read frozen bytes', t => {
  const h = fixture(t, 'resume'), result = inspectRetainedReplayInputs(h.request);
  const hashes = JSON.parse(fs.readFileSync(h.source)).record.blobHashes;
  assert.equal(result.blobCount, hashes.length);
  assert.equal(result.totalBlobBytes, hashes.reduce((n, digest) => n + fs.readFileSync(h.blobPath(digest)).length, 0));
  assert.equal(result.runConfigHash, hash(JSON.stringify(h.r.runConfig)));
  assert.equal(result.skillInventoryHash, hash(JSON.stringify(h.r.harness.skillSnapshots)));
  assert.equal(result.configSnapshotHash, h.r.harness.configSnapshotHash);
});
test('unknown input options and mismatched scope fail closed', t => {
  const h = fixture(t);
  assert.throws(() => inspectRetainedReplayInputs({ ...h.request, sessionPath: '/not-authorized' }), { code: 'replay_input_invalid' });
  assert.throws(() => inspectRetainedReplayInputs({ ...h.request, association: { ...h.request.association, turnId: 'other' } }));
});
