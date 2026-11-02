const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { entry } = require('../helpers/badcase-model-review.cjs');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const { modelBinding } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const tick = () => new Promise(r => setImmediate(r));
function setup(t) {
  const dom = new JSDOM('<div id="panel"></div>', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  dom.window.eval(fs.readFileSync(require.resolve('../../public/shared/model-review.js'), 'utf8'));
  const e = entry(), root = dom.window.document.querySelector('#panel'), calls = []; let accept = true;
  const flags = { projectId: e.projectId, mode: 'model-configuration-review', launchAvailable: false, paidAuthorization: false, materialVerified: false, executionVerified: false, strictEvalEligible: false };
  const p = { ...flags, entryId: e.id, plan: planEvaluation(e.spec), binding: modelBinding(e.config), approvalId: '00000000-0000-0000-0000-000000000001', expiresAt: Date.now() + 60000 };
  const report = { ...flags, binding: p.binding, report: { approval: { approvalId: p.approvalId, planHash: p.plan.planHash }, ledger: { spec: p.plan.spec } } };
  const panel = dom.window.CaffShared.createModelReviewPanel({ root, confirm: () => accept, fetchJson: async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url === '/api/bootstrap') return { projects: [e.projectId], localAdmin: { modelProviders: { enabled: true, csrfToken: 'synthetic' } } };
    if (url.endsWith('/entries')) return { ...flags, entries: [{ id: e.id }] };
    return structuredClone(url.endsWith('/preview') ? p : report);
  } });
  const el = n => root.querySelector(`[data-model-${n}]`);
  return { dom, root, panel, p, report, calls, el, accept: v => { accept = v; }, click: async n => { el(n).click(); await tick(); } };
}
test('full config text-safe preview, cancel zero approval POST, exact dual hashes and CSRF on confirmation; no launch', async t => {
  const h = setup(t); h.p.plan.spec.caseId = '<img src=x onerror=alert(1)>';
  await h.panel.load(); await h.click('preview');
  assert.equal(h.root.querySelector('img'), null); assert.match(h.el('review').textContent, /inputMicroUsdPerMillionTokens/);
  assert.match(h.el('review').textContent, /contextWindowTokens/); assert.match(h.el('review').textContent, /totalLimitMicroUsd/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1).body)), { entryId: h.p.entryId });
  h.accept(false); await h.click('approve'); assert.equal(h.calls.filter(c => c.url.endsWith('/approve')).length, 0);
  h.accept(true); await h.click('approve');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1).body)), { confirmed: true, approvalId: h.p.approvalId, planHash: h.p.plan.planHash, bindingHash: h.p.binding.bindingHash });
  assert.equal(h.calls.at(-1).headers['X-CAFF-CSRF-Token'], 'synthetic'); assert.match(h.el('status').textContent, /已保存/);
  assert.equal(h.root.querySelector('[data-model-start]'), null);
});
test('changed fields/expiry invalidate ticket; historical read cannot restore confirmation', async t => {
  const h = setup(t); await h.panel.load(); await h.click('preview');
  h.el('entry').dispatchEvent(new h.dom.window.Event('change')); assert.equal(h.el('approve').disabled, true);
  await h.click('preview'); h.dom.window.Date.now = () => h.p.expiresAt;
  const n = h.calls.length; await h.click('approve'); assert.equal(h.calls.length, n); assert.equal(h.el('approve').disabled, true);
  await h.click('read'); assert.equal(h.calls.at(-1).method, undefined); assert.equal(h.el('approve').disabled, true);
  assert.match(h.el('report').textContent, /"paidAuthorization": false/);
});
test('wrong project/binding/permission/expired previews fail closed and render no review', async t => {
  for (const change of [p => { p.projectId = 'other'; }, p => { p.binding.bindingHash = '0'.repeat(64); }, p => { p.paidAuthorization = true; },
    p => { p.launchAvailable = true; }, p => { p.materialVerified = true; }, p => { p.expiresAt = 0; }, p => { p.entryId = 'other'; }]) {
    const h = setup(t); change(h.p); await h.panel.load(); await h.click('preview');
    assert.equal(h.el('approve').disabled, true); assert.equal(h.el('review').textContent, '');
  }
});
test('production does not load review page or compose review capability', () => {
  assert.doesNotMatch(fs.readFileSync(require.resolve('../../public/projects.html'), 'utf8'), /model-review/);
  assert.doesNotMatch(fs.readFileSync(require.resolve('../../server/app/create-server.ts'), 'utf8'), /model-review|createModelReviewService/);
});
