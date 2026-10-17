const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const lockPath = require.resolve('../../build/server/domain/runtime/badcase-capture/project-write-lock');
const { withAsyncProjectWriteLease, withProjectWriteLock, acquireProjectWriteLease,
  inspectProjectWriteLock, recoverProjectWriteLock } = require(lockPath);
const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { inspectOrphanBlobs, collectOrphanBlobs } = require('../../build/server/domain/runtime/badcase-capture/orphan-gc');
const { saveSealedCase } = require('../../build/server/domain/runtime/badcase-capture/sealed-case');
const code = wanted => e => e.code === wanted;
const tick = () => new Promise(resolve => setImmediate(resolve));
function latch() { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-async-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root });
  store.savePolicy({ ...store.loadPolicy('p1'), stagingQuotaBytes: 1024 * 1024 });
  const project = path.join(root, 'projects', 'p1'), lock = path.join(project, '.writer-lock');
  const content = Buffer.from('unpublished synthetic file'), hash = sha256Hex(content);
  store.writeBlob('p1', hash, content);
  const q = { captureRoot: root, projectId: 'p1' }, plan = inspectOrphanBlobs(q);
  return { root, store, project, lock, content, hash, q, plan };
}
function busy(h) {
  assert.ok(fs.existsSync(h.lock));
  assert.throws(() => h.store.savePolicy(h.store.loadPolicy('p1')), code('capture_writer_busy'));
  assert.throws(() => inspectOrphanBlobs(h.q), code('capture_writer_busy'));
  assert.throws(() => collectOrphanBlobs(h.q, { confirmed: true, expected: h.plan.planHash }), code('capture_writer_busy'));
  assert.throws(() => saveSealedCase({ captureRoot: h.root, association: {
    projectId: 'p1', conversationId: 'c1', messageId: 'm1', turnId: 't1', agentId: 'a1',
    taskId: 'task1', checkpointId: 'cp1', runId: 1,
  }, flagId: `flag-${sha256Hex('p1\0m1')}` }), code('capture_writer_busy'));
}
function checkpoint(h) {
  return { schemaVersion: 1, checkpointId: 'cp1', projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1',
    files: { 'file.txt': { type: 'file', hash: h.hash, size: h.content.length, mode: 0o100644 } }, deletions: [],
    replayInput: { complete: false, deliveryMode: 'fresh', incompleteReasons: ['prompt_missing'], harness: { skillSnapshots: [] } } };
}

test('async lease holds across await without granting unrelated stack reentrancy; explicit publish protects CAS from GC', async t => {
  const h = setup(t), entered = latch(), finish = latch(); let write;
  const run = withAsyncProjectWriteLease(h.root, 'p1', async commit => {
    write = commit; entered.resolve(); await finish.promise;
    return commit(() => {
      assert.equal(withProjectWriteLock(h.root, 'p1', () => 7), 7, 'only the synchronous commit stack is reentrant');
      h.store.savePolicy(h.store.loadPolicy('p1'));
      h.store.saveCheckpoint('p1', checkpoint(h));
      h.store.saveLatestCheckpointId('p1', h.root, 'cp1');
      return { published: true };
    });
  });
  try {
    await entered.promise; await tick(); busy(h);
    let secondEntered = false;
    await assert.rejects(withAsyncProjectWriteLease(h.root, 'p1', async () => { secondEntered = true; }), code('capture_writer_busy'));
    assert.equal(secondEntered, false);
    const other = acquireProjectWriteLease(h.root, 'p2'); other.release();
    const source = `const {withProjectWriteLock}=require(${JSON.stringify(lockPath)});try{withProjectWriteLock(${JSON.stringify(h.root)},'p1',()=>process.exit(9))}catch(e){process.stdout.write(e.code)}`;
    const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0); assert.equal(child.stdout, 'capture_writer_busy');
    assert.equal(h.store.loadCheckpoint('p1', 'cp1'), null);
  } finally { finish.resolve(); await run.catch(() => {}); }
  assert.deepEqual(await run, { published: true });
  assert.equal(fs.existsSync(h.lock), false);
  let staleRan = false;
  assert.throws(() => write(() => { staleRan = true; }), code('capture_lock_invalid'));
  assert.equal(staleRan, false);
  assert.equal(inspectOrphanBlobs(h.q).candidates.length, 0);
  assert.deepEqual(h.store.readBlob('p1', h.hash), h.content);
  assert.equal(h.store.loadCheckpoint('p1', 'cp1').replayInput.complete, false);
  assert.throws(() => collectOrphanBlobs(h.q, { confirmed: true, expected: h.plan.planHash }), code('orphan_gc_plan_changed'));
});

for (const mode of ['throw', 'reject', 'commit-throw', 'return-refusal', 'return-empty']) {
  test(`async lease releases after ${mode}, clears scoped writer and permits next capture`, async t => {
    const h = setup(t); let write;
    const refusal = { captured: false, reason: 'fixture_refused' }, problem = Error('synthetic failure');
    const run = withAsyncProjectWriteLease(h.root, 'p1', async commit => {
      write = commit;
      if (mode === 'throw') throw problem;
      await tick(); busy(h);
      if (mode === 'reject') throw problem;
      if (mode === 'commit-throw') return commit(() => { throw problem; });
      return mode === 'return-refusal' ? refusal : undefined;
    });
    if (['throw', 'reject', 'commit-throw'].includes(mode)) await assert.rejects(run, e => e === problem);
    else assert.equal(await run, mode === 'return-refusal' ? refusal : undefined);
    assert.equal(fs.existsSync(h.lock), false);
    let ran = false;
    assert.throws(() => write(() => { ran = true; }), code('capture_lock_invalid')); assert.equal(ran, false);
    assert.equal(await withAsyncProjectWriteLease(h.root, 'p1', commit => commit(() => 42)), 42);
    h.store.savePolicy(h.store.loadPolicy('p1'));
  });
}

test('callbacks scheduled inside a commit receive no ambient permission while outer action still waits', async t => {
  const h = setup(t), entered = latch(), done = latch(); let scheduled;
  const run = withAsyncProjectWriteLease(h.root, 'p1', async commit => {
    commit(() => { scheduled = tick().then(() => busy(h)); });
    entered.resolve(); await done.promise;
  });
  try { await entered.promise; await scheduled; busy(h); }
  finally { done.resolve(); await run.catch(() => {}); }
  await run;
});

test('live in-process async action cannot be retired even with a claimed offline confirmation', async t => {
  const h = setup(t), entered = latch(), done = latch();
  const run = withAsyncProjectWriteLease(h.root, 'p1', async () => { entered.resolve(); await done.promise; });
  try {
    await entered.promise;
    const expected = inspectProjectWriteLock(h.root, 'p1');
    assert.throws(() => recoverProjectWriteLock(h.root, 'p1', { expected, writersStopped: true }), code('capture_writer_busy'));
    assert.equal(fs.existsSync(path.join(h.project, '.writer-recovery')), false);
    assert.equal(inspectProjectWriteLock(h.root, 'p1'), expected);
    assert.equal(fs.readdirSync(h.project).some(n => n.startsWith('.writer-lock-retired-')), false);
  } finally { done.resolve(); await run.catch(() => {}); }
  await run;
});

for (const mode of ['promise-resolve', 'promise-reject', 'function-resolve', 'object-reject']) {
  test(`accidental async commit ${mode} fails, drains its returned task, revokes scope and never unlocks early`, async t => {
    const h = setup(t), entered = latch(), taskDone = latch(), actionDone = latch(); let write, rejected;
    const run = withAsyncProjectWriteLease(h.root, 'p1', async commit => {
      write = commit;
      // Ordinary function returning a Promise tests the runtime result guard,
      // not merely an AsyncFunction constructor-name check.
      try {
        assert.throws(() => commit(() => {
          entered.resolve();
          if (mode === 'function-resolve') {
            const value = function () {}; value.then = taskDone.promise.then.bind(taskDone.promise); return value;
          }
          if (mode === 'object-reject') return { then: taskDone.promise.then.bind(taskDone.promise) };
          return taskDone.promise;
        }), code('capture_lock_async_commit'));
      } finally { actionDone.resolve(); }
      return 'must not report success after swallowed misuse';
    });
    const observed = run.then(() => { rejected = false; }, error => { rejected = error.code; });
    try {
      await entered.promise; await actionDone.promise; await tick();
      busy(h); assert.equal(rejected, undefined, 'returned task is still in flight');
      let ran = false;
      assert.throws(() => write(() => { ran = true; }), code('capture_lock_invalid')); assert.equal(ran, false);
    } finally {
      if (mode.endsWith('reject')) taskDone.reject(Error('unlogged synthetic task error'));
      else taskDone.resolve();
    }
    await observed;
    assert.equal(rejected, 'capture_lock_async_commit'); assert.equal(fs.existsSync(h.lock), false);
    h.store.savePolicy(h.store.loadPolicy('p1'));
  });
}

test('same-project sync or foreign lease and recovery gate block before action; invalid inputs do not create storage', async t => {
  const h = setup(t); let calls = 0;
  const action = async () => { calls++; };
  let blocked;
  withProjectWriteLock(h.root, 'p1', () => { blocked = assert.rejects(withAsyncProjectWriteLease(h.root, 'p1', action), code('capture_writer_busy')); });
  await blocked;
  const lease = acquireProjectWriteLease(h.root, 'p1');
  try { await assert.rejects(withAsyncProjectWriteLease(h.root, 'p1', action), code('capture_writer_busy')); }
  finally { lease.release(); }
  fs.mkdirSync(path.join(h.project, '.writer-recovery'));
  try { await assert.rejects(withAsyncProjectWriteLease(h.root, 'p1', action), code('capture_writer_busy')); }
  finally { fs.rmdirSync(path.join(h.project, '.writer-recovery')); }
  for (const project of ['', '../other', 'p1/other']) await assert.rejects(withAsyncProjectWriteLease(h.root, project, action), code('capture_lock_invalid'));
  await assert.rejects(withAsyncProjectWriteLease(h.root, 'missing', null), code('capture_lock_invalid'));
  assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(h.root, 'projects', 'missing')), false);
});

test('real Windows async Git candidate under lease publishes to CAS in explicit commit and restores twice (test writer only)',
  { skip: process.platform !== 'win32' ? 'real Windows NTFS required' : false }, async t => {
  const h = setup(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-async-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { execFileSync } = require('node:child_process');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'absent-global'), GIT_TEMPLATE_DIR: '' } });
  git('init', '-q'); git('config', 'core.ignorecase', 'false');
  fs.writeFileSync(path.join(root, 'file.txt'), 'original'); git('add', 'file.txt');
  fs.writeFileSync(path.join(root, 'file.txt'), 'dirty');
  fs.writeFileSync(path.join(root, 'untracked'), 'new');
  fs.writeFileSync(path.join(root, 'secret'), 'sk-SENTINELabcdefghijk');
  const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
  const { readWindowsGitFileCandidateAsync } = require('../../build/server/domain/runtime/badcase-capture/windows-git-candidate');
  const { restoreCheckpoint } = require('../../build/server/domain/runtime/badcase-capture/restore');
  const service = createBadcaseCaptureService({ captureRoot: h.root });
  service.savePolicy('p1', { ...service.loadPolicy('p1'), authorizedDirs: [root], authorizedInputDirs: [], excludedPatterns: [] });
  service.authorizeProject('p1');
  const before = service.loadPolicy('p1');
  const value = await withAsyncProjectWriteLease(h.root, 'p1', async commit => {
    const pending = readWindowsGitFileCandidateAsync({ targetDir: root, captureRoot: h.root, policy: before });
    let candidate;
    try { await tick(); busy(h); }
    finally { candidate = await pending; }
    assert.equal(candidate.ok, true, candidate.reason);
    assert.equal(h.store.listCheckpoints('p1').length, 0);
    return commit(() => {
      // This is a trusted test writer, NOT the enabled turn collector. It must
      // not upgrade candidate completeness or claim independent consistency.
      for (const [digest, bytes] of candidate.blobs) h.store.stageBlob('p1', 'test', digest, bytes);
      h.store.commitStaging('p1', 'test');
      const cp = { ...checkpoint(h), files: candidate.files, targetDir: root, strictEvalEligible: false,
        limitations: candidate.limitations, consistency: { level: 'best_effort' } };
      h.store.saveCheckpoint('p1', cp); h.store.saveLatestCheckpointId('p1', root, 'cp1');
      return cp;
    });
  });
  assert.equal(fs.existsSync(h.lock), false); assert.deepEqual(service.loadPolicy('p1'), before);
  assert.equal(before.status, 'disabled');
  const restored = [];
  for (const n of [1, 2]) {
    const targetDir = path.join(h.root, `test-restore-${n}`);
    const result = restoreCheckpoint({ store: h.store, projectId: 'p1', checkpointId: 'cp1', targetDir });
    assert.equal(result.ok, true, result.reason); assert.equal(result.strictEvalEligible, false);
    assert.equal(result.replayInputComplete, false); assert.deepEqual(result.missingSecrets, ['secret']);
    assert.equal(fs.readFileSync(path.join(targetDir, 'file.txt'), 'utf8'), 'dirty');
    assert.equal(fs.readFileSync(path.join(targetDir, 'untracked'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(targetDir, 'secret')), false); restored.push(result.restoredFiles);
  }
  assert.deepEqual(restored[0], restored[1]); assert.equal(value.strictEvalEligible, false);
});

test('owner mismatch prevents commit and release without deleting replacement owner; settled wrapper can be recovered explicitly', async t => {
  const h = setup(t); let write, ran = false;
  await assert.rejects(withAsyncProjectWriteLease(h.root, 'p1', async commit => {
    write = commit;
    fs.writeFileSync(path.join(h.lock, 'owner'), 'f'.repeat(64));
    assert.throws(() => commit(() => { ran = true; }), code('capture_lock_invalid'));
  }), code('capture_lock_invalid'));
  assert.equal(ran, false); assert.equal(fs.readFileSync(path.join(h.lock, 'owner'), 'utf8'), 'f'.repeat(64));
  assert.throws(() => write(() => { ran = true; }), code('capture_lock_invalid'));
  const expected = inspectProjectWriteLock(h.root, 'p1');
  const receipt = recoverProjectWriteLock(h.root, 'p1', { expected, writersStopped: true });
  assert.equal(receipt.recovered, true);
  assert.equal(fs.readFileSync(path.join(h.project, receipt.quarantineName, 'lock', 'owner'), 'utf8'), 'f'.repeat(64));
  assert.equal(await withAsyncProjectWriteLease(h.root, 'p1', commit => commit(() => 1)), 1);
});
