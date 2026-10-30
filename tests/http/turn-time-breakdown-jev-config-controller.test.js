const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  createTurnTimeBreakdownJevConfigController,
} = require('../../build/server/api/turn-time-breakdown-jev-config-controller');
const {
  JEV_SERVICE_TYPE,
  createJevEnabledResolver,
  createJevServiceConfigService,
} = require('../../build/server/domain/runtime/jev-service-config');
const { withTempDir } = require('../helpers/temp-dir');

const ROUTE = '/api/system-services/turn-time-breakdown-jev';

function createHarness(t) {
  const tempDir = withTempDir('caff-jev-config-http-');
  const store = createChatAppStore({
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'chat.sqlite'),
  });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const service = createJevServiceConfigService({
    store,
    turnTimeBreakdownRepository: store.turnTimeBreakdownRepository,
  });
  const broadcasts = [];
  const controller = createTurnTimeBreakdownJevConfigController({
    service,
    host: '127.0.0.1',
    port: 4313,
    csrfToken: 'system-service-csrf',
    broadcastEvent(name, payload) {
      broadcasts.push({ name, payload });
    },
  });
  return { controller, store, service, broadcasts };
}

async function invoke(controller, options = {}) {
  const method = options.method || 'GET';
  const pathname = options.pathname || ROUTE;
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

test('jev config GET returns three-state status and is local-admin guarded', async (t) => {
  const { controller } = createHarness(t);
  const response = await invoke(controller);
  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.config.enabled, false);
  assert.equal(response.json.config.apiKeyConfigured, false);
  assert.equal(response.json.status.reason, 'api_key_missing');
  assert.equal(response.json.status.effective, false);
  assert.equal(response.json.status.endpoint, 'https://api.typesafe.ai');
  assert.equal(response.json.status.model, 'jev-latest');
  assert.equal(response.json.cache.entries, 0);

  await assert.rejects(
    () => invoke(controller, { remoteAddress: '192.168.1.8' }),
    (error) => error.statusCode === 403 && error.issues[0].code === 'system_service_config_local_only'
  );
});

test('jev config PUT key + toggle reaches enabled; every response stays free of key material', async (t) => {
  const { controller, store, broadcasts } = createHarness(t);
  const isJevEnabled = createJevEnabledResolver({ store });

  assert.equal(isJevEnabled(), false);

  // Toggle first, key later: the intermediate state is honestly reported.
  const toggled = await invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { enabled: true } });
  assert.equal(toggled.json.config.enabled, true);
  assert.equal(toggled.json.status.reason, 'api_key_missing');
  assert.equal(toggled.json.status.effective, false);
  assert.equal(isJevEnabled(), false);

  const keyed = await invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { apiKey: 'sk-controller-secret' } });
  assert.equal(keyed.statusCode, 200);
  assert.equal(keyed.json.config.apiKeyConfigured, true);
  assert.equal(keyed.json.status.effective, true);
  assert.equal(keyed.json.status.reason, 'enabled');
  assert.equal(JSON.stringify(keyed.json).includes('sk-controller-secret'), false);
  // Same-process immediate effect: no server rebuild, the next resolver
  // call reads the stored key.
  assert.equal(isJevEnabled(), true);
  assert.ok(broadcasts.every((entry) => !JSON.stringify(entry).includes('sk-controller-secret')),
    'broadcast events must never carry the key');

  // Clearing the key flips back in-process.
  const cleared = await invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { clearApiKey: true } });
  assert.equal(cleared.json.config.apiKeyConfigured, false);
  assert.equal(cleared.json.status.reason, 'api_key_missing');
  assert.equal(isJevEnabled(), false);

  const off = await invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { enabled: false } });
  assert.equal(off.json.config.enabled, false);
  assert.equal(isJevEnabled(), false);
});

test('jev config PUT rejects credential look-alike fields with 422; apiKey is the only accepted one', async (t) => {
  const { controller, store } = createHarness(t);

  for (const field of ['api_key', 'key', 'token', 'secret', 'password', 'authorization']) {
    await assert.rejects(
      () => invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { [field]: 'x' } }),
      (error) => error.statusCode === 422 && error.issues[0].code === 'credential_field_not_accepted',
      `field ${field} must be rejected`
    );
  }

  // The accepted field goes through.
  const ok = await invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { apiKey: 'sk-accepted' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(store.getSystemServiceCredential(JEV_SERVICE_TYPE).apiKey, 'sk-accepted');

  // Rejected writes must not have flipped anything.
  assert.equal(store.getSystemServiceToggle(JEV_SERVICE_TYPE), false);
});

test('jev config PUT rejects invalid payloads with 422 instead of coercing them', async (t) => {
  const { controller, store } = createHarness(t);

  await assert.rejects(
    () => invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { enabled: 'true' } }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'invalid_enabled_value'
  );
  await assert.rejects(
    () => invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { apiKey: 'sk-a', clearApiKey: true } }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'credential_conflict'
  );
  await assert.rejects(
    () => invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { baseUrl: 'not-a-url' } }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'invalid_base_url'
  );
  // The rejected writes must not have flipped anything.
  assert.equal(store.getSystemServiceToggle(JEV_SERVICE_TYPE), false);
  assert.equal(store.getSystemServiceCredential(JEV_SERVICE_TYPE), null);
});

test('jev config PUT endpoint/model overrides show up in GET with userinfo stripped', async (t) => {
  const { controller } = createHarness(t);

  const response = await invoke(controller, {
    method: 'PUT',
    headers: mutationHeaders(),
    body: { baseUrl: 'https://user:SUPERSECRET@proxy.example.com/v1', model: 'jev-pro' },
  });
  assert.equal(response.statusCode, 200);
  const raw = JSON.stringify(response.json);
  assert.ok(!raw.includes('SUPERSECRET'), 'userinfo must never appear in the response');
  assert.equal(response.json.status.endpoint, 'https://proxy.example.com/v1');
  assert.equal(response.json.status.model, 'jev-pro');

  // Empty string resets to the client defaults.
  const reset = await invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { baseUrl: '', model: '' } });
  assert.equal(reset.json.status.endpoint, 'https://api.typesafe.ai');
  assert.equal(reset.json.status.model, 'jev-latest');
});

test('jev config mutations require CSRF + loopback', async (t) => {
  const { controller } = createHarness(t);

  await assert.rejects(
    () => invoke(controller, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: { enabled: true } }),
    (error) => error.statusCode === 403
  );
  await assert.rejects(
    () => invoke(controller, {
      method: 'PUT',
      headers: mutationHeaders(),
      remoteAddress: '192.168.1.8',
      body: { enabled: true },
    }),
    (error) => error.statusCode === 403
  );
  await assert.rejects(
    () => invoke(controller, { method: 'DELETE', pathname: `${ROUTE}/cache`, headers: { 'content-type': 'application/json; charset=utf-8', origin: 'http://127.0.0.1:4313' } }),
    (error) => error.statusCode === 403
  );
});

test('jev cache DELETE clears entries and leaves classified steps untouched', async (t) => {
  const { controller, store } = createHarness(t);
  const repository = store.turnTimeBreakdownRepository;

  repository.setJevCacheEntry('k1', { category: 'read', subcategory: null, runKind: null, confidence: 0.8 });
  repository.setJevCacheEntry('k2', { category: 'test', subcategory: null, runKind: 'full-regression', confidence: null });
  repository.upsertStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    stepKey: 'call-1',
    toolName: 'bash',
    category: 'test',
    classifiedBy: 'jev',
    jevStatus: 'resolved',
    startedAt: '2026-10-20T10:00:00.000Z',
    durationMs: 500,
  });

  const before = await invoke(controller);
  assert.equal(before.json.cache.entries, 2);

  const response = await invoke(controller, { method: 'DELETE', pathname: `${ROUTE}/cache`, headers: mutationHeaders() });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.cleared, 2);

  const after = await invoke(controller);
  assert.equal(after.json.cache.entries, 0);
  const steps = repository.listSteps('task-1');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].category, 'test');
});

// Cross-layer seam tests: a real node http server, the real controller
// (with the real local-admin guard), and the real browser fetchJson client
// from public/shared/api-client.js. The old 415-on-clear regression lived at
// this seam when the client omitted JSON Content-Type on bodyless mutations.
// P1 now declares JSON for every JSON mutation; raw non-JSON callers must still
// fail. Neither controller-only nor JSDOM-only harnesses cover the wire seam.
async function withRealServer(t, run) {
  const http = require('node:http');
  const vm = require('node:vm');

  const tempDir = withTempDir('caff-jev-config-seam-');
  const store = createChatAppStore({
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'chat.sqlite'),
  });

  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const authority = `127.0.0.1:${port}`;

  const service = createJevServiceConfigService({
    store,
    turnTimeBreakdownRepository: store.turnTimeBreakdownRepository,
  });
  const controller = createTurnTimeBreakdownJevConfigController({
    service,
    host: '127.0.0.1',
    port,
    csrfToken: 'system-service-csrf',
  });
  server.on('request', async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${authority}`);
      await controller({ req, res, pathname: requestUrl.pathname, requestUrl });
    } catch (error) {
      const { sendJson, buildErrorJsonPayload } = require('../../build/server/http/response');
      sendJson(res, error.statusCode || 500, buildErrorJsonPayload(error));
    }
  });

  // Load the real browser client (it reads `window` and the global fetch).
  const clientContext = { window: {}, fetch: globalThis.fetch, JSON, Error };
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'public/shared/api-client.js'), 'utf8'),
    clientContext,
    { filename: 'public/shared/api-client.js' }
  );
  const fetchJson = clientContext.window.CaffShared.fetchJson;

  t.after(() => {
    server.close();
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const mutationHeaders = {
    origin: `http://${authority}`,
    'x-caff-csrf-token': 'system-service-csrf',
  };

  await run({ store, fetchJson, baseUrl: `http://${authority}${ROUTE}`, mutationHeaders });
}

test('cross-layer: fetchJson declares JSON for bodyless DELETE, while a raw non-JSON DELETE is rejected 415', async (t) => {
  await withRealServer(t, async ({ store, fetchJson, baseUrl, mutationHeaders }) => {
    const repository = store.turnTimeBreakdownRepository;
    repository.setJevCacheEntry('k1', { category: 'read', subcategory: null, runKind: null, confidence: 0.8 });
    repository.setJevCacheEntry('k2', { category: 'test', subcategory: null, runKind: null, confidence: null });
    repository.upsertStep({
      taskId: 'task-seam',
      messageId: 'msg-1',
      stepKey: 'call-1',
      toolName: 'bash',
      category: 'test',
      classifiedBy: 'jev',
      jevStatus: 'resolved',
      startedAt: '2026-10-20T10:00:00.000Z',
      durationMs: 500,
    });

    const before = await fetchJson(baseUrl);
    assert.equal(before.cache.entries, 2);

    // Raw non-JSON callers must still fail. The shared client now declares
    // JSON even without an explicit body, as required by the P1 write guard.
    const rejected = await fetch(`${baseUrl}/cache`, { method: 'DELETE', headers: mutationHeaders });
    assert.equal(rejected.status, 415);
    assert.equal((await rejected.json()).issues[0].code, 'system_service_config_json_required');
    assert.equal((await fetchJson(baseUrl)).cache.entries, 2, 'the rejected DELETE must not have cleared anything');

    // Both explicit {} (the existing UI) and omitted bodies use JSON now.
    const cleared = await fetchJson(`${baseUrl}/cache`, {
      method: 'DELETE',
      headers: mutationHeaders,
    });
    assert.equal(cleared.cleared, 2);

    const after = await fetchJson(baseUrl);
    assert.equal(after.cache.entries, 0);
    const steps = repository.listSteps('task-seam');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].category, 'test', 'clearing the cache must not touch classified steps');
  });
});

test('cross-layer: real fetchJson writes a key over the wire; the key never comes back, not even in error bodies', async (t) => {
  await withRealServer(t, async ({ store, fetchJson, baseUrl, mutationHeaders }) => {
    const KEY = 'sk-wire-secret-9f2b7c';

    const putResponse = await fetchJson(baseUrl, {
      method: 'PUT',
      headers: mutationHeaders,
      body: { enabled: true, apiKey: KEY },
    });
    assert.equal(putResponse.config.apiKeyConfigured, true);
    assert.equal(putResponse.status.effective, true);
    assert.equal(JSON.stringify(putResponse).includes(KEY), false, 'PUT response must not echo the key');

    const getResponse = await fetchJson(baseUrl);
    assert.equal(JSON.stringify(getResponse).includes(KEY), false, 'GET must not echo the key');

    // A rejected write's error body must not carry the key either (send
    // the key alongside an invalid field so a body-echoing handler would
    // include it).
    await assert.rejects(
      () => fetchJson(baseUrl, { method: 'PUT', headers: mutationHeaders, body: { enabled: 'yes', apiKey: KEY } }),
      (error) => {
        assert.equal(error.status, 422);
        assert.equal(JSON.stringify(error).includes(KEY), false, 'error body must not echo the key');
        return true;
      }
    );

    // The stored row (internal surface) does hold the key — that is the
    // point of the write — and the resolver sees it in-process.
    assert.equal(store.getSystemServiceCredential(JEV_SERVICE_TYPE).apiKey, KEY);
    assert.equal(createJevEnabledResolver({ store })(), true);
  });
});
