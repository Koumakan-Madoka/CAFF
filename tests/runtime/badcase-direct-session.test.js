// Synthetic in-memory session prefixes only; no SDK, account, I/O or model calls.
const test = require('node:test'), assert = require('node:assert/strict');
const direct = require('../../scripts/badcase-capture/direct-model.cjs');
const names = ['CAFF_CHAT_API_URL', 'CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_CONVERSATION_ID', 'CAFF_CHAT_TURN_ID',
  'CAFF_CHAT_TOOLS_PATH', 'CAFF_CHAT_TOOLS_RELATIVE_PATH', 'PI_AGENT_SANDBOX_DIR', 'PI_AGENT_PRIVATE_DIR'];
const values = Object.fromEntries(names.map(n => [n, 'isolated-' + n]));
test('immutable container distribution includes the session validator used by resumed worker', () => {
  const files = require('../../scripts/badcase-capture/evaluation-bridge-files.json');
  assert.ok(files.build.includes('build/server/domain/runtime/badcase-capture/session-validator.js'));
});
function session(root) {
  return [
    { type: 'session', version: 3, id: 'old-session', cwd: root },
    { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'Earlier {{CAFF_CHAT_API_URL}} ' + root } },
    { type: 'message', id: 'm2', parentId: 'm1', message: { role: 'assistant', api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-6.1-sol', usage: {}, stopReason: 'stop',
      content: [{ type: 'text', text: 'Use {{PI_AGENT_PRIVATE_DIR}}' }, { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: root + (root.startsWith('/') ? '/' : '\\') + 'source.txt' } }] } },
    { type: 'message', id: 'm3', parentId: 'm2', message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', isError: false, content: [{ type: 'text', text: 'retained bytes' }] } },
  ].map(JSON.stringify).join('\r\n') + '\r\n';
}
test('direct bindings sum prompt/session markers and map only allowed JSON strings, preserving CRLF and all other prefix bytes', () => {
  for (const root of ['/old/root', 'C:\\old\\root']) {
    const sessionText = session(root), prompt = 'Now {{CAFF_CHAT_API_URL}} ' + root;
    const bindings = { sourceRoot: root, controlledReplacements: [{ name: names[0], count: 1 }, { name: names[0], count: 1 }, { name: 'PI_AGENT_PRIVATE_DIR', count: 1 }] };
    assert.doesNotThrow(() => direct.validateDirectBindings(prompt, bindings, sessionText));
    const result = direct.bindDirectInputs(prompt, sessionText, bindings, values);
    assert.equal(result.prompt, 'Now isolated-CAFF_CHAT_API_URL /work/restored');
    const expected = sessionText.replace(JSON.stringify(root), JSON.stringify('/work/restored'))
      .replace(JSON.stringify(root + (root.startsWith('/') ? '/' : '\\') + 'source.txt'), JSON.stringify('/work/restored/source.txt'))
      .replace(JSON.stringify('Earlier {{CAFF_CHAT_API_URL}} ' + root), JSON.stringify('Earlier isolated-CAFF_CHAT_API_URL /work/restored'))
      .replace('{{PI_AGENT_PRIVATE_DIR}}', 'isolated-PI_AGENT_PRIVATE_DIR');
    assert.equal(result.sessionText, expected); assert.equal(sessionText, session(root));
    assert.equal(JSON.parse(result.sessionText.split('\n')[0]).id, 'old-session');
    assert.equal(direct.bindDirectPrompt(prompt, { ...bindings, controlledReplacements: [{ name: names[0], count: 1 }] }, values), result.prompt);
    assert.throws(() => direct.validateDirectBindings(prompt, { ...bindings, controlledReplacements: [] }, sessionText), /bindings_unsupported/);
  }
});
test('resume bindings reject missing newline, malformed JSON, wrong root/version and markers in identities or tool payloads', () => {
  const root = '/old/root', good = session(root), prompt = 'Current task';
  const bindings = { sourceRoot: root, controlledReplacements: [{ name: names[0], count: 1 }, { name: 'PI_AGENT_PRIVATE_DIR', count: 1 }] };
  for (const text of ['', good.slice(0, -1), 'invalid\n', good.replace('"version":3', '"version":2'), good.replace('"cwd":"/old/root"', '"cwd":"/other"'),
    good.replace('"old-session"', '"{{CAFF_CHAT_API_URL}}"'), good.replace('"retained bytes"', '"{{CAFF_CHAT_API_URL}}"'),
    good.replace('"read","arguments"', '"{{CAFF_CHAT_API_URL}}","arguments"'), good.replace('"retained bytes"', '"{{UNKNOWN}}"'),
    good.replace('PI_AGENT_PRIVATE_DIR', 'UNKNOWN'), good.replace('CAFF_CHAT_API_URL', 'CAFF_CHAT_API_\\u0055RL')]) {
    assert.notEqual(text, good, 'each negative fixture must actually differ');
    assert.throws(() => direct.validateDirectBindings(prompt, bindings, text), /bindings_unsupported/);
  }
});
test('session text substitutions escape callback values as JSON, never as new entries', () => {
  const root = '/old/root', text = session(root), bindings = { sourceRoot: root, controlledReplacements: [{ name: names[0], count: 1 }, { name: 'PI_AGENT_PRIVATE_DIR', count: 1 }] };
  const value = 'quoted "value"\nnot a new session entry';
  const result = direct.bindDirectInputs('task', text, bindings, { ...values, CAFF_CHAT_API_URL: value });
  assert.equal(result.sessionText.split('\n').length, text.split('\n').length);
  assert.equal(JSON.parse(result.sessionText.split('\n')[1]).message.content, 'Earlier ' + value + ' /work/restored');
});
