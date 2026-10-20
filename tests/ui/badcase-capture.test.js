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
  const h = setup(t, url => url.endsWith('/badcase-capture') ? { ...snapshot(), usage: { totalBytes: 361, blobCount: 2,
    ...(withBreakdown ? { bytesByKind: { blobs: 100, checkpoints: 50, latest: 20, flags: 61, retention: 90, cases: 0, runReferences: 40 } } : {}) } } : undefined);
  await h.panel.select({ id: 'a' });
  let text = h.root.querySelector('[data-capture-storage-detail]').textContent;
  for (const expected of ['CAS：100 B', '检查点：50 B', 'latest：20 B', '标记：61 B', '保留清单：90 B', '封存记录：0 B', '运行引用：40 B']) assert.ok(text.includes(expected), text);
  assert.match(h.root.textContent, /逻辑字节/); assert.match(h.root.textContent, /不含.*staging/);
  withBreakdown = false; await h.click('refresh');
  text = h.root.querySelector('[data-capture-storage-detail]').textContent;
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

test('metadata-only Windows preview shows bytes and limitations, never enables even with a stray receipt', async t => {
  const h = setup(t, url => url.endsWith('/estimate') ? estimate({ captureAvailable: false,
    estimates: [{ targetDir: '/repo', ok: true, complete: true, fileCount: 2, totalBytes: 123, captureAvailable: false }] }) : undefined);
  await h.panel.select({ id: 'a' }); await h.click('estimate');
  assert.match(h.root.textContent, /123 B/);
  assert.match(h.root.textContent, /元数据预估完成.*采集尚不可用/);
  assert.match(h.root.textContent, /ignored/);
  assert.match(h.root.textContent, /未扫描内容/);
  assert.equal(h.button('enable').disabled, true);
  await h.click('enable');
  assert.equal(h.calls.some(c => c.url.endsWith('/enable')), false);
});

test('unsupported ambient Git configuration is reported without changing it or offering enable', async t => {
  const h = setup(t, url => url.endsWith('/estimate') ? estimate({ captureAvailable: false,
    estimates: [{ targetDir: '/repo', ok: true, complete: true, fileCount: 2, totalBytes: 123,
      captureAvailable: false, reason: 'windows_git_environment_unsupported' }] }) : undefined);
  await h.panel.select({ id: 'a' }); await h.click('estimate');
  const text = h.root.querySelector('[data-capture-notice]').textContent;
  assert.match(text, /Git.*配置.*不支持/); assert.match(text, /不会自动.*关闭.*改动/);
  assert.equal(h.button('enable').disabled, true); await h.click('enable');
  assert.equal(h.calls.some(c => c.url.endsWith('/enable')), false);
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
test('external Git JSON selection is explicit, confirmed, read-only on load and draft-invalidates receipt', async t => {
  const selected = [{ worktree: 'C:/work', metadataRoot: 'C:/main/.git/worktrees/work', commonRoot: 'C:/main/.git' }];
  const h = setup(t, url => url.endsWith('/badcase-capture') ? { ...snapshot(), policy: { ...snapshot().policy, windowsExternalGit: selected } } : undefined);
  await h.panel.select({ id: 'a' });
  assert.deepEqual(JSON.parse(h.field('windowsExternalGit').value), selected); assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  await h.click('estimate'); assert.equal(h.button('enable').disabled, false);
  h.edit('windowsExternalGit', '{bad'); assert.equal(h.button('enable').disabled, true); assert.equal(h.button('estimate').disabled, true);
  await h.click('authorize'); assert.equal(h.calls.some(c => c.url.endsWith('/authorize')), false); assert.match(h.root.textContent, /JSON/);
  h.edit('windowsExternalGit', JSON.stringify(selected)); h.accept(false); await h.click('authorize');
  assert.equal(h.calls.some(c => c.url.endsWith('/authorize')), false);
  h.accept(true); await h.click('authorize');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c.url.endsWith('/authorize')).body.windowsExternalGit)), selected);
  assert.match(h.confirms.at(-1), /worktrees/); assert.equal(h.calls.some(c => c.url.endsWith('/enable')), false);
  await h.panel.select(null); assert.equal(h.field('windowsExternalGit').value, '');
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
  for (const file of ['shared/management-list.js', 'shared/badcase-capture.js', 'shared/badcase-evaluations.js', 'projects.js']) {
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public', file), 'utf8'));
  }
  await tick();
  assert.match(dom.window.document.querySelector('[data-capture-status]').textContent, /Project A/);
  assert.ok(calls.some(c => c.url === '/api/projects/a/badcase-capture'));
  dom.window.document.querySelectorAll('#project-list button')[1].click(); await tick();
  assert.match(dom.window.document.querySelector('[data-capture-status]').textContent, /Project B/);
  assert.ok(calls.some(c => c.url === '/api/projects/b/badcase-capture'));
  assert.equal(calls.some(c => c.method === 'POST'), false);
  assert.equal(dom.window.document.querySelector('[data-eval-approve]').disabled, true);
  assert.equal(dom.window.document.querySelector('[data-offline-evaluation-advanced]').open, false);
  assert.match(dom.window.document.querySelector('[data-eval-status]').textContent, /尚未预览/);
});
test('project page loads panel module before entry and wires selected project, not active project', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/projects.html'), 'utf8');
  const js = fs.readFileSync(path.resolve(__dirname, '../../public/projects.js'), 'utf8');
  assert.ok(html.includes('id="badcase-capture-panel"'));
  assert.ok(html.indexOf('/shared/badcase-capture.js') < html.indexOf('/projects.js'));
  assert.match(js, /capturePanel\.select\(selected\)/);
});

test('guided path has three steps, hidden defaults and no automatic read or grant on load', async t => {
  const h = setup(t, url => url.endsWith('/badcase-capture') ? { ...snapshot(), policy: { ...snapshot().policy, authorizedDirs: [] } } : undefined);
  await h.panel.select({ id: 'a', path: 'C:/app', worktreePath: 'C:/work' });
  assert.equal(h.field('worktree').value, 'C:/work');
  assert.equal(h.root.querySelectorAll('fieldset').length, 3);
  const advanced = h.root.querySelector('[data-capture-advanced]');
  assert.equal(advanced.open, false);
  for (const name of ['windowsExternalGit', 'stagingRetentionDays', 'stagingQuotaBytes', 'excludedPatterns']) {
    assert.ok(advanced.contains(h.field(name)));
  }
  assert.equal(advanced.contains(h.field('callbackInputAuthorized')), false);
  assert.equal(h.button('discover-git').disabled, true);
  assert.equal(h.calls.some(c => c.method === 'POST'), false);
  h.accept(false); await h.click('authorize-worktree');
  assert.equal(h.calls.some(c => c.method === 'POST'), false);
});

test('guided external Git flow requires each root consent, needs no JSON and never enables from a preview', async t => {
  const worktree = 'C:/work', metadataRoot = 'C:/main/.git/worktrees/work', commonRoot = 'C:/main/.git';
  let policy = { ...snapshot().policy, authorizedDirs: [], windowsExternalGit: [], callbackInputAuthorized: false };
  const h = setup(t, (url, options) => {
    if (url.endsWith('/badcase-capture')) return { ...snapshot(), policy };
    if (url.endsWith('/authorize')) { policy = { ...policy, ...options.body, status: 'disabled' }; return { ...snapshot(), policy }; }
    if (url.endsWith('/discover-git')) {
      assert.equal(options.body.confirmed, true);
      const inputs = policy.authorizedInputDirs;
      return { ok: true, targetDir: worktree, ready: inputs.includes(commonRoot),
        next: !inputs.includes(metadataRoot) ? { kind: 'metadata', path: metadataRoot }
          : !inputs.includes(commonRoot) ? { kind: 'common', path: commonRoot } : null,
        selection: inputs.includes(metadataRoot) ? { worktree, metadataRoot, commonRoot } : null };
    }
    if (url.endsWith('/estimate')) return estimate({ captureAvailable: false });
  });
  await h.panel.select({ id: 'a', path: worktree });
  await h.click('authorize-worktree');
  assert.deepEqual(Array.from(policy.authorizedDirs), [worktree]);
  assert.equal(policy.authorizedInputDirs.length, 0);
  assert.match(h.root.querySelector('[data-capture-dependency]').textContent, /本 worktree 的 Git 元数据/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/authorize')).length, 1);
  h.accept(false); await h.click('authorize-dependency');
  assert.equal(h.calls.filter(c => c.url.endsWith('/authorize')).length, 1);
  h.accept(true); await h.click('authorize-dependency');
  assert.deepEqual(Array.from(policy.authorizedInputDirs), [metadataRoot]);
  assert.match(h.root.querySelector('[data-capture-dependency]').textContent, /Git 公共元数据/);
  await h.click('authorize-dependency');
  assert.deepEqual(Array.from(policy.authorizedInputDirs), [metadataRoot, commonRoot]);
  assert.equal(policy.windowsExternalGit[0].commonRoot, commonRoot);
  assert.equal(policy.callbackInputAuthorized, false);
  assert.equal(h.button('enable').disabled, true);
  assert.equal(h.calls.some(c => c.url.endsWith('/enable')), false);
  assert.equal(h.calls.filter(c => c.url.endsWith('/estimate')).length, 1);
  assert.equal(h.confirms.some(text => text.includes('JSON') || text.includes('windowsExternalGit')), false);
  assert.ok(h.confirms.every(text => text.includes('不启用采集') && text.includes('当前身份')));
});

test('guided reauthorization explicitly removes only the exact .git data exclusion for turn classification; cancel and advanced consent preserve it', async t => {
  let policy = { ...snapshot().policy, excludedPatterns: ['.git', 'node_modules', 'private', '.git/index', '.git/**'] };
  const h = setup(t, (url, options) => {
    if (url.endsWith('/badcase-capture')) return { ...snapshot(), policy };
    if (url.endsWith('/authorize')) { policy = { ...policy, ...options.body }; return { ...snapshot(), policy }; }
    if (url.endsWith('/discover-git')) return { ok: false, reason: 'git_metadata_unsupported' };
  });
  await h.panel.select({ id: 'a' });
  const original = h.field('excludedPatterns').value;
  h.accept(false); await h.click('authorize-worktree');
  assert.equal(h.calls.some(c => c.method === 'POST'), false); assert.equal(h.field('excludedPatterns').value, original);
  h.accept(true); await h.click('authorize');
  assert.deepEqual(Array.from(policy.excludedPatterns), ['.git', 'node_modules', 'private', '.git/index', '.git/**']);
  await h.click('authorize-worktree');
  assert.deepEqual(Array.from(policy.excludedPatterns), ['node_modules', 'private', '.git/index', '.git/**']);
  const consent = h.confirms.at(-1);
  assert.match(consent, /移除.*精确.*\.git/); assert.match(consent, /每次.*turn.*分类/); assert.match(consent, /\.git.*仍.*不归档/);
  assert.equal(h.calls.some(c => c.url.endsWith('/enable')), false);
});

test('native linked-worktree guided default authorization produces a usable classified file selection without archiving Git', { skip: process.platform !== 'win32' }, async t => {
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'caff-guided-git-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main'), work = path.join(root, 'work'), captureRoot = path.join(root, 'capture');
  fs.mkdirSync(main);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global') };
  const git = (...args) => execFileSync('git', ['-C', main, ...args], { env, windowsHide: true, encoding: 'utf8' });
  git('init', '-q'); git('config', 'core.ignorecase', 'true');
  fs.writeFileSync(path.join(main, '.gitignore'), '*.log\n'); fs.writeFileSync(path.join(main, 'tracked.log'), 'original');
  git('add', '-f', '.gitignore', 'tracked.log');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  git('worktree', 'add', '-qb', 'fixture-work', work);
  fs.writeFileSync(path.join(work, 'tracked.log'), 'dirty'); fs.writeFileSync(path.join(work, 'untracked'), 'new');
  fs.writeFileSync(path.join(work, 'ignored.log'), 'IGNORE_SENTINEL'); fs.writeFileSync(path.join(work, 'included.log'), 'include');
  const base = '../../build/server/domain/runtime/badcase-capture';
  const service = require(base).createBadcaseCaptureService({ captureRoot });
  const state = () => ({ policy: service.loadPolicy('p'), usage: service.computeUsage('p') });
  const h = setup(t, async (url, options) => {
    if (url === '/api/bootstrap') return { localAdmin: { modelProviders: { enabled: true, csrfToken: 'test-csrf' } } };
    if (url.endsWith('/badcase-capture')) return state();
    if (url.endsWith('/authorize')) {
      assert.equal(options.body.confirmed, true);
      service.savePolicy('p', { ...service.loadPolicy('p'), ...options.body }); service.authorizeProject('p'); return state();
    }
    if (url.endsWith('/discover-git')) return service.discoverGitDependenciesAsync('p', options.body.targetDir);
    if (url.endsWith('/estimate')) {
      const result = await service.estimateDirectoryAsync('p', work);
      return { complete: result.complete, captureAvailable: result.captureAvailable, totalBytes: result.totalBytes,
        estimateId: null, estimates: [{ targetDir: work, ...result }] };
    }
    assert.fail('unexpected UI endpoint');
  });
  await h.panel.select({ id: 'p', path: work }); h.edit('includedIgnoredPatterns', 'included.log');
  // Wait for native I/O via DOM changes without exposing a production test API
  // or polling. Each predicate describes the next distinct rendered stage.
  const action = (name, rendered) => new Promise((resolve, reject) => {
    const observer = new h.root.ownerDocument.defaultView.MutationObserver(() => {
      if (rendered()) { observer.disconnect(); clearTimeout(timer); resolve(); }
    });
    const timer = setTimeout(() => { observer.disconnect(); reject(Error(`UI did not settle: ${name}`)); }, 15000);
    observer.observe(h.root, { subtree: true, childList: true, attributes: true }); h.button(name).click();
  });
  const dependencyText = () => h.root.querySelector('[data-capture-dependency]').textContent;
  await action('authorize-worktree', () => /本 worktree 的 Git 元数据/.test(dependencyText()));
  await action('authorize-dependency', () => /Git 公共元数据/.test(dependencyText()));
  await action('authorize-dependency', () => /元数据预估完成/.test(h.root.querySelector('[data-capture-estimate]').textContent));
  const policy = service.loadPolicy('p');
  const selection = require(base + '/windows-external-selection').selectWindowsExternalGit(policy, work);
  const candidate = await require(base + '/windows-git-candidate').readWindowsGitFileCandidateAsync({
    policy, targetDir: work, captureRoot, externalGit: selection });
  assert.equal(candidate.ok, true, candidate.reason);
  assert.deepEqual(Object.keys(candidate.files).sort(), ['.gitignore', 'included.log', 'tracked.log', 'untracked']);
  assert.equal(candidate.blobs.has(require('node:crypto').createHash('sha256').update('IGNORE_SENTINEL').digest('hex')), false);
  assert.equal(policy.excludedPatterns.includes('.git'), false); assert.equal(policy.excludedPatterns.includes('node_modules'), true);
  assert.equal(policy.authorizedDirs.length, 1); assert.equal(policy.authorizedInputDirs.length, 2);
  assert.equal(policy.windowsExternalGit.length, 1); assert.equal(policy.callbackInputAuthorized, false);
  assert.equal(policy.status, 'disabled'); assert.equal(service.store.listCheckpoints('p').length, 0);
  assert.equal(service.computeUsage('p').totalBytes, 0); assert.equal(h.calls.filter(c => c.url.endsWith('/authorize')).length, 3);
  assert.equal(h.calls.some(c => c.url.endsWith('/enable')), false); assert.equal(h.button('enable').disabled, true);
});

test('guided discovery discloses nested repository support limits before confirmation', async t => {
  const h = setup(t); await h.panel.select({ id: 'a' });
  assert.match(h.root.querySelector('fieldset:nth-of-type(2)').textContent, /自动识别暂不支持.*嵌套仓库\/submodule/);
  assert.equal(h.calls.some(c => c.method === 'POST'), false);
});

test('unsupported Git layouts explain nested repository limits and stop guided continuation without granting or retrying', async t => {
  const h = setup(t, url => url.endsWith('/discover-git') ? { ok: false, reason: 'git_metadata_unsupported' } : undefined);
  await h.panel.select({ id: 'a' });
  await h.click('estimate');
  assert.equal(h.button('enable').disabled, false);
  const before = h.field('authorizedDirs').value;
  await h.click('discover-git');
  const text = h.root.querySelector('[data-capture-dependency]').textContent;
  assert.match(text, /git_metadata_unsupported/);
  assert.match(text, /嵌套仓库\/submodule/);
  assert.match(text, /停止本次引导/);
  assert.match(text, /可改选不含嵌套仓库的验证 worktree/);
  assert.match(text, /不保证.*可采集/);
  assert.equal(h.button('authorize-dependency').hidden, true);
  assert.equal(h.button('enable').disabled, true);
  assert.equal(h.field('authorizedDirs').value, before);
  assert.equal(h.root.querySelector('[data-capture-advanced]').open, false);
  await h.click('authorize-dependency'); await h.click('enable'); await tick();
  assert.deepEqual(h.calls.filter(c => c.method === 'POST').map(c => c.url.split('/').at(-1)), ['estimate', 'discover-git']);
});

test('late Git candidate response cannot overwrite another project or survive a scope edit', async t => {
  const pending = deferred();
  const h = setup(t, url => url.endsWith('/discover-git') ? pending.promise : undefined);
  await h.panel.select({ id: 'a' }); await h.click('discover-git');
  await h.panel.select({ id: 'b' });
  pending.resolve({ ok: true, ready: false, targetDir: '/repo', next: { kind: 'metadata', path: 'C:/not-for-B' }, selection: null });
  await tick();
  assert.equal(h.button('authorize-dependency').disabled, true);
  assert.equal(h.root.textContent.includes('not-for-B'), false);
  await h.click('discover-git');
  assert.equal(h.button('authorize-dependency').disabled, false);
  h.edit('worktree', 'C:/changed');
  assert.equal(h.button('authorize-dependency').disabled, true);
  assert.equal(h.root.querySelector('[data-capture-dependency]').textContent.includes('not-for-B'), false);
});

test('public Room source consent is unchecked by default, separately disclosed, confirmed and never part of settings', async t => {
  const h = setup(t); await h.panel.select({ id: 'a' });
  const checkbox = h.field('callbackInputAuthorized');
  assert.equal(checkbox.checked, false); assert.match(h.root.textContent, /公共文本上下文/);
  assert.match(h.root.textContent, /标题.*公共元数据.*参与者.*完整公共文本/);
  assert.equal(h.calls.some(c => c.method === 'POST'), false);
  await h.click('estimate'); assert.equal(h.button('enable').disabled, false);
  checkbox.checked = true; checkbox.dispatchEvent(new checkbox.ownerDocument.defaultView.Event('input', { bubbles: true }));
  assert.equal(h.button('enable').disabled, true);
  h.accept(false); await h.click('authorize'); assert.equal(h.calls.some(c => c.url.endsWith('/authorize')), false);
  h.accept(true); await h.click('authorize');
  assert.equal(h.calls.find(c => c.url.endsWith('/authorize')).body.callbackInputAuthorized, true);
  assert.match(h.confirms.at(-1), /授权本项目各 Room 公共文本上下文/);
  assert.equal(checkbox.checked, false, 'render only persisted consent, not an optimistic grant');
  checkbox.checked = true; await h.click('settings');
  assert.equal(Object.hasOwn(h.calls.find(c => c.url.endsWith('/settings')).body, 'callbackInputAuthorized'), false);
  assert.equal(checkbox.checked, false);
  await h.click('estimate'); await h.click('enable'); assert.match(h.confirms.at(-1), /未授权.*缺失/);
});

test('persisted source consent is shown without mutation and resets when another project cannot load', async t => {
  const h = setup(t, url => url.endsWith('/a/badcase-capture') ? { ...snapshot(), policy: { ...snapshot().policy, callbackInputAuthorized: true } }
    : url.endsWith('/b/badcase-capture') ? Promise.reject(Error('offline')) : undefined);
  await h.panel.select({ id: 'a' }); assert.equal(h.field('callbackInputAuthorized').checked, true);
  await h.panel.select({ id: 'b' }); assert.equal(h.field('callbackInputAuthorized').checked, false);
  assert.equal(h.calls.some(c => c.method === 'POST'), false);
});
