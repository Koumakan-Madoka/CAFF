// Only synthetic trusted code bytes; never executes the archived code on the host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { archiveHarness, readHarnessArchive, prepareHarnessFiles } = require('../../scripts/badcase-capture/harness-archive.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const sources = ['scripts/badcase-capture/pi-probe-guards.cjs', 'scripts/badcase-capture/retained-sdk-container.cjs',
  ...['retained-sdk-diagnostic', 'capsule-materialization', 'secrets', 'replay-path'].map(n => `build/server/domain/runtime/badcase-capture/${n}.js`)];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-harness-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  for (const name of sources) { const p = path.join(source, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `throw Error(${JSON.stringify(name)});`); }
  return { root, source, destination: path.join(root, 'archive') };
}
function rewrite(a, change) {
  const p = path.join(a.directory, 'harness.json'), data = JSON.parse(fs.readFileSync(p)); change(data);
  const bytes = Buffer.from(JSON.stringify(data)); fs.writeFileSync(p, bytes);
  return { ...a, archiveHash: hash(bytes), archiveBytes: bytes.length };
}
test('current harness survives removal of sources, repeats exactly, and includes guard/shared path checks', t => {
  const f = fixture(t), a = archiveHarness(f.source, f.destination), b = archiveHarness(f.source, path.join(f.root, 'second'));
  assert.equal(a.archiveHash, b.archiveHash);
  const files = readHarnessArchive(a); assert.deepEqual(files, prepareHarnessFiles(f.source));
  assert.deepEqual(files.map(x => x.path).sort(), ['capsule-materialization.js', 'pi-probe-guards.cjs', 'probe.cjs', 'replay-path.cjs', 'replay-path.js', 'retained-sdk-diagnostic.js', 'secrets.js']);
  fs.rmSync(f.source, { recursive: true }); assert.deepEqual(readHarnessArchive(a), files);
  assert.deepEqual(Object.keys(a).sort(), ['archiveBytes', 'archiveHash', 'directory', 'harnessBytes', 'harnessHash']);
});
test('legacy five-file archives keep their exact bytes and identity without reading live helpers', t => {
  const f = fixture(t), current = archiveHarness(f.source, f.destination), file = path.join(current.directory, 'harness.json');
  const data = JSON.parse(fs.readFileSync(file)); data.files = data.files.filter(f => !f.path.startsWith('replay-path.'));
  const bytes = Buffer.from(JSON.stringify(data)), files = data.files.map(f => ({ path: f.path, bytes: Buffer.from(f.base64, 'base64') }));
  const m = require('../../scripts/badcase-capture/pi-probe-materials.cjs').manifestFor(files);
  const ref = { ...current, archiveHash: hash(bytes), archiveBytes: bytes.length, harnessHash: m.inputHash, harnessBytes: files.reduce((n, f) => n + f.bytes.length, 0) };
  fs.writeFileSync(file, bytes); fs.rmSync(f.source, { recursive: true });
  assert.deepEqual(readHarnessArchive(ref), files); assert.deepEqual(fs.readFileSync(file), bytes);
});
test('harness rejects missing, changed, malformed or incorrectly pinned bytes', t => {
  const f = fixture(t), a = archiveHarness(f.source, f.destination);
  for (const delta of [{ archiveHash: '0'.repeat(64) }, { harnessHash: '0'.repeat(64) }, { archiveBytes: a.archiveBytes + 1 }, { harnessBytes: a.harnessBytes + 1 }, { extra: 1 }]) {
    assert.throws(() => readHarnessArchive({ ...a, ...delta }), { code: 'harness_archive_invalid' });
  }
  fs.appendFileSync(path.join(a.directory, 'harness.json'), ' ');
  assert.throws(() => readHarnessArchive(a), { code: 'harness_archive_invalid' });
  fs.unlinkSync(path.join(a.directory, 'harness.json'));
  assert.throws(() => readHarnessArchive(a), { code: 'harness_archive_invalid' });
});
test('schema, base64, hashes and exact supported inventories are rechecked even with a new outer hash', t => {
  for (const change of [d => { d.extra = true; }, d => { d.kind = 'other'; }, d => { d.files.pop(); },
    d => { d.files.push(d.files[0]); }, d => { d.files[0].path = '../escape'; }, d => { d.files[0].extra = true; },
    d => { d.files[0].base64 += '='; }, d => { d.files[0].sha256 = '0'.repeat(64); }, d => { d.files[0].size++; }]) {
    const f = fixture(t), a = archiveHarness(f.source, f.destination);
    assert.throws(() => readHarnessArchive(rewrite(a, change)), { code: 'harness_archive_invalid' });
  }
});
test('oversized reference fails before filesystem access or allocation', t => {
  const f = fixture(t), a = archiveHarness(f.source, f.destination), original = fs.lstatSync; let accesses = 0;
  fs.lstatSync = () => { accesses++; throw Error('must not access fs'); };
  try { assert.throws(() => readHarnessArchive({ ...a, archiveBytes: 2 * 1024 * 1024 + 1 }), { code: 'harness_archive_invalid' }); }
  finally { fs.lstatSync = original; }
  assert.equal(accesses, 0);
});
test('existing destination and incomplete publication never get overwritten or removed', t => {
  const f = fixture(t), a = archiveHarness(f.source, f.destination), before = fs.readFileSync(path.join(a.directory, 'harness.json'));
  assert.throws(() => archiveHarness(f.source, f.destination), { code: 'harness_archive_write_failed' });
  assert.deepEqual(fs.readFileSync(path.join(a.directory, 'harness.json')), before);
  for (const fault of ['write', 'sync', 'corrupt']) {
    const dest = path.join(f.root, fault), write = fs.writeFileSync, sync = fs.fsyncSync;
    fs.writeFileSync = (fd, bytes, ...rest) => { if (typeof fd === 'number') { if (fault === 'write') throw Error('disk fault'); if (fault === 'corrupt') { bytes = Buffer.from(bytes); bytes[0] ^= 1; } } return write(fd, bytes, ...rest); };
    fs.fsyncSync = fd => { if (fault === 'sync') throw Error('sync fault'); return sync(fd); };
    try { assert.throws(() => archiveHarness(f.source, dest), { code: 'harness_archive_write_failed' }); }
    finally { fs.writeFileSync = write; fs.fsyncSync = sync; }
    assert.equal(fs.existsSync(dest), true);
  }
});
test('source missing, oversized, or symlink refuses publication; archive directory links refused', t => {
  const f = fixture(t), p = path.join(f.source, sources[0]);
  fs.unlinkSync(p); assert.throws(() => archiveHarness(f.source, f.destination), { code: 'harness_archive_write_failed' });
  assert.equal(fs.existsSync(f.destination), false);
  fs.writeFileSync(p, Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => archiveHarness(f.source, f.destination), { code: 'harness_archive_write_failed' });
  fs.writeFileSync(p, '// guard'); const a = archiveHarness(f.source, f.destination), alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readHarnessArchive({ ...a, directory: alias }), { code: 'harness_archive_invalid' });
  fs.renameSync(p, p + '.original');
  try { fs.symlinkSync(p + '.original', p); } catch (e) { if (e.code === 'EPERM') return t.skip('file link privilege unavailable'); throw e; }
  assert.throws(() => archiveHarness(f.source, path.join(f.root, 'linked')), { code: 'harness_archive_write_failed' });
});
test('archive-selected staging uses archived harness only and keeps guard', t => {
  const { stageDiagnostic } = require('../../scripts/badcase-capture/retained-sdk-diagnostic.cjs');
  const f = fixture(t), a = archiveHarness(f.source, f.destination), before = readHarnessArchive(a);
  fs.rmSync(f.source, { recursive: true });
  const read = fs.readFileSync; let liveReads = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === 'string' && sources.some(s => p.replaceAll('\\', '/').endsWith(s))) { liveReads++; throw Error('live harness unavailable'); }
    return read(p, ...rest);
  };
  try {
    const files = stageDiagnostic('{}', {}, {}, { harnessArchive: a });
    for (const f of before) assert.deepEqual(files.find(x => x.path === f.path)?.bytes, f.bytes);
    assert.ok(files.some(x => x.path === 'pi-probe-guards.cjs')); assert.equal(liveReads, 0);
    for (const bad of [null, undefined, { ...a, archiveHash: '0'.repeat(64) }]) {
      assert.throws(() => stageDiagnostic('{}', {}, {}, { harnessArchive: bad }), { code: 'harness_archive_invalid' });
    }
  } finally { fs.readFileSync = read; }
});
test('staging rejects legacy bare references and unknown source options instead of silent fallback', t => {
  const { stageDiagnostic } = require('../../scripts/badcase-capture/retained-sdk-diagnostic.cjs');
  const f = fixture(t), a = archiveHarness(f.source, f.destination);
  for (const sources of [a, null, [], { harnessArchive: a, unexpected: true }]) {
    assert.throws(() => stageDiagnostic('{}', {}, {}, sources), { code: 'diagnostic_sources_invalid' });
  }
});
test('bad harness stops wrapper before transport and preserves run reference', async t => {
  const fixture = require('../helpers/badcase-initialization-fixture.cjs');
  const { runRetainedSdkDiagnostic } = require('../../scripts/badcase-capture/retained-sdk-diagnostic.cjs');
  const h = fixture(t, 'fresh'); let calls = 0;
  for (const harnessArchive of [null, undefined]) {
    await assert.rejects(runRetainedSdkDiagnostic(h.request, {}, { harnessArchive, runProbe: async () => { calls++; } }), { code: 'harness_archive_invalid' });
  }
  assert.equal(calls, 0); assert.equal(fs.readdirSync(h.runDir).length, 1);
});
