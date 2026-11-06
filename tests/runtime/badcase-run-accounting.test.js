const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createWikiRunStore, projectWikiRunAccounting: project } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store');
const { wikiRunHash: hash } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-replay');
const row = (id, status, extra = {}) => ({ id, caseId: 'c', traceHash: 'trace', decisionHash: 'decision', variant: { kind: 'original' }, status, ...extra });
test('legacy invalid runs are projected without changing immutable packets, hashes or Wiki state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-run-accounting-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = createWikiRunStore({ globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') });
  const r = runs.reserve({ schemaVersion: 1, kind: 'wikiskill-run-request', variant: { kind: 'original' }, metadata: { caseId: 'c', traceHash: 'trace', decisionHash: 'decision' } });
  const result = runs.finish(r.id, { outcome: { status: 'unreached', countAsFailure: true, reason: 'other_tool_requested' }, message: { content: [{ type: 'toolCall', name: 'read', arguments: { path: 'file' } }] }, modelCalls: 1, toolExecutions: 0 });
  const file = path.join(root, 'wiki/run-replays', r.id + '.result.json'), before = fs.readFileSync(file);
  const list = runs.list(), [current] = project(list);
  assert.equal(list[0].status, 'invalid'); assert.equal(current.status, 'invalid'); assert.equal(Object.hasOwn(current, 'countAsFailure'), false);
  assert.equal(current.eligibleForScoring, false); assert.equal(current.baselineStatus, 'no_valid_output'); assert.equal(current.caseEligibleForGateAndScreen, false);
  assert.equal(current.resultHash, hash(result)); assert.deepEqual(runs.read(r.id).result, result); assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(project(project(list)), project(list));
});
test('baseline validity is scoped to exact case/trace/decision and excludes invalid attempts, errors, unknowns and user withdrawals', () => {
  const rows = [row('1', 'unreached', { countAsFailure: true }), row('2', 'reached', { variant: { kind: 'candidate', id: 'candidate' } }),
    row('3', 'reached', { caseId: 'other' }), row('4', 'reached', { traceHash: 'old-trace' }), row('5', 'reached', { decisionHash: 'old-decision' })];
  const before = structuredClone(rows), p = project(rows);
  for (const r of p.slice(0, 2)) { assert.equal(r.baselineStatus, 'no_valid_output'); assert.equal(r.caseEligibleForGateAndScreen, false); }
  assert.equal(p[0].eligibleForScoring, false); assert.equal(p[1].eligibleForScoring, true); assert.deepEqual(rows, before);
  const withValid = project([...rows, row('6', 'reached')]);
  assert.equal(withValid[0].caseEligibleForGateAndScreen, true); assert.equal(withValid[0].eligibleForScoring, false); // invalid attempt still never scored
  assert.equal(withValid[1].caseEligibleForGateAndScreen, true);
  for (const status of ['error', 'reserved']) { const [r] = project([row('1', status)]); assert.equal(r.eligibleForScoring, false); assert.equal(r.caseEligibleForGateAndScreen, false); }
  const withdrawn = project([row('1', 'reached')], [{ caseId: 'c', traceHash: 'trace', decision: { level: 'reference', hash: 'new', supersedesDecisionHash: 'decision' } }])[0];
  assert.equal(withdrawn.excludedReason, 'user_reclassified_reference'); assert.equal(withdrawn.eligibleForScoring, false); assert.equal(withdrawn.caseEligibleForGateAndScreen, false);
});
