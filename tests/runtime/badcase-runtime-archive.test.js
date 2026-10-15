// Static trusted artifacts only. Never imports or runs the archived SDK on the host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { archiveRuntime, readRuntimeArchive } = require('../../scripts/badcase-capture/runtime-archive.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-runtime-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'archive');
  const sdk = path.join(source, 'node_modules/@earendil-works/pi-coding-agent');
  const put = (p, b) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
  for (const [prefix, name, version] of [
    ['', '@earendil-works/pi-coding-agent', '0.85.1'],
    ['/node_modules/@earendil-works/chord', '@earendil-works/chord', '0.85.1'],
    ['/node_modules/@earendil-works/pi-ai', '@earendil-works/pi-ai', '0.85.1'],
    ['/node_modules/typebox', 'typebox', '1.3.7'],
  ]) put(sdk + prefix + '/package.json', JSON.stringify({ name, version, type: 'module' }));
  put(sdk + '/dist/bundle/index.js', 'throw Error("must never execute on host");');
  put(sdk + '/dist/bundle/chunk.js', '// another bundle file keeps tree nonempty when entry is removed');
  put(sdk + '/dist/modes/interactive/theme/dark.json', '{}');
  put(sdk + '/node_modules/@earendil-works/chord/dist/context/index.js', '// synthetic');
  put(sdk + '/node_modules/typebox/build/esm/index.mjs', '// synthetic');
  put(sdk + '/auth.json', 'excluded synthetic auth sentinel');
  return { root, source, destination, sdk };
}
function rewrite(ref, mutate) {
  const file = path.join(ref.directory, 'runtime.json');
  const d = JSON.parse(fs.readFileSync(file)); mutate(d);
  const bytes = Buffer.from(JSON.stringify(d)); fs.writeFileSync(file, bytes);
  return { ...ref, archiveHash: hash(bytes), archiveBytes: bytes.length };
}
test('archive survives removal of source, repeats byte-for-byte, and only contains runtime whitelist', t => {
  const f = fixture(t), a = archiveRuntime(f.source, f.destination);
  const b = archiveRuntime(f.source, path.join(f.root, 'second'));
  assert.equal(a.archiveHash, b.archiveHash); assert.equal(a.archiveBytes, b.archiveBytes);
  const before = readRuntimeArchive(a);
  assert.ok(before.every(x => x.path.startsWith('runtime/')));
  assert.equal(before.some(x => /auth.json|probe.cjs|session|capsule/.test(x.path)), false);
  fs.rmSync(f.source, { recursive: true });
  const after = readRuntimeArchive(a);
  assert.deepEqual(after, before);
  assert.equal(manifestFor(after).runtimeHash, a.runtimeHash);
  assert.equal(manifestFor(after).runtimeBytes, a.runtimeBytes);
  assert.deepEqual(Object.keys(a).sort(), ['archiveBytes', 'archiveHash', 'directory', 'runtimeBytes', 'runtimeHash']);
  assert.equal(fs.statSync(path.join(a.directory, 'runtime.json')).size, a.archiveBytes);
});
test('existing destination is not overwritten, and invalid source never creates destination', t => {
  const f = fixture(t), a = archiveRuntime(f.source, f.destination);
  const bytes = fs.readFileSync(path.join(a.directory, 'runtime.json'));
  assert.throws(() => archiveRuntime(f.source, f.destination), { code: 'runtime_archive_write_failed' });
  assert.deepEqual(fs.readFileSync(path.join(a.directory, 'runtime.json')), bytes);
  fs.unlinkSync(f.sdk + '/dist/bundle/index.js');
  const target = path.join(f.root, 'missing');
  assert.throws(() => archiveRuntime(f.source, target), /probe_dependency_missing/);
  assert.equal(fs.existsSync(target), false);
});
test('missing, damaged or incorrectly pinned artifact fails closed', t => {
  const f = fixture(t), a = archiveRuntime(f.source, f.destination), file = path.join(a.directory, 'runtime.json');
  for (const delta of [{ archiveHash: '0'.repeat(64) }, { archiveBytes: a.archiveBytes + 1 },
    { runtimeHash: '0'.repeat(64) }, { runtimeBytes: a.runtimeBytes + 1 }, { extra: true }, { archiveBytes: 24 * 1024 * 1024 + 1 }]) {
    assert.throws(() => readRuntimeArchive({ ...a, ...delta }), { code: 'runtime_archive_invalid' });
  }
  fs.appendFileSync(file, ' ');
  assert.throws(() => readRuntimeArchive(a), { code: 'runtime_archive_invalid' });
  fs.unlinkSync(file);
  assert.throws(() => readRuntimeArchive(a), { code: 'runtime_archive_invalid' });
});
test('even with a newly supplied outer hash, malformed inventories and per-file corruption are refused', t => {
  const changes = [d => { d.schemaVersion = 2; }, d => { d.extra = true; },
    d => { d.files[0].base64 = '***'; }, d => { d.files[0].base64 += '='; }, d => { d.files[0].base64 = Buffer.from('tampered').toString('base64'); },
    d => { d.files[0].size++; }, d => { d.files[0].sha256 = '0'.repeat(64); },
    d => { d.files.push(d.files[0]); }, d => { d.files[0].path = '../escape'; },
    d => { d.files[0].path = 'runtime/auth.json'; }, d => { d.files = []; },
    d => { d.files[0].extra = true; }, d => { d.files = Array(4097).fill(d.files[0]); }];
  for (const change of changes) {
    const f = fixture(t), a = archiveRuntime(f.source, f.destination);
    assert.throws(() => readRuntimeArchive(rewrite(a, change)), { code: 'runtime_archive_invalid' });
  }
});
test('recomputed artifact hashes cannot bypass pinned package versions or required entry', t => {
  for (const edit of [files => files.filter(f => f.path !== 'runtime/dist/bundle/index.js'), files => {
    const f = files.find(f => f.path === 'runtime/bundled-pi-ai/package.json');
    const p = JSON.parse(f.bytes); p.version = '999'; f.bytes = Buffer.from(JSON.stringify(p)); return files;
  }]) {
    const f = fixture(t), a = archiveRuntime(f.source, f.destination);
    const files = edit(readRuntimeArchive(a)); const m = manifestFor(files);
    const changed = rewrite(a, d => { d.files = files.map(x => ({ path: x.path, size: x.bytes.length, sha256: hash(x.bytes), base64: x.bytes.toString('base64') })); });
    assert.throws(() => readRuntimeArchive({ ...changed, runtimeHash: m.runtimeHash, runtimeBytes: m.runtimeBytes }), { code: 'runtime_archive_invalid' });
  }
});
test('archive reader rejects directory links and non-files', t => {
  const f = fixture(t), a = archiveRuntime(f.source, f.destination), alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readRuntimeArchive({ ...a, directory: alias }), { code: 'runtime_archive_invalid' });
  const file = path.join(a.directory, 'runtime.json'); fs.unlinkSync(file); fs.mkdirSync(file);
  assert.throws(() => readRuntimeArchive(a), { code: 'runtime_archive_invalid' });
});
test('archive reader rejects file links', t => {
  const f = fixture(t), a = archiveRuntime(f.source, f.destination), alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readRuntimeArchive({ ...a, directory: alias }), { code: 'runtime_archive_invalid' });
  const file = path.join(a.directory, 'runtime.json'); fs.renameSync(file, file + '.saved');
  try { fs.symlinkSync(file + '.saved', file); } catch (e) { if (e.code === 'EPERM') return t.skip('file symlink privilege unavailable; directory-link assertion passed'); throw e; }
  assert.throws(() => readRuntimeArchive(a), { code: 'runtime_archive_invalid' });
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.throws(() => readRuntimeArchive(a), { code: 'runtime_archive_invalid' });
});
test('write failure never publishes a success reference or erases an incomplete destination', t => {
  const f = fixture(t), original = fs.writeFileSync;
  fs.writeFileSync = (...args) => { if (typeof args[0] === 'number') throw Object.assign(Error('synthetic disk fault'), { code: 'ENOSPC' }); return original(...args); };
  try { assert.throws(() => archiveRuntime(f.source, f.destination), { code: 'runtime_archive_write_failed' }); }
  finally { fs.writeFileSync = original; }
  assert.equal(fs.existsSync(f.destination), true);
  assert.throws(() => archiveRuntime(f.source, f.destination), { code: 'runtime_archive_write_failed' });
});
test('fsync failure and corrupted write-back cannot publish a reference', t => {
  for (const phase of ['sync', 'corrupt']) {
    const f = fixture(t), sync = fs.fsyncSync, write = fs.writeFileSync;
    fs.fsyncSync = fd => { if (phase === 'sync') throw Error('synthetic fsync failure'); return sync(fd); };
    fs.writeFileSync = (fd, bytes, ...rest) => {
      if (phase === 'corrupt' && typeof fd === 'number') { bytes = Buffer.from(bytes); bytes[0] ^= 1; }
      return write(fd, bytes, ...rest);
    };
    try { assert.throws(() => archiveRuntime(f.source, f.destination), { code: 'runtime_archive_write_failed' }); }
    finally { fs.fsyncSync = sync; fs.writeFileSync = write; }
  }
});
test('archive-selected staging never reads installed packages, and a bad reference never falls back', t => {
  const { stageDiagnostic } = require('../../scripts/badcase-capture/retained-sdk-diagnostic.cjs');
  const f = fixture(t), a = archiveRuntime(f.source, f.destination);
  fs.rmSync(f.source, { recursive: true });
  const original = fs.readFileSync;
  fs.readFileSync = (p, ...args) => { if (typeof p === 'string' && p.replaceAll('\\', '/').includes('/node_modules/')) throw Error('unexpected installed dependency read'); return original(p, ...args); };
  try {
    const files = stageDiagnostic('{}', {}, {}, a);
    assert.equal(manifestFor(files).runtimeHash, a.runtimeHash);
    assert.ok(files.some(x => x.path === 'capsule.json'));
    assert.throws(() => stageDiagnostic('{}', {}, {}, { ...a, archiveHash: '0'.repeat(64) }), { code: 'runtime_archive_invalid' });
    assert.throws(() => stageDiagnostic('{}', {}, {}, null), { code: 'runtime_archive_invalid' });
    assert.throws(() => stageDiagnostic('{}', {}, {}, undefined), { code: 'runtime_archive_invalid' });
  } finally { fs.readFileSync = original; }
});
test('invalid archive stops wrapper before transport while retaining input protection', async t => {
  const fixture = require('../helpers/badcase-initialization-fixture.cjs');
  const { runRetainedSdkDiagnostic } = require('../../scripts/badcase-capture/retained-sdk-diagnostic.cjs');
  const h = fixture(t, 'fresh'); let calls = 0;
  await assert.rejects(runRetainedSdkDiagnostic(h.request, {}, { runtimeArchive: null, runProbe: async () => { calls++; } }), { code: 'runtime_archive_invalid' });
  assert.equal(calls, 0); assert.equal(fs.readdirSync(h.runDir).length, 1);
});
