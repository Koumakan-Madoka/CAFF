const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { assignPatternQuotaSplit } = require('../../build/server/domain/runtime/badcase-capture/wiki-split');
const { prepareWikiInduction, inductWikiCases } = require('../../scripts/badcase-capture/wiki-induction.cjs');
const MODEL = 'deepseek/deepseek-v4-flash';
const proof = { inputHash: 'a'.repeat(64), calls: [], cleaned: true };
function setup(t, count = 4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-preclass-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { globalRoot: path.join(root, 'global'), sourceWorktree: path.join(root, 'source') }, store = createWikiStore(config);
  const cases = store.addTextCases(Array.from({ length: count }, (_, i) => ({ source: { origin: 'http://127.0.0.1:3100', projectId: 'p1', conversationId: 'c1', messageId: 'm' + i, agentId: 'role-family-gpt' }, role: 'GPT', actual: '原问题' + i, expected: '原期望' + i, message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }))).cases;
  if (count === 16) store.setReplaySplit({ caseIds: cases.slice(0, 9).map(c => c.id) });
  const trainIds = store.read().cases.filter(c => c.split === 'train').map(c => c.id);
  const fields = { title: '汇报难懂', failureMode: '结论后置', symptoms: '术语过多', rootCauseHypothesis: '面向内部', guideline: '先讲结论。', caseIds: trainIds };
  const v = store.saveDraft({ model: MODEL, caseIds: trainIds, entries: [fields, { ...fields, title: '另一已审核模式' }], unclassified: [] });
  for (const e of v.entries) store.review({ versionId: v.id, entryId: e.id, decision: 'approved', expectedRevision: store.read().revision });
  function mark(i, checkpoint = 'cp-' + i) {
    return store.addMarkedCase({ source: { projectId: 'p1', conversationId: 'new-room', conversationTitle: '新房间', messageId: String(i), agentId: 'role-family-deepseek' }, role: 'DeepSeek', actual: '新问题' + i, expected: '新期望' + i, message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false, sealedCheckpointId: checkpoint }).case;
  }
  const result = (c, kind = 'assign') => ({ caseId: c.id, kind, ...(kind === 'assign' ? { entryId: 'entry-1' } : {}), reason: '症状相符', confidence: '高' });
  const record = results => store.recordPreclassification({ caseIds: results.map(r => r.caseId), model: MODEL, proof, results }, store.read().revision);
  return { store, config, cases, mark, result, record };
}
test('D15 integer quota deficits and ties: 4/0/0 -> gate,test,gate,test,train', () => {
  const counts = { train: 4, gate: 0, test: 0 }, output = [];
  for (let i = 0; i < 5; i++) { const split = assignPatternQuotaSplit(counts); output.push(split); counts[split]++; }
  assert.deepEqual(output, ['gate', 'test', 'gate', 'test', 'train']);
  assert.equal(assignPatternQuotaSplit({ train: 0, gate: 0, test: 0 }), 'train');
  assert.equal(assignPatternQuotaSplit({ train: 1, gate: 0, test: 0 }), 'gate');
});
test('new marks have no group, survive restart, cannot bypass preclassification by manual membership', t => {
  const h = setup(t), c = h.mark('pending');
  assert.equal(c.split, null); assert.equal(c.preclassification, undefined);
  assert.equal(h.store.getCaseStates().find(s => s.caseId === c.id).status, 'pending-preclassification');
  assert.equal(createWikiStore(h.config).read().cases.at(-1).split, null);
  assert.throws(() => h.store.assignCase({ caseId: c.id, entryId: 'entry-1', expectedRevision: h.store.read().revision }), /wiki_not_pending/);
  const prepared = prepareWikiInduction(h.store);
  assert.equal(prepared.phase, 'preclassification'); assert.deepEqual(prepared.caseIds, [c.id]);
});
test('atomic quota counts existing approved links once, sorts same-batch createdAt/id, freezes run and split', t => {
  const h = setup(t), before = h.store.read(), marked = Array.from({ length: 5 }, (_, i) => h.mark('batch-' + i));
  const ordered = [...marked].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const revision = h.store.read().revision, saved = h.record([...marked].reverse().map(c => h.result(c)));
  const after = h.store.read(); assert.equal(after.revision, revision + 1);
  assert.deepEqual(ordered.map(c => after.cases.find(v => v.id === c.id).split), ['gate', 'test', 'gate', 'test', 'train']);
  assert.deepEqual(after.cases.slice(0, before.cases.length), before.cases);
  assert.deepEqual(after.versions, before.versions); assert.deepEqual(after.replaySplit, before.replaySplit);
  for (const c of marked) { const v = after.cases.find(v => v.id === c.id); assert.equal(v.preclassification.runId, saved.run.id); assert.equal(v.preclassification.reason, '症状相符'); }
  assert.equal(after.events.filter(e => e.type === 'case-preclassified').length, 5);
  assert.throws(() => h.record(marked.map(c => h.result(c))), /wiki_not_pending/);
  assert.deepEqual(createWikiStore(h.config).read(), after);
});
test('counts frozen preclassification even after changed attribution; approved links and frozen label form a union per case', t => {
  const h = setup(t), c = h.mark('first'); h.record([h.result(c)]);
  assert.equal(h.store.read().cases.at(-1).split, 'gate');
  h.store.assignCase({ caseId: c.id, entryId: 'entry-2', expectedRevision: h.store.read().revision });
  const next = h.mark('next'); h.record([h.result(next)]);
  assert.equal(h.store.read().cases.at(-1).split, 'test');
  assert.equal(h.store.read().cases.find(v => v.id === c.id).preclassification.entryId, 'entry-1');
  assert.equal(h.store.read().cases.find(v => v.id === c.id).split, 'gate');
});
test('new mode, none and missing sealed checkpoint always train; preclassification never learns from future gate/test', t => {
  const h = setup(t), a = h.mark('new'), b = h.mark('none'), c = h.mark('missing', null), held = h.mark('held');
  const proposal = { title: '新模式', failureMode: '新问题', symptoms: '症状', rootCauseHypothesis: '假设', guideline: '可泛化准则。', caseIds: [a.id] };
  const versions = h.store.read().versions;
  h.record([h.result(a, 'new'), h.result(b, 'none'), h.result(c), h.result(held)]);
  for (const original of [a, b, c]) assert.equal(h.store.read().cases.find(v => v.id === original.id).split, 'train');
  assert.equal(h.store.read().cases.find(v => v.id === held.id).split, 'gate');
  assert.deepEqual(h.store.read().versions, versions, 'preclassification cannot learn any new-pattern prose');
  const plan = prepareWikiInduction(h.store); assert.equal(plan.phase, 'induction'); assert.deepEqual(plan.caseIds, [a.id]);
  assert.equal(plan.files[0].bytes.toString().includes(held.id), false);
  h.store.recordInduction({ model: MODEL, caseIds: [a.id], proof, results: [{ ...h.result(a, 'new'), proposal }] }, h.store.read().revision);
  assert.equal(h.store.read().versions.at(-1).entries.at(-1).status, 'draft');
});
test('gate/test classification confirmation is separate, allows approved/manual/clear, never modifies wiki or group', t => {
  const h = setup(t), c = h.mark('held'); const saved = h.record([h.result(c)]);
  const before = h.store.read(); assert.equal(before.cases.at(-1).split, 'gate');
  assert.equal(h.store.getCaseStates().find(s => s.caseId === c.id).status, 'classification-pending');
  h.store.resolveSuggestion({ suggestionId: saved.suggestions[0].id, decision: 'accepted', expectedRevision: before.revision });
  assert.equal(h.store.getCaseStates().find(s => s.caseId === c.id).status, 'classification-confirmed');
  assert.equal(h.store.read().classifications[0].entryId, 'entry-1');
  for (const entryId of ['entry-2', null]) h.store.assignCase({ caseId: c.id, entryId, expectedRevision: h.store.read().revision });
  assert.equal(h.store.read().classifications[0].entryId, null);
  assert.deepEqual(h.store.read().versions, before.versions); assert.equal(h.store.read().cases.at(-1).split, 'gate');
  assert.throws(() => prepareWikiInduction(h.store), /wiki_no_pending_cases/);
  assert.throws(() => h.store.recordInduction({ caseIds: [c.id], model: MODEL, proof, results: [h.result(c)] }), /wiki_not_pending/);
  assert.throws(() => h.store.saveDraft({ model: MODEL, caseIds: [c.id], entries: [], unclassified: [{ caseId: c.id, reason: 'no' }] }), /wiki_unknown_training_case/);
});
test('existing 16 cases keep their recorded 13/3 grouping, replaySplit and versions through preclassification', t => {
  const h = setup(t, 16), before = h.store.read();
  assert.equal(before.cases.filter(c => c.split === 'train').length, 13); assert.equal(before.cases.filter(c => c.split === 'test').length, 3);
  const c = h.mark('new-mark'); h.record([h.result(c)]);
  assert.deepEqual(h.store.read().cases.slice(0, 16), before.cases);
  assert.deepEqual(h.store.read().replaySplit, before.replaySplit); assert.deepEqual(h.store.read().versions, before.versions);
});

test('model failure, invalid output, revision conflict and cross-group proposal publish no allocation', async t => {
  const h = setup(t), c = h.mark('fails'), before = h.store.read();
  const execute = async () => ({ cleaned: true, receipt: { ok: false, calls: [] } });
  await assert.rejects(inductWikiCases({ store: h.store, confirmed: true, expectedRevision: before.revision }, { readKey: () => 'synthetic-only', execute }), /wiki_generation_failed/);
  assert.deepEqual(h.store.read(), before);
  for (const r of [[{ ...h.result(c), entryId: 'entry-missing' }], [], [h.result(c), h.result(c)]]) assert.throws(() => h.record(r));
  assert.deepEqual(h.store.read(), before);
  const other = h.mark('new'); const now = h.store.read();
  assert.throws(() => h.record([{ ...h.result(other, 'new'), proposal: { title: 'bad', failureMode: 'bad', symptoms: 'bad', rootCauseHypothesis: 'bad', guideline: 'bad', caseIds: [c.id, other.id] } }, h.result(c)]), /wiki_model_output_invalid/);
  assert.deepEqual(h.store.read(), now);
});
