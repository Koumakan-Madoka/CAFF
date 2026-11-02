const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createEvaluationAdminService } = require('../../build/server/domain/runtime/badcase-capture/evaluation-admin');
const { dispatchRecordedEvaluation, recordEvaluationApproval } = require('../../build/server/domain/runtime/badcase-capture/evaluation-record');
const { spec, hash } = require('../helpers/badcase-offline-spec.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-evaluation-admin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, service: createEvaluationAdminService({ root }) };
}
const approve = p => ({ confirmed: true, approvalId: p.approvalId, planHash: p.plan.planHash });
test('preview is memory-only; confirm binds plan and persists without dispatch; restart can query', t => {
  const { root, service } = setup(t), s = spec(), p = service.preview('p1', { spec: s });
  assert.deepEqual(fs.readdirSync(root), []); s.caseId = 'mutated'; p.plan.spec.caseId = 'mutated-too';
  const r = service.approve('p1', approve(p));
  assert.equal(r.report.ledger.spec.caseId, 'case-1'); assert.equal(r.report.consumed, false);
  assert.equal(r.report.ledger.runs.length, 0); assert.equal(r.launchAvailable, false); assert.equal(r.paidAuthorization, false);
  assert.deepEqual(service.approve('p1', approve(p)), r);
  const restarted = createEvaluationAdminService({ root });
  assert.deepEqual(restarted.read('p1', p.approvalId), r);
  assert.throws(() => restarted.approve('p1', approve(p)), /evaluation_preview_stale/);
  assert.throws(() => restarted.read('p2', p.approvalId), /evaluation_record_invalid/);
});
test('confirmation, scope, hash and key set cannot be substituted', t => {
  const { root, service } = setup(t), p = service.preview('p1', { spec: spec() });
  for (const b of [{ ...approve(p), confirmed: false }, { ...approve(p), planHash: hash('other') }, { ...approve(p), spec: spec() }, { ...approve(p), expiresAt: Date.now() + 99e6 }, { 'confirmed|approvalId': true, planHash: p.plan.planHash }]) {
    assert.throws(() => service.approve('p1', b));
  }
  assert.throws(() => service.approve('p2', approve(p)), /evaluation_preview_stale/);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('expiry and backwards time refuse approval without writes', t => {
  const { root, service } = setup(t), clock = Date.now, p = service.preview('p1', { spec: spec() });
  t.after(() => { Date.now = clock; });
  Date.now = () => p.expiresAt;
  assert.throws(() => service.approve('p1', approve(p)), /evaluation_preview_stale/);
  Date.now = () => 0;
  assert.throws(() => service.approve('p1', approve(p)), /evaluation_preview_stale/);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('only fixed offline profile accepted; no credentials, paths or provider override', t => {
  const { root, service } = setup(t);
  for (const change of [{ model: { ...spec().model, provider: 'paid-provider' } }, { roleId: 'real-role' }, { timeoutMs: 10 }, { perRunLimitMicroUsd: 100 }, { totalLimitMicroUsd: 99 }, { evaluator: { ...spec().evaluator, id: 'shell' } }, { captureRoot: '/host' }]) {
    assert.throws(() => service.preview('p1', { spec: { ...spec(), ...change } }));
  }
  assert.throws(() => service.preview('p1', { spec: { ...spec(), caseId: 'ghp_syntheticSentinelOnly' } }), /evaluation_offline_only/);
  assert.throws(() => service.preview('../p', { spec: spec() }));
  assert.throws(() => service.preview('p1', { spec: spec(), execute: 'anything' }));
  assert.deepEqual(fs.readdirSync(root), []);
});
test('bounded outstanding previews do not evict a still valid confirmation', t => {
  const { service } = setup(t), first = service.preview('p1', { spec: spec() });
  for (let i = 1; i < 64; i++) service.preview('p1', { spec: spec() });
  assert.throws(() => service.preview('p1', { spec: spec() }), /evaluation_preview_busy/);
  assert.equal(service.approve('p1', approve(first)).report.dispatchState, 'approved');
});
test('corrupt or missing record is an error and GET never creates directories', t => {
  const { root, service } = setup(t), p = service.preview('p1', { spec: spec() });
  assert.throws(() => service.read('p1', p.approvalId), /evaluation_record_invalid/);
  assert.deepEqual(fs.readdirSync(root), []);
  service.approve('p1', approve(p));
  const file = path.join(root, hash('p1'), 'evaluations', hash(p.approvalId), 'approval.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => service.read('p1', p.approvalId), /evaluation_record_invalid/);
  assert.throws(() => service.approve('p1', approve(p)), /evaluation_record_invalid/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('failed fsync is not acknowledged; retained partial approval is never overwritten', t => {
  const { root, service } = setup(t), p = service.preview('p1', { spec: spec() }), sync = fs.fsyncSync;
  t.after(() => { fs.fsyncSync = sync; });
  fs.fsyncSync = () => { throw Error('synthetic-disk-failure'); };
  assert.throws(() => service.approve('p1', approve(p)), /evaluation_record_write_failed/);
  fs.fsyncSync = sync;
  // Write may exist despite failed acknowledgement; query reports it, not a run.
  assert.equal(service.read('p1', p.approvalId).report.consumed, false);
  assert.equal(fs.readdirSync(path.join(root, hash('p1'), 'evaluations')).length, 1);
});
test('own project directory symlinks cannot redirect approvals into another scope', t => {
  const { root, service } = setup(t), target = path.join(root, 'target'), p = service.preview('p1', { spec: spec() });
  fs.mkdirSync(target);
  try { fs.symlinkSync(target, path.join(root, hash('p1')), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('link privilege unavailable'); return; } throw e; }
  assert.throws(() => service.approve('p1', approve(p)), /evaluation_record_invalid/);
  assert.deepEqual(fs.readdirSync(target), []);
});
test('persisted non-offline record cannot be projected as an offline declaration', t => {
  const { root, service } = setup(t), approvalId = '11111111-1111-4111-8111-111111111111';
  const s = { ...spec(), model: { ...spec().model, provider: 'paid-provider' } };
  const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
  const plan = planEvaluation(s);
  recordEvaluationApproval(path.join(root, hash('p1')), s, { confirmed: true, approvalId,
    planHash: plan.planHash, expiresAt: Date.now() + 120000 });
  assert.throws(() => service.read('p1', approvalId), /evaluation_record_invalid/);
});
test('report shows injected internal results and unknown reservations, not zero-cost success', async t => {
  const { root, service } = setup(t), p = service.preview('p1', { spec: spec() });
  service.approve('p1', approve(p));
  // Trusted offline coordinator only. The HTTP service has no dispatch method.
  const recordRoot = path.join(root, hash('p1'));
  await dispatchRecordedEvaluation(recordRoot, p.approvalId, async r => ({ runId: r.runId, status: 'failed', costMicroUsd: null, outputHash: null, score: null }));
  const r = service.read('p1', p.approvalId);
  assert.equal(r.report.ledger.unknownCostRuns, 1); assert.equal(r.report.ledger.runs[0].costMicroUsd, null);
  assert.equal(r.report.ledger.summary.baseline.scored, 0); assert.equal(r.report.ledger.strictEvalEligible, false);
  assert.equal(service.dispatch, undefined);
});
