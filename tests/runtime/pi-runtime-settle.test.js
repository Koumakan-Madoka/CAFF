const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const childProcess = require('node:child_process');
const Database = require('better-sqlite3');
const { withTempDir } = require('../helpers/temp-dir');

function syntheticRun(t, options = {}) {
  const dir = withTempDir('caff-settle-deadline-');
  const child = new EventEmitter();
  child.pid = 2147483647;
  child.connected = true;
  child.stderr = new PassThrough();
  const sent = [];
  const killed = [];
  child.send = (message, callback) => { sent.push(message); callback?.(null); };
  child.kill = signal => { killed.push(signal); return true; };
  // Capture the imports, including taskkill on Windows. No real process is
  // spawned or killed; all SQLite and diagnostics live in the system temp dir.
  const previous = { fork: childProcess.fork, spawn: childProcess.spawn, spawnSync: childProcess.spawnSync };
  childProcess.fork = () => child;
  childProcess.spawn = (...args) => { killed.push(args); const p = new EventEmitter(); p.unref = () => {}; return p; };
  childProcess.spawnSync = (...args) => { killed.push(args); return { status: 0 }; };
  const modulePath = require.resolve('../../build/lib/pi-runtime');
  delete require.cache[modulePath];
  let runtime;
  try { runtime = require(modulePath); }
  finally { Object.assign(childProcess, previous); delete require.cache[modulePath]; }
  const sqlitePath = path.join(dir, 'run.sqlite');
  const handle = runtime.startRun('test-provider', 'test-model', 'synthetic prompt', {
    agentDir: dir, sqlitePath, cwd: dir, streamOutput: false,
    heartbeatIntervalMs: 0, heartbeatTimeoutMs: 0, progressTimeoutMs: 0,
    timeoutMs: 20, terminateGraceMs: 20, terminationSettleMs: 80,
    ...options,
  });
  const outcome = handle.resultPromise.then(value => ({ value }), error => ({ error }));
  t.after(async () => {
    child.emit('close', 1, null); // Also release the unpatched implementation after a red assertion.
    await outcome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function row() {
    const db = new Database(sqlitePath, { readonly: true });
    try { return db.prepare('SELECT * FROM runs WHERE id = ?').get(handle.runId); }
    finally { db.close(); }
  }
  async function within(ms = 500) {
    let timer;
    try {
      return await Promise.race([outcome, new Promise(resolve => { timer = setTimeout(() => resolve({ hung: true }), ms); })]);
    } finally { clearTimeout(timer); }
  }
  return { child, handle, row, within, sent, killed };
}

test('watchdog settles as failed after force kill even when the child never emits close', async t => {
  const f = syntheticRun(t);
  const result = await f.within();
  assert.equal(result.hung, undefined, 'watchdog termination must not wait forever for close');
  assert.ok(result.error);
  assert.equal(result.error.terminationReason.type, 'run_timeout');
  assert.equal(result.error.terminationReason.closeObserved, false);
  assert.match(result.error.message, /close/i);
  assert.ok(f.sent.some(m => m.type === 'abort'));
  assert.ok(f.killed.length > 0);
  const row = f.row();
  assert.equal(row.status, 'failed');
  assert.ok(row.ended_at);
  const summary = JSON.parse(row.stream_diagnostics_json);
  assert.equal(summary.capture, 'finished');
  assert.equal(summary.watchdog.closeObserved, false);
  assert.equal(summary.watchdog.settleDeadlineExceeded, true);
  f.child.emit('close', 0, null);
  assert.deepEqual(f.row(), row, 'a late close must not overwrite the failed terminal row');
});

test('cancel also settles a missing close while retaining its original cancellation reason', async t => {
  const f = syntheticRun(t, { timeoutMs: 0 });
  f.handle.cancel('Synthetic shutdown');
  const result = await f.within();
  assert.equal(result.hung, undefined);
  assert.equal(result.error.terminationReason.type, 'cancelled');
  assert.equal(result.error.terminationReason.closeObserved, false);
  assert.equal(f.row().status, 'failed');
});

test('termination deadline can be configured by environment and cannot disable or precede force kill', async t => {
  const previous = process.env.PI_TERMINATION_SETTLE_MS;
  let f;
  try {
    process.env.PI_TERMINATION_SETTLE_MS = '70';
    f = syntheticRun(t, { terminationSettleMs: undefined });
  } finally {
    if (previous === undefined) delete process.env.PI_TERMINATION_SETTLE_MS;
    else process.env.PI_TERMINATION_SETTLE_MS = previous;
  }
  assert.ok((await f.within()).error);
  assert.equal(JSON.parse(f.row().stream_diagnostics_json).watchdog.terminationSettleMs, 70);
  const { startRun } = require('../../build/lib/pi-runtime');
  for (const terminationSettleMs of [0, 20, 19]) {
    assert.throws(() => startRun('test-provider', 'test-model', 'invalid setting', {
      terminateGraceMs: 20, terminationSettleMs,
    }), /terminationSettleMs must be greater than terminateGraceMs/);
  }
});

test('normal close before the settle deadline keeps the original timeout failure and finalizes once', async t => {
  const f = syntheticRun(t);
  f.handle.on('run_terminating', () => setTimeout(() => f.child.emit('close', 0, null), 5));
  let failed = 0;
  f.handle.on('run_failed', () => { failed += 1; });
  const result = await f.within();
  assert.equal(result.error.terminationReason.type, 'run_timeout');
  assert.equal(f.row().status, 'failed');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(failed, 1);
  const watchdog = JSON.parse(f.row().stream_diagnostics_json).watchdog;
  assert.equal(watchdog.closeObserved, true);
  assert.equal(watchdog.settleDeadlineExceeded, false);
});

test('a close emitted reentrantly by a terminal observer cannot overwrite deadline failure', async t => {
  const f = syntheticRun(t, { timeoutMs: 0 });
  let failures = 0;
  let successes = 0;
  f.handle.on('run_failed', () => {
    failures += 1;
    f.child.emit('close', 0, null);
  });
  f.handle.on('run_succeeded', () => { successes += 1; });
  f.handle.complete('Synthetic completion');
  const result = await f.within();
  assert.ok(result.error, 'deadline failure remains authoritative during terminal observers');
  assert.equal(failures, 1);
  assert.equal(successes, 0);
  assert.equal(f.row().status, 'failed');
});

test('expected completion without close must fail instead of normalizing an unobserved exit to success', async t => {
  const f = syntheticRun(t, { timeoutMs: 0 });
  f.child.emit('message', { type: 'pi_event', event: {
    type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer' }], stopReason: 'stop', timestamp: 1 },
  } });
  const result = await f.within();
  assert.equal(result.hung, undefined, 'expected completion must also obey the termination deadline');
  assert.ok(result.error);
  assert.equal(f.row().status, 'failed');
});
