const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { spec, hash } = require('../helpers/badcase-offline-spec.cjs');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const tick = () => new Promise(r => setImmediate(r));
function setup(t, handler) {
  const dom = new JSDOM('<div id="panel"></div>', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  dom.window.eval(fs.readFileSync(require.resolve('../../public/shared/badcase-workbench.js'), 'utf8'));
  const root = dom.window.document.querySelector('#panel'), calls = [], id = '00000000-0000-0000-0000-000000000001'; let accept = true;
  const envelope = { projectId: 'p1', mode: 'offline-scripted-declaration', launchAvailable: false, materialVerified: false, paidAuthorization: false };
  const plan = planEvaluation(spec()), review = { planHash: plan.planHash, realModel: false, faithfulReplay: false,
    roles: { baseline: '<img src=x onerror=alert(1)>', candidate: 'Candidate' }, rule: { expectedHash: hash('done'), badcaseHash: hash('draft') } };
  const p = { ...envelope, materialId: 'sample', approvalId: id, expiresAt: Date.now() + 60000, plan, review, reviewHash: hash(JSON.stringify(review)) };
  const result = { ...envelope, report: { approval: { approvalId: id, planHash: plan.planHash }, consumed: false,
    ledger: { executionVerified: false, strictEvalEligible: false, runs: [] }, dispatchState: 'approved' } };
  const panel = dom.window.CaffShared.createScriptedWorkbenchPanel({ root, confirm: () => accept,
    fetchJson: async (url, options = {}) => {
      calls.push({ url, ...options }); const custom = handler?.(url, options); if (custom !== undefined) return custom;
      if (url === '/api/bootstrap') return { localAdmin: { modelProviders: { enabled: true, csrfToken: 'test-only' } } };
      if (url.endsWith('/materials')) return { projectId: 'p1', mode: 'offline-scripted-workbench', paidAuthorization: false, materials: [{ id: 'sample' }] };
      return structuredClone(url.endsWith('/material-preview') ? p : result);
    } });
  const el = name => root.querySelector(`[data-work-${name}]`);
  return { dom, root, panel, p, result, calls, el, accept: value => { accept = value; }, click: async n => { el(n).click(); await tick(); } };
}
test('material ID only preview, text-safe review, separate approve and start confirmations; cancels do not post', async t => {
  const h = setup(t); await h.panel.select({ id: 'p1' }); assert.equal(h.calls.length, 2);
  await h.click('preview'); assert.equal(h.el('start').disabled, true); assert.equal(h.root.querySelector('img'), null);
  assert.match(h.el('review').textContent, /expectedHash/); assert.match(h.el('review').textContent, /tool-loop-v1/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1).body)), { materialId: 'sample', repetitions: 1 });
  h.accept(false); await h.click('approve'); assert.equal(h.calls.length, 3);
  h.accept(true); await h.click('approve'); assert.equal(h.el('start').disabled, false);
  h.accept(false); await h.click('start'); assert.equal(h.calls.length, 4);
  h.accept(true); await h.click('start'); assert.equal(h.calls.length, 5); assert.equal(h.el('start').disabled, true);
  const request = h.calls.at(-1); assert.equal(request.url.endsWith('/start'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)), { confirmed: true, approvalId: h.p.approvalId, planHash: h.p.plan.planHash, reviewHash: h.p.reviewHash });
  assert.equal(request.headers['X-CAFF-CSRF-Token'], 'test-only');
});
test('editing invalidates approval, expiry prevents posts, late responses cannot authorize another project', async t => {
  const h = setup(t); await h.panel.select({ id: 'p1' }); await h.click('preview'); await h.click('approve');
  h.el('repetitions').dispatchEvent(new h.dom.window.Event('input')); assert.equal(h.el('start').disabled, true);
  await h.click('preview'); h.dom.window.Date.now = () => h.p.expiresAt;
  const count = h.calls.length; await h.click('approve'); assert.equal(h.calls.length, count); assert.match(h.el('status').textContent, /过期/);
  let release; const delayed = setup(t, url => url.endsWith('/material-preview') ? new Promise(r => { release = r; }) : undefined);
  await delayed.panel.select({ id: 'p1' }); await delayed.click('preview'); await delayed.panel.select(null);
  release(delayed.p); await tick(); assert.equal(delayed.el('approve').disabled, true); assert.equal(delayed.el('id').value, '');
});
test('lost start response never retries or reenables start; read ID retained and unknown costs stay unknown', async t => {
  const h = setup(t, url => url.endsWith('/start') ? Promise.reject(Error('PRIVATE-SENTINEL')) : undefined);
  await h.panel.select({ id: 'p1' }); await h.click('preview'); await h.click('approve'); await h.click('start');
  assert.equal(h.el('start').disabled, true); assert.equal(h.el('id').value, h.p.approvalId); assert.match(h.el('status').textContent, /结果未知/);
  assert.doesNotMatch(h.root.textContent, /PRIVATE-SENTINEL/); await h.click('start');
  assert.equal(h.calls.filter(c => c.url.endsWith('/start')).length, 1);
  h.result.report.ledger.runs = [{ costMicroUsd: null, score: null }]; await h.click('read');
  assert.match(h.el('report').textContent, /"costMicroUsd": null/); assert.equal(h.calls.at(-1).method, undefined);
});
test('wrong review binding, scope, qualifications or saved report cannot enable launch', async t => {
  for (const change of [{ projectId: 'p2' }, { materialVerified: true }, { paidAuthorization: true }, { reviewHash: 'bad' },
    { materialId: 'other' }, { review: { planHash: hash('other'), realModel: false, faithfulReplay: false } }]) {
    const h = setup(t); Object.assign(h.p, change); await h.panel.select({ id: 'p1' }); await h.click('preview');
    assert.equal(h.el('approve').disabled, true); assert.equal(h.el('start').disabled, true);
  }
  const h = setup(t); h.result.report.approval.planHash = hash('other');
  await h.panel.select({ id: 'p1' }); await h.click('preview'); await h.click('approve');
  assert.equal(h.el('start').disabled, true); assert.equal(h.el('report').textContent, '');
});
test('production projects page does not load workbench or offer a launch capability', () => {
  assert.doesNotMatch(fs.readFileSync(require.resolve('../../public/projects.html'), 'utf8'), /badcase-workbench/);
  assert.doesNotMatch(fs.readFileSync(require.resolve('../../server/app/create-server.ts'), 'utf8'), /workbench\s*:/);
});
