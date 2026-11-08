const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { setup, hash } = require('../helpers/wiki-pending-patterns.cjs');
const generation = require('../../scripts/badcase-capture/wiki-induction.cjs');
const { buildRequestBody, classify } = require('../../scripts/badcase-capture/wiki-induction-container.cjs');
const ids = ['new-1', 'new-2', 'new-3', 'new-4'];
const proposal = (members = ids, patch = {}) => ({ name: '调用前核对工具约束', scope: '调用工具前漏查参数和前置条件。',
  members: members.map(caseId => ({ caseId, reason: 'Synthetic category identity only' })), ...patch });
const key = 'synthetic-category-model-key';
function runner(h, outputs) {
  const calls = [], events = [], diagnostics = [];
  const options = { readKey: () => key, proposeCategories: true, onEvent: e => events.push(e), writeDiagnostic: d => diagnostics.push(d),
    execute: async (image, files, settings) => {
      assert.equal(settings.key, key); const input = JSON.parse(files.find(f => f.path === 'wiki-induction-input.json').bytes); calls.push(input);
      const content = outputs.shift();
      const receipt = await classify(input, { key, fetchImpl: async (_url, init) => {
        assert.equal(JSON.parse(init.body).model, 'deepseek-v4-flash');
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      } });
      return { cleaned: true, containerId: 'synthetic-only', receipt };
    } };
  const args = { store: h.store, confirmed: true, expectedRevision: h.store.read().revision, image: { imageId: 'sha256:' + 'a'.repeat(64), architecture: 'amd64' } };
  return { calls, events, diagnostics, args, options };
}
function markUnclassified(h) {
  const state = h.store.read(); delete state.cases.find(c => c.id === 'new-4').preclassification;
  state.revision++; h.publish(state);
}

test('standalone preparation uses all eligible identity cases, not old training/holdouts, and includes existing scoped categories', t => {
  const h = setup(t, 5); h.confirm('new-5', { pendingPattern: { name: '已有类别', scope: '用来判断归属的范围' } });
  const before = h.bytes(), plan = generation.prepareWikiCategoryProposals(h.store);
  assert.equal(plan.phase, 'category-proposals'); assert.deepEqual(plan.caseIds, ids);
  const input = JSON.parse(plan.files[0].bytes);
  assert.deepEqual(input.cases.map(c => c.id), ids); assert.equal(input.pendingPatterns[0].scope, '用来判断归属的范围');
  assert.deepEqual(input.pendingPatterns[0].caseIds, ['new-5']); assert.equal(input.cases[0].preclassification.reason, 'Synthetic new pattern suggestion');
  const text = JSON.stringify(input); assert.ok(!text.includes('old-train')); assert.ok(!text.includes('old-control'));
  assert.deepEqual(h.bytes(), before);
});

test('production-shaped marked cases complete fake-model proposal, group confirmation, split, bounded induction and approval', async t => {
  const h = setup(t), state = h.store.read(), sample = state.cases.find(c => c.id === 'new-1');
  assert.equal(sample.role, 'role-family-gpt');
  state.cases.push({ ...structuredClone(sample), id: 'deepseek-new', role: 'role-family-deepseek', source: { ...sample.source, agentId: 'role-family-deepseek' } });
  state.revision++; h.publish(state);
  const run = runner(h, [{ proposals: [proposal()] }]), saved = await generation.proposeWikiCategories(run.args, run.options);
  assert.deepEqual(run.calls[0].cases.map(c => c.id), ids);
  const base = '../../build/server/domain/runtime/badcase-capture/';
  const { projectWikiPatternLabels, planWikiInitialSplit } = require(base + 'wiki-initial-split');
  const before = h.store.read(), p = saved.proposals[0], labels = projectWikiPatternLabels(before);
  const categoryId = h.store.confirmCategoryProposal({ proposalHash: p.hash, expectedRevision: before.revision, name: p.name, scope: p.scope,
    members: p.members.map(m => ({ caseId: m.caseId, labelHash: labels.find(l => l.caseId === m.caseId).labelHash })) }).pendingPattern.id;
  const split = planWikiInitialSplit(h.store.read(), []);
  h.store.confirmInitialSplit({ proposalHash: split.hash, patternKey: categoryId, expectedRevision: h.store.read().revision });
  const { wikiCategoryTrainingCases } = require(base + 'wiki-category-induction');
  const training = wikiCategoryTrainingCases(h.store.read(), categoryId).cases.map(c => c.id); let calls = 0;
  const { content } = require('../helpers/wiki-category-induction.cjs');
  const draft = await generation.inductWikiCategory({ store: h.store, confirmed: true, expectedRevision: h.store.read().revision, pendingPatternId: categoryId, image: {} }, {
    readKey: () => key, execute: async (_image, files) => {
      calls++; assert.deepEqual(JSON.parse(files[0].bytes).cases.map(c => c.id), training);
      return { cleaned: true, receipt: { ok: true, calls: [], results: [content()] } };
    },
  });
  const entry = draft.version.entries.at(-1);
  h.store.review({ versionId: draft.version.id, entryId: entry.id, expectedRevision: h.store.read().revision, decision: 'approved' });
  const after = h.store.read(); assert.equal(calls, 1); assert.equal(after.versions.at(-1).entries.at(-1).status, 'approved');
  assert.equal(after.pendingPatternLinks.find(l => l.pendingPatternId === categoryId).entryId, entry.id);
  for (const id of training) assert.ok(h.store.getCaseStates().find(c => c.caseId === id).memberships.some(m => m.entryId === entry.id));
  const selections = after.cases.filter(c => ids.includes(c.id) && ['gate', 'test'].includes(c.split)).map(c => ({ sourceCaseId: c.id, category: 'reproduction' }));
  const suite = require(base + 'wiki-evaluation-suite').planWikiEvaluationSuite(after, selections, entry.id);
  assert.equal(suite.targetReproductionCaseIds.length, 1); assert.equal(suite.targetTestReproductionCaseIds.length, 1);
  assert.equal(after.cases.find(c => c.id === 'deepseek-new').split, null); assert.ok(!after.patternLabels.some(l => l.caseId === 'deepseek-new'));
});

test('category prompt is identity-only, untrusted-data-only, has closed schema/limits and permits joining existing categories', () => {
  const body = JSON.parse(buildRequestBody({ phase: 'category-proposals', cases: [{ id: 'a' }], pendingPatterns: [] }));
  const prompt = body.messages[0].content;
  for (const word of ['proposals', 'name', 'scope', 'members', 'caseId', 'reason', 'pendingPatternId', '40', '120', '训练', '不可信', '准则']) assert.ok(prompt.includes(word), word);
  assert.ok(!prompt.includes('恰有一个 results 数组'));
  assert.deepEqual(JSON.parse(body.messages[1].content).outputChecklist.requiredCaseIds, ['a']);
});

test('already-preclassified cases can generate multiple categories via fake isolated model with no label/old-record writes', async t => {
  const h = setup(t), before = h.store.read(), run = runner(h, [{ proposals: [proposal(ids.slice(0, 2)), proposal(ids.slice(2), { name: '指令冲突未揭示' })] }]);
  const saved = await generation.proposeWikiCategories(run.args, run.options);
  assert.equal(saved.proposals.length, 2); assert.equal(run.calls.length, 1); assert.equal(h.store.read().revision, before.revision + 1);
  for (const field of ['cases', 'versions', 'patternLabels', 'inductionRuns', 'suggestions']) assert.deepEqual(h.store.read()[field], before[field]);
  assert.ok(!JSON.stringify({ saved, events: run.events }).includes(key)); assert.equal(run.diagnostics.length, 0);
});

test('combined page action preclassifies then proposes using old/new eligible cases, atomically in one snapshot', async t => {
  const h = setup(t); markUnclassified(h); const before = h.store.read(), bytes = h.bytes();
  const run = runner(h, [{ results: [{ caseId: 'new-4', kind: 'new', reason: 'Synthetic newly classified', confidence: '高' }] }, { proposals: [proposal()] }]);
  const saved = await generation.inductWikiCases(run.args, run.options);
  assert.equal(run.calls.length, 2); assert.deepEqual(run.calls[0].cases.map(c => c.id), ['new-4']); assert.deepEqual(run.calls[1].cases.map(c => c.id), ids);
  assert.equal(saved.proposals.length, 1); assert.equal(h.store.read().revision, before.revision + 1);
  assert.equal(Object.keys(h.bytes()).length, Object.keys(bytes).length + 1);
  assert.deepEqual(h.store.read().patternLabels, before.patternLabels);
  assert.deepEqual(h.store.read().cases.filter(c => c.id !== 'new-4'), before.cases.filter(c => c.id !== 'new-4'));
  assert.deepEqual(h.store.read().versions, before.versions);
  assert.equal(h.store.read().cases.find(c => c.id === 'new-4').preclassification.reason, 'Synthetic newly classified');
});

for (const invalid of [[], [proposal(ids, { name: '' })], [proposal(['outside'])], [proposal(['new-1', 'new-1'])], [proposal(ids, { guideline: 'not allowed' })]]) {
  test('invalid second output rejects combined generation without even publishing preclassification: ' + hash(invalid).slice(0, 8), async t => {
    const h = setup(t); markUnclassified(h); const bytes = h.bytes(), state = h.store.read();
    const run = runner(h, [{ results: [{ caseId: 'new-4', kind: 'new', reason: 'Synthetic', confidence: '高' }] }, { proposals: invalid }]);
    await assert.rejects(generation.inductWikiCases(run.args, run.options), /wiki_model_output_invalid/);
    assert.deepEqual(h.store.read(), state); assert.deepEqual(h.bytes(), bytes); assert.equal(run.calls.length, 2);
    assert.equal(run.diagnostics.at(-1).phase, 'category-proposals');
  });
}

test('invalid preclassification is rejected before any category call; revision drift before save rejects both results', async t => {
  const h = setup(t); markUnclassified(h); const bytes = h.bytes();
  const run = runner(h, [{ results: [{ caseId: 'outside', kind: 'new', reason: 'Synthetic', confidence: '高' }] }]);
  await assert.rejects(generation.inductWikiCases(run.args, run.options)); assert.equal(run.calls.length, 1); assert.deepEqual(h.bytes(), bytes);
  const next = runner(h, [{ results: [{ caseId: 'new-4', kind: 'new', reason: 'Synthetic', confidence: '高' }] }, { proposals: [proposal()] }]);
  const execute = next.options.execute; let n = 0;
  next.options.execute = async (...args) => { const out = await execute(...args); if (++n === 2) h.confirm('new-1', { entryId: null }); return out; };
  await assert.rejects(generation.inductWikiCases(next.args, next.options), /wiki_revision_conflict/);
  assert.equal(h.store.read().cases.find(c => c.id === 'new-4').preclassification, undefined);
  assert.equal(h.store.read().categoryProposals, undefined);
});

test('fake category model can propose joining an existing category without rewriting its identity', async t => {
  const h = setup(t, 5), pending = h.confirm('new-5', { pendingPattern: { name: '调用前核对工具约束', scope: '调用工具前漏查参数和前置条件。' } });
  const before = h.store.read(), run = runner(h, [{ proposals: [proposal(ids, { pendingPatternId: pending.pendingPatternId })] }]);
  const saved = await generation.proposeWikiCategories(run.args, run.options);
  assert.equal(saved.proposals[0].pendingPatternId, pending.pendingPatternId);
  assert.deepEqual(h.store.read().pendingPatterns, before.pendingPatterns); assert.deepEqual(h.store.read().patternLabels, before.patternLabels);
});

test('standalone preflight rejects missing consent/revision/no eligible cases before auth or execution', async t => {
  const h = setup(t), run = runner(h, []); let reads = 0; run.options.readKey = () => { reads++; throw Error(); };
  for (const patch of [{ confirmed: false }, { expectedRevision: 0 }]) await assert.rejects(generation.proposeWikiCategories({ ...run.args, ...patch }, run.options));
  for (const caseId of ids) h.confirm(caseId, { entryId: null });
  await assert.rejects(generation.proposeWikiCategories({ ...run.args, expectedRevision: h.store.read().revision }, run.options), /wiki_no_pending_cases/);
  assert.equal(reads, 0); assert.equal(run.calls.length, 0);
});

test('operator page runtime selects same config for standalone categories and opts into combined category generation', async t => {
  const h = setup(t), configFile = path.join(h.root, 'runtime.json'), credentialDir = path.join(h.root, 'synthetic-agent');
  fs.writeFileSync(configFile, JSON.stringify({ image: { imageId: 'sha256:' + 'a'.repeat(64), architecture: 'amd64' }, credentialDir }));
  const runtime = require('../../scripts/badcase-capture/wiki-page-runtime.cjs'); let n = 0;
  const deps = { readKey: env => { assert.equal(env.PI_CODING_AGENT_DIR, credentialDir); return key; },
    induct: async (_input, options) => { assert.equal(options.proposeCategories, true); n++; return 'combined'; },
    proposeCategories: async (input, options) => { assert.equal(input.store, h.store); assert.equal(input.confirmed, true); assert.equal(options.readKey(), key); n++; return 'standalone'; } };
  assert.equal(await runtime.runPageInduction({ store: h.store, expectedRevision: h.store.read().revision }, { configFile }, deps), 'combined');
  assert.equal(await runtime.runPageCategoryProposals({ store: h.store, expectedRevision: h.store.read().revision }, { configFile }, deps), 'standalone'); assert.equal(n, 2);
});
