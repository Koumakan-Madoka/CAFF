// Trusted HOST ONLY foundation for Codex replay. Explicit, read-only access
// lease; no OAuth runtime, refresh field, discovery, writeback or global proxy.
// compare-sealed uses inspectAccess only on this host, before Docker staging.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const PROFILE = Object.freeze({ model: 'openai-codex/gpt-6.1-sol', api: 'openai-codex-responses', thinking: 'xhigh',
  fast: false, transport: 'sse', endpoint: 'https://chatgpt.com/backend-api/codex/responses', proxy: require('./host-proxy.cjs').url });
const MAX_REQUEST_BYTES = 16 * 1024 * 1024, MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const fail = code => Object.assign(Error('evaluation_codex_' + code), { code: 'evaluation_codex_' + code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const same = (a, b) => a.isFile() && b.isFile() && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k]);
function readAuth(file) {
  let fd, bytes;
  try {
    const parent = fs.lstatSync(path.dirname(file)), before = fs.lstatSync(file, { bigint: true });
    // The approved auth file may be a regular hardlink. Reading it cannot
    // mutate aliases; still reject symlinks and verify descriptor/path identity
    // and content metadata before/after the read (no alias discovery).
    if (!parent.isDirectory() || parent.isSymbolicLink() || !before.isFile() || before.size < 2n || before.size > 1048576n) throw Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) throw Error();
    bytes = Buffer.alloc(Number(before.size) + 1); let n = 0;
    while (n < bytes.length) { const got = fs.readSync(fd, bytes, n, bytes.length - n, n); if (!got) break; n += got; }
    if (n !== Number(before.size) || !same(before, fs.fstatSync(fd, { bigint: true })) || !same(before, fs.lstatSync(file, { bigint: true }))) throw Error();
    const text = bytes.subarray(0, n).toString('utf8');
    if (!Buffer.from(text).equals(bytes.subarray(0, n))) throw Error();
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch { throw fail('auth_unavailable'); }
  finally { bytes?.fill(0); if (fd !== undefined) fs.closeSync(fd); }
}
function createCodexAccess(authFile, { now = Date.now } = {}) {
  // No ambient directory or credential fallback. The caller must explicitly
  // select the authorized host .pi-sandbox/auth.json, not an agent sandbox.
  if (typeof authFile !== 'string' || !path.isAbsolute(authFile) || path.basename(authFile) !== 'auth.json'
    || path.basename(path.dirname(authFile)) !== '.pi-sandbox') throw fail('auth_source_invalid');
  const file = path.resolve(authFile); let lease, closed = false;
  const get = () => {
    if (closed) throw fail('access_closed');
    if (!lease) {
      const entry = own(readAuth(file), 'openai-codex');
      // Deliberately never access entry.refresh or pass the document to pi's
      // credential store. Its automatic OAuth refresh would mutate production.
      const access = own(entry, 'access'), expires = own(entry, 'expires');
      if (own(entry, 'type') !== 'oauth' || typeof access !== 'string' || access.length > 16384
        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(access) || !Number.isSafeInteger(expires)) throw fail('access_invalid');
      let payload;
      try { payload = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8')); } catch { throw fail('access_invalid'); }
      const accountId = own(own(payload, 'https://api.openai.com/auth'), 'chatgpt_account_id'), exp = own(payload, 'exp');
      if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(accountId) || !Number.isSafeInteger(exp)
        || !Number.isSafeInteger(exp * 1000)) throw fail('access_invalid');
      // Local claims are only an expiry/routing check, not signature validation.
      // The provider still authenticates the original token on every request.
      lease = Object.freeze({ access, accountId, expiresAt: Math.min(expires, exp * 1000) });
    }
    if (now() >= lease.expiresAt) throw fail('access_expired');
    return lease;
  };
  // Avoid accidental serialization of access/account identity or the source path.
  return Object.defineProperties({}, { get: { value: get }, close: { value: () => { closed = true; lease = undefined; } } });
}
const ALLOWED_HEADERS = new Set(['authorization', 'chatgpt-account-id', 'originator', 'user-agent', 'openai-beta', 'accept',
  'content-type', 'content-encoding', 'session-id', 'x-client-request-id']);
function snapshotRequest(url, options) {
  try {
    if (String(url) !== PROFILE.endpoint || !object(options) || options.method !== 'POST'
      || Object.keys(options).some(k => !['method', 'headers', 'body', 'signal'].includes(k))) throw Error();
    const headers = new Headers(options.headers);
    if ([...headers.keys()].some(k => !ALLOWED_HEADERS.has(k)) || headers.get('content-type') !== 'application/json'
      || headers.get('accept') !== 'text/event-stream' || ![null, 'zstd'].includes(headers.get('content-encoding'))) throw Error();
    if (typeof options.body !== 'string' && !ArrayBuffer.isView(options.body)) throw Error();
    const body = typeof options.body === 'string' ? Buffer.from(options.body) : Buffer.from(new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength));
    if (!body.length || body.length > MAX_REQUEST_BYTES) throw Error();
    const plain = headers.get('content-encoding') === 'zstd' ? zlib.zstdDecompressSync(body, { maxOutputLength: MAX_REQUEST_BYTES }) : body;
    if (plain.length > MAX_REQUEST_BYTES) throw Error();
    const text = plain.toString('utf8'); if (!Buffer.from(text).equals(plain)) throw Error();
    const value = JSON.parse(text);
    if (!object(value) || value.model !== 'gpt-6.1-sol' || value.stream !== true || value.store !== false
      || !Array.isArray(value.input) || value.reasoning?.effort !== PROFILE.thinking || Object.hasOwn(value, 'service_tier')) throw Error();
    // The container's inert SDK credential/identity are never used upstream.
    headers.delete('authorization'); headers.delete('chatgpt-account-id');
    return { headers, body, plain };
  } catch { throw fail('request_invalid'); }
}
function hasAccess(bytes, access) {
  return bytes.includes(access) || bytes.includes(JSON.stringify(access).slice(1, -1));
}
async function responseBytes(response, signal) {
  if (!response.body) {
    if (response.status !== 200) return Buffer.alloc(0);
    throw fail('response_invalid');
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
      size += value.byteLength; if (size > MAX_RESPONSE_BYTES) throw fail('response_too_large'); chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener('abort', abort); try { await reader.cancel(); } finally { reader.releaseLock(); } }
}
function quotaCode(value) { return /^(?:usage_limit_reached|insufficient_quota|quota_exceeded|GoUsageLimitError|FreeUsageLimitError)$/.test(value || ''); }
function sseTerminalReason(bytes) {
  // Only protocol error events, never ordinary answer/tool text, affect the
  // environment-stop classification. The native SDK remains the SSE parser.
  for (const frame of bytes.toString('utf8').split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(s => s.startsWith('data:')).map(s => s.slice(5).trim()).join('\n');
    let event; try { event = JSON.parse(data); } catch { continue; }
    if (!object(event)) continue;
    if (event.type === 'error' || event.type === 'response.failed' || event.response?.status === 'failed') {
      const code = event.code || event.error?.code || event.response?.error?.code;
      return quotaCode(code) ? 'quota_exhausted' : ['invalid_api_key', 'token_expired', 'invalid_token'].includes(code) ? 'access_rejected' : 'provider_failed';
    }
  }
  return null;
}
// Exception names/codes are external strings too. Project only fixed enums
// and bounded numeric errno, never message/stack/URL/request/cause prose.
const ERROR_TYPES = new Set(['Error','TypeError','RangeError','DOMException','AbortError','TimeoutError','SocketError','ConnectTimeoutError','HeadersTimeoutError','BodyTimeoutError','AggregateError']);
const ERROR_CODES = new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','EPIPE','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','ENETDOWN','ENOTFOUND','EAI_AGAIN','EAI_FAIL',
  'UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_ABORTED','UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_WRONG_VERSION_NUMBER']);
function networkDiagnostic(error, phase) {
  const values=[]; for(let e=error,i=0;e && i<4;i++,e=e.cause)values.push(e);
  const type=e=>ERROR_TYPES.has(e?.name)?e.name:'OtherError';
  return {phase,exceptionType:type(error),causeType:error?.cause?type(error.cause):null,
    code:values.map(e=>e.code).find(v=>ERROR_CODES.has(v)) || null,
    errno:values.map(e=>e.errno).find(v=>Number.isSafeInteger(v) && Math.abs(v)<=65535) ?? null};
}
function createCodexTransport(config, dependencies = {}) {
  if (config?.confirmed !== true) throw fail('confirmation_required');
  if (!object(config) || Object.keys(config).some(k => !['authFile', 'confirmed', 'timeoutMs'].includes(k))
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 2700000) throw fail('config_invalid');
  const credential = createCodexAccess(config.authFile, { now: dependencies.now || Date.now });
  const timeoutMs = config.timeoutMs, send = dependencies.fetch || ((...args) => require('undici').fetch(...args));
  const createDispatcher = dependencies.createDispatcher || (uri => new (require('undici').ProxyAgent)({ uri }));
  let dispatcher, closed = false, stopped = false, busy = false, active, reason = null, diagnostic = null, requests = 0;
  const stop = code => { stopped = true; reason = 'evaluation_codex_' + code; };
  const transportFetch = async (url, options) => {
    if (closed) throw fail('transport_closed');
    if (stopped) throw fail('transport_stopped');
    if (busy) throw fail('transport_busy');
    busy = true; let timer, signal, controller;
    try {
      const q = snapshotRequest(url, options);
      if (dependencies.containsKnownValue?.(q.plain)) throw fail('input_contains_known_key');
      const access = credential.get();
      if (hasAccess(q.plain, access.access) || [...q.headers.values()].some(s => s.includes(access.access))) throw fail('input_contains_access');
      if (options.signal?.aborted) throw fail('request_aborted');
      dispatcher ??= createDispatcher(PROFILE.proxy); // explicit per-request dispatcher; NO_PROXY/global dispatcher never wins
      controller = new AbortController(); active = controller;
      const deadline = new AbortController(); timer = setTimeout(() => deadline.abort(), timeoutMs); timer.unref?.();
      signal = AbortSignal.any([controller.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
      q.headers.set('authorization', 'Bearer ' + access.access); q.headers.set('chatgpt-account-id', access.accountId);
      ++requests;
      let response, bytes, phase = 'send';
      try {
        response = await send(PROFILE.endpoint, { method: 'POST', headers: q.headers, body: q.body, signal, dispatcher, redirect: 'error' });
        phase = 'receive'; bytes = await responseBytes(response, signal);
      } catch (e) {
        if (closed) throw fail('transport_closed');
        if (options.signal?.aborted) throw fail('request_aborted');
        if (deadline.signal.aborted) throw fail('request_timeout');
        if (['evaluation_codex_response_invalid', 'evaluation_codex_response_too_large'].includes(e?.code)) throw e;
        diagnostic = networkDiagnostic(e, phase);
        throw fail('proxy_failed');
      }
      // Inspect error bodies solely in memory for a coarse environment reason.
      // Never return raw non-200 errors, response headers, auth or account data.
      if (response.status !== 200) {
        let code = response.status === 401 || response.status === 403 ? 'access_rejected'
          : [502, 503, 504].includes(response.status) ? 'gateway_unavailable' : 'http_failed';
        if (response.status === 429) {
          let error; try { error = JSON.parse(bytes.toString('utf8')).error; } catch {}
          code = quotaCode(error?.code || error?.type) ? 'quota_exhausted' : 'rate_limited';
        }
        // No in-turn retry. Only the host's bounded alternating policy may
        // replace a gateway-failed turn after verified launcher cleanup.
        if (code === 'gateway_unavailable') reason = 'evaluation_codex_' + code;
        else stop(code);
        return new Response(JSON.stringify({ error: { code: reason, message: reason } }), { status: response.status, headers: { 'content-type': 'application/json' } });
      }
      if (hasAccess(bytes, access.access)) throw fail('output_contains_access');
      if (dependencies.containsKnownValue?.(bytes)) throw fail('output_contains_known_key');
      const terminal = sseTerminalReason(bytes); if (terminal) stop(terminal);
      return new Response(bytes, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } catch (e) {
      const code = /^evaluation_codex_[a-z_]+$/.test(e?.code || '') ? e.code : 'evaluation_codex_request_invalid';
      // A transient send/read failure ends this turn, not the batch. The host
      // may start another attempt only after its launcher proves cleanup.
      stopped = code !== 'evaluation_codex_proxy_failed'; reason = code; throw Object.assign(Error(code), { code });
    } finally { clearTimeout(timer); active = undefined; busy = false; }
  };
  return { fetch: transportFetch, state: () => ({ profile: PROFILE, requests, stopped, closed, reason, diagnostic: diagnostic && { ...diagnostic } }),
    beginAttempt() {
      if (closed) throw fail('transport_closed'); if (busy) throw fail('transport_busy');
      if (!stopped) { reason = null; diagnostic = null; }
    },
    inspectAccess(check) {
      if (closed) throw fail('transport_closed');
      if (stopped) throw Object.assign(Error(reason), { code: reason });
      let access;
      try { access = credential.get().access; }
      catch (e) { stopped = true; reason = e.code; throw e; }
      // Trusted synchronous host input/output checks only; never pass this
      // callback, credential lease or returned access into a worker or event.
      check(access);
    },
    async close() { if (closed) return; closed = true; credential.close(); active?.abort(); await dispatcher?.destroy(); } };
}
module.exports = { PROFILE, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, createCodexAccess, createCodexTransport, readPrivateJson: readAuth };
