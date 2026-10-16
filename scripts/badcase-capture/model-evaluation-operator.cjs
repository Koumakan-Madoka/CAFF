// Explicit local operator entry. No production/agent/HTTP start route.
// Review does not start a model. Run requires a separate --confirm-paid action,
// an unexpired reviewed plan and a dedicated key supplied in the named variable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { readRegistry, startModelReviewServer } = require('./model-review-server.cjs');
const { selectSealedMaterials } = require('./sealed-workbench.cjs');
const { prepareModelEvaluation } = require('./model-evaluation.cjs');
const { restoreImageArchive } = require('./image-recovery.cjs');
const { createModelReviewService } = require('../../build/server/domain/runtime/badcase-capture/model-review');
const { readBoundModelApproval, dispatchBoundModelEvaluation } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
function loadOperatorConfig(file) {
  const c = readRegistry(file);
  assert.ok(exact(c, ['root', 'captureRoot', 'selection', 'image', 'imageArchive', 'sources', 'roles', 'rule', 'model', 'limits', 'target', 'productionResourcesExcluded']));
  assert.equal(c.productionResourcesExcluded, true);
  for (const name of ['root', 'captureRoot']) assert.ok(typeof c[name] === 'string' && path.isAbsolute(c[name]));
  assert.ok(exact(c.selection, ['id', 'projectId', 'conversationId', 'messageId']));
  for (const v of Object.values(c.selection)) assert.match(v, /^[A-Za-z0-9_-]{1,128}$/);
  return c;
}
function prepareOperator(c) {
  const [material] = selectSealedMaterials({ captureRoot: c.captureRoot, selections: [c.selection], image: c.image,
    sources: c.sources, roles: c.roles, rule: c.rule });
  const prepared = prepareModelEvaluation(material.request, c.image, c.sources, c.roles, c.rule, c.model, c.limits);
  return { prepared, entries: [{ projectId: c.selection.projectId, id: c.selection.id, spec: prepared.plan.spec, config: c.model }] };
}
function readOperatorReport(c, approvalId) {
  return createModelReviewService({ root: c.root, entries: [] }).read(c.selection.projectId, approvalId);
}
async function runOperator(c, approvalId, confirmed, credential) {
  assert.equal(confirmed, true); assert.equal(typeof credential, 'function');
  const { prepared } = prepareOperator(c), saved = readOperatorReport(c, approvalId);
  assert.equal(saved.report.ledger.planHash, prepared.plan.planHash);
  assert.deepEqual(saved.binding, prepared.review.binding);
  assert.ok(Date.now() < saved.report.approval.expiresAt);
  assert.equal(saved.report.dispatchState, 'approved');
  const scope = path.join(c.root, hash(c.selection.projectId));
  // Separate launch attestation, not a reinterpretation of the review-only UI.
  // No credentials or raw task text are written here. Original claim remains the
  // once-only execution authority and rejects retries after partial execution.
  const intent = { kind: 'explicit-local-paid-launch-v1', approvalId, planHash: prepared.plan.planHash,
    bindingHash: saved.binding.bindingHash, confirmed: true, at: Date.now(), expiresAt: saved.report.approval.expiresAt };
  const file = path.join(scope, 'launch-' + hash(approvalId) + '.json');
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(intent)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(intent));
  // Only a dedicated empty daemon and trusted archived image can be restored.
  // This composition never spawns dockerd, pulls images or touches shared state.
  const restored = await restoreImageArchive(c.imageArchive, c.target);
  const reread = readBoundModelApproval(scope, approvalId);
  assert.deepEqual(reread.binding, saved.binding); assert.equal(reread.report.ledger.planHash, prepared.plan.planHash);
  assert.ok(Date.now() < reread.report.approval.expiresAt);
  return dispatchBoundModelEvaluation(scope, approvalId,
    (run, send) => prepared.execute(scope, run, send, restored.runProbe), credential);
}
async function main(args) {
  assert.ok(args.length >= 3 && args[0] === '--config');
  const c = loadOperatorConfig(args[1]);
  if (args.length === 3 && args[2] === '--review') {
    const { entries } = prepareOperator(c);
    const server = await startModelReviewServer({ root: c.root, entries });
    console.log(JSON.stringify({ url: server.url, mode: 'retained-model-review', paidAuthorization: false, launchAvailable: false }));
    let closing = false;
    const close = () => { if (!closing) { closing = true; server.close().catch(() => { process.exitCode = 1; }); } };
    process.once('SIGTERM', close); process.once('SIGINT', close); return;
  }
  if (args.length === 4 && args[2] === '--report') { console.log(JSON.stringify(readOperatorReport(c, args[3]))); return; }
  assert.ok(args.length === 5 && args[2] === '--run' && args[4] === '--confirm-paid');
  // Dedicated opt-in only. Never read OPENAI_API_KEY, auth.json, production DB or
  // CAFF's provider store. Operator provisions this evaluation-only credential.
  const key = process.env.CAFF_EVALUATION_MODEL_KEY;
  assert.ok(typeof key === 'string' && /^[A-Za-z0-9._~+\/-]{1,4096}={0,2}$/.test(key));
  delete process.env.CAFF_EVALUATION_MODEL_KEY;
  const report = await runOperator(c, args[3], true, () => ({ value: key, expiresAt: Date.now() + 30000 }));
  console.log(JSON.stringify(report));
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { console.error('model_evaluation_operator_failed'); process.exitCode = 1; });
module.exports = { loadOperatorConfig, prepareOperator, readOperatorReport, runOperator };
