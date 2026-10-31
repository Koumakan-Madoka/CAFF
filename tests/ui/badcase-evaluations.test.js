const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const { spec } = require('../helpers/badcase-offline-spec.cjs');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const tick = () => new Promise(r => setImmediate(r));
const id = '00000000-0000-0000-0000-000000000001';
function setup(t, handler) {
  const dom = new JSDOM('<div id="panel"></div>', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/badcase-evaluations.js'), 'utf8'));
  const root = dom.window.document.querySelector('#panel'), calls = [], confirmations = []; let accept = true;
  const envelope = { projectId: 'p1', mode: 'offline-scripted-declaration', launchAvailable: false, paidAuthorization: false, materialVerified: false };
  const preview = { ...envelope, approvalId: id, expiresAt: Date.now() + 60000, plan: planEvaluation(spec()) };
  const result = { ...envelope, report: { approval: { approvalId: id, planHash: preview.plan.planHash }, dispatchState: 'approved', reason: null,
    ledger: { executionVerified: false, strictEvalEligible: false, runs: [], knownCostMicroUsd: 0, unknownCostRuns: 0 } } };
  const panel = dom.window.CaffShared.createBadcaseEvaluationPanel({ root,
    confirm: text => { confirmations.push(text); return accept; },
    fetchJson: async (url, o = {}) => { calls.push({ url, ...o }); const custom = handler?.(url, o); if (custom !== undefined) return custom;
      if (url === '/api/bootstrap') return { localAdmin: { modelProviders: { enabled: true, csrfToken: 'test-only' } } };
      return url.endsWith('/preview') ? structuredClone(preview) : structuredClone(result);
    } });
  const el = name => root.querySelector(`[data-eval-${name}]`);
  return { dom, root, panel, calls, confirmations, preview, result, el, accept: v => { accept = v; },
    fill: () => { el('spec').value = JSON.stringify(spec()); el('spec').dispatchEvent(new dom.window.Event('input')); },
    click: async name => { el(name).click(); await tick(); } };
}
test('no approval on load/preview/cancel; explicit confirm sends only binding and CSRF', async t => {
  const h = setup(t); await h.panel.select({ id: 'p1' }); h.fill();
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  await h.click('preview'); assert.equal(h.el('approve').disabled, false);
  assert.match(h.el('plan').textContent, /tool-loop-v1/); assert.match(h.el('plan').textContent, /25000/);
  h.accept(false); await h.click('approve'); assert.equal(h.calls.length, 2);
  h.accept(true); await h.click('approve');
  const req = h.calls.at(-1); assert.equal(req.url, '/api/projects/p1/badcase-evaluations/approve');
  assert.deepEqual(JSON.parse(JSON.stringify(req.body)), { confirmed: true, approvalId: id, planHash: h.preview.plan.planHash });
  assert.equal(req.headers['X-CAFF-CSRF-Token'], 'test-only'); assert.match(h.el('status').textContent, /未启动任务/);
  assert.match(h.confirmations[0], /不启动任务或付费/);
});
test('editing invalidates preview, expired preview cannot approve, no automatic POST retries', async t => {
  const h = setup(t); await h.panel.select({ id: 'p1' }); h.fill(); await h.click('preview');
  h.fill(); assert.equal(h.el('approve').disabled, true);
  await h.click('preview'); const clock = h.dom.window.Date.now; h.dom.window.Date.now = () => h.preview.expiresAt;
  await h.click('approve'); h.dom.window.Date.now = clock;
  assert.equal(h.calls.filter(c => c.url.endsWith('/approve')).length, 0); assert.match(h.el('status').textContent, /过期/);
});
test('late preview after project switch cannot enable approval for new project', async t => {
  let resolve; const wait = new Promise(r => { resolve = r; });
  const h = setup(t, url => url.endsWith('/preview') ? wait : undefined);
  await h.panel.select({ id: 'p1' }); h.fill(); await h.click('preview');
  await h.panel.select({ id: 'p2' }); resolve(h.preview); await tick();
  assert.equal(h.el('approve').disabled, true); assert.equal(h.el('plan').textContent, ''); assert.equal(h.el('id').value, '');
});
test('lost confirmation response retains query ID and never auto-retries', async t => {
  const h = setup(t, url => url.endsWith('/approve') ? Promise.reject(Error('private-server-error')) : undefined);
  await h.panel.select({ id: 'p1' }); h.fill(); await h.click('preview'); await h.click('approve');
  assert.equal(h.calls.filter(c => c.url.endsWith('/approve')).length, 1);
  assert.equal(h.el('id').value, id); assert.match(h.el('status').textContent, /结果未知/); assert.doesNotMatch(h.root.textContent, /private-server-error/);
  await h.click('read'); assert.equal(h.calls.at(-1).method, undefined); assert.match(h.el('report').textContent, /approved/);
});
test('unresolved/unknown result is text, not HTML or zero-cost success', async t => {
  const h = setup(t); h.result.report.dispatchState = 'unresolved'; h.result.report.reason = '<img src=x onerror=alert(1)>';
  h.result.report.ledger.runs = [{ costMicroUsd: null, score: null, status: 'reserved' }];
  await h.panel.select({ id: 'p1' }); h.el('id').value = id; await h.click('read');
  assert.equal(h.root.querySelector('img'), null); assert.match(h.el('report').textContent, /unresolved/);
  assert.match(h.el('report').textContent, /null 表示未知，不是 0/); assert.match(h.el('report').textContent, /"costMicroUsd": null/);
});
test('wrong project, claimed verification or unavailable admin fails closed', async t => {
  for (const change of [{ projectId: 'other' }, { launchAvailable: true }, { paidAuthorization: true }, { materialVerified: true }]) {
    const h = setup(t); Object.assign(h.preview, change); await h.panel.select({ id: 'p1' }); h.fill(); await h.click('preview');
    assert.equal(h.el('approve').disabled, true); assert.match(h.el('status').textContent, /失败/);
  }
  const h = setup(t, () => ({ localAdmin: {} })); await h.panel.select({ id: 'p1' });
  assert.equal(h.el('preview').disabled, true);
});
test('report for another approval or changed plan is never shown as confirmation success', async t => {
  for (const change of [{ approvalId: '00000000-0000-0000-0000-000000000002' }, { planHash: '0'.repeat(64) }]) {
    const h = setup(t); Object.assign(h.result.report.approval, change);
    await h.panel.select({ id: 'p1' }); h.fill(); await h.click('preview'); await h.click('approve');
    assert.equal(h.el('report').textContent, ''); assert.match(h.el('status').textContent, /结果未知/);
  }
});
test('projects page retains capture only, without the legacy offline evaluation panel', () => {
  const root = path.resolve(__dirname, '../../public');
  const html = fs.readFileSync(path.join(root, 'projects.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'projects.js'), 'utf8');
  assert.doesNotMatch(html + script, /badcase-evaluations|evaluationPanel|createBadcaseEvaluationPanel/);
  assert.match(html, /shared\/badcase-capture.js/);
  assert.match(script, /capturePanel.select\(selected\)/);
});
