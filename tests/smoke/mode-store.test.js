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

test('ModeStore destructively removes builtin legacy product Rooms and tables', () => {
  const db = new Database(':memory:');
  migrateChatSchema(db);
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO modes VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('werewolf', 'Werewolf', '', 1, '[]', 'full', ts, ts);
  db.prepare('INSERT INTO chat_conversations (id, title, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('game-1', 'Legacy game', 'werewolf', ts, ts);
  db.exec('CREATE TABLE skill_test_cases (id TEXT); CREATE TABLE eval_cases (id TEXT);');
  const store = new ModeStore(db);
  try {
    assert.equal(store.get('werewolf'), null);
    assert.equal(db.prepare('SELECT id FROM chat_conversations WHERE id = ?').get('game-1'), undefined);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    assert.ok(!names.includes('skill_test_cases'));
    assert.ok(!names.includes('eval_cases'));
  } finally { db.close(); }
});
