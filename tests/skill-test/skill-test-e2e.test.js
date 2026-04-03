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
      skillMap.set(entry, { id: entry, name: entry, description: '' });
      continue;
    }
    if (entry && entry.id) {
      skillMap.set(entry.id, {
        id: entry.id,
        name: entry.name || entry.id,
        description: entry.description || '',
        body: entry.body || '',
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

test('generate auto-smoke-validates and updates validity_status', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);

  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['werewolf']),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
    startRunImpl: () => {
      return {
        runId: 'run-1',
        sessionPath: '/tmp/session',
        resultPromise: Promise.resolve({ reply: 'ok', runId: 'run-1', sessionPath: '/tmp/session' }),
      };
    },
    // We inject evaluation to avoid depending on a2a_task_events/session JSONL setup.
    evaluateRunImpl: (_taskId, _testCase) => {
      return {
        triggerPassed: 1,
        executionPassed: 1,
        toolAccuracy: 1,
        actualToolsJson: JSON.stringify(['read-skill']),
      };
    },
  });

  const req = createJsonRequest('POST', '/api/skills/werewolf/test-cases/generate', {
    count: 2,
    loadingMode: 'dynamic',
    testType: 'trigger',
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
  assert.ok(Array.isArray(res.json.cases));
  assert.ok(res.json.cases.length >= 2);

  // In unit env we don't have real a2a_task_events/session JSONL,
  // so even with injected startRun/evaluateRun the controller may still
  // classify cases as invalid based on other gates. Assert at least that
  // smoke validation ran and produced non-pending statuses.
  const statuses = new Set(res.json.cases.map((c) => c.validityStatus));
  assert.ok(statuses.size >= 1);
  assert.ok(!statuses.has('pending'));

  const rows = db
    .prepare('SELECT trigger_prompt, validity_status FROM skill_test_cases WHERE skill_id = ?')
    .all('werewolf');
  assert.ok(rows.length >= 2);

  db.close();
});

test('generate preserves requested loadingMode and testType', async () => {
  const db = createTestDb();
  const store = createInMemoryStore(db);

  const controller = createSkillTestController({
    store,
    agentToolBridge: createFakeAgentToolBridge(),
    skillRegistry: createFakeSkillRegistry(['werewolf']),
    getProjectDir: () => '/tmp/project',
    toolBaseUrl: 'http://127.0.0.1:3100',
    startRunImpl: () => {
      return {
        runId: 'run-full-generate',
        sessionPath: '/tmp/session-generate',
        resultPromise: Promise.resolve({ reply: 'ok', runId: 'run-full-generate', sessionPath: '/tmp/session-generate' }),
      };
    },
    evaluateRunImpl: () => {
      return {
        triggerPassed: 1,
        executionPassed: 1,
        toolAccuracy: 1,
        actualToolsJson: JSON.stringify([]),
      };
    },
  });

  const req = createJsonRequest('POST', '/api/skills/werewolf/test-cases/generate', {
    count: 1,
    loadingMode: 'full',
    testType: 'execution',
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
  assert.ok(Array.isArray(res.json.cases));
  assert.ok(res.json.cases.length >= 1);
  assert.ok(res.json.cases.every((testCase) => testCase.loadingMode === 'full'));
  assert.ok(res.json.cases.every((testCase) => testCase.testType === 'execution'));

  const rows = db
    .prepare('SELECT loading_mode, test_type FROM skill_test_cases WHERE skill_id = ?')
    .all('werewolf');
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => row.loading_mode === 'full'));
  assert.ok(rows.every((row) => row.test_type === 'execution'));

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
      startRunImpl: () => {
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
    assert.equal(runRes.json.run.executionPassed, true);

    const row = harness.db
      .prepare('SELECT trigger_passed, execution_passed FROM skill_test_runs ORDER BY created_at DESC LIMIT 1')
      .get();
    assert.equal(row.trigger_passed, 1);
    assert.equal(row.execution_passed, 1);
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
    assert.equal(runRes.json.run.executionPassed, true);
    assert.equal(callCount, 2);

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
    assert.equal(runRes.json.run.executionPassed, true);
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
    assert.equal(detailRes.json.result.executionEvaluation.usedSequenceValidation, true);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.enabled, true);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.passed, true);
    assert.equal(detailRes.json.result.executionEvaluation.sequenceCheck.matchedCount, 2);
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
          actualToolsJson: JSON.stringify(['read-skill']),
        };
      },
    });

    const createReq = createJsonRequest('POST', '/api/skills/werewolf/test-cases', {
      testType: 'execution',
      loadingMode: 'dynamic',
      triggerPrompt: '我们来玩狼人杀吧',
      expectedTools: ['read-skill'],
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
