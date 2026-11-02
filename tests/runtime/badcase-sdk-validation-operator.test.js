// Operator lifecycle under inert launcher/daemon/auth dependencies. No model,
// SDK or native execution; real private file publication, original boundaries.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const file = path.resolve(__dirname, '../../scripts/badcase-capture/sdk-validation-operator.cjs');
function fixture(t, option = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-sdk-operator-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], spec = { caseId: 'new-validation' }, plan = { spec, planHash: hash('plan') };
  const binding = { bindingHash: hash('binding'), endpointHash: hash('endpoint'), config: { settings: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, endpoint: {} } };
  const approval = { approvalId: 'explicit-new-approval', planHash: plan.planHash, confirmed: true, expiresAt: Date.now() + 60000 };
  const report = { consumed: false, dispatchState: 'approved', approval, ledger: { spec, planHash: plan.planHash } };
  const source = { kind: 'explicit-nonproduction-model-auth-reuse-v1', provider: 'opencode-go', model: 'deepseek-v4.1-flash',
    endpointHash: binding.endpointHash, sourcePathHash: hash('explicit absolute source'), confirmedNonProduction: true };
  const c = { root, projectId: 'new-validation-project', caseId: spec.caseId, input: {}, roles: {}, rule: {}, model: binding.config, limits: {},
    image: { imageId: 'sha256:' + 'a'.repeat(64) }, imageArchive: { archiveHash: hash('archive') },
    target: { socket: 'unix:///var/tmp/caff-image-recovery-test/docker.sock', daemonId: 'isolated-test', dataRoot: '/var/tmp/caff-image-recovery-test/data' }, productionResourcesExcluded: true };
  const scope = path.join(root, hash(c.projectId)); fs.mkdirSync(scope);
  const prepared = { plan, review: { launchHash: hash('launch') }, async dispatch(r, id, credential, probe) {
    calls.push('dispatch'); assert.equal(r, scope); assert.equal(id, approval.approvalId);
    assert.equal(typeof credential, 'function'); assert.equal(typeof probe, 'function');
    assert.ok(fs.existsSync(path.join(scope, 'launch-' + hash(id) + '.json')));
    return { ...report, consumed: true, dispatchState: 'finished' };
  } };
  const deps = {
    './sdk-docker-validation.cjs': { prepareSdkDockerValidation: () => { calls.push('prepare'); return prepared; } },
    './model-review-server.cjs': { readRegistry: () => { calls.push('load'); return c; }, startModelReviewServer: async () => { calls.push('review'); return { url: 'loopback', close: async () => {} }; } },
    './image-recovery.cjs': { restoreImageArchive: async () => { calls.push('restore'); if (option.restoreFail) throw Error('private-restore'); return { image: c.image, runProbe: async () => {} }; } },
    './authorized-model-auth.cjs': { createAuthorizedModelCredential: q => { calls.push('source-selection'); assert.equal(q.confirmedNonProduction, true);
      assert.ok(path.isAbsolute(q.file)); return { declaration: source, credential: () => { calls.push('source-read'); return {}; } }; } },
    '../../build/server/domain/runtime/badcase-capture/model-review': { createModelReviewService: () => ({ read: () => { calls.push('approval-read');
      return { report: { ...report, consumed: !!option.consumed, dispatchState: option.consumed ? 'finished' : 'approved' }, binding }; } }) },
    '../../build/server/domain/runtime/badcase-capture/model-binding': { readBoundModelApproval: () => { calls.push('approval-reread');
      return { report: option.changed ? { ...report, ledger: { ...report.ledger, planHash: hash('changed') } } : report, binding }; } }
  };
  const printed = [], mod = { exports: {} }, req = name => Object.hasOwn(deps, name) ? deps[name] : require(name);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: req, module: mod, __dirname: path.dirname(file), process,
    console: { log: value => printed.push(value) }, JSON });
  return { api: mod.exports, c, calls, scope, report, binding, source, prepared, printed };
}
test('explicit paid/source confirmation publishes source+plan+target attestation before restore, then rereads approval and dispatches', async t => {
  const f = fixture(t), result = await f.api.runSdkValidationOperator(f.c, f.report.approval.approvalId, true, path.join(f.c.root, 'explicit-models.json'), true);
  assert.equal(result.dispatchState, 'finished');
  assert.deepEqual(f.calls, ['prepare', 'approval-read', 'source-selection', 'restore', 'approval-reread', 'dispatch']);
  const attestation = JSON.parse(fs.readFileSync(path.join(f.scope, 'launch-' + hash(f.report.approval.approvalId) + '.json')));
  assert.deepEqual(attestation.credentialSource, f.source); assert.equal(attestation.planHash, f.prepared.plan.planHash);
  assert.equal(attestation.bindingHash, f.binding.bindingHash); assert.equal(attestation.launchHash, f.prepared.review.launchHash);
  assert.equal(attestation.targetHash, hash(JSON.stringify(f.c.target)));
  assert.ok(!JSON.stringify(attestation).includes('explicit-models.json'));
  await assert.rejects(f.api.runSdkValidationOperator(f.c, f.report.approval.approvalId, true, path.join(f.c.root, 'explicit-models.json'), true));
  assert.equal(f.calls.filter(x => x === 'restore').length, 1);
});
test('missing confirmation, explicit source, production exclusion or approved scope cannot restore a daemon or read credentials', async t => {
  for (const mode of ['paid', 'purpose', 'source', 'production', 'consumed', 'wrongPlan']) {
    const f = fixture(t, { consumed: mode === 'consumed' });
    if (mode === 'production') f.c.productionResourcesExcluded = false;
    if (mode === 'wrongPlan') f.prepared.plan.spec = { caseId: 'other' };
    await assert.rejects(f.api.runSdkValidationOperator(f.c, f.report.approval.approvalId, mode !== 'paid',
      mode === 'source' ? '' : path.join(f.c.root, 'explicit-models.json'), mode !== 'purpose'));
    assert.ok(!f.calls.includes('restore') && !f.calls.includes('dispatch') && !f.calls.includes('source-read'));
  }
});
test('report CLI reads only the saved report, and incomplete paid arguments never become a credential fallback', async t => {
  const f = fixture(t);
  await f.api.main(['--config', 'explicit-config.json', '--report', f.report.approval.approvalId]);
  assert.deepEqual(f.calls, ['load', 'approval-read']); assert.equal(JSON.parse(f.printed[0]).report.dispatchState, 'approved');
  for (const tail of [['--run', f.report.approval.approvalId], ['--run', f.report.approval.approvalId, '--confirm-paid'],
    ['--run', f.report.approval.approvalId, '--confirm-paid', '--reuse-models', 'explicit.json']]) {
    await assert.rejects(f.api.main(['--config', 'explicit-config.json', ...tail]));
  }
  assert.ok(!f.calls.includes('prepare') && !f.calls.includes('source-selection') && !f.calls.includes('restore'));
});
test('restore failure retains intent and changed approval after restore blocks dispatch without accessing source contents', async t => {
  for (const mode of ['restoreFail', 'changed']) {
    const f = fixture(t, { [mode]: true });
    await assert.rejects(f.api.runSdkValidationOperator(f.c, f.report.approval.approvalId, true, path.join(f.c.root, 'explicit-models.json'), true));
    assert.ok(fs.existsSync(path.join(f.scope, 'launch-' + hash(f.report.approval.approvalId) + '.json')));
    assert.ok(!f.calls.includes('dispatch') && !f.calls.includes('source-read'));
  }
});
