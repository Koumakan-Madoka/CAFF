const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
function boot(handler) {
  const calls = [];
  const context = { URL, window: { CaffShared: {}, location: new URL('http://localhost:4312/') }, fetch: async (url, options = {}) => {
    calls.push({ url, options });
    const data = handler ? await handler(url, options, calls) : { apiSecurity: { csrfToken: 'test-process-csrf' } };
    return { ok: data.status ? data.status < 400 : true, status: data.status || 200, text: async () => JSON.stringify(data.body || data) };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/shared/api-client.js'), 'utf8'), context);
  return { api: context.window.CaffShared, calls };
}

test('all pages lazily bootstrap one CSRF token before concurrent JSON/bodyless writes', async () => {
  const { api, calls } = boot();
  await Promise.all(['/api/projects', '/api/agents', '/api/conversations', '/api/system-services/example'].map(url => api.fetchJson(url, { method: 'POST', body: { sample: true } })));
  await api.fetchJson('/api/projects/id', { method: 'DELETE' });
  assert.equal(calls.filter(call => call.url === '/api/bootstrap').length, 1);
  for (const call of calls.filter(call => call.url !== '/api/bootstrap')) {
    assert.equal(call.options.headers['X-CAFF-CSRF-Token'], 'test-process-csrf');
    assert.equal(call.options.headers['Content-Type'], 'application/json');
  }
});

test('bootstrap token is reused for multipart uploads without manually setting a boundary', async () => {
  const { api, calls } = boot();
  await api.fetchJson('/api/bootstrap');
  const body = { syntheticFormData: true };
  await api.fetchFormDataJson('/api/conversations/id/images', { body, headers: { 'Content-Type': 'multipart/form-data; boundary=stale' } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.body, body);
  assert.equal(calls[1].options.headers['X-CAFF-CSRF-Token'], 'test-process-csrf');
  assert.equal(calls[1].options.headers['Content-Type'], undefined);
});

test('stale CSRF refreshes bootstrap but never replays the failed mutation automatically', async () => {
  let bootstraps = 0, writes = 0;
  const { api, calls } = boot(url => {
    if (url === '/api/bootstrap') return { apiSecurity: { csrfToken: ++bootstraps === 1 ? 'old-csrf' : 'new-csrf' } };
    return ++writes === 1 ? { status: 403, body: { error: 'stale', code: 'api_csrf_invalid' } } : { ok: true };
  });
  await assert.rejects(api.fetchJson('/api/projects', { method: 'POST', body: {} }), error => error.code === 'api_csrf_invalid');
  assert.equal(writes, 1);
  assert.equal(bootstraps, 2);
  await api.fetchJson('/api/projects', { method: 'POST', body: {}, headers: { 'x-caff-csrf-token': 'old-csrf' } });
  assert.equal(writes, 2);
  assert.equal(calls.at(-1).options.headers['X-CAFF-CSRF-Token'], 'new-csrf');
  assert.equal(calls.at(-1).options.headers['x-caff-csrf-token'], undefined);
});

test('a missing bootstrap CSRF token prevents the first write instead of silently downgrading', async () => {
  const { api, calls } = boot(() => ({ apiSecurity: {} }));
  await assert.rejects(api.fetchJson('/api/projects', { method: 'POST', body: {} }), /CSRF token/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/bootstrap');
});

test('CSRF auto-attachment never leaks the cached token to a third-party URL', async () => {
  const { api, calls } = boot();
  await api.fetchJson('/api/bootstrap');
  await api.fetchJson('https://external.example/api/projects', { method: 'POST', body: {} });
  assert.equal(calls[1].options.headers['X-CAFF-CSRF-Token'], undefined);
});
