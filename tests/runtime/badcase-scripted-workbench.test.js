const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { hash } = require('../helpers/badcase-offline-spec.cjs');
const { archiveRuntime } = require('../../scripts/badcase-capture/runtime-archive.cjs');
const { archiveHarness } = require('../../scripts/badcase-capture/harness-archive.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const { createScriptedWorkbench } = require('../../scripts/badcase-capture/scripted-workbench.cjs');
const image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
function setup(t) {
  const h = fixture(t), repo = path.resolve(__dirname, '../..'), root = path.join(h.root, 'admin');
  const material = { id: 'sample', projectId: 'p1', request: h.request, image,
    sources: { runtimeArchive: archiveRuntime(repo, path.join(h.root, 'runtime')), harnessArchive: archiveHarness(repo, path.join(h.root, 'harness')) },
    roles: { baseline: 'Baseline <b>text</b>', candidate: 'Candidate text' }, rule: { expectedHash: hash('done\n'), badcaseHash: hash('draft\n') } };
  let calls = 0, transport = async (_, files) => {
    calls++; const manifest = manifestFor(files), q = JSON.parse(files.find(f => f.path === 'task.json').bytes);
    return { containerId: 'a'.repeat(64), manifest, result: { code: 0, stderr: '', stdout: JSON.stringify({
      kind: 'scripted-sdk-task-v1', runId: q.runId, roleHash: hash(q.role), capsuleHash: q.capsuleHash,
      inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, deliveryMode: q.deliveryMode,
      invocationHash: q.invocationHash, historyHash: q.historyHash, scriptCalls: 5, networkCalls: 0,
      toolNames: ['write', 'read', 'edit', 'bash'], artifactBase64: Buffer.from('done\n').toString('base64') }) } };
  };
  const options = { root, materials: [material], runProbe: (...args) => transport(...args) };
  return { ...h, root, material, options, service: createScriptedWorkbench(options), calls: () => calls,
    transport: fn => { transport = fn; } };
}
test('operator registry rejects extra image fields, missing transport and cross-project material binding', t => {
  const h = setup(t);
  for (const options of [ { ...h.options, runProbe: null }, { ...h.options, materials: [{ ...h.material, image: { ...image, hostPath: '/host' } }] },
    { ...h.options, materials: [{ ...h.material, projectId: 'p2' }] }, { ...h.options, materials: [h.material, h.material] } ]) {
    assert.throws(() => createScriptedWorkbench(options), /evaluation_workbench_invalid/);
  }
  assert.equal(fs.existsSync(h.root), false);
});
test('isolated server uses loopback port, guarded material routes and static allowlist; no approval on preview', async t => {
  const h = setup(t), { startScriptedWorkbenchServer } = require('../../scripts/badcase-capture/workbench-server.cjs');
  const server = await startScriptedWorkbenchServer(h.options); t.after(() => server.close());
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const catalog = await fetch(server.url + '/api/projects/p1/badcase-evaluations/materials'); assert.equal(catalog.status, 200);
  assert.equal(catalog.headers.get('cache-control'), 'no-store'); assert.match(catalog.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(server.url + '/scripts/badcase-capture/scripted-workbench.cjs')).status, 404);
  // fetch normalizes Host on some Node versions; raw HTTP is needed to send
  // the adversarial header rather than accidentally testing a normal request.
  const wrongHost = await new Promise((resolve, reject) => {
    require('node:http').get(server.url + '/api/bootstrap', { headers: { Host: 'foreign.invalid' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(server.url + '/api/projects/p1/badcase-evaluations/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url }, body: '{}' })).status, 403);
  assert.equal(h.calls(), 0); assert.equal(fs.existsSync(h.root), false);
});
const confirmation = p => ({ confirmed: true, approvalId: p.approvalId, planHash: p.plan.planHash, reviewHash: p.reviewHash });
test('catalog is scoped and read-only; material preview derives plan and review without exposing paths', t => {
  const h = setup(t);
  assert.deepEqual(h.service.materials('p1'), { mode: 'offline-scripted-workbench', projectId: 'p1', materials: [{ id: 'sample' }], paidAuthorization: false });
  assert.equal(h.service.materials('p2').materials.length, 0); assert.equal(fs.existsSync(h.root), false);
  const p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 });
  assert.equal(p.review.roles.baseline, h.material.roles.baseline); assert.deepEqual(p.review.rule, h.material.rule);
  assert.equal(p.review.task, 'fixed-write-read-edit-bash-v1'); assert.equal(p.review.deliveryMode, 'fresh');
  assert.equal(p.review.planHash, p.plan.planHash); assert.equal(p.reviewHash, hash(JSON.stringify(p.review)));
  assert.equal(p.materialVerified, false); assert.equal(p.paidAuthorization, false);
  assert.doesNotMatch(JSON.stringify(p), /archivePath|captureRoot|recordRoot/);
  assert.equal(JSON.stringify(p).includes(h.root), false); assert.equal(h.calls(), 0); assert.equal(fs.existsSync(h.root), false);
});
test('explicit reviewed approval then start executes both variants and same durable report; no auto launch', async t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p);
  assert.equal(h.calls(), 0); assert.equal(h.service.approve('p1', c).report.consumed, false); assert.equal(h.calls(), 0);
  h.material.roles.candidate = 'Mutated caller'; // registry must be detached
  p.review.roles.candidate = 'Mutated response';
  const result = await h.service.start('p1', c); assert.equal(h.calls(), 2); assert.equal(result.report.reason, 'complete');
  assert.equal(result.materialVerified, false); assert.equal(result.report.ledger.strictEvalEligible, false);
  assert.deepEqual(h.service.admin.read('p1', p.approvalId), result);
  await assert.rejects(h.service.start('p1', c), /evaluation_start_attempted/); assert.equal(h.calls(), 2);
  const restarted = createScriptedWorkbench(h.options);
  assert.deepEqual(restarted.admin.read('p1', p.approvalId), result);
  await assert.rejects(restarted.start('p1', c), /evaluation_review_stale/);
});
test('scope, review hash, plan hash, confirmation and injected paths refuse without execution or approval', async t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p);
  for (const b of [{ ...c, confirmed: false }, { ...c, reviewHash: hash('other') }, { ...c, planHash: hash('other') }, { ...c, root: '/host' }]) {
    assert.throws(() => h.service.approve('p1', b)); await assert.rejects(h.service.start('p1', b));
  }
  assert.throws(() => h.service.approve('p2', c)); await assert.rejects(h.service.start('p2', c));
  assert.throws(() => h.service.preview('p2', { materialId: 'sample', repetitions: 1 }));
  assert.throws(() => h.service.preview('p1', { materialId: 'sample', repetitions: 1, sources: {} }));
  assert.equal(h.calls(), 0); assert.equal(fs.existsSync(h.root), false);
});
test('start without saved approval cannot create it; failed attempt is not retried', async t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p);
  await assert.rejects(h.service.start('p1', c), /evaluation_start_failed/);
  assert.equal(fs.existsSync(h.root), false); assert.equal(h.calls(), 0);
  h.service.approve('p1', c);
  await assert.rejects(h.service.start('p1', c), /evaluation_start_attempted/);
});
test('expired or backwards-time review refuses approval/start and leaves durable record unconsumed', async t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p), now = Date.now;
  h.service.approve('p1', c); t.after(() => { Date.now = now; });
  for (const at of [p.expiresAt, 0]) {
    Date.now = () => at;
    assert.throws(() => h.service.approve('p1', c), /evaluation_review_stale/);
    await assert.rejects(h.service.start('p1', c), /evaluation_review_stale/);
  }
  assert.equal(h.calls(), 0); assert.equal(h.service.admin.read('p1', p.approvalId).report.consumed, false);
});
test('changed archive after review refuses before transport and claim; errors do not expose material paths', async t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p);
  h.service.approve('p1', c); fs.writeFileSync(h.blobPath(h.r.promptBlobHash), 'corrupt');
  await assert.rejects(h.service.start('p1', c), e => e.code === 'evaluation_start_failed' && !e.message.includes(h.root));
  assert.equal(h.calls(), 0); assert.equal(h.service.admin.read('p1', p.approvalId).report.consumed, false);
});
test('saved approval replaced with another valid plan cannot exceed the human-reviewed repetition count', async t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p);
  h.service.approve('p1', c);
  const file = path.join(h.root, hash('p1'), 'evaluations', hash(p.approvalId), 'approval.json');
  const stored = JSON.parse(fs.readFileSync(file));
  stored.spec.repetitions = 2; stored.spec.totalLimitMicroUsd = 4;
  stored.approval.planHash = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan').planEvaluation(stored.spec).planHash;
  fs.writeFileSync(file, JSON.stringify(stored));
  await assert.rejects(h.service.start('p1', c), /evaluation_start_failed/);
  assert.equal(h.calls(), 0); assert.equal(h.service.admin.read('p1', p.approvalId).report.consumed, false);
});
test('one active start per workbench, no queue; duplicate requests never dispatch twice', async t => {
  const h = setup(t); let release, calls = 0;
  h.transport(async () => { calls++; await new Promise(r => { release = r; }); throw Error('PRIVATE-SENTINEL'); });
  const p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p);
  const other = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), d = confirmation(other);
  h.service.approve('p1', c); h.service.approve('p1', d);
  const first = h.service.start('p1', c);
  await assert.rejects(h.service.start('p1', c), /evaluation_start_attempted/);
  await assert.rejects(h.service.start('p1', d), /evaluation_workbench_busy/);
  release(); const result = await first;
  assert.equal(calls, 1); assert.equal(result.report.dispatchState, 'unresolved');
  assert.equal(result.report.ledger.runs[0].costMicroUsd, null); assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SENTINEL/);
});
test('bounded review tickets refuse further preparation, restart drops tickets, no implicit approval', t => {
  const h = setup(t), first = h.service.preview('p1', { materialId: 'sample', repetitions: 1 });
  for (let i = 1; i < 64; i++) h.service.preview('p1', { materialId: 'sample', repetitions: 1 });
  const pins = fs.readdirSync(h.runDir), read = fs.readFileSync; let reads = 0;
  t.after(() => { fs.readFileSync = read; });
  fs.readFileSync = function(...args) { reads++; return read.apply(this, args); };
  assert.throws(() => h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), /evaluation_preview_busy/);
  fs.readFileSync = read;
  assert.equal(reads, 0); assert.deepEqual(fs.readdirSync(h.runDir), pins);
  assert.throws(() => createScriptedWorkbench(h.options).approve('p1', confirmation(first)), /evaluation_review_stale/);
  assert.equal(h.calls(), 0);
});
