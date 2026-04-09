const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { migrateChatSchema, migrateRunSchema, migrateSkillTestSchema } = require('../../build/storage/sqlite/migrations');
const { createSkillTestController } = require('../../build/server/api/skill-test-controller');

function createTestDb(databasePath = ':memory:') {
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  migrateChatSchema(db);
  migrateRunSchema(db);
  migrateSkillTestSchema(db);
  return db;
}

function createInMemoryStore(db, options = {}) {
  return {
    db,
    agentDir: options.agentDir || '/tmp/agent-test',
    databasePath: options.databasePath || ':memory:',
  };
}

function createTempHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-skill-test-'));
  const databasePath = path.join(tempDir, 'skill-test.sqlite');
  const db = createTestDb(databasePath);
  return {
    db,
    tempDir,
    databasePath,
    cleanup() {
      try {
        db.close();
      } catch {
        // ignore cleanup errors
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function createFakeAgentToolBridge() {
  return {
    createInvocationContext(ctx) {
      return ctx;
    },
    registerInvocation() {
      return { invocationId: 'inv-1', callbackToken: 'token-1' };
    },
    unregisterInvocation() {},
  };
}

function createFakeSkillRegistry(existingSkills = []) {
  const skillMap = new Map();
  for (const entry of existingSkills) {
    if (typeof entry === 'string') {
      skillMap.set(entry, {
        id: entry,
        name: entry,
        description: '',
        path: `/tmp/skills/${entry}`,
      });
      continue;
    }
    if (entry && entry.id) {
      skillMap.set(entry.id, {
        id: entry.id,
        name: entry.name || entry.id,
        description: entry.description || '',
        body: entry.body || '',
        path: entry.path || `/tmp/skills/${entry.id}`,
      });
    }
  }
  return {
    getSkill(skillId) {
      return skillMap.get(skillId) || null;
    },
  };
}

function createJsonRequest(method, urlPath, body) {
  return {
    method,
    url: urlPath,
    headers: { 'content-type': 'application/json' },
    setEncoding() {
      // request-body helper calls this on IncomingMessage; no-op is enough here
    },
    on(event, cb) {
      if (event !== 'data' && event !== 'end') return;
      if (event === 'data') {
        cb(Buffer.from(JSON.stringify(body ?? {}), 'utf8'));
      }
      if (event === 'end') {
        cb();
      }
    },
  };
}

function createRawJsonRequest(method, urlPath, rawBody) {
  return {
    method,
    url: urlPath,
    headers: { 'content-type': 'application/json' },
    setEncoding() {
      // request-body helper calls this on IncomingMessage; no-op is enough here
    },
    resume() {
      // request-body helper may call this on oversized bodies; no-op is enough here
    },
    on(event, cb) {
      if (event !== 'data' && event !== 'end') return;
      if (event === 'data' && rawBody != null) {
        cb(Buffer.from(String(rawBody), 'utf8'));
      }
      if (event === 'end') {
        cb();
      }
    },
  };
}

function createCaptureResponse() {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      if (headers && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
          this.setHeader(key, value);
        }
      }
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    end(chunk) {
      if (chunk != null) this.write(chunk);
      this.bodyText = Buffer.concat(chunks).toString('utf8');
      this.finished = true;
    },
    get json() {
      try {
        return JSON.parse(this.bodyText || 'null');
      } catch {
        return null;
      }
    },
  };
}

test('generate creates AI draft cases without smoke validation and uses selected model', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  let capturedProvider = '';
  let capturedModel = '';
  let capturedPrompt = '';

  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry([
      {
        id: 'werewolf',
        name: '狼人杀 Skill',
        description: '用于后端全自动主持的狼人杀玩法。',
        body: '需要先 `read /tmp/skills/werewolf/SKILL.md` 读取狼人杀玩法说明，再按玩家身份行动。',
      },
    ]),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
    startRunImpl: (provider, model, prompt) => {
      capturedProvider = provider;
      capturedModel = model;
      capturedPrompt = prompt;
      return {
        runId: 'run-1',
        sessionPath: '/tmp/session',
        resultPromise: Promise.resolve({
          reply: JSON.stringify([
            { triggerPrompt: '我们来玩狼人杀吧', note: 'direct' },
            { triggerPrompt: '今晚想开狼人杀房间，你来带我入局', expectedBehavior: '应该加载狼人杀 skill', note: 'indirect' },
          ]),
          runId: 'run-1',
          sessionPath: '/tmp/session',
        }),
      };
    },
  });

  const req = createJsonRequest('POST', '/api/skills/werewolf/test-cases/generate', {
    count: 2,
    loadingMode: 'dynamic',
    testType: 'trigger',
    provider: 'openai',
    model: 'gpt-4.1',
  });
  const res = createCaptureResponse();

  const handled = await controller({
    req,
    res,
    pathname: '/api/skills/werewolf/test-cases/generate',
    requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/generate'),
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.ok(res.json);
  assert.equal(capturedProvider, 'openai');
  assert.equal(capturedModel, 'gpt-4.1');
  assert.match(capturedPrompt, /Mode: dynamic/);
  assert.match(capturedPrompt, /userPrompt/);
  assert.ok(Array.isArray(res.json.cases));
  assert.equal(res.json.cases.length, 2);

  const caseStatuses = new Set(res.json.cases.map((c) => c.caseStatus));
  assert.deepEqual([...caseStatuses], ['draft']);
  assert.equal(Number(res.json.draftCount || 0), res.json.cases.length);
  assert.ok(!Object.prototype.hasOwnProperty.call(res.json, 'smokeRuns'));
  assert.ok(res.json.cases.every((testCase) => Array.isArray(testCase.expectedTools) && testCase.expectedTools[0] && testCase.expectedTools[0].name === 'read'));
  assert.ok(res.json.cases.every((testCase) => testCase.userPrompt === testCase.triggerPrompt));
  assert.ok(res.json.cases.every((testCase) => testCase.generationProvider === 'openai'));
  assert.ok(res.json.cases.every((testCase) => testCase.generationModel === 'gpt-4.1'));
  assert.ok(res.json.cases.every((testCase) => typeof testCase.generationCreatedAt === 'string' && testCase.generationCreatedAt.length > 0));

  const rows = db
    .prepare('SELECT trigger_prompt, validity_status, case_status, generation_provider, generation_model, generation_created_at FROM skill_test_cases WHERE skill_id = ?')
    .all('werewolf');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.case_status === 'draft'));
  assert.ok(rows.every((row) => row.validity_status === 'pending'));
  assert.ok(rows.every((row) => row.generation_provider === 'openai'));
  assert.ok(rows.every((row) => row.generation_model === 'gpt-4.1'));
  assert.ok(rows.every((row) => typeof row.generation_created_at === 'string' && row.generation_created_at.length > 0));

  db.close();
});

test('legacy case migration adds case_status without backfilling from validity_status', () => {
  const db = new Database(':memory:');
  const now = new Date().toISOString();

  db.exec(`
CREATE TABLE skill_test_cases (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  eval_case_id TEXT,
  test_type TEXT NOT NULL DEFAULT 'trigger',
  loading_mode TEXT NOT NULL DEFAULT 'dynamic',
  trigger_prompt TEXT NOT NULL,
  expected_tools_json TEXT NOT NULL DEFAULT '[]',
  expected_behavior TEXT NOT NULL DEFAULT '',
  validity_status TEXT NOT NULL DEFAULT 'pending',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE skill_test_runs (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  eval_case_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  actual_tools_json TEXT NOT NULL DEFAULT '[]',
  tool_accuracy REAL,
  trigger_passed INTEGER,
  execution_passed INTEGER,
  error_message TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (test_case_id) REFERENCES skill_test_cases(id)
);
  `);

  const insert = db.prepare(`
    INSERT INTO skill_test_cases (
      id, skill_id, test_type, loading_mode, trigger_prompt,
      expected_tools_json, expected_behavior, validity_status, note, created_at, updated_at
    ) VALUES (
      @id, @skillId, 'trigger', 'dynamic', @triggerPrompt,
      '[]', '', @validityStatus, '', @createdAt, @updatedAt
    )
  `);

  insert.run({
    id: 'legacy-ready',
    skillId: 'werewolf',
    triggerPrompt: 'legacy validated case',
    validityStatus: 'validated',
    createdAt: now,
    updatedAt: now,
  });
  insert.run({
    id: 'legacy-invalid',
    skillId: 'werewolf',
    triggerPrompt: 'legacy invalid case',
    validityStatus: 'invalid',
    createdAt: now,
    updatedAt: now,
  });
  insert.run({
    id: 'legacy-draft',
    skillId: 'werewolf',
    triggerPrompt: 'legacy pending case',
    validityStatus: 'pending',
    createdAt: now,
    updatedAt: now,
  });

  migrateSkillTestSchema(db);

  const rows = db
    .prepare('SELECT id, case_status FROM skill_test_cases ORDER BY id ASC')
    .all();

  assert.deepEqual(rows, [
    { id: 'legacy-draft', case_status: 'draft' },
    { id: 'legacy-invalid', case_status: 'draft' },
    { id: 'legacy-ready', case_status: 'draft' },
  ]);

  db.close();
});

test('run endpoint bootstraps dependent schemas for fresh skill-test databases', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-skill-test-fresh-schema-'));
  const databasePath = path.join(tempDir, 'skill-test.sqlite');
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  migrateSkillTestSchema(db);

  try {
    const store = createInMemoryStore(db, {
      agentDir: path.join(tempDir, 'agent'),
      databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry(['werewolf']),
      getProjectDir: () => tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => ({
        runId: 'run-fresh-schema',
        sessionPath: path.join(tempDir, 'session-fresh-schema.jsonl'),
        resultPromise: Promise.resolve({
          reply: 'ok',
          runId: 'run-fresh-schema',
          sessionPath: path.join(tempDir, 'session-fresh-schema.jsonl'),
        }),
      }),
      evaluateRunImpl: () => ({
        triggerPassed: 1,
        executionPassed: 1,
        toolAccuracy: 1,
        actualToolsJson: JSON.stringify(['read']),
      }),
    });

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status,
        expected_goal, expected_sequence_json, evaluation_rubric_json,
        note, created_at, updated_at
      ) VALUES (
        @id, @skillId, 'trigger', 'dynamic', @triggerPrompt,
        '[]', '', 'ready', 'ready',
        '', '[]', '{}',
        '', @createdAt, @updatedAt
      )`
    ).run({
      id: 'fresh-schema-case',
      skillId: 'werewolf',
      triggerPrompt: 'run me on a fresh database',
      createdAt: now,
      updatedAt: now,
    });

    const runRes = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/fresh-schema-case/run', {}),
      res: runRes,
      pathname: '/api/skills/werewolf/test-cases/fresh-schema-case/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/fresh-schema-case/run'),
    });

    assert.equal(handled, true);
    assert.equal(runRes.statusCode, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM eval_cases').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM eval_case_runs').get().count, 1);
  } finally {
    try {
      db.close();
    } catch {
      // ignore cleanup errors
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('run endpoint reuses the main in-memory db for tool-call telemetry', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-skill-test-in-memory-run-'));
  const db = createTestDb();
  let invocationContext = null;

  try {
    const store = createInMemoryStore(db, {
      agentDir: path.join(tempDir, 'agent'),
      databasePath: ':memory:',
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: {
        createInvocationContext(ctx) {
          return ctx;
        },
        registerInvocation(ctx) {
          invocationContext = ctx;
          return { invocationId: 'inv-memory-run', callbackToken: 'token-memory-run' };
        },
        unregisterInvocation() {},
      },
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          path: '/tmp/skills/werewolf',
        },
      ]),
      getProjectDir: () => tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: (_provider, _model, _prompt, runOptions = {}) => {
        assert.ok(invocationContext);
        invocationContext.runStore.appendTaskEvent(runOptions.taskId, 'agent_tool_call', {
          tool: 'read',
          request: { path: '/tmp/skills/werewolf/SKILL.md' },
          status: 'succeeded',
        });
        return {
          runId: null,
          sessionPath: '',
          resultPromise: Promise.resolve({ reply: 'ok' }),
        };
      },
    });

    const createRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        testType: 'execution',
        loadingMode: 'dynamic',
        triggerPrompt: '先读取狼人杀 skill 说明。',
        expectedTools: ['read'],
        expectedBehavior: '应该读取目标 SKILL.md。',
      }),
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {}),
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(runRes.json.run.executionPassed, true);
    assert.equal(runRes.json.run.toolAccuracy, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM a2a_task_events').get().count, 1);
  } finally {
    try {
      db.close();
    } catch {
      // ignore cleanup errors
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('legacy validity_status rows stay draft in list, summary, and run-all', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);

  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['werewolf']),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
    startRunImpl: () => ({
      runId: 'run-legacy-ready',
      sessionPath: '/tmp/session-legacy-ready',
      resultPromise: Promise.resolve({ reply: 'ok', runId: 'run-legacy-ready', sessionPath: '/tmp/session-legacy-ready' }),
    }),
    evaluateRunImpl: () => ({
      triggerPassed: 1,
      executionPassed: 1,
      toolAccuracy: 1,
      actualToolsJson: JSON.stringify(['read']),
    }),
  });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skill_test_cases (
      id, skill_id, test_type, loading_mode, trigger_prompt,
      expected_tools_json, expected_behavior, validity_status, case_status,
      expected_goal, expected_sequence_json, evaluation_rubric_json,
      note, created_at, updated_at
    ) VALUES (
      @id, @skillId, 'trigger', 'dynamic', @triggerPrompt,
      '[]', '', @validityStatus, @caseStatus,
      '', '[]', '{}',
      '', @createdAt, @updatedAt
    )`
  ).run({
    id: 'legacy-ready-row',
    skillId: 'werewolf',
    triggerPrompt: 'legacy validated case still marked draft after migration',
    validityStatus: 'validated',
    caseStatus: 'draft',
    createdAt: now,
    updatedAt: now,
  });

  const listRes = createCaptureResponse();
  const listHandled = await controller({
    req: createJsonRequest('GET', '/api/skills/werewolf/test-cases'),
    res: listRes,
    pathname: '/api/skills/werewolf/test-cases',
    requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
  });

  assert.equal(listHandled, true);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.json.cases.length, 1);
  assert.equal(listRes.json.cases[0].caseStatus, 'draft');

  const summaryRes = createCaptureResponse();
  const summaryHandled = await controller({
    req: createJsonRequest('GET', '/api/skill-test-summary'),
    res: summaryRes,
    pathname: '/api/skill-test-summary',
    requestUrl: new URL('http://localhost/api/skill-test-summary'),
  });

  assert.equal(summaryHandled, true);
  assert.equal(summaryRes.statusCode, 200);
  const summaryEntry = summaryRes.json.summary.find((entry) => entry.skillId === 'werewolf');
  assert.ok(summaryEntry);
  assert.equal(summaryEntry.casesByStatus.draft, 1);
  assert.equal(summaryEntry.casesByStatus.ready || 0, 0);

  await assert.rejects(
    () => controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/run-all', {}),
      res: createCaptureResponse(),
      pathname: '/api/skills/werewolf/test-cases/run-all',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/run-all'),
    }),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.message, 'No test cases to run');
      return true;
    }
  );

  db.close();
});

test('skill test summary counts distinct cases and averages metrics across status buckets', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['werewolf']),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  const baseTime = Date.now();
  const caseStmt = db.prepare(
    `INSERT INTO skill_test_cases (
      id, skill_id, test_type, loading_mode, trigger_prompt,
      expected_tools_json, expected_behavior, validity_status, case_status,
      expected_goal, expected_sequence_json, evaluation_rubric_json,
      note, created_at, updated_at
    ) VALUES (
      @id, @skillId, 'trigger', 'dynamic', @triggerPrompt,
      '[]', '', 'pending', @caseStatus,
      '', '[]', '{}',
      '', @createdAt, @updatedAt
    )`
  );
  caseStmt.run({
    id: 'summary-draft-case',
    skillId: 'werewolf',
    triggerPrompt: 'draft summary case',
    caseStatus: 'draft',
    createdAt: new Date(baseTime).toISOString(),
    updatedAt: new Date(baseTime).toISOString(),
  });
  caseStmt.run({
    id: 'summary-ready-case',
    skillId: 'werewolf',
    triggerPrompt: 'ready summary case',
    caseStatus: 'ready',
    createdAt: new Date(baseTime + 1000).toISOString(),
    updatedAt: new Date(baseTime + 1000).toISOString(),
  });

  const runStmt = db.prepare(
    `INSERT INTO skill_test_runs (
      id, test_case_id, status, actual_tools_json,
      tool_accuracy, trigger_passed, execution_passed,
      required_step_completion_rate, step_completion_rate,
      tool_call_success_rate, goal_achievement,
      evaluation_json, created_at
    ) VALUES (
      @id, @testCaseId, 'succeeded', '[]',
      @toolAccuracy, @triggerPassed, @executionPassed,
      @requiredStepCompletionRate, @stepCompletionRate,
      @toolCallSuccessRate, @goalAchievement,
      '{}', @createdAt
    )`
  );
  runStmt.run({
    id: 'summary-run-1',
    testCaseId: 'summary-draft-case',
    toolAccuracy: 0.2,
    triggerPassed: 1,
    executionPassed: 0,
    requiredStepCompletionRate: 0.3,
    stepCompletionRate: 0.4,
    toolCallSuccessRate: 0.6,
    goalAchievement: 0.5,
    createdAt: new Date(baseTime + 2000).toISOString(),
  });
  runStmt.run({
    id: 'summary-run-2',
    testCaseId: 'summary-draft-case',
    toolAccuracy: 0.4,
    triggerPassed: 0,
    executionPassed: 1,
    requiredStepCompletionRate: 0.5,
    stepCompletionRate: 0.6,
    toolCallSuccessRate: 0.8,
    goalAchievement: 0.7,
    createdAt: new Date(baseTime + 3000).toISOString(),
  });
  runStmt.run({
    id: 'summary-run-3',
    testCaseId: 'summary-ready-case',
    toolAccuracy: 1,
    triggerPassed: 1,
    executionPassed: 1,
    requiredStepCompletionRate: 0.9,
    stepCompletionRate: 0.8,
    toolCallSuccessRate: 0.6,
    goalAchievement: 0.7,
    createdAt: new Date(baseTime + 4000).toISOString(),
  });

  const summaryRes = createCaptureResponse();
  await controller({
    req: createJsonRequest('GET', '/api/skill-test-summary'),
    res: summaryRes,
    pathname: '/api/skill-test-summary',
    requestUrl: new URL('http://localhost/api/skill-test-summary'),
  });

  assert.equal(summaryRes.statusCode, 200);
  const summaryEntry = summaryRes.json.summary.find((entry) => entry.skillId === 'werewolf');
  assert.ok(summaryEntry);
  assert.equal(summaryEntry.casesByStatus.draft, 1);
  assert.equal(summaryEntry.casesByStatus.ready, 1);
  assert.equal(summaryEntry.totalCases, 2);
  assert.equal(summaryEntry.totalRuns, 3);

  const assertApprox = (actual, expected) => {
    assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} ≈ ${expected}`);
  };

  assertApprox(summaryEntry.avgToolAccuracy, (0.2 + 0.4 + 1) / 3);
  assertApprox(summaryEntry.avgRequiredStepCompletionRate, (0.3 + 0.5 + 0.9) / 3);
  assertApprox(summaryEntry.avgStepCompletionRate, (0.4 + 0.6 + 0.8) / 3);
  assertApprox(summaryEntry.avgGoalAchievement, (0.5 + 0.7 + 0.7) / 3);
  assertApprox(summaryEntry.avgToolCallSuccessRate, (0.6 + 0.8 + 0.6) / 3);

  db.close();
});

test('patch test-case propagates invalid JSON body errors', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['werewolf']),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skill_test_cases (
      id, skill_id, test_type, loading_mode, trigger_prompt,
      expected_tools_json, expected_behavior, validity_status, case_status,
      expected_goal, expected_sequence_json, evaluation_rubric_json,
      note, created_at, updated_at
    ) VALUES (
      @id, @skillId, 'trigger', 'dynamic', @triggerPrompt,
      '[]', '', 'pending', 'draft',
      '', '[]', '{}',
      '', @createdAt, @updatedAt
    )`
  ).run({
    id: 'invalid-json-patch-case',
    skillId: 'werewolf',
    triggerPrompt: 'patch me',
    createdAt: now,
    updatedAt: now,
  });

  await assert.rejects(
    () => controller({
      req: createRawJsonRequest('PATCH', '/api/skills/werewolf/test-cases/invalid-json-patch-case', '{"note":'),
      res: createCaptureResponse(),
      pathname: '/api/skills/werewolf/test-cases/invalid-json-patch-case',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/invalid-json-patch-case'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, 'Invalid JSON body');
      return true;
    }
  );

  db.close();
});

test('generate test-cases propagates invalid JSON body errors', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['werewolf']),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  await assert.rejects(
    () => controller({
      req: createRawJsonRequest('POST', '/api/skills/werewolf/test-cases/generate', '{"count":'),
      res: createCaptureResponse(),
      pathname: '/api/skills/werewolf/test-cases/generate',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/generate'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, 'Invalid JSON body');
      return true;
    }
  );

  db.close();
});

test('run endpoints propagate invalid JSON body errors', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['werewolf']),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skill_test_cases (
      id, skill_id, test_type, loading_mode, trigger_prompt,
      expected_tools_json, expected_behavior, validity_status, case_status,
      expected_goal, expected_sequence_json, evaluation_rubric_json,
      note, created_at, updated_at
    ) VALUES (
      @id, @skillId, 'trigger', 'dynamic', @triggerPrompt,
      '[]', '', 'ready', 'ready',
      '', '[]', '{}',
      '', @createdAt, @updatedAt
    )`
  ).run({
    id: 'invalid-json-run-case',
    skillId: 'werewolf',
    triggerPrompt: 'run me',
    createdAt: now,
    updatedAt: now,
  });

  await assert.rejects(
    () => controller({
      req: createRawJsonRequest('POST', '/api/skills/werewolf/test-cases/run-all', '{"provider":'),
      res: createCaptureResponse(),
      pathname: '/api/skills/werewolf/test-cases/run-all',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/run-all'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, 'Invalid JSON body');
      return true;
    }
  );

  await assert.rejects(
    () => controller({
      req: createRawJsonRequest('POST', '/api/skills/werewolf/test-cases/invalid-json-run-case/run', '{"provider":'),
      res: createCaptureResponse(),
      pathname: '/api/skills/werewolf/test-cases/invalid-json-run-case/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/invalid-json-run-case/run'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, 'Invalid JSON body');
      return true;
    }
  );

  db.close();
});

test('generate preserves requested loadingMode and testType for AI full drafts', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  let capturedPrompt = '';

  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry([
      {
        id: 'werewolf',
        name: '狼人杀 Skill',
        description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家。',
        body: '当进入房间后，只能扮演玩家，并可使用 `send-public` 发言。',
      },
    ]),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
    startRunImpl: (_provider, _model, prompt) => {
      capturedPrompt = prompt;
      return {
        runId: 'run-full-generate',
        sessionPath: '/tmp/session-generate',
        resultPromise: Promise.resolve({
          reply: JSON.stringify([
            {
              userPrompt: '进入狼人杀房间后只扮演玩家并发一次言',
              triggerPrompt: '进入狼人杀房间后只扮演玩家并发一次言',
              expectedTools: [
                {
                  name: 'send-public',
                  order: 1,
                  requiredParams: ['content'],
                  arguments: { content: '<string>' },
                },
              ],
              expectedGoal: '以玩家身份加入流程并至少完成一次公开发言。',
              expectedSteps: [
                {
                  id: 'step-1',
                  title: 'Public message',
                  expectedBehavior: 'Call send-public to produce one public reply.',
                  required: true,
                  order: 1,
                  strongSignals: [{ type: 'tool', toolName: 'send-public' }],
                },
              ],
              expectedSequence: [{ name: 'send-public', order: 1 }],
              evaluationRubric: { thresholds: { goalAchievement: 0.8 } },
              note: 'full ai draft',
            },
          ]),
          runId: 'run-full-generate',
          sessionPath: '/tmp/session-generate',
        }),
      };
    },
  });

  const req = createJsonRequest('POST', '/api/skills/werewolf/test-cases/generate', {
    count: 1,
    loadingMode: 'full',
    testType: 'execution',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
  });
  const res = createCaptureResponse();

  const handled = await controller({
    req,
    res,
    pathname: '/api/skills/werewolf/test-cases/generate',
    requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/generate'),
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.match(capturedPrompt, /Mode: full/);
  assert.match(capturedPrompt, /userPrompt/);
  assert.ok(Array.isArray(res.json.cases));
  assert.equal(res.json.cases.length, 1);
  assert.ok(res.json.cases.every((testCase) => testCase.loadingMode === 'full'));
  assert.ok(res.json.cases.every((testCase) => testCase.testType === 'execution'));
  assert.equal(res.json.cases[0].expectedGoal, '以玩家身份加入流程并至少完成一次公开发言。');
  assert.equal(res.json.cases[0].userPrompt, '进入狼人杀房间后只扮演玩家并发一次言');
  assert.equal(res.json.cases[0].generationProvider, 'anthropic');
  assert.equal(res.json.cases[0].generationModel, 'claude-sonnet-4');
  assert.ok(typeof res.json.cases[0].generationCreatedAt === 'string' && res.json.cases[0].generationCreatedAt.length > 0);
  assert.equal(res.json.cases[0].expectedSteps.length, 1);
  assert.equal(res.json.cases[0].expectedSteps[0].title, 'Public message');
  assert.equal(res.json.cases[0].expectedSequence.length, 1);
  assert.equal(res.json.cases[0].expectedSequence[0], 'step-1');
  assert.equal(res.json.cases[0].evaluationRubric.thresholds.goalAchievement, 0.8);

  const rows = db
    .prepare('SELECT loading_mode, test_type, expected_goal, expected_steps_json, expected_sequence_json, generation_provider, generation_model, generation_created_at FROM skill_test_cases WHERE skill_id = ?')
    .all('werewolf');
  assert.equal(rows.length, 1);
  assert.ok(rows.every((row) => row.loading_mode === 'full'));
  assert.ok(rows.every((row) => row.test_type === 'execution'));
  assert.equal(rows[0].expected_goal, '以玩家身份加入流程并至少完成一次公开发言。');
  assert.equal(rows[0].generation_provider, 'anthropic');
  assert.equal(rows[0].generation_model, 'claude-sonnet-4');
  assert.ok(typeof rows[0].generation_created_at === 'string' && rows[0].generation_created_at.length > 0);
  const storedSteps = JSON.parse(rows[0].expected_steps_json || '[]');
  assert.equal(storedSteps.length, 1);
  assert.equal(storedSteps[0].title, 'Public message');
  const storedSequence = JSON.parse(rows[0].expected_sequence_json || '[]');
  assert.deepEqual(storedSequence, ['step-1']);

  db.close();
});

test('full mode run can pass trigger via assistant behavior cues', async () => {
  const harness = createTempHarness();
  const reply = '请切换到单独的狼人杀玩法房间，我在房间内只扮演玩家。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: (_provider, _model, prompt) => {
        if (/严格的 Skill 执行评审器/.test(prompt)) {
          const judgeReply = JSON.stringify({
            goalAchievement: { score: 0.88, reason: '完成了玩家视角回应。' },
            instructionAdherence: { score: 0.9, reason: '遵循了玩家角色限制。' },
            summary: '步骤顺序和目标达成均符合预期。',
            verdictSuggestion: 'pass',
            steps: [
              {
                stepId: 'legacy-step-1',
                completed: true,
                confidence: 0.93,
                evidenceIds: ['tool-call-1'],
                matchedSignalIds: ['sig-legacy-step-1-read'],
                reason: '先调用了 read。',
              },
              {
                stepId: 'legacy-step-2',
                completed: true,
                confidence: 0.92,
                evidenceIds: ['tool-call-2'],
                matchedSignalIds: ['sig-legacy-step-2-bash'],
                reason: '随后调用了 bash。',
              },
              {
                stepId: 'legacy-step-behavior',
                completed: true,
                confidence: 0.8,
                evidenceIds: ['msg-1'],
                matchedSignalIds: [],
                reason: '整体行为符合预期。',
              },
            ],
            constraintChecks: [],
            missedExpectations: [],
          });
          return {
            runId: null,
            sessionPath: path.join(harness.tempDir, `execution-judge-${Date.now()}.jsonl`),
            resultPromise: Promise.resolve({ reply: judgeReply }),
          };
        }
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: reply }],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'trigger',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedBehavior: '遇到这类请求时，应该提示去单独的狼人杀房间，并在房间里只扮演玩家。',
      note: 'manual full-mode trigger case',
    });
    const createRes = createCaptureResponse();

    const created = await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    assert.equal(created, true);
    assert.equal(createRes.statusCode, 201);
    assert.equal(createRes.json.testCase.loadingMode, 'full');

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();

    const handledRun = await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(handledRun, true);
    assert.equal(runRes.statusCode, 200);
    assert.ok(runRes.json.run);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.ok(['pass', 'borderline', 'fail'].includes(runRes.json.run.verdict));

    const row = harness.db
      .prepare('SELECT trigger_passed, execution_passed FROM skill_test_runs ORDER BY created_at DESC LIMIT 1')
      .get();
    assert.equal(row.trigger_passed, 1);
    assert.equal(row.execution_passed, runRes.json.run.verdict === 'pass' ? 1 : 0);
  } finally {
    harness.cleanup();
  }
});

test('full mode run can pass trigger via AI judge when heuristic signals are inconclusive', async () => {
  const harness = createTempHarness();
  let callCount = 0;

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
          body: '进入房间后只能从玩家视角行动，不主持流程，不接管裁判职责。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: (_provider, _model, prompt) => {
        callCount += 1;
        if (callCount === 1) {
          const reply = '收到，我会作为参与者加入，但不会承担主持职责。';
          const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
          fs.writeFileSync(
            sessionPath,
            `${JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: reply }],
              },
            })}\n`,
            'utf8'
          );
          return {
            runId: null,
            sessionPath,
            resultPromise: Promise.resolve({ reply, sessionPath }),
          };
        }

        assert.match(prompt, /只返回一行 JSON/);
        const judgeReply = JSON.stringify({
          passed: true,
          confidence: 0.92,
          reason: '助手明确表示只以参与者身份加入且不承担主持职责，符合技能约束。',
          matchedBehaviors: ['只以参与者身份加入', '不承担主持职责'],
        });
        const judgeSessionPath = path.join(harness.tempDir, `judge-session-${Date.now()}.jsonl`);
        return {
          runId: null,
          sessionPath: judgeSessionPath,
          resultPromise: Promise.resolve({ reply: judgeReply, sessionPath: judgeSessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'trigger',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedBehavior: '应该保持玩家视角参与，不接管流程推进。',
      note: 'manual full-mode ai-judge case',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();

    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(runRes.json.run.verdict, 'borderline');
    assert.equal(callCount, 3);

    const detailReq = createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined);
    const detailRes = createCaptureResponse();
    await controller({
      req: detailReq,
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.result.triggerEvaluation.mode, 'full');
    assert.deepEqual(detailRes.json.result.triggerEvaluation.matchedSignals, []);
    assert.ok(detailRes.json.result.triggerEvaluation.decisionSources.includes('ai-judge'));
    assert.equal(detailRes.json.result.triggerEvaluation.aiJudge.attempted, true);
    assert.equal(detailRes.json.result.triggerEvaluation.aiJudge.passed, true);
    assert.equal(detailRes.json.result.triggerEvaluation.aiJudge.confidence, 0.92);
    assert.deepEqual(detailRes.json.result.triggerEvaluation.aiJudge.matchedBehaviors, ['只以参与者身份加入', '不承担主持职责']);
  } finally {
    harness.cleanup();
  }
});

test('full mode AI judges receive full assistant evidence without controller truncation', async () => {
  const harness = createTempHarness();
  const tailMarker = 'TAIL-END-987654321';
  const longReply = `${'evidence-line-'.repeat(220)}${tailMarker}`;
  const judgePrompts = [];

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
          body: '进入房间后只能从玩家视角行动，不主持流程，不接管裁判职责。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: (_provider, _model, prompt) => {
        if (/严格的 Skill 触发评审器/.test(prompt) || /严格的 Skill 执行评审器/.test(prompt)) {
          judgePrompts.push(prompt);
        }

        if (/严格的 Skill 触发评审器/.test(prompt)) {
          const reply = JSON.stringify({
            passed: true,
            confidence: 0.9,
            reason: '证据完整可见。',
            matchedBehaviors: ['tail-marker-visible'],
          });
          const sessionPath = path.join(harness.tempDir, `trigger-judge-${Date.now()}.jsonl`);
          return {
            runId: null,
            sessionPath,
            resultPromise: Promise.resolve({ reply, sessionPath }),
          };
        }

        if (/严格的 Skill 执行评审器/.test(prompt)) {
          const reply = JSON.stringify({
            steps: [
              {
                stepId: 'legacy-step-summary',
                completed: true,
                confidence: 0.95,
                evidenceIds: ['msg-1'],
                matchedSignalIds: [],
                reason: '证据完整可见。',
              },
            ],
            constraintChecks: [],
            goalAchievement: { score: 0.95, reason: '证据完整可见。' },
            instructionAdherence: { score: 0.95, reason: '证据完整可见。' },
            summary: '证据完整可见。',
            verdictSuggestion: 'pass',
            missedExpectations: [],
          });
          const sessionPath = path.join(harness.tempDir, `execution-judge-${Date.now()}.jsonl`);
          return {
            runId: null,
            sessionPath,
            resultPromise: Promise.resolve({ reply, sessionPath }),
          };
        }

        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: longReply }],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply: longReply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedBehavior: '应保持玩家视角，不承担主持职责。',
      note: 'judge evidence should stay full',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();

    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(judgePrompts.length, 2);
    for (const prompt of judgePrompts) {
      assert.ok(prompt.includes(tailMarker));
      assert.ok(!prompt.includes('...[truncated]'));
    }
  } finally {
    harness.cleanup();
  }
});

test('execution evaluation supports structured expectedTools parameter checks', async () => {
  const harness = createTempHarness();
  const reply = '请切换到单独的狼人杀玩法房间，我在房间内只扮演玩家。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: reply },
                { type: 'toolCall', name: 'bash', id: 'tool-1', arguments: { command: 'echo ping', timeout: 15 } },
              ],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedTools: [
        {
          name: 'bash',
          requiredParams: ['command', 'timeout'],
          arguments: { timeout: '<number>' },
        },
      ],
      expectedBehavior: '遇到这类请求时，应该提示去单独的狼人杀房间，并在房间里只扮演玩家。',
      note: 'structured expected tools pass case',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    assert.equal(createRes.statusCode, 201);
    const caseId = createRes.json.testCase.id;

    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(typeof runRes.json.run.executionPassed, 'boolean');
    assert.equal(runRes.json.run.toolAccuracy, 1);

    const detailReq = createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined);
    const detailRes = createCaptureResponse();
    await controller({
      req: detailReq,
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.result.executionEvaluation.usedParameterValidation, true);
    assert.equal(detailRes.json.result.executionEvaluation.toolChecks[0].matched, true);
    assert.equal(detailRes.json.result.executionEvaluation.toolChecks[0].parameterPassed, true);
  } finally {
    harness.cleanup();
  }
});

test('execution evaluation supports <contains:...> argument matching for generated specs', async () => {
  const harness = createTempHarness();
  const reply = '请切换到单独的狼人杀玩法房间，我在房间内只扮演玩家。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: reply },
                { type: 'toolCall', name: 'read', id: 'tool-contains-1', arguments: { path: '/tmp/project/.trellis/spec/backend/index.md' } },
              ],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedTools: [
        {
          name: 'read',
          requiredParams: ['path'],
          arguments: { path: '<contains:.trellis/spec>' },
        },
      ],
      expectedBehavior: '遇到这类请求时，应该提示去单独的狼人杀房间，并在房间里只扮演玩家。',
      note: 'contains placeholder pass case',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(typeof runRes.json.run.executionPassed, 'boolean');
    assert.equal(runRes.json.run.toolAccuracy, 1);

    const detailReq = createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined);
    const detailRes = createCaptureResponse();
    await controller({
      req: detailReq,
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.result.executionEvaluation.toolChecks[0].matched, true);
    assert.equal(detailRes.json.result.executionEvaluation.toolChecks[0].argumentShapePassed, true);
    assert.deepEqual(detailRes.json.result.executionEvaluation.toolChecks[0].actualArguments, {
      path: '/tmp/project/.trellis/spec/backend/index.md',
    });
  } finally {
    harness.cleanup();
  }
});

test('execution evaluation trims surrounding whitespace for <contains:...> argument matching', async () => {
  const harness = createTempHarness();
  const reply = '请切换到单独的狼人杀玩法房间，我在房间内只扮演玩家。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: reply },
                { type: 'toolCall', name: 'read', id: 'tool-contains-2', arguments: { path: '/tmp/project/.trellis/spec/backend/index.md' } },
              ],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedTools: [
        {
          name: 'read',
          requiredParams: ['path'],
          arguments: { path: '  <contains:.trellis/spec>  ' },
        },
      ],
      expectedBehavior: '遇到这类请求时，应该提示去单独的狼人杀房间，并在房间里只扮演玩家。',
      note: 'contains placeholder with whitespace pass case',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(typeof runRes.json.run.executionPassed, 'boolean');
    assert.equal(runRes.json.run.toolAccuracy, 1);
  } finally {
    harness.cleanup();
  }
});

test('execution evaluation normalizes slash direction for <contains:...> argument matching', async () => {
  const harness = createTempHarness();
  const reply = '请切换到单独的狼人杀玩法房间，我在房间内只扮演玩家。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: reply },
                { type: 'toolCall', name: 'read', id: 'tool-contains-slash-1', arguments: { path: 'C:\\tmp\\project\\.trellis\\spec\\backend\\index.md' } },
              ],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedTools: [
        {
          name: 'read',
          requiredParams: ['path'],
          arguments: { path: '<contains:/tmp/project/.trellis/spec/backend/index.md>' },
        },
      ],
      expectedBehavior: '遇到这类请求时，应该提示去单独的狼人杀房间，并在房间里只扮演玩家。',
      note: 'contains placeholder slash normalization pass case',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.toolAccuracy, 1);
  } finally {
    harness.cleanup();
  }
});

test('execution evaluation reports missing parameters for structured expectedTools', async () => {
  const harness = createTempHarness();
  const reply = '请切换到单独的狼人杀玩法房间，我在房间内只扮演玩家。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: reply },
                { type: 'toolCall', name: 'bash', id: 'tool-2', arguments: { command: 'echo ping' } },
              ],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedTools: [
        {
          name: 'bash',
          requiredParams: ['timeout'],
          arguments: { timeout: '<number>' },
        },
      ],
      expectedBehavior: '遇到这类请求时，应该提示去单独的狼人杀房间，并在房间里只扮演玩家。',
      note: 'structured expected tools fail case',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(runRes.json.run.executionPassed, false);
    assert.equal(runRes.json.run.toolAccuracy, 0);

    const detailReq = createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined);
    const detailRes = createCaptureResponse();
    await controller({
      req: detailReq,
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.deepEqual(detailRes.json.result.executionEvaluation.toolChecks[0].missingParams, ['timeout']);
    assert.equal(detailRes.json.result.executionEvaluation.toolChecks[0].matched, false);
    assert.equal(detailRes.json.result.executionEvaluation.toolChecks[0].parameterPassed, false);
  } finally {
    harness.cleanup();
  }
});

test('execution evaluation can enforce ordered tool sequence expectations', async () => {
  const harness = createTempHarness();
  const reply = '请切换到单独的狼人杀玩法房间，我在房间内只扮演玩家。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: reply },
                { type: 'toolCall', name: 'read', id: 'tool-seq-1', arguments: { path: '/tmp/skills/werewolf/SKILL.md' } },
                { type: 'toolCall', name: 'bash', id: 'tool-seq-2', arguments: { command: 'echo ready', timeout: 15 } },
              ],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedTools: [
        {
          name: 'read',
          order: 1,
          requiredParams: ['path'],
          arguments: { path: '<string>' },
        },
        {
          name: 'bash',
          order: 2,
          requiredParams: ['command'],
          arguments: { command: '<string>' },
        },
      ],
      expectedBehavior: '应该先读取技能材料，再继续执行后续工具调用。',
      note: 'ordered tool sequence pass case',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(typeof runRes.json.run.executionPassed, 'boolean');
    assert.equal(runRes.json.run.toolAccuracy, 1);

    const detailReq = createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined);
    const detailRes = createCaptureResponse();
    await controller({
      req: detailReq,
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.result.executionEvaluation.usedSequenceValidation, true);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.enabled, true);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.passed, true);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.matchedCount, 2);
  } finally {
    harness.cleanup();
  }
});

test('full mode sequence adherence follows ordered hits even when parameter checks fail', async () => {
  const harness = createTempHarness();
  const reply = '请切换到单独的狼人杀玩法房间，我在房间内只扮演玩家。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: reply },
                { type: 'toolCall', name: 'read', id: 'tool-seq-1', arguments: { path: '/tmp/skills/werewolf/SKILL.md' } },
                { type: 'toolCall', name: 'bash', id: 'tool-seq-2', arguments: { command: 'echo ready', timeout: 15 } },
              ],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedTools: [
        {
          name: 'read',
          order: 1,
          requiredParams: ['path'],
          arguments: { path: '/not/the/real/skill/path.md' },
        },
        {
          name: 'bash',
          order: 2,
          requiredParams: ['command'],
          arguments: { command: 'not-the-real-command' },
        },
      ],
      expectedBehavior: '应该先读取技能材料，再继续执行后续工具调用。',
      note: 'ordered sequence score should not collapse when params fail',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);

    const detailReq = createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined);
    const detailRes = createCaptureResponse();
    await controller({
      req: detailReq,
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.enabled, true);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.matchedCount, 2);
    const sequenceScore = detailRes.json.result.evaluation.dimensions.sequenceAdherence.score;
    assert.ok(sequenceScore === 1 || sequenceScore === null);
    assert.ok(typeof detailRes.json.result.evaluation.dimensions.sequenceAdherence.reason === 'string');
    assert.equal(detailRes.json.result.executionEvaluation.toolChecks[0].matched, false);
    assert.equal(detailRes.json.result.executionEvaluation.toolChecks[1].matched, false);
  } finally {
    harness.cleanup();
  }
});

test('execution evaluation fails when ordered tool sequence is out of order', async () => {
  const harness = createTempHarness();
  const reply = '请切换到单独的狼人杀玩法房间，我在房间内只扮演玩家。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: reply },
                { type: 'toolCall', name: 'bash', id: 'tool-seq-3', arguments: { command: 'echo ready', timeout: 15 } },
                { type: 'toolCall', name: 'read', id: 'tool-seq-4', arguments: { path: '/tmp/skills/werewolf/SKILL.md' } },
              ],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedTools: [
        {
          name: 'read',
          order: 1,
          requiredParams: ['path'],
          arguments: { path: '<string>' },
        },
        {
          name: 'bash',
          order: 2,
          requiredParams: ['command'],
          arguments: { command: '<string>' },
        },
      ],
      expectedBehavior: '应该先读取技能材料，再继续执行后续工具调用。',
      note: 'ordered tool sequence fail case',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(runRes.json.run.executionPassed, false);
    assert.equal(runRes.json.run.toolAccuracy, 1);

    const detailReq = createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined);
    const detailRes = createCaptureResponse();
    await controller({
      req: detailReq,
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.enabled, true);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.passed, false);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.steps[1].outOfOrder, true);
  } finally {
    harness.cleanup();
  }
});

test('execution sequence avoids combining session and event timelines', async () => {
  const harness = createTempHarness();
  const reply = '收到，我先读 skill。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: (_provider, _model, _prompt, runOptions = {}) => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: reply },
                { type: 'toolCall', name: 'read', id: 'tool-seq-mixed-1', arguments: { path: '/tmp/skills/werewolf/SKILL.md' } },
              ],
            },
          })}\n`,
          'utf8'
        );
        harness.db.prepare(
          'INSERT INTO a2a_task_events (task_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?)'
        ).run(
          runOptions.taskId,
          'agent_tool_call',
          JSON.stringify({
            tool: 'bash',
            request: { command: 'echo ready', timeout: 15 },
            status: 'succeeded',
          }),
          new Date().toISOString()
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'dynamic',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedTools: [
        {
          name: 'read',
          order: 1,
          requiredParams: ['path'],
          arguments: { path: '<string>' },
        },
        {
          name: 'bash',
          order: 2,
          requiredParams: ['command'],
          arguments: { command: '<string>' },
        },
      ],
      expectedBehavior: '应该先读取 skill，再继续执行后续工具调用。',
      note: 'mixed timeline sequence case',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(runRes.json.run.toolAccuracy, 1);
    assert.equal(runRes.json.run.executionPassed, false);

    const detailReq = createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined);
    const detailRes = createCaptureResponse();
    await controller({
      req: detailReq,
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.passed, false);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.steps[0].matched, true);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.steps[1].matched, false);
    assert.ok(!detailRes.json.result.executionEvaluation.sequenceCheck.observedTools.includes('bash'));
  } finally {
    harness.cleanup();
  }
});

test('execution evaluation normalizes participants tool alias for expected tools', async () => {
  const harness = createTempHarness();
  const reply = '我先看看当前房间里都有谁。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: (_provider, _model, _prompt, runOptions = {}) => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: reply },
                { type: 'toolCall', name: 'read', id: 'tool-participants-read', arguments: { path: '/tmp/skills/werewolf/SKILL.md' } },
              ],
            },
          })}\n`,
          'utf8'
        );
        harness.db.prepare(
          'INSERT INTO a2a_task_events (task_id, event_type, event_json, created_at) VALUES (?, ?, ?, ?)'
        ).run(
          runOptions.taskId,
          'agent_tool_call',
          JSON.stringify({
            tool: 'participants',
            request: {},
            status: 'succeeded',
          }),
          new Date().toISOString()
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'dynamic',
      triggerPrompt: '进入狼人杀房间前，先看看房间参与者。',
      expectedTools: ['list-participants'],
      expectedBehavior: '应该读取 skill 并查看当前参与者列表。',
      note: 'participants alias case',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(runRes.json.run.executionPassed, true);
    assert.equal(runRes.json.run.toolAccuracy, 1);

    const detailReq = createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined);
    const detailRes = createCaptureResponse();
    await controller({
      req: detailReq,
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.result.executionEvaluation.toolChecks[0].name, 'list-participants');
    assert.equal(detailRes.json.result.executionEvaluation.toolChecks[0].matched, true);
    assert.equal(detailRes.json.result.executionEvaluation.toolChecks[0].matchedByName, true);
  } finally {
    harness.cleanup();
  }
});

test('case regression groups runs by provider/model and promptVersion', async () => {
  const harness = createTempHarness();

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry(['werewolf']),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        return {
          runId: null,
          sessionPath: path.join(harness.tempDir, `session-${Date.now()}.jsonl`),
          resultPromise: Promise.resolve({ reply: 'ok' }),
        };
      },
      evaluateRunImpl: () => {
        return {
          triggerPassed: 1,
          executionPassed: 1,
          toolAccuracy: 1,
          actualToolsJson: JSON.stringify(['read']),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'dynamic',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedTools: ['read'],
      expectedBehavior: '应该触发狼人杀 skill 并读取 skill body',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;

    const runV1Req = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {
      provider: 'openai',
      model: 'gpt-4.1',
      promptVersion: 'skill-test-v2',
    });
    const runV1Res = createCaptureResponse();
    await controller({
      req: runV1Req,
      res: runV1Res,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    const runV2Req = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {
      provider: 'anthropic',
      model: 'claude-sonnet',
      promptVersion: 'skill-test-v3',
    });
    const runV2Res = createCaptureResponse();
    await controller({
      req: runV2Req,
      res: runV2Res,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    const regressionReq = createJsonRequest('GET', `/api/skills/werewolf/test-cases/${caseId}/regression`, undefined);
    const regressionRes = createCaptureResponse();
    const handledRegression = await controller({
      req: regressionReq,
      res: regressionRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/regression`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/regression`),
    });

    assert.equal(handledRegression, true);
    assert.equal(regressionRes.statusCode, 200);
    assert.equal(regressionRes.json.testCaseId, caseId);
    assert.equal(regressionRes.json.regression.length, 2);
    assert.deepEqual(
      regressionRes.json.regression
        .map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          promptVersion: entry.promptVersion,
          totalRuns: entry.totalRuns,
        }))
        .sort((a, b) => a.promptVersion.localeCompare(b.promptVersion)),
      [
        { provider: 'openai', model: 'gpt-4.1', promptVersion: 'skill-test-v2', totalRuns: 1 },
        { provider: 'anthropic', model: 'claude-sonnet', promptVersion: 'skill-test-v3', totalRuns: 1 },
      ]
    );

    const caseRunsReq = createJsonRequest('GET', `/api/skills/werewolf/test-cases/${caseId}/runs`, undefined);
    const caseRunsRes = createCaptureResponse();
    await controller({
      req: caseRunsReq,
      res: caseRunsRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/runs`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/runs`),
    });

    assert.equal(caseRunsRes.statusCode, 200);
    assert.equal(caseRunsRes.json.runs.length, 2);
    assert.deepEqual(
      caseRunsRes.json.runs.map((run) => run.promptVersion).sort(),
      ['skill-test-v2', 'skill-test-v3']
    );
  } finally {
    harness.cleanup();
  }
});

test('run persists effective provider/model when request uses environment defaults', async () => {
  const harness = createTempHarness();
  const originalProvider = process.env.PI_PROVIDER;
  const originalModel = process.env.PI_MODEL;
  let capturedProvider = '';
  let capturedModel = '';

  process.env.PI_PROVIDER = 'env-provider';
  process.env.PI_MODEL = 'env-model';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry(['werewolf']),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: (provider, model) => {
        capturedProvider = provider;
        capturedModel = model;
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply: 'ok', sessionPath }),
        };
      },
      evaluateRunImpl: () => ({
        triggerPassed: 1,
        executionPassed: 1,
        toolAccuracy: 1,
        actualToolsJson: JSON.stringify(['read']),
        verdict: 'pass',
        evaluation: { verdict: 'pass', summary: 'pass run' },
      }),
    });

    const createRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        testType: 'execution',
        loadingMode: 'full',
        triggerPrompt: '我们来玩狼人杀吧',
        expectedGoal: '作为玩家参与，不接管主持。',
        expectedBehavior: '应保持玩家视角，不承担主持职责。',
      }),
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {
        promptVersion: 'env-defaults',
      }),
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(capturedProvider, 'env-provider');
    assert.equal(capturedModel, 'env-model');

    const evalRunRow = harness.db
      .prepare('SELECT provider, model, prompt_version FROM eval_case_runs WHERE id = ?')
      .get(runRes.json.run.evalCaseRunId);
    assert.equal(evalRunRow.provider, 'env-provider');
    assert.equal(evalRunRow.model, 'env-model');
    assert.equal(evalRunRow.prompt_version, 'env-defaults');

    const regressionRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('GET', `/api/skills/werewolf/test-cases/${caseId}/regression`),
      res: regressionRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/regression`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/regression`),
    });

    assert.equal(regressionRes.statusCode, 200);
    assert.equal(regressionRes.json.regression.length, 1);
    assert.equal(regressionRes.json.regression[0].provider, 'env-provider');
    assert.equal(regressionRes.json.regression[0].model, 'env-model');
    assert.equal(regressionRes.json.regression[0].promptVersion, 'env-defaults');
  } finally {
    if (originalProvider === undefined) {
      delete process.env.PI_PROVIDER;
    } else {
      process.env.PI_PROVIDER = originalProvider;
    }

    if (originalModel === undefined) {
      delete process.env.PI_MODEL;
    } else {
      process.env.PI_MODEL = originalModel;
    }

    harness.cleanup();
  }
});

test('list test cases includes latestRun metadata for UI state', async () => {
  const harness = createTempHarness();

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry(['werewolf']),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        return {
          runId: 'run-latest-1',
          sessionPath: path.join(harness.tempDir, 'session-latest.jsonl'),
          resultPromise: Promise.resolve({
            reply: 'ok',
            runId: 'run-latest-1',
            sessionPath: path.join(harness.tempDir, 'session-latest.jsonl'),
          }),
        };
      },
      evaluateRunImpl: () => {
        return {
          triggerPassed: 1,
          executionPassed: 0,
          toolAccuracy: 0,
          actualToolsJson: JSON.stringify([]),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'trigger',
      loadingMode: 'dynamic',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedBehavior: '应该触发狼人杀 skill。',
    });
    const createRes = createCaptureResponse();
    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });
    assert.equal(runRes.statusCode, 200);

    const listReq = createJsonRequest('GET', '/api/skills/werewolf/test-cases', undefined);
    const listRes = createCaptureResponse();
    await controller({
      req: listReq,
      res: listRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json.cases.length, 1);
    assert.ok(listRes.json.cases[0].latestRun);
    assert.equal(listRes.json.cases[0].latestRun.id, runRes.json.run.id);
    assert.equal(typeof listRes.json.cases[0].latestRun.triggerPassed, 'boolean');
    assert.ok(Object.prototype.hasOwnProperty.call(listRes.json.cases[0].latestRun, 'executionPassed'));
    assert.ok(listRes.json.cases[0].latestRun.createdAt);
  } finally {
    harness.cleanup();
  }
});

test('dynamic trigger detection matches real skill markdown path outside /skills/ roots', async () => {
  const harness = createTempHarness();
  const externalSkillDir = path.join(harness.tempDir, 'external-skill-root', 'werewolf');
  const externalSkillFile = path.join(externalSkillDir, 'SKILL.md');
  const reply = '收到，我先读取 skill 说明。';

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。',
          path: externalSkillDir,
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: reply },
                { type: 'toolCall', name: 'read', id: 'tool-external-1', arguments: { path: externalSkillFile } },
              ],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'trigger',
      loadingMode: 'dynamic',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedBehavior: '应该读取目标 skill 的 SKILL.md。',
    });
    const createRes = createCaptureResponse();
    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(runRes.json.run.executionPassed, null);

    const detailReq = createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined);
    const detailRes = createCaptureResponse();
    await controller({
      req: detailReq,
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.result.triggerEvaluation.mode, 'dynamic');
    assert.equal(detailRes.json.result.triggerEvaluation.loaded, true);
    assert.equal(detailRes.json.result.triggerEvaluation.loadEvidence.length, 1);
    assert.equal(detailRes.json.result.triggerEvaluation.loadEvidence[0].path, externalSkillFile.replace(/\\/g, '/'));
  } finally {
    harness.cleanup();
  }
});

test('archived case keeps archived legacy validity for compatibility reads', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);

  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['werewolf']),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
    testType: 'trigger',
    loadingMode: 'dynamic',
    triggerPrompt: '我们来玩狼人杀吧',
    expectedBehavior: '应该触发狼人杀 skill。',
  });
  const createRes = createCaptureResponse();

  await controller({
    req: createReq,
    res: createRes,
    pathname: '/api/skills/werewolf/test-cases',
    requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
  });

  const caseId = createRes.json.testCase.id;
  const patchReq = createJsonRequest('PATCH', `/api/skills/werewolf/test-cases/${caseId}`, {
    caseStatus: 'archived',
  });
  const patchRes = createCaptureResponse();

  await controller({
    req: patchReq,
    res: patchRes,
    pathname: `/api/skills/werewolf/test-cases/${caseId}`,
    requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}`),
  });

  assert.equal(patchRes.statusCode, 200);
  assert.equal(patchRes.json.testCase.caseStatus, 'archived');

  const row = db
    .prepare('SELECT case_status, validity_status FROM skill_test_cases WHERE id = ?')
    .get(caseId);
  assert.equal(row.case_status, 'archived');
  assert.equal(row.validity_status, 'archived');

  db.close();
});

test('full mode can pass without expected tools when toolErrorRate is n/a', async () => {
  const harness = createTempHarness();

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
          body: '进入房间后只能从玩家视角行动，不主持流程，不接管裁判职责。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: (_provider, _model, prompt) => {
        if (/严格的 Skill 触发评审器/.test(prompt)) {
          const reply = JSON.stringify({
            passed: true,
            confidence: 0.91,
            reason: '助手明确表示仅以玩家身份参与。',
            matchedBehaviors: ['仅以玩家身份参与'],
          });
          return {
            runId: null,
            sessionPath: path.join(harness.tempDir, `trigger-judge-${Date.now()}.jsonl`),
            resultPromise: Promise.resolve({ reply }),
          };
        }

        if (/严格的 Skill 执行评审器/.test(prompt)) {
          const reply = JSON.stringify({
            steps: [
              {
                stepId: 'legacy-step-summary',
                completed: true,
                confidence: 0.93,
                evidenceIds: ['msg-1'],
                matchedSignalIds: [],
                reason: '已明确回应会按玩家身份参与。',
              },
            ],
            constraintChecks: [],
            goalAchievement: { score: 0.95, reason: '已明确回应会按玩家身份参与。' },
            instructionAdherence: { score: 0.93, reason: '没有越过 skill 的角色边界。' },
            summary: '整体执行符合预期。',
            verdictSuggestion: 'pass',
            missedExpectations: [],
          });
          return {
            runId: null,
            sessionPath: path.join(harness.tempDir, `execution-judge-${Date.now()}.jsonl`),
            resultPromise: Promise.resolve({ reply }),
          };
        }

        const reply = '收到，我会只以玩家身份参与，不承担主持职责。';
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: reply }],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedBehavior: '应保持玩家视角，不承担主持职责。',
      note: 'full mode without expected tools',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();

    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(runRes.json.run.executionPassed, true);
    assert.equal(runRes.json.run.verdict, 'pass');

    const detailReq = createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined);
    const detailRes = createCaptureResponse();
    await controller({
      req: detailReq,
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.result.evaluation.verdict, 'pass');
    assert.equal(detailRes.json.result.evaluation.dimensions.toolErrorRate.score, null);
  } finally {
    harness.cleanup();
  }
});

test('summary and regression execution metrics ignore legacy dynamic runs and use full-mode verdict pass', async () => {
  const harness = createTempHarness();
  const queuedEvaluations = [
    {
      triggerPassed: 1,
      executionPassed: 1,
      toolAccuracy: 1,
      actualToolsJson: JSON.stringify([]),
      verdict: 'pass',
      evaluation: { verdict: 'pass', summary: 'pass run' },
    },
    {
      triggerPassed: 1,
      executionPassed: 1,
      toolAccuracy: 1,
      actualToolsJson: JSON.stringify([]),
      verdict: 'fail',
      evaluation: { verdict: 'fail', summary: 'fail run' },
    },
    {
      triggerPassed: 1,
      executionPassed: null,
      toolAccuracy: null,
      actualToolsJson: JSON.stringify([]),
      verdict: '',
      evaluation: null,
    },
    {
      triggerPassed: 1,
      executionPassed: 1,
      toolAccuracy: 1,
      actualToolsJson: JSON.stringify(['read']),
      verdict: '',
      evaluation: null,
    },
  ];

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry(['werewolf']),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply: 'ok', sessionPath }),
        };
      },
      evaluateRunImpl: () => {
        const next = queuedEvaluations.shift();
        assert.ok(next);
        return next;
      },
    });

    const createFullCaseRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        testType: 'execution',
        loadingMode: 'full',
        triggerPrompt: '我们来玩狼人杀吧',
        expectedGoal: '作为玩家参与，不接管主持。',
        expectedBehavior: '应保持玩家视角，不承担主持职责。',
      }),
      res: createFullCaseRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const fullCaseId = createFullCaseRes.json.testCase.id;
    for (let index = 0; index < 2; index += 1) {
      const runRes = createCaptureResponse();
      await controller({
        req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${fullCaseId}/run`, {
          provider: 'openai',
          model: 'gpt-4.1',
          promptVersion: 'phase3',
        }),
        res: runRes,
        pathname: `/api/skills/werewolf/test-cases/${fullCaseId}/run`,
        requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${fullCaseId}/run`),
      });
      assert.equal(runRes.statusCode, 200);
    }

    const createDynamicCaseRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        testType: 'trigger',
        loadingMode: 'dynamic',
        triggerPrompt: '只要先触发技能就好。',
        expectedBehavior: '应先加载技能。',
      }),
      res: createDynamicCaseRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const dynamicCaseId = createDynamicCaseRes.json.testCase.id;
    const dynamicRunRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${dynamicCaseId}/run`, {
        provider: 'openai',
        model: 'gpt-4.1',
        promptVersion: 'phase3',
      }),
      res: dynamicRunRes,
      pathname: `/api/skills/werewolf/test-cases/${dynamicCaseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${dynamicCaseId}/run`),
    });
    assert.equal(dynamicRunRes.statusCode, 200);
    assert.equal(dynamicRunRes.json.run.executionPassed, null);

    const createLegacyExecutionCaseRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        testType: 'execution',
        loadingMode: 'dynamic',
        triggerPrompt: '先读技能，再按旧版动态执行检查来跑。',
        expectedTools: ['read'],
        expectedBehavior: '旧版 dynamic execution 个例仍会在单次 run 里保留 executionPassed。',
      }),
      res: createLegacyExecutionCaseRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const legacyExecutionCaseId = createLegacyExecutionCaseRes.json.testCase.id;
    const legacyExecutionRunRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${legacyExecutionCaseId}/run`, {
        provider: 'openai',
        model: 'gpt-4.1',
        promptVersion: 'phase3',
      }),
      res: legacyExecutionRunRes,
      pathname: `/api/skills/werewolf/test-cases/${legacyExecutionCaseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${legacyExecutionCaseId}/run`),
    });
    assert.equal(legacyExecutionRunRes.statusCode, 200);
    assert.equal(legacyExecutionRunRes.json.run.executionPassed, true);

    const summaryRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('GET', '/api/skill-test-summary'),
      res: summaryRes,
      pathname: '/api/skill-test-summary',
      requestUrl: new URL('http://localhost/api/skill-test-summary'),
    });

    assert.equal(summaryRes.statusCode, 200);
    const summaryEntry = summaryRes.json.summary.find((entry) => entry.skillId === 'werewolf');
    assert.ok(summaryEntry);
    assert.equal(summaryEntry.totalRuns, 4);
    assert.equal(summaryEntry.executionPassedCount, 1);
    assert.equal(summaryEntry.executionRate, 0.5);

    const skillRegressionRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('GET', '/api/skills/werewolf/regression'),
      res: skillRegressionRes,
      pathname: '/api/skills/werewolf/regression',
      requestUrl: new URL('http://localhost/api/skills/werewolf/regression'),
    });

    assert.equal(skillRegressionRes.statusCode, 200);
    assert.equal(skillRegressionRes.json.regression.length, 1);
    assert.equal(skillRegressionRes.json.regression[0].totalRuns, 4);
    assert.equal(skillRegressionRes.json.regression[0].executionPassedCount, 1);
    assert.equal(skillRegressionRes.json.regression[0].executionRate, 0.5);

    const caseRegressionRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('GET', `/api/skills/werewolf/test-cases/${fullCaseId}/regression`),
      res: caseRegressionRes,
      pathname: `/api/skills/werewolf/test-cases/${fullCaseId}/regression`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${fullCaseId}/regression`),
    });

    assert.equal(caseRegressionRes.statusCode, 200);
    assert.equal(caseRegressionRes.json.regression.length, 1);
    assert.equal(caseRegressionRes.json.regression[0].totalRuns, 2);
    assert.equal(caseRegressionRes.json.regression[0].executionPassedCount, 1);
    assert.equal(caseRegressionRes.json.regression[0].executionRate, 0.5);
  } finally {
    harness.cleanup();
  }
});

test('run normalization flags evaluation_projection_mismatch and uses evaluation_json as source', async () => {
  const harness = createTempHarness();

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry(['werewolf']),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `projection-mismatch-session-${Date.now()}.jsonl`);
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply: 'ok', sessionPath }),
        };
      },
      evaluateRunImpl: () => ({
        triggerPassed: 1,
        executionPassed: 1,
        toolAccuracy: 0.2,
        actualToolsJson: JSON.stringify([]),
        triggerEvaluation: null,
        executionEvaluation: null,
        requiredToolCoverage: 0.1,
        toolCallSuccessRate: 0.2,
        toolErrorRate: 0.9,
        sequenceAdherence: 0.1,
        goalAchievement: 0.2,
        instructionAdherence: 0.3,
        verdict: 'fail',
        evaluation: {
          verdict: 'pass',
          summary: 'projection mismatch test',
          dimensions: {
            requiredToolCoverage: { score: 0.95, reason: 'from evaluation_json' },
            toolCallSuccessRate: { score: 0.9, reason: 'from evaluation_json' },
            toolErrorRate: { score: 0.05, reason: 'from evaluation_json' },
            sequenceAdherence: { score: 0.88, reason: 'from evaluation_json' },
            goalAchievement: { score: 0.92, reason: 'from evaluation_json' },
            instructionAdherence: { score: 0.91, reason: 'from evaluation_json' },
          },
          validation: { issues: [] },
        },
        validationIssues: [],
      }),
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedBehavior: '应保持玩家视角，不承担主持职责。',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.verdict, 'pass');
    assert.equal(runRes.json.run.requiredToolCoverage, 0.95);
    assert.equal(runRes.json.run.toolCallSuccessRate, 0.9);
    assert.equal(runRes.json.run.toolErrorRate, 0.05);
    assert.ok(Array.isArray(runRes.json.run.validationIssues));
    assert.ok(runRes.json.run.validationIssues.some((issue) => issue.code === 'evaluation_projection_mismatch'));
    assert.ok(Array.isArray(runRes.json.run.evaluation.validation.issues));
    assert.ok(runRes.json.run.evaluation.validation.issues.some((issue) => issue.code === 'evaluation_projection_mismatch'));

    const detailRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined),
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.ok(detailRes.json.run.validationIssues.some((issue) => issue.code === 'evaluation_projection_mismatch'));
  } finally {
    harness.cleanup();
  }
});

test('run normalization flags evaluation_projection_failed when dimensions cannot be projected', async () => {
  const harness = createTempHarness();

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry(['werewolf']),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, `projection-failed-session-${Date.now()}.jsonl`);
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply: 'ok', sessionPath }),
        };
      },
      evaluateRunImpl: () => ({
        triggerPassed: 1,
        executionPassed: 1,
        toolAccuracy: 0.8,
        actualToolsJson: JSON.stringify([]),
        triggerEvaluation: null,
        executionEvaluation: null,
        requiredToolCoverage: 0.8,
        toolCallSuccessRate: 0.8,
        toolErrorRate: 0.2,
        sequenceAdherence: 0.8,
        goalAchievement: 0.8,
        instructionAdherence: 0.8,
        verdict: 'pass',
        evaluation: {
          verdict: 'pass',
          summary: 'projection failed test without dimensions',
          validation: { issues: [] },
        },
        validationIssues: [],
      }),
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'full',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedGoal: '作为玩家参与，不接管主持。',
      expectedBehavior: '应保持玩家视角，不承担主持职责。',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.verdict, 'pass');
    assert.equal(runRes.json.run.requiredToolCoverage, null);
    assert.equal(runRes.json.run.goalAchievement, null);
    assert.ok(Array.isArray(runRes.json.run.validationIssues));
    assert.ok(runRes.json.run.validationIssues.some((issue) => issue.code === 'evaluation_projection_failed'));
    assert.ok(Array.isArray(runRes.json.run.evaluation.validation.issues));
    assert.ok(runRes.json.run.evaluation.validation.issues.some((issue) => issue.code === 'evaluation_projection_failed'));
  } finally {
    harness.cleanup();
  }
});

test('failed runs preserve null triggerPassed instead of coercing to false', async () => {
  const harness = createTempHarness();

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry(['werewolf']),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => ({
        runId: null,
        sessionPath: path.join(harness.tempDir, `failed-session-${Date.now()}.jsonl`),
        resultPromise: Promise.reject(new Error('simulated run failure')),
      }),
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'trigger',
      loadingMode: 'dynamic',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedBehavior: '应该触发狼人杀 skill。',
    });
    const createRes = createCaptureResponse();

    await controller({
      req: createReq,
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runReq = createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {});
    const runRes = createCaptureResponse();
    await controller({
      req: runReq,
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.status, 'failed');
    assert.equal(runRes.json.run.triggerPassed, null);
    assert.equal(runRes.json.run.executionPassed, null);
  } finally {
    harness.cleanup();
  }
});

test('generate throws 404 when skill is missing in registry', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);

  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry([]),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  const req = createJsonRequest('POST', '/api/skills/werewolf/test-cases/generate', {
    count: 1,
    prompts: ['我们来玩狼人杀吧'],
  });
  const res = createCaptureResponse();

  await assert.rejects(
    () =>
      controller({
        req,
        res,
        pathname: '/api/skills/werewolf/test-cases/generate',
        requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/generate'),
      }),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.match(String(err.message), /Skill not found/i);
      return true;
    }
  );

  db.close();
});

test('manual create accepts userPrompt as canonical prompt and mirrors triggerPrompt', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry([]),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  const req = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
    userPrompt: '请先读取 skill 文档再继续执行。',
    loadingMode: 'dynamic',
    expectedBehavior: '应先读取目标 skill。',
    note: 'canonical prompt test',
  });
  const res = createCaptureResponse();

  const handled = await controller({
    req,
    res,
    pathname: '/api/skills/werewolf/test-cases',
    requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.testCase.userPrompt, '请先读取 skill 文档再继续执行。');
  assert.equal(res.json.testCase.triggerPrompt, '请先读取 skill 文档再继续执行。');
  assert.deepEqual(res.json.issues, []);

  const row = db.prepare('SELECT trigger_prompt FROM skill_test_cases WHERE skill_id = ?').get('werewolf');
  assert.equal(row.trigger_prompt, '请先读取 skill 文档再继续执行。');

  db.close();
});

test('manual create rejects conflicting userPrompt and triggerPrompt aliases', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry([]),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  const req = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
    userPrompt: '请读取狼人杀 skill。',
    triggerPrompt: '请读取别的 skill。',
    loadingMode: 'dynamic',
  });
  const res = createCaptureResponse();

  await assert.rejects(
    () => controller({
      req,
      res,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.issues[0].code, 'prompt_alias_conflict');
      assert.match(String(err.message), /must match after normalization/i);
      return true;
    }
  );

  db.close();
});

test('manual create rejects non-array expectedSequence and non-object evaluationRubric', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry([]),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  const badSequenceReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
    userPrompt: '请先读取狼人杀 skill 文档。',
    loadingMode: 'dynamic',
    expectedSequence: { name: 'read' },
  });

  await assert.rejects(
    () => controller({
      req: badSequenceReq,
      res: createCaptureResponse(),
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.issues[0].code, 'expected_sequence_invalid');
      return true;
    }
  );

  const badRubricReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
    userPrompt: '请先读取狼人杀 skill 文档。',
    loadingMode: 'dynamic',
    evaluationRubric: [],
  });

  await assert.rejects(
    () => controller({
      req: badRubricReq,
      res: createCaptureResponse(),
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.issues[0].code, 'evaluation_rubric_invalid');
      return true;
    }
  );

  db.close();
});

test('manual create rejects full case missing expectedGoal', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry([]),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  const req = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
    userPrompt: '进入房间后请只以玩家身份参与狼人杀。',
    loadingMode: 'full',
    expectedBehavior: '先确认规则，再以玩家身份发言。',
    expectedGoal: '',
    expectedSteps: [
      {
        id: 'step-1',
        title: '确认规则',
        expectedBehavior: '先确认规则约束后再继续发言。',
        required: true,
        failureIfMissing: '未先确认规则。',
        strongSignals: [],
      },
    ],
  });

  await assert.rejects(
    () => controller({
      req,
      res: createCaptureResponse(),
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.issues[0].code, 'expected_goal_required');
      return true;
    }
  );

  db.close();
});

test('run preflight rejects stored invalid expectedSequence schema with structured issues', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  let startRunCalled = false;
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['werewolf']),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
    startRunImpl: () => {
      startRunCalled = true;
      return {
        runId: null,
        sessionPath: '/tmp/never-called.jsonl',
        resultPromise: Promise.resolve({ reply: '', sessionPath: '/tmp/never-called.jsonl' }),
      };
    },
  });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skill_test_cases (
      id, skill_id, test_type, loading_mode, trigger_prompt,
      expected_tools_json, expected_behavior, validity_status, case_status,
      expected_goal, expected_sequence_json, evaluation_rubric_json,
      note, created_at, updated_at
    ) VALUES (
      @id, @skillId, @testType, @loadingMode, @triggerPrompt,
      @expectedToolsJson, @expectedBehavior, @validityStatus, @caseStatus,
      @expectedGoal, @expectedSequenceJson, @evaluationRubricJson,
      @note, @createdAt, @updatedAt
    )`
  ).run({
    id: 'case-invalid-sequence',
    skillId: 'werewolf',
    testType: 'execution',
    loadingMode: 'full',
    triggerPrompt: '请只以玩家身份参与狼人杀。',
    expectedToolsJson: '[]',
    expectedBehavior: '只能以玩家身份参与。',
    validityStatus: 'pending',
    caseStatus: 'draft',
    expectedGoal: '完成玩家视角回应。',
    expectedSequenceJson: '{"name":"send-public"}',
    evaluationRubricJson: '{}',
    note: 'broken expectedSequence schema',
    createdAt: now,
    updatedAt: now,
  });

  await assert.rejects(
    () => controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/case-invalid-sequence/run', {}),
      res: createCaptureResponse(),
      pathname: '/api/skills/werewolf/test-cases/case-invalid-sequence/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/case-invalid-sequence/run'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.caseSchemaStatus, 'invalid');
      assert.equal(err.derivedFromLegacy, false);
      assert.ok(Array.isArray(err.issues));
      assert.ok(err.issues.some((issue) => issue.code === 'case_schema_invalid'));
      assert.ok(err.issues.some((issue) => issue.code === 'expected_sequence_invalid'));
      return true;
    }
  );

  assert.equal(startRunCalled, false);
  db.close();
});

test('case reads expose schema validation metadata and mark-ready rejects invalid stored schema', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['werewolf']),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skill_test_cases (
      id, skill_id, test_type, loading_mode, trigger_prompt,
      expected_tools_json, expected_behavior, validity_status, case_status,
      expected_goal, expected_sequence_json, evaluation_rubric_json,
      note, created_at, updated_at
    ) VALUES (
      @id, @skillId, @testType, @loadingMode, @triggerPrompt,
      @expectedToolsJson, @expectedBehavior, @validityStatus, @caseStatus,
      @expectedGoal, @expectedSequenceJson, @evaluationRubricJson,
      @note, @createdAt, @updatedAt
    )`
  ).run({
    id: 'case-invalid-ready',
    skillId: 'werewolf',
    testType: 'execution',
    loadingMode: 'full',
    triggerPrompt: '请只以玩家身份参与狼人杀。',
    expectedToolsJson: '[]',
    expectedBehavior: '只能以玩家身份参与。',
    validityStatus: 'pending',
    caseStatus: 'draft',
    expectedGoal: '完成玩家视角回应。',
    expectedSequenceJson: '{"name":"send-public"}',
    evaluationRubricJson: '{}',
    note: 'broken expectedSequence schema for ready gate',
    createdAt: now,
    updatedAt: now,
  });

  const listRes = createCaptureResponse();
  await controller({
    req: createJsonRequest('GET', '/api/skills/werewolf/test-cases', undefined),
    res: listRes,
    pathname: '/api/skills/werewolf/test-cases',
    requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
  });

  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.json.cases.length, 1);
  assert.equal(listRes.json.cases[0].validation.caseSchemaStatus, 'invalid');
  assert.equal(listRes.json.cases[0].validation.derivedFromLegacy, false);
  assert.ok(listRes.json.cases[0].validation.issues.some((issue) => issue.code === 'expected_sequence_invalid'));

  const getRes = createCaptureResponse();
  await controller({
    req: createJsonRequest('GET', '/api/skills/werewolf/test-cases/case-invalid-ready', undefined),
    res: getRes,
    pathname: '/api/skills/werewolf/test-cases/case-invalid-ready',
    requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/case-invalid-ready'),
  });

  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.json.testCase.validation.caseSchemaStatus, 'invalid');
  assert.ok(getRes.json.testCase.validation.issues.some((issue) => issue.code === 'expected_sequence_invalid'));

  await assert.rejects(
    () => controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/case-invalid-ready/mark-ready', {}),
      res: createCaptureResponse(),
      pathname: '/api/skills/werewolf/test-cases/case-invalid-ready/mark-ready',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/case-invalid-ready/mark-ready'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.caseSchemaStatus, 'invalid');
      assert.equal(err.derivedFromLegacy, false);
      assert.ok(Array.isArray(err.issues));
      assert.ok(err.issues.some((issue) => issue.code === 'case_schema_invalid'));
      assert.ok(err.issues.some((issue) => issue.code === 'expected_sequence_invalid'));
      return true;
    }
  );

  db.close();
});

test('skill-scoped case routes reject case ids from another skill', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['werewolf', 'undercover']),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
  });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skill_test_cases (
      id, skill_id, test_type, loading_mode, trigger_prompt,
      expected_tools_json, expected_behavior, validity_status, case_status,
      expected_goal, expected_sequence_json, evaluation_rubric_json,
      note, created_at, updated_at
    ) VALUES (
      @id, @skillId, 'trigger', 'dynamic', @triggerPrompt,
      '[]', '', 'pending', 'draft',
      '', '[]', '{}',
      '', @createdAt, @updatedAt
    )`
  ).run({
    id: 'cross-skill-case',
    skillId: 'werewolf',
    triggerPrompt: 'cross skill ownership case',
    createdAt: now,
    updatedAt: now,
  });

  db.prepare(
    `INSERT INTO skill_test_runs (
      id, test_case_id, status, actual_tools_json, evaluation_json, created_at
    ) VALUES (
      @id, @testCaseId, 'succeeded', '[]', '{}', @createdAt
    )`
  ).run({
    id: 'cross-skill-run',
    testCaseId: 'cross-skill-case',
    createdAt: now,
  });

  await assert.rejects(
    () => controller({
      req: createJsonRequest('GET', '/api/skills/undercover/test-cases/cross-skill-case'),
      res: createCaptureResponse(),
      pathname: '/api/skills/undercover/test-cases/cross-skill-case',
      requestUrl: new URL('http://localhost/api/skills/undercover/test-cases/cross-skill-case'),
    }),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.message, 'Test case not found');
      return true;
    }
  );

  await assert.rejects(
    () => controller({
      req: createJsonRequest('DELETE', '/api/skills/undercover/test-cases/cross-skill-case'),
      res: createCaptureResponse(),
      pathname: '/api/skills/undercover/test-cases/cross-skill-case',
      requestUrl: new URL('http://localhost/api/skills/undercover/test-cases/cross-skill-case'),
    }),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.message, 'Test case not found');
      return true;
    }
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM skill_test_cases WHERE id = ?').get('cross-skill-case').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM skill_test_runs WHERE test_case_id = ?').get('cross-skill-case').count, 1);

  const deleteRes = createCaptureResponse();
  await controller({
    req: createJsonRequest('DELETE', '/api/skills/werewolf/test-cases/cross-skill-case'),
    res: deleteRes,
    pathname: '/api/skills/werewolf/test-cases/cross-skill-case',
    requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/cross-skill-case'),
  });

  assert.equal(deleteRes.statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM skill_test_cases WHERE id = ?').get('cross-skill-case').count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM skill_test_runs WHERE test_case_id = ?').get('cross-skill-case').count, 0);

  db.close();
});

test('full mode run marks critical sequence evidence gaps as borderline needs-review', async () => {
  const harness = createTempHarness();

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
          body: '进入房间后只能从玩家视角行动，不主持流程，不接管裁判职责。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: (_provider, _model, prompt) => {
        if (/严格的 Skill 触发评审器/.test(prompt)) {
          const reply = JSON.stringify({
            passed: true,
            confidence: 0.9,
            reason: '助手明确表示只会按玩家身份参与。',
            matchedBehaviors: ['只按玩家身份参与'],
          });
          return {
            runId: null,
            sessionPath: path.join(harness.tempDir, `trigger-judge-${Date.now()}.jsonl`),
            resultPromise: Promise.resolve({ reply }),
          };
        }

        if (/严格的 Skill 执行评审器/.test(prompt)) {
          const reply = JSON.stringify({
            steps: [
              {
                stepId: 'step-1',
                completed: true,
                confidence: 0.9,
                evidenceIds: ['msg-1'],
                matchedSignalIds: [],
                reason: '关键步骤已完成。',
              },
            ],
            constraintChecks: [],
            goalAchievement: { score: 0.92, reason: '目标基本达成。' },
            instructionAdherence: { score: 0.9, reason: '行为符合玩家视角。' },
            summary: '整体输出符合预期。',
            verdictSuggestion: 'pass',
            missedExpectations: [],
          });
          return {
            runId: null,
            sessionPath: path.join(harness.tempDir, `execution-judge-${Date.now()}.jsonl`),
            resultPromise: Promise.resolve({ reply }),
          };
        }

        const reply = '收到，我会只以玩家身份参与，不承担主持职责。';
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: reply }],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createRes = createCaptureResponse();
    const created = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        testType: 'execution',
        loadingMode: 'full',
        userPrompt: '进入房间后请只以玩家身份参与。',
        expectedBehavior: '只按玩家身份回应，不主持流程。',
        expectedGoal: '完成玩家视角回应。',
        expectedSteps: [
          {
            id: 'step-1',
            title: '确认规则',
            expectedBehavior: '继续前先确认规则。',
            required: true,
            order: 1,
            failureIfMissing: '未先确认规则。',
            strongSignals: [],
          },
        ],
        expectedSequence: ['step-1'],
        evaluationRubric: {
          criticalDimensions: ['sequenceAdherence'],
        },
        note: 'critical sequence evidence unavailable regression',
      }),
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    assert.equal(created, true);
    const caseId = createRes.json.testCase.id;

    const runRes = createCaptureResponse();
    const runHandled = await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {}),
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runHandled, true);
    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.verdict, 'borderline');
    assert.ok(Array.isArray(runRes.json.issues));
    assert.ok(runRes.json.issues.some((issue) => issue.code === 'critical_sequence_evidence_unavailable'));
    assert.ok(Array.isArray(runRes.json.run.evaluation.validation.issues));
    assert.ok(runRes.json.run.evaluation.validation.issues.some((issue) => issue.code === 'critical_sequence_evidence_unavailable'));
  } finally {
    harness.cleanup();
  }
});

test('full mode run surfaces judge_parse_failed issues in response and run detail', async () => {
  const harness = createTempHarness();

  try {
    const store = createInMemoryStore(harness.db, {
      agentDir: path.join(harness.tempDir, 'agent'),
      databasePath: harness.databasePath,
    });

    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: '狼人杀 Skill',
          description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
          body: '进入房间后只能从玩家视角行动，不主持流程，不接管裁判职责。',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: (_provider, _model, prompt) => {
        if (/严格的 Skill 触发评审器/.test(prompt)) {
          const reply = JSON.stringify({
            passed: true,
            confidence: 0.9,
            reason: '助手明确表示只会按玩家身份参与。',
            matchedBehaviors: ['只按玩家身份参与'],
          });
          return {
            runId: null,
            sessionPath: path.join(harness.tempDir, `trigger-judge-${Date.now()}.jsonl`),
            resultPromise: Promise.resolve({ reply }),
          };
        }

        if (/严格的 Skill 执行评审器/.test(prompt)) {
          const reply = JSON.stringify({
            steps: [
              {
                stepId: 'legacy-step-summary',
                completed: true,
                confidence: 0.91,
                evidenceIds: ['msg-1'],
                matchedSignalIds: [],
                reason: '该字段仅用于触发 score 越界 parse_failed。',
              },
            ],
            constraintChecks: [],
            goalAchievement: { score: 1.2, reason: '越界分数，应触发 parse_failed。' },
            instructionAdherence: { score: 0.91, reason: '其他字段仍然合法。' },
            summary: '这条 judge 回包故意带坏分数。',
            verdictSuggestion: 'pass',
            missedExpectations: [],
          });
          return {
            runId: null,
            sessionPath: path.join(harness.tempDir, `execution-judge-${Date.now()}.jsonl`),
            resultPromise: Promise.resolve({ reply }),
          };
        }

        const reply = '收到，我会只以玩家身份参与，不承担主持职责。';
        const sessionPath = path.join(harness.tempDir, `session-${Date.now()}.jsonl`);
        fs.writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: reply }],
            },
          })}\n`,
          'utf8'
        );
        return {
          runId: null,
          sessionPath,
          resultPromise: Promise.resolve({ reply, sessionPath }),
        };
      },
    });

    const createRes = createCaptureResponse();
    const created = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        testType: 'execution',
        loadingMode: 'full',
        userPrompt: '进入房间后请只以玩家身份参与。',
        expectedBehavior: '只按玩家身份回应，不主持流程。',
        expectedGoal: '完成玩家视角回应。',
        note: 'judge parse failure regression',
      }),
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    assert.equal(created, true);
    const caseId = createRes.json.testCase.id;

    const runRes = createCaptureResponse();
    const runHandled = await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {}),
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runHandled, true);
    assert.equal(runRes.statusCode, 200);
    assert.ok(Array.isArray(runRes.json.issues));
    assert.ok(runRes.json.issues.some((issue) => issue.code === 'judge_parse_failed'));
    assert.equal(runRes.json.run.verdict, 'borderline');

    const detailRes = createCaptureResponse();
    const detailHandled = await controller({
      req: createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, null),
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailHandled, true);
    assert.equal(detailRes.statusCode, 200);
    assert.ok(detailRes.json.result.validation);
    assert.ok(Array.isArray(detailRes.json.result.validation.issues));
    assert.ok(detailRes.json.result.validation.issues.some((issue) => issue.code === 'judge_parse_failed'));
    assert.equal(detailRes.json.run.evaluation.validation.issues[0].code, 'judge_parse_failed');
  } finally {
    harness.cleanup();
  }
});
