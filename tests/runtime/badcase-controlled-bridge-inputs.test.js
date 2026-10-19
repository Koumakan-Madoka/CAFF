// Pure substitution tests. No SDK, host tools, credentials, network or authorization.
const test = require('node:test'), assert = require('node:assert/strict');
const api = () => require('../../build/server/domain/runtime/badcase-capture/controlled-bridge-inputs');
const names = ['CAFF_CHAT_API_URL', 'CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_CONVERSATION_ID',
  'CAFF_CHAT_TURN_ID', 'CAFF_CHAT_TOOLS_PATH', 'CAFF_CHAT_TOOLS_RELATIVE_PATH'];
const values = { CAFF_CHAT_API_URL: 'http://127.0.0.1:12345', CAFF_CHAT_INVOCATION_ID: 'new-local-invocation',
  CAFF_CHAT_CALLBACK_TOKEN: 'a'.repeat(64), CAFF_CHAT_CONVERSATION_ID: 'c1', CAFF_CHAT_TURN_ID: 't1',
  CAFF_CHAT_TOOLS_PATH: '/work/build/lib/agent-chat-tools.js', CAFF_CHAT_TOOLS_RELATIVE_PATH: '../../build/lib/agent-chat-tools.js' };
function input() {
  const session = [{ type: 'session', id: 'session-id', cwd: '/work/restored/snapshot' },
    { type: 'message', id: 'm1', message: { role: 'user', content: 'Use {{CAFF_CHAT_API_URL}}' } },
    { type: 'message', id: 'm2', message: { role: 'assistant', content: [{ type: 'text', text: 'Use {{CAFF_CHAT_CALLBACK_TOKEN}}' }] } },
    { type: 'custom_message', id: 'm3', content: [{ type: 'text', text: 'Use {{CAFF_CHAT_TOOLS_PATH}}' }] }];
  return { invocation: names.map(n => '{{' + n + '}}').join('\n'), sessionText: session.map(JSON.stringify).join('\r\n') + '\r\n',
    controlledReplacements: [...names.map(name => ({ name, count: 1 })),
      ...['CAFF_CHAT_API_URL', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_TOOLS_PATH'].map(name => ({ name, count: 1 }))] };
}
test('replacement ledger sums prompt/session records and preserves every non-placeholder byte and CRLF', () => {
  const v = input(), before = JSON.stringify(v), a = api(), plan = a.planControlledBridgeInputs(v);
  assert.equal(plan.replacementCount, 10); assert.equal(plan.variableCount, 7);
  let r; assert.doesNotThrow(() => { r = a.applyControlledBridgeInputs(v, values); });
  assert.equal(r.invocation, names.map(n => values[n]).join('\n'));
  const expected = v.sessionText.replace('{{CAFF_CHAT_API_URL}}', values.CAFF_CHAT_API_URL)
    .replace('{{CAFF_CHAT_CALLBACK_TOKEN}}', values.CAFF_CHAT_CALLBACK_TOKEN).replace('{{CAFF_CHAT_TOOLS_PATH}}', values.CAFF_CHAT_TOOLS_PATH);
  assert.equal(r.sessionText, expected); assert.ok(r.sessionText.endsWith('\r\n'));
  assert.equal(JSON.stringify(v), before); assert.deepEqual(r.receipt, plan);
  assert.equal(JSON.stringify(r.receipt).includes(values.CAFF_CHAT_CALLBACK_TOKEN), false);
  assert.equal(JSON.stringify(r.receipt).includes(values.CAFF_CHAT_API_URL), false);
});
test('fresh stays fresh, zero replacements are valid and no unknown or malformed placeholders are silently kept', () => {
  const a = api(), v = { invocation: 'plain', sessionText: null, controlledReplacements: [] };
  assert.equal(a.applyControlledBridgeInputs(v, values).sessionText, null);
  const jsonProse = { ...v, invocation: 'Inspect {"outer":{"inner":1}}' };
  assert.equal(a.applyControlledBridgeInputs(jsonProse, values).invocation, jsonProse.invocation);
  for (const text of ['{{UNKNOWN}}', '{{CAFF_BROWSER_CLI_PATH}}', '{{PI_AGENT_PRIVATE_DIR}}', '{{missing', '{{{{CAFF_CHAT_TURN_ID}}}}']) {
    assert.throws(() => a.planControlledBridgeInputs({ ...v, invocation: text }), { code: 'replay_bridge_replacements_invalid' });
  }
});
test('missing, inflated, zero, fractional, unknown, extra-field and overflow ledger entries fail closed', () => {
  const a = api();
  for (const edit of [v => v.controlledReplacements.pop(), v => v.controlledReplacements[0].count++,
    v => v.controlledReplacements[0].count = 0, v => v.controlledReplacements[0].count = 1.5,
    v => v.controlledReplacements[0].name = 'UNKNOWN', v => v.controlledReplacements[0].value = 'old',
    v => v.controlledReplacements[0].count = Number.MAX_SAFE_INTEGER, v => v.controlledReplacements = Array(513).fill({ name: names[0], count: 1 })]) {
    const v = input(); edit(v); assert.throws(() => a.planControlledBridgeInputs(v), { code: 'replay_bridge_replacements_invalid' });
  }
});
test('session replacements cannot change identity/keys/models/tool calls/results or ambiguous/alternate JSON string encodings', () => {
  const a = api(), entry = v => ({ invocation: '', controlledReplacements: [{ name: names[0], count: 1 }], sessionText: JSON.stringify(v) + '\n' });
  for (const e of [{ type: 'session', id: '{{CAFF_CHAT_API_URL}}' }, { type: '{{CAFF_CHAT_API_URL}}' },
    { type: 'message', message: { role: 'user', content: 'plain', '{{CAFF_CHAT_API_URL}}': 'key' } },
    { type: 'message', message: { role: 'assistant', model: '{{CAFF_CHAT_API_URL}}', content: [] } },
    { type: 'message', message: { role: 'toolResult', content: '{{CAFF_CHAT_API_URL}}' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: '{{CAFF_CHAT_API_URL}}' } }] } },
    { type: 'message', copy: '{{CAFF_CHAT_API_URL}}', message: { role: 'user', content: '{{CAFF_CHAT_API_URL}}' } }]) {
    assert.throws(() => a.planControlledBridgeInputs(entry(e)), { code: 'replay_bridge_replacements_invalid' });
  }
  const v = entry({ type: 'message', message: { role: 'user', content: '{{CAFF_CHAT_API_URL}}' } });
  v.sessionText = v.sessionText.replace('CAFF_CHAT_API_URL', 'CAFF_CHAT_API_\\u0055RL');
  assert.throws(() => a.planControlledBridgeInputs(v), { code: 'replay_bridge_replacements_invalid' });
});
test('bindings are closed, container-local and cannot inject shell syntax, production URLs or provider/private authority', () => {
  const a = api();
  for (const patch of [{ CAFF_CHAT_API_URL: 'https://production.invalid' }, { CAFF_CHAT_API_URL: 'http://localhost:12345' },
    { CAFF_CHAT_API_URL: 'http://127.0.0.1:70000' }, { CAFF_CHAT_CALLBACK_TOKEN: 'old-secret' },
    { CAFF_CHAT_TOOLS_PATH: '/host/cli.js' }, { CAFF_CHAT_TOOLS_RELATIVE_PATH: '/work/build/lib/agent-chat-tools.js' },
    { CAFF_CHAT_INVOCATION_ID: 'x\"$()' }, { CAFF_CHAT_TURN_ID: '' }, { OPENAI_API_KEY: 'forbidden' }]) {
    assert.throws(() => a.applyControlledBridgeInputs(input(), { ...values, ...patch }), { code: 'replay_bridge_replacements_invalid' });
  }
  const missing = { ...values }; delete missing.CAFF_CHAT_CALLBACK_TOKEN;
  assert.throws(() => a.applyControlledBridgeInputs(input(), missing), { code: 'replay_bridge_replacements_invalid' });
});
