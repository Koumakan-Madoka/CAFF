const test = require('node:test');
const assert = require('node:assert/strict');
const { sdkMessages, sdkTools, assistantMessage, modelStream } = require('../../scripts/badcase-capture/container-model-adapter.cjs');
const { relayDockerTransport } = require('../../scripts/badcase-capture/container-model-relay.cjs');
const profile = { settings: { provider: 'synthetic', model: 'fixture', temperature: 0, maxOutputTokens: 100, inputMicroUsdPerMillionTokens: 0, outputMicroUsdPerMillionTokens: 0, maxRequestBytes: 4096, maxResponseBytes: 4096 }, tools: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] };
test('SDK text and tool history is preserved; unsupported content is never silently dropped', () => {
  const context = { systemPrompt: 'role', messages: [
    { role: 'user', content: [{ type: 'text', text: 'input' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'one', name: 'read', arguments: { path: 'x' } }] },
    { role: 'toolResult', toolCallId: 'one', content: [{ type: 'text', text: 'result' }], isError: false },
  ] };
  assert.deepEqual(sdkMessages(context), [{ role: 'system', content: 'role' }, { role: 'user', content: 'input' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'one', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] },
    { role: 'tool', tool_call_id: 'one', content: 'result' }]);
  for (const content of [[{ type: 'image', data: 'abc' }], [{ type: 'thinking', thinking: 'hidden' }]]) {
    assert.throws(() => sdkMessages({ systemPrompt: 'role', messages: [{ role: 'user', content }] }));
  }
  assert.throws(() => sdkMessages({ systemPrompt: 'role', messages: [{ role: 'custom', content: 'not supported' }] }));
});
test('actual SDK tool definitions must match reviewed definitions', () => {
  const tools = [{ name: 'read', description: 'Read', parameters: profile.tools[0].function.parameters }];
  assert.deepEqual(sdkTools(tools, profile), profile.tools);
  assert.throws(() => sdkTools([{ ...tools[0], description: 'changed' }], profile));
  assert.throws(() => sdkTools([...tools, tools[0]], profile));
});
test('model response becomes toolUse and usage, not a locally scripted action', () => {
  const raw = { model: 'fixture', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'one', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  const m = assistantMessage(raw, profile);
  assert.equal(m.stopReason, 'toolUse'); assert.deepEqual(m.content, [{ type: 'toolCall', id: 'one', name: 'read', arguments: { path: 'x' } }]);
  assert.equal(m.usage.totalTokens, 12);
  assert.throws(() => assistantMessage({ ...raw, model: 'other' }, profile));
});
test('container adapter sends explicit nonthinking mode and refuses to erase nonempty reasoning', async () => {
  const p = structuredClone(profile); Object.assign(p.settings, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', compatibilityProfile: 'opencode-go-deepseek-nonthinking-v1' });
  const raw = { model: p.settings.model, choices: [{ finish_reason: 'stop', message: { content: 'answer', reasoning_content: null } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  const context = { systemPrompt: 'role', messages: [{ role: 'user', content: 'input' }], tools: p.tools.map(t => ({ ...t.function })) };
  let captured;
  const stream = modelStream(p, async body => { captured = JSON.parse(body); return Buffer.from(JSON.stringify(raw)); }, () => {});
  const selected = { provider: p.settings.provider, id: p.settings.model };
  assert.equal((await stream(selected, context).result()).content[0].text, 'answer');
  assert.deepEqual(captured.thinking, { type: 'disabled' }); assert.deepEqual(captured.messages, sdkMessages(context));
  for (const value of ['PRIVATE-REASONING', ' ', 0, false, [], {}]) {
    raw.choices[0].message.reasoning_content = value;
    await assert.rejects(stream(selected, context).result());
  }
  raw.choices[0].message.reasoning_content = '';
  assert.equal((await stream(selected, context).result()).content[0].text, 'answer');
  raw.model = profile.settings.model;
  assert.throws(() => assistantMessage(raw, profile));
  delete raw.choices[0].message.reasoning_content;
  assert.equal(assistantMessage(raw, profile).content[0].text, 'answer');
  for (const patch of [{ compatibilityProfile: 'unknown' }, { provider: 'other' }, { model: 'other' }]) {
    const bad = structuredClone(p); Object.assign(bad.settings, patch); let exchanges = 0;
    await assert.rejects(modelStream(bad, async () => { exchanges++; return Buffer.from(JSON.stringify(raw)); }, () => {})({ provider: bad.settings.provider, id: bad.settings.model }, context).result());
    assert.equal(exchanges, 0);
  }
});

test('cached adapter separates input/cacheRead without adding tokens or inventing a discount', async () => {
  const p = structuredClone(profile); Object.assign(p.settings, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', compatibilityProfile: 'opencode-go-deepseek-nonthinking-cached-v1', inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000 });
  const raw = { model: p.settings.model, choices: [{ finish_reason: 'stop', message: { content: 'answer', reasoning_content: null } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 7 } } };
  const context = { systemPrompt: 'role', messages: [{ role: 'user', content: 'input' }], tools: p.tools.map(t => ({ ...t.function })) };
  let captured;
  const message = await modelStream(p, async body => { captured = JSON.parse(body); return Buffer.from(JSON.stringify(raw)); }, () => {})({ provider: p.settings.provider, id: p.settings.model }, context).result();
  assert.deepEqual(captured.thinking, { type: 'disabled' }); assert.equal(message.usage.input, 3); assert.equal(message.usage.cacheRead, 7);
  assert.equal(message.usage.output, 2); assert.equal(message.usage.totalTokens, 12);
  assert.ok(Math.abs(message.usage.cost.total - 0.000014) < 1e-12);
  assert.ok(Math.abs(message.usage.cost.cacheRead - 0.000007) < 1e-12);
  for (const count of [0, 10]) {
    raw.usage.prompt_tokens_details = { cached_tokens: count, audio_tokens: 0 };
    const m = assistantMessage(raw, p); assert.equal(m.usage.input + m.usage.cacheRead, 10); assert.equal(m.usage.input, 10 - count);
    assert.ok(Math.abs(m.usage.cost.total - 0.000014) < 1e-12);
  }
  for (const details of [{ cached_tokens: -1 }, { cached_tokens: 11 }, { cached_tokens: 1.5 }, { cached_tokens: '7' }, { cached_tokens: null },
    { cached_tokens: 7, audio_tokens: 1 }, { cached_tokens: 7, extra: 0 }, [], null]) {
    raw.usage.prompt_tokens_details = details; assert.throws(() => assistantMessage(raw, p));
  }
  raw.usage.prompt_tokens_details = { cached_tokens: 7 }; delete raw.choices[0].message.reasoning_content;
  const strict = structuredClone(p); strict.settings.compatibilityProfile = 'opencode-go-deepseek-nonthinking-v1';
  assert.throws(() => assistantMessage(raw, strict)); delete strict.settings.compatibilityProfile;
  assert.throws(() => assistantMessage(raw, strict));
  delete raw.usage.prompt_tokens_details; assert.equal(assistantMessage(raw, p).usage.cacheRead, 0);
});

test('index0 adapter independently gates metadata and emits index-free SDK history with unchanged call identity', async () => {
  const p = structuredClone(profile); Object.assign(p.settings, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', compatibilityProfile: 'opencode-go-deepseek-nonthinking-cached-index0-v1' });
  const raw = { model: p.settings.model, choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: '', tool_calls: [
    { id: 'one', type: 'function', index: 0, function: { name: 'read', arguments: '{ "path": "x" }' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 7 } } };
  const message = assistantMessage(raw, p);
  assert.deepEqual(message.content, [{ type: 'toolCall', id: 'one', name: 'read', arguments: { path: 'x' } }]);
  assert.equal(message.usage.input, 3); assert.equal(message.usage.cacheRead, 7);
  const context = { systemPrompt: 'role', tools: p.tools.map(t => ({ ...t.function })), messages: [message, { role: 'toolResult', toolCallId: 'one', content: 'result' }] };
  const wire = sdkMessages(context); assert.deepEqual(wire[1].tool_calls, [{ id: 'one', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }]);
  let captured;
  const stream = modelStream(p, async body => { captured = JSON.parse(body); return Buffer.from(JSON.stringify(raw)); }, () => {});
  await stream({ provider: p.settings.provider, id: p.settings.model }, context).result();
  assert.deepEqual(captured.thinking, { type: 'disabled' }); assert.deepEqual(captured.messages, wire);
  for (const value of [null, 1, -1, 0.5, '0', false, {}, [], Number.MAX_SAFE_INTEGER]) {
    const v = structuredClone(raw); v.choices[0].message.tool_calls[0].index = value;
    assert.throws(() => assistantMessage(v, p));
  }
  for (const compatibilityProfile of [undefined, 'opencode-go-deepseek-nonthinking-v1', 'opencode-go-deepseek-nonthinking-cached-v1']) {
    const old = structuredClone(p); if (compatibilityProfile) old.settings.compatibilityProfile = compatibilityProfile; else delete old.settings.compatibilityProfile;
    const v = structuredClone(raw); delete v.choices[0].message.reasoning_content; delete v.usage.prompt_tokens_details;
    assert.throws(() => assistantMessage(v, old));
  }
  for (const change of [t => t.extra = 0, t => delete t.id, t => delete t.type, t => delete t.function,
    t => t.type = 'other', t => t.type = null, t => t.type = 0]) {
    const v = structuredClone(raw); change(v.choices[0].message.tool_calls[0]); assert.throws(() => assistantMessage(v, p));
  }
  const multiple = structuredClone(raw); multiple.choices[0].message.tool_calls.push(multiple.choices[0].message.tool_calls[0]);
  assert.throws(() => assistantMessage(multiple, p));
  delete raw.choices[0].message.tool_calls[0].index; assert.deepEqual(assistantMessage(raw, p).content, message.content);
});

test('relay uses only pinned container ID; duplicate mailbox sequence sends once and joins before returning', async () => {
  const id = 'a'.repeat(64); let finish, delivered = 0, sent = 0, reads = 0;
  const run = async (args, options) => {
    if (args[0] === 'start') return new Promise(resolve => { finish = resolve; });
    if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([{ Id: id, State: { Running: true } }]), stderr: '' };
    assert.equal(args[0], 'exec'); assert.equal(args.includes(id), true);
    if (options?.input) { delivered++; return { code: 0, stdout: '', stderr: '' }; }
    reads++;
    if (reads === 2) setTimeout(() => finish({ code: 0, stdout: 'receipt', stderr: '' }), 5);
    return { code: 0, stdout: JSON.stringify({ sequence: 1, body: Buffer.from('{}').toString('base64') }), stderr: '' };
  };
  const wrapped = relayDockerTransport(run, async b => { sent++; assert.equal(b.toString(), '{}'); return Buffer.from('{"ok":true}'); }, { maxRequests: 2, maxRequestBytes: 100, maxResponseBytes: 100 });
  const result = await wrapped(['start', '-a', '-i', id], { timeoutMs: 1000 });
  assert.equal(result.stdout, 'receipt'); assert.equal(sent, 1); assert.equal(delivered, 1); assert.equal(reads, 2);
});
test('mailbox read racing with container exit joins the actual attach result instead of inventing a relay failure', async () => {
  const id = 'a'.repeat(64); let finish, stopped = false, joined = false;
  const run = async args => {
    if (args[0] === 'start') return new Promise(resolve => { finish = () => { joined = true; resolve({ code: 124, stdout: '', stderr: '' }); }; });
    if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([{ Id: id, State: { Running: !stopped } }]), stderr: '' };
    assert.equal(args[0], 'exec'); stopped = true; setImmediate(finish); return { code: 1, stdout: '', stderr: 'container stopped before exec' };
  };
  const wrapped = relayDockerTransport(run, async () => assert.fail('no model request'), { maxRequests: 2, maxRequestBytes: 100, maxResponseBytes: 100 });
  const result = await wrapped(['start', '-a', '-i', id], { timeoutMs: 1000 }); assert.equal(result.code, 124); assert.equal(joined, true);
});
test('failed mailbox exec while the container is still running remains a hard relay failure', async () => {
  const id = 'a'.repeat(64); let finish, killed = false;
  const run = async args => {
    if (args[0] === 'start') return new Promise(resolve => { finish = resolve; });
    if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([{ Id: id, State: { Running: !killed } }]), stderr: '' };
    if (args[0] === 'kill') { killed = true; finish({ code: 137, stdout: '', stderr: '' }); return { code: 0, stdout: '', stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unexpected failure while running' };
  };
  const wrapped = relayDockerTransport(run, async () => assert.fail(), { maxRequests: 2, maxRequestBytes: 100, maxResponseBytes: 100 });
  await assert.rejects(wrapped(['start', '-a', '-i', id], { timeoutMs: 1000 }), /container_model_relay_failed/); assert.equal(killed, true);
});
test('relay failure reports only an allowlisted phase/code after joining, never Docker stderr', async () => {
  const id = 'a'.repeat(64), diagnostics = []; let finish, killed = false;
  const run = async args => {
    if (args[0] === 'start') return new Promise(resolve => { finish = resolve; });
    if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([{ Id: id, State: { Running: !killed } }]), stderr: '' };
    if (args[0] === 'kill') { killed = true; finish({ code: 137, stdout: '', stderr: '' }); return { code: 0, stdout: '', stderr: '' }; }
    return { code: null, failure: 'timeout', stdout: 'PRIVATE-OUTPUT', stderr: 'PRIVATE-ERROR' };
  };
  const relay = relayDockerTransport(run, async () => assert.fail('no provider request'), { maxRequests: 2, maxRequestBytes: 100, maxResponseBytes: 100 }, undefined, d => diagnostics.push(d));
  await assert.rejects(relay(['start', '-a', '-i', id], { timeoutMs: 1000 }), /container_model_relay_failed/);
  assert.equal(killed, true);
  assert.deepEqual(diagnostics, [{ phase: 'read', errorCode: 'relay_failed' }]);
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE'), false);
});
test('host send refusal preserves only exact allowlisted causes after stopping and joining the worker', async () => {
  for (const code of ['evaluation_codex_access_expired', 'evaluation_codex_input_contains_known_key', 'evaluation_codex_input_contains_access',
    'evaluation_codex_request_aborted', 'evaluation_codex_transport_stopped', 'wiki_precheck_trace_input_contains_key',
    'evaluation_codex_mailbox_request_invalid', 'evaluation_codex_private_detail', 'evaluation_codex_PRIVATE', 'PRIVATE']) {
    const id = 'a'.repeat(64), diagnostics = []; let finish, killed = false, joined = false;
    const run = async args => {
      if (args[0] === 'start') return new Promise(resolve => { finish = () => { joined = true; resolve({ code: 137, stdout: '', stderr: '' }); }; });
      if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([{ Id: id, State: { Running: !killed } }]), stderr: '' };
      if (args[0] === 'kill') { killed = true; finish(); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: JSON.stringify({ sequence: 1, body: 'e30=' }), stderr: '' };
    };
    const relay = relayDockerTransport(run, async () => { throw Object.assign(Error('PRIVATE request or access'), { code }); },
      { maxRequests: 2, maxRequestBytes: 100, maxResponseBytes: 100 }, undefined, d => { assert.equal(joined, true); diagnostics.push(d); });
    await assert.rejects(relay(['start', '-a', '-i', id], { timeoutMs: 1000 }), /container_model_relay_failed/);
    assert.equal(killed, true); assert.equal(joined, true);
    assert.deepEqual(diagnostics, [{ phase: 'send', errorCode: code.includes('PRIVATE') || code === 'evaluation_codex_private_detail' ? 'relay_failed' : code }]);
    assert.equal(JSON.stringify(diagnostics).includes('PRIVATE'), false);
  }
});
test('external precheck cancellation stops the pinned container between model calls and joins attach', async () => {
  const controller = new AbortController(), id = 'a'.repeat(64); let finish, killed = false, reads = 0, joined = false;
  const run = async args => {
    if (args[0] === 'start') return new Promise(resolve => { finish = () => { joined = true; resolve({ code: 137, stdout: '', stderr: '' }); }; });
    if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([{ Id: id, State: { Running: !killed } }]), stderr: '' };
    if (args[0] === 'kill') { assert.equal(args[1], id); killed = true; finish(); return { code: 0, stdout: '', stderr: '' }; }
    assert.equal(args[0], 'exec'); reads++;
    if (reads === 1) controller.abort();
    // The pre-fix relay must terminate too, so a red test never leaves a worker.
    if (reads === 3) setImmediate(finish);
    return { code: 0, stdout: '', stderr: '' };
  };
  const relay = relayDockerTransport(run, async () => assert.fail('no model send'), { maxRequests: 2, maxRequestBytes: 100, maxResponseBytes: 100 }, controller.signal);
  await assert.rejects(relay(['start', '-a', '-i', id], { timeoutMs: 1000 }), /container_model_relay_failed/);
  assert.equal(killed, true); assert.equal(joined, true); assert.equal(reads, 1);
});
test('an already aborted relay cannot attach a worker', async () => {
  const controller = new AbortController(); controller.abort(); let starts = 0;
  const run = async args => { if (args[0] === 'start') starts++; return { code: 0, stdout: '', stderr: '' }; };
  const relay = relayDockerTransport(run, async () => assert.fail(), { maxRequests: 2, maxRequestBytes: 100, maxResponseBytes: 100 }, controller.signal);
  await assert.rejects(relay(['start', '-a', '-i', 'a'.repeat(64)], { timeoutMs: 1000 })); assert.equal(starts, 0);
});
test('a transient host send error retains only its fixed code after stopping and joining the owned worker', async () => {
  const id='a'.repeat(64);let finish,killed=false;
  const run=async args=>{
    if(args[0]==='start')return new Promise(resolve=>{finish=resolve;});
    if(args[0]==='inspect')return {code:0,stdout:JSON.stringify([{Id:id,State:{Running:!killed}}]),stderr:''};
    if(args[0]==='kill'){killed=true;finish({code:137,stdout:'PRIVATE',stderr:'PRIVATE'});return {code:0,stdout:'',stderr:''};}
    return {code:0,stdout:JSON.stringify({sequence:1,body:'e30='}),stderr:''};
  };
  const relay=relayDockerTransport(run,async()=>{throw Object.assign(Error('PRIVATE-CREDENTIAL'),{code:'evaluation_codex_proxy_failed'});},{maxRequests:2,maxRequestBytes:100,maxResponseBytes:100});
  await assert.rejects(relay(['start','-a','-i',id],{timeoutMs:1000}),e=>e.code==='evaluation_codex_proxy_failed'&&!JSON.stringify(e).includes('PRIVATE'));
  assert.equal(killed,true);
});
test('malformed/oversized/skipped mailbox requests never reach send and owned process is stopped', async () => {
  for (const request of [{ sequence: 2, body: 'e30=' }, { sequence: 1, body: '!!!' }, { sequence: 1, body: Buffer.alloc(101).toString('base64') }, { sequence: 1, body: 'e30=', extra: true }]) {
    const id = 'a'.repeat(64); let finish, sent = 0, killed = 0;
    const run = async args => {
      if (args[0] === 'start') return new Promise(resolve => { finish = resolve; });
      if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([{ Id: id, State: { Running: true } }]), stderr: '' };
      if (args[0] === 'kill') { killed++; finish({ code: 137, stdout: '', stderr: '' }); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: JSON.stringify(request), stderr: '' };
    };
    const wrapped = relayDockerTransport(run, async () => { sent++; return Buffer.from('{}'); }, { maxRequests: 2, maxRequestBytes: 100, maxResponseBytes: 100 });
    await assert.rejects(wrapped(['start', '-a', '-i', id], { timeoutMs: 1000 }));
    assert.equal(sent, 0); assert.equal(killed, 1);
  }
});
