const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { readBadcaseTrajectory } = require('../../build/server/domain/runtime/badcase-capture/trajectory');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-trajectory-'));
  const store = createChatAppStore({ agentDir: root, sqlitePath: path.join(root, 'test.sqlite') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  store.saveCustomRoleConfig({ id: 'agent-a', name: 'Trajectory', personaPrompt: 'synthetic' });
  store.createConversation({ id: 'room-a', title: 'Synthetic', participants: ['agent-a'], projectScopeId: 'project-a' });
  const scope = { projectId: 'project-a', conversationId: 'room-a', messageId: 'message-a', turnId: 'turn-a', agentId: 'agent-a', taskId: 'task-a', runId: 1, checkpointId: 'checkpoint-a' };
  store.createMessage({ id: scope.messageId, conversationId: scope.conversationId, turnId: scope.turnId,
    agentId: scope.agentId, role: 'assistant', senderName: 'Trajectory', content: 'message body not copied', status: 'completed',
    taskId: scope.taskId, runId: scope.runId, metadata: { badcaseCheckpointId: scope.checkpointId } });
  const db = store.db;
  require('../../build/lib/sqlite-store').createSqliteRunStore({ agentDir: root, db });
  db.prepare(`INSERT INTO runs (id, agent_dir, cwd, prompt, prompt_length, status, started_at, task_id, assistant_errors_json)
    VALUES (1, '/not-read', '/not-read', 'private input not copied', 24, 'succeeded', '2026-01-01', 'task-a', '[]')`).run();
  db.prepare(`INSERT INTO a2a_tasks (id, run_id, kind, status, metadata_json, output_text, created_at, updated_at, session_path)
    VALUES ('task-a', 1, 'conversation_agent_reply', 'succeeded', ?, 'result', '2026-01-01', '2026-01-01', '/must-not-be-read/session.jsonl')`)
    .run(JSON.stringify({ conversationId: scope.conversationId, turnId: scope.turnId, agentId: scope.agentId, agentPrivateDir: '/not-archived' }));
  const append = (payload, type = 'agent_tool_call') => db.prepare('INSERT INTO a2a_task_events (task_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run(scope.taskId, type, typeof payload === 'string' ? payload : JSON.stringify(payload), '2026-01-01');
  const read = (limits) => readBadcaseTrajectory({ db, association: scope, limits });
  return { root, store, db, scope, append, read };
}
const code = value => failure => failure.code === value && failure.message === value;

test('reads full ordered raw bridge events beyond Inspector window, not clipped display summaries', t => {
  const h = setup(t);
  for (let i = 0; i < 250; i++) h.append({ tool: 'read', request: { relative: `file-${i}` }, result: { content: 'x'.repeat(400) }, ordinal: i });
  h.append({ type: 'expected_completion' }, 'agent_reply_terminating');
  h.append({ unarchived: true }, 'agent_reply_queued');
  const result = h.read();
  assert.equal(result.schemaVersion, 1); assert.equal(result.databaseConsistent, true);
  assert.equal(result.events.length, 251); assert.equal(result.events[125].payload.ordinal, 125);
  assert.equal(result.events[125].payload.result.content.length, 400);
  assert.ok(result.events.every((row, index, rows) => index === 0 || row.id > rows[index - 1].id));
  assert.equal(result.totalTaskEventCount, 252); assert.equal(result.archivedEventCount, 251);
  assert.equal(result.complete, false); assert.equal(result.strictEvalEligible, false);
  assert.deepEqual(result.incompleteReasons, ['post_turn_session_not_archived', 'context_snapshot_not_archived', 'usage_not_archived',
    'timeline_not_archived', 'attachments_not_archived', 'private_ancestry_not_verified', 'no_independent_consistency_evidence',
    'other_task_events_not_archived']);
  const text = JSON.stringify(result);
  for (const absent of ['message body not copied', 'private input not copied', '/not-archived', '/must-not-be-read']) assert.ok(!text.includes(absent));
  assert.deepEqual(h.read(), result, 'no mutable timestamps or database writes in reader');
});

test('checks project, message, task, run, checkpoint, turn and agent association before returning content', t => {
  for (const key of Object.keys(setup(t).scope)) {
    const h = setup(t); h.append({ content: 'must not leak on mismatch' });
    const association = { ...h.scope, [key]: key === 'runId' ? 2 : 'other' };
    assert.throws(() => readBadcaseTrajectory({ db: h.db, association }), code('trajectory_association_mismatch'), key);
  }
});

test('rejects task metadata and reciprocal run task mismatches instead of trusting only message IDs', t => {
  for (const key of ['conversationId', 'turnId', 'agentId']) {
    const h = setup(t);
    const metadata = { conversationId: 'room-a', turnId: 'turn-a', agentId: 'agent-a', [key]: 'other' };
    h.db.prepare('UPDATE a2a_tasks SET metadata_json=?').run(JSON.stringify(metadata));
    assert.throws(h.read, code('trajectory_association_mismatch'));
  }
  const h = setup(t); h.db.prepare("UPDATE runs SET task_id='other'").run();
  assert.throws(h.read, code('trajectory_association_mismatch'));
});

test('only terminal public message/task/run combinations may supply a trajectory', t => {
  for (const sql of ["UPDATE chat_messages SET status='streaming'", "UPDATE a2a_tasks SET status='running'", "UPDATE runs SET status='running'"]) {
    const h = setup(t); h.db.exec(sql); assert.throws(h.read, code('trajectory_not_terminal'));
  }
  const h = setup(t); h.db.prepare('UPDATE chat_messages SET metadata_json=?').run(JSON.stringify({ privateOnly: true, badcaseCheckpointId: 'checkpoint-a' }));
  assert.throws(h.read, code('trajectory_private_content'));
});

test('private trigger message and unknown/missing trigger associations fail closed', t => {
  for (const mode of ['private', 'missing', 'other-room']) {
    const h = setup(t);
    if (mode !== 'missing') {
      if (mode === 'other-room') h.store.createConversation({ id: 'room-b', title: 'Other', participants: ['agent-a'], projectScopeId: 'project-a' });
      h.store.createMessage({ id: 'trigger', conversationId: mode === 'other-room' ? 'room-b' : 'room-a', turnId: 'turn-a', role: 'user', senderName: 'test', content: 'never copied', metadata: { privateOnly: mode === 'private' } });
    }
    h.db.prepare('UPDATE a2a_tasks SET metadata_json=?').run(JSON.stringify({ conversationId: 'room-a', turnId: 'turn-a', agentId: 'agent-a', triggeredByMessageId: 'trigger' }));
    assert.throws(h.read, code(mode === 'private' ? 'trajectory_private_content' : 'trajectory_trigger_unverified'));
  }
});

test('rejects sensitive and private event payloads, including short values and nested JSON strings', t => {
  for (const payload of [
    { request: { password: 'a' } }, { request: { headers: { Authorization: 'Bearer short' } } },
    { result: 'sk-FAKE_SENTINEL_123456' }, { result: JSON.stringify({ apiKey: 'tiny' }) },
    { request: 'Authorization: Bearer anything' }, { request: 'TOKEN=small' },
    { result: 'nul\0hidden' }, { privateOnly: true }, { visibility: 'private' }, { tool: 'send-private' },
    { result: JSON.stringify({ visibility: 'private' }) }, { result: JSON.stringify([{ role: 'private' }]) },
  ]) {
    const h = setup(t); h.append(payload);
    assert.throws(h.read, failure => ['trajectory_sensitive_content', 'trajectory_private_content'].includes(failure.code));
  }
});

test('output/error and assistant error JSON are checked too; invalid JSON is never silently dropped', t => {
  for (const sql of [
    `UPDATE a2a_tasks SET output_text='password=synthetic'`,
    `UPDATE a2a_tasks SET error_message='Bearer synthetic'`,
    `UPDATE runs SET assistant_errors_json='[{"secret":"tiny"}]'`,
  ]) { const h = setup(t); h.db.exec(sql); assert.throws(h.read, code('trajectory_sensitive_content')); }
  for (const sql of ["UPDATE a2a_tasks SET metadata_json='{'", "UPDATE chat_messages SET metadata_json='{'", "UPDATE runs SET assistant_errors_json='{' "]) {
    const h = setup(t); h.db.exec(sql); assert.throws(h.read, code('trajectory_invalid_source'));
  }
  const h = setup(t); h.append('{'); assert.throws(h.read, code('trajectory_invalid_source'));
});

test('count and UTF-8 byte limits reject rather than exporting a silently truncated trajectory', t => {
  const h = setup(t); h.append({ text: '字'.repeat(400) }); h.append({ text: 'second' });
  assert.throws(() => h.read({ maxEvents: 1 }), code('trajectory_limit_exceeded'));
  assert.throws(() => h.read({ maxBytes: 1024 }), code('trajectory_limit_exceeded'));
  assert.equal(h.read().events.length, 2);
  const huge = setup(t); huge.db.prepare('UPDATE a2a_tasks SET metadata_json=?').run(' '.repeat(65537));
  assert.throws(huge.read, code('trajectory_limit_exceeded'));
});

test('role, task kind, metadata limits, nesting depth and final JSON limit have independent negative cases', t => {
  for (const sql of ["UPDATE chat_messages SET role='user'", "UPDATE a2a_tasks SET kind='other'"]) {
    const h = setup(t); h.db.exec(sql); assert.throws(h.read, code('trajectory_association_mismatch'));
  }
  const message = setup(t); message.db.prepare('UPDATE chat_messages SET metadata_json=?').run(' '.repeat(65537));
  assert.throws(message.read, code('trajectory_limit_exceeded'));
  const trigger = setup(t);
  trigger.store.createMessage({ id: 'trigger', conversationId: 'room-a', role: 'user', content: 'not archived', metadata: { padding: ' '.repeat(65537) } });
  trigger.db.prepare('UPDATE a2a_tasks SET metadata_json=?').run(JSON.stringify({ conversationId: 'room-a', turnId: 'turn-a', agentId: 'agent-a', triggeredByMessageId: 'trigger' }));
  assert.throws(trigger.read, code('trajectory_trigger_unverified'));
  const deep = setup(t); let nested = { text: 'safe' };
  for (let i = 0; i < 70; i++) nested = { nested };
  deep.append(nested); assert.throws(deep.read, code('trajectory_limit_exceeded'));
  const final = setup(t); for (let i = 0; i < 100; i++) final.append({});
  assert.throws(() => final.read({ maxBytes: 5000 }), code('trajectory_limit_exceeded'));
});

test('task output may equal message body; only the separate message-content column is omitted', t => {
  const h = setup(t); h.db.prepare('UPDATE a2a_tasks SET output_text=?').run('message body not copied');
  assert.equal(h.read().task.output, 'message body not copied');
  assert.equal('message' in h.read(), false);
});

test('event attribution cannot contradict the frozen message association', t => {
  for (const key of ['assistantMessageId', 'conversationId', 'turnId', 'agentId']) {
    const h = setup(t); h.append({ [key]: 'other', result: 'not returned' });
    assert.throws(h.read, code('trajectory_association_mismatch'));
  }
});

test('byte preflight rejects before reading oversized event payloads into JavaScript', t => {
  const h = setup(t); h.append({ result: '字'.repeat(2000) });
  const original = h.db.prepare; let fetchedEvents = false;
  try {
    h.db.prepare = function (sql) {
      if (/SELECT id, event_type, event_json/.test(sql)) fetchedEvents = true;
      return original.call(this, sql);
    };
    assert.throws(() => h.read({ maxBytes: 1024 }), code('trajectory_limit_exceeded'));
    assert.equal(fetchedEvents, false);
  } finally { h.db.prepare = original; }
});

test('source absent/unreadable and invalid inputs have stable errors without exposing database exceptions', t => {
  const h = setup(t);
  for (const association of [null, { ...h.scope, extra: true }, { ...h.scope, runId: '1' }, { ...h.scope, projectId: '../x' }]) {
    assert.throws(() => readBadcaseTrajectory({ db: h.db, association }), code('trajectory_invalid_input'));
  }
  assert.throws(() => h.read({ maxEvents: 10001 }), code('trajectory_invalid_input'));
  assert.throws(() => readBadcaseTrajectory({ db: { transaction: () => { throw Error('/private/path'); } }, association: h.scope }), code('trajectory_unavailable'));
  h.db.prepare('DELETE FROM a2a_task_events').run(); h.db.prepare('DELETE FROM a2a_tasks').run();
  assert.throws(h.read, code('trajectory_association_mismatch'));
});

test('SQLite read transaction observes one snapshot across a concurrent WAL writer', t => {
  const h = setup(t); h.append({ result: 'old' });
  // Separate connection, same isolated temporary DB. No source repository or production database is accessed.
  const Database = require('better-sqlite3');
  const writer = new Database(path.join(h.root, 'test.sqlite'));
  h.db.pragma('journal_mode = WAL');
  const original = h.db.prepare;
  let intercepted = false;
  try {
    h.db.prepare = function (sql) {
      const statement = original.call(this, sql);
      if (/FROM a2a_task_events/.test(sql) && !intercepted) {
        intercepted = true;
        writer.prepare('UPDATE a2a_task_events SET event_json=?').run(JSON.stringify({ result: 'new' }));
      }
      return statement;
    };
    assert.equal(h.read().events[0].payload.result, 'old');
  } finally { h.db.prepare = original; writer.close(); }
  assert.equal(intercepted, true); assert.equal(h.db.prepare, original);
  assert.equal(h.read().events[0].payload.result, 'new');
});
