// Trusted offline archive restore into a separately managed, disposable daemon.
// No HTTP/agent entry point. The lifecycle owner verifies namespaces and stops the
// daemon; this module verifies routing/storage identity. Same-user files/daemon are TCB.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { verifyImageArchive } = require('./image-archive.cjs');
const { runDockerCommand } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const { runProbe } = require('./verify-pi-initialization.cjs');
const good = r => r && r.code === 0 && !r.failure;
function json(r) { assert.ok(good(r), 'image_recovery_control_failed'); return JSON.parse(r.stdout); }
function imageIdentity(img, image) {
  assert.equal(img.Id, image.imageId); assert.equal(img.Architecture, image.architecture); assert.equal(img.Os, 'linux');
  assert.ok(Array.isArray(img.RepoDigests) && img.RepoDigests.every(x => typeof x === 'string'));
  assert.ok(img.Config); assert.equal(Object.keys(img.Config.Volumes || {}).length, 0);
  assert.equal((img.Config.OnBuild || []).length, 0);
  assert.ok(!img.Config.Healthcheck?.Test?.length || img.Config.Healthcheck.Test[0] === 'NONE');
  // RepoDigests may be empty after docker load. Identity is pinned to the image's
  // config digest (which also commits to uncompressed layer digests), not a forged tag.
}
async function restoreImageArchive(reference, destination, options = {}) {
  // Clone declarations before awaits; never accept a caller changing the target mid-load.
  const target = JSON.parse(JSON.stringify(destination));
  assert.deepEqual(Object.keys(target).sort(), ['daemonId', 'dataRoot', 'socket']);
  assert.match(target.socket, /^unix:\/\/\/var\/tmp\/caff-image-recovery-[A-Za-z0-9_-]+\/docker\.sock$/);
  const directory = target.socket.slice('unix://'.length, -'/docker.sock'.length);
  assert.equal(target.dataRoot, directory + '/data'); assert.ok(typeof target.daemonId === 'string' && target.daemonId.length > 0);
  const ref = { ...reference }, verified = verifyImageArchive(ref);
  const image = Object.freeze({ ...verified.image });
  if (!options.runDocker) {
    assert.equal(process.platform, 'linux');
    const st = fs.lstatSync(directory), socket = fs.lstatSync(directory + '/docker.sock');
    assert.ok(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0);
    assert.ok(socket.isSocket() && !socket.isSymbolicLink() && st.uid === process.getuid() && socket.uid === st.uid);
  }
  const run = options.runDocker || runDockerCommand;
  const local = (args, opts = {}) => run(args, { ...opts, dockerHost: target.socket });
  const shared = json(await run(['info', '--format', '{{json .}}']));
  assert.ok(shared.ID && shared.ID !== target.daemonId, 'image_recovery_shared_daemon');
  async function checkDaemon(empty = false) {
    const info = json(await local(['info', '--format', '{{json .}}']));
    assert.equal(info.ID, target.daemonId); assert.equal(info.DockerRootDir, target.dataRoot); assert.equal(info.Driver, 'vfs');
    assert.ok(!info.ServerErrors?.length);
    if (empty) { assert.equal(info.Images, 0); assert.equal(info.Containers, 0); }
  }
  async function inspect() {
    const entries = json(await local(['image', 'inspect', image.imageId]));
    assert.ok(Array.isArray(entries) && entries.length === 1); imageIdentity(entries[0], image); return entries[0];
  }
  await checkDaemon(true);
  // Only a previously verified trusted self-export is loaded. No arbitrary tar upload,
  // pull or host fallback. Paths and byte stability rely on the same-OS-user TCB.
  assert.ok(good(await local(['image', 'load', '--input', path.join(ref.directory, 'image.tar')], { timeoutMs: 120000 })), 'image_recovery_load_failed');
  verifyImageArchive(ref); await checkDaemon();
  const observed = await inspect();
  const identity = { imageId: image.imageId, declaredRepositoryDigest: image.repositoryDigest,
    observedRepositoryDigests: [...observed.RepoDigests], archiveHash: ref.archiveHash,
    architecture: image.architecture, os: 'linux', source: 'trusted-archive', runtimeVersionsVerified: false };
  return { identity, image, async runProbe(requestedImage, files, probeOptions = {}) {
    const timeoutMs = Object.hasOwn(probeOptions, 'timeoutMs') ? probeOptions.timeoutMs : 25000;
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 25000, 'probe_timeout_invalid');
    assert.deepEqual(requestedImage, image); await checkDaemon(); await inspect();
    let observedId = null, observedOwner = null, completed = false, removed = false;
    const observeCreated = async (id, owner) => {
      assert.equal(observedId, null); assert.match(id, /^[a-f0-9]{64}$/);
      assert.ok(typeof owner === 'string' && owner.length > 0);
      // Independent target transport: do not trust the probe's own inspect result.
      // Before execution/cleanup the exact ID must exist on THIS daemon.
      const entries = json(await local(['inspect', id]));
      assert.ok(Array.isArray(entries) && entries.length === 1);
      const container = entries[0];
      assert.equal(container.Id, id); assert.equal(container.Image, image.imageId);
      assert.equal(container.Config?.Labels?.['caff.badcase.pi-initialization'], owner);
      assert.equal(container.State?.Running, false);
      observedId = id; observedOwner = owner;
    };
    const observeCompleted = async (id, owner, execution) => {
      assert.equal(id, observedId); assert.equal(owner, observedOwner); assert.equal(completed, false);
      const entries = json(await local(['inspect', id]));
      assert.ok(Array.isArray(entries) && entries.length === 1);
      const c = entries[0];
      assert.equal(c.Id, id); assert.equal(c.Image, image.imageId);
      assert.equal(c.Config?.Labels?.['caff.badcase.pi-initialization'], owner);
      assert.equal(c.State?.Running, false); assert.equal(c.State?.OOMKilled, false);
      assert.ok(typeof c.State?.StartedAt === 'string' && Date.parse(c.State.StartedAt) > 0, 'image_recovery_probe_not_started');
      assert.ok(Number.isInteger(execution?.code)); assert.equal(c.State.ExitCode, execution.code);
      completed = true;
    };
    const observeRemoved = async id => {
      // Also runs during failure cleanup, including a rejected creation observer.
      assert.match(id, /^[a-f0-9]{64}$/);
      if (observedId) assert.equal(id, observedId);
      const remaining = await local(['ps', '-a', '--no-trunc', '--filter', 'id=' + id, '--format', '{{.ID}}']);
      assert.ok(good(remaining) && remaining.stdout.trim() === '', 'image_recovery_probe_not_removed');
      removed = true;
    };
    const result = await (probeOptions.probe || runProbe)(image, files, {
      timeoutMs,
      runDocker: local, observeCreated, observeCompleted, observeRemoved });
    assert.ok(observedId && completed && removed, 'image_recovery_probe_unobserved');
    assert.equal(result?.containerId, observedId);
    await checkDaemon(); await inspect();
    return result;
  } };
}
module.exports = { restoreImageArchive };
