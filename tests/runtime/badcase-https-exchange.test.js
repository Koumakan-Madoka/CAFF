const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { httpsExchangeEndpoint, createHttpsExchange } = require('../../build/server/domain/runtime/badcase-capture/https-exchange.js');
const { chatCompletionsSettings, encodeChatCompletionsRequest, dispatchChatCompletions } = require('../../build/server/domain/runtime/badcase-capture/chat-completions-protocol.js');
const { readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress.js');
const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
const endpoint = () => ({ hostname: 'api.caff-test.example', address: '93.184.216.34', path: '/v1/chat/completions',
  maxRequestBytes: 4096, maxResponseBytes: 4096, timeoutMs: 1000 });
const lease = () => ({ value: 'synthetic-local-only', expiresAt: Date.now() + 60000 });
const request = () => ({ body: Buffer.from('{"synthetic":true}'), signal: new AbortController().signal });
const invalid = e => e.code === 'model_https_invalid' && e.message === e.code;
const failed = e => e.code === 'model_https_failed' && e.message === e.code;
async function bytes(result) { const b = []; for await (const v of result.chunks) b.push(v); return Buffer.concat(b); }
function network(t, behavior = {}) {
  const original = https.request, calls = [];
  https.request = options => {
    const req = new EventEmitter(), socket = new EventEmitter();
    Object.assign(socket, { encrypted: true, authorized: true, remoteAddress: options.hostname, ...behavior.socket });
    req.destroyed = false; req.destroy = () => { req.destroyed = true; res.destroy(); };
    const res = new PassThrough(); Object.assign(res, { statusCode: 200, headers: { 'content-type': 'application/json' }, complete: true, ...behavior.response });
    res.on('error', () => {});
    req.end = body => {
      calls.at(-1).body = Buffer.from(body); behavior.onEnd?.(req, res);
      if (behavior.hang) return;
      queueMicrotask(() => {
        if (behavior.error) { req.emit('error', Error('PRIVATE-NETWORK')); return; }
        req.emit('response', res);
        if (!res.destroyed) {
          if (behavior.stream) behavior.stream(res); else res.end(behavior.body || Buffer.from('{"ok":true}'));
        }
      });
    };
    calls.push({ options, req, res, socket });
    queueMicrotask(() => { req.emit('socket', socket); socket.emit('secureConnect'); });
    return req;
  };
  t.after(() => { https.request = original; });
  return calls;
}

test('endpoint snapshot/hash and strict public IPv4, hostname, path and cap validation', () => {
  const e = endpoint(), p = httpsExchangeEndpoint(e);
  assert.deepEqual(p.endpoint, { protocol: 'pinned-https-v1', ...e });
  assert.equal(p.endpointHash, httpsExchangeEndpoint(Object.fromEntries(Object.entries(e).reverse())).endpointHash);
  for (const patch of [{ address: '0.1.2.3' }, { address: '10.0.0.1' }, { address: '127.0.0.1' }, { address: '169.254.169.254' },
    { address: '172.16.0.1' }, { address: '192.168.1.1' }, { address: '100.64.0.1' }, { address: '192.0.2.1' },
    { address: '192.88.99.1' }, { address: '198.19.0.1' }, { address: '198.51.100.1' }, { address: '203.0.113.1' },
    { address: '224.0.0.1' }, { address: '255.255.255.255' }, { address: '::1' }, { address: '0177.0.0.1' },
    { hostname: 'localhost' }, { hostname: 'api.local' }, { hostname: 'api.internal' }, { hostname: '127.0.0.1' },
    { hostname: 'api.example.' }, { hostname: 'API.example' }, { hostname: 'user@api.example' },
    { hostname: 'sk-' + 'a'.repeat(30) + '.example' },
    { path: '//elsewhere' }, { path: '/v1/../admin' }, { path: '/v1/a?key=x' }, { path: '/v1/%2e' },
    { port: 80 }, { proxy: 'anything' }, { timeoutMs: 0 }, { timeoutMs: 300001 }, { maxResponseBytes: 4194305 }])
    assert.throws(() => httpsExchangeEndpoint({ ...e, ...patch }), invalid, JSON.stringify(patch));
  for (const key of Object.keys(e)) {
    const other = { ...e, [key]: typeof e[key] === 'number' ? e[key] + 1 : key === 'path' ? '/other' : key === 'address' ? '8.8.8.8' : 'other.example' };
    assert.notEqual(httpsExchangeEndpoint(other).endpointHash, p.endpointHash);
  }
});

test('OpenCode client profile is explicit, destination-bound and changes endpoint hash without migrating legacy bytes', () => {
  const legacy = { ...endpoint(), hostname: 'opencode.ai', path: '/zen/go/v1/chat/completions' };
  const p = { ...legacy, clientProfile: 'opencode-go-v1' };
  assert.equal(httpsExchangeEndpoint(p).endpoint.clientProfile, 'opencode-go-v1');
  assert.notEqual(httpsExchangeEndpoint(p).endpointHash, httpsExchangeEndpoint(legacy).endpointHash);
  assert.equal(Object.hasOwn(httpsExchangeEndpoint(legacy).endpoint, 'clientProfile'), false);
  assert.equal(httpsExchangeEndpoint({ ...p, path: '/inference/go/openai/v1/chat/completions' }).endpoint.clientProfile, p.clientProfile);
  for (const patch of [{ clientProfile: 'other' }, { clientProfile: undefined }, { clientProfile: null },
    { hostname: 'other.example' }, { hostname: 'sub.opencode.ai' }, { path: '/inference/openai/v1/chat/completions' },
    { path: '/zen/v1/chat/completions' }, { headers: { 'User-Agent': 'OpenCode' } }])
    assert.throws(() => httpsExchangeEndpoint({ ...p, ...patch }), invalid);
});

test('OpenCode profile sends honest fixed identity and immutable per-run session, never arbitrary headers', async t => {
  const calls = network(t), e = { ...endpoint(), hostname: 'opencode.ai', path: '/zen/go/v1/chat/completions', clientProfile: 'opencode-go-v1' };
  const sessionId = hash('approved-run'), context = { sessionId };
  const exchange = createHttpsExchange(e, lease, context); context.sessionId = hash('changed');
  await exchange(request()); await exchange(request());
  assert.deepEqual(calls.map(c => c.options.headers['x-opencode-session']), [sessionId, sessionId]);
  assert.ok(calls.every(c => c.options.headers['User-Agent'] === 'caff-badcase-evaluator/1.0'));
  await createHttpsExchange(e, lease, { sessionId: hash('independent-run') })(request());
  assert.notEqual(calls[2].options.headers['x-opencode-session'], sessionId);
  for (const context of [undefined, null, {}, { sessionId: 'raw-conversation' }, { sessionId: 'a'.repeat(63) },
    { sessionId: 'A'.repeat(64) }, { sessionId, extra: true }, { sessionId: 'x\r\ny' }])
    assert.throws(() => createHttpsExchange(e, lease, context), invalid);
  assert.throws(() => createHttpsExchange(endpoint(), lease, { sessionId }), invalid);
  const getter = Object.defineProperty({}, 'sessionId', { enumerable: true, get() { throw Error('PRIVATE-CONTEXT'); } });
  assert.throws(() => createHttpsExchange(e, lease, getter), invalid);
  let reads = 0;
  const once = Object.defineProperty({}, 'sessionId', { enumerable: true, get() { reads++; return reads === 1 ? sessionId : 'INVALID'; } });
  const snapshotted = createHttpsExchange(e, lease, once); assert.equal(reads, 1);
  await snapshotted(request()); assert.equal(reads, 1);
  assert.equal(calls[3].options.headers['x-opencode-session'], sessionId);
  await createHttpsExchange(endpoint(), lease)(request());
  assert.equal(Object.hasOwn(calls[4].options.headers, 'x-opencode-session'), false);
  assert.equal(Object.hasOwn(calls[4].options.headers, 'User-Agent'), false);
  assert.equal(calls.length, 5);
});

test('fixed TLS/address/Host/POST, no proxy/agent reuse, credential scope and no send before verified TLS', async t => {
  const calls = network(t); let scopes = [];
  const e = endpoint(), x = createHttpsExchange(e, scope => { scopes.push(scope); return lease(); }); e.hostname = 'changed.example';
  const r = request(), original = Buffer.from(r.body), pending = x(r); r.body.fill(0);
  void pending.catch(() => {}); // mutation failures must not create unhandled rejections
  assert.equal(calls[0].options.hostname, '93.184.216.34');
  assert.equal(calls[0].body, undefined);
  assert.equal((await bytes(await pending)).toString(), '{"ok":true}');
  const { options: o, body } = calls[0]; assert.deepEqual(body, original);
  assert.equal(o.hostname, '93.184.216.34'); assert.equal(o.port, 443); assert.equal(o.servername, 'api.caff-test.example');
  assert.equal(o.path, '/v1/chat/completions'); assert.equal(o.method, 'POST'); assert.equal(o.agent, false);
  assert.equal(o.rejectUnauthorized, true); assert.equal(o.minVersion, 'TLSv1.2'); assert.deepEqual(o.ca, tls.rootCertificates);
  assert.equal(o.maxHeaderSize, 16384); assert.equal(o.headers.Host, 'api.caff-test.example');
  assert.equal(o.headers.Authorization, 'Bearer synthetic-local-only'); assert.equal(o.headers['Content-Length'], original.length);
  assert.equal(o.headers['Accept-Encoding'], 'identity'); assert.equal(o.headers.Connection, 'close');
  assert.ok(o.checkServerIdentity('ignored', { subjectaltname: 'DNS:other.example' }) instanceof Error);
  assert.deepEqual(scopes, [httpsExchangeEndpoint(endpoint()).endpointHash]);
  assert.equal(calls[0].req.destroyed, true);
});

test('bad requests, pre-abort, bad leases fail without network or credential diagnostics', async t => {
  const calls = network(t); let credentials = 0;
  const x = createHttpsExchange(endpoint(), () => { credentials++; return lease(); });
  const c = new AbortController(); c.abort();
  for (const r of [null, {}, { ...request(), signal: c.signal }, { ...request(), extra: 1 }, { ...request(), body: Buffer.alloc(4097) }])
    await assert.rejects(x(r), invalid);
  assert.equal(credentials, 0);
  for (const source of [() => { throw Error('PRIVATE-CREDENTIAL'); }, () => Promise.resolve(lease()),
    () => ({ ...lease(), extra: 1 }), () => ({ ...lease(), value: 'bad\r\nheader' }),
    () => ({ ...lease(), value: '' }), () => ({ ...lease(), expiresAt: Date.now() }), () => ({ ...lease(), value: 'a'.repeat(4097) })])
    await assert.rejects(createHttpsExchange(endpoint(), source)(request()), failed);
  assert.equal(calls.length, 0);
});

test('unverified or wrong peer socket never receives body or credential HTTP bytes', async t => {
  for (const socket of [{ authorized: false }, { encrypted: false }, { remoteAddress: '127.0.0.1' }]) {
    await t.test(JSON.stringify(socket), async t => {
      const calls = network(t, { socket });
      await assert.rejects(createHttpsExchange(endpoint(), lease)(request()), failed);
      assert.equal(calls[0].body, undefined); assert.equal(calls[0].req.destroyed, true);
    });
  }
});

test('redirect, retry status, compression, content type and declared length reject once and destroy', async t => {
  for (const response of [{ statusCode: 302, headers: { location: 'https://elsewhere.example' } }, { statusCode: 429 }, { statusCode: 500 },
    { headers: { 'content-type': 'text/plain' } }, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } },
    { headers: { 'content-type': 'application/json', 'content-length': '4097' } },
    { headers: { 'content-type': 'application/json', 'content-length': '01' } }]) {
    await t.test(JSON.stringify(response), async t => {
      const calls = network(t, { response }); await assert.rejects(createHttpsExchange(endpoint(), lease)(request()), failed);
      assert.equal(calls.length, 1); assert.equal(calls[0].req.destroyed, true); assert.equal(calls[0].res.destroyed, true);
      assert.equal(calls[0].res.listenerCount('data'), 0); // header rejection precedes body subscription
    });
  }
});

test('response aggregate bound, truncated framing and network errors fail without retry', async t => {
  for (const behavior of [{ body: Buffer.alloc(4097) }, { response: { complete: false } }, { error: true },
    { response: { headers: { 'content-type': 'application/json', 'content-length': '100' } } }]) {
    await t.test('failure', async t => {
      const calls = network(t, behavior); await assert.rejects(createHttpsExchange(endpoint(), lease)(request()), failed);
      assert.equal(calls.length, 1); assert.equal(calls[0].req.destroyed, true);
    });
  }
});

test('closed HTTPS labels survive protocol and durable ledger without response or credential details', async t => {
  for (const [stage, behavior] of [
    ['https_status', { response: { statusCode: 429 } }],
    ['https_headers', { response: { headers: { 'content-type': 'text/PRIVATE-CONTENT-TYPE' } } }],
    ['https_body', { response: { complete: false } }],
    ['https_peer', { socket: { authorized: false } }],
    ['https_connect', { dial: true }],
    ['https_credential', { credential: true }],
    ['https_cancelled', { hang: true }],
  ]) await t.test(stage, async t => {
    const calls = network(t, behavior);
    if (behavior.dial) https.request = () => { throw Error('PRIVATE-DIAL'); };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-https-stage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const s = { provider: 'synthetic', model: 'fixed-model', contextWindowTokens: 1000, maxOutputTokens: 100,
      temperature: 0, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1,
      maxRequestBytes: 4096, maxResponseBytes: 4096 };
    const p = chatCompletionsSettings(s), runId = hash(stage), policy = { approvalId: 'synthetic', planHash: hash('plan'), runId,
      provider: s.provider, model: s.model, settingsHash: p.settingsHash, expiresAt: Date.now() + 60000,
      maxRequests: 2, maxRequestBytes: 4096, maxResponseBytes: 4096, timeoutMs: 1000,
      perRequestReserveMicroUsd: p.perRequestReserveMicroUsd, runLimitMicroUsd: p.perRequestReserveMicroUsd * 2 };
    const x = createHttpsExchange({ ...endpoint(), timeoutMs: behavior.hang ? 15 : 1000 }, () => {
      if (behavior.credential) throw Error('PRIVATE-CREDENTIAL'); return lease();
    });
    const body = encodeChatCompletionsRequest(s, [{ role: 'user', content: 'PRIVATE-PROMPT' }]);
    const report = await dispatchChatCompletions(root, policy, s, async send => {
      await assert.rejects(send(body)); await assert.rejects(send(body), /model_egress_stopped/);
    }, x);
    assert.equal(report.requests[0].failureStage, stage); assert.equal(report.reason, 'transport_failed');
    assert.equal(report.unknownCostRequests, 1); assert.equal(report.knownCostMicroUsd, 0);
    assert.deepEqual(readModelEgress(root, runId), report);
    assert.equal(calls.length, behavior.dial || behavior.credential ? 0 : 1);
    const dir = path.join(root, 'model-egress', runId), disk = fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
    assert.ok(!disk.includes('PRIVATE-') && !disk.includes('synthetic-local-only'));
  });
});

test('composed request, HTTPS, lease and approval deadlines stay independent with sticky accounting', async t => {
  const cases = [
    { name: 'request', requestMs: 18000, httpsMs: 24000, leaseMs: 60000, approvalMs: 60000, at: 18000, fire: 0, status: 'timeout' },
    { name: 'https', requestMs: 24000, httpsMs: 18000, leaseMs: 60000, approvalMs: 60000, at: 18000, fire: 1, status: 'transport_failed' },
    { name: 'lease', requestMs: 24000, httpsMs: 23000, leaseMs: 9000, approvalMs: 60000, at: 9000, fire: 1, status: 'transport_failed' },
    { name: 'approval', requestMs: 24000, httpsMs: 23000, leaseMs: 60000, approvalMs: 12000, at: 12000, fire: 0, status: 'timeout' },
    { name: 'tie-https-first', requestMs: 18000, httpsMs: 18000, leaseMs: 60000, approvalMs: 60000, at: 18000, fire: 1, status: 'timeout' },
    { name: 'late-success-before-timer', requestMs: 18000, httpsMs: 24000, leaseMs: 60000, approvalMs: 60000, at: 18001, status: 'timeout' },
    { name: 'in-time-success', requestMs: 18000, httpsMs: 24000, leaseMs: 60000, approvalMs: 60000, at: 17000, status: 'completed' },
  ];
  for (const c of cases) await t.test(c.name, async t => {
    const calls = network(t, { hang: true }), timers = [], cleared = new Set();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-composed-deadline-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const wall = Date.now(); let elapsed = 0;
    t.mock.method(Date, 'now', () => wall + elapsed);
    t.mock.method(require('node:perf_hooks').performance, 'now', () => elapsed);
    t.mock.method(global, 'setTimeout', (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; });
    t.mock.method(global, 'clearTimeout', timer => { cleared.add(timer); });
    const s = { provider: 'synthetic', model: 'fixed-model', contextWindowTokens: 1000, maxOutputTokens: 100,
      temperature: 0, inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000,
      maxRequestBytes: 4096, maxResponseBytes: 4096 };
    const p = chatCompletionsSettings(s), runId = hash(c.name), policy = { approvalId: 'synthetic', planHash: hash('plan'), runId,
      provider: s.provider, model: s.model, settingsHash: p.settingsHash, expiresAt: wall + c.approvalMs,
      maxRequests: 2, maxRequestBytes: 4096, maxResponseBytes: 4096, timeoutMs: c.requestMs,
      perRequestReserveMicroUsd: p.perRequestReserveMicroUsd, runLimitMicroUsd: p.perRequestReserveMicroUsd * 2 };
    const body = encodeChatCompletionsRequest(s, [{ role: 'user', content: 'PRIVATE-PROMPT' }]);
    const x = createHttpsExchange({ ...endpoint(), timeoutMs: c.httpsMs }, () => ({ ...lease(), expiresAt: wall + c.leaseMs }));
    let sender;
    const pending = dispatchChatCompletions(root, policy, s, async send => {
      sender = send;
      if (c.status === 'completed') await send(body);
      else { await assert.rejects(send(body)); await assert.rejects(send(body), /model_egress_stopped/); }
    }, x);
    void pending.catch(() => {}); // a failed fixture assertion must not leave an unobserved rejection
    // Drain the bounded Promise/microtask setup, not wall time or any network.
    for (let n = 0; n < 12; n++) await Promise.resolve();
    assert.equal(timers.length, 2); assert.equal(calls.length, 1); assert.ok(calls[0].body);
    assert.equal(timers[0].delay, Math.min(c.requestMs, c.approvalMs));
    assert.equal(timers[1].delay, Math.min(c.httpsMs, c.leaseMs));
    const reserved = readModelEgress(root, runId);
    assert.equal(reserved.requests[0].status, 'reserved');
    elapsed = c.at;
    const response = Buffer.from(JSON.stringify({ id: 'synthetic', object: 'chat.completion', created: 1, model: s.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'PRIVATE-ANSWER' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    if (c.fire !== undefined) {
      timers[c.fire].fn();
      assert.equal(calls[0].req.destroyed, true, 'deadline must synchronously cancel its own request');
    } else { calls[0].req.emit('response', calls[0].res); calls[0].res.end(response); }
    const report = await pending;
    assert.equal(report.reason, c.status); assert.equal(report.requests[0].status, c.status);
    assert.equal(report.requests.length, 1); assert.equal(report.committedMicroUsd, p.perRequestReserveMicroUsd);
    assert.equal(report.unknownCostRequests, c.status === 'completed' ? 0 : 1);
    assert.equal(report.knownCostMicroUsd, c.status === 'completed' ? 40 : 0);
    assert.equal(report.requests[0].responseHash, c.status === 'completed' ? hash(response) : null);
    assert.equal(report.requests[0].failureStage, c.status === 'transport_failed' ? 'https_cancelled' : undefined);
    assert.equal(report.strictEvalEligible, false); assert.equal(report.executionVerified, false);
    assert.equal(calls[0].req.destroyed, true); assert.equal(calls[0].res.destroyed, true);
    assert.ok(timers.every(timer => cleared.has(timer)));
    assert.deepEqual(readModelEgress(root, runId), report);
    // Late callbacks/events cannot reopen the claim, release an answer or refund.
    elapsed += 60000; timers[1].fn(); calls[0].req.emit('response', calls[0].res);
    await assert.rejects(sender(body), /model_egress_stopped/);
    assert.equal(timers.length, 2); assert.equal(calls.length, 1);
    assert.deepEqual(readModelEgress(root, runId), report);
    const dir = path.join(root, 'model-egress', runId), disk = fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
    for (const text of ['PRIVATE-', 'synthetic-local-only']) assert.ok(!disk.includes(text));
  });
});

test('early deadline timer wakeup rearms without failing or mislabelling an in-flight request', async t => {
 for (const mode of ['abort', 'deadline']) await t.test(mode, async t => {
  const calls = network(t, { hang: true }), timers = [], cleared = [];
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const originalSet = global.setTimeout, originalClear = global.clearTimeout;
  global.setTimeout = (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; };
  global.clearTimeout = timer => { cleared.push(timer); };
  t.after(() => { global.setTimeout = originalSet; global.clearTimeout = originalClear; });
  const controller = new AbortController();
  const pending = createHttpsExchange(endpoint(), lease)({ ...request(), signal: controller.signal });
  const rejected = assert.rejects(pending, e => failed(e)
    && require('../../build/server/domain/runtime/badcase-capture/model-egress.js').modelFailureStage(e) === 'https_cancelled');
  void rejected.catch(() => {}); // keep a failing early assertion from producing unhandled activity
  await Promise.resolve(); // verified TLS, body sent; transport deliberately hangs
  assert.equal(timers.length, 1); assert.ok(calls[0].body);
  timers[0].fn(); // force a scheduler wakeup before either monotonic deadline
  assert.equal(calls[0].req.destroyed, false);
  assert.equal(timers.length, 2); assert.ok(timers[1].delay >= 1 && timers[1].delay <= 1000);
  if (mode === 'abort') controller.abort();
  else { now += 60000; timers[1].fn(); }
  await rejected;
  assert.equal(calls[0].req.destroyed, true); assert.ok(cleared.includes(timers[1]));
  timers[1].fn(); // a queued late callback cannot rearm after completion
  assert.equal(timers.length, 2);
  assert.equal(calls.length, 1); // rearming is not a second upstream request
 });
});

test('abort, absolute timeout, credential expiry and single in-flight rejection terminate own request', { timeout: 5000 }, async t => {
  for (const mode of ['abort', 'timeout', 'expiry']) {
    await t.test(mode, async t => {
      const calls = network(t, { hang: true }), c = new AbortController();
      const e = { ...endpoint(), timeoutMs: mode === 'timeout' ? 25 : 1000 };
      const x = createHttpsExchange(e, () => ({ ...lease(), expiresAt: Date.now() + (mode === 'expiry' ? 25 : 60000) }));
      const p = x({ ...request(), signal: c.signal });
      void p.catch(() => {}); // attach before testing a concurrent failure
      await assert.rejects(x(request()), invalid);
      if (mode === 'abort') c.abort();
      await assert.rejects(p, failed); assert.equal(calls.length, 1); assert.equal(calls[0].req.destroyed, true);
    });
  }
});

test('exact byte boundary accepted', async t => {
  const calls = network(t, { body: Buffer.alloc(4096, 97) });
  const result = await createHttpsExchange(endpoint(), lease)(request());
  assert.equal((await bytes(result)).length, 4096); assert.equal(calls.length, 1);
});

test('response chunks copied before producer can mutate them', async t => {
  network(t, { stream(res) {
    const chunk = Buffer.from('{"copy":true}'); res.emit('data', chunk); chunk.fill(0); res.end();
  } });
  assert.equal((await bytes(await createHttpsExchange(endpoint(), lease)(request()))).toString(), '{"copy":true}');
});

test('credential expiry remains bounded under clock rollback and delayed timer', async t => {
  const now = Date.now; t.after(() => { Date.now = now; });
  network(t, { onEnd() {
    const start = performance.now(); while (performance.now() - start < 35) { /* timer cannot fire */ }
    Date.now = () => now() - 60000;
  } });
  await assert.rejects(createHttpsExchange(endpoint(), () => ({ ...lease(), expiresAt: now() + 20 }))(request()), failed);
});

test('credential source reissued per request, async rejection drained, slow source cannot dial', async t => {
  const calls = network(t); let leases = 0;
  const x = createHttpsExchange(endpoint(), () => { leases++; return lease(); });
  await x(request()); await x(request()); assert.equal(leases, 2); assert.equal(calls.length, 2);
  await assert.rejects(createHttpsExchange(endpoint(), async () => { throw Error('PRIVATE-ISSUER'); })(request()), failed);
  await assert.rejects(createHttpsExchange({ ...endpoint(), timeoutMs: 5 }, () => {
    const start = performance.now(); while (performance.now() - start < 20) { /* sync trusted issuer */ } return lease();
  })(request()), failed);
  assert.equal(calls.length, 2);
});

test('response chunk count guard has bounded negative fixture', async t => {
  const calls = network(t, { stream(res) {
    // Emit bounded events directly: no infinite microtask starvation on mutation.
    for (let i = 0; i < 8193 && !res.destroyed; i++) res.emit('data', Buffer.alloc(0));
    if (!res.destroyed) res.end('{}');
  } });
  await assert.rejects(createHttpsExchange(endpoint(), lease)(request()), failed);
  assert.equal(calls[0].res.destroyed, true);
});

test('deadline monotonic recheck rejects late success even before timer callback', async t => {
  const calls = network(t, { onEnd() { const start = performance.now(); while (performance.now() - start < 20) { /* simulate blocked loop */ } } });
  await assert.rejects(createHttpsExchange({ ...endpoint(), timeoutMs: 5 }, lease)(request()), failed);
  assert.equal(calls.length, 1);
});

test('in-time data followed by late synchronous end is rejected at resolve, before delayed timer', { timeout: 3000 }, async t => {
  let dataAccepted = false;
  const calls = network(t, { stream(res) {
    res.emit('data', Buffer.from('{}')); dataAccepted = !res.destroyed;
    const start = performance.now(); while (performance.now() - start < 150) { /* timer cannot fire */ }
    res.emit('end');
  } });
  await assert.rejects(createHttpsExchange({ ...endpoint(), timeoutMs: 100 }, lease)(request()), failed);
  assert.equal(dataAccepted, true); assert.equal(calls[0].req.destroyed, true);
});

test('local real TLS: synthetic CA routing only in test; verify success, hostname mismatch and untrusted certificate', { timeout: 15000 }, async t => {
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('openssl unavailable; live TLS certificate fixture not generated'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-https-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem',
    '-days', '1', '-subj', '/CN=api.caff-test.example', '-addext', 'subjectAltName=DNS:api.caff-test.example'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, 'ephemeral synthetic certificate generation');
  const cert = fs.readFileSync(path.join(root, 'cert.pem')), key = fs.readFileSync(path.join(root, 'key.pem'));
  let received = 0, observed, mode = 'simple';
  const server = https.createServer({ key, cert }, (req, res) => {
    received++; observed = { host: req.headers.host, auth: req.headers.authorization, url: req.url };
    req.resume(); req.on('end', () => {
      if (mode === 'redirect') { res.writeHead(302, { Location: 'https://not-contacted.example' }); res.end(); return; }
      if (mode === 'slow') return; // owned request timer destroys this socket
      if (mode === 'headers') { res.writeHead(200, { 'X-Large': 'x'.repeat(17000) }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(mode === 'simple' ? '{"local":true}' : JSON.stringify({ id: 'synthetic', object: 'chat.completion', created: 1,
        model: 'fixed-model', choices: [{ index: 0, message: { role: 'assistant', content: 'local-synthetic-answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const original = https.request;
  t.after(() => { https.request = original; });
  let trust = true;
  // Test-only socket rerouting and synthetic CA. No production injection option;
  // outbound hostname/address assertions above independently pin real options.
  https.request = options => {
    const req = original({ ...options, hostname: '127.0.0.1', port: server.address().port, ...(trust ? { ca: cert } : {}) });
    req.on('socket', socket => Object.defineProperty(socket, 'remoteAddress', { value: options.hostname }));
    return req;
  };
  assert.equal((await bytes(await createHttpsExchange(endpoint(), lease)(request()))).toString(), '{"local":true}');
  assert.deepEqual(observed, { host: 'api.caff-test.example', auth: 'Bearer synthetic-local-only', url: '/v1/chat/completions' });
  await assert.rejects(createHttpsExchange({ ...endpoint(), hostname: 'other.example' }, lease)(request()), failed);
  trust = false; await assert.rejects(createHttpsExchange(endpoint(), lease)(request()), failed);
  assert.equal(received, 1); // neither failed TLS handshake sent HTTP credentials/body
  trust = true;
  for (const failureMode of ['redirect', 'slow', 'headers']) {
    mode = failureMode; const before = received;
    await assert.rejects(createHttpsExchange({ ...endpoint(), timeoutMs: 100 }, lease)(request()), failed);
    assert.equal(received, before + 1); // no redirect/retry, only one local request
  }
  const s = { provider: 'local-synthetic', model: 'fixed-model', contextWindowTokens: 1000, maxOutputTokens: 100,
    temperature: 0, inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000,
    maxRequestBytes: 4096, maxResponseBytes: 4096 };
  const p = chatCompletionsSettings(s);
  for (const failure of [false, true]) {
    mode = failure ? 'redirect' : 'protocol';
    const runId = hash('local-run-' + failure), policy = { approvalId: 'synthetic-not-paid', planHash: hash('synthetic-plan'), runId,
      provider: s.provider, model: s.model, settingsHash: p.settingsHash, expiresAt: Date.now() + 60000,
      maxRequests: 2, maxRequestBytes: 4096, maxResponseBytes: 4096, timeoutMs: 1000,
      perRequestReserveMicroUsd: p.perRequestReserveMicroUsd, runLimitMicroUsd: p.perRequestReserveMicroUsd * 2 };
    const x = createHttpsExchange(endpoint(), () => {
      assert.equal(readModelEgress(root, runId).requests.at(-1).status, 'reserved'); return lease();
    });
    const before = received;
    const report = await dispatchChatCompletions(root, policy, s, async send => {
      const body = encodeChatCompletionsRequest(s, [{ role: 'user', content: 'local-synthetic-question' }]);
      if (failure) { await assert.rejects(send(body)); await assert.rejects(send(body)); }
      else assert.equal(JSON.parse(await send(body)).choices[0].message.content, 'local-synthetic-answer');
    }, x);
    assert.equal(received, before + 1); assert.equal(report.reason, failure ? 'transport_failed' : 'completed');
    assert.equal(report.knownCostMicroUsd, failure ? 0 : 40); assert.equal(report.unknownCostRequests, failure ? 1 : 0);
    assert.deepEqual(readModelEgress(root, runId), report);
    const dir = path.join(root, 'model-egress', runId), disk = fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
    for (const text of ['synthetic-local-only', 'local-synthetic-question', 'local-synthetic-answer']) assert.ok(!disk.includes(text));
  }
});
