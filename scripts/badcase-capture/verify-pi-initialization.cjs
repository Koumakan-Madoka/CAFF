// Explicit Linux-only real Docker experiment, NOT a production case launcher.
// Stages only trusted installed npm distribution files + fixed synthetic fixtures.
// No SDK import on host, npm install, image build/pull, real capture, credentials or model calls.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { prepareOfflineTask, runDockerCommand } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const { prepareProbeFiles, manifestFor } = require('./pi-probe-materials.cjs');
const { verifiedCleanupId } = require('./pi-probe-guards.cjs');
const LABEL = 'caff.badcase.pi-initialization';
const WORK = 'rw,nosuid,nodev,size=64m,uid=65534,gid=65534,mode=0700';
const TMP = 'rw,nosuid,nodev,noexec,size=16m,uid=65534,gid=65534,mode=0700';
const CMD = ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/work', 'TMPDIR=/tmp', '/bin/sh', '-c',
  'tar --no-same-owner -xf - && timeout -k 2 25 node probe.cjs'];
const good = r => r && r.code === 0 && !r.failure;
function one(r) { assert.ok(good(r), 'probe_docker_control_failed'); const a = JSON.parse(r.stdout); assert.equal(a.length, 1); return a[0]; }
function isolated(c, image, owner) {
  const h = c.HostConfig;
  assert.match(c.Id, /^[a-f0-9]{64}$/); assert.equal(c.Image, image.imageId);
  assert.equal(c.Config.Labels?.[LABEL], owner); assert.equal(c.Config.User, '65534:65534');
  assert.deepEqual(c.Config.Entrypoint, ['/usr/bin/env']); assert.deepEqual(c.Config.Cmd, CMD); assert.equal(c.Config.WorkingDir, '/work');
  assert.equal(Object.keys(c.Config.Volumes || {}).length, 0);
  assert.ok(c.Mounts.every(m => m.Type === 'tmpfs' && ['/work', '/tmp'].includes(m.Destination)));
  assert.equal(h.NetworkMode, 'none'); assert.equal(h.ReadonlyRootfs, true); assert.equal(h.Privileged, false);
  assert.deepEqual(h.CapDrop, ['ALL']); assert.equal((h.CapAdd || []).length, 0); assert.ok(h.SecurityOpt.includes('no-new-privileges'));
  assert.equal(h.Memory, 536870912); assert.equal(h.MemorySwap, 536870912); assert.equal(h.NanoCpus, 1000000000); assert.equal(h.PidsLimit, 64);
  for (const k of ['Binds', 'Mounts', 'VolumesFrom', 'Devices', 'DeviceRequests']) assert.equal((h[k] || []).length, 0);
  assert.equal(Object.keys(h.PortBindings || {}).length, 0); assert.ok(!h.PidMode); assert.equal(h.IpcMode, 'private');
  assert.equal(h.LogConfig.Type, 'none'); assert.equal(h.AutoRemove, false); assert.ok(['no', ''].includes(h.RestartPolicy.Name));
  assert.deepEqual(h.Tmpfs, { '/work': WORK, '/tmp': TMP });
}
async function runProbe(image, files, options = {}) {
  // Internal trusted transport injection routes the ENTIRE lifecycle, including cleanup.
  // Ordinary diagnostics retain the strict default-daemon image preflight.
  const runDocker = options.runDocker || runDockerCommand;
  const manifest = manifestFor(files);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-pi-init-'));
  const owner = crypto.randomUUID(), name = 'caff-pi-init-' + owner;
  let id = '', started = false, result;
  try {
    for (const f of [...files, { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) }]) {
      const target = path.join(root, f.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, f.bytes, { flag: 'wx', mode: 0o600 });
    }
    // Source is the allowlisted ordinary-file stage we just created, NOT user-supplied tar.
    const archive = execFileSync('tar', ['-C', root, '-cf', '-', '.'], { env: { PATH: process.env.PATH }, maxBuffer: 24 * 1024 * 1024, timeout: 15000 });
    started = true; // create can succeed even if its CLI response is lost
    const created = await runDocker(['create', '--name', name, '--label', LABEL + '=' + owner, '--pull', 'never', '-i',
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--memory-swap', '512m',
      '--cpus', '1', '--pids-limit', '64', '--user', '65534:65534', '--ipc', 'private', '--workdir', '/work', '--log-driver', 'none',
      '--tmpfs', '/work:' + WORK, '--tmpfs', '/tmp:' + TMP, '--entrypoint', '/usr/bin/env', image.imageId, ...CMD]);
    assert.ok(good(created), 'probe_create_failed'); id = created.stdout.trim(); assert.match(id, /^[a-f0-9]{64}$/);
    const pre = one(await runDocker(['inspect', id])); isolated(pre, image, owner); assert.equal(pre.State.Running, false);
    result = await runDocker(['start', '-a', '-i', id], { input: archive, timeoutMs: 30000 });
    const post = one(await runDocker(['inspect', id])); isolated(post, image, owner);
    assert.equal(post.State.Running, false); assert.equal(post.State.ExitCode, result.code); assert.equal(post.State.OOMKilled, false);
  } finally {
    try {
      if (started) {
        const found = await runDocker(['inspect', id || name]);
        if (good(found)) {
          const cleanupId = verifiedCleanupId(one(found), owner, id);
          assert.ok(good(await runDocker(['rm', '-f', cleanupId])), 'probe_cleanup_failed');
        } else assert.equal(id, '', 'probe_cleanup_unknown');
        const remaining = await runDocker(['ps', '-a', '--no-trunc', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']);
        assert.ok(good(remaining) && !remaining.stdout.trim(), 'probe_cleanup_failed');
      }
    } catch { throw Object.assign(Error('probe_cleanup_failed'), { containerName: name }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); } // only this invocation's synthetic stage
  }
  return { result, manifest, containerId: id };
}
async function verifyProbeImage(image) {
  if (process.platform !== 'linux') throw Error('probe_linux_required');
  prepareOfflineTask({ image, files: [{ path: 'x.cjs', base64: '', sha256: crypto.createHash('sha256').update('').digest('hex') }], entrypoint: 'x.cjs', timeoutMs: 30000 });
  const endpoint = one(await runDockerCommand(['context', 'inspect', 'default'])).Endpoints?.docker?.Host;
  assert.match(endpoint, /^unix:\/\/\/[^\s\0]+$/);
  const img = one(await runDockerCommand(['image', 'inspect', image.imageId]));
  assert.equal(img.Id, image.imageId); assert.ok(img.RepoDigests.includes(image.repositoryDigest)); assert.equal(img.Architecture, image.architecture); assert.equal(img.Os, 'linux');
  assert.equal(Object.keys(img.Config.Volumes || {}).length, 0); assert.equal((img.Config.OnBuild || []).length, 0);
  assert.ok(!img.Config.Healthcheck?.Test?.length || img.Config.Healthcheck.Test[0] === 'NONE');
}
async function main() {
  const args = process.argv.slice(2);
  const arg = name => { const i = args.indexOf('--' + name); if (i < 0 || !args[i + 1]) throw Error('probe_arguments_required'); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  await verifyProbeImage(image);
  const repo = path.resolve(__dirname, '../..');
  const reports = [], ids = [];
  for (const scenario of ['fresh', 'fresh-copy', 'resume', 'missing-dependency', 'wrong-sdk-version', 'wrong-ai-version', 'missing-session', 'broken-session']) {
    const mode = ['resume', 'missing-session', 'broken-session'].includes(scenario) ? 'resume' : 'fresh';
    let files = prepareProbeFiles(repo, mode);
    // Negative controls change fixed synthetic stages only, never installed packages or captured data.
    if (scenario === 'missing-dependency') files = files.filter(f => f.path !== 'runtime/dist/bundle/index.js');
    if (scenario === 'missing-session') files = files.filter(f => f.path !== 'resume.jsonl');
    if (scenario === 'broken-session') files.find(f => f.path === 'resume.jsonl').bytes = Buffer.from('{broken');
    if (scenario === 'wrong-sdk-version' || scenario === 'wrong-ai-version') {
      const f = files.find(f => f.path === (scenario === 'wrong-sdk-version' ? 'runtime/package.json' : 'runtime/bundled-pi-ai/package.json'));
      const p = JSON.parse(f.bytes); p.version = '999.0.0'; f.bytes = Buffer.from(JSON.stringify(p));
    }
    files.push({ path: 'environment.json', bytes: Buffer.from(JSON.stringify(image)) });
    const run = await runProbe(image, files); ids.push(run.containerId);
    if (['fresh', 'fresh-copy', 'resume'].includes(scenario)) {
      assert.ok(good(run.result)); assert.equal(run.result.stderr, '');
      const r = JSON.parse(run.result.stdout);
      assert.deepEqual(r, { kind: 'synthetic-pi-initialization', mode, piVersion: '0.85.1', inputHash: run.manifest.inputHash,
        runtimeHash: run.manifest.runtimeHash, runtimeBytes: run.manifest.runtimeBytes, historyMessages: mode === 'resume' ? 1 : 0,
        sessionBytesUnchanged: mode === 'resume' ? true : null, toolsVerified: ['read', 'write', 'edit', 'bash'], modelCalls: 0, networkCalls: 0,
        runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false });
      reports.push({ scenario, ...r });
    } else {
      assert.equal(run.result.code, 1); assert.equal(run.result.failure, undefined);
      assert.equal(run.result.stdout, ''); assert.equal(run.result.stderr, 'pi_initialization_probe_failed\n');
      reports.push({ scenario, blocked: true });
    }
  }
  assert.equal(reports[0].inputHash, reports[1].inputHash);
  assert.equal(reports[0].runtimeHash, reports[2].runtimeHash);
  assert.equal(new Set(ids).size, ids.length);
  console.log(JSON.stringify({ ok: true, image, reports, cleanedContainerIds: ids, modelInvocations: 0,
    artifactSource: 'allowlisted-installed-npm-distribution', imageArchived: false, retainedCaseLaunched: false, acceptance: false }, null, 2));
}
if (require.main === module) main().catch(e => { console.error(JSON.stringify({ ok: false, code: 'pi_initialization_verification_failed', containerName: e.containerName || null })); process.exitCode = 1; });
module.exports = { isolated, runProbe, verifyProbeImage };
