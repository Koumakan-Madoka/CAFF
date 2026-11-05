// Pure synthetic evidence only. No providers, credentials, source files or tool execution.
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const api = () => require('../../build/server/domain/runtime/badcase-capture/wiki-dehydration');
const sha = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ids = {
  one: 'text-3ff896480224fea1cde010370be091785529db0b1b18d8b5e0648a0a4f15aa89',
  four: 'text-ea8201f3c1ddf0fa73043f88d2ac6e10eb2d3529ed3140e0a2261a63503cc40b',
};
function fixture() {
  const source = { projectId: null, conversationId: 'room', messageId: 'message', agentId: 'role-family-gpt' };
  const bundle = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', source, markedStep: 2,
    missingReasons: ['original_context_unavailable', 'model_duration_missing'], markedMessage: 'public reply', actual: 'actual issue', expected: 'expected behavior',
    context: { systemPrompt: 'historical cwd [REDACTED]', sections: [{ sectionKey: 'session_goal', content: 'Goal: fix this behavior' }],
      priorSessionEntries: [{ type: 'model_change', id: 'meta' }, { type: 'message', id: 'p1', message: { role: 'user', content: 'previous full CAFF rules and room history' } },
        { type: 'message', id: 'p2', message: { role: 'assistant', content: [{ type: 'text', text: 'previous reply' }] } }],
      trigger: { type: 'message', id: 'u1', message: { role: 'user', content: 'New messages since your last reply:\nUser: investigate this behavior' } } },
    steps: [
      { step: 1, entryId: 'a1', output: { role: 'assistant', content: [{ type: 'thinking', thinking: 'THOUGHT_MUST_NOT_REACH_JEV' },
        { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'test.md' } }] }, toolResults: [
          { type: 'message', id: 'r1', message: { role: 'toolResult', toolCallId: 'call', content: [{ type: 'text', text: 'result sensitive-test-needle ' + 'x'.repeat(60000) }] } }] },
      { step: 2, entryId: 'a2', output: { role: 'assistant', content: [{ type: 'toolCall', id: 'reply', name: 'bash',
        arguments: { command: "cat <<'MSG' | node bridge send-public --content-stdin\npublic reply\nMSG" } }] }, toolResults: [
          { type: 'message', id: 'r2', message: { role: 'toolResult', toolCallId: 'reply', content: [{ type: 'text', text: 'posted' }] } }] },
      { step: 3, entryId: 'a3', output: { role: 'assistant', content: [{ type: 'text', text: 'PRIVATE_BOOKKEEPING_AFTER_REPLY' }] }, toolResults: [] },
    ] };
  const caseRecord = { id: ids.one, n: 999, source: structuredClone(source), kind: 'text-only', split: 'train', actual: bundle.actual, expected: bundle.expected,
    candidate: 'CURRENT_CANDIDATE_MUST_NOT_REACH_JEV', evaluation: 'CURRENT_RESULTS_MUST_NOT_REACH_JEV', traceBundle: { hash: sha(bundle) } };
  const cause = { source: 'trigger', text: 'investigate this behavior' };
  return { bundle, caseRecord, cause, knownKeyValues: ['sensitive-test-needle'] };
}
function refresh(h) { h.caseRecord.traceBundle.hash = sha(h.bundle); return h; }
function answer(kind = 'single', cut = 'step_1', kp = .8, cp = .8) {
  return { model: 'jev-test', answers: {
    kind: { type: 'choice', choice: kind, probabilities: { single: kind === 'single' ? kp : .1, throughout: kind === 'throughout' ? kp : .1, unclear: kind === 'unclear' ? kp : .1 } },
    cut: { type: 'choice', choice: cut, probabilities: { step_1: cut === 'step_1' ? cp : .1, step_2: cut === 'step_2' ? cp : .1, none: cut === 'none' ? cp : .1 } },
  } };
}
test('request uses exactly the B6 fields, two questions last, and canonical page numbering instead of caller row ordinals', () => {
  const h = fixture(), before = structuredClone(h), built = api().buildDehydrationRequest(h);
  assert.equal(built.caseNumber, 1); assert.equal(built.caseId, h.caseRecord.id);
  assert.equal(built.traceHash, sha(h.bundle)); assert.equal(built.requestHash, sha(built.request));
  assert.deepEqual(Object.keys(built.request), ['state', 'questions']);
  assert.deepEqual(Object.keys(built.request.state), ['cause', 'steps', 'reply', 'actual', 'expected']);
  assert.deepEqual(Object.keys(built.request.questions), ['kind', 'cut']);
  assert.deepEqual(Object.keys(built.request.questions.kind.criteria), ['single', 'throughout', 'unclear']);
  assert.deepEqual(Object.keys(built.request.questions.cut.criteria), ['step_1', 'step_2', 'none']);
  assert.equal(built.request.state.cause, h.cause.text);
  const wire = JSON.stringify(built.request);
  assert.doesNotMatch(wire, /THOUGHT_MUST|PRIVATE_BOOKKEEPING|CURRENT_CANDIDATE|CURRENT_RESULTS|sensitive-test-needle|"split"/);
  assert.deepEqual(h, before);
});
test('step cards redact before clipping, retain message/plan head 500 tail 300 and actual error lines', () => {
  const h = fixture();
  h.bundle.steps[0].output.content = [{ type: 'toolCall', id: 'call', name: 'write', arguments: { path: 'design-plan.md', content: 'A'.repeat(500) + 'OMITTED' + 'Z'.repeat(300) } }];
  let built = api().buildDehydrationRequest(refresh(h));
  assert.equal(built.request.state.steps[0].kind, 'plan');
  assert.ok(built.request.state.steps[0].body.startsWith('A'.repeat(500)));
  assert.ok(built.request.state.steps[0].body.endsWith('Z'.repeat(300)));
  assert.ok(!built.request.state.steps[0].body.includes('OMITTED'));
  assert.equal(built.request.state.steps[1].body, 'public reply');
  h.bundle.steps[0].toolResults[0].message.isError = true;
  h.bundle.steps[0].toolResults[0].message.content = [{ type: 'text', text: 'boring\nError: sensitive-test-needle denied\nnormal\nfatal: exact failure' }];
  built = api().buildDehydrationRequest(refresh(h));
  assert.equal(built.request.state.steps[0].kind, 'error');
  assert.match(built.request.state.steps[0].body, /Error: \[\*\] denied\nfatal: exact failure/);
  assert.doesNotMatch(built.request.state.steps[0].body, /boring|normal/);
  h.bundle.steps[0].toolResults[0].message.isError = false;
  h.bundle.steps[0].output.content = [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a' } }];
  built = api().buildDehydrationRequest(refresh(h));
  assert.equal(built.request.state.steps[0].kind, 'ordinary');
  assert.ok(built.request.state.steps[0].body.length <= 120);
});
test('eligibility rejects real missing inputs, source-only case identities and source/hash mismatch, not broad legacy flags', () => {
  const h = fixture(); assert.equal(api().dehydrationAvailability(h.caseRecord, h.bundle).eligible, true);
  h.caseRecord.id = ids.four; h.caseRecord.split = 'train';
  assert.equal(api().dehydrationAvailability(h.caseRecord, h.bundle).reason, 'historical_source_only');
  h.caseRecord.id = ids.one;
  h.bundle.context.systemPrompt = null;
  assert.equal(api().dehydrationAvailability(h.caseRecord, h.bundle).reason, 'system_prompt_missing');
  assert.throws(() => api().buildDehydrationRequest(refresh(h)), e => e.code === 'wiki_dehydration_ineligible');
  h.bundle.context.systemPrompt = 'historical'; h.bundle.context.trigger = null;
  assert.equal(api().dehydrationAvailability(h.caseRecord, h.bundle).reason, 'turn_trigger_missing');
  const good = fixture(); good.bundle.source.messageId = 'different';
  assert.throws(() => api().buildDehydrationRequest(good), e => e.code === 'wiki_trace_association_mismatch');
  const stale = fixture(); stale.bundle.markedMessage += 'changed';
  assert.throws(() => api().buildDehydrationRequest(stale), e => e.code === 'wiki_trace_invalid');
});
test('cause must come from the frozen trigger or contemporaneous Goal, never current mutable context', () => {
  const h = fixture(); h.cause = { source: 'goal', text: 'fix this behavior' };
  assert.equal(api().buildDehydrationRequest(h).request.state.cause, 'fix this behavior');
  h.cause.text = 'made up current objective';
  assert.throws(() => api().buildDehydrationRequest(h), e => e.code === 'wiki_dehydration_cause_invalid');
  h.bundle.context.sections = [];
  h.bundle.context.priorSessionEntries[1].message.content = 'made up current objective, outside any Goal section';
  assert.throws(() => api().buildDehydrationRequest(refresh(h)), e => e.code === 'wiki_dehydration_cause_invalid');
  h.bundle.context.priorSessionEntries[1].message.content = 'CAFF rules\n\nSession goal:\nObjective: made up current objective\n\nConversation history:\nother messages';
  assert.equal(api().buildDehydrationRequest(refresh(h)).request.state.cause, h.cause.text);
});
test('only highest probabilities >= .65 recommend a single step; none/unclear/low/missing probabilities use marked-step fallback', () => {
  const built = api().buildDehydrationRequest(fixture());
  let r = api().interpretDehydrationAnswer(built, answer('single', 'step_1', .65, .65));
  assert.equal(r.kindSuggestion, 'single'); assert.equal(r.cutStepSuggestion, 1); assert.equal(r.cutSource, 'jev');
  for (const a of [answer('single', 'none'), answer('single', 'step_1', .8, .64), answer('throughout'), answer('unclear')]) {
    r = api().interpretDehydrationAnswer(built, a); assert.equal(r.cutStepSuggestion, 2); assert.equal(r.cutSource, 'marked_step_fallback');
  }
  r = api().interpretDehydrationAnswer(built, answer('single', 'step_1', .64)); assert.equal(r.kindSuggestion, 'unclear');
  const noProb = answer(); delete noProb.answers.kind.probabilities; delete noProb.answers.cut.probabilities;
  r = api().interpretDehydrationAnswer(built, noProb); assert.equal(r.kindProbability, null); assert.equal(r.cutProbability, null); assert.equal(r.kindSuggestion, 'unclear');
  const bad = answer(); bad.answers.cut.probabilities.step_99 = .9;
  assert.throws(() => api().interpretDehydrationAnswer(built, bad), e => e.code === 'wiki_dehydration_answer_invalid');
});
test('prefix contains exactly retained messages, trigger and pre-cut calls/results, with historical display paths unchanged', () => {
  const h = fixture(), before = structuredClone(h.bundle), p = api().buildDehydrationPrefix(h.caseRecord, h.bundle, 2);
  assert.equal(p.systemPrompt, 'historical cwd [REDACTED]');
  assert.equal(p.metadata.systemPromptNote, '系统提示词为历史展示版，路径行已占位');
  assert.equal(p.metadata.traceHash, h.caseRecord.traceBundle.hash); assert.equal(p.metadata.cutStep, 2);
  assert.deepEqual(p.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'toolResult']);
  assert.equal(p.messages.at(-1).content[0].text.length, h.bundle.steps[0].toolResults[0].message.content[0].text.length);
  assert.doesNotMatch(JSON.stringify(p.messages), /PRIVATE_BOOKKEEPING_AFTER_REPLY|send-public/);
  assert.deepEqual(h.bundle, before);
  assert.equal(api().buildDehydrationPrefix(h.caseRecord, h.bundle, 1).messages.length, 3);
  assert.throws(() => api().buildDehydrationPrefix(h.caseRecord, h.bundle, 3), e => e.code === 'wiki_dehydration_cut_invalid');
  h.bundle.steps[0].toolResults = [];
  assert.throws(() => api().buildDehydrationPrefix(refresh(h).caseRecord, h.bundle, 2), e => e.code === 'wiki_dehydration_prefix_unavailable');
});
test('request is bounded and never silently drops long error lines or too many cut options', () => {
  const h = fixture(); h.bundle.steps[0].toolResults[0].message.isError = true;
  h.bundle.steps[0].toolResults[0].message.content[0].text = 'Error: ' + 'x'.repeat(65000);
  assert.throws(() => api().buildDehydrationRequest(refresh(h)), e => e.code === 'wiki_dehydration_input_too_large');
  const many = fixture(); many.bundle.steps = Array.from({ length: 255 }, (_, i) => ({ step: i + 1, output: { role: 'assistant', content: [] }, toolResults: [] }));
  many.bundle.markedStep = 255;
  assert.throws(() => api().buildDehydrationRequest(refresh(many)), e => e.code === 'wiki_dehydration_input_too_large');
});
