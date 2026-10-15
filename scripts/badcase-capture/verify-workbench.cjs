// --browser: real Chromium + synthetic executor (zero Docker/model).
// Dedicated daemon arguments: real HTTP -> Docker; --browser-docker adds real
// browser interaction in the same run. Never uses shared-daemon containers or
// real models. All modes use disposable synthetic capture material.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const fixture = require('../../tests/helpers/badcase-initialization-fixture.cjs');
const { hash } = require('../../tests/helpers/badcase-offline-spec.cjs');
const { archiveRuntime } = require('./runtime-archive.cjs');
const { archiveHarness } = require('./harness-archive.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { startScriptedWorkbenchServer } = require('./workbench-server.cjs');
function verificationMode(args) {
  const synthetic = args.includes('--browser'), joint = args.includes('--browser-docker');
  assert.ok(!(synthetic && joint));
  return { browserMode: synthetic || joint, synthetic, joint };
}
function isolatedBrowserOptions(root, executable, libraries, ownNamespace, parentNamespace, fontconfig) {
  assert.ok(path.isAbsolute(executable) && path.isAbsolute(libraries));
  assert.ok(parentNamespace && ownNamespace && ownNamespace !== parentNamespace);
  if (fontconfig !== undefined) assert.ok(path.isAbsolute(fontconfig));
  return { headless: true, timeout: 15000, executablePath: executable,
    // Trusted synthetic page only. Playwright's default root/no-sandbox launch is
    // not a browser OS sandbox. Network namespace + request routing restrict I/O.
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'C.UTF-8', LD_LIBRARY_PATH: libraries,
      ...(fontconfig === undefined ? {} : { FONTCONFIG_FILE: fontconfig }) } };
}
function assertExecutionEvidence({ synthetic, joint, browserVersion, calls, ids }) {
  assert.equal(calls.length, 4); assert.equal(new Set(calls).size, 4);
  if (joint) { assert.equal(synthetic, false); assert.ok(browserVersion); }
  if (!synthetic) {
    assert.equal(ids.length, 4); assert.equal(new Set(ids).size, 4);
    assert.ok(ids.every(id => /^[a-f0-9]{64}$/.test(id)));
  }
}
let verificationStage = 'prepare';
async function main() {
  const args = process.argv.slice(2), { browserMode, synthetic, joint } = verificationMode(args);
  const arg = name => { const i = args.indexOf('--' + name); assert.ok(i >= 0 && args[i + 1]); return args[i + 1]; };
  const root = synthetic ? fs.mkdtempSync(path.join(os.tmpdir(), 'caff-workbench-ui-')) : path.join(arg('data-root'), '..', 'artifacts');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const cleanup = [], ids = [], reports = [], calls = [];
  let server, browser, identity = null, archiveBytes = null;
  try {
    const image = synthetic ? { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' }
      : { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
    let transport;
    if (!synthetic) {
      const { archiveImage } = require('./image-archive.cjs'), { restoreImageArchive } = require('./image-recovery.cjs');
      const ref = await archiveImage(image, path.join(root, 'image'));
      const restored = await restoreImageArchive(ref, { socket: arg('socket'), daemonId: arg('daemon-id'), dataRoot: arg('data-root') });
      identity = restored.identity; archiveBytes = ref.archiveBytes; transport = restored.runProbe;
    } else transport = async (_, files) => {
      const manifest = manifestFor(files), q = JSON.parse(files.find(f => f.path === 'task.json').bytes);
      return { containerId: 'a'.repeat(64), manifest, result: { code: 0, stderr: '', stdout: JSON.stringify({ kind: 'scripted-sdk-task-v1', runId: q.runId, roleHash: hash(q.role),
        capsuleHash: q.capsuleHash, inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, deliveryMode: q.deliveryMode,
        invocationHash: q.invocationHash, historyHash: q.historyHash, scriptCalls: 5, networkCalls: 0, toolNames: ['write', 'read', 'edit', 'bash'], artifactBase64: Buffer.from('done\n').toString('base64') }) } };
    };
    const repo = path.resolve(__dirname, '../..');
    const sources = { runtimeArchive: archiveRuntime(repo, path.join(root, 'runtime')), harnessArchive: archiveHarness(repo, path.join(root, 'harness')) };
    const fixtures = ['fresh', 'resume'].map(mode => fixture({ after: f => cleanup.push(f) }, mode));
    const materials = fixtures.map((h, i) => ({ id: i ? 'resume' : 'fresh', projectId: 'p1', request: h.request, image, sources,
      roles: { baseline: 'Synthetic baseline <b>literal text</b>.', candidate: 'Synthetic candidate.' }, rule: { expectedHash: hash('done\n'), badcaseHash: hash('draft\n') } }));
    const originalBlobs = fixtures.map(h => fs.readFileSync(h.blobPath(h.r.promptBlobHash)));
    for (const h of fixtures) fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
    const options = { root: path.join(root, 'approvals'), materials, runProbe: async (img, files, executionOptions) => {
      assert.deepEqual(executionOptions, { timeoutMs: 25000 });
      calls.push(JSON.parse(files.find(f => f.path === 'task.json').bytes).runId);
      const r = await transport(img, files, executionOptions); if (!synthetic) ids.push(r.containerId); return r;
    } };
    server = await startScriptedWorkbenchServer(options);
    async function api(action, body) {
      const bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
      const response = await fetch(server.url + '/api/projects/p1/badcase-evaluations/' + action, { method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', Origin: server.url, 'X-CAFF-CSRF-Token': bootstrap.localAdmin.modelProviders.csrfToken },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
      return { status: response.status, body: await response.json() };
    }
    const canceledPosts = { approve: 0, start: 0 }; let browserVersion = null;
    if (browserMode) {
      verificationStage = 'browser-launch';
      const { chromium } = require('playwright-core');
      const profileRoot = path.join(root, 'browser'); fs.mkdirSync(profileRoot, { mode: 0o700 });
      const launchOptions = joint ? isolatedBrowserOptions(profileRoot, arg('browser-executable'), arg('browser-library-dir'),
        fs.readlinkSync('/proc/self/ns/net'), arg('parent-netns'),
        args.includes('--browser-fontconfig') ? arg('browser-fontconfig') : undefined) : { headless: true };
      browser = await chromium.launch(launchOptions); browserVersion = await browser.version();
      const context = await browser.newContext(), page = await context.newPage(), errors = [], posts = [];
      await context.route('**/*', r => new URL(r.request().url()).origin === server.url ? r.continue() : r.abort());
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
      verificationStage = 'browser-preview';
      await page.goto(server.url);
      const el = n => page.locator(`[data-work-${n}]`), status = text => page.waitForFunction(t => document.querySelector('[data-work-status]').textContent.includes(t), text, { timeout: 120000 });
      await status('尚未预览');
      for (const m of materials) {
        await el('material').selectOption(m.id); await el('preview').click(); await status('材料预览完成');
        assert.match(await el('review').textContent(), /expectedHash/); assert.equal(await page.locator('#panel b').count(), 0);
        verificationStage = 'browser-approve';
        let before = posts.length;
        page.once('dialog', d => { void d.dismiss(); }); await el('approve').click(); assert.equal(posts.length, before);
        page.once('dialog', d => { void d.accept(); }); await el('approve').click(); await status('声明已保存');
        verificationStage = 'browser-start';
        before = posts.length;
        page.once('dialog', d => { void d.dismiss(); }); await el('start').click(); assert.equal(posts.length, before);
        page.once('dialog', d => { void d.accept(); }); await el('start').click(); await status('启动请求已返回');
        verificationStage = 'browser-report';
        const approvalId = await el('id').inputValue(), report = JSON.parse(await el('report').textContent());
        assert.equal(report.reason, 'complete'); assert.equal(await el('start').isDisabled(), true);
        const savedReview = await api('reviews/' + approvalId); assert.equal(savedReview.status, 200);
        assert.deepEqual(savedReview.body.reviewArchive.review.roles, m.roles);
        reports.push({ approvalId, report, reviewArchive: savedReview.body.reviewArchive });
      }
      assert.equal(posts.filter(u => u.endsWith('/material-preview')).length, 2);
      assert.equal(posts.filter(u => u.endsWith('/material-approve')).length, 2);
      assert.equal(posts.filter(u => u.endsWith('/start')).length, 2);
      assert.deepEqual(errors, []); await context.close();
    } else {
      const catalog = await api('materials'); assert.equal(catalog.status, 200); assert.equal(catalog.body.materials.length, 2);
      for (const m of materials) {
        const p = await api('material-preview', { materialId: m.id, repetitions: 1 }); assert.equal(p.status, 200);
        assert.deepEqual(p.body.review.roles, m.roles); assert.deepEqual(p.body.review.rule, m.rule);
        assert.equal(p.body.review.deliveryMode, m.id);
        const c = { confirmed: true, approvalId: p.body.approvalId, planHash: p.body.plan.planHash, reviewHash: p.body.reviewHash };
        assert.equal((await api('material-approve', { ...c, reviewHash: '0'.repeat(64) })).status, 409);
        assert.equal((await api('material-approve', c)).status, 200);
        assert.equal((await api('start', { ...c, root: '/host' })).status, 422);
        const r = await api('start', c); assert.equal(r.status, 200); assert.equal(r.body.report.reason, 'complete');
        assert.equal((await api('start', c)).status, 409);
        assert.deepEqual((await api('records/' + c.approvalId)).body, r.body);
        const savedReview = await api('reviews/' + c.approvalId); assert.equal(savedReview.status, 200);
        assert.deepEqual(savedReview.body.reviewArchive.review, p.body.review);
        assert.equal(savedReview.body.reviewArchive.reviewHash, c.reviewHash);
        reports.push({ approvalId: c.approvalId, report: r.body.report, reviewArchive: savedReview.body.reviewArchive });
      }
    }
    verificationStage = 'rebuild';
    await server.close();
    // Registry changes do not rewrite or reconstruct historical review text.
    const changed = materials.map(m => ({ ...m, roles: { baseline: 'Later baseline', candidate: 'Later candidate' } }));
    server = await startScriptedWorkbenchServer({ ...options, materials: changed });
    for (const r of reports) {
      assert.deepEqual((await api('records/' + r.approvalId)).body.report, r.report);
      assert.deepEqual((await api('reviews/' + r.approvalId)).body.reviewArchive, r.reviewArchive);
      assert.equal((await api('start', { confirmed: true, approvalId: r.approvalId, planHash: r.report.approval.planHash, reviewHash: '0'.repeat(64) })).status, 409);
      assert.equal(r.report.ledger.strictEvalEligible, false);
      assert.equal(r.report.ledger.summary.baseline.expectationMet, 1); assert.equal(r.report.ledger.summary.candidate.expectationMet, 1);
      assert.equal(r.report.ledger.summary.baseline.reproduced, 0); assert.equal(r.report.ledger.summary.candidate.reproduced, 0);
    }
    if (browserMode) {
      const context = await browser.newContext(), page = await context.newPage();
      await context.route('**/*', r => new URL(r.request().url()).origin === server.url ? r.continue() : r.abort());
      await page.goto(server.url);
      await page.waitForFunction(() => document.querySelector('[data-work-status]').textContent.includes('尚未预览'));
      for (const r of reports) {
        await page.locator('[data-work-id]').fill(r.approvalId); await page.locator('[data-work-read]').click();
        await page.waitForFunction(() => document.querySelector('[data-work-status]').textContent.includes('只读查询完成'));
        assert.deepEqual(JSON.parse(await page.locator('[data-work-report]').textContent()), r.report);
        await page.locator('[data-work-archive]').click();
        await page.waitForFunction(id => {
          try { return JSON.parse(document.querySelector('[data-work-review]').textContent).approvalId === id; } catch { return false; }
        }, r.approvalId);
        assert.deepEqual(JSON.parse(await page.locator('[data-work-review]').textContent()), r.reviewArchive);
        assert.equal(await page.locator('#panel b').count(), 0);
        assert.equal(await page.locator('[data-work-start]').isDisabled(), true);
        assert.equal(await page.locator('[data-work-approve]').isDisabled(), true);
      }
      await context.close();
    }
    fixtures.forEach((h, i) => { assert.deepEqual(fs.readFileSync(h.blobPath(h.r.promptBlobHash)), originalBlobs[i]); assert.equal(fs.readdirSync(h.runDir).length, 3); });
    verificationStage = 'evidence';
    assertExecutionEvidence({ synthetic, joint, browserVersion, calls, ids });
    assert.deepEqual(reports.flatMap(r => r.report.ledger.runs.map(run => run.runId)), calls);
    console.log(JSON.stringify({ ok: true, kind: 'offline-scripted-workbench', browser: browserVersion, browserExecutorSynthetic: synthetic,
      sameRunBrowserDocker: joint, isolatedBrowserNetwork: joint, observedRunIds: calls,
      realModelInvocations: 0, humanApproval: false, acceptance: false, productionLaunchAvailable: false,
      browserCancelApprovePosts: browserMode ? canceledPosts.approve : null, browserCancelStartPosts: browserMode ? canceledPosts.start : null,
      identity, archiveBytes, cleanedContainerIds: ids, reportReadAfterRebuild: true, reviewReadAfterRebuild: true, changedRegistryIgnored: true, sourceBlobsUnchanged: true,
      reports: reports.map(r => ({ approvalId: r.approvalId, reason: r.report.reason, summary: r.report.ledger.summary })) }));
  } finally {
    if (browser) await browser.close(); if (server) await server.close();
    for (const fn of cleanup.reverse()) fn();
    if (synthetic) fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { verificationMode, isolatedBrowserOptions, assertExecutionEvidence };
if (require.main === module) main().catch(() => { console.error('workbench_verification_failed:' + verificationStage); process.exitCode = 1; });
