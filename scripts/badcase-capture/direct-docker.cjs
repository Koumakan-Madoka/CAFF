// One disposable Docker task. Static distribution copying reuses the existing
// CAFF stage; actual SDK/tools run ONLY in the container. No approval/gateway.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { readEvaluationKey, validKey, KEY_ENV } = require('./direct-model.cjs');
const { prepareCaffRuntimeFiles } = require('./caff-runtime-wiring.cjs');
const { readTrustedDistributionFile } = require('./evaluation-bridge-launcher.cjs');
function prepareDirectTurnFiles(repoRoot, dependencyRoot, image, input) {
  assert.equal(input?.kind, 'prepared-caff-turn-v1');
  const files = prepareCaffRuntimeFiles(repoRoot, dependencyRoot, image, input.sessionText === null ? 'fresh' : 'resume');
  files.find(f => f.path === 'probe.cjs').path = 'caff-runtime-bootstrap.cjs';
  for (const [source, destination] of [['direct-model.cjs', 'direct-model.cjs'], ['direct-sdk-container.cjs', 'probe.cjs']]) {
    files.push({ path: destination, bytes: readTrustedDistributionFile(path.resolve(repoRoot), 'scripts/badcase-capture/' + source) });
  }
  files.push({ path: 'replay-input.json', bytes: Buffer.from(JSON.stringify(input)) });
  manifestFor(files); return files;
}
const LABEL = 'caff.badcase.direct';
const WORK = 'rw,exec,nosuid,nodev,size=128m,uid=65534,gid=65534,mode=0700';
const TMP = 'rw,nosuid,nodev,noexec,size=16m,uid=65534,gid=65534,mode=0700';
const fail = code => Object.assign(Error(code), { code });
const good = r => r && r.code === 0 && !r.failure;
function one(r) { assert.ok(good(r), 'evaluation_docker_control_failed'); const a = JSON.parse(r.stdout); assert.equal(a.length, 1); return a[0]; }
// Key is inherited by NAME on `docker create`, not included in argv, tar,
// models.json, an env-file or image. This child receives no other CAFF auth.
function docker(args, options = {}) {
  const env = {};
  for (const k of ['PATH', 'HOME', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  if (options.key !== undefined) env[KEY_ENV] = validKey(options.key);
  return new Promise(resolve => {
    const output = { stdout: [], stderr: [] }; let size = 0, failure = '', done = false;
    const child = spawn('docker', ['--context', 'default', ...args], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = reason => { failure ||= reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs || 15000);
    for (const name of ['stdout', 'stderr']) child[name].on('data', b => {
      size += b.length; if (size > 1048576) { stop('output_limit'); return; } output[name].push(b);
    });
    child.on('error', () => { failure = 'spawn'; });
    child.on('close', code => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString(), ...(failure ? { failure } : {}) }); });
    child.stdin.on('error', () => {}); child.stdin.end(options.input || '');
  });
}
function isolation(c, image, owner, command, network) {
  const h = c.HostConfig;
  assert.match(c.Id, /^[a-f0-9]{64}$/); assert.equal(c.Image, image.imageId);
  assert.equal(c.Config.Labels?.[LABEL], owner); assert.equal(c.Config.User, '65534:65534');
  assert.deepEqual(c.Config.Entrypoint, ['/bin/sh']); assert.deepEqual(c.Config.Cmd, command); assert.equal(c.Config.WorkingDir, '/work');
  assert.equal(Object.keys(c.Config.Volumes || {}).length, 0);
  assert.ok(c.Mounts.every(m => m.Type === 'tmpfs' && ['/work', '/tmp'].includes(m.Destination)));
  assert.equal(h.NetworkMode, network); assert.equal(h.ReadonlyRootfs, true); assert.equal(h.Privileged, false);
  assert.deepEqual(h.CapDrop, ['ALL']); assert.equal((h.CapAdd || []).length, 0); assert.ok(h.SecurityOpt.includes('no-new-privileges'));
  assert.equal(h.Memory, 1073741824); assert.equal(h.MemorySwap, 1073741824); assert.equal(h.NanoCpus, 2000000000); assert.equal(h.PidsLimit, 128);
  for (const k of ['Binds', 'Mounts', 'VolumesFrom', 'Devices', 'DeviceRequests']) assert.equal((h[k] || []).length, 0);
  assert.equal(Object.keys(h.PortBindings || {}).length, 0); assert.ok(!h.PidMode); assert.equal(h.IpcMode, 'private');
  assert.equal(h.LogConfig.Type, 'none'); assert.equal(h.AutoRemove, false); assert.ok(['no', ''].includes(h.RestartPolicy.Name));
  assert.deepEqual(h.Tmpfs, { '/work': WORK, '/tmp': TMP });
  return { network, user: c.Config.User, privileged: false, readonlyRootfs: true, capDrop: h.CapDrop,
    memory: h.Memory, nanoCpus: h.NanoCpus, pidsLimit: h.PidsLimit, binds: [], mounts: c.Mounts.map(m => ({ type: m.Type, destination: m.Destination })),
    credentialEnvironmentNames: [KEY_ENV], logDriver: 'none' };
}
async function runDirectDockerTask(image, files, options = {}) {
  const key = options.key === undefined ? readEvaluationKey() : validKey(options.key);
  const timeoutMs = options.timeoutMs ?? 120000, network = options.network ?? 'bridge';
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000);
  assert.ok(['bridge', 'none'].includes(network));
  if (!options.runDocker && process.platform !== 'linux') throw fail('evaluation_linux_required');
  const manifest = manifestFor(files); assert.ok(files.some(f => f.path === 'probe.cjs'));
  // No selected key, including an escaped JSON spelling, may be staged.
  for (const f of files) assert.ok(!f.bytes.includes(key) && !f.bytes.includes(JSON.stringify(key).slice(1, -1)), 'evaluation_input_contains_key');
  const run = options.runDocker || docker;
  assert.match(one(await run(['context', 'inspect', 'default'])).Endpoints?.docker?.Host, /^unix:\/\/\/[^\s\0]+$/);
  const img = one(await run(['image', 'inspect', image.imageId]));
  assert.equal(img.Id, image.imageId); assert.equal(img.Os, 'linux'); assert.equal(img.Architecture, image.architecture);
  assert.ok(img.RepoDigests.includes(image.repositoryDigest));
  assert.equal(Object.keys(img.Config.Volumes || {}).length, 0); assert.equal((img.Config.OnBuild || []).length, 0);
  assert.ok(!img.Config.Healthcheck?.Test?.length || img.Config.Healthcheck.Test[0] === 'NONE');
  assert.ok((img.Config.Env || []).every(e => !/^(?:CAFF_|PI_|OPENAI_|ANTHROPIC_|AWS_|NODE_OPTIONS=|NODE_PATH=|LD_|.*(?:KEY|TOKEN|PASSWORD)=)/i.test(e)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-direct-')), owner = crypto.randomUUID(), name = 'caff-direct-' + owner;
  const command = ['-c', 'tar --no-same-owner -xf - && exec timeout -k 2 ' + Math.ceil(timeoutMs / 1000) + ' node probe.cjs'];
  let id = '', created = false, result, proof;
  try {
    for (const f of [...files, { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) }]) {
      const target = path.join(root, f.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, f.bytes, { flag: 'wx', mode: 0o600 });
    }
    const archive = execFileSync('tar', ['-C', root, '-cf', '-', '.'], { env: { PATH: process.env.PATH }, maxBuffer: 24 * 1024 * 1024, timeout: 15000 });
    created = true;
    const c = await run(['create', '--name', name, '--label', LABEL + '=' + owner, '--pull', 'never', '-i', '--env', KEY_ENV,
      '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1g', '--memory-swap', '1g',
      '--cpus', '2', '--pids-limit', '128', '--user', '65534:65534', '--ipc', 'private', '--workdir', '/work', '--log-driver', 'none',
      '--tmpfs', '/work:' + WORK, '--tmpfs', '/tmp:' + TMP, '--entrypoint', '/bin/sh', image.imageId, ...command], { key });
    assert.ok(good(c), 'evaluation_create_failed'); id = c.stdout.trim(); assert.match(id, /^[a-f0-9]{64}$/);
    const pre = one(await run(['inspect', id])); proof = isolation(pre, image, owner, command, network); assert.equal(pre.State.Running, false);
    result = await run(['start', '-a', '-i', id], { input: archive, timeoutMs: timeoutMs + 5000 });
    const post = one(await run(['inspect', id])); isolation(post, image, owner, command, network);
    if (!result.failure) { assert.equal(post.State.Running, false); assert.equal(post.State.ExitCode, result.code); }
    // Raw Docker inspect includes runtime env; never return/save that object.
    // Failed worker stderr/provider bodies are deliberately not result material.
    if (!good(result) || post.State.OOMKilled) result = { code: result.code, failed: true, reason: result.failure || (post.State.OOMKilled ? 'oom' : 'worker_failed') };
    else if ([result.stdout, result.stderr].some(s => s.includes(key) || s.includes(JSON.stringify(key).slice(1, -1)))) throw fail('evaluation_output_contains_key');
    else { assert.equal(result.stderr, '', 'evaluation_worker_stderr'); result = { code: 0, receipt: JSON.parse(result.stdout) }; }
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
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  return { ...result, containerId: id, cleaned: true, isolation: proof, timeoutMs, inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash };
}
module.exports = { prepareDirectTurnFiles, runDirectDockerTask, isolation };
