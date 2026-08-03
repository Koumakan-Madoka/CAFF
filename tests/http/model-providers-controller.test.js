const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { createModelProvidersController } = require('../../build/server/api/model-providers-controller');
const { ProviderValidationError } = require('../../build/server/domain/models/provider-validation');
const { withTempDir } = require('../helpers/temp-dir');

function createHarness(t, options = {}) {
  const agentDir = withTempDir('caff-model-providers-http-');
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

  const rawDocument = options.document || {
    providers: {
      deepseek: {
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'openai-completions',
        apiKey: '!resolve-deepseek --token controller-secret',
        headers: {
          Authorization: 'Bearer header-secret',
        },
        models: [{ id: 'deepseek-v3.2', family: 'deepseek' }],
      },
    },
  };
  fs.writeFileSync(path.join(agentDir, 'models.json'), `${JSON.stringify(rawDocument, null, 2)}\n`, 'utf8');

  const validationCalls = [];
  const controller = createModelProvidersController({
    agentDir,
    host: options.host || '127.0.0.1',
    port: options.port || 4312,
    csrfToken: options.csrfToken || 'provider-csrf-token',
    externalAuthProviderIds: new Set(options.externalAuthProviderIds || []),
    async validateProvider(providerId, provider) {
      validationCalls.push({ providerId, provider });
      if (typeof options.validateProvider === 'function') {
        return options.validateProvider(providerId, provider);
      }
      return { ok: true, status: 'reachable' };
    },
  });

  return { agentDir, controller, validationCalls };
}

async function invoke(controller, options = {}) {
  const method = options.method || 'GET';
  const pathname = options.pathname || '/api/model-providers';
  const host = options.hostHeader || '127.0.0.1:4312';
  const req = new PassThrough();
  req.method = method;
  req.headers = {
    host,
    ...(options.headers || {}),
  };
  req.socket = {
    remoteAddress: options.remoteAddress || '127.0.0.1',
  };
  const state = {
    body: '',
    headers: {},
    statusCode: 0,
  };
  const res = {
    writeHead(statusCode, headers) {
      state.statusCode = statusCode;
      state.headers = headers || {};
    },
    end(chunk = '') {
      state.body = String(chunk || '');
    },
  };

  const handledPromise = controller({
    req,
    res,
    pathname,
    requestUrl: new URL(`http://${host}${pathname}`),
  });
  if (options.body === undefined) {
    req.end();
  } else {
    req.end(JSON.stringify(options.body));
  }

  const handled = await handledPromise;
  return {
    handled,
    headers: state.headers,
    json: state.body ? JSON.parse(state.body) : {},
    statusCode: state.statusCode,
  };
}

function mutationHeaders(overrides = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    origin: 'http://127.0.0.1:4312',
    'x-caff-csrf-token': 'provider-csrf-token',
    ...overrides,
  };
}

test('provider GET is loopback/Host gated and returns credential-blind state without CORS trust', async (t) => {
  const { controller } = createHarness(t, { externalAuthProviderIds: ['deepseek'] });
  const response = await invoke(controller);

  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(response.json.providers[0].hasApiKey, true);
  assert.equal(response.json.providers[0].hasExternalAuth, true);
  assert.equal(response.json.providers[0].apiKeyMode, 'command');

  const serialized = JSON.stringify(response.json);
  for (const secret of ['controller-secret', 'resolve-deepseek', 'header-secret']) {
    assert.equal(serialized.includes(secret), false, `GET leaked ${secret}`);
  }
});

test('provider routes reject non-loopback listen hosts, remote sockets, and mismatched Host', async (t) => {
  const nonLocal = createHarness(t, { host: '0.0.0.0' });
  await assert.rejects(
    () => invoke(nonLocal.controller),
    (error) => error.statusCode === 403 && error.issues[0].code === 'provider_config_local_only'
  );

  const local = createHarness(t);
  await assert.rejects(
    () => invoke(local.controller, { remoteAddress: '192.168.1.20' }),
    (error) => error.statusCode === 403 && error.issues[0].code === 'provider_config_local_only'
  );
  await assert.rejects(
    () => invoke(local.controller, { hostHeader: 'evil.example:4312' }),
    (error) => error.statusCode === 403 && error.issues[0].code === 'provider_config_host_mismatch'
  );
});

test('provider mutations require JSON, exact Origin, and the per-process CSRF token', async (t) => {
  const { controller } = createHarness(t);
  const request = {
    method: 'PUT',
    pathname: '/api/model-providers/deepseek',
    body: {
      name: 'DeepSeek Cloud',
      apiKeyMode: 'command',
      apiKey: '',
      models: [{ id: 'deepseek-v3.2', family: 'deepseek' }],
    },
  };

  await assert.rejects(
    () => invoke(controller, { ...request, headers: mutationHeaders({ 'content-type': 'text/plain' }) }),
    (error) => error.statusCode === 415 && error.issues[0].code === 'provider_config_json_required'
  );
  await assert.rejects(
    () => invoke(controller, { ...request, headers: mutationHeaders({ origin: 'http://evil.example:4312' }) }),
    (error) => error.statusCode === 403 && error.issues[0].code === 'provider_config_origin_mismatch'
  );
  await assert.rejects(
    () => invoke(controller, { ...request, headers: mutationHeaders({ 'x-caff-csrf-token': 'wrong' }) }),
    (error) => error.statusCode === 403 && error.issues[0].code === 'provider_config_csrf_invalid'
  );
});

test('provider update preserves a blank secret and returns only masked write state', async (t) => {
  const { agentDir, controller } = createHarness(t);
  const response = await invoke(controller, {
    method: 'PUT',
    pathname: '/api/model-providers/deepseek',
    headers: mutationHeaders(),
    body: {
      name: 'DeepSeek Cloud',
      api: 'openai-responses',
      apiKeyMode: 'command',
      apiKey: '   ',
      models: [{ id: 'deepseek-v3.2', family: 'deepseek' }],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.providers[0].name, 'DeepSeek Cloud');
  assert.equal(response.json.providers[0].hasApiKey, true);
  assert.ok(['durable', 'directory_sync_unsupported'].includes(response.json.write.durability));
  assert.equal(response.json.write.backupCreated, true);
  assert.equal(JSON.stringify(response.json).includes('controller-secret'), false);

  const stored = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'));
  assert.equal(stored.providers.deepseek.apiKey, '!resolve-deepseek --token controller-secret');
});

test('provider secret clear, validation, and provider removal remain independent actions', async (t) => {
  const { controller, validationCalls } = createHarness(t);
  const cleared = await invoke(controller, {
    method: 'DELETE',
    pathname: '/api/model-providers/deepseek/secret',
    headers: mutationHeaders(),
  });
  assert.equal(cleared.json.providers[0].hasApiKey, false);
  assert.equal(cleared.json.providers.length, 1);

  const validation = await invoke(controller, {
    method: 'POST',
    pathname: '/api/model-providers/deepseek/validate',
    headers: mutationHeaders(),
    body: {},
  });
  assert.deepEqual(validation.json.validation, { ok: true, status: 'reachable' });
  assert.equal(validationCalls.length, 1);

  const removed = await invoke(controller, {
    method: 'DELETE',
    pathname: '/api/model-providers/deepseek',
    headers: mutationHeaders(),
  });
  assert.deepEqual(removed.json.providers, []);
});

test('provider controller replaces unexpected secret-bearing failures with a redacted error', async (t) => {
  const { controller } = createHarness(t, {
    validateProvider() {
      throw new Error('probe failed with controller-secret and Authorization header-secret');
    },
  });

  await assert.rejects(
    () => invoke(controller, {
      method: 'POST',
      pathname: '/api/model-providers/deepseek/validate',
      headers: mutationHeaders(),
      body: {},
    }),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.equal(error.issues[0].code, 'provider_config_operation_failed');
      assert.equal(error.message.includes('controller-secret'), false);
      assert.equal(error.message.includes('header-secret'), false);
      return true;
    }
  );
});

test('provider controller returns stable redacted issues for unsafe validation targets', async (t) => {
  const { controller } = createHarness(t, {
    validateProvider() {
      throw new ProviderValidationError(
        'provider_validation_address_forbidden',
        'providers.deepseek.baseUrl'
      );
    },
  });

  await assert.rejects(
    () => invoke(controller, {
      method: 'POST',
      pathname: '/api/model-providers/deepseek/validate',
      headers: mutationHeaders(),
      body: {},
    }),
    (error) => {
      assert.equal(error.statusCode, 422);
      assert.deepEqual(error.issues, [{
        code: 'provider_validation_address_forbidden',
        path: 'providers.deepseek.baseUrl',
      }]);
      return true;
    }
  );
});
