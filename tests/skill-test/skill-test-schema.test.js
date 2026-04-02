const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

// Test migration and basic CRUD operations for skill_test schema
const { migrateSkillTestSchema } = require('../../build/storage/sqlite/migrations');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  migrateSkillTestSchema(db);
  return db;
}

// ---- Schema migration ----

test('migrateSkillTestSchema creates tables without error', () => {
  const db = createTestDb();

  // Verify tables exist
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'skill_test%'")
    .all()
    .map((r) => r.name);

  assert.ok(tables.includes('skill_test_cases'), 'skill_test_cases table should exist');
  assert.ok(tables.includes('skill_test_runs'), 'skill_test_runs table should exist');

  db.close();
});

test('migrateSkillTestSchema is idempotent', () => {
  const db = createTestDb();
  // Run migration again — should not throw
  assert.doesNotThrow(() => migrateSkillTestSchema(db));
  db.close();
});

// ---- skill_test_cases CRUD ----

test('can insert and read a skill_test_case', () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO skill_test_cases (
      id, skill_id, test_type, loading_mode, trigger_prompt,
      expected_tools_json, expected_behavior, validity_status, note,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'tc-001', 'werewolf', 'trigger', 'dynamic', '我们来狼人杀吧',
    '["read-skill"]', 'Agent should trigger werewolf skill', 'pending', 'Auto-generated',
    now, now
  );

  const row = db.prepare('SELECT * FROM skill_test_cases WHERE id = ?').get('tc-001');
  assert.ok(row);
  assert.equal(row.skill_id, 'werewolf');
  assert.equal(row.test_type, 'trigger');
  assert.equal(row.loading_mode, 'dynamic');
  assert.equal(row.trigger_prompt, '我们来狼人杀吧');
  assert.equal(row.validity_status, 'pending');

  db.close();
});

test('can insert and read a skill_test_run', () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  // Create a test case first
  db.prepare(`
    INSERT INTO skill_test_cases (id, skill_id, test_type, loading_mode, trigger_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('tc-002', 'werewolf', 'trigger', 'dynamic', 'test prompt', now, now);

  // Create a test run
  db.prepare(`
    INSERT INTO skill_test_runs (
      id, test_case_id, status, actual_tools_json, tool_accuracy,
      trigger_passed, execution_passed, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'tr-001', 'tc-002', 'succeeded', '["read-skill","send-public"]', 0.8,
    1, 1, '', now
  );

  const row = db.prepare('SELECT * FROM skill_test_runs WHERE id = ?').get('tr-001');
  assert.ok(row);
  assert.equal(row.test_case_id, 'tc-002');
  assert.equal(row.status, 'succeeded');
  assert.equal(row.trigger_passed, 1);
  assert.equal(row.execution_passed, 1);
  assert.ok(Math.abs(row.tool_accuracy - 0.8) < 0.001);

  db.close();
});

test('execution_passed supports NULL (three-state)', () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO skill_test_cases (id, skill_id, test_type, loading_mode, trigger_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('tc-003', 'werewolf', 'trigger', 'dynamic', 'test', now, now);

  // Run with trigger_failed — execution_passed should be NULL
  db.prepare(`
    INSERT INTO skill_test_runs (
      id, test_case_id, status, actual_tools_json, trigger_passed, execution_passed, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tr-002', 'tc-003', 'succeeded', '[]', 0, null, '', now);

  const row = db.prepare('SELECT * FROM skill_test_runs WHERE id = ?').get('tr-002');
  assert.equal(row.trigger_passed, 0);
  assert.equal(row.execution_passed, null);

  db.close();
});

test('validity_status transitions work correctly', () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO skill_test_cases (id, skill_id, test_type, loading_mode, trigger_prompt, validity_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tc-004', 'werewolf', 'trigger', 'dynamic', 'test', 'pending', now, now);

  // Transition: pending → validated
  db.prepare("UPDATE skill_test_cases SET validity_status = 'validated', updated_at = ? WHERE id = ?")
    .run(now, 'tc-004');

  let row = db.prepare('SELECT validity_status FROM skill_test_cases WHERE id = ?').get('tc-004');
  assert.equal(row.validity_status, 'validated');

  // Transition: pending → needs_review
  db.prepare(`
    INSERT INTO skill_test_cases (id, skill_id, test_type, loading_mode, trigger_prompt, validity_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tc-005', 'werewolf', 'trigger', 'dynamic', 'test', 'pending', now, now);

  db.prepare("UPDATE skill_test_cases SET validity_status = 'needs_review', updated_at = ? WHERE id = ?")
    .run(now, 'tc-005');

  row = db.prepare('SELECT validity_status FROM skill_test_cases WHERE id = ?').get('tc-005');
  assert.equal(row.validity_status, 'needs_review');

  db.close();
});

// ---- Index verification ----

test('indexes are created correctly', () => {
  const db = createTestDb();

  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_skill_test%'")
    .all()
    .map((r) => r.name);

  assert.ok(indexes.includes('idx_skill_test_cases_skill_id'));
  assert.ok(indexes.includes('idx_skill_test_cases_validity'));
  assert.ok(indexes.includes('idx_skill_test_runs_case_id'));

  db.close();
});
