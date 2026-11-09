// Real command shapes as inert output; fake model/judge and in-memory HTTP only.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { PassThrough } = require('node:stream');
const setup = require('../helpers/wiki-scene-run.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const api = () => require(base + 'wiki-run-replay');
const { createWikiRunStore } = require(base + 'wiki-run-store');
const fixtures = require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items;
const blocks = (n, step) => fixtures.find(f => f.case === n && f.step === step).toolCalls.map((c, i) => ({ type: 'toolCall', id: 'real-' + i, ...c }));
const send = { type: 'toolCall', id: 'public', name: 'bash', arguments: { command: 'node "$CAFF_CHAT_TOOLS_PATH" send-public --content "Clear result."' } };
function kernel(h, fault) {
 const runs = createWikiRunStore(h.scope), request = api().buildWikiRunRequest({ item: h.item(), bundle: h.bundle, decision: h.decision, toolset: h.toolset, reportOnly: true, rubricHash: h.rubric.hash });
 let modelCalls = 0, judgeCalls = 0;
 const judge = { configuration: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', settings: {}, promptHash: 'c'.repeat(64) }, async evaluate(input) {
  judgeCalls++; assert.deepEqual(Object.keys(input).sort(), ['expected', 'publicReply', 'questions', 'task']); assert.equal(input.publicReply, 'Clear result.');
  if (fault === 'backend') throw Error('PRIVATE JUDGE FAILURE'); if (fault === 'parse') return 'not-json';
  return { judgments: input.questions.map(q => ({ criterionId: q.id, verdict: 'satisfied', reason: 'Synthetic clear answer', evidence: [{ source: 'reply', text: 'Clear result.' }] })) };
 } };
 return { runs, request, get modelCalls() { return modelCalls; }, get judgeCalls() { return judgeCalls; }, run(content, iteration = 1, overrides = {}) {
  return api().replayWikiRunReport({ store: h.store, runs, caseId: h.c.id, toolset: h.toolset, rubricHash: h.rubric.hash, approvedRequestHash: api().wikiRunHash(request),
   attempt: { planHash: 'd'.repeat(64), executionId: '1b947e3a-88c8-4a52-a9e1-c32dcd8c99df', iteration } },
  { confirmed: true, ...(h.rubric.questions.length ? { judge } : {}), client: { async complete(q) {
    modelCalls++; assert.deepEqual(q, request); if (fault === 'model') throw Error('PRIVATE MODEL FAILURE');
    return { networkRequests: 1, durationMs: 2, wireRequest: fault === 'wire' ? {} : require(base + 'wiki-run-wire').buildWikiRunWireRequest(q),
     message: { role: 'assistant', stopReason: 'toolUse', content } };
  } }, ...overrides });
 } };
}
async function get(h) {
 const controller = require('../../build/server/api/badcase-wiki-controller').createBadcaseWikiController({ ...h.scope, host: '127.0.0.1', port: 4313, csrfToken: 'synthetic' });
 const req = new PassThrough(); req.method = 'GET'; req.socket = { remoteAddress: '127.0.0.1' }; req.headers = { host: '127.0.0.1:4313' }; let value;
 const res = { writeHead(status) { assert.equal(status, 200); }, end(bytes) { value = JSON.parse(bytes); } };
 await controller({ req, res, pathname: '/api/wikiskill' }); return value;
}
test('scene diagnostic cuts run once, freeze original output/checks and GET counts without touching trace identity, groups or gate data', async t => {
 const h = setup(t), f = kernel(h), before = h.store.read(), bytes = JSON.stringify(h.store.readCaseTrace(h.c.id));
 assert.throws(() => api().buildWikiRunRequest({ item: h.item(), bundle: h.bundle, decision: h.decision, toolset: h.toolset }), { code: 'wiki_run_scene_unsupported' });
 const rows = [];
 for (const [i, content] of [blocks(22, 29), blocks(22, 30), blocks(23, 45)].entries()) rows.push(await f.run(content, i + 1));
 assert.deepEqual(rows.map(r => r.outcome.status), ['fail', 'pass', 'invalid']); assert.equal(f.modelCalls, 3); assert.equal(f.judgeCalls, 0);
 assert.ok(rows.every(r => r.toolExecutions === 0 && r.report.kind === 'wiki-run-report-v1' && r.report.rubricHash === h.rubric.hash));
 const listed = f.runs.list(); assert.ok(listed.every(r => r.reportOnly && !r.caseEligibleForGateAndScreen && !r.eligibleForScoring && r.baselineStatus === 'not_run'));
 const view = await get(h), c = view.cases.find(c => c.id === h.c.id);
 assert.equal(c.runChecks.reportOnly, true); assert.equal(c.runChecks.notAdoptionEvidence, true);
 assert.equal(c.runChecks.passed, 1); assert.equal(c.runChecks.failed, 1); assert.equal(c.runChecks.invalid, 1); assert.equal(c.runChecks.errors, 0); assert.equal(c.runChecks.total, 3);
 assert.deepEqual(c.runChecks.invalidReasons, { arguments_unparseable: 1 });
 assert.equal(view.pipelineStates.find(c => c.caseId === h.c.id).level, 'trace'); assert.equal(view.pipelineStates[0].original.valid, 0); assert.deepEqual(view.comparisons, []);
 assert.deepEqual(h.store.read(), before); assert.equal(JSON.stringify(h.store.readCaseTrace(h.c.id)), bytes); assert.equal(c.sealedCheckpointId, h.c.sealedCheckpointId);
 assert.equal(view.initialSplitProposal.rows[0].decisionHash, null);
 await assert.rejects(f.run(blocks(22, 30)), { code: 'wiki_run_already_reserved' }); assert.equal(f.modelCalls, 3);
 for (const row of rows) assert.deepEqual(f.runs.read(row.id).result, row);
 assert.equal(fs.existsSync(path.join(h.scope.globalRoot, 'comparisons')), false);
});
for (const [fault, status, judges] of [[undefined, 'pass', 3], ['parse', 'error', 2], ['backend', 'error', 2], ['wire', 'error', 0], ['model', 'error', 0]]) {
 test(`scene dual report ${fault || 'success'} durably retains judge/error evidence without gate scoring`, async t => {
  const h = setup(t, { reply: true }), f = kernel(h, fault), row = await f.run([...blocks(22, 30), send]);
  assert.equal(row.outcome.status, status); assert.equal(f.modelCalls, 1); assert.equal(f.judgeCalls, judges); assert.equal(row.toolExecutions, 0);
  if (judges) { assert.equal(row.report.assessment.status, status); assert.equal(row.report.checks.status, status); }
  if (fault !== 'model') assert.deepEqual(row.message.content, [...blocks(22, 30), send]);
  const view = await get(h), counts = view.cases[0].runChecks;
  assert.equal(counts.errors, status === 'error' ? 1 : 0); assert.equal(counts.passed, status === 'pass' ? 1 : 0); assert.equal(counts.invalid, 0);
  assert.equal(view.pipelineStates[0].original.valid, 0); assert.deepEqual(view.comparisons, []); assert.doesNotMatch(JSON.stringify(row), /PRIVATE/);
 });
}
test('scene report tool failure skips reply judge, even with a configured reply check', async t => {
 const h = setup(t, { reply: true }), f = kernel(h), row = await f.run([...blocks(22, 29), send]);
 assert.equal(row.outcome.status, 'fail'); assert.equal(f.judgeCalls, 0); assert.equal(row.report.assessment, undefined);
});
test('scene reply-only reporting is supported without changing legacy non-report packets', async t => {
 const h = setup(t, { reply: true, tool: false }), f = kernel(h), row = await f.run([send]);
 assert.equal(row.outcome.status, 'pass'); assert.equal(f.judgeCalls, 3); assert.equal(row.report.checks.tool.status, 'unconfigured');
});
test('report counts bind current frozen rubric and distinguish a reserved unknown attempt from invalid output', async t => {
 const h = setup(t), f = kernel(h), row = await f.run(blocks(22, 30));
 const file = path.join(h.scope.globalRoot, 'run-replays', row.id + '.result.json'), bytes = fs.readFileSync(file);
 const draft = h.store.saveRubricDraft({ caseId: h.c.id, model: 'deepseek/deepseek-v4-flash', questions: [], scoringModel: null, toolCheck: { ...h.rubric.toolCheck, rules: [{ parameter: 'reason', kind: 'max-chars', max: 999 }] } }, h.store.read().revision);
 const current = h.store.confirmRubric({ rubricId: draft.id, hash: draft.hash, confirmationRecord: 'New diagnostic rules' }, h.store.read().revision);
 const request = api().buildWikiRunRequest({ item: h.item(), bundle: h.bundle, decision: h.decision, toolset: h.toolset, reportOnly: true, rubricHash: current.hash });
 assert.notEqual(api().wikiRunHash(request), api().wikiRunHash(f.request)); f.runs.reserve(request);
 const before = h.store.read(), view = await get(h), counts = view.cases[0].runChecks;
 assert.equal(counts.rubricHash, current.hash); assert.equal(counts.passed, 0); assert.equal(counts.invalid, 0); assert.equal(counts.pending, 1); assert.equal(counts.total, 1);
 assert.deepEqual(h.store.read(), before); assert.deepEqual(fs.readFileSync(file), bytes);
});
test('report approval and reply-only evidence guards reject before any model or judge call; report candidates are forbidden', async t => {
 const h = setup(t), f = kernel(h); await assert.rejects(f.run(blocks(22, 30), 1, { confirmed: false }), { code: 'wiki_run_confirmation_required' }); assert.equal(f.modelCalls, 0);
 assert.throws(() => api().buildWikiRunRequest({ item: h.item(), bundle: h.bundle, decision: h.decision, toolset: h.toolset, reportOnly: true, rubricHash: h.rubric.hash, candidate: {} }), { code: 'wiki_run_report_invalid' });
 const other = setup(t, { reply: true, evidence: 'trace' }), g = kernel(other);
 await assert.rejects(g.run([send]), { code: 'wiki_rubric_run_evidence_invalid' }); assert.equal(g.modelCalls, 0); assert.equal(g.judgeCalls, 0);
});
