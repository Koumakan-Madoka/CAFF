const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { migrateChatSchema } = require('../../build/storage/sqlite/migrations');
const { ModeStore } = require('../../build/lib/mode-store');

function createStore() {
  const db = new Database(':memory:');
  migrateChatSchema(db);
  return { db, store: new ModeStore(db) };
}

test('ModeStore seeds only the generic collaboration Mode', () => {
  const { db, store } = createStore();
  try {
    assert.deepEqual(store.list().map((mode) => mode.id), ['standard']);
    assert.equal(store.get('standard').builtin, true);
    assert.equal(store.get('werewolf'), null);
    assert.equal(store.get('who_is_undercover'), null);
    assert.equal(store.get('skill_test_design'), null);
  } finally { db.close(); }
});

test('ModeStore preserves custom Skill-backed Modes', () => {
  const { db, store } = createStore();
  try {
    const saved = store.save({ id: 'architecture-review', name: 'Architecture review', skillIds: ['review', 'review'] });
    assert.equal(saved.builtin, false);
    assert.ok(saved.skillIds.includes('review'));
    assert.equal(saved.skillIds.filter((id) => id === 'review').length, 1);
    store.delete('architecture-review');
    assert.equal(store.get('architecture-review'), null);
  } finally { db.close(); }
});

test('ModeStore keeps builtin Mode undeletable but configurable', () => {
  const { db, store } = createStore();
  try {
    assert.throws(() => store.delete('standard'), /cannot delete builtin/i);
    const updated = store.save({ id: 'standard', name: '协作', skillIds: ['start'], loadingStrategy: 'full' });
    assert.equal(updated.builtin, true);
    assert.equal(updated.name, '协作');
    assert.equal(updated.loadingStrategy, 'full');
    assert.ok(updated.skillIds.includes('start'));
  } finally { db.close(); }
});

test('ModeStore destructively removes legacy product Room subtrees, deliveries, and orphaned modes', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateChatSchema(db);
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO modes VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('werewolf', 'Werewolf', '', 1, '[]', 'full', ts, ts);
  const insertRoom = db.prepare(`
    INSERT INTO chat_conversations (
      id, title, type, project_scope_id, parent_conversation_id,
      origin_conversation_id, tree_depth, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRoom.run('game-root', 'Legacy game', 'werewolf', 'project-1', null, null, 0, ts, ts);
  insertRoom.run('game-child', 'Legacy child', 'standard', 'project-1', 'game-root', 'game-root', 1, ts, ts);
  insertRoom.run('game-grandchild', 'Legacy grandchild', 'standard', 'project-1', 'game-child', 'game-root', 2, ts, ts);
  insertRoom.run('orphan-game', 'Orphaned legacy game', 'who_is_undercover', 'project-1', null, null, 0, ts, ts);
  insertRoom.run('healthy-room', 'Healthy Room', 'standard', 'project-1', null, null, 0, ts, ts);
  db.prepare(`
    INSERT INTO chat_cross_conversation_deliveries (
      id, kind, idempotency_scope, idempotency_key, principal_kind,
      source_conversation_id, source_agent_name, source_project_scope_id,
      target_conversation_id, target_agent_id, target_project_scope_id,
      trace_id, root_delivery_id, hop_count, message_status, dispatch_status,
      response_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-delivery', 'notify', 'legacy-retirement', 'legacy-delivery', 'operator',
    'game-child', 'Migration', 'project-1', 'healthy-room', 'role-family-gpt', 'project-1',
    'legacy-trace', 'legacy-delivery', 0, 'pending', 'queued', 'not_expected', ts, ts
  );
  db.prepare(`
    INSERT INTO chat_cross_conversation_delivery_events (delivery_id, event_type, created_at)
    VALUES (?, ?, ?)
  `).run('legacy-delivery', 'created', ts);
  db.exec('CREATE TABLE skill_test_cases (id TEXT); CREATE TABLE eval_cases (id TEXT);');

  const store = new ModeStore(db);
  try {
    assert.equal(store.get('werewolf'), null);
    assert.equal(store.get('who_is_undercover'), null);
    assert.deepEqual(
      db.prepare('SELECT id FROM chat_conversations ORDER BY id').all().map((row) => row.id),
      ['healthy-room']
    );
    assert.equal(db.prepare('SELECT id FROM chat_cross_conversation_deliveries').get(), undefined);
    assert.equal(db.prepare('SELECT id FROM chat_cross_conversation_delivery_events').get(), undefined);
    assert.ok(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'chat_cross_delivery_events_append_only_delete'
    `).get());
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    assert.ok(!names.includes('skill_test_cases'));
    assert.ok(!names.includes('eval_cases'));
  } finally { db.close(); }
});
