const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('../../build/server/domain/runtime/badcase-capture/chat-completions-protocol.js');
const { readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress.js');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const config = () => ({ settings: { provider: 'synthetic', model: 'fixed-model', contextWindowTokens: 1000, maxOutputTokens: 100,
  temperature: 0, inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000, maxRequestBytes: 8192, maxResponseBytes: 8192 },
  tools: [{ type: 'function', function: { name: 'read', description: 'Read a synthetic file', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }] });
const messages = () => [{ role: 'system', content: 'synthetic role' }, { role: 'user', content: 'synthetic task' }];
const call = (id = 'call-1') => ({ id, type: 'function', function: { name: 'read', arguments: '{ "path": "synthetic.txt" }' } });
const response = (tool = true) => ({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'fixed-model',
  choices: [{ index: 0, message: tool ? { role: 'assistant', content: null, tool_calls: [call()] } : { role: 'assistant', content: 'synthetic answer' }, finish_reason: tool ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
const exchange = value => async () => ({ status: 200, chunks: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
function request(c = config(), history = messages()) {
  return { requestId: hash('request'), provider: c.settings.provider, model: c.settings.model,
    settingsHash: api.toolChatCompletionsSettings(c).settingsHash,
    body: api.encodeToolChatCompletionsRequest(c, history), signal: new AbortController().signal };
}
const invalid = e => e.code === 'chat_completions_invalid' && e.message === e.code;
const history = () => [...messages(), { role: 'assistant', content: null, tool_calls: [call()] }, { role: 'tool', tool_call_id: 'call-1', content: 'synthetic result' }];

test('explicit tool profile binds complete definitions with distinct hash; legacy encoder stays text-only', () => {
  const c = config(), p = api.toolChatCompletionsSettings(c);
  assert.equal(p.settings.protocol, 'chat-completions-tools-v1');
  assert.notEqual(p.settingsHash, api.chatCompletionsSettings(c.settings).settingsHash);
  assert.equal(p.perRequestReserveMicroUsd, 1200);
  const other = config(); other.tools[0].function.parameters = { additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } }, type: 'object' };
  assert.equal(api.toolChatCompletionsSettings(other).settingsHash, p.settingsHash);
  other.tools[0].function.description += ' changed'; assert.notEqual(api.toolChatCompletionsSettings(other).settingsHash, p.settingsHash);
  c.tools[0].function.name = 'mutated'; assert.equal(p.tools[0].function.name, 'read');
  assert.throws(() => api.encodeChatCompletionsRequest(c.settings, history()), invalid);
});

test('tool registry rejects empty/duplicate/unknown/oversized/deep/ref/secret declarations', () => {
  for (const change of [c => c.tools = [], c => c.tools.push(c.tools[0]), c => c.tools = Array.from({ length: 17 }, (_, i) => ({ type: 'function', function: { ...c.tools[0].function, name: 'tool' + i } })),
    c => c.tools[0].type = 'custom', c => c.tools[0].function.name = '../bad', c => c.tools[0].function.extra = true,
    c => c.tools[0].function.description = 'x'.repeat(8192), c => c.tools[0].function.description = 'sk-' + 'a'.repeat(32),
    c => c.tools[0].function.parameters.$ref = 'https://example.test/schema', c => c.tools[0].function.parameters = [],
    c => { let p = c.tools[0].function.parameters; for (let i = 0; i < 20; i++) p = p.nested = {}; },
    c => c.tools[0].function.parameters.values = Array(2050).fill(0), c => c.extra = true]) {
    const c = config(); change(c); assert.throws(() => api.toolChatCompletionsSettings(c), invalid);
  }
});

test('tool encoder preserves argument bytes and matching history, fixes definitions and serial execution', () => {
  const c = config(), v = JSON.parse(api.encodeToolChatCompletionsRequest(c, history()));
  assert.deepEqual(v.messages, history()); assert.deepEqual(v.tools, api.toolChatCompletionsSettings(c).tools);
  assert.equal(v.parallel_tool_calls, false); assert.equal(v.tool_choice, 'auto');
  assert.equal(v.model, c.settings.model); assert.equal(v.max_completion_tokens, 100); assert.equal(v.stream, false);
});

test('tool history rejects orphan/duplicate/reordered/missing results, unknown tools and unsupported roles', () => {
  const valid = history();
  const values = [[...messages(), valid[3]], valid.slice(0, -1), [...valid, valid[3]], [...valid.slice(0, 3), messages()[1], valid[3]],
    [...valid, valid[2], valid[3]], [{ role: 'developer', content: 'x' }]];
  for (const change of [v => v[3].tool_call_id = 'other', v => v[2].tool_calls[0].function.name = 'unknown',
    v => v[2].tool_calls.push(call('call-2')), v => v[2].tool_calls[0].function.arguments = '[]',
    v => v[2].tool_calls[0].function.arguments = '{', v => v[3].extra = true,
    v => v[2].content = ['image'], v => v[3].content = 'sk-' + 'a'.repeat(32),
    v => v[2].tool_calls[0].function.arguments = '{"k":"\\u0073k-' + 'a'.repeat(32) + '"}']) { const v = history(); change(v); values.push(v); }
  for (const v of values) assert.throws(() => api.encodeToolChatCompletionsRequest(config(), v), invalid);
});

test('tool request override or text-profile hash fails before exchange', async () => {
  let calls = 0; const c = config(), send = api.createToolChatCompletionsTransport(c, async () => { calls++; return exchange(response())(); });
  for (const patch of [{ tools: [] }, { tool_choice: 'required' }, { parallel_tool_calls: true }, { model: 'other' },
    { temperature: 1 }, { max_completion_tokens: 101 }, { seed: 1 }, { messages: history().slice(0, -1) }]) {
    const r = request(); r.body = Buffer.from(JSON.stringify({ ...JSON.parse(r.body), ...patch })); await assert.rejects(send(r), invalid);
  }
  const r = request(); await assert.rejects(send({ ...r, settingsHash: api.chatCompletionsSettings(c.settings).settingsHash }), invalid);
  const renamed = JSON.parse(r.body); renamed.tools[0].function.description += ' changed';
  await assert.rejects(send({ ...r, body: Buffer.from(JSON.stringify(renamed)) }), invalid);
  await assert.rejects(send({ ...r, body: Buffer.from(' ' + r.body) }), invalid); assert.equal(calls, 0);
});

test('tool response accepted without executing anything; raw bytes and declared cost retained', async () => {
  const v = response(), raw = Buffer.from(JSON.stringify(v));
  const r = await api.createToolChatCompletionsTransport(config(), exchange(v))(request());
  assert.deepEqual(r.body, raw); assert.equal(r.costMicroUsd, 40);
  const final = await api.createToolChatCompletionsTransport(config(), exchange(response(false)))(request(config(), history()));
  assert.equal(JSON.parse(final.body).choices[0].message.content, 'synthetic answer');
});

test('response rejects unknown/reused/multiple calls, invalid arguments, truncation and unaccounted usage', async () => {
  for (const change of [v => v.choices[0].message.tool_calls[0].function.name = 'other', v => v.choices[0].message.tool_calls.push(call('call-2')),
    v => v.choices[0].message.tool_calls[0].function.arguments = 'null', v => v.choices[0].message.tool_calls[0].function.arguments = '{',
    v => v.choices[0].message.tool_calls[0].function.arguments = '{"k":"sk-' + 'a'.repeat(32) + '"}',
    v => v.choices[0].message.tool_calls[0].function.arguments = '{"k":"\\u0073k-' + 'a'.repeat(32) + '"}',
    v => v.choices[0].finish_reason = 'stop', v => v.choices[0].finish_reason = 'length', v => v.choices[0].message.refusal = 'no',
    v => v.choices[0].message.annotations = [{}], v => v.choices[0].message.extra = true, v => v.model = 'other',
    v => v.usage = { prompt_tokens: 20, completion_tokens: 101, total_tokens: 121 }, v => delete v.usage,
    v => v.usage.completion_tokens_details = { reasoning_tokens: 1 }]) {
    const v = response(); change(v); await assert.rejects(api.createToolChatCompletionsTransport(config(), exchange(v))(request()), invalid);
  }
  await assert.rejects(api.createToolChatCompletionsTransport(config(), exchange(response()))(request(config(), history())), invalid);
});

test('argument byte bound is independent of outer response limit', async () => {
  const c = config(); c.settings.maxResponseBytes = 131072;
  for (const delta of [0, 1]) {
    const v = response(); v.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({ k: 'a'.repeat(65536 - 8 + delta) });
    assert.equal(Buffer.byteLength(v.choices[0].message.tool_calls[0].function.arguments), 65536 + delta);
    const promise = api.createToolChatCompletionsTransport(c, exchange(v))(request(c));
    if (delta) await assert.rejects(promise, invalid); else assert.equal((await promise).costMicroUsd, 40);
  }
});

test('tool collector shares bounded streaming, abort-before-close and input snapshots', { timeout: 5000 }, async () => {
  for (const mode of ['size', 'count']) {
    let closeAborted = false;
    const send = api.createToolChatCompletionsTransport(config(), async r => ({ status: 200, chunks: (async function* () {
      try { if (mode === 'size') yield Buffer.alloc(8193); else { for (let i = 0; i < 8193; i++) yield Buffer.alloc(0); yield Buffer.from(JSON.stringify(response())); } }
      finally { closeAborted = r.signal.aborted; }
    })() }));
    await assert.rejects(send(request()), invalid); assert.equal(closeAborted, true);
  }
  const c = config(), r = request(c), original = Buffer.from(r.body), bytes = Buffer.from(JSON.stringify(response()));
  const send = api.createToolChatCompletionsTransport(c, async q => {
    r.body.fill(0); assert.deepEqual(q.body, original);
    return { status: 200, chunks: (async function* () { const first = Buffer.from(bytes.subarray(0, 10)); yield first; first.fill(0); yield bytes.subarray(10); })() };
  });
  c.tools[0].function.name = 'other'; assert.deepEqual((await send(r)).body, bytes);
});

test('real request ledger covers two synthetic tool rounds, immutable hashes, bad reply stops', async t => {
  for (const bad of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-tool-protocol-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const c = config(), p = api.toolChatCompletionsSettings(c), policy = { approvalId: 'synthetic', planHash: hash('plan'), runId: hash('run'),
      provider: c.settings.provider, model: c.settings.model, settingsHash: p.settingsHash, expiresAt: Date.now() + 60000,
      maxRequests: 2, maxRequestBytes: 8192, maxResponseBytes: 8192, timeoutMs: 1000, perRequestReserveMicroUsd: 1200, runLimitMicroUsd: 2400 };
    let calls = 0;
    for (const patch of [{ settingsHash: api.chatCompletionsSettings(c.settings).settingsHash }, { perRequestReserveMicroUsd: 1199 }, { maxRequestBytes: 8191 }]) {
      await assert.rejects(api.dispatchToolChatCompletions(root, { ...policy, ...patch }, c, () => {}, exchange(response())), invalid);
      assert.deepEqual(fs.readdirSync(root), []);
    }
    const report = await api.dispatchToolChatCompletions(root, policy, c, async send => {
      const first = JSON.parse(await send(api.encodeToolChatCompletionsRequest(c, messages())));
      const next = [...messages(), first.choices[0].message, { role: 'tool', tool_call_id: 'call-1', content: 'synthetic result' }];
      if (bad) { await assert.rejects(send(api.encodeToolChatCompletionsRequest(c, next))); await assert.rejects(send(api.encodeToolChatCompletionsRequest(c, next))); }
      else await send(api.encodeToolChatCompletionsRequest(c, next));
    }, async () => {
      calls++; const saved = readModelEgress(root, policy.runId); assert.equal(saved.requests.at(-1).status, 'reserved');
      assert.equal(saved.committedMicroUsd, calls * 1200);
      const v = response(calls === 1); if (bad && calls === 2) delete v.usage; return exchange(v)();
    });
    assert.equal(calls, 2); assert.equal(report.reason, bad ? 'transport_failed' : 'completed');
    assert.equal(report.requests[1].failureStage, bad ? 'protocol_response_envelope' : undefined);
    assert.equal(Object.hasOwn(report.requests[0], 'failureStage'), false);
    assert.equal(report.knownCostMicroUsd, bad ? 40 : 80); assert.equal(report.unknownCostRequests, bad ? 1 : 0);
    assert.equal(report.committedMicroUsd, 2400); assert.deepEqual(readModelEgress(root, policy.runId), report);
    const dir = path.join(root, 'model-egress', policy.runId), text = fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
    assert.ok(!text.includes('synthetic result')); assert.ok(!text.includes('synthetic.txt'));
  }
});
