const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const api = () => require('../../scripts/badcase-capture/draft-wiki-rubrics.cjs');
const questions = [
  { id: 'q1', question: 'The reply states the result.', evidence: 'reply' },
  { id: 'q2', question: 'The reply explains the next step.', evidence: 'reply' },
];
const key = 'synthetic-drafting-key-no-real-access';
function setup(t, count = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-rubric-draft-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') }, store = createWikiStore(config);
  const cases = store.addTextCases(Array.from({ length: count }, (_, i) => ({ source: { origin: 'http://127.0.0.1:3100', projectId: 'p', conversationId: 'c', messageId: 'm' + i, agentId: 'role-family-gpt' },
    role: 'GPT', actual: 'Unclear result', expected: 'Clear result and next step', message: 'HISTORICAL_REPLY_MUST_NOT_ENTER_DRAFT', traceExcerpt: 'HISTORICAL_TRACE',
    traceState: 'available', messageTruncated: false, traceTruncated: false }))).cases;
  const args = { store, caseIds: cases.map(c => c.id), expectedRevision: store.read().revision, credentialDir: path.join(root, 'credentials'), confirmed: true };
  const output = () => JSON.stringify({ results: cases.map(c => ({ caseId: c.id, questions })) });
  const envelope = (content = output(), finish = 'stop') => Buffer.from(JSON.stringify({ status: 200, body: Buffer.from(JSON.stringify({
    choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  })).toString('base64') }));
  let reads = 0, sends = 0, closes = 0;
  const options = { readKey: env => { reads++; assert.equal(env.PI_CODING_AGENT_DIR, args.credentialDir); return key; },
    createExchange: ({ key: actual, expectedBody }) => { assert.equal(actual, key); return { exchange: async body => { sends++; assert.deepEqual(body, expectedBody); return envelope(); }, close: async () => { closes++; } }; } };
  return { root, config, store, cases, args, output, envelope, options, counts: () => ({ reads, sends, closes }) };
}
test('draft planning is annotation-only, accepts holdouts without induction, and uses preclassification model settings', t => {
  const h = setup(t, 6); h.store.setReplaySplit({ caseIds: h.cases.map(c => c.id) });
  assert.ok(h.store.read().cases.some(c => c.split === 'test'));
  const plan = api().prepareWikiRubricDraft(h.store, h.args.caseIds, h.store.read().revision);
  const text = JSON.stringify(plan); assert.equal(text.includes('HISTORICAL_REPLY'), false); assert.equal(text.includes('HISTORICAL_TRACE'), false);
  const request = JSON.parse(plan.body); assert.equal(request.model, 'deepseek-v4-flash'); assert.equal(request.temperature, 0);
  assert.equal(request.max_tokens, 32768); assert.equal(request.stream, false); assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.deepEqual(JSON.parse(request.messages[1].content).cases.map(c => Object.keys(c).sort()), h.cases.map(() => ['actual', 'expected', 'id', 'task']));
  assert.equal(h.counts().reads, 0);
});
test('draft input includes supplied original task or explicit null, never a historical answer or invented task', t => {
  const h = setup(t), tasks = { [h.cases[0].id]: 'ACTUAL-TRIGGERING-USER-MESSAGE' };
  const plan = api().prepareWikiRubricDraft(h.store, h.args.caseIds, h.args.expectedRevision, tasks), cases = JSON.parse(JSON.parse(plan.body).messages[1].content).cases;
  assert.equal(cases[0].task, tasks[h.cases[0].id]); assert.equal(cases[1].task, null);
  assert.notEqual(plan.inputHash, api().prepareWikiRubricDraft(h.store, h.args.caseIds, h.args.expectedRevision).inputHash);
  assert.throws(() => api().prepareWikiRubricDraft(h.store, h.args.caseIds, h.args.expectedRevision, { missing: 'fake' }));
});
test('drafting contract preserves user conditions/exceptions and asks for execution evidence rather than trusting prose', () => {
  const request = JSON.parse(api().buildRubricDraftRequest({ cases: [{ id: 'conditional-case', actual: 'Added machinery',
    expected: 'Do not add it unless unavoidable and explained beforehand' }] }));
  const instructions = request.messages[0].content;
  assert.match(instructions, /保留用户要求中的条件与例外/);
  assert.match(instructions, /不得拆成无条件禁令/);
  assert.match(instructions, /未做该行为，或者确有必要且已事先说明/);
  assert.match(instructions, /执行行为.*trace.*files/);
  assert.match(instructions, /不重复.*硬断言/);
  assert.match(instructions, /每项期望要求/);
});
test('one authorized request saves all versions as drafts, seals model wording/proof, never confirms them', async t => {
  const h = setup(t), before = h.store.read(), out = await api().draftWikiRubrics(h.args, h.options);
  assert.equal(out.modelOutput, h.output()); assert.equal(out.drafts.length, 2); assert.ok(out.drafts.every(d => d.status === 'draft'));
  assert.deepEqual(h.counts(), { reads: 1, sends: 1, closes: 1 }); assert.equal(h.store.read().revision, before.revision + 1);
  assert.match(out.proof.inputHash, /^[a-f0-9]{64}$/); assert.match(out.proof.requestHash, /^[a-f0-9]{64}$/); assert.equal(out.proof.call.usage.totalTokens, 30);
  assert.equal(JSON.stringify(out).includes(key), false); assert.deepEqual(h.store.read().cases, before.cases);
});
test('drafting accepts a single assertion without adding duplicate or unrelated requirements', async t => {
  const h = setup(t), results = h.cases.map(c => ({ caseId: c.id, questions: [questions[0]] }));
  const out = await api().draftWikiRubrics(h.args, { ...h.options,
    createExchange: () => ({ exchange: async () => h.envelope(JSON.stringify({ results })), close: async () => {} }) });
  assert.equal(out.drafts.length, results.length);
  for (const draft of out.drafts) {
    assert.deepEqual(draft.questions, [questions[0]]); assert.equal(draft.status, 'draft'); assert.equal(draft.scoringModel, null);
  }
});
test('unknown/duplicate cases, stale revision and unconfirmed execution fail before credentials/network', async t => {
  const h = setup(t), before = h.store.read();
  for (const patch of [{ caseIds: ['missing'] }, { caseIds: [h.cases[0].id, h.cases[0].id] }, { expectedRevision: 0 }, { confirmed: false }]) {
    await assert.rejects(api().draftWikiRubrics({ ...h.args, ...patch }, h.options));
  }
  assert.deepEqual(h.counts(), { reads: 0, sends: 0, closes: 0 }); assert.deepEqual(h.store.read(), before);
});
test('missing/duplicate/extra case output or invalid later rubric publishes no partial drafts', async t => {
  const h = setup(t), before = h.store.read();
  const rows = JSON.parse(h.output()).results;
  for (const results of [rows.slice(0, 1), [rows[0], rows[0]], [...rows, { caseId: 'extra', questions }],
    [rows[0], { ...rows[1], questions: [] }], [rows[0], { ...rows[1], questions: Array.from({ length: 5 }, (_, i) => ({ ...questions[0], id: 'q' + i })) }],
    [rows[0], { ...rows[1], approved: true }]]) {
    let sent = 0, closed = 0;
    const options = { ...h.options, createExchange: () => ({ exchange: async () => { sent++; return h.envelope(JSON.stringify({ results })); }, close: async () => { closed++; } }) };
    await assert.rejects(api().draftWikiRubrics(h.args, options)); assert.equal(sent, 1); assert.equal(closed, 1); assert.deepEqual(h.store.read(), before);
  }
});
test('truncated/malformed/reflected-key responses fail closed without retry, logs or stored model output', async t => {
  const h = setup(t), before = h.store.read();
  for (const response of [h.envelope(h.output(), 'length'), h.envelope('not-json'), h.envelope(key),
    Buffer.from(JSON.stringify({ status: 429, body: Buffer.from(key).toString('base64') })), Buffer.from('malformed')]) {
    let sent = 0, closed = 0;
    await assert.rejects(api().draftWikiRubrics(h.args, { ...h.options, createExchange: () => ({ exchange: async () => { sent++; return response; }, close: async () => { closed++; } }) }),
      e => /^wiki_/.test(e.code) && !e.message.includes(key));
    assert.equal(sent, 1); assert.equal(closed, 1); assert.deepEqual(h.store.read(), before);
  }
});
test('concurrent revision change refuses draft publication after the response', async t => {
  const h = setup(t);
  const options = { ...h.options, createExchange: () => ({ exchange: async () => {
    h.store.saveRubricDraft({ caseId: h.cases[0].id, model: 'deepseek/deepseek-v4-flash', questions }, h.store.read().revision);
    return h.envelope();
  }, close: async () => {} }) };
  await assert.rejects(api().draftWikiRubrics(h.args, options), /wiki_revision_conflict/);
  assert.equal(h.store.read().rubrics.length, 1);
});
test('CLI saves original model wording once and refuses an occupied output before auth/network', async t => {
  const h = setup(t), configFile = path.join(h.root, 'config.json'), outputFile = path.join(h.root, 'result.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...h.config, caseIds: h.args.caseIds, expectedRevision: h.args.expectedRevision, credentialDir: h.args.credentialDir }));
  await api().main(['--config', configFile, '--confirmed', '--output', outputFile], h.options);
  const records = fs.readFileSync(outputFile, 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(records[0].modelOutput, h.output()); assert.equal(records[1].drafts.length, 2);
  const before = h.counts();
  // Update only the revision, so output collision rather than stale input blocks.
  const config = JSON.parse(fs.readFileSync(configFile)); config.expectedRevision = h.store.read().revision;
  fs.writeFileSync(configFile, JSON.stringify(config));
  await assert.rejects(api().main(['--config', configFile, '--confirmed', '--output', outputFile], h.options), { code: 'EEXIST' });
  assert.deepEqual(h.counts(), before);
});
test('failed durable-original-output hook prevents any draft publication', async t => {
  const h = setup(t), before = h.store.read();
  await assert.rejects(api().draftWikiRubrics(h.args, { ...h.options, onGenerated: () => { throw Error('synthetic disk failure'); } }), /synthetic disk failure/);
  assert.deepEqual(h.store.read(), before); assert.equal(h.counts().closes, 1);
});
test('rubric batch store mutation is atomic with invalid later questions and refuses duplicate case versions', t => {
  const h = setup(t), before = h.store.read();
  assert.equal(typeof h.store.saveRubricDrafts, 'function');
  for (const inputs of [[{ caseId: h.cases[0].id, model: 'deepseek/deepseek-v4-flash', questions }, { caseId: h.cases[1].id, model: 'deepseek/deepseek-v4-flash', questions: [] }],
    [0, 1].map(() => ({ caseId: h.cases[0].id, model: 'deepseek/deepseek-v4-flash', questions }))]) {
    assert.throws(() => h.store.saveRubricDrafts(inputs, before.revision)); assert.deepEqual(h.store.read(), before);
  }
});
