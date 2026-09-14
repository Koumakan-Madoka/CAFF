const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SubscriptionLoginError,
  buildCodexProviderEntry,
  createSubscriptionLoginService,
  resolveCallbackHost,
} = require('../../build/server/domain/models/subscription-login');
const { withTempDir } = require('../helpers/temp-dir');

function oauthCredential(overrides = {}) {
  return {
    type: 'oauth',
    access: 'access-token-value',
    refresh: 'refresh-token-value',
    expires: 1893456000000,
    ...overrides,
  };
}

function fakeCodexModels() {
  return {
    'gpt-5.3-codex-spark': {
      id: 'gpt-5.3-codex-spark',
      name: 'GPT-5.3 Codex Spark',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: true,
      input: ['text'],
      contextWindow: 128000,
      maxTokens: 128000,
    },
    'gpt-5.4': {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      input: ['text', 'image'],
      contextWindow: 272000,
      maxTokens: 128000,
    },
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createHarness(t, options = {}) {
  const agentDir = withTempDir('caff-subscription-login-');
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

  const flows = new Map();
  const flowLog = [];
  const committedModels = [];

  function registerFlow(channel, login) {
    flows.set(channel, { login });
  }

  const service = createSubscriptionLoginService({
    agentDir,
    env: {},
    loadOAuthFlow: async (channel) => {
      const flow = flows.get(channel);
      if (!flow) {
        throw new SubscriptionLoginError('oauth_flow_unavailable', `no fake flow for ${channel}`, channel);
      }
      return flow;
    },
    loadCodexModels: async () => options.codexModels || fakeCodexModels(),
    checkPortAvailable: options.checkPortAvailable || (async () => {}),
    onModelsCommitted: () => committedModels.push(Date.now()),
    ...(options.serviceOptions || {}),
  });

  return { agentDir, service, registerFlow, flowLog, committedModels };
}

async function waitForSessionState(service, sessionId, states, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = service.getSession(sessionId);
    if (!session || states.includes(session.state)) {
      return session;
    }
    if (Date.now() > deadline) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('anthropic login drives the OAuth flow, stores the credential, and reports status', async (t) => {
  const harness = createHarness(t);
  const interactions = [];

  harness.registerFlow('anthropic', async (interaction) => {
    interactions.push(interaction);
    interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?code=true' });
    interaction.notify({ type: 'progress', message: 'Exchanging authorization code for tokens...' });
    return oauthCredential();
  });

  const session = await harness.service.startLogin('anthropic');
  assert.equal(session.state, 'starting');
  assert.equal(session.channel, 'anthropic');

  const settled = await waitForSessionState(harness.service, session.id, ['success', 'error', 'cancelled']);
  assert.equal(settled.state, 'success');
  assert.equal(settled.error, null);
  assert.equal(settled.authUrl, 'https://claude.ai/oauth/authorize?code=true');
  assert.deepEqual(readJson(path.join(harness.agentDir, 'auth.json')), {
    anthropic: oauthCredential(),
  });

  const status = harness.service.getStatus();
  const anthropicStatus = status.channels.find((channel) => channel.channel === 'anthropic');
  assert.equal(anthropicStatus.loggedIn, true);
  assert.equal(anthropicStatus.expiresAt, oauthCredential().expires);
  assert.equal(anthropicStatus.accountId, null);
  const codexStatus = status.channels.find((channel) => channel.channel === 'openai-codex');
  assert.equal(codexStatus.loggedIn, false);
  assert.equal(fs.existsSync(path.join(harness.agentDir, 'models.json')), false, 'anthropic login never touches models.json');
  assert.deepEqual(harness.committedModels, []);
});

test('openai-codex login answers the method prompt with browser, stores credentials, and registers the provider', async (t) => {
  const harness = createHarness(t);
  const prompts = [];

  harness.registerFlow('openai-codex', async (interaction) => {
    prompts.push(await interaction.prompt({
      type: 'select',
      message: 'Select login method',
      options: [
        { id: 'browser', label: 'Browser login' },
        { id: 'device_code', label: 'Device code login' },
      ],
    }));
    interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize' });
    return oauthCredential({ access: 'codex-access', accountId: 'chatgpt-account-id' });
  });

  const session = await harness.service.startLogin('openai-codex');
  const settled = await waitForSessionState(harness.service, session.id, ['success', 'error', 'cancelled']);

  assert.deepEqual(prompts, ['browser']);
  assert.equal(settled.state, 'success');
  assert.equal(settled.providerRegistered, true);
  assert.deepEqual(readJson(path.join(harness.agentDir, 'auth.json')), {
    'openai-codex': oauthCredential({ access: 'codex-access', accountId: 'chatgpt-account-id' }),
  });

  const modelsDocument = readJson(path.join(harness.agentDir, 'models.json'));
  const codexEntry = modelsDocument.providers['openai-codex'];
  assert.equal(codexEntry.name, 'OpenAI Codex');
  assert.equal(codexEntry.baseUrl, 'https://chatgpt.com/backend-api');
  assert.equal(codexEntry.api, 'openai-codex-responses');
  assert.equal(codexEntry.models.length, 2);
  assert.deepEqual(codexEntry.models[0], {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3 Codex Spark',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 128000,
  });
  assert.ok(!('apiKey' in codexEntry), 'the codex provider entry carries no api key');

  const status = harness.service.getStatus();
  const codexStatus = status.channels.find((channel) => channel.channel === 'openai-codex');
  assert.equal(codexStatus.loggedIn, true);
  assert.equal(codexStatus.accountId, 'chatgpt-account-id');
  assert.equal(harness.committedModels.length, 1, 'model catalog invalidation fired once');
});

test('openai-codex login respects an existing models.json document and other providers', async (t) => {
  const harness = createHarness(t);
  fs.writeFileSync(path.join(harness.agentDir, 'models.json'), `${JSON.stringify({
    providers: {
      deepseek: {
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'openai-completions',
        apiKey: 'literal-key',
        models: [{ id: 'deepseek-v3.2', family: 'deepseek', contextWindow: 262144, maxTokens: 32768 }],
      },
    },
  }, null, 2)}\n`, 'utf8');

  harness.registerFlow('openai-codex', async () => oauthCredential({ access: 'codex-access', accountId: 'acct' }));
  const session = await harness.service.startLogin('openai-codex');
  await waitForSessionState(harness.service, session.id, ['success', 'error', 'cancelled']);

  const modelsDocument = readJson(path.join(harness.agentDir, 'models.json'));
  assert.ok(modelsDocument.providers.deepseek, 'existing providers are preserved');
  assert.ok(modelsDocument.providers['openai-codex'], 'codex entry is registered');
});

test('cancelling a login rejects the pending manual prompt and settles the session as cancelled', async (t) => {
  const harness = createHarness(t);
  let loginOutcome = 'unset';
  let promptRejection = null;

  harness.registerFlow('anthropic', async (interaction) => {
    interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?code=true' });
    try {
      await interaction.prompt({ type: 'manual_code', message: 'paste the code' });
      loginOutcome = 'resolved';
    } catch (error) {
      promptRejection = error;
      loginOutcome = 'rejected';
      throw error;
    }
    return oauthCredential();
  });

  const session = await harness.service.startLogin('anthropic');
  await waitForSessionState(harness.service, session.id, ['waiting_browser']);
  assert.equal(harness.service.getSession(session.id).state, 'waiting_browser');

  const cancelled = harness.service.cancelSession(session.id);
  assert.equal(cancelled.state, 'cancelled');

  const deadline = Date.now() + 2000;
  while (loginOutcome === 'unset' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(loginOutcome, 'rejected');
  assert.ok(promptRejection instanceof SubscriptionLoginError);
  assert.equal(promptRejection.code, 'login_cancelled');

  const settled = await waitForSessionState(harness.service, session.id, ['cancelled']);
  assert.equal(settled.state, 'cancelled');
  assert.equal(settled.error, null);
  assert.equal(fs.existsSync(path.join(harness.agentDir, 'auth.json')), false, 'no credential is written for a cancelled login');
});

test('login start fails fast when the callback port is unavailable and rejects concurrent logins', async (t) => {
  const harness = createHarness(t, {
    checkPortAvailable: async () => {
      throw Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });
    },
  });

  await assert.rejects(
    () => harness.service.startLogin('anthropic'),
    (error) => error instanceof SubscriptionLoginError && error.code === 'callback_port_unavailable'
  );

  const permissiveHarness = createHarness(t);
  let releaseLogin;
  const loginGate = new Promise((resolve) => {
    releaseLogin = resolve;
  });
  permissiveHarness.registerFlow('anthropic', async () => {
    await loginGate;
    return oauthCredential();
  });

  const first = await permissiveHarness.service.startLogin('anthropic');
  await assert.rejects(
    () => permissiveHarness.service.startLogin('anthropic'),
    (error) => error instanceof SubscriptionLoginError && error.code === 'login_in_progress'
  );

  releaseLogin();
  await waitForSessionState(permissiveHarness.service, first.id, ['success', 'error', 'cancelled']);
  assert.equal(permissiveHarness.service.getSession(first.id).state, 'success');

  const restarted = await permissiveHarness.service.startLogin('anthropic');
  await waitForSessionState(permissiveHarness.service, restarted.id, ['success', 'error', 'cancelled']);
  assert.equal(permissiveHarness.service.getSession(restarted.id).state, 'success');
});

test('flow failures surface as sanitized error sessions without touching storage', async (t) => {
  const harness = createHarness(t);
  harness.registerFlow('anthropic', async () => {
    throw new Error('Token exchange request failed. status=400; body=invalid_grant');
  });

  const session = await harness.service.startLogin('anthropic');
  const settled = await waitForSessionState(harness.service, session.id, ['success', 'error', 'cancelled']);
  assert.equal(settled.state, 'error');
  assert.equal(settled.error, 'Token exchange request failed. status=400; body=invalid_grant');
  assert.equal(fs.existsSync(path.join(harness.agentDir, 'auth.json')), false);
});

test('flow failures keep the network cause chain and the failing stage for diagnosis', async (t) => {
  const harness = createHarness(t);
  harness.registerFlow('openai-codex', async (interaction) => {
    interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize' });
    const cause = Object.assign(new Error('connect ECONNRESET 104.18.7.10:443'), { code: 'ECONNRESET' });
    const error = new Error('fetch failed');
    error.cause = cause;
    throw error;
  });

  const session = await harness.service.startLogin('openai-codex');
  const settled = await waitForSessionState(harness.service, session.id, ['success', 'error', 'cancelled']);
  assert.equal(settled.state, 'error');
  assert.equal(
    settled.error,
    'fetch failed [cause: ECONNRESET: connect ECONNRESET 104.18.7.10:443]',
    'the undici cause chain is preserved in the surfaced message'
  );
  assert.equal(settled.failedStep, 'waiting_browser', 'the last active stage is recorded for honest UI marking');
  assert.equal(fs.existsSync(path.join(harness.agentDir, 'auth.json')), false);
});

test('logout removes credentials and the codex provider registration together', async (t) => {
  const harness = createHarness(t);
  harness.registerFlow('openai-codex', async () => oauthCredential({ access: 'codex-access', accountId: 'acct' }));

  const session = await harness.service.startLogin('openai-codex');
  await waitForSessionState(harness.service, session.id, ['success', 'error', 'cancelled']);
  assert.equal(harness.service.getStatus().channels.find((c) => c.channel === 'openai-codex').loggedIn, true);

  const logout = await harness.service.logout('openai-codex');
  assert.deepEqual(logout, { channel: 'openai-codex', credentialRemoved: true, modelsUpdated: true });
  assert.deepEqual(readJson(path.join(harness.agentDir, 'auth.json')), {});
  assert.deepEqual(readJson(path.join(harness.agentDir, 'models.json')).providers, {});
  assert.equal(harness.service.getStatus().channels.find((c) => c.channel === 'openai-codex').loggedIn, false);

  const anthropicLogout = await harness.service.logout('anthropic');
  assert.deepEqual(anthropicLogout, { channel: 'anthropic', credentialRemoved: false, modelsUpdated: false });
});

test('logout refuses while a login for the same channel is in flight', async (t) => {
  const harness = createHarness(t);
  let releaseLogin;
  const loginGate = new Promise((resolve) => {
    releaseLogin = resolve;
  });
  harness.registerFlow('openai-codex', async () => {
    await loginGate;
    return oauthCredential({ accountId: 'acct' });
  });

  const session = await harness.service.startLogin('openai-codex');
  await assert.rejects(
    () => harness.service.logout('openai-codex'),
    (error) => error instanceof SubscriptionLoginError && error.code === 'login_in_progress'
  );

  releaseLogin();
  await waitForSessionState(harness.service, session.id, ['success', 'error', 'cancelled']);
  const logout = await harness.service.logout('openai-codex');
  assert.equal(logout.credentialRemoved, true);
});

test('dispose cancels all in-flight logins for a clean server shutdown', async (t) => {
  const harness = createHarness(t);
  harness.registerFlow('anthropic', async (interaction) => {
    interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?code=true' });
    await new Promise(() => {});
    return oauthCredential();
  });

  const session = await harness.service.startLogin('anthropic');
  await waitForSessionState(harness.service, session.id, ['waiting_browser']);
  harness.service.dispose();
  assert.equal(harness.service.getSession(session.id).state, 'cancelled');
});

test('unknown channels are rejected and callback host honours PI_OAUTH_CALLBACK_HOST', async (t) => {
  const harness = createHarness(t);
  await assert.rejects(
    () => harness.service.startLogin('gemini'),
    (error) => error instanceof SubscriptionLoginError && error.code === 'channel_unknown'
  );
  await assert.rejects(
    () => harness.service.logout('gemini'),
    (error) => error instanceof SubscriptionLoginError && error.code === 'channel_unknown'
  );

  assert.equal(resolveCallbackHost({}), '127.0.0.1');
  assert.equal(resolveCallbackHost({ PI_OAUTH_CALLBACK_HOST: '192.168.1.5' }), '192.168.1.5');
  assert.equal(resolveCallbackHost({ PI_OAUTH_CALLBACK_HOST: '  ' }), '127.0.0.1');

  const seenPorts = [];
  const portHarness = createHarness(t, {
    checkPortAvailable: async (host, port) => {
      seenPorts.push({ host, port });
    },
  });
  portHarness.registerFlow('openai-codex', async () => oauthCredential({ accountId: 'a' }));
  await portHarness.service.startLogin('openai-codex');
  assert.deepEqual(seenPorts, [{ host: '127.0.0.1', port: 1455 }]);
});

test('buildCodexProviderEntry clamps inconsistent limits and keeps required fields', () => {
  const entry = buildCodexProviderEntry({
    weird: {
      id: 'weird',
      name: 'Weird Model',
      contextWindow: 1000,
      maxTokens: 5000,
    },
    'no-limits': {
      id: 'no-limits',
    },
  });

  assert.deepEqual(entry.models, [
    {
      id: 'weird',
      name: 'Weird Model',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      contextWindow: 1000,
      maxTokens: 1000,
    },
    {
      id: 'no-limits',
      name: 'no-limits',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      contextWindow: 128000,
      maxTokens: 16384,
    },
  ]);
});
