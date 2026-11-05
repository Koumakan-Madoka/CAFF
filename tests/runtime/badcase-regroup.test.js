const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { planWikiRegroup, planConfirmedWikiRegroup } = require('../../build/server/domain/runtime/badcase-capture/wiki-regroup');
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const deletedId = 'text-6d9cbd07278d02cc72a12b5a358aad639d802a632679a43de0752e5eff7a3a92';
const sourceId = 'text-ea8201f3c1ddf0fa73043f88d2ac6e10eb2d3529ed3140e0a2261a63503cc40b';
function fixture() {
  const cases = ['trace-a', 'trace-b', ...Array.from({ length: 6 }, (_, i) => 'run-' + i), 'invalid', 'reference', 'other', sourceId, deletedId].map(id => ({ id,
    kind: 'text-only', split: 'train', actual: id, expected: 'expected', createdAt: '2026-11-05T00:00:00Z',
    source: { projectId: null, agentId: id === 'other' ? 'role-family-deepseek' : 'role-family-gpt', conversationId: 'room', messageId: id },
    traceBundle: { hash: 'a'.repeat(64) }, ...(['trace-a', 'trace-b', 'other'].includes(id) ? { sealedCheckpointId: id } : {}) }));
  const dehydrations = cases.filter(c => c.id.startsWith('run-') || ['invalid', 'reference'].includes(c.id)).map(c => ({ caseId: c.id, traceHash: c.traceBundle.hash,
    decision: { hash: hash(c.id), level: c.id === 'reference' ? 'reference' : 'run', kind: c.id === 'reference' ? 'throughout' : 'single' } }));
  const runs = dehydrations.map(d => ({ id: hash(d.caseId + '-run'), resultHash: hash(d.caseId + '-result'), caseId: d.caseId, traceHash: d.traceHash,
    decisionHash: d.decision.hash, variant: { kind: 'original' }, baselineStatus: d.caseId === 'invalid' ? 'no_valid_output' : 'valid_output',
    caseEligibleForGateAndScreen: d.caseId !== 'invalid' }));
  return { state: { schemaVersion: 1, scope: 'global', revision: 1, cases, dehydrations, versions: [], events: [], replayCases: [],
    replaySplit: { id: 'old-frozen-split' }, candidates: [], caseStates: [], suggestions: [], classifications: [] }, runs };
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-regroup-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') }, f = fixture();
  const dir = path.join(options.globalRoot, 'snapshots'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '000000000001.json'), JSON.stringify({ schemaVersion: 1, checksum: hash(f.state), record: f.state }));
  return { ...f, options, store: createWikiStore(options), dir };
}
function confirmationFixture(t) {
  const h = setup(t), state = h.store.read();
  state.cases.find(c => c.id === 'trace-a').split = 'gate'; state.cases.find(c => c.id === 'trace-b').split = 'test';
  fs.writeFileSync(path.join(h.dir, '000000000001.json'), JSON.stringify({ schemaVersion: 1, checksum: hash(state), record: state }));
  const { createWikiRunStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store');
  const runs = createWikiRunStore(h.options);
  for (const d of state.dehydrations) {
    const r = runs.reserve({ schemaVersion: 1, kind: 'wikiskill-run-request', variant: { kind: 'original' }, metadata: { caseId: d.caseId, traceHash: d.traceHash, decisionHash: d.decision.hash } });
    runs.finish(r.id, { outcome: { status: d.caseId === 'invalid' ? 'invalid' : 'reached' }, modelCalls: 1, toolExecutions: 0 });
  }
  const proposal = h.store.proposeRegroup({ expectedRevision: 1 });
  const input = { expectedRevision: h.store.read().revision, proposalHash: proposal.hash, preserveTraceSplits: true, reason: '保留已冻结的 trace 组别，只应用六条 run 分组' };
  const confirmation = { source: 'user-via-planner', reference: 'user-group-confirmation' };
  return { ...h, proposal, input, confirmation, runs };
}
test('stratified proposal is order-independent, bounded, fixed-seed and contains no evaluation answers', () => {
  const f = fixture(), p = planWikiRegroup(f.state, f.runs);
  const reverse = { ...f.state, cases: [...f.state.cases].reverse(), dehydrations: [...f.state.dehydrations].reverse() };
  const groups = v => v.rows.map(r => [r.caseId, r.proposedSplit, r.reason]);
  assert.deepEqual(groups(planWikiRegroup(reverse, [...f.runs].reverse())), groups(p), 'ranks/groups do not depend on import order');
  assert.equal(p.policy, 'trace-run-stratified-v1'); assert.equal(p.counts.trace.train, 1); assert.equal(p.counts.trace.gate, 1); assert.equal(p.counts.trace.test, 0);
  assert.equal(p.counts.run.gate, 1); assert.equal(p.counts.run.train, 5); assert.equal(p.counts.run.test, 0);
  assert.ok(p.counts.run.gate <= p.counts.trace.gate); assert.ok(p.warnings.includes('no_new_trace_test'));
  for (const id of [sourceId, 'reference', 'other', 'invalid']) assert.equal(p.rows.find(r => r.caseId === id).proposedSplit, null);
  assert.equal(p.rows.find(r => r.caseId === 'invalid').reason, 'baseline_no_valid_output');
  assert.equal(p.rows.find(r => r.caseId === 'reference').level, 'reference'); assert.equal(p.rows.find(r => r.caseId === sourceId).level, 'source');
  assert.deepEqual(planWikiRegroup({ ...f.state, candidates: ['CANDIDATE MUST NOT ENTER'], comparisons: ['GRADE MUST NOT ENTER'] }, f.runs), p);
  assert.doesNotMatch(JSON.stringify(p), /CANDIDATE MUST|GRADE MUST/);
});
test('run gate quota cannot be supplied by non-GPT scenes; candidate/foreign-decision outputs cannot unlock runs', () => {
  const f = fixture(); f.state.cases = f.state.cases.filter(c => !c.id.startsWith('trace-'));
  const p = planWikiRegroup(f.state, f.runs); assert.equal(p.counts.run.gate, 0); assert.equal(p.counts.run.train, 6);
  for (const altered of [{ variant: { kind: 'candidate' } }, { traceHash: 'b'.repeat(64) }, { decisionHash: 'b'.repeat(64) }, { caseId: 'foreign' }]) {
    const q = planWikiRegroup(f.state, f.runs.map(r => r.caseId === 'run-0' ? { ...r, ...altered } : r));
    assert.equal(q.rows.find(r => r.caseId === 'run-0').proposedSplit, null);
  }
});
test('approved deletion removes active selection but archives original records and leaves versions, legacy splits and files unchanged', t => {
  const h = setup(t), before = h.store.read(), oldBytes = fs.readFileSync(path.join(h.dir, '000000000001.json'));
  const input = { caseIds: [deletedId], reason: '早于9月14日，缺当时系统提示词；用户批准删除', expectedRevision: 1 };
  const confirmation = { source: 'user-via-planner', reference: 'approved-deletion-message' };
  h.store.deleteCases(input, confirmation); const after = h.store.read();
  assert.equal(after.cases.some(c => c.id === deletedId), false);
  assert.deepEqual(after.deletedCases[0].case, before.cases.find(c => c.id === deletedId));
  assert.equal(after.deletedCases[0].caseNumber, 7); assert.equal(after.deletedCases[0].confirmation.reference, confirmation.reference);
  assert.equal(after.events.at(-1).type, 'case-deleted'); assert.equal(after.events.at(-1).reason, input.reason);
  for (const k of ['versions', 'replaySplit', 'replayCases', 'dehydrations']) assert.deepEqual(after[k], before[k]);
  assert.deepEqual(fs.readFileSync(path.join(h.dir, '000000000001.json')), oldBytes);
  assert.throws(() => h.store.confirmDehydration({ caseId: deletedId, expectedRevision: after.revision }), /wiki_unknown_case/);
  assert.throws(() => h.store.deleteCases({ ...input, caseIds: [sourceId], expectedRevision: after.revision }, confirmation), /wiki_deletion_not_approved/);
  const rev = after.revision; h.store.deleteCases({ ...input, expectedRevision: rev }, confirmation); assert.equal(h.store.read().revision, rev);
  assert.throws(() => h.store.deleteCases({ ...input, expectedRevision: rev }), /wiki_invalid_input/);
});
test('deletion preserves a frozen trace for audit and a failed snapshot write is atomic', t => {
  const h = setup(t), { buildWikiTraceBundle } = require('../../build/server/domain/runtime/badcase-capture/wiki-trace');
  const c = h.store.read().cases.find(c => c.id === deletedId);
  const packet = buildWikiTraceBundle({ source: c.source, origin: 'backfill', message: { content: 'original reply' }, frozenAt: '2026-11-05T00:00:00Z' });
  // Fixture starts with a trace reference; use the immutable packet store directly.
  const { createWikiTraceStore, wikiTraceReference } = require('../../build/server/domain/runtime/badcase-capture/wiki-trace');
  createWikiTraceStore(h.options.globalRoot).freeze(packet); c.traceBundle = wikiTraceReference(packet);
  const state = h.store.read(); state.cases.find(v => v.id === c.id).traceBundle = c.traceBundle;
  fs.writeFileSync(path.join(h.dir, '000000000001.json'), JSON.stringify({ schemaVersion: 1, checksum: hash(state), record: state }));
  const before = h.store.read(), confirmation = { source: 'user-via-planner', reference: 'approved-deletion' };
  const input = { caseIds: [deletedId], reason: 'missing historical system prompt', expectedRevision: 1 };
  const link = fs.linkSync; try { fs.linkSync = () => { throw Error('disk failure'); }; assert.throws(() => h.store.deleteCases(input, confirmation), /wiki_write_failed/); } finally { fs.linkSync = link; }
  assert.deepEqual(h.store.read(), before); h.store.deleteCases(input, confirmation);
  assert.deepEqual(h.store.readCaseTrace(deletedId), packet); assert.deepEqual(h.store.read().deletedCases[0].case.traceBundle, c.traceBundle);
});
test('confirmed run-only plan keeps trace gate/test frozen and records the user adjustment without mutating the proposal', () => {
  const f = fixture(); f.state.cases.find(c => c.id === 'trace-a').split = 'gate'; f.state.cases.find(c => c.id === 'trace-b').split = 'test';
  const proposal = planWikiRegroup(f.state, f.runs), before = structuredClone(proposal), p = planConfirmedWikiRegroup(f.state, f.runs, proposal);
  assert.deepEqual(proposal, before); assert.equal(p.proposalHash, proposal.hash); assert.equal(p.inputHash, proposal.inputHash);
  assert.deepEqual(p.counts, { trace: { train: 0, gate: 1, test: 1 }, run: { train: 5, gate: 1, test: 0 } });
  assert.equal(p.rows.find(r => r.caseId === 'trace-b').confirmedSplit, 'test');
  assert.equal(p.rows.find(r => r.caseId === 'trace-b').confirmationReason, 'frozen_trace_split');
  assert.equal(p.rows.find(r => r.caseId === 'invalid').confirmedSplit, null);
  assert.ok(p.adjustments.some(r => r.level === 'trace' && r.confirmedSplit !== r.proposedSplit));
  assert.deepEqual(f.state.cases.map(c => c.split), ['gate', 'test', ...Array(11).fill('train')]);
  const changed = structuredClone(f.state); changed.cases[0].split = 'train';
  assert.throws(() => planConfirmedWikiRegroup(changed, f.runs, proposal), /wiki_regroup_stale/);
  const overQuota = structuredClone(f.state); overQuota.cases[0].split = 'test';
  assert.throws(() => planConfirmedWikiRegroup(overQuota, f.runs, planWikiRegroup(overQuota, f.runs)), /wiki_regroup_quota_invalid/);
});
test('confirmation applies only eligible run splits once, binds provenance/hash, and preserves old splits, proposals and run packets', t => {
  const h = confirmationFixture(t), before = h.store.read(), old = fs.readFileSync(path.join(h.dir, '000000000001.json'));
  const runPackets = h.runs.list().map(r => h.runs.read(r.id)), saved = h.store.confirmRegroup(h.input, h.confirmation), after = h.store.read();
  assert.equal(saved.status, 'active'); assert.equal(saved.proposalHash, h.proposal.hash); assert.deepEqual(saved.confirmation, h.confirmation);
  const { hash: digest, ...content } = saved; assert.equal(digest, hash(content)); assert.equal(saved.preserveTraceSplits, true);
  assert.equal(after.cases.find(c => c.id === 'trace-a').split, 'gate'); assert.equal(after.cases.find(c => c.id === 'trace-b').split, 'test');
  assert.equal(after.cases.filter(c => c.id.startsWith('run-') && c.split === 'gate').length, 1);
  for (const c of after.cases) {
    const original = before.cases.find(v => v.id === c.id);
    assert.deepEqual(c, c.id.startsWith('run-') ? { ...original, split: saved.rows.find(r => r.caseId === c.id).confirmedSplit } : original);
  }
  for (const key of ['versions', 'replaySplit', 'replayCases', 'dehydrations', 'regroupProposals']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(h.runs.list().map(r => h.runs.read(r.id)), runPackets); assert.deepEqual(fs.readFileSync(path.join(h.dir, '000000000001.json')), old);
  assert.equal(after.regroupConfirmations.length, 1); assert.equal(after.events.at(-1).type, 'case-regroup-confirmed');
  assert.deepEqual(h.store.confirmRegroup({ ...h.input, expectedRevision: after.revision }, h.confirmation), saved); assert.equal(h.store.read().revision, after.revision);
  assert.deepEqual(h.store.proposeRegroup({ expectedRevision: after.revision }), h.proposal, 'application cannot silently reshuffle or rewrite the frozen proposal');
  assert.throws(() => h.store.confirmRegroup({ ...h.input, expectedRevision: after.revision, reason: 'different' }, h.confirmation), /wiki_regroup_frozen/);
});
test('confirmation refuses missing consent, caller splits, stale revision/hash/evidence and corrupt proposal without publishing', t => {
  const h = confirmationFixture(t), before = h.store.read();
  const call = (input = h.input, confirmation = h.confirmation) => h.store.confirmRegroup(input, confirmation);
  assert.throws(() => h.store.confirmRegroup(h.input), /wiki_invalid_input/);
  assert.throws(() => call(h.input, { ...h.confirmation, source: 'automatic' }), /wiki_invalid_input/);
  assert.throws(() => call({ ...h.input, preserveTraceSplits: false }), /wiki_invalid_input/);
  assert.throws(() => call({ ...h.input, assignments: [{ caseId: 'invalid', split: 'gate' }] }), /wiki_invalid_input/);
  assert.throws(() => call({ ...h.input, expectedRevision: 1 }), /wiki_revision_conflict/);
  assert.throws(() => call({ ...h.input, proposalHash: 'f'.repeat(64) }), /wiki_regroup_stale/);
  assert.deepEqual(h.store.read(), before);
  const run = h.runs.list().find(r => r.caseId === 'run-0');
  const file = path.join(h.options.globalRoot, 'run-replays', run.id + '.result.json'); const bytes = fs.readFileSync(file); fs.unlinkSync(file);
  assert.throws(() => call(), /wiki_regroup_stale/); assert.deepEqual(h.store.read(), before); fs.writeFileSync(file, bytes);
  const bad = structuredClone(before); bad.regroupProposals[0].rows.find(r => r.caseId === 'invalid').proposedSplit = 'gate';
  fs.writeFileSync(path.join(h.dir, String(bad.revision).padStart(12, '0') + '.json'), JSON.stringify({ schemaVersion: 1, checksum: hash(bad), record: bad }));
  assert.throws(() => call(), /wiki_regroup_stale/); assert.equal(h.store.read().revision, before.revision);
});
test('confirmation snapshot publication failure is atomic and retryable without extra model calls', t => {
  const h = confirmationFixture(t), before = h.store.read(), link = fs.linkSync;
  try { fs.linkSync = () => { throw Error('disk failure'); }; assert.throws(() => h.store.confirmRegroup(h.input, h.confirmation), /wiki_write_failed/); }
  finally { fs.linkSync = link; }
  assert.deepEqual(h.store.read(), before); assert.equal(h.store.confirmRegroup(h.input, h.confirmation).status, 'active');
});
test('proposal persistence is trusted-only, idempotent and never changes any active or historical group', t => {
  const h = setup(t), before = h.store.read();
  assert.throws(() => h.store.proposeRegroup({ expectedRevision: 0 }), /wiki_revision_conflict/);
  const p = h.store.proposeRegroup({ expectedRevision: before.revision }); const after = h.store.read();
  assert.equal(p.status, 'proposed'); assert.deepEqual(after.cases, before.cases); assert.deepEqual(after.replaySplit, before.replaySplit);
  assert.equal(after.regroupProposals.length, 1); assert.equal(after.events.at(-1).type, 'case-regroup-proposed');
  assert.deepEqual(h.store.proposeRegroup({ expectedRevision: after.revision }), p); assert.equal(h.store.read().revision, after.revision);
  assert.throws(() => h.store.proposeRegroup({ expectedRevision: after.revision, seed: 'peeked' }), /wiki_invalid_input/);
  const active = planWikiRegroup(after, []); assert.equal(active.rows.find(r => r.caseId === 'run-0').proposedSplit, null, 'store must not trust supplied eligibility');
});
