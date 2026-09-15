const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const projectRoot = path.resolve(__dirname, '..', '..');

// Realistic shapes mirroring the /api/subscription-auth and /api/model-providers
// projections produced by the backend controllers.

function anthropicProvider(overrides = {}) {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic-messages',
    authHeader: false,
    hasApiKey: true,
    hasExternalAuth: false,
    apiKeyMode: 'literal',
    hasCustomHeaders: false,
    models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
    ...overrides,
  };
}

function codexProvider() {
  return {
    id: 'openai-codex',
    name: 'ChatGPT Codex',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    api: 'openai-codex-responses',
    authHeader: false,
    hasApiKey: false,
    hasExternalAuth: true,
    apiKeyMode: 'external',
    hasCustomHeaders: false,
    models: [{ id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' }],
  };
}

function channelStatus(overrides = {}) {
  return {
    channels: [
      { channel: 'anthropic', loggedIn: false, accountId: null, expiresAt: null },
      { channel: 'openai-codex', loggedIn: false, accountId: null, expiresAt: null },
    ],
    logins: [],
    ...overrides,
  };
}

function loggedInStatus() {
  return channelStatus({
    channels: [
      { channel: 'anthropic', loggedIn: true, accountId: 'claude-account', expiresAt: 1893456000000 },
      { channel: 'openai-codex', loggedIn: true, accountId: 'chatgpt-account', expiresAt: 1893456000000 },
    ],
  });
}

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize?client_id=pi&code_challenge=abc';

// ---------------------------------------------------------------------------
// Part A: the subscription-login module standalone (channel view, login flow
// dialog, codex read-only detail).
// ---------------------------------------------------------------------------

function loadSubscriptionLoginModule() {
  const dom = new JSDOM('<div id="root"></div>');
  const openedUrls = [];
  const timers = [];
  const context = {
    document: dom.window.document,
    Event: dom.window.Event,
    structuredClone,
    window: {
      CaffPersonas: {},
      CaffShared: {},
      open: (url) => { openedUrls.push(String(url)); return null; },
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    },
  };
  for (const rel of ['public/shared/model-options.js', 'public/personas/management-utils.js', 'public/personas/subscription-login.js']) {
    const sourcePath = path.join(projectRoot, rel);
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }
  return { dom, context, openedUrls, timers };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushTimers(session, rounds = 1) {
  for (let round = 0; round < rounds; round += 1) {
    const pending = session.timers.splice(0);
    if (!pending.length) break;
    pending.forEach((fn) => fn());
    await settle();
    await settle();
  }
}

function createController(session, { fetchImpl, onClose = () => {}, selectProvider = () => {}, onChannelChanged = async () => {} } = {}) {
  const toasts = [];
  const controller = session.context.window.CaffPersonas.createSubscriptionLogin({
    root: session.dom.window.document.getElementById('root'),
    fetchJson: fetchImpl,
    showToast: (message) => { toasts.push(message); },
    isEnabled: () => true,
    getCsrfToken: () => 'csrf-token',
    onChannelChanged,
    onClose,
    selectProvider,
  });
  return { controller, toasts };
}

test('channel view renders the zero-login state with browser login actions only', async () => {
  const session = loadSubscriptionLoginModule();
  const closed = [];
  const { controller } = createController(session, {
    fetchImpl: async (url) => {
      assert.equal(url, '/api/subscription-auth');
      return channelStatus();
    },
    onClose: () => closed.push('closed'),
  });

  await controller.open();

  const root = session.dom.window.document.getElementById('root');
  assert.match(root.textContent, /通过订阅登录/u);
  assert.match(root.textContent, /0 \/ 2 已登录/u);
  assert.equal(root.querySelectorAll('[data-oauth-channel-login]').length, 2, 'both channels offer browser login');
  assert.equal(root.querySelectorAll('[data-oauth-channel-logout]').length, 0, 'no logout actions while logged out');
  assert.equal(root.querySelectorAll('[data-oauth-channel-view]').length, 0, 'no codex provider link while logged out');
  assert.doesNotMatch(root.textContent, /已连接/u);

  root.querySelector('#oauth-channel-back').click();
  assert.deepEqual(closed, ['closed']);
});

test('channel view renders logged-in channels with account details and codex provider link', async () => {
  const session = loadSubscriptionLoginModule();
  const selections = [];
  const { controller } = createController(session, {
    fetchImpl: async (url) => {
      assert.equal(url, '/api/subscription-auth');
      return loggedInStatus();
    },
    selectProvider: (providerId) => selections.push(providerId),
  });

  await controller.open();

  const root = session.dom.window.document.getElementById('root');
  assert.match(root.textContent, /2 \/ 2 已登录/u);
  assert.equal(root.querySelectorAll('[data-oauth-channel-logout]').length, 2);
  assert.match(root.textContent, /已连接 · claude-account/u);
  assert.match(root.textContent, /已连接 · chatgpt-account/u);
  assert.equal(root.querySelectorAll('[data-oauth-channel-view]').length, 1, 'only the codex channel links to its provider');

  root.querySelector('[data-oauth-channel-view]').click();
  assert.deepEqual(selections, ['openai-codex']);
});

test('channel view offers a resume entry for an in-progress login session', async () => {
  const session = loadSubscriptionLoginModule();
  const { controller } = createController(session, {
    fetchImpl: async (url) => {
      assert.equal(url, '/api/subscription-auth');
      return channelStatus({
        logins: [{ id: 'login-9', channel: 'anthropic', state: 'waiting_browser', authUrl: AUTHORIZE_URL }],
      });
    },
  });

  await controller.open();

  const resume = session.dom.window.document.querySelector('[data-oauth-channel-resume="anthropic"]');
  assert.ok(resume, 'resume entry rendered for the in-progress anthropic login');
  assert.match(resume.textContent, /查看进行中的登录/u);
});

test('anthropic login flow drives the real session API through to success', async () => {
  const session = loadSubscriptionLoginModule();
  const calls = [];
  const changed = [];
  let pollCount = 0;
  const { controller, toasts } = createController(session, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/subscription-auth') return channelStatus();
      if (url === '/api/subscription-auth/logins') {
        assert.deepEqual(JSON.parse(JSON.stringify(options.body)), { channel: 'anthropic' });
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-CAFF-CSRF-Token'], 'csrf-token');
        return { session: { id: 'login-1', channel: 'anthropic', state: 'starting' } };
      }
      if (url === '/api/subscription-auth/logins/login-1') {
        pollCount += 1;
        if (pollCount === 1) {
          return { session: { id: 'login-1', channel: 'anthropic', state: 'waiting_browser', authUrl: AUTHORIZE_URL } };
        }
        return { session: { id: 'login-1', channel: 'anthropic', state: 'success' } };
      }
      throw new Error(`unexpected url ${url}`);
    },
    onChannelChanged: async () => { changed.push('changed'); },
  });

  await controller.open();
  session.dom.window.document.querySelector('[data-oauth-channel-login="anthropic"]').click();
  await settle();

  const doc = session.dom.window.document;
  const backdrop = doc.getElementById('oauth-flow-backdrop');
  assert.ok(backdrop, 'flow dialog exists');
  assert.equal(backdrop.classList.contains('hidden'), false, 'flow dialog is visible');
  assert.match(doc.getElementById('oauth-flow-title').textContent, /登录 Claude Pro \/ Max/u);
  assert.match(doc.querySelector('[data-step="pkce"]').textContent, /⏳/u, 'starting marks the PKCE step active');
  assert.equal(doc.querySelectorAll('#oauth-flow-steps li').length, 5, 'anthropic flow has five steps');

  await flushTimers(session);
  assert.equal(doc.getElementById('oauth-browser-url').textContent, AUTHORIZE_URL, 'real authorize URL is displayed');
  assert.equal(doc.getElementById('oauth-browser-frame').classList.contains('hidden'), false);
  assert.deepEqual(session.openedUrls, [AUTHORIZE_URL], 'the page opens the authorize URL once');
  const openBrowser = doc.getElementById('oauth-open-browser');
  assert.equal(openBrowser.disabled, false);
  assert.equal(openBrowser.dataset.authUrl, AUTHORIZE_URL);
  assert.match(doc.querySelector('[data-step="callback"]').textContent, /⏳/u, 'waiting_browser marks the callback step active');

  await flushTimers(session);
  assert.match(doc.getElementById('oauth-flow-result').textContent, /凭证已写入 auth\.json/u);
  assert.match(doc.getElementById('oauth-flow-result').textContent, /anthropic 供应商即刻起由订阅凭证驱动/u);
  assert.equal(doc.getElementById('oauth-cancel').disabled, true, 'cancel is disabled once settled');
  assert.deepEqual(changed, ['changed'], 'channel change notification fires so the list refreshes');
  assert.match(toasts[0], /Claude Pro \/ Max 登录成功/u);
});

test('codex login flow shows the registration step and codex-specific success copy', async () => {
  const session = loadSubscriptionLoginModule();
  let pollCount = 0;
  const { controller } = createController(session, {
    fetchImpl: async (url) => {
      if (url === '/api/subscription-auth') return channelStatus();
      if (url === '/api/subscription-auth/logins') {
        return { session: { id: 'login-2', channel: 'openai-codex', state: 'starting' } };
      }
      if (url === '/api/subscription-auth/logins/login-2') {
        pollCount += 1;
        if (pollCount === 1) {
          return { session: { id: 'login-2', channel: 'openai-codex', state: 'waiting_browser', authUrl: 'https://auth.openai.com/oauth/authorize' } };
        }
        return { session: { id: 'login-2', channel: 'openai-codex', state: 'success' } };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });

  await controller.open();
  session.dom.window.document.querySelector('[data-oauth-channel-login="openai-codex"]').click();
  await settle();

  const doc = session.dom.window.document;
  assert.equal(doc.querySelectorAll('#oauth-flow-steps li').length, 6, 'codex flow adds the models.json registration step');
  assert.match(doc.querySelector('[data-step="register"]').textContent, /注册 openai-codex provider/u);

  await flushTimers(session, 2);
  assert.match(doc.getElementById('oauth-flow-result').textContent, /openai-codex provider 已注册进 models\.json/u);
  assert.match(doc.getElementById('oauth-flow-result').textContent, /搜索供应商永远覆盖不到此渠道/u);
});

test('a failed login marks only the truly completed steps and keeps the network cause', async () => {
  const session = loadSubscriptionLoginModule();
  let pollCount = 0;
  const { controller } = createController(session, {
    fetchImpl: async (url) => {
      if (url === '/api/subscription-auth') return channelStatus();
      if (url === '/api/subscription-auth/logins') {
        return { session: { id: 'login-err', channel: 'openai-codex', state: 'starting' } };
      }
      if (url === '/api/subscription-auth/logins/login-err') {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            session: {
              id: 'login-err',
              channel: 'openai-codex',
              state: 'waiting_browser',
              authUrl: 'https://auth.openai.com/oauth/authorize',
            },
          };
        }
        return {
          session: {
            id: 'login-err',
            channel: 'openai-codex',
            state: 'error',
            error: 'fetch failed [cause: ECONNRESET: connect ECONNRESET 104.18.7.10:443]',
            failedStep: 'waiting_browser',
          },
        };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });

  await controller.open();
  session.dom.window.document.querySelector('[data-oauth-channel-login="openai-codex"]').click();
  await settle();

  const doc = session.dom.window.document;
  await flushTimers(session, 2);

  const markOf = (key) => {
    const text = doc.querySelector(`[data-step="${key}"]`).textContent;
    if (text.startsWith('✓ ')) return 'done';
    if (text.startsWith('✗ ')) return 'error';
    if (text.startsWith('⏳ ')) return 'active';
    return 'pending';
  };
  assert.equal(markOf('pkce'), 'done', 'PKCE completed before the failure');
  assert.equal(markOf('browser'), 'done', 'the authorize URL was issued');
  assert.equal(markOf('callback'), 'error', 'the error mark lands on the last known stage');
  assert.equal(markOf('exchange'), 'pending', 'steps after the failure are not shown as completed');
  assert.equal(markOf('persist'), 'pending', 'persist is not claimed done');
  assert.equal(markOf('register'), 'pending', 'register is not claimed done');
  assert.match(
    doc.getElementById('oauth-flow-result').textContent,
    /登录失败：fetch failed \[cause: ECONNRESET/u,
    'the network cause is visible to the user'
  );
});

test('cancelling the login settles the session without writing credentials', async () => {
  const session = loadSubscriptionLoginModule();
  const calls = [];
  const { controller } = createController(session, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/subscription-auth') return channelStatus();
      if (url === '/api/subscription-auth/logins') {
        return { session: { id: 'login-3', channel: 'anthropic', state: 'starting' } };
      }
      if (url === '/api/subscription-auth/logins/login-3') {
        return { session: { id: 'login-3', channel: 'anthropic', state: 'waiting_browser', authUrl: AUTHORIZE_URL } };
      }
      if (url === '/api/subscription-auth/logins/login-3/cancel') {
        assert.equal(options.method, 'POST');
        return { session: { id: 'login-3', channel: 'anthropic', state: 'cancelled' } };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });

  await controller.open();
  session.dom.window.document.querySelector('[data-oauth-channel-login="anthropic"]').click();
  await settle();
  await flushTimers(session);

  session.dom.window.document.getElementById('oauth-cancel').click();
  await settle();
  await settle();

  assert.ok(calls.some((call) => call.url === '/api/subscription-auth/logins/login-3/cancel'), 'cancel POST issued');
  assert.match(session.dom.window.document.getElementById('oauth-flow-result').textContent, /已取消：未写入任何凭证/u);
  assert.equal(session.dom.window.document.getElementById('oauth-cancel').disabled, true);
});

test('closing the flow dialog cancels the in-flight session to release the callback port', async () => {
  const session = loadSubscriptionLoginModule();
  const calls = [];
  const { controller } = createController(session, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/subscription-auth') return channelStatus();
      if (url === '/api/subscription-auth/logins') {
        return { session: { id: 'login-4', channel: 'anthropic', state: 'starting' } };
      }
      if (url === '/api/subscription-auth/logins/login-4') {
        return { session: { id: 'login-4', channel: 'anthropic', state: 'waiting_browser', authUrl: AUTHORIZE_URL } };
      }
      if (url === '/api/subscription-auth/logins/login-4/cancel') {
        return { session: { id: 'login-4', channel: 'anthropic', state: 'cancelled' } };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });

  await controller.open();
  session.dom.window.document.querySelector('[data-oauth-channel-login="anthropic"]').click();
  await settle();
  await flushTimers(session);

  session.dom.window.document.getElementById('oauth-flow-close').click();
  await settle();
  await settle();

  const backdrop = session.dom.window.document.getElementById('oauth-flow-backdrop');
  assert.equal(backdrop.classList.contains('hidden'), true, 'dialog is hidden');
  assert.ok(calls.some((call) => call.url === '/api/subscription-auth/logins/login-4/cancel'), 'closing cancels the active session');
});

test('codex read-only detail renders the registered provider and logs out through the real API', async () => {
  const session = loadSubscriptionLoginModule();
  const closed = [];
  const changed = [];
  let providers = [anthropicProvider(), codexProvider()];
  const { controller, toasts } = createController(session, {
    fetchImpl: async (url, options) => {
      if (url === '/api/subscription-auth') return loggedInStatus();
      if (url === '/api/model-providers') return { providers };
      if (url === '/api/subscription-auth/logout') {
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(JSON.stringify(options.body)), { channel: 'openai-codex' });
        providers = [anthropicProvider()];
        return { ok: true, channel: 'openai-codex', removedCredential: true, removedProviderEntry: true };
      }
      throw new Error(`unexpected url ${url}`);
    },
    onChannelChanged: async () => { changed.push('changed'); },
    onClose: () => closed.push('closed'),
  });

  await controller.renderCodexDetail();

  const doc = session.dom.window.document;
  const root = doc.getElementById('root');
  assert.match(root.textContent, /ChatGPT Codex/u);
  assert.match(root.textContent, /订阅登录注册/u);
  assert.match(root.textContent, /订阅账号/u);
  const accountInput = Array.from(root.querySelectorAll('input[readonly]'))
    .find((input) => input.value === 'chatgpt-account');
  assert.ok(accountInput, 'subscription account is rendered read-only');
  assert.equal(root.querySelectorAll('input:not([readonly])').length, 0, 'the codex detail is fully read-only');

  doc.getElementById('oauth-codex-logout').click();
  await settle();
  await settle();
  await settle();

  assert.deepEqual(changed, ['changed']);
  assert.deepEqual(closed, ['closed'], 'leaving the codex detail after logout returns to the provider list');
  assert.match(toasts[0], /openai-codex 供应商条目一并移除/u);
});

test('describeProvider reports live channel state for provider display rules', async () => {
  const session = loadSubscriptionLoginModule();
  const { controller } = createController(session, {
    fetchImpl: async (url) => {
      assert.equal(url, '/api/subscription-auth');
      return loggedInStatus();
    },
  });

  await controller.refreshStatus();

  assert.equal(controller.describeProvider('kimi-for-coding'), null, 'non-subscription providers report nothing');
  assert.equal(controller.describeProvider('anthropic').accountId, 'claude-account');
  assert.equal(controller.describeProvider('anthropic').channel, 'anthropic');
  assert.equal(controller.describeProvider('openai-codex').label, 'ChatGPT Codex');
});

// ---------------------------------------------------------------------------
// Part B: provider-management wiring (list display rules + editor detail
// fallback after logout), with the real provider-editor and the real
// subscription-login module loaded together.
// ---------------------------------------------------------------------------

function loadProviderManagementFixture({ providers, status }) {
  const dom = new JSDOM(`
    <ul id="provider-list"></ul>
    <section id="provider-detail"></section>
    <button id="add-provider"></button>
    <button id="import-provider"></button>
    <button id="refresh-providers"></button>
    <button id="subscription-login"></button>
    <span id="provider-count"></span>
  `);
  const state = { providers, status };
  const calls = [];
  const changed = [];
  const context = {
    document: dom.window.document,
    Event: dom.window.Event,
    structuredClone,
    window: { CaffShared: {}, CaffPersonas: {} },
  };
  context.window.CaffPersonas.createCatalogImport = () => ({ async open() {} });

  for (const rel of [
    'public/shared/management-list.js',
    'public/shared/model-options.js',
    'public/personas/management-utils.js',
    'public/personas/provider-editor.js',
    'public/personas/subscription-login.js',
    'public/personas/provider-management.js',
  ]) {
    const sourcePath = path.join(projectRoot, rel);
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }

  const management = context.window.CaffPersonas.createProviderManagement({
    list: dom.window.document.getElementById('provider-list'),
    detail: dom.window.document.getElementById('provider-detail'),
    addButton: dom.window.document.getElementById('add-provider'),
    importButton: dom.window.document.getElementById('import-provider'),
    refreshButton: dom.window.document.getElementById('refresh-providers'),
    subscriptionButton: dom.window.document.getElementById('subscription-login'),
    count: dom.window.document.getElementById('provider-count'),
    isEnabled: () => true,
    getCsrfToken: () => 'csrf-token',
    showToast() {},
    onProvidersChanged: async () => { changed.push('providers'); },
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/model-providers') return { providers: state.providers };
      if (url === '/api/subscription-auth') return state.status;
      if (url === '/api/subscription-auth/logout') {
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        if (body.channel === 'openai-codex') {
          state.providers = state.providers.filter((provider) => provider.id !== 'openai-codex');
        } else if (body.channel === 'anthropic') {
          state.providers = state.providers.map((provider) => (
            provider.id === 'anthropic'
              ? anthropicProvider({ hasExternalAuth: false, apiKeyMode: 'literal', hasApiKey: true })
              : provider
          ));
        }
        state.status = channelStatus();
        return { ok: true, channel: body.channel, removedCredential: true };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });

  return { dom, document: dom.window.document, management, state, calls, changed };
}

test('provider list shows zero subscription display when no channel is logged in', async () => {
  const fixture = loadProviderManagementFixture({
    providers: [anthropicProvider()],
    status: channelStatus(),
  });

  await fixture.management.refresh();

  const listText = fixture.document.getElementById('provider-list').textContent;
  assert.doesNotMatch(listText, /OAuth external/u);
  assert.doesNotMatch(listText, /订阅登录注册/u);
  assert.equal(fixture.document.querySelectorAll('[data-provider-id="openai-codex"]').length, 0, 'codex entry absent while logged out');
  assert.match(fixture.document.getElementById('provider-count').textContent, /^1 个连接$/u);
});

test('logged-in anthropic gains the external mark and subscription block in its detail', async () => {
  const fixture = loadProviderManagementFixture({
    providers: [anthropicProvider({ hasExternalAuth: true, apiKeyMode: 'external', hasApiKey: false })],
    status: loggedInStatus(),
  });

  await fixture.management.refresh();

  const anthropicRow = fixture.document.querySelector('[data-provider-id="anthropic"]');
  assert.ok(anthropicRow);
  assert.match(anthropicRow.textContent, /OAuth external/u);
  assert.match(fixture.document.getElementById('provider-count').textContent, /含 1 个订阅条目/u);

  anthropicRow.click();
  await settle();

  const detail = fixture.document.getElementById('provider-detail');
  assert.ok(fixture.document.getElementById('provider-subscription-block'), 'subscription block rendered');
  assert.match(detail.textContent, /官方渠道订阅 · Claude Pro \/ Max 已登录/u);
  assert.match(detail.textContent, /账号 claude-account/u);
  assert.ok(fixture.document.getElementById('provider-external-auth-note'), 'external auth note rendered');
  assert.equal(fixture.document.getElementById('provider-auth-mode').value, 'none', 'external mode is not writable');
});

test('anthropic logout from the editor detail falls back to the API key display', async () => {
  const fixture = loadProviderManagementFixture({
    providers: [anthropicProvider({ hasExternalAuth: true, apiKeyMode: 'external', hasApiKey: false })],
    status: loggedInStatus(),
  });

  await fixture.management.refresh();
  fixture.document.querySelector('[data-provider-id="anthropic"]').click();
  await settle();
  assert.ok(fixture.document.getElementById('provider-subscription-block'), 'precondition: subscription block visible');

  fixture.document.getElementById('provider-subscription-logout').click();
  await settle();
  await settle();
  await settle();
  await settle();

  assert.ok(fixture.calls.some((call) => call.url === '/api/subscription-auth/logout'), 'logout POST issued');
  const detail = fixture.document.getElementById('provider-detail');
  assert.equal(fixture.document.getElementById('provider-subscription-block'), null, 'subscription block removed after logout');
  assert.equal(fixture.document.getElementById('provider-external-auth-note'), null, 'external note removed after logout');
  assert.match(detail.textContent, /已保存 · literal/u, 'detail falls back to the saved API key state');
  assert.doesNotMatch(fixture.document.querySelector('[data-provider-id="anthropic"]').textContent, /OAuth external/u);
  assert.doesNotMatch(fixture.document.getElementById('provider-count').textContent, /订阅条目/u);
});

test('logged-in codex gets a subscription row, read-only detail, and disappears after logout', async () => {
  const fixture = loadProviderManagementFixture({
    providers: [anthropicProvider(), codexProvider()],
    status: loggedInStatus(),
  });

  await fixture.management.refresh();

  const codexRow = fixture.document.querySelector('[data-provider-id="openai-codex"]');
  assert.ok(codexRow, 'codex row present while logged in');
  assert.match(codexRow.textContent, /CD/u);
  assert.match(codexRow.textContent, /订阅/u);
  assert.match(codexRow.textContent, /订阅登录注册/u);
  assert.match(fixture.document.getElementById('provider-count').textContent, /含 1 个订阅条目/u);

  codexRow.click();
  await settle();
  await settle();

  const detail = fixture.document.getElementById('provider-detail');
  assert.match(detail.textContent, /订阅登录注册/u);
  const accountInput = Array.from(detail.querySelectorAll('input[readonly]'))
    .find((input) => input.value === 'chatgpt-account');
  assert.ok(accountInput, 'codex detail shows the subscription account');
  assert.equal(fixture.document.getElementById('provider-id'), null, 'no writable editor for the codex subscription entry');

  fixture.document.getElementById('oauth-codex-logout').click();
  await settle();
  await settle();
  await settle();
  await settle();

  assert.equal(fixture.document.querySelectorAll('[data-provider-id="openai-codex"]').length, 0, 'codex row removed after logout');
  assert.doesNotMatch(fixture.document.getElementById('provider-count').textContent, /订阅条目/u);
  assert.match(fixture.document.getElementById('provider-count').textContent, /^1 个连接$/u);
  assert.match(fixture.document.getElementById('provider-detail').textContent, /Anthropic/u, 'detail returns to a remaining provider');
});
