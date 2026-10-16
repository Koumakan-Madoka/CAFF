const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chatCompletionsSettings, encodeChatCompletionsRequest, createChatCompletionsTransport, dispatchChatCompletions } = require('../../build/server/domain/runtime/badcase-capture/chat-completions-protocol.js');
const { readModelEgress, modelFailureStage } = require('../../build/server/domain/runtime/badcase-capture/model-egress.js');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const spec = () => ({ provider: 'offline-compatible', model: 'fixed-model-v1', contextWindowTokens: 1000,
  maxOutputTokens: 100, temperature: 0, inputMicroUsdPerMillionTokens: 1000000,
  outputMicroUsdPerMillionTokens: 2000000, maxRequestBytes: 4096, maxResponseBytes: 4096 });
const messages = () => [{ role: 'system', content: 'test instruction' }, { role: 'user', content: 'synthetic question' }];
const response = () => ({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'fixed-model-v1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic answer', refusal: null, annotations: [] }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
function request(s = spec()) {
  return { requestId: hash('request'), provider: s.provider, model: s.model,
    settingsHash: chatCompletionsSettings(s).settingsHash, body: encodeChatCompletionsRequest(s, messages()), signal: new AbortController().signal };
}
function exchange(value = response()) {
  return async () => ({ status: 200, chunks: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
}
const invalid = e => e.code === 'chat_completions_invalid' && e.message === e.code;

test('fixed settings bind all limits and pricing, exact integer rounding and stable order', () => {
  const s = spec(), p = chatCompletionsSettings(s);
  assert.equal(p.perRequestReserveMicroUsd, 1200);
  assert.equal(p.settingsHash, chatCompletionsSettings(Object.fromEntries(Object.entries(s).reverse())).settingsHash);
  assert.equal(chatCompletionsSettings({ ...s, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1 }).perRequestReserveMicroUsd, 2);
  for (const key of Object.keys(s)) {
    const changed = { ...s, [key]: typeof s[key] === 'number' ? s[key] + 1 : s[key] + '-other' };
    assert.notEqual(chatCompletionsSettings(changed).settingsHash, p.settingsHash, key);
  }
  assert.deepEqual(p.settings, { protocol: 'chat-completions-text-v1', ...s });
  for (const patch of [{ extra: true }, { temperature: 3 }, { temperature: NaN }, { maxOutputTokens: 1001 },
    { maxResponseBytes: 4194305 }, { model: 'https://host/model' }, { provider: 'sk-' + 'a'.repeat(32) },
    { inputMicroUsdPerMillionTokens: -1 }, { contextWindowTokens: 1.5 }, { maxRequestBytes: 0 }])
    assert.throws(() => chatCompletionsSettings({ ...s, ...patch }), invalid);
});

test('encoder preserves text and fixes wire settings, rejects unsupported rather than stripping', () => {
  const body = JSON.parse(encodeChatCompletionsRequest(spec(), messages()));
  assert.deepEqual(body, { model: 'fixed-model-v1', messages: messages(), temperature: 0,
    max_completion_tokens: 100, n: 1, stream: false, store: false });
  for (const value of [[], Array(257).fill(messages()[0]), [{ role: 'tool', content: 'x' }],
    [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], [{ role: 'user', content: 'x', name: 'extra' }],
    [{ role: 'assistant', content: 'x', tool_calls: [] }], [{ role: 'user', content: '\ud800' }],
    [{ role: 'user', content: 'sk-' + 'a'.repeat(32) }], [{ role: 'user', content: 'x'.repeat(4096) }]])
    assert.throws(() => encodeChatCompletionsRequest(spec(), value), invalid);
});

test('request validation blocks setting overrides and unsupported wire keys before exchange', async () => {
  let calls = 0;
  const send = createChatCompletionsTransport(spec(), async () => { calls++; return exchange()(); });
  for (const patch of [{ model: 'other' }, { temperature: 1 }, { max_completion_tokens: 101 }, { n: 2 },
    { stream: true }, { store: true }, { tools: [] }, { max_tokens: 100 }, { seed: 1 },
    { messages: [{ role: 'developer', content: 'unsupported' }] }]) {
    const r = request(); r.body = Buffer.from(JSON.stringify({ ...JSON.parse(r.body), ...patch }));
    await assert.rejects(send(r), e => invalid(e) && modelFailureStage(e) === 'protocol_request');
  }
  for (const patch of [{ provider: 'other' }, { model: 'other' }, { settingsHash: hash('other') }, { requestId: 'bad' }])
    await assert.rejects(send({ ...request(), ...patch }), invalid);
  const r = request();
  for (const bytes of [Buffer.from(' ' + r.body), Buffer.from(r.body.toString().replace('"n":1', '"n":2,"n":1')), Buffer.from([255])])
    await assert.rejects(send({ ...r, body: bytes }), invalid);
  assert.equal(calls, 0);
});

test('fragmented UTF8 JSON response preserves bytes, verifies model/usage and computes tariff', async () => {
  const value = response(); value.choices[0].message.content = '合成回复';
  const bytes = Buffer.from(JSON.stringify(value)); let received;
  const send = createChatCompletionsTransport(spec(), async r => {
    received = r;
    return { status: 200, chunks: (async function* () { for (const byte of bytes) yield Buffer.from([byte]); })() };
  });
  const result = await send(request());
  assert.deepEqual(result.body, bytes); assert.equal(result.costMicroUsd, 40);
  assert.deepEqual(Object.keys(received).sort(), ['body', 'signal']);
  assert.equal(received.signal.aborted, true); // transport scope closed after response
});

test('bounded collection closes iterable on byte overflow, invalid chunk and chunk flood', { timeout: 3000 }, async () => {
  for (const mode of ['overflow', 'type', 'flood']) {
    let closed = false, pulls = 0;
    const send = createChatCompletionsTransport(spec(), async () => ({ status: 200, chunks: (async function* () {
      try {
        // Finite flood: removing the count guard must fail quickly, not starve
        // timers forever in an infinite microtask loop.
        while (pulls < 8194) { pulls++; yield mode === 'overflow' ? Buffer.alloc(4097) : mode === 'type' ? 'text' : Buffer.alloc(0); }
        yield Buffer.from(JSON.stringify(response()));
      } finally { closed = true; }
    })() }));
    await assert.rejects(send(request()), invalid);
    assert.equal(closed, true); assert.equal(pulls, mode === 'flood' ? 8193 : 1);
  }
});

test('overflow aborts exchange before awaiting iterable cleanup', { timeout: 3000 }, async () => {
  let abortedAtClose = false;
  const send = createChatCompletionsTransport(spec(), async r => ({ status: 200, chunks: (async function* () {
    try { yield Buffer.alloc(4097); }
    finally { abortedAtClose = r.signal.aborted; }
  })() }));
  await assert.rejects(send(request()), invalid);
  assert.equal(abortedAtClose, true);
});

test('chunk buffers are copied immediately, not retained as mutable views', async () => {
  const bytes = Buffer.from(JSON.stringify(response())), split = 20;
  const send = createChatCompletionsTransport(spec(), async () => ({ status: 200, chunks: (async function* () {
    const first = Buffer.from(bytes.subarray(0, split)); yield first; first.fill(0); yield bytes.subarray(split);
  })() }));
  assert.deepEqual((await send(request()).then(r => r.body)), bytes);
});

test('cumulative byte boundary accepts exact fit and stops before retaining overflow', async () => {
  const bytes = Buffer.from(JSON.stringify(response()));
  for (const delta of [0, -1]) {
    const s = { ...spec(), maxResponseBytes: bytes.length + delta };
    const send = createChatCompletionsTransport(s, async () => ({ status: 200, chunks: (async function* () {
      yield bytes.subarray(0, 20); yield bytes.subarray(20);
    })() }));
    if (delta === 0) assert.deepEqual((await send(request(s))).body, bytes);
    else await assert.rejects(send(request(s)), invalid);
  }
});

test('tariff ceil and total context bound apply to accepted usage', async () => {
  const s = { ...spec(), inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1 };
  assert.equal((await createChatCompletionsTransport(s, exchange())(request(s))).costMicroUsd, 2);
  const v = response(); v.usage = { prompt_tokens: 990, completion_tokens: 20, total_tokens: 1010 };
  await assert.rejects(createChatCompletionsTransport(spec(), exchange(v))(request()), invalid);
});

test('malformed, mismatched, truncated, unsupported and unaccounted responses fail closed', async () => {
  const mutations = [v => v.model = 'other', v => v.object = 'other', v => v.choices.push(v.choices[0]),
    v => v.choices[0].index = 1, v => v.choices[0].finish_reason = 'length',
    v => v.choices[0].message.tool_calls = [], v => v.choices[0].message.content = null,
    v => v.choices[0].message.content = 'sk-' + 'a'.repeat(32), v => v.choices[0].message.refusal = 'refused',
    v => delete v.usage, v => v.usage.completion_tokens = 101,
    v => v.usage = { prompt_tokens: 20, completion_tokens: 101, total_tokens: 121 }, // sum valid; output cap independently violated
    v => v.usage.prompt_tokens = 1001,
    v => v.usage.total_tokens++, v => v.usage.prompt_tokens = -1, v => v.usage.total_tokens = 1.5,
    v => v.usage.prompt_tokens_details = { cached_tokens: 1 },
    v => v.usage.completion_tokens_details = { reasoning_tokens: 1 }, v => v.unrecognized = true];
  for (const mutate of mutations) {
    const v = response(); mutate(v);
    await assert.rejects(createChatCompletionsTransport(spec(), exchange(v))(request()), invalid);
  }
  for (const status of [301, 429, 500]) {
    let pulled = false, aborted = false;
    const send = createChatCompletionsTransport(spec(), async r => { r.signal.addEventListener('abort', () => aborted = true);
      return { status, chunks: (async function* () { pulled = true; yield Buffer.from('PRIVATE-ERROR'); })() }; });
    await assert.rejects(send(request()), invalid); assert.equal(pulled, false); assert.equal(aborted, true);
  }
});

test('zero-valued optional usage details accepted but unknown or nonzero extensions rejected', async () => {
  const v = response(); v.system_fingerprint = null; v.service_tier = 'default';
  v.usage.prompt_tokens_details = { cached_tokens: 0, audio_tokens: 0 };
  v.usage.completion_tokens_details = { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 };
  assert.equal((await createChatCompletionsTransport(spec(), exchange(v))(request())).costMicroUsd, 40);
  v.usage.prompt_tokens_details.other = 0;
  await assert.rejects(createChatCompletionsTransport(spec(), exchange(v))(request()), invalid);
});

test('abort propagated before exchange and after delayed chunk, late success never accepted', { timeout: 5000 }, async () => {
  let calls = 0;
  const before = request(), c = new AbortController(); c.abort(); before.signal = c.signal;
  const send = createChatCompletionsTransport(spec(), async () => { calls++; return exchange()(); });
  await assert.rejects(send(before), invalid); assert.equal(calls, 0);
  const during = request(), controller = new AbortController(); during.signal = controller.signal;
  let settled = false, closed = false;
  const delayed = createChatCompletionsTransport(spec(), async r => ({ status: 200, chunks: (async function* () {
    try { await new Promise(resolve => setTimeout(resolve, 10)); controller.abort();
      assert.equal(r.signal.aborted, true); settled = true; yield Buffer.from(JSON.stringify(response())); }
    finally { closed = true; }
  })() }));
  await assert.rejects(delayed(during), invalid); assert.equal(settled, true); assert.equal(closed, true);
});

test('invalid request objects and signals retain fixed error boundary', async () => {
  const send = createChatCompletionsTransport(spec(), async () => assert.fail());
  for (const value of [null, {}, { ...request(), signal: 'not-a-signal' }])
    await assert.rejects(send(value), invalid);
});

test('exceptions and invalid UTF8 become fixed errors without body or provider diagnostics', async () => {
  for (const x of [async () => { throw Error('PRIVATE-PROVIDER'); }, async () => ({ status: 200, chunks: (async function* () {
    throw Error('PRIVATE-STREAM'); })() }), async () => ({ status: 200, chunks: (async function* () { yield Buffer.from([255]); })() })])
    await assert.rejects(createChatCompletionsTransport(spec(), x)(request()), invalid);
});

test('failure stage is fixed, distinguishes exchange/collection/decode/schema, and persists without payload', async t => {
  const cases = [
    ['protocol_exchange', async () => { throw Error('PRIVATE-UPSTREAM'); }],
    ['protocol_collect', async () => ({ status: 200, chunks: (async function* () { throw Error('PRIVATE-STREAM'); })() })],
    ['protocol_decode', async () => ({ status: 200, chunks: (async function* () { yield Buffer.from('PRIVATE-NOT-JSON'); })() })],
    ['protocol_response_envelope', exchange({ ...response(), model: 'wrong-model' })],
    ['protocol_response_choice', exchange({ ...response(), choices: [{ ...response().choices[0], finish_reason: 'length' }] })],
    ['protocol_response_usage', exchange({ ...response(), usage: { ...response().usage, total_tokens: 99 } })],
  ];
  for (const [stage, x] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-protocol-stage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const s = spec(), p = chatCompletionsSettings(s), runId = hash(stage);
    const policy = { approvalId: 'offline-test', planHash: hash('plan'), runId, provider: s.provider, model: s.model,
      settingsHash: p.settingsHash, expiresAt: Date.now() + 60000, maxRequests: 2, maxRequestBytes: 4096,
      maxResponseBytes: 4096, timeoutMs: 1000, perRequestReserveMicroUsd: p.perRequestReserveMicroUsd, runLimitMicroUsd: 2400 };
    const report = await dispatchChatCompletions(root, policy, s, async send => {
      await assert.rejects(send(encodeChatCompletionsRequest(s, messages())));
      await assert.rejects(send(encodeChatCompletionsRequest(s, messages())), /model_egress_stopped/);
    }, x);
    assert.equal(report.requests[0].failureStage, stage);
    assert.equal(report.reason, 'transport_failed'); assert.equal(report.unknownCostRequests, 1);
    assert.deepEqual(readModelEgress(root, runId), report);
    const disk = fs.readdirSync(path.join(root, 'model-egress', runId)).map(n => fs.readFileSync(path.join(root, 'model-egress', runId, n), 'utf8')).join('');
    assert.ok(!disk.includes('PRIVATE-') && !disk.includes('synthetic'));
  }
});

test('settings and request bytes snapshotted before asynchronous exchange', async () => {
  const s = spec(), r = request(s), original = Buffer.from(r.body);
  const send = createChatCompletionsTransport(s, async value => {
    r.body.fill(120); assert.deepEqual(value.body, original); return exchange()();
  });
  s.model = 'changed'; s.maxOutputTokens = 1;
  assert.equal((await send(r)).costMicroUsd, 40);
});

test('real coordinator integration reserves before exchange, persists hashes and stops on protocol error', async t => {
  for (const bad of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-protocol-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const s = spec(), settings = chatCompletionsSettings(s), body = encodeChatCompletionsRequest(s, messages());
    const policy = { approvalId: 'offline-test', planHash: hash('plan'), runId: hash('run'), provider: s.provider, model: s.model,
      settingsHash: settings.settingsHash, expiresAt: Date.now() + 60000, maxRequests: 2, maxRequestBytes: s.maxRequestBytes,
      maxResponseBytes: s.maxResponseBytes, timeoutMs: 1000, perRequestReserveMicroUsd: settings.perRequestReserveMicroUsd,
      runLimitMicroUsd: 2400 };
    let calls = 0;
    const exchangeFn = async () => {
      calls++; const state = readModelEgress(root, policy.runId);
      assert.equal(state.requests.at(-1).status, 'reserved'); assert.equal(state.committedMicroUsd, 1200);
      const v = response(); if (bad) delete v.usage;
      return exchange(v)();
    };
    for (const patch of [{ provider: 'other' }, { model: 'other' }, { settingsHash: hash('other') },
      { maxRequestBytes: 4095 }, { maxResponseBytes: 4095 }, { perRequestReserveMicroUsd: 1199 }]) {
      await assert.rejects(dispatchChatCompletions(root, { ...policy, ...patch }, s, async () => assert.fail(), exchangeFn), invalid);
      assert.deepEqual(fs.readdirSync(root), []); assert.equal(calls, 0);
    }
    const report = await dispatchChatCompletions(root, policy, s, async send => {
      if (bad) { await assert.rejects(send(body)); await assert.rejects(send(body), /model_egress_stopped/); }
      else assert.equal(JSON.parse(await send(body)).choices[0].message.content, 'synthetic answer');
    }, exchangeFn);
    assert.equal(calls, 1); assert.equal(report.reason, bad ? 'transport_failed' : 'completed');
    assert.equal(report.knownCostMicroUsd, bad ? 0 : 40); assert.equal(report.unknownCostRequests, bad ? 1 : 0);
    assert.equal(report.committedMicroUsd, 1200); assert.equal(report.paidAuthorization, false);
    assert.deepEqual(readModelEgress(root, policy.runId), report);
    const dir = path.join(root, 'model-egress', policy.runId);
    assert.ok(!fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('').includes('synthetic'));
  }
});
