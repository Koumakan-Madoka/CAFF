// Trusted operator-only recovery, never an HTTP/agent capability. The caller must
// fence/stop the producing scheduler before invoking recovery; no PID/age heuristic.
// Intent files and their ancestors, transport and dedicated daemon are same-user TCB.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { runDockerCommand } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const LABEL = 'caff.badcase.pi-initialization';
const good = r => r && r.code === 0 && !r.failure;
const digest = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function targetValid(t) {
  assert.deepEqual(Object.keys(t).sort(), ['daemonId', 'dataRoot', 'socket']);
  assert.match(t.socket, /^unix:\/\/\/var\/tmp\/caff-image-recovery-[A-Za-z0-9_-]+\/docker\.sock$/);
  assert.equal(t.dataRoot, t.socket.slice(7, -'/docker.sock'.length) + '/data');
  assert.ok(typeof t.daemonId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(t.daemonId));
}
function intentValid(x) {
  assert.deepEqual(Object.keys(x).sort(), ['imageId', 'name', 'owner', 'target', 'version']);
  assert.equal(x.version, 1); targetValid(x.target);
  assert.match(x.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(x.owner, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(x.name, 'caff-pi-init-' + x.owner);
}
function location(ref) {
  assert.deepEqual(Object.keys(ref).sort(), ['directory', 'owner']);
  assert.ok(path.isAbsolute(ref.directory));
  assert.match(ref.owner, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const st = fs.lstatSync(ref.directory); assert.ok(st.isDirectory() && !st.isSymbolicLink());
  return path.join(ref.directory, ref.owner + '.json');
}
function readIntent(ref) {
  const file = location(ref), st = fs.lstatSync(file);
  assert.ok(st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= 4096);
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd); assert.equal(opened.ino, st.ino); assert.equal(opened.dev, st.dev); assert.equal(opened.size, st.size);
    const bytes = Buffer.alloc(st.size + 1), n = fs.readSync(fd, bytes, 0, bytes.length, 0);
    assert.equal(n, st.size); const text = bytes.subarray(0, n).toString('utf8');
    assert.deepEqual(Buffer.from(text), bytes.subarray(0, n));
    const envelope = JSON.parse(text); assert.deepEqual(Object.keys(envelope).sort(), ['hash', 'intent']);
    intentValid(envelope.intent); assert.equal(envelope.intent.owner, ref.owner); assert.equal(envelope.hash, digest(envelope.intent));
    return envelope.intent;
  } finally { fs.closeSync(fd); }
}
function saveProbeIntent(directory, input) {
  const intent = JSON.parse(JSON.stringify({ version: 1, ...input })); intentValid(intent);
  // The configured parent must already exist. Never follow an existing root link.
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const ref = { directory, owner: intent.owner }, file = location(ref);
  const bytes = Buffer.from(JSON.stringify({ intent, hash: digest(intent) })); assert.ok(bytes.length <= 4096);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  assert.deepEqual(readIntent(ref), intent);
  return ref; // Partial files are retained on error; never overwrite/retry an intent.
}
async function recoverProbeIntent(reference, destination, options = {}) {
  assert.equal(options.schedulerStopped, true, 'probe_recovery_requires_stopped_scheduler');
  const ref = { ...reference }, target = JSON.parse(JSON.stringify(destination)); targetValid(target);
  const intent = readIntent(ref); assert.deepEqual(intent.target, target);
  const run = options.runDocker || runDockerCommand;
  if (!options.runDocker) {
    assert.equal(process.platform, 'linux');
    const directory = target.socket.slice(7, -'/docker.sock'.length);
    const st = fs.lstatSync(directory), socket = fs.lstatSync(directory + '/docker.sock');
    assert.ok(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && st.uid === process.getuid());
    assert.ok(socket.isSocket() && !socket.isSymbolicLink() && socket.uid === st.uid);
  }
  const local = (args) => run(args, { dockerHost: target.socket });
  function json(r) { assert.ok(good(r), 'probe_recovery_control_failed'); return JSON.parse(r.stdout); }
  const shared = json(await run(['info', '--format', '{{json .}}']));
  assert.ok(shared.ID && shared.ID !== target.daemonId, 'probe_recovery_shared_daemon');
  async function daemon() {
    const info = json(await local(['info', '--format', '{{json .}}']));
    assert.equal(info.ID, target.daemonId); assert.equal(info.DockerRootDir, target.dataRoot); assert.equal(info.Driver, 'vfs');
    assert.ok(!info.ServerErrors?.length);
  }
  async function list() {
    const r = await local(['ps', '-a', '--no-trunc', '--filter', 'label=' + LABEL + '=' + intent.owner, '--format', '{{.ID}}']);
    assert.ok(good(r), 'probe_recovery_list_failed');
    const ids = r.stdout.trim() ? r.stdout.trim().split(/\r?\n/) : [];
    assert.ok(ids.length <= 1); for (const id of ids) assert.match(id, /^[a-f0-9]{64}$/);
    return ids;
  }
  async function inspect(id) {
    const a = json(await local(['inspect', id])); assert.ok(Array.isArray(a) && a.length === 1);
    const c = a[0]; assert.equal(c.Id, id); assert.equal(c.Name, '/' + intent.name);
    // Lazy import avoids the orchestration -> journal -> isolation guard cycle.
    require('./verify-pi-initialization.cjs').isolated(c, { imageId: intent.imageId }, intent.owner);
    assert.equal(typeof c.State?.Running, 'boolean'); return c;
  }
  await daemon();
  const ids = await list(), id = ids[0] || null;
  if (id) {
    let c = await inspect(id);
    if (c.State.Running) {
      await daemon(); c = await inspect(id);
      if (c.State.Running) assert.ok(good(await local(['kill', id])), 'probe_recovery_kill_failed');
    }
    await daemon(); c = await inspect(id); assert.equal(c.State.Running, false, 'probe_recovery_not_stopped');
    // No force: if a producer is still running/restarts this container, fail closed.
    assert.ok(good(await local(['rm', id])), 'probe_recovery_remove_failed');
  }
  await daemon(); assert.deepEqual(await list(), [], 'probe_recovery_remaining');
  // Cleanup evidence only, never a score/result/timeout proof or budget release.
  return { containerId: id, stopped: true, removed: true, executionState: 'unknown', resultSettled: false };
}
module.exports = { saveProbeIntent, recoverProbeIntent };
