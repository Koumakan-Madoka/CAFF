const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
function state(status = 'disabled', dirs = ['/repo']) {
  return { policy: { status, authorizedDirs: dirs }, usage: { totalBytes: 321, blobCount: 2 } };
}
function setup(t, handler) {
  const dom = new JSDOM('<div id="panel"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/badcase-capture.js'), 'utf8'));
  const calls = [], confirmations = [];
  let accepted = true;
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
    input: () => root.querySelector('[name="worktree"]'),
    click: async action => { root.querySelector(`[data-capture-action="${action}"]`).click(); await tick(); } };
}
test('compact panel loads read-only with only a directory and switch, no JSON or advanced configuration', async t => {
  const h = setup(t); await h.panel.select({ id: 'a', path: '/repo' });
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  assert.equal(h.input().value, '/repo'); assert.equal(h.root.querySelectorAll('input').length, 1);
  assert.equal(h.root.querySelectorAll('textarea, details').length, 0);
  assert.equal(h.button('toggle').getAttribute('role'), 'switch');
  assert.equal(h.button('toggle').getAttribute('aria-checked'), 'false');
  assert.match(h.root.textContent, /321 B/); assert.match(h.root.textContent, /不支持/);
});
test('enable confirms files + session + public context once, posts only compact configuration with CSRF', async t => {
  const h = setup(t); await h.panel.select({ id: 'a', name: 'A' }); await h.click('toggle');
  assert.equal(h.confirmations.length, 1); assert.match(h.confirmations[0], /session/); assert.match(h.confirmations[0], /公共文本/);
  const posts = h.calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/projects/a/badcase-capture/configure');
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0].body)), { targetDir: '/repo', enabled: true, confirmed: true });
  assert.equal(posts[0].headers['X-CAFF-CSRF-Token'], 'test-csrf');
  assert.equal(h.button('toggle').getAttribute('aria-checked'), 'true'); assert.equal(h.input().disabled, true);
});
test('cancel is side-effect free; disable works without re-authorizing or editing directory', async t => {
  const h = setup(t); await h.panel.select({ id: 'a' }); h.accept(false); await h.click('toggle');
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  h.accept(true); await h.click('toggle'); await h.click('toggle');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1).body)), { enabled: false, confirmed: true });
  assert.equal(h.button('toggle').getAttribute('aria-checked'), 'false');
});
test('failed enable reports unsupported without retry; unknown text is never HTML', async t => {
  const h = setup(t, (url) => { if (url.endsWith('/configure')) throw Object.assign(new Error('failed'), { issues: [{ code: '<img src=x>' }] }); });
  await h.panel.select({ id: 'a' }); await h.click('toggle');
  assert.match(h.root.textContent, /<img src=x>/); assert.equal(h.root.querySelector('img'), null);
  assert.equal(h.button('toggle').getAttribute('aria-checked'), 'false');
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
});
test('a late mutation response cannot overwrite another selected project', async t => {
  let release;
  const h = setup(t, url => url.endsWith('/configure') ? new Promise(resolve => { release = resolve; }) : undefined);
  await h.panel.select({ id: 'a' }); h.button('toggle').click(); await tick();
  await h.panel.select({ id: 'b', name: 'B' }); release(state('enabled')); await tick();
  assert.match(h.root.textContent, /B/); assert.equal(h.button('toggle').getAttribute('aria-checked'), 'false');
});
test('admin-off and invalid state prevent mutation; empty selection clears state', async t => {
  const h = setup(t, url => url === '/api/bootstrap' ? { localAdmin: { modelProviders: { enabled: false } } } : undefined);
  await h.panel.select({ id: 'a' }); assert.equal(h.button('toggle').disabled, true);
  await h.click('toggle'); assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  await h.panel.select(null); assert.equal(h.input().value, ''); assert.match(h.root.textContent, /未选择项目/);
});
test('unavailable usage never shows zero; closing remains available and old metrics clear', async t => {
  const h = setup(t, url => url.endsWith('/badcase-capture') ? { ...state('enabled'), usage: null,
    usageError: 'capture_usage_unavailable' } : undefined);
  await h.panel.select({ id: 'a' }); assert.match(h.root.textContent, /占用未知/); assert.doesNotMatch(h.root.textContent, /0 B/);
  assert.equal(h.button('toggle').disabled, false); await h.click('toggle'); assert.match(h.root.textContent, /已关闭/);
});
