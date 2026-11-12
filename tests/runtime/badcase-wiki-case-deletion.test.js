const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const fixture = require('../helpers/wiki-case-deletion.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiDisplayCases } = require(base + 'wiki-suite');
const { wikiValueHash: hash } = require(base + 'wiki-rubric');

test('any case number can be archived, including #22–#24, without rewriting other cases, groups, hashes or evidence', t => {
  const h = fixture(t), before = h.store.read(), bytes = fs.readFileSync(h.file);
  const numbers = rows => wikiDisplayCases(rows.cases, rows.deletedCases).map(c => [c.id, c.displayNumber]);
  assert.deepEqual(numbers(before).slice(-3).map(r => r[1]), [22, 23, 24]);
  for (const n of [22, 23, 24]) {
    const old = h.store.read(), id = 'synthetic-' + n;
    const saved = h.store.deleteCases({ ...h.input, caseIds: [id], expectedRevision: old.revision }, h.confirmation)[0];
    assert.deepEqual(saved.case, before.cases.find(c => c.id === id)); assert.equal(saved.caseNumber, n);
    const { hash: digest, ...payload } = saved; assert.equal(digest, require('node:crypto').createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
    assert.deepEqual(h.store.readCaseTrace(id), h.packets.get(id));
  }
  const after = h.store.read();
  assert.deepEqual(after.cases, before.cases.filter(c => ![22, 23, 24].some(n => c.id === 'synthetic-' + n)));
  for (const key of ['patternLabels', 'initialSplitConfirmations', 'regroupConfirmations', 'replaySplit', 'rubrics', 'dehydrations', 'replayCases', 'versions']) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(numbers(after), numbers(before).filter(([id]) => !id.match(/synthetic-2[234]$/)));
  assert.deepEqual(fs.readFileSync(h.file), bytes);
  assert.deepEqual(after.events.map(e => e.type), Array(3).fill('case-deleted'));
  assert.deepEqual(after.events.map(e => e.caseNumbers[0]), [22, 23, 24]);
  const revision = after.revision; h.store.deleteCases({ ...h.input, expectedRevision: revision }, h.confirmation); assert.equal(h.store.read().revision, revision);
});

test('deleting a non-final case reserves its public number and leaves the following case numbers stable', t => {
  const h = fixture(t); h.store.deleteCases(h.input, h.confirmation);
  const state = h.store.read(), display = wikiDisplayCases(state.cases, state.deletedCases);
  assert.deepEqual(display.slice(-2).map(c => c.displayNumber), [23, 24]);
  assert.deepEqual(state.deletedCases[0].confirmation, h.confirmation);
});

test('page provenance is distinct, reasons and revision required, invented provenance rejected atomically', t => {
  const h = fixture(t), before = h.store.read();
  for (const patch of [{ reason: '' }, { reason: '  ' }, { expectedRevision: undefined }, { expectedRevision: 0 }]) assert.throws(() => h.store.deleteCases({ ...h.input, ...patch }, h.confirmation), /wiki_invalid|wiki_revision_conflict/);
  assert.throws(() => h.store.deleteCases(h.input), /wiki_invalid_input/);
  assert.throws(() => h.store.deleteCases(h.input, { source: 'automatic' }), /wiki_invalid_input/);
  assert.deepEqual(h.store.read(), before);
  const saved = h.store.deleteCases(h.input, { source: 'badcase-page' })[0];
  assert.deepEqual(saved.confirmation, { source: 'badcase-page' });
});

test('confirmed controls reject deletion with no new snapshot (same existing control immutability rule)', t => {
  const h = require('../helpers/wiki-gate-control.cjs')(t); h.confirm(); const before = h.store.read();
  assert.throws(() => h.store.deleteCases({ caseIds: [h.c.id], reason: 'withdraw', expectedRevision: before.revision }, { source: 'badcase-page' }), /wiki_control_case_frozen/);
  assert.deepEqual(h.store.read(), before);
});

for (const status of ['failed', 'stopped', 'completed']) test(`unfinished original precheck blocks deletion; a ${status} record does not`, t => {
  const h = fixture(t), records = require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(h.scope);
  const reservation = records.reserve(h.precheck()), before = h.store.read();
  assert.throws(() => h.store.deleteCases(h.input, h.confirmation), /wiki_case_in_use/);
  assert.deepEqual(h.store.read(), before);
  records.finish(reservation.id, { status, reason: status === 'completed' ? null : 'synthetic_stopped', runs: status === 'completed' ? Array.from({ length: 3 }, (_, i) => ({ iteration: i + 1, variant: 'original', status: 'pass', artifactId: 'synthetic-' + i, artifactHash: hash(i), usageComplete: true })) : [] });
  h.store.deleteCases(h.input, h.confirmation); assert.equal(h.store.read().deletedCases.length, 1);
  assert.equal(records.list('synthetic-22').length, 1);
  assert.throws(() => records.reserve(h.precheck()), /wiki_case_deleted/);
});

test('running formal batch blocks deletion even when its current case has not started', t => {
  const h = fixture(t), batches = require(base + 'wiki-batch-execution-store').createWikiBatchExecutionStore(h.scope);
  const r = batches.start(h.batch()), before = h.store.read();
  assert.throws(() => h.store.deleteCases(h.input, h.confirmation), /wiki_case_in_use/); assert.deepEqual(h.store.read(), before);
  batches.fail(r.id, 'wiki_synthetic_stop'); h.store.deleteCases(h.input, h.confirmation);
  assert.equal(batches.read()[0].status, 'failed');
  assert.throws(() => batches.start(h.batch()), /wiki_case_deleted/);
});

test('deletion checks all executions, not just the most recent twenty displayed on the page', t => {
  const h = fixture(t), batches = require(base + 'wiki-batch-execution-store').createWikiBatchExecutionStore(h.scope);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const r = batches.start(h.batch());
  for (let i = 0; i < 21; i++) { t.mock.timers.setTime(Date.now() + 1000); const next = batches.start(h.batch('synthetic-23')); batches.fail(next.id, 'wiki_synthetic_stop'); }
  assert.equal(batches.read().some(x => x.id === r.id), false);
  assert.throws(() => h.store.deleteCases(h.input, h.confirmation), /wiki_case_in_use/);
  batches.fail(r.id, 'wiki_synthetic_stop'); h.store.deleteCases(h.input, h.confirmation);
});

test('legacy single-case running evaluations also block deletion; unrelated activity does not', t => {
  const h = fixture(t), executions = require(base + 'wiki-execution-store').createWikiExecutionStore(h.scope);
  const plan = { kind: 'sealed-original-replay-v1', model: 'deepseek/deepseek-v4-flash', variants: ['original'], repeats: 1, caseId: 'synthetic-22', checkpointId: 'cp', checkpointHash: hash('cp'), rulesHash: hash('rules') };
  const r = executions.start(plan); assert.throws(() => h.store.deleteCases(h.input, h.confirmation), /wiki_case_in_use/);
  executions.fail(r.id, 'wiki_synthetic_stop'); executions.start({ ...plan, caseId: 'synthetic-23' });
  h.store.deleteCases(h.input, h.confirmation);
  assert.throws(() => executions.start(plan), /wiki_case_deleted/);
});

test('old #7/#9/#11/#13 archives remain byte-compatible and do not get rewritten by new deletions', t => {
  const h = fixture(t); h.state.deletedCases = [7, 9, 11, 13].map(n => ({ case: { ...h.state.cases[0], id: 'legacy-archived-' + n }, caseNumber: n, reason: 'historical approval', confirmation: h.confirmation, deletedAt: '2026-11-05T00:00:00.000Z', hash: hash('archive-' + n) })); h.seed();
  const before = h.store.read().deletedCases; h.store.deleteCases(h.input, h.confirmation);
  assert.deepEqual(h.store.read().deletedCases.slice(0, 4), before);
});
