const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { createWikiRunStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store');
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const modulePath = '../../build/server/domain/runtime/badcase-capture/wiki-initial-split';
function fixture() {
  const cases = [], dehydrations = [];
  function add(id, level = 'trace', split = null, entryId = 'entry-1') {
    const c = { id, kind: 'marked-badcase', split, source: { agentId: 'role-family-gpt', conversationId: 'synthetic-room', messageId: id },
      actual: 'synthetic problem ' + id, expected: 'synthetic expectation', createdAt: '2026-11-06T00:00:00Z',
      traceBundle: { hash: hash(id) }, sealedCheckpointId: level === 'trace' ? 'cp-' + id : null };
    cases.push(c);
    if (level === 'run') dehydrations.push({ caseId: id, traceHash: c.traceBundle.hash, decision: { hash: hash(['decision', id]), kind: 'single', level: 'run' } });
    return { caseId: id, entryId, source: 'manual', confirmedAt: '2026-11-06T00:00:00Z' };
  }
  const classifications = [];
  for (const p of [1, 2]) {
    for (let i = 0; i < 4; i++) classifications.push(add(`p${p}-trace-${i}`, 'trace', null, 'entry-' + p));
    for (let i = 0; i < 6; i++) classifications.push(add(`p${p}-run-${i}`, 'run', null, 'entry-' + p));
  }
  for (const [id, level] of [['unlabelled', 'trace'], ['invalid', 'run'], ['pending', 'run'], ['reference', 'run'], ['unconfirmed', 'run'], ['other', 'trace'], ['already', 'trace']]) {
    const label = add(id, level, id === 'already' ? 'test' : null);
    if (id !== 'unlabelled') classifications.push(label);
  }
  classifications.push(add('text-ea8201f3c1ddf0fa73043f88d2ac6e10eb2d3529ed3140e0a2261a63503cc40b'));
  cases.find(c => c.id === 'other').source.agentId = 'role-family-kimi';
  dehydrations.find(d => d.caseId === 'reference').decision = { hash: hash('reference'), kind: 'throughout', level: 'reference' };
  delete dehydrations.find(d => d.caseId === 'unconfirmed').decision;
  const state = { schemaVersion: 1, scope: 'global', revision: 1, cases, dehydrations, classifications, caseStates: [],
    versions: [{ id: 'wiki-1', entries: [1, 2].map(n => ({ id: 'entry-' + n, title: 'Pattern ' + n, status: 'approved', caseIds: [] })) }],
    replayCases: [], replaySplit: { id: 'legacy-split' }, suggestions: [], events: [], candidates: [],
    regroupProposals: [{ hash: hash('old-proposal') }], regroupConfirmations: [{ hash: hash('old-confirmation') }],
    deletedCases: [{ case: { ...cases[0], id: 'deleted' }, hash: hash('archived') }] };
  const runs = dehydrations.filter(d => d.decision && !['pending', 'reference'].includes(d.caseId)).map(d => ({ id: hash(['run', d.caseId]), resultHash: hash(['result', d.caseId]),
    caseId: d.caseId, traceHash: d.traceHash, decisionHash: d.decision.hash, variant: { kind: 'original' }, baselineStatus: d.caseId === 'invalid' ? 'no_valid_output' : 'valid_output', caseEligibleForGateAndScreen: d.caseId !== 'invalid' }));
  return { state, runs };
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-initial-split-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') }, f = fixture();
  const directory = path.join(options.globalRoot, 'snapshots'); fs.mkdirSync(directory, { recursive: true });
  function publish(state) { fs.writeFileSync(path.join(directory, String(state.revision).padStart(12, '0') + '.json'), JSON.stringify({ schemaVersion: 1, checksum: hash(state), record: state })); }
  publish(f.state);
  const store = createWikiStore(options), runs = createWikiRunStore(options);
  for (const d of f.state.dehydrations.filter(d => d.decision && !['pending', 'reference'].includes(d.caseId))) {
    const r = runs.reserve({ schemaVersion: 1, kind: 'wikiskill-run-request', variant: { kind: 'original' }, metadata: { caseId: d.caseId, traceHash: d.traceHash, decisionHash: d.decision.hash } });
    runs.finish(r.id, { outcome: { status: d.caseId === 'invalid' ? 'invalid' : 'reached' }, modelCalls: 1, toolExecutions: 0 });
  }
  return { ...f, root, options, directory, publish, store, runs };
}
test('initial allocation is deterministic, per confirmed pattern, and excludes all ineligible pending cases', () => {
  const { planWikiInitialSplit } = require(modulePath), f = fixture(), p = planWikiInitialSplit(f.state, f.runs);
  assert.deepEqual(planWikiInitialSplit({ ...f.state, cases: [...f.state.cases].reverse(), classifications: [...f.state.classifications].reverse() }, [...f.runs].reverse()), p);
  assert.equal(p.seed, 'wikiskill-trace-run-stratified-v1');
  for (const key of ['entry-1', 'entry-2']) {
    const mode = p.patterns.find(v => v.patternKey === key);
    assert.equal(mode.rows.filter(r => r.proposedSplit).length, 10);
    assert.equal(mode.counts.run.test, 0); assert.ok(mode.counts.run.gate <= mode.counts.trace.gate);
  }
  const reasons = Object.fromEntries(p.rows.map(r => [r.caseId, r.reason]));
  assert.equal(reasons.unlabelled, 'pattern_label_unconfirmed'); assert.equal(reasons.invalid, 'baseline_no_valid_output');
  assert.equal(reasons.pending, 'baseline_pending'); assert.equal(reasons.reference, 'reference_only');
  assert.equal(reasons.unconfirmed, 'dehydration_not_confirmed'); assert.equal(reasons.other, 'non_gpt_report_only');
  assert.equal(reasons['text-ea8201f3c1ddf0fa73043f88d2ac6e10eb2d3529ed3140e0a2261a63503cc40b'], 'legacy_test_source');
  assert.equal(p.rows.some(r => r.caseId === 'deleted'), false);
  assert.equal(p.rows.find(r => r.caseId === 'already').proposedSplit, null);
  assert.equal(p.rows.filter(r => r.proposedSplit === 'test').every(r => r.level === 'trace'), true);
  assert.deepEqual(p.patterns.find(v => v.patternKey === 'entry-2').counts, { trace: { train: 2, gate: 1, test: 1 }, run: { train: 5, gate: 1, test: 0 } });
  const noTrace = structuredClone(f.state); noTrace.cases = noTrace.cases.filter(c => !c.id.startsWith('p2-trace'));
  const q = planWikiInitialSplit(noTrace, f.runs);
  assert.equal(q.patterns.find(v => v.patternKey === 'entry-2').counts.run.gate, 0, 'another pattern cannot supply a trace gate quota');
  assert.deepEqual(q.patterns.find(v => v.patternKey === 'entry-1'), p.patterns.find(v => v.patternKey === 'entry-1'));
  const poison = { ...f.state, candidates: [{ text: 'CANDIDATE PRIVATE' }], comparisons: ['SCORE PRIVATE'] };
  assert.deepEqual(planWikiInitialSplit(poison, f.runs), p);
});
test('candidate outputs and foreign or superseded evidence never make a run eligible', () => {
  const { planWikiInitialSplit } = require(modulePath), f = fixture();
  for (const change of [{ variant: { kind: 'candidate' } }, { traceHash: hash('wrong') }, { decisionHash: hash('wrong') }, { excludedReason: 'user_reclassified_reference' }]) {
    const rows = f.runs.map(r => r.caseId === 'p1-run-0' ? { ...r, ...change } : r);
    assert.equal(planWikiInitialSplit(f.state, rows).rows.find(r => r.caseId === 'p1-run-0').proposedSplit, null);
  }
});
test('confirmed labels do not infer holdout membership, and explicit unclassified is distinct from unconfirmed', t => {
  const { projectWikiPatternLabels } = require(modulePath), h = setup(t), before = h.store.read();
  const labels = projectWikiPatternLabels(before), c = before.cases.find(c => c.id === 'unlabelled'), label = labels.find(r => r.caseId === c.id);
  assert.equal(label.confirmed, false);
  const input = { caseId: c.id, entryId: null, labelHash: label.labelHash, expectedRevision: before.revision };
  const saved = h.store.confirmPatternLabel(input), after = h.store.read();
  assert.equal(saved.entryId, null); assert.equal(projectWikiPatternLabels(after).find(r => r.caseId === c.id).patternKey, 'unclassified');
  for (const k of ['cases', 'versions', 'caseStates', 'classifications', 'regroupProposals', 'regroupConfirmations', 'dehydrations', 'replaySplit']) assert.deepEqual(after[k], before[k]);
  assert.deepEqual(h.store.confirmPatternLabel(input), saved); assert.equal(h.store.read().revision, after.revision, 'network retry of exact consent is idempotent');
  assert.throws(() => h.store.confirmPatternLabel({ ...input, entryId: 'entry-1', expectedRevision: after.revision }), /wiki_pattern_label_frozen/);
});
test('label confirmation binds revision and hash and refuses unknown modes, deleted cases and caller fields', t => {
  const { projectWikiPatternLabels } = require(modulePath), h = setup(t), before = h.store.read();
  const input = { caseId: 'unlabelled', entryId: 'entry-1', labelHash: projectWikiPatternLabels(before).find(r => r.caseId === 'unlabelled').labelHash, expectedRevision: before.revision };
  for (const [change, error] of [[{ expectedRevision: 0 }, /wiki_revision_conflict/], [{ labelHash: hash('bad') }, /wiki_pattern_label_stale/], [{ entryId: 'missing' }, /wiki_entry_not_found/], [{ split: 'train' }, /wiki_invalid_input/], [{ caseId: 'deleted' }, /wiki_unknown_case/]]) {
    assert.throws(() => h.store.confirmPatternLabel({ ...input, ...change }), error); assert.deepEqual(h.store.read(), before);
  }
  const saved = h.store.confirmPatternLabel(input); assert.equal(saved.entryId, 'entry-1'); assert.deepEqual(h.store.read().cases, before.cases);
});
test('initial split confirmation only activates the selected pattern and preserves all historical records', t => {
  const { planWikiInitialSplit } = require(modulePath), h = setup(t), before = h.store.read(), packets = h.runs.list().map(r => h.runs.read(r.id));
  const p = planWikiInitialSplit(before, h.runs.list()), input = { expectedRevision: before.revision, proposalHash: p.hash, patternKey: 'entry-1' };
  const saved = h.store.confirmInitialSplit(input), after = h.store.read();
  assert.equal(saved.proposal.hash, p.hash); assert.equal(saved.patternKey, 'entry-1');
  for (const c of after.cases) {
    const old = before.cases.find(v => v.id === c.id), row = p.rows.find(r => r.caseId === c.id);
    assert.deepEqual(c, row.patternKey === 'entry-1' && row.proposedSplit ? { ...old, split: row.proposedSplit } : old);
  }
  for (const k of ['versions', 'caseStates', 'classifications', 'regroupProposals', 'regroupConfirmations', 'dehydrations', 'replaySplit', 'replayCases']) assert.deepEqual(after[k], before[k]);
  assert.deepEqual(h.runs.list().map(r => h.runs.read(r.id)), packets);
  assert.deepEqual(h.store.confirmInitialSplit(input), saved); assert.equal(h.store.read().revision, after.revision);
  const q = planWikiInitialSplit(after, h.runs.list());
  assert.equal(q.rows.filter(r => r.patternKey === 'entry-1' && r.proposedSplit).length, 0);
  assert.deepEqual(q.patterns.find(r => r.patternKey === 'entry-2'), p.patterns.find(r => r.patternKey === 'entry-2'));
});
test('split confirmation rejects stale hashes/revisions/evidence, empty patterns and submitted assignments atomically', t => {
  const { planWikiInitialSplit } = require(modulePath), h = setup(t), before = h.store.read(), p = planWikiInitialSplit(before, h.runs.list());
  const input = { expectedRevision: before.revision, proposalHash: p.hash, patternKey: 'entry-1' };
  for (const [change, error] of [[{ expectedRevision: 0 }, /wiki_revision_conflict/], [{ proposalHash: hash('wrong') }, /wiki_initial_split_stale/], [{ patternKey: 'missing' }, /wiki_initial_split_empty/], [{ assignments: [] }, /wiki_invalid_input/]]) {
    assert.throws(() => h.store.confirmInitialSplit({ ...input, ...change }), error); assert.deepEqual(h.store.read(), before);
  }
  const run = h.runs.list().find(r => r.caseId === 'p1-run-0'), file = path.join(h.options.globalRoot, 'run-replays', run.id + '.result.json'), bytes = fs.readFileSync(file);
  fs.unlinkSync(file); assert.throws(() => h.store.confirmInitialSplit(input), /wiki_initial_split_stale/); fs.writeFileSync(file, bytes);
  const link = fs.linkSync;
  try { fs.linkSync = () => { throw Error('disk failure'); }; assert.throws(() => h.store.confirmInitialSplit(input), /wiki_write_failed/); }
  finally { fs.linkSync = link; }
  assert.deepEqual(h.store.read(), before); assert.equal(h.store.confirmInitialSplit(input).patternKey, 'entry-1');
});
test('model preclassification only proposes a pattern and cannot allocate a new case or change old groups', t => {
  const h = setup(t), state = h.store.read(); state.cases = state.cases.filter(c => c.id === 'already'); h.publish(state);
  const c = h.store.addMarkedCase({ source: { projectId: null, conversationId: 'room', conversationTitle: 'synthetic', messageId: 'new', agentId: 'role-family-gpt' }, role: 'GPT',
    actual: 'new issue', expected: 'expected', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false, sealedCheckpointId: 'new-checkpoint' }).case;
  const before = h.store.read();
  h.store.recordPreclassification({ caseIds: [c.id], model: 'deepseek/deepseek-v4-flash', proof: { inputHash: hash('input'), calls: [], cleaned: true },
    results: [{ caseId: c.id, kind: 'assign', entryId: 'entry-1', reason: 'synthetic suggestion', confidence: 'high' }] }, before.revision);
  assert.equal(h.store.read().cases.find(v => v.id === c.id).split, null);
  assert.deepEqual(h.store.read().cases.find(v => v.id === 'already'), before.cases.find(v => v.id === 'already'));
  assert.deepEqual(h.store.read().versions, before.versions);
});
