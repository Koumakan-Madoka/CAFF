const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareProbeFiles, manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-probe-materials-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'node_modules/@earendil-works/pi-coding-agent');
  function put(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  put(sdk + '/package.json', JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.85.1', type: 'module' }));
  put(sdk + '/dist/bundle/index.js', 'export const synthetic=true;');
  put(sdk + '/dist/bundle/chunks/chunk.js', '// synthetic dependency');
  put(sdk + '/dist/modes/interactive/theme/dark.json', '{}');
  for (const [pkg, version] of [['@earendil-works/chord', '0.85.1'], ['@earendil-works/pi-ai', '0.85.1'], ['typebox', '1.3.7']]) {
    put(sdk + '/node_modules/' + pkg + '/package.json', JSON.stringify({ name: pkg, version, type: 'module' }));
  }
  put(sdk + '/node_modules/@earendil-works/chord/dist/context/index.js', '// context');
  put(sdk + '/node_modules/typebox/build/esm/index.mjs', '// typebox');
  return { root, sdk, put };
}
test('stages only declared distribution files, stable manifest, and explicit synthetic sessions', t => {
  const f = fixture(t); f.put(f.sdk + '/auth.json', 'must not copy');
  f.put(f.sdk + '/node_modules/@earendil-works/chord/private.txt', 'must not copy');
  const a = prepareProbeFiles(f.root, 'fresh'), b = prepareProbeFiles(f.root, 'resume');
  assert.equal(a.some(x => x.path.includes('auth.json') || x.path.includes('private.txt')), false);
  assert.deepEqual(a.find(x => x.path === 'pi-probe-guards.cjs').bytes,
    fs.readFileSync(path.resolve(__dirname, '../../scripts/badcase-capture/pi-probe-guards.cjs')));
  assert.equal(a.some(x => x.path === 'resume.jsonl'), false);
  assert.equal(b.some(x => x.path === 'resume.jsonl'), true);
  assert.deepEqual(b.find(x => x.path === 'resume.jsonl').bytes, b.find(x => x.path === 'expected-session.jsonl').bytes);
  assert.deepEqual(a.find(x => x.path === 'expected-session.jsonl').bytes, b.find(x => x.path === 'expected-session.jsonl').bytes);
  const ma = manifestFor(a), mb = manifestFor(b);
  assert.equal(ma.runtimeHash, mb.runtimeHash);
  assert.notEqual(ma.inputHash, mb.inputHash);
  assert.deepEqual(manifestFor(prepareProbeFiles(f.root, 'fresh')), ma);
  assert.ok(ma.runtimeBytes > 0); assert.ok(ma.files.length > 4);
});
test('missing distributions and wrong pinned versions fail before Docker', t => {
  const f = fixture(t);
  for (const pkg of ['', '/node_modules/@earendil-works/pi-ai', '/node_modules/@earendil-works/chord', '/node_modules/typebox']) {
    const p = f.sdk + pkg + '/package.json', original = fs.readFileSync(p);
    const metadata = JSON.parse(original); metadata.version = '999.0.0'; fs.writeFileSync(p, JSON.stringify(metadata));
    assert.throws(() => prepareProbeFiles(f.root, 'fresh'), /probe_dependency_version/); fs.writeFileSync(p, original);
  }
  fs.unlinkSync(f.sdk + '/dist/bundle/index.js');
  assert.throws(() => prepareProbeFiles(f.root, 'fresh'), /probe_dependency_missing/);
  assert.throws(() => prepareProbeFiles(f.root, 'other'), /probe_mode_invalid/);
});
test('rejects filesystem links rather than copying outside the selected distributions', t => {
  const f = fixture(t), p = f.sdk + '/dist/bundle/chunks/link.js';
  try { fs.symlinkSync(f.sdk + '/package.json', p); } catch (e) { if (e.code === 'EPERM') return t.skip('symlink privilege unavailable'); throw e; }
  assert.throws(() => prepareProbeFiles(f.root, 'fresh'), /probe_dependency_type/);
});
test('dependency read size is bounded and manifest rejects duplicate/escaping names', t => {
  const f = fixture(t); f.put(f.sdk + '/dist/bundle/chunks/huge.js', Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.throws(() => prepareProbeFiles(f.root, 'fresh'), /probe_dependency_size/);
  assert.throws(() => manifestFor([{ path: '../outside', bytes: Buffer.from('x') }]), /probe_file_invalid/);
  assert.throws(() => manifestFor([{ path: 'a', bytes: Buffer.from('x') }, { path: 'a', bytes: Buffer.from('y') }]), /probe_file_invalid/);
});
test('inspect guard rejects unsafe container configuration and command substitution', async () => {
  const { isolated } = require('../../scripts/badcase-capture/verify-pi-initialization.cjs');
  const fakeDocker = require('../helpers/badcase-fake-docker.cjs');
  const image = { imageId: 'sha256:' + 'a'.repeat(64) }, owner = 'synthetic-owner';
  const cmd = ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/work', 'TMPDIR=/tmp', '/bin/sh', '-c', 'tar --no-same-owner -xf - && timeout -k 2 25 node probe.cjs'];
  const docker = fakeDocker(image);
  await docker.run(['create', '--name', 'synthetic', '--label', 'caff.badcase.offline=' + owner, image.imageId, ...cmd]);
  const base = JSON.parse((await docker.run(['inspect', 'b'.repeat(64)])).stdout)[0];
  base.Config.Labels = { 'caff.badcase.pi-initialization': owner };
  assert.doesNotThrow(() => isolated(base, image, owner));
  for (const change of [
    c => { c.Image = 'other'; }, c => { c.Config.Labels = {}; }, c => { c.Config.User = '0'; },
    c => { c.Config.Entrypoint = ['/bin/sh']; }, c => { c.Config.Cmd.push('other'); }, c => { c.Config.WorkingDir = '/'; },
    c => { c.Config.Volumes = { '/data': {} }; }, c => { c.Mounts = [{ Type: 'bind', Destination: '/work' }]; },
    c => { c.HostConfig.NetworkMode = 'host'; }, c => { c.HostConfig.ReadonlyRootfs = false; }, c => { c.HostConfig.Privileged = true; },
    c => { c.HostConfig.CapDrop = []; }, c => { c.HostConfig.CapAdd = ['SYS_ADMIN']; }, c => { c.HostConfig.SecurityOpt = []; },
    c => { c.HostConfig.Memory = 0; }, c => { c.HostConfig.MemorySwap = -1; }, c => { c.HostConfig.NanoCpus = 0; }, c => { c.HostConfig.PidsLimit = 0; },
    ...['Binds', 'Mounts', 'VolumesFrom', 'Devices', 'DeviceRequests'].map(k => c => { c.HostConfig[k] = ['unsafe']; }),
    c => { c.HostConfig.PortBindings = { '80/tcp': [] }; }, c => { c.HostConfig.PidMode = 'host'; }, c => { c.HostConfig.IpcMode = 'host'; },
    c => { c.HostConfig.LogConfig.Type = 'json-file'; }, c => { c.HostConfig.AutoRemove = true; }, c => { c.HostConfig.RestartPolicy.Name = 'always'; },
    c => { c.HostConfig.Tmpfs['/tmp'] = 'rw'; },
  ]) { const c = structuredClone(base); change(c); assert.throws(() => isolated(c, image, owner)); }
});
test('real probe orchestrator uses injected transport and observes before start; observer failure cleans without starting', async () => {
  // Compile unchanged trusted orchestration with a DENY default transport and fake
  // tar. No Docker, shell, SDK or model runs on this unit-test path.
  const Module = require('node:module');
  const filename = path.resolve(__dirname, '../../scripts/badcase-capture/verify-pi-initialization.cjs');
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = m.require.bind(m);
  let defaultCalls = 0;
  m.require = name => name === 'node:child_process' ? { execFileSync: () => Buffer.from('synthetic tar') }
    : name.endsWith('/badcase-capture/docker-sandbox') ? { runDockerCommand: async () => { defaultCalls++; throw Error('default_transport_forbidden'); } }
    : nativeRequire(name);
  m._compile(fs.readFileSync(filename, 'utf8'), filename);
  const image = { imageId: 'sha256:' + 'a'.repeat(64) };
  for (const reject of [false, true]) {
    const events = [];
    const fake = require('../helpers/badcase-fake-docker.cjs')(image, { change(args, result, state) {
      events.push(args[0]);
      if (args[0] === 'inspect') { const c = state.info(); c.Config.Labels = { 'caff.badcase.pi-initialization': state.owner }; result.stdout = JSON.stringify([c]); }
    } });
    const options = { runDocker: fake.run, observeCreated: async (id, owner) => {
      events.push('observe'); assert.equal(id, 'b'.repeat(64)); assert.ok(owner);
      assert.equal(events.includes('start'), false);
      if (reject) throw Error('target_container_missing');
    }, observeCompleted: async () => { events.push('observe-completed'); assert.equal(events.includes('start'), true); assert.equal(events.includes('rm'), false); },
      observeRemoved: async () => { events.push('observe-removed'); assert.equal(events.includes('rm'), true); } };
    const pending = m.exports.runProbe(image, [{ path: 'probe.cjs', bytes: Buffer.from('// inert') }], options);
    if (reject) { await assert.rejects(pending, /target_container_missing/); assert.equal(events.includes('start'), false); }
    else { assert.equal((await pending).containerId, 'b'.repeat(64)); assert.ok(events.indexOf('observe') < events.indexOf('start')); }
    assert.ok(events.includes('observe')); assert.ok(events.includes('rm')); assert.equal(events.at(-1), 'observe-removed');
    assert.equal(events.includes('observe-completed'), !reject);
  }
  assert.equal(defaultCalls, 0);
});
test('container entry refuses host execution before importing SDK', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['scripts/badcase-capture/pi-initialize-probe.cjs'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'pi_initialization_probe_failed\n');
});
