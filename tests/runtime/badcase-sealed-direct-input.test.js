const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), crypto = require('node:crypto');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { prepareSealedDirectTurn } = require('../../scripts/badcase-capture/sealed-direct-input.cjs');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function portable(t, change = () => {}) {
  return fixture(t, 'fresh', ({ cp, r, config, put }) => {
    config.toolBridgeEnabled = true;
    config.portableRuntime = { schemaVersion: 1, kind: 'portable-default-resources-v1', supported: true };
    config.sdkStartConfig = { cwd: cp.targetDir, provider: r.runConfig.provider, model: r.runConfig.model,
      resume: false, thinking: 'off', fast: false, retireUserScopeSkills: true };
    const role = 'Your private persona instructions:\nRead only.';
    const prompt = 'header\n\n' + role + '\n\nuser task';
    r.roleSpan = { start: 8, end: 8 + role.length, sha256: sha(role) };
    r.promptBlobHash = r.normalizedPromptHash = put(prompt);
    const association = { projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1', userMessageId: 'u1', assistantMessageId: 'msg1' };
    const trace = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association,
      assistantCreatedAt: '2026-01-01T00:00:01.000Z', conversation: { title: 'Test', type: 'standard', metadata: {} },
      participants: [{ id: 'a1', name: config.agentName, description: 'Test' }], publicMessages: [
        { id: 'u1', turnId: 't0', role: 'user', agentId: null, senderName: 'User', content: 'Read files.', status: 'completed',
          createdAt: '2026-01-01T00:00:00.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] }], privateMessages: [], pendingDelegations: [] };
    r.callbackInput = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-reference-v1', blobHash: put(JSON.stringify(trace)), association };
    change({ cp, r, config, put }); r.harness.configSnapshotHash = put(JSON.stringify(config));
  });
}
test('sealed portable input preserves real start bytes, changes only declared role, and never touches source/archive', t => {
  const f = portable(t), before = fs.readFileSync(f.source);
  const a = prepareSealedDirectTurn(f.request), b = prepareSealedDirectTurn(f.request, 'Read only. Verify each file.');
  assert.equal(a.supported, true, JSON.stringify(a)); assert.equal(b.supported, true);
  assert.equal(a.originalRole, 'Read only.'); assert.equal(b.originalRole, a.originalRole, 'anchor always exposes archived original, not candidate');
  assert.equal(a.input.sessionText, null); assert.equal(a.input.settings, null); assert.equal(a.input.systemPrompt, null);
  assert.equal(a.input.files[0].base64, Buffer.from('retained bytes').toString('base64'));
  assert.deepEqual(Object.keys(a.input.callback).sort(), ['association', 'expectedTraceHash', 'trace'], 'callback constructor accepts only its three archived input fields');
  assert.equal(a.provenance.commonInputHash, b.provenance.commonInputHash);
  assert.equal(a.provenance.originalRoleHash, b.provenance.originalRoleHash);
  assert.deepEqual({ ...a.input, prompt: '' }, { ...b.input, prompt: '' });
  assert.equal(b.input.prompt, a.input.prompt.replace('Read only.', 'Read only. Verify each file.'));
  assert.deepEqual(fs.readFileSync(f.source), before); assert.equal(a.provenance.strictEvalEligible, false);
  for (const role of ['', '{{CAFF_CHAT_CALLBACK_TOKEN}}', 'sk-' + 'x'.repeat(32)]) assert.equal(prepareSealedDirectTurn(f.request, role).supported, false);
});
test('blanket Windows metadata limitation is not a strict certificate; portable/default-resource declaration is still mandatory', t => {
  const f = portable(t, ({ r }) => { r.complete = false; r.incompleteReasons = ['windows_capture_subset_unverified']; });
  assert.equal(prepareSealedDirectTurn(f.request).supported, true);
});
test('missing/legacy/delta/session/resources/corrupt material stays unsupported, never synthesized or silently made fresh', t => {
  const changes = [({ r }) => { delete r.roleSpan; }, ({ r }) => { r.roleSpan.sha256 = '0'.repeat(64); },
    ({ config }) => { delete config.portableRuntime; }, ({ config }) => { config.portableRuntime.supported = false; },
    ({ config }) => { config.sdkStartConfig.thinking = 'high'; }, ({ r, put }) => { r.deliveryMode = 'resume'; r.sessionBlobHash = put('not an empty fresh session'); },
    ({ r }) => { r.invocationImageCount = 1; }, ({ r }) => { r.unverifiedDimensions = ['unknown']; },
    ({ r }) => { r.complete = false; r.incompleteReasons = ['harness_config_unverified']; },
    ({ r }) => { r.complete = false; r.incompleteReasons = []; }, ({ r }) => { r.runConfig.skillIds = ['missing']; }];
  for (const change of changes) {
    const f = portable(t, change); assert.deepEqual(prepareSealedDirectTurn(f.request), { supported: false, reason: 'unsupported_or_missing_replay_materials' });
  }
  const broken = portable(t); fs.unlinkSync(broken.blobPath(broken.r.promptBlobHash));
  assert.equal(prepareSealedDirectTurn(broken.request).supported, false);
});
