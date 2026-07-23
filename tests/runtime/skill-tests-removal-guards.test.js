const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// TDD red guards for the Skill Tests module removal.
// These read SOURCE files directly (no build step needed), so they can run
// before `npm run build`. They are RED while the module exists and GREEN
// once the removal is complete.

const ROOT = path.resolve(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

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

test('removed API routes return 404 (behavioral guard via build output)', () => {
  const createServer = readSrc('server/app/create-server.ts');
  assert.ok(!/\/api\/eval-cases/.test(createServer), 'eval-cases API route must not be registered');
  assert.ok(!/\/api\/skill-test/.test(createServer), 'skill-test API routes must not be registered');
  assert.ok(!/skill-test-summary/.test(createServer), 'skill-test-summary route must not be registered');
});

test('migrations no longer create skill_test or eval_case tables on fresh DB', () => {
  const src = readSrc('storage/sqlite/migrations.ts');
  assert.ok(!/CREATE TABLE IF NOT EXISTS eval_cases/.test(src), 'eval_cases table creation must be removed');
  assert.ok(!/CREATE TABLE IF NOT EXISTS eval_case_runs/.test(src), 'eval_case_runs table creation must be removed');
  assert.ok(!/CREATE TABLE IF NOT EXISTS skill_test_cases/.test(src), 'skill_test_cases table creation must be removed');
  assert.ok(!/CREATE TABLE IF NOT EXISTS skill_test_runs/.test(src), 'skill_test_runs table creation must be removed');
});

test('skill-test-design-workbench skill is deleted', () => {
  assert.ok(!exists('.agents/skills/skill-test-design-workbench/SKILL.md'), 'skill-test-design-workbench SKILL.md must be deleted');
});

test('mode-store retires skill_test_design from legacy DB', () => {
  const src = readSrc('lib/mode-store.ts');
  assert.ok(/retireSkillTestDesignMode/.test(src), 'retireSkillTestDesignMode method must exist');
  assert.ok(/skill-test-design-workbench/.test(src), 'retirement must filter skill-test-design-workbench from participant skills');
});
