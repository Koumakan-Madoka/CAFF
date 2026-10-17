const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('../../build/server/domain/runtime/badcase-capture/chat-completions-protocol.js');
const { readModelEgress, modelFailureStage } = require('../../build/server/domain/runtime/badcase-capture/model-egress.js');
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

test('tools-v1 uses the same fixed envelope checks before releasing any tool call', async () => {
  for (const [check, change] of [
    ['keys', v => v['PRIVATE-UNKNOWN-FIELD'] = 'PRIVATE-EXTRA'],
    ['id', v => v.id = 'PRIVATE-ID/'], ['object', v => v.object = 'PRIVATE-OBJECT'],
    ['created', v => v.created = 'PRIVATE-CREATED'], ['model', v => v.model = 'PRIVATE-MODEL'],
    ['fingerprint', v => v.system_fingerprint = 'PRIVATE-FINGERPRINT/'],
    ['service_tier', v => v.service_tier = 'PRIVATE-TIER'], ['choices', v => v.choices = []],
  ]) {
    const v = response(); change(v);
    await assert.rejects(api.createToolChatCompletionsTransport(config(), exchange(v))(request()), e => {
      assert.equal(modelFailureStage(e), 'protocol_response_envelope_' + check);
      assert.deepEqual(Object.keys(e), ['code']); assert.equal(e.cause, undefined);
      return invalid(e);
    });
  }
});

test('tools-v1 uses fixed choice checks without accepting reasoning extensions or truncation', async () => {
  for (const [check, change] of [
    ['keys', v => v.choices[0] = null], ['index', v => v.choices[0].index = 1],
    ['finish', v => v.choices[0].finish_reason = 'PRIVATE-FINISH'], ['truncated', v => v.choices[0].finish_reason = 'length'],
    ['logprobs', v => v.choices[0].logprobs = {}], ['message_keys', v => v.choices[0].message['PRIVATE-EXTRA'] = 'PRIVATE-VALUE'],
    ['message_reasoning', v => v.choices[0].message.reasoning_content = 'PRIVATE-REASONING'],
    ['role', v => v.choices[0].message.role = 'PRIVATE-ROLE'], ['content', v => v.choices[0].message.content = []],
    ['refusal', v => v.choices[0].message.refusal = 'PRIVATE-REFUSAL'], ['annotations', v => v.choices[0].message.annotations = [{}]],
  ]) {
    const v = response(); change(v);
    await assert.rejects(api.createToolChatCompletionsTransport(config(), exchange(v))(request()), e => {
      assert.equal(modelFailureStage(e), 'protocol_response_choice_' + check);
      assert.deepEqual(Object.keys(e), ['code']); assert.equal(e.cause, undefined); return invalid(e);
    });
  }
  // Both previously valid null-content tool calls and plain final responses stay valid.
  assert.equal((await api.createToolChatCompletionsTransport(config(), exchange(response()))(request())).costMicroUsd, 40);
  assert.equal((await api.createToolChatCompletionsTransport(config(), exchange(response(false)))(request(config(), history()))).costMicroUsd, 40);
});

test('explicit nonthinking tools preserve call history without silently dropping reasoning', async () => {
  const c = config(); Object.assign(c.settings, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', compatibilityProfile: 'opencode-go-deepseek-nonthinking-v1' });
  const body = api.encodeToolChatCompletionsRequest(c, history()); assert.deepEqual(JSON.parse(body).thinking, { type: 'disabled' });
  const v = response(); v.model = c.settings.model; v.choices[0].message.reasoning_content = null;
  assert.equal((await api.createToolChatCompletionsTransport(c, exchange(v))(request(c))).costMicroUsd, 40);
  v.choices[0].message.reasoning_content = 'PRIVATE-REASONING';
  await assert.rejects(api.createToolChatCompletionsTransport(c, exchange(v))(request(c)), e => modelFailureStage(e) === 'protocol_response_choice_reasoning_invalid');
  let calls = 0;
  const send = api.createToolChatCompletionsTransport(c, async () => { calls++; return exchange()(); });
  const r = request(c), changed = JSON.parse(r.body); changed.thinking.type = 'enabled'; r.body = Buffer.from(JSON.stringify(changed));
  await assert.rejects(send(r), invalid); assert.equal(calls, 0);
  const inherited = history(); inherited[2].reasoning_content = 'PRIVATE-HISTORY';
  assert.throws(() => api.encodeToolChatCompletionsRequest(c, inherited), invalid);
});

test('tools-v1 uses the same usage detail rejection labels before returning a tool call', async () => {
  for (const [check, change] of [
    ['prompt_details', v => v.usage.prompt_tokens_details = { cached_tokens: 21 }],
    ['cached_tokens', v => v.usage.prompt_tokens_details = { cached_tokens: 1 }],
    ['completion_details', v => v.usage.completion_tokens_details = { audio_tokens: 1 }],
    ['reasoning_tokens', v => v.usage.completion_tokens_details = { reasoning_tokens: 1 }],
  ]) {
    const v = response(); change(v);
    await assert.rejects(api.createToolChatCompletionsTransport(config(), exchange(v))(request()), e => {
      assert.equal(modelFailureStage(e), 'protocol_response_usage_' + check); return invalid(e);
    });
  }
});

test('explicit cached nonthinking tools retain full prompt accounting and validated call bytes', async () => {
  const c = config(); Object.assign(c.settings, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', compatibilityProfile: 'opencode-go-deepseek-nonthinking-cached-v1' });
  const v = response(); v.model = c.settings.model; v.choices[0].message.reasoning_content = '';
  v.usage.prompt_tokens_details = { cached_tokens: 7 };
  const result = await api.createToolChatCompletionsTransport(c, exchange(v))(request(c)); assert.equal(result.costMicroUsd, 40);
  assert.deepEqual(JSON.parse(result.body).choices[0].message.tool_calls, v.choices[0].message.tool_calls);
  assert.deepEqual(JSON.parse(api.encodeToolChatCompletionsRequest(c, history())).thinking, { type: 'disabled' });
  v.usage.completion_tokens_details = { reasoning_tokens: 1 };
  await assert.rejects(api.createToolChatCompletionsTransport(c, exchange(v))(request(c)), e => modelFailureStage(e) === 'protocol_response_usage_reasoning_tokens');
});

const indexProfile = 'opencode-go-deepseek-nonthinking-cached-index0-v1';
function indexedConfig() {
  const c = config(); Object.assign(c.settings, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', compatibilityProfile: indexProfile }); return c;
}
test('index0 compatibility preserves response bytes and accepts only optional zero on one complete response call', async () => {
  const c = indexedConfig(), v = response(); v.model = c.settings.model;
  for (const patch of [{ provider: 'other' }, { model: 'other' }, { compatibilityProfile: 'unknown' }]) {
    assert.throws(() => api.toolChatCompletionsSettings({ ...c, settings: { ...c.settings, ...patch } }), invalid);
  }
  v.choices[0].message.reasoning_content = ''; v.usage.prompt_tokens_details = { cached_tokens: 7 };
  for (const indexed of [false, true]) {
    const t = v.choices[0].message.tool_calls[0]; if (indexed) t.index = 0;
    const result = await api.createToolChatCompletionsTransport(c, exchange(v))(request(c));
    assert.deepEqual(result.body, Buffer.from(JSON.stringify(v))); assert.equal(result.costMicroUsd, 40);
    assert.equal(t.function.arguments, '{ "path": "synthetic.txt" }');
  }
  for (const compatibilityProfile of [undefined, 'opencode-go-deepseek-nonthinking-v1', 'opencode-go-deepseek-nonthinking-cached-v1']) {
    const old = structuredClone(c); if (compatibilityProfile) old.settings.compatibilityProfile = compatibilityProfile; else delete old.settings.compatibilityProfile;
    delete v.choices[0].message.reasoning_content;
    await assert.rejects(api.createToolChatCompletionsTransport(old, exchange(v))(request(old)), e => modelFailureStage(e) === 'protocol_response_tool_keys_index');
  }
});
test('index0 compatibility refuses malformed values, missing/unknown fields and never accepts index in request history', async () => {
  const c = indexedConfig(); let calls = 0;
  for (const index of [null, 1, -1, 0.5, '0', false, {}, [], Number.MAX_SAFE_INTEGER]) {
    const v = response(); v.model = c.settings.model; v.choices[0].message.tool_calls[0].index = index;
    await assert.rejects(api.createToolChatCompletionsTransport(c, exchange(v))(request(c)), e => modelFailureStage(e) === 'protocol_response_tool_keys_index');
  }
  for (const [check, change] of toolFailureCases()) {
    if (['keys_index', 'reused'].includes(check)) continue;
    const v = response(); v.model = c.settings.model; v.choices[0].message.tool_calls[0].index = 0;
    change(v, v.choices[0].message.tool_calls[0]);
    await assert.rejects(api.createToolChatCompletionsTransport(c, exchange(v))(request(c)), invalid);
  }
  const h = history(); h[2].tool_calls[0].index = 0;
  assert.throws(() => api.encodeToolChatCompletionsRequest(c, h), invalid);
  const r = request(c), b = JSON.parse(r.body); b.messages = h; r.body = Buffer.from(JSON.stringify(b));
  await assert.rejects(api.createToolChatCompletionsTransport(c, async () => { calls++; return exchange(response())(); })(r), e => modelFailureStage(e) === 'protocol_request');
  assert.equal(calls, 0);
  const reused = response(); reused.model = c.settings.model; reused.choices[0].message.tool_calls[0].index = 0;
  await assert.rejects(api.createToolChatCompletionsTransport(c, exchange(reused))(request(c, history())), e => modelFailureStage(e) === 'protocol_response_tool_reused');
  for (const [stage, change] of [
    ['choice_reasoning_invalid', v => v.choices[0].message.reasoning_content = 'PRIVATE-REASONING'],
    ['choice_truncated', v => v.choices[0].finish_reason = 'length'],
    ['usage_prompt_details', v => v.usage.prompt_tokens_details = { cached_tokens: 21 }],
    ['usage_completion_details', v => v.usage.completion_tokens_details = { audio_tokens: 1 }],
    ['usage_reasoning_tokens', v => v.usage.completion_tokens_details = { reasoning_tokens: 1 }],
    ['usage', v => v.usage.total_tokens++],
  ]) {
    const v = response(); v.model = c.settings.model; v.choices[0].message.tool_calls[0].index = 0; change(v);
    await assert.rejects(api.createToolChatCompletionsTransport(c, exchange(v))(request(c)), e => modelFailureStage(e) === 'protocol_response_' + stage);
  }
  for (const thinking of [undefined, { type: 'enabled' }, { type: 'disabled', extra: true }]) {
    const r = request(c), b = JSON.parse(r.body); if (thinking) b.thinking = thinking; else delete b.thinking;
    r.body = Buffer.from(JSON.stringify(b));
    await assert.rejects(api.createToolChatCompletionsTransport(c, async () => { calls++; return exchange(response())(); })(r), e => modelFailureStage(e) === 'protocol_request');
  }
  assert.equal(calls, 0);
  // Invalid index must fail before an invalid id, not hide a malformed index.
  const v = response(); v.model = c.settings.model; Object.assign(v.choices[0].message.tool_calls[0], { index: 1, id: 'PRIVATE/' });
  await assert.rejects(api.createToolChatCompletionsTransport(c, exchange(v))(request(c)), e => modelFailureStage(e) === 'protocol_response_tool_keys_index');
});

const toolFailureCases = () => [
  ['calls', v => v.choices[0].message.tool_calls = null],
  ['calls', v => v.choices[0].message.tool_calls = []],
  ['calls', v => v.choices[0].message.tool_calls.push(call('call-2'))],
  ['keys_extra', (v, c) => c['PRIVATE-EXTRA'] = 'PRIVATE-VALUE'],
  ...[null, [], 'PRIVATE-SHAPE', 1, true].map(shape => ['keys_shape', v => v.choices[0].message.tool_calls[0] = shape]),
  ...Array.from({ length: 7 }, (_, i) => ['keys_missing', (v, c) => {
    ['id', 'type', 'function'].forEach((key, bit) => { if ((i + 1) & (1 << bit)) delete c[key]; });
  }]),
  ...Array.from({ length: 7 }, (_, i) => ['keys_mixed', (v, c) => {
    ['id', 'type', 'function'].forEach((key, bit) => { if ((i + 1) & (1 << bit)) delete c[key]; });
    c['PRIVATE-EXTRA'] = 'PRIVATE-VALUE';
  }]),
  ['keys_mixed', (v, c) => { delete c.type; c.index = 0; }],
  ...[null, 0, 1, -1, 'PRIVATE-INDEX', {}, []].map(index => ['keys_index', (v, c) => c.index = index]),
  ['keys_extra', (v, c) => { c.index = 0; c['PRIVATE-EXTRA'] = 'PRIVATE-VALUE'; }],
  ['id', (v, c) => c.id = 'PRIVATE-ID/'],
  ['reused', () => {}, true],
  ['type', (v, c) => c.type = 'PRIVATE-TYPE'],
  ['function_keys', (v, c) => c.function = null],
  ['function_keys', (v, c) => c.function.extra = 'PRIVATE-EXTRA'],
  ['name', (v, c) => c.function.name = 'PRIVATE-NAME'],
  ['arguments_text', (v, c) => c.function.arguments = []],
  ['arguments_text', (v, c) => c.function.arguments = 'PRIVATE-ARG\u0000'],
  ['arguments_size', (v, c) => c.function.arguments = ' '.repeat(65537)],
  ['arguments_json', (v, c) => c.function.arguments = '{PRIVATE-ARG'],
  ['arguments_object', (v, c) => c.function.arguments = '[]'],
  ['arguments_object', (v, c) => c.function.arguments = 'null'],
  ['arguments_structure', (v, c) => c.function.arguments = '{"$ref":"PRIVATE-REF"}'],
  ['arguments_structure', (v, c) => c.function.arguments = JSON.stringify({ k: Array(2050).fill(0) })],
  ['arguments_structure', (v, c) => c.function.arguments = '{"k":'.repeat(18) + '{}' + '}'.repeat(18)],
];

test('tool response failures have fixed labels, durable closed records and unchanged stop/unknown-cost semantics', async t => {
  for (const [check, change, reused] of toolFailureCases()) await t.test(check, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-tool-label-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const c = config(); c.settings.maxResponseBytes = 131072;
    const v = response(); change(v, v.choices[0].message.tool_calls[0]);
    const stage = 'protocol_response_tool_' + check, h = reused ? history() : messages();
    await assert.rejects(api.createToolChatCompletionsTransport(c, exchange(v))(request(c, h)), e => {
      assert.equal(modelFailureStage(e), stage); assert.deepEqual(Object.keys(e), ['code']); assert.equal(e.cause, undefined); return invalid(e);
    });
    const p = api.toolChatCompletionsSettings(c), runId = hash(stage);
    const policy = { approvalId: 'synthetic', planHash: hash('plan'), runId,
      provider: c.settings.provider, model: c.settings.model, settingsHash: p.settingsHash, expiresAt: Date.now() + 60000,
      maxRequests: 2, maxRequestBytes: 8192, maxResponseBytes: 131072, timeoutMs: 1000, perRequestReserveMicroUsd: 1200, runLimitMicroUsd: 2400 };
    let calls = 0;
    const report = await api.dispatchToolChatCompletions(root, policy, c, async send => {
      await assert.rejects(send(api.encodeToolChatCompletionsRequest(c, h)), /model_egress_transport_failed/);
      await assert.rejects(send(api.encodeToolChatCompletionsRequest(c, h)), /model_egress_stopped/);
    }, async () => { calls++; return exchange(v)(); });
    assert.equal(calls, 1); assert.equal(report.reason, 'transport_failed'); assert.equal(report.unknownCostRequests, 1);
    assert.equal(report.committedMicroUsd, 1200); assert.equal(report.knownCostMicroUsd, 0); assert.equal(report.requests[0].failureStage, stage);
    for (const key of ['costMicroUsd', 'responseHash', 'responseBytes']) assert.equal(report.requests[0][key], null);
    assert.deepEqual(readModelEgress(root, runId), report);
    const dir = path.join(root, 'model-egress', runId), file = path.join(dir, '0001.result.json'), original = fs.readFileSync(file, 'utf8');
    assert.ok(!fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('').includes('PRIVATE-'));
    for (const failureStage of [stage + '_PRIVATE', 'protocol_response_tool_PRIVATE']) {
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), failureStage }));
      assert.throws(() => readModelEgress(root, runId), /model_egress_record_invalid/);
    }
    // Historical coarse labels remain readable; never retroactively classify them.
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), failureStage: 'protocol_response' }));
    assert.equal(readModelEgress(root, runId).requests[0].failureStage, 'protocol_response');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), failureStage: 'protocol_response_tool_keys' }));
    assert.equal(readModelEgress(root, runId).requests[0].failureStage, 'protocol_response_tool_keys');
    fs.writeFileSync(file, original); assert.deepEqual(readModelEgress(root, runId), report);
  });
});

test('tool labels preserve first-failure order and do not label request history failures as responses', async () => {
  const changes = toolFailureCases();
  // Reachable adjacent double faults retain order. Invalid IDs cannot also be
  // reused: every ID admitted into request history already passed id().
  const pairs = [['keys_extra', 'id'], ['keys_index', 'id'], ['keys_missing', 'type'], ['keys_mixed', 'type'], ['reused', 'type'], ['type', 'function_keys'],
    ['function_keys', 'name'], ['name', 'arguments_text'], ['arguments_text', 'arguments_size'],
    ['arguments_size', 'arguments_json']];
  for (const [first, second] of pairs) {
    const choose = check => check === 'function_keys' ? changes.filter(x => x[0] === check).at(-1) : changes.find(x => x[0] === check);
    const v = response(), a = choose(first), b = choose(second);
    a[1](v, v.choices[0].message.tool_calls[0]); b[1](v, v.choices[0].message.tool_calls[0]);
    const h = a[2] || b[2] ? history() : messages();
    // Size and JSON must coexist: oversized malformed JSON, not an overwritten value.
    if (first === 'arguments_text') v.choices[0].message.tool_calls[0].function.arguments = '\u0000' + ' '.repeat(65536);
    if (first === 'arguments_size') v.choices[0].message.tool_calls[0].function.arguments = '{' + ' '.repeat(65536);
    const c = config(); c.settings.maxResponseBytes = 131072;
    await assert.rejects(api.createToolChatCompletionsTransport(c, exchange(v))(request(c, h)), e => {
      assert.equal(modelFailureStage(e), 'protocol_response_tool_' + first, first + ' before ' + second); return invalid(e);
    });
  }
  for (const [check, change, reused] of changes) {
    if (reused) continue;
    const v = response(); change(v, v.choices[0].message.tool_calls[0]);
    const h = [...messages(), v.choices[0].message, { role: 'tool', tool_call_id: 'call-1', content: 'result' }];
    assert.throws(() => api.encodeToolChatCompletionsRequest(config(), h), e => invalid(e) && modelFailureStage(e) === undefined);
  }
});

test('transport rejects malformed tool request history with protocol_request, never a response label or exchange', async () => {
  let calls = 0;
  for (const [check, change, reused] of toolFailureCases()) {
    if (reused) continue;
    const c = config(); c.settings.maxRequestBytes = 131072;
    const r = request(c), body = JSON.parse(r.body), v = response();
    change(v, v.choices[0].message.tool_calls[0]);
    body.messages = [...messages(), v.choices[0].message, { role: 'tool', tool_call_id: 'call-1', content: 'result' }];
    r.body = Buffer.from(JSON.stringify(body));
    await assert.rejects(api.createToolChatCompletionsTransport(c, async () => { calls++; return exchange(response())(); })(r), e => {
      assert.equal(modelFailureStage(e), 'protocol_request', check); return invalid(e);
    });
  }
  assert.equal(calls, 0);
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
    assert.equal(report.requests[1].failureStage, bad ? 'protocol_response_envelope_keys' : undefined);
    assert.equal(Object.hasOwn(report.requests[0], 'failureStage'), false);
    assert.equal(report.knownCostMicroUsd, bad ? 40 : 80); assert.equal(report.unknownCostRequests, bad ? 1 : 0);
    assert.equal(report.committedMicroUsd, 2400); assert.deepEqual(readModelEgress(root, policy.runId), report);
    const dir = path.join(root, 'model-egress', policy.runId), text = fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
    assert.ok(!text.includes('synthetic result')); assert.ok(!text.includes('synthetic.txt'));
  }
});
