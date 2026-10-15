const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { archiveImage } = require('../../scripts/badcase-capture/image-archive.cjs');
const { restoreImageArchive } = require('../../scripts/badcase-capture/image-recovery.cjs');
const image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
const target = { socket: 'unix:///var/tmp/caff-image-recovery-test/docker.sock', daemonId: 'isolated-id', dataRoot: '/var/tmp/caff-image-recovery-test/data' };
const ok = v => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-recovery-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const img = { Id: image.imageId, RepoDigests: [image.repositoryDigest], Architecture: 'amd64', Os: 'linux', Config: {}, RootFS: { Type: 'layers', Layers: ['sha256:' + '3'.repeat(64)] } };
  const ref = await archiveImage(image, path.join(root, 'archive'), { runDocker: async a => ok(a[0] === 'context' ? [{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }] : [img]), save: async (_, fd) => fs.writeSync(fd, 'trusted opaque image fixture') });
  const calls = []; let loaded = false;
  const state = { finished: false, removed: false, img: { ...img, RepoDigests: [] }, info: { ID: target.daemonId, DockerRootDir: target.dataRoot, Driver: 'vfs', Images: 0, Containers: 0 }, sharedId: 'shared-id', loadFails: false };
  const runDocker = async (a, o = {}) => {
    calls.push({ a, o });
    if (a[0] === 'info') return ok(o.dockerHost ? { ...state.info, Images: loaded ? 1 : state.info.Images } : { ID: state.sharedId });
    if (a[1] === 'load') { loaded = true; return state.loadFails ? { code: 1, stdout: '', stderr: 'not returned' } : ok({}); }
    if (a[1] === 'inspect') return ok([state.img]);
    if (a[0] === 'ps') return { code: 0, stdout: state.removed ? '' : 'a'.repeat(64) + '\n', stderr: '' };
    if (a[0] === 'inspect') return ok([{ Id: 'a'.repeat(64), Image: image.imageId,
      Config: { Labels: { 'caff.badcase.pi-initialization': 'probe-owner' } }, State: { Running: false,
        StartedAt: state.finished ? '2026-01-01T00:00:00Z' : '0001-01-01T00:00:00Z', ExitCode: 0, OOMKilled: false } }]);
    throw Error('unexpected command');
  };
  return { ref, state, calls, options: { runDocker }, root };
}
test('restores missing RepoDigest honestly and binds all subsequent commands to isolated daemon', async t => {
  const h = await fixture(t), r = await restoreImageArchive(h.ref, target, h.options);
  assert.deepEqual(r.identity, { imageId: image.imageId, declaredRepositoryDigest: image.repositoryDigest, observedRepositoryDigests: [], archiveHash: h.ref.archiveHash, architecture: 'amd64', os: 'linux', source: 'trusted-archive', runtimeVersionsVerified: false });
  let received;
  const result = await r.runProbe(image, [], { timeoutMs: 1234, probe: async (i, f, options) => {
    assert.equal(options.timeoutMs, 1234);
    received = options; await options.observeCreated('a'.repeat(64), 'probe-owner');
    h.state.finished = true; await options.observeCompleted('a'.repeat(64), 'probe-owner', { code: 0 });
    h.state.removed = true; await options.observeRemoved('a'.repeat(64));
    return { containerId: 'a'.repeat(64) };
  } });
  assert.equal(result.containerId, 'a'.repeat(64));
  assert.ok(h.calls.some(c => c.a[0] === 'inspect' && c.a[1] === result.containerId && c.o.dockerHost === target.socket));
  await received.runDocker(['info', '--format', '{{json .}}']);
  assert.equal(h.calls.at(-1).o.dockerHost, target.socket);
  assert.ok(h.calls.filter(c => c.a[0] !== 'info').every(c => c.o.dockerHost === target.socket));
});
test('invalid deadline is rejected before target inspection or probe', async t => {
  const h = await fixture(t), r = await restoreImageArchive(h.ref, target, h.options), count = h.calls.length;
  for (const timeoutMs of [null, 0, -1, 1.2, 25001, '1000']) {
    await assert.rejects(r.runProbe(image, [], { timeoutMs, probe: () => assert.fail('must not run') }), /probe_timeout_invalid/);
  }
  assert.equal(h.calls.length, count);
});
test('probe without target-daemon observation or with mismatched result ID fails closed', async t => {
  const h = await fixture(t), r = await restoreImageArchive(h.ref, target, h.options);
  await assert.rejects(r.runProbe(image, [], { probe: async () => ({ containerId: 'a'.repeat(64) }) }), /image_recovery_probe_unobserved/);
  await assert.rejects(r.runProbe(image, [], { probe: async (_, __, options) => {
    await options.observeCreated('a'.repeat(64), 'probe-owner'); return { containerId: 'b'.repeat(64) };
  } }));
});
test('observation independently rejects missing, wrong owner, wrong ID and running target container', async t => {
  for (const result of [{ code: 1, stdout: '', stderr: '' }, ok([{ Id: 'b'.repeat(64) }]),
    ok([{ Id: 'a'.repeat(64), Image: image.imageId, Config: { Labels: { 'caff.badcase.pi-initialization': 'wrong' } }, State: { Running: false } }]),
    ok([{ Id: 'a'.repeat(64), Image: image.imageId, Config: { Labels: { 'caff.badcase.pi-initialization': 'probe-owner' } }, State: { Running: true } }])]) {
    const h = await fixture(t), run = h.options.runDocker;
    h.options.runDocker = (args, options) => args[0] === 'inspect' ? result : run(args, options);
    const r = await restoreImageArchive(h.ref, target, h.options);
    await assert.rejects(r.runProbe(image, [], { probe: async (_, __, options) => {
      await options.observeCreated('a'.repeat(64), 'probe-owner'); return { containerId: 'a'.repeat(64) };
    } }));
  }
});
test('completion and removal observations independently reject omitted stages, never-started container and leftover ID', async t => {
  for (const fault of ['omit-completed', 'omit-removed', 'not-started', 'not-removed']) {
    const h = await fixture(t), restored = await restoreImageArchive(h.ref, target, h.options);
    await assert.rejects(restored.runProbe(image, [], { probe: async (_, __, o) => {
      await o.observeCreated('a'.repeat(64), 'probe-owner');
      h.state.finished = fault !== 'not-started';
      if (fault !== 'omit-completed') await o.observeCompleted('a'.repeat(64), 'probe-owner', { code: 0 });
      h.state.removed = fault !== 'not-removed';
      if (fault !== 'omit-removed') await o.observeRemoved('a'.repeat(64));
      return { containerId: 'a'.repeat(64) };
    } }));
    assert.ok(h.calls.filter(c => c.a[0] === 'inspect' || c.a[0] === 'ps').every(c => c.o.dockerHost === target.socket));
  }
});
test('completion rejects wrong exit status, wrong owner, wrong image and live or OOM container', async t => {
  for (const change of [c => { c.Image = 'other'; }, c => { c.Config.Labels = {}; }, c => { c.State.ExitCode = 9; },
    c => { c.State.Running = true; }, c => { c.State.OOMKilled = true; }]) {
    const h = await fixture(t), run = h.options.runDocker;
    h.options.runDocker = async (a, o) => { const r = await run(a, o);
      if (a[0] === 'inspect' && h.state.finished) { const c = JSON.parse(r.stdout)[0]; change(c); return ok([c]); } return r; };
    const restored = await restoreImageArchive(h.ref, target, h.options);
    await assert.rejects(restored.runProbe(image, [], { probe: async (_, __, o) => {
      await o.observeCreated('a'.repeat(64), 'probe-owner'); h.state.finished = true;
      await o.observeCompleted('a'.repeat(64), 'probe-owner', { code: 0 });
      h.state.removed = true; await o.observeRemoved('a'.repeat(64)); return { containerId: 'a'.repeat(64) };
    } }));
  }
});
test('bad archive rejected before any Docker command', async t => {
  const h = await fixture(t);
  await assert.rejects(restoreImageArchive({ ...h.ref, archiveHash: '0'.repeat(64) }, target, h.options));
  assert.equal(h.calls.length, 0);
});
test('shared/nonempty/wrong-root daemon never receives load', async t => {
  for (const change of [{ sharedId: target.daemonId }, { info: { ID: target.daemonId, DockerRootDir: target.dataRoot, Driver: 'vfs', Images: 1, Containers: 0 } }, { info: { ID: target.daemonId, DockerRootDir: '/production', Driver: 'vfs', Images: 0, Containers: 0 } }]) {
    const h = await fixture(t); Object.assign(h.state, change);
    await assert.rejects(restoreImageArchive(h.ref, target, h.options));
    assert.equal(h.calls.some(c => c.a[1] === 'load'), false);
  }
});
test('load error, wrong image, architecture and unsafe image configuration rejected', async t => {
  for (const mutation of [h => h.state.loadFails = true, h => h.state.img.Id = 'sha256:' + '9'.repeat(64), h => h.state.img.Architecture = 'arm64', h => h.state.img.Config = { Volumes: { '/host': {} } }]) {
    const h = await fixture(t); mutation(h);
    await assert.rejects(restoreImageArchive(h.ref, target, h.options));
  }
});
test('transport rechecks daemon and image, cannot use a different template', async t => {
  const h = await fixture(t), r = await restoreImageArchive(h.ref, target, h.options);
  let calls = 0; const options = { probe: async () => { calls++; } };
  await assert.rejects(r.runProbe({ ...image, imageId: 'sha256:' + '9'.repeat(64) }, [], options));
  h.state.info.ID = 'replacement-daemon';
  await assert.rejects(r.runProbe(image, [], options));
  h.state.info.ID = target.daemonId; h.state.img.Os = 'windows';
  await assert.rejects(r.runProbe(image, [], options));
  assert.equal(calls, 0);
});
test('invalid sockets and shared socket names fail before any command', async t => {
  const h = await fixture(t);
  for (const socket of ['unix:///var/run/docker.sock', 'tcp://localhost:2375', 'unix:///var/tmp/caff-image-recovery-test/../docker.sock']) {
    await assert.rejects(restoreImageArchive(h.ref, { ...target, socket }, h.options));
  }
  assert.equal(h.calls.length, 0);
});
