const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { buildDehydrationRequest } = require('../../build/server/domain/runtime/badcase-capture/wiki-dehydration');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dehydration-workflow-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createWikiStore({ globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') });
  const c = store.addMarkedCase({ source: { projectId: null, conversationId: 'room', conversationTitle: 'room', messageId: 'm', agentId: 'role-family-gpt' },
    role: 'GPT', actual: 'wrong', expected: 'right', message: 'reply', traceState: 'missing', traceExcerpt: '', traceTruncated: false, messageTruncated: false }).case;
  const bundle = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', source: c.source, origin: 'mark', frozenAt: '2026-11-05T00:00:00Z', complete: false, missingReasons: [], redaction: { policy: 'known_values_only' }, markedStep: 1,
    markedMessage: 'reply', actual: 'wrong', expected: 'right', context: { systemPrompt: 'system', priorSessionEntries: [], trigger: { type: 'message', message: { role: 'user', content: 'solve this' } } },
    steps: [{ step: 1, output: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] }, toolResults: [] }] };
  store.freezeCaseTrace(c.id, bundle);
  const item = () => store.read().cases.find(v => v.id === c.id), cause = { source: 'trigger', text: 'solve this' };
  const built = buildDehydrationRequest({ caseRecord: item(), bundle, cause });
  const response = { model: 'jev-test', answers: { kind: { type: 'choice', choice: 'single', probabilities: { single: .9, throughout: .05, unclear: .05 } },
    cut: { type: 'choice', choice: 'step_1', probabilities: { step_1: .9, none: .1 } } } };
  const save = () => store.saveDehydrationRecommendation({ built, response, expectedRevision: store.read().revision });
  const confirm = (r, extra = {}) => store.confirmDehydration({ caseId: c.id, traceHash: item().traceBundle.hash, recommendationHash: r.hash,
    kind: 'single', cutStep: 1, expectedRevision: store.read().revision, ...extra });
  return { store, c, bundle, built, response, item, save, confirm };
}
test('recommendation and immutable user decision bind case, trace and request; old packets/splits/results are untouched', t => {
  const h = setup(t), before = h.store.read(), packet = h.store.readCaseTrace(h.c.id);
  const r = h.save(); assert.equal(r.recommendation.kindSuggestion, 'single'); assert.equal(r.caseId, h.c.id);
  assert.deepEqual(r.request, h.built.request); assert.equal(h.store.read().revision, before.revision + 1);
  assert.deepEqual(h.save(), r); // no extra snapshot or request
  const d = h.confirm(r); assert.equal(d.kind, 'single'); assert.equal(d.cutStep, 1); assert.match(d.hash, /^[a-f0-9]{64}$/);
  const revision = h.store.read().revision; assert.deepEqual(h.confirm(r), d); assert.equal(h.store.read().revision, revision);
  assert.throws(() => h.confirm(r, { kind: 'throughout', cutStep: null }), e => e.code === 'wiki_dehydration_frozen');
  assert.throws(() => h.save(), e => e.code === 'wiki_dehydration_frozen');
  const after = h.store.read(); for (const key of ['cases', 'replayCases', 'replaySplit', 'comparisonReviews']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(h.store.readCaseTrace(h.c.id), packet);
  assert.deepEqual(h.store.getDehydration(h.c.id).decision, d);
});
test('confirmation rejects stale revision, different trace/recommendation and non-null cuts for throughout/unclear', t => {
  const h = setup(t), r = h.save();
  for (const [extra, code] of [[{ expectedRevision: 0 }, 'wiki_revision_conflict'], [{ traceHash: 'f'.repeat(64) }, 'wiki_dehydration_stale'],
    [{ recommendationHash: 'f'.repeat(64) }, 'wiki_dehydration_stale'], [{ kind: 'throughout' }, 'wiki_dehydration_cut_invalid'], [{ cutStep: 2 }, 'wiki_dehydration_cut_invalid']]) {
    assert.throws(() => h.confirm(r, extra), e => e.code === code);
  }
  const d = h.confirm(r, { kind: 'unclear', cutStep: null }); assert.equal(d.kind, 'unclear'); assert.equal(d.level, 'reference'); assert.equal(d.cutStep, null);
});
test('recommendation failure never invents an answer; rebinding and changing the first recommendation are rejected', t => {
  const h = setup(t);
  assert.throws(() => h.store.confirmDehydration({ caseId: h.c.id, expectedRevision: h.store.read().revision }), e => e.code === 'wiki_dehydration_recommendation_required');
  assert.throws(() => h.store.saveDehydrationRecommendation({ built: { ...h.built, traceHash: 'f'.repeat(64) }, response: h.response, expectedRevision: h.store.read().revision }), e => e.code === 'wiki_dehydration_stale');
  const r = h.save(); h.response.answers.kind.choice = 'unclear'; h.response.answers.kind.probabilities = { single: .05, throughout: .05, unclear: .9 };
  assert.throws(() => h.store.saveDehydrationRecommendation({ built: h.built, response: h.response, expectedRevision: h.store.read().revision }), e => e.code === 'wiki_dehydration_recommendation_exists');
  assert.equal(h.store.getDehydration(h.c.id).hash, r.hash);
});
test('recommendation runner sends one approved, bound request; catches errors without leaking upstream text; retries return the stored result', async t => {
  const h = setup(t), { recommendDehydration } = require('../../build/server/domain/runtime/badcase-capture/wiki-dehydration-runner');
  let calls = 0; const client = { ask: async req => { calls++; assert.deepEqual(req, h.built.request); return h.response; } };
  const input = { store: h.store, caseId: h.c.id, cause: { source: 'trigger', text: 'solve this' }, approvedRequestHash: h.built.requestHash, expectedRevision: h.store.read().revision };
  await assert.rejects(recommendDehydration({ ...input, approvedRequestHash: 'f'.repeat(64) }, { client }), e => e.code === 'wiki_dehydration_stale'); assert.equal(calls, 0);
  const r = await recommendDehydration(input, { client }); assert.equal(calls, 1); assert.equal(r.caseId, h.c.id);
  await recommendDehydration({ ...input, expectedRevision: h.store.read().revision }, { client }); assert.equal(calls, 1);
  const other = setup(t), b = other.built;
  await assert.rejects(recommendDehydration({ store: other.store, caseId: other.c.id, cause: { source: 'trigger', text: 'solve this' }, approvedRequestHash: b.requestHash, expectedRevision: other.store.read().revision },
    { client: { ask() { throw Error('DO NOT LEAK PRIVATE UPSTREAM BODY'); } } }), e => e.code === 'wiki_dehydration_jev_failed' && !e.message.includes('PRIVATE'));
  assert.equal(other.store.getDehydration(other.c.id), null);
});
