// Trusted offline runner integration, not an HTTP/agent tool or a paid launcher.
// Paths/materials and the dedicated restored daemon capability are supplied only
// by the trusted operator. Never creates approvals or substitutes a new plan.
const assert = require('node:assert/strict');
const { createEvaluationAdminService, evaluationAdminRecordRoot } = require('../../build/server/domain/runtime/badcase-capture/evaluation-admin');
const { dispatchRecordedEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-record');
const { prepareScriptedEvaluation } = require('./scripted-evaluation.cjs');
const copy = v => JSON.parse(JSON.stringify(v));
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function fresh(report) {
  assert.equal(report.consumed, false, 'evaluation_already_consumed');
  const at = Date.now();
  assert.ok(Number.isSafeInteger(at) && at >= report.recordedAt && at < report.approval.expiresAt, 'evaluation_approval_stale');
}
async function dispatchApprovedScriptedEvaluation(value, runProbe) {
  assert.ok(exact(value, ['root', 'projectId', 'approvalId', 'request', 'image', 'sources', 'roles', 'rule']), 'evaluation_runner_invalid');
  assert.equal(typeof runProbe, 'function', 'dedicated_transport_required');
  const q = copy(value), service = createEvaluationAdminService({ root: q.root });
  // read() also refuses persisted non-offline records. Approval/scope/expiry are
  // checked before any preparation pins; missing records are never synthesized.
  const approved = service.read(q.projectId, q.approvalId).report;
  fresh(approved);
  assert.equal(q.request?.association?.projectId, q.projectId, 'evaluation_project_mismatch');
  assert.equal(q.request?.flagId, approved.ledger.spec.caseId, 'evaluation_case_mismatch');
  const prepared = prepareScriptedEvaluation(q.request, q.image, q.sources, q.roles, q.rule, approved.ledger.spec.repetitions);
  // Whole-spec equality as well as hash, not a subset of caller declarations.
  // Preparation can retain its pin on failure; nothing unpins or authorizes GC.
  assert.deepEqual(prepared.plan.spec, approved.ledger.spec, 'evaluation_material_mismatch');
  assert.equal(prepared.plan.planHash, approved.approval.planHash, 'evaluation_material_mismatch');
  const current = service.read(q.projectId, q.approvalId).report;
  assert.deepEqual(current, approved, 'evaluation_approval_changed');
  fresh(current); // archive reads may have outlived the approval
  await dispatchRecordedEvaluation(evaluationAdminRecordRoot(q.root, q.projectId), q.approvalId, r => {
    // Rebind the coordinator's reloaded request before any container call. This
    // is not an atomic defense against malicious same-user file replacements.
    assert.equal(r.approvalId, approved.approval.approvalId);
    assert.equal(r.planHash, approved.approval.planHash);
    assert.equal(r.expiresAt, approved.approval.expiresAt);
    return prepared.execute(r, runProbe);
  });
  // Same projection as HTTP GET; completion doesn't upgrade material/strict
  // qualifications or expose stdout. Permanent claim prevents repeat dispatch.
  return service.read(q.projectId, q.approvalId);
}
module.exports = { dispatchApprovedScriptedEvaluation };
