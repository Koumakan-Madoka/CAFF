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
    assert.ok(prompt.includes('- Speak publicly: node ./tools.js send-public [--no-finalize] --content-stdin (--no-finalize posts an interim update and keeps the current run active).'));
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
test('known adopted fragments use the longest exact archived slot; unknown WikiSkill additions never fall back to a prefix', t => {
  const adopted = oldSharedRules + '\n\nWikiSkill 已审核准则：\n- 先说明结果。';
  const known = [{ baseText: oldSharedRules, baseHash: hash(oldSharedRules) }, { baseText: adopted, baseHash: hash(adopted) }];
  const f = captured(t, 'role-family-gpt', ({ r, put, prompt }) => { r.promptBlobHash = r.normalizedPromptHash = put(prompt.replace(oldSharedRules, adopted)); });
  const original = prepareSealedPromptTarget(f.request, targetId, null, known);
  assert.equal(original.supported, true); assert.equal(original.baseText, adopted); assert.equal(original.provenance.originalTargetHash, hash(adopted));
  const next = adopted + '\n\nWikiSkill 已审核准则：\n- 只追加一个变化。';
  const replaced = prepareSealedPromptTarget(f.request, targetId, next, known);
  assert.equal(replaced.supported, true); assert.equal(replaced.input.prompt, original.input.prompt.replace(adopted, next));
  assert.equal(replaced.provenance.commonInputHash, original.provenance.commonInputHash);
  for (const bad of [undefined, known.slice(0, 1), [{ ...known[1], baseHash: 'f'.repeat(64) }]]) {
    assert.equal(prepareSealedPromptTarget(f.request, targetId, null, bad).supported, false);
  }
  for (const mutation of [adopted + '\n\nWikiSkill 已审核准则：\n- 未采纳的变化。', adopted.replace('先说明结果', '先说明影响')]) {
    const bad = captured(t, 'role-family-gpt', ({ r, put, prompt }) => { r.promptBlobHash = r.normalizedPromptHash = put(prompt.replace(oldSharedRules, mutation)); });
    assert.equal(prepareSealedPromptTarget(bad.request, targetId, null, known).supported, false);
  }
  const duplicate = captured(t, 'role-family-gpt', ({ r, put, prompt }) => { r.promptBlobHash = r.normalizedPromptHash = put(prompt.replace(oldSharedRules, adopted) + '\n\nRules:\n' + adopted + '\n'); });
  assert.equal(prepareSealedPromptTarget(duplicate.request, targetId, null, known).supported, false);
});
test('global target preflight distinguishes a real target failure from unrelated captured configuration limits', t => {
  const thinking = captured(t, 'role-family-gpt', ({ config }) => { config.sdkStartConfig.thinking = 'xhigh'; });
  assert.deepEqual(prepareSealedPromptTarget(thinking.request, targetId), { supported: false, reason: 'replay_recorded_thinking_not_supported' });
  const missing = captured(t, 'role-family-gpt', ({ r, put, prompt }) => { r.promptBlobHash = r.normalizedPromptHash = put(prompt.replace(oldSharedRules, 'other archived text')); });
  assert.deepEqual(prepareSealedPromptTarget(missing.request, targetId), { supported: false, reason: 'replay_declared_prompt_target_missing_or_invalid' });
});
test('missing, stale, duplicated or non-declared targets remain unsupported without changing the archive', t => {
  const good = captured(t);
  for (const [id, text] of [['unknown', null], [targetId, ''], [targetId, '{{CAFF_CHAT_CALLBACK_TOKEN}}'], [targetId, 'sk-' + 'x'.repeat(32)]]) assert.equal(prepareSealedPromptTarget(good.request, id, text).supported, false);
  for (const transform of [p => p.replace('Keep your answer readable', 'Keep the output clear'), p => p + '\n\nRules:\n' + oldSharedRules, p => p.replace('Rules:\n', 'Other instructions:\n'), p => p.replace('Rules:\n', 'Other instructions:\n') + '\n\nRules:\n' + oldSharedRules + '\n', p => p.replace('Rules:\n', 'Other instructions:\n').replace('Do this role only.', 'Do this role only.\n\nRules:\n' + oldSharedRules + '\n')]) {
    const f = captured(t, 'a1', ({ r, put, prompt }) => { r.promptBlobHash = r.normalizedPromptHash = put(transform(prompt)); });
    assert.equal(prepareSealedPromptTarget(f.request, targetId).supported, false);
  }
});
