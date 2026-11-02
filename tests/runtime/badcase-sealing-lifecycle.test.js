const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { sealCheckpointAsync } = require('../../build/server/domain/runtime/badcase-capture/sealing-process');
const worker = path.resolve(__dirname, '../../build/server/domain/runtime/badcase-capture/sealing-worker.js');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-seal-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root });
  const association = { projectId: 'p1', conversationId: 'c1', messageId: 'm1', turnId: 't1', agentId: 'a1', taskId: 'task1', checkpointId: 'cp1', runId: 1 };
  const data = Buffer.from('synthetic material'), hash = sha256Hex(data);
  store.writeBlob('p1', hash, data);
  store.saveCheckpoint('p1', { schemaVersion: 1, projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1', checkpointId: 'cp1', files: { 'file.txt': { type: 'file', hash, size: data.length } }, deletions: [], replayInput: { complete: false, deliveryMode: 'fresh', incompleteReasons: ['prompt_missing'], harness: { skillSnapshots: [] } } });
  const request = { captureRoot: root, association, flagId: `flag-${sha256Hex('p1\0m1')}` };
  const lock = path.join(root, 'projects/p1/.writer-lock');
  function fault(body) {
    const file = path.join(root, `worker-${crypto.randomUUID()}.cjs`);
    fs.writeFileSync(file, `${body}\nrequire(${JSON.stringify(worker)});`);
    return file;
  }
  // Fault at a real retention publication, after the production code acquired
  // the shared writer lock. Atomics.wait blocks JS finally/signal handlers.
  const hungWorker = fault(`const fs = require('node:fs'); const original = fs.linkSync;
    fs.linkSync = (source, target) => {
      if (String(target).includes(require('node:path').sep + 'retention' + require('node:path').sep)) {
        fs.writeSync(1, 'LOCKED'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return original(source, target);
    };`);
  return { root, store, request, lock, fault, hungWorker };
}
for (const mode of ['kill', 'timeout']) {
  test(`real sealing worker ${mode} while publishing does not strand its lock and retry succeeds`, { timeout: 15000 }, async t => {
    const h = setup(t); let pid, reached = false, observedError;
    await assert.rejects(sealCheckpointAsync(h.request, {
      workerPath: h.hungWorker, timeoutMs: 3000,
      onSpawn: value => { pid = value; },
      onOutput: chunk => {
        try {
          assert.equal(chunk.toString(), 'LOCKED'); reached = true;
          assert.ok(fs.existsSync(h.lock));
          assert.throws(() => h.store.savePolicy(h.store.loadPolicy('p1')), e => e.code === 'capture_writer_busy');
        } catch (e) { observedError = e; }
        if (mode === 'kill') process.kill(pid, 'SIGKILL');
      },
    }), e => e.code === (mode === 'kill' ? 'seal_process_failed' : 'seal_timeout'));
    if (observedError) throw observedError;
    assert.equal(reached, true, 'fault must hit the actual locked publication');
    assert.equal(fs.existsSync(h.lock), false, 'dead child must not leave a permanent writer lock');
    assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/cases')), false);
    // Incomplete temp files remain; recovery does not delete saved materials.
    assert.ok(fs.readdirSync(path.join(h.root, 'projects/p1/retention')).some(n => n.includes('.tmp-')));
    const result = await sealCheckpointAsync(h.request);
    assert.equal(result.state, 'saved_incomplete');
    assert.equal(fs.existsSync(h.lock), false);
    assert.deepEqual(await sealCheckpointAsync(h.request), result);
  });
}

test('foreign legacy lock is not deleted or delegated and worker is not started', async t => {
  const h = setup(t); fs.mkdirSync(h.lock);
  let spawned = false;
  await assert.rejects(sealCheckpointAsync(h.request, { onSpawn: () => { spawned = true; } }), e => e.code === 'capture_writer_busy');
  assert.equal(spawned, false); assert.equal(fs.lstatSync(h.lock).isDirectory(), true);
});

test('normal worker result releases lock, including a known storage failure', async t => {
  const h = setup(t);
  h.store.savePolicy({ ...h.store.loadPolicy('p1'), stagingQuotaBytes: 1 });
  await assert.rejects(sealCheckpointAsync(h.request), e => e.code === 'seal_quota_exceeded');
  assert.equal(fs.existsSync(h.lock), false);
  h.store.savePolicy({ ...h.store.loadPolicy('p1'), stagingQuotaBytes: 1024 * 1024 });
  assert.equal((await sealCheckpointAsync(h.request)).state, 'saved_incomplete');
});

test('supervisor lease blocks unrelated writes, permits only scoped delegated reentrancy, and is not released by the borrower', t => {
  const h = setup(t);
  const { acquireProjectWriteLease, withDelegatedProjectWriteLock, withProjectWriteLock } = require('../../build/server/domain/runtime/badcase-capture/project-write-lock');
  const lease = acquireProjectWriteLease(h.root, 'p1');
  try {
    assert.throws(() => h.store.savePolicy(h.store.loadPolicy('p1')), e => e.code === 'capture_writer_busy');
    let ran = false;
    for (const owner of ['', '0'.repeat(64), lease.owner + 'x']) {
      assert.throws(() => withDelegatedProjectWriteLock(h.root, 'p1', owner, () => { ran = true; }), e => e.code === 'capture_lock_invalid');
    }
    assert.throws(() => withDelegatedProjectWriteLock(h.root, 'p2', lease.owner, () => { ran = true; }), e => e.code === 'capture_lock_invalid');
    assert.equal(ran, false);
    withDelegatedProjectWriteLock(h.root, 'p1', lease.owner, () => {
      withProjectWriteLock(h.root, 'p1', () => h.store.savePolicy(h.store.loadPolicy('p1')));
    });
    assert.ok(fs.existsSync(h.lock), 'borrower must not remove supervisor lock');
    assert.throws(() => h.store.savePolicy(h.store.loadPolicy('p1')), e => e.code === 'capture_writer_busy');
    assert.throws(() => withDelegatedProjectWriteLock(h.root, 'p1', lease.owner, () => { throw Error('synthetic'); }), /synthetic/);
    assert.throws(() => h.store.savePolicy(h.store.loadPolicy('p1')), e => e.code === 'capture_writer_busy', 'throw must clear local reentrancy');
  } finally { lease.release(); }
  lease.release(); // idempotent only for this closure
  h.store.savePolicy(h.store.loadPolicy('p1'));
});

test('release mismatch or unexpected lock contents fail closed without deleting another owner', t => {
  const h = setup(t);
  const { acquireProjectWriteLease } = require('../../build/server/domain/runtime/badcase-capture/project-write-lock');
  const lease = acquireProjectWriteLease(h.root, 'p1');
  const ownerFile = path.join(h.lock, 'owner');
  const other = 'f'.repeat(64);
  fs.writeFileSync(ownerFile, other);
  assert.throws(() => lease.release(), e => e.code === 'capture_lock_invalid');
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), other);
  fs.writeFileSync(ownerFile, lease.owner);
  fs.writeFileSync(path.join(h.lock, 'unexpected'), 'do not delete');
  assert.throws(() => lease.release(), e => e.code === 'capture_lock_invalid');
  assert.equal(fs.readFileSync(path.join(h.lock, 'unexpected'), 'utf8'), 'do not delete');
  assert.throws(() => h.store.savePolicy(h.store.loadPolicy('p1')), e => e.code === 'capture_writer_busy');
});

for (const [label, source, code] of [
  ['early exit', 'process.exit(7);', 'seal_process_failed'],
  ['invalid output', `process.stdout.write('not-json'); process.exit(0);`, 'seal_output_invalid'],
  ['too much output', `process.stdout.write('x'.repeat(70000));`, 'seal_output_limit'],
]) {
  test(`${label} releases only the supervisor lease and returns a fixed failure`, async t => {
    const h = setup(t);
    await assert.rejects(sealCheckpointAsync(h.request, { workerPath: h.fault(source) }), e => e.code === code);
    assert.equal(fs.existsSync(h.lock), false);
    assert.equal((await sealCheckpointAsync(h.request)).state, 'saved_incomplete');
  });
}

test('failed spawn releases parent lease and caller lockOwner is never trusted', async t => {
  const h = setup(t);
  await assert.rejects(sealCheckpointAsync(h.request, { workerPath: '\0' }), e => e.code === 'seal_process_failed');
  assert.equal(fs.existsSync(h.lock), false);
  assert.equal((await sealCheckpointAsync({ ...h.request, lockOwner: 'attacker-supplied' })).state, 'saved_incomplete');
});

test('worker cannot run with a forged or missing delegation even with an otherwise valid request', t => {
  const h = setup(t);
  const { acquireProjectWriteLease } = require('../../build/server/domain/runtime/badcase-capture/project-write-lock');
  const { spawnSync } = require('node:child_process');
  const lease = acquireProjectWriteLease(h.root, 'p1');
  try {
    for (const lockOwner of [undefined, '0'.repeat(64)]) {
      const result = spawnSync(process.execPath, [worker], { input: JSON.stringify({ request: h.request, lockOwner }), encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: 'seal_write_failed' });
      assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/cases')), false);
      assert.equal(fs.readFileSync(path.join(h.lock, 'owner'), 'utf8'), lease.owner);
    }
  } finally { lease.release(); }
});

test('kill and exit alone do not release leases or concurrency slots before close (event-order probe)', async t => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const cp = require('node:child_process');
  const original = cp.spawn, children = [], pending = [];
  const first = setup(t), second = setup(t), third = setup(t);
  cp.spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = 0; child.kill = () => { child.kills++; return true; };
    children.push(child); return child;
  };
  try {
    for (const h of [first, second]) pending.push(sealCheckpointAsync(h.request).catch(e => e));
    assert.equal(children.length, 2);
    for (const child of children) { child.emit('error', Error('private diagnostic')); child.emit('exit', null, 'SIGKILL'); }
    assert.ok(children.every(c => c.kills === 1));
    assert.ok(fs.existsSync(first.lock)); assert.ok(fs.existsSync(second.lock));
    await assert.rejects(sealCheckpointAsync(third.request), e => e.code === 'seal_busy');
    assert.throws(() => first.store.savePolicy(first.store.loadPolicy('p1')), e => e.code === 'capture_writer_busy');
  } finally {
    cp.spawn = original;
    for (const child of children) child.emit('close', null, 'SIGKILL');
    const failures = await Promise.all(pending);
    assert.ok(failures.every(e => e.code === 'seal_process_failed' && !e.message.includes('private')));
  }
  assert.equal(fs.existsSync(first.lock), false); assert.equal(fs.existsSync(second.lock), false);
  assert.equal((await sealCheckpointAsync(third.request)).state, 'saved_incomplete');
});

test('cleanup failure is explicit, leaves the lock closed, and never returns a success', async t => {
  const h = setup(t);
  const source = `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(path.join(h.lock, 'owner'))}, '0'.repeat(64)); process.exit(7);`;
  await assert.rejects(sealCheckpointAsync(h.request, { workerPath: h.fault(source) }), e => e.code === 'seal_lock_release_failed');
  assert.equal(fs.readFileSync(path.join(h.lock, 'owner'), 'utf8'), '0'.repeat(64));
  await assert.rejects(sealCheckpointAsync(h.request), e => e.code === 'capture_writer_busy');
});

test('observer failure kills and waits for worker before releasing lock', async t => {
  const h = setup(t); let observed = false;
  await assert.rejects(sealCheckpointAsync(h.request, { workerPath: h.hungWorker, onOutput: () => {
    observed = true; throw Error('private observer detail');
  } }), e => e.code === 'seal_process_failed' && !e.message.includes('private'));
  assert.equal(observed, true); assert.equal(fs.existsSync(h.lock), false);
  assert.equal((await sealCheckpointAsync(h.request)).state, 'saved_incomplete');
});

test('static delegated owner links are rejected without reading or deleting the target', t => {
  const h = setup(t);
  const { acquireProjectWriteLease, withDelegatedProjectWriteLock } = require('../../build/server/domain/runtime/badcase-capture/project-write-lock');
  const lease = acquireProjectWriteLease(h.root, 'p1');
  const ownerFile = path.join(h.lock, 'owner'), target = path.join(h.root, 'outside-owner');
  fs.renameSync(ownerFile, target);
  try { fs.symlinkSync(target, ownerFile); }
  catch (e) {
    if (!['EACCES', 'EPERM'].includes(e.code)) throw e;
    fs.renameSync(target, ownerFile); lease.release(); t.skip('symlink privilege unavailable'); return;
  }
  let ran = false;
  assert.throws(() => withDelegatedProjectWriteLock(h.root, 'p1', lease.owner, () => { ran = true; }), e => e.code === 'capture_lock_invalid');
  assert.throws(() => lease.release(), e => e.code === 'capture_lock_invalid');
  assert.equal(ran, false); assert.equal(fs.readFileSync(target, 'utf8'), lease.owner);
  assert.equal(fs.lstatSync(ownerFile).isSymbolicLink(), true);
});

test('two active workers block a third, keep parent writers out, then permit retry after close', { timeout: 15000 }, async t => {
  const first = setup(t), second = setup(t), third = setup(t);
  const pids = []; const pending = [];
  try {
    for (const h of [first, second]) {
      let ready;
      const signalled = new Promise(resolve => { ready = resolve; });
      const result = sealCheckpointAsync(h.request, { workerPath: h.hungWorker, timeoutMs: 6000,
        onSpawn: pid => pids.push(pid), onOutput: () => ready() });
      // Observe rejection immediately; always drain children even on assertion failure.
      pending.push(result.then(() => null, e => e));
      await Promise.race([signalled, pending.at(-1).then(e => { throw e || Error('worker ended before fault'); })]);
    }
    await assert.rejects(sealCheckpointAsync(third.request), e => e.code === 'seal_busy');
    assert.equal(fs.existsSync(third.lock), false);
    assert.throws(() => first.store.savePolicy(first.store.loadPolicy('p1')), e => e.code === 'capture_writer_busy');
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    const results = await Promise.all(pending);
    assert.ok(results.every(e => e?.code === 'seal_process_failed'));
  }
  assert.equal(fs.existsSync(first.lock), false); assert.equal(fs.existsSync(second.lock), false);
  assert.equal((await sealCheckpointAsync(third.request)).state, 'saved_incomplete');
});
