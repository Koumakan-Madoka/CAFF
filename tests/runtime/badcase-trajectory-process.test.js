const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { readBadcaseTrajectory } = require('../../build/server/domain/runtime/badcase-capture/trajectory');
const { readBadcaseTrajectoryAsync } = require('../../build/server/domain/runtime/badcase-capture/trajectory-process');
const failure = code => error => error.code === code && error.message === code;
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-trajectory-process-'));
  const databasePath = path.join(root, 'test.sqlite');
  const store = createChatAppStore({ agentDir: root, sqlitePath: databasePath });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  store.saveCustomRoleConfig({ id: 'agent-a', name: 'Synthetic', personaPrompt: 'test' });
  store.createConversation({ id: 'room-a', title: 'Synthetic', participants: ['agent-a'], projectScopeId: 'project-a' });
  const association = { projectId: 'project-a', conversationId: 'room-a', messageId: 'message-a', turnId: 'turn-a', agentId: 'agent-a', taskId: 'task-a', runId: 1, checkpointId: 'checkpoint-a' };
  store.createMessage({ id: 'message-a', conversationId: 'room-a', turnId: 'turn-a', agentId: 'agent-a', taskId: 'task-a', runId: 1,
    role: 'assistant', content: 'result', status: 'completed', metadata: { badcaseCheckpointId: 'checkpoint-a' } });
  require('../../build/lib/sqlite-store').createSqliteRunStore({ agentDir: root, db: store.db });
  store.db.prepare(`INSERT INTO runs (id, agent_dir, cwd, prompt, prompt_length, status, started_at, task_id, assistant_errors_json)
    VALUES (1, '/not-read', '/not-read', 'not archived', 12, 'succeeded', '2026-01-01', 'task-a', '[]')`).run();
  store.db.prepare(`INSERT INTO a2a_tasks (id, run_id, kind, status, metadata_json, output_text, created_at, updated_at)
    VALUES ('task-a', 1, 'conversation_agent_reply', 'succeeded', ?, 'result', '2026-01-01', '2026-01-01')`)
    .run(JSON.stringify({ conversationId: 'room-a', turnId: 'turn-a', agentId: 'agent-a' }));
  const request = { databasePath, association };
  const worker = source => { const file = path.join(root, `worker-${Math.random()}.cjs`); fs.writeFileSync(file, source); return file; };
  return { root, databasePath, store, request, worker,
    read: options => readBadcaseTrajectoryAsync(request, options),
    append(payload) { store.db.prepare('INSERT INTO a2a_task_events (task_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?)')
      .run('task-a', 'agent_tool_call', JSON.stringify(payload), '2026-01-01'); } };
}

test('real readonly subprocess returns the same full trajectory and leaves SQLite data unchanged', { timeout: 15000 }, async t => {
  const h = setup(t);
  for (let i = 0; i < 260; i++) h.append({ tool: 'read', result: `raw-${i}` });
  const before = h.store.db.serialize();
  const expected = readBadcaseTrajectory({ db: h.store.db, association: h.request.association });
  assert.deepEqual(await h.read(), expected);
  assert.deepEqual(await h.read(), expected);
  assert.equal(expected.events.length, 260); assert.equal(expected.task.output, 'result');
  assert.equal(expected.complete, false); assert.equal(expected.strictEvalEligible, false);
  assert.deepEqual(h.store.db.serialize(), before);
});

test('real subprocess rejects mismatches, secrets and missing databases without creating one', { timeout: 15000 }, async t => {
  const h = setup(t);
  await assert.rejects(readBadcaseTrajectoryAsync({ ...h.request, association: { ...h.request.association, checkpointId: 'wrong' } }), failure('trajectory_association_mismatch'));
  h.append({ result: JSON.stringify({ visibility: 'private' }) });
  await assert.rejects(h.read(), failure('trajectory_private_content'));
  h.store.db.prepare('DELETE FROM a2a_task_events').run(); h.append({ result: 'sk-FAKE_SENTINEL_123456' });
  await assert.rejects(h.read(), failure('trajectory_sensitive_content'));
  const absent = path.join(h.root, 'missing.sqlite');
  await assert.rejects(readBadcaseTrajectoryAsync({ ...h.request, databasePath: absent }), failure('trajectory_unavailable'));
  assert.equal(fs.existsSync(absent), false);
});

test('request shape, absolute database path and limits fail before starting a worker', { timeout: 10000 }, async t => {
  const h = setup(t), marker = path.join(h.root, 'started');
  const workerPath = h.worker(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
  for (const request of [null, { ...h.request, extra: true }, { ...h.request, databasePath: 'relative.db' },
    { ...h.request, association: { ...h.request.association, runId: '1' } }, { ...h.request, limits: { maxBytes: 4194305 } }]) {
    await assert.rejects(readBadcaseTrajectoryAsync(request, { workerPath }), failure('trajectory_invalid_input'));
  }
  assert.equal(fs.existsSync(marker), false);
});

test('timeout kills the reader and frees concurrency; main loop remains responsive', { timeout: 15000 }, async t => {
  const h = setup(t);
  const workerPath = h.worker("process.stdin.resume(); process.stdout.write('ready'); setInterval(()=>{},1000);");
  let pid, responsive = false;
  const pending = h.read({ workerPath, timeoutMs: 3000, onOutput() { setImmediate(() => { responsive = true; }); }, onSpawn(value) { pid = value; } });
  await assert.rejects(pending, failure('trajectory_timeout'));
  assert.equal(responsive, true); assert.ok(pid);
  assert.throws(() => process.kill(pid, 0));
  assert.equal((await h.read()).kind, 'badcase-database-trajectory');
});

test('two active readers are allowed, third rejects without queueing; slots release on timeout', { timeout: 15000 }, async t => {
  const h = setup(t);
  const workerPath = h.worker("process.stdin.resume(); setInterval(()=>{},1000);");
  // Attach rejection handlers immediately so no timeout can become unhandled.
  const first = assert.rejects(h.read({ workerPath, timeoutMs: 1500 }), failure('trajectory_timeout'));
  const second = assert.rejects(h.read({ workerPath, timeoutMs: 1500 }), failure('trajectory_timeout'));
  await assert.rejects(h.read(), failure('trajectory_busy'));
  await Promise.all([first, second]);
  assert.equal((await h.read()).complete, false);
});

test('stdout and stderr are bounded together and never exposed in errors', { timeout: 15000 }, async t => {
  const h = setup(t);
  for (const stream of ['stdout', 'stderr']) {
    const workerPath = h.worker(`process.stdin.resume(); process.${stream}.write('private-diagnostic'.repeat(4096)); setInterval(()=>{},1000);`);
    await assert.rejects(h.read({ workerPath, maxOutputBytes: 1024 }), failure('trajectory_output_limit'));
  }
  const workerPath = h.worker("process.stdin.resume(); process.stdout.write('private-malformed-json');");
  await assert.rejects(h.read({ workerPath }), failure('trajectory_output_invalid'));
});

test('no payload is accepted before clean close; wrong association/status and arbitrary error codes reject', { timeout: 15000 }, async t => {
  const h = setup(t), good = readBadcaseTrajectory({ db: h.store.db, association: h.request.association });
  for (const envelope of [{ ok: false, code: 'trajectory_/private/path' }, { ok: true, result: { ...good, complete: true } },
    { ok: true, result: { ...good, association: { ...good.association, runId: 2 } } }]) {
    const workerPath = h.worker(`process.stdin.resume(); process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});`);
    await assert.rejects(h.read({ workerPath }), failure('trajectory_output_invalid'));
  }
  const workerPath = h.worker(`process.stdin.resume(); process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, result: good }))}, () => process.exit(7));`);
  await assert.rejects(h.read({ workerPath }), failure('trajectory_process_failed'));
});

test('child does not inherit Node startup hooks or unrelated host credentials', { timeout: 15000 }, async t => {
  const h = setup(t), name = 'CAFF_TEST_SYNTHETIC_PRIVATE_VALUE', original = process.env[name], originalOptions = process.env.NODE_OPTIONS;
  const marker = path.join(h.root, 'hook-ran');
  const hook = h.worker(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const good = readBadcaseTrajectory({ db: h.store.db, association: h.request.association });
  const workerPath = h.worker(`process.stdin.resume(); if(process.env.${name} || process.env.NODE_OPTIONS) process.exit(8);
    process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, result: good }))});`);
  try {
    process.env[name] = 'synthetic'; process.env.NODE_OPTIONS = `--require=${hook}`;
    assert.equal((await h.read({ workerPath })).complete, false);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (original === undefined) delete process.env[name]; else process.env[name] = original;
    if (originalOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalOptions;
  }
});
