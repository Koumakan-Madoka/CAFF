const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { hash } = require('../helpers/badcase-offline-spec.cjs');
const { archiveRuntime } = require('../../scripts/badcase-capture/runtime-archive.cjs');
const { archiveHarness } = require('../../scripts/badcase-capture/harness-archive.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const { prepareScriptedEvaluation } = require('../../scripts/badcase-capture/scripted-evaluation.cjs');
const { dispatchApprovedScriptedEvaluation } = require('../../scripts/badcase-capture/approved-scripted-evaluation.cjs');
const { createEvaluationAdminService } = require('../../build/server/domain/runtime/badcase-capture/evaluation-admin');
const image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
function setup(t, mode = 'fresh') {
  const h = fixture(t, mode), repo = path.resolve(__dirname, '../..');
  const sources = { runtimeArchive: archiveRuntime(repo, path.join(h.root, 'runtime')), harnessArchive: archiveHarness(repo, path.join(h.root, 'harness')) };
  const roles = { baseline: 'Synthetic baseline role.', candidate: 'Synthetic candidate role.' };
  const rule = { expectedHash: hash('done\n'), badcaseHash: hash('draft\n') };
  const prepared = prepareScriptedEvaluation(h.request, image, sources, roles, rule);
  const root = path.join(h.root, 'admin'), service = createEvaluationAdminService({ root });
  const p = service.preview('p1', { spec: prepared.plan.spec });
  service.approve('p1', { confirmed: true, approvalId: p.approvalId, planHash: p.plan.planHash });
  const q = { root, projectId: 'p1', approvalId: p.approvalId, request: h.request, image, sources, roles, rule };
  return { ...h, q, service, p, recordDir: path.join(root, hash('p1'), 'evaluations', hash(p.approvalId)) };
}
function response(files) {
  const manifest = manifestFor(files), q = JSON.parse(files.find(f => f.path === 'task.json').bytes);
  return { containerId: 'a'.repeat(64), manifest, result: { code: 0, stderr: '', stdout: JSON.stringify({
    kind: 'scripted-sdk-task-v1', runId: q.runId, roleHash: hash(q.role), capsuleHash: q.capsuleHash,
    inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, deliveryMode: q.deliveryMode,
    invocationHash: q.invocationHash, historyHash: q.historyHash, scriptCalls: 5, networkCalls: 0,
    toolNames: ['write', 'read', 'edit', 'bash'], artifactBase64: Buffer.from('done\n').toString('base64') }) + '\n' } };
}
test('saved project approval drives both variants; restarted management reads identical results; repeat never calls transport', async t => {
  for (const mode of ['fresh', 'resume']) {
    const h = setup(t, mode); let calls = 0;
    fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
    const r = await dispatchApprovedScriptedEvaluation(h.q, async (_, files) => {
      calls++; assert.equal(JSON.parse(files.find(f => f.path === 'task.json').bytes).deliveryMode, mode);
      return response(files);
    });
    assert.equal(calls, 2); assert.equal(r.report.reason, 'complete');
    assert.equal(r.report.ledger.summary.baseline.expectationMet, 1); assert.equal(r.report.ledger.summary.candidate.expectationMet, 1);
    assert.equal(r.launchAvailable, false); assert.equal(r.paidAuthorization, false); assert.equal(r.materialVerified, false);
    assert.equal(r.report.ledger.executionVerified, false); assert.equal(r.report.ledger.strictEvalEligible, false);
    assert.deepEqual(createEvaluationAdminService({ root: h.q.root }).read('p1', h.p.approvalId), r);
    assert.equal(fs.readdirSync(h.runDir).length, 3);
    await assert.rejects(dispatchApprovedScriptedEvaluation(h.q, async () => { calls++; }), /evaluation_already_consumed/);
    assert.equal(calls, 2);
  }
});
test('project, case, roles, rule, environment and plan changes refuse before claim or transport', async t => {
  const h = setup(t); let calls = 0;
  const mutations = [
    { projectId: 'p2' },
    { request: { ...h.q.request, association: { ...h.q.request.association, projectId: 'p2' } } },
    { request: { ...h.q.request, flagId: 'different-case' } },
    { roles: { ...h.q.roles, candidate: 'Changed candidate.' } },
    { rule: { ...h.q.rule, expectedHash: hash('different') } },
    { image: { ...image, nodeVersion: 'v24.22.0' } },
    { extra: 'forbidden' },
  ];
  for (const change of mutations) {
    await assert.rejects(dispatchApprovedScriptedEvaluation({ ...h.q, ...change }, async () => { calls++; }));
    assert.equal(h.service.read('p1', h.p.approvalId).report.consumed, false);
  }
  assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(h.recordDir), ['approval.json']);
});
test('missing or corrupted archive and corrupt CAS refuse before consuming approval', async t => {
  const h = setup(t); let calls = 0;
  for (const runtimeArchive of [null, { ...h.q.sources.runtimeArchive, archiveHash: '0'.repeat(64) }]) {
    await assert.rejects(dispatchApprovedScriptedEvaluation({ ...h.q, sources: { ...h.q.sources, runtimeArchive } }, async () => { calls++; }));
  }
  fs.writeFileSync(h.blobPath(h.r.promptBlobHash), 'corrupted');
  await assert.rejects(dispatchApprovedScriptedEvaluation(h.q, async () => { calls++; }));
  assert.equal(calls, 0); assert.equal(h.service.read('p1', h.p.approvalId).report.consumed, false);
});
test('expiry, backwards clock and absent transport refuse without consuming or new pins', async t => {
  const h = setup(t), now = Date.now, pins = fs.readdirSync(h.runDir);
  t.after(() => { Date.now = now; }); let calls = 0;
  for (const at of [h.p.expiresAt, 0]) {
    Date.now = () => at;
    await assert.rejects(dispatchApprovedScriptedEvaluation(h.q, async () => { calls++; }), /evaluation_approval_stale/);
  }
  Date.now = now;
  await assert.rejects(dispatchApprovedScriptedEvaluation(h.q), /dedicated_transport_required/);
  assert.equal(calls, 0); assert.equal(h.service.read('p1', h.p.approvalId).report.consumed, false);
  assert.deepEqual(fs.readdirSync(h.runDir), pins);
});
test('expiry during material preparation blocks before claim and transport', async t => {
  const h = setup(t), read = fs.readFileSync, now = Date.now; let expired = false, calls = 0;
  t.after(() => { fs.readFileSync = read; Date.now = now; });
  fs.readFileSync = function(file, ...args) {
    const value = read.call(this, file, ...args);
    if (typeof file === 'string' && path.resolve(file) === path.resolve('scripts/badcase-capture/scripted-task-container.cjs')) expired = true;
    return value;
  };
  Date.now = () => expired ? h.p.expiresAt : now();
  await assert.rejects(dispatchApprovedScriptedEvaluation(h.q, async () => { calls++; }), /evaluation_approval_stale/);
  assert.equal(expired, true); assert.equal(calls, 0); assert.equal(h.service.read('p1', h.p.approvalId).report.consumed, false);
});
test('changed approval during preparation is rejected before claim', async t => {
  const h = setup(t), read = fs.readFileSync; let changed = false, calls = 0;
  t.after(() => { fs.readFileSync = read; });
  fs.readFileSync = function(file, ...args) {
    const value = read.call(this, file, ...args);
    if (!changed && typeof file === 'string' && path.resolve(file) === path.resolve('scripts/badcase-capture/scripted-task-container.cjs')) {
      const fileName = path.join(h.recordDir, 'approval.json'), stored = JSON.parse(read(fileName));
      stored.approval.expiresAt += 1000; fs.writeFileSync(fileName, JSON.stringify(stored)); changed = true;
    }
    return value;
  };
  await assert.rejects(dispatchApprovedScriptedEvaluation(h.q, async () => { calls++; }), /evaluation_approval_changed/);
  assert.equal(changed, true); assert.equal(calls, 0); assert.equal(h.service.read('p1', h.p.approvalId).report.consumed, false);
});
test('missing and non-offline persisted approvals refuse before preparation or transport', async t => {
  const h = setup(t), pins = fs.readdirSync(h.runDir); let calls = 0;
  await assert.rejects(dispatchApprovedScriptedEvaluation({ ...h.q, approvalId: '11111111-1111-4111-8111-111111111111' }, async () => { calls++; }), /evaluation_record_invalid/);
  const file = path.join(h.recordDir, 'approval.json'), stored = JSON.parse(fs.readFileSync(file));
  const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
  stored.spec.model.provider = 'paid-provider'; stored.approval.planHash = planEvaluation(stored.spec).planHash;
  fs.writeFileSync(file, JSON.stringify(stored));
  await assert.rejects(dispatchApprovedScriptedEvaluation(h.q, async () => { calls++; }), /evaluation_record_invalid/);
  assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(h.runDir), pins); assert.deepEqual(fs.readdirSync(h.recordDir), ['approval.json']);
});
test('transport failure leaves unknown reservation queryable with no raw exception and no replay', async t => {
  const h = setup(t); let calls = 0;
  const r = await dispatchApprovedScriptedEvaluation(h.q, async () => { calls++; throw Error('PRIVATE-RUNNER-SENTINEL'); });
  assert.equal(r.report.dispatchState, 'unresolved'); assert.equal(r.report.reason, 'dispatch_failed');
  assert.equal(r.report.ledger.runs[0].costMicroUsd, null); assert.equal(r.report.ledger.runs[0].score, null);
  assert.deepEqual(h.service.read('p1', h.p.approvalId), r);
  assert.equal(fs.readdirSync(h.recordDir).some(n => fs.readFileSync(path.join(h.recordDir, n), 'utf8').includes('PRIVATE-RUNNER-SENTINEL')), false);
  await assert.rejects(dispatchApprovedScriptedEvaluation(h.q, async () => { calls++; }), /evaluation_already_consumed/);
  assert.equal(calls, 1);
});
test('concurrent invocations consume only once and retain all references', async t => {
  const h = setup(t); let calls = 0, release;
  const first = dispatchApprovedScriptedEvaluation(h.q, async (_, files) => {
    if (++calls === 1) await new Promise(r => { release = r; });
    return response(files);
  });
  assert.equal(calls, 1);
  await assert.rejects(dispatchApprovedScriptedEvaluation(h.q, async () => { calls++; }), /evaluation_already_consumed/);
  release(); assert.equal((await first).report.reason, 'complete'); assert.equal(calls, 2);
  assert.equal(fs.readdirSync(h.runDir).length, 3);
});
