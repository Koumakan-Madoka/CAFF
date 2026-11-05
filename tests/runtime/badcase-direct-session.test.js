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
test('direct bindings map header/prose only, preserving CRLF and frozen historical file arguments', () => {
  for (const root of ['/old/root', 'C:\\old\\root']) {
    const sessionText = session(root), prompt = 'Now {{CAFF_CHAT_API_URL}} ' + root;
    const bindings = { sourceRoot: root, controlledReplacements: [{ name: names[0], count: 1 }, { name: names[0], count: 1 }, { name: 'PI_AGENT_PRIVATE_DIR', count: 1 }] };
    assert.doesNotThrow(() => direct.validateDirectBindings(prompt, bindings, sessionText));
    const result = direct.bindDirectInputs(prompt, sessionText, bindings, values);
    assert.equal(result.prompt, 'Now isolated-CAFF_CHAT_API_URL /work/restored');
    const expected = sessionText.replace(JSON.stringify(root), JSON.stringify('/work/restored'))
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
    good.replace('"read","arguments"', '"{{CAFF_CHAT_API_URL}}","arguments"'),
    good.replace('PI_AGENT_PRIVATE_DIR', 'UNKNOWN'), good.replace('CAFF_CHAT_API_URL', 'CAFF_CHAT_API_\\u0055RL')]) {
    assert.notEqual(text, good, 'each negative fixture must actually differ');
    assert.throws(() => direct.validateDirectBindings(prompt, bindings, text), /bindings_unsupported/);
  }
});
test('frozen bash/unknown calls, results and external paths are inert context, with original argument/result bytes', () => {
  const root = 'C:\\old\\root', entries = session(root).trim().split('\n').map(JSON.parse);
  entries[2].message.content[1] = { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'node -e "throw Error(\'must never run\')" ' + root + '\\secret-looking-history-path' } };
  entries[3].message.toolName = 'bash'; entries[3].message.content[0].text = root + '\\outside {{UNKNOWN}}';
  entries.push({ type: 'message', id: 'm4', parentId: 'm3', message: { role: 'assistant', api: 'a', provider: 'p', model: 'm', usage: {}, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'unknown1', name: 'retired_plugin', arguments: { path: '/not-in-workspace/file' } }] } });
  const text = entries.map(JSON.stringify).join('\r\n') + '\r\n';
  const bindings = { sourceRoot: root, controlledReplacements: [{ name: names[0], count: 1 }, { name: 'PI_AGENT_PRIVATE_DIR', count: 1 }] };
  const result = direct.bindDirectInputs('Current task', text, bindings, values);
  const mapped = result.sessionText.trim().split('\n').map(JSON.parse);
  assert.deepEqual(mapped[2].message.content[1], entries[2].message.content[1]);
  assert.deepEqual(mapped[3], entries[3]); assert.deepEqual(mapped[4], entries[4]);
  const validation = require('../../build/server/domain/runtime/badcase-capture/session-validator').validateSessionV2(result.sessionText, { authorizedRoot: '/work/restored', historyContext: true });
  assert.equal(validation.ok, true); assert.deepEqual(validation.unverifiedDimensions, []);
  assert.equal(direct.replaySessionInfo(text).historyTools, 'context-only-not-executed');
  assert.equal(direct.replaySessionInfo(text).externalPathDependencies, 'not-verified');
  for (const entry of [
    { type: 'custom', id: 'ext', parentId: 'm4', customType: 'unknown-extension', data: {} },
    { type: 'message', id: 'img', parentId: 'm4', message: { role: 'user', content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }] } },
  ]) {
    const unsupported = require('../../build/server/domain/runtime/badcase-capture/session-validator').validateSessionV2(result.sessionText + JSON.stringify(entry) + '\n', { historyContext: true });
    assert.equal(unsupported.ok, true); assert.ok(unsupported.unverifiedDimensions.length);
  }
});

test('Windows path prose remains frozen context rather than an unsupported current dependency', () => {
  const root = 'C:\\old\\root', text = session(root).replace('Earlier {{CAFF_CHAT_API_URL}}', 'Earlier ' + root.replaceAll('\\', '\\\\') + '\\\\outside-file {{CAFF_CHAT_API_URL}}');
  const bindings = { sourceRoot: root, controlledReplacements: [{ name: names[0], count: 1 }, { name: 'PI_AGENT_PRIVATE_DIR', count: 1 }] };
  const result = direct.bindDirectInputs('Current task', text, bindings, values);
  assert.ok(JSON.parse(result.sessionText.split('\n')[1]).message.content.includes(root + '\\outside-file'));
});

test('recorded skill roots bind POSIX/Windows prompt and history prose, not sibling prefixes or historical tools', () => {
  for (const skillRoot of ['/project/.agents/skills/demo', 'E:\\project\\.agents\\skills\\demo']) {
    const root = '/old/root', child = skillRoot + (skillRoot.startsWith('/') ? '/' : '\\') + 'references' + (skillRoot.startsWith('/') ? '/' : '\\') + 'guide.md';
    const entries = session(root).trimEnd().split('\n').map(JSON.parse);
    entries[1].message.content = 'Earlier {{CAFF_CHAT_API_URL}} ' + child;
    entries[2].message.content[1].arguments.path = child;
    const text = entries.map(JSON.stringify).join('\r\n') + '\r\n';
    const bindings = { sourceRoot: root, controlledReplacements: [{ name: names[0], count: 1 }, { name: 'PI_AGENT_PRIVATE_DIR', count: 1 }],
      projectSkills: [{ sourcePath: skillRoot, relativePath: '.caff-replay-skills/mirror/demo' }] };
    const result = direct.bindDirectInputs('Read ' + child + ' and ' + skillRoot + '-sibling', text, bindings, values);
    assert.equal(result.prompt, 'Read /work/restored/.caff-replay-skills/mirror/demo/references/guide.md and ' + skillRoot + '-sibling');
    const mapped = result.sessionText.trimEnd().split('\n').map(JSON.parse);
    assert.equal(mapped[1].message.content, 'Earlier isolated-CAFF_CHAT_API_URL /work/restored/.caff-replay-skills/mirror/demo/references/guide.md');
    assert.deepEqual(mapped[2].message.content[1], entries[2].message.content[1]);
    assert.equal(result.sessionText.includes('\r\n'), true);
    for (const bad of [{ sourcePath: 'relative', relativePath: '.caff-replay-skills/x' }, { sourcePath: skillRoot, relativePath: '../outside' },
      { sourcePath: skillRoot, relativePath: '.caff-replay-skills/../../outside' }]) {
      assert.throws(() => direct.validateDirectBindings('task', { ...bindings, projectSkills: [bad] }), /bindings_unsupported/);
    }
  }
});

test('in-cwd captured skill bindings normalize Windows children before the general cwd substitution', () => {
  const sourceRoot = 'E:\\project', skillRoot = sourceRoot + '\\.agents\\skills\\demo';
  const bindings = { sourceRoot, controlledReplacements: [], projectSkills: [{ sourcePath: skillRoot, relativePath: '.agents/skills/demo' }] };
  const prompt = 'Read ' + skillRoot + '\\references\\guide.md';
  assert.equal(direct.bindDirectInputs(prompt, null, bindings, values).prompt, 'Read /work/restored/.agents/skills/demo/references/guide.md');
});

test('CLI discloses inert history tools and unchecked current external-path dependencies', () => {
  const report = require('../../scripts/badcase-capture/direct-comparison.cjs').formatComparison({ supported: true, replaySession: direct.replaySessionInfo(session('/old/root')) });
  assert.match(report, /历史工具.*仅作上下文.*不执行/);
  assert.match(report, /当前.*外部路径.*未核验/);
});

test('session text substitutions escape callback values as JSON, never as new entries', () => {
  const root = '/old/root', text = session(root), bindings = { sourceRoot: root, controlledReplacements: [{ name: names[0], count: 1 }, { name: 'PI_AGENT_PRIVATE_DIR', count: 1 }] };
  const value = 'quoted "value"\nnot a new session entry';
  const result = direct.bindDirectInputs('task', text, bindings, { ...values, CAFF_CHAT_API_URL: value });
  assert.equal(result.sessionText.split('\n').length, text.split('\n').length);
  assert.equal(JSON.parse(result.sessionText.split('\n')[1]).message.content, 'Earlier ' + value + ' /work/restored');
});
