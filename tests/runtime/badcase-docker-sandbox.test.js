const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { prepareOfflineTask, runOfflineDockerTask } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox.js');
const digest = 'sha256:' + 'a'.repeat(64);
const image = { imageId: digest, repositoryDigest: 'node@' + digest, architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
function task(source = 'console.log("ok")') {
  const bytes = Buffer.from(source);
  return { image, entrypoint: 'task.cjs', files: [{ path: 'task.cjs', base64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') }], timeoutMs: 1000 };
}
function fakeDocker(overrides = {}) {
  const calls = [];
  let name, owner, cmd, created = false;
  const info = () => ({ Id: 'b'.repeat(64), Image: image.imageId, Config: { Labels: { 'caff.badcase.offline': owner }, User: '65534:65534', Entrypoint: ['/usr/bin/env'], WorkingDir: '/work', Cmd: cmd, Volumes: null }, Mounts: [], HostConfig: { LogConfig: { Type: 'none' }, RestartPolicy: { Name: 'no' }, AutoRemove: false, NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Memory: 536870912, MemorySwap: 536870912, NanoCpus: 1000000000, PidsLimit: 64, Binds: null, PortBindings: {}, Devices: [], DeviceRequests: null, PidMode: '', IpcMode: 'private', Tmpfs: { '/work': 'rw,nosuid,nodev,size=64m,uid=65534,gid=65534,mode=0700', '/tmp': 'rw,nosuid,nodev,noexec,size=16m,uid=65534,gid=65534,mode=0700' } }, State: { Running: false, ExitCode: 0, OOMKilled: false } });
  const run = async (args, options) => {
    calls.push({ args, options });
    const result = { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'context') result.stdout = JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
    else if (args[0] === 'image') result.stdout = JSON.stringify([{ Id: image.imageId, RepoDigests: [image.repositoryDigest], Architecture: image.architecture, Os: 'linux', Config: { Volumes: null, OnBuild: null } }]);
    else if (args[0] === 'create') {
      name = args[args.indexOf('--name') + 1]; owner = args[args.indexOf('--label') + 1].split('=')[1]; cmd = args.slice(args.indexOf(image.imageId) + 1); created = true; result.stdout = 'b'.repeat(64);
    } else if (args[0] === 'inspect') result.stdout = JSON.stringify([info()]);
    else if (args[0] === 'start') result.stdout = 'ok\n';
    else if (args[0] === 'rm') created = false;
    else if (args[0] === 'ps') result.stdout = created ? 'b'.repeat(64) + '\n' : '';
    if (overrides.change) await overrides.change(args, result, { info, name, owner, created });
    return result;
  };
  return { run, calls };
}

test('bundle is immutable, content addressed and independent of object key order', () => {
  const input = task(); const a = prepareOfflineTask(input); input.files[0].base64 = '';
  assert.equal(a.inputHash, prepareOfflineTask(task()).inputHash);
  const reordered = task(); reordered.image = Object.fromEntries(Object.entries(reordered.image).reverse());
  reordered.files[0] = Object.fromEntries(Object.entries(reordered.files[0]).reverse());
  assert.equal(a.inputHash, prepareOfflineTask(reordered).inputHash);
  assert.ok(a.payload.includes('task.cjs'));
});
test('reject path escape, links, duplicate paths and file-directory conflicts before Docker', async () => {
  for (const p of ['../x', '/x', 'C:/x', 'a\\b', 'a//b', '.', 'a/../b', 'a\u0000b']) {
    const t = task(); t.files[0].path = p; assert.throws(() => prepareOfflineTask(t), /offline_input_invalid/);
  }
  const t = task(); t.files[0].type = 'symlink'; assert.throws(() => prepareOfflineTask(t), /offline_input_invalid/);
  const d = task(); d.files.push({ ...d.files[0] }); assert.throws(() => prepareOfflineTask(d), /offline_input_invalid/);
  const c = task(); c.files.push({ ...c.files[0], path: 'task.cjs/child' }); assert.throws(() => prepareOfflineTask(c), /offline_input_invalid/);
  const f = fakeDocker(); await assert.rejects(runOfflineDockerTask({ ...task(), mounts: ['/'] }, { runDocker: f.run }), /offline_input_invalid/); assert.equal(f.calls.length, 0);
});
test('reject floating or inconsistent image declarations, corruption, secrets, limits and missing entry', () => {
  for (const patch of [{ image: { ...image, imageId: 'node:latest' } }, { image: { ...image, repositoryDigest: 'node:latest' } }, { image: { ...image, architecture: 'unknown' } }, { timeoutMs: 0 }, { timeoutMs: 300001 }, { entrypoint: 'missing.cjs' }]) assert.throws(() => prepareOfflineTask({ ...task(), ...patch }), /offline_input_invalid/);
  const corrupt = task(); corrupt.files[0].sha256 = 'c'.repeat(64); assert.throws(() => prepareOfflineTask(corrupt), /offline_input_invalid/);
  const secret = task('const key = "' + 'sk-' + 'a'.repeat(40) + '"'); assert.throws(() => prepareOfflineTask(secret), /offline_input_secret/);
});
test('local fixed image, explicit isolation, stdin bundle, no host environment injection, owned cleanup', async () => {
  const f = fakeDocker(); const r = await runOfflineDockerTask(task(), { runDocker: f.run });
  assert.equal(r.state, 'completed'); assert.equal(r.cleaned, true); assert.equal(r.stdout, 'ok\n');
  const create = f.calls.find(c => c.args[0] === 'create').args;
  for (const option of ['--read-only', '--network', '--cap-drop', '--security-opt', '--memory', '--memory-swap', '--cpus', '--pids-limit', '--user', '--pull', '--entrypoint']) assert.ok(create.includes(option), option);
  assert.equal(create[create.indexOf('--network') + 1], 'none');
  assert.equal(create[create.indexOf('--pull') + 1], 'never');
  for (const forbidden of ['--volume', '-v', '--mount', '--privileged', '--env-file', '-e', '--publish']) assert.equal(create.slice(0, create.indexOf(image.imageId)).includes(forbidden), false, forbidden);
  assert.ok(f.calls.find(c => c.args[0] === 'start').options.input.includes('task.cjs'));
  assert.equal(f.calls.filter(c => c.args[0] === 'rm').length, 1);
  assert.equal(r.strictEvalEligible, false);
});
test('remote daemon and mismatched/missing image fail before container creation', async () => {
  for (const which of ['remote', 'digest', 'arch', 'volumes', 'onbuild', 'healthcheck', 'missing']) {
    const f = fakeDocker({ change(args, r) {
      if (which === 'remote' && args[0] === 'context') r.stdout = JSON.stringify([{ Endpoints: { docker: { Host: 'tcp://remote:2375' } } }]);
      if (args[0] === 'image') {
        const i = JSON.parse(r.stdout)[0];
        if (which === 'digest') i.RepoDigests = []; if (which === 'arch') i.Architecture = 'arm64'; if (which === 'volumes') i.Config.Volumes = { '/data': {} }; if (which === 'onbuild') i.Config.OnBuild = ['RUN unexpected']; if (which === 'healthcheck') i.Config.Healthcheck = { Test: ['CMD-SHELL', 'unexpected'] }; if (which === 'missing') r.code = 1;
        r.stdout = JSON.stringify([i]);
      }
    } });
    await assert.rejects(runOfflineDockerTask(task(), { runDocker: f.run }), /offline_(daemon|image)_invalid/);
    assert.equal(f.calls.some(c => c.args[0] === 'create'), false);
  }
});
test('inspect mismatch blocks execution but still removes only owned container', async () => {
  const f = fakeDocker({ change(args, r) { if (args[0] === 'inspect') { const i = JSON.parse(r.stdout)[0]; i.HostConfig.Privileged = true; r.stdout = JSON.stringify([i]); } } });
  await assert.rejects(runOfflineDockerTask(task(), { runDocker: f.run }), /offline_isolation_invalid/);
  assert.equal(f.calls.some(c => c.args[0] === 'start'), false); assert.ok(f.calls.some(c => c.args[0] === 'rm'));
});
test('timeout/output excess/nonzero task exits never return completed and cleanup is verified', async () => {
  for (const reason of ['timeout', 'output_limit', 'exit']) {
    const f = fakeDocker({ change(args, r) { if (args[0] === 'start') { if (reason === 'exit') r.code = 7; else r.failure = reason; } if (args[0] === 'inspect' && reason === 'exit') { const i = JSON.parse(r.stdout)[0]; i.State.ExitCode = 7; r.stdout = JSON.stringify([i]); } } });
    const r = await runOfflineDockerTask(task(), { runDocker: f.run });
    assert.equal(r.state, reason === 'exit' ? 'failed' : 'killed'); assert.equal(r.cleaned, true);
    assert.ok(f.calls.some(c => c.args[0] === 'rm'));
  }
});
test('cleanup failure or ownership mismatch is explicit and never deletes foreign container', async () => {
  for (const which of ['rm', 'owner']) {
    let inspections = 0;
    const f = fakeDocker({ change(args, r) {
      if (which === 'rm' && args[0] === 'rm') r.code = 1;
      if (args[0] === 'inspect' && ++inspections >= 3 && which === 'owner') { const i = JSON.parse(r.stdout)[0]; i.Config.Labels = {}; r.stdout = JSON.stringify([i]); }
    } });
    await assert.rejects(runOfflineDockerTask(task(), { runDocker: f.run }), /offline_cleanup_failed/);
    if (which === 'owner') assert.equal(f.calls.some(c => c.args[0] === 'rm'), false);
  }
});
test('every declared isolation guard rejects a mismatched inspect before task execution', async () => {
  const changes = [
    i => { i.Image = 'other'; }, i => { i.Config.Cmd = ['node']; }, i => { i.Config.User = 'root'; },
    i => { i.Config.Volumes = { '/data': {} }; }, i => { i.Mounts = [{ Type: 'bind', Destination: '/work' }]; },
    i => { i.HostConfig.NetworkMode = 'host'; }, i => { i.HostConfig.ReadonlyRootfs = false; },
    i => { i.HostConfig.CapDrop = []; }, i => { i.HostConfig.CapAdd = ['SYS_ADMIN']; }, i => { i.HostConfig.SecurityOpt = []; },
    i => { i.HostConfig.Memory = 0; }, i => { i.HostConfig.MemorySwap = -1; }, i => { i.HostConfig.NanoCpus = 0; }, i => { i.HostConfig.PidsLimit = -1; },
    i => { i.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']; }, i => { i.HostConfig.Mounts = [{}]; },
    i => { i.HostConfig.VolumesFrom = ['production']; }, i => { i.HostConfig.Devices = [{}]; }, i => { i.HostConfig.DeviceRequests = [{}]; },
    i => { i.HostConfig.PortBindings = { '3100/tcp': [] }; }, i => { i.HostConfig.PidMode = 'host'; }, i => { i.HostConfig.IpcMode = 'host'; },
    i => { i.HostConfig.Tmpfs['/work'] = 'rw'; }, i => { i.HostConfig.Tmpfs['/extra'] = 'rw'; },
    i => { i.HostConfig.LogConfig.Type = 'json-file'; }, i => { i.HostConfig.RestartPolicy.Name = 'always'; }, i => { i.HostConfig.AutoRemove = true; },
  ];
  for (const change of changes) {
    const f = fakeDocker({ change(args, r) { if (args[0] === 'inspect') { const i = JSON.parse(r.stdout)[0]; change(i); r.stdout = JSON.stringify([i]); } } });
    await assert.rejects(runOfflineDockerTask(task(), { runDocker: f.run }), /offline_isolation_invalid/);
    assert.equal(f.calls.some(c => c.args[0] === 'start'), false);
  }
});
test('two in-flight runs hold slots through cleanup; third is rejected without Docker calls', async () => {
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  let reached = 0, ready; const waiting = new Promise(resolve => { ready = resolve; });
  const fake = () => fakeDocker({ async change(args) { if (args[0] === 'rm') { if (++reached === 2) ready(); await gate; } } });
  const a = fake(), b = fake(), c = fakeDocker();
  const pending = [runOfflineDockerTask(task(), { runDocker: a.run }), runOfflineDockerTask(task(), { runDocker: b.run })];
  await waiting;
  try { await assert.rejects(runOfflineDockerTask(task(), { runDocker: c.run }), /offline_busy/); assert.equal(c.calls.length, 0); }
  finally { unblock(); await Promise.all(pending); }
  assert.equal((await runOfflineDockerTask(task(), { runDocker: c.run })).state, 'completed');
});
test('uncertain create failure still attempts owned-name lookup; no invented success', async () => {
  const f = fakeDocker({ change(args, r) { if (args[0] === 'create') { r.failure = 'timeout'; r.stdout = ''; } } });
  await assert.rejects(runOfflineDockerTask(task(), { runDocker: f.run }), /offline_create_failed/);
  assert.ok(f.calls.some(c => c.args[0] === 'rm'));
});
