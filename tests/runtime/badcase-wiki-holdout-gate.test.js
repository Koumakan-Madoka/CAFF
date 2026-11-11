const test = require('node:test'), assert = require('node:assert/strict');
const base = '../../build/server/domain/runtime/badcase-capture/';
const fixture = require('../helpers/wiki-mode-holdout.cjs');
const api = () => require(base + 'wiki-holdout-gate');
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
const select = h => api().planWikiHoldoutGate(h.input());
const runs = (original, candidate) => Array.from({ length: 10 }, (_, i) => ['original', 'candidate'].map(variant => ({ variant, iteration: i + 1,
  status: i < (variant === 'original' ? original : candidate) ? 'pass' : 'fail' }))).flat();
const results = (selection, counts = [[0, 6], [0, 0]]) => selection.caseIds.map((caseId, i) => ({ caseId, status: 'completed', runs: runs(...counts[i % counts.length]) }));
const decide = (selection, rows) => api().decideWikiHoldoutGate(selection, rows);
const rehash = value => { const { hash: old, ...payload } = value; value.hash = hash(payload); return value; };
test('mode 6 pools #23 gate and #24 test, never #22 training or another mode; frozen groups and inputs stay byte-identical', () => {
  const h = fixture(), before = JSON.stringify(h.input()), s = select(h);
  const display = require(base + 'wiki-suite').wikiDisplayCases(h.state.cases);
  assert.equal(display.find(c => c.id === h.marked[5].id).displayNumber, 22);
  assert.equal(display.find(c => c.id === h.marked[6].id).displayNumber, 23);
  assert.equal(display.find(c => c.id === h.marked[7].id).displayNumber, 24);
  assert.deepEqual(s.caseIds, [h.marked[6].id, h.marked[7].id].sort());
  assert.deepEqual(s.cases.map(c => c.originalSplit).sort(), ['gate', 'test']);
  assert.deepEqual(s.cases.map(c => c.level).sort(), ['run', 'trace']);
  assert.ok(s.cases.every(c => c.eligible && c.reason === null && c.precheck.resultHash));
  assert.equal(JSON.stringify(h.input()), before);
  assert.deepEqual(api().validateWikiHoldoutGateSelection(s), s);
});
test('#19/#20-style 0→6 plus 0→0 passes pooled one-sided Fisher without any per-case success or no-harm requirement', () => {
  const s = select(fixture()), d = decide(s, results(s));
  assert.equal(d.outcome, 'accepted'); assert.equal(d.repair.passed, true);
  assert.equal(d.repair.original.total, 20); assert.equal(d.repair.original.passed, 0);
  assert.equal(d.repair.candidate.total, 20); assert.equal(d.repair.candidate.passed, 6);
  const choose = (n, k) => Array.from({ length: k }, (_, i) => (n - i) / (i + 1)).reduce((a, b) => a * b, 1);
  assert.ok(Math.abs(d.repair.pValue - choose(20, 6) / choose(40, 6)) < 1e-12);
  assert.equal(Object.hasOwn(d, 'noHarm'), false); assert.equal(d.warnings.length, 0);
  assert.equal(d.byLevel.trace.original.failed, 10); assert.equal(d.byLevel.run.original.failed, 10);
});
test('pooled improvement does not run a per-case degradation check inside the gate', () => {
  const s = select(fixture()), d = decide(s, results(s, [[0, 10], [4, 0]]));
  assert.equal(d.outcome, 'accepted'); assert.equal(d.repair.original.passed, 4); assert.equal(d.repair.candidate.passed, 10);
});
for (const [original, candidate, expected] of [[0, 3, 'rejected'], [0, 4, 'accepted'], [0, 6, 'accepted'], [5, 5, 'rejected'], [8, 2, 'rejected']]) test(`gate requires Fisher < .05 AND more candidate passes (${original}→${candidate})`, () => {
  const h = fixture(); h.state.cases.find(c => c.id === h.marked[7].id).split = 'train';
  const s = select(h), d = decide(s, results(s, [[original, candidate]]));
  assert.equal(d.outcome, expected); assert.deepEqual(d.warnings, ['只有 1 道门槛题']);
});
test('a single run holdout can pass without trace quota or a separate test/control stage', () => {
  const h = fixture(); h.state.cases.find(c => c.id === h.marked[6].id).split = 'train';
  const s = select(h), d = decide(s, results(s, [[0, 6]]));
  assert.equal(s.caseIds.length, 1); assert.equal(s.cases[0].originalSplit, 'test');
  assert.equal(d.outcome, 'accepted'); assert.deepEqual(d.byLevel.trace.caseIds, []);
  assert.deepEqual(d.byLevel.run.caseIds, s.caseIds);
});
test('non-reproduced same-mode holdouts stay listed but are excluded from results and every denominator', () => {
  const h = fixture(); h.save(24, ['pass', 'pass', 'pass', 'pass', 'pass'], { createdAt: '2026-11-11T00:00:01.000Z' });
  const s = select(h), row = s.cases.find(c => c.caseId === h.marked[7].id);
  assert.equal(s.cases.length, 2); assert.equal(s.caseIds.length, 1);
  assert.equal(row.eligible, false); assert.equal(row.reason, 'precheck_not_reproduced');
  const d = decide(s, results(s)); assert.deepEqual(d.ignoredCaseIds, [row.caseId]);
  assert.equal(d.repair.original.total, 10); assert.equal(d.byLevel.run.original.total, 0);
  assert.throws(() => decide(s, [...results(s), { caseId: row.caseId, status: 'completed', runs: runs(0, 10) }]), /wiki_holdout_gate_result_invalid/);
});
for (const change of ['missing', 'reserved', 'stopped', 'tie', 'scene', 'rubric', 'support']) test(`only current trusted reproduced prechecks qualify (${change})`, () => {
  const h = fixture(), c = h.marked[6], time = '2026-11-11T00:00:01.000Z';
  if (change === 'missing') h.records.splice(0, h.records.length, ...h.records.filter(r => r.reservation.plan.caseId !== c.id));
  if (change === 'reserved') h.save(23, undefined, { reserve: true, createdAt: time });
  if (change === 'stopped') h.save(23, [], { status: 'stopped', createdAt: time });
  if (change === 'tie') h.save(23, ['fail', 'pass'], { createdAt: time });
  if (change === 'scene') h.state.replayCases.find(r => r.sourceCaseId === c.id).checkpointHash = hash('changed scene');
  if (change === 'rubric') h.state.rubrics.find(r => r.caseId === c.id).status = 'draft';
  if (change === 'support') h.replayChecks.splice(0, h.replayChecks.length, ...h.replayChecks.filter(r => r.caseId !== c.id));
  const s = select(h), row = s.cases.find(r => r.caseId === c.id);
  assert.equal(row.eligible, false); assert.ok(row.reason); assert.equal(s.caseIds.includes(c.id), false);
});
test('non-GPT identity cannot qualify even when role looks like GPT; source id is authoritative', () => {
  const h = fixture(), c = h.marked[6]; c.source.agentId = 'role-family-deepseek'; c.role = 'GPT';
  const s = select(h), row = s.cases.find(r => r.caseId === c.id);
  assert.equal(row.eligible, false); assert.equal(row.reason, 'non_gpt_report_only');
});
test('unconfirmed or conflicting mode identity cannot be relabeled by caller selections', () => {
  const h = fixture(), c = h.marked[6]; h.state.patternLabels = h.state.patternLabels.filter(l => l.caseId !== c.id);
  assert.equal(select(h).cases.some(r => r.caseId === c.id), false);
  h.state.classifications.push({ caseId: c.id, entryId: 'entry-1', source: 'manual', confirmedAt: '2026-11-11T00:00:00.000Z' });
  assert.equal(select(h).cases.some(r => r.caseId === c.id), false);
  h.state.patternLabels.push({ caseId: c.id, entryId: 'entry-6', source: 'badcase-page', confirmedAt: '2026-11-11T00:00:00.000Z' });
  assert.throws(() => select(h), /wiki_classification_confirmation_required/);
});
test('no reproduced targets is indeterminate, not accepted; a different mode is never used to fill the gate', () => {
  const h = fixture(); h.state.patternLabels.filter(l => [h.marked[6].id, h.marked[7].id].includes(l.caseId)).forEach(l => l.entryId = 'entry-1');
  const s = select(h), d = decide(s, []); assert.deepEqual(s.cases, []); assert.equal(d.outcome, 'indeterminate'); assert.equal(d.repair.pValue, null);
});
test('invalid/environment replacements alternate, stay outside the denominator, and report trace/run separately', () => {
  const s = select(fixture()), rows = results(s), target = rows[0];
  const extra = [{ variant: 'original', iteration: 1, status: 'invalid' }, { variant: 'candidate', iteration: 1, status: 'error' }];
  target.runs.forEach(r => r.iteration++); target.runs.unshift(...extra);
  const d = decide(s, rows), level = s.cases.find(c => c.caseId === target.caseId).level;
  assert.equal(d.outcome, 'accepted'); assert.equal(d.repair.original.total, 20);
  assert.equal(d.byLevel[level].original.invalid, 1); assert.equal(d.byLevel[level].candidate.errors, 1);
});
test('incomplete valid counts and terminal judge errors cannot pass or trigger extra judge slots', () => {
  const s = select(fixture()), rows = results(s); rows[0].status = 'error';
  rows[0].runs[0] = { variant: 'original', iteration: 1, status: 'error', judgeError: true };
  const d = decide(s, rows); assert.equal(d.outcome, 'indeterminate'); assert.equal(d.repair.passed, false);
  assert.equal(d.repair.original.total, 19);
  rows[0].status = 'completed'; assert.throws(() => decide(s, rows), /wiki_holdout_gate_result_invalid/);
});
test('missing, unsupported or error case is indeterminate even when another case improves significantly', () => {
  const s = select(fixture());
  for (const status of ['not-run', 'unsupported', 'error']) {
    const rows = results(s, [[0, 10]]); rows[1] = { caseId: rows[1].caseId, status, runs: [] };
    assert.equal(decide(s, rows).outcome, 'indeterminate');
  }
  assert.equal(decide(s, results(s).slice(0, 1)).outcome, 'indeterminate');
});
test('result schema, alternating attempts, duplicate/unknown cases, replacement budget and valid caps fail closed', () => {
  const s = select(fixture());
  for (const mutate of [rows => rows.push(rows[0]), rows => rows[0].caseId = 'unknown', rows => rows[0].runs.reverse(),
    rows => rows[0].runs[0].iteration = 2, rows => rows[0].runs[0].judgeError = false, rows => rows[0].runs[0].status = 'unknown',
    rows => rows[0].runs.push({ variant: 'original', iteration: 11, status: 'pass' }), rows => rows[0].other = true,
    rows => { rows[0].status = 'error'; rows[0].runs = Array.from({ length: 6 }, (_, i) => ({ variant: i % 2 ? 'candidate' : 'original', iteration: Math.floor(i / 2) + 1, status: 'invalid' })); }]) {
    const rows = results(s); mutate(rows); assert.throws(() => decide(s, rows), /wiki_holdout_gate_result_invalid/);
  }
});
test('selection evidence is immutable and closed even if a same-user caller rehashes malformed fields', () => {
  const s = select(fixture());
  for (const mutate of [v => v.hash = hash('changed'), v => v.other = true, v => v.caseIds.reverse(), v => v.cases[0].originalSplit = 'train',
    v => v.cases[0].level = 'report', v => v.cases[0].eligible = false, v => v.cases[0].precheck.resultHash = [],
    v => v.cases[0].precheck.id = 'not-a-precheck', v => v.cases.push(v.cases[0]), v => v.targetEntryId = '',
    v => v.cases[0].caseHash = ['a'.repeat(64)], v => v.cases[0].reason = 'forged_reason']) {
    const v = structuredClone(s); mutate(v); if (v.hash !== hash('changed')) rehash(v);
    assert.throws(() => api().validateWikiHoldoutGateSelection(v), /wiki_holdout_gate_selection_invalid/);
  }
});
