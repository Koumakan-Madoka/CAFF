const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveProbeIntent, recoverProbeIntent } = require('../../scripts/badcase-capture/probe-recovery.cjs');
const target = { socket: 'unix:///var/tmp/caff-image-recovery-test/docker.sock', daemonId: 'dedicated', dataRoot: '/var/tmp/caff-image-recovery-test/data' };
const image = { imageId: 'sha256:' + 'a'.repeat(64) };
const owner = '12345678-1234-4234-8234-123456789abc', name = 'caff-pi-init-' + owner, id = 'b'.repeat(64);
function setup(t, fault = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-recovery-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ref = saveProbeIntent(directory, { target, imageId: image.imageId, owner, name });
  let exists = true, running = true;
  const calls = [];
  const fake = require('../helpers/badcase-fake-docker.cjs')(image);
  const ready = fake.run(['create', '--name', name, '--label', 'caff.badcase.offline=' + owner, image.imageId,
    '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/work', 'TMPDIR=/tmp', '/bin/sh', '-c', 'tar --no-same-owner -xf - && timeout -k 2 25 node probe.cjs']);
  const runDocker = async (args, options = {}) => {
    await ready; calls.push({ args, options });
    const result = { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'info') result.stdout = JSON.stringify(options.dockerHost ? { ID: fault === 'daemon' ? 'other' : target.daemonId, DockerRootDir: target.dataRoot, Driver: 'vfs' } : { ID: fault === 'shared' ? target.daemonId : 'shared' });
    else if (args[0] === 'ps') {
      result.stdout = exists ? id + '\n' : '';
      if (fault === 'list') result.code = 1;
      if (fault === 'multiple') result.stdout += 'c'.repeat(64) + '\n';
    } else if (args[0] === 'inspect') {
      const c = JSON.parse((await fake.run(['inspect', id])).stdout)[0];
      c.Name = '/' + name; c.Config.Labels = { 'caff.badcase.pi-initialization': owner }; c.State.Running = running;
      if (fault === 'owner') c.Config.Labels = {};
      if (fault === 'image') c.Image = 'sha256:' + 'c'.repeat(64);
      if (fault === 'name') c.Name += '-other';
      if (fault === 'isolation') c.HostConfig.Privileged = true;
      result.stdout = JSON.stringify([c]);
    } else if (args[0] === 'kill') { if (fault === 'kill') result.code = 1; else if (fault !== 'still-running') running = false; }
    else if (args[0] === 'rm') { if (fault === 'rm') result.code = 1; else if (fault !== 'remaining') exists = false; }
    else throw Error('unexpected control');
    return result;
  };
  return { directory, ref, calls, runDocker, absent() { exists = false; } };
}
test('durable intent is immutable and recovery only cleans exact owned ID; re-read is idempotent and never settles a run', async t => {
  const h = setup(t);
  const original = fs.readFileSync(path.join(h.directory, owner + '.json'));
  assert.throws(() => saveProbeIntent(h.directory, { target, imageId: image.imageId, owner, name }));
  const r = await recoverProbeIntent(h.ref, target, { schedulerStopped: true, runDocker: h.runDocker });
  assert.deepEqual(r, { containerId: id, stopped: true, removed: true, executionState: 'unknown', resultSettled: false });
  assert.deepEqual(h.calls.filter(c => ['kill', 'rm'].includes(c.args[0])).map(c => c.args), [['kill', id], ['rm', id]]);
  assert.ok(h.calls.filter(c => c.args[0] !== 'info' || c.options.dockerHost).every(c => c.options.dockerHost === target.socket));
  assert.deepEqual(fs.readFileSync(path.join(h.directory, owner + '.json')), original);
  assert.deepEqual(await recoverProbeIntent(h.ref, target, { schedulerStopped: true, runDocker: h.runDocker }), { containerId: null, stopped: true, removed: true, executionState: 'unknown', resultSettled: false });
});
test('no stopped confirmation, wrong target, broken intent and filesystem links fail before Docker', async t => {
  const h = setup(t);
  await assert.rejects(recoverProbeIntent(h.ref, target, { runDocker: h.runDocker }));
  await assert.rejects(recoverProbeIntent(h.ref, { ...target, daemonId: 'changed' }, { schedulerStopped: true, runDocker: h.runDocker }));
  const file = path.join(h.directory, owner + '.json'), original = fs.readFileSync(file);
  fs.writeFileSync(file, '{');
  await assert.rejects(recoverProbeIntent(h.ref, target, { schedulerStopped: true, runDocker: h.runDocker }));
  fs.writeFileSync(file, original);
  const moved = h.directory + '-moved'; fs.renameSync(h.directory, moved);
  try {
    fs.symlinkSync(moved, h.directory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(recoverProbeIntent(h.ref, target, { schedulerStopped: true, runDocker: h.runDocker }));
  } finally { if (fs.existsSync(h.directory)) fs.unlinkSync(h.directory); fs.renameSync(moved, h.directory); }
  assert.equal(h.calls.length, 0);
});
test('bounded intent integrity, file links and unsafe names reject before Docker', async t => {
  const h = setup(t), file = path.join(h.directory, owner + '.json'), original = fs.readFileSync(file);
  for (const content of [Buffer.alloc(4097, 32), Buffer.from('{}'), Buffer.from(original.toString().replace(image.imageId, 'sha256:' + 'c'.repeat(64)))]) {
    fs.writeFileSync(file, content);
    await assert.rejects(recoverProbeIntent(h.ref, target, { schedulerStopped: true, runDocker: h.runDocker }));
  }
  fs.writeFileSync(file, original);
  await assert.rejects(recoverProbeIntent({ ...h.ref, owner: '../outside' }, target, { schedulerStopped: true, runDocker: h.runDocker }));
  const decoy = path.join(h.directory, 'decoy'); fs.renameSync(file, decoy);
  try {
    fs.symlinkSync(decoy, file);
    await assert.rejects(recoverProbeIntent(h.ref, target, { schedulerStopped: true, runDocker: h.runDocker }));
  } catch (e) { if (e.code !== 'EPERM') throw e; t.diagnostic('file symlink privilege unavailable; Linux verifies this branch'); }
  assert.equal(h.calls.length, 0); assert.deepEqual(fs.readFileSync(decoy), original);
});
test('unacknowledged intent fsync is retained and cannot be overwritten', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-intent-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw Error('synthetic-sync-failure'); };
    assert.throws(() => saveProbeIntent(directory, { target, imageId: image.imageId, owner, name }), /synthetic-sync-failure/);
  } finally { fs.fsyncSync = sync; }
  assert.ok(fs.existsSync(path.join(directory, owner + '.json')));
  assert.throws(() => saveProbeIntent(directory, { target, imageId: image.imageId, owner, name }));
});
test('daemon, ownership, isolation and control failures never authorize broad or forced deletion', async t => {
  for (const fault of ['daemon', 'shared', 'list', 'multiple', 'owner', 'image', 'name', 'isolation', 'kill', 'still-running', 'rm', 'remaining']) {
    const h = setup(t, fault);
    await assert.rejects(recoverProbeIntent(h.ref, target, { schedulerStopped: true, runDocker: h.runDocker }), undefined, fault);
    if (!['kill', 'still-running', 'rm', 'remaining'].includes(fault)) assert.equal(h.calls.some(c => ['kill', 'rm'].includes(c.args[0])), false, fault);
    if (['kill', 'still-running'].includes(fault)) assert.equal(h.calls.some(c => c.args[0] === 'rm'), false);
    for (const c of h.calls.filter(c => ['kill', 'rm'].includes(c.args[0]))) assert.deepEqual(c.args, [c.args[0], id]);
  }
});
