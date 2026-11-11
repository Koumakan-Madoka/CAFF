const test = require('node:test'), assert = require('node:assert/strict');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
const api = () => require(base + 'wiki-holdout-validation');
const fixture = require('../helpers/wiki-mode-holdout.cjs');
const { createWikiGateControlConfirmation } = require(base + 'wiki-gate-control');
function setup() {
  const h = fixture();
  h.state.versions[0].entries.push(...[2, 3, 4].map(n => ({ id: 'entry-' + n, status: 'approved', caseIds: [] })));
  for (const [i, entryId] of [[2, 'entry-2'], [3, 'entry-2'], [4, 'entry-3']]) h.state.patternLabels.find(l => l.caseId === h.marked[i].id).entryId = entryId;
  function run(number) {
    const c = h.marked[number - 17]; c.sealedCheckpointId = null;
    const content = { caseId: c.id, kind: 'single', level: 'run', traceHash: c.traceBundle.hash, cutStep: 42 };
    h.state.dehydrations.push({ caseId: c.id, traceHash: c.traceBundle.hash, decision: { ...content, hash: require(base + 'wiki-run-replay').wikiRunHash(content) } });
    h.replayChecks.splice(h.replayChecks.findIndex(r => r.caseId === c.id), 1, { caseId: c.id, level: 'run', status: 'supported', traceHash: c.traceBundle.hash, decisionHash: h.state.dehydrations.at(-1).decision.hash, cutStep: 42 });
    return c;
  }
  run(18);
  function confirm(number) {
    const c = h.marked[number - 17];
    h.save(number, Array(c.sealedCheckpointId ? 3 : 5).fill('pass'), { createdAt: '2026-11-11T00:00:01.000Z' });
    const view = require(base + 'wiki-gate-control').projectWikiGateControls(h.state, h.records, h.replayChecks).find(r => r.caseId === c.id);
    const confirmation = createWikiGateControlConfirmation(h.state, c.id, view.proposalHash, h.records, h.replayChecks);
    h.state.controlConfirmations.push(confirmation); return confirmation;
  }
  for (let number = 17; number <= 21; number++) confirm(number);
  const history = h.marked.map((c, i) => ({ caseId: c.id, caseHash: hash(c), level: c.sealedCheckpointId ? 'trace' : 'run',
    totalTokens: [100, 900, 300, 600, 150, 900, 900, 900][i], executions: 3, evidenceHash: hash('synthetic retained usage ' + c.id) }));
  return { ...h, history, run, confirm, input() { return { ...h.input(), seed: 'fixed-validation-seed', history }; } };
}
const select = h => api().planWikiHoldoutValidation(h.input());
const decide = (s, gate, rows = []) => api().decideWikiHoldoutValidation(s, gate, rows);
const runs = (original, candidate, repeats = 5) => Array.from({ length: repeats }, (_, i) => ['original', 'candidate'].map(variant => ({ variant, iteration: i + 1, status: i < (variant === 'original' ? original : candidate) ? 'pass' : 'fail' }))).flat();
const results = (s, counts = [5, 5]) => s.caseIds.map(caseId => ({ caseId, status: 'completed', runs: runs(...counts, s.policy.repeats) }));
const rehash = v => { const { hash: old, ...payload } = v; v.hash = hash(payload); return v; };
test('selects at most one confirmed control per other approved mode, run first then cheapest historical whole output; never uses target or all holdouts', () => {
  const h = setup(), before = JSON.stringify(h.input()), s = select(h);
  assert.equal(s.kind, 'wiki-holdout-validation-selection-v1');
  assert.deepEqual(s.caseIds, [h.marked[1].id, h.marked[2].id, h.marked[4].id]);
  assert.deepEqual(s.otherEntryIds, ['entry-1', 'entry-2', 'entry-3', 'entry-4']);
  assert.deepEqual(s.uncovered, [{ entryId: 'entry-4', reason: 'no-confirmed-control' }]);
  assert.equal(s.cases[0].level, 'run'); assert.equal(s.cases[0].tokensPerExecution, 300);
  assert.equal(s.estimatedTokens, (300 + 100 + 50) * 15, 'includes two arms and five replacement allowances');
  assert.equal(s.budgetStatus, 'ready'); assert.equal(s.policy.repeats, 5); assert.equal(s.policy.degradationThreshold, 2); assert.equal(s.policy.maxEstimatedTokens, 20000000);
  assert.deepEqual(api().validateWikiHoldoutValidationSelection(s), s); assert.equal(JSON.stringify(h.input()), before);
});
test('only a current exact confirmation is usable; stale, eligible-only, own mode and no-control modes never get substitute holdouts', () => {
  const h = setup(); h.state.controlConfirmations = h.state.controlConfirmations.filter(c => c.caseId !== h.marked[4].id);
  h.save(19, ['fail', 'fail', 'pass'], { createdAt: '2026-11-11T00:00:02.000Z' });
  const s = select(h); assert.equal(s.cases.find(c => c.entryId === 'entry-2').caseId, h.marked[3].id);
  assert.deepEqual(s.uncovered.map(r => r.entryId), ['entry-3', 'entry-4']);
  assert.ok(!s.caseIds.some(id => [h.marked[4].id, h.marked[5].id, h.marked[6].id, h.marked[7].id].includes(id)));
});
test('same-level equal costs use seeded hashes and are stable under input reordering', () => {
  const h = setup(); h.history.find(r => r.caseId === h.marked[3].id).totalTokens = 300;
  const s = select(h); h.state.cases.reverse(); h.history.reverse(); h.state.controlConfirmations.reverse();
  assert.deepEqual(select(h), s);
  const ids = h.marked.slice(2, 4).map(c => c.id).sort((a, b) => hash({ seed: s.seed, caseId: a }).localeCompare(hash({ seed: s.seed, caseId: b })));
  assert.equal(s.cases.find(c => c.entryId === 'entry-2').caseId, ids[0]);
});
test('unknown/stale usage is not zero-cost and blocks execution even when a confirmed run is preferred', () => {
  const h = setup(); h.history.find(r => r.caseId === h.marked[1].id).caseHash = hash('stale output identity');
  const s = select(h); assert.equal(s.cases[0].caseId, h.marked[1].id); assert.equal(s.cases[0].tokensPerExecution, null);
  assert.equal(s.estimatedTokens, null); assert.equal(s.budgetStatus, 'usage-unknown');
  const d = decide(s, 'accepted'); assert.equal(d.outcome, 'indeterminate'); assert.equal(d.adoptionEligible, false);
  assert.throws(() => decide(s, 'accepted', results(s)), /wiki_holdout_validation_result_invalid/);
});
test('budget equality is allowed, exceeding stops without silently skipping or substituting; operator skip is explicit uncovered coverage', () => {
  const h = setup(), full = select(h);
  const equal = api().planWikiHoldoutValidation({ ...h.input(), policy: { maxEstimatedTokens: full.estimatedTokens } }); assert.equal(equal.budgetStatus, 'ready');
  const over = api().planWikiHoldoutValidation({ ...h.input(), policy: { maxEstimatedTokens: full.estimatedTokens - 1 } });
  assert.equal(over.budgetStatus, 'over-limit'); assert.deepEqual(over.caseIds, full.caseIds); assert.equal(decide(over, 'accepted').adoptionEligible, false);
  assert.throws(() => decide(over, 'accepted', results(over)), /wiki_holdout_validation_result_invalid/);
  const skipped = api().planWikiHoldoutValidation({ ...h.input(), policy: { maxEstimatedTokens: full.estimatedTokens - 1 }, skippedCaseIds: [full.caseIds[0]] });
  assert.equal(skipped.budgetStatus, 'ready'); assert.equal(skipped.cases[0].skipped, true);
  assert.equal(skipped.caseIds.includes(full.caseIds[0]), false);
  assert.ok(skipped.uncovered.some(r => r.entryId === 'entry-1' && r.reason === 'operator-skipped'));
  assert.throws(() => api().planWikiHoldoutValidation({ ...h.input(), skippedCaseIds: [h.marked[0].id] }), /wiki_holdout_validation_selection_invalid/);
});
for (const gate of ['rejected', 'indeterminate']) test(`gate ${gate} cannot execute validation or adopt`, () => {
  const s = select(setup()), d = decide(s, gate); assert.equal(d.validation.status, 'not-run'); assert.equal(d.adoptionEligible, false);
  assert.equal(d.outcome, gate === 'rejected' ? 'gate-rejected' : 'indeterminate');
  assert.throws(() => decide(s, gate, results(s)), /wiki_holdout_validation_result_invalid/);
});
for (const [counts, expected] of [[[5, 5], false], [[5, 4], false], [[5, 3], true], [[3, 5], false]]) test(`per-case loss ${counts.join('→')} uses a two-pass threshold, not pooled compensation`, () => {
  const s = select(setup()), d = decide(s, 'accepted', results(s, counts));
  assert.equal(d.validation.cases[0].degraded, expected); assert.equal(d.adoptionEligible, !expected);
  assert.equal(d.outcome, expected ? 'validation-degraded' : 'validation-partial-coverage');
});
test('any completed case degradation rejects even when other controls gain more passes or another control is not run', () => {
  const s = select(setup()), rows = results(s, [0, 5]); rows[0].runs = runs(5, 3);
  for (const missing of [false, true]) {
    const copy = structuredClone(rows); if (missing) copy[1] = { caseId: s.caseIds[1], status: 'not-run', runs: [] };
    const d = decide(s, 'accepted', copy); assert.equal(d.outcome, 'validation-degraded'); assert.equal(d.adoptionEligible, false);
  }
});
test('repeat count and degradation threshold are configurable and bound into the selection hash', () => {
  const h = setup(), s = api().planWikiHoldoutValidation({ ...h.input(), policy: { repeats: 3, degradationThreshold: 1 } });
  assert.equal(s.policy.repeats, 3); assert.equal(s.policy.degradationThreshold, 1);
  assert.equal(decide(s, 'accepted', results(s, [3, 2])).outcome, 'validation-degraded');
  assert.notEqual(s.hash, select(h).hash);
});
test('five final coverage outcomes distinguish gate rejection, full validation, degradation, full and partial uncovered', () => {
  const h = setup(), partial = select(h);
  assert.equal(decide(partial, 'rejected').outcome, 'gate-rejected');
  assert.equal(decide(partial, 'accepted', results(partial, [5, 3])).outcome, 'validation-degraded');
  assert.equal(decide(partial, 'accepted', results(partial)).outcome, 'validation-partial-coverage');
  h.state.versions[0].entries = h.state.versions[0].entries.filter(e => e.id !== 'entry-4'); const full = select(h);
  assert.equal(decide(full, 'accepted', results(full)).outcome, 'validation-passed');
  h.state.controlConfirmations = []; const none = select(h), d = decide(none, 'accepted');
  assert.equal(d.outcome, 'validation-uncovered'); assert.equal(d.adoptionEligible, true); assert.equal(d.validation.cases.length, 0);
  assert.deepEqual(d.validation.uncovered.map(r => r.entryId), none.otherEntryIds);
});
test('missing, incomplete and terminal judge errors are indeterminate, not a clean no-degradation verdict', () => {
  const s = select(setup());
  for (const status of ['not-run', 'unsupported', 'error']) { const rows = results(s); rows[0] = { caseId: s.caseIds[0], status, runs: [] }; assert.equal(decide(s, 'accepted', rows).outcome, 'indeterminate'); }
  assert.equal(decide(s, 'accepted', results(s).slice(1)).outcome, 'indeterminate');
  const rows = results(s); rows[0].runs[0] = { variant: 'original', iteration: 1, status: 'error', judgeError: true }; rows[0].status = 'error';
  const d = decide(s, 'accepted', rows); assert.equal(d.outcome, 'indeterminate'); assert.equal(d.validation.cases[0].original.total, 4);
});
test('alternating invalid/environment replacements remain outside denominators and report run/trace separately', () => {
  const s = select(setup()), rows = results(s), extra = [{ variant: 'original', iteration: 1, status: 'invalid' }, { variant: 'candidate', iteration: 1, status: 'error' }];
  rows[0].runs.forEach(r => r.iteration++); rows[0].runs.unshift(...extra);
  const d = decide(s, 'accepted', rows); assert.equal(d.adoptionEligible, true);
  assert.equal(d.validation.byLevel.run.original.invalid, 1); assert.equal(d.validation.byLevel.run.candidate.errors, 1);
  assert.equal(d.validation.byLevel.trace.original.total, 10); assert.equal(d.validation.byLevel.run.original.total, 5);
});
test('counts, schedules, unknown or duplicated cases, caps and extra fields are closed even with superficially good pass totals', () => {
  const s = select(setup());
  for (const change of [r => r.push(r[0]), r => r[0].caseId = 'unknown', r => r[0].runs.reverse(), r => r[0].runs[0].iteration = 2,
    r => r[0].runs[0].judgeError = false, r => r[0].runs[0].status = 'unknown', r => r[0].extra = true,
    r => r[0].runs.push({ variant: 'original', iteration: 6, status: 'pass' }), r => { r[0].status = 'error'; r[0].runs = Array.from({ length: 6 }, (_, i) => ({ variant: i % 2 ? 'candidate' : 'original', iteration: Math.floor(i / 2) + 1, status: 'invalid' })); }]) {
    const rows = results(s); change(rows); assert.throws(() => decide(s, 'accepted', rows), /wiki_holdout_validation_result_invalid/);
  }
});
test('selection hash binds exact control/precheck, usage, policy, seed and operator skip; malformed rehashed proofs fail closed', () => {
  const s = select(setup());
  for (const change of [v => v.hash = hash('wrong'), v => v.extra = true, v => v.caseIds.reverse(), v => v.cases[0].entryId = v.targetEntryId,
    v => v.cases[0].precheck.resultHash = [], v => v.cases[0].controlHash = 'not-hash', v => v.estimatedTokens++, v => v.budgetStatus = 'over-limit',
    v => v.uncovered = [], v => v.cases[0].skipped = true, v => v.policy.repeats = 0]) {
    const v = structuredClone(s); change(v); if (v.hash !== hash('wrong')) rehash(v);
    assert.throws(() => api().validateWikiHoldoutValidationSelection(v), /wiki_holdout_validation_selection_invalid/);
  }
});
test('invalid policy, history, duplicate identities, skipped ids or target are rejected before producing a plan', () => {
  const h = setup();
  for (const patch of [{ seed: '' }, { targetEntryId: 'missing' }, { policy: null }, { skippedCaseIds: null }, { policy: { repeats: 0 } }, { policy: { repeats: 21 } }, { policy: { degradationThreshold: 0 } },
    { policy: { degradationThreshold: 6 } }, { policy: { maxEstimatedTokens: -1 } }, { policy: { unknown: true } }, { history: [...h.history, h.history[0]] },
    { history: [{ ...h.history[0], totalTokens: NaN }] }, { history: [{ ...h.history[0], executions: 0 }] },
    { history: [{ ...h.history[0], totalTokens: Number.MAX_SAFE_INTEGER, executions: 1 }] }, { skippedCaseIds: ['unknown'] }]) {
    assert.throws(() => api().planWikiHoldoutValidation({ ...h.input(), ...patch }), /wiki_holdout_validation_selection_invalid/);
  }
});
