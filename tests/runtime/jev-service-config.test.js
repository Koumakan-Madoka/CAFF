const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  JEV_SERVICE_TYPE,
  createJevEnabledResolver,
  createJevServiceConfigService,
  readJevClientMaterial,
  resolveJevRuntimeStatus,
  stripUrlUserinfo,
} = require('../../build/server/domain/runtime/jev-service-config');
const { withTempDir } = require('../helpers/temp-dir');

function openStore(t) {
  const tempDir = withTempDir('caff-jev-service-config-');
  const store = createChatAppStore({
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'chat.sqlite'),
  });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { store, tempDir };
}

function createService(store) {
  return createJevServiceConfigService({
    store,
    turnTimeBreakdownRepository: store.turnTimeBreakdownRepository,
  });
}

test('stripUrlUserinfo strips credentials and redacts unparseable values', () => {
  assert.equal(stripUrlUserinfo('https://user:pass@api.typesafe.ai/v1'), 'https://api.typesafe.ai/v1');
  assert.equal(stripUrlUserinfo('https://api.typesafe.ai'), 'https://api.typesafe.ai');
  assert.equal(stripUrlUserinfo('https://api.typesafe.ai/'), 'https://api.typesafe.ai');
  assert.equal(stripUrlUserinfo('not a url with user:pass@host'), '<invalid-url>');
  assert.equal(stripUrlUserinfo(''), '');
});

test('resolveJevRuntimeStatus distinguishes all three states with an accurate reason', () => {
  const connectionInfo = { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' };

  const allOn = resolveJevRuntimeStatus({ connectionInfo, apiKeyConfigured: true, dbSwitchEnabled: true });
  assert.equal(allOn.effective, true);
  assert.equal(allOn.reason, 'enabled');

  const keyMissing = resolveJevRuntimeStatus({ connectionInfo, apiKeyConfigured: false, dbSwitchEnabled: true });
  assert.equal(keyMissing.effective, false);
  assert.equal(keyMissing.reason, 'api_key_missing');

  const dbOff = resolveJevRuntimeStatus({ connectionInfo, apiKeyConfigured: true, dbSwitchEnabled: false });
  assert.equal(dbOff.effective, false);
  assert.equal(dbOff.reason, 'db_switch_off');

  assert.equal(allOn.endpoint, 'https://api.typesafe.ai');
  assert.equal(allOn.model, 'jev-latest');
});

test('credential store: absent row means no key; set/clear/override round-trip; return value carries no key', (t) => {
  const { store } = openStore(t);

  assert.equal(store.getSystemServiceCredential(JEV_SERVICE_TYPE), null);

  const saved = store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { setApiKey: 'sk-secret-1' });
  assert.equal(saved.apiKeyConfigured, true);
  assert.equal(JSON.stringify(saved).includes('sk-secret-1'), false, 'write return value must not carry the key');

  const row = store.getSystemServiceCredential(JEV_SERVICE_TYPE);
  assert.equal(row.apiKey, 'sk-secret-1');
  assert.equal(row.baseUrl, null);
  assert.equal(row.model, null);
  assert.ok(row.updatedAt);

  // Overrides stored; empty string resets to default (NULL).
  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { baseUrl: 'https://proxy.example.com', model: 'jev-pro' });
  let next = store.getSystemServiceCredential(JEV_SERVICE_TYPE);
  assert.equal(next.baseUrl, 'https://proxy.example.com');
  assert.equal(next.model, 'jev-pro');
  assert.equal(next.apiKey, 'sk-secret-1', 'partial updates must not clobber the key');

  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { baseUrl: '', model: '' });
  next = store.getSystemServiceCredential(JEV_SERVICE_TYPE);
  assert.equal(next.baseUrl, null);
  assert.equal(next.model, null);

  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { clearApiKey: true });
  next = store.getSystemServiceCredential(JEV_SERVICE_TYPE);
  assert.equal(next.apiKey, null);
});

test('readJevClientMaterial: null without a key; fingerprint tracks the material', (t) => {
  const { store } = openStore(t);

  assert.equal(readJevClientMaterial(store), null);

  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { setApiKey: 'sk-mat-1' });
  const material = readJevClientMaterial(store);
  assert.equal(material.apiKey, 'sk-mat-1');
  assert.equal(material.baseUrl, 'https://api.typesafe.ai', 'defaults come from the client, not env');
  assert.equal(material.model, 'jev-latest');
  assert.ok(material.fingerprint);

  const fp = material.fingerprint;
  assert.equal(readJevClientMaterial(store).fingerprint, fp, 'identical re-reads share the fingerprint');

  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { setApiKey: 'sk-mat-2' });
  assert.notEqual(readJevClientMaterial(store).fingerprint, fp, 'key rotation changes the fingerprint');
});

test('createJevEnabledResolver flips in the same process without a restart (toggle AND key)', (t) => {
  const { store } = openStore(t);
  const isJevEnabled = createJevEnabledResolver({ store });

  assert.equal(isJevEnabled(), false);
  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);
  assert.equal(isJevEnabled(), false, 'toggle on without a stored key stays off');
  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { setApiKey: 'sk-x' });
  assert.equal(isJevEnabled(), true);
  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { clearApiKey: true });
  assert.equal(isJevEnabled(), false, 'clearing the key fails closed immediately');
  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { setApiKey: 'sk-x' });
  store.setSystemServiceToggle(JEV_SERVICE_TYPE, false);
  assert.equal(isJevEnabled(), false, 'toggle off with a stored key stays off');
});

test('createJevEnabledResolver never reads TYPESAFE_* env (env fully set, DB empty → off)', (t) => {
  const prevEnabled = process.env.TYPESAFE_ENABLED;
  const prevKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_ENABLED = 'true';
  process.env.TYPESAFE_API_KEY = 'sk-leftover-env-key';
  t.after(() => {
    if (prevEnabled === undefined) { delete process.env.TYPESAFE_ENABLED; } else { process.env.TYPESAFE_ENABLED = prevEnabled; }
    if (prevKey === undefined) { delete process.env.TYPESAFE_API_KEY; } else { process.env.TYPESAFE_API_KEY = prevKey; }
  });

  const { store } = openStore(t);
  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);
  const isJevEnabled = createJevEnabledResolver({ store });
  assert.equal(isJevEnabled(), false, 'env key must be ignored by the classification pipeline');
});

test('deprecated projects.json timeBreakdown.jevEnabled no longer participates', (t) => {
  const { store, tempDir } = openStore(t);
  // A legacy projects.json that explicitly enables JEV for a project must
  // have no effect: only the DB state counts now (contract §6).
  fs.writeFileSync(path.join(tempDir, 'projects.json'), JSON.stringify({
    version: 1,
    activeProjectId: 'p1',
    projects: [{ id: 'p1', name: 'demo', path: tempDir, timeBreakdown: { jevEnabled: true } }],
  }));

  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { setApiKey: 'sk-x' });
  const isJevEnabled = createJevEnabledResolver({ store });
  assert.equal(isJevEnabled(), false);

  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);
  assert.equal(isJevEnabled(), true);
});

test('service: getConfiguration reports status + cache count; update flips; clearCache empties without touching steps', (t) => {
  const { store } = openStore(t);
  const repository = store.turnTimeBreakdownRepository;
  const service = createService(store);

  repository.setJevCacheEntry('k1', { category: 'test', subcategory: null, runKind: 'targeted', confidence: 0.9 });
  repository.upsertStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    stepKey: 'call-1',
    toolName: 'bash',
    category: 'test',
    classifiedBy: 'jev',
    jevStatus: 'resolved',
    startedAt: '2026-10-20T10:00:00.000Z',
    durationMs: 1000,
  });

  const initial = service.getConfiguration();
  assert.equal(initial.config.enabled, false);
  assert.equal(initial.config.apiKeyConfigured, false);
  assert.equal(initial.status.reason, 'api_key_missing', 'no stored key is reported first');
  assert.equal(initial.cache.entries, 1);
  assert.equal(initial.status.endpoint, 'https://api.typesafe.ai');
  assert.equal(initial.status.model, 'jev-latest');

  const keyed = service.updateConfiguration({ apiKey: 'sk-live-key' });
  assert.equal(keyed.config.apiKeyConfigured, true);
  assert.equal(keyed.status.reason, 'db_switch_off');
  assert.equal(JSON.stringify(keyed).includes('sk-live-key'), false, 'update response must never carry the key');

  const updated = service.updateConfiguration({ enabled: true });
  assert.equal(updated.config.enabled, true);
  assert.equal(updated.status.effective, true);
  assert.equal(updated.status.reason, 'enabled');

  const cleared = service.clearCache();
  assert.equal(cleared.cleared, 1);
  assert.equal(repository.countJevCacheEntries(), 0);

  // Clearing the cache must not rewrite already-classified steps.
  const steps = repository.listSteps('task-1');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].category, 'test');
  assert.equal(steps[0].classified_by, 'jev');
});

test('service: endpoint/model change clears the classification cache; key rotation does not', (t) => {
  const { store } = openStore(t);
  const repository = store.turnTimeBreakdownRepository;
  const service = createService(store);

  const seed = () => repository.setJevCacheEntry('k1', { category: 'test', subcategory: null, runKind: null, confidence: 0.9 });

  seed();
  service.updateConfiguration({ apiKey: 'sk-v1' });
  service.updateConfiguration({ apiKey: 'sk-v2' });
  assert.equal(repository.countJevCacheEntries(), 1, 'key rotation against the same model keeps the cache');

  service.updateConfiguration({ model: 'jev-pro' });
  assert.equal(repository.countJevCacheEntries(), 0, 'model change invalidates cached classifications');

  seed();
  service.updateConfiguration({ baseUrl: 'https://proxy.example.com' });
  assert.equal(repository.countJevCacheEntries(), 0, 'endpoint change invalidates cached classifications');

  seed();
  service.updateConfiguration({ enabled: true });
  assert.equal(repository.countJevCacheEntries(), 1, 'a pure toggle write never touches the cache');

  const status = service.getConfiguration().status;
  assert.equal(status.endpoint, 'https://proxy.example.com');
  assert.equal(status.model, 'jev-pro');
});

test('service: validation is fail-closed at the service boundary', (t) => {
  const { store } = openStore(t);
  const service = createService(store);

  // A future caller bypassing the controller (script, migration) inherits
  // the same fail-closed semantics: no silent coercion into OFF.
  assert.throws(
    () => service.updateConfiguration({ enabled: 'true' }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'invalid_enabled_value'
  );
  assert.throws(
    () => service.updateConfiguration({ apiKey: '' }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'invalid_api_key'
  );
  assert.throws(
    () => service.updateConfiguration({ apiKey: 'sk-a', clearApiKey: true }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'credential_conflict'
  );
  assert.throws(
    () => service.updateConfiguration({ clearApiKey: false }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'invalid_clear_flag'
  );
  assert.throws(
    () => service.updateConfiguration({ baseUrl: 'ftp://nope' }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'invalid_base_url'
  );
  assert.throws(
    () => service.updateConfiguration({ model: 42 }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'invalid_model'
  );

  // Nothing was applied by any rejected write.
  assert.equal(store.getSystemServiceToggle(JEV_SERVICE_TYPE), false);
  assert.equal(store.getSystemServiceCredential(JEV_SERVICE_TYPE), null);
});

test('service: GET payload never contains the API key or URL userinfo', (t) => {
  const { store } = openStore(t);
  const service = createService(store);

  service.updateConfiguration({
    enabled: true,
    apiKey: 'sk-SECRETKEY-never-echo',
    baseUrl: 'https://user:SECRETKEY@api.typesafe.ai',
  });

  const serialized = JSON.stringify(service.getConfiguration());
  assert.ok(!serialized.includes('SECRETKEY'), 'key material must never appear in the payload');
  assert.ok(!serialized.includes('user:'), 'URL userinfo must never appear in the payload');
  const configuration = service.getConfiguration();
  assert.equal(configuration.status.endpoint, 'https://api.typesafe.ai');
  assert.equal(configuration.status.effective, true);
});
