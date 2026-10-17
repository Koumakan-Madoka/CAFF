// Pure archived-input mapping. No SDK, filesystem restore, Docker or agent execution.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const api = () => require('../../build/server/domain/runtime/badcase-capture/worktree-replay-inputs');
const DEST = '/work/restored/snapshot';
function encoded(data) {
  const capsule = JSON.stringify(data);
  return { capsule, expected: { capsuleHash: hash(capsule), checkpointChecksum: hash(JSON.stringify(data.checkpoint)) } };
}
function inputs(t, mode = 'fresh', platform = 'linux') {
  const root = platform === 'win32' ? 'C:\\source\\project' : '/source/project';
  const h = fixture(t, mode, ({ cp, r, config, session, put }) => {
    cp.targetDir = root; cp.files['source.txt'].mode = 0o100644;
    r.promptBlobHash = r.normalizedPromptHash = put('Inspect ' + root + (platform === 'win32' ? '\\source.txt' : '/source.txt'));
    config.toolBridgeEnabled = true; config.extraHarnessSetting = { mustRemain: true };
    r.harness.configSnapshotHash = put(JSON.stringify(config));
    if (mode === 'resume') {
      session[0].cwd = root;
      r.sessionBlobHash = put(session.map(e => JSON.stringify(e)).join('\r\n') + '\r\n');
    }
  });
  const p = prepareRetainedInitializationCapsule(h.request);
  const data = JSON.parse(p.capsule);
  const declaration = { schemaVersion: 1, sourcePlatform: platform, sourceRoot: root, mappings: [
    { input: 'prompt', start: 8, end: 8 + root.length + 11, sourcePath: root + (platform === 'win32' ? '\\source.txt' : '/source.txt') },
    ...(mode === 'resume' ? [{ input: 'session', line: 0, pointer: '/cwd', start: 0, end: root.length, sourcePath: root }] : []),
  ] };
  return { h, data, ...encoded(data), declaration };
}
function blob(data, digest) { return Buffer.from(data.blobs.find(b => b.sha256 === digest).base64, 'base64').toString(); }
function changeBlob(data, field, text) {
  const old = data.checkpoint.replayInput[field], b = Buffer.from(text), sha256 = hash(b);
  data.checkpoint.replayInput[field] = sha256;
  if (field === 'promptBlobHash') data.checkpoint.replayInput.normalizedPromptHash = sha256;
  data.blobs = data.blobs.filter(b => b.sha256 !== old); data.blobs.push({ sha256, base64: b.toString('base64') });
}
function plan(v, declaration = v.declaration) { return api().prepareWorktreeReplayInputs(v.capsule, v.expected, declaration); }

test('explicit Linux/Windows fresh/resume maps only declared paths, preserves full harness and archive bytes', t => {
  for (const platform of ['linux', 'win32']) for (const mode of ['fresh', 'resume']) {
    const v = inputs(t, mode, platform), before = v.capsule, decl = structuredClone(v.declaration);
    const p = plan(v);
    assert.equal(p.invocation, 'Inspect ' + DEST + '/source.txt');
    assert.equal(p.deliveryMode, mode);
    assert.equal(p.workingCwd, DEST);
    assert.equal(p.runConfig.promptVersion, 'v1');
    assert.equal(p.harness.toolBridgeEnabled, true);
    assert.deepEqual(p.harness.extraHarnessSetting, { mustRemain: true });
    assert.equal(p.archive.capsuleHash, v.expected.capsuleHash);
    assert.equal(p.archive.promptBlobHash, v.data.checkpoint.replayInput.promptBlobHash);
    assert.equal(p.archive.sessionBlobHash, v.data.checkpoint.replayInput.sessionBlobHash);
    assert.equal(p.receipt.kind, 'explicit-worktree-input-mapping-v1');
    for (const k of ['launchAuthorized', 'runnable', 'reproduced', 'evaluable', 'strictEvalEligible']) assert.equal(p.receipt[k], false);
    assert.equal(p.receipt.piExecuted, false);
    assert.equal(p.receipt.mappingCount, mode === 'fresh' ? 1 : 2);
    assert.equal(p.receipt.invocationHash, hash(p.invocation));
    assert.equal(p.receipt.sessionHash, mode === 'fresh' ? '' : hash(p.sessionText));
    assert.equal(p.receipt.declarationHash, hash(JSON.stringify(decl)));
    if (mode === 'fresh') assert.equal(p.sessionText, null);
    else {
      const original = blob(v.data, v.data.checkpoint.replayInput.sessionBlobHash);
      assert.equal(p.sessionText, original.replace(JSON.stringify(decl.sourceRoot), JSON.stringify(DEST)));
      assert.ok(p.sessionText.endsWith('\r\n'), 'CRLF and all undeclared bytes preserved');
    }
    assert.equal(v.capsule, before); assert.deepEqual(v.declaration, decl);
    p.runConfig.promptVersion = 'changed'; p.harness.extraHarnessSetting.mustRemain = false;
    assert.equal(plan(v).harness.extraHarnessSetting.mustRemain, true, 'no borrowed output references');
  }
});

test('no implicit root replacement: omitted, stale, overlapping or out-of-bounds spans fail closed', t => {
  const v = inputs(t);
  for (const alter of [d => { d.mappings = []; }, d => { d.mappings[0].start--; }, d => { d.mappings[0].end++; },
    d => { d.mappings.push({ ...d.mappings[0] }); }, d => { d.mappings[0].start = -1; },
    d => { d.mappings[0].end = 1.5; }, d => { d.mappings[0].sourcePath += 'stale'; }]) {
    const d = structuredClone(v.declaration); alter(d);
    assert.throws(() => plan(v, d), { code: 'replay_worktree_mapping_invalid' });
  }
  const d = structuredClone(v.declaration); d.mappings[0].sourcePath = d.sourceRoot; d.mappings[0].end = 8 + d.sourceRoot.length;
  assert.throws(() => plan(v, d), { code: 'replay_worktree_mapping_invalid' }, 'partial path spans cannot hide traversal or stale suffixes');
});

test('platform-independent lexical roots reject other worktrees, traversal, aliases and caller destination changes', t => {
  for (const platform of ['linux', 'win32']) {
    const v = inputs(t, 'fresh', platform);
    for (const source of [v.declaration.sourceRoot + '-other/source.txt', v.declaration.sourceRoot + '/../../escape',
      v.declaration.sourceRoot + '/a/../source.txt', v.declaration.sourceRoot + '//source.txt',
      v.declaration.sourceRoot + '/SHORT~1', v.declaration.sourceRoot.toUpperCase() + '/source.txt']) {
      const data = structuredClone(v.data); changeBlob(data, 'promptBlobHash', 'Inspect ' + source);
      const d = structuredClone(v.declaration); d.mappings[0].sourcePath = source; d.mappings[0].end = 8 + source.length;
      assert.throws(() => plan({ ...encoded(data), declaration: d }), { code: 'replay_worktree_mapping_invalid' });
    }
    for (const root of [platform === 'linux' ? '/' : 'C:\\', platform === 'linux' ? '/source' : 'C:\\source', '/wrong', 'C:relative', '\\\\host\\share', 'C:\\source\\project\\..']) {
      const d = structuredClone(v.declaration); d.sourceRoot = root;
      assert.throws(() => plan(v, d), { code: 'replay_worktree_mapping_invalid' });
    }
    const d = structuredClone(v.declaration); d.destination = '/host/repository';
    assert.throws(() => plan(v, d), { code: 'replay_worktree_mapping_invalid' });
  }
});

test('Windows child component aliases cannot become differently named Linux files; ambiguous archived components reject', t => {
  const v = inputs(t, 'fresh', 'win32'), root = v.declaration.sourceRoot;
  for (const filename of ['SOURCE.txt', 'dir/NEW.txt']) {
    const data = structuredClone(v.data);
    data.checkpoint.files['Dir/new.txt'] = { ...data.checkpoint.files['source.txt'] };
    const source = root + '\\' + filename.replaceAll('/', '\\');
    changeBlob(data, 'promptBlobHash', 'Inspect ' + source);
    const d = { ...v.declaration, mappings: [{ input: 'prompt', start: 8, end: 8 + source.length, sourcePath: source }] };
    assert.throws(() => plan({ ...encoded(data), declaration: d }), { code: 'replay_worktree_mapping_invalid' });
  }
  const ambiguous = structuredClone(v.data);
  ambiguous.checkpoint.files['Dir/a.txt'] = { ...ambiguous.checkpoint.files['source.txt'] };
  ambiguous.checkpoint.files['dir/b.txt'] = { ...ambiguous.checkpoint.files['source.txt'] };
  assert.throws(() => plan({ ...encoded(ambiguous), declaration: v.declaration }), { code: 'replay_worktree_mapping_invalid' });
});

test('text spans require path boundaries, preventing root-only traversal and embedded/sibling rewrites', t => {
  const v = inputs(t), root = v.declaration.sourceRoot;
  for (const [text, start, source] of [
    [root + '/../../outside', 0, root],
    [root + '/source.txt/../outside', 0, root + '/source.txt'],
    ['prefix' + root, 6, root],
    [root + '-other', 0, root],
  ]) {
    const data = structuredClone(v.data); changeBlob(data, 'promptBlobHash', text);
    const d = { ...v.declaration, mappings: [{ input: 'prompt', start, end: start + source.length, sourcePath: source }] };
    assert.throws(() => plan({ ...encoded(data), declaration: d }), { code: 'replay_worktree_mapping_invalid' });
  }
});

test('resume never becomes fresh: mandatory header cwd mapping, absent/bad history and extra fresh session declarations reject', t => {
  const v = inputs(t, 'resume');
  const d = structuredClone(v.declaration); d.mappings.pop();
  assert.throws(() => plan(v, d), { code: 'replay_worktree_mapping_invalid' });
  for (const text of ['', '{bad}\n', JSON.stringify({ type: 'session', version: 2, cwd: d.sourceRoot }) + '\n']) {
    const data = structuredClone(v.data); changeBlob(data, 'sessionBlobHash', text);
    assert.throws(() => plan({ ...encoded(data), declaration: v.declaration }), { code: 'replay_worktree_mapping_invalid' });
  }
  const f = inputs(t); f.declaration.mappings.push({ input: 'session', line: 0, pointer: '/cwd', start: 0, end: f.declaration.sourceRoot.length, sourcePath: f.declaration.sourceRoot });
  assert.throws(() => plan(f), { code: 'replay_worktree_mapping_invalid' });
});

test('explicit historical text/file-tool paths preserve complex session entries instead of stripping history', t => {
  const v = inputs(t, 'resume', 'win32'), root = v.declaration.sourceRoot, filename = root + '\\source.txt';
  const entries = blob(v.data, v.data.checkpoint.replayInput.sessionBlobHash).trim().split('\r\n').map(JSON.parse);
  entries.push({ type: 'message', id: 'assistant1', parentId: 'm1', message: { role: 'assistant', content: [
    { type: 'text', text: 'Read ' + filename }, { type: 'toolCall', id: 'call1', name: 'read', arguments: { path: filename, offset: 1 } },
  ] } }, { type: 'message', id: 'result1', parentId: 'assistant1', message: { role: 'toolResult', toolCallId: 'call1', content: [{ type: 'text', text: 'retained bytes' }], isError: false } });
  const original = entries.map(JSON.stringify).join('\n') + '\n'; changeBlob(v.data, 'sessionBlobHash', original);
  const d = structuredClone(v.declaration);
  d.mappings.push({ input: 'session', line: 2, pointer: '/message/content/0/text', start: 5, end: 5 + filename.length, sourcePath: filename },
    { input: 'session', line: 2, pointer: '/message/content/1/arguments/path', start: 0, end: filename.length, sourcePath: filename });
  const p = plan({ ...encoded(v.data), declaration: d });
  const working = p.sessionText.trim().split('\n').map(JSON.parse);
  assert.deepEqual(working[3], entries[3]);
  assert.equal(working[2].message.content[0].text, 'Read ' + DEST + '/source.txt');
  assert.deepEqual(working[2].message.content[1], { ...entries[2].message.content[1], arguments: { path: DEST + '/source.txt', offset: 1 } });
  assert.equal(p.harness.toolBridgeEnabled, true); assert.equal(p.receipt.runnable, false, 'mapping does not validate full SDK history');
  const bad = structuredClone(d); bad.mappings[2].pointer = '/message/content/1/id';
  assert.throws(() => plan({ ...encoded(v.data), declaration: bad }), { code: 'replay_worktree_mapping_invalid' });
});

test('multiple occurrences require explicit non-overlapping spans; order is immaterial to mapped bytes, declaration hash binds order', t => {
  const v = inputs(t), root = v.declaration.sourceRoot;
  changeBlob(v.data, 'promptBlobHash', root + ' then ' + root);
  const d = { ...v.declaration, mappings: [
    { input: 'prompt', start: 0, end: root.length, sourcePath: root },
    { input: 'prompt', start: root.length + 6, end: root.length * 2 + 6, sourcePath: root },
  ] };
  const a = plan({ ...encoded(v.data), declaration: d });
  const b = plan({ ...encoded(v.data), declaration: { ...d, mappings: [...d.mappings].reverse() } });
  assert.equal(a.invocation, DEST + ' then ' + DEST); assert.equal(a.invocation, b.invocation);
  assert.notEqual(a.receipt.declarationHash, b.receipt.declarationHash);
  assert.throws(() => plan({ ...encoded(v.data), declaration: { ...d, mappings: d.mappings.slice(0, 1) } }), { code: 'replay_worktree_mapping_invalid' });
});

test('residual case/separator aliases, ambiguous JSON tokens and forbidden session identity fields fail closed', t => {
  const v = inputs(t, 'resume', 'win32'), root = v.declaration.sourceRoot;
  const data = structuredClone(v.data), entries = blob(data, data.checkpoint.replayInput.sessionBlobHash).trim().split('\r\n').map(JSON.parse);
  entries[1].message.content = root.toLowerCase().replaceAll('\\', '/') + '/unmapped';
  changeBlob(data, 'sessionBlobHash', entries.map(JSON.stringify).join('\n') + '\n');
  assert.throws(() => plan({ ...encoded(data), declaration: v.declaration }), { code: 'replay_worktree_mapping_invalid' });
  entries[1].message.content = root;
  entries[1].extra = root;
  changeBlob(data, 'sessionBlobHash', entries.map(JSON.stringify).join('\n') + '\n');
  const d = structuredClone(v.declaration); d.mappings.push({ input: 'session', line: 1, pointer: '/message/content', start: 0, end: root.length, sourcePath: root });
  assert.throws(() => plan({ ...encoded(data), declaration: d }), { code: 'replay_worktree_mapping_invalid' });
  const identityData = structuredClone(v.data), identityEntries = blob(identityData, identityData.checkpoint.replayInput.sessionBlobHash).trim().split('\r\n').map(JSON.parse);
  identityEntries[1].id = root + '\\source.txt';
  changeBlob(identityData, 'sessionBlobHash', identityEntries.map(JSON.stringify).join('\n') + '\n');
  const identityDeclaration = structuredClone(v.declaration);
  identityDeclaration.mappings.push({ input: 'session', line: 1, pointer: '/id', start: 0, end: identityEntries[1].id.length, sourcePath: identityEntries[1].id });
  assert.throws(() => plan({ ...encoded(identityData), declaration: identityDeclaration }), { code: 'replay_worktree_mapping_invalid' });
  for (const pointer of ['/id', '/__proto__/cwd', '/message/role', '/message/content/01/text', '/cwd/extra']) {
    const bad = structuredClone(v.declaration); bad.mappings[1].pointer = pointer;
    assert.throws(() => plan(v, bad), { code: 'replay_worktree_mapping_invalid' });
  }
});

test('keeps skill and controlled-variable declarations verbatim; mapping is not runtime credential substitution', t => {
  const v = inputs(t), data = structuredClone(v.data), r = data.checkpoint.replayInput;
  const skill = Buffer.from('Synthetic skill content'), digest = hash(skill);
  data.blobs.push({ sha256: digest, base64: skill.toString('base64') });
  r.runConfig.skillIds = ['one'];
  r.harness.skillSnapshots = [{ id: 'one', source: 'synthetic/SKILL.md', sha256: digest, blobHash: digest }];
  r.controlledReplacements = [{ name: 'CAFF_CHAT_API_URL', count: 1 }];
  changeBlob(data, 'promptBlobHash', blob(data, r.promptBlobHash) + '\n{{CAFF_CHAT_API_URL}}');
  const p = plan({ ...encoded(data), declaration: v.declaration });
  assert.deepEqual(p.skillSnapshots, r.harness.skillSnapshots);
  assert.deepEqual(p.controlledReplacements, r.controlledReplacements);
  assert.ok(p.invocation.endsWith('{{CAFF_CHAT_API_URL}}'));
  assert.deepEqual(p.runConfig.skillIds, ['one']);
  assert.equal(p.receipt.launchAuthorized, false);
});

test('256 distinct valid spans succeed but 257 fail at the declaration limit, not overlap or duplicate checks', t => {
  const v = inputs(t), root = v.declaration.sourceRoot;
  for (const count of [256, 257]) {
    const data = structuredClone(v.data); changeBlob(data, 'promptBlobHash', (root + ' ').repeat(count));
    const d = { ...v.declaration, mappings: Array.from({ length: count }, (_, i) => ({
      input: 'prompt', start: i * (root.length + 1), end: i * (root.length + 1) + root.length, sourcePath: root,
    })) };
    if (count === 256) assert.equal(plan({ ...encoded(data), declaration: d }).invocation, (DEST + ' ').repeat(count));
    else assert.throws(() => plan({ ...encoded(data), declaration: d }), { code: 'replay_worktree_mapping_invalid' });
  }
});

test('large residual namespace is bounded, including arrays that must not be spread onto the host stack', t => {
  const v = inputs(t, 'resume'), data = structuredClone(v.data);
  const entries = blob(data, data.checkpoint.replayInput.sessionBlobHash).trim().split('\r\n').map(JSON.parse);
  entries[1].extra = Array(100001).fill(0);
  changeBlob(data, 'sessionBlobHash', entries.map(JSON.stringify).join('\n') + '\n');
  assert.throws(() => plan({ ...encoded(data), declaration: v.declaration }), { code: 'replay_worktree_mapping_invalid' });
});

test('bounded closed declaration and original capsule verification precede mapping; incomplete inputs remain blocked', t => {
  const v = inputs(t);
  for (const alter of [d => { d.schemaVersion = 2; }, d => { d.sourcePlatform = 'darwin'; }, d => { d.extra = true; },
    d => { d.mappings[0].extra = true; }, d => { d.mappings = Array(257).fill(d.mappings[0]); }]) {
    const d = structuredClone(v.declaration); alter(d); assert.throws(() => plan(v, d), { code: 'replay_worktree_mapping_invalid' });
  }
  assert.throws(() => plan({ ...v, capsule: v.capsule + ' ' }), { code: 'capsule_materials_invalid' });
  const data = structuredClone(v.data); data.checkpoint.replayInput.unverifiedDimensions = ['attachments_unverified'];
  assert.throws(() => plan({ ...encoded(data), declaration: v.declaration }), { code: 'replay_worktree_mapping_invalid' });
  const images = structuredClone(v.data); images.checkpoint.replayInput.invocationImageCount = 1;
  assert.throws(() => plan({ ...encoded(images), declaration: v.declaration }), { code: 'replay_worktree_mapping_invalid' });
  const mismatch = structuredClone(v.data); mismatch.checkpoint.integrity = { platform: 'win32' };
  assert.throws(() => plan({ ...encoded(mismatch), declaration: v.declaration }), { code: 'replay_worktree_mapping_invalid' });
});
