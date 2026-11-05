const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const r = require(base + 'wiki-rubric'), s = require(base + 'wiki-scoring-v2'), e = require(base + 'wiki-experiment-plan');
const models = { deepseek: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' }, jev: { backend: 'jev', model: 'jev-latest' } };
const assertions = [{ id: 'a', question: '回复直接给出结论。', evidence: 'reply' }, { id: 'b', question: '回复说明结论的影响。', evidence: 'reply' }];
const configuration = backend => ({ ...models[backend], settings: {}, promptHash: r.wikiValueHash('synthetic-' + backend + '-descriptor-not-a-judge-prompt') });
function fixture() {
  const catalog = ['repair', 'control', 'held'].map((id, i) => ({ id, sceneHash: r.wikiValueHash(id), task: 'Report result', actual: 'Unclear', expected: 'Clear', hardAssertions: {},
    rubric: { ...r.createWikiRubric({ caseId: id, version: 1, model: r.WIKI_RUBRIC_MODEL, actual: 'Unclear', expected: 'Clear', questions: assertions, scoringModel: models[i === 1 ? 'jev' : 'deepseek'] }),
      status: 'frozen', confirmedAt: '2026-11-05T00:00:00.000Z', confirmationRecord: 'Synthetic human approval' } }));
  const definition = { kind: 'wiki-experiment-v2', variants: [{ id: 'original', promptHash: r.wikiValueHash('original') }, { id: 'candidate', promptHash: r.wikiValueHash('candidate') }],
    runner: { model: 'openai-codex/gpt-6.1-sol', settings: {} }, repeats: 10, executionPolicy: 'alternating-valid-v1',
    decision: { kind: 'wikiskill-gate-v1', alpha: .05, noHarmFraction: .05, minimumAllowedLoss: 1, maxExtraAttemptsPerCase: 5 },
    cases: catalog.map((c, i) => ({ caseId: c.id, stage: i === 2 ? 'test' : 'gate', category: i === 1 ? 'control' : 'reproduction', targetReproduction: i !== 1, judge: configuration(i === 1 ? 'jev' : 'deepseek') })) };
  return { catalog, definition, plan: () => e.createWikiExperimentPlan(definition, catalog) };
}
test('assertion v2 freezes selected scoring model in content hash, distinct from drafting model', () => {
  const h = fixture(), a = h.catalog[0].rubric;
  assert.equal(a.kind, 'wiki-rubric-v2'); assert.deepEqual(a.scoringModel, models.deepseek);
  const b = r.createWikiRubric({ ...a, actual: 'Unclear', expected: 'Clear', scoringModel: models.jev });
  assert.notEqual(a.hash, b.hash); assert.equal(b.model, r.WIKI_RUBRIC_MODEL);
  const changed = { ...a, scoringModel: models.jev };
  assert.throws(() => r.validateWikiRubric(changed, true), /wiki_rubric_hash_changed/);
  assert.throws(() => s.bindWikiJudge(configuration('jev'), a), /wiki_judge_binding_changed/);
  assert.throws(() => s.validateWikiJudgeBinding({ ...s.bindWikiJudge(configuration('deepseek'), a), ...models.jev }, a), /wiki_judge_binding_changed/);
});
test('new manual assertions reject question format and unselected model cannot freeze; old rubric remains byte-compatible', () => {
  const input = { caseId: 'case', version: 1, model: r.WIKI_RUBRIC_MODEL, actual: 'Unclear', expected: 'Clear', questions: assertions };
  for (const question of ['是否直接给出结论？', 'Does the reply explain the impact?']) assert.throws(() => r.createWikiRubric({ ...input, questions: [{ ...assertions[0], question }, assertions[1]] }));
  const draft = r.createWikiRubric(input); assert.equal(draft.scoringModel, null);
  assert.throws(() => r.validateWikiRubric({ ...draft, status: 'frozen', confirmedAt: '2026-11-05T00:00:00.000Z', confirmationRecord: 'No model selected' }, true), /wiki_rubric_model_required/);
  const content = { kind: 'wiki-rubric-v1', caseId: 'legacy', version: 1, model: r.WIKI_RUBRIC_MODEL, sourceHash: r.wikiRubricSourceHash('Unclear', 'Clear'), questions: [{ ...assertions[0], question: 'Is this clear?' }, assertions[1]] };
  const hash = r.wikiValueHash(content), legacy = { ...content, hash, id: 'rubric-' + hash, status: 'frozen', confirmedAt: '2026-11-04T00:00:00.000Z', confirmationRecord: 'Old approval' };
  assert.deepEqual(r.validateWikiRubric(legacy, true), legacy);
});
test('store model selection creates a new immutable version, confirmation cannot silently substitute a model', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-case-model-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = require(base + 'wiki-store').createWikiStore({ globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') });
  const c = store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'p', conversationId: 'c', messageId: 'm', agentId: 'role-family-gpt' }, role: 'GPT', actual: 'Unclear', expected: 'Clear', message: 'Not for drafting', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]).cases[0];
  const save = scoringModel => store.saveRubricDraft({ caseId: c.id, model: r.WIKI_RUBRIC_MODEL, questions: assertions, ...(scoringModel ? { scoringModel } : {}) }, store.read().revision);
  const a = save(), before = store.read(); assert.throws(() => store.confirmRubric({ rubricId: a.id, hash: a.hash, confirmationRecord: 'Confirm' }, before.revision), /wiki_rubric_model_required/); assert.deepEqual(store.read(), before);
  const b = save(models.jev); assert.equal(b.version, 2); assert.notEqual(b.hash, a.hash);
  const frozen = store.confirmRubric({ rubricId: b.id, hash: b.hash, confirmationRecord: 'User chose JEV' }, store.read().revision);
  assert.deepEqual(store.getFrozenRubric(c.id, b.hash), frozen); assert.equal(store.read().rubrics[0].status, 'draft');
  assert.throws(() => store.confirmRubric({ rubricId: b.id, hash: b.hash, confirmationRecord: 'Change', scoringModel: models.deepseek }, store.read().revision));
});
test('independent experiment selects models per case; plan validator accepts heterogeneous judges but refuses same-case configuration drift', () => {
  const h = fixture(), p = h.plan(); assert.equal(p.kind, 'wiki-experiment-plan-v2'); assert.deepEqual(p.cases.map(c => c.judge.backend), ['deepseek', 'jev', 'deepseek']);
  assert.deepEqual(e.validateWikiExperimentPlan(p), p); e.assertWikiExperimentPlan(p, h.definition, h.catalog);
  for (const mutate of [x => x.definition.cases[0].judge = configuration('jev'), x => x.definition.cases[1].judge.promptHash = r.wikiValueHash('changed'), x => x.definition.cases[1].judge.settings.temperature = 1]) {
    const x = fixture(), old = x.plan(); mutate(x); assert.throws(() => e.assertWikiExperimentPlan(old, x.definition, x.catalog), /wiki_experiment_changed/);
  }
  h.definition.cases[0].judge = configuration('jev'); assert.throws(h.plan, /wiki_judge_binding_changed/);
});
test('assertion drafting instructs declarative binary statements, never yes/no questions', () => {
  const draft = require('../../scripts/badcase-capture/draft-wiki-rubrics.cjs');
  const text = JSON.parse(draft.buildRubricDraftRequest({ cases: [] })).messages[0].content;
  assert.match(text, /陈述句/); assert.match(text, /成立.*不成立/); assert.doesNotMatch(text, /起草2–4条能答是\/否的中文问题/);
});
