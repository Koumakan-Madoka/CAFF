// Authorized dedicated-daemon experiment: real HTTP approval storage -> internal
// offline runner -> real Docker SDK tools -> HTTP report after service rebuild.
// Approval clicks are simulated here; not a human approval or paid model run.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { archiveImage } = require('./image-archive.cjs');
const { restoreImageArchive } = require('./image-recovery.cjs');
const { archiveRuntime } = require('./runtime-archive.cjs');
const { archiveHarness } = require('./harness-archive.cjs');
const { prepareScriptedEvaluation } = require('./scripted-evaluation.cjs');
const { dispatchApprovedScriptedEvaluation } = require('./approved-scripted-evaluation.cjs');
const { createEvaluationAdminService } = require('../../build/server/domain/runtime/badcase-capture/evaluation-admin');
const { createBadcaseEvaluationsController } = require('../../build/server/api/badcase-evaluations-controller');
const fixture = require('../../tests/helpers/badcase-initialization-fixture.cjs');
const { hash } = require('../../tests/helpers/badcase-offline-spec.cjs');
async function main() {
  const args = process.argv.slice(2), arg = n => { const i = args.indexOf('--' + n); assert.ok(i >= 0 && args[i + 1]); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  const target = { socket: arg('socket'), daemonId: arg('daemon-id'), dataRoot: arg('data-root') };
  const root = path.join(target.dataRoot, '..', 'artifacts'); fs.mkdirSync(root, { mode: 0o700 });
  const adminRoot = path.join(root, 'offline-approvals'), repo = path.resolve(__dirname, '../..');
  const cleanup = [], ids = [], reports = [];
  let controller, authority;
  function rebuild() {
    controller = createBadcaseEvaluationsController({ service: createEvaluationAdminService({ root: adminRoot }), host: '127.0.0.1',
      getAuthority: () => authority, csrfToken: 'synthetic-loopback-only', projectManager: { listProjects: () => [{ id: 'p1' }, { id: 'p2' }] } });
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (await controller({ req, res, pathname: new URL(req.url, 'http://local').pathname })) return;
      res.writeHead(404); res.end();
    } catch (e) { res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ issues: e.issues || [] })); }
  });
  try {
    const ref = await archiveImage(image, path.join(root, 'image'));
    const restored = await restoreImageArchive(ref, target);
    const sources = { runtimeArchive: archiveRuntime(repo, path.join(root, 'runtime')), harnessArchive: archiveHarness(repo, path.join(root, 'harness')) };
    await new Promise(r => server.listen(0, '127.0.0.1', r)); authority = `127.0.0.1:${server.address().port}`; rebuild();
    async function api(suffix, body, projectId = 'p1') {
      const response = await fetch(`http://${authority}/api/projects/${projectId}/badcase-evaluations/${suffix}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://${authority}`, 'X-CAFF-CSRF-Token': 'synthetic-loopback-only' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      return { status: response.status, body: await response.json() };
    }
    for (const scenario of ['fresh', 'resume', 'bad-receipt']) {
      const h = fixture({ after: fn => cleanup.push(fn) }, scenario === 'resume' ? 'resume' : 'fresh');
      fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
      const originalBlob = fs.readFileSync(h.blobPath(h.r.promptBlobHash));
      const roles = { baseline: 'Synthetic baseline role.', candidate: 'Synthetic candidate role.' };
      const rule = { expectedHash: hash('done\n'), badcaseHash: hash('draft\n') };
      const prepared = prepareScriptedEvaluation(h.request, image, sources, roles, rule);
      const preview = await api('preview', { spec: prepared.plan.spec }); assert.equal(preview.status, 200);
      const p = preview.body;
      const approval = await api('approve', { confirmed: true, approvalId: p.approvalId, planHash: p.plan.planHash }); assert.equal(approval.status, 200);
      assert.equal(approval.body.report.consumed, false);
      const request = { root: adminRoot, projectId: 'p1', approvalId: p.approvalId, request: h.request, image, sources, roles, rule };
      let transportCalls = 0;
      // A real saved approval must NOT authorize a different material plan.
      await assert.rejects(dispatchApprovedScriptedEvaluation({ ...request, roles: { ...roles, candidate: 'Unapproved role.' } }, async () => { transportCalls++; }), /evaluation_material_mismatch/);
      assert.equal(transportCalls, 0);
      assert.equal((await api('records/' + p.approvalId)).body.report.consumed, false);
      const result = await dispatchApprovedScriptedEvaluation(request, async (img, files) => {
        const run = await restored.runProbe(img, files); ids.push(run.containerId); transportCalls++;
        assert.equal(run.result.code, 0); assert.equal(run.result.stderr, '');
        if (scenario === 'bad-receipt') {
          const receipt = JSON.parse(run.result.stdout); receipt.scriptCalls = 0;
          run.result.stdout = JSON.stringify(receipt) + '\n';
        }
        return run;
      });
      assert.equal(transportCalls, scenario === 'bad-receipt' ? 1 : 2);
      rebuild(); // no preview tickets; persistent report survives
      const queried = await api('records/' + p.approvalId); assert.equal(queried.status, 200); assert.deepEqual(queried.body, result);
      assert.equal((await api('records/' + p.approvalId, undefined, 'p2')).status, 409);
      await assert.rejects(dispatchApprovedScriptedEvaluation(request, async () => { transportCalls++; }), /evaluation_already_consumed/);
      assert.equal(transportCalls, scenario === 'bad-receipt' ? 1 : 2);
      if (scenario === 'bad-receipt') {
        assert.equal(result.report.dispatchState, 'unresolved'); assert.equal(result.report.reason, 'dispatch_failed');
        assert.equal(result.report.ledger.runs[0].score, null); assert.equal(result.report.ledger.runs[0].costMicroUsd, null);
      } else {
        assert.equal(result.report.reason, 'complete'); assert.equal(result.report.ledger.runs.length, 2);
        assert.equal(result.report.ledger.summary.baseline.expectationMet, 1); assert.equal(result.report.ledger.summary.candidate.expectationMet, 1);
        assert.equal(result.report.ledger.summary.baseline.reproduced, 0); assert.equal(result.report.ledger.summary.candidate.reproduced, 0);
      }
      assert.deepEqual(fs.readFileSync(h.blobPath(h.r.promptBlobHash)), originalBlob);
      assert.equal(result.materialVerified, false); assert.equal(result.paidAuthorization, false);
      assert.equal(result.report.ledger.strictEvalEligible, false);
      reports.push({ scenario, approvalId: p.approvalId, dispatchState: result.report.dispatchState, reason: result.report.reason,
        inputHash: result.report.ledger.spec.inputHash, harnessHash: result.report.ledger.spec.harnessHash,
        summary: result.report.ledger.summary, runs: result.report.ledger.runs, protectedReferences: fs.readdirSync(h.runDir).length,
        httpReadAfterRebuild: true, crossProjectReadRefused: true, changedMaterialRefusedBeforeClaim: true, repeatRefused: true });
    }
    assert.equal(new Set(ids).size, 5);
    console.log(JSON.stringify({ ok: true, kind: 'approved-offline-scripted-evaluation', identity: restored.identity, archiveBytes: ref.archiveBytes,
      reports, cleanedContainerIds: ids, realModelInvocations: 0, humanApproval: false, acceptance: false,
      sourceBlobsUnchanged: true, httpProductionDispatchRoute: false, browserTested: false, artifactsRetainedAfterExperiment: false }));
  } finally {
    if (server.listening) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    for (const fn of cleanup.reverse()) fn();
  }
}
if (require.main === module) main().catch(() => { console.error('approved_scripted_evaluation_verification_failed'); process.exitCode = 1; });
