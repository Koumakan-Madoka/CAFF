const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { zstdDecompressSync } = require('node:zlib');
const { withTempDir } = require('../helpers/temp-dir');

// Real SDK + real pi-ai serializers/transports, entirely fake credentials and I/O.
// No server, proxy, subscription token, or production configuration is touched.
const fakeJwt = `fake.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.fake`;
const sdkUrl = pathToFileURL(path.resolve(__dirname, '../../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
const hostUrl = pathToFileURL(path.resolve(__dirname, '../../lib/pi-sdk-host.mjs')).href;

function responseEvents(id, tool) {
  const item = tool
    ? { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'ping', arguments: '{}', status: 'completed' }
    : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
  return [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: {
      id, status: 'completed', output: [item], service_tier: 'default',
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    } },
  ];
}

async function runScenario(t, { fast, transport, provider = 'openai-codex', api = 'openai-codex-responses', supported = true, rejectTier = false, wsRetry = false, wsFallback = false }) {
  const dir = withTempDir('caff-fast-sdk-');
  const sdk = await import(sdkUrl);
  const { createSdkRuntime, runAgentRuntime, disposeSdkRuntime, normalizeStartCommand } = await import(hostUrl);
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';
  const requests = [];
  const sockets = [];
  let catalogCalls = 0;
  let responseIndex = 0;
  let toolCalls = 0;
  let runtime;
  const extensionErrors = [];
  const tierReports = [];
  const sendResponse = () => responseEvents(`resp_${++responseIndex}`, responseIndex === 1);
  globalThis.fetch = async (url, options) => {
    const urlText = String(url);
    if (urlText.includes('/codex/models?')) {
      catalogCalls += 1;
      assert.equal(options.redirect, 'error');
      return Response.json({ models: [{ slug: 'gpt-6.1-sol', service_tiers: supported ? [{ id: 'priority' }] : [] }] });
    }
    assert.match(urlText, /\/responses$/u, 'no unhandled network access');
    const headers = new Headers(options.headers);
    const body = headers.get('content-encoding') === 'zstd'
      ? zstdDecompressSync(options.body).toString('utf8') : options.body;
    requests.push(JSON.parse(body));
    if (rejectTier) return new Response('Unsupported service_tier: priority', { status: 400 });
    // A provider retry must resend the already-injected body unchanged.
    if (requests.length === 1) return new Response('temporarily unavailable', { status: 503, headers: { 'retry-after-ms': '0' } });
    return new Response(sendResponse().map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  globalThis.WebSocket = class FakeSocket extends EventTarget {
    readyState = 0;
    constructor(url) {
      super();
      assert.match(String(url), /^wss:\/\/chatgpt.com\/backend-api\/codex\/responses$/u);
      if (wsFallback) throw new Error('test-only connection failure');
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    send(body) {
      requests.push(JSON.parse(body));
      const events = wsRetry && requests.length === 1
        ? [{ type: 'error', code: 'websocket_connection_limit_reached', message: 'websocket_connection_limit_reached' }]
        : sendResponse();
      // Parsing listeners are installed after send(), so emit in a later task.
      setImmediate(() => {
        for (const event of events) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
      });
    }
    close() { this.readyState = 3; }
  };
  t.after(async () => {
    try {
      if (runtime) await disposeSdkRuntime(runtime);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
      if (originalOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = originalOffline;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const config = normalizeStartCommand({ type: 'start', prompt: 'Call ping then finish.', config: {
    fast, provider, model: 'gpt-6.1-sol', thinking: 'off', cwd: dir, agentDir: dir,
  } }).config;
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { [provider]: {
    api, baseUrl: 'https://chatgpt.com/backend-api',
    models: [{ id: config.model, name: config.model, reasoning: false, input: ['text'],
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }],
  } } }));
  if (provider === 'openai-codex') fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    'openai-codex': { type: 'oauth', access: fakeJwt, refresh: 'fake-refresh', expires: Date.now() + 3_600_000, accountId: 'test-account' },
  }));
  const testSdk = { ...sdk,
    createAgentSessionServices: async (options) => {
      const services = await sdk.createAgentSessionServices({ ...options,
        settingsManager: sdk.SettingsManager.inMemory({
          transport, compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 1, timeoutMs: 3000 } },
        }),
        resourceLoaderOptions: { ...options.resourceLoaderOptions,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          agentsFilesOverride: () => ({ agentsFiles: [] }),
          extensionFactories: [...options.resourceLoaderOptions.extensionFactories, (pi) => {
            pi.registerTool({ name: 'ping', label: 'Ping', description: 'Test-only no-I/O tool', parameters: { type: 'object', properties: {} },
              execute: async () => { toolCalls += 1; return { content: [{ type: 'text', text: 'pong' }], details: {} }; },
            });
          }],
        },
      });
      if (provider !== 'openai-codex') await services.modelRuntime.setRuntimeApiKey(provider, fakeJwt);
      return services;
    },
    createAgentSessionFromServices: (options) => sdk.createAgentSessionFromServices({ ...options, tools: ['ping'] }),
  };
  ({ runtime } = await createSdkRuntime(testSdk, config, { onServiceTierRequest: (request) => tierReports.push(request) }));
  await runAgentRuntime(runtime, 'Call ping then finish.', () => {}, { onExtensionError: (e) => extensionErrors.push(e) });
  assert.deepEqual(extensionErrors, []);
  assert.ok(requests.length >= 1);
  const expectedFast = fast === true && provider === 'openai-codex' && api === 'openai-codex-responses' && supported;
  for (const body of requests) {
    assert.equal(Object.hasOwn(body, 'service_tier'), expectedFast);
    if (expectedFast) assert.equal(body.service_tier, 'priority');
  }
  if (rejectTier) {
    assert.equal(requests.length, 2, 'pi-ai may retry errors; both attempts must retain priority');
    assert.deepEqual(requests[0], requests[1]);
    const message = runtime.session.messages.filter((m) => m.role === 'assistant').at(-1);
    assert.equal(message.stopReason, 'error');
    assert.match(message.errorMessage, /Unsupported service_tier/u);
  } else {
    assert.equal(toolCalls, 1, 'tool-call followup must be exercised');
    assert.equal(responseIndex, 2);
    if (transport === 'sse' || wsFallback) {
      assert.equal(requests.length, 3, 'HTTP retry plus model followup');
      assert.deepEqual(requests[0], requests[1]);
    } else {
      assert.equal(sockets.length, wsRetry ? 2 : 1, 'followup reuses the successful socket');
      assert.equal(requests.length, wsRetry ? 3 : 2);
      if (wsRetry) assert.deepEqual(requests[0], requests[1]);
      assert.equal(requests.at(-1).previous_response_id, 'resp_1', 'must exercise incremental WebSocket body');
      assert.ok(requests.at(-1).input.some((item) => item.type === 'function_call_output'));
    }
  }
  assert.equal(catalogCalls, fast === true && provider === 'openai-codex' && api === 'openai-codex-responses' ? 1 : 0);
  assert.equal(tierReports.length, rejectTier ? 1 : 2, 'hook evidence counts model invocations, not transport retries');
  for (const report of tierReports) {
    assert.equal(report.status, expectedFast ? 'requested' : !fast ? 'disabled' : provider !== 'openai-codex' ? 'out_of_scope' : 'unsupported');
    assert.equal(report.serviceTierRequested, expectedFast ? 'priority' : null);
    assert.equal(report.supportSource, expectedFast || (fast && supported === false) ? 'catalog' : fast ? 'out_of_scope' : null);
    assert.equal(Object.keys(report).length, 3, 'never report credentials or provider content');
  }
}

for (const transport of ['sse', 'websocket-cached']) {
  for (const [name, config] of [
    ['on', { fast: true }], ['off', { fast: false }],
    ['unsupported', { fast: true, supported: false }],
    ['other provider', { fast: true, provider: 'relay' }],
  ]) test(`real SDK ${transport}: Fast ${name}, tool followup and transport requests`, { timeout: 20000 }, async (t) => {
    await runScenario(t, { ...config, transport });
  });
}
test('real SDK WebSocket: connection-limit retry retains Fast then uses incremental followup', { timeout: 20000 }, async (t) => {
  await runScenario(t, { fast: true, transport: 'websocket-cached', wsRetry: true });
});
test('real SDK auto: WebSocket failure falls back to SSE without losing Fast', { timeout: 20000 }, async (t) => {
  await runScenario(t, { fast: true, transport: 'auto', wsFallback: true });
});
test('real SDK SSE: non-codex API is never injected', { timeout: 20000 }, async (t) => {
  await runScenario(t, { fast: true, transport: 'sse', provider: 'relay', api: 'openai-responses' });
});
test('real SDK SSE: priority rejection is surfaced, never silently downgraded', { timeout: 20000 }, async (t) => {
  await runScenario(t, { fast: true, transport: 'sse', rejectTier: true });
});
