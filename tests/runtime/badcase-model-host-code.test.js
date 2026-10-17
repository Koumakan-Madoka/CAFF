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
  fs.writeFileSync(path.join(dir, 'leaf.cjs'), "throw Error('must never execute while inventorying');\n");
  return { root, dir, capture: require(path.join(dir, 'model-host-code.cjs')).captureHostCode };
}
test('inventory is path-neutral, sorted, includes lazy/transitive dependencies and itself, and executes none', t => {
  const a = fixture(t), b = fixture(t), first = a.capture(), second = b.capture();
  assert.deepEqual(first.files, second.files);
  assert.deepEqual(Object.keys(first.files), Object.keys(first.files).sort());
  assert.equal(Object.keys(first.files).length, 4);
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
