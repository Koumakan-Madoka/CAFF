const test = require('node:test');
const assert = require('node:assert/strict');
const { sdkMessages, sdkTools, assistantMessage } = require('../../scripts/badcase-capture/container-model-adapter.cjs');
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
  const raw = { model: 'fixture', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'one', function: { name: 'read', arguments: '{"path":"x"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  const m = assistantMessage(raw, profile);
  assert.equal(m.stopReason, 'toolUse'); assert.deepEqual(m.content, [{ type: 'toolCall', id: 'one', name: 'read', arguments: { path: 'x' } }]);
  assert.equal(m.usage.totalTokens, 12);
  assert.throws(() => assistantMessage({ ...raw, model: 'other' }, profile));
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
