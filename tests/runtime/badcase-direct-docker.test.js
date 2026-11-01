const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { runDirectDockerTask } = require('../../scripts/badcase-capture/direct-docker.cjs');
const image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64' };
const id = '3'.repeat(64), key = 'test-only-direct-evaluation-key-123456';
function fake({ badIsolation = false, failed = false, leaked = false, timeout = false, lostCreate = false, modelTimeout = false, imageEnv } = {}) {
  const calls = []; let container = null, running = false;
  async function run(args, options = {}) {
    calls.push({ args: [...args], options });
    const ok = data => ({ code: 0, stdout: typeof data === 'string' ? data : JSON.stringify([data]), stderr: '' });
    if (args[0] === 'context') return ok({ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } });
    if (args[0] === 'image') return ok({ Id: image.imageId, RepoDigests: [image.repositoryDigest], Os: 'linux', Architecture: 'amd64', Config: { Env: imageEnv || ['PATH=/bin', 'NODE_VERSION=24.21.0', 'YARN_VERSION=1.22.22'] } });
    if (args[0] === 'create') {
      const value = k => args[args.indexOf(k) + 1];
      container = { Id: id, Image: image.imageId, Config: { Labels: { 'caff.badcase.direct': value('--label').split('=')[1] },
        User: value('--user'), Entrypoint: [value('--entrypoint')], Cmd: args.slice(args.indexOf(image.imageId) + 1), WorkingDir: value('--workdir') },
        HostConfig: { NetworkMode: value('--network'), ReadonlyRootfs: true, Privileged: badIsolation, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
          Memory: 1073741824, MemorySwap: 1073741824, NanoCpus: 2000000000, PidsLimit: 128, IpcMode: 'private', LogConfig: { Type: 'none' }, AutoRemove: false,
          RestartPolicy: { Name: 'no' }, Tmpfs: Object.fromEntries(args.flatMap((a, i) => a === '--tmpfs' ? [args[i + 1].split(/:(.*)/s).slice(0, 2)] : [])) },
        Mounts: [{ Type: 'tmpfs', Destination: '/work' }, { Type: 'tmpfs', Destination: '/tmp' }], State: { Running: false, ExitCode: modelTimeout ? 124 : failed ? 1 : 0, OOMKilled: false } };
      return lostCreate ? { code: null, failure: 'timeout', stdout: '', stderr: key } : ok(id + '\n');
    }
    if (args[0] === 'inspect') return container ? ok(container) : { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'start') { container.State.Running = timeout; return timeout ? { code: null, failure: 'timeout', stdout: key, stderr: key }
      : { code: modelTimeout ? 124 : failed ? 1 : 0, stdout: failed ? key : JSON.stringify({ kind: 'test', ...(leaked ? { text: key } : {}) }), stderr: failed ? key : '' }; }
    if (args[0] === 'rm') { container = null; running = false; return ok(''); }
    if (args[0] === 'ps') return ok(container ? id : '');
    throw Error('unexpected');
  }
  return { run, calls, remaining: () => container !== null || running };
}
const files = [{ path: 'probe.cjs', bytes: Buffer.from('console.log("{}")') }];
test('key inherited by env name only; no host mounts/socket/privileged; receipt after verified cleanup', async () => {
  const f = fake(); const r = await runDirectDockerTask(image, files, { key, network: 'none', timeoutMs: 1000, runDocker: f.run });
  assert.equal(r.cleaned, true); assert.equal(f.remaining(), false); assert.equal(r.receipt.kind, 'test'); assert.equal(r.isolation.network, 'none');
  assert.deepEqual(r.isolation.binds, []); assert.equal(r.isolation.privileged, false);
  for (const c of f.calls) assert.equal(JSON.stringify(c.args).includes(key), false);
  const c = f.calls.find(c => c.args[0] === 'create'); assert.equal(c.options.key, key);
  assert.equal(c.args[c.args.indexOf('--env') + 1], 'CAFF_BADCASE_MODEL_KEY');
  const start = f.calls.find(c => c.args[0] === 'start'); assert.equal(start.options.input.includes(key), false);
  assert.equal(JSON.stringify(r).includes(key), false);
});
test('launcher reads explicitly selected key file without staging its path or bytes; missing file never falls back', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-launch-key-')), file = path.join(root, 'private.key');
  const prior = process.env.CAFF_BADCASE_MODEL_KEY_FILE, ambient = process.env.CAFF_BADCASE_MODEL_KEY;
  t.after(() => {
    if (prior === undefined) delete process.env.CAFF_BADCASE_MODEL_KEY_FILE; else process.env.CAFF_BADCASE_MODEL_KEY_FILE = prior;
    if (ambient === undefined) delete process.env.CAFF_BADCASE_MODEL_KEY; else process.env.CAFF_BADCASE_MODEL_KEY = ambient;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.CAFF_BADCASE_MODEL_KEY_FILE = file; process.env.CAFF_BADCASE_MODEL_KEY = 'ignored-ambient-value';
  fs.writeFileSync(file, key + '\n');
  const f = fake(); await runDirectDockerTask(image, files, { runDocker: f.run, network: 'none' });
  assert.equal(f.calls.find(c => c.args[0] === 'create').options.key, key);
  const archive = f.calls.find(c => c.args[0] === 'start').options.input;
  assert.equal(archive.includes(key), false); assert.equal(archive.includes(file), false);
  fs.unlinkSync(file); const blocked = fake();
  await assert.rejects(runDirectDockerTask(image, files, { runDocker: blocked.run }), /file_unavailable_or_invalid/);
  assert.equal(blocked.calls.length, 0);
});
test('official Node version metadata allowed, executable settings and baked-in auth refused before create', async () => {
  for (const entry of ['NODE_OPTIONS=--import=evil', 'NODE_PATH=/evil', 'CAFF_BADCASE_MODEL_KEY=private', 'LD_PRELOAD=/evil', 'VENDOR_API_KEY=private']) {
    const f = fake({ imageEnv: ['PATH=/bin', entry] });
    await assert.rejects(runDirectDockerTask(image, files, { key, runDocker: f.run }));
    assert.equal(f.calls.some(c => c.args[0] === 'create'), false);
  }
});
test('input/output credential matches refused; cleanup on output leak/isolation drift/lost create', async () => {
  const f = fake(); await assert.rejects(runDirectDockerTask(image, [{ path: 'probe.cjs', bytes: Buffer.from(key) }], { key, runDocker: f.run }), /input_contains_key/);
  assert.equal(f.calls.length, 0);
  for (const setup of [{ leaked: true }, { badIsolation: true }, { lostCreate: true }]) {
    const fakeRun = fake(setup);
    await assert.rejects(runDirectDockerTask(image, files, { key, timeoutMs: 1000, runDocker: fakeRun.run }));
    assert.equal(fakeRun.remaining(), false); assert.ok(fakeRun.calls.some(c => c.args[0] === 'rm'));
  }
});
test('inner model timeout is distinguished from Docker attach/control timeout only after isolation and cleanup', async () => {
  const f = fake({modelTimeout:true}), r = await runDirectDockerTask(image,files,{key,timeoutMs:1000,runDocker:f.run});
  assert.equal(r.failed,true);assert.equal(r.code,124);assert.equal(r.reason,'model_timeout');
  assert.equal(r.cleaned,true);assert.equal(f.remaining(),false);assert.ok(r.inputHash && r.runtimeHash && r.isolation);
  const g=fake({timeout:true}), control=await runDirectDockerTask(image,files,{key,timeoutMs:1000,runDocker:g.run});
  assert.equal(control.reason,'timeout');assert.notEqual(control.code,124);
});
test('worker failure and attach timeout never return raw stdout/stderr and remove process tree', async () => {
  for (const setup of [{ failed: true }, { timeout: true }]) {
    const f = fake(setup); const r = await runDirectDockerTask(image, files, { key, timeoutMs: 1000, runDocker: f.run });
    assert.equal(r.failed, true); assert.equal(r.cleaned, true); assert.equal(f.remaining(), false);
    assert.equal(Object.hasOwn(r, 'stdout'), false); assert.equal(Object.hasOwn(r, 'stderr'), false); assert.equal(JSON.stringify(r).includes(key), false);
  }
});
