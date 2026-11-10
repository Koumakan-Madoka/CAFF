// Native byte exchange over the existing verified Docker-exec mailbox. No
// credential file, model networking or scorer on the container side.
const { createMailbox } = require('./container-model-adapter.cjs');
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const MAILBOX_LIMITS = Object.freeze({ maxRequests: 32, maxRequestBytes: 4194304, maxResponseBytes: 4194304 });
const ALLOWED_HEADERS = new Set(['originator', 'user-agent', 'openai-beta', 'accept', 'content-type', 'content-encoding', 'session-id', 'x-client-request-id']);
const fail = suffix => Object.assign(Error('evaluation_codex_mailbox_' + suffix), { code: 'evaluation_codex_mailbox_' + suffix });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// Trusted execution config only. Default stays byte-compatible; neither the
// model request nor callback parameters can select a larger allowance.
function codexMailboxLimits(maxRequests = MAILBOX_LIMITS.maxRequests) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 64) throw fail('limits_invalid');
  return Object.freeze({ ...MAILBOX_LIMITS, maxRequests });
}
function decode(value) {
  if (typeof value !== 'string') throw Error();
  const b = Buffer.from(value, 'base64'); if (b.toString('base64') !== value) throw Error(); return b;
}
function encode(value, cap) { const b = Buffer.from(JSON.stringify(value)); if (b.length > cap) throw Error(); return b; }
function createCodexRelayExchange(transport) {
  if (typeof transport?.fetch !== 'function') throw fail('transport_required');
  return async bytes => {
    let q, body;
    try {
      if (!Buffer.isBuffer(bytes) || bytes.length > MAILBOX_LIMITS.maxRequestBytes) throw Error();
      q = JSON.parse(bytes); if (!object(q) || Object.keys(q).sort().join(',') !== 'body,headers' || !object(q.headers)
        || Object.entries(q.headers).some(([k, v]) => !ALLOWED_HEADERS.has(k) || typeof v !== 'string')) throw Error();
      body = decode(q.body);
    } catch { throw fail('request_invalid'); }
    // The trusted transport fixes endpoint/proxy/config and supplies the access
    // only on the host. No URL/auth/account identity is accepted from mailbox.
    const response = await transport.fetch(ENDPOINT, { method: 'POST', headers: q.headers, body });
    try {
      const output = Buffer.from(await response.arrayBuffer());
      return encode({ status: response.status, body: output.toString('base64') }, MAILBOX_LIMITS.maxResponseBytes);
    } catch { throw fail('response_invalid'); }
  };
}
function createCodexMailboxFetch({ exchange, callbackUrl, callbackFetch = globalThis.fetch, gate = () => {}, maxRequests } = {}) {
  const limits = codexMailboxLimits(maxRequests);
  let activeSignal, busy = false, requests = 0;
  const check = () => { gate(); if (activeSignal?.aborted) throw fail('aborted'); };
  const send = exchange || createMailbox({ maxRequests: limits.maxRequests,
    settings: { maxRequestBytes: MAILBOX_LIMITS.maxRequestBytes, maxResponseBytes: MAILBOX_LIMITS.maxResponseBytes } }, check);
  return async (url, options) => {
    const text = typeof url === 'string' || url instanceof URL ? String(url) : url?.url;
    if (callbackUrl && new URL(text).origin === callbackUrl) return callbackFetch(url, options);
    let encoded;
    try {
      if (text !== ENDPOINT || !object(options) || options.method !== 'POST' || busy
        || Object.keys(options).some(k => !['method', 'headers', 'body', 'signal'].includes(k))) throw Error();
      const headers = new Headers(options.headers); headers.delete('authorization'); headers.delete('chatgpt-account-id');
      if ([...headers.keys()].some(k => !ALLOWED_HEADERS.has(k))) throw Error();
      if (typeof options.body !== 'string' && !ArrayBuffer.isView(options.body)) throw Error();
      const body = typeof options.body === 'string' ? Buffer.from(options.body)
        : Buffer.from(new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength));
      encoded = encode({ headers: Object.fromEntries(headers), body: body.toString('base64') }, MAILBOX_LIMITS.maxRequestBytes);
    } catch { throw fail('request_invalid'); }
    busy = true; activeSignal = options.signal;
    try {
      check(); if (requests >= limits.maxRequests) throw fail('request_limit');
      requests++; const response = await send(encoded); check();
      try {
        if (!Buffer.isBuffer(response) || response.length > MAILBOX_LIMITS.maxResponseBytes) throw Error();
        const r = JSON.parse(response);
        if (!object(r) || Object.keys(r).sort().join(',') !== 'body,status' || !Number.isSafeInteger(r.status) || r.status < 200 || r.status > 599) throw Error();
        return new Response(decode(r.body), { status: r.status, headers: { 'content-type': r.status === 200 ? 'text/event-stream' : 'application/json' } });
      } catch { throw fail('response_invalid'); }
    } finally { activeSignal = undefined; busy = false; }
  };
}
module.exports = { createCodexRelayExchange, createCodexMailboxFetch, MAILBOX_LIMITS, codexMailboxLimits };
