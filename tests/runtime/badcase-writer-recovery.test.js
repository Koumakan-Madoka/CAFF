const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, fork } = require('node:child_process');
const modulePath = require.resolve('../../build/server/domain/runtime/badcase-capture/project-write-lock');
const locks = require(modulePath);
const { inspectProjectWriteLock, recoverProjectWriteLock, withProjectWriteLock, acquireProjectWriteLease, withDelegatedProjectWriteLock } = locks;
const code = value => e => e.code === value;
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-writer-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects/p1'); fs.mkdirSync(project, { recursive: true });
  return { root, project, lock: path.join(project, '.writer-lock'), gate: path.join(project, '.writer-recovery') };
}
function recover(h, expected = inspectProjectWriteLock(h.root, 'p1')) {
  return recoverProjectWriteLock(h.root, 'p1', { writersStopped: true, expected });
}
function tree(dir) {
  return fs.readdirSync(dir).sort().flatMap(name => {
    const full = path.join(dir, name);
    return fs.lstatSync(full).isDirectory() ? tree(full).map(([p,b]) => [name + '/' + p,b]) : [[name, fs.readFileSync(full).toString('hex')]];
  });
}
test('recovery gate blocks ordinary, supervisor and delegated writers without creating a new lock', t => {
  const h = setup(t); fs.mkdirSync(h.gate); let ran = false;
  assert.throws(() => withProjectWriteLock(h.root, 'p1', () => { ran = true; }), code('capture_writer_busy'));
  assert.throws(() => acquireProjectWriteLease(h.root, 'p1'), code('capture_writer_busy'));
  assert.equal(ran, false); assert.equal(fs.existsSync(h.lock), false);
  fs.rmdirSync(h.gate); const lease = acquireProjectWriteLease(h.root, 'p1'); fs.mkdirSync(h.gate);
  assert.throws(() => withDelegatedProjectWriteLock(h.root, 'p1', lease.owner, () => { ran = true; }), code('capture_writer_busy'));
  fs.rmdirSync(h.gate); lease.release();
});
test('gate appearing between precheck and mkdir blocks action and removes only newly acquired empty lock', t => {
  const h = setup(t), original = fs.mkdirSync; let ran = false;
  try {
    fs.mkdirSync = (file, ...args) => { const result = original(file, ...args); if (file === h.lock) original(h.gate); return result; };
    assert.throws(() => withProjectWriteLock(h.root, 'p1', () => { ran = true; }), code('capture_writer_busy'));
  } finally { fs.mkdirSync = original; }
  assert.equal(ran, false); assert.equal(fs.existsSync(h.lock), false); assert.ok(fs.existsSync(h.gate));
});
test('empty crash lock is inspected read-only, identity-bound and preserved by rename', t => {
  const h = setup(t); fs.mkdirSync(h.lock); const before = tree(h.root);
  const expected = inspectProjectWriteLock(h.root, 'p1'); assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(inspectProjectWriteLock(h.root, 'p1'), expected); assert.deepEqual(tree(h.root), before);
  for (const options of [undefined, {}, { writersStopped: false, expected }, { writersStopped: true, expected: 'f'.repeat(64) }, { writersStopped: true, expected, extra: true }]) {
    assert.throws(() => recoverProjectWriteLock(h.root, 'p1', options)); assert.ok(fs.existsSync(h.lock));
  }
  const receipt = recover(h, expected);
  assert.deepEqual(Object.keys(receipt).sort(), ['executionState', 'materialsChanged', 'quarantineName', 'recovered']);
  assert.equal(receipt.recovered, true); assert.equal(receipt.materialsChanged, false); assert.equal(receipt.executionState, 'unknown');
  assert.match(receipt.quarantineName, /^\.writer-lock-retired-[A-Za-z0-9]{6}$/);
  assert.ok(fs.lstatSync(path.join(h.project, receipt.quarantineName)).isDirectory());
  assert.equal(fs.existsSync(h.lock), false); assert.equal(fs.existsSync(h.gate), false);
  assert.throws(() => recover(h, expected), code('capture_lock_invalid'));
  assert.equal(withProjectWriteLock(h.root, 'p1', () => 42), 42);
});
test('supervisor owner is preserved; stale release cannot delete a newly acquired lease', t => {
  const h = setup(t), lease = acquireProjectWriteLease(h.root, 'p1');
  const receipt = recover(h); const next = acquireProjectWriteLease(h.root, 'p1');
  assert.throws(() => lease.release(), code('capture_lock_invalid'));
  assert.equal(fs.readFileSync(path.join(h.lock, 'owner'), 'utf8'), next.owner);
  assert.equal(fs.readFileSync(path.join(h.project, receipt.quarantineName, 'lock', 'owner'), 'utf8'), lease.owner);
  next.release();
});
test('changed owner, replaced directory, unknown contents and malformed owner refuse without quarantine', t => {
  for (const mode of ['owner', 'directory', 'extra', 'oversize', 'nonascii']) {
    const h = setup(t), lease = acquireProjectWriteLease(h.root, 'p1'), expected = inspectProjectWriteLock(h.root, 'p1');
    if (mode === 'owner') fs.writeFileSync(path.join(h.lock, 'owner'), 'f'.repeat(64));
    if (mode === 'directory') { fs.renameSync(h.lock, h.lock + '-old'); fs.mkdirSync(h.lock); fs.writeFileSync(path.join(h.lock, 'owner'), lease.owner); }
    if (mode === 'extra') fs.writeFileSync(path.join(h.lock, 'foreign'), 'keep');
    if (mode === 'oversize') fs.writeFileSync(path.join(h.lock, 'owner'), 'f'.repeat(65));
    if (mode === 'nonascii') fs.writeFileSync(path.join(h.lock, 'owner'), Buffer.alloc(64, 0xe1));
    if (['extra', 'oversize', 'nonascii'].includes(mode)) assert.throws(() => inspectProjectWriteLock(h.root, 'p1'), code('capture_lock_invalid'));
    const before = tree(h.root); assert.throws(() => recover(h, expected), code('capture_lock_invalid'));
    assert.deepEqual(tree(h.root), before); assert.equal(fs.existsSync(h.gate), false);
  }
});
test('single foreign entry refuses before attempting to inspect an owner and preserves all bytes', t => {
  const h = setup(t); fs.mkdirSync(h.lock); fs.writeFileSync(path.join(h.lock, 'foreign'), 'f'.repeat(64));
  const before = tree(h.root), original = fs.lstatSync; let ownerReads = 0;
  try {
    fs.lstatSync = (file, ...args) => { if (file === path.join(h.lock, 'owner')) ownerReads++; return original(file, ...args); };
    assert.throws(() => inspectProjectWriteLock(h.root, 'p1'), code('capture_lock_invalid'));
    assert.throws(() => recover(h, 'a'.repeat(64)), code('capture_lock_invalid'));
  } finally { fs.lstatSync = original; }
  assert.equal(ownerReads, 0); assert.deepEqual(tree(h.root), before);
  assert.equal(fs.existsSync(h.gate), false);
});
test('same-byte owner replacement between lstat and open refuses by opened file identity', t => {
  for (const operation of ['inspect', 'recover']) {
    const h = setup(t), lease = acquireProjectWriteLease(h.root, 'p1');
    const expected = inspectProjectWriteLock(h.root, 'p1');
    const owner = path.join(h.lock, 'owner'), replacement = path.join(h.project, 'replacement'), retired = path.join(h.project, 'original-owner');
    fs.writeFileSync(replacement, lease.owner);
    const original = fs.openSync; let swapped = false;
    try {
      fs.openSync = (file, ...args) => {
        if (file === owner && !swapped) { swapped = true; fs.renameSync(owner, retired); fs.renameSync(replacement, owner); }
        return original(file, ...args);
      };
      assert.throws(() => operation === 'inspect' ? inspectProjectWriteLock(h.root, 'p1') : recover(h, expected), code('capture_lock_invalid'));
    } finally { fs.openSync = original; }
    assert.equal(swapped, true);
    assert.equal(fs.readFileSync(owner, 'utf8'), lease.owner); assert.equal(fs.readFileSync(retired, 'utf8'), lease.owner);
    assert.equal(fs.existsSync(h.gate), false);
    assert.equal(fs.readdirSync(h.project).some(name => name.startsWith('.writer-lock-retired-')), false);
  }
});
test('missing storage is never created and invalid project ids never traverse', t => {
  const h = setup(t), missing = path.join(h.root, 'missing');
  assert.throws(() => inspectProjectWriteLock(missing, 'p1'), code('capture_lock_invalid'));
  assert.throws(() => recoverProjectWriteLock(missing, 'p1', { writersStopped: true, expected: 'a'.repeat(64) }), code('capture_lock_invalid'));
  assert.equal(fs.existsSync(missing), false);
  for (const id of ['../p1', 42, null, undefined]) assert.throws(() => inspectProjectWriteLock(h.root, id), code('capture_lock_invalid'));
});
test('static directory and owner links refuse without moving the target', t => {
  for (const which of ['root', 'projects', 'project', 'lock', 'owner']) {
    const h = setup(t); acquireProjectWriteLease(h.root, 'p1');
    const target = { root: h.root, projects: path.join(h.root, 'projects'), project: h.project, lock: h.lock, owner: path.join(h.lock, 'owner') }[which];
    const outside = target + '-outside'; fs.renameSync(target, outside);
    if (which === 'root') t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    try { fs.symlinkSync(outside, target, which === 'owner' ? 'file' : (process.platform === 'win32' ? 'junction' : 'dir')); }
    catch (e) { if (!['EPERM','EACCES'].includes(e.code)) throw e; fs.renameSync(outside, target); t.diagnostic('file symlink unavailable'); continue; }
    assert.throws(() => inspectProjectWriteLock(h.root, 'p1'), code('capture_lock_invalid'));
    assert.throws(() => recover(h, 'a'.repeat(64)), code('capture_lock_invalid'));
    assert.ok(fs.existsSync(outside)); assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  }
});
test('rename failure retains original lock, and a crash-left recovery gate is never reclaimed', t => {
  const h = setup(t); fs.mkdirSync(h.lock); const expected = inspectProjectWriteLock(h.root, 'p1'), original = fs.renameSync;
  try { fs.renameSync = () => { throw Error('private path'); }; assert.throws(() => recover(h, expected), code('capture_lock_recovery_failed')); }
  finally { fs.renameSync = original; }
  assert.ok(fs.existsSync(h.lock)); assert.equal(fs.existsSync(h.gate), false);
  fs.mkdirSync(h.gate);
  assert.throws(() => recover(h, expected), code('capture_writer_busy')); assert.ok(fs.existsSync(h.gate));
});
test('post-rename verification failure retains the gate and retired lock, never reports success', t => {
  const h = setup(t); const lease = acquireProjectWriteLease(h.root, 'p1');
  const expected = inspectProjectWriteLock(h.root, 'p1'), original = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { original(from, to); fs.writeFileSync(path.join(to, 'owner'), 'f'.repeat(64)); };
    assert.throws(() => recover(h, expected), code('capture_lock_recovery_failed'));
  } finally { fs.renameSync = original; }
  assert.ok(fs.existsSync(h.gate)); assert.equal(fs.existsSync(h.lock), false);
  assert.equal(fs.readdirSync(h.project).filter(n => n.startsWith('.writer-lock-retired-')).length, 1);
  assert.throws(() => withProjectWriteLock(h.root, 'p1', () => {}), code('capture_writer_busy'));
  assert.throws(() => lease.release(), code('capture_lock_invalid'));
});
test('gate release failure is explicit and blocks subsequent writers', t => {
  const h = setup(t); fs.mkdirSync(h.lock); const original = fs.rmdirSync;
  try {
    fs.rmdirSync = (file, ...args) => { if (file === h.gate) throw Error('private detail'); return original(file, ...args); };
    assert.throws(() => recover(h), code('capture_lock_recovery_failed'));
  } finally { fs.rmdirSync = original; }
  assert.ok(fs.existsSync(h.gate)); assert.throws(() => acquireProjectWriteLease(h.root, 'p1'), code('capture_writer_busy'));
});
test('another recovery process cannot enter while rename is in progress', t => {
  const h = setup(t); fs.mkdirSync(h.lock); const expected = inspectProjectWriteLock(h.root, 'p1'), original = fs.renameSync;
  let attempted = false;
  try {
    fs.renameSync = (...args) => {
      attempted = true;
      const script = `try { require(${JSON.stringify(modulePath)}).recoverProjectWriteLock(${JSON.stringify(h.root)}, 'p1', ${JSON.stringify({writersStopped:true,expected})}); process.exit(5); } catch(e) { process.stdout.write(e.code); }`;
      const child = spawnSync(process.execPath, ['-e', script], { encoding:'utf8', timeout:5000 });
      assert.equal(child.status, 0); assert.equal(child.stdout, 'capture_writer_busy');
      assert.throws(() => withProjectWriteLock(h.root, 'p1', () => assert.fail()), code('capture_writer_busy'));
      return original(...args);
    };
    recover(h, expected);
  } finally { fs.renameSync = original; }
  assert.equal(attempted, true);
});
test('recovery process death after rename leaves a fail-closed gate and preserved owner', t => {
  const h = setup(t), lease = acquireProjectWriteLease(h.root, 'p1'), expected = inspectProjectWriteLock(h.root, 'p1');
  const script = `const fs=require('node:fs'), original=fs.renameSync; fs.renameSync=(...args)=>{original(...args);process.exit(23);};require(${JSON.stringify(modulePath)}).recoverProjectWriteLock(${JSON.stringify(h.root)},'p1',${JSON.stringify({writersStopped:true,expected})});`;
  const child = spawnSync(process.execPath, ['-e',script], {encoding:'utf8',timeout:5000}); assert.equal(child.status,23);
  assert.equal(fs.existsSync(h.lock),false); assert.ok(fs.existsSync(h.gate));
  const retired = fs.readdirSync(h.project).filter(n=>n.startsWith('.writer-lock-retired-')); assert.equal(retired.length,1);
  assert.equal(fs.readFileSync(path.join(h.project,retired[0],'lock/owner'),'utf8'),lease.owner);
  assert.throws(()=>acquireProjectWriteLease(h.root,'p1'),code('capture_writer_busy'));
  assert.throws(()=>recover(h,expected),code('capture_writer_busy'));
});
test('own synchronous writer cannot recover its held lock even with a stopped declaration', t => {
  const h = setup(t);
  withProjectWriteLock(h.root, 'p1', () => assert.throws(() => recover(h), code('capture_writer_busy')));
});
// A real child abruptly exits AFTER publishing protection but BEFORE finally.
// Recovery must not hide its partial inventory or change any archived byte.
test('crashed reference publisher can explicitly recover and retry without dropping published pins or partial files', t => {
  const h = setup(t);
  const storePath = require.resolve('../../build/server/domain/runtime/badcase-capture/capture-store');
  const retentionPath = require.resolve('../../build/server/domain/runtime/badcase-capture/checkpoint-retention');
  const runsPath = require.resolve('../../build/server/domain/runtime/badcase-capture/run-references');
  const { createCaptureStore, sha256Hex } = require(storePath);
  const store = createCaptureStore({ captureRoot: h.root }); const bytes = Buffer.from('synthetic protected bytes'), hash = sha256Hex(bytes);
  store.writeBlob('p1', hash, bytes);
  const scope = { projectId:'p1', checkpointId:'cp1', conversationId:'c1', turnId:'t1', agentId:'a1', referenceId:'flag-one' };
  store.saveCheckpoint('p1', { schemaVersion:1, projectId:'p1', checkpointId:'cp1', conversationId:'c1', turnId:'t1', agentId:'a1', files:{'x.txt':{type:'file',hash,size:bytes.length}}, deletions:[], replayInput:{complete:false,deliveryMode:'fresh',incompleteReasons:['prompt_missing'],harness:{skillSnapshots:[]}} });
  require(retentionPath).createCheckpointRetentionStore({captureStore:store}).retain(scope);
  const input = {...scope,replayRunId:'run-one'};
  const script = `const fs=require('node:fs'); const original=fs.linkSync; fs.linkSync=(s,d)=>{original(s,d);process.exit(23);};require(${JSON.stringify(runsPath)}).createReplayRunReferenceStore({captureStore:require(${JSON.stringify(storePath)}).createCaptureStore({captureRoot:${JSON.stringify(h.root)}})}).protect(${JSON.stringify(input)});`;
  const child = spawnSync(process.execPath, ['-e',script], {encoding:'utf8',timeout:10000}); assert.equal(child.status,23);
  const runs = require(runsPath).createReplayRunReferenceStore({captureStore:store});
  const published = runs.get(input); assert.ok(published);
  assert.throws(() => runs.protect(input), code('capture_writer_busy'));
  const before = tree(h.project); recover(h);
  assert.deepEqual(tree(h.project), before, 'empty old lock contains no file; all materials unchanged');
  assert.deepEqual(runs.protect(input), {created:false,reference:published});
  assert.deepEqual(tree(h.project), before);
  assert.throws(() => runs.protectedObjects('p1'), code('run_reference_inventory_busy'));
  assert.equal(store.readBlob('p1',hash).equals(bytes),true);
});
test('killed lease owner leaves a lock; explicit recovery waits for observed child exit, then permits a new writer', {timeout:10000}, async t => {
  const h = setup(t), childFile = path.join(h.root,'child.cjs');
  fs.writeFileSync(childFile, `const lease=require(${JSON.stringify(modulePath)}).acquireProjectWriteLease(${JSON.stringify(h.root)},'p1');process.send({ready:true});setInterval(()=>{},1000);`);
  const child = fork(childFile, [], {stdio:['ignore','ignore','ignore','ipc']});
  const exited = new Promise(resolve => child.once('exit',resolve));
  try {
    await new Promise((resolve,reject) => {child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('early exit')));});
    assert.throws(() => withProjectWriteLock(h.root,'p1',()=>{}),code('capture_writer_busy'));
  } finally { child.kill('SIGKILL'); await exited; }
  const before = fs.readFileSync(path.join(h.lock,'owner')); const receipt = recover(h);
  assert.deepEqual(fs.readFileSync(path.join(h.project,receipt.quarantineName,'lock','owner')),before);
  withProjectWriteLock(h.root,'p1',()=>{});
});
