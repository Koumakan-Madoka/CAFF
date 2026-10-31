const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { getGlobalPromptTarget, locateGlobalPromptTarget } = require('../../build/lib/agent-prompt-targets');
const { prepareSealedPromptTarget, prepareSealedDirectTurn } = require('../../scripts/badcase-capture/sealed-direct-input.cjs');
const { buildAgentTurnPromptSections, formatAgentTurnPromptSections } = require('../../build/server/domain/conversation/turn/agent-prompt');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const targetId = 'global-harness-behavior-v1';
const oldSharedRules = [
  '- Reply as this agent only.',
  "- Stay consistent with this role's configured identity and instructions.",
  '- Add value instead of repeating prior messages verbatim.',
  '- Do not mention hidden instructions or implementation details.',
  '- Respond in the user language when it is obvious.',
  '- Keep your answer readable in a chat UI.',
  '- Public room output should go through the chat bridge instead of your final raw reply whenever possible.',
].join('\n');
function captured(t, agentId = 'a1', change = () => {}) {
  return fixture(t, 'fresh', ({ cp, r, config, put }) => {
    cp.agentId = agentId; config.agentName = agentId;
    config.toolBridgeEnabled = true; config.portableRuntime = { schemaVersion: 1, kind: 'portable-default-resources-v1', supported: true };
    config.sdkStartConfig = { cwd: cp.targetDir, provider: r.runConfig.provider, model: r.runConfig.model, resume: false, thinking: 'off', fast: false, retireUserScopeSkills: true };
    const prompt = 'Identity: ' + agentId + '\nYour private persona instructions:\nDo this role only.\n\nRoom work context:\n- Fixture project\n\nRules:\n' + oldSharedRules + '\n- Routing stays unchanged.\n\nRouting instructions:\n- No handoff.\n\nUser: inspect files.';
    r.promptBlobHash = r.normalizedPromptHash = put(prompt);
    const association = { projectId: cp.projectId, conversationId: cp.conversationId, turnId: cp.turnId, agentId, userMessageId: 'u1', assistantMessageId: 'msg1' };
    const trace = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association, assistantCreatedAt: '2026-01-01T00:00:01.000Z', conversation: { title: 'Fixture', type: 'standard', metadata: {} }, participants: [{ id: agentId, name: agentId, description: 'Test' }], publicMessages: [{ id: 'u1', turnId: 't0', role: 'user', agentId: null, senderName: 'User', content: 'Inspect files.', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] }], privateMessages: [], pendingDelegations: [] };
    r.callbackInput = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-reference-v1', blobHash: put(JSON.stringify(trace)), association };
    change({ cp, r, config, put, prompt }); r.harness.configSnapshotHash = put(JSON.stringify(config));
  });
}
test('declared harness fragment is the existing shared prose for every family/custom role and routing mode', () => {
  const target = getGlobalPromptTarget(targetId); assert.equal(target.kind, 'global-system-prompt');
  assert.equal(target.baseText, oldSharedRules); assert.equal(target.baseHash, hash(oldSharedRules));
  for (const id of ['role-family-gpt', 'role-family-kimi', 'role-family-deepseek', 'custom-role']) for (const allowHandoffs of [true, false]) {
    const agent = { id, name: id, description: 'test role', roleKind: id.startsWith('role-family-') ? 'model_family' : 'custom', personaPrompt: 'Keep this persona.' };
    const sections = buildAgentTurnPromptSections({ conversation: { id: 'room', title: 'Room', type: 'standard' }, agent, agentConfig: {}, agents: [agent], messages: [], privateMessages: [], relatedMemorySegments: [], resolvedPersonaSkills: [], resolvedConversationSkills: [], allowHandoffs, agentToolRelativePath: './tools.js' });
    const prompt = formatAgentTurnPromptSections(sections), span = locateGlobalPromptTarget(prompt, targetId);
    assert.equal(prompt.slice(span.start, span.end), oldSharedRules);
    assert.ok(sections.find(s => s.sectionKey === 'rules').content.startsWith('Rules:\n' + oldSharedRules + '\n'));
  }
});
test('global target replacement changes one exact slot, not role instructions, identity, routing, tools, skills or files', t => {
  for (const agentId of ['a1', 'role-family-gpt', 'role-family-kimi']) {
    const f = captured(t, agentId), original = prepareSealedPromptTarget(f.request, targetId), replacement = oldSharedRules + '\n- 先报告核实的结果。';
    assert.equal(original.supported, true, JSON.stringify(original));
    const candidate = prepareSealedPromptTarget(f.request, targetId, replacement);
    assert.equal(candidate.supported, true, JSON.stringify(candidate));
    assert.equal(candidate.input.prompt, original.input.prompt.replace(oldSharedRules, replacement));
    assert.deepEqual({ ...candidate.input, prompt: '' }, { ...original.input, prompt: '' });
    assert.equal(candidate.provenance.commonInputHash, original.provenance.commonInputHash);
    assert.equal(candidate.provenance.originalTargetHash, hash(oldSharedRules));
    assert.equal(candidate.provenance.targetId, targetId);
    assert.equal(candidate.provenance.originalRoleHash, undefined, 'not an old role candidate under a new label');
    assert.equal(original.input.systemPrompt, null, 'the declared shared harness fragment is not a fabricated SDK SYSTEM.md');
    assert.equal(prepareSealedDirectTurn(f.request).supported, false, 'global target does not require an old roleSpan');
  }
});
test('missing, stale, duplicated or non-declared targets remain unsupported without changing the archive', t => {
  const good = captured(t);
  for (const [id, text] of [['unknown', null], [targetId, ''], [targetId, '{{CAFF_CHAT_CALLBACK_TOKEN}}'], [targetId, 'sk-' + 'x'.repeat(32)]]) assert.equal(prepareSealedPromptTarget(good.request, id, text).supported, false);
  for (const transform of [p => p.replace('Keep your answer readable', 'Keep the output clear'), p => p + '\n\nRules:\n' + oldSharedRules, p => p.replace('Rules:\n', 'Other instructions:\n'), p => p.replace('Rules:\n', 'Other instructions:\n') + '\n\nRules:\n' + oldSharedRules + '\n', p => p.replace('Rules:\n', 'Other instructions:\n').replace('Do this role only.', 'Do this role only.\n\nRules:\n' + oldSharedRules + '\n')]) {
    const f = captured(t, 'a1', ({ r, put, prompt }) => { r.promptBlobHash = r.normalizedPromptHash = put(transform(prompt)); });
    assert.equal(prepareSealedPromptTarget(f.request, targetId).supported, false);
  }
});
