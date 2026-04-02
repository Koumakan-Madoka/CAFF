import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import { resolveToolRelativePath } from '../http/path-utils';
import { migrateSkillTestSchema } from '../../storage/sqlite/migrations';
import { DEFAULT_THINKING, resolveSetting, startRun } from '../../lib/minimal-pi';
import { createSqliteRunStore } from '../../lib/sqlite-store';
import { generateSkillTestPrompts } from '../../lib/skill-test-generator';
import { ROOT_DIR } from '../app/config';
import { ensureAgentSandbox, toPortableShellPath } from '../domain/conversation/turn/agent-sandbox';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value: any) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeTestCaseRow(row: any) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  return {
    id: String(row.id || '').trim(),
    skillId: String(row.skill_id || '').trim(),
    evalCaseId: row.eval_case_id ? String(row.eval_case_id).trim() : null,
    testType: String(row.test_type || 'trigger').trim(),
    loadingMode: String(row.loading_mode || 'dynamic').trim(),
    triggerPrompt: String(row.trigger_prompt || '').trim(),
    expectedTools: safeJsonParse(row.expected_tools_json) || [],
    expectedBehavior: String(row.expected_behavior || '').trim(),
    validityStatus: String(row.validity_status || 'pending').trim(),
    note: String(row.note || '').trim(),
    createdAt: String(row.created_at || '').trim(),
    updatedAt: String(row.updated_at || '').trim(),
  };
}

function normalizeTestRunRow(row: any) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  return {
    id: String(row.id || '').trim(),
    testCaseId: String(row.test_case_id || '').trim(),
    evalCaseRunId: row.eval_case_run_id ? String(row.eval_case_run_id).trim() : null,
    status: String(row.status || 'pending').trim(),
    actualTools: safeJsonParse(row.actual_tools_json) || [],
    toolAccuracy: row.tool_accuracy != null ? Number(row.tool_accuracy) : null,
    triggerPassed: row.trigger_passed != null ? Boolean(row.trigger_passed) : null,
    executionPassed: row.execution_passed != null ? Boolean(row.execution_passed) : null,
    errorMessage: String(row.error_message || '').trim(),
    createdAt: String(row.created_at || '').trim(),
  };
}

// resolveToolRelativePath is now imported from ../http/path-utils

export function createSkillTestController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  const agentToolBridge = options.agentToolBridge;
  const skillRegistry = options.skillRegistry;
  const getProjectDir = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  const toolBaseUrl = String(options.toolBaseUrl || '').trim() || 'http://127.0.0.1:3100';
  let schemaReady = false;

  if (!store || !store.db) {
    return async function handleMissingSkillTestController(context) {
      const { req, pathname } = context;
      if (pathname.startsWith('/api/skill-test') && req.method) {
        throw createHttpError(501, 'Skill test store is not configured');
      }
      return false;
    };
  }

  function ensureSchema() {
    if (schemaReady) {
      return;
    }
    migrateSkillTestSchema(store.db);
    schemaReady = true;
  }

  // ---- Query helpers ----

  function listTestCases(skillId: string, limit = 100) {
    ensureSchema();
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    const rows = store.db
      .prepare(
        `SELECT * FROM skill_test_cases
         WHERE skill_id = @skillId
         ORDER BY created_at DESC
         LIMIT @limit`
      )
      .all({ skillId, limit: safeLimit });
    return rows.map(normalizeTestCaseRow).filter(Boolean);
  }

  function getTestCase(caseId: string) {
    ensureSchema();
    const row = store.db
      .prepare('SELECT * FROM skill_test_cases WHERE id = @id')
      .get({ id: caseId });
    return normalizeTestCaseRow(row);
  }

  function createTestCase(input: any) {
    ensureSchema();
    const skillId = String(input.skillId || '').trim();
    const testType = String(input.testType || 'trigger').trim();
    const loadingMode = String(input.loadingMode || 'dynamic').trim();
    const triggerPrompt = String(input.triggerPrompt || input.trigger_prompt || '').trim();
    const expectedTools = Array.isArray(input.expectedTools || input.expected_tools)
      ? input.expectedTools || input.expected_tools
      : [];
    const expectedBehavior = String(input.expectedBehavior || input.expected_behavior || '').trim();
    const note = String(input.note || '').trim();

    if (!skillId) {
      throw createHttpError(400, 'skillId is required');
    }
    // Validate enum fields
    const validTestTypes = new Set(['trigger', 'execution']);
    const validLoadingModes = new Set(['dynamic', 'full']);
    if (!validTestTypes.has(testType)) {
      throw createHttpError(400, `testType must be one of: ${[...validTestTypes].join(', ')}`);
    }
    if (!validLoadingModes.has(loadingMode)) {
      throw createHttpError(400, `loadingMode must be one of: ${[...validLoadingModes].join(', ')}`);
    }

    if (!triggerPrompt) {
      throw createHttpError(400, 'triggerPrompt is required');
    }
    if (triggerPrompt.length < 5) {
      throw createHttpError(400, 'triggerPrompt is too short (minimum 5 characters)');
    }
    if (triggerPrompt.length > 2000) {
      throw createHttpError(400, 'triggerPrompt is too long (maximum 2000 characters)');
    }

    const id = randomUUID();
    const timestamp = nowIso();

    store.db
      .prepare(
        `INSERT INTO skill_test_cases (
          id, skill_id, test_type, loading_mode, trigger_prompt,
          expected_tools_json, expected_behavior, validity_status, note,
          created_at, updated_at
        ) VALUES (
          @id, @skillId, @testType, @loadingMode, @triggerPrompt,
          @expectedToolsJson, @expectedBehavior, @validityStatus, @note,
          @createdAt, @updatedAt
        )`
      )
      .run({
        id,
        skillId,
        testType,
        loadingMode,
        triggerPrompt,
        expectedToolsJson: JSON.stringify(expectedTools),
        expectedBehavior,
        validityStatus: 'pending',
        note,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

    return getTestCase(id);
  }

  function listTestRuns(skillId: string, limit = 100) {
    ensureSchema();
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    const rows = store.db
      .prepare(
        `SELECT r.* FROM skill_test_runs r
         INNER JOIN skill_test_cases c ON r.test_case_id = c.id
         WHERE c.skill_id = @skillId
         ORDER BY r.created_at DESC
         LIMIT @limit`
      )
      .all({ skillId, limit: safeLimit });
    return rows.map(normalizeTestRunRow).filter(Boolean);
  }

  // ---- Run execution ----

  function collectToolCallsFromTask(taskId: string) {
    ensureSchema();
    let rows: any[] = [];
    try {
      rows = store.db
        .prepare(
          `SELECT event_json FROM a2a_task_events
           WHERE task_id = @taskId AND event_type = 'agent_tool_call'
           ORDER BY id ASC LIMIT 200`
        )
        .all({ taskId });
    } catch {
      rows = [];
    }
    return rows
      .map((row) => safeJsonParse(row.event_json))
      .filter(Boolean);
  }

  function evaluateRun(taskId: string, testCase: any) {
    const toolCallEvents = collectToolCallsFromTask(taskId);
    const expectedTools: string[] = Array.isArray(testCase.expectedTools) ? testCase.expectedTools : [];

    // Step 1: trigger check — did the agent call read-skill for this skill?
    let triggerPassed = false;
    const actualTools: string[] = [];

    for (const event of toolCallEvents) {
      const toolName = String(event.tool || '').trim();
      actualTools.push(toolName);

      if (
        toolName === 'read-skill' &&
        event.request &&
        String(event.request.skillId || '').trim() === testCase.skillId
      ) {
        triggerPassed = true;
      }
    }

    // Step 2: execution check — tool name matching (only if trigger passed)
    let toolAccuracy: number | null = null;
    let executionPassed: number | null = null;

    const EXECUTION_THRESHOLD = 0.8; // configurable — 80% tool match rate required

    if (triggerPassed && expectedTools.length > 0) {
      const matched = expectedTools.filter((expected) =>
        actualTools.some((actual) => actual === expected)
      );
      toolAccuracy = matched.length / expectedTools.length;
      executionPassed = toolAccuracy >= EXECUTION_THRESHOLD ? 1 : 0;
    } else if (triggerPassed && expectedTools.length === 0) {
      toolAccuracy = 1;
      executionPassed = 1;
    }

    return {
      triggerPassed: triggerPassed ? 1 : 0,
      executionPassed,
      toolAccuracy,
      actualToolsJson: JSON.stringify([...new Set(actualTools)]),
    };
  }

  async function executeRun(testCase: any, runOptions: any = {}) {
    ensureSchema();

    if (!agentToolBridge) {
      throw createHttpError(501, 'Agent tool bridge is not configured');
    }

    const prompt = String(testCase.triggerPrompt || '').trim();
    if (!prompt) {
      throw createHttpError(400, 'Test case has no trigger prompt');
    }

    const skill = skillRegistry ? skillRegistry.getSkill(testCase.skillId) : null;
    const agentId = String(runOptions.agentId || 'skill-test-agent').trim();
    const agentName = String(runOptions.agentName || 'Skill Test Agent').trim();
    const provider = String(runOptions.provider || '').trim();
    const model = String(runOptions.model || '').trim();

    // Create or reuse eval_case for this test case
    // Only create a new one if the test case doesn't already have one
    let evalCaseId = testCase.evalCaseId;
    const timestamp = nowIso();

    if (!evalCaseId) {
      evalCaseId = randomUUID();

      store.db
        .prepare(
          `INSERT INTO eval_cases (
            id, conversation_id, turn_id, message_id, stage_task_id,
            agent_id, agent_name, provider, model, thinking,
            prompt_version, expectations_json,
            prompt_a, output_a, note,
            created_at, updated_at
          ) VALUES (
            @id, @conversationId, @turnId, @messageId, @stageTaskId,
            @agentId, @agentName, @provider, @model, @thinking,
            @promptVersion, @expectationsJson,
            @promptA, @outputA, @note,
            @createdAt, @updatedAt
          )`
        )
        .run({
          id: evalCaseId,
          conversationId: `skill-test-${testCase.skillId}`,
          turnId: `skill-test-turn-${testCase.id}`,
          messageId: '',
          stageTaskId: '',
          agentId,
          agentName,
          provider: provider || null,
          model: model || null,
          thinking: null,
          promptVersion: 'skill-test-v1',
          expectationsJson: JSON.stringify({
            source: 'skill_test',
            skillId: testCase.skillId,
            expectedTools: testCase.expectedTools || [],
          }),
          promptA: prompt,
          outputA: '',
          note: `Skill test: ${testCase.skillId} (${testCase.testType})`,
          createdAt: timestamp,
          updatedAt: timestamp,
        });

      // Update test case with eval_case_id (only when newly created)
      store.db
        .prepare('UPDATE skill_test_cases SET eval_case_id = @evalCaseId, updated_at = @updatedAt WHERE id = @id')
        .run({ id: testCase.id, evalCaseId, updatedAt: timestamp });
    }

    // Set up run infrastructure
    const agent = { id: agentId, name: agentName };
    const sandbox = ensureAgentSandbox(store.agentDir, agent);
    const projectDir = getProjectDir ? String(getProjectDir() || '').trim() : '';
    const runStore = createSqliteRunStore({ agentDir: store.agentDir, sqlitePath: store.databasePath });
    const taskId = `skill-test-run-${randomUUID()}`;
    const stage = { taskId, status: 'queued', runId: null as any };
    const sessionName = `skill-test-${testCase.id}-${Date.now()}`;

    let toolInvocation: any = null;

    try {
      const promptUserMessage = {
        id: 'skill-test-user',
        turnId: `skill-test-turn-${testCase.id}`,
        role: 'user',
        senderName: 'TestUser',
        content: prompt,
        status: 'completed',
        createdAt: timestamp,
      };

      toolInvocation = agentToolBridge.registerInvocation(
        agentToolBridge.createInvocationContext({
          conversationId: `skill-test-${testCase.skillId}`,
          turnId: `skill-test-turn-${testCase.id}`,
          projectDir,
          agentId,
          agentName,
          assistantMessageId: '',
          userMessageId: promptUserMessage.id,
          promptUserMessage,
          conversationAgents: [agent],
          runStore,
          stage,
          turnState: null,
          enqueueAgent: null,
          allowHandoffs: false,
          dryRun: true,
        })
      );

      const agentToolScriptPath = path.resolve(ROOT_DIR, 'lib', 'agent-chat-tools.js');
      const agentToolRelativePath = resolveToolRelativePath(agentToolScriptPath);

      runStore.createTask({
        taskId,
        kind: 'skill_test_run',
        title: `Skill test: ${testCase.skillId}`,
        status: 'queued',
        assignedAgent: 'pi',
        assignedRole: agentName,
        provider: provider || null,
        model: model || null,
        requestedSession: sessionName,
        sessionPath: null,
        inputText: prompt,
        metadata: {
          testCaseId: testCase.id,
          skillId: testCase.skillId,
          evalCaseId,
          source: 'skill_test',
          toolBridgeEnabled: true,
          toolBridgeDryRun: true,
        },
        startedAt: timestamp,
      });

      let result: any = null;
      let outputText = '';
      let status = 'succeeded';
      let errorMessage = '';
      let runId: any = null;
      let sessionPath = '';

      try {
        const handle = startRun(provider || '', model || '', prompt, {
          thinking: '',
          agentDir: store.agentDir,
          sqlitePath: store.databasePath,
          streamOutput: false,
          session: sessionName,
          taskId,
          taskKind: 'skill_test_run',
          taskRole: agentName,
          metadata: {
            testCaseId: testCase.id,
            skillId: testCase.skillId,
            evalCaseId,
            source: 'skill_test',
          },
          extraEnv: {
            PI_AGENT_ID: agentId,
            PI_AGENT_NAME: agentName,
            PI_AGENT_SANDBOX_DIR: sandbox.sandboxDir,
            PI_AGENT_PRIVATE_DIR: sandbox.privateDir,
            CAFF_CHAT_API_URL: toolBaseUrl,
            CAFF_CHAT_INVOCATION_ID: toolInvocation.invocationId,
            CAFF_CHAT_CALLBACK_TOKEN: toolInvocation.callbackToken,
            CAFF_CHAT_TOOLS_PATH: toPortableShellPath(agentToolScriptPath),
            CAFF_CHAT_TOOLS_RELATIVE_PATH: agentToolRelativePath,
            CAFF_CHAT_CONVERSATION_ID: `skill-test-${testCase.skillId}`,
            CAFF_CHAT_TURN_ID: `skill-test-turn-${testCase.id}`,
            CAFF_SKILL_LOADING_MODE: testCase.loadingMode || 'dynamic',
          },
        });

        stage.runId = handle.runId || null;
        stage.status = 'running';
        sessionPath = handle.sessionPath || '';

        runStore.updateTask(taskId, {
          status: 'running',
          runId: handle.runId || null,
          requestedSession: sessionName,
          sessionPath: handle.sessionPath || null,
        });

        result = await handle.resultPromise;
        runId = result && result.runId ? result.runId : handle.runId || null;
        sessionPath = (result && result.sessionPath) || sessionPath;
        outputText = String(result.reply || '');
        status = 'succeeded';
      } catch (error) {
        const err: any = error;
        status = 'failed';
        errorMessage = err && err.message ? String(err.message) : String(err || 'Unknown error');
      } finally {
        stage.status = status === 'succeeded' ? 'completed' : 'failed';
        if (toolInvocation) {
          agentToolBridge.unregisterInvocation(toolInvocation.invocationId);
        }
      }

      // Evaluate results
      const evaluation = status === 'succeeded' ? evaluateRun(taskId, testCase) : {
        triggerPassed: 0,
        executionPassed: null,
        toolAccuracy: null,
        actualToolsJson: '[]',
      };

      const finishedAt = nowIso();

      // Update task
      runStore.updateTask(taskId, {
        status: status === 'succeeded' ? 'succeeded' : 'failed',
        runId,
        sessionPath: sessionPath || null,
        outputText: outputText || '',
        errorMessage: errorMessage || '',
        endedAt: finishedAt,
      });

      // Create eval_case_run
      const evalCaseRunId = randomUUID();
      const runResult = {
        status,
        triggerPassed: evaluation.triggerPassed,
        executionPassed: evaluation.executionPassed,
        toolAccuracy: evaluation.toolAccuracy,
        actualTools: safeJsonParse(evaluation.actualToolsJson) || [],
        source: 'skill_test',
      };

      store.db
        .prepare(
          `INSERT INTO eval_case_runs (
            id, case_id, variant, provider, model, thinking,
            prompt, run_id, task_id, status, error_message,
            output_text, result_json, session_path, created_at
          ) VALUES (
            @id, @caseId, @variant, @provider, @model, @thinking,
            @prompt, @runId, @taskId, @status, @errorMessage,
            @outputText, @resultJson, @sessionPath, @createdAt
          )`
        )
        .run({
          id: evalCaseRunId,
          caseId: evalCaseId,
          variant: 'B',
          provider: provider || null,
          model: model || null,
          thinking: null,
          prompt,
          runId,
          taskId,
          status,
          errorMessage: errorMessage || null,
          outputText: outputText || null,
          resultJson: JSON.stringify(runResult),
          sessionPath: sessionPath || null,
          createdAt: finishedAt,
        });

      // Create skill_test_run
      const testRunId = randomUUID();
      store.db
        .prepare(
          `INSERT INTO skill_test_runs (
            id, test_case_id, eval_case_run_id, status,
            actual_tools_json, tool_accuracy, trigger_passed, execution_passed,
            error_message, created_at
          ) VALUES (
            @id, @testCaseId, @evalCaseRunId, @status,
            @actualToolsJson, @toolAccuracy, @triggerPassed, @executionPassed,
            @errorMessage, @createdAt
          )`
        )
        .run({
          id: testRunId,
          testCaseId: testCase.id,
          evalCaseRunId,
          status,
          actualToolsJson: evaluation.actualToolsJson,
          toolAccuracy: evaluation.toolAccuracy,
          triggerPassed: evaluation.triggerPassed,
          executionPassed: evaluation.executionPassed,
          errorMessage: errorMessage || '',
          createdAt: finishedAt,
        });

      // Update test case validity_status based on trigger result
      // Only transition from 'pending' — never downgrade 'validated' to 'invalid'
      // to avoid false negatives from transient environment issues
      if (testCase.validityStatus === 'pending') {
        const newValidity = evaluation.triggerPassed ? 'validated' : 'needs_review';
        store.db
          .prepare(
            'UPDATE skill_test_cases SET validity_status = @validityStatus, updated_at = @updatedAt WHERE id = @id'
          )
          .run({ id: testCase.id, validityStatus: newValidity, updatedAt: finishedAt });
      }

      const runRow = store.db.prepare('SELECT * FROM skill_test_runs WHERE id = @id').get({ id: testRunId });
      return {
        testCase: getTestCase(testCase.id),
        run: normalizeTestRunRow(runRow),
      };
    } finally {
      runStore.close();
    }
  }

  function getSkillTestSummary() {
    ensureSchema();

    const rows = store.db
      .prepare(
        `SELECT
          c.skill_id,
          c.validity_status,
          COUNT(c.id) AS case_count,
          COALESCE(SUM(CASE WHEN r.trigger_passed = 1 THEN 1 ELSE 0 END), 0) AS trigger_passed_count,
          COALESCE(SUM(CASE WHEN r.execution_passed = 1 THEN 1 ELSE 0 END), 0) AS execution_passed_count,
          COALESCE(SUM(CASE WHEN r.trigger_passed IS NOT NULL THEN 1 ELSE 0 END), 0) AS total_runs,
          COALESCE(AVG(CASE WHEN r.tool_accuracy IS NOT NULL THEN r.tool_accuracy END), 0) AS avg_tool_accuracy
         FROM skill_test_cases c
         LEFT JOIN skill_test_runs r ON r.test_case_id = c.id
         GROUP BY c.skill_id, c.validity_status
         ORDER BY c.skill_id`
      )
      .all();

    const summary: Record<string, any> = {};

    for (const row of rows) {
      const skillId = String(row.skill_id || '').trim();
      if (!summary[skillId]) {
        summary[skillId] = {
          skillId,
          casesByValidity: {},
          totalCases: 0,
          totalRuns: 0,
          triggerPassedCount: 0,
          executionPassedCount: 0,
          avgToolAccuracy: 0,
        };
      }
      const bucket = summary[skillId];
      bucket.casesByValidity[String(row.validity_status || 'pending')] = Number(row.case_count || 0);
      bucket.totalCases += Number(row.case_count || 0);
      bucket.totalRuns += Number(row.total_runs || 0);
      bucket.triggerPassedCount += Number(row.trigger_passed_count || 0);
      bucket.executionPassedCount += Number(row.execution_passed_count || 0);
      bucket.avgToolAccuracy = Number(row.avg_tool_accuracy || 0);
    }

    // Compute rates
    for (const entry of Object.values(summary) as any[]) {
      entry.triggerRate = entry.totalRuns > 0 ? entry.triggerPassedCount / entry.totalRuns : null;
      entry.executionRate =
        entry.triggerPassedCount > 0 ? entry.executionPassedCount / entry.triggerPassedCount : null;
    }

    return Object.values(summary);
  }

  return async function handleSkillTestRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    // ---- Global summary ----
    if (req.method === 'GET' && pathname === '/api/skill-test-summary') {
      sendJson(res, 200, { summary: getSkillTestSummary() });
      return true;
    }

    // ---- Skill-scoped routes: /api/skills/:skillId/test-cases/... ----
    const testCasesBaseMatch = pathname.match(/^\/api\/skills\/([^/]+)\/test-cases(?:\/|$)(.*)/);
    if (testCasesBaseMatch) {
      const skillId = decodeURIComponent(testCasesBaseMatch[1]);
      const subPath = testCasesBaseMatch[2] || '';

      // GET /api/skills/:skillId/test-cases — list
      if (req.method === 'GET' && !subPath) {
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '', 10);
        sendJson(res, 200, { cases: listTestCases(skillId, limit) });
        return true;
      }

      // POST /api/skills/:skillId/test-cases/generate — AI generate
      if (req.method === 'POST' && subPath === 'generate') {
        const skill = skillRegistry ? skillRegistry.getSkill(skillId) : null;
        if (!skill) {
          throw createHttpError(404, `Skill not found: ${skillId}`);
        }

        const body = await readRequestJson(req).catch(() => ({}));
        const count = Math.max(1, Math.min(10, Number(body.count || 3)));
        const prompts = generateSkillTestPrompts(skill, { count });

        const cases: any[] = [];
        for (const prompt of prompts) {
          const tc = createTestCase({
            skillId,
            testType: 'trigger',
            loadingMode: 'dynamic',
            triggerPrompt: prompt.triggerPrompt,
            expectedTools: prompt.expectedTools || [],
            expectedBehavior: prompt.expectedBehavior || '',
            note: prompt.note || 'Auto-generated',
          });
          if (tc) {
            cases.push(tc);
          }
        }

        sendJson(res, 201, { generated: cases.length, cases });
        return true;
      }

      // POST /api/skills/:skillId/test-cases — manual create
      if (req.method === 'POST' && !subPath) {
        const body = await readRequestJson(req);
        const tc = createTestCase({
          ...body,
          skillId,
        });
        sendJson(res, 201, { testCase: tc });
        return true;
      }

      // POST /api/skills/:skillId/test-cases/run-all — run all validated cases
      if (req.method === 'POST' && subPath === 'run-all') {
        ensureSchema();
        const cases = store.db
          .prepare(
            `SELECT * FROM skill_test_cases
             WHERE skill_id = @skillId AND validity_status = 'validated'
             ORDER BY created_at ASC`
          )
          .all({ skillId });

        if (cases.length === 0) {
          throw createHttpError(404, 'No test cases to run');
        }

        const body = await readRequestJson(req).catch(() => ({}));
        const results: any[] = [];

        for (const caseRow of cases) {
          const testCase = normalizeTestCaseRow(caseRow);
          if (!testCase) continue;
          try {
            const result = await executeRun(testCase, {
              provider: body.provider,
              model: body.model,
            });
            results.push(result);
          } catch (error: any) {
            results.push({
              testCase,
              run: null,
              error: String(error.message || error),
            });
          }
        }

        sendJson(res, 200, { total: results.length, results });
        return true;
      }

      // Sub-resource routes: :caseId/...
      const subMatch = subPath.match(/^([^/]+)(?:\/(.*))?$/);
      if (subMatch) {
        const caseId = decodeURIComponent(subMatch[1]);
        const action = subMatch[2] || '';

        // GET /api/skills/:skillId/test-cases/:caseId/runs — runs for specific case
        if (req.method === 'GET' && action === 'runs') {
          ensureSchema();
          const runsLimit = Number.parseInt(requestUrl.searchParams.get('limit') || '', 10);
          const safeRunsLimit = Number.isInteger(runsLimit) && runsLimit > 0 ? Math.min(runsLimit, 500) : 50;
          const rows = store.db
            .prepare(
              `SELECT * FROM skill_test_runs
               WHERE test_case_id = @caseId
               ORDER BY created_at DESC
               LIMIT @limit`
            )
            .all({ caseId, limit: safeRunsLimit });
          sendJson(res, 200, { runs: rows.map(normalizeTestRunRow).filter(Boolean) });
          return true;
        }

        // POST /api/skills/:skillId/test-cases/:caseId/run
        if (req.method === 'POST' && action === 'run') {
          const testCase = getTestCase(caseId);
          if (!testCase) {
            throw createHttpError(404, 'Test case not found');
          }

          const body = await readRequestJson(req).catch(() => ({}));
          const result = await executeRun(testCase, {
            provider: body.provider,
            model: body.model,
          });
          sendJson(res, 200, result);
          return true;
        }

        // GET /api/skills/:skillId/test-cases/:caseId
        if (req.method === 'GET' && !action) {
          const testCase = getTestCase(caseId);
          if (!testCase) {
            throw createHttpError(404, 'Test case not found');
          }
          sendJson(res, 200, { testCase });
          return true;
        }

        // DELETE /api/skills/:skillId/test-cases/:caseId
        if (req.method === 'DELETE' && !action) {
          ensureSchema();
          const existing = getTestCase(caseId);
          if (!existing) {
            throw createHttpError(404, 'Test case not found');
          }
          store.db.prepare('DELETE FROM skill_test_runs WHERE test_case_id = @id').run({ id: caseId });
          store.db.prepare('DELETE FROM skill_test_cases WHERE id = @id').run({ id: caseId });
          sendJson(res, 200, { deletedId: caseId });
          return true;
        }
      }
    }

    // ---- Skill-scoped runs: /api/skills/:skillId/test-runs ----
    const testRunsMatch = pathname.match(/^\/api\/skills\/([^/]+)\/test-runs$/);
    if (testRunsMatch && req.method === 'GET') {
      const skillId = decodeURIComponent(testRunsMatch[1]);
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '', 10);
      sendJson(res, 200, { runs: listTestRuns(skillId, limit) });
      return true;
    }

    // ---- Single run detail: /api/skill-test-runs/:runId ----
    const runDetailMatch = pathname.match(/^\/api\/skill-test-runs\/([^/]+)$/);
    if (runDetailMatch && req.method === 'GET') {
      ensureSchema();
      const runId = decodeURIComponent(runDetailMatch[1]);
      const row = store.db.prepare('SELECT * FROM skill_test_runs WHERE id = @id').get({ id: runId });
      const run = normalizeTestRunRow(row);
      if (!run) {
        throw createHttpError(404, 'Test run not found');
      }
      sendJson(res, 200, { run });
      return true;
    }

    return false;
  };
}
