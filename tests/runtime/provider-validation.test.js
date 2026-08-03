const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  ProviderValidationError,
  validateModelProviderConnection,
} = require('../../build/server/domain/models/provider-validation');
const { withTempDir } = require('../helpers/temp-dir');

function createRequestHarness(responseOptions = {}) {
  const calls = [];

  function request(url, options, onResponse) {
    const req = new EventEmitter();
    const call = { url: String(url), options, timeoutMs: 0 };
    calls.push(call);

    req.setTimeout = (timeoutMs, onTimeout) => {
      call.timeoutMs = timeoutMs;
      call.onTimeout = onTimeout;
      return req;
    };
    req.destroy = (error) => {
      queueMicrotask(() => req.emit('error', error || new Error('destroyed')));
      return req;
    };
    req.end = () => {
      if (responseOptions.timeout) {
        queueMicrotask(() => call.onTimeout());
        return;
      }

      queueMicrotask(() => {
        const res = new PassThrough();
        res.statusCode = responseOptions.statusCode || 401;
        res.headers = responseOptions.headers || {};
        onResponse(res);
        res.end(responseOptions.body || '');
      });
    };
    return req;
  }

  return { calls, request };
}

test('provider validation uses all-public DNS results and a lookup pinned to those addresses', async () => {
  const harness = createRequestHarness({
    statusCode: 401,
    headers: {
      authorization: 'Bearer response-secret',
      location: 'https://internal.example/secret-path',
    },
    body: 'response-body-secret',
  });
  const result = await validateModelProviderConnection('deepseek', {
    baseUrl: 'https://api.example.com/v1',
    apiKey: '!secret-command --token command-secret',
    headers: {
      Authorization: 'Bearer request-secret',
      'X-Internal-Token': 'header-secret',
    },
  }, {
    request: harness.request,
    async resolveHostname(hostname) {
      assert.equal(hostname, 'api.example.com');
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ];
    },
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'reachable',
    httpStatusClass: '4xx',
  });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].timeoutMs > 0 && harness.calls[0].timeoutMs <= 5000, true);
  assert.equal(harness.calls[0].options.maxRedirects, 0);
  assert.equal(harness.calls[0].options.headers.Authorization, undefined);
  assert.equal(harness.calls[0].options.headers['X-Internal-Token'], undefined);

  const pinned = await new Promise((resolve, reject) => {
    harness.calls[0].options.lookup('api.example.com', { all: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(addresses);
    });
  });
  assert.deepEqual(pinned, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ]);

  const serialized = JSON.stringify(result);
  for (const secret of [
    'response-secret',
    'response-body-secret',
    'internal.example',
    'request-secret',
    'header-secret',
    'secret-command',
    'command-secret',
  ]) {
    assert.equal(serialized.includes(secret), false, `validation leaked ${secret}`);
  }
});

test('provider validation accepts a public IPv6 literal without DNS fallback', async () => {
  const harness = createRequestHarness({ statusCode: 204 });
  const result = await validateModelProviderConnection('ipv6', {
    baseUrl: 'https://[2606:2800:220:1:248:1893:25c8:1946]/v1',
  }, {
    request: harness.request,
    async resolveHostname() {
      throw new Error('literal IP must not use DNS');
    },
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'reachable',
    httpStatusClass: '2xx',
  });
  assert.equal(harness.calls.length, 1);
});

test('provider validation rejects unsafe schemes, userinfo, and any non-public DNS answer before requesting', async () => {
  let requestCount = 0;
  const request = () => {
    requestCount += 1;
    throw new Error('request should not run');
  };

  await assert.rejects(
    () => validateModelProviderConnection('local', { baseUrl: 'file:///etc/passwd' }, { request }),
    (error) => error instanceof ProviderValidationError && error.code === 'provider_validation_scheme_invalid'
  );
  await assert.rejects(
    () => validateModelProviderConnection('local', { baseUrl: 'https://user:pass@example.com' }, { request }),
    (error) => error instanceof ProviderValidationError && error.code === 'provider_validation_userinfo_forbidden'
  );
  await assert.rejects(
    () => validateModelProviderConnection('local', { baseUrl: 'https://example.com' }, {
      request,
      async resolveHostname() {
        return [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ];
      },
    }),
    (error) => error instanceof ProviderValidationError && error.code === 'provider_validation_address_forbidden'
  );
  for (const baseUrl of ['http://127.0.0.1', 'http://[::1]', 'http://[::ffff:7f00:1]']) {
    await assert.rejects(
      () => validateModelProviderConnection('local', { baseUrl }, { request }),
      (error) => error instanceof ProviderValidationError && error.code === 'provider_validation_address_forbidden'
    );
  }
  assert.equal(requestCount, 0);
});

test('provider validation classifies redirects, oversized bodies, and timeouts without response detail', async () => {
  const deps = {
    async resolveHostname() {
      return [{ address: '93.184.216.34', family: 4 }];
    },
  };

  const redirectHarness = createRequestHarness({
    statusCode: 302,
    headers: { location: 'http://127.0.0.1/admin?token=redirect-secret' },
  });
  assert.deepEqual(await validateModelProviderConnection('redirect', {
    baseUrl: 'https://redirect.example.com',
  }, { ...deps, request: redirectHarness.request }), {
    ok: false,
    status: 'redirect',
    httpStatusClass: '3xx',
  });
  assert.equal(redirectHarness.calls.length, 1);

  const largeHarness = createRequestHarness({ body: 'x'.repeat(2048) });
  assert.deepEqual(await validateModelProviderConnection('large', {
    baseUrl: 'https://large.example.com',
  }, { ...deps, request: largeHarness.request, bodyLimit: 128 }), {
    ok: false,
    status: 'response_too_large',
    httpStatusClass: '4xx',
  });

  const timeoutHarness = createRequestHarness({ timeout: true });
  assert.deepEqual(await validateModelProviderConnection('slow', {
    baseUrl: 'https://slow.example.com',
  }, { ...deps, request: timeoutHarness.request, timeoutMs: 50 }), {
    ok: false,
    status: 'timeout',
    httpStatusClass: null,
  });
});

test('provider validation never executes command references', async (t) => {
  const tempDir = withTempDir('caff-provider-command-probe-');
  const markerPath = path.join(tempDir, 'command-executed.txt');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const harness = createRequestHarness();

  await validateModelProviderConnection('command', {
    baseUrl: 'https://command.example.com',
    apiKey: `!node -e "require('fs').writeFileSync('${markerPath}', 'bad')"`,
  }, {
    request: harness.request,
    async resolveHostname() {
      return [{ address: '93.184.216.34', family: 4 }];
    },
  });

  assert.equal(fs.existsSync(markerPath), false);
});
