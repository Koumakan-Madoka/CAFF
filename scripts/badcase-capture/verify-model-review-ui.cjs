// Real Chromium + isolated review server/storage. Zero model/Docker/agent runs.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { startModelReviewServer } = require('./model-review-server.cjs');
const { entry } = require('../../tests/helpers/badcase-model-review.cjs');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-review-browser-')), root = path.join(temp, 'store'), e = entry();
  let server, browser;
  try {
    assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--tools'));
    const toolsMode = process.argv[2] === '--tools';
    if (toolsMode) {
      e.config.tools = [{ type: 'function', function: { name: 'read', description: 'synthetic read <not-html>',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
      e.spec.model.settingsHash = require('../../build/server/domain/runtime/badcase-capture/model-binding').modelBinding(e.config).bindingHash;
    }
    server = await startModelReviewServer({ root, entries: [e] });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(); let allowed = new URL(server.url).host;
    await context.route('**/*', r => new URL(r.request().url()).host === allowed ? r.continue() : r.abort());
    const page = await context.newPage(), calls = [], errors = [];
    page.on('request', r => { if (r.method() === 'POST') calls.push(new URL(r.url()).pathname); });
    page.on('pageerror', e => errors.push(e.message));
    const el = n => page.locator(`[data-model-${n}]`);
    const status = s => page.waitForFunction(s => document.querySelector('[data-model-status]').textContent.includes(s), s);
    await page.goto(server.url); await status('尚未预览');
    await el('preview').click(); await status('仅预览'); assert.equal(fs.existsSync(root), false);
    assert.match(await el('review').textContent(), /inputMicroUsdPerMillionTokens/);
    if (toolsMode) {
      const preview = JSON.parse(await el('review').textContent());
      assert.deepEqual(preview.binding.config.tools, e.config.tools);
      assert.equal(await page.locator('not-html').count(), 0);
    }
    page.once('dialog', d => { void d.dismiss(); }); await el('approve').click();
    assert.equal(calls.filter(p => p.endsWith('/approve')).length, 0); assert.equal(fs.existsSync(root), false);
    const approvalId = await el('id').inputValue();
    page.once('dialog', d => { void d.accept(); }); await el('approve').click(); await status('已保存');
    const report = JSON.parse(await el('report').textContent());
    assert.equal(report.report.consumed, false); assert.equal(report.launchAvailable, false); assert.equal(report.paidAuthorization, false);
    await server.close(); server = await startModelReviewServer({ root, entries: [] }); allowed = new URL(server.url).host;
    await page.goto(server.url); await status('没有预配置');
    await el('project').fill(e.projectId); await el('id').fill(approvalId); await el('read').click(); await status('只读查询完成');
    assert.deepEqual(JSON.parse(await el('report').textContent()), report);
    assert.equal(await el('approve').isDisabled(), true); assert.deepEqual(errors, []);
    assert.equal(calls.length, 2);
    console.log(JSON.stringify({ ok: true, browser: await browser.version(), previewPosts: 1, approvalPosts: 1, cancelPosts: 0,
      readAfterServerRestart: true, registryRemoved: true, toolsMode, launchAvailable: false, paidAuthorization: false, realModelInvocations: 0, dockerRuns: 0 }));
  } finally {
    if (browser) await browser.close(); if (server) await server.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(() => { console.error('model_review_ui_verification_failed'); process.exitCode = 1; });
