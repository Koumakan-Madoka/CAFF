const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../lib/pi-extensions/caff-fast-mode.mjs')).href;
const codex = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-6.1-sol', baseUrl: 'https://chatgpt.com/backend-api' };
const auth = (account = 'test-account', key = 'fake-key') => ({
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: key, headers: { 'chatgpt-account-id': account } }),
});
const catalog = (models) => ({ ok: true, json: async () => ({ models }) });
const entry = (slug, priority = true) => ({ slug, service_tiers: priority ? [{ id: 'priority' }] : [] });

async function hook(options) {
  const { createFastModeExtension } = await import(moduleUrl);
  let handler;
  createFastModeExtension(options)({ on(name, fn) {
    assert.equal(name, 'before_provider_request');
    handler = fn;
  } });
  return handler;
}

test('Fast extension is explicit opt-in and leaves off/out-of-scope payloads byte-identical', async () => {
  for (const enabled of [undefined, false, 'true', 'false', 1, null]) {
    const handler = await hook({ enabled, resolveSupport: () => assert.fail('off must not resolve credentials/catalog') });
    const payload = { model: codex.id, input: [], stream: true };
    const before = JSON.stringify(payload);
    assert.equal(await handler({ payload }, { model: codex }), undefined);
    assert.equal(JSON.stringify(payload), before);
  }
  const handler = await hook({ enabled: true, resolveSupport: () => assert.fail('outside scope') });
  for (const model of [
    undefined,
    { ...codex, api: 'openai-responses' }, { ...codex, api: 'openai-completions' },
    { ...codex, provider: 'relay' }, { ...codex, provider: 'anthropic', api: 'anthropic-messages' },
    { ...codex, provider: 'glm', api: 'openai-completions' },
    { ...codex, provider: 'kimi', api: 'openai-completions' },
    { ...codex, provider: 'deepseek', api: 'openai-completions' },
  ]) assert.equal(await handler({ payload: { model: 'm' } }, { model }), undefined);
});

test('Fast hook injects on every model call without mutating payloads, skips unsupported models', async () => {
  let count = 0;
  const handler = await hook({ enabled: true, resolveSupport: async () => ({ supported: ++count <= 3 }) });
  for (let call = 0; call < 3; call += 1) {
    const payload = Object.freeze({ model: codex.id, input: [{ role: 'user', content: String(call) }] });
    const result = await handler({ payload }, { model: codex });
    assert.deepEqual(result, { ...payload, service_tier: 'priority' });
    assert.equal(Object.hasOwn(payload, 'service_tier'), false);
  }
  assert.equal(await handler({ payload: { model: codex.id } }, { model: codex }), undefined);
});

test('runtime and server fallback allowlists stay identical and build copies the extension', async () => {
  const runtime = await import(moduleUrl);
  const server = require('../../build/server/domain/models/fast-mode-support.js');
  assert.deepEqual(runtime.FAST_MODE_MODEL_ALLOWLIST, server.FAST_MODE_MODEL_ALLOWLIST);
  const built = path.resolve(__dirname, '../../build/lib/pi-extensions/caff-fast-mode.mjs');
  assert.equal(fs.readFileSync(built, 'utf8'), fs.readFileSync(new URL(moduleUrl), 'utf8'));
});

test('catalog success (including model absent or priority absent) is authoritative over allowlist', async () => {
  const { createFastSupportResolver } = await import(moduleUrl);
  for (const models of [[], [entry(codex.id, false)], [entry('other-model')]]) {
    let calls = 0;
    const resolve = createFastSupportResolver({ fetchImpl: async (url, options) => {
      calls += 1;
      assert.match(url, /client_version=0\.160\.0$/u);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.get('chatgpt-account-id'), 'test-account');
      assert.equal(options.headers.get('authorization'), 'Bearer fake-key');
      assert.ok(options.signal instanceof AbortSignal);
      return catalog(models);
    } });
    assert.deepEqual(await resolve(codex, auth()), { supported: false, source: 'catalog' });
    assert.deepEqual(await resolve(codex, auth()), { supported: false, source: 'catalog' });
    assert.equal(calls, 1);
  }
});

test('catalog supports models outside fallback and is reused across model calls only within TTL', async () => {
  const { createFastSupportResolver } = await import(moduleUrl);
  let calls = 0;
  let clock = 0;
  const resolve = createFastSupportResolver({ now: () => clock, fetchImpl: async () => {
    calls += 1;
    return catalog([entry('future-model')]);
  } });
  assert.deepEqual(await resolve({ ...codex, id: 'future-model' }, auth()), { supported: true, source: 'catalog' });
  assert.deepEqual(await resolve(codex, auth()), { supported: false, source: 'catalog' });
  assert.equal(calls, 1);
  clock = 300_001;
  await resolve(codex, auth());
  assert.equal(calls, 2);
});

test('failed, malformed, HTTP-error and timed-out catalog use only the static allowlist', async () => {
  const { createFastSupportResolver } = await import(moduleUrl);
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => catalog([{}]),
    async (_url, { signal }) => new Promise((_, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('timeout did not abort')), 500);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    }),
  ]) {
    const resolve = createFastSupportResolver({ fetchImpl, timeoutMs: 5 });
    assert.deepEqual(await resolve(codex, auth()), { supported: true, source: 'allowlist' });
    assert.deepEqual(await resolve({ ...codex, id: 'unknown' }, auth()), { supported: false, source: 'allowlist' });
  }
});

test('account, credential, endpoint changes invalidate catalog cache; custom endpoints never receive credentials', async () => {
  const { createFastSupportResolver } = await import(moduleUrl);
  let calls = 0;
  const resolve = createFastSupportResolver({ fetchImpl: async (_url, { headers }) => {
    calls += 1;
    return catalog(headers.get('chatgpt-account-id') === 'a' ? [entry(codex.id)] : []);
  } });
  assert.equal((await resolve(codex, auth('a'))).supported, true);
  assert.equal((await resolve(codex, auth('b'))).supported, false);
  assert.equal((await resolve(codex, auth('b', 'refreshed-fake-key'))).supported, false);
  assert.equal(calls, 3);
  const custom = { ...codex, baseUrl: 'https://untrusted.invalid/backend-api' };
  assert.equal((await resolve(custom, auth('a'))).source, 'allowlist');
  assert.equal(calls, 3);
  assert.equal((await resolve(codex, auth('a'))).source, 'catalog');
  assert.equal(calls, 4);
});

test('JWT account resolution matches Codex auth and missing auth never makes a network call', async () => {
  const { createFastSupportResolver } = await import(moduleUrl);
  const resolve = createFastSupportResolver({ fetchImpl: async (_url, { headers }) => {
    assert.equal(headers.get('chatgpt-account-id'), 'jwt-test-account');
    return catalog([entry(codex.id)]);
  } });
  const key = `fake.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'jwt-test-account' } })).toString('base64url')}.fake`;
  assert.equal((await resolve(codex, { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: key }) })).source, 'catalog');
  const offline = createFastSupportResolver({ fetchImpl: () => assert.fail('must not fetch') });
  for (const registry of [undefined, { getApiKeyAndHeaders: async () => ({ ok: false }) }, { getApiKeyAndHeaders: async () => { throw new Error('auth failed'); } }]) {
    assert.equal((await offline(codex, registry)).source, 'allowlist');
  }
});

test('pending catalog calls deduplicate, but an account switch discards stale in-flight results', async () => {
  const { createFastSupportResolver } = await import(moduleUrl);
  let finish;
  let calls = 0;
  const resolve = createFastSupportResolver({ fetchImpl: async (_url, { headers }) => {
    calls += 1;
    if (headers.get('chatgpt-account-id') === 'a') return new Promise((r) => { finish = r; });
    return catalog([]);
  } });
  const a = resolve(codex, auth('a'));
  const a2 = resolve(codex, auth('a'));
  // Drain the auth-resolution microtasks without polling or sleeping.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(await resolve(codex, auth('b')), { supported: false, source: 'catalog' });
  finish(catalog([entry(codex.id)]));
  assert.deepEqual(await a, { supported: false, source: 'account_changed' });
  assert.deepEqual(await a2, { supported: false, source: 'account_changed' });
  assert.deepEqual(await resolve(codex, auth('b')), { supported: false, source: 'catalog' });
  assert.equal(calls, 2);
});
