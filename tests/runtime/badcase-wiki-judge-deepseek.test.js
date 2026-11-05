const test = require('node:test'), assert = require('node:assert/strict');
const api = () => require('../../scripts/badcase-capture/wiki-judge-deepseek.cjs');
const input = { task: 'Report the outcome.', expected: 'Explain plainly.', questions: [{ id: 'q1', question: 'The outcome is explained.', evidence: 'reply' }], publicReply: 'The work is complete.' };
const output = JSON.stringify({ judgments: [{ criterionId: 'q1', verdict: 'satisfied', reason: 'The outcome is stated.', evidence: [{ source: 'reply', text: input.publicReply }] }] });
const key = 'synthetic-not-real-key-for-unit-testing';
function envelope(content = output, model = 'deepseek-v4-flash') { return Buffer.from(JSON.stringify({ status: 200, body: Buffer.from(JSON.stringify({ model, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 } })).toString('base64') })); }
function setup(response = () => envelope()) {
  const calls = [], events = []; let closes = 0;
  const judge = api().createDeepseekWikiJudge({ key, maxRequests: 6, onCall: e => events.push(e) }, { createExchange({ expectedBody, key: actual }) {
    assert.equal(actual, key); calls.push(JSON.parse(expectedBody));
    return { async exchange(bytes) { assert.equal(bytes.toString(), JSON.stringify(calls.at(-1))); return response(); }, async close() { closes++; } };
  } });
  return { judge, calls, events, closes: () => closes };
}
test('judge is explicit opt-in, projects blind input, freezes settings and hashes exact prompt', async () => {
  const { wikiValueHash } = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric');
  const h = setup(); assert.equal(h.calls.length, 0);
  await h.judge.evaluate(input);
  assert.deepEqual(h.calls[0].messages.map(m => m.role), ['system', 'user']);
  assert.deepEqual(JSON.parse(h.calls[0].messages[1].content), input);
  assert.equal(h.calls[0].model, 'deepseek-v4-flash'); assert.equal(h.calls[0].temperature, 0);
  assert.deepEqual(h.calls[0].response_format, { type: 'json_object' });
  assert.equal(h.judge.configuration.promptHash, wikiValueHash(api().DEEPSEEK_JUDGE_PROMPT));
  assert.ok(Object.isFrozen(h.judge.configuration.settings));
  assert.equal(h.closes(), 1); assert.equal(h.events[0].success, true);
  assert.deepEqual(h.events[0].usage, { input: 30, output: 40, totalTokens: 70 });
  assert.equal(h.events[0].observedModel, 'deepseek-v4-flash');
  assert.equal(h.judge.configuration.settings.responseModelPolicy, 'deepseek-v4-flash|deepseek-flash');
});
test('adapter rejects extra labels, candidate text, bad evidence and leaked selected key before network', async () => {
  for (const bad of [{ ...input, variant: 'candidate' }, { ...input, candidateGuideline: 'private' }, { ...input, publicReply: key }, { ...input, evidence: { originalResults: [] } }]) {
    const h = setup(); await assert.rejects(h.judge.evaluate(bad)); assert.equal(h.calls.length, 0);
  }
});
test('technical failures are sanitized; the scorer alone retries the same input once', async () => {
  const h = setup(() => { throw Error('private ' + key); });
  await assert.rejects(h.judge.evaluate(input), e => e.code === 'wiki_judge_request_failed' && !e.message.includes(key));
  assert.equal(h.calls.length, 1); assert.equal(h.closes(), 1); assert.equal(h.events[0].success, false);
  assert.equal(JSON.stringify(h.events).includes(key), false);
});
test('budget refuses excess calls, and credentials cannot appear in output or evidence', async () => {
  assert.throws(() => api().createDeepseekWikiJudge({ key, maxRequests: 0 }));
  let calls = 0;
  const h = api().createDeepseekWikiJudge({ key, maxRequests: 1 }, { createExchange() { calls++; return { exchange: async () => envelope(), close: async () => {} }; } });
  await h.evaluate(input); await assert.rejects(h.evaluate(input), /wiki_judge_budget_exhausted/); assert.equal(calls, 1);
  const bad = setup(() => envelope(key)); await assert.rejects(bad.judge.evaluate(input));
  assert.equal(JSON.stringify(bad.events).includes(key), false);
});
test('both user-approved response aliases score identically and retain the actual returned label', async () => {
  for (const model of ['deepseek-v4-flash', 'deepseek-flash']) {
    const h = setup(() => envelope(output, model));
    assert.equal(await h.judge.evaluate(input), output);
    assert.equal(h.events[0].success, true); assert.equal(h.events[0].observedModel, model);
    assert.equal(h.events[0].model, 'deepseek/deepseek-v4-flash');
    assert.deepEqual(h.events[0].usage, { input: 30, output: 40, totalTokens: 70 });
  }
});
test('unapproved models remain typed errors with safe usage and without leaking arbitrary labels', async () => {
  for (const model of ['deepseek-chat', 'DeepSeek-V4.1-Flash-1017', 'deepseek-flash-other']) {
    const h = setup(() => envelope(output, model));
    await assert.rejects(h.judge.evaluate(input), e => e.code === 'wiki_judge_model_changed');
    assert.equal(h.events[0].success, false); assert.equal(h.events[0].error, 'wiki_judge_model_changed');
    assert.deepEqual(h.events[0].usage, { input: 30, output: 40, totalTokens: 70 });
    assert.equal(h.events[0].observedModel, 'other');
    assert.equal(JSON.stringify(h.events).includes(model), false);
  }
});
test('malformed envelopes, truncated output and wrong model cannot be recorded as successful judgments', async () => {
  for (const response of [Buffer.from('{}'), Buffer.from(JSON.stringify({ status: 403, body: '' })), envelope('not json'), Buffer.from(envelope().toString().replace('200', '201'))]) {
    const h = setup(() => response); await assert.rejects(h.judge.evaluate(input)); assert.equal(h.events[0].success, false);
  }
});
test('real adapter composes with the common scorer, retaining three cited binary votes', async () => {
  const { createWikiRubric } = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric');
  const { bindWikiJudge, scoreWikiRun } = require('../../build/server/domain/runtime/badcase-capture/wiki-scoring-v2');
  const rubric = { ...createWikiRubric({ caseId: 'synthetic', version: 1, model: 'deepseek/deepseek-v4-flash', actual: 'Unclear', expected: input.expected,
    scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' }, questions: input.questions }), status: 'frozen', confirmedAt: '2026-11-05T00:00:00.000Z', confirmationRecord: 'Synthetic only' };
  const h = setup(() => envelope(output, 'deepseek-flash')); const result = await scoreWikiRun({ rubric, binding: bindWikiJudge(h.judge.configuration, rubric), hardAssertions: [], run: { completed: true, replySource: 'public', publicReply: input.publicReply, task: input.task, expected: input.expected } }, h.judge);
  assert.equal(result.status, 'pass'); assert.equal(result.votes.length, 3); assert.equal(h.calls.length, 3);
});
