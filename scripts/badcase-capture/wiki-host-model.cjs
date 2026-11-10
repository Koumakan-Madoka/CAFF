// Wiki-only, one-request mailbox. Provider connection and auth stay on the
// trusted host; no HTTP listener, credentials or network inside WSL/Docker.
const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const PROXY = 'http://127.0.0.1:17890';
const LIMITS = Object.freeze({ maxRequests: 1, maxRequestBytes: 4 * 1024 * 1024, maxResponseBytes: 1024 * 1024 });
const fail = code => Object.assign(Error('wiki_host_' + code), { code: 'wiki_host_' + code });
function decode(text) {
  if (typeof text !== 'string') throw fail('response_invalid');
  const b = Buffer.from(text, 'base64'); if (b.toString('base64') !== text) throw fail('response_invalid'); return b;
}
function createWikiMailboxFetch({ exchange } = {}) {
  let used = false;
  const send = exchange || require('./container-model-adapter.cjs').createMailbox({ maxRequests: 1, settings: LIMITS }, () => {});
  return async (url, options) => {
    if (used) throw fail('request_blocked');
    const headers = new Headers(options?.headers);
    if (String(url) !== ENDPOINT || options?.method !== 'POST' || headers.get('content-type') !== 'application/json'
      || [...headers.keys()].some(k => k !== 'content-type') || typeof options.body !== 'string'
      || Buffer.byteLength(options.body) > LIMITS.maxRequestBytes) throw fail('request_invalid');
    used = true;
    const signal = options.signal;
    signal?.throwIfAborted();
    const bytes = await send(Buffer.from(options.body)); signal?.throwIfAborted();
    let r;
    try {
      if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.maxResponseBytes) throw Error();
      r = JSON.parse(bytes);
      if (!r || Object.keys(r).sort().join(',') !== 'body,status' || !Number.isSafeInteger(r.status) || r.status < 200 || r.status > 599) throw Error();
    } catch { throw fail('response_invalid'); }
    return new Response(decode(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
}
function createWikiHostExchange({ key, expectedBody, signal }, dependencies = {}) {
  require('./direct-model.cjs').validKey(key);
  if (!Buffer.isBuffer(expectedBody) || !expectedBody.length || expectedBody.length > LIMITS.maxRequestBytes
    || expectedBody.includes(key) || expectedBody.includes(JSON.stringify(key).slice(1, -1))) throw fail('request_invalid');
  const expected = Buffer.from(expectedBody);
  const fetch = dependencies.fetch || ((...args) => require('undici').fetch(...args));
  const createDispatcher = dependencies.createDispatcher || (uri => new (require('undici').ProxyAgent)({ uri }));
  let used = false, closed = false, dispatcher, active;
  return {
    async exchange(bytes) {
      if (closed || used) throw fail('request_blocked');
      used = true;
      if (!Buffer.isBuffer(bytes) || !bytes.equals(expected)) throw fail('request_invalid');
      const controller = new AbortController(); active = controller;
      const timer = setTimeout(() => controller.abort(), 110000); timer.unref?.();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        dispatcher = createDispatcher(PROXY);
        const response = await fetch(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: bytes, dispatcher });
        if (response.status !== 200) {
          await response.body?.cancel();
          // No provider error body (which can echo credentials) reaches the
          // worker, ledger or logs. One failed request is never retried.
          return Buffer.from(JSON.stringify({ status: response.status, body: Buffer.from('{"error":"wiki_model_request_failed"}').toString('base64') }));
        }
        if (!response.body) throw fail('response_invalid');
        const reader = response.body.getReader(), chunks = []; let size = 0;
        const abort = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', abort, { once: true });
        try {
          for (;;) {
            controller.signal.throwIfAborted(); const { value, done } = await reader.read(); controller.signal.throwIfAborted(); if (done) break;
            size += value.byteLength; if (size > 512 * 1024) throw fail('response_too_large'); chunks.push(Buffer.from(value));
          }
        } finally { controller.signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const output = Buffer.concat(chunks);
        if (output.includes(key) || output.includes(JSON.stringify(key).slice(1, -1))) throw fail('output_contains_key');
        return Buffer.from(JSON.stringify({ status: 200, body: output.toString('base64') }));
      } catch (e) {
        const code = /^wiki_host_[a-z_]+$/.test(e?.code || '') ? e.code : 'wiki_host_proxy_failed';
        throw Object.assign(Error(code), { code });
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); active = undefined; }
    },
    async close() { if (closed) return; closed = true; key = ''; active?.abort(); await dispatcher?.destroy(); },
  };
}
async function runWikiHostTask(image, files, options, dependencies = {}) {
  const fs = require('node:fs'), path = require('node:path');
  const { validateWslDockerBackend, createWslDockerRunner } = require('./wsl-docker.cjs');
  const selected = validateWslDockerBackend(options.dockerBackend);
  const runDocker = (dependencies.createRunner || createWslDockerRunner)(selected);
  const input = files.find(f => f.path === 'wiki-induction-input.json');
  if (!input) throw fail('request_invalid');
  const expectedBody = Buffer.from(require('./wiki-induction-container.cjs').buildRequestBody(JSON.parse(input.bytes)));
  // Reject known auth bytes in all material before a file/archive/container is
  // created; no selected key is passed to the WSL runner, even as environment.
  require('./direct-model.cjs').validKey(options.key);
  if (files.some(f => f.bytes.includes(options.key) || f.bytes.includes(JSON.stringify(options.key).slice(1, -1)))) throw fail('input_contains_key');
  const staged = [...files, { path: 'wiki-host-relay.json', bytes: Buffer.from('{"kind":"wiki-host-relay-v1"}') },
    ...['wiki-host-model.cjs', 'container-model-adapter.cjs'].map(name => ({ path: name, bytes: fs.readFileSync(path.join(__dirname, name)) }))];
  const transport = (dependencies.createExchange || createWikiHostExchange)({ key: options.key, expectedBody });
  try {
    return await (dependencies.execute || require('./direct-docker.cjs').runHostModelDockerTask)(image, staged, {
      timeoutMs: options.timeoutMs, runDocker, network: 'none', sendNativeRequest: transport.exchange, limits: LIMITS,
    });
  } finally { await transport.close(); }
}
module.exports = { createWikiMailboxFetch, createWikiHostExchange, runWikiHostTask, LIMITS };
