const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  JEV_SERVICE_TYPE,
  createJevEnabledResolver,
  createJevServiceConfigService,
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

const CONNECTION = { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' };

test('stripUrlUserinfo strips credentials and redacts unparseable values', () => {
  assert.equal(stripUrlUserinfo('https://user:pass@api.typesafe.ai/v1'), 'https://api.typesafe.ai/v1');
  assert.equal(stripUrlUserinfo('https://api.typesafe.ai'), 'https://api.typesafe.ai');
  assert.equal(stripUrlUserinfo('https://api.typesafe.ai/'), 'https://api.typesafe.ai');
  assert.equal(stripUrlUserinfo('not a url with user:pass@host'), '<invalid-url>');
  assert.equal(stripUrlUserinfo(''), '');
});

test('resolveJevRuntimeStatus distinguishes all four states with an accurate reason', () => {
  const base = { connectionInfo: CONNECTION };

  const allOn = resolveJevRuntimeStatus({ ...base, masterSwitchEnabled: true, apiKeyConfigured: true, dbSwitchEnabled: true });
  assert.equal(allOn.effective, true);
  assert.equal(allOn.reason, 'enabled');

  const masterOff = resolveJevRuntimeStatus({ ...base, masterSwitchEnabled: false, apiKeyConfigured: true, dbSwitchEnabled: true });
  assert.equal(masterOff.effective, false);
  assert.equal(masterOff.reason, 'master_switch_off');

  const keyMissing = resolveJevRuntimeStatus({ ...base, masterSwitchEnabled: true, apiKeyConfigured: false, dbSwitchEnabled: true });
  assert.equal(keyMissing.effective, false);
  assert.equal(keyMissing.reason, 'api_key_missing');

  const dbOff = resolveJevRuntimeStatus({ ...base, masterSwitchEnabled: true, apiKeyConfigured: true, dbSwitchEnabled: false });
  assert.equal(dbOff.effective, false);
  assert.equal(dbOff.reason, 'db_switch_off');

  assert.equal(allOn.endpoint, 'https://api.typesafe.ai');
  assert.equal(allOn.model, 'jev-latest');
});

test('toggle store: absent row means off, set flips on/off, updated_at is recorded', (t) => {
  const { store } = openStore(t);

  assert.equal(store.getSystemServiceToggle(JEV_SERVICE_TYPE), false);

  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);
  assert.equal(store.getSystemServiceToggle(JEV_SERVICE_TYPE), true);

  const row = store.systemServiceToggleRepository.get(JEV_SERVICE_TYPE);
  assert.equal(row.enabled, 1);
  assert.ok(row.updated_at);

  store.setSystemServiceToggle(JEV_SERVICE_TYPE, false);
  assert.equal(store.getSystemServiceToggle(JEV_SERVICE_TYPE), false);
});

test('createJevEnabledResolver flips in the same process without a restart', (t) => {
  const { store } = openStore(t);
  const isJevEnabled = createJevEnabledResolver({ store, masterSwitchEnabled: true, apiKeyConfigured: true });

  assert.equal(isJevEnabled(), false);
  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);
  assert.equal(isJevEnabled(), true);
  store.setSystemServiceToggle(JEV_SERVICE_TYPE, false);
  assert.equal(isJevEnabled(), false);
});

test('createJevEnabledResolver: master switch off stays off even with the DB toggle on', (t) => {
  const { store } = openStore(t);
  const isJevEnabled = createJevEnabledResolver({ store, masterSwitchEnabled: false, apiKeyConfigured: true });

  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);
  assert.equal(isJevEnabled(), false);
});

test('createJevEnabledResolver: API key missing stays off even with master + DB toggle on', (t) => {
  const { store } = openStore(t);
  // Both shapes must fail closed: explicitly false, and omitted entirely
  // (a caller that forgets the gate must not silently enable JEV).
  const explicit = createJevEnabledResolver({ store, masterSwitchEnabled: true, apiKeyConfigured: false });
  const omitted = createJevEnabledResolver({ store, masterSwitchEnabled: true });

  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);
  assert.equal(explicit(), false);
  assert.equal(omitted(), false);
});

test('deprecated projects.json timeBreakdown.jevEnabled no longer participates', (t) => {
  const { store, tempDir } = openStore(t);
  // A legacy projects.json that explicitly enables JEV for a project must
  // have no effect: only the DB toggle counts now (contract §6).
  fs.writeFileSync(path.join(tempDir, 'projects.json'), JSON.stringify({
    version: 1,
    activeProjectId: 'p1',
    projects: [{ id: 'p1', name: 'demo', path: tempDir, timeBreakdown: { jevEnabled: true } }],
  }));

  const isJevEnabled = createJevEnabledResolver({ store, masterSwitchEnabled: true, apiKeyConfigured: true });
  assert.equal(isJevEnabled(), false);

  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);
  assert.equal(isJevEnabled(), true);
});

test('service: getConfiguration reports status + cache count; update flips; clearCache empties without touching steps', (t) => {
  const { store } = openStore(t);
  const repository = store.turnTimeBreakdownRepository;
  const service = createJevServiceConfigService({
    store,
    turnTimeBreakdownRepository: repository,
    masterSwitchEnabled: true,
    apiKeyConfigured: true,
    connectionInfo: CONNECTION,
  });

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
  assert.equal(initial.status.reason, 'db_switch_off');
  assert.equal(initial.cache.entries, 1);

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

test('service: updateConfiguration fails closed on a non-boolean enabled', (t) => {
  const { store } = openStore(t);
  const service = createJevServiceConfigService({
    store,
    turnTimeBreakdownRepository: store.turnTimeBreakdownRepository,
    masterSwitchEnabled: true,
    apiKeyConfigured: true,
    connectionInfo: CONNECTION,
  });

  // A future caller bypassing the controller (script, migration) inherits
  // the same fail-closed semantics: no silent coercion into OFF.
  assert.throws(
    () => service.updateConfiguration({ enabled: 'true' }),
    (error) => error.statusCode === 422 && error.issues[0].code === 'invalid_enabled_value'
  );
  assert.equal(store.getSystemServiceToggle(JEV_SERVICE_TYPE), false);
});

test('service: GET payload never contains the API key or URL userinfo', (t) => {
  const { store } = openStore(t);
  const service = createJevServiceConfigService({
    store,
    turnTimeBreakdownRepository: store.turnTimeBreakdownRepository,
    masterSwitchEnabled: true,
    apiKeyConfigured: true,
    connectionInfo: { baseUrl: 'https://user:SECRETKEY@api.typesafe.ai', model: 'jev-latest' },
  });

  const serialized = JSON.stringify(service.getConfiguration());
  assert.ok(!serialized.includes('SECRETKEY'), 'key material must never appear in the payload');
  assert.ok(!serialized.includes('user:'), 'URL userinfo must never appear in the payload');
  assert.equal(service.getConfiguration().status.endpoint, 'https://api.typesafe.ai');
});
