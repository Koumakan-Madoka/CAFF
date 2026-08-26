const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

function openStore(tempDir) {
  return createChatAppStore({
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'chat.sqlite'),
  });
}

test('system service configuration persists one atomic recovery_scribe snapshot', (t) => {
  const tempDir = withTempDir('caff-system-service-config-');
  let store = openStore(tempDir);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  assert.equal(store.getSystemServiceConfig('recovery_scribe'), null);

  const first = store.saveSystemServiceConfig('recovery_scribe', {
    enabled: true,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    thinking: 'low',
    timeoutMs: 45_000,
  });
  assert.deepEqual(
    {
      serviceType: first.serviceType,
      enabled: first.enabled,
      provider: first.provider,
      model: first.model,
      thinking: first.thinking,
      timeoutMs: first.timeoutMs,
    },
    {
      serviceType: 'recovery_scribe',
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: 'low',
      timeoutMs: 45_000,
    }
  );

  const second = store.saveSystemServiceConfig('recovery_scribe', {
    enabled: false,
    provider: 'openai',
    model: 'gpt-5',
    thinking: 'medium',
    timeoutMs: 30_000,
  });
  assert.equal(second.enabled, false);
  assert.equal(second.provider, 'openai');
  assert.equal(second.model, 'gpt-5');
  assert.equal(second.timeoutMs, 30_000);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM chat_system_service_configs').get().count,
    1
  );

  store.close();
  store = openStore(tempDir);
  assert.deepEqual(store.getSystemServiceConfig('recovery_scribe'), second);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
