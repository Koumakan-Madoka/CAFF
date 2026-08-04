const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');

// Removal guards for the Skill Tests module.
// Part 1: Structural source-regex guards verify wiring is removed (fast, no build).
// Part 2: Real behavioral guards use build artifacts (SQLite + HTTP) to verify
//          runtime behavior, not just source text.

const ROOT = path.resolve(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ─── Part 1: Structural source-regex guards ─────────────────

test('create-server no longer wires Skill Tests / eval-cases controllers or open-sandbox factory', () => {
  const src = readSrc('server/app/create-server.ts');
  assert.ok(!/createSkillTestController/.test(src), 'createSkillTestController wiring must be removed');
  assert.ok(!/createEvalCasesController/.test(src), 'createEvalCasesController wiring must be removed');
  assert.ok(!/createConfiguredOpenSandboxFactory/.test(src), 'createConfiguredOpenSandboxFactory wiring must be removed');
  assert.ok(!/SKILL_TEST_OPENSANDBOX_CHAT_API_URL/.test(src), 'SKILL_TEST_OPENSANDBOX_CHAT_API_URL config import must be removed');
});

test('conversations-controller no longer special-cases skill_test_design', () => {
  const src = readSrc('server/api/conversations-controller.ts');
  assert.ok(!/isSkillTestDesignConversation/.test(src), 'isSkillTestDesignConversation import/usage must be removed');
});

test('Skill Tests module files are deleted', () => {
  const mustNotExist = [
    'public/eval-cases.html',
    'public/eval-cases.js',
    'public/skill-tests.js',
    'public/chat/skill-test-design-panel.js',
    'server/api/skill-test-controller.ts',
    'server/api/eval-cases-controller.ts',
    'lib/skill-test-generator.ts',
    'lib/pi-skill-test-sandbox-extension.mjs',
    'lib/pi-skill-test-sandbox-env.mjs',
  ];
  for (const rel of mustNotExist) {
    assert.ok(!exists(rel), `${rel} must be deleted`);
  }
  assert.ok(!exists('public/skill-tests'), 'public/skill-tests/ directory must be deleted');
  assert.ok(!exists('server/domain/skill-test'), 'server/domain/skill-test/ directory must be deleted');
  assert.ok(!exists('tests/skill-test'), 'tests/skill-test/ directory must be deleted');
});

test('package.json no longer references Skill Tests scripts or opensandbox dep', () => {
  const pkg = JSON.parse(readSrc('package.json'));
  const checkScript = String(pkg.scripts.check || '');
  assert.ok(!/skill-tests/.test(checkScript), 'check script must not syntax-check skill-test files');
  assert.ok(!/eval-cases\.js/.test(checkScript), 'check script must not syntax-check eval-cases.js');
  assert.ok(!/skill-test-design-panel/.test(checkScript), 'check script must not syntax-check skill-test-design-panel.js');
  assert.ok(!pkg.scripts['opensandbox:build-runtime-image'], 'opensandbox build script must be removed');
  assert.ok(!pkg.scripts['opensandbox:build-caff-image'], 'opensandbox caff-image script must be removed');
  assert.ok(!pkg.dependencies || !pkg.dependencies.opensandbox, 'opensandbox dependency must be removed');
});

test('no destructive migration drops Skill Test / eval-case data', () => {
  const src = readSrc('storage/sqlite/migrations.ts');
  assert.ok(!/DROP\s+TABLE[^;]*skill_test/i.test(src), 'must not DROP TABLE skill_test_*');
  assert.ok(!/DROP\s+TABLE[^;]*eval_case/i.test(src), 'must not DROP TABLE eval_case*');
});

test('normal chat surfaces are intact (regression guard)', () => {
  const app = readSrc('public/app.js');
  assert.ok(/renderConversationPane/.test(app), 'renderConversationPane must remain in app.js');
  assert.ok(/renderConversationList/.test(app), 'renderConversationList must remain in app.js');
  const idx = readSrc('public/index.html');
  assert.ok(/\/chat\/conversation-pane\.js/.test(idx), 'conversation-pane.js script must remain loaded');
  assert.ok(/\/chat\/conversation-list\.js/.test(idx), 'conversation-list.js script must remain loaded');
});

test('skill-test-design-workbench skill is deleted', () => {
  assert.ok(!exists('.agents/skills/skill-test-design-workbench/SKILL.md'), 'skill-test-design-workbench SKILL.md must be deleted');
});

// ─── Part 2: Real behavioral guards (SQLite + HTTP) ──────────
// These use build/ artifacts. The test:fast script runs `npm run build`
// before invoking this file, so compiled modules are available.

function createTestDb() {
  const betterSqlite3 = require('better-sqlite3');
  const { migrateChatSchema } = require('../../build/storage/sqlite/migrations');
  const db = betterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateChatSchema(db);
  return db;
}

function insertLegacySkillTestDesignData(db) {
  const ts = '2026-01-01T00:00:00.000Z';

  db.prepare(`
    INSERT INTO modes (id, name, description, builtin, skill_ids_json, loading_strategy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('skill_test_design', 'Skill Test Design', 'Legacy builtin mode', 1, '["skill-test-design-workbench"]', 'full', ts, ts);

  db.prepare(`
    INSERT INTO chat_agents (id, name, persona_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('st-agent-1', 'Test Agent', 'Test persona', ts, ts);

  db.prepare(`
    INSERT INTO chat_conversations (id, title, type, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('st-conv-1', 'Skill Test Conversation', 'skill_test_design', '{"custom":"meta"}', ts, ts);

  db.prepare(`
    INSERT INTO chat_conversation_agents (conversation_id, agent_id, conversation_skills_json, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('st-conv-1', 'st-agent-1', JSON.stringify(['skill-test-design-workbench', 'other-skill']), 0, ts);

  db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, turn_id, role, agent_id, sender_name, content, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('st-msg-1', 'st-conv-1', 'st-turn-1', 'user', null, 'User', 'Hello skill test', 'completed', ts);

  db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, turn_id, role, agent_id, sender_name, content, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('st-msg-2', 'st-conv-1', 'st-turn-1', 'assistant', 'st-agent-1', 'Test Agent', 'Hi there', 'completed', ts);
}

function insertNormalConversationWithWorkbenchBinding(db) {
  const ts = '2026-01-01T00:00:00.000Z';

  db.prepare(`
    INSERT INTO chat_agents (id, name, persona_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('normal-agent-1', 'Normal Agent', 'Normal persona', ts, ts);

  db.prepare(`
    INSERT INTO chat_conversations (id, title, type, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('normal-conv-1', 'Normal Chat', 'standard', '{"key":"val"}', ts, ts);

  db.prepare(`
    INSERT INTO chat_conversation_agents (conversation_id, agent_id, conversation_skills_json, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('normal-conv-1', 'normal-agent-1', JSON.stringify(['skill-test-design-workbench', 'start', 'other-skill']), 0, ts);
}

function insertLegacySkillTestTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_cases (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS skill_test_cases (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      eval_case_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.prepare('INSERT INTO eval_cases (id, title) VALUES (?, ?)').run('ec-1', 'Legacy eval case');
  db.prepare('INSERT INTO skill_test_cases (id, skill_id, eval_case_id) VALUES (?, ?, ?)').run('stc-1', 'test-skill', 'ec-1');
}

test('fresh DB does not create skill_test or eval_case tables (real SQLite)', () => {
  const db = createTestDb();
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);

    const skillTestTables = tables.filter((name) => /skill_test/i.test(name));
    const evalCaseTables = tables.filter((name) => /eval_case/i.test(name));

    assert.deepEqual(skillTestTables, [], 'no skill_test tables must exist on fresh DB');
    assert.deepEqual(evalCaseTables, [], 'no eval_case tables must exist on fresh DB');
  } finally {
    db.close();
  }
});

test('retireSkillTestDesignMode preserves legacy conversation data (real SQLite)', () => {
  const db = createTestDb();

  insertLegacySkillTestDesignData(db);

  const { ModeStore } = require('../../build/lib/mode-store');
  const store = new ModeStore(db);

  const mode = store.get('skill_test_design');
  assert.equal(mode, null, 'builtin skill_test_design mode must be deleted after construction');

  const conversation = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get('st-conv-1');
  assert.ok(conversation, 'legacy conversation must not be deleted');
  assert.equal(conversation.type, 'skill_test_design', 'conversation type must be preserved');
  assert.equal(conversation.title, 'Skill Test Conversation', 'conversation title must be preserved');
  assert.deepEqual(JSON.parse(conversation.metadata_json), { custom: 'meta' }, 'conversation metadata must be preserved');

  const messages = db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id').all('st-conv-1');
  assert.equal(messages.length, 2, 'all legacy messages must be preserved');
  assert.equal(messages[0].content, 'Hello skill test');
  assert.equal(messages[1].content, 'Hi there');

  const participant = db.prepare(`
    SELECT conversation_skills_json
    FROM chat_conversation_agents
    WHERE conversation_id = ? AND agent_id = ?
  `).get('st-conv-1', 'st-agent-1');
  const skills = JSON.parse(participant.conversation_skills_json);
  assert.ok(!skills.includes('skill-test-design-workbench'), 'workbench skill must be removed from participants');
  assert.ok(skills.includes('other-skill'), 'non-workbench skills must be preserved');

  db.close();
});

test('retireSkillTestDesignMode removes workbench binding from normal conversations (real SQLite)', () => {
  const db = createTestDb();

  insertLegacySkillTestDesignData(db);
  insertNormalConversationWithWorkbenchBinding(db);

  const { ModeStore } = require('../../build/lib/mode-store');
  new ModeStore(db);

  const participant = db.prepare(`
    SELECT conversation_skills_json
    FROM chat_conversation_agents
    WHERE conversation_id = ? AND agent_id = ?
  `).get('normal-conv-1', 'normal-agent-1');
  const skills = JSON.parse(participant.conversation_skills_json);
  assert.ok(!skills.includes('skill-test-design-workbench'), 'workbench skill must be removed from normal conversation participants');
  assert.ok(skills.includes('start'), 'non-workbench skills must be preserved in normal conversations');
  assert.ok(skills.includes('other-skill'), 'other skills must be preserved');

  db.close();
});

test('retireSkillTestDesignMode cleans ghost bindings even when builtin mode row is absent (real SQLite)', () => {
  const db = createTestDb();

  insertNormalConversationWithWorkbenchBinding(db);

  const { ModeStore } = require('../../build/lib/mode-store');
  new ModeStore(db);

  const participant = db.prepare(`
    SELECT conversation_skills_json
    FROM chat_conversation_agents
    WHERE conversation_id = ? AND agent_id = ?
  `).get('normal-conv-1', 'normal-agent-1');
  const skills = JSON.parse(participant.conversation_skills_json);
  assert.ok(!skills.includes('skill-test-design-workbench'), 'ghost binding must be removed even without builtin mode row');

  db.close();
});

test('retireSkillTestDesignMode is idempotent (real SQLite)', () => {
  const db = createTestDb();

  insertLegacySkillTestDesignData(db);

  const { ModeStore } = require('../../build/lib/mode-store');
  const store = new ModeStore(db);

  const conversationBefore = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get('st-conv-1');
  const participantBefore = db.prepare(`
    SELECT conversation_skills_json FROM chat_conversation_agents
    WHERE conversation_id = ? AND agent_id = ?
  `).get('st-conv-1', 'st-agent-1');

  assert.doesNotThrow(() => store.retireSkillTestDesignMode(), 'second retirement call must not throw');

  const conversationAfter = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get('st-conv-1');
  const participantAfter = db.prepare(`
    SELECT conversation_skills_json FROM chat_conversation_agents
    WHERE conversation_id = ? AND agent_id = ?
  `).get('st-conv-1', 'st-agent-1');

  assert.deepEqual(conversationAfter, conversationBefore, 'conversation data must be unchanged by idempotent re-run');
  assert.equal(participantAfter.conversation_skills_json, participantBefore.conversation_skills_json, 'participant skills must be unchanged by idempotent re-run');

  db.close();
});

test('retireSkillTestDesignMode preserves user-created custom mode with same id across reconstruction (real SQLite)', () => {
  const db = createTestDb();

  const { ModeStore } = require('../../build/lib/mode-store');
  const store = new ModeStore(db);

  store.save({ id: 'skill_test_design', name: 'User Custom ST', skillIds: ['start'] });

  const store2 = new ModeStore(db);

  const mode = store2.get('skill_test_design');
  assert.ok(mode, 'user-created custom mode with id=skill_test_design must survive reconstruction');
  assert.equal(mode.builtin, false, 'surviving mode must be the user-created custom, not builtin');
  assert.equal(mode.name, 'User Custom ST');

  db.close();
});

test('legacy eval_cases and skill_test_cases tables and rows are preserved after migration (real SQLite)', () => {
  const db = createTestDb();

  insertLegacySkillTestTables(db);

  const { migrateChatSchema } = require('../../build/storage/sqlite/migrations');
  migrateChatSchema(db);

  const evalCases = db.prepare('SELECT * FROM eval_cases').all();
  assert.equal(evalCases.length, 1, 'legacy eval_cases rows must be preserved');
  assert.equal(evalCases[0].id, 'ec-1');
  assert.equal(evalCases[0].title, 'Legacy eval case');

  const skillTestCases = db.prepare('SELECT * FROM skill_test_cases').all();
  assert.equal(skillTestCases.length, 1, 'legacy skill_test_cases rows must be preserved');
  assert.equal(skillTestCases[0].id, 'stc-1');
  assert.equal(skillTestCases[0].skill_id, 'test-skill');

  db.close();
});

// ─── HTTP behavioral guard ───────────────────────────────────

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForServer(baseUrl, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'Server did not respond';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);
      if (response.ok) {
        return;
      }
      lastError = `Unexpected status: ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(lastError);
}

test('removed API routes return 404 via real HTTP', async (t) => {
  const { createServerApp } = require('../../build/server/app/create-server');
  const { withTempDir } = require('../helpers/temp-dir');

  const tempDir = withTempDir('caff-removal-http-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const port = await findFreePort();

  const app = createServerApp({
    host: '127.0.0.1',
    port,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    try {
      await new Promise((resolve) => app.close(resolve));
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  await new Promise((resolve) => app.start(resolve));
  await waitForServer(baseUrl);

  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
  assert.ok(bootstrapResponse.ok, 'active /api/bootstrap route must still work (sanity check)');

  const retiredRoutes = [
    { path: '/api/eval-cases', method: 'GET' },
    { path: '/api/skill-test-summary', method: 'GET' },
    { path: '/api/skill-test-runs/test-run-1', method: 'GET' },
    { path: '/api/skills/test-skill/test-cases', method: 'GET' },
    { path: '/api/agent-tools/sandbox/access', method: 'POST' },
    { path: '/api/agent-tools/sandbox/read', method: 'POST' },
    { path: '/api/agent-tools/sandbox/write', method: 'POST' },
    { path: '/api/agent-tools/sandbox/mkdir', method: 'POST' },
    { path: '/api/agent-tools/sandbox/bash', method: 'POST' },
  ];

  for (const route of retiredRoutes) {
    const response = await fetch(`${baseUrl}${route.path}`, { method: route.method });
    assert.equal(
      response.status,
      404,
      `${route.method} ${route.path} must return 404 after Skill Tests removal`,
    );
  }
});
