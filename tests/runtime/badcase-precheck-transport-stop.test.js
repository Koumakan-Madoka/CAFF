const test = require('node:test'), assert = require('node:assert/strict');
const { createWikiRunClient } = require('../../scripts/badcase-capture/wiki-run-client.cjs');
const { createWikiHostExchange } = require('../../scripts/badcase-capture/wiki-host-model.cjs');

test('precheck external abort reaches the one-shot native SDK and pending host request', async t => {
  const controller = new AbortController(); let signal, reject, sends = 0;
  const client = await createWikiRunClient({ authFile: '/synthetic/.pi-sandbox/auth.json', signal: controller.signal }, {
    createTransport: () => ({ fetch: async () => {}, state: () => ({}), close: async () => { reject?.(Error('closed')); } }),
    stream(model, context, options) { signal = options.signal; return { result() { sends++; return new Promise((resolve, r) => {
      reject = r; signal.addEventListener('abort', () => r(Error('aborted')));
    }); } }; },
  });
  t.after(() => client.close());
  const pending = client.complete({ model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh', context: {} }); pending.catch(() => {});
  controller.abort(); assert.equal(signal.aborted, true); await assert.rejects(pending); assert.equal(sends, 1);
});
test('the real native SDK forwards precheck cancellation into its injected fetch', { timeout: 5000 }, async t => {
  const controller = new AbortController(); let release, reject, observed;
  const started = new Promise(resolve => release = resolve);
  const client = await createWikiRunClient({ authFile: '/synthetic/.pi-sandbox/auth.json', signal: controller.signal }, {
    createTransport: () => ({ state: () => ({}), close: async () => reject?.(Error('closed')), async fetch(url, options) {
      observed = options.signal; release();
      return new Promise((resolve, r) => { reject = r; observed.addEventListener('abort', () => r(Error('cancelled'))); });
    } }),
  }); t.after(() => client.close());
  const pending = client.complete({ model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh', context: { systemPrompt: 'Synthetic system', messages: [{ role: 'user', content: 'Synthetic input', timestamp: 1 }], tools: [] } }); pending.catch(() => {});
  await started; controller.abort(); assert.equal(observed.aborted, true); await assert.rejects(pending, /wiki_run_model_failed/);
});
test('precheck external abort cancels the pending DeepSeek host exchange and cleans up', async t => {
  const controller = new AbortController(); let signal, destroys = 0;
  const transport = createWikiHostExchange({ key: 'synthetic-judge-key-not-real', expectedBody: Buffer.from('{}'), signal: controller.signal }, {
    createDispatcher: () => ({ async destroy() { destroys++; } }),
    fetch: async (url, options) => { signal = options.signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')))); },
  }); t.after(() => transport.close());
  const pending = transport.exchange(Buffer.from('{}')); pending.catch(() => {});
  controller.abort(); assert.equal(signal.aborted, true); await assert.rejects(pending, /wiki_host_proxy_failed/);
  await transport.close(); assert.equal(destroys, 1);
});
test('an already aborted host-judge request cannot open its dispatcher or fetch', async () => {
  const controller = new AbortController(); controller.abort(); let opens = 0, sends = 0;
  const transport = createWikiHostExchange({ key: 'synthetic-judge-key-not-real', expectedBody: Buffer.from('{}'), signal: controller.signal }, {
    createDispatcher: () => { opens++; return { async destroy() {} }; }, fetch: async () => { sends++; return new Response('{}'); },
  });
  try { await assert.rejects(transport.exchange(Buffer.from('{}'))); assert.equal(opens, 0); assert.equal(sends, 0); }
  finally { await transport.close(); }
});
