const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { archiveRuntime } = require('../../scripts/badcase-capture/runtime-archive.cjs');
const { archiveHarness } = require('../../scripts/badcase-capture/harness-archive.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const { prepareScriptedEvaluation } = require('../../scripts/badcase-capture/scripted-evaluation.cjs');
const { recordEvaluationApproval, dispatchRecordedEvaluation, readEvaluationRecord } = require('../../build/server/domain/runtime/badcase-capture/evaluation-record');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
function setup(t, mode = 'fresh') {
  const h = fixture(t, mode), repo = path.resolve(__dirname, '../..');
  const sources = { runtimeArchive: archiveRuntime(repo, path.join(h.root, 'runtime')), harnessArchive: archiveHarness(repo, path.join(h.root, 'harness')) };
  const roles = { baseline: 'Synthetic baseline role.', candidate: 'Synthetic candidate role.' };
  const rule = { expectedHash: hash('done\n'), badcaseHash: hash('draft\n') };
  const prepared = prepareScriptedEvaluation(h.request, image, sources, roles, rule);
  const approval = { confirmed: true, planHash: prepared.plan.planHash, approvalId: 'offline-test', expiresAt: Date.now() + 120000 };
  recordEvaluationApproval(h.root, prepared.plan.spec, approval);
  return { ...h, sources, roles, rule, prepared, approval };
}
function response(files, changes = {}) {
  const manifest = manifestFor(files), q = JSON.parse(files.find(f => f.path === 'task.json').bytes);
  return { containerId: 'a'.repeat(64), manifest, result: { code: 0, stderr: '', stdout: JSON.stringify({
    kind: 'scripted-sdk-task-v1', runId: q.runId, roleHash: hash(q.role), capsuleHash: q.capsuleHash,
    inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, deliveryMode: q.deliveryMode,
    invocationHash: q.invocationHash, historyHash: q.historyHash, scriptCalls: 5, networkCalls: 0,
    toolNames: ['write', 'read', 'edit', 'bash'], artifactBase64: Buffer.from('done\n').toString('base64'), ...changes }) + '\n' } };
}
async function dispatch(h, transport) {
  return dispatchRecordedEvaluation(h.root, h.approval.approvalId, r => h.prepared.execute(r, transport));
}
test('offline adapter binds actual materials and roles, keeps rubric outside stage, persists scores for two independent runs', async t => {
  const h = setup(t), stages = [];
  const report = await dispatch(h, async (img, files, options) => {
    assert.deepEqual(options, { timeoutMs: 25000 });
    stages.push(files); assert.deepEqual(img, image);
    assert.equal(files.some(f => !f.path.startsWith('runtime/') && /scor|rubric|answer|rule/.test(f.path)), false);
    assert.equal(files.some(f => f.bytes.includes(h.rule.expectedHash)), false);
    return response(files);
  });
  assert.equal(stages.length, 2); assert.notEqual(stages[0], stages[1]);
  const qs = stages.map(f => JSON.parse(f.find(x => x.path === 'task.json').bytes));
  assert.equal(qs[0].role, h.roles.baseline); assert.equal(qs[1].role, h.roles.candidate);
  assert.equal(qs[0].capsuleHash, qs[1].capsuleHash); assert.notEqual(qs[0].runId, qs[1].runId);
  assert.equal(report.ledger.state, 'complete'); assert.equal(report.ledger.knownCostMicroUsd, 0);
  assert.equal(report.ledger.summary.baseline.expectationMet, 1); assert.equal(report.ledger.summary.candidate.expectationMet, 1);
  assert.equal(report.ledger.spec.model.provider, 'caff-offline-scripted');
  assert.equal(report.ledger.executionVerified, false); assert.equal(report.ledger.strictEvalEligible, false);
  assert.deepEqual(readEvaluationRecord(h.root, h.approval.approvalId), report);
  assert.equal(fs.readdirSync(h.runDir).length, 3); // planning pin + one per run; never unpin
});
test('resume mode and invocation/history hashes are preserved, not silently fresh', async t => {
  const h = setup(t, 'resume');
  const report = await dispatch(h, async (_, files) => {
    const q = JSON.parse(files.find(f => f.path === 'task.json').bytes); assert.equal(q.deliveryMode, 'resume');
    return response(files);
  });
  assert.equal(report.ledger.state, 'complete');
});
test('tampered dispatch/role hash, expired request, missing transport are refused before Docker', async t => {
  const h = setup(t), run = h.prepared.plan.runs[0]; let calls = 0;
  const request = { ...run, planHash: h.prepared.plan.planHash, timeoutMs: 25000, perRunLimitMicroUsd: 1, approvalId: h.approval.approvalId, expiresAt: h.approval.expiresAt };
  for (const change of [{ roleHash: '0'.repeat(64) }, { commonHash: '0'.repeat(64) }, { expiresAt: 0 }, { timeoutMs: 1000 }, { variant: 'candidate' }, { extra: true }]) {
    await assert.rejects(h.prepared.execute({ ...request, ...change }, async () => { calls++; }));
  }
  await assert.rejects(h.prepared.execute(request)); assert.equal(calls, 0);
});
test('invalid output and receipts never fabricate settled score or zero cost', async t => {
  for (const changes of [{ roleHash: '0'.repeat(64) }, { scriptCalls: 0 }, { networkCalls: 1 }, { deliveryMode: 'resume' },
    { toolNames: ['write'] }, { artifactBase64: '%%%secret-sentinel' }, { artifactBase64: Buffer.alloc(4097).toString('base64') }, { extra: true }]) {
    const h = setup(t), report = await dispatch(h, async (_, files) => response(files, changes));
    assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.reason, 'dispatch_failed');
    assert.equal(report.ledger.runs[0].score, null); assert.equal(report.ledger.runs[0].costMicroUsd, null);
  }
});
test('verified deadline records timed_out without score or known cost; incomplete cleanup remains unresolved', async t => {
  for (const invalid of [false, 'missing', 'duration', 'stopped', 'removed', 'extra', 'result']) {
    const h = setup(t); let calls = 0;
    const report = await dispatch(h, async (_, files) => {
      calls++;
      const r = response(files);
      r.result.failure = 'timeout'; r.result.code = 137;
      r.termination = { reason: 'deadline', timeoutMs: 25000, stopped: true, removed: true };
      if (invalid === 'missing') delete r.termination;
      if (invalid === 'duration') r.termination.timeoutMs = 1;
      if (['stopped', 'removed'].includes(invalid)) r.termination[invalid] = false;
      if (invalid === 'extra') r.termination.extra = true;
      if (invalid === 'result') delete r.result.failure;
      return r;
    });
    assert.equal(calls, 1); assert.equal(report.ledger.runs[0].score, null); assert.equal(report.ledger.runs[0].costMicroUsd, null);
    assert.equal(report.ledger.runs[0].status, invalid ? 'reserved' : 'timed_out');
    assert.deepEqual(readEvaluationRecord(h.root, h.approval.approvalId), report);
    if (invalid) assert.equal(report.dispatchState, 'unresolved');
  }
});
test('host rubric independently records failure and reproduction rather than trusting a container score', async t => {
  const h = setup(t);
  const report = await dispatch(h, async (_, files) => response(files, { artifactBase64: Buffer.from('draft\n').toString('base64') }));
  assert.equal(report.ledger.summary.baseline.reproduced, 1); assert.equal(report.ledger.summary.candidate.reproduced, 1);
  assert.equal(report.ledger.summary.baseline.expectationMet, 0);
});
test('corrupt sealed input is rechecked and blocked before transport, despite previously prepared plan', async t => {
  const h = setup(t); fs.writeFileSync(h.blobPath(h.r.promptBlobHash), 'changed'); let calls = 0;
  const report = await dispatch(h, async () => { calls++; });
  assert.equal(calls, 0); assert.equal(report.reason, 'dispatch_failed');
});
test('changing public plan, roles or sources after preparation cannot change the frozen execution', async t => {
  const h = setup(t); h.prepared.plan.spec.baselineRoleHash = '0'.repeat(64); h.roles.baseline = 'changed'; h.sources.runtimeArchive.archiveHash = '0'.repeat(64);
  let i = 0;
  const report = await dispatch(h, async (_, files) => { assert.equal(JSON.parse(files.find(f => f.path === 'task.json').bytes).role, i++ === 0 ? 'Synthetic baseline role.' : 'Synthetic candidate role.'); return response(files); });
  assert.equal(report.ledger.state, 'complete');
});
test('secret-bearing, oversized, NUL and invalid Unicode role inputs are rejected without transport or new references', t => {
  const h = setup(t), count = fs.readdirSync(h.runDir).length;
  for (const baseline of ['sk-synthetic123456789', 'password=synthetic-sentinel', 'x'.repeat(16385), 'x\0y', '\ud800']) {
    assert.throws(() => prepareScriptedEvaluation(h.request, image, h.sources, { ...h.roles, baseline }, h.rule), /scripted_role_invalid/);
  }
  assert.equal(fs.readdirSync(h.runDir).length, count);
});
test('explicit missing archive never falls back and nonzero/unknown transport never becomes a scored zero-cost success', async t => {
  const h = setup(t);
  assert.throws(() => prepareScriptedEvaluation(h.request, image, { ...h.sources, runtimeArchive: null }, h.roles, h.rule));
  const report = await dispatch(h, async (_, files) => { const r = response(files); r.result.code = 1; r.result.stderr = 'private-sentinel'; return r; });
  assert.equal(report.reason, 'dispatch_failed'); assert.equal(report.ledger.runs[0].costMicroUsd, null);
});
test('container task refuses host execution before importing SDK', () => {
  const r = spawnSync(process.execPath, ['scripts/badcase-capture/scripted-task-container.cjs'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'scripted_sdk_task_failed\n');
});
