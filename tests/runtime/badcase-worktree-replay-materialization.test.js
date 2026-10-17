// Static working-copy staging only. No SDK/model or captured executable runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const { decodeInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/capsule-materialization');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const api = () => require('../../build/server/domain/runtime/badcase-capture/worktree-replay-materialization');
const linux = { skip: process.platform !== 'linux' ? 'real Linux working-copy writes required' : false };
function inputs(t, mode = 'fresh', platform = 'linux') {
  const root = platform === 'win32' ? 'C:\\source\\project' : '/source/project';
  const h = fixture(t, mode, ({ cp, r, config, session, put }) => {
    cp.targetDir = root; cp.files['source.txt'].mode = 0o100644;
    const content = '#!/bin/sh\nexit 77\n';
    cp.files['bin/never-run.sh'] = { type: 'file', mode: 0o100755, size: Buffer.byteLength(content), hash: put(content) };
    r.promptBlobHash = r.normalizedPromptHash = put('Inspect ' + root + '\n{{CAFF_CHAT_API_URL}}');
    r.controlledReplacements = [{ name: 'CAFF_CHAT_API_URL', count: 1 }];
    config.toolBridgeEnabled = true; config.futureConfig = { preserved: ['unchanged'] };
    r.harness.configSnapshotHash = put(JSON.stringify(config));
    r.runConfig.skillIds = ['s1'];
    const skill = put('Synthetic skill data only.');
    r.harness.skillSnapshots = [{ id: 's1', source: 'synthetic', blobHash: skill, sha256: skill }];
    if (mode === 'resume') { session[0].cwd = root; r.sessionBlobHash = put(session.map(e => JSON.stringify(e)).join('\r\n') + '\r\n'); }
  });
  const p = prepareRetainedInitializationCapsule(h.request);
  const expected = { capsuleHash: p.capsuleHash, checkpointChecksum: p.provenance.checkpointChecksum };
  const declaration = { schemaVersion: 1, sourcePlatform: platform, sourceRoot: root, mappings: [
    { input: 'prompt', start: 8, end: 8 + root.length, sourcePath: root },
    ...(mode === 'resume' ? [{ input: 'session', line: 0, pointer: '/cwd', start: 0, end: root.length, sourcePath: root }] : []),
  ] };
  return { h, p, expected, declaration };
}
function plan(v) { return api().planWorktreeReplayMaterialization(v.p.capsule, v.expected, v.declaration); }
function isolated({ platform = 'linux', changes = {}, restore } = {}) {
  const filename = path.resolve(__dirname, '../../build/server/domain/runtime/badcase-capture/worktree-replay-materialization.js');
  const local = require('node:module').createRequire(filename), exports = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, module: { exports }, Buffer, structuredClone,
    process: { platform }, require: name => name === 'node:fs' ? { ...fs, ...changes } : name === './capsule-materialization' && restore
      ? { ...local(name), materializeModePreservingReplayCapsule: restore } : local(name) }, { filename });
  return exports;
}

test('pure plan combines complete mapped inputs and mode restoration without stripping config, skills or archive', t => {
  for (const mode of ['fresh', 'resume']) for (const platform of ['linux', 'win32']) {
    const v = inputs(t, mode, platform), before = v.p.capsule, d = structuredClone(v.declaration), p = plan(v);
    const names = p.files.map(f => f.path);
    assert.deepEqual(names, ['controlled-replacements.json', 'declaration.json', 'harness.json', 'prompt.txt', 'run-config.json',
      ...(mode === 'resume' ? ['session.jsonl'] : []), 'skill-snapshots.json']);
    const read = n => p.files.find(f => f.path === n).bytes.toString();
    assert.equal(read('prompt.txt'), 'Inspect /work/restored/snapshot\n{{CAFF_CHAT_API_URL}}');
    assert.equal(JSON.parse(read('harness.json')).toolBridgeEnabled, true);
    assert.deepEqual(JSON.parse(read('harness.json')).futureConfig, { preserved: ['unchanged'] });
    assert.deepEqual(JSON.parse(read('run-config.json')).skillIds, ['s1']);
    assert.deepEqual(JSON.parse(read('controlled-replacements.json')), [{ name: 'CAFF_CHAT_API_URL', count: 1 }]);
    assert.deepEqual(JSON.parse(read('declaration.json')), d);
    assert.equal(JSON.parse(read('skill-snapshots.json'))[0].id, 's1');
    assert.equal(p.expectedReceipt.kind, 'worktree-replay-materialization-v1');
    assert.equal(p.expectedReceipt.deliveryMode, mode);
    assert.equal(p.expectedReceipt.workingInputHash, hash(JSON.stringify(p.files.map(f => ({ path: f.path, size: f.bytes.length, sha256: hash(f.bytes) })))));
    assert.equal(p.expectedReceipt.workingInputCount, p.files.length);
    assert.equal(p.expectedReceipt.fileModePreserved, true); // expectation, NOT observation
    for (const key of ['piExecuted', 'launchAuthorized', 'runnable', 'reproduced', 'evaluable', 'strictEvalEligible']) assert.equal(p.expectedReceipt[key], false);
    if (mode === 'resume') assert.ok(read('session.jsonl').endsWith('\r\n'));
    assert.equal(v.p.capsule, before); assert.deepEqual(v.declaration, d);
    p.files[0].bytes.fill(0); assert.notDeepEqual(plan(v).files[0].bytes, p.files[0].bytes);
  }
});

test('mapping/capsule/mode failures precede restoration and all filesystem writes', t => {
  const v = inputs(t, 'resume'); let writes = 0, restores = 0;
  const consumer = isolated({ changes: { mkdirSync() { writes++; } }, restore() { restores++; } });
  for (const [capsule, expected, declaration] of [[v.p.capsule + ' ', v.expected, v.declaration],
    [v.p.capsule, v.expected, { ...v.declaration, mappings: [] }]]) {
    assert.throws(() => consumer.materializeWorktreeReplayInputs(capsule, expected, declaration, path.join(v.h.root, 'absent')));
    assert.equal(writes, 0); assert.equal(restores, 0);
  }
  const data = JSON.parse(v.p.capsule); delete data.checkpoint.files['source.txt'].mode;
  const capsule = JSON.stringify(data), expected = { capsuleHash: hash(capsule), checkpointChecksum: hash(JSON.stringify(data.checkpoint)) };
  assert.throws(() => consumer.materializeWorktreeReplayInputs(capsule, expected, v.declaration, '/not-used'), { code: 'capsule_file_mode_invalid' });
  assert.equal(writes, 0); assert.equal(restores, 0);
});

test('missing run config or replacement inventory never becomes omitted working material or a guessed default', t => {
  const v = inputs(t);
  for (const [key, value] of [['runConfig', undefined], ['runConfig', null], ['runConfig', []],
    ['controlledReplacements', undefined], ['controlledReplacements', null], ['controlledReplacements', {}]]) {
    const data = JSON.parse(v.p.capsule); data.checkpoint.replayInput[key] = value;
    const capsule = JSON.stringify(data), expected = { capsuleHash: hash(capsule), checkpointChecksum: hash(JSON.stringify(data.checkpoint)) };
    assert.throws(() => api().planWorktreeReplayMaterialization(capsule, expected, v.declaration), { code: 'replay_working_copy_inputs_invalid' });
  }
});

test('non-Linux staging is blocked before restore/write; pure planning remains portable', t => {
  const v = inputs(t); let calls = 0;
  for (const platform of ['win32', 'darwin']) {
    const off = isolated({ platform, changes: { mkdirSync() { calls++; } }, restore() { calls++; } });
    assert.equal(off.planWorktreeReplayMaterialization(v.p.capsule, v.expected, v.declaration).expectedReceipt.deliveryMode, 'fresh');
    assert.throws(() => off.materializeWorktreeReplayInputs(v.p.capsule, v.expected, v.declaration, '/unused'), { code: 'replay_working_copy_platform_unsupported' });
    assert.equal(calls, 0);
  }
});

test('restore failure or mismatched observation never writes working inputs or returns success', t => {
  const v = inputs(t); let writes = 0;
  const good = { materializedHash: plan(v).expectedReceipt.materializedHash, modeInventoryHash: plan(v).expectedReceipt.modeInventoryHash, fileModePreserved: true };
  for (const restore of [() => { throw Object.assign(Error('synthetic'), { code: 'EIO' }); },
    () => ({ ...good, materializedHash: 'wrong' }), () => ({ ...good, modeInventoryHash: 'wrong' }), () => ({ ...good, fileModePreserved: false })]) {
    const off = isolated({ changes: { mkdirSync() { writes++; } }, restore });
    assert.throws(() => off.materializeWorktreeReplayInputs(v.p.capsule, v.expected, v.declaration, '/unused'));
    assert.equal(writes, 0);
  }
});

test('Linux two independent fresh/resume working copies preserve full archive and exact modes; never execute scripts', linux, t => {
  for (const mode of ['fresh', 'resume']) for (const platform of ['linux', 'win32']) {
    const v = inputs(t, mode, platform), p = plan(v), destinations = ['a', 'b'].map(n => path.join(v.h.root, n));
    const old = process.umask(0o077);
    try {
      for (const destination of destinations) {
        let actual;
        assert.doesNotThrow(() => { actual = api().materializeWorktreeReplayInputs(v.p.capsule, v.expected, v.declaration, destination); });
        assert.deepEqual(actual, p.expectedReceipt);
        for (const f of p.files) {
          const target = path.join(destination, 'working-inputs', f.path);
          assert.deepEqual(fs.readFileSync(target), f.bytes); assert.equal(fs.statSync(target).mode & 0o777, 0o600);
        }
        for (const f of decodeInitializationCapsule(v.p.capsule, v.expected).files) assert.deepEqual(fs.readFileSync(path.join(destination, f.path)), f.bytes);
        assert.equal(fs.statSync(path.join(destination, 'snapshot/bin/never-run.sh')).mode & 0o777, 0o755);
        assert.equal(fs.statSync(path.join(destination, 'working-inputs')).mode & 0o777, 0o700);
        assert.equal(fs.existsSync(path.join(destination, 'working-inputs/session.jsonl')), mode === 'resume');
      }
    } finally { process.umask(old); }
    fs.writeFileSync(path.join(destinations[0], 'working-inputs/prompt.txt'), 'changed');
    assert.equal(fs.readFileSync(path.join(destinations[1], 'working-inputs/prompt.txt'), 'utf8'), 'Inspect /work/restored/snapshot\n{{CAFF_CHAT_API_URL}}');
    assert.throws(() => api().materializeWorktreeReplayInputs(v.p.capsule, v.expected, v.declaration, destinations[0]), { code: 'EEXIST' });
    assert.equal(fs.readdirSync(v.h.runDir).length, 1, 'no run-reference release');
  }
});

test('Linux working-input write/read/mode/close errors close opened fd and never return receipt', linux, t => {
  const v = inputs(t);
  for (const fault of ['open', 'write', 'read', 'mode', 'close']) {
    let active = 0, closes = 0;
    const consumer = isolated({ changes: {
      openSync(...args) { if (fault === 'open') throw Object.assign(Error('synthetic'), { code: 'EIO' }); active++; return fs.openSync(...args); },
      closeSync(fd) { fs.closeSync(fd); active--; closes++; if (fault === 'close') throw Object.assign(Error('synthetic'), { code: 'EIO' }); },
      writeFileSync(...args) { if (fault === 'write') throw Object.assign(Error('synthetic'), { code: 'ENOSPC' }); return fs.writeFileSync(...args); },
      readSync(...args) { const n = fs.readSync(...args); if (fault === 'read' && n) args[1][0] ^= 1; return n; },
      fchmodSync(fd, mode) { fs.fchmodSync(fd, fault === 'mode' ? 0o644 : mode); },
    } });
    assert.throws(() => consumer.materializeWorktreeReplayInputs(v.p.capsule, v.expected, v.declaration, path.join(v.h.root, fault)));
    assert.equal(active, 0); assert.equal(closes, fault === 'open' ? 0 : 1);
    assert.equal(fs.readdirSync(v.h.runDir).length, 1);
  }
});

test('static Docker wrapper stages the new fixed entry and rejects forged receipts/cleanup before exposing results', async t => {
  const { runRetainedWorktreeProbe } = require('../../scripts/badcase-capture/retained-input-probe.cjs');
  const { prepareOfflineTask } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
  const v = inputs(t, 'resume'); let calls = 0;
  const image = { imageId: 'sha256:' + 'a'.repeat(64), repositoryDigest: 'node@sha256:' + 'b'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
  async function runTask(task, mutate = () => {}) {
    calls++;
    const read = n => Buffer.from(task.files.find(f => f.path === n).base64, 'base64').toString();
    assert.match(read('probe.cjs'), /materializeWorktreeReplayInputs/);
    assert.doesNotThrow(() => new vm.Script(read('probe.cjs')), 'fixed container entry must be valid JavaScript');
    assert.doesNotMatch(read('probe.cjs'), /execFile|session\.prompt|createAgentSession/);
    for (const name of ['worktree-replay-inputs.js', 'worktree-replay-materialization.js']) assert.ok(read(name).length > 0);
    assert.deepEqual(JSON.parse(read('declaration.json')), v.declaration);
    const p = api().planWorktreeReplayMaterialization(read('capsule.json'), JSON.parse(read('expected.json')), JSON.parse(read('declaration.json')));
    const result = { state: 'completed', cleaned: true, inputHash: prepareOfflineTask(task).inputHash,
      stdout: JSON.stringify(p.expectedReceipt) + '\n', stderr: '', containerId: 'a'.repeat(64) };
    mutate(result); return result;
  }
  const r = await runRetainedWorktreeProbe(v.h.request, v.declaration, image, { runTask });
  assert.equal(r.deliveryMode, 'resume'); assert.equal(r.piExecuted, false); assert.equal(r.provenance.launchAuthorized, false);
  assert.equal(Object.hasOwn(r, 'stdout'), false); assert.equal(Object.hasOwn(r, 'stderr'), false);
  for (const mutate of [r => { r.cleaned = false; }, r => { r.state = 'failed'; }, r => { r.inputHash = 'wrong'; },
    r => { r.containerId = 'not-an-id'; }, r => { r.stderr = 'unexpected'; }, r => { r.stdout += 'extra'; },
    r => { r.stdout = r.stdout.replace('worktree-replay-materialization-v1', 'other'); }]) {
    await assert.rejects(runRetainedWorktreeProbe(v.h.request, v.declaration, image, { runTask: task => runTask(task, mutate) }), { code: 'replay_working_copy_probe_failed' });
  }
  const before = calls;
  await assert.rejects(runRetainedWorktreeProbe(v.h.request, { ...v.declaration, mappings: [] }, image, { runTask }), { code: 'replay_worktree_mapping_invalid' });
  assert.equal(calls, before);
});
