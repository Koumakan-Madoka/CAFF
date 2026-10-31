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
    change({ cp, r, config, put, trace }); r.harness.configSnapshotHash = put(JSON.stringify(config));
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
function gptFamily(t, change = () => {}) {
  return portable(t, value => {
    const { cp, r, config, put, trace } = value;
    cp.agentId = 'role-family-gpt'; config.agentName = 'GPT';
    trace.association.agentId = cp.agentId;
    trace.participants = [{ id: cp.agentId, name: 'GPT', description: 'OpenAI GPT 模型族' }];
    r.callbackInput.association = trace.association;
    r.callbackInput.blobHash = put(JSON.stringify(trace));
    const role = 'Rules:\n- Reply as this agent only.\n- Respond in the user language.';
    const header = 'Your visible agent name: GPT\n\n';
    r.promptBlobHash = r.normalizedPromptHash = put(header + role + '\n\nUser: Read files.');
    r.roleSpan = { start: header.length, end: header.length + role.length, sha256: sha(role) };
    change(value);
  });
}
test('actual GPT family rules are an appendable role span without inventing a persona or changing common inputs', t => {
  const f = gptFamily(t), original = prepareSealedDirectTurn(f.request);
  assert.equal(original.supported, true);
  assert.equal(original.originalRole, '- Reply as this agent only.\n- Respond in the user language.');
  const candidateRole = original.originalRole + '\n\nWikiSkill 已审核准则：\n- 核验后报告。';
  const candidate = prepareSealedDirectTurn(f.request, candidateRole);
  assert.equal(candidate.supported, true);
  assert.equal(candidate.input.prompt, original.input.prompt.replace('Rules:\n' + original.originalRole, 'Rules:\n' + candidateRole));
  assert.doesNotMatch(candidate.input.prompt, /Your private persona instructions:/);
  assert.deepEqual({ ...original.input, prompt: '' }, { ...candidate.input, prompt: '' });
  assert.equal(candidate.provenance.commonInputHash, original.provenance.commonInputHash);
  assert.equal(candidate.provenance.originalRoleHash, original.provenance.originalRoleHash);
  assert.equal(candidate.input.prompt.startsWith('Your visible agent name: GPT\n\n'), true);
});
test('real sealed family anchor flows through candidate creation, confirmation and original/candidate preflight without injected preparers', t => {
  const f = gptFamily(t);
  const path = require('node:path');
  const config = { captureRoot: f.root, sourceWorktree: f.root + '-source', projectId: 'p1' };
  const store = require('../../build/server/domain/runtime/badcase-capture/wiki-store').createWikiStore(config);
  const source = store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'p1', conversationId: 'old-room', messageId: 'old-message', agentId: 'role-family-gpt' },
    role: 'GPT', actual: 'Unverified report', expected: 'Use distinct confirmed facts.', message: 'done', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]).cases[0];
  const version = store.saveDraft({ caseIds: [source.id], model: 'deepseek/deepseek-v4-flash', entries: [{ title: 'Evidence', failureMode: 'Unsupported claim', symptoms: 'Premature report',
    rootCauseHypothesis: 'Skipped inspection', guideline: '核验后再汇报。', caseIds: [source.id] }], unclassified: [] });
  store.review({ versionId: version.id, entryId: version.entries[0].id, expectedRevision: store.read().revision, decision: 'approved' });
  const candidate = require('../../scripts/badcase-capture/create-wiki-candidate.cjs').createCandidate({ ...config, request: f.request, versionId: version.id, entryIds: [version.entries[0].id] });
  const comparison = { request: f.request, repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), image: { imageId: 'sha256:' + 'd'.repeat(64) },
    repeats: 3, wikiCandidate: { sourceWorktree: config.sourceWorktree, candidateId: candidate.id }, rules: { kind: 'file-literals-v1', files: [{ path: 'source.txt', contains: ['retained bytes'], notContains: [] }] } };
  const { prepareComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs');
  assert.throws(() => prepareComparison(comparison), e => e.code === 'wiki_candidate_confirmation_required');
  store.confirmCandidate({ candidateId: candidate.id, candidateRoleHash: candidate.candidateRoleHash, expectedRevision: store.read().revision });
  const plan = prepareComparison(comparison);
  assert.equal(plan.supported, true);
  assert.equal(plan.inputs.candidate.prompt, plan.inputs.original.prompt.replace('Rules:\n' + candidate.baseRole, 'Rules:\n' + candidate.candidateRole));
  assert.deepEqual({ ...plan.inputs.original, prompt: '' }, { ...plan.inputs.candidate, prompt: '' });
  assert.equal(candidate.anchor.originalRoleHash, f.r.roleSpan.sha256);
  assert.doesNotMatch(plan.inputs.candidate.prompt, /Your private persona instructions:/);
});
test('family support does not synthesize missing old spans or accept Rules for custom or other family identities', t => {
  const legacy = gptFamily(t, ({ r }) => { delete r.roleSpan; });
  assert.equal(prepareSealedDirectTurn(legacy.request).supported, false);
  const custom = portable(t, ({ r, put }) => {
    const role = 'Rules:\n- Read files.';
    r.promptBlobHash = r.normalizedPromptHash = put(role);
    r.roleSpan = { start: 0, end: role.length, sha256: sha(role) };
  });
  assert.equal(prepareSealedDirectTurn(custom.request).supported, false);
  const otherFamily = gptFamily(t, ({ cp, r, trace, put }) => {
    cp.agentId = trace.association.agentId = 'role-family-kimi';
    trace.participants = [{ id: cp.agentId, name: 'Kimi', description: 'Moonshot Kimi 模型族' }];
    r.callbackInput.blobHash = put(JSON.stringify(trace));
  });
  assert.equal(prepareSealedDirectTurn(otherFamily.request).supported, false);
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
