const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { planWikiRegroup } = require('../../build/server/domain/runtime/badcase-capture/wiki-regroup');
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
