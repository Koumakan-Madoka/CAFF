const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startSdkModelGateway, sdkGatewayModelRouting } = require('../../scripts/badcase-capture/sdk-model-gateway.cjs');
const protocol = require('../../build/server/domain/runtime/badcase-capture/chat-completions-protocol');
const { dispatchToolChatCompletions } = protocol;
const { readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress');
const { modelBinding, recordBoundModelApproval, dispatchBoundModelEvaluation } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const profile = () => ({ settings: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextWindowTokens: 10000,
  maxOutputTokens: 100, temperature: 0, inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000,
  maxRequestBytes: 16384, maxResponseBytes: 16384, compatibilityProfile: 'opencode-go-deepseek-nonthinking-cached-index0-v1' },
  tools: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }] });
const call = () => ({ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{ "path": "hello.txt" }' } });
const reply = (tool = false) => ({ id: 'chatcmpl-synthetic', object: 'chat.completion', created: 1, model: profile().settings.model,
  choices: [{ index: 0, message: { role: 'assistant', content: tool ? null : '合成回复\nnot a real model', reasoning_content: '',
    ...(tool ? { tool_calls: [{ ...call(), index: 0 }] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_tokens_details: { cached_tokens: 7 } } });
// Representative pi 0.85.1 openai-completions wire shape. No SDK executes on host.
const request = () => ({ model: profile().settings.model, stream: true, stream_options: { include_usage: true },
  max_completion_tokens: 100, thinking: { type: 'disabled' },
  tools: profile().tools.map(t => ({ ...t, function: { ...t.function, strict: false } })),
  messages: [{ role: 'system', content: 'synthetic role' }, { role: 'user', content: [{ type: 'text', text: '零\n' }, { type: 'text', text: '001' }] }] });
function send(g, body = request(), patch = {}) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(g.baseUrl + (patch.route || '/chat/completions'), { method: patch.method || 'POST',
      headers: { authorization: 'Bearer ' + g.apiKey, 'content-type': 'application/json', 'content-length': bytes.length, ...patch.headers } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(bytes);
  });
}
function events(r) {
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /^text\/event-stream/);
  const rows = r.text.trim().split('\n\n').map(s => { assert.ok(s.startsWith('data: ')); return s.slice(6); });
  assert.equal(rows.pop(), '[DONE]'); return rows.map(JSON.parse);
}
async function fixture(t, sender, opts = {}) {
  const p = profile();
  const g = await startSdkModelGateway({ profile: p, maxRequests: 2, expiresAt: Date.now() + 10000, ...opts }, sender);
  t.after(() => g.stop()); return g;
}
test('buffered SDK HTTP gateway preserves text, definitions, serial tool history and usage, without exposing supplier auth', async t => {
  let n = 0; const captured = [];
  const g = await fixture(t, async body => { captured.push(JSON.parse(body)); return Buffer.from(JSON.stringify(reply(++n === 1))); });
  assert.match(g.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(g.declaration.kind, 'buffered-sdk-chat-bridge-v1'); assert.equal(g.declaration.upstreamStreaming, false);
  assert.equal(g.declaration.settingsHash, protocol.toolChatCompletionsSettings(profile()).settingsHash);
  const a = events(await send(g));
  assert.equal(a[0].choices[0].delta.role, 'assistant');
  assert.deepEqual(a[1].choices[0].delta.tool_calls, [{ ...call(), index: 0 }]);
  assert.equal(a[2].choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(a[3].usage, reply().usage); assert.deepEqual(a[3].choices, []);
  const q = request(); q.messages.push({ role: 'assistant', content: null, reasoning_content: '', tool_calls: [call()] },
    { role: 'tool', tool_call_id: 'call-1', content: 'tool result' });
  const b = events(await send(g, q)); assert.equal(b[1].choices[0].delta.content, reply().choices[0].message.content);
  for (const raw of captured) {
    assert.equal(raw.stream, false); assert.equal(raw.store, false); assert.equal(raw.n, 1); assert.equal(raw.temperature, 0);
    assert.equal(raw.parallel_tool_calls, false); assert.equal(raw.tool_choice, 'auto');
    assert.deepEqual(raw.thinking, { type: 'disabled' }); assert.equal(raw.messages[1].content, '零\n001');
    assert.deepEqual(raw.tools, protocol.toolChatCompletionsSettings(profile()).tools);
  }
  assert.deepEqual(captured[1].messages.slice(-2), [{ role: 'assistant', content: null, tool_calls: [call()] },
    { role: 'tool', tool_call_id: 'call-1', content: 'tool result' }]);
  assert.equal(g.status().requests, 2); assert.equal(g.status().failed, false);
  assert.ok(!JSON.stringify(g.declaration).includes(g.apiKey));
  const capped = await send(g); assert.equal(capped.status, 503); assert.equal(n, 2);
  await g.stop(); await assert.rejects(send(g));
});

test('native SDK routing keeps model identity and declared costs, with a local-only environment identity instead of supplier auth', async t => {
  const g = await fixture(t, async () => Buffer.from(JSON.stringify(reply())));
  const p = profile(), routing = sdkGatewayModelRouting(p, g), provider = routing.models.providers[p.settings.provider];
  assert.equal(provider.api, 'openai-completions'); assert.equal(provider.baseUrl, g.baseUrl);
  assert.equal(provider.apiKey, '$CAFF_SDK_MODEL_GATEWAY_KEY');
  assert.equal(routing.environment.CAFF_SDK_MODEL_GATEWAY_KEY, g.apiKey);
  assert.ok(!JSON.stringify(routing.models).includes(g.apiKey));
  const model = provider.models[0]; assert.equal(model.id, p.settings.model); assert.deepEqual(model.input, ['text']);
  assert.equal(model.contextWindow, p.settings.contextWindowTokens); assert.equal(model.maxTokens, p.settings.maxOutputTokens);
  assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 1, cacheWrite: 0 });
  assert.equal(model.reasoning, true); assert.equal(provider.compat.thinkingFormat, 'deepseek');
  assert.equal(provider.compat.supportsDeveloperRole, false); assert.equal(provider.compat.supportsStrictMode, false);
  assert.equal(provider.compat.maxTokensField, 'max_completion_tokens');
  assert.deepEqual(model.samplingParams, { temperature: 0, n: 1, store: false, parallel_tool_calls: false, tool_choice: 'auto' });
  const changed = profile(); changed.tools[0].function.description += ' changed';
  assert.throws(() => sdkGatewayModelRouting(changed, g));
  for (const patch of [{ baseUrl: 'https://production.example/v1' }, { baseUrl: g.baseUrl + '/other' }, { apiKey: 'bad identity' }]) {
    assert.throws(() => sdkGatewayModelRouting(p, { ...g, ...patch }));
  }
  const plain = profile(); delete plain.settings.compatibilityProfile;
  assert.throws(() => sdkGatewayModelRouting(plain, g));
});

test('unknown settings, changed tool definitions, nonempty reasoning and unsupported content fail before any send; no retry', async t => {
  for (const change of [q => q.stream = false, q => q.model = 'other', q => q.temperature = 1, q => q.max_completion_tokens = 99,
    q => q.store = true, q => q.n = 2, q => q.parallel_tool_calls = true, q => q.seed = 0,
    q => q.tool_choice = 'required', q => q.stream_options.extra = true, q => q.thinking.type = 'enabled',
    q => delete q.thinking, q => q.tools[0].function.strict = true, q => q.tools[0].function.description += ' changed',
    q => q.tools[0].function.parameters.properties.path.type = 'number', q => q.messages[1].content[0].extra = 'no',
    q => q.messages[1].content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }),
    q => q.messages[0].role = 'developer', q => q.messages[0].reasoning_content = 'PRIVATE-REASONING',
    q => q.messages[1].content = 'sk-' + 'a'.repeat(32), q => q.messages.push({ role: 'tool', tool_call_id: 'orphan', content: 'x' }),
    q => q.messages.push({ role: 'assistant', content: 'x', reasoning_content: ' ' })]) {
    let calls = 0; const g = await fixture(t, async () => { calls++; return Buffer.from(JSON.stringify(reply())); });
    const q = request(); change(q); const r = await send(g, q);
    assert.equal(r.status, 400); assert.ok(!r.text.includes('PRIVATE')); assert.equal(calls, 0);
    assert.equal((await send(g)).status, 503); assert.equal(calls, 0); await g.stop();
  }
});

test('local identity/route/origin checks, body caps and snapshot ownership do not expand the send surface', async t => {
  let calls = 0; const p = profile(); const g = await startSdkModelGateway({ profile: p, maxRequests: 2, expiresAt: Date.now() + 10000 },
    async () => { calls++; return Buffer.from(JSON.stringify(reply())); }); t.after(() => g.stop());
  p.settings.model = 'changed'; p.tools[0].function.description = 'changed';
  for (const patch of [{ headers: { authorization: 'Bearer wrong' } }, { headers: { origin: 'http://example.test' } },
    { headers: { host: 'production.example' } }, { route: '/chat/completions?other=1' }, { route: '/models' }, { method: 'PUT' },
    { headers: { 'content-type': 'text/plain' } }]) {
    assert.ok((await send(g, request(), patch)).status >= 400); assert.equal(calls, 0);
  }
  const q = request(); Object.assign(q, { temperature: 0, store: false, n: 1, parallel_tool_calls: false, tool_choice: 'auto' });
  assert.equal((await send(g, q)).status, 200); assert.equal(calls, 1);
  assert.equal((await send(g, Buffer.from('x'.repeat(16385)))).status, 400); assert.equal(calls, 1);
});

test('invalid provider response or sender failure returns no model text and leaves gateway stopped', async t => {
  for (const make of [() => { throw Error('PRIVATE-EXCEPTION'); }, () => Buffer.from('PRIVATE-NOT-JSON'),
    () => { const r = reply(); r.choices[0].message.reasoning_content = 'PRIVATE-REASONING'; return Buffer.from(JSON.stringify(r)); },
    () => { const r = reply(); delete r.usage; return Buffer.from(JSON.stringify(r)); }]) {
    let calls = 0; const g = await fixture(t, async () => { calls++; return make(); });
    const r = await send(g); assert.equal(r.status, 502); assert.ok(!r.text.includes('PRIVATE')); assert.ok(!r.text.includes('合成回复'));
    assert.equal(g.status().failed, true); assert.equal((await send(g)).status, 503); assert.equal(calls, 1); await g.stop();
  }
});

test('concurrent request is refused; stop joins the active sender and never emits a late success', async t => {
  let resolve, called; const entered = new Promise(r => called = r);
  const g = await fixture(t, () => { called(); return new Promise(r => resolve = r); });
  const active = send(g).catch(() => null); await entered;
  assert.equal((await send(g)).status, 409); assert.equal(g.status().requests, 1);
  let stopped = false; const closing = g.stop().then(() => stopped = true);
  await new Promise(r => setImmediate(r)); assert.equal(stopped, false);
  resolve(Buffer.from(JSON.stringify(reply()))); await closing; assert.equal(stopped, true);
  const r = await active; assert.ok(r === null || r.status !== 200);
  await assert.rejects(send(g));
});

test('expiry stops the listener and late upstream result; invalid startup opens no listener', async t => {
  for (const patch of [{ maxRequests: 0 }, { maxRequests: 1001 }, { expiresAt: Date.now() - 1 }, { extra: true }]) {
    await assert.rejects(startSdkModelGateway({ profile: profile(), maxRequests: 2, expiresAt: Date.now() + 10000, ...patch }, async () => Buffer.from('{}')));
  }
  let resolve, called; const entered = new Promise(r => called = r);
  const g = await fixture(t, () => { called(); return new Promise(r => resolve = r); }, { expiresAt: Date.now() + 500 });
  const active = send(g).catch(() => null); await entered;
  await new Promise(r => setTimeout(r, 550)); assert.equal(g.status().stopped, true);
  resolve(Buffer.from(JSON.stringify(reply()))); await g.stop();
  const r = await active; assert.ok(r === null || r.status !== 200); await assert.rejects(send(g));
});

test('real request ledger reserves before upstream and records validated bytes before HTTP SSE release', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-sdk-gateway-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = profile(), binding = protocol.toolChatCompletionsSettings(p), runId = hash('sdk-http-synthetic-run');
  let g, calls = 0;
  const policy = { approvalId: 'synthetic', planHash: hash('plan'), runId, provider: p.settings.provider, model: p.settings.model,
    settingsHash: binding.settingsHash, expiresAt: Date.now() + 10000, maxRequests: 2, maxRequestBytes: p.settings.maxRequestBytes,
    maxResponseBytes: p.settings.maxResponseBytes, timeoutMs: 5000, perRequestReserveMicroUsd: binding.perRequestReserveMicroUsd,
    runLimitMicroUsd: 2 * binding.perRequestReserveMicroUsd };
  const report = await dispatchToolChatCompletions(root, policy, p, async authorizedSend => {
    g = await startSdkModelGateway({ profile: p, maxRequests: 2, expiresAt: policy.expiresAt }, authorizedSend);
    try {
      for (let i = 0; i < 2; i++) {
        events(await send(g)); const row = readModelEgress(root, runId).requests[i];
        assert.equal(row.status, 'completed'); assert.equal(row.responseHash, hash(JSON.stringify(reply()))); assert.equal(row.costMicroUsd, 40);
      }
    } finally { await g.stop(); }
  }, async ({ body }) => {
    const row = readModelEgress(root, runId).requests.at(-1); assert.equal(row.status, 'reserved');
    assert.equal(row.requestHash, hash(body)); calls++;
    return { status: 200, chunks: (async function* () { yield Buffer.from(JSON.stringify(reply())); })() };
  });
  assert.equal(calls, 2); assert.equal(report.reason, 'completed'); assert.equal(report.knownCostMicroUsd, 80);
  assert.equal(report.unknownCostRequests, 0); assert.equal(report.paidAuthorization, false);
  const disk = fs.readdirSync(path.join(root, 'model-egress', runId)).map(f => fs.readFileSync(path.join(root, 'model-egress', runId, f), 'utf8')).join('');
  assert.ok(!disk.includes(g.apiKey)); assert.ok(!disk.includes('合成回复'));
});

test('gateway composes with the original immutable approval and both ledgers; upstream failure stops the plan without retry', async t => {
  const original = https.request; t.after(() => { https.request = original; });
  let upstreamCalls = 0, bad = false, currentRoot, currentRun;
  https.request = options => {
    const req = new EventEmitter(), socket = new EventEmitter(), res = new PassThrough();
    Object.assign(socket, { encrypted: true, authorized: true, remoteAddress: options.hostname });
    Object.assign(res, { headers: { 'content-type': 'application/json' }, statusCode: 200, complete: true });
    req.destroy = () => res.destroy();
    req.end = body => {
      upstreamCalls++;
      assert.equal(readModelEgress(currentRoot, currentRun.runId).requests.at(-1).status, 'reserved');
      assert.equal(JSON.parse(body).stream, false); assert.equal(options.headers.Authorization, 'Bearer synthetic-supplier-lease');
      queueMicrotask(() => { req.emit('response', res); res.end(bad ? 'PRIVATE-BAD-JSON' : JSON.stringify(reply())); });
    };
    queueMicrotask(() => { req.emit('socket', socket); socket.emit('secureConnect'); }); return req;
  };
  for (bad of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-sdk-approved-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); currentRoot = root;
    const p = profile(), config = { ...p, maxRequests: 2, endpoint: { hostname: 'opencode.ai', address: '93.184.216.34',
      path: '/zen/go/v1/chat/completions', clientProfile: 'opencode-go-v1', maxRequestBytes: p.settings.maxRequestBytes,
      maxResponseBytes: p.settings.maxResponseBytes, timeoutMs: 2000 } }, binding = modelBinding(config);
    const plan = planEvaluation({ caseId: 'synthetic-gateway', checkpointHash: hash('synthetic-checkpoint'), inputHash: hash('synthetic-input'),
      environmentHash: hash('synthetic-env'), harnessHash: hash('synthetic-harness'), roleId: 'synthetic-role',
      baselineRoleHash: hash('base'), candidateRoleHash: hash('candidate'),
      model: { provider: p.settings.provider, id: p.settings.model, settingsHash: binding.bindingHash },
      evaluator: { id: 'synthetic-not-real-score', versionHash: hash('synthetic-scorer') }, repetitions: 1,
      timeoutMs: 5000, perRunLimitMicroUsd: 2 * binding.perRequestReserveMicroUsd, totalLimitMicroUsd: 4 * binding.perRequestReserveMicroUsd });
    const approval = { confirmed: true, approvalId: 'synthetic-gateway-approval', planHash: plan.planHash, expiresAt: Date.now() + 60000 };
    recordBoundModelApproval(root, plan.spec, config, approval);
    const before = upstreamCalls, identities = [];
    const report = await dispatchBoundModelEvaluation(root, approval.approvalId, async (run, authorizedSend) => {
      currentRun = run;
      const g = await startSdkModelGateway({ profile: p, maxRequests: config.maxRequests, expiresAt: run.expiresAt }, authorizedSend);
      identities.push(g.apiKey);
      try {
        const r = await send(g);
        if (bad) { assert.equal(r.status, 502); assert.ok(!r.text.includes('PRIVATE')); throw Error('synthetic_failed'); }
        events(r);
        const ledger = readModelEgress(root, run.runId); assert.equal(ledger.requests[0].status, 'completed');
        return { runId: run.runId, status: 'completed', costMicroUsd: ledger.knownCostMicroUsd,
          outputHash: hash('synthetic-not-agent-output'), score: { expectationMet: false, badcaseReproduced: false } };
      } finally { await g.stop(); }
    }, () => ({ value: 'synthetic-supplier-lease', expiresAt: Date.now() + 10000 }));
    assert.equal(upstreamCalls - before, bad ? 1 : 2); assert.equal(report.ledger.runs.length, bad ? 1 : 2);
    assert.equal(report.dispatchState, bad ? 'unresolved' : 'finished');
    if (bad) {
      const ledger = readModelEgress(root, report.ledger.runs[0].runId);
      assert.equal(ledger.requests[0].status, 'transport_failed'); assert.equal(ledger.requests[0].failureStage, 'protocol_decode');
      assert.equal(ledger.unknownCostRequests, 1); assert.equal(ledger.committedMicroUsd, binding.perRequestReserveMicroUsd);
    } else {
      assert.equal(report.ledger.knownCostMicroUsd, 80); assert.equal(new Set(identities).size, 2);
    }
    await assert.rejects(dispatchBoundModelEvaluation(root, approval.approvalId, async () => { throw Error(); }, () => { throw Error(); }));
    assert.equal(upstreamCalls - before, bad ? 1 : 2);
  }
});
