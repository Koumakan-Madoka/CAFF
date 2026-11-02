// Explicit operator entry for NEW fresh Docker validation, NOT capture/replay.
// Review saves an immutable plan only; --run requires separate paid/nonproduction
// confirmations and an explicit existing models.json source. No default auth,
// automatic model call, daemon startup, production route or host-agent fallback.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { prepareSdkDockerValidation } = require('./sdk-docker-validation.cjs');
const { readRegistry, startModelReviewServer } = require('./model-review-server.cjs');
const { restoreImageArchive } = require('./image-recovery.cjs');
const { createAuthorizedModelCredential } = require('./authorized-model-auth.cjs');
const { createModelReviewService } = require('../../build/server/domain/runtime/badcase-capture/model-review');
const { readBoundModelApproval } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const copy = v => JSON.parse(JSON.stringify(v));
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
function configValue(value) {
  const c = copy(value);
  assert.ok(exact(c, ['root', 'projectId', 'caseId', 'input', 'roles', 'rule', 'model', 'limits', 'image', 'imageArchive', 'target', 'productionResourcesExcluded']));
  assert.equal(c.productionResourcesExcluded, true); assert.ok(typeof c.root === 'string' && path.isAbsolute(c.root));
  assert.match(c.projectId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.ok(exact(c.target, ['socket', 'daemonId', 'dataRoot']));
  assert.match(c.target.socket, /^unix:\/\/\/var\/tmp\/caff-image-recovery-[A-Za-z0-9_-]+\/docker\.sock$/);
  assert.equal(c.target.dataRoot, c.target.socket.slice(7, -'/docker.sock'.length) + '/data');
  assert.ok(typeof c.target.daemonId === 'string' && c.target.daemonId.length > 0);
  assert.match(c.imageArchive?.archiveHash, /^[a-f0-9]{64}$/);
  return c;
}
function loadSdkValidationConfig(file) { return configValue(readRegistry(file)); }
function prepareSdkValidationOperator(value) {
  const c = configValue(value), root = path.resolve(__dirname, '../..');
  const prepared = prepareSdkDockerValidation(root, root, c.image, { caseId: c.caseId, input: c.input, roles: c.roles,
    rule: c.rule, config: c.model, limits: c.limits });
  return { prepared, entries: [{ projectId: c.projectId, id: c.caseId, spec: prepared.plan.spec, config: c.model }] };
}
function readSdkValidationReport(c, approvalId) {
  return createModelReviewService({ root: c.root, entries: [] }).read(c.projectId, approvalId);
}
function fresh(saved, prepared) {
  assert.equal(saved.report.dispatchState, 'approved'); assert.equal(saved.report.consumed, false);
  assert.deepEqual(saved.report.ledger.spec, prepared.plan.spec);
  assert.equal(saved.report.ledger.planHash, prepared.plan.planHash);
  assert.ok(Date.now() < saved.report.approval.expiresAt);
}
async function runSdkValidationOperator(value, approvalId, confirmedPaid, sourceFile, confirmedNonProduction) {
  assert.equal(confirmedPaid, true); assert.equal(confirmedNonProduction, true);
  assert.ok(typeof sourceFile === 'string' && path.isAbsolute(sourceFile));
  const c = configValue(value), { prepared } = prepareSdkValidationOperator(c);
  const saved = readSdkValidationReport(c, approvalId); fresh(saved, prepared);
  assert.deepEqual(saved.binding.config, c.model);
  const source = createAuthorizedModelCredential({ file: sourceFile, provider: c.model.settings.provider, model: c.model.settings.model,
    endpoint: c.model.endpoint, confirmedNonProduction: true }); // declaration only; no source bytes read yet
  assert.equal(source.declaration.endpointHash, saved.binding.endpointHash);
  // Once-only durable launch attestation before image load or supplier/source
  // access. Failure leaves it in place; new work needs a new reviewed approval.
  const intent = { kind: 'explicit-fresh-sdk-validation-launch-v1', approvalId, confirmed: true,
    planHash: prepared.plan.planHash, bindingHash: saved.binding.bindingHash, launchHash: prepared.review.launchHash,
    imageArchiveHash: c.imageArchive.archiveHash, targetHash: hash(JSON.stringify(c.target)), credentialSource: source.declaration,
    at: Date.now(), expiresAt: saved.report.approval.expiresAt, realCapture: false, faithfulReplay: false };
  const scope = path.join(c.root, hash(c.projectId)), file = path.join(scope, 'launch-' + hash(approvalId) + '.json');
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(intent)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(intent));
  const restored = await restoreImageArchive(c.imageArchive, c.target);
  assert.deepEqual(restored.image, c.image);
  const current = readBoundModelApproval(scope, approvalId);
  assert.deepEqual(current.binding, saved.binding); fresh(current, prepared);
  return prepared.dispatch(scope, approvalId, source.credential, restored.runProbe);
}
async function main(args) {
  assert.ok(args.length >= 3 && args[0] === '--config');
  const c = loadSdkValidationConfig(args[1]);
  if (args.length === 3 && args[2] === '--review') {
    const { entries } = prepareSdkValidationOperator(c);
    const server = await startModelReviewServer({ root: c.root, entries });
    console.log(JSON.stringify({ url: server.url, mode: 'new-fresh-sdk-validation-review', paidAuthorization: false, realCapture: false, faithfulReplay: false }));
    let closing = false;
    const close = () => { if (!closing) { closing = true; server.close().catch(() => { process.exitCode = 1; }); } };
    process.once('SIGTERM', close); process.once('SIGINT', close); return;
  }
  if (args.length === 4 && args[2] === '--report') { console.log(JSON.stringify(readSdkValidationReport(c, args[3]))); return; }
  assert.ok(args.length === 8 && args[2] === '--run' && args[4] === '--confirm-paid' && args[5] === '--reuse-models' && args[7] === '--confirm-nonproduction');
  console.log(JSON.stringify(await runSdkValidationOperator(c, args[3], true, args[6], true)));
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { process.stderr.write('sdk_validation_operator_failed\n'); process.exitCode = 1; });
module.exports = { loadSdkValidationConfig, prepareSdkValidationOperator, readSdkValidationReport, runSdkValidationOperator, main };
