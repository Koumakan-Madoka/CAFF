const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { runDirectDockerTask, runDependencyDockerTask, prepareDirectReplayInput } = require('../../scripts/badcase-capture/direct-docker.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const crypto = require('node:crypto');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64' };
const id = '3'.repeat(64), key = 'test-only-direct-evaluation-key-123456';
function fake({ badIsolation = false, failed = false, leaked = false, timeout = false, lostCreate = false, modelTimeout = false, copyFail = false, imageEnv, proxyFailure = false, cleanupFailure = false } = {}) {
  const calls = []; let container = null, running = false;
  async function run(args, options = {}) {
    calls.push({ args: [...args], options: { ...options,
      ...(options.inputFile ? { input: fs.readFileSync(options.inputFile) } : {}) } });
    const ok = data => ({ code: 0, stdout: typeof data === 'string' ? data : JSON.stringify([data]), stderr: '' });
    if (args[0] === 'context') return ok({ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } });
    if (args[0] === 'image') return ok({ Id: image.imageId, RepoDigests: [image.repositoryDigest], Os: 'linux', Architecture: 'amd64', Config: { Env: imageEnv || ['PATH=/bin', 'NODE_VERSION=24.21.0', 'YARN_VERSION=1.22.22'] } });
    if (args[0] === 'create') {
      const value = k => args[args.indexOf(k) + 1];
      container = { Id: id, Image: image.imageId, Config: { Labels: { 'caff.badcase.direct': value('--label').split('=')[1] },
        User: value('--user'), Entrypoint: [value('--entrypoint')], Cmd: args.slice(args.indexOf(image.imageId) + 1), WorkingDir: value('--workdir') },
        HostConfig: { NetworkMode: value('--network'), ReadonlyRootfs: true, Privileged: badIsolation, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
          Memory: Number(value('--memory').replace('g', '')) * 1024 ** 3, MemorySwap: Number(value('--memory-swap').replace('g', '')) * 1024 ** 3,
          NanoCpus: 2000000000, PidsLimit: 128, IpcMode: 'private', LogConfig: { Type: 'none' }, AutoRemove: false,
          RestartPolicy: { Name: 'no' }, Tmpfs: Object.fromEntries(args.flatMap((a, i) => a === '--tmpfs' ? [args[i + 1].split(/:(.*)/s).slice(0, 2)] : [])) },
        Mounts: [{ Type: 'tmpfs', Destination: '/work' }, { Type: 'tmpfs', Destination: '/tmp' }], State: { Running: false, ExitCode: modelTimeout ? 124 : failed ? 1 : 0, OOMKilled: false } };
      return lostCreate ? { code: null, failure: 'timeout', stdout: '', stderr: key } : ok(id + '\n');
    }
    if (args[0] === 'inspect') return container ? ok(container) : { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'start') { container.State.Running = timeout;
      if (proxyFailure) throw Object.assign(Error('PRIVATE-PROXY-BODY'), { code: 'evaluation_codex_proxy_failed' });
      if (options.outputFile) fs.writeFileSync(options.outputFile, copyFail ? 'invalid-artifact-stream' : JSON.stringify({ kind: 'test' }) + '\nsynthetic archive');
      return timeout ? { code: null, failure: 'timeout', stdout: key, stderr: key }
      : { code: modelTimeout ? 124 : failed ? 1 : 0, stdout: failed ? key : JSON.stringify({ kind: 'test', ...(leaked ? { text: key } : {}) }), stderr: failed ? key : '' }; }
    if (args[0] === 'cp') { if (copyFail) return { code: 1, stdout: '', stderr: key }; fs.writeFileSync(args[2], 'synthetic archive'); return ok(''); }
    if (args[0] === 'rm') { if (cleanupFailure) return { code: 1, stdout: '', stderr: 'private cleanup diagnostic' }; container = null; running = false; return ok(''); }
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
test('file-backed dependencies are chunk-scanned, copied without readFile, and revalidated before create', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-file-backed-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceFile = path.join(root, 'archive'), bytes = Buffer.from('x'.repeat(65535) + key + 'end'); fs.writeFileSync(sourceFile, bytes);
  const staged = [...files, { path: 'replay-dependencies.tar.gz', sourceFile }], f = fake();
  await assert.rejects(runDirectDockerTask(image, staged, { key, runDocker: f.run }), /evaluation_input_contains_key/);
  assert.equal(f.calls.length, 0);
  fs.writeFileSync(sourceFile, Buffer.alloc(2 * 1024 * 1024, 97));
  const m = manifestFor(staged, { replayWorkspace: true }), originalRead = fs.readFileSync;
  fs.readFileSync = (name, ...args) => { assert.notEqual(name, sourceFile, 'never read entire archive'); return originalRead(name, ...args); };
  try {
    const result = await runDirectDockerTask(image, staged, { key, runDocker: f.run, expectedInputHash: m.inputHash });
    assert.equal(result.inputHash, m.inputHash); assert.equal(result.cleaned, true);
  } finally { fs.readFileSync = originalRead; }
  fs.appendFileSync(sourceFile, 'drift'); const stopped = fake();
  await assert.rejects(runDirectDockerTask(image, staged, { key, runDocker: stopped.run, expectedInputHash: m.inputHash }), /evaluation_input_changed/);
  assert.equal(stopped.calls.length, 0);
  assert.throws(() => manifestFor([{ path: 'runtime/not-authorized', sourceFile }], { replayWorkspace: true }), /probe_file_invalid/);
});
test('Codex launcher is explicitly relay-only and has no credential environment or network path', async () => {
  const codexFiles = [...files, { path: 'evaluation-profile.json', bytes: Buffer.from(JSON.stringify('openai-codex/gpt-6.1-sol')) }], f = fake();
  await assert.rejects(runDirectDockerTask(image, codexFiles, { key, runDocker: f.run }), /evaluation_codex_relay_required/);
  assert.equal(f.calls.length, 0);
  const { runCodexDockerTask } = require('../../scripts/badcase-capture/direct-docker.cjs');
  assert.equal(typeof runCodexDockerTask, 'function');
  const r = await runCodexDockerTask(image, codexFiles, { timeoutMs: 1000, runDocker: f.run, sendNativeRequest: async () => { throw Error('no fake requests'); } });
  assert.equal(r.cleaned, true); assert.equal(f.remaining(), false); assert.equal(r.isolation.network, 'none');
  assert.deepEqual(r.isolation.credentialEnvironmentNames, []);
  const create = f.calls.find(c => c.args[0] === 'create'); assert.equal(create.args.includes('--env'), false); assert.equal(create.options.key, undefined);
  await assert.rejects(runCodexDockerTask(image, codexFiles, { network: 'bridge' }), /evaluation_codex_relay_required/);
  await assert.rejects(runCodexDockerTask(image, codexFiles, { sendNativeRequest: async () => {}, key }), /evaluation_codex_relay_required/);
});
test('host native relay refuses a container request beyond configured cap, including explicit 64, and proves cleanup', async () => {
  const { runCodexDockerTask } = require('../../scripts/badcase-capture/direct-docker.cjs');
  for (const maxRequests of [undefined, 64, 1]) {
    const cap = maxRequests ?? 32, f = fake(); let running = false, finish, sequence = 1, sent = 0;
    const input = [...files, { path: 'evaluation-profile.json', bytes: Buffer.from(JSON.stringify('openai-codex/gpt-6.1-sol')) },
      ...(maxRequests === undefined ? [] : [{ path: 'evaluation-limits.json', bytes: Buffer.from(JSON.stringify({ maxRequests })) }])];
    const runDocker = async (args, options) => {
      if (args[0] === 'start') { running = true; await new Promise(resolve => { finish = resolve; }); return f.run(args, options); }
      if (args[0] === 'kill') { running = false; finish(); return { code: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'exec') {
        if (args[1] === '-i') { sequence++; return { code: 0, stdout: '', stderr: '' }; }
        return { code: 0, stdout: JSON.stringify({ sequence, body: Buffer.from('{}').toString('base64') }), stderr: '' };
      }
      const result = await f.run(args, options);
      if (args[0] === 'inspect' && result.code === 0) {
        const values = JSON.parse(result.stdout); values[0].State.Running = running; result.stdout = JSON.stringify(values);
      }
      return result;
    };
    await assert.rejects(runCodexDockerTask(image, input, { maxRequests, runDocker, timeoutMs: 10000,
      sendNativeRequest: async () => { sent++; return Buffer.from('{}'); } }), /container_model_relay_failed/);
    assert.equal(sent, cap); assert.equal(sequence, cap + 1); assert.equal(f.remaining(), false);
    assert.ok(f.calls.some(c => c.args[0] === 'rm'));
  }
});
test('native launcher refuses out-of-range or mismatched stage/caller limits before Docker', async () => {
  const { runCodexDockerTask } = require('../../scripts/badcase-capture/direct-docker.cjs');
  const input = [...files, { path: 'evaluation-profile.json', bytes: Buffer.from(JSON.stringify('openai-codex/gpt-6.1-sol')) }];
  const configured = [...input, { path: 'evaluation-limits.json', bytes: Buffer.from(JSON.stringify({ maxRequests: 64 })) }];
  const f = fake(), options = { timeoutMs: 1000, runDocker: f.run, sendNativeRequest: async () => assert.fail('no send') };
  for (const maxRequests of [0, 65, null, '64']) {
    await assert.rejects(runCodexDockerTask(image, input, { ...options, maxRequests }), /evaluation_codex_mailbox_limits_invalid/);
  }
  await assert.rejects(runCodexDockerTask(image, input, { ...options, maxRequests: 64 }), /evaluation_codex_mailbox_limits_mismatch/);
  await assert.rejects(runCodexDockerTask(image, configured, options), /evaluation_codex_mailbox_limits_mismatch/);
  assert.equal(f.calls.length, 0);
  const r = await runCodexDockerTask(image, configured, { ...options, maxRequests: 64 });
  assert.equal(r.cleaned, true); assert.equal(f.remaining(), false);
});
test('a cancelled native precheck cannot inspect images, create or attach any container', async () => {
  const { runCodexDockerTask } = require('../../scripts/badcase-capture/direct-docker.cjs'), controller = new AbortController(); controller.abort();
  const input = [...files, { path: 'evaluation-profile.json', bytes: Buffer.from(JSON.stringify('openai-codex/gpt-6.1-sol')) }], f = fake();
  await assert.rejects(runCodexDockerTask(image, input, { signal: controller.signal, timeoutMs: 1000, runDocker: f.run, sendNativeRequest: async () => assert.fail('no send') }), /evaluation_aborted/);
  assert.equal(f.calls.length, 0); assert.equal(f.remaining(), false);
});
test('proxy failure returns pinned launcher hashes and isolation only after verified cleanup; missing cleanup still throws', async () => {
  const { runCodexDockerTask } = require('../../scripts/badcase-capture/direct-docker.cjs');
  const input = [...files, { path: 'evaluation-profile.json', bytes: Buffer.from(JSON.stringify('openai-codex/gpt-6.1-sol')) }];
  const f = fake({ proxyFailure: true });
  const r = await runCodexDockerTask(image, input, { timeoutMs: 1000, runDocker: f.run, sendNativeRequest: async () => Buffer.from('{}') });
  assert.equal(r.reason, 'evaluation_codex_proxy_failed'); assert.equal(r.failed, true); assert.equal(r.cleaned, true); assert.equal(r.containerId, id); assert.equal(r.isolation.network, 'none');
  assert.equal(r.inputHash, manifestFor(input, { replayWorkspace: true }).inputHash); assert.equal(f.remaining(), false); assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
  const g = fake({ proxyFailure: true, cleanupFailure: true });
  await assert.rejects(runCodexDockerTask(image, input, { timeoutMs: 1000, runDocker: g.run, sendNativeRequest: async () => Buffer.from('{}') }), /evaluation_cleanup_failed/);
});
test('host-model launcher preserves network-none/no-credential isolation and requires bounded explicit exchange', async () => {
  const { runHostModelDockerTask } = require('../../scripts/badcase-capture/direct-docker.cjs');
  const f = fake(), options = { timeoutMs: 1000, runDocker: f.run, sendNativeRequest: async () => Buffer.from('{}'),
    limits: { maxRequests: 1, maxRequestBytes: 4096, maxResponseBytes: 4096 } };
  const r = await runHostModelDockerTask(image, files, options);
  assert.equal(r.cleaned, true); assert.equal(f.remaining(), false); assert.equal(r.isolation.network, 'none');
  assert.deepEqual(r.isolation.credentialEnvironmentNames, []);
  const c = f.calls.find(c => c.args[0] === 'create'); assert.equal(c.options.key, undefined); assert.equal(c.args.includes('--env'), false);
  for (const extra of [{ key }, { network: 'bridge' }, { sendNativeRequest: undefined }, { limits: undefined }]) {
    await assert.rejects(runHostModelDockerTask(image, files, { ...options, ...extra }), /evaluation_host_relay_required/);
  }
});
test('dependency installer streams its archive before tmpfs teardown, never reads/injects account auth, then verifies cleanup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-deps-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'node_modules.tar.gz'), prior = process.env.CAFF_BADCASE_MODEL_KEY_FILE;
  process.env.CAFF_BADCASE_MODEL_KEY_FILE = path.join(root, 'nonexistent-account-path');
  try {
    const f = fake(), result = await runDependencyDockerTask(image, files, { outputFile: file, runDocker: f.run });
    assert.equal(result.cleaned, true); assert.equal(f.remaining(), false);
    assert.deepEqual(result.isolation.credentialEnvironmentNames, []); assert.deepEqual(result.isolation.binds, []);
    const create = f.calls.find(c => c.args[0] === 'create');
    assert.equal(create.args.includes('--env'), false); assert.equal(create.options.key, undefined);
    assert.equal(create.args[create.args.indexOf('--memory') + 1], '4g');
    assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic archive');
    assert.equal(f.calls.some(c => c.args[0] === 'cp'), false, 'stopped tmpfs cannot supply docker cp artifacts');
    assert.equal(f.calls.find(c => c.args[0] === 'start').options.outputFile, file);
    fs.unlinkSync(file);
    const bad = fake({ copyFail: true });
    await assert.rejects(runDependencyDockerTask(image, files, { outputFile: file, runDocker: bad.run }), /dependency_artifact_invalid/);
    assert.equal(bad.remaining(), false); assert.equal(fs.existsSync(file), false);
  } finally { if (prior === undefined) delete process.env.CAFF_BADCASE_MODEL_KEY_FILE; else process.env.CAFF_BADCASE_MODEL_KEY_FILE = prior; }
});
test('45-minute turn ceiling reaches the container watchdog and attach grace without waiting or changing install ceiling', async () => {
  const f = fake(), result = await runDirectDockerTask(image, files, { key, timeoutMs: 2700000, runDocker: f.run });
  assert.equal(result.timeoutMs, 2700000); assert.equal(result.cleaned, true);
  assert.ok(f.calls.find(c => c.args[0] === 'create').args.at(-1).includes('timeout -k 2 2700 node probe.cjs'));
  assert.equal(f.calls.find(c => c.args[0] === 'start').options.timeoutMs, 2705000);
  const bad = fake(); await assert.rejects(runDirectDockerTask(image, files, { key, timeoutMs: 2700001, runDocker: bad.run }));
  assert.equal(bad.calls.length, 0);
});
test('workspace files are staged as raw directory entries, not base64 inside replay JSON, with hashes bound to the manifest', () => {
  const bytes = Buffer.alloc(25 * 1024 * 1024, 0x61), input = { kind: 'prepared-caff-turn-v1', prompt: 'Inspect.', files: [
    { path: 'src/large.txt', base64: bytes.toString('base64'), sha256: sha(bytes) }
  ], sessionText: null, callback: null, settings: null, systemPrompt: null };
  const staged = prepareDirectReplayInput(input), json = staged.find(f => f.path === 'replay-input.json').bytes;
  assert.ok(json.length < 4096); assert.equal(json.includes(bytes.subarray(0, 4096)), false);
  const wire = JSON.parse(json); assert.equal(wire.workspace, 'replay-workspace');
  assert.deepEqual(wire.files, [{ path: 'src/large.txt', sha256: sha(bytes), size: bytes.length }]);
  assert.deepEqual(staged.find(f => f.path === 'replay-workspace/src/large.txt').bytes, bytes);
  assert.equal(input.files[0].base64, bytes.toString('base64'), 'caller input remains unchanged');
  assert.throws(() => manifestFor(staged), /probe_dependency_size/, 'static-stage default still bounded');
  const manifest = manifestFor(staged, { replayWorkspace: true });
  assert.equal(manifest.files.find(f => f.path === 'replay-workspace/src/large.txt').size, bytes.length);
  const changed = staged.map(f => ({ ...f })); changed.find(f => f.path.startsWith('replay-workspace/')).bytes = Buffer.from('changed');
  assert.notEqual(manifestFor(changed, { replayWorkspace: true }).inputHash, manifest.inputHash);
  assert.throws(() => manifestFor([{ path: 'runtime/large', bytes }], { replayWorkspace: true }), /probe_dependency_size/);
});
test('workspace staging refuses corrupt encodings, digests, traversal and collisions before Docker', () => {
  assert.equal(typeof prepareDirectReplayInput, 'function');
  const file = { path: 'source.txt', base64: Buffer.from('bytes').toString('base64'), sha256: sha('bytes') };
  const input = { kind: 'prepared-caff-turn-v1', files: [file] };
  for (const files of [[{ ...file, path: '../escape' }], [{ ...file, path: '.git/config' }], [{ ...file, sha256: '0'.repeat(64) }],
    [{ ...file, base64: file.base64 + '\n' }], [file, file], [file, { ...file, path: 'source.txt/nested' }]]) {
    assert.throws(() => prepareDirectReplayInput({ ...input, files }));
  }
  assert.throws(() => prepareDirectReplayInput({ ...input, workspace: '/outside' }));
});
test('large replay archive streams from an owned temporary file, not a bounded stdout buffer or host mount', async () => {
  const bytes = Buffer.alloc(25 * 1024 * 1024, 0x61), f = fake();
  const r = await runDirectDockerTask(image, [...files, { path: 'replay-workspace/large.txt', bytes }], { key, network: 'none', timeoutMs: 1000, runDocker: f.run });
  assert.equal(r.cleaned, true); assert.equal(f.remaining(), false);
  const start = f.calls.find(c => c.args[0] === 'start');
  assert.equal(typeof start.options.inputFile, 'string'); assert.ok(start.options.input.length > bytes.length);
  assert.equal(fs.existsSync(start.options.inputFile), false, 'owned archive removed after container cleanup');
  assert.deepEqual(r.isolation.binds, []);
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
    const start = f.calls.find(c => c.args[0] === 'start');
    assert.equal(fs.existsSync(start.options.inputFile), false);
  }
});
