const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { withTempDir } = require('../helpers/temp-dir');
const { requireSpawn } = require('../helpers/spawn');

function start(t, script, options = {}) {
  const dir = withTempDir('caff-stream-diagnostics-');
  const host = path.join(dir, 'host.mjs');
  fs.writeFileSync(host, `let timer; process.on('message', c => { if(c.type === 'abort') process.exit(0); if(c.type !== 'start') return; ${script} });`);
  const modulePath = require.resolve('../../build/lib/pi-runtime');
  const previous = process.env.PI_SDK_HOST_OVERRIDE;
  process.env.PI_SDK_HOST_OVERRIDE = host;
  delete require.cache[modulePath];
  const runtime = require(modulePath);
  if (previous === undefined) delete process.env.PI_SDK_HOST_OVERRIDE;
  else process.env.PI_SDK_HOST_OVERRIDE = previous;
  delete require.cache[modulePath];
  const sqlitePath = path.join(dir, 'test.sqlite');
  const handle = runtime.startRun('test', 'test', 'test', {
    agentDir: dir, sqlitePath, cwd: dir, streamOutput: false,
    timeoutMs: 5000, heartbeatTimeoutMs: 0, progressTimeoutMs: 0,
    terminateGraceMs: 100, diagnosticsIntervalMs: 1000, ...options,
  });
  t.after(() => { handle.cancel(); fs.rmSync(dir, { recursive: true, force: true }); });
  function read() {
    const db = new Database(sqlitePath, { readonly: true });
    try {
      const row = db.prepare('SELECT status, stream_diagnostics_json FROM runs WHERE id = ?').get(handle.runId);
      return { status: row.status, summary: JSON.parse(row.stream_diagnostics_json) };
    } finally { db.close(); }
  }
  return { handle, read };
}

const sendDelta = (type, value) => `process.send({type:'pi_event',event:{type:'message_update',assistantMessageEvent:{type:${JSON.stringify(type)},delta:${JSON.stringify(value)}}}});`;

test('diagnostics persist while running and on abnormal exit, bounded and without sensitive payloads', async t => {
  if (!requireSpawn(t)) return;
  const { handle, read } = start(t, sendDelta('toolcall_delta', 'SENSITIVE_SENTINEL') + 'setInterval(() => {}, 1000);');
  const outcome = handle.resultPromise.catch(e => e);
  const summaries = [];
  await new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('missing periodic diagnostic')), 3500);
    handle.on('stream_diagnostics', e => {
      summaries.push(e.summary);
      if (e.summary.capture === 'periodic') { clearTimeout(guard); resolve(); }
    });
  });
  const live = read();
  assert.equal(live.status, 'running');
  assert.equal(live.summary.delta.count, 1);
  assert.equal(live.summary.phase, 'output');
  assert.equal(live.summary.refreshCounts.initial || 0, 0, 'disabled progress timer must not claim refreshes');
  handle.cancel('SENSITIVE_SENTINEL');
  await outcome;
  const final = read();
  assert.equal(final.status, 'failed');
  assert.equal(final.summary.capture, 'finished');
  assert.ok(!JSON.stringify(final.summary).includes('SENSITIVE_SENTINEL'));
  assert.ok(!JSON.stringify(summaries).includes('SENSITIVE_SENTINEL'));
  assert.ok(summaries.length <= 3);
});

test('abrupt host exit preserves final diagnosis without a graceful termination path', async t => {
  if (!requireSpawn(t)) return;
  const { handle, read } = start(t, sendDelta('thinking_delta', 'private thought') + 'setTimeout(() => process.exit(9), 50);');
  const error = await handle.resultPromise.catch(e => e);
  assert.equal(error.code, 9);
  assert.equal(read().status, 'failed');
  assert.equal(read().summary.capture, 'finished');
  assert.equal(read().summary.delta.count, 1);
});

test('diagnostic storage failures do not change the run result or leak error details', async t => {
  if (!requireSpawn(t)) return;
  const { SqliteRunStore } = require('../../build/lib/sqlite-store');
  const previous = SqliteRunStore.prototype.saveRunDiagnostics;
  SqliteRunStore.prototype.saveRunDiagnostics = () => { throw new Error('PRIVATE_STORAGE_ERROR'); };
  t.after(() => { SqliteRunStore.prototype.saveRunDiagnostics = previous; });
  const { handle } = start(t, 'setTimeout(() => process.exit(0), 50);');
  const warnings = [];
  handle.on('diagnostics_warning', e => warnings.push(e));
  const result = await handle.resultPromise;
  assert.equal(result.code, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'snapshot_write_failed');
  assert.ok(!JSON.stringify(warnings).includes('PRIVATE_STORAGE_ERROR'));
});

for (const [name, type, value] of [['empty', 'toolcall_delta', ''], ['whitespace', 'toolcall_delta', ' \n'], ['thinking', 'thinking_delta', 'thought'], ['sparse text', 'text_delta', 'x']]) {
  test(`diagnostics leave ${name} delta watchdog feeding and eventual stop-flow timeout unchanged`, async t => {
    if (!requireSpawn(t)) return;
    const { handle, read } = start(t, `let n=0; timer=setInterval(() => { ${sendDelta(type, value)} if(++n === 8) clearInterval(timer); }, 70);`, { progressTimeoutMs: 350 });
    const error = await handle.resultPromise.catch(e => e);
    assert.equal(error.terminationReason.type, 'progress_timeout');
    const { summary } = read();
    assert.equal(summary.delta.count, 8);
    assert.equal(summary.refreshCounts.pi_event, 8);
    assert.equal(summary.refreshCounts.initial, 1);
    assert.equal(summary.phase, type === 'thinking_delta' ? 'thinking' : 'output');
    assert.ok(summary.lastPiEventAt - summary.startedAt >= 490);
  });
}

test('heartbeat-only silence does not refresh progress and retains unknown stage after assistant start', async t => {
  if (!requireSpawn(t)) return;
  const { handle, read } = start(t, `process.send({type:'pi_event',event:{type:'message_start',message:{role:'assistant'}}}); setInterval(() => process.send({type:'heartbeat'}), 30);`, { progressTimeoutMs: 250, heartbeatTimeoutMs: 2000 });
  const error = await handle.resultPromise.catch(e => e);
  assert.equal(error.terminationReason.type, 'progress_timeout');
  const { summary } = read();
  assert.equal(summary.phase, 'unknown');
  assert.ok(summary.heartbeatCount > 0);
  assert.equal(summary.refreshCounts.pi_event, 1);
});

test('silent long reasoning and tool execution gain no new timeout when existing limits disabled', async t => {
  if (!requireSpawn(t)) return;
  for (const event of [{ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } }, { type: 'tool_execution_start', toolCallId: 'one', toolName: 'secret-tool' }]) {
    const { handle, read } = start(t, `process.send({type:'pi_event',event:${JSON.stringify(event)}}); setTimeout(() => process.exit(0), 1200);`, { timeoutMs: 0 });
    await handle.resultPromise;
    const { summary, status } = read();
    assert.equal(status, 'succeeded');
    assert.equal(summary.phase, event.type === 'tool_execution_start' ? 'tool' : 'thinking');
    assert.deepEqual(summary.refreshCounts, {});
  }
});
