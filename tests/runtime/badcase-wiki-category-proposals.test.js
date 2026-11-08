// Category identity may see all unallocated cases; it never assigns a label
// until the operator confirms the exact proposal and current member hashes.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup, hash } = require('../helpers/wiki-pending-patterns.cjs');
const { projectWikiPatternLabels: labels, planWikiInitialSplit: split } = require('../../build/server/domain/runtime/badcase-capture/wiki-initial-split');
const MODEL = 'deepseek/deepseek-v4-flash';
const caseIds = ['new-1', 'new-2', 'new-3', 'new-4'];
const category = (ids = caseIds, patch = {}) => ({ name: '调用前核对工具约束', scope: '调用受约束的工具前不核对参数或前置条件，被拒后才改。',
  members: ids.map(caseId => ({ caseId, reason: 'Synthetic: skipped a tool constraint check' })), ...patch });
const proof = { inputHash: hash('synthetic category request'), calls: [], cleaned: true };
const record = (h, proposals = [category()], ids = caseIds, revision = h.store.read().revision) => h.store.recordCategoryProposals({ caseIds: ids, model: MODEL, proof, proposals }, revision);
function consent(h, proposal, ids = proposal.members.map(m => m.caseId), patch = {}) {
  const state = h.store.read(), projected = labels(state);
  return { proposalHash: proposal.hash, expectedRevision: state.revision, name: proposal.name, scope: proposal.scope,
    members: ids.map(caseId => ({ caseId, labelHash: projected.find(l => l.caseId === caseId).labelHash })), ...patch };
}
const status = (h, proposal) => h.store.getCategoryProposals().find(p => p.hash === proposal.hash).status;
const oldFields = state => Object.fromEntries(['cases', 'versions', 'caseStates', 'classifications', 'patternLabels', 'initialSplitConfirmations',
  'regroupProposals', 'regroupConfirmations', 'dehydrations', 'rubrics', 'inductionRuns', 'suggestions'].map(k => [k, JSON.stringify(state[k])]));
function unchanged(h, action, error) {
  const state = h.store.read(), bytes = h.bytes();
  assert.throws(action, error);
  assert.deepEqual(h.store.read(), state); assert.deepEqual(h.bytes(), bytes, 'failure must not publish even a partial snapshot');
}

test('category eligibility uses marked source agent identity with production-shaped roles, excluding DeepSeek and text-only', t => {
  const { wikiCategoryEligibleCases } = require('../../build/server/domain/runtime/badcase-capture/wiki-category-proposals');
  const h = setup(t), state = h.store.read(), sample = state.cases.find(c => c.id === 'new-1');
  assert.equal(sample.kind, 'marked-badcase'); assert.equal(sample.role, 'role-family-gpt');
  state.cases.push({ ...structuredClone(sample), id: 'deepseek-new', role: 'role-family-deepseek', source: { ...sample.source, agentId: 'role-family-deepseek' } },
    { ...structuredClone(sample), id: 'text-only-new', kind: 'text-only', role: 'GPT' });
  state.revision++; h.publish(state);
  assert.deepEqual(wikiCategoryEligibleCases(h.store.read()).map(c => c.id), caseIds);
  const p = record(h).proposals[0], view = h.store.getCategoryProposals()[0];
  assert.deepEqual(view.members.filter(m => m.canConfirm).map(m => m.caseId), caseIds);
  h.store.confirmCategoryProposal(consent(h, p));
  assert.ok(labels(h.store.read()).filter(l => caseIds.includes(l.caseId)).every(l => l.confirmed));
  assert.equal(labels(h.store.read()).find(l => l.caseId === 'deepseek-new').confirmed, false);
  assert.deepEqual(wikiCategoryEligibleCases(h.store.read()), []);
});

test('model category proposals are immutable hashed records, not labels, memberships or group assignments', t => {
  const h = setup(t), before = h.store.read(), bytes = h.bytes(), result = record(h);
  assert.equal(result.proposals.length, 1);
  const proposal = result.proposals[0], { hash: savedHash, ...content } = proposal;
  assert.equal(savedHash, hash(content)); assert.deepEqual(proposal.members, category().members);
  assert.equal(proposal.name, category().name); assert.equal(proposal.scope, category().scope);
  assert.equal(status(h, proposal), 'pending');
  assert.equal(h.store.read().revision, before.revision + 1);
  assert.deepEqual(oldFields(h.store.read()), oldFields(before));
  assert.equal(split(h.store.read(), []).hash, split(before, []).hash, 'suggestions cannot alter the grouping proposal');
  for (const [file, content] of Object.entries(bytes)) assert.equal(h.bytes()[file], content);
  const saved = JSON.stringify(h.store.read().categoryProposals);
  h.store.getCategoryProposals(); labels(h.store.read());
  assert.equal(JSON.stringify(h.store.read().categoryProposals), saved, 'GET projection cannot change original proposal bytes');
});

test('one model response may propose multiple disjoint categories, atomically', t => {
  const h = setup(t), before = h.store.read();
  const proposals = [category(caseIds.slice(0, 2)), category(caseIds.slice(2), { name: '未揭示指令冲突', scope: '遇到指令冲突时先试调用，而不是先指出冲突。' })];
  const result = record(h, proposals);
  assert.equal(result.proposals.length, 2); assert.equal(h.store.read().revision, before.revision + 1);
  assert.deepEqual(oldFields(h.store.read()), oldFields(before));
  assert.deepEqual(h.store.getCategoryProposals().map(p => p.status), ['pending', 'pending']);
});

for (const [label, invalid] of [
  ['missing name', () => { const p = category(); delete p.name; return p; }],
  ['empty name', () => category(undefined, { name: '  ' })],
  ['long name', () => category(undefined, { name: '字'.repeat(41) })],
  ['missing scope', () => { const p = category(); delete p.scope; return p; }],
  ['empty scope', () => category(undefined, { scope: '  ' })],
  ['long scope', () => category(undefined, { scope: '字'.repeat(121) })],
  ['empty members', () => category([])],
  ['unknown member', () => category(['missing'])],
  ['holdout member', () => category(['old-control'])],
  ['training member', () => category(['old-train'])],
  ['duplicate member', () => category(['new-1', 'new-1'])],
  ['missing reason', () => ({ ...category(), members: [{ caseId: 'new-1' }] })],
  ['extra prose field', () => category(undefined, { guideline: 'Model must not learn content yet' })],
  ['unknown pending category', () => category(undefined, { pendingPatternId: 'missing' })],
]) {
  test(`invalid category output (${label}) rejects the whole batch without labels or partial proposals`, t => {
    const h = setup(t), good = category(['new-1']);
    unchanged(h, () => record(h, [good, invalid()]), /wiki_model_output_invalid/);
  });
}

test('a member may not occur in two proposals in the same model response', t => {
  const h = setup(t);
  unchanged(h, () => record(h, [category(), category(['new-2'], { name: '重复成员' })]), /wiki_model_output_invalid/);
});

test('eligibility excludes non-GPT, non-marked, allocated, already-labelled, and non-new preclassifications', t => {
  const patches = [{ role: 'Kimi', source: { agentId: 'role-family-kimi' } }, { kind: 'text-only' }, { split: 'train' },
    { preclassification: { kind: 'assign', entryId: 'entry-1' } }, { preclassification: { kind: 'none' } }, { preclassification: undefined }];
  for (const patch of patches) {
    const h = setup(t), state = h.store.read(); Object.assign(state.cases.find(c => c.id === 'new-4'), patch);
    state.revision++; h.publish(state);
    unchanged(h, () => record(h), /wiki_not_pending|wiki_model_output_invalid/);
  }
  const h = setup(t); h.confirm('new-4', { entryId: null });
  unchanged(h, () => record(h), /wiki_not_pending|wiki_model_output_invalid/);
  unchanged(h, () => record(h, [category(['new-1'])], ['new-1'], 0), /wiki_revision_conflict/);
});

test('new overlapping proposals supersede the old pending card through a separate resolution, never rewrite its content', t => {
  const h = setup(t), first = record(h).proposals[0], original = JSON.stringify(h.store.read().categoryProposals[0]);
  const next = record(h, [category(undefined, { name: '先检查再调用' })]).proposals[0];
  assert.equal(status(h, first), 'superseded'); assert.equal(status(h, next), 'pending');
  assert.equal(JSON.stringify(h.store.read().categoryProposals[0]), original);
  unchanged(h, () => h.store.confirmCategoryProposal(consent(h, first)), /wiki_category_proposal_resolved/);
});

test('group confirmation creates one scoped category and all selected frozen labels in one snapshot; excluded members stay unconfirmed', t => {
  const h = setup(t), p = record(h).proposals[0], before = h.store.read(), bytes = h.bytes();
  const input = consent(h, p, ['new-1', 'new-2', 'new-3'], { name: '核对约束后再调用', scope: '先核对工具的参数上限和前置条件，再调用。' });
  const result = h.store.confirmCategoryProposal(input), after = h.store.read();
  assert.equal(after.revision, before.revision + 1); assert.equal(Object.keys(h.bytes()).length, Object.keys(bytes).length + 1);
  const pending = after.pendingPatterns.find(v => v.id === result.pendingPattern.id);
  assert.equal(pending.name, input.name); assert.equal(pending.scope, input.scope); assert.equal(pending.sourceProposalHash, p.hash);
  const { hash: categoryHash, ...content } = pending; assert.equal(categoryHash, hash(content));
  assert.equal(status(h, p), 'accepted');
  for (const caseId of ['new-1', 'new-2', 'new-3']) {
    const projected = labels(after).find(l => l.caseId === caseId); assert.equal(projected.confirmed, true);
    assert.equal(projected.pendingPatternId, pending.id); assert.equal(projected.entryId, null);
    const saved = after.patternLabels.find(l => l.caseId === caseId); assert.equal(saved.source, 'badcase-page');
    assert.equal(saved.labelHash, input.members.find(m => m.caseId === caseId).labelHash);
  }
  assert.equal(labels(after).find(l => l.caseId === 'new-4').confirmed, false);
  assert.deepEqual(after.cases, before.cases); assert.deepEqual(after.versions, before.versions);
  assert.equal(JSON.stringify(after.categoryProposals), JSON.stringify(before.categoryProposals));
  for (const [file, content] of Object.entries(bytes)) assert.equal(h.bytes()[file], content);
  unchanged(h, () => h.confirm('new-1', { entryId: 'entry-1' }), /wiki_pattern_label_frozen/);
});

test('group consent binds proposal hash, revision, each member hash, membership and nonempty selection; any failure rolls back all', t => {
  const h = setup(t), p = record(h).proposals[0], input = consent(h, p);
  for (const [patch, error] of [
    [{ proposalHash: hash('not the proposal') }, /wiki_category_proposal_not_found|wiki_category_proposal_stale/],
    [{ expectedRevision: input.expectedRevision - 1 }, /wiki_revision_conflict/],
    [{ members: input.members.map((m, i) => i === 3 ? { ...m, labelHash: hash('stale last member') } : m) }, /wiki_pattern_label_stale/],
    [{ members: [] }, /wiki_invalid_case_ids|wiki_invalid_input/],
    [{ members: [input.members[0], input.members[0]] }, /wiki_invalid_case_ids|wiki_invalid_input/],
    [{ members: [{ caseId: 'old-control', labelHash: hash('outside proposal') }] }, /wiki_invalid_case_ids|wiki_invalid_input/],
    [{ split: 'train' }, /wiki_invalid_input/],
  ]) unchanged(h, () => h.store.confirmCategoryProposal({ ...input, ...patch }), error);
  const original = fs.linkSync;
  try { fs.linkSync = () => { throw Error('synthetic disk failure'); };
    unchanged(h, () => h.store.confirmCategoryProposal(input), /wiki_write_failed/);
  } finally { fs.linkSync = original; }
});

test('edited category name/scope validation and conflicts reject without creating orphan categories', t => {
  const h = setup(t), p = record(h).proposals[0], input = consent(h, p);
  for (const patch of [{ name: '' }, { name: '字'.repeat(41) }, { scope: '' }, { scope: '字'.repeat(121) }, { scope: undefined }]) {
    unchanged(h, () => h.store.confirmCategoryProposal({ ...input, ...patch }), /wiki_pending_pattern_name_invalid|wiki_pending_pattern_scope_invalid/);
  }
  unchanged(h, () => h.store.confirmCategoryProposal({ ...input, name: 'Approved pattern 1' }), /wiki_pending_pattern_name_conflict/);
  h.confirm('new-4', { pendingPattern: { name: '已有新类别', scope: '先前手动确认的范围' } });
  unchanged(h, () => h.store.confirmCategoryProposal({ ...consent(h, p, ['new-1']), name: '已有新类别' }), /wiki_pending_pattern_name_conflict/);
});

test('rejecting a proposal releases all members to single-case consent and preserves proposal and label bytes', t => {
  const h = setup(t), p = record(h).proposals[0], before = h.store.read();
  h.store.rejectCategoryProposal({ proposalHash: p.hash, expectedRevision: before.revision });
  assert.equal(status(h, p), 'rejected');
  assert.equal(JSON.stringify(h.store.read().categoryProposals), JSON.stringify(before.categoryProposals));
  assert.deepEqual(oldFields(h.store.read()), oldFields(before));
  unchanged(h, () => h.store.confirmCategoryProposal(consent(h, p)), /wiki_category_proposal_resolved/);
  const saved = h.confirm('new-1', { entryId: null }); assert.equal(saved.entryId, null);
});

test('model may suggest joining an existing scoped pending category without duplicating or changing it', t => {
  const h = setup(t, 5), first = h.confirm('new-5', { pendingPattern: { name: '已有新类别', scope: '工具调用前漏查约束。' } });
  const pending = h.store.read().pendingPatterns[0], before = JSON.stringify(pending);
  const p = record(h, [category(undefined, { pendingPatternId: first.pendingPatternId, name: pending.name, scope: pending.scope })]).proposals[0];
  const done = h.store.confirmCategoryProposal(consent(h, p));
  assert.equal(done.pendingPattern.id, first.pendingPatternId); assert.equal(h.store.read().pendingPatterns.length, 1);
  assert.equal(JSON.stringify(h.store.read().pendingPatterns[0]), before);
  assert.ok(labels(h.store.read()).filter(l => caseIds.includes(l.caseId)).every(l => l.pendingPatternId === first.pendingPatternId));
});

test('proposal member views expose current confirmability without rewriting immutable proposals', t => {
  const h = setup(t), p = record(h).proposals[0], raw = JSON.stringify(h.store.read().categoryProposals);
  assert.ok(h.store.getCategoryProposals()[0].members.every(m => m.canConfirm === true && m.unavailableReason === null));
  h.confirm('new-1', { entryId: null });
  const bytes = h.bytes(), view = h.store.getCategoryProposals()[0];
  assert.equal(view.members.find(m => m.caseId === 'new-1').canConfirm, false);
  assert.equal(view.members.find(m => m.caseId === 'new-1').unavailableReason, 'wiki_pattern_label_frozen');
  assert.ok(view.members.filter(m => m.caseId !== 'new-1').every(m => m.canConfirm));
  unchanged(h, () => h.store.confirmCategoryProposal(consent(h, p)), /wiki_pattern_label_frozen/);
  assert.equal(JSON.stringify(h.store.read().categoryProposals), raw); assert.deepEqual(h.bytes(), bytes);
  h.store.rejectCategoryProposal({ proposalHash: p.hash, expectedRevision: h.store.read().revision });
  assert.ok(h.store.getCategoryProposals()[0].members.every(m => m.canConfirm === false && m.unavailableReason === 'wiki_category_proposal_resolved'));
});

test('manual new categories require scope, and single-case options expose scoped category identity and members', t => {
  const h = setup(t);
  unchanged(h, () => h.confirm('new-1', { pendingPattern: { name: '只有名字不够' } }), /wiki_pending_pattern_scope_invalid/);
  const created = h.confirm('new-1', { pendingPattern: { name: '约束检查', scope: '工具调用前未检查参数和前置条件。' } });
  const choice = labels(h.store.read()).find(l => l.caseId === 'new-2').pendingOptions.find(p => p.id === created.pendingPatternId);
  assert.equal(choice.scope, '工具调用前未检查参数和前置条件。'); assert.deepEqual(choice.caseIds, ['new-1']);
});

test('legacy #185 categories without scope remain readable and retain record bytes and grouping hash', t => {
  const h = setup(t), state = h.store.read(), content = { id: 'pending-legacy', name: '旧的待归纳模式', source: 'badcase-page', createdAt: '2026-11-08T00:00:00.000Z', createdRevision: 117 };
  state.pendingPatterns = [{ ...content, hash: hash(content) }]; state.revision++; h.publish(state);
  const before = h.bytes(), golden = split(h.store.read(), []).hash, pending = JSON.stringify(h.store.read().pendingPatterns);
  assert.ok(labels(h.store.read()).find(l => l.caseId === 'new-1').pendingOptions.some(p => p.id === content.id));
  assert.deepEqual(h.bytes(), before); assert.equal(JSON.stringify(h.store.read().pendingPatterns), pending);
  h.confirm('new-1', { pendingPattern: { id: content.id } });
  assert.equal(JSON.stringify(h.store.read().pendingPatterns), pending);
  for (const [file, bytes] of Object.entries(before)) assert.equal(h.bytes()[file], bytes);
  assert.equal(typeof golden, 'string');
});
