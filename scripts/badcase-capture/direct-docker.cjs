// One disposable Docker task. Static distribution copying reuses the existing
// CAFF stage; actual SDK/tools run ONLY in the container. No approval/gateway.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { readEvaluationKey, validKey, modelProfile, DEFAULT_PROFILE, CODEX_PROFILE, KEY_ENV } = require('./direct-model.cjs');
const { relayDockerTransport } = require('./container-model-relay.cjs');
const { MAILBOX_LIMITS } = require('./codex-mailbox.cjs');
const { prepareCaffRuntimeFiles } = require('./caff-runtime-wiring.cjs');
const { readTrustedDistributionFile } = require('./evaluation-bridge-launcher.cjs');
function prepareDirectReplayInput(input) {
  assert.equal(input?.kind, 'prepared-caff-turn-v1');
  assert.equal(input.workspace, undefined);
  assert.ok(Array.isArray(input.files) && input.files.length <= 1024);
  const files = [], inventory = input.files.map(f => {
    assert.ok(typeof f.path === 'string' && /^[A-Za-z0-9_.@/-]+$/.test(f.path)
      && f.path.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git'));
    assert.equal(typeof f.base64, 'string');
    const bytes = Buffer.from(f.base64, 'base64');
    assert.equal(bytes.toString('base64'), f.base64);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), f.sha256);
    files.push({ path: 'replay-workspace/' + f.path, bytes });
    return { path: f.path, sha256: f.sha256, size: bytes.length };
  });
  let gitInventory;
  if (input.gitFiles !== undefined) {
    assert.ok(input.repository?.kind === 'sanitized-root-git-v1' && input.repository.historyIncluded === false
      && input.repository.headIdenticalToSource === false && Array.isArray(input.gitFiles) && input.gitFiles.length === 6);
    gitInventory = input.gitFiles.map(f => {
      assert.match(f.path, /^\.git\/(?:HEAD|config|index|refs\/heads\/replay-baseline|objects\/pack\/pack-[a-f0-9]{40,64}\.(?:pack|idx))$/);
      assert.equal(typeof f.base64, 'string');
      const bytes = Buffer.from(f.base64, 'base64'); assert.equal(bytes.toString('base64'), f.base64);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), f.sha256);
      files.push({ path: 'replay-workspace/' + f.path, bytes });
      return { path: f.path, sha256: f.sha256, size: bytes.length };
    });
  } else assert.equal(input.repository, undefined);
  const { dependencyArchive, ...control } = input;
  if (dependencyArchive !== undefined) {
    assert.equal(input.dependencies?.kind, 'npm-ci-linux-v1');
    const bytes = Buffer.from(dependencyArchive.base64, 'base64');
    assert.equal(bytes.toString('base64'), dependencyArchive.base64);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), dependencyArchive.sha256);
    assert.equal(dependencyArchive.sha256, input.dependencies.archiveHash);
    files.push({ path: 'replay-dependencies.tar.gz', bytes });
    control.dependencies = { ...input.dependencies, archivePath: 'replay-dependencies.tar.gz' };
  } else assert.equal(input.dependencies, undefined);
  files.push({ path: 'replay-input.json', bytes: Buffer.from(JSON.stringify({ ...control, files: inventory,
    ...(gitInventory ? { gitFiles: gitInventory } : {}), workspace: 'replay-workspace' })) });
  manifestFor(files, { replayWorkspace: true });
  return files;
}
function prepareDirectTurnFiles(repoRoot, dependencyRoot, image, input, profile = DEFAULT_PROFILE) {
  modelProfile(profile);
  assert.equal(input?.kind, 'prepared-caff-turn-v1');
  const files = prepareCaffRuntimeFiles(repoRoot, dependencyRoot, image, input.sessionText === null ? 'fresh' : 'resume');
  files.find(f => f.path === 'probe.cjs').path = 'caff-runtime-bootstrap.cjs';
  for (const [source, destination] of [['direct-model.cjs', 'direct-model.cjs'], ['direct-sdk-container.cjs', 'probe.cjs'], ['restore-replay-dependencies.cjs', 'restore-replay-dependencies.cjs']]) {
    files.push({ path: destination, bytes: readTrustedDistributionFile(path.resolve(repoRoot), 'scripts/badcase-capture/' + source) });
  }
  if (profile === CODEX_PROFILE) for (const source of ['codex-mailbox.cjs', 'container-model-adapter.cjs']) {
    files.push({ path: source, bytes: readTrustedDistributionFile(path.resolve(repoRoot), 'scripts/badcase-capture/' + source) });
  }
  files.push(...prepareDirectReplayInput(input));
  files.push({ path: 'evaluation-profile.json', bytes: Buffer.from(JSON.stringify(profile)) });
  manifestFor(files, { replayWorkspace: true }); return files;
}
const LABEL = 'caff.badcase.direct';
const WORK = 'rw,exec,nosuid,nodev,size=2g,uid=65534,gid=65534,mode=0700';
const TMP = 'rw,nosuid,nodev,noexec,size=1g,uid=65534,gid=65534,mode=0700';
const fail = code => Object.assign(Error(code), { code });
const good = r => r && r.code === 0 && !r.failure;
function one(r) { assert.ok(good(r), 'evaluation_docker_control_failed'); const a = JSON.parse(r.stdout); assert.equal(a.length, 1); return a[0]; }
// Key is inherited by NAME on `docker create`, not included in argv, tar,
// models.json, an env-file or image. This child receives no other CAFF auth.
function docker(args, options = {}) {
  const env = {};
  for (const k of ['PATH', 'HOME', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  if (options.key !== undefined) env[KEY_ENV] = validKey(options.key);
  const maxOutput = options.maxOutput ?? 1048576;
  assert.ok(Number.isSafeInteger(maxOutput) && maxOutput >= 1 && maxOutput <= 8388736);
  return new Promise(resolve => {
    const output = { stdout: [], stderr: [] }; let size = 0, failure = '', done = false, inputStream;
    const outputFd = options.outputFile ? fs.openSync(options.outputFile, 'wx', 0o600) : undefined;
    const child = spawn('docker', ['--context', 'default', ...args], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = reason => { failure ||= reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs || 15000);
    for (const name of ['stdout', 'stderr']) child[name].on('data', b => {
      if (name === 'stdout' && outputFd !== undefined) { try { fs.writeSync(outputFd, b); } catch { stop('artifact_write'); } return; }
      size += b.length; if (size > maxOutput) { stop('output_limit'); return; } output[name].push(b);
    });
    child.on('error', () => { failure = 'spawn'; });
    child.on('close', code => { if (done) return; done = true; clearTimeout(timer); inputStream?.destroy(); if (outputFd !== undefined) fs.closeSync(outputFd); resolve({ code, stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString(), ...(failure ? { failure } : {}) }); });
    child.stdin.on('error', () => {});
    if (options.inputFile) { inputStream = fs.createReadStream(options.inputFile); inputStream.on('error', () => stop('input')); inputStream.pipe(child.stdin); }
    else child.stdin.end(options.input || '');
  });
}
function isolation(c, image, owner, command, network, credential = true) {
  const h = c.HostConfig;
  assert.match(c.Id, /^[a-f0-9]{64}$/); assert.equal(c.Image, image.imageId);
  assert.equal(c.Config.Labels?.[LABEL], owner); assert.equal(c.Config.User, '65534:65534');
  assert.deepEqual(c.Config.Entrypoint, ['/bin/sh']); assert.deepEqual(c.Config.Cmd, command); assert.equal(c.Config.WorkingDir, '/work');
  assert.equal(Object.keys(c.Config.Volumes || {}).length, 0);
  assert.ok(c.Mounts.every(m => m.Type === 'tmpfs' && ['/work', '/tmp'].includes(m.Destination)));
  assert.equal(h.NetworkMode, network); assert.equal(h.ReadonlyRootfs, true); assert.equal(h.Privileged, false);
  assert.deepEqual(h.CapDrop, ['ALL']); assert.equal((h.CapAdd || []).length, 0); assert.ok(h.SecurityOpt.includes('no-new-privileges'));
  assert.equal(h.Memory, 4294967296); assert.equal(h.MemorySwap, 4294967296); assert.equal(h.NanoCpus, 2000000000); assert.equal(h.PidsLimit, 128);
  for (const k of ['Binds', 'Mounts', 'VolumesFrom', 'Devices', 'DeviceRequests']) assert.equal((h[k] || []).length, 0);
  assert.equal(Object.keys(h.PortBindings || {}).length, 0); assert.ok(!h.PidMode); assert.equal(h.IpcMode, 'private');
  assert.equal(h.LogConfig.Type, 'none'); assert.equal(h.AutoRemove, false); assert.ok(['no', ''].includes(h.RestartPolicy.Name));
  assert.deepEqual(h.Tmpfs, { '/work': WORK, '/tmp': TMP });
  return { network, user: c.Config.User, privileged: false, readonlyRootfs: true, capDrop: h.CapDrop,
    memory: h.Memory, memorySwap: h.MemorySwap, nanoCpus: h.NanoCpus, pidsLimit: h.PidsLimit, tmpfs: h.Tmpfs,
    binds: [], mounts: c.Mounts.map(m => ({ type: m.Type, destination: m.Destination })),
    credentialEnvironmentNames: credential ? [KEY_ENV] : [], logDriver: 'none' };
}
async function runDirectDockerTask(image, files, options = {}) {
  if (files.some(f => f.path === 'evaluation-profile.json' && JSON.parse(f.bytes) === CODEX_PROFILE)) throw fail('evaluation_codex_relay_required');
  const key = options.key === undefined ? readEvaluationKey() : validKey(options.key);
  return runDockerTask(image, files, options, key);
}
// The caller owns the explicitly approved host-only transport lifetime. This
// path never reads/injects credentials and cannot use a bridged network.
async function runCodexDockerTask(image, files, options = {}) {
  if (typeof options.sendNativeRequest !== 'function' || options.key !== undefined || options.network !== undefined && options.network !== 'none'
    || !files.some(f => f.path === 'evaluation-profile.json' && JSON.parse(f.bytes) === CODEX_PROFILE)) throw fail('evaluation_codex_relay_required');
  if (!options.runDocker && process.platform !== 'linux') throw fail('evaluation_linux_required');
  const run = relayDockerTransport(options.runDocker || docker, options.sendNativeRequest, MAILBOX_LIMITS);
  return runDockerTask(image, files, { ...options, runDocker: run, network: 'none' }, undefined);
}
// Separate credential-free path: never read a provider key and never inject
// any account environment. Only its fixed archive artifact may be collected.
async function runDependencyDockerTask(image, files, options = {}) {
  assert.ok(path.isAbsolute(options.outputFile || '') && !fs.existsSync(options.outputFile));
  try {
    const result = await runDockerTask(image, files, { ...options, timeoutMs: options.timeoutMs ?? 900000 }, undefined, options.outputFile);
    if (result.failed) fs.rmSync(options.outputFile, { force: true });
    return result;
  } catch (e) { fs.rmSync(options.outputFile, { force: true }); throw e; }
}
async function runDockerTask(image, files, options, key, dependencyOutput) {
  const timeoutMs = options.timeoutMs ?? 120000, network = options.network ?? 'bridge';
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= (dependencyOutput ? 900000 : 300000));
  assert.ok(['bridge', 'none'].includes(network));
  if (!options.runDocker && process.platform !== 'linux') throw fail('evaluation_linux_required');
  const manifest = manifestFor(files, { replayWorkspace: true }); assert.ok(files.some(f => f.path === 'probe.cjs'));
  // No selected key, including an escaped JSON spelling, may be staged.
  if (key !== undefined) for (const f of files) assert.ok(!f.bytes.includes(key) && !f.bytes.includes(JSON.stringify(key).slice(1, -1)), 'evaluation_input_contains_key');
  const run = options.runDocker || docker;
  assert.match(one(await run(['context', 'inspect', 'default'])).Endpoints?.docker?.Host, /^unix:\/\/\/[^\s\0]+$/);
  const img = one(await run(['image', 'inspect', image.imageId]));
  assert.equal(img.Id, image.imageId); assert.equal(img.Os, 'linux'); assert.equal(img.Architecture, image.architecture);
  assert.ok(img.RepoDigests.includes(image.repositoryDigest));
  assert.equal(Object.keys(img.Config.Volumes || {}).length, 0); assert.equal((img.Config.OnBuild || []).length, 0);
  assert.ok(!img.Config.Healthcheck?.Test?.length || img.Config.Healthcheck.Test[0] === 'NONE');
  assert.ok((img.Config.Env || []).every(e => !/^(?:CAFF_|PI_|OPENAI_|ANTHROPIC_|AWS_|NODE_OPTIONS=|NODE_PATH=|LD_|.*(?:KEY|TOKEN|PASSWORD)=)/i.test(e)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-direct-')), archiveFile = root + '.tar', owner = crypto.randomUUID(), name = 'caff-direct-' + owner;
  const command = ['-c', 'tar --no-same-owner -xf - && exec timeout -k 2 ' + Math.ceil(timeoutMs / 1000) + ' node probe.cjs'];
  let id = '', created = false, result, proof;
  try {
    for (const f of [...files, { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) }]) {
      const target = path.join(root, f.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, f.bytes, { flag: 'wx', mode: 0o600 });
    }
    // The archive contains only already-checked bytes, never the selected key.
    // Write and stream it instead of buffering tar stdout with a size ceiling.
    const archiveFd = fs.openSync(archiveFile, 'wx', 0o600);
    try { execFileSync('tar', ['-C', root, '-cf', '-', '.'], { env: { PATH: process.env.PATH }, stdio: ['ignore', archiveFd, 'pipe'], timeout: 15000 }); }
    finally { fs.closeSync(archiveFd); }
    created = true;
    const c = await run(['create', '--name', name, '--label', LABEL + '=' + owner, '--pull', 'never', '-i', ...(key === undefined ? [] : ['--env', KEY_ENV]),
      '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '4g', '--memory-swap', '4g',
      '--cpus', '2', '--pids-limit', '128', '--user', '65534:65534', '--ipc', 'private', '--workdir', '/work', '--log-driver', 'none',
      '--tmpfs', '/work:' + WORK, '--tmpfs', '/tmp:' + TMP, '--entrypoint', '/bin/sh', image.imageId, ...command], { key });
    assert.ok(good(c), 'evaluation_create_failed'); id = c.stdout.trim(); assert.match(id, /^[a-f0-9]{64}$/);
    const pre = one(await run(['inspect', id])); proof = isolation(pre, image, owner, command, network, key !== undefined); assert.equal(pre.State.Running, false);
    result = await run(['start', '-a', '-i', id], { inputFile: archiveFile, timeoutMs: timeoutMs + 5000,
      ...(dependencyOutput ? { outputFile: dependencyOutput } : {}) });
    const post = one(await run(['inspect', id])); isolation(post, image, owner, command, network, key !== undefined);
    if (!result.failure) { assert.equal(post.State.Running, false); assert.equal(post.State.ExitCode, result.code); }
    // Raw Docker inspect includes runtime env; never return/save that object.
    // Failed worker stderr/provider bodies are deliberately not result material.
    if (!good(result) || post.State.OOMKilled) result = { code: result.code, failed: true, reason: result.failure || (post.State.OOMKilled ? 'oom' : post.State.ExitCode === 124 ? 'model_timeout' : 'worker_failed') };
    else if (key !== undefined && [result.stdout, result.stderr].some(s => s.includes(key) || s.includes(JSON.stringify(key).slice(1, -1)))) throw fail('evaluation_output_contains_key');
    else {
      assert.equal(result.stderr, '', 'evaluation_worker_stderr');
      if (dependencyOutput) {
        // tmpfs disappears when the container stops. Stream one bounded JSON
        // line followed by archive bytes while it is alive, never docker cp a
        // stopped tmpfs or base64-buffer an archive in worker JSON/stdout logs.
        const bytes = fs.readFileSync(dependencyOutput), end = bytes.indexOf(10);
        assert.ok(end > 0 && end <= 8192 && end < bytes.length - 1, 'dependency_artifact_invalid');
        let receipt; try { receipt = JSON.parse(bytes.subarray(0, end).toString('utf8')); } catch { throw fail('dependency_artifact_invalid'); }
        fs.writeFileSync(dependencyOutput, bytes.subarray(end + 1)); result = { code: 0, receipt };
      } else result = { code: 0, receipt: JSON.parse(result.stdout) };
    }
  } finally {
    try {
      if (created) {
        const found = await run(['inspect', id || name]);
        if (good(found)) {
          const c = one(found); assert.match(c.Id, /^[a-f0-9]{64}$/); assert.equal(c.Config.Labels?.[LABEL], owner);
          if (id) assert.equal(c.Id, id);
          assert.ok(good(await run(['rm', '-f', c.Id])), 'evaluation_cleanup_failed');
        } else assert.equal(id, '', 'evaluation_cleanup_unknown');
        const remaining = await run(['ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']);
        assert.ok(good(remaining) && !remaining.stdout.trim(), 'evaluation_cleanup_failed');
      }
    } finally { fs.rmSync(archiveFile, { force: true }); fs.rmSync(root, { recursive: true, force: true }); }
  }
  return { ...result, containerId: id, cleaned: true, isolation: proof, timeoutMs, inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash };
}
module.exports = { prepareDirectTurnFiles, prepareDirectReplayInput, runDirectDockerTask, runCodexDockerTask, runDependencyDockerTask, isolation };
