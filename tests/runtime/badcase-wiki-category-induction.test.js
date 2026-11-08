const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { setup, content } = require('../helpers/wiki-category-induction.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { planWikiEvaluationSuite: suite } = require(base + 'wiki-evaluation-suite');
const { prepareWikiInduction } = require('../../scripts/badcase-capture/wiki-induction.cjs');
function unchanged(h, action, error) { const before = h.store.read(), bytes = h.bytes(); assert.throws(action, error); assert.deepEqual(h.store.read(), before); assert.deepEqual(h.bytes(), bytes); }
const frozen = s => Object.fromEntries(['cases', 'patternLabels', 'pendingPatterns', 'initialSplitConfirmations', 'dehydrations', 'rubrics', 'classifications'].map(k => [k, JSON.stringify(s[k])]));
const selections = h => h.members.filter(c => ['gate', 'test'].includes(c.split)).map(c => ({ sourceCaseId: c.id, category: 'reproduction' })).concat({ sourceCaseId: 'old-control', category: 'control' });

test('category readiness accepts production-shaped GPT roles and rejects DeepSeek members in every split', t => {
  const { wikiCategoryTrainingCases } = require(base + 'wiki-category-induction');
  const h = setup(t), state = h.store.read();
  assert.ok(h.members.every(c => c.kind === 'marked-badcase' && c.role === 'role-family-gpt' && c.source.agentId === 'role-family-gpt'));
  assert.deepEqual(wikiCategoryTrainingCases(state, h.categoryId).cases.map(c => c.id), h.trainIds);
  for (const split of ['train', 'gate', 'test']) {
    const invalid = structuredClone(state), member = invalid.cases.find(c => h.members.some(m => m.id === c.id) && c.split === split);
    assert.ok(member); member.role = member.source.agentId = 'role-family-deepseek';
    assert.throws(() => wikiCategoryTrainingCases(invalid, h.categoryId), /wiki_category_not_ready/);
  }
});

test('category induction appends a draft version with fixed title/train IDs/source; approval atomically confirms train members and immutable link', t => {
  const h = setup(t), before = h.store.read(), saved = h.draft(), draft = saved.version.entries.at(-1), afterDraft = h.store.read();
  assert.equal(afterDraft.revision, before.revision + 1); assert.equal(draft.title, '调用前检查约束');
  assert.equal(draft.sourcePendingPatternId, h.categoryId); assert.equal(draft.status, 'draft'); assert.deepEqual(draft.caseIds, h.trainIds);
  assert.equal(JSON.stringify(afterDraft.versions.slice(0, -1)), JSON.stringify(before.versions));
  assert.deepEqual(afterDraft.versions.at(-1).entries.slice(0, -1), before.versions.at(-1).entries);
  assert.deepEqual(frozen(afterDraft), frozen(before)); assert.equal(afterDraft.pendingPatternLinks, undefined);
  unchanged(h, () => h.draft(), /wiki_category_draft_pending/);
  const patch = { failureMode: '修改后的失败模式', symptoms: '修改后的表现', rootCauseHypothesis: '修改后的原因推测', guideline: '调用工具前核验声明的约束。' };
  h.review(saved, { patch }); const after = h.store.read(), approved = after.versions.at(-1).entries.at(-1);
  assert.equal(after.revision, afterDraft.revision + 1); assert.equal(approved.status, 'approved');
  for (const [key, value] of Object.entries(patch)) assert.equal(approved[key], value);
  assert.equal(after.pendingPatternLinks.length, 1); assert.equal(after.pendingPatternLinks[0].entryId, approved.id);
  assert.equal(after.pendingPatternLinks[0].pendingPatternId, h.categoryId); assert.equal(after.pendingPatternLinks[0].source, 'badcase-page');
  for (const id of h.trainIds) assert.ok(h.store.getCaseStates().find(v => v.caseId === id).memberships.some(m => m.entryId === approved.id && m.source === 'model-confirmed'));
  assert.deepEqual(frozen(after), frozen(before));
  const resolved = suite(after, selections(h), approved.id);
  assert.equal(resolved.targetReproductionCaseIds.length, 1); assert.equal(resolved.targetTestReproductionCaseIds.length, 1);
  unchanged(h, () => h.store.linkPendingPattern({ pendingPatternId: h.categoryId, entryId: 'entry-2', expectedRevision: after.revision }), /wiki_pending_pattern_link_frozen/);
  unchanged(h, () => h.review(saved), /wiki_entry_reviewed/);
  const candidate = h.store.createGlobalCandidate({ versionId: after.versions.at(-1).id, entryIds: [approved.id], targetId: 'global-harness-behavior-v1', files: [] });
  assert.ok(JSON.stringify(candidate).includes(patch.guideline)); assert.equal(JSON.stringify(candidate).includes('SCOPE_MUST_NOT'), false);
  const revision = h.store.reviseGuideline({ versionId: after.versions.at(-1).id, entryId: approved.id, guideline: '调用前检查所有参数约束，然后再执行。', expectedRevision: h.store.read().revision });
  const link = JSON.stringify(h.store.read().pendingPatternLinks);
  h.store.review({ versionId: revision.id, entryId: approved.id, decision: 'approved', expectedRevision: h.store.read().revision });
  assert.equal(JSON.stringify(h.store.read().pendingPatternLinks), link, 'normal approved-pattern wording revision must not re-link');
});

test('category content, identity, training coverage and revision validate before any snapshot; >300 Unicode guideline rejected', t => {
  const h = setup(t);
  for (const patch of [{ caseIds: [...h.trainIds, h.members.find(c => c.split === 'gate').id] }, { caseIds: h.trainIds.slice(1) }, { caseIds: [...h.trainIds].reverse().slice(0, 1) },
    { pendingPatternId: 'missing' }, { model: 'other' }, { results: [] }, { results: [content(), content()] }, { results: [{ ...content(), scope: 'forbidden' }] },
    { results: [{ ...content(), title: 'model-controlled identity' }] }, { results: [{ ...content(), failureMode: '' }] }, { results: [{ ...content(), guideline: '😀'.repeat(301) }] }]) {
    unchanged(h, () => h.store.recordCategoryInduction(h.request(patch), h.store.read().revision), /wiki_invalid|wiki_model_output_invalid|wiki_guideline_too_long|wiki_pending_pattern_not_found/);
  }
  unchanged(h, () => h.store.recordCategoryInduction(h.request(), 0), /wiki_revision_conflict/);
  const saved = h.draft();
  for (const patch of [{ guideline: '字'.repeat(301) }, { title: '不能改类别名' }, { caseIds: h.trainIds.slice(1) }]) unchanged(h, () => h.review(saved, { patch }), /wiki_guideline_too_long|wiki_invalid_input|wiki_membership_edit_unsupported/);
  const original = fs.linkSync;
  try { fs.linkSync = () => { throw Error('synthetic disk failure'); }; unchanged(h, () => h.review(saved), /wiki_write_failed/); }
  finally { fs.linkSync = original; }
  assert.equal(h.store.read().pendingPatternLinks, undefined); assert.equal(h.store.read().versions.at(-1).entries.at(-1).status, 'draft');
});

test('reject permits reinduction; manual competing link prevents initial draft approval without partial membership', t => {
  const h = setup(t), first = h.draft(); h.review(first, { decision: 'rejected', patch: { symptoms: '已驳回的表现' } });
  assert.equal(h.store.read().pendingPatternLinks, undefined);
  const rejected = JSON.stringify(h.store.read().versions.at(-1).entries.at(-1)), second = h.draft();
  assert.notEqual(first.version.entries.at(-1).id, second.version.entries.at(-1).id);
  assert.equal(JSON.stringify(h.store.read().versions.at(-1).entries.at(-2)), rejected);
  h.store.linkPendingPattern({ pendingPatternId: h.categoryId, entryId: 'entry-1', expectedRevision: h.store.read().revision });
  unchanged(h, () => h.review(second), /wiki_pending_pattern_link_frozen/);
});

test('unallocated/empty-train/linked categories cannot start, and stale old-version category review cannot orphan a later clone', t => {
  const h = setup(t, false);
  unchanged(h, () => h.store.recordCategoryInduction(h.request({ caseIds: ['new-1'] }), h.store.read().revision), /wiki_category_not_ready/);
  const h2 = setup(t), state = h2.store.read();
  for (const c of state.cases.filter(c => h2.trainIds.includes(c.id))) c.split = 'gate'; state.revision++; h2.publish(state);
  unchanged(h2, () => h2.store.recordCategoryInduction(h2.request({ caseIds: [] }), state.revision), /wiki_category_not_ready|wiki_invalid_case_ids/);
  const h3 = setup(t), saved = h3.draft(), newer = h3.store.read();
  const copy = structuredClone(newer.versions.at(-1)); copy.id = 'wiki-newer'; newer.versions.push(copy); newer.revision++; h3.publish(newer);
  unchanged(h3, () => h3.review(saved), /wiki_revision_conflict/);
  h3.store.review({ versionId: copy.id, entryId: copy.entries.at(-1).id, expectedRevision: newer.revision, decision: 'approved' });
  assert.equal(h3.store.read().pendingPatternLinks.length, 1);
});

test('a draft can still be rejected after membership drift or competing manual link, releasing it for regeneration', t => {
  for (const mode of ['membership', 'link']) {
    const h = setup(t), saved = h.draft();
    if (mode === 'membership') {
      const state = h.store.read(), extra = { ...structuredClone(state.cases.find(c => c.id === h.trainIds[0])), id: 'extra-training' };
      state.cases.push(extra); state.patternLabels.push({ ...structuredClone(state.patternLabels.find(l => l.pendingPatternId === h.categoryId)), caseId: extra.id });
      state.revision++; h.publish(state);
    } else h.store.linkPendingPattern({ pendingPatternId: h.categoryId, entryId: 'entry-1', expectedRevision: h.store.read().revision });
    unchanged(h, () => h.review(saved), /wiki_category_not_ready|wiki_pending_pattern_link_frozen/);
    h.review(saved, { decision: 'rejected' });
    assert.equal(h.store.read().versions.at(-1).entries.at(-1).status, 'rejected');
    if (mode === 'membership') {
      const cases = [...h.trainIds, 'extra-training'];
      const next = h.store.recordCategoryInduction(h.request({ caseIds: cases }), h.store.read().revision);
      assert.deepEqual([...next.version.entries.at(-1).caseIds].sort(), cases.sort());
    }
  }
});

test('global induction planning and store both exclude unlinked category training members, without blocking unrelated pending training', t => {
  const h = setup(t), state = h.store.read();
  state.cases.push({ ...structuredClone(state.cases.find(c => c.id === h.trainIds[0])), id: 'unrelated', split: 'train', actual: 'unrelated actual', expected: 'unrelated expected', message: 'unrelated message', traceExcerpt: 'unrelated trace' }); state.revision++; h.publish(state);
  const plan = prepareWikiInduction(h.store); assert.deepEqual(plan.caseIds, ['unrelated']);
  const bytes = plan.files[0].bytes.toString(); for (const id of h.trainIds) assert.equal(bytes.includes(id), false);
  const input = { caseIds: h.trainIds, model: 'deepseek/deepseek-v4-flash', proof: { inputHash: 'a'.repeat(64), calls: [], cleaned: true },
    results: h.trainIds.map(caseId => ({ caseId, kind: 'none', reason: 'must not see category cases', confidence: 'high' })) };
  unchanged(h, () => h.store.recordInduction(input, h.store.read().revision), /wiki_not_pending/);
  h.store.recordInduction({ ...input, caseIds: ['unrelated'], results: [{ ...input.results[0], caseId: 'unrelated' }] }, h.store.read().revision);
  assert.throws(() => prepareWikiInduction(h.store), /wiki_no_pending_cases/);
});

test('auto-approved category passes actual experiment target/control guards using synthetic frozen rubrics', t => {
  const h = setup(t), saved = h.draft(); h.review(saved);
  const entryId = saved.version.entries.at(-1).id, state = h.store.read(), selected = selections(h);
  const { createWikiRubric, wikiValueHash } = require(base + 'wiki-rubric');
  const { createWikiExperimentPlan } = require(base + 'wiki-experiment-plan');
  const judge = { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', settings: { temperature: 0 }, promptHash: wikiValueHash('synthetic-judge') };
  const judges = require('../helpers/wiki-judge-catalog.cjs')(h.root, [{ configuration: judge, prompt: 'synthetic-judge' }]);
  const previous = process.env.CAFF_WIKISKILL_JUDGES_CONFIG; process.env.CAFF_WIKISKILL_JUDGES_CONFIG = judges.configFile;
  t.after(() => { if (previous === undefined) delete process.env.CAFF_WIKISKILL_JUDGES_CONFIG; else process.env.CAFF_WIKISKILL_JUDGES_CONFIG = previous; });
  const catalog = selected.map(s => state.cases.find(c => c.id === s.sourceCaseId)).map(c => ({ id: c.id, sceneHash: 'a'.repeat(64), task: 'Synthetic task', actual: c.actual, expected: c.expected,
    hardAssertions: { kind: 'synthetic-check' }, rubric: { ...createWikiRubric({ caseId: c.id, version: 1, actual: c.actual, expected: c.expected, model: judge.model,
      scoringModel: { backend: judge.backend, model: judge.model }, questions: [{ id: 'q1', question: 'Checks constraints first', evidence: 'reply' }] }),
      status: 'frozen', confirmedAt: '2026-11-08T00:00:00.000Z', confirmationRecord: 'Synthetic confirmation' } }));
  const definition = { kind: 'wiki-experiment-v1', variants: [{ id: 'original', promptHash: 'b'.repeat(64) }, { id: 'candidate', promptHash: 'c'.repeat(64) }], runner: { model: 'openai-codex/gpt-6.1-sol', settings: { thinking: 'xhigh' } },
    repeats: 10, executionPolicy: 'alternating-valid-v1', decision: { kind: 'wikiskill-gate-v1', alpha: .05, noHarmFraction: .05, minimumAllowedLoss: 1, maxExtraAttemptsPerCase: 5 }, judge,
    cases: suite(state, selected, entryId).cases.map(c => ({ caseId: c.sourceCaseId, stage: c.stage, category: c.category, targetReproduction: c.targetReproduction })) };
  const plan = createWikiExperimentPlan(definition, catalog); assert.equal(plan.cases.filter(c => c.targetReproduction).length, 2);
});
