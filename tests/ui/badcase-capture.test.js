const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
function state(status = 'disabled') {
  return { projectPath: '/repo', policy: { status, authorizedDirs: ['/legacy-other-dir'] }, usage: { totalBytes: 321 },
    coverage: { roomWorktreeCount: 2 }, storage: { insideProject: false, overlapsProject: false }, lastCapture: null };
}
function setup(t, handler) {
  const dom = new JSDOM('<div id="panel"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/badcase-capture.js'), 'utf8'));
  const calls = [], confirmations = []; let accepted = true;
  const root = dom.window.document.getElementById('panel');
  const panel = dom.window.CaffShared.createBadcaseCapturePanel({ root, confirm: text => { confirmations.push(text); return accepted; },
    fetchJson: async (url, options = {}) => {
      calls.push({ url, ...options });
      const response = handler?.(url, options); if (response !== undefined) return response;
      if (url === '/api/bootstrap') return { localAdmin: { modelProviders: { enabled: true, csrfToken: 'test-csrf' } } };
      return state(options.body?.enabled ? 'enabled' : 'disabled');
    } });
  return { root, panel, calls, confirmations, accept: value => { accepted = value; },
    button: action => root.querySelector(`[data-capture-action="${action}"]`),
    click: async action => { root.querySelector(`[data-capture-action="${action}"]`).click(); await tick(); } };
}
test('one switch uses the registered project path as read-only text, no directory input or advanced form', async t => {
  const h = setup(t); await h.panel.select({ id: 'a', path: '/repo' });
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  assert.equal(h.root.querySelectorAll('input, textarea, details').length, 0);
  assert.match(h.root.querySelector('[data-capture-directory]').textContent, /\/repo/);
  assert.doesNotMatch(h.root.textContent, /legacy-other-dir|不支持外置 Git|凭据和私有目录不保存/);
  assert.equal(h.root.querySelectorAll('[role="switch"]').length, 1);
  assert.equal(h.button('toggle').getAttribute('aria-checked'), 'false');
  assert.match(h.root.textContent, /321 B/); assert.match(h.root.textContent, /尚无采集记录/);
  assert.match(h.root.querySelector('[data-capture-coverage]').textContent, /2.*房间|房间.*2/);
});
test('enable confirms project/worktree/skill/session/public scope and posts one switch with CSRF', async t => {
  const h = setup(t); await h.panel.select({ id: 'a', name: 'A', path: '/repo' }); await h.click('toggle');
  assert.equal(h.confirmations.length, 1);
  for (const text of ['session', '公共文本', 'skill', 'worktree', '/repo']) assert.ok(h.confirmations[0].includes(text));
  const posts = h.calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/projects/a/badcase-capture/configure');
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0].body)), { enabled: true, confirmed: true });
  assert.equal(posts[0].headers['X-CAFF-CSRF-Token'], 'test-csrf');
  assert.equal(h.button('toggle').getAttribute('aria-checked'), 'true');
});
test('cancel is side-effect free; disable works without re-authorizing or editing a directory', async t => {
  const h = setup(t); await h.panel.select({ id: 'a' }); h.accept(false); await h.click('toggle');
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  h.accept(true); await h.click('toggle'); await h.click('toggle');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1).body)), { enabled: false, confirmed: true });
  assert.equal(h.button('toggle').getAttribute('aria-checked'), 'false');
});
for (const [status, label] of [['captured', '已保存'], ['partial', '部分保存'], ['pending_skills', '等待 skill'], ['failed', '失败']]) {
  test('last result displays ' + status + ', skip count and source without claiming replay success', async t => {
    const h = setup(t, url => url.endsWith('/badcase-capture') ? { ...state('enabled'), lastCapture: {
      status, targetDir: '/room/<img src=x>', createdAt: '2026-11-05T01:00:00.000Z', skippedCount: status === 'failed' ? null : 3,
      totalNewBytes: 87, preparationDurationMs: 120, reason: status === 'failed' ? 'head_unreadable' : '',
    } } : undefined);
    await h.panel.select({ id: 'a' }); const text = h.root.querySelector('[data-capture-last]').textContent;
    assert.ok(text.includes(label)); assert.match(text, status === 'failed' ? /跳过.*未知/ : /跳过.*3/);
    assert.match(text, /87 B/); assert.match(text, /120 ms/); assert.match(text, /\/room\/<img src=x>/);
    assert.equal(h.root.querySelector('img'), null); if (status === 'failed') assert.match(text, /head_unreadable/);
  });
}
test('storage inside project explains external absolute path + restart, blocks enable but never blocks disable', async t => {
  let enabled = false;
  const h = setup(t, (url, o) => url.endsWith('/badcase-capture') ? { ...state(enabled ? 'enabled' : 'disabled'), storage: { insideProject: true, overlapsProject: true } }
    : url.endsWith('/configure') ? { ...state(o.body.enabled ? 'enabled' : 'disabled'), storage: { insideProject: true, overlapsProject: true } } : undefined);
  await h.panel.select({ id: 'a' });
  const hint = h.root.querySelector('[data-capture-storage]'); assert.equal(hint.hidden, false);
  for (const text of ['项目目录内', 'CAFF_BADCASE_CAPTURE_DIR', '绝对路径', '重启', '不会自动搬迁']) assert.ok(hint.textContent.includes(text));
  assert.equal(h.button('toggle').disabled, true); enabled = true; await h.click('refresh');
  assert.equal(h.button('toggle').disabled, false); await h.click('toggle'); assert.equal(h.button('toggle').getAttribute('aria-checked'), 'false');
});
test('failed enable reports explicit location advice and never retries; unknown text stays text', async t => {
  const h = setup(t, url => { if (url.endsWith('/configure')) throw Object.assign(new Error('failed'), { issues: [{ code: 'badcase_capture_storage_overlaps_project' }, { code: '<img src=x>' }] }); });
  await h.panel.select({ id: 'a' }); await h.click('toggle');
  assert.match(h.root.textContent, /CAFF_BADCASE_CAPTURE_DIR/); assert.match(h.root.textContent, /<img src=x>/); assert.equal(h.root.querySelector('img'), null);
  assert.equal(h.button('toggle').getAttribute('aria-checked'), 'false'); assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
});
test('a late mutation response cannot overwrite another selected project', async t => {
  let release;
  const h = setup(t, url => url.endsWith('/configure') ? new Promise(resolve => { release = resolve; }) : undefined);
  await h.panel.select({ id: 'a' }); h.button('toggle').click(); await tick();
  await h.panel.select({ id: 'b', name: 'B' }); release(state('enabled')); await tick();
  assert.match(h.root.textContent, /B/); assert.equal(h.button('toggle').getAttribute('aria-checked'), 'false');
});
test('admin-off prevents mutation; empty selection clears project-specific status', async t => {
  const h = setup(t, url => url === '/api/bootstrap' ? { localAdmin: { modelProviders: { enabled: false } } } : undefined);
  await h.panel.select({ id: 'a' }); assert.equal(h.button('toggle').disabled, true);
  await h.click('toggle'); assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  await h.panel.select(null); assert.match(h.root.textContent, /未选择项目/);
  for (const name of ['directory', 'coverage', 'last', 'storage']) assert.equal(h.root.querySelector(`[data-capture-${name}]`).textContent, '');
});
test('unknown usage/count/last result never becomes zero; closing remains available', async t => {
  const h = setup(t, url => url.endsWith('/badcase-capture') ? { ...state('enabled'), usage: null, coverage: { roomWorktreeCount: null },
    usageError: 'capture_usage_unavailable', lastCaptureError: 'capture_metrics_unavailable' } : undefined);
  await h.panel.select({ id: 'a' }); assert.match(h.root.textContent, /占用未知/); assert.doesNotMatch(h.root.textContent, /0 B/);
  assert.match(h.root.querySelector('[data-capture-coverage]').textContent, /未知/);
  assert.match(h.root.querySelector('[data-capture-last]').textContent, /不可用/);
  assert.equal(h.button('toggle').disabled, false); await h.click('toggle'); assert.match(h.root.textContent, /已关闭/);
});
