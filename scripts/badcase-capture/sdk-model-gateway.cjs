// Trusted operator-only, buffered OpenAI SSE compatibility for the ORIGINAL SDK.
// No SDK execution, supplier credential, destination selection or paid authority.
// Supply ONLY the send closure owned by the approved host supervisor/dual ledgers.
// The same helper can live inside a network=none container with send=mailbox; it
// does not open the container network or give tested code the host send closure.
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { toolChatCompletionsSettings, encodeToolChatCompletionsRequest, createToolChatCompletionsTransport }
  = require('../../build/server/domain/runtime/badcase-capture/chat-completions-protocol');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, required, optional = []) => object(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const exact = (v, names) => keys(v, names);
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
function fail() { throw Error('sdk_model_gateway_invalid'); }
function check(v) { if (!v) fail(); }
const MAPPING = Object.freeze({ kind: 'buffered-sdk-chat-bridge-v1', upstreamStreaming: false,
  request: ['stream=true -> false', 'stream_options.include_usage=true -> validated final usage',
    'missing temperature/n/store/tool_choice/parallel_tool_calls -> approved fixed values',
    'text-only content blocks -> ordered concatenation without separators',
    'tool strict=false or absent -> unconstrained function schema', 'nonthinking empty reasoning_content -> absent'],
  response: ['validated full response -> role, content/call, finish, usage, DONE SSE frames',
    'exact provider text/call ID/name/argument bytes and usage retained', 'no partial response before request-ledger settlement'] });

function requestBody(bytes, profile, reviewed) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= profile.settings.maxRequestBytes);
  const text = bytes.toString('utf8'); check(Buffer.from(text).equals(bytes));
  const q = JSON.parse(text);
  // Native OpenAI SDK serializes once with JSON.stringify. Reject duplicate keys,
  // alternate encodings and unknown parameters rather than erase settings.
  check(JSON.stringify(q) === text && !containsSecretSentinel(text));
  const s = profile.settings;
  check(keys(q, ['model', 'messages', 'tools', 'stream', 'stream_options', 'max_completion_tokens'],
    ['temperature', 'n', 'store', 'tool_choice', 'parallel_tool_calls', ...(s.compatibilityProfile ? ['thinking'] : [])]));
  check(q.model === s.model && q.stream === true && q.max_completion_tokens === s.maxOutputTokens
    && exact(q.stream_options, ['include_usage']) && q.stream_options.include_usage === true);
  for (const [k, expected] of Object.entries({ temperature: s.temperature, n: 1, store: false, tool_choice: 'auto', parallel_tool_calls: false })) {
    check(!Object.hasOwn(q, k) || q[k] === expected);
  }
  if (s.compatibilityProfile) check(exact(q.thinking, ['type']) && q.thinking.type === 'disabled');
  check(Array.isArray(q.tools));
  const tools = q.tools.map(t => {
    check(exact(t, ['type', 'function']) && keys(t.function, ['name', 'description', 'parameters'], ['strict']));
    check(!Object.hasOwn(t.function, 'strict') || t.function.strict === false);
    const { strict: _strict, ...f } = t.function; return { type: t.type, function: f };
  });
  const actual = toolChatCompletionsSettings({ settings: s, tools });
  check(actual.settingsHash === reviewed.settingsHash); // includes tool order, descriptions and complete schemas
  check(Array.isArray(q.messages) && q.messages.length <= 256);
  const messages = q.messages.map(m => {
    check(object(m));
    const copy = { ...m };
    if (Object.hasOwn(copy, 'reasoning_content')) {
      check(s.compatibilityProfile && m.role === 'assistant' && (m.reasoning_content === '' || m.reasoning_content === null));
      delete copy.reasoning_content;
    }
    if (Array.isArray(copy.content)) {
      check(copy.content.length > 0 && copy.content.every(b => exact(b, ['type', 'text']) && b.type === 'text' && typeof b.text === 'string'));
      copy.content = copy.content.map(b => b.text).join('');
    }
    return copy;
  });
  // Reuse original history/tool/secret/byte validation and exact upstream encoder.
  return encodeToolChatCompletionsRequest(profile, messages);
}
function sse(bytes) {
  // Called only AFTER the original protocol validates the complete response.
  const raw = JSON.parse(bytes), c = raw.choices[0], m = c.message;
  const base = { id: raw.id, object: 'chat.completion.chunk', created: raw.created, model: raw.model,
    ...(Object.hasOwn(raw, 'system_fingerprint') ? { system_fingerprint: raw.system_fingerprint } : {}),
    ...(Object.hasOwn(raw, 'service_tier') ? { service_tier: raw.service_tier } : {}) };
  const choice = (delta, finish_reason = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason }] });
  const delta = { ...(m.content === null ? {} : { content: m.content }),
    ...(m.tool_calls ? { tool_calls: m.tool_calls.map(t => ({ index: 0, id: t.id, type: t.type, function: t.function })) } : {}) };
  return Buffer.from([choice({ role: 'assistant' }), choice(delta), choice({}, c.finish_reason),
    { ...base, choices: [], usage: raw.usage }].map(v => 'data: ' + JSON.stringify(v) + '\n\n').join('') + 'data: [DONE]\n\n');
}
function collect(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0, count = 0; const chunks = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', error); };
    const error = () => { cleanup(); reject(Error('sdk_model_gateway_invalid')); };
    const data = b => {
      if (!Buffer.isBuffer(b) || ++count > 8192 || b.length > cap - size) { error(); req.resume(); return; }
      chunks.push(b); size += b.length;
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', error);
  });
}
async function startSdkModelGateway(input, send) {
  // No route calls this constructor and there is no ambient credential fallback.
  check(exact(input, ['profile', 'maxRequests', 'expiresAt']) && typeof send === 'function');
  check(integer(input.maxRequests, 1, 1000) && integer(input.expiresAt, Date.now() + 1, Date.now() + 300000));
  check(exact(input.profile, ['settings', 'tools']));
  const profile = JSON.parse(JSON.stringify(input.profile)), reviewed = toolChatCompletionsSettings(profile);
  const maxRequests = input.maxRequests, expiresAt = input.expiresAt;
  const started = performance.now(), lifetime = expiresAt - Date.now();
  const apiKey = crypto.randomBytes(32).toString('hex');
  let stopped = false, failed = false, requests = 0, busy = false, timer, closing;
  const pending = new Set(), sockets = new Set();
  const expired = () => Date.now() >= expiresAt || performance.now() - started >= lifetime;
  const guard = () => check(!stopped && !expired());
  // Independently validate the response even if a trusted test/misconfigured
  // caller supplies a send closure not obtained from dispatchBoundModelEvaluation.
  // This adds no approval, refund, retry or independent cost settlement.
  const transport = createToolChatCompletionsTransport(profile, async ({ body }) => {
    guard(); const response = await send(body); guard();
    check(Buffer.isBuffer(response) && response.length <= profile.settings.maxResponseBytes);
    return { status: 200, chunks: (async function* () { yield response; })() };
  });
  const server = http.createServer({ maxHeaderSize: 16384 });
  server.maxConnections = 8; server.requestTimeout = Math.min(300000, lifetime); server.headersTimeout = Math.min(10000, lifetime);
  const respond = (res, status, text, type = 'application/json') => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', connection: 'close' }); res.end(text);
  };
  const failure = (res, status) => respond(res, status, '{"error":"sdk_model_gateway_unavailable"}');
  let authority;
  async function handle(req, res) {
    // Fresh loopback-only identity, no cookie/session/browser authorization. Host
    // is fixed, never used as an upstream destination. Supplier Key stays outside.
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== authority || req.headers.origin !== undefined
      || req.headers.authorization !== 'Bearer ' + apiKey) { req.resume(); failure(res, 403); return; }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { req.resume(); failure(res, 404); return; }
    if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'] !== undefined) { req.resume(); failure(res, 415); return; }
    if (stopped || failed || expired() || requests >= maxRequests) { req.resume(); failure(res, 503); return; }
    if (busy) { req.resume(); failure(res, 409); return; }
    busy = true;
    let dispatched = false;
    try {
      const length = req.headers['content-length'];
      check(length === undefined || (/^[1-9]\d*$/.test(length) && Number(length) <= profile.settings.maxRequestBytes));
      const bytes = await collect(req, profile.settings.maxRequestBytes); guard();
      const body = requestBody(bytes, profile, reviewed);
      guard(); requests++; dispatched = true;
      const result = await transport({ requestId: hash(body), provider: profile.settings.provider, model: profile.settings.model,
        settingsHash: reviewed.settingsHash, body, signal: new AbortController().signal });
      guard(); check(!res.destroyed);
      respond(res, 200, sse(result.body), 'text/event-stream; charset=utf-8');
    } catch {
      failed = true; req.resume(); failure(res, dispatched ? 502 : 400);
    } finally { busy = false; }
  }
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('request', (req, res) => {
    const task = handle(req, res); pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
  });
  async function stop() {
    if (!closing) {
      stopped = true; clearTimeout(timer);
      closing = (async () => {
        const closed = new Promise((resolve, reject) => server.close(e => e ? reject(Error('sdk_model_gateway_stop_failed')) : resolve()));
        for (const socket of sockets) socket.destroy();
        // The original supervisor owns cancellation/termination. Join any active
        // send even if it ignores abort: this is not a hard wall-clock guarantee.
        await Promise.allSettled([...pending]); await closed;
      })();
    }
    await closing;
  }
  await new Promise((resolve, reject) => {
    const error = () => { server.off('listening', ready); reject(Error('sdk_model_gateway_start_failed')); };
    const ready = () => { server.off('error', error); resolve(); };
    server.once('error', error); server.once('listening', ready); server.listen(0, '127.0.0.1');
  });
  authority = '127.0.0.1:' + server.address().port;
  const wake = () => {
    if (expired()) { void stop().catch(() => {}); }
    else timer = setTimeout(wake, Math.max(1, Math.min(expiresAt - Date.now(), lifetime - (performance.now() - started))));
  };
  wake(); timer?.unref();
  return { baseUrl: 'http://' + authority + '/v1', apiKey,
    declaration: { ...JSON.parse(JSON.stringify(MAPPING)), mappingHash: hash(JSON.stringify(MAPPING)), settingsHash: reviewed.settingsHash },
    status: () => ({ requests, busy, failed, stopped }), stop };
}
module.exports = { startSdkModelGateway };
