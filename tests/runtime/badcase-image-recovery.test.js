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
  const state = { img: { ...img, RepoDigests: [] }, info: { ID: target.daemonId, DockerRootDir: target.dataRoot, Driver: 'vfs', Images: 0, Containers: 0 }, sharedId: 'shared-id', loadFails: false };
  const runDocker = async (a, o = {}) => {
    calls.push({ a, o });
    if (a[0] === 'info') return ok(o.dockerHost ? { ...state.info, Images: loaded ? 1 : state.info.Images } : { ID: state.sharedId });
    if (a[1] === 'load') { loaded = true; return state.loadFails ? { code: 1, stdout: '', stderr: 'not returned' } : ok({}); }
    if (a[1] === 'inspect') return ok([state.img]);
    throw Error('unexpected command');
  };
  return { ref, state, calls, options: { runDocker }, root };
}
test('restores missing RepoDigest honestly and binds all subsequent commands to isolated daemon', async t => {
  const h = await fixture(t), r = await restoreImageArchive(h.ref, target, h.options);
  assert.deepEqual(r.identity, { imageId: image.imageId, declaredRepositoryDigest: image.repositoryDigest, observedRepositoryDigests: [], archiveHash: h.ref.archiveHash, architecture: 'amd64', os: 'linux', source: 'trusted-archive', runtimeVersionsVerified: false });
  let received;
  const result = await r.runProbe(image, [], { probe: async (i, f, options) => { received = options; return 42; } });
  assert.equal(result, 42);
  await received.runDocker(['info', '--format', '{{json .}}']);
  assert.equal(h.calls.at(-1).o.dockerHost, target.socket);
  assert.ok(h.calls.filter(c => c.a[0] !== 'info').every(c => c.o.dockerHost === target.socket));
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
