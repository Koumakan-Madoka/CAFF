const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const {
  createRecoveryScribeConfigController,
} = require('../../build/server/api/recovery-scribe-config-controller');
const {
  createRecoveryScribeConfigManager,
} = require('../../build/server/domain/conversation/recovery-scribe-config');

function createHarness() {
  const updates = [];
  let current = {
    config: {
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: 'low',
      timeoutMs: 60_000,
    },
    source: 'runtime_defaults',
    updatedAt: null,
    modelOptions: [],
  };
  const service = {
    getConfiguration() {
      return structuredClone(current);
    },
    updateConfiguration(payload) {
      updates.push(structuredClone(payload));
      current = {
        ...current,
        config: structuredClone(payload),
        source: 'persisted',
        updatedAt: '2026-08-26T12:00:00.000Z',
      };
      return structuredClone(current);
    },
  };
  const broadcasts = [];
  const controller = createRecoveryScribeConfigController({
    service,
    host: '127.0.0.1',
    port: 4313,
    csrfToken: 'system-service-csrf',
    broadcastEvent(name, payload) {
      broadcasts.push({ name, payload });
    },
  });
  return { controller, updates, broadcasts };
}

async function invoke(controller, options = {}) {
  const method = options.method || 'GET';
  const pathname = '/api/system-services/recovery-scribe';
  const req = new PassThrough();
  req.method = method;
  req.headers = {
    host: '127.0.0.1:4313',
    ...(options.headers || {}),
  };
  req.socket = { remoteAddress: options.remoteAddress || '127.0.0.1' };
  const state = { statusCode: 0, headers: {}, body: '' };
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
    requestUrl: new URL(`http://127.0.0.1:4313${pathname}`),
  });
  req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  const handled = await handledPromise;
  return {
    handled,
    statusCode: state.statusCode,
    json: state.body ? JSON.parse(state.body) : {},
  };
}

function mutationHeaders() {
  return {
    'content-type': 'application/json; charset=utf-8',
    origin: 'http://127.0.0.1:4313',
    'x-caff-csrf-token': 'system-service-csrf',
  };
}

test('recovery scribe config GET is local-admin guarded and credential-blind', async () => {
  const { controller } = createHarness();
  const response = await invoke(controller);
  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.config.provider, 'deepseek');
  assert.equal(response.json.source, 'runtime_defaults');

  await assert.rejects(
    () => invoke(controller, { remoteAddress: '192.168.1.8' }),
    (error) => error.statusCode === 403 && error.issues[0].code === 'system_service_config_local_only'
  );
});

test('recovery scribe config PUT projects stable 422 issues from authoritative validation', async () => {
  const service = createRecoveryScribeConfigManager({
    defaults: {
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: 'low',
      timeoutMs: 60_000,
    },
    store: {
      getSystemServiceConfig() { return null; },
      saveSystemServiceConfig() { throw new Error('invalid input must not persist'); },
    },
    modelCatalog: {
      getOptions() {
        return [{
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          supportedThinkingLevels: ['off', 'low'],
        }];
      },
    },
  });
  const controller = createRecoveryScribeConfigController({
    service,
    host: '127.0.0.1',
    port: 4313,
    csrfToken: 'system-service-csrf',
  });

  await assert.rejects(
    () => invoke(controller, {
      method: 'PUT',
      headers: mutationHeaders(),
      body: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        thinking: 'low',
        timeoutMs: 60_001,
      },
    }),
    (error) => error.statusCode === 422
      && error.issues[0].code === 'recovery_config_timeout_invalid'
      && error.issues[0].path === 'body.timeoutMs'
  );
});

test('recovery scribe config PUT saves one full snapshot and broadcasts immediate activation', async () => {
  const { controller, updates, broadcasts } = createHarness();
  const body = {
    enabled: false,
    provider: 'openai',
    model: 'gpt-5',
    thinking: 'medium',
    timeoutMs: 45_000,
  };
  const response = await invoke(controller, {
    method: 'PUT',
    headers: mutationHeaders(),
    body,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(updates, [body]);
  assert.equal(response.json.source, 'persisted');
  assert.deepEqual(broadcasts, [{
    name: 'system_service_config_updated',
    payload: {
      serviceType: 'recovery_scribe',
      enabled: false,
      updatedAt: '2026-08-26T12:00:00.000Z',
    },
  }]);

  await assert.rejects(
    () => invoke(controller, { method: 'PUT', body, headers: { 'content-type': 'application/json' } }),
    (error) => error.statusCode === 403 && error.issues[0].code === 'system_service_config_origin_mismatch'
  );
});
