// Synthetic UI/controller/storage integration only; no Docker, SQLite, capture,
// SDK or model. Loopback port 0, disposable storage, outbound browser requests denied.
// npm run build && node scripts/badcase-capture/verify-evaluation-admin-ui.cjs
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { createBadcaseEvaluationsController } = require('../../build/server/api/badcase-evaluations-controller');
const { createEvaluationAdminService } = require('../../build/server/domain/runtime/badcase-capture/evaluation-admin');
const { dispatchRecordedEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-record');
const { spec, hash } = require('../../tests/helpers/badcase-offline-spec.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-evaluation-browser-'));
let server, browser, controller, authority;
const calls = [], errors = [];
function rebuild() {
  controller = createBadcaseEvaluationsController({ service: createEvaluationAdminService({ root }), host: '127.0.0.1',
    getAuthority: () => authority, csrfToken: 'synthetic-browser-only', projectManager: { listProjects: () => [{ id: 'p1' }] } });
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><script src="/shared/api-client.js"></script><script src="/shared/badcase-evaluations.js"></script><div id="panel"></div><script>const panel=CaffShared.createBadcaseEvaluationPanel({root:document.querySelector('#panel'),fetchJson:CaffShared.fetchJson});panel.select({id:'p1'});</script></html>`;
(async () => {
  try {
    server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://test').pathname;
      const json = (v, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
      try {
        if (pathname === '/api/bootstrap') return json({ localAdmin: { modelProviders: { enabled: true, csrfToken: 'synthetic-browser-only' } } });
        if (pathname.startsWith('/api/projects/')) { calls.push({ method: req.method, pathname }); if (await controller({ req, res, pathname })) return; }
        if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
        if (['/shared/api-client.js', '/shared/badcase-evaluations.js'].includes(pathname)) {
          res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(path.resolve(__dirname, '../../public', pathname.slice(1))));
        }
        res.writeHead(404); res.end();
      } catch (e) { json({ issues: e.issues || [] }, e.statusCode || 500); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); authority = `127.0.0.1:${server.address().port}`; rebuild();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route('**/*', r => new URL(r.request().url()).host === authority ? r.continue() : r.abort());
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const el = name => page.locator(`[data-eval-${name}]`);
    const status = text => page.waitForFunction(t => document.querySelector('[data-eval-status]').textContent.includes(t), text);
    await page.goto(`http://${authority}/`); await status('尚未预览');
    await el('spec').fill(JSON.stringify(spec())); await el('preview').click(); await status('仅预览');
    assert.deepEqual(fs.readdirSync(root), []);
    page.once('dialog', d => { void d.dismiss(); }); await el('approve').click();
    assert.equal(calls.filter(c => c.pathname.endsWith('/approve')).length, 0);
    assert.deepEqual(fs.readdirSync(root), []);
    const approvalId = await el('id').inputValue();
    page.once('dialog', d => { void d.accept(); }); await el('approve').click(); await status('批准声明已保存');
    assert.equal(calls.filter(c => c.pathname.endsWith('/approve')).length, 1);
    assert.match(await el('report').textContent(), /"consumed": false/);
    // Synthetic executor writes two structured scores, NOT Docker/model evidence.
    await dispatchRecordedEvaluation(path.join(root, hash('p1')), approvalId, async r => ({ runId: r.runId,
      status: 'completed', costMicroUsd: 0, outputHash: hash(r.variant), score: { expectationMet: true, badcaseReproduced: false } }));
    rebuild(); await page.reload(); await status('尚未预览');
    await el('id').fill(approvalId); await el('read').click(); await status('只读查询完成');
    assert.match(await el('report').textContent(), /"plannedRuns": 2/);
    assert.match(await el('report').textContent(), /"state": "complete"/);
    assert.match(await el('report').textContent(), /"strictEvalEligible": false/);
    assert.equal(calls.filter(c => c.method === 'POST').length, 2);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, browser: await browser.version(), previewPosts: 1, approvalPosts: 1,
      cancelApprovalPosts: 0, reportsAfterRebuild: 1, syntheticScoredRuns: 2, realModelInvocations: 0,
      dockerRuns: 0, fullAppShell: false, acceptance: false }));
  } finally {
    if (browser) await browser.close();
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(() => { console.error('evaluation_admin_browser_verification_failed'); process.exitCode = 1; });
