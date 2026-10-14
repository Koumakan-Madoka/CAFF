const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = path.resolve(__dirname, '../../public/shared/badcase-capture.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function snapshot(status = 'disabled') {
  return { policy: { status, authorizedDirs: ['/repo'], authorizedInputDirs: [], includedIgnoredPatterns: [],
    excludedPatterns: ['.env'], stagingRetentionDays: 7, stagingQuotaBytes: 10737418240 }, usage: { totalBytes: 321, blobCount: 2 } };
}
function estimate(overrides = {}) {
  return { complete: true, estimateId: 'receipt-a', expiresAt: 601000, totalBytes: 123,
    estimates: [{ targetDir: '/repo', ok: true, complete: true, totalBytes: 123, fileCount: 2 }], ...overrides };
}
function setup(t, handler) {
  const dom = new JSDOM('<div id="panel"></div>', { runScripts: 'outside-only', url: 'http://localhost/' });
  t.after(() => dom.window.close());
  dom.window.CaffShared = {};
  dom.window.eval(fs.readFileSync(source, 'utf8'));
  const calls = [], confirms = [];
  let accepted = true, now = 1000;
  const fetchJson = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (handler) { const custom = handler(url, options); if (custom !== undefined) return custom; }
    if (url === '/api/bootstrap') return { localAdmin: { modelProviders: { enabled: true, csrfToken: 'test-csrf' } } };
    if (url.endsWith('/estimate')) return estimate();
    return snapshot(url.endsWith('/enable') ? 'enabled' : 'disabled');
  };
  const root = dom.window.document.getElementById('panel');
  const panel = dom.window.CaffShared.createBadcaseCapturePanel({ root, fetchJson,
    confirm: text => { confirms.push(text); return accepted; }, now: () => now });
  const button = action => root.querySelector(`[data-capture-action="${action}"]`);
  const field = name => root.querySelector(`[name="${name}"]`);
  return { panel, root, calls, confirms, button, field,
    accept: value => { accepted = value; }, time: value => { now = value; },
    click: async action => { button(action).click(); await tick(); },
    edit: (name, value) => { field(name).value = value; field(name).dispatchEvent(new dom.window.Event('input', { bubbles: true })); } };
}
test('opening and selecting a project is read-only; displays persisted limits, usage and trust boundary', async t => {
  const h = setup(t); await h.panel.select({ id: 'a', name: 'A', path: '/never-auto-authorize' });
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  assert.equal(h.field('authorizedDirs').value, '/repo');
  assert.equal(h.field('stagingQuotaBytes').value, '10737418240');
  assert.match(h.root.textContent, /321/); assert.match(h.root.textContent, /同一 OS 用户/);
  assert.match(h.root.textContent, /Windows/); assert.equal(h.button('enable').disabled, true);
});
test('usage shows committed storage categories and labels absent older breakdown as unknown', async t => {
  let withBreakdown = true;
  const h = setup(t, url => url.endsWith('/badcase-capture') ? { ...snapshot(), usage: { totalBytes: 321, blobCount: 2,
    ...(withBreakdown ? { bytesByKind: { blobs: 100, checkpoints: 50, latest: 20, flags: 61, retention: 90, cases: 0 } } : {}) } } : undefined);
  await h.panel.select({ id: 'a' });
  let text = h.root.querySelector('[data-capture-usage]').textContent;
  for (const expected of ['CAS：100 B', '检查点：50 B', 'latest：20 B', '标记：61 B', '保留清单：90 B', '封存记录：0 B']) assert.ok(text.includes(expected), text);
  assert.match(h.root.textContent, /逻辑字节/); assert.match(h.root.textContent, /不含.*staging/);
  withBreakdown = false; await h.click('refresh');
  text = h.root.querySelector('[data-capture-usage]').textContent;
  assert.match(text, /分项未知/); assert.doesNotMatch(text, /标记：0 B/);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
});
test('unavailable usage still shows persisted policy, permits disable and refresh, never shows zero or stale bytes', async t => {
  let unavailable = false, status = 'enabled';
  const h = setup(t, url => {
    if (url === '/api/bootstrap') return;
    if (url.endsWith('/disable')) status = 'disabled';
    return { ...snapshot(status), ...(unavailable ? { usage: null, usageError: 'capture_usage_unavailable' } : { usageError: null }) };
  });
  await h.panel.select({ id: 'a' });
  assert.match(h.root.querySelector('[data-capture-usage]').textContent, /321 B/);
  unavailable = true; await h.click('refresh');
  assert.match(h.root.querySelector('[data-capture-status]').textContent, /状态：已开启/);
  assert.equal(h.field('authorizedDirs').value, '/repo');
  assert.equal(h.button('disable').disabled, false);
  const usageText = () => h.root.querySelector('[data-capture-usage]').textContent;
  assert.match(usageText(), /占用未知/); assert.match(usageText(), /capture_usage_unavailable/);
  assert.doesNotMatch(usageText(), /321|0 B|undefined|null/);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  await h.click('disable');
  assert.match(h.root.querySelector('[data-capture-status]').textContent, /状态：已关闭/);
  assert.match(usageText(), /占用未知/);
  assert.doesNotMatch(h.root.querySelector('[data-capture-notice]').textContent, /操作失败/);
  await h.click('refresh');
  assert.match(h.root.querySelector('[data-capture-status]').textContent, /状态：已关闭/);
  assert.match(usageText(), /占用未知/);
  unavailable = false; await h.click('refresh');
  assert.match(usageText(), /321 B/); assert.doesNotMatch(usageText(), /占用未知/);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
});
test('null usage without the explicit unavailable code is not a valid management state', async t => {
  const h = setup(t, url => url.endsWith('/badcase-capture') ? { ...snapshot(), usage: null } : undefined);
  await h.panel.select({ id: 'a' });
  assert.match(h.root.textContent, /badcase_capture_state_invalid/);
  assert.equal(h.button('disable').disabled, true);
});

test('writer contention explains retry without claiming policy success or retrying automatically', async t => {
  let busy = true;
  const h = setup(t, url => {
    if (url.endsWith('/disable') && busy) throw Object.assign(new Error('rejected'), {
      issues: [{ code: 'capture_writer_busy' }] });
    if (url.endsWith('/badcase-capture')) return snapshot('enabled');
  });
  await h.panel.select({ id: 'a' });
  await h.click('estimate');
  await h.click('disable');
  const text = h.root.querySelector('[data-capture-notice]').textContent;
  assert.match(text, /capture_writer_busy/);
  assert.match(text, /存储正忙/);
  assert.match(text, /稍后.*重试/);
  assert.match(h.root.querySelector('[data-capture-status]').textContent, /已开启/);
  assert.equal(h.button('enable').disabled, true);
  assert.equal(h.button('disable').disabled, false);
  assert.equal(h.button('refresh').disabled, false);
  assert.equal(h.calls.filter(call => call.url.endsWith('/disable')).length, 1);
  busy = false;
  await h.click('disable');
  assert.match(h.root.querySelector('[data-capture-status]').textContent, /已关闭/);
  assert.equal(h.calls.filter(call => call.url.endsWith('/disable')).length, 2);
});

test('authorization and enable require separate confirmation; cancel sends no mutation', async t => {
  const h = setup(t); await h.panel.select({ id: 'a', name: 'A' });
  h.accept(false); await h.click('authorize'); assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  h.accept(true); await h.click('authorize');
  const authorization = h.calls.find(c => c.url.endsWith('/authorize'));
  assert.equal(authorization.body.confirmed, true); assert.equal(authorization.headers['X-CAFF-CSRF-Token'], 'test-csrf');
  assert.deepEqual(Array.from(authorization.body.excludedPatterns), ['.env']);
  assert.match(h.confirms[1], /\/repo/); assert.match(h.confirms[1], /关闭/);
  assert.equal(h.calls.some(c => c.url.endsWith('/enable')), false);
  await h.click('estimate'); assert.equal(h.button('enable').disabled, false);
  h.accept(false); await h.click('enable'); assert.equal(h.calls.some(c => c.url.endsWith('/enable')), false);
  h.accept(true); await h.click('enable');
  const enable = h.calls.find(c => c.url.endsWith('/enable'));
  assert.equal(enable.body.estimateId, 'receipt-a'); assert.equal(enable.body.confirmed, true);
  assert.match(h.confirms.at(-1), /123/); assert.match(h.root.textContent, /已开启/);
});
test('partial estimate and unknown reason never enable or inject markup', async t => {
  const h = setup(t, url => url.endsWith('/estimate') ? estimate({ complete: false, estimateId: 'forged-but-incomplete',
    estimates: [{ targetDir: '/repo', ok: false, reason: '<img src=x onerror=alert(1)>' }] }) : undefined);
  await h.panel.select({ id: 'a' }); await h.click('estimate');
  assert.equal(h.button('enable').disabled, true); assert.match(h.root.textContent, /<img src=x/);
  assert.equal(h.root.querySelector('img'), null); assert.match(h.root.textContent, /不完整/);
});
test('expired receipt is rejected at click without issuing enable; server expiry clears receipt too', async t => {
  const h = setup(t, url => { if (url.endsWith('/enable')) throw Object.assign(new Error('rejected'), {
    issues: [{ code: 'badcase_capture_estimate_required' }] }); });
  await h.panel.select({ id: 'a' }); await h.click('estimate'); h.time(601000); await h.click('enable');
  assert.equal(h.calls.some(c => c.url.endsWith('/enable')), false); assert.match(h.root.textContent, /过期/);
  h.time(1000); await h.click('estimate'); await h.click('enable');
  assert.match(h.root.textContent, /badcase_capture_estimate_required/); assert.equal(h.button('enable').disabled, true);
});
test('draft scope disables estimate and consumes local receipt; settings only posts limits', async t => {
  const h = setup(t); await h.panel.select({ id: 'a' }); await h.click('estimate');
  h.edit('authorizedDirs', '/other'); assert.equal(h.button('estimate').disabled, true); assert.equal(h.button('enable').disabled, true);
  h.edit('stagingRetentionDays', '8'); await h.click('settings');
  assert.equal(h.field('authorizedDirs').value, '/repo');
  assert.match(h.root.textContent, /未保存的范围草稿已丢弃/);
  const settings = h.calls.find(c => c.url.endsWith('/settings'));
  assert.deepEqual(Object.keys(settings.body).sort(), ['stagingQuotaBytes', 'stagingRetentionDays']);
  assert.equal(settings.body.stagingRetentionDays, 8); assert.equal(h.button('enable').disabled, true);
});
test('late estimate from A cannot enable B; pending disable invalidates same-project estimate', async t => {
  let pending = deferred();
  const h = setup(t, url => url.endsWith('/estimate') ? pending.promise : undefined);
  await h.panel.select({ id: 'a' }); await h.click('estimate');
  await h.panel.select({ id: 'b' }); pending.resolve(estimate()); await tick();
  assert.equal(h.button('enable').disabled, true); assert.doesNotMatch(h.root.textContent, /123 B/);
  pending = deferred(); await h.click('estimate'); assert.equal(h.button('disable').disabled, false);
  await h.click('disable'); pending.resolve(estimate()); await tick();
  assert.equal(h.button('enable').disabled, true); assert.match(h.root.textContent, /已关闭/);
});
test('close remains available during enable and discards its late same-project success', async t => {
  const pending = deferred();
  const h = setup(t, url => url.endsWith('/enable') ? pending.promise : undefined);
  await h.panel.select({ id: 'a' }); await h.click('estimate'); await h.click('enable');
  assert.equal(h.button('disable').disabled, false);
  await h.click('disable'); pending.resolve(snapshot('enabled')); await tick();
  assert.match(h.root.textContent, /状态：已关闭/);
  assert.equal(h.button('enable').disabled, true);
  assert.equal(h.calls.filter(c => c.url.endsWith('/disable')).length, 1);
});
test('late GET or enable response cannot overwrite another project, including ABA selection', async t => {
  const pendingGet = deferred(), pendingEnable = deferred(); let getCount = 0;
  const h = setup(t, (url, options) => {
    if (url.endsWith('/a/badcase-capture') && !options.method && ++getCount === 1) return pendingGet.promise;
    if (url.endsWith('/enable')) return pendingEnable.promise;
  });
  const old = h.panel.select({ id: 'a' }); await tick();
  await h.panel.select({ id: 'b' }); await h.panel.select({ id: 'a' });
  pendingGet.resolve(snapshot('enabled')); await old; assert.doesNotMatch(h.root.textContent, /状态：已开启/);
  await h.click('estimate'); await h.click('enable'); await h.panel.select({ id: 'b' });
  pendingEnable.resolve(snapshot('enabled')); await tick(); assert.doesNotMatch(h.root.textContent, /状态：已开启/);
});
test('mutation error invalidates receipt and refresh reloads persisted state; no retry mutation', async t => {
  let failed = false;
  const h = setup(t, (url, options) => {
    if (url.endsWith('/authorize')) { failed = true; throw Object.assign(new Error('failed'), { issues: [{ code: 'custom_pin_failure' }] }); }
    if (failed && !options.method && url !== '/api/bootstrap') return snapshot('disabled');
  });
  await h.panel.select({ id: 'a' }); await h.click('estimate'); await h.click('authorize');
  assert.match(h.root.textContent, /custom_pin_failure/); assert.equal(h.button('enable').disabled, true);
  await h.click('refresh'); assert.match(h.root.textContent, /已关闭/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/authorize')).length, 1);
});
test('no selection clears private paths', async t => {
  const h = setup(t); await h.panel.select({ id: 'a' }); await h.panel.select(null);
  assert.equal(h.field('authorizedDirs').value, ''); assert.equal(h.button('authorize').disabled, true);
  assert.equal(h.button('enable').disabled, true);
});
test('disabled management or missing CSRF fails closed without loading project state', async t => {
  for (const admin of [{ enabled: false, csrfToken: 'test' }, { enabled: true }]) {
    const h = setup(t, url => url === '/api/bootstrap' ? { localAdmin: { modelProviders: admin } } : undefined);
    await h.panel.select({ id: 'a' });
    assert.equal(h.calls.length, 1); assert.equal(h.button('authorize').disabled, true);
    assert.equal(h.button('disable').disabled, true); assert.match(h.root.textContent, /未开放本地采集管理/);
  }
});
test('malformed successful estimate fails closed; duplicate clicks cannot create concurrent mutations', async t => {
  const pending = deferred();
  const h = setup(t, url => url.endsWith('/estimate') ? pending.promise : undefined);
  await h.panel.select({ id: 'a' }); await h.click('estimate'); await h.click('estimate');
  assert.equal(h.calls.filter(c => c.url.endsWith('/estimate')).length, 1);
  pending.resolve(estimate({ estimates: [] })); await tick(); assert.equal(h.button('enable').disabled, true);
});
test('real project entry connects selection to panel, with no mutation during bootstrap', async t => {
  const dom = new JSDOM(fs.readFileSync(path.resolve(__dirname, '../../public/projects.html'), 'utf8'), {
    runScripts: 'outside-only', url: 'http://localhost/',
  });
  t.after(() => dom.window.close());
  const calls = [];
  dom.window.CaffShared = { createToastController: () => ({ show() {} }),
    fetchJson: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (url === '/api/projects') return { projects: [{ id: 'a', name: 'Project A' }, { id: 'b', name: 'Project B' }], activeProjectId: 'b' };
      if (url === '/api/bootstrap') return { localAdmin: { modelProviders: { enabled: true, csrfToken: 'test' } } };
      return snapshot();
    } };
  for (const file of ['shared/management-list.js', 'shared/badcase-capture.js', 'projects.js']) {
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public', file), 'utf8'));
  }
  await tick();
  assert.match(dom.window.document.querySelector('[data-capture-status]').textContent, /Project A/);
  assert.ok(calls.some(c => c.url === '/api/projects/a/badcase-capture'));
  dom.window.document.querySelectorAll('#project-list button')[1].click(); await tick();
  assert.match(dom.window.document.querySelector('[data-capture-status]').textContent, /Project B/);
  assert.ok(calls.some(c => c.url === '/api/projects/b/badcase-capture'));
  assert.equal(calls.some(c => c.method === 'POST'), false);
});
test('project page loads panel module before entry and wires selected project, not active project', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/projects.html'), 'utf8');
  const js = fs.readFileSync(path.resolve(__dirname, '../../public/projects.js'), 'utf8');
  assert.ok(html.includes('id="badcase-capture-panel"'));
  assert.ok(html.indexOf('/shared/badcase-capture.js') < html.indexOf('/projects.js'));
  assert.match(js, /capturePanel\.select\(selected\)/);
});
