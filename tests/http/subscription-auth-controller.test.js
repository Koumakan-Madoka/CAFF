const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { createSubscriptionAuthController } = require('../../build/server/api/subscription-auth-controller');
const {
  SubscriptionLoginError,
  createSubscriptionLoginService,
} = require('../../build/server/domain/models/subscription-login');
const { withTempDir } = require('../helpers/temp-dir');

const HOST_HEADER = '127.0.0.1:4312';
const CSRF_TOKEN = 'subscription-csrf-token';

function createHarness(t, options = {}) {
  const agentDir = withTempDir('caff-subscription-auth-http-');
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

  const flows = new Map();
  const service = options.service || createSubscriptionLoginService({
    agentDir,
    env: {},
    loadOAuthFlow: async (channel) => {
      const flow = flows.get(channel);
      if (!flow) {
        throw new SubscriptionLoginError('oauth_flow_unavailable', `no fake flow for ${channel}`, channel);
      }
      return flow;
    },
    loadCodexModels: async () => ({
      'gpt-5.4': { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272000, maxTokens: 128000 },
    }),
    checkPortAvailable: async () => {},
  });

  const controller = createSubscriptionAuthController({
    service,
    host: options.host || '127.0.0.1',
    port: options.port || 4312,
    csrfToken: options.csrfToken || CSRF_TOKEN,
  });

  return { agentDir, controller, service, flows };
}

function fakeFlow(credentialOverrides = {}) {
  return {
    login: async (interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/authorize' });
      return {
        type: 'oauth',
        access: 'access-token-value',
        refresh: 'refresh-token-value',
        expires: 1893456000000,
        ...credentialOverrides,
      };
    },
  };
}

async function invoke(controller, options = {}) {
  const method = options.method || 'GET';
  const pathname = options.pathname || '/api/subscription-auth';
  const req = new PassThrough();
  req.method = method;
  req.headers = {
    host: options.hostHeader || HOST_HEADER,
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

  if (options.body !== undefined) {
    const payload = JSON.stringify(options.body);
    req.headers['content-type'] = options.contentType || 'application/json';
    req.headers['content-length'] = String(Buffer.byteLength(payload));
    process.nextTick(() => {
      req.end(payload);
    });
  }

  const handled = await controller({ req, res, pathname, requestUrl: new URL(`http://${req.headers.host}${pathname}`) }).catch((error) => {
    // Mirror the app-level router: HttpErrors become JSON error payloads.
    state.statusCode = Number.isInteger(error && error.statusCode) ? error.statusCode : 500;
    state.body = JSON.stringify({ error: error && error.message, issues: error && error.issues });
    return true;
  });
  let parsed = null;
  try {
    parsed = JSON.parse(state.body);
  } catch {}
  return { handled, ...state, parsed };
}

function mutationHeaders() {
  return {
    origin: `http://${HOST_HEADER}`,
    'x-caff-csrf-token': CSRF_TOKEN,
  };
}

test('subscription auth status is loopback/Host gated and never exposes credential payloads', async (t) => {
  const harness = createHarness(t);
  harness.flows.set('anthropic', fakeFlow());
  const session = await harness.service.startLogin('anthropic');
  await new Promise((resolve) => setTimeout(resolve, 60));

  const ok = await invoke(harness.controller);
  assert.equal(ok.handled, true);
  assert.equal(ok.statusCode, 200);
  assert.ok(Array.isArray(ok.parsed.channels));
  assert.equal(ok.parsed.channels.find((channel) => channel.channel === 'anthropic').loggedIn, true);
  assert.equal(ok.parsed.channels.find((channel) => channel.channel === 'openai-codex').loggedIn, false);
  assert.ok(!JSON.stringify(ok.parsed).includes('access-token-value'), 'tokens never appear in status payloads');

  const remote = await invoke(harness.controller, { remoteAddress: '10.0.0.9' });
  assert.equal(remote.statusCode, 403);
  assert.deepEqual(remote.parsed.issues.map((issue) => issue.code), ['subscription_auth_local_only']);

  const badHost = await invoke(harness.controller, { hostHeader: 'evil.example:4312' });
  assert.equal(badHost.statusCode, 403);
  assert.deepEqual(badHost.parsed.issues.map((issue) => issue.code), ['subscription_auth_host_mismatch']);

  const sessionPoll = await invoke(harness.controller, { pathname: `/api/subscription-auth/logins/${session.id}` });
  assert.equal(sessionPoll.statusCode, 200);
  assert.equal(sessionPoll.parsed.session.state, 'success');
  assert.ok(!JSON.stringify(sessionPoll.parsed).includes('refresh-token-value'));
});

test('subscription login start requires JSON, exact Origin, and the CSRF token', async (t) => {
  const harness = createHarness(t);

  const noOrigin = await invoke(harness.controller, {
    method: 'POST',
    pathname: '/api/subscription-auth/logins',
    body: { channel: 'anthropic' },
    headers: { 'x-caff-csrf-token': CSRF_TOKEN },
  });
  assert.equal(noOrigin.statusCode, 403);
  assert.deepEqual(noOrigin.parsed.issues.map((issue) => issue.code), ['subscription_auth_origin_mismatch']);

  const badCsrf = await invoke(harness.controller, {
    method: 'POST',
    pathname: '/api/subscription-auth/logins',
    body: { channel: 'anthropic' },
    headers: { origin: `http://${HOST_HEADER}`, 'x-caff-csrf-token': 'wrong' },
  });
  assert.equal(badCsrf.statusCode, 403);
  assert.deepEqual(badCsrf.parsed.issues.map((issue) => issue.code), ['subscription_auth_csrf_invalid']);

  const notJson = await invoke(harness.controller, {
    method: 'POST',
    pathname: '/api/subscription-auth/logins',
    body: { channel: 'anthropic' },
    contentType: 'text/plain',
    headers: mutationHeaders(),
  });
  assert.equal(notJson.statusCode, 415);
});

test('subscription login start drives the service and maps domain errors to stable codes', async (t) => {
  const harness = createHarness(t);
  harness.flows.set('anthropic', fakeFlow());

  const started = await invoke(harness.controller, {
    method: 'POST',
    pathname: '/api/subscription-auth/logins',
    body: { channel: 'anthropic' },
    headers: mutationHeaders(),
  });
  assert.equal(started.statusCode, 200);
  assert.equal(started.parsed.session.channel, 'anthropic');
  assert.ok(started.parsed.session.id);

  const unknown = await invoke(harness.controller, {
    method: 'POST',
    pathname: '/api/subscription-auth/logins',
    body: { channel: 'gemini' },
    headers: mutationHeaders(),
  });
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(unknown.parsed.issues.map((issue) => issue.code), ['subscription_auth_channel_unknown']);

  const missing = await invoke(harness.controller, {
    method: 'POST',
    pathname: '/api/subscription-auth/logins',
    body: {},
    headers: mutationHeaders(),
  });
  assert.equal(missing.statusCode, 422);
  assert.deepEqual(missing.parsed.issues.map((issue) => issue.code), ['subscription_auth_channel_required']);
});

test('subscription login session polling and cancellation handle unknown sessions', async (t) => {
  const harness = createHarness(t);

  const missing = await invoke(harness.controller, { pathname: '/api/subscription-auth/logins/nope' });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.parsed.issues.map((issue) => issue.code), ['subscription_auth_session_not_found']);

  const cancelledMissing = await invoke(harness.controller, {
    method: 'POST',
    pathname: '/api/subscription-auth/logins/nope/cancel',
    body: {},
    headers: mutationHeaders(),
  });
  assert.equal(cancelledMissing.statusCode, 404);

  harness.flows.set('anthropic', {
    login: async (interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/authorize' });
      await new Promise(() => {});
      return { type: 'oauth', access: 'a', refresh: 'r', expires: 1 };
    },
  });
  const started = await invoke(harness.controller, {
    method: 'POST',
    pathname: '/api/subscription-auth/logins',
    body: { channel: 'anthropic' },
    headers: mutationHeaders(),
  });
  const sessionId = started.parsed.session.id;

  const cancelled = await invoke(harness.controller, {
    method: 'POST',
    pathname: `/api/subscription-auth/logins/${sessionId}/cancel`,
    body: {},
    headers: mutationHeaders(),
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.parsed.session.state, 'cancelled');
});

test('subscription logout is a mutation and reports credential plus models cleanup', async (t) => {
  const harness = createHarness(t);
  harness.flows.set('openai-codex', fakeFlow({ accountId: 'acct' }));
  await harness.service.startLogin('openai-codex');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(harness.service.getStatus().channels.find((c) => c.channel === 'openai-codex').loggedIn, true);

  const logout = await invoke(harness.controller, {
    method: 'POST',
    pathname: '/api/subscription-auth/logout',
    body: { channel: 'openai-codex' },
    headers: mutationHeaders(),
  });
  assert.equal(logout.statusCode, 200);
  assert.deepEqual(logout.parsed, { channel: 'openai-codex', credentialRemoved: true, modelsUpdated: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(harness.agentDir, 'auth.json'), 'utf8')), {});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(harness.agentDir, 'models.json'), 'utf8')).providers, {});

  const status = await invoke(harness.controller);
  assert.equal(status.parsed.channels.find((c) => c.channel === 'openai-codex').loggedIn, false);
});

test('subscription auth controller leaves foreign routes unhandled', async (t) => {
  const harness = createHarness(t);
  const foreign = await invoke(harness.controller, { pathname: '/api/model-providers' });
  assert.equal(foreign.handled, false);
});
