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
test('one active start per workbench, no queue; duplicate requests never dispatch twice', { timeout: 5000 }, async t => {
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
test('confirmed review survives restart without live materials; exact retry preserves bytes, detached preview cannot alter it', t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p);
  const expected = JSON.parse(JSON.stringify(p.review));
  assert.equal(fs.existsSync(h.root), false);
  p.review.roles.candidate = 'caller mutation';
  h.service.approve('p1', c);
  const file = path.join(h.root, hash('p1'), 'reviews', hash(p.approvalId) + '.json');
  const bytes = fs.readFileSync(file);
  h.service.approve('p1', c); assert.deepEqual(fs.readFileSync(file), bytes);
  const restarted = createScriptedWorkbench({ ...h.options, materials: [] });
  const r = restarted.readReview('p1', p.approvalId);
  assert.deepEqual(r.reviewArchive.review, expected); assert.equal(r.reviewArchive.reviewHash, p.reviewHash);
  assert.equal(r.reviewArchive.approvalId, p.approvalId); assert.equal(r.report.consumed, false);
  assert.throws(() => restarted.readReview('p2', p.approvalId));
  assert.equal(h.calls(), 0);
});
test('missing durable review blocks start before claim, old approval report remains readable', async t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p);
  h.service.approve('p1', c);
  const file = path.join(h.root, hash('p1'), 'reviews', hash(p.approvalId) + '.json');
  fs.unlinkSync(file);
  assert.throws(() => h.service.readReview('p1', p.approvalId));
  await assert.rejects(h.service.start('p1', c), /evaluation_start_failed/);
  assert.equal(h.calls(), 0); assert.equal(h.service.admin.read('p1', p.approvalId).report.consumed, false);
});
test('review fsync failure cannot acknowledge approval or expose an orphan as a saved review', t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p);
  const sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error('PRIVATE-SENTINEL'); };
  try { assert.throws(() => h.service.approve('p1', c), /evaluation_review_write_failed/); }
  finally { fs.fsyncSync = sync; }
  assert.throws(() => h.service.admin.read('p1', p.approvalId));
  assert.equal(h.calls(), 0);
});
test('review archive refuses semantic tampering even with recomputed reviewHash; read stays non-mutating', t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 });
  h.service.approve('p1', confirmation(p));
  const file = path.join(h.root, hash('p1'), 'reviews', hash(p.approvalId) + '.json'), original = fs.readFileSync(file);
  const mutations = [v => { v.projectId = 'p2'; }, v => { v.approvalId = '00000000-0000-0000-0000-000000000001'; },
    v => { v.expiresAt++; }, v => { v.createdAt--; v.expiresAt--; }, v => { v.extra = true; }, v => { v.review.roles.candidate += '!'; },
    v => { v.review.rule.expectedHash = hash('changed'); }, v => { v.review.declaredImage.nodeVersion = 'v1.2.3'; },
    v => { v.review.declaredImage.hostPath = '/private'; }, v => { v.review.deliveryMode = 'silent-fresh'; },
    v => { v.review.realModel = true; }, v => { v.review.invocationHash = 'bad'; },
    v => { v.review.planHash = hash('other'); }, v => { v.reviewHash = hash('wrong'); }];
  for (const change of mutations) {
    const v = JSON.parse(original); change(v);
    if (v.reviewHash === p.reviewHash) v.reviewHash = hash(JSON.stringify(v.review));
    const bytes = Buffer.from(JSON.stringify(v)); fs.writeFileSync(file, bytes);
    assert.throws(() => h.service.readReview('p1', p.approvalId), /evaluation_review_invalid/);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
  for (const bytes of [Buffer.from('{'), Buffer.concat([original, Buffer.from([0xff])]), Buffer.alloc(256 * 1024 + 1, 32)]) {
    fs.writeFileSync(file, bytes); assert.throws(() => h.service.readReview('p1', p.approvalId), /evaluation_review_invalid/);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
  fs.writeFileSync(file, original); assert.equal(h.service.readReview('p1', p.approvalId).reviewArchive.reviewHash, p.reviewHash);
});
test('independently valid archive replacement cannot replace the confirmed ticket at start or on approve retry', async t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p);
  h.service.approve('p1', c);
  const file = path.join(h.root, hash('p1'), 'reviews', hash(p.approvalId) + '.json'), v = JSON.parse(fs.readFileSync(file));
  v.review.invocationHash = hash('different-observation'); v.reviewHash = hash(JSON.stringify(v.review));
  fs.writeFileSync(file, JSON.stringify(v));
  assert.throws(() => h.service.approve('p1', c), /evaluation_review_write_failed/);
  await assert.rejects(h.service.start('p1', c), /evaluation_start_failed/);
  assert.equal(h.calls(), 0); assert.equal(h.service.admin.read('p1', p.approvalId).report.consumed, false);
});
test('partial review write is retained, never repaired by retry and never creates approval', t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p), write = fs.writeFileSync;
  fs.writeFileSync = function(fd, ...args) { if (typeof fd === 'number') { write(fd, '{'); throw Error('PRIVATE-SENTINEL'); } return write(fd, ...args); };
  try { assert.throws(() => h.service.approve('p1', c), /evaluation_review_write_failed/); }
  finally { fs.writeFileSync = write; }
  const file = path.join(h.root, hash('p1'), 'reviews', hash(p.approvalId) + '.json');
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
  assert.throws(() => h.service.approve('p1', c), /evaluation_review_write_failed/);
  assert.throws(() => h.service.admin.read('p1', p.approvalId)); assert.equal(fs.readFileSync(file, 'utf8'), '{');
});
test('archive validation rejects secret-bearing and invalid role bytes before any directory write', t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 });
  const { saveReviewArchive } = require('../../scripts/badcase-capture/review-archive.cjs');
  const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
  for (const role of ['sk-synthetic-test-only-123456', 'password=\nsynthetic-only-value', '\ud800', 'x'.repeat(16385), '\0x']) {
    const review = structuredClone(p.review), spec = structuredClone(p.plan.spec);
    review.roles.candidate = role; spec.candidateRoleHash = hash(role); review.planHash = planEvaluation(spec).planHash;
    const v = { schemaVersion: 1, projectId: 'p1', approvalId: p.approvalId, materialId: 'sample', createdAt: p.createdAt,
      expiresAt: p.expiresAt, reviewHash: hash(JSON.stringify(review)), review };
    assert.throws(() => saveReviewArchive(h.root, v, spec), /evaluation_review_invalid/);
    assert.equal(fs.existsSync(h.root), false);
  }
});
test('expiry during review fsync leaves an unapproved orphan; GET never promotes it', t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p), sync = fs.fsyncSync, now = Date.now;
  fs.fsyncSync = fd => { sync(fd); Date.now = () => p.expiresAt; };
  try { assert.throws(() => h.service.approve('p1', c), /evaluation_preview_stale/); }
  finally { fs.fsyncSync = sync; Date.now = now; }
  assert.throws(() => h.service.readReview('p1', p.approvalId)); assert.equal(h.calls(), 0);
});
test('review own directories and file refuse symlinks without decoy writes', async t => {
  const h = setup(t), p = h.service.preview('p1', { materialId: 'sample', repetitions: 1 }), c = confirmation(p);
  h.service.approve('p1', c);
  const dir = path.join(h.root, hash('p1'), 'reviews'), file = path.join(dir, hash(p.approvalId) + '.json');
  const bytes = fs.readFileSync(file), decoy = path.join(path.dirname(h.root), 'review-decoy'); fs.mkdirSync(decoy);
  fs.writeFileSync(path.join(decoy, path.basename(file)), bytes);
  fs.renameSync(dir, dir + '-saved'); fs.symlinkSync(decoy, dir, 'junction');
  assert.throws(() => h.service.readReview('p1', p.approvalId), /evaluation_review_invalid/);
  assert.throws(() => h.service.approve('p1', c), /evaluation_review_write_failed/);
  fs.unlinkSync(dir); fs.renameSync(dir + '-saved', dir);
  fs.unlinkSync(file);
  try { fs.symlinkSync(path.join(decoy, path.basename(file)), file, 'file'); }
  catch (e) { if (e.code === 'EPERM') { t.diagnostic('file symlink unavailable; directory junction assertions executed'); return; } throw e; }
  assert.throws(() => h.service.readReview('p1', p.approvalId), /evaluation_review_invalid/);
  assert.throws(() => h.service.approve('p1', c), /evaluation_review_write_failed/);
  await assert.rejects(h.service.start('p1', c), /evaluation_start_failed/);
  assert.equal(h.calls(), 0); assert.deepEqual(fs.readFileSync(path.join(decoy, path.basename(file))), bytes);
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
