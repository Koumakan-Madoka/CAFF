const assert = require('node:assert/strict');
const test = require('node:test');

const { createHealthController } = require('../../build/server/api/health-controller');

function createResponse() {
  const state = { body: '', headers: {}, statusCode: 0 };
  return {
    res: {
      writeHead(statusCode, headers) {
        state.statusCode = statusCode;
        state.headers = headers || {};
      },
      end(body = '') {
        state.body = String(body || '');
      },
    },
    state,
  };
}

test('health controller serves a fresh no-store readiness payload', async () => {
  let calls = 0;
  const controller = createHealthController({
    getHealthStatus() {
      calls += 1;
      return { ok: true, timestamp: `call-${calls}` };
    },
  });
  const first = createResponse();
  const second = createResponse();

  assert.equal(await controller({
    req: { method: 'GET' },
    res: first.res,
    pathname: '/api/health',
    requestUrl: new URL('http://127.0.0.1/api/health'),
  }), true);
  assert.equal(await controller({
    req: { method: 'GET' },
    res: second.res,
    pathname: '/api/health',
    requestUrl: new URL('http://127.0.0.1/api/health'),
  }), true);

  assert.equal(first.state.statusCode, 200);
  assert.equal(first.state.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(first.state.body), { ok: true, timestamp: 'call-1' });
  assert.deepEqual(JSON.parse(second.state.body), { ok: true, timestamp: 'call-2' });
  assert.equal(calls, 2);
});

test('health controller falls through for unsupported methods and paths', async () => {
  const controller = createHealthController({
    getHealthStatus() {
      throw new Error('must not be called');
    },
  });
  const response = createResponse();

  assert.equal(await controller({
    req: { method: 'POST' },
    res: response.res,
    pathname: '/api/health',
    requestUrl: new URL('http://127.0.0.1/api/health'),
  }), false);
  assert.equal(await controller({
    req: { method: 'GET' },
    res: response.res,
    pathname: '/api/not-health',
    requestUrl: new URL('http://127.0.0.1/api/not-health'),
  }), false);
  assert.equal(response.state.statusCode, 0);
});
