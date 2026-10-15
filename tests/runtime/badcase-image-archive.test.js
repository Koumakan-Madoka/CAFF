// Synthetic bytes and injected local Docker control only; no daemon or model required.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { archiveImage, verifyImageArchive, saveImageStream } = require('../../scripts/badcase-capture/image-archive.cjs');
const image = { imageId: 'sha256:' + 'a'.repeat(64), repositoryDigest: 'node@sha256:' + 'b'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
function setup(t, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-image-archive-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], inspected = { Id: image.imageId, RepoDigests: [image.repositoryDigest], Architecture: 'amd64', Os: 'linux', Config: {} };
  const options = { runDocker: async args => {
    calls.push(args);
    const value = args[0] === 'context' ? { Endpoints: { docker: { Host: 'unix:///synthetic.sock' } } } : structuredClone(inspected);
    mutate(value, calls.length);
    return { code: 0, stdout: JSON.stringify([value]), stderr: '' };
  }, save: async (id, fd) => { calls.push(['save', id]); fs.writeSync(fd, Buffer.from('synthetic opaque image bytes')); } };
  return { root, destination: path.join(root, 'archive'), calls, options };
}
test('image export binds trusted identity, verifies disk bytes without Docker and never loads', async t => {
  const h = setup(t), ref = await archiveImage(image, h.destination, h.options);
  assert.deepEqual(Object.keys(ref).sort(), ['archiveBytes', 'archiveHash', 'directory', 'metadataBytes', 'metadataHash']);
  const v = verifyImageArchive(ref);
  assert.deepEqual(v.image, image); assert.equal(v.os, 'linux'); assert.equal(v.kind, 'trusted-docker-image-export');
  assert.equal(v.archiveBytes, 28); assert.equal(v.runtimeVersionsVerified, false);
  assert.equal(v.restored, false); assert.equal(v.runnable, false);
  assert.deepEqual(h.calls.map(a => a[0]), ['context', 'image', 'save', 'image']);
  assert.deepEqual(h.calls[2], ['save', image.imageId]);
  assert.equal(fs.readdirSync(h.destination).sort().join(','), 'image.tar,metadata.json');
});
test('wrong image, unsafe config, changed post identity and remote daemon fail closed', async t => {
  for (const change of [v => { if (v.Id) v.Id = 'sha256:' + 'c'.repeat(64); },
    v => { if (v.Id) v.RepoDigests = []; }, v => { if (v.Id) v.Architecture = 'arm64'; },
    v => { if (v.Id) v.Os = 'windows'; }, v => { if (v.Config) v.Config.Volumes = { '/data': {} }; },
    v => { if (v.Config) v.Config.OnBuild = ['RUN true']; }, v => { if (v.Config) v.Config.Healthcheck = { Test: ['CMD', 'true'] }; },
    (v, n) => { if (v.Id && n === 4) v.RepoDigests = []; },
    v => { if (v.Endpoints) v.Endpoints.docker.Host = 'tcp://remote:2375'; }]) {
    const h = setup(t, change);
    await assert.rejects(archiveImage(image, h.destination, h.options), { code: 'image_archive_write_failed' });
    assert.equal(fs.existsSync(path.join(h.destination, 'metadata.json')), false);
  }
});
test('missing, tampered, truncated, extra-key and over-limit references are rejected', async t => {
  const h = setup(t), ref = await archiveImage(image, h.destination, h.options);
  for (const change of [{ archiveHash: 'c'.repeat(64) }, { archiveBytes: ref.archiveBytes + 1 }, { metadataHash: 'c'.repeat(64) },
    { metadataBytes: ref.metadataBytes + 1 }, { archiveBytes: 4 * 1024 ** 3 + 1 }, { metadataBytes: 65537 }, { extra: true }, { directory: 'relative' }]) {
    assert.throws(() => verifyImageArchive({ ...ref, ...change }), { code: 'image_archive_invalid' });
  }
  const file = path.join(h.destination, 'image.tar'), bytes = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.alloc(bytes.length, 1));
  assert.throws(() => verifyImageArchive(ref), { code: 'image_archive_invalid' });
  fs.writeFileSync(file, bytes.subarray(1));
  assert.throws(() => verifyImageArchive(ref), { code: 'image_archive_invalid' });
  fs.unlinkSync(file); assert.throws(() => verifyImageArchive(ref), { code: 'image_archive_invalid' });
});
test('metadata schema and linkage are rechecked even with a new external metadata hash', async t => {
  const crypto = require('node:crypto');
  const h = setup(t), ref = await archiveImage(image, h.destination, h.options);
  const file = path.join(h.destination, 'metadata.json'), base = JSON.parse(fs.readFileSync(file));
  for (const change of [d => { d.schemaVersion = 2; }, d => { d.kind = 'other'; }, d => { d.os = 'windows'; },
    d => { d.extra = true; }, d => { d.archiveHash = 'c'.repeat(64); }, d => { d.archiveBytes++; },
    d => { d.image.nodeVersion = 'floating'; }, d => { d.image.extra = true; }]) {
    const d = structuredClone(base); change(d); const bytes = Buffer.from(JSON.stringify(d)); fs.writeFileSync(file, bytes);
    const changed = { ...ref, metadataBytes: bytes.length, metadataHash: crypto.createHash('sha256').update(bytes).digest('hex') };
    assert.throws(() => verifyImageArchive(changed), { code: 'image_archive_invalid' });
  }
});
test('invalid template fails before filesystem or Docker side effects', async t => {
  for (const change of [{ imageId: 'node:latest' }, { repositoryDigest: '' }, { architecture: 'windows' }, { extra: true }]) {
    const h = setup(t);
    await assert.rejects(archiveImage({ ...image, ...change }, h.destination, h.options), { code: 'image_archive_write_failed' });
    assert.equal(h.calls.length, 0); assert.equal(fs.existsSync(h.destination), false);
  }
});
test('reference bounds reject before touching filesystem', () => {
  const old = fs.lstatSync; let reads = 0;
  fs.lstatSync = () => { reads++; throw Error('unexpected'); };
  try {
    const ref = { directory: path.resolve('unused'), archiveHash: 'a'.repeat(64), archiveBytes: 4 * 1024 ** 3 + 1, metadataHash: 'b'.repeat(64), metadataBytes: 100 };
    assert.throws(() => verifyImageArchive(ref), { code: 'image_archive_invalid' });
    assert.equal(reads, 0);
  } finally { fs.lstatSync = old; }
});
test('existing destination untouched; failed stream/fsync/readback never returns a reference', async t => {
  const h = setup(t); fs.mkdirSync(h.destination); fs.writeFileSync(path.join(h.destination, 'sentinel'), 'keep');
  await assert.rejects(archiveImage(image, h.destination, h.options), { code: 'image_archive_write_failed' });
  assert.equal(fs.readFileSync(path.join(h.destination, 'sentinel'), 'utf8'), 'keep');
  for (const mode of ['save', 'sync', 'readback']) {
    const h = setup(t), old = fs.fsyncSync;
    if (mode === 'save') h.options.save = async (id, fd) => { fs.writeSync(fd, 'partial'); throw Error('save'); };
    if (mode === 'sync') fs.fsyncSync = () => { throw Error('disk'); };
    if (mode === 'readback') fs.fsyncSync = fd => { old(fd); fs.writeSync(fd, Buffer.from('X'), 0, 1, 0); };
    try { await assert.rejects(archiveImage(image, h.destination, h.options), { code: 'image_archive_write_failed' }); }
    finally { fs.fsyncSync = old; }
    assert.ok(fs.existsSync(h.destination));
  }
});
test('archive symlinks and non-regular files refused', async t => {
  const h = setup(t), ref = await archiveImage(image, h.destination, h.options);
  const file = path.join(h.destination, 'image.tar'), outside = path.join(h.root, 'outside');
  fs.renameSync(file, outside);
  fs.mkdirSync(file); assert.throws(() => verifyImageArchive(ref), { code: 'image_archive_invalid' }); fs.rmdirSync(file);
  try { fs.symlinkSync(outside, file, 'file'); } catch { t.skip('file symlink unavailable; non-file assertion passed'); return; }
  assert.throws(() => verifyImageArchive(ref), { code: 'image_archive_invalid' });
});
test('only one export active; admission retained through save completion', async t => {
  const h = setup(t), h2 = setup(t); let release, entered;
  const started = new Promise(r => { entered = r; });
  h.options.save = async (id, fd) => { entered(); await new Promise(r => { release = r; }); fs.writeSync(fd, 'bytes'); };
  const first = archiveImage(image, h.destination, h.options); await started;
  await assert.rejects(archiveImage(image, h2.destination, h2.options), { code: 'image_archive_busy' });
  assert.equal(h2.calls.length, 0); release(); await first;
});
test('stream CLI lifecycle with a real synthetic child rejects nonzero exit and kills timeout', async t => {
  const { spawn } = require('node:child_process');
  const h = setup(t);
  for (const mode of ['good', 'exit', 'timeout']) {
    let child, closed = false;
    const fd = fs.openSync(path.join(h.root, mode), 'wx');
    const program = mode === 'timeout' ? 'setInterval(()=>{},1000)' : `process.stdout.write('bytes');process.exitCode=${mode === 'exit' ? 1 : 0}`;
    const shim = () => { child = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'] }); child.on('close', () => { closed = true; }); return child; };
    try {
      const p = saveImageStream(image.imageId, fd, { spawn: shim, timeoutMs: mode === 'timeout' ? 50 : 5000 });
      if (mode === 'good') await p; else await assert.rejects(p, { code: 'image_archive_stream_failed' });
      assert.equal(closed, true); assert.ok(child.exitCode !== null || child.signalCode !== null);
    } finally { fs.closeSync(fd); }
  }
});
function fakeSpawn(run) {
  return (exe, args, opts) => {
    assert.equal(exe, 'docker'); assert.deepEqual(args, ['--context', 'default', 'image', 'save', image.imageId]);
    assert.equal(opts.shell, false); assert.equal(opts.env.DOCKER_HOST, undefined); assert.equal(opts.env.NODE_OPTIONS, undefined);
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.kill = () => { setImmediate(() => c.emit('close', null, 'SIGKILL')); return true; };
    setImmediate(() => run(c)); return c;
  };
}
test('stream saves chunks; nonzero exit, empty, excess bytes/stderr, timeout and write failure reject', async t => {
  const h = setup(t);
  for (const mode of ['good', 'exit', 'empty', 'limit', 'stderr', 'timeout', 'write', 'spawn']) {
    const fd = fs.openSync(path.join(h.root, mode), 'wx');
    const spawn = fakeSpawn(c => {
      if (mode === 'timeout') return;
      if (mode === 'spawn') { c.emit('error', Error('spawn')); c.emit('close', -1); return; }
      if (mode !== 'empty') { c.stdout.write(Buffer.from('ab')); c.stdout.write(Buffer.from('cd')); }
      if (mode === 'stderr') c.stderr.write(Buffer.alloc(65537));
      c.emit('close', mode === 'exit' ? 1 : 0);
    });
    try {
      const result = saveImageStream(image.imageId, mode === 'write' ? -1 : fd, { spawn, maxBytes: mode === 'limit' ? 3 : 100, timeoutMs: 20 });
      if (mode === 'good') { await result; assert.equal(fs.readFileSync(path.join(h.root, mode), 'utf8'), 'abcd'); }
      else await assert.rejects(result, { code: 'image_archive_stream_failed' });
    } finally { fs.closeSync(fd); }
  }
});
