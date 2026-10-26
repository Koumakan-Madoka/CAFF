const assert = require('node:assert/strict');
const test = require('node:test');
const { createApiMutationGuard } = require('../../build/server/http/api-mutation-guard');

const user = { kind: 'user' }, planner = { kind: 'planner', plannerId: 'local-planner', plannerName: 'Test Planner' };
function request(headers = {}, method = 'POST') {
  return { method, headers: { host: '127.0.0.1:43210', origin: 'http://127.0.0.1:43210', 'content-type': 'application/json', 'x-caff-csrf-token': 'test-csrf', ...headers } };
}
function guard(host = '127.0.0.1') { return createApiMutationGuard({ host, getAuthority: () => `${host}:43210`, csrfToken: 'test-csrf' }); }

test('central write guard rejects Host/Origin/CSRF/Content-Type before any route processing', () => {
  for (const [headers, code, status] of [
    [{ host: 'evil.example:43210' }, 'api_host_mismatch', 403],
    [{ host: '' }, 'api_host_mismatch', 403],
    [{ origin: 'http://evil.example:43210' }, 'api_origin_mismatch', 403],
    [{ origin: '' }, 'api_origin_mismatch', 403], [{ origin: 'null' }, 'api_origin_mismatch', 403],
    [{ 'x-caff-csrf-token': '' }, 'api_csrf_invalid', 403], [{ 'x-caff-csrf-token': 'wrong' }, 'api_csrf_invalid', 403],
    [{ 'content-type': 'text/plain' }, 'api_json_required', 415], [{ 'content-type': 'application/jsonp' }, 'api_json_required', 415],
  ]) assert.throws(() => guard().assertMutation(request(headers), '/api/projects', user), error => error.statusCode === status && error.code === code);
  assert.doesNotThrow(() => guard().assertMutation(request(), '/api/projects', user));
  assert.doesNotThrow(() => guard().assertMutation(request({ 'content-type': 'application/json; charset=utf-8' }, 'DELETE'), '/api/projects/id', user));
  for (const name of ['host', 'origin', 'x-caff-csrf-token', 'content-type']) {
    const req = request(); req.rawHeaders = [name, req.headers[name], name, req.headers[name]];
    assert.throws(() => guard().assertMutation(req, '/api/projects', user));
  }
  assert.throws(() => guard().assertMutation(request({ host: 'evil.example', 'x-forwarded-host': '127.0.0.1:43210' }), '/api/projects', user), error => error.code === 'api_host_mismatch');
});

test('loopback writes accept literal aliases only and require Origin to match the validated request Host', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.doesNotThrow(() => guard().assertMutation(request({ host: host + ':43210', origin: `http://${host}:43210` }), '/api/projects', user));
  }
  assert.throws(() => guard().assertMutation(request({ host: 'localhost:43210' }), '/api/projects', user), error => error.code === 'api_origin_mismatch');
  assert.throws(() => guard('192.0.2.1').assertMutation(request(), '/api/projects', user), error => error.code === 'api_host_mismatch');
  assert.throws(() => guard().assertMutation(request({ host: '127.1:43210', origin: 'http://127.1:43210' }), '/api/projects', user));
  assert.throws(() => guard().assertMutation(request({ host: 'localhost:43211', origin: 'http://localhost:43211' }), '/api/projects', user));
});

test('planner bearer replaces only Origin/CSRF; callback and exact webhook domains retain native guards', () => {
  assert.doesNotThrow(() => guard().assertMutation(request({ origin: '', 'x-caff-csrf-token': '' }), '/api/projects', planner));
  assert.throws(() => guard().assertMutation(request({ host: 'evil.example' }), '/api/projects', planner), error => error.code === 'api_host_mismatch');
  assert.throws(() => guard().assertMutation(request({ 'content-type': 'text/plain' }), '/api/projects', planner), error => error.statusCode === 415);
  for (const pathname of ['/api/agent-tools/post-message', '/api/integrations/feishu/webhook']) {
    assert.doesNotThrow(() => guard().assertMutation({ method: 'POST', headers: {} }, pathname, null));
  }
  assert.throws(() => guard().assertMutation({ method: 'POST', headers: {} }, '/api/integrations/feishu/webhook/extra', null));
  assert.doesNotThrow(() => guard().assertMutation({ method: 'GET', headers: { host: 'evil.example' } }, '/api/projects', user));
});

test('only image POST accepts multipart, with boundary, while still requiring Origin and CSRF', () => {
  const pathname = '/api/conversations/room/images';
  const req = request({ 'content-type': 'multipart/form-data; boundary=----test' });
  assert.doesNotThrow(() => guard().assertMutation(req, pathname, user));
  assert.throws(() => guard().assertMutation(req, '/api/projects', user), error => error.statusCode === 415);
  for (const type of ['multipart/form-data', 'multipart/form-data; boundary=one; boundary=two', 'multipart/form-data; boundary="trailing "']) {
    assert.throws(() => guard().assertMutation(request({ 'content-type': type }), pathname, user), error => error.statusCode === 415);
  }
  assert.throws(() => guard().assertMutation(request({ ...req.headers, 'x-caff-csrf-token': '' }), pathname, user), error => error.code === 'api_csrf_invalid');
  assert.throws(() => guard().assertMutation(request({ ...req.headers, origin: 'http://evil.example' }), pathname, user), error => error.code === 'api_origin_mismatch');
});
