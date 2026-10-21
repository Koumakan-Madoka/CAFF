const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  createTurnTimeBreakdownJevConfigController,
} = require('../../build/server/api/turn-time-breakdown-jev-config-controller');
const { createJevServiceConfigService } = require('../../build/server/domain/runtime/jev-service-config');
const { withTempDir } = require('../helpers/temp-dir');

const ROUTE = '/api/system-services/turn-time-breakdown-jev';

function createHarness(t, options = {}) {
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
    masterSwitchEnabled: options.masterSwitchEnabled !== undefined ? options.masterSwitchEnabled : true,
    apiKeyConfigured: options.apiKeyConfigured !== undefined ? options.apiKeyConfigured : true,
    connectionInfo: options.connectionInfo || { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' },
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

test('jev config GET returns four-state status and is local-admin guarded', async (t) => {
  const { controller } = createHarness(t);
  const response = await invoke(controller);
  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.config.enabled, false);
  assert.equal(response.json.status.reason, 'db_switch_off');
  assert.equal(response.json.status.effective, false);
  assert.equal(response.json.status.endpoint, 'https://api.typesafe.ai');
  assert.equal(response.json.cache.entries, 0);

  await assert.rejects(
    () => invoke(controller, { remoteAddress: '192.168.1.8' }),
    (error) => error.statusCode === 403 && error.issues[0].code === 'system_service_config_local_only'
  );
});

test('jev config GET serializes without key material or URL userinfo', async (t) => {
  const { controller } = createHarness(t, {
    connectionInfo: { baseUrl: 'https://user:SUPERSECRET@api.typesafe.ai', model: 'jev-latest' },
  });
  const response = await invoke(controller);
  assert.equal(response.statusCode, 200);
  const raw = JSON.stringify(response.json);
  assert.ok(!raw.includes('SUPERSECRET'), 'key material must never appear in the response');
  assert.ok(!raw.includes('user:'), 'URL userinfo must never appear in the response');
  assert.equal(response.json.status.endpoint, 'https://api.typesafe.ai');
});

test('jev config PUT flips the toggle and broadcasts; the pipeline resolver sees it immediately', async (t) => {
  const { controller, store, broadcasts } = createHarness(t);
  const { createJevEnabledResolver } = require('../../build/server/domain/runtime/jev-service-config');
  const isJevEnabled = createJevEnabledResolver({ store, masterSwitchEnabled: true, apiKeyConfigured: true });

  assert.equal(isJevEnabled(), false);
  const response = await invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { enabled: true } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.config.enabled, true);
  assert.equal(response.json.status.effective, true);
  assert.equal(response.json.status.reason, 'enabled');
  // Same-process immediate effect: no server rebuild, the next resolver
  // call reads the flipped row.
  assert.equal(isJevEnabled(), true);
  assert.deepEqual(broadcasts.map((entry) => entry.name), ['system_service_config_updated']);

  const off = await invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { enabled: false } });
  assert.equal(off.json.config.enabled, false);
  assert.equal(isJevEnabled(), false);
});

test('jev config PUT rejects credential fields with 422 instead of ignoring them', async (t) => {
  const { controller, store } = createHarness(t);

  await assert.rejects(
    () => invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { enabled: true, apiKey: 'x' } }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'credential_field_not_accepted'
  );
  await assert.rejects(
    () => invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { token: 'x' } }),
    (error) => error.statusCode === 422
  );
  // The rejected write must not have flipped anything.
  assert.equal(store.getSystemServiceToggle('turn-time-breakdown-jev'), false);
});

test('jev config PUT rejects a non-boolean enabled with 422 instead of coercing it to off', async (t) => {
  const { controller, store } = createHarness(t);

  await assert.rejects(
    () => invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { enabled: 'true' } }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'invalid_enabled_value'
  );
  await assert.rejects(
    () => invoke(controller, { method: 'PUT', headers: mutationHeaders(), body: { enabled: 1 } }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'invalid_enabled_value'
  );
  // The rejected writes must not have flipped anything.
  assert.equal(store.getSystemServiceToggle('turn-time-breakdown-jev'), false);
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

test('status reasons track env gates: master switch off and key missing stay distinguishable', async (t) => {
  const masterOff = createHarness(t, { masterSwitchEnabled: false });
  const r1 = await invoke(masterOff.controller);
  assert.equal(r1.json.status.reason, 'master_switch_off');

  const keyMissing = createHarness(t, { apiKeyConfigured: false });
  const r2 = await invoke(keyMissing.controller);
  assert.equal(r2.json.status.reason, 'api_key_missing');
});

// Cross-layer seam test: a real node http server, the real controller (with
// the real local-admin guard), and the real browser fetchJson client from
// public/shared/api-client.js. The 415-on-clear regression lived exactly at
// this seam (guard requires JSON content-type; fetchJson only adds it when a
// body is present), which neither the controller harness nor the JSDOM UI
// harness crossed.
test('cross-layer: real fetchJson against a real server can clear the cache, and a bodyless DELETE is rejected 415', async (t) => {
  const http = require('node:http');
  const vm = require('node:vm');
  const { buildErrorJsonPayload } = require('../../build/server/http/response');

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
    masterSwitchEnabled: true,
    apiKeyConfigured: true,
    connectionInfo: { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' },
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
      const { sendJson } = require('../../build/server/http/response');
      sendJson(res, error.statusCode || 500, buildErrorJsonPayload(error));
    }
  });

  t.after(() => {
    server.close();
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Load the real browser client (it reads `window` and the global fetch).
  const clientContext = { window: {}, fetch: globalThis.fetch, JSON, Error };
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'public/shared/api-client.js'), 'utf8'),
    clientContext,
    { filename: 'public/shared/api-client.js' }
  );
  const fetchJson = clientContext.window.CaffShared.fetchJson;

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

  const baseUrl = `http://${authority}${ROUTE}`;
  const mutationHeaders = {
    origin: `http://${authority}`,
    'x-caff-csrf-token': 'system-service-csrf',
  };

  const before = await fetchJson(baseUrl);
  assert.equal(before.cache.entries, 2);

  // The regression shape: DELETE without a body → fetchJson sends no JSON
  // content-type → the guard must reject 415. This is exactly what the
  // pre-fix UI sent, and it must keep failing so the seam stays honest.
  await assert.rejects(
    () => fetchJson(`${baseUrl}/cache`, { method: 'DELETE', headers: mutationHeaders }),
    (error) => error.status === 415 && error.issues[0].code === 'system_service_config_json_required'
  );
  assert.equal((await fetchJson(baseUrl)).cache.entries, 2, 'the rejected DELETE must not have cleared anything');

  // The shipped shape: DELETE with an empty JSON body (what
  // jev-config-management.js now sends).
  const cleared = await fetchJson(`${baseUrl}/cache`, {
    method: 'DELETE',
    headers: mutationHeaders,
    body: {},
  });
  assert.equal(cleared.cleared, 2);

  const after = await fetchJson(baseUrl);
  assert.equal(after.cache.entries, 0);
  const steps = repository.listSteps('task-seam');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].category, 'test', 'clearing the cache must not touch classified steps');
});
