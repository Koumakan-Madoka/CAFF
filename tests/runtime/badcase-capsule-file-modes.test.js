// Static restoration only: never executes captured files or initializes an agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const api = require('../../build/server/domain/runtime/badcase-capture/capsule-materialization');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const expected = p => ({ capsuleHash: p.capsuleHash, checkpointChecksum: p.provenance.checkpointChecksum });
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
function materials(t, mode = 'fresh') {
  const h = fixture(t, mode, ({ cp, put }) => {
    cp.files['source.txt'].mode = 0o100644;
    cp.files['bin/run.sh'] = { type: 'file', size: Buffer.byteLength('#!/bin/sh\n:\n\n'), mode: 0o100755, hash: put('#!/bin/sh\n:\n\n') };
  });
  const p = prepareRetainedInitializationCapsule(h.request);
  return { h, p, e: expected(p) };
}
function encoded(data) { const capsule = JSON.stringify(data); return { capsule, e: { capsuleHash: hash(capsule), checkpointChecksum: hash(JSON.stringify(data.checkpoint)) } }; }
function isolated({ platform = 'linux', changes = {}, replace = s => s } = {}) {
  const filename = path.resolve(__dirname, '../../build/server/domain/runtime/badcase-capture/capsule-materialization.js');
  const local = require('node:module').createRequire(filename), exports = {};
  vm.runInNewContext(replace(fs.readFileSync(filename, 'utf8')), { exports, module: { exports }, Buffer,
    process: { platform }, require: name => name === 'node:fs' ? { ...fs, ...changes } : local(name) }, { filename });
  return exports;
}
const linux = { skip: process.platform !== 'linux' ? 'real POSIX mode verification requires Linux' : false };

test('mode plan validates fresh/resume without writes, binds modes separately from byte manifest and stays non-runnable', t => {
  for (const mode of ['fresh', 'resume']) {
    const { p, e } = materials(t, mode);
    const plan = api.planModePreservingReplayCapsule(p.capsule, e);
    assert.equal(plan.expectedReceipt.deliveryMode, mode);
    assert.equal(plan.expectedReceipt.kind, 'linux-rwx-mode-restoration-v1');
    assert.equal(plan.expectedReceipt.fileModePreserved, true); // EXPECTATION, not observation
    assert.equal(plan.expectedReceipt.piExecuted, false);
    for (const k of ['runnable', 'reproduced', 'evaluable', 'strictEvalEligible']) assert.equal(plan.expectedReceipt[k], false);
    assert.deepEqual(plan.modes, [{ path: 'snapshot/bin/run.sh', mode: 0o755 }, { path: 'snapshot/source.txt', mode: 0o644 }]);
    assert.equal(plan.expectedReceipt.modeInventoryHash, hash(JSON.stringify(plan.modes)));
    const data = JSON.parse(p.capsule); data.checkpoint.files['bin/run.sh'].mode = 0o100644;
    const other = encoded(data), changed = api.planModePreservingReplayCapsule(other.capsule, other.e);
    assert.notEqual(changed.expectedReceipt.modeInventoryHash, plan.expectedReceipt.modeInventoryHash);
    assert.notEqual(changed.expectedReceipt.materializedHash, plan.expectedReceipt.materializedHash, 'byte inventory includes changed checkpoint.json metadata');
    assert.deepEqual(changed.files.filter(f => f.path.startsWith('snapshot/')), plan.files.filter(f => f.path.startsWith('snapshot/')), 'file contents remain unchanged');
    assert.equal(api.decodeInitializationCapsule(p.capsule, e).receipt.fileModePreserved, false, 'legacy data-only diagnostic unchanged');
  }
});

test('missing, malformed, non-file and special permission bits reject before any write rather than defaulting or masking', t => {
  const { h, p } = materials(t);
  for (const mode of [undefined, null, '100755', 0o755, -1, 1.5, 0o040755, 0o120777, 0o104755, 0o102755, 0o101755, 0x100000000 + 0o100755]) {
    const data = JSON.parse(p.capsule); data.checkpoint.files['source.txt'].mode = mode;
    const changed = encoded(data), destination = path.join(h.root, 'must-not-exist');
    let writes = 0;
    const guarded = isolated({ changes: { mkdirSync() { writes++; assert.fail('validation must precede writes'); } } });
    assert.throws(() => guarded.materializeModePreservingReplayCapsule(changed.capsule, changed.e, destination), { code: 'capsule_file_mode_invalid' });
    assert.equal(writes, 0); assert.equal(fs.existsSync(destination), false);
  }
});

test('mode consumer repeats capsule byte/path validation before writes', t => {
  const { h, p, e } = materials(t);
  const destination = path.join(h.root, 'absent');
  assert.throws(() => api.planModePreservingReplayCapsule(p.capsule + ' ', e), { code: 'capsule_materials_invalid' });
  const data = JSON.parse(p.capsule); data.checkpoint.files['../escape'] = data.checkpoint.files['source.txt'];
  const changed = encoded(data);
  assert.throws(() => isolated().materializeModePreservingReplayCapsule(changed.capsule, changed.e, destination), { code: 'capsule_materials_invalid' });
  assert.equal(fs.existsSync(destination), false);
});

test('non-Linux consumer blocks before filesystem writes; planning is host-independent', t => {
  const { p, e } = materials(t);
  for (const platform of ['win32', 'darwin']) {
    let io = 0;
    const off = isolated({ platform, changes: { mkdirSync() { io++; assert.fail('no filesystem write'); } } });
    assert.equal(off.planModePreservingReplayCapsule(p.capsule, e).expectedReceipt.fileModePreserved, true);
    assert.throws(() => off.materializeModePreservingReplayCapsule(p.capsule, e, '/not-used'), { code: 'capsule_mode_platform_unsupported' });
    assert.equal(io, 0);
  }
});

test('Linux restores two independent fresh/resume copies with exact rwx bits under restrictive umask, never executes contents', linux, t => {
  for (const mode of ['fresh', 'resume']) {
    const { h, p, e } = materials(t, mode), plan = api.planModePreservingReplayCapsule(p.capsule, e);
    const a = path.join(h.root, 'a'), b = path.join(h.root, 'b');
    const old = process.umask(0o077);
    try {
      assert.deepEqual(api.materializeModePreservingReplayCapsule(p.capsule, e, a), plan.expectedReceipt);
      assert.deepEqual(api.materializeModePreservingReplayCapsule(p.capsule, e, b), plan.expectedReceipt);
    } finally { process.umask(old); }
    for (const root of [a, b]) {
      for (const f of plan.files) assert.deepEqual(fs.readFileSync(path.join(root, f.path)), f.bytes);
      for (const m of plan.modes) assert.equal(fs.lstatSync(path.join(root, m.path)).mode & 0o7777, m.mode);
      assert.equal(fs.lstatSync(path.join(root, 'materials/checkpoint.json')).mode & 0o777, 0o600);
      assert.equal(fs.lstatSync(path.join(root, 'snapshot')).mode & 0o777, 0o700);
    }
    fs.chmodSync(path.join(a, 'snapshot/bin/run.sh'), 0o600);
    assert.equal(fs.statSync(path.join(b, 'snapshot/bin/run.sh')).mode & 0o777, 0o755);
    assert.throws(() => api.materializeModePreservingReplayCapsule(p.capsule, e, a), { code: 'EEXIST' });
    assert.equal(fs.readdirSync(h.runDir).length, 1, 'restoration does not unpin');
  }
});

test('strict offline wrapper validates expected observed receipt, rejects invalid modes before Docker, never returns output', async t => {
  const { runRetainedModeProbe } = require('../../scripts/badcase-capture/retained-input-probe.cjs');
  const { prepareOfflineTask } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
  const image = { imageId: 'sha256:' + 'a'.repeat(64), repositoryDigest: 'node@sha256:' + 'b'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
  const { h } = materials(t, 'resume'); let calls = 0;
  async function runTask(task, mutate = () => {}) {
    calls++; assert.equal(fs.readdirSync(h.runDir).length, 1);
    const content = name => Buffer.from(task.files.find(f => f.path === name).base64, 'base64').toString();
    assert.match(content('probe.cjs'), /materializeModePreservingReplayCapsule/);
    assert.doesNotMatch(content('probe.cjs'), /execFile|session\.prompt|createAgentSession/);
    const plan = api.planModePreservingReplayCapsule(content('capsule.json'), JSON.parse(content('expected.json')));
    const result = { state: 'completed', cleaned: true, inputHash: prepareOfflineTask(task).inputHash,
      stdout: JSON.stringify(plan.expectedReceipt) + '\n', stderr: '', containerId: 'a'.repeat(64) };
    mutate(result); return result;
  }
  const r = await runRetainedModeProbe(h.request, image, { runTask });
  assert.equal(r.fileModePreserved, true); assert.equal(r.piExecuted, false); assert.equal(r.provenance.launchAuthorized, false);
  assert.equal(Object.hasOwn(r, 'stdout'), false); assert.equal(Object.hasOwn(r, 'stderr'), false);
  for (const mutate of [r => { r.cleaned = false; }, r => { r.inputHash = 'bad'; }, r => { r.state = 'failed'; },
    r => { r.stdout = r.stdout.replace('"fileModePreserved":true', '"fileModePreserved":false'); },
    r => { r.stdout = r.stdout.replace(/"modeInventoryHash":"[a-f0-9]+"/, '"modeInventoryHash":"wrong"'); },
    r => { r.stdout += 'extra'; }, r => { r.stderr = 'unexpected'; }]) {
    await assert.rejects(runRetainedModeProbe(h.request, image, { runTask: task => runTask(task, mutate) }), { code: 'capsule_probe_failed' });
  }
  const noModes = fixture(t), before = calls;
  await assert.rejects(runRetainedModeProbe(noModes.request, image, { runTask }), { code: 'capsule_file_mode_invalid' });
  assert.equal(calls, before, 'no Docker call when mode completeness is missing');
});

test('all ordinary rwx masks including unreadable mode are represented without ownership or special-bit claims', t => {
  const { p } = materials(t);
  for (const permission of [0o000, 0o111, 0o444, 0o600, 0o777]) {
    const data = JSON.parse(p.capsule); data.checkpoint.files['source.txt'].mode = 0o100000 | permission;
    const x = encoded(data), plan = api.planModePreservingReplayCapsule(x.capsule, x.e);
    assert.equal(plan.modes.find(m => m.path === 'snapshot/source.txt').mode, permission);
  }
});

test('Linux mode 000 verifies bytes through the already-open descriptor; mode faults close descriptors', linux, t => {
  const { h, p } = materials(t);
  const data = JSON.parse(p.capsule); data.checkpoint.files['bin/run.sh'].mode = 0o100000;
  const x = encoded(data), dest = path.join(h.root, 'unreadable');
  assert.equal(api.materializeModePreservingReplayCapsule(x.capsule, x.e, dest).fileModePreserved, true);
  assert.equal(fs.statSync(path.join(dest, 'snapshot/bin/run.sh')).mode & 0o777, 0);
  for (const fault of ['chmod', 'content', 'close']) {
    let active = 0, closed = 0;
    const broken = isolated({ changes: {
      openSync(...args) { const fd = fs.openSync(...args); active++; return fd; },
      closeSync(fd) { fs.closeSync(fd); active--; closed++; if (fault === 'close') throw Object.assign(Error('synthetic close'), { code: 'EIO' }); },
      fchmodSync(fd, mode) {
        if (fault === 'chmod') throw Object.assign(Error('synthetic chmod'), { code: 'EPERM' });
        fs.fchmodSync(fd, mode);
      },
      readFileSync(file, ...args) {
        if (fault === 'content' && typeof file === 'number') return Buffer.from('changed');
        return fs.readFileSync(file, ...args);
      },
    } });
    assert.throws(() => broken.materializeModePreservingReplayCapsule(x.capsule, x.e, path.join(h.root, 'fault-' + fault)),
      { code: fault === 'chmod' ? 'EPERM' : fault === 'close' ? 'EIO' : 'capsule_materials_write_failed' });
    assert.equal(active, 0); assert.equal(closed, 1);
  }
});

test('chmod errors and observed mode mismatch never return a success receipt, even when chmod silently does nothing', linux, t => {
  const { h, p, e } = materials(t);
  for (const behavior of ['throw', 'noop', 'extra-special-bit']) {
    const dest = path.join(h.root, behavior);
    const broken = isolated({ changes: {
      fchmodSync(fd, mode) {
        if (behavior === 'throw') throw Object.assign(Error('synthetic'), { code: 'EPERM' });
        if (behavior === 'extra-special-bit') fs.fchmodSync(fd, mode | 0o1000);
      },
    } });
    assert.throws(() => broken.materializeModePreservingReplayCapsule(p.capsule, e, dest),
      { code: behavior === 'throw' ? 'EPERM' : 'capsule_file_mode_mismatch' });
    assert.equal(fs.existsSync(dest), true, 'partial new copy may remain, never success or destructive cleanup');
    assert.equal(fs.readdirSync(h.runDir).length, 1);
  }
});
