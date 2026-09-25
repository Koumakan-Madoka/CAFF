const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const CONFIG_PATH = path.resolve(__dirname, '../../build/server/app/config.js');
const BRIDGE_PATH = path.resolve(__dirname, '../../build/server/domain/runtime/agent-tool-bridge.js');

const TYPESAFE_ENV_KEYS = [
  'TYPESAFE_ENABLED',
  'TYPESAFE_API_KEY',
  'TYPESAFE_BASE_URL',
  'TYPESAFE_MODEL',
  'TYPESAFE_MAX_REQUESTS',
  'TYPESAFE_TOKEN_BUDGET',
  'TYPESAFE_TIMEOUT_MS',
];

function loadFreshBridge(env, bridgeOptions) {
  const saved = {};
  for (const key of TYPESAFE_ENV_KEYS) {
    saved[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  delete require.cache[CONFIG_PATH];
  delete require.cache[BRIDGE_PATH];
  const { createAgentToolBridge } = require(BRIDGE_PATH);
  const bridge = createAgentToolBridge({
    store: {
      getConversation(id) {
        return { id, projectScopeId: 'project-jev' };
      },
    },
    ...bridgeOptions,
  });
  const restore = () => {
    for (const key of TYPESAFE_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    delete require.cache[CONFIG_PATH];
    delete require.cache[BRIDGE_PATH];
  };
  return { bridge, restore };
}

function registerJevInvocation(bridge) {
  return bridge.registerInvocation(bridge.createInvocationContext({
    invocationId: `jev-invocation-${Math.random().toString(36).slice(2)}`,
    callbackToken: 'jev-callback',
    conversationId: 'jev-conversation',
    agentId: 'jev-agent',
    agentName: 'Jev Agent',
    stage: { status: 'running' },
  }));
}

function askBody(context, args) {
  return {
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    arguments: {
      state: 'The deploy failed twice this week.',
      questions: {
        is_urgent: { type: 'noul', instructions: 'Does this need immediate attention?' },
      },
      ...args,
    },
  };
}

test('jev_ask facade is disabled by default and reports jev_disabled', async (t) => {
  const { bridge, restore } = loadFreshBridge({}, {});
  t.after(restore);
  const context = registerJevInvocation(bridge);
  await assert.rejects(
    bridge.handlePiCapability('jev_ask', askBody(context)),
    (error) => error && error.code === 'jev_disabled' && error.statusCode === 503
  );
});

test('jev_ask reports not configured when enabled without an API key', async (t) => {
  const { bridge, restore } = loadFreshBridge({ TYPESAFE_ENABLED: 'true' }, {});
  t.after(restore);
  const context = registerJevInvocation(bridge);
  await assert.rejects(
    bridge.handlePiCapability('jev_ask', askBody(context)),
    (error) => error && error.code === 'jev_not_configured' && error.statusCode === 503
  );
});

test('jev_ask validates arguments before reaching the client', async (t) => {
  const askCalls = [];
  const { bridge, restore } = loadFreshBridge(
    { TYPESAFE_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' },
    { typeSafeClient: { ask: async (input) => { askCalls.push(input); return { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }; } } }
  );
  t.after(restore);
  const context = registerJevInvocation(bridge);

  // Question ids that would collide with projection-safety key filters are refused.
  await assert.rejects(
    bridge.handlePiCapability('jev_ask', askBody(context, {
      questions: { token_count: { type: 'noul', instructions: 'x?' } },
    })),
    (error) => error && error.code === 'pi_capability_invalid_arguments'
  );

  // More than 32 questions are refused.
  const tooMany = {};
  for (let index = 0; index < 33; index += 1) {
    tooMany[`q${index}`] = { type: 'noul', instructions: 'x?' };
  }
  await assert.rejects(
    bridge.handlePiCapability('jev_ask', askBody(context, { questions: tooMany })),
    (error) => error && error.code === 'pi_capability_invalid_arguments'
  );

  // Unknown arguments are refused.
  await assert.rejects(
    bridge.handlePiCapability('jev_ask', askBody(context, { stream: true })),
    (error) => error && error.code === 'pi_capability_invalid_arguments'
  );

  assert.equal(askCalls.length, 0);
});

test('jev_ask projects answers and usage without token-keyed fields', async (t) => {
  const { bridge, restore } = loadFreshBridge(
    { TYPESAFE_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' },
    {
      typeSafeClient: {
        ask: async () => ({
          model: 'jev-1.13.0',
          answers: { is_urgent: { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 210, output_tokens: 12 },
        }),
      },
    }
  );
  t.after(restore);
  const context = registerJevInvocation(bridge);
  const result = await bridge.handlePiCapability('jev_ask', askBody(context));

  assert.equal(result.model, 'jev-1.13.0');
  assert.equal(result.answers.is_urgent.noul, 0.9);
  assert.deepEqual(result.usage, { input: 210, output: 12 });
  assert.ok(Number.isFinite(result.latencyMs));
  assert.doesNotMatch(JSON.stringify(result), /tokens/u);
});

test('jev_ask maps client budget exhaustion to an explicit 429 error', async (t) => {
  const { TypeSafeClientError } = require('../../build/server/domain/integrations/typesafe/typesafe-client');
  const { bridge, restore } = loadFreshBridge(
    { TYPESAFE_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' },
    {
      typeSafeClient: {
        ask: async () => {
          throw new TypeSafeClientError('typesafe_budget_exceeded', 'TypeSafe request budget exhausted (200/200)');
        },
      },
    }
  );
  t.after(restore);
  const context = registerJevInvocation(bridge);
  await assert.rejects(
    bridge.handlePiCapability('jev_ask', askBody(context)),
    (error) => error && error.code === 'typesafe_budget_exceeded' && error.statusCode === 429
  );
});

test('jev_ask never returns fabricated answers when the client fails', async (t) => {
  const { TypeSafeClientError } = require('../../build/server/domain/integrations/typesafe/typesafe-client');
  const { bridge, restore } = loadFreshBridge(
    { TYPESAFE_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' },
    {
      typeSafeClient: {
        ask: async () => {
          throw new TypeSafeClientError('typesafe_timeout', 'TypeSafe request timed out after 30000ms');
        },
      },
    }
  );
  t.after(restore);
  const context = registerJevInvocation(bridge);
  await assert.rejects(
    bridge.handlePiCapability('jev_ask', askBody(context)),
    (error) => error && error.code === 'typesafe_timeout' && error.statusCode === 504
  );
});
