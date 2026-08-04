const assert = require('node:assert/strict');
const test = require('node:test');

const { createReadinessHealthStatus } = require('../../build/server/domain/runtime/readiness-health');

test('readiness health projects locally runnable default roles without remote probes', () => {
  const resolutionCalls = [];
  const getHealthStatus = createReadinessHealthStatus({
    getAddress() {
      return { address: '127.0.0.1', port: 4317 };
    },
    getRoleDirectory() {
      return {
        agents: [
          {
            id: 'role-family-gpt',
            name: 'GPT',
            isDefaultChatRole: true,
            availability: { status: 'available' },
          },
          {
            id: 'role-family-claude',
            name: 'Claude',
            isDefaultChatRole: true,
            availability: { status: 'default_model_missing' },
          },
          {
            id: 'role-family-kimi',
            name: 'Kimi',
            isDefaultChatRole: false,
            availability: { status: 'available' },
          },
        ],
      };
    },
    resolveRuntimeParticipants(participants) {
      resolutionCalls.push(participants);
      if (participants[0].agentId === 'role-family-claude') {
        const error = new Error('not runnable');
        error.issues = [{ availability: { status: 'default_model_missing' } }];
        throw error;
      }
      return [{
        id: participants[0].agentId,
        runtimeConfig: { provider: 'openai', model: 'gpt-5.4' },
      }];
    },
    env: {
      FEISHU_APP_ID: ' cli_test ',
      FEISHU_APP_SECRET: ' secret-is-never-returned ',
      FEISHU_CONNECTION_MODE: 'long_connection',
    },
    isFeishuLongConnectionSdkAvailable() {
      return false;
    },
    now() {
      return new Date('2026-08-04T00:00:00.000Z');
    },
  });

  const health = getHealthStatus();

  assert.equal(health.ok, true);
  assert.deepEqual(health.core, { ready: true, host: '127.0.0.1', port: 4317 });
  assert.equal(health.chat.ready, true);
  assert.equal(health.chat.defaultRoleCount, 2);
  assert.equal(health.chat.availableDefaultRoleCount, 1);
  assert.deepEqual(health.chat.roles, [
    {
      id: 'role-family-gpt',
      name: 'GPT',
      ready: true,
      availability: 'available',
      provider: 'openai',
      model: 'gpt-5.4',
    },
    {
      id: 'role-family-claude',
      name: 'Claude',
      ready: false,
      availability: 'default_model_missing',
    },
  ]);
  assert.deepEqual(resolutionCalls, [
    [{ agentId: 'role-family-gpt' }],
    [{ agentId: 'role-family-claude' }],
  ]);
  assert.deepEqual(health.optional, {
    feishu: {
      configured: true,
      connectionMode: 'long-connection',
      longConnectionSdkAvailable: false,
    },
  });
  assert.equal(health.timestamp, '2026-08-04T00:00:00.000Z');

  const serialized = JSON.stringify(health);
  assert.ok(!serialized.includes('secret-is-never-returned'));
  assert.ok(!serialized.includes('databasePath'));
  assert.ok(!serialized.includes('apiKey'));
});

test('readiness health keeps core observable when the role directory fails', () => {
  const getHealthStatus = createReadinessHealthStatus({
    host: '0.0.0.0',
    port: 3100,
    getRoleDirectory() {
      throw new Error('catalog failed at C:\\private\\models.json with sk-live-secret');
    },
    resolveRuntimeParticipants() {
      throw new Error('must not run without a role directory');
    },
    env: {},
    isFeishuLongConnectionSdkAvailable() {
      return false;
    },
    now() {
      return new Date('2026-08-04T00:01:00.000Z');
    },
  });

  const health = getHealthStatus();

  assert.equal(health.ok, false);
  assert.deepEqual(health.core, { ready: true, host: '0.0.0.0', port: 3100 });
  assert.deepEqual(health.chat, {
    ready: false,
    defaultRoleCount: 0,
    availableDefaultRoleCount: 0,
    roles: [],
    issue: { code: 'role_directory_unavailable' },
  });
  assert.deepEqual(health.optional.feishu, {
    configured: false,
    connectionMode: 'webhook',
    longConnectionSdkAvailable: false,
  });
  const serialized = JSON.stringify(health);
  assert.ok(!serialized.includes('private'));
  assert.ok(!serialized.includes('sk-live-secret'));
});
