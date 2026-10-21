const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { zstdDecompressSync } = require('node:zlib');
const ROOT = path.resolve(__dirname, '../..');
const { withTempDir } = require(path.join(ROOT, 'tests/helpers/temp-dir'));
const sdkUrl = pathToFileURL(path.join(ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
const providerUrl = pathToFileURL(path.join(ROOT, 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js')).href;
const fakeJwt = `fake.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fake`;
const model = { id: 'gpt-6.1-sol', name: 'fixture', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', reasoning: false, input: ['text'], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 128000, maxTokens: 500 };
const baseCost = 25 / 1_000_000;
const assertPrice = (actual, multiplier = 1) => assert.ok(Math.abs(actual - baseCost * multiplier) < 1e-12);

// Real installed pi 0.85.1 + CAFF factory; all credentials and transports are fake.
// These tests pin observable SDK behavior, not real backend scheduling.
async function audit({ fast = true, transport = 'sse', responseTier = 'default', nativeTier } = {}) {
  const dir = withTempDir('caff-fast-pi-evidence-');
  const oldFetch = globalThis.fetch, oldWs = globalThis.WebSocket, oldOffline = process.env.PI_OFFLINE;
  const result = { requests: [], headers: [], hookReports: [] };
  let runtime;
  process.env.PI_OFFLINE = '1';
  const events = () => {
    const item = { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
    return [
      { type: 'response.created', response: { id: 'resp_test', service_tier: 'auto' } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item], service_tier: responseTier, usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
    ];
  };
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/codex/models?')) return Response.json({ models: [{ slug: model.id, service_tiers: [{ id: 'priority' }] }] });
    assert.equal(String(input), 'https://chatgpt.com/backend-api/codex/responses');
    const h = new Headers(init.headers);
    result.requests.push(JSON.parse(h.get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body).toString('utf8') : init.body));
    const response = new Response(events().map(x => `data: ${JSON.stringify(x)}\n\n`).join(''), { headers: { 'x-test-observer': 'fixture' } });
    response.headers.delete('content-type'); // Real W6 backend omitted this header.
    return response;
  };
  globalThis.WebSocket = class extends EventTarget {
    readyState = 0;
    constructor(url) { super(); assert.equal(String(url), 'wss://chatgpt.com/backend-api/codex/responses'); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(body) { result.requests.push(JSON.parse(body)); setImmediate(() => { for (const event of events()) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })); }); }
    close() { this.readyState = 3; }
  };
  try {
    if (nativeTier) {
      const { stream } = await import(providerUrl);
      const s = stream(model, { messages: [{ role: 'user', content: 'done', timestamp: Date.now() }] }, { apiKey: fakeJwt, transport, serviceTier: nativeTier, maxRetries: 0 });
      result.message = await s.result();
    } else {
      const sdk = await import(sdkUrl);
      const host = await import(pathToFileURL(path.join(ROOT, 'lib/pi-sdk-host.mjs')).href);
      fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { 'openai-codex': { api: model.api, baseUrl: model.baseUrl, models: [model] } } }));
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: fakeJwt, refresh: 'fixture', expires: Date.now() + 3600000, accountId: 'fixture-account' } }));
      const wrappedSdk = { ...sdk,
        createAgentSessionServices: options => sdk.createAgentSessionServices({ ...options,
          settingsManager: sdk.SettingsManager.inMemory({ transport, compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } }),
          resourceLoaderOptions: { ...options.resourceLoaderOptions, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
            agentsFilesOverride: () => ({ agentsFiles: [] }),
            extensionFactories: [...options.resourceLoaderOptions.extensionFactories, pi => pi.on('after_provider_response', event => result.headers.push(event))],
          },
        }),
        createAgentSessionFromServices: options => sdk.createAgentSessionFromServices({ ...options, noTools: 'all' }),
      };
      const config = host.normalizeStartCommand({ type: 'start', prompt: 'done', config: { fast, provider: model.provider, model: model.id, thinking: 'off', cwd: dir, agentDir: dir } }).config;
      ({ runtime } = await host.createSdkRuntime(wrappedSdk, config, { onServiceTierRequest: x => result.hookReports.push(x) }));
      await host.runAgentRuntime(runtime, 'done', () => {});
      result.message = runtime.session.messages.filter(x => x.role === 'assistant').at(-1);
    }
    assert.equal(result.message.stopReason, 'stop');
    return result;
  } finally {
    if (runtime) { const host = await import(pathToFileURL(path.join(ROOT, 'lib/pi-sdk-host.mjs')).href); await host.disposeSdkRuntime(runtime); }
    globalThis.fetch = oldFetch; globalThis.WebSocket = oldWs;
    if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const transport of ['sse', 'websocket-cached']) {
  test(`pi evidence ${transport}: injected priority with backend default has no execution-tier field or priority pricing`, { timeout: 15000 }, async () => {
    const r = await audit({ transport });
    assert.equal(r.requests.length, 1);
    assert.equal(r.requests[0].service_tier, 'priority');
    assert.equal(r.hookReports[0].serviceTierRequested, 'priority');
    assert.equal(r.message.responseId, 'resp_test');
    assert.equal(Object.hasOwn(r.message, 'serviceTier'), false);
    assert.equal(Object.hasOwn(r.message, 'service_tier'), false);
    assertPrice(r.message.usage.cost.total);
    if (transport === 'sse') {
      assert.equal(r.headers.length, 1);
      assert.deepEqual(Object.keys(r.headers[0]).sort(), ['headers', 'status', 'type']);
      assert.equal(r.headers[0].headers['x-test-observer'], 'fixture');
      assert.equal(Object.hasOwn(r.headers[0], 'body'), false);
      assert.equal(Object.hasOwn(r.headers[0], 'serviceTier'), false);
    } else assert.equal(r.headers.length, 0, 'this installed Codex WS adapter does not invoke onResponse');
  });
  test(`pi evidence ${transport}: backend priority changes provider cost but is not preserved as a message tier`, { timeout: 15000 }, async () => {
    const r = await audit({ transport, responseTier: 'priority' });
    assertPrice(r.message.usage.cost.total, 2);
    assert.equal(Object.hasOwn(r.message, 'serviceTier'), false);
    assert.equal(Object.hasOwn(r.message, 'service_tier'), false);
  });
  test(`pi evidence ${transport}: disabled Fast omits request tier and keeps baseline price`, { timeout: 15000 }, async () => {
    const r = await audit({ transport, fast: false });
    assert.equal(Object.hasOwn(r.requests[0], 'service_tier'), false);
    assertPrice(r.message.usage.cost.total);
  });
}
test('pi native option pricing can double even when backend says default; cost alone is not execution proof', { timeout: 15000 }, async () => {
  const r = await audit({ nativeTier: 'priority' });
  assert.equal(r.requests[0].service_tier, 'priority');
  assertPrice(r.message.usage.cost.total, 2);
});
