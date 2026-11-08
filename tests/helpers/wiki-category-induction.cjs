// Synthetic category workflow fixture; no production reads or model calls.
const { setup: pendingSetup, hash } = require('./wiki-pending-patterns.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { planWikiInitialSplit } = require(base + 'wiki-initial-split');
const MODEL = 'deepseek/deepseek-v4-flash';
const content = () => ({ failureMode: '未核对约束就调用工具', symptoms: '参数被工具拒绝', rootCauseHypothesis: '可能跳过调用前检查', guideline: '调用前先核对工具参数及前置条件。' });
function setup(t, allocate = true) {
  const h = pendingSetup(t), seeded = h.store.read();
  for (const e of seeded.versions[0].entries) Object.assign(e, content());
  seeded.revision++; h.publish(seeded);
  const categoryId = h.confirm('new-1', { pendingPattern: { name: '调用前检查约束', scope: 'SCOPE_MUST_NOT_ENTER_INDUCTION_OR_CANDIDATE' } }).pendingPatternId;
  for (const caseId of ['new-2', 'new-3', 'new-4']) h.confirm(caseId, { pendingPattern: { id: categoryId } });
  if (allocate) { const state = h.store.read(), p = planWikiInitialSplit(state, []);
    h.store.confirmInitialSplit({ proposalHash: p.hash, patternKey: categoryId, expectedRevision: state.revision }); }
  const state = h.store.read();
  for (const c of state.cases) Object.assign(c, { actual: `${c.split || 'unallocated'}_ACTUAL_${c.id}`,
    expected: `${c.split || 'unallocated'}_EXPECTED_${c.id}`, message: `${c.split || 'unallocated'}_MESSAGE_${c.id}`,
    traceExcerpt: `${c.split || 'unallocated'}_TRACE_${c.id}`, traceState: 'available', messageTruncated: false, traceTruncated: false });
  state.revision++; h.publish(state);
  const members = state.cases.filter(c => c.id.startsWith('new-'));
  const trainIds = members.filter(c => c.split === 'train').map(c => c.id).sort();
  const request = (patch = {}) => ({ pendingPatternId: categoryId, caseIds: trainIds, model: MODEL,
    proof: { inputHash: hash('synthetic training-only input'), calls: [], cleaned: true }, results: [content()], ...patch });
  const draft = () => h.store.recordCategoryInduction(request(), h.store.read().revision);
  const review = (saved, patch = {}) => h.store.review({ versionId: saved.version.id, entryId: saved.version.entries.at(-1).id,
    expectedRevision: h.store.read().revision, decision: 'approved', ...patch });
  return { ...h, categoryId, members, trainIds, request, draft, review };
}
module.exports = { setup, content, MODEL, hash };
