const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const tarStream = require('tar-stream');

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

async function createTarGzBuffer(entries = []) {
  return await new Promise((resolve, reject) => {
    const pack = tarStream.pack();
    const gzip = zlib.createGzip();
    const chunks = [];

    gzip.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);
    pack.on('error', reject);
    pack.pipe(gzip);

    const writeNext = (index) => {
      if (index >= entries.length) {
        pack.finalize();
        return;
      }
      const entry = entries[index] || {};
      const entryType = entry.type || 'file';
      const entryBody = entryType === 'file' ? Buffer.from(entry.content || '') : undefined;
      pack.entry({
        name: String(entry.name || '').trim(),
        type: entryType,
        mode: Number.isInteger(entry.mode) ? entry.mode : 0o644,
        linkname: entry.linkname || undefined,
      }, entryBody, (error) => {
        if (error) {
          reject(error);
          return;
        }
        writeNext(index + 1);
      });
    };

    writeNext(0);
  });
}

function createSandboxToolAdapterStub(options = {}) {
  const stdout = String(options.stdout || '/case/project\n');
  const stderr = String(options.stderr || '');
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : 0;
  const fileContent = Buffer.isBuffer(options.fileContent)
    ? options.fileContent
    : Buffer.from(String(options.fileContent || '# sandbox skill\n'), 'utf8');

  return {
    async access() {},
    async readFile() {
      return fileContent;
    },
    async writeFile(hostPath, content) {
      fs.mkdirSync(path.dirname(hostPath), { recursive: true });
      fs.writeFileSync(hostPath, content == null ? '' : content);
    },
    async mkdir(hostPath) {
      fs.mkdirSync(hostPath, { recursive: true });
    },
    async runCommand() {
      return {
        stdout,
        stderr,
        exitCode,
      };
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

test('isolated run keeps tool-call telemetry inside the case store and persists debug snapshot', async () => {
  const harness = createTempHarness();
  let invocationContext = null;

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const now = new Date().toISOString();
    harness.db.prepare(`
      INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status, note,
        created_at, updated_at
      ) VALUES (
        'isolated-telemetry-case', 'werewolf', 'trigger', 'dynamic', '请读取狼人杀 skill。',
        '[]', '', 'pending', 'ready', '',
        @createdAt, @updatedAt
      )
    `).run({ createdAt: now, updatedAt: now });

    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: {
        createInvocationContext(ctx) {
          return ctx;
        },
        registerInvocation(ctx) {
          invocationContext = ctx;
          return { invocationId: 'inv-isolated-telemetry', callbackToken: 'token-isolated-telemetry' };
        },
        unregisterInvocation() {},
      },
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'test',
        sandboxId: `sandbox-${caseId}`,
      }),
      startRunImpl: (_provider, _model, _prompt, runOptions = {}) => {
        assert.ok(invocationContext);
        const runtimeSkillPath = path.join(runOptions.agentDir || invocationContext.runStore.agentDir, 'skills', 'werewolf', 'SKILL.md');
        invocationContext.runStore.appendTaskEvent(runOptions.taskId, 'agent_tool_call', {
          tool: 'read',
          request: { path: runtimeSkillPath },
          status: 'succeeded',
        });
        return {
          runId: 'isolated-telemetry-run',
          sessionPath: '',
          resultPromise: Promise.resolve({
            reply: 'ok',
            runId: 'isolated-telemetry-run',
            sessionPath: '',
          }),
        };
      },
    });

    const runRes = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/isolated-telemetry-case/run', {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
      }),
      res: runRes,
      pathname: '/api/skills/werewolf/test-cases/isolated-telemetry-case/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/isolated-telemetry-case/run'),
    });

    assert.equal(handled, true);
    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.status, 'succeeded');
    assert.ok(runRes.json.run.isolation);
    assert.equal(runRes.json.run.isolation.pollutionCheck.ok, true);
    assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM a2a_task_events').get().count, 0);

    const detailRes = createCaptureResponse();
    const detailHandled = await controller({
      req: createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined),
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailHandled, true);
    assert.equal(detailRes.statusCode, 200);
    assert.ok(detailRes.json.debug);
    assert.equal(Array.isArray(detailRes.json.debug.toolCalls), true);
    assert.equal(detailRes.json.debug.toolCalls.length, 1);
    assert.equal(detailRes.json.debug.toolCalls[0].payload.tool, 'read');
  } finally {
    harness.cleanup();
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

test('dynamic trigger run stops immediately after target skill load and emits live trace events', async () => {
  const harness = createTempHarness();
  const sessionPath = path.join(harness.tempDir, 'agent', 'named-sessions', 'dynamic-stop-session.jsonl');
  const broadcastEvents = [];
  const completionReasons = [];
  let lateWorkflowStepObserved = false;

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
          path: '/tmp/skills/werewolf',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      broadcastEvent(eventName, payload) {
        broadcastEvents.push({ eventName, payload });
      },
      startRunImpl: () => {
        const emitter = new EventEmitter();
        let settled = false;
        let resolveResult;
        const resultPromise = new Promise((resolve) => {
          resolveResult = resolve;
        });
        const finish = (reply = '') => {
          if (settled) {
            return;
          }
          settled = true;
          fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
          fs.writeFileSync(
            sessionPath,
            `${JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [
                  { type: 'toolCall', name: 'read', id: 'tool-stop-1', arguments: { path: '/tmp/skills/werewolf/SKILL.md' } },
                ],
              },
            })}\n`,
            'utf8'
          );
          resolveResult({ reply, runId: 'run-dynamic-stop', sessionPath });
        };
        const handle = {
          runId: 'run-dynamic-stop',
          sessionPath,
          on(eventName, listener) {
            emitter.on(eventName, listener);
            return handle;
          },
          complete(reason) {
            completionReasons.push(String(reason || ''));
            finish('stopped after skill load');
            return handle;
          },
          cancel(reason) {
            completionReasons.push(String(reason || ''));
            finish('stopped after skill load');
            return handle;
          },
          resultPromise,
        };
        setTimeout(() => {
          emitter.emit('runner_status', {
            stage: 'preparing_assets',
            label: '正在准备 sandbox runner…',
          });
        }, 0);
        setTimeout(() => {
          emitter.emit('assistant_text_delta', {
            delta: '正在加载 skill…',
            isFallback: false,
            messageKey: 'response:skill-test-live',
          });
        }, 2);
        setTimeout(() => {
          emitter.emit('pi_event', {
            piEvent: {
              message: {
                role: 'assistant',
                content: [
                  { type: 'toolCall', name: 'read', id: 'tool-stop-1', arguments: { path: '/tmp/skills/werewolf/SKILL.md' } },
                ],
              },
            },
          });
        }, 5);
        setTimeout(() => {
          if (!settled) {
            lateWorkflowStepObserved = true;
            finish('late step should not happen');
          }
        }, 40);
        return handle;
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'trigger',
      loadingMode: 'dynamic',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedBehavior: '应该只验证目标 skill 是否被正确加载。',
    });
    const createRes = createCaptureResponse();
    await controller({
      req: createReq,
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

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.status, 'succeeded');
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.equal(runRes.json.run.executionPassed, null);
    assert.equal(lateWorkflowStepObserved, false);
    assert.ok(completionReasons.some((reason) => reason.includes('Dynamic skill load confirmed')));

    const detailRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`, undefined),
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.deepEqual(detailRes.json.run.actualTools, ['read']);

    const startedEvent = broadcastEvents.find((entry) => entry.eventName === 'skill_test_run_event' && entry.payload && entry.payload.phase === 'started');
    const progressEvent = broadcastEvents.find((entry) => entry.eventName === 'skill_test_run_event' && entry.payload && entry.payload.phase === 'progress');
    const completedEvent = broadcastEvents.find((entry) => entry.eventName === 'skill_test_run_event' && entry.payload && entry.payload.phase === 'completed');
    const outputDeltaEvent = broadcastEvents.find((entry) => entry.eventName === 'skill_test_run_event' && entry.payload && entry.payload.phase === 'output_delta');
    const toolEvent = broadcastEvents.find(
      (entry) =>
        entry.eventName === 'conversation_tool_event' &&
        entry.payload &&
        entry.payload.step &&
        entry.payload.step.toolName === 'read'
    );

    assert.ok(startedEvent, 'expected skill_test_run_event started payload');
    assert.ok(progressEvent, 'expected skill_test_run_event progress payload');
    assert.ok(completedEvent, 'expected skill_test_run_event completed payload');
    assert.ok(outputDeltaEvent, 'expected live skill_test_run_event output_delta payload');
    assert.ok(toolEvent, 'expected live conversation_tool_event payload');
    assert.equal(startedEvent.payload.caseId, caseId);
    assert.equal(completedEvent.payload.caseId, caseId);
    assert.equal(progressEvent.payload.messageId, startedEvent.payload.messageId);
    assert.equal(progressEvent.payload.progressLabel, '正在准备 sandbox runner…');
    assert.equal(progressEvent.payload.runnerStage, 'preparing_assets');
    assert.equal(outputDeltaEvent.payload.messageId, startedEvent.payload.messageId);
    assert.equal(outputDeltaEvent.payload.delta, '正在加载 skill…');
    assert.equal(outputDeltaEvent.payload.outputText, '正在加载 skill…');
    assert.equal(outputDeltaEvent.payload.progressLabel, '模型正在输出…');
    assert.equal(toolEvent.payload.messageId, startedEvent.payload.messageId);
    assert.equal(completedEvent.payload.trace.summary.totalSteps, 1);
  } finally {
    harness.cleanup();
  }
});

test('dynamic trigger evaluation falls back to load-confirmed task event when session evidence is absent', async () => {
  const harness = createTempHarness();
  const completionReasons = [];

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
          path: '/tmp/skills/werewolf',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const emitter = new EventEmitter();
        let resolveResult;
        const resultPromise = new Promise((resolve) => {
          resolveResult = resolve;
        });
        const handle = {
          runId: 'run-dynamic-confirmed-task-event',
          sessionPath: '',
          on(eventName, listener) {
            emitter.on(eventName, listener);
            return handle;
          },
          complete(reason) {
            completionReasons.push(String(reason || ''));
            resolveResult({ reply: 'stopped after skill load', runId: 'run-dynamic-confirmed-task-event', sessionPath: '' });
            return handle;
          },
          cancel(reason) {
            completionReasons.push(String(reason || ''));
            resolveResult({ reply: 'stopped after skill load', runId: 'run-dynamic-confirmed-task-event', sessionPath: '' });
            return handle;
          },
          resultPromise,
        };
        setTimeout(() => {
          emitter.emit('pi_event', {
            piEvent: {
              message: {
                role: 'assistant',
                content: [
                  { type: 'toolCall', name: 'read', id: 'tool-confirm-only-1', arguments: { path: '/tmp/skills/werewolf/SKILL.md' } },
                ],
              },
            },
          });
        }, 0);
        return handle;
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'trigger',
      loadingMode: 'dynamic',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedBehavior: '应该在 runtime 事件确认加载后立即通过。',
    });
    const createRes = createCaptureResponse();
    await controller({
      req: createReq,
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
    assert.equal(runRes.json.run.status, 'succeeded');
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.deepEqual(runRes.json.run.actualTools, ['read']);
    assert.ok(completionReasons.some((reason) => reason.includes('Dynamic skill load confirmed')));
  } finally {
    harness.cleanup();
  }
});

test('dynamic trigger early-stop matches target read even when it is not the last tool call in the pi event', async () => {
  const harness = createTempHarness();
  let lateWorkflowStepObserved = false;
  const completionReasons = [];

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
          path: '/tmp/skills/werewolf',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const emitter = new EventEmitter();
        let settled = false;
        let resolveResult;
        const resultPromise = new Promise((resolve) => {
          resolveResult = resolve;
        });
        const finish = (reply = '') => {
          if (settled) {
            return;
          }
          settled = true;
          resolveResult({ reply, runId: 'run-dynamic-multi-tool-event', sessionPath: '' });
        };
        const handle = {
          runId: 'run-dynamic-multi-tool-event',
          sessionPath: '',
          on(eventName, listener) {
            emitter.on(eventName, listener);
            return handle;
          },
          complete(reason) {
            completionReasons.push(String(reason || ''));
            finish('stopped after skill load');
            return handle;
          },
          cancel(reason) {
            completionReasons.push(String(reason || ''));
            finish('stopped after skill load');
            return handle;
          },
          resultPromise,
        };
        setTimeout(() => {
          emitter.emit('pi_event', {
            piEvent: {
              message: {
                role: 'assistant',
                content: [
                  { type: 'toolCall', name: 'read', id: 'tool-multi-1', arguments: { path: '/tmp/skills/werewolf/SKILL.md' } },
                  { type: 'toolCall', name: 'bash', id: 'tool-multi-2', arguments: { command: 'echo ready' } },
                ],
              },
            },
          });
        }, 0);
        setTimeout(() => {
          if (!settled) {
            lateWorkflowStepObserved = true;
            finish('late step should not happen');
          }
        }, 40);
        return handle;
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'trigger',
      loadingMode: 'dynamic',
      triggerPrompt: '先加载狼人杀 skill，然后再决定下一步。',
      expectedBehavior: '命中目标 SKILL.md 后应立刻停止，不必继续处理同条消息里的其他 tool。',
    });
    const createRes = createCaptureResponse();
    await controller({
      req: createReq,
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

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.status, 'succeeded');
    assert.equal(runRes.json.run.triggerPassed, true);
    assert.deepEqual(runRes.json.run.actualTools, ['read']);
    assert.equal(lateWorkflowStepObserved, false);
    assert.ok(completionReasons.some((reason) => reason.includes('Dynamic skill load confirmed')));
  } finally {
    harness.cleanup();
  }
});

test('legacy dynamic execution runs keep executing after skill load instead of early-stopping', async () => {
  const harness = createTempHarness();
  const sessionPath = path.join(harness.tempDir, 'agent', 'named-sessions', 'dynamic-execution-session.jsonl');
  let completionCount = 0;

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
          path: '/tmp/skills/werewolf',
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        const emitter = new EventEmitter();
        const resultPromise = new Promise((resolve) => {
          setTimeout(() => {
            fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
            fs.writeFileSync(
              sessionPath,
              `${JSON.stringify({
                type: 'message',
                message: {
                  role: 'assistant',
                  content: [
                    { type: 'toolCall', name: 'read', id: 'tool-read-1', arguments: { path: '/tmp/skills/werewolf/SKILL.md' } },
                    { type: 'toolCall', name: 'bash', id: 'tool-bash-1', arguments: { command: 'echo ready', timeout: 15 } },
                  ],
                },
              })}\n`,
              'utf8'
            );
            resolve({ reply: 'done', runId: 'run-dynamic-execution', sessionPath });
          }, 30);
        });
        const handle = {
          runId: 'run-dynamic-execution',
          sessionPath,
          on(eventName, listener) {
            emitter.on(eventName, listener);
            return handle;
          },
          complete() {
            completionCount += 1;
            return handle;
          },
          cancel() {
            completionCount += 1;
            return handle;
          },
          resultPromise,
        };
        setTimeout(() => {
          emitter.emit('pi_event', {
            piEvent: {
              message: {
                role: 'assistant',
                content: [
                  { type: 'toolCall', name: 'read', id: 'tool-read-1', arguments: { path: '/tmp/skills/werewolf/SKILL.md' } },
                ],
              },
            },
          });
        }, 0);
        return handle;
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'dynamic',
      triggerPrompt: '先加载狼人杀 skill，再继续执行后续步骤。',
      expectedTools: ['read', 'bash'],
      expectedBehavior: '旧版 dynamic execution 应继续执行后续工具。',
    });
    const createRes = createCaptureResponse();
    await controller({
      req: createReq,
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
    assert.equal(completionCount, 0);
    assert.deepEqual(runRes.json.run.actualTools, ['read', 'bash']);
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

test('manual create persists environmentConfig on skill test cases', async () => {
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
    userPrompt: '先检查环境，再执行 skill。',
    loadingMode: 'dynamic',
    expectedBehavior: '环境通过后继续运行。',
    environmentConfig: {
      enabled: true,
      requirements: [{ kind: 'command', name: 'python' }],
      bootstrap: { commands: ['python --version'] },
      verify: { commands: ['python --version'] },
    },
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
  assert.equal(res.json.testCase.environmentConfig.enabled, true);
  assert.equal(res.json.testCase.environmentConfig.requirements[0].name, 'python');

  const row = db.prepare('SELECT environment_config_json FROM skill_test_cases WHERE id = ?').get(res.json.testCase.id);
  assert.ok(row);
  const storedConfig = JSON.parse(row.environment_config_json || '{}');
  assert.equal(storedConfig.enabled, true);
  assert.equal(storedConfig.bootstrap.commands[0], 'python --version');

  db.close();
});

test('isolated run executes environment bootstrap before model run and persists environment status', async () => {
  const harness = createTempHarness();

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    let installed = false;
    const seenCommands = [];
    let startRunCalls = 0;
    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'env-test',
        sandboxId: `sandbox-${caseId}`,
        toolAdapter: {
          async access() {},
          async readFile() {
            return Buffer.from('# sandbox skill\n', 'utf8');
          },
          async writeFile() {},
          async mkdir() {},
          async runCommand(command) {
            seenCommands.push(String(command));
            if (String(command).includes("command -v 'fakecli'")) {
              return installed
                ? { stdout: '/usr/bin/fakecli\n', stderr: '', exitCode: 0 }
                : { stdout: '', stderr: 'not found', exitCode: 1 };
            }
            if (String(command) === 'install fakecli') {
              installed = true;
              return { stdout: 'installed', stderr: '', exitCode: 0 };
            }
            if (String(command) === 'fakecli --version') {
              return installed
                ? { stdout: 'fakecli 1.0.0\n', stderr: '', exitCode: 0 }
                : { stdout: '', stderr: 'not found', exitCode: 1 };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
        cleanup: async () => {},
      }),
      startRunImpl: () => {
        startRunCalls += 1;
        return {
          runId: 'env-bootstrap-run',
          sessionPath: path.join(harness.tempDir, 'env-bootstrap-run.jsonl'),
          resultPromise: Promise.resolve({
            reply: 'ok',
            runId: 'env-bootstrap-run',
            sessionPath: path.join(harness.tempDir, 'env-bootstrap-run.jsonl'),
          }),
        };
      },
      evaluateRunImpl: () => ({
        triggerPassed: 1,
        executionPassed: null,
        toolAccuracy: null,
        actualToolsJson: '[]',
        triggerEvaluation: { mode: 'dynamic', loaded: true, loadEvidence: [] },
        executionEvaluation: null,
        requiredStepCompletionRate: null,
        stepCompletionRate: null,
        requiredToolCoverage: null,
        toolCallSuccessRate: null,
        toolErrorRate: null,
        sequenceAdherence: null,
        goalAchievement: null,
        instructionAdherence: null,
        verdict: 'pass',
        evaluation: { verdict: 'pass', dimensions: {} },
        validationIssues: [],
      }),
    });

    const createRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        userPrompt: '先把 fakecli 装好，再继续运行狼人杀 skill。',
        loadingMode: 'dynamic',
        expectedBehavior: '先准备依赖再运行。',
        caseStatus: 'ready',
        environmentConfig: {
          enabled: true,
          requirements: [{ kind: 'command', name: 'fakecli' }],
          bootstrap: { commands: ['install fakecli'] },
          verify: { commands: ['fakecli --version'] },
        },
      }),
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
        environment: { enabled: true },
      }),
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.status, 'succeeded');
    assert.equal(runRes.json.run.environmentStatus, 'passed');
    assert.equal(runRes.json.run.environmentPhase, 'completed');
    assert.equal(runRes.json.run.evaluation.environment.status, 'passed');
    assert.equal(startRunCalls, 1);
    assert.ok(seenCommands.some((entry) => entry.includes("command -v 'fakecli'")));
    assert.ok(seenCommands.includes('install fakecli'));
    assert.ok(seenCommands.includes('fakecli --version'));

    const storedRun = harness.db.prepare('SELECT environment_status, environment_phase FROM skill_test_runs WHERE id = ?').get(runRes.json.run.id);
    assert.equal(storedRun.environment_status, 'passed');
    assert.equal(storedRun.environment_phase, 'completed');

    const detailRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`),
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.result.evaluation.environment.advice.target, 'TESTING.md');
    assert.match(detailRes.json.result.evaluation.environment.advice.patch, /# Testing Environment/);
  } finally {
    harness.cleanup();
  }
});

test('run can source environment bootstrap config from skill TESTING.md', async () => {
  const harness = createTempHarness();

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'TESTING.md'), [
      '# Testing Environment',
      '',
      '## Prerequisites',
      '- fakecli',
      '',
      '## Bootstrap',
      '- install fakecli',
      '',
      '## Verification',
      '- fakecli --version',
      '',
    ].join('\n'), 'utf8');

    let installed = false;
    const seenCommands = [];
    let startRunCalls = 0;
    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'testing-doc-env',
        sandboxId: `sandbox-${caseId}`,
        toolAdapter: {
          async access() {},
          async readFile() {
            return Buffer.from('# sandbox skill\n', 'utf8');
          },
          async writeFile() {},
          async mkdir() {},
          async runCommand(command) {
            seenCommands.push(String(command));
            if (String(command).includes("command -v 'fakecli'")) {
              return installed
                ? { stdout: '/usr/bin/fakecli\n', stderr: '', exitCode: 0 }
                : { stdout: '', stderr: 'not found', exitCode: 1 };
            }
            if (String(command) === 'install fakecli') {
              installed = true;
              return { stdout: 'installed', stderr: '', exitCode: 0 };
            }
            if (String(command) === 'fakecli --version') {
              return installed
                ? { stdout: 'fakecli 1.0.0\n', stderr: '', exitCode: 0 }
                : { stdout: '', stderr: 'not found', exitCode: 1 };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
        cleanup: async () => {},
      }),
      startRunImpl: () => {
        startRunCalls += 1;
        return {
          runId: 'testing-doc-run',
          sessionPath: path.join(harness.tempDir, 'testing-doc-run.jsonl'),
          resultPromise: Promise.resolve({
            reply: 'ok',
            runId: 'testing-doc-run',
            sessionPath: path.join(harness.tempDir, 'testing-doc-run.jsonl'),
          }),
        };
      },
      evaluateRunImpl: () => ({
        triggerPassed: 1,
        executionPassed: null,
        toolAccuracy: null,
        actualToolsJson: '[]',
        triggerEvaluation: { mode: 'dynamic', loaded: true, loadEvidence: [] },
        executionEvaluation: null,
        requiredStepCompletionRate: null,
        stepCompletionRate: null,
        requiredToolCoverage: null,
        toolCallSuccessRate: null,
        toolErrorRate: null,
        sequenceAdherence: null,
        goalAchievement: null,
        instructionAdherence: null,
        verdict: 'pass',
        evaluation: { verdict: 'pass', dimensions: {} },
        validationIssues: [],
      }),
    });

    const createRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        userPrompt: '先读测试文档里的环境说明，再执行狼人杀 skill。',
        loadingMode: 'dynamic',
        expectedBehavior: '支持从 TESTING.md 自动读取环境链。',
        caseStatus: 'ready',
      }),
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
        environment: { enabled: true },
      }),
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.status, 'succeeded');
    assert.equal(runRes.json.run.environmentStatus, 'passed');
    assert.equal(runRes.json.run.evaluation.environment.status, 'passed');
    assert.equal(runRes.json.run.evaluation.environment.source.testingDocUsed, true);
    assert.match(String(runRes.json.run.evaluation.environment.source.testingDocPath || ''), /TESTING\.md$/);
    assert.equal(startRunCalls, 1);
    assert.ok(seenCommands.some((entry) => entry.includes("command -v 'fakecli'")));
    assert.ok(seenCommands.includes('install fakecli'));
    assert.ok(seenCommands.includes('fakecli --version'));
  } finally {
    harness.cleanup();
  }
});

test('isolated run saves environment cache, restores on hit, and rebuilds after expiry', async () => {
  const harness = createTempHarness();

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const cacheRootDir = path.join(harness.tempDir, 'environment-cache');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(cacheRootDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    let startRunCalls = 0;
    let bootstrapExecutions = 0;
    let cacheSaveExecutions = 0;
    const seenCommands = [];
    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      environmentCacheRootDir: cacheRootDir,
      openSandboxFactory: ({ caseId, projectDir, outputDir }) => ({
        driverName: 'opensandbox',
        driverVersion: 'cache-restore',
        sandboxId: `sandbox-${caseId}`,
        toolAdapter: {
          async access(hostPath) {
            if (!fs.existsSync(hostPath)) {
              throw new Error(`File not found: ${hostPath}`);
            }
          },
          async readFile(hostPath) {
            if (!fs.existsSync(hostPath)) {
              throw new Error(`File not found: ${hostPath}`);
            }
            return fs.readFileSync(hostPath);
          },
          async writeFile(hostPath, content) {
            fs.mkdirSync(path.dirname(hostPath), { recursive: true });
            fs.writeFileSync(hostPath, content == null ? '' : content);
          },
          async mkdir(hostPath) {
            fs.mkdirSync(hostPath, { recursive: true });
          },
          async runCommand(command, input = {}) {
            const cwd = input && input.cwd ? String(input.cwd) : projectDir;
            const normalizedCommand = String(command || '').trim();
            seenCommands.push(normalizedCommand);
            if (normalizedCommand === 'test -f .cache-bin/fakecli') {
              return fs.existsSync(path.join(cwd, '.cache-bin', 'fakecli'))
                ? { stdout: 'ok\n', stderr: '', exitCode: 0 }
                : { stdout: '', stderr: 'missing', exitCode: 1 };
            }
            if (normalizedCommand === 'mkdir -p .cache-bin && printf "ok" > .cache-bin/fakecli') {
              bootstrapExecutions += 1;
              fs.mkdirSync(path.join(cwd, '.cache-bin'), { recursive: true });
              fs.writeFileSync(path.join(cwd, '.cache-bin', 'fakecli'), 'ok', 'utf8');
              return { stdout: 'installed\n', stderr: '', exitCode: 0 };
            }
            if (normalizedCommand.includes('tar -czf') && normalizedCommand.includes('artifact.tgz')) {
              cacheSaveExecutions += 1;
              const entries = [];
              const cacheDir = path.join(projectDir, '.cache-bin');
              const fakeCliPath = path.join(cacheDir, 'fakecli');
              if (fs.existsSync(cacheDir)) {
                entries.push({ name: 'project/.cache-bin', type: 'directory', mode: 0o755 });
              }
              if (fs.existsSync(fakeCliPath)) {
                entries.push({
                  name: 'project/.cache-bin/fakecli',
                  type: 'file',
                  mode: 0o755,
                  content: fs.readFileSync(fakeCliPath),
                });
              }
              fs.mkdirSync(path.join(outputDir, 'environment-cache'), { recursive: true });
              fs.writeFileSync(
                path.join(outputDir, 'environment-cache', 'artifact.tgz'),
                await createTarGzBuffer(entries),
              );
              return { stdout: 'saved\n', stderr: '', exitCode: 0 };
            }
            if (normalizedCommand.startsWith('chmod ')) {
              return { stdout: '', stderr: '', exitCode: 0 };
            }
            if (normalizedCommand.startsWith('ln -sfn ')) {
              return { stdout: '', stderr: '', exitCode: 0 };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
        cleanup: async () => {},
      }),
      startRunImpl: () => {
        startRunCalls += 1;
        return {
          runId: `cache-run-${startRunCalls}`,
          sessionPath: path.join(harness.tempDir, `cache-run-${startRunCalls}.jsonl`),
          resultPromise: Promise.resolve({
            reply: 'ok',
            runId: `cache-run-${startRunCalls}`,
            sessionPath: path.join(harness.tempDir, `cache-run-${startRunCalls}.jsonl`),
          }),
        };
      },
      evaluateRunImpl: () => ({
        triggerPassed: 1,
        executionPassed: null,
        toolAccuracy: null,
        actualToolsJson: '[]',
        triggerEvaluation: { mode: 'dynamic', loaded: true, loadEvidence: [] },
        executionEvaluation: null,
        requiredStepCompletionRate: null,
        stepCompletionRate: null,
        requiredToolCoverage: null,
        toolCallSuccessRate: null,
        toolErrorRate: null,
        sequenceAdherence: null,
        goalAchievement: null,
        instructionAdherence: null,
        verdict: 'pass',
        evaluation: { verdict: 'pass', dimensions: {} },
        validationIssues: [],
      }),
    });

    const createRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        userPrompt: '命中 cache 时应先恢复环境，再继续运行。',
        loadingMode: 'dynamic',
        expectedBehavior: 'restore-on-hit 应跳过 bootstrap。',
        caseStatus: 'ready',
        environmentConfig: {
          enabled: true,
          requirements: [{ kind: 'command', name: 'fakecli', probeCommand: 'test -f .cache-bin/fakecli' }],
          bootstrap: { commands: ['mkdir -p .cache-bin && printf "ok" > .cache-bin/fakecli'] },
          verify: { commands: ['test -f .cache-bin/fakecli'] },
          cache: {
            enabled: true,
            paths: [{ root: 'project', path: '.cache-bin' }],
            ttlHours: 24,
          },
        },
      }),
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const firstRunRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
        environment: { enabled: true },
      }),
      res: firstRunRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(firstRunRes.statusCode, 200);
    assert.equal(firstRunRes.json.run.environmentStatus, 'passed');
    assert.equal(firstRunRes.json.run.evaluation.environment.cache.status, 'saved');
    assert.equal(bootstrapExecutions, 1);
    assert.equal(cacheSaveExecutions, 1);

    const cacheKey = String(firstRunRes.json.run.evaluation.environment.cache.key || '').trim();
    assert.ok(cacheKey);
    const cacheEntryDir = path.join(cacheRootDir, cacheKey);
    assert.ok(fs.existsSync(path.join(cacheEntryDir, 'artifact.tgz')));
    assert.ok(fs.existsSync(path.join(cacheEntryDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(cacheEntryDir, 'summary.json')));
    assert.match(String(firstRunRes.json.run.evaluation.environment.cache.summaryPath || ''), /summary\.json$/);
    assert.ok(String(firstRunRes.json.run.evaluation.environment.cache.artifactSha256 || '').trim());

    const expiredOtherKey = 'expired-other';
    const expiredOtherDir = path.join(cacheRootDir, expiredOtherKey);
    fs.mkdirSync(expiredOtherDir, { recursive: true });
    fs.writeFileSync(path.join(expiredOtherDir, 'artifact.tgz'), await createTarGzBuffer([
      { name: 'project/.noop', type: 'file', mode: 0o644, content: 'noop' },
    ]));
    fs.writeFileSync(path.join(expiredOtherDir, 'manifest.json'), JSON.stringify({
      cacheKey: expiredOtherKey,
      skillId: 'werewolf',
      createdAt: '2020-01-01T00:00:00.000Z',
      savedAt: '2020-01-01T00:00:00.000Z',
      lastValidatedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-02T00:00:00.000Z',
      paths: [{ root: 'project', path: '.noop' }],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(expiredOtherDir, 'keep-me-if-janitor-breaks.txt'), 'stale', 'utf8');

    seenCommands.length = 0;
    const bootstrapExecutionsBeforeRestore = bootstrapExecutions;
    const secondRunRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
        environment: { enabled: true },
      }),
      res: secondRunRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(secondRunRes.statusCode, 200);
    assert.equal(secondRunRes.json.run.status, 'succeeded');
    assert.equal(secondRunRes.json.run.environmentStatus, 'passed');
    assert.equal(secondRunRes.json.run.evaluation.environment.cache.status, 'restored');
    assert.equal(secondRunRes.json.run.evaluation.environment.cache.restoredFiles, 1);
    assert.match(String(secondRunRes.json.run.evaluation.environment.cache.manifestPath || ''), /manifest\.json$/);
    assert.match(String(secondRunRes.json.run.evaluation.environment.cache.summaryPath || ''), /summary\.json$/);
    assert.equal(bootstrapExecutions, bootstrapExecutionsBeforeRestore);
    assert.equal(cacheSaveExecutions, 1);
    assert.ok(seenCommands.includes('test -f .cache-bin/fakecli'));
    assert.ok(!seenCommands.includes('mkdir -p .cache-bin && printf "ok" > .cache-bin/fakecli'));
    assert.ok(!seenCommands.some((entry) => entry.includes('tar -czf')));
    assert.ok(!fs.existsSync(expiredOtherDir));

    const currentManifestPath = path.join(cacheEntryDir, 'manifest.json');
    const currentManifest = JSON.parse(fs.readFileSync(currentManifestPath, 'utf8'));
    currentManifest.lastValidatedAt = '2020-01-01T00:00:00.000Z';
    currentManifest.savedAt = '2020-01-01T00:00:00.000Z';
    currentManifest.expiresAt = '2020-01-02T00:00:00.000Z';
    fs.writeFileSync(currentManifestPath, JSON.stringify(currentManifest, null, 2), 'utf8');

    seenCommands.length = 0;
    const bootstrapExecutionsBeforeExpiry = bootstrapExecutions;
    const thirdRunRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
        environment: { enabled: true },
      }),
      res: thirdRunRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(thirdRunRes.statusCode, 200);
    assert.equal(thirdRunRes.json.run.status, 'succeeded');
    assert.equal(thirdRunRes.json.run.environmentStatus, 'passed');
    assert.equal(thirdRunRes.json.run.evaluation.environment.cache.status, 'saved');
    assert.equal(bootstrapExecutions, bootstrapExecutionsBeforeExpiry + 1);
    assert.equal(cacheSaveExecutions, 2);
    assert.ok(seenCommands.includes('mkdir -p .cache-bin && printf "ok" > .cache-bin/fakecli'));
    assert.equal(startRunCalls, 3);
  } finally {
    harness.cleanup();
  }
});

test('environment-enabled run fails fast as runtime_unsupported without sandbox tools', async () => {
  const harness = createTempHarness();

  try {
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    let startRunCalls = 0;
    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => harness.tempDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => {
        startRunCalls += 1;
        return {
          runId: 'should-not-run',
          sessionPath: path.join(harness.tempDir, 'should-not-run.jsonl'),
          resultPromise: Promise.resolve({ reply: 'unexpected', runId: 'should-not-run', sessionPath: path.join(harness.tempDir, 'should-not-run.jsonl') }),
        };
      },
    });

    const createRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        userPrompt: '先准备环境，再执行。',
        loadingMode: 'dynamic',
        expectedBehavior: '环境准备失败时不要继续。',
        caseStatus: 'ready',
        environmentConfig: {
          enabled: true,
          requirements: [{ kind: 'command', name: 'fakecli' }],
          bootstrap: { commands: ['install fakecli'] },
        },
      }),
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    const caseId = createRes.json.testCase.id;
    const runRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {
        environment: { enabled: true },
      }),
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.status, 'failed');
    assert.equal(runRes.json.run.environmentStatus, 'runtime_unsupported');
    assert.equal(runRes.json.run.evaluation.environment.status, 'runtime_unsupported');
    assert.equal(startRunCalls, 0);
  } finally {
    harness.cleanup();
  }
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

test('isolated run-all assigns distinct case project roots and records isolation evidence', async () => {
  const harness = createTempHarness();

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const now = new Date().toISOString();
    const insertCase = harness.db.prepare(`
      INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status, note,
        created_at, updated_at
      ) VALUES (
        @id, 'werewolf', 'trigger', 'dynamic', @prompt,
        '[]', '', 'pending', 'ready', '',
        @createdAt, @updatedAt
      )
    `);

    insertCase.run({ id: 'iso-case-1', prompt: 'case one prompt', createdAt: now, updatedAt: now });
    insertCase.run({ id: 'iso-case-2', prompt: 'case two prompt', createdAt: now, updatedAt: now });

    const seenProjectDirs = [];
    let runIndex = 0;
    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'test',
        sandboxId: `sandbox-${caseId}`,
        toolAdapter: createSandboxToolAdapterStub(),
      }),
      startRunImpl: (_provider, _model, _prompt, runOptions = {}) => {
        runIndex += 1;
        const caseProjectDir = String(runOptions.extraEnv && runOptions.extraEnv.CAFF_TRELLIS_PROJECT_DIR || '');
        seenProjectDirs.push(caseProjectDir);
        fs.writeFileSync(path.join(caseProjectDir, '.trellis', `marker-${runIndex}.txt`), `run-${runIndex}`, 'utf8');
        const sessionPath = path.join(harness.tempDir, `isolated-run-${runIndex}.jsonl`);
        return {
          runId: `run-${runIndex}`,
          sessionPath,
          resultPromise: Promise.resolve({
            reply: `reply-${runIndex}`,
            runId: `run-${runIndex}`,
            sessionPath,
          }),
        };
      },
    });

    const res = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/run-all', {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
      }),
      res,
      pathname: '/api/skills/werewolf/test-cases/run-all',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/run-all'),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.total, 2);
    assert.equal(new Set(seenProjectDirs).size, 2);
    assert.ok(res.json.results.every((entry) => entry.run && entry.run.isolation && entry.run.isolation.mode === 'isolated'));
    assert.ok(res.json.results.every((entry) => entry.run.isolation.execution.runtime === 'host'));
    assert.ok(res.json.results.every((entry) => entry.run.isolation.execution.loopRuntime === 'host'));
    assert.ok(res.json.results.every((entry) => entry.run.isolation.execution.toolRuntime === 'sandbox'));
    assert.ok(res.json.results.every((entry) => entry.run.isolation.execution.pathSemantics === 'sandbox'));
    assert.ok(res.json.results.every((entry) => entry.run.isolation.execution.preparedOnly === false));
    const projectDirs = res.json.results.map((entry) => entry.run.isolation.resources.projectDir);
    assert.equal(new Set(projectDirs).size, 2);
    assert.equal(fs.existsSync(path.join(liveProjectDir, '.trellis')), false);
  } finally {
    harness.cleanup();
  }
});

test('isolated run fails when pollution check detects live trellis changes', async () => {
  const harness = createTempHarness();

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const liveTrellisDir = path.join(liveProjectDir, '.trellis');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveTrellisDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(liveTrellisDir, 'workflow.md'), '# Workflow\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const now = new Date().toISOString();
    harness.db.prepare(`
      INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status, note,
        created_at, updated_at
      ) VALUES (
        'pollution-case', 'werewolf', 'trigger', 'dynamic', 'pollution prompt',
        '[]', '', 'pending', 'ready', '',
        @createdAt, @updatedAt
      )
    `).run({ createdAt: now, updatedAt: now });

    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'test',
        sandboxId: `sandbox-${caseId}`,
      }),
      startRunImpl: () => {
        fs.writeFileSync(path.join(liveTrellisDir, 'workflow.md'), '# polluted\n', 'utf8');
        const sessionPath = path.join(harness.tempDir, 'pollution-run.jsonl');
        return {
          runId: 'pollution-run',
          sessionPath,
          resultPromise: Promise.resolve({
            reply: 'polluted',
            runId: 'pollution-run',
            sessionPath,
          }),
        };
      },
    });

    const res = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/pollution-case/run', {
        isolation: { mode: 'isolated', trellisMode: 'readonlySnapshot' },
      }),
      res,
      pathname: '/api/skills/werewolf/test-cases/pollution-case/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/pollution-case/run'),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.run.status, 'failed');
    assert.ok(res.json.run.isolation);
    assert.equal(res.json.run.isolation.pollutionCheck.ok, false);
    assert.ok(Array.isArray(res.json.issues));
    assert.ok(res.json.issues.some((issue) => issue.code === 'skill_test_pollution_detected'));
  } finally {
    harness.cleanup();
  }
});

test('isolated run fails when pollution check detects case-scoped live sqlite writes', async () => {
  const harness = createTempHarness();
  let pollutionDb = null;

  try {
    harness.db.pragma('wal_autocheckpoint = 0');
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const now = new Date().toISOString();
    harness.db.prepare(`
      INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status, note,
        created_at, updated_at
      ) VALUES (
        'sqlite-pollution-case', 'werewolf', 'trigger', 'dynamic', 'sqlite pollution prompt',
        '[]', '', 'pending', 'ready', '',
        @createdAt, @updatedAt
      )
    `).run({ createdAt: now, updatedAt: now });

    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'test',
        sandboxId: `sandbox-${caseId}`,
      }),
      startRunImpl: (_provider, _model, _prompt, options = {}) => {
        pollutionDb = new Database(harness.databasePath);
        pollutionDb.pragma('journal_mode = WAL');
        pollutionDb.pragma('wal_autocheckpoint = 0');
        const pollutedAgentId = String(options && options.extraEnv && options.extraEnv.PI_AGENT_ID || 'skill-test-agent').trim() || 'skill-test-agent';
        pollutionDb.prepare(
          `INSERT INTO chat_agents (
            id, name, persona_prompt, description, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          pollutedAgentId,
          'Live Pollution Agent',
          'polluted',
          'x'.repeat(4096),
          new Date().toISOString(),
          new Date().toISOString()
        );
        const sessionPath = path.join(harness.tempDir, 'sqlite-pollution-run.jsonl');
        return {
          runId: 'sqlite-pollution-run',
          sessionPath,
          resultPromise: Promise.resolve({
            reply: 'polluted',
            runId: 'sqlite-pollution-run',
            sessionPath,
          }),
        };
      },
    });

    const res = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/sqlite-pollution-case/run', {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
      }),
      res,
      pathname: '/api/skills/werewolf/test-cases/sqlite-pollution-case/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/sqlite-pollution-case/run'),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.run.status, 'failed');
    assert.ok(res.json.run.isolation);
    assert.equal(res.json.run.isolation.pollutionCheck.ok, false);
    assert.ok(Array.isArray(res.json.run.isolation.pollutionCheck.changes));
    assert.ok(
      res.json.run.isolation.pollutionCheck.changes.some((change) => (
        String(change && change.table || '').trim() === 'chat_agents'
      ))
    );
    assert.ok(Array.isArray(res.json.issues));
    assert.ok(res.json.issues.some((issue) => issue.code === 'skill_test_pollution_detected'));
  } finally {
    try {
      pollutionDb && pollutionDb.close();
    } catch {
      // ignore cleanup errors
    }
    harness.cleanup();
  }
});

test('isolated run ignores unrelated live sqlite activity outside the case scope', async () => {
  const harness = createTempHarness();
  let pollutionDb = null;

  try {
    harness.db.pragma('wal_autocheckpoint = 0');
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const now = new Date().toISOString();
    harness.db.prepare(`
      INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status, note,
        created_at, updated_at
      ) VALUES (
        'sqlite-unrelated-case', 'werewolf', 'trigger', 'dynamic', 'sqlite unrelated prompt',
        '[]', '', 'pending', 'ready', '',
        @createdAt, @updatedAt
      )
    `).run({ createdAt: now, updatedAt: now });

    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'test',
        sandboxId: `sandbox-${caseId}`,
      }),
      startRunImpl: () => {
        pollutionDb = new Database(harness.databasePath);
        pollutionDb.pragma('journal_mode = WAL');
        pollutionDb.pragma('wal_autocheckpoint = 0');
        pollutionDb.prepare(
          `INSERT INTO chat_agents (
            id, name, persona_prompt, description, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          'unrelated-live-agent',
          'Unrelated Live Agent',
          'clean',
          'x'.repeat(2048),
          new Date().toISOString(),
          new Date().toISOString()
        );
        const sessionPath = path.join(harness.tempDir, 'sqlite-unrelated-run.jsonl');
        return {
          runId: 'sqlite-unrelated-run',
          sessionPath,
          resultPromise: Promise.resolve({
            reply: 'clean',
            runId: 'sqlite-unrelated-run',
            sessionPath,
          }),
        };
      },
    });

    const res = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/sqlite-unrelated-case/run', {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
      }),
      res,
      pathname: '/api/skills/werewolf/test-cases/sqlite-unrelated-case/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/sqlite-unrelated-case/run'),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.ok(res.json.run.isolation);
    assert.equal(res.json.run.isolation.pollutionCheck.ok, true);
    assert.ok(Array.isArray(res.json.run.isolation.pollutionCheck.changes));
    assert.equal(res.json.run.isolation.pollutionCheck.changes.length, 0);
    assert.ok(Array.isArray(res.json.issues));
    assert.ok(!res.json.issues.some((issue) => issue.code === 'skill_test_pollution_detected'));
  } finally {
    try {
      pollutionDb && pollutionDb.close();
    } catch {
      // ignore cleanup errors
    }
    harness.cleanup();
  }
});

test('readonlySnapshot rejects symlinked live Trellis entries', async (t) => {
  const harness = createTempHarness();

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const liveTrellisDir = path.join(liveProjectDir, '.trellis');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(path.join(liveTrellisDir, 'spec'), { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(liveTrellisDir, 'workflow.md'), '# Workflow\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const externalDir = path.join(harness.tempDir, 'external-spec');
    const linkedSpecDir = path.join(liveTrellisDir, 'spec', 'linked');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'secret.md'), '# secret\n', 'utf8');

    try {
      fs.symlinkSync(externalDir, linkedSpecDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink creation not supported in this environment: ${error && error.message ? error.message : error}`);
      return;
    }

    const now = new Date().toISOString();
    harness.db.prepare(`
      INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status, note,
        created_at, updated_at
      ) VALUES (
        'symlink-snapshot-case', 'werewolf', 'trigger', 'dynamic', 'snapshot prompt',
        '[]', '', 'pending', 'ready', '',
        @createdAt, @updatedAt
      )
    `).run({ createdAt: now, updatedAt: now });

    let startRunCalled = false;
    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'test',
        sandboxId: `sandbox-${caseId}`,
      }),
      startRunImpl: () => {
        startRunCalled = true;
        throw new Error('startRun should not execute when readonlySnapshot rejects symlinks');
      },
    });

    const res = createCaptureResponse();
    let caughtError = null;

    try {
      await controller({
        req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/symlink-snapshot-case/run', {
          isolation: { mode: 'isolated', trellisMode: 'readonlySnapshot' },
        }),
        res,
        pathname: '/api/skills/werewolf/test-cases/symlink-snapshot-case/run',
        requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/symlink-snapshot-case/run'),
      });
    } catch (error) {
      caughtError = error;
    }

    if (caughtError) {
      assert.equal(caughtError.statusCode, 400);
      assert.match(String(caughtError.message || ''), /symlink/i);
    } else {
      assert.equal(res.statusCode, 400);
      assert.match(String((res.json && (res.json.error || res.json.message)) || res.bodyText || ''), /symlink/i);
    }

    assert.equal(startRunCalled, false);
  } finally {
    harness.cleanup();
  }
});

test('isolated run awaits async openSandboxFactory and still uses host loop by default', async () => {
  const harness = createTempHarness();

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const now = new Date().toISOString();
    harness.db.prepare(`
      INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status, note,
        created_at, updated_at
      ) VALUES (
        'async-case', 'werewolf', 'trigger', 'dynamic', 'async prompt',
        '[]', '', 'pending', 'ready', '',
        @createdAt, @updatedAt
      )
    `).run({ createdAt: now, updatedAt: now });

    let factoryCalls = 0;
    let adapterStartRunCalls = 0;
    let startRunCalls = 0;
    let cleanupCalls = 0;
    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      openSandboxFactory: async ({ caseId }) => {
        factoryCalls += 1;
        return {
          driverName: 'opensandbox',
          driverVersion: 'async-test',
          sandboxId: `sandbox-${caseId}`,
          toolAdapter: createSandboxToolAdapterStub(),
          resources: {
            remoteRoot: `/remote/${caseId}`,
          },
          startRun: async () => {
            adapterStartRunCalls += 1;
            const sessionPath = path.join(harness.tempDir, 'async-adapter-run.jsonl');
            return {
              runId: 'async-adapter-run',
              sessionPath,
              resultPromise: Promise.resolve({
                reply: 'async-adapter-ok',
                runId: 'async-adapter-run',
                sessionPath,
              }),
            };
          },
          cleanup: async () => {
            cleanupCalls += 1;
          },
        };
      },
      startRunImpl: () => {
        startRunCalls += 1;
        const sessionPath = path.join(harness.tempDir, 'async-run.jsonl');
        return {
          runId: 'async-run',
          sessionPath,
          resultPromise: Promise.resolve({
            reply: 'async-ok',
            runId: 'async-run',
            sessionPath,
          }),
        };
      },
    });

    const res = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/async-case/run', {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
      }),
      res,
      pathname: '/api/skills/werewolf/test-cases/async-case/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/async-case/run'),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.run.status, 'succeeded');
    assert.equal(factoryCalls, 1);
    assert.equal(adapterStartRunCalls, 0);
    assert.equal(startRunCalls, 1);
    assert.equal(cleanupCalls, 1);
    assert.equal(res.json.run.isolation.driver.version, 'async-test');
    assert.equal(res.json.run.isolation.execution.runtime, 'host');
    assert.equal(res.json.run.isolation.execution.loopRuntime, 'host');
    assert.equal(res.json.run.isolation.execution.toolRuntime, 'sandbox');
    assert.equal(res.json.run.isolation.execution.pathSemantics, 'sandbox');
    assert.ok(!Object.prototype.hasOwnProperty.call(res.json.run.isolation.execution, 'adapterStartRun'));
    assert.equal(res.json.run.isolation.resources.remoteRoot, '/remote/async-case');
  } finally {
    harness.cleanup();
  }
});

test('isolated run records skill-test chat bridge auth evidence and scoped env', async () => {
  const harness = createTempHarness();

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const now = new Date().toISOString();
    harness.db.prepare(`
      INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status, note,
        created_at, updated_at
      ) VALUES (
        'chat-bridge-case', 'werewolf', 'trigger', 'dynamic', 'chat bridge prompt',
        '[]', '', 'pending', 'ready', '',
        @createdAt, @updatedAt
      )
    `).run({ createdAt: now, updatedAt: now });

    let invocationContext = null;
    let capturedExtraEnv = null;
    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: {
        createInvocationContext(ctx) {
          return {
            ...ctx,
            invocationId: 'inv-chat-bridge',
            callbackToken: 'token-chat-bridge',
            auth: {
              scope: ctx.authScope,
              caseId: ctx.caseId,
              runId: ctx.runId,
              taskId: ctx.taskId,
              tokenTtlSec: ctx.tokenTtlSec,
              expiresAt: '2026-04-13T09:10:00.000Z',
              validated: false,
              validatedCount: 0,
              lastValidatedAt: '',
              rejects: [],
            },
          };
        },
        registerInvocation(ctx) {
          invocationContext = ctx;
          return ctx;
        },
        unregisterInvocation() {
          return invocationContext;
        },
        summarizeInvocationAuth(ctx) {
          return ctx && ctx.auth ? ctx.auth : null;
        },
      },
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      skillTestChatApiUrl: 'https://bridge.example.test',
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'chat-bridge-test',
        sandboxId: `sandbox-${caseId}`,
        extraEnv: {
          CAFF_CHAT_TOOLS_PATH: `/case-runtime/${caseId}/agent-chat-tools.js`,
          CAFF_CHAT_TOOLS_RELATIVE_PATH: `../runtime/${caseId}/agent-chat-tools.js`,
        },
      }),
      startRunImpl: (_provider, _model, _prompt, runOptions = {}) => {
        capturedExtraEnv = runOptions.extraEnv || {};
        const sessionPath = path.join(harness.tempDir, 'chat-bridge-run.jsonl');
        return {
          runId: 'chat-bridge-run',
          sessionPath,
          resultPromise: Promise.resolve({
            reply: 'chat-bridge-ok',
            runId: 'chat-bridge-run',
            sessionPath,
          }),
        };
      },
    });

    const res = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/chat-bridge-case/run', {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
      }),
      res,
      pathname: '/api/skills/werewolf/test-cases/chat-bridge-case/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/chat-bridge-case/run'),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.ok(res.json.run.isolation.chatBridge);
    assert.equal(res.json.run.isolation.chatBridge.configuredUrl, 'https://bridge.example.test');
    assert.equal(res.json.run.isolation.chatBridge.auth.scope, 'skill-test');
    assert.equal(res.json.run.isolation.chatBridge.auth.caseId, 'chat-bridge-case');
    assert.equal(res.json.run.isolation.chatBridge.auth.runId, capturedExtraEnv.CAFF_SKILL_TEST_RUN_ID);
    assert.equal(res.json.run.isolation.chatBridge.auth.tokenTtlSec, 600);
    assert.equal(capturedExtraEnv.CAFF_CHAT_API_URL, 'https://bridge.example.test');
    assert.equal(capturedExtraEnv.CAFF_CHAT_TOOLS_PATH, '/case-runtime/chat-bridge-case/agent-chat-tools.js');
    assert.equal(capturedExtraEnv.CAFF_CHAT_TOOLS_RELATIVE_PATH, '../runtime/chat-bridge-case/agent-chat-tools.js');
    assert.equal(capturedExtraEnv.CAFF_SKILL_TEST_CASE_ID, 'chat-bridge-case');
  } finally {
    harness.cleanup();
  }
});

test('isolated full-mode judges reuse the case-scoped runtime store', async () => {
  const harness = createTempHarness();
  const originalProvider = process.env.PI_PROVIDER;
  const originalModel = process.env.PI_MODEL;

  process.env.PI_PROVIDER = 'judge-env-provider';
  process.env.PI_MODEL = 'judge-env-model';

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const liveAgentDir = path.join(harness.tempDir, 'agent-root');
    const mainRunCalls = [];
    const judgeRunCalls = [];
    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: liveAgentDir,
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          body: 'Follow the requested workflow and report the result.',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      resolveProviderAuthEnvImpl: (provider) => (
        provider === 'judge-env-provider'
          ? { ZAI_API_KEY: 'judge-auth-key' }
          : {}
      ),
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'judge-scope-test',
        sandboxId: `sandbox-${caseId}`,
      }),
      startRunImpl: (provider, model, prompt, runOptions = {}) => {
        const taskKind = String(runOptions.taskKind || '').trim();

        if (taskKind === 'skill_test_trigger_judge') {
          judgeRunCalls.push({
            taskKind,
            provider,
            model,
            agentDir: runOptions.agentDir,
            sqlitePath: runOptions.sqlitePath,
            prompt,
            extraEnv: runOptions.extraEnv || {},
          });
          const sessionPath = path.join(harness.tempDir, `trigger-judge-${Date.now()}.jsonl`);
          return {
            runId: null,
            sessionPath,
            resultPromise: Promise.resolve({
              reply: JSON.stringify({
                passed: true,
                confidence: 0.95,
                reason: 'Assistant follows the requested finish-work style workflow.',
                matchedBehaviors: ['workflow-followed'],
              }),
              sessionPath,
            }),
          };
        }

        if (taskKind === 'skill_test_execution_judge') {
          judgeRunCalls.push({
            taskKind,
            provider,
            model,
            agentDir: runOptions.agentDir,
            sqlitePath: runOptions.sqlitePath,
            prompt,
            extraEnv: runOptions.extraEnv || {},
          });
          const sessionPath = path.join(harness.tempDir, `execution-judge-${Date.now()}.jsonl`);
          return {
            runId: null,
            sessionPath,
            resultPromise: Promise.resolve({
              reply: JSON.stringify({
                goalAchievement: { score: 0.9, reason: 'The workflow is completed.' },
                instructionAdherence: { score: 0.92, reason: 'The assistant stays on checklist scope.' },
                summary: 'The assistant completes the requested isolated workflow.',
                verdictSuggestion: 'pass',
                steps: [
                  {
                    stepId: 'step-1',
                    completed: true,
                    confidence: 0.91,
                    evidenceIds: ['msg-1'],
                    matchedSignalIds: [],
                    reason: 'Observed the expected readiness summary.',
                  },
                ],
                constraintChecks: [],
                missedExpectations: [],
              }),
              sessionPath,
            }),
          };
        }

        mainRunCalls.push({
          provider,
          model,
          agentDir: runOptions.agentDir,
          sqlitePath: runOptions.sqlitePath,
          prompt,
          extraEnv: runOptions.extraEnv || {},
        });
        const reply = '我会先跑 lint、type-check、tests，再检查 git diff 和 spec 同步状态。';
        const sessionPath = path.join(harness.tempDir, 'isolated-full-main-run.jsonl');
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
          runId: 'isolated-full-main-run',
          sessionPath,
          resultPromise: Promise.resolve({
            reply,
            runId: 'isolated-full-main-run',
            sessionPath,
          }),
        };
      },
    });

    const createRes = createCaptureResponse();
    const created = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
        testType: 'execution',
        loadingMode: 'full',
        triggerPrompt: '代码写完了，帮我跑一下提交前检查',
        expectedGoal: 'Complete the finish-work style quality gate review.',
        expectedBehavior: 'Run the quality gate workflow and summarize readiness.',
        expectedSteps: [
          {
            id: 'step-1',
            title: 'Summarize readiness',
            expectedBehavior: 'Return a concise readiness summary after the checks.',
            required: true,
            order: 1,
            strongSignals: [],
          },
        ],
        evaluationRubric: {
          criticalConstraints: [],
          criticalDimensions: [],
          passThresholds: {
            goalAchievement: 0.7,
            instructionAdherence: 0.7,
            sequenceAdherence: 0.6,
          },
          hardFailThresholds: {
            goalAchievement: 0.4,
            instructionAdherence: 0.4,
            sequenceAdherence: 0.3,
          },
        },
      }),
      res: createRes,
      pathname: '/api/skills/werewolf/test-cases',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases'),
    });

    assert.equal(created, true);
    assert.equal(createRes.statusCode, 201);
    const caseId = createRes.json.testCase.id;

    const runRes = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', `/api/skills/werewolf/test-cases/${caseId}/run`, {
        isolation: { mode: 'isolated', trellisMode: 'fixture' },
      }),
      res: runRes,
      pathname: `/api/skills/werewolf/test-cases/${caseId}/run`,
      requestUrl: new URL(`http://localhost/api/skills/werewolf/test-cases/${caseId}/run`),
    });

    assert.equal(handled, true);
    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.isolation.pollutionCheck.ok, true);
    assert.equal(mainRunCalls.length, 1);
    assert.equal(judgeRunCalls.length, 2);
    assert.notEqual(mainRunCalls[0].agentDir, liveAgentDir);
    assert.notEqual(mainRunCalls[0].sqlitePath, harness.databasePath);
    assert.equal(runRes.json.run.isolation.resources.sqlitePath, mainRunCalls[0].sqlitePath.replace(/\\/g, '/'));
    assert.equal(mainRunCalls[0].provider, 'judge-env-provider');
    assert.equal(mainRunCalls[0].model, 'judge-env-model');
    assert.equal(mainRunCalls[0].extraEnv.PI_SQLITE_PATH, mainRunCalls[0].sqlitePath);
    assert.equal(mainRunCalls[0].extraEnv.CAFF_TRELLIS_PROJECT_DIR, runRes.json.run.isolation.resources.projectDir.replace(/\//g, path.sep));
    assert.equal(mainRunCalls[0].extraEnv.ZAI_API_KEY, 'judge-auth-key');
    assert.ok(judgeRunCalls.every((entry) => entry.provider === mainRunCalls[0].provider));
    assert.ok(judgeRunCalls.every((entry) => entry.model === mainRunCalls[0].model));
    assert.ok(judgeRunCalls.every((entry) => entry.agentDir === mainRunCalls[0].agentDir));
    assert.ok(judgeRunCalls.every((entry) => entry.sqlitePath === mainRunCalls[0].sqlitePath));
    assert.ok(judgeRunCalls.every((entry) => entry.extraEnv.PI_SQLITE_PATH === mainRunCalls[0].sqlitePath));
    assert.ok(judgeRunCalls.every((entry) => entry.extraEnv.CAFF_TRELLIS_PROJECT_DIR === mainRunCalls[0].extraEnv.CAFF_TRELLIS_PROJECT_DIR));
    assert.ok(judgeRunCalls.every((entry) => entry.extraEnv.CAFF_SKILL_TEST_SKILL_PATH === mainRunCalls[0].extraEnv.CAFF_SKILL_TEST_SKILL_PATH));
    assert.ok(judgeRunCalls.every((entry) => entry.extraEnv.ZAI_API_KEY === 'judge-auth-key'));
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

test('run detail surfaces sandbox failure debug payload', async () => {
  const harness = createTempHarness();

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const now = new Date().toISOString();
    harness.db.prepare(`
      INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status, note,
        created_at, updated_at
      ) VALUES (
        'sandbox-debug-case', 'werewolf', 'trigger', 'dynamic', 'sandbox debug prompt',
        '[]', '', 'pending', 'ready', '',
        @createdAt, @updatedAt
      )
    `).run({ createdAt: now, updatedAt: now });

    const sessionPath = path.join(harness.tempDir, 'sandbox-debug-run.jsonl');
    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      startRunImpl: () => ({
        runId: 'sandbox-debug-run',
        sessionPath,
        resultPromise: Promise.reject(Object.assign(new Error('Sandbox pi process exited with code 1'), {
          runId: 'sandbox-debug-run',
          sessionPath,
          stderrTail: 'sandbox stderr tail',
          stdoutLines: ['stdout line 1'],
          parseErrors: 1,
          assistantErrors: ['assistant boom'],
          sandboxCommand: {
            exitCode: 1,
            stdout: '',
            stderr: 'sandbox stderr tail',
          },
          exitCode: 1,
          signal: null,
        })),
      }),
    });

    const runRes = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/sandbox-debug-case/run', {}),
      res: runRes,
      pathname: '/api/skills/werewolf/test-cases/sandbox-debug-case/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/sandbox-debug-case/run'),
    });

    assert.equal(handled, true);
    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json.run.status, 'failed');

    const detailRes = createCaptureResponse();
    await controller({
      req: createJsonRequest('GET', `/api/skill-test-runs/${runRes.json.run.id}`),
      res: detailRes,
      pathname: `/api/skill-test-runs/${runRes.json.run.id}`,
      requestUrl: new URL(`http://localhost/api/skill-test-runs/${runRes.json.run.id}`),
    });

    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.json.debug.failure.stderrTail, 'sandbox stderr tail');
    assert.deepEqual(detailRes.json.debug.failure.stdoutLines, ['stdout line 1']);
    assert.equal(detailRes.json.debug.failure.parseErrors, 1);
    assert.deepEqual(detailRes.json.result.debug.failure.assistantErrors, ['assistant boom']);
    assert.equal(detailRes.json.result.debug.failure.exitCode, 1);
  } finally {
    harness.cleanup();
  }
});

test('isolated publish-gate allows host loop when sandbox tools also provide sandbox path semantics', async () => {
  const harness = createTempHarness();

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const now = new Date().toISOString();
    harness.db.prepare(`
      INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status, note,
        created_at, updated_at
      ) VALUES (
        'publish-gate-host-execution', 'werewolf', 'trigger', 'dynamic', 'host execution prompt',
        '[]', '', 'pending', 'ready', '',
        @createdAt, @updatedAt
      )
    `).run({ createdAt: now, updatedAt: now });

    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'prepared-only',
        sandboxId: `sandbox-${caseId}`,
        toolAdapter: createSandboxToolAdapterStub(),
      }),
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, 'publish-gate-host-execution.jsonl');
        return {
          runId: 'publish-gate-host-execution-run',
          sessionPath,
          resultPromise: Promise.resolve({
            reply: 'host-execution',
            runId: 'publish-gate-host-execution-run',
            sessionPath,
          }),
        };
      },
    });

    const res = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/publish-gate-host-execution/run', {
        isolation: { mode: 'isolated', trellisMode: 'fixture', egressMode: 'allow', publishGate: true },
      }),
      res,
      pathname: '/api/skills/werewolf/test-cases/publish-gate-host-execution/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/publish-gate-host-execution/run'),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.run.status, 'succeeded');
    assert.equal(res.json.run.isolation.publishGate, true);
    assert.equal(res.json.run.isolation.execution.runtime, 'host');
    assert.equal(res.json.run.isolation.execution.loopRuntime, 'host');
    assert.equal(res.json.run.isolation.execution.toolRuntime, 'sandbox');
    assert.equal(res.json.run.isolation.execution.pathSemantics, 'sandbox');
    assert.equal(res.json.run.isolation.execution.preparedOnly, false);
    assert.ok(Array.isArray(res.json.issues));
    assert.ok(!res.json.issues.some((issue) => issue.code === 'skill_test_path_semantics_not_sandboxed'));
  } finally {
    harness.cleanup();
  }
});

test('isolated publish-gate fails when deny egress is not enforced by the adapter', async () => {
  const harness = createTempHarness();

  try {
    const liveProjectDir = path.join(harness.tempDir, 'live-project');
    const skillDir = path.join(harness.tempDir, 'live-skills', 'werewolf');
    fs.mkdirSync(liveProjectDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Werewolf\n\nFixture skill body.\n', 'utf8');

    const now = new Date().toISOString();
    harness.db.prepare(`
      INSERT INTO skill_test_cases (
        id, skill_id, test_type, loading_mode, trigger_prompt,
        expected_tools_json, expected_behavior, validity_status, case_status, note,
        created_at, updated_at
      ) VALUES (
        'publish-gate-egress', 'werewolf', 'trigger', 'dynamic', 'egress prompt',
        '[]', '', 'pending', 'ready', '',
        @createdAt, @updatedAt
      )
    `).run({ createdAt: now, updatedAt: now });

    const controller = createSkillTestController({
      store: createInMemoryStore(harness.db, {
        agentDir: path.join(harness.tempDir, 'agent-root'),
        databasePath: harness.databasePath,
      }),
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry([
        {
          id: 'werewolf',
          name: 'Werewolf',
          description: 'Fixture skill',
          path: skillDir,
        },
      ]),
      getProjectDir: () => liveProjectDir,
      toolBaseUrl: 'http://127.0.0.1:3100',
      openSandboxFactory: ({ caseId }) => ({
        driverName: 'opensandbox',
        driverVersion: 'sandbox-start-run',
        sandboxId: `sandbox-${caseId}`,
        toolAdapter: createSandboxToolAdapterStub(),
        execution: {
          pathSemantics: 'sandbox',
        },
        startRun: async () => {
          const sessionPath = path.join(harness.tempDir, 'publish-gate-egress-adapter.jsonl');
          return {
            runId: 'publish-gate-egress-adapter-run',
            sessionPath,
            resultPromise: Promise.resolve({
              reply: 'egress-adapter-run',
              runId: 'publish-gate-egress-adapter-run',
              sessionPath,
            }),
          };
        },
      }),
      startRunImpl: () => {
        const sessionPath = path.join(harness.tempDir, 'publish-gate-egress.jsonl');
        return {
          runId: 'publish-gate-egress-run',
          sessionPath,
          resultPromise: Promise.resolve({
            reply: 'egress-run',
            runId: 'publish-gate-egress-run',
            sessionPath,
          }),
        };
      },
    });

    const res = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/skills/werewolf/test-cases/publish-gate-egress/run', {
        isolation: { mode: 'isolated', trellisMode: 'fixture', egressMode: 'deny', publishGate: true },
      }),
      res,
      pathname: '/api/skills/werewolf/test-cases/publish-gate-egress/run',
      requestUrl: new URL('http://localhost/api/skills/werewolf/test-cases/publish-gate-egress/run'),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.run.status, 'failed');
    assert.equal(res.json.run.isolation.execution.runtime, 'host');
    assert.equal(res.json.run.isolation.execution.loopRuntime, 'host');
    assert.equal(res.json.run.isolation.execution.toolRuntime, 'sandbox');
    assert.equal(res.json.run.isolation.execution.pathSemantics, 'sandbox');
    assert.equal(res.json.run.isolation.egress.mode, 'deny');
    assert.equal(res.json.run.isolation.egress.enforced, false);
    assert.ok(Array.isArray(res.json.issues));
    assert.ok(res.json.issues.some((issue) => issue.code === 'skill_test_egress_not_enforced'));
  } finally {
    harness.cleanup();
  }
});

test('skill test design import-matrix requires a source assistant message id', async () => {
  const db = createTestDb();
  let conversation = {
    id: 'design-conv-import',
    title: 'Skill Test Design',
    type: 'skill_test_design',
    metadata: {
      skillTestDesign: {
        version: 1,
        skillId: 'demo-skill',
        skillName: 'Demo Skill',
        phase: 'collecting_context',
        participantRoles: { 'agent-builder': 'scribe' },
        matrix: null,
        confirmation: null,
        export: null,
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
      },
    },
    messages: [],
  };
  const store = {
    db,
    getConversation(id) {
      return id === conversation.id ? conversation : null;
    },
    updateConversation(id, updates) {
      if (id !== conversation.id) {
        return null;
      }
      conversation = { ...conversation, ...updates };
      return conversation;
    },
  };
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['demo-skill']),
  });

  await assert.rejects(
    controller({
      req: createJsonRequest('POST', '/api/conversations/design-conv-import/skill-test-design/import-matrix', {
        matrix: {
          kind: 'skill_test_matrix',
          matrixId: 'matrix-import-1',
          skillId: 'demo-skill',
          phase: 'awaiting_confirmation',
          rows: [
            {
              rowId: 'row-1',
              scenario: 'cover the happy path for import validation',
              priority: 'P0',
              coverageReason: 'need a valid row so only messageId is under test',
              testType: 'trigger',
              loadingMode: 'dynamic',
              riskPoints: ['missing source audit'],
              keyAssertions: ['matrix imports only with assistant source'],
              includeInMvp: true,
              draftingHints: {},
            },
          ],
        },
      }),
      res: createCaptureResponse(),
      pathname: '/api/conversations/design-conv-import/skill-test-design/import-matrix',
      requestUrl: new URL('http://localhost/api/conversations/design-conv-import/skill-test-design/import-matrix'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.issues.some((issue) => issue.code === 'matrix_source_message_required'));
      return true;
    }
  );
});

test('skill test design import-matrix can read project-local matrix artifact', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-skill-test-design-artifact-'));
  try {
    const db = createTestDb();
    const artifactRelativePath = '.tmp/skill-test-design/demo-skill/matrix-artifact-1.json';
    const artifactAbsolutePath = path.join(tempDir, ...artifactRelativePath.split('/'));
    fs.mkdirSync(path.dirname(artifactAbsolutePath), { recursive: true });
    fs.writeFileSync(artifactAbsolutePath, JSON.stringify({
      kind: 'skill_test_matrix',
      matrixId: 'matrix-artifact-1',
      skillId: 'demo-skill',
      phase: 'awaiting_confirmation',
      rows: [
        {
          rowId: 'row-1',
          scenario: 'cover artifact-backed matrix import without posting full JSON',
          priority: 'P0',
          coverageReason: 'large matrices should stay out of the chat message body',
          testType: 'trigger',
          loadingMode: 'dynamic',
          riskPoints: ['chat message limit'],
          keyAssertions: ['imports the matrix from a trusted project artifact'],
          includeInMvp: true,
          draftingHints: {
            triggerPrompt: 'please load the demo skill for artifact import coverage',
            expectedBehavior: 'reads the demo skill instructions',
          },
        },
      ],
    }), 'utf8');

    let conversation = {
      id: 'design-conv-artifact',
      title: 'Skill Test Design',
      type: 'skill_test_design',
      metadata: {
        skillTestDesign: {
          version: 1,
          skillId: 'demo-skill',
          skillName: 'Demo Skill',
          phase: 'collecting_context',
          participantRoles: { 'agent-builder': 'scribe' },
          matrix: null,
          confirmation: null,
          export: null,
          createdAt: '2026-04-21T00:00:00.000Z',
          updatedAt: '2026-04-21T00:00:00.000Z',
        },
      },
      messages: [
        {
          id: 'assistant-msg-artifact',
          role: 'assistant',
          agentId: 'agent-builder',
          content: `矩阵已写入 artifact。\nMATRIX_ARTIFACT: ${artifactRelativePath}`,
        },
      ],
    };
    const store = {
      db,
      getConversation(id) {
        return id === conversation.id ? conversation : null;
      },
      updateConversation(id, updates) {
        if (id !== conversation.id) {
          return null;
        }
        conversation = { ...conversation, ...updates };
        return conversation;
      },
    };
    const controller = createSkillTestController({
      store,
      agentToolBridge: createFakeAgentToolBridge(),
      skillRegistry: createFakeSkillRegistry(['demo-skill']),
      getProjectDir: () => tempDir,
    });

    const res = createCaptureResponse();
    const handled = await controller({
      req: createJsonRequest('POST', '/api/conversations/design-conv-artifact/skill-test-design/import-matrix', {
        messageId: 'assistant-msg-artifact',
        matrixPath: artifactRelativePath,
      }),
      res,
      pathname: '/api/conversations/design-conv-artifact/skill-test-design/import-matrix',
      requestUrl: new URL('http://localhost/api/conversations/design-conv-artifact/skill-test-design/import-matrix'),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.state.matrix.matrixId, 'matrix-artifact-1');
    assert.equal(res.json.state.matrix.sourceMessageId, 'assistant-msg-artifact');
    assert.equal(res.json.state.matrix.sourceArtifactPath, artifactRelativePath);
    assert.equal(res.json.state.matrix.rows[0].scenario, 'cover artifact-backed matrix import without posting full JSON');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('skill test design export-drafts rolls back partial draft creation on validation failure', async () => {
  const db = createTestDb();
  let conversation = {
    id: 'design-conv-export',
    title: 'Skill Test Design',
    type: 'skill_test_design',
    metadata: {
      skillTestDesign: {
        version: 1,
        skillId: 'demo-skill',
        skillName: 'Demo Skill',
        phase: 'awaiting_confirmation',
        participantRoles: { 'agent-builder': 'scribe' },
        matrix: {
          kind: 'skill_test_matrix',
          matrixId: 'matrix-export-1',
          skillId: 'demo-skill',
          phase: 'awaiting_confirmation',
          sourceMessageId: 'assistant-msg-1',
          agentRole: 'scribe',
          importedAt: '2026-04-21T00:00:00.000Z',
          rows: [
            {
              rowId: 'row-valid',
              scenario: 'cover a valid dynamic trigger planning row',
              priority: 'P0',
              coverageReason: 'should be exportable when isolated',
              testType: 'trigger',
              loadingMode: 'dynamic',
              riskPoints: ['duplicate drafts'],
              keyAssertions: ['creates a draft case'],
              includeInMvp: true,
              draftingHints: {
                triggerPrompt: 'please load the demo skill and explain the main flow',
                expectedBehavior: 'reads the correct skill and explains the main flow',
              },
            },
            {
              rowId: 'row-invalid',
              scenario: 'cover an invalid short prompt row for rollback proof',
              priority: 'P1',
              coverageReason: 'forces export validation to fail after the first row',
              testType: 'trigger',
              loadingMode: 'dynamic',
              riskPoints: ['partial export'],
              keyAssertions: ['transaction should roll back'],
              includeInMvp: true,
              draftingHints: {
                triggerPrompt: 'bad',
                expectedBehavior: 'this row should fail validation',
              },
            },
          ],
        },
        confirmation: null,
        export: null,
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
      },
    },
    messages: [
      {
        id: 'assistant-msg-1',
        role: 'assistant',
        agentId: 'agent-builder',
        content: '```json\n{"kind":"skill_test_matrix"}\n```',
      },
    ],
  };
  const store = {
    db,
    getConversation(id) {
      return id === conversation.id ? conversation : null;
    },
    updateConversation(id, updates) {
      if (id !== conversation.id) {
        return null;
      }
      conversation = { ...conversation, ...updates };
      return conversation;
    },
  };
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['demo-skill']),
  });

  await assert.rejects(
    controller({
      req: createJsonRequest('POST', '/api/conversations/design-conv-export/skill-test-design/export-drafts', {
        matrixId: 'matrix-export-1',
        confirmMatrix: true,
        confirmationMessageId: 'assistant-msg-1',
        exportedBy: 'user',
      }),
      res: createCaptureResponse(),
      pathname: '/api/conversations/design-conv-export/skill-test-design/export-drafts',
      requestUrl: new URL('http://localhost/api/conversations/design-conv-export/skill-test-design/export-drafts'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(Array.isArray(err.issues));
      assert.ok(err.issues.length > 0);
      return true;
    }
  );

  const storedCases = db.prepare('SELECT COUNT(*) AS count FROM skill_test_cases WHERE skill_id = ?').get('demo-skill');
  assert.equal(storedCases.count, 0);
});

test('skill test design export-drafts records duplicate and skipped row summary in conversation export state', async () => {
  const db = createTestDb();
  let conversation = {
    id: 'design-conv-export-summary',
    title: 'Skill Test Design',
    type: 'skill_test_design',
    metadata: {
      skillTestDesign: {
        version: 1,
        skillId: 'demo-skill',
        skillName: 'Demo Skill',
        phase: 'awaiting_confirmation',
        participantRoles: { 'agent-builder': 'scribe' },
        matrix: {
          kind: 'skill_test_matrix',
          matrixId: 'matrix-export-summary-1',
          skillId: 'demo-skill',
          phase: 'awaiting_confirmation',
          sourceMessageId: 'assistant-msg-export-summary',
          agentRole: 'scribe',
          importedAt: '2026-04-21T00:00:00.000Z',
          rows: [
            {
              rowId: 'row-duplicate',
              scenario: 'cover duplicate prompt warning for chat generated draft export',
              priority: 'P0',
              coverageReason: 'export should proceed while reporting duplicate candidates',
              testType: 'trigger',
              loadingMode: 'dynamic',
              riskPoints: ['duplicate prompt'],
              keyAssertions: ['duplicate warning is returned and summarized'],
              includeInMvp: true,
              draftingHints: {
                triggerPrompt: 'please load the demo skill and explain the main flow',
                expectedBehavior: 'reads the correct skill and explains the main flow',
              },
            },
            {
              rowId: 'row-full-skipped',
              scenario: 'cover full execution row skipped by phase one export',
              priority: 'P1',
              coverageReason: 'Phase 1 should keep full execution rows out of dynamic trigger export',
              testType: 'execution',
              loadingMode: 'full',
              environmentSource: 'skill_contract',
              environmentContractRef: 'TESTING.md#Bootstrap',
              riskPoints: ['phase scope'],
              keyAssertions: ['skipped row is summarized'],
              includeInMvp: true,
              draftingHints: {
                triggerPrompt: 'please execute the full demo skill scenario',
                expectedBehavior: 'full execution remains out of Phase 1 export',
              },
            },
          ],
        },
        confirmation: null,
        export: null,
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
      },
    },
    messages: [
      {
        id: 'assistant-msg-export-summary',
        role: 'assistant',
        agentId: 'agent-builder',
        content: '```json\n{"kind":"skill_test_matrix"}\n```',
      },
    ],
  };
  const store = {
    db,
    getConversation(id) {
      return id === conversation.id ? conversation : null;
    },
    updateConversation(id, updates) {
      if (id !== conversation.id) {
        return null;
      }
      conversation = { ...conversation, ...updates };
      return conversation;
    },
  };
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['demo-skill']),
  });

  const createRes = createCaptureResponse();
  const created = await controller({
    req: createJsonRequest('POST', '/api/skills/demo-skill/test-cases', {
      skillId: 'demo-skill',
      loadingMode: 'dynamic',
      testType: 'trigger',
      userPrompt: 'please load the demo skill and explain the main flow',
      expectedBehavior: 'existing draft for duplicate warning coverage',
      caseStatus: 'draft',
    }),
    res: createRes,
    pathname: '/api/skills/demo-skill/test-cases',
    requestUrl: new URL('http://localhost/api/skills/demo-skill/test-cases'),
  });
  assert.equal(created, true);
  assert.equal(createRes.statusCode, 201);

  const res = createCaptureResponse();
  const handled = await controller({
    req: createJsonRequest('POST', '/api/conversations/design-conv-export-summary/skill-test-design/export-drafts', {
      matrixId: 'matrix-export-summary-1',
      confirmMatrix: true,
      confirmationMessageId: 'assistant-msg-export-summary',
      exportedBy: 'user',
    }),
    res,
    pathname: '/api/conversations/design-conv-export-summary/skill-test-design/export-drafts',
    requestUrl: new URL('http://localhost/api/conversations/design-conv-export-summary/skill-test-design/export-drafts'),
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.exportedCount, 1);
  assert.equal(res.json.cases.length, 1);
  assert.equal(res.json.duplicateWarnings.length, 1);
  assert.equal(res.json.duplicateWarnings[0].rowId, 'row-duplicate');
  assert.equal(res.json.skippedRows.length, 1);
  assert.equal(res.json.skippedRows[0].rowId, 'row-full-skipped');
  assert.match(res.json.skippedRows[0].nextAction, /后续 Phase/);
  assert.equal(res.json.state.export.exportedCount, 1);
  assert.equal(res.json.state.export.duplicateWarningCount, 1);
  assert.equal(res.json.state.export.skippedRowCount, 1);
  assert.deepEqual(res.json.state.export.exportedCaseIds, [res.json.cases[0].id]);
  assert.equal(conversation.metadata.skillTestDesign.export.duplicateWarningCount, 1);
  assert.equal(conversation.metadata.skillTestDesign.export.skippedRows[0].rowId, 'row-full-skipped');
  assert.match(conversation.metadata.skillTestDesign.export.skippedRows[0].nextAction, /后续 Phase/);
});

test('skill test design confirm-matrix rejects unresolved chain dependencies before export', async () => {
  const db = createTestDb();
  let conversation = {
    id: 'design-conv-confirm-chain',
    title: 'Skill Test Design',
    type: 'skill_test_design',
    metadata: {
      skillTestDesign: {
        version: 1,
        skillId: 'demo-skill',
        skillName: 'Demo Skill',
        phase: 'awaiting_confirmation',
        participantRoles: { 'agent-builder': 'scribe' },
        matrix: {
          kind: 'skill_test_matrix',
          matrixId: 'matrix-chain-confirm-1',
          skillId: 'demo-skill',
          phase: 'awaiting_confirmation',
          sourceMessageId: 'assistant-msg-chain-confirm',
          agentRole: 'scribe',
          importedAt: '2026-04-21T00:00:00.000Z',
          rows: [
            {
              rowId: 'row-chain-2',
              scenario: 'reuse the prepared environment for the next chain step',
              priority: 'P0',
              coverageReason: 'chain export should block when dependencies are broken',
              testType: 'trigger',
              loadingMode: 'dynamic',
              environmentSource: 'skill_contract',
              environmentContractRef: 'TESTING.md#Bootstrap',
              scenarioKind: 'chain_step',
              chainId: 'demo-chain',
              chainName: 'Demo Chain',
              sequenceIndex: 2,
              dependsOnRowIds: ['row-chain-missing'],
              inheritance: ['filesystem'],
              riskPoints: ['broken dependency graph'],
              keyAssertions: ['confirmation fails before export'],
              includeInMvp: true,
              draftingHints: {
                triggerPrompt: 'please continue the demo chain after bootstrap',
                expectedBehavior: 'uses the confirmed chain context',
              },
            },
          ],
        },
        confirmation: null,
        export: null,
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
      },
    },
    messages: [
      {
        id: 'assistant-msg-chain-confirm',
        role: 'assistant',
        agentId: 'agent-builder',
        content: 'MATRIX_ARTIFACT: .tmp/skill-test-design/demo-skill/matrix-chain-confirm-1.json',
      },
    ],
  };
  const store = {
    db,
    getConversation(id) {
      return id === conversation.id ? conversation : null;
    },
    updateConversation(id, updates) {
      if (id !== conversation.id) {
        return null;
      }
      conversation = { ...conversation, ...updates };
      return conversation;
    },
  };
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['demo-skill']),
  });

  await assert.rejects(
    controller({
      req: createJsonRequest('POST', '/api/conversations/design-conv-confirm-chain/skill-test-design/confirm-matrix', {
        matrixId: 'matrix-chain-confirm-1',
        confirmationMessageId: 'assistant-msg-chain-confirm',
      }),
      res: createCaptureResponse(),
      pathname: '/api/conversations/design-conv-confirm-chain/skill-test-design/confirm-matrix',
      requestUrl: new URL('http://localhost/api/conversations/design-conv-confirm-chain/skill-test-design/confirm-matrix'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.issues.some((issue) => issue.code === 'matrix_chain_dependency_missing'));
      return true;
    }
  );
});

test('skill test design export-drafts blocks execution rows when environmentSource is missing', async () => {
  const db = createTestDb();
  let conversation = {
    id: 'design-conv-env-gate',
    title: 'Skill Test Design',
    type: 'skill_test_design',
    metadata: {
      skillTestDesign: {
        version: 1,
        skillId: 'demo-skill',
        skillName: 'Demo Skill',
        phase: 'awaiting_confirmation',
        participantRoles: { 'agent-builder': 'scribe' },
        matrix: {
          kind: 'skill_test_matrix',
          matrixId: 'matrix-env-gate-1',
          skillId: 'demo-skill',
          phase: 'awaiting_confirmation',
          sourceMessageId: 'assistant-msg-env-gate',
          agentRole: 'scribe',
          importedAt: '2026-04-21T00:00:00.000Z',
          rows: [
            {
              rowId: 'row-execution-missing-env',
              scenario: 'run the full execution path that needs a real prepared environment',
              priority: 'P0',
              coverageReason: 'execution export must fail closed without a trusted environment contract',
              testType: 'execution',
              loadingMode: 'full',
              environmentSource: 'missing',
              riskPoints: ['unguarded export'],
              keyAssertions: ['formal export is blocked'],
              includeInMvp: true,
              draftingHints: {
                triggerPrompt: 'please complete the full execution path for the demo skill',
                expectedGoal: 'finish the full environment-dependent flow',
                expectedBehavior: 'requires a real prepared environment',
              },
            },
          ],
        },
        confirmation: null,
        export: null,
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
      },
    },
    messages: [
      {
        id: 'assistant-msg-env-gate',
        role: 'assistant',
        agentId: 'agent-builder',
        content: '```json\n{"kind":"skill_test_matrix"}\n```',
      },
    ],
  };
  const store = {
    db,
    getConversation(id) {
      return id === conversation.id ? conversation : null;
    },
    updateConversation(id, updates) {
      if (id !== conversation.id) {
        return null;
      }
      conversation = { ...conversation, ...updates };
      return conversation;
    },
  };
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['demo-skill']),
  });

  await assert.rejects(
    controller({
      req: createJsonRequest('POST', '/api/conversations/design-conv-env-gate/skill-test-design/export-drafts', {
        matrixId: 'matrix-env-gate-1',
        confirmMatrix: true,
        confirmationMessageId: 'assistant-msg-env-gate',
        exportedBy: 'user',
      }),
      res: createCaptureResponse(),
      pathname: '/api/conversations/design-conv-env-gate/skill-test-design/export-drafts',
      requestUrl: new URL('http://localhost/api/conversations/design-conv-env-gate/skill-test-design/export-drafts'),
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.issues.some((issue) => issue.code === 'matrix_environment_source_missing'));
      return true;
    }
  );

  const storedCases = db.prepare('SELECT COUNT(*) AS count FROM skill_test_cases WHERE skill_id = ?').get('demo-skill');
  assert.equal(storedCases.count, 0);
});

test('skill test design export-drafts preserves chain planning metadata and dependsOnCaseIds', async () => {
  const db = createTestDb();
  let conversation = {
    id: 'design-conv-chain-export',
    title: 'Skill Test Design',
    type: 'skill_test_design',
    metadata: {
      skillTestDesign: {
        version: 1,
        skillId: 'demo-skill',
        skillName: 'Demo Skill',
        phase: 'awaiting_confirmation',
        participantRoles: { 'agent-builder': 'scribe' },
        matrix: {
          kind: 'skill_test_matrix',
          matrixId: 'matrix-chain-export-1',
          skillId: 'demo-skill',
          phase: 'awaiting_confirmation',
          sourceMessageId: 'assistant-msg-chain-export',
          agentRole: 'scribe',
          importedAt: '2026-04-21T00:00:00.000Z',
          rows: [
            {
              rowId: 'row-chain-bootstrap',
              scenario: 'bootstrap the demo skill environment via the declared contract',
              priority: 'P0',
              coverageReason: 'first chain step prepares the reusable environment',
              testType: 'trigger',
              loadingMode: 'dynamic',
              environmentSource: 'skill_contract',
              environmentContractRef: 'TESTING.md#Bootstrap',
              scenarioKind: 'chain_step',
              chainId: 'demo-chain',
              chainName: 'Demo Chain',
              sequenceIndex: 1,
              dependsOnRowIds: [],
              inheritance: ['filesystem'],
              riskPoints: ['bootstrap drift'],
              keyAssertions: ['first step is exported as a draft'],
              includeInMvp: true,
              draftingHints: {
                triggerPrompt: 'please bootstrap the demo skill according to the testing contract',
                expectedBehavior: 'reads the contract and prepares the environment',
              },
            },
            {
              rowId: 'row-chain-verify',
              scenario: 'verify the follow-up trigger after bootstrap completes',
              priority: 'P1',
              coverageReason: 'second chain step reuses the planned environment metadata',
              testType: 'trigger',
              loadingMode: 'dynamic',
              environmentSource: 'skill_contract',
              environmentContractRef: 'TESTING.md#Verification',
              scenarioKind: 'chain_step',
              chainId: 'demo-chain',
              chainName: 'Demo Chain',
              sequenceIndex: 2,
              dependsOnRowIds: ['row-chain-bootstrap'],
              inheritance: ['filesystem', 'artifacts'],
              riskPoints: ['dependency mapping'],
              keyAssertions: ['dependsOnCaseIds is preserved'],
              includeInMvp: true,
              draftingHints: {
                triggerPrompt: 'please verify the demo skill after bootstrap using the same planned chain',
                expectedBehavior: 'continues from the planned chain metadata',
              },
            },
          ],
        },
        confirmation: null,
        export: null,
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
      },
    },
    messages: [
      {
        id: 'assistant-msg-chain-export',
        role: 'assistant',
        agentId: 'agent-builder',
        content: 'MATRIX_ARTIFACT: .tmp/skill-test-design/demo-skill/matrix-chain-export-1.json',
      },
    ],
  };
  const store = {
    db,
    getConversation(id) {
      return id === conversation.id ? conversation : null;
    },
    updateConversation(id, updates) {
      if (id !== conversation.id) {
        return null;
      }
      conversation = { ...conversation, ...updates };
      return conversation;
    },
  };
  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['demo-skill']),
  });

  const res = createCaptureResponse();
  const handled = await controller({
    req: createJsonRequest('POST', '/api/conversations/design-conv-chain-export/skill-test-design/export-drafts', {
      matrixId: 'matrix-chain-export-1',
      confirmMatrix: true,
      confirmationMessageId: 'assistant-msg-chain-export',
      exportedBy: 'user',
    }),
    res,
    pathname: '/api/conversations/design-conv-chain-export/skill-test-design/export-drafts',
    requestUrl: new URL('http://localhost/api/conversations/design-conv-chain-export/skill-test-design/export-drafts'),
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.exportedCount, 2);
  assert.equal(res.json.cases.length, 2);

  const byRowId = new Map(res.json.cases.map((testCase) => [testCase.sourceMetadata.matrixRowId, testCase]));
  const bootstrapCase = byRowId.get('row-chain-bootstrap');
  const verifyCase = byRowId.get('row-chain-verify');
  assert.ok(bootstrapCase);
  assert.ok(verifyCase);
  assert.equal(bootstrapCase.sourceMetadata.skillTestDesign.environmentContractRef, 'TESTING.md#Bootstrap');
  assert.equal(bootstrapCase.sourceMetadata.skillTestDesign.environmentSource, 'skill_contract');
  assert.equal(bootstrapCase.sourceMetadata.skillTestDesign.chainPlanning.exportedCaseId, bootstrapCase.id);
  assert.deepEqual(bootstrapCase.sourceMetadata.skillTestDesign.chainPlanning.dependsOnCaseIds, []);
  assert.equal(verifyCase.sourceMetadata.skillTestDesign.environmentContractRef, 'TESTING.md#Verification');
  assert.equal(verifyCase.sourceMetadata.skillTestDesign.chainPlanning.exportChainId, 'demo-chain');
  assert.equal(verifyCase.sourceMetadata.skillTestDesign.chainPlanning.exportedCaseId, verifyCase.id);
  assert.deepEqual(verifyCase.sourceMetadata.skillTestDesign.chainPlanning.dependsOnRowIds, ['row-chain-bootstrap']);
  assert.deepEqual(verifyCase.sourceMetadata.skillTestDesign.chainPlanning.dependsOnCaseIds, [bootstrapCase.id]);

  const storedCases = db.prepare('SELECT id, source_metadata_json FROM skill_test_cases WHERE skill_id = ? ORDER BY created_at ASC').all('demo-skill');
  assert.equal(storedCases.length, 2);
  const storedById = new Map(storedCases.map((row) => [row.id, JSON.parse(row.source_metadata_json)]));
  assert.deepEqual(storedById.get(verifyCase.id).skillTestDesign.chainPlanning.dependsOnCaseIds, [bootstrapCase.id]);
});
