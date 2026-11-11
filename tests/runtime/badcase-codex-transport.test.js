// Synthetic access credentials, native pi-ai serializer/parser and fake network only.
// Never opens a real auth.json, listens on 10090 or makes an external request.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const zlib = require('node:zlib');
const load = () => require('../../scripts/badcase-capture/codex-transport.cjs');
const hostProxy = require('../../scripts/badcase-capture/host-proxy.cjs');
test('shared host proxy is the immutable fixed policy, not an environment-selected endpoint', () => {
  assert.deepEqual(hostProxy, { host: '127.0.0.1', port: 10090, url: 'http://127.0.0.1:10090' });
  assert.equal(Object.isFrozen(hostProxy), true);
  assert.equal(load().PROFILE.proxy, hostProxy.url);
});
const epoch = 2000000000000, endpoint = 'https://chatgpt.com/backend-api/codex/responses';
const jwt = (exp = epoch / 1000 + 600, account = 'synthetic-account') => 'test.' + Buffer.from(JSON.stringify({
  exp, 'https://api.openai.com/auth': { chatgpt_account_id: account },
})).toString('base64url') + '.not-a-real-signature';
function fixture(t, entry = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-access-test-')), dir = path.join(root, '.pi-sandbox');
  fs.mkdirSync(dir); const authFile = path.join(dir, 'auth.json');
  const access = jwt(), refresh = 'SYNTHETIC-REFRESH-MUST-NEVER-BE-USED';
  const bytes = JSON.stringify({ 'openai-codex': { type: 'oauth', access, expires: epoch + 600000, refresh, ...entry },
    unrelated: { access: 'SYNTHETIC-UNRELATED-MUST-NEVER-BE-USED' } });
  fs.writeFileSync(authFile, bytes);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, authFile, access, refresh, bytes, config: { authFile, confirmed: true, timeoutMs: 1000 } };
}
const request = (patch = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream',
  authorization: 'Bearer inert-placeholder', 'chatgpt-account-id': 'placeholder', originator: 'pi' },
  body: JSON.stringify({ model: 'gpt-6.1-sol', instructions: 'Synthetic prompt.', input: [], stream: true, store: false,
    reasoning: { effort: 'xhigh', summary: 'auto' }, ...patch }) });
const sse = () => {
  const item = { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'synthetic answer', annotations: [] }] };
  const events = [{ type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item],
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 4 } } } }];
  return events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('');
};
function fakeTransport(f, { send = () => new Response(sse(), { headers: { 'content-type': 'text/event-stream' } }), now = () => epoch, guard } = {}) {
  const calls = [], agents = [];
  const transport = load().createCodexTransport(f.config, { now, containsKnownValue: guard, createDispatcher: uri => {
    const agent = { uri, destroyed: false, destroy: async () => { agent.destroyed = true; } }; agents.push(agent); return agent;
  }, fetch: async (url, options) => { calls.push({ url, options }); return send(url, options); } });
  return { transport, calls, agents };
}
test('access source is explicit, lazy, access-only, pinned in memory, with no refresh or auth-file writeback', t => {
  const f = fixture(t), { createCodexAccess } = load(); let at = epoch;
  const credential = createCodexAccess(f.config.authFile, { now: () => at });
  assert.equal(JSON.stringify(credential), '{}');
  const first = credential.get(); assert.equal(first.access, f.access); assert.equal(first.accountId, 'synthetic-account');
  fs.writeFileSync(f.authFile, JSON.stringify({ 'openai-codex': { type: 'oauth', access: jwt(epoch / 1000 + 1200), expires: epoch + 1200000 } }));
  assert.equal(credential.get().access, first.access, 'no token rotation/re-read while the lease is active');
  at = epoch + 600000; assert.throws(() => credential.get(), /evaluation_codex_access_expired/);
  credential.close(); assert.throws(() => credential.get(), /evaluation_codex_access_closed/);
  const untouched = fixture(t), copy = createCodexAccess(untouched.authFile, { now: () => epoch });
  copy.get(); copy.close(); assert.equal(fs.readFileSync(untouched.authFile, 'utf8'), untouched.bytes);
});
test('wrong source, missing provider, invalid/expired access never falls back to ambient credentials or refresh', t => {
  const { createCodexAccess, createCodexTransport } = load(), f = fixture(t);
  assert.throws(() => createCodexAccess(path.join(f.root, 'auth.json')), /evaluation_codex_auth_source_invalid/);
  assert.throws(() => createCodexTransport({ ...f.config, confirmed: false }), /evaluation_codex_confirmation_required/);
  for (const patch of [{ access: 'bad-token' }, { access: jwt(epoch / 1000 - 1) }, { expires: epoch - 1 },
    { type: 'api_key' }, { access: jwt(epoch / 1000 + 600, '') }, { expires: 'tomorrow' }]) {
    const bad = fixture(t, patch), reader = createCodexAccess(bad.authFile, { now: () => epoch });
    assert.throws(() => reader.get(), e => /^evaluation_codex_access_(invalid|expired)$/.test(e.message));
    assert.equal(fs.readFileSync(bad.authFile, 'utf8'), bad.bytes);
  }
  fs.writeFileSync(f.authFile, '{}'); assert.throws(() => createCodexAccess(f.authFile).get(), /evaluation_codex_access_invalid/);
  fs.unlinkSync(f.authFile); assert.throws(() => createCodexAccess(f.authFile).get(), /evaluation_codex_auth_unavailable/);
});
test('approved regular hardlinked auth is read-only and retains inode/content identity without discovering other paths', t => {
  const f = fixture(t), target = path.join(f.root, 'original.json'); fs.renameSync(f.authFile, target);
  try { fs.linkSync(target, f.authFile); } catch (e) { if (['EPERM', 'ENOTSUP'].includes(e.code)) return t.skip(e.code); throw e; }
  const before = fs.statSync(f.authFile, { bigint: true }), reader = load().createCodexAccess(f.authFile, { now: () => epoch });
  assert.equal(reader.get().access, f.access); reader.close();
  assert.deepEqual(fs.readFileSync(f.authFile), Buffer.from(f.bytes)); assert.deepEqual(fs.readFileSync(target), Buffer.from(f.bytes));
  const after = fs.statSync(f.authFile, { bigint: true });
  for (const key of ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
});
test('symbolic auth sources are still rejected', t => {
  const f = fixture(t), target = path.join(f.root, 'original.json'); fs.renameSync(f.authFile, target);
  try { fs.symlinkSync(target, f.authFile); } catch (e) { if (['EPERM', 'ENOTSUP'].includes(e.code)) return t.skip(e.code); throw e; }
  assert.throws(() => load().createCodexAccess(f.authFile).get(), /evaluation_codex_auth_unavailable/);
});
test('native Responses bytes and SSE preserved; fixed endpoint/proxy, credentials replaced only on the host, no redirect', async t => {
  const f = fixture(t), g = fakeTransport(f), q = request(), response = await g.transport.fetch(endpoint, q);
  assert.equal(await response.text(), sse()); assert.equal(g.calls.length, 1); assert.equal(g.agents.length, 1);
  const c = g.calls[0]; assert.equal(c.url, endpoint); assert.equal(c.options.dispatcher, g.agents[0]);
  assert.equal(g.agents[0].uri, hostProxy.url); assert.equal(c.options.redirect, 'error');
  assert.equal(c.options.headers.get('authorization'), 'Bearer ' + f.access);
  assert.equal(c.options.headers.get('chatgpt-account-id'), 'synthetic-account');
  assert.equal(Buffer.from(c.options.body).toString(), q.body); assert.equal(q.headers.authorization, 'Bearer inert-placeholder');
  assert.equal(fs.readFileSync(f.authFile, 'utf8'), f.bytes);
  assert.equal(JSON.stringify(g.transport.state()).includes(f.access), false); assert.equal(JSON.stringify(g.transport.state()).includes(f.refresh), false);
  await g.transport.close(); assert.equal(g.agents[0].destroyed, true);
  await assert.rejects(g.transport.fetch(endpoint, request()), /evaluation_codex_transport_closed/);
});
test('invalid destinations/configs and unapproved reasoning are rejected before credential read or egress', async t => {
  for (const change of [q => ['https://elsewhere.invalid/responses', q], q => [endpoint + '?x=1', q], q => [endpoint, { ...q, method: 'GET' }],
    q => [endpoint, { ...q, headers: { ...q.headers, cookie: 'forbidden' } }], q => [endpoint, { ...q, redirect: 'follow' }],
    () => [endpoint, request({ model: 'other' })], () => [endpoint, request({ reasoning: { effort: 'off' } })],
    () => [endpoint, request({ store: true })], () => [endpoint, request({ service_tier: 'priority' })]]) {
    const f = fixture(t); fs.unlinkSync(f.authFile); const g = fakeTransport(f);
    await assert.rejects(g.transport.fetch(...change(request())), /evaluation_codex_request_invalid/);
    assert.equal(g.calls.length, 0); assert.equal(g.agents.length, 0); await g.transport.close();
  }
});
test('expired credential and outgoing/incoming selected-access leaks stop without leaking values', async t => {
  const expired = fixture(t, { expires: epoch - 1 }), x = fakeTransport(expired);
  await assert.rejects(x.transport.fetch(endpoint, request()), /evaluation_codex_access_expired/); assert.equal(x.calls.length, 0); await x.transport.close();
  for (const direction of ['out', 'in']) {
    const f = fixture(t), g = fakeTransport(f, { send: () => new Response(sse() + f.access) });
    const q = direction === 'out' ? request({ instructions: 'Do not send ' + f.access }) : request();
    await assert.rejects(g.transport.fetch(endpoint, q), /evaluation_codex_(input|output)_contains_access/);
    assert.equal(g.calls.length, direction === 'out' ? 0 : 1);
    assert.equal(JSON.stringify(g.transport.state()).includes(f.access), false); await g.transport.close();
  }
});
test('host inventory guard checks actual request/response plaintext, not only the selected access or initial workspace', async t => {
  const opaque = 'synthetic-other-provider-known-value';
  for (const direction of ['out', 'in']) {
    const f = fixture(t), g = fakeTransport(f, { guard: bytes => bytes.includes(opaque), send: () => new Response(sse().replace('synthetic answer', opaque)) });
    const q = direction === 'out' ? request({ instructions: opaque }) : request();
    await assert.rejects(g.transport.fetch(endpoint, q), new RegExp('evaluation_codex_' + (direction === 'out' ? 'input' : 'output') + '_contains_known_key'));
    assert.equal(g.calls.length, direction === 'out' ? 0 : 1); assert.equal(g.transport.state().stopped, true);
    assert.equal(JSON.stringify(g.transport.state()).includes(opaque), false); await g.transport.close();
  }
});
test('auth refusal, exhausted quota and HTTP failure latch closed; no SDK retry or direct fallback', async t => {
  for (const [status, code] of [[401, 'access_rejected'], [403, 'access_rejected'], [429, 'quota_exhausted'],
    ...[301, 307, 400, 404, 408, 500, 501, 505, 529].map(status => [status, 'http_failed'])]) {
    const f = fixture(t), g = fakeTransport(f, { send: () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: f.access } }), { status }) });
    const r = await g.transport.fetch(endpoint, request()); assert.equal(r.status, status);
    const text = await r.text(); assert.match(text, new RegExp('evaluation_codex_' + code)); assert.equal(text.includes(f.access), false);
    assert.equal(g.transport.state().reason, 'evaluation_codex_' + code);
    await assert.rejects(g.transport.fetch(endpoint, request()), /evaluation_codex_transport_stopped/); assert.equal(g.calls.length, 1); await g.transport.close();
  }
  const f = fixture(t), g = fakeTransport(f, { send: () => { throw Error('ECONNREFUSED ' + f.access); } });
  await assert.rejects(g.transport.fetch(endpoint, request()), /evaluation_codex_proxy_failed/);
  assert.equal(g.transport.state().stopped, false); assert.equal(g.calls.length, 1, 'no within-turn retry'); await g.transport.close();
});
test('only upstream 502/503/504 permit a new host attempt, preserving status without exposing bodies or retrying within the turn', async t => {
  for (const status of [502, 503, 504]) {
    const f = fixture(t); let sends = 0;
    const g = fakeTransport(f, { send: () => ++sends === 1
      ? new Response(JSON.stringify({ error: { code: 'PRIVATE-UPSTREAM', message: f.access } }), { status })
      : new Response(sse()) });
    const response = await g.transport.fetch(endpoint, request());
    assert.equal(response.status, status); assert.equal(g.calls.length, 1, 'no within-turn retry');
    assert.deepEqual(await response.json(), { error: { code: 'evaluation_codex_gateway_unavailable', message: 'evaluation_codex_gateway_unavailable' } });
    assert.equal(g.transport.state().reason, 'evaluation_codex_gateway_unavailable');
    assert.equal(g.transport.state().stopped, false);
    assert.doesNotMatch(JSON.stringify(g.transport.state()), /PRIVATE-UPSTREAM/);
    assert.equal(JSON.stringify(g.transport.state()).includes(f.access), false);
    g.transport.beginAttempt(); assert.equal(g.transport.state().reason, null);
    assert.equal((await g.transport.fetch(endpoint, request())).status, 200); assert.equal(g.calls.length, 2);
    assert.equal(fs.readFileSync(f.authFile, 'utf8'), f.bytes); await g.transport.close();
  }
});
test('single send/read failures are replaceable and expose only allowlisted type/errno, never exception prose or key', async t => {
  for (const phase of ['send', 'receive']) {
    const f = fixture(t); let count = 0;
    const g = fakeTransport(f, { send: () => {
      if (++count > 1) return new Response(sse());
      const cause = Object.assign(Error('PRIVATE ' + f.access), { code: 'ECONNRESET', errno: -4077 });
      const error = new TypeError('PRIVATE-BODY ' + f.access, { cause });
      if (phase === 'send') throw error;
      return new Response(new ReadableStream({ start(c) { c.error(error); } }));
    } });
    await assert.rejects(g.transport.fetch(endpoint, request()), /evaluation_codex_proxy_failed/);
    assert.equal(g.calls.length, 1); assert.equal(g.transport.state().stopped, false);
    assert.deepEqual(g.transport.state().diagnostic, { phase, exceptionType: 'TypeError', causeType: 'Error', code: 'ECONNRESET', errno: -4077 });
    assert.doesNotMatch(JSON.stringify(g.transport.state()), /PRIVATE/); assert.equal(JSON.stringify(g.transport.state()).includes(f.access), false);
    g.transport.beginAttempt(); assert.equal(g.transport.state().reason, null); assert.equal(g.transport.state().diagnostic, null);
    assert.equal((await g.transport.fetch(endpoint, request())).status, 200); assert.equal(g.calls.length, 2); await g.transport.close();
  }
});
test('empty HTTP auth/quota errors retain their status and still stop before another request', async t => {
  for (const [status, reason] of [[401, 'access_rejected'], [429, 'rate_limited']]) {
    const f = fixture(t), g = fakeTransport(f, { send: () => new Response(null, { status }) });
    const response = await g.transport.fetch(endpoint, request()); assert.equal(response.status, status);
    assert.equal(g.transport.state().reason, 'evaluation_codex_' + reason);
    await assert.rejects(g.transport.fetch(endpoint, request()), /evaluation_codex_transport_stopped/); assert.equal(g.calls.length, 1); await g.transport.close();
  }
});
test('HTTP-200 SSE quota error stops, but ordinary answer text mentioning quota does not', async t => {
  const f = fixture(t), g = fakeTransport(f, { send: () => new Response('data: ' + JSON.stringify({ type: 'error', code: 'usage_limit_reached', message: f.access }) + '\n\n') });
  // Even terminal provider errors must never echo selected access bytes.
  await assert.rejects(g.transport.fetch(endpoint, request()), /evaluation_codex_output_contains_access/); await g.transport.close();
  const h = fakeTransport(f, { send: () => new Response('data: {"type":"error","code":"usage_limit_reached"}\n\n') });
  await h.transport.fetch(endpoint, request()); assert.equal(h.transport.state().reason, 'evaluation_codex_quota_exhausted');
  await assert.rejects(h.transport.fetch(endpoint, request()), /evaluation_codex_transport_stopped/); await h.transport.close();
  const normal = fakeTransport(f, { send: () => new Response(sse().replaceAll('synthetic answer', 'usage_limit_reached')) });
  await normal.transport.fetch(endpoint, request()); assert.equal(normal.transport.state().reason, null); await normal.transport.close();
});
test('real pi-ai Codex parser does not retry an upstream gateway error inside a turn', async t => {
  const { OPENAI_CODEX_MODELS } = await import('@earendil-works/pi-ai/providers/openai-codex.models');
  const { streamSimple } = await import('@earendil-works/pi-ai/api/openai-codex-responses');
  const { normalizeContext } = await import('@earendil-works/pi-ai/utils/transcript');
  for (const status of [502, 503, 504]) {
    const f = fixture(t), g = fakeTransport(f, { send: () => new Response('PRIVATE-UPSTREAM', { status }) });
    const output = await streamSimple(OPENAI_CODEX_MODELS['gpt-6.1-sol'], normalizeContext({ systemPrompt: 'Synthetic system.',
      messages: [{ role: 'user', content: 'Synthetic task.', timestamp: 1 }] }),
    { apiKey: jwt(), fetch: g.transport.fetch, transport: 'sse', reasoning: 'xhigh', maxRetries: 0 }).result();
    assert.equal(output.stopReason, 'error'); assert.equal(g.calls.length, 1);
    assert.equal(g.transport.state().reason, 'evaluation_codex_gateway_unavailable');
    assert.equal(g.transport.state().stopped, false); assert.doesNotMatch(output.errorMessage, /PRIVATE-UPSTREAM/);
    await g.transport.close();
  }
});
test('caller abort, close and request deadline cancel in-flight sends and destroy the dedicated dispatcher', async t => {
  for (const mode of ['abort', 'close', 'timeout']) {
    const f = fixture(t), abort = new AbortController(); let signal;
    const g = fakeTransport(f, { send: (_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal; signal.addEventListener('abort', () => reject(Error('synthetic aborted')), { once: true });
    }) });
    const pending = assert.rejects(g.transport.fetch(endpoint, { ...request(), signal: abort.signal }), /evaluation_codex_(request_aborted|transport_closed|request_timeout)/);
    if (mode === 'abort') abort.abort(); if (mode === 'close') await g.transport.close();
    // The real child socket keeps an event loop alive. Our fake needs an owned timer for AbortSignal.timeout.
    const keepalive = setTimeout(() => {}, 1500);
    await pending; clearTimeout(keepalive); assert.equal(signal.aborted, true); await g.transport.close(); assert.equal(g.agents[0].destroyed, true);
  }
});
test('response/request limits, unsupported compression and concurrent callers fail closed', async t => {
  const { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } = load();
  for (const q of [{ ...request(), body: Buffer.alloc(MAX_REQUEST_BYTES + 1) },
    { ...request(), headers: { ...request().headers, 'content-encoding': 'gzip' } }]) {
    const f = fixture(t), g = fakeTransport(f);
    await assert.rejects(g.transport.fetch(endpoint, q), /evaluation_codex_request_invalid/); assert.equal(g.calls.length, 0); await g.transport.close();
  }
  const f = fixture(t); let cancelled = false;
  const g = fakeTransport(f, { send: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); }, cancel() { cancelled = true; },
  })) });
  await assert.rejects(g.transport.fetch(endpoint, request()), /evaluation_codex_response_too_large/);
  assert.equal(cancelled, true); await g.transport.close();
  let finish;
  const h = fakeTransport(f, { send: () => new Promise(resolve => { finish = resolve; }) });
  const pending = h.transport.fetch(endpoint, request());
  await assert.rejects(h.transport.fetch(endpoint, request()), /evaluation_codex_transport_busy/); assert.equal(h.calls.length, 1);
  finish(new Response(sse())); await pending; await h.transport.close();
});
test('zstd bodies cannot hide outgoing access or inflate beyond the decoded model-request limit', { skip: typeof zlib.zstdCompressSync !== 'function' }, async t => {
  for (const mode of ['access', 'limit']) {
    const f = fixture(t), g = fakeTransport(f), { MAX_REQUEST_BYTES } = load();
    const q = request({ instructions: mode === 'access' ? f.access : 'x'.repeat(MAX_REQUEST_BYTES) });
    q.body = zlib.zstdCompressSync(q.body); q.headers['content-encoding'] = 'zstd';
    await assert.rejects(g.transport.fetch(endpoint, q), mode === 'access' ? /evaluation_codex_input_contains_access/ : /evaluation_codex_request_invalid/);
    assert.equal(g.calls.length, 0); await g.transport.close();
  }
});
test('real undici transport uses only the dedicated proxy dispatcher; proxy CONNECT rejection cannot fall back direct', async t => {
  const http = require('node:http'), { ProxyAgent } = require('undici'), f = fixture(t), proxy = http.createServer();
  const sockets = new Set(), destinations = []; let transport;
  t.after(async () => { await transport?.close(); for (const s of sockets) s.destroy(); if (proxy.listening) await new Promise(resolve => proxy.close(resolve)); });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, socket) => { destinations.push(req.url); socket.end('HTTP/1.1 502 Synthetic proxy refusal\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  transport = load().createCodexTransport(f.config, { now: () => epoch, createDispatcher: uri => {
    assert.equal(uri, hostProxy.url); return new ProxyAgent({ uri: 'http://127.0.0.1:' + proxy.address().port });
  } });
  await assert.rejects(transport.fetch(endpoint, request()), /evaluation_codex_proxy_failed/);
  assert.equal(transport.state().stopped, false); assert.equal(transport.state().requests, 1);
  transport.beginAttempt();
  await assert.rejects(transport.fetch(endpoint, request()), /evaluation_codex_proxy_failed/);
  assert.deepEqual(destinations, ['chatgpt.com:443', 'chatgpt.com:443']); assert.equal(transport.state().requests, 2);
});
test('real pi-ai Codex serializer/parser uses gpt-6.1-sol xhigh, native tool schema, compressed bytes and token usage', async t => {
  const f = fixture(t), g = fakeTransport(f); t.after(() => g.transport.close());
  const { OPENAI_CODEX_MODELS } = await import('@earendil-works/pi-ai/providers/openai-codex.models');
  const { streamSimple } = await import('@earendil-works/pi-ai/api/openai-codex-responses');
  const { normalizeContext } = await import('@earendil-works/pi-ai/utils/transcript');
  const model = OPENAI_CODEX_MODELS['gpt-6.1-sol']; assert.equal(model.api, 'openai-codex-responses');
  const output = await streamSimple(model, normalizeContext({ systemPrompt: 'Synthetic system.', messages: [{ role: 'user', content: 'Synthetic task.', timestamp: 1 }],
    tools: [{ name: 'read', description: 'Synthetic read.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }),
  { apiKey: jwt(epoch / 1000 + 1000, 'inert-container-placeholder'), fetch: g.transport.fetch, transport: 'sse', reasoning: 'xhigh', maxRetries: 0 }).result();
  assert.equal(output.stopReason, 'stop', output.errorMessage); assert.equal(g.calls.length, 1);
  const { headers, body } = g.calls[0].options;
  const decoded = headers.get('content-encoding') === 'zstd' ? zlib.zstdDecompressSync(body) : body;
  const wire = JSON.parse(Buffer.from(decoded).toString());
  assert.equal(wire.model, 'gpt-6.1-sol'); assert.equal(wire.reasoning.effort, 'xhigh'); assert.equal(wire.store, false); assert.equal(wire.stream, true);
  assert.equal(wire.tools[0].name, 'read'); assert.equal(wire.instructions, 'Synthetic system.');
  assert.equal(output.content.find(b => b.type === 'text').text, 'synthetic answer');
  assert.equal(output.usage.input, 16); assert.equal(output.usage.cacheRead, 4); assert.equal(output.usage.output, 5); assert.equal(output.usage.totalTokens, 25);
});
