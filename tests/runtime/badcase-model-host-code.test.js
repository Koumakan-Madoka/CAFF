const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-host-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'scripts/badcase-capture'); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../../scripts/badcase-capture/model-host-code.cjs'), path.join(dir, 'model-host-code.cjs'));
  fs.writeFileSync(path.join(dir, 'model-evaluation-operator.cjs'), "require('./model-evaluation.cjs');\n");
  fs.writeFileSync(path.join(dir, 'model-evaluation.cjs'), "require('node:fs'); function lazy() { return require('./leaf.cjs'); }\n");
  fs.writeFileSync(path.join(dir, 'approved-sdk-model-gateway.cjs'), "require('./leaf.cjs');\n");
  fs.writeFileSync(path.join(dir, 'leaf.cjs'), "throw Error('must never execute while inventorying');\n");
  return { root, dir, capture: require(path.join(dir, 'model-host-code.cjs')).captureHostCode };
}
test('inventory is path-neutral, sorted, includes lazy/transitive dependencies and itself, and executes none', t => {
  const a = fixture(t), b = fixture(t), first = a.capture(), second = b.capture();
  assert.deepEqual(first.files, second.files);
  assert.deepEqual(Object.keys(first.files), Object.keys(first.files).sort());
  assert.equal(Object.keys(first.files).length, 5);
  for (const [name, digest] of Object.entries(first.files)) {
    assert.ok(!path.isAbsolute(name) && !name.includes('\\'));
    assert.equal(digest, crypto.createHash('sha256').update(fs.readFileSync(path.join(a.root, name))).digest('hex'));
  }
  assert.equal(Object.isFrozen(first.files), true); first.verify(); second.verify();
});
test('inventory catches byte changes, missing files, new graph edges, and pre-existing changes before a new snapshot', t => {
  for (const mode of ['bytes', 'missing', 'edge']) {
    const h = fixture(t), snapshot = h.capture();
    const leaf = path.join(h.dir, 'leaf.cjs'), original = fs.readFileSync(leaf);
    if (mode === 'bytes') fs.appendFileSync(leaf, '\n// synthetic revision\n');
    if (mode === 'missing') fs.unlinkSync(leaf);
    if (mode === 'edge') {
      fs.writeFileSync(path.join(h.dir, 'extra.cjs'), '// another local dependency\n');
      fs.appendFileSync(leaf, "\nrequire('./extra.cjs');\n");
    }
    assert.throws(() => snapshot.verify(), /^Error: model_host_code_invalid$/);
    if (mode !== 'missing') assert.notDeepEqual(h.capture().files, snapshot.files);
    fs.writeFileSync(leaf, original); snapshot.verify();
  }
});
test('unsupported or out-of-tree dependencies fail closed rather than disappearing from the inventory', t => {
  for (const source of ["require(process.env.PRIVATE_VALUE)", "require('unapproved-package')", "import('./leaf.cjs')", "require('../../../outside.cjs')"]) {
    const h = fixture(t);
    fs.writeFileSync(path.join(h.dir, 'leaf.cjs'), source);
    assert.throws(() => h.capture());
  }
  const a = fixture(t), b = fixture(t);
  const outside = path.relative(a.dir, path.join(b.dir, 'leaf.cjs')).split(path.sep).join('/');
  fs.writeFileSync(path.join(a.dir, 'leaf.cjs'), 'require(' + JSON.stringify(outside) + ')');
  assert.throws(() => a.capture(), /^Error: model_host_code_invalid$/);
});
test('inventory single-file byte limit accepts exactly 1MiB and rejects one byte more on capture and verify', t => {
  const h = fixture(t), leaf = path.join(h.dir, 'leaf.cjs');
  fs.writeFileSync(leaf, Buffer.alloc(1048576, 32));
  let snapshot; assert.doesNotThrow(() => { snapshot = h.capture(); snapshot.verify(); });
  fs.appendFileSync(leaf, ' ');
  assert.throws(() => h.capture(), /^Error: model_host_code_invalid$/);
  assert.throws(() => snapshot.verify(), /^Error: model_host_code_invalid$/);
  fs.truncateSync(leaf, 1048576); snapshot.verify();
});
test('inventory graph cap accepts exactly 256 unique files including roots and rejects the 257th', t => {
  const h = fixture(t), leaf = path.join(h.dir, 'leaf.cjs');
  for (let i = 0; i < 253; i++) fs.writeFileSync(path.join(h.dir, 'n' + i + '.cjs'), '// synthetic leaf\n');
  fs.writeFileSync(leaf, Array.from({ length: 251 }, (_, i) => "require('./n" + i + ".cjs');").join('\n'));
  let snapshot; assert.doesNotThrow(() => { snapshot = h.capture(); snapshot.verify(); });
  assert.equal(Object.keys(snapshot.files).length, 256);
  // Repeated edges do not count as additional files.
  fs.appendFileSync(leaf, "\nrequire('./n0.cjs');"); assert.equal(Object.keys(h.capture().files).length, 256);
  fs.appendFileSync(leaf, "\nrequire('./n251.cjs');");
  assert.throws(() => h.capture(), /^Error: model_host_code_invalid$/);
  assert.throws(() => snapshot.verify(), /^Error: model_host_code_invalid$/);
});
test('inventory rejects invalid UTF-8 bytes rather than hashing replacement text, on capture and verify', t => {
  const h = fixture(t), leaf = path.join(h.dir, 'leaf.cjs');
  fs.writeFileSync(leaf, '// 合法 UTF-8\n'); const snapshot = h.capture(); snapshot.verify();
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xe2, 0x82]),
    Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xef, 0xbf, 0xbd, 0xff])]) {
    fs.writeFileSync(leaf, bytes);
    assert.throws(() => h.capture(), /^Error: model_host_code_invalid$/);
    assert.throws(() => snapshot.verify(), /^Error: model_host_code_invalid$/);
  }
  fs.writeFileSync(leaf, '// 合法 UTF-8\n'); snapshot.verify();
});
test('directory symlink or junction ancestors cannot supply inventory dependencies', t => {
  const h = fixture(t), real = path.join(h.dir, 'real-dir'), link = path.join(h.dir, 'alias-dir');
  fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'module.cjs'), '// synthetic dependency\n');
  try { fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('directory link permission unavailable'); return; } throw e; }
  fs.appendFileSync(path.join(h.dir, 'leaf.cjs'), "\nrequire('./alias-dir/module.cjs');\n");
  assert.throws(() => h.capture(), /^Error: model_host_code_invalid$/);
});
test('symlink substitution cannot supply an approved host file', t => {
  const h = fixture(t), snapshot = h.capture(), leaf = path.join(h.dir, 'leaf.cjs');
  fs.renameSync(leaf, path.join(h.dir, 'real.cjs'));
  try { fs.symlinkSync(path.join(h.dir, 'real.cjs'), leaf); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('file symlink permission unavailable'); return; } throw e; }
  assert.throws(() => snapshot.verify(), /^Error: model_host_code_invalid$/);
  assert.throws(() => h.capture(), /^Error: model_host_code_invalid$/);
});
