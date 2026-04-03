import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

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

function isPlainObject(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: any, key: string) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function parseExpectedToolOrder(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }

  const rawValue = hasOwn(value, 'order')
    ? value.order
    : hasOwn(value, 'sequence')
      ? value.sequence
      : hasOwn(value, 'sequenceIndex')
        ? value.sequenceIndex
        : hasOwn(value, 'sequence_index')
          ? value.sequence_index
          : null;

  if (rawValue == null || rawValue === '') {
    return null;
  }

  const order = typeof rawValue === 'string'
    ? Number.parseInt(rawValue, 10)
    : Number(rawValue);

  return Number.isInteger(order) && order > 0 ? order : null;
}

function sanitizeExpectedToolSpecEntry(value: any) {
  if (typeof value === 'string') {
    const name = String(value || '').trim();
    return name || null;
  }
  if (!isPlainObject(value)) {
    return null;
  }

  const name = String(value.name || value.tool || '').trim();
  if (!name) {
    return null;
  }

  const requiredParamsSource = Array.isArray(value.requiredParams)
    ? value.requiredParams
    : Array.isArray(value.required_params)
      ? value.required_params
      : [];
  const requiredParams = [...new Set(
    requiredParamsSource
      .map((entry: any) => String(entry || '').trim())
      .filter(Boolean)
  )];

  let argumentsShape: any;
  if (hasOwn(value, 'arguments')) {
    argumentsShape = value.arguments;
  } else if (hasOwn(value, 'args')) {
    argumentsShape = value.args;
  } else if (hasOwn(value, 'params')) {
    argumentsShape = value.params;
  }

  const order = parseExpectedToolOrder(value);
  const normalized: any = { name };
  if (argumentsShape !== undefined) {
    normalized.arguments = argumentsShape;
  }
  if (requiredParams.length > 0) {
    normalized.requiredParams = requiredParams;
  }
  if (order != null) {
    normalized.order = order;
  }
  return normalized;
}

function sanitizeExpectedToolSpecs(value: any) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => sanitizeExpectedToolSpecEntry(entry))
    .filter(Boolean);
}

function normalizeExpectedToolSpecs(value: any) {
  return sanitizeExpectedToolSpecs(value).map((entry: any, index: number) => {
    if (typeof entry === 'string') {
      return {
        name: entry,
        requiredParams: [],
        hasArgumentShape: false,
        hasParameterExpectation: false,
        hasSequenceExpectation: false,
        arguments: undefined,
        order: null,
        sourceOrder: index,
      };
    }

    const requiredParams = Array.isArray(entry.requiredParams)
      ? entry.requiredParams.map((item: any) => String(item || '').trim()).filter(Boolean)
      : [];
    const hasArgumentShape = hasOwn(entry, 'arguments');
    const order = parseExpectedToolOrder(entry);

    return {
      name: String(entry.name || '').trim(),
      requiredParams,
      hasArgumentShape,
      hasParameterExpectation: hasArgumentShape || requiredParams.length > 0,
      hasSequenceExpectation: order != null,
      arguments: hasArgumentShape ? entry.arguments : undefined,
      order,
      sourceOrder: index,
    };
  }).filter((entry: any) => entry.name);
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
    expectedTools: sanitizeExpectedToolSpecs(safeJsonParse(row.expected_tools_json) || []),
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
    provider: String(row.provider || '').trim(),
    model: String(row.model || '').trim(),
    promptVersion: String(row.prompt_version || '').trim(),
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
  const startRunImpl = typeof options.startRunImpl === 'function' ? options.startRunImpl : startRun;
  const evaluateRunImpl = typeof options.evaluateRunImpl === 'function' ? options.evaluateRunImpl : null;
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

  function getSkillTestRunDebug(run: any) {
    if (!run || !run.evalCaseRunId) return null;
    // Look up the eval_case_run to get task_id and session info
    let evalRun: any = null;
    try {
      evalRun = store.db.prepare('SELECT * FROM eval_case_runs WHERE id = @id').get({ id: run.evalCaseRunId });
    } catch { return null; }
    if (!evalRun) return null;

    const taskId = evalRun.task_id ? String(evalRun.task_id).trim() : '';
    const sessionPath = evalRun.session_path ? String(evalRun.session_path).trim() : '';

    // Collect tool call events
    let toolEvents: any[] = [];
    if (taskId) {
      try {
        toolEvents = store.db
          .prepare(
            `SELECT event_json, created_at FROM a2a_task_events
             WHERE task_id = @taskId AND event_type = 'agent_tool_call'
             ORDER BY id ASC LIMIT 200`
          )
          .all({ taskId });
      } catch { toolEvents = []; }
    }

    // Read session assistant snapshot
    let sessionSnapshot: any = null;
    if (sessionPath) {
      sessionSnapshot = readSessionAssistantSnapshot(sessionPath);
    }

    return {
      taskId,
      sessionPath,
      outputText: evalRun.output_text || '',
      toolCalls: toolEvents.map(r => ({
        createdAt: r.created_at || '',
        payload: safeJsonParse(r.event_json),
      })),
      session: sessionSnapshot,
    };
  }

  /**
   * Read session JSONL and extract thinking, text, toolCalls, errors from assistant messages.
   */
  function readSessionAssistantSnapshot(sessionPath: string) {
    const resolved = String(sessionPath || '').trim();
    if (!resolved) return null;
    let text = '';
    try {
      if (!fs.existsSync(resolved)) return null;
      text = fs.readFileSync(resolved, 'utf8');
    } catch { return null; }

    const lines = text.split(/\r?\n/);
    const thinkingParts: string[] = [];
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    const assistantMessages: any[] = [];

    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      let entry: any = null;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      if (!entry || entry.type !== 'message' || !entry.message || entry.message.role !== 'assistant') continue;

      const message = entry.message;
      assistantMessages.push(message);

      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block.type === 'thinking' && block.thinking) thinkingParts.push(block.thinking);
        if (block.type === 'text' && block.text) textParts.push(block.text);
        if (block.type === 'toolCall' && block.name) {
          toolCalls.push({ toolName: block.name, toolCallId: block.id || '', arguments: block.arguments || {} });
        }
      }
    }

    return {
      thinking: thinkingParts.join('\n'),
      text: textParts.join('\n'),
      toolCalls,
      assistantMessageCount: assistantMessages.length,
      assistantMessagesTail: assistantMessages.slice(-6),
    };
  }

  // ---- Query helpers ----

  function getLatestRunForCase(caseId: string) {
    ensureSchema();
    const row = store.db
      .prepare(
        `SELECT
           r.*,
           e.provider AS provider,
           e.model AS model,
           e.prompt_version AS prompt_version
         FROM skill_test_runs r
         LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
         WHERE r.test_case_id = @caseId
         ORDER BY r.created_at DESC
         LIMIT 1`
      )
      .get({ caseId });
    return normalizeTestRunRow(row);
  }

  function attachLatestRun(testCase: any) {
    if (!testCase || !testCase.id) {
      return testCase;
    }
    return {
      ...testCase,
      latestRun: getLatestRunForCase(testCase.id),
    };
  }

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
    return rows.map(normalizeTestCaseRow).filter(Boolean).map((testCase: any) => attachLatestRun(testCase));
  }

  function getTestCase(caseId: string) {
    ensureSchema();
    const row = store.db
      .prepare('SELECT * FROM skill_test_cases WHERE id = @id')
      .get({ id: caseId });
    return attachLatestRun(normalizeTestCaseRow(row));
  }

  function createTestCase(input: any) {
    ensureSchema();
    const skillId = String(input.skillId || '').trim();
    const testType = String(input.testType || 'trigger').trim();
    const loadingMode = String(input.loadingMode || 'dynamic').trim();
    const triggerPrompt = String(input.triggerPrompt || input.trigger_prompt || '').trim();
    const rawExpectedTools = Array.isArray(input.expectedTools || input.expected_tools)
      ? input.expectedTools || input.expected_tools
      : [];
    const expectedTools = sanitizeExpectedToolSpecs(rawExpectedTools);
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
    if (rawExpectedTools.length > 0 && expectedTools.length !== rawExpectedTools.length) {
      throw createHttpError(
        400,
        'expectedTools items must be tool names or { name, arguments?, requiredParams?, order? } objects'
      );
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
        `SELECT
           r.*, 
           e.provider AS provider,
           e.model AS model,
           e.prompt_version AS prompt_version
         FROM skill_test_runs r
         INNER JOIN skill_test_cases c ON r.test_case_id = c.id
         LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
         WHERE c.skill_id = @skillId
         ORDER BY r.created_at DESC
         LIMIT @limit`
      )
      .all({ skillId, limit: safeLimit });
    return rows.map(normalizeTestRunRow).filter(Boolean);
  }

  function getRegressionBuckets(whereSql: string, params: Record<string, any>) {
    ensureSchema();
    const rows = store.db
      .prepare(
        `SELECT
           COALESCE(NULLIF(e.provider, ''), 'default') AS provider_label,
           COALESCE(NULLIF(e.model, ''), 'default') AS model_label,
           COALESCE(NULLIF(e.prompt_version, ''), 'skill-test-v1') AS prompt_version,
           COUNT(r.id) AS total_runs,
           COALESCE(SUM(CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded_runs,
           COALESCE(SUM(CASE WHEN r.trigger_passed = 1 THEN 1 ELSE 0 END), 0) AS trigger_passed_count,
           COALESCE(SUM(CASE WHEN r.execution_passed = 1 THEN 1 ELSE 0 END), 0) AS execution_passed_count,
           COALESCE(AVG(CASE WHEN r.tool_accuracy IS NOT NULL THEN r.tool_accuracy END), 0) AS avg_tool_accuracy,
           MAX(r.created_at) AS last_run_at
         FROM skill_test_runs r
         INNER JOIN skill_test_cases c ON r.test_case_id = c.id
         LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
         WHERE ${whereSql}
         GROUP BY provider_label, model_label, prompt_version
         ORDER BY total_runs DESC, last_run_at DESC`
      )
      .all(params);

    return rows.map((row: any) => {
      const totalRuns = Number(row.total_runs || 0);
      const triggerPassedCount = Number(row.trigger_passed_count || 0);
      const executionPassedCount = Number(row.execution_passed_count || 0);
      return {
        provider: String(row.provider_label || '').trim(),
        model: String(row.model_label || '').trim(),
        promptVersion: String(row.prompt_version || '').trim() || 'skill-test-v1',
        totalRuns,
        succeededRuns: Number(row.succeeded_runs || 0),
        triggerPassedCount,
        executionPassedCount,
        triggerRate: totalRuns > 0 ? triggerPassedCount / totalRuns : null,
        executionRate: triggerPassedCount > 0 ? executionPassedCount / triggerPassedCount : null,
        avgToolAccuracy: row.avg_tool_accuracy != null ? Number(row.avg_tool_accuracy) : null,
        lastRunAt: String(row.last_run_at || '').trim(),
      };
    });
  }

  function getSkillRegressionSummary(skillId: string) {
    return getRegressionBuckets('c.skill_id = @skillId', { skillId });
  }

  function getCaseRegressionSummary(caseId: string) {
    return getRegressionBuckets('c.id = @caseId', { caseId });
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

  /**
   * Parse tool calls from a pi session JSONL file.
   * Returns an array of { toolName, toolCallId, arguments } objects
   * extracted from assistant messages that contain toolCall content blocks.
   */
  function parseToolCallsFromSession(sessionPath: string) {
    if (!sessionPath) return [];
    let lines: string[] = [];
    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      lines = content.split('\n');
    } catch {
      return [];
    }
    const toolCalls: Array<{ toolName: string; toolCallId: string; arguments: any }> = [];
    for (const line of lines) {
      const entry = safeJsonParse(line);
      if (!entry || entry.type !== 'message') continue;
      const msg = entry.message || {};
      if (msg.role !== 'assistant') continue;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block.type === 'toolCall' && block.name) {
          toolCalls.push({
            toolName: block.name,
            toolCallId: block.id || '',
            arguments: block.arguments || {},
          });
        }
      }
    }
    return toolCalls;
  }

  /**
   * Find session path for a given taskId from a2a_tasks table.
   */
  function getSessionPathForTask(taskId: string) {
    ensureSchema();
    try {
      const row = store.db
        .prepare('SELECT session_path FROM a2a_tasks WHERE id = @id')
        .get({ id: taskId });
      return row && row.session_path ? String(row.session_path).trim() : '';
    } catch {
      return '';
    }
  }

  function normalizeSkillDisplayName(value: any) {
    return String(value || '').trim().replace(/\s+Skill$/i, '');
  }

  function normalizeLooseText(value: any) {
    return String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractTriggerSignalTokens(value: any, limit = 12) {
    const text = String(value || '').trim();
    if (!text) {
      return [];
    }

    const stopWords = new Set([
      'agent',
      'should',
      'recognize',
      'request',
      'trigger',
      'skill',
      'user',
      'mode',
      'test',
      'case',
      'expected',
      'behavior',
      'tool',
      'tools',
      'full',
      'dynamic',
      '用于',
      '后端',
      '自动',
      '主持',
      '模型',
      '测试',
      '触发',
      '执行',
      '用户',
      '技能',
    ]);

    const matches = text.match(/[A-Za-z][A-Za-z0-9-]{2,}|[\u4e00-\u9fff]{2,12}/g) || [];
    const tokens: string[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const token = String(match || '').trim();
      const normalized = normalizeLooseText(token);
      if (!normalized || stopWords.has(normalized) || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      tokens.push(token);
      if (tokens.length >= limit) {
        break;
      }
    }
    return tokens;
  }

  function buildFullModeTriggerSignals(skill: any, testCase: any) {
    const signals: string[] = [];
    const seen = new Set<string>();

    const pushSignal = (value: any) => {
      const text = String(value || '').trim();
      const normalized = normalizeLooseText(text);
      if (!text || !normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      signals.push(text);
    };

    pushSignal(normalizeSkillDisplayName(skill && skill.name));
    pushSignal(skill && skill.id);
    pushSignal(testCase && testCase.skillId);

    const secondarySources = [
      skill && skill.description,
      testCase && testCase.expectedBehavior,
      testCase && testCase.note,
    ];
    for (const source of secondarySources) {
      for (const token of extractTriggerSignalTokens(source)) {
        pushSignal(token);
      }
    }

    return signals.slice(0, 16);
  }

  function clipJudgeText(value: any, maxLength = 2400) {
    const text = String(value || '').trim();
    if (!text) {
      return '';
    }
    if (text.length <= maxLength) {
      return text;
    }
    const safeLength = Math.max(0, maxLength - 16);
    return `${text.slice(0, safeLength).trim()}\n...[truncated]`;
  }

  function extractJsonObjectFromText(value: any) {
    const text = String(value || '').trim();
    if (!text) {
      return null;
    }

    const candidates: string[] = [];
    const pushCandidate = (candidateValue: any) => {
      const candidate = String(candidateValue || '').trim();
      if (!candidate || candidates.includes(candidate)) {
        return;
      }
      candidates.push(candidate);
    };

    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch && fencedMatch[1]) {
      pushCandidate(fencedMatch[1]);
    }

    pushCandidate(text);

    const firstBraceIndex = text.indexOf('{');
    const lastBraceIndex = text.lastIndexOf('}');
    if (firstBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
      pushCandidate(text.slice(firstBraceIndex, lastBraceIndex + 1));
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (isPlainObject(parsed)) {
          return parsed;
        }
      } catch {
      }
    }

    return null;
  }

  function normalizeJudgePassed(value: any) {
    if (typeof value === 'boolean') {
      return value;
    }

    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (['true', '1', 'yes', 'y', 'pass', 'passed'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'fail', 'failed'].includes(normalized)) {
      return false;
    }
    return null;
  }

  function normalizeJudgeConfidence(value: any) {
    if (value == null || value === '') {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    if (parsed < 0) {
      return 0;
    }
    if (parsed > 1) {
      return 1;
    }
    return parsed;
  }

  function parseFullModeTriggerJudgeResponse(value: any) {
    const rawResponse = clipJudgeText(value, 600);
    const parsed = extractJsonObjectFromText(value);
    const matchedBehaviorsSource = parsed
      ? (Array.isArray(parsed.matchedBehaviors)
        ? parsed.matchedBehaviors
        : Array.isArray(parsed.matched_behaviors)
          ? parsed.matched_behaviors
          : Array.isArray(parsed.matchedEvidence)
            ? parsed.matchedEvidence
            : Array.isArray(parsed.evidence)
              ? parsed.evidence
              : [])
      : [];
    const matchedBehaviors = [...new Set(
      matchedBehaviorsSource
        .map((entry: any) => String(entry || '').trim())
        .filter(Boolean)
    )].slice(0, 8);

    return {
      attempted: Boolean(rawResponse),
      skipped: false,
      skippedReason: '',
      parsed: Boolean(parsed),
      passed: parsed && hasOwn(parsed, 'passed') ? normalizeJudgePassed(parsed.passed) : null,
      confidence: parsed && hasOwn(parsed, 'confidence') ? normalizeJudgeConfidence(parsed.confidence) : null,
      reason: parsed && hasOwn(parsed, 'reason') ? String(parsed.reason || '').trim() : '',
      matchedBehaviors,
      rawResponse,
      errorMessage: parsed || !rawResponse ? '' : 'judge-response-not-json',
    };
  }

  function buildFullModeTriggerJudgePrompt(skill: any, testCase: any, actualTools: string[], evidenceText: string) {
    const observedTools = [...new Set((Array.isArray(actualTools) ? actualTools : []).filter(Boolean))];
    const skillName = clipJudgeText(normalizeSkillDisplayName(skill && skill.name), 120);
    const skillId = clipJudgeText(testCase && testCase.skillId || skill && skill.id, 80);
    const skillDescription = clipJudgeText(skill && skill.description, 500);
    const skillBody = clipJudgeText(skill && skill.body, 1800);
    const expectedBehavior = clipJudgeText(testCase && testCase.expectedBehavior, 600);
    const note = clipJudgeText(testCase && testCase.note, 300);
    const triggerPrompt = clipJudgeText(testCase && testCase.triggerPrompt, 600);
    const assistantEvidence = clipJudgeText(evidenceText, 2200);
    const observedToolsJson = clipJudgeText(JSON.stringify(observedTools, null, 2), 300);

    return [
      '你是一个严格的 Skill 触发评审器。',
      '任务：判断 assistant 是否在 full mode 下真正遵循了目标 skill，而不是仅仅聊到相关话题。',
      '只依据下面提供的证据判断，不要调用工具，不要查看文件，不要补充额外解释。',
      '只返回一行 JSON，格式必须严格为：',
      '{"passed":true|false,"confidence":0.0,"reason":"一句话原因","matchedBehaviors":["命中的关键行为"]}',
      '判定规则：',
      '- 只有当 assistant 明确采用了目标 skill 的行为、身份、约束或流程时，passed 才能为 true。',
      '- 如果 assistant 只是解释概念、泛泛回答、或行为与 skill 不符，passed=false。',
      '- 如果证据不足或你不确定，passed=false。',
      '',
      `Skill Name: ${skillName || 'unknown'}`,
      `Skill ID: ${skillId || 'unknown'}`,
      `Skill Description:\n${skillDescription || '(none)'}`,
      `Expected Behavior:\n${expectedBehavior || '(none)'}`,
      `Case Note:\n${note || '(none)'}`,
      `User Prompt:\n${triggerPrompt || '(none)'}`,
      `Observed Tools:\n${observedToolsJson || '[]'}`,
      `Assistant Evidence:\n${assistantEvidence || '(none)'}`,
      `Skill Body Excerpt:\n${skillBody || '(none)'}`,
    ].join('\n\n');
  }

  async function runFullModeTriggerAiJudge(skill: any, testCase: any, actualTools: string[], evidenceText: string, runtime: any = {}) {
    const hasObservableEvidence = Boolean(String(evidenceText || '').trim()) || actualTools.length > 0;
    if (!hasObservableEvidence) {
      return {
        attempted: false,
        skipped: true,
        skippedReason: 'no-observable-evidence',
        parsed: false,
        passed: null,
        confidence: null,
        reason: '',
        matchedBehaviors: [],
        rawResponse: '',
        errorMessage: '',
        sessionPath: '',
      };
    }

    const judgePrompt = buildFullModeTriggerJudgePrompt(skill, testCase, actualTools, evidenceText);
    const judgeTaskId = `skill-test-judge-${randomUUID()}`;
    const judgeSessionName = `skill-test-judge-${String(testCase && testCase.id || 'case').trim() || 'case'}-${Date.now()}`;
    const provider = String(runtime && runtime.provider || '').trim();
    const model = String(runtime && runtime.model || '').trim();
    const judgeAgentIdBase = String(runtime && runtime.agentId || 'skill-test-agent').trim() || 'skill-test-agent';
    const sandboxDir = runtime && runtime.sandbox && runtime.sandbox.sandboxDir
      ? String(runtime.sandbox.sandboxDir)
      : '';
    const privateDir = runtime && runtime.sandbox && runtime.sandbox.privateDir
      ? String(runtime.sandbox.privateDir)
      : '';

    try {
      const handle = startRunImpl(provider, model, judgePrompt, {
        thinking: '',
        agentDir: store.agentDir,
        sqlitePath: store.databasePath,
        streamOutput: false,
        session: judgeSessionName,
        taskId: judgeTaskId,
        taskKind: 'skill_test_trigger_judge',
        taskRole: 'Skill Trigger Judge',
        metadata: {
          source: 'skill_test_trigger_judge',
          parentTaskId: runtime && runtime.taskId ? runtime.taskId : null,
          testCaseId: testCase && testCase.id ? testCase.id : null,
          skillId: testCase && testCase.skillId ? testCase.skillId : null,
        },
        extraEnv: {
          PI_AGENT_ID: `${judgeAgentIdBase}-judge`,
          PI_AGENT_NAME: 'Skill Trigger Judge',
          PI_AGENT_SANDBOX_DIR: sandboxDir,
          PI_AGENT_PRIVATE_DIR: privateDir,
          CAFF_SKILL_LOADING_MODE: 'full',
        },
      });
      const judgeResult = await handle.resultPromise;
      const parsed = parseFullModeTriggerJudgeResponse(judgeResult && judgeResult.reply ? judgeResult.reply : '');
      return {
        ...parsed,
        attempted: true,
        sessionPath: String((judgeResult && judgeResult.sessionPath) || handle.sessionPath || '').trim(),
      };
    } catch (error: any) {
      return {
        attempted: true,
        skipped: false,
        skippedReason: '',
        parsed: false,
        passed: null,
        confidence: null,
        reason: '',
        matchedBehaviors: [],
        rawResponse: '',
        errorMessage: error && error.message ? String(error.message) : String(error || 'AI judge failed'),
        sessionPath: '',
      };
    }
  }

  async function evaluateFullModeTrigger(skill: any, testCase: any, actualTools: string[], evidenceText: string, runtime: any = {}) {
    const expectedTools = normalizeExpectedToolSpecs(testCase && testCase.expectedTools).map((entry: any) => entry.name);
    const normalizedEvidence = normalizeLooseText(evidenceText);
    const triggerSignals = buildFullModeTriggerSignals(skill, testCase);
    const matchedSignals = triggerSignals.filter((signal) => {
      const normalizedSignal = normalizeLooseText(signal);
      return normalizedSignal ? normalizedEvidence.includes(normalizedSignal) : false;
    });
    const expectedToolMatched = expectedTools.some((tool) => actualTools.includes(tool));
    const hasObservableOutput = Boolean(String(evidenceText || '').trim()) || actualTools.length > 0;
    const signalMatched = matchedSignals.length > 0 && hasObservableOutput;
    const aiJudge = await runFullModeTriggerAiJudge(skill, testCase, actualTools, evidenceText, runtime);
    const triggerPassed = expectedToolMatched || signalMatched || aiJudge.passed === true;
    const decisionSources = [];

    if (expectedToolMatched) {
      decisionSources.push('expected-tool');
    }
    if (signalMatched) {
      decisionSources.push('behavior-signals');
    }
    if (aiJudge.passed === true) {
      decisionSources.push('ai-judge');
    }
    if (decisionSources.length === 0) {
      decisionSources.push('none');
    }

    return {
      triggerPassed,
      triggerEvaluation: {
        mode: 'full',
        matchedSignals,
        expectedToolMatched,
        signalMatched,
        hasObservableOutput,
        decisionSources,
        aiJudge,
      },
    };
  }

  function getArgumentPathState(value: any, pathExpression: string) {
    const segments = String(pathExpression || '').split('.').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) {
      return { found: false, value: undefined };
    }

    let current = value;
    for (const segment of segments) {
      if (Array.isArray(current) && /^\d+$/.test(segment)) {
        current = current[Number(segment)];
      } else if (current != null && (typeof current === 'object' || Array.isArray(current))) {
        current = current[segment as keyof typeof current];
      } else {
        return { found: false, value: undefined };
      }

      if (current === undefined) {
        return { found: false, value: undefined };
      }
    }

    return { found: true, value: current };
  }

  function matchesArgumentPattern(expected: any, actual: any): boolean {
    if (typeof expected === 'string') {
      const expectedText = expected.trim();
      const normalized = expectedText.toLowerCase();
      if (normalized === '<any>') {
        return actual !== undefined;
      }
      if (normalized === '<string>') {
        return typeof actual === 'string' && actual.trim().length > 0;
      }
      if (normalized === '<number>') {
        return typeof actual === 'number' && Number.isFinite(actual);
      }
      if (normalized === '<boolean>') {
        return typeof actual === 'boolean';
      }
      if (normalized === '<array>') {
        return Array.isArray(actual);
      }
      if (normalized === '<object>') {
        return isPlainObject(actual);
      }
      if (normalized.startsWith('<contains:') && normalized.endsWith('>')) {
        if (typeof actual !== 'string') {
          return false;
        }
        const needle = expectedText.slice('<contains:'.length, -1).trim().toLowerCase();
        return needle.length > 0 && actual.toLowerCase().includes(needle);
      }
      return actual === expectedText;
    }

    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length < expected.length) {
        return false;
      }
      return expected.every((item, index) => matchesArgumentPattern(item, actual[index]));
    }

    if (isPlainObject(expected)) {
      if (!isPlainObject(actual)) {
        return false;
      }
      return Object.entries(expected).every(([key, value]) => matchesArgumentPattern(value, actual[key]));
    }

    return Object.is(expected, actual);
  }

  function evaluateExpectedToolCall(spec: any, observedToolCalls: any[]) {
    const matchingCalls = observedToolCalls.filter((entry) => entry.toolName === spec.name);
    const hasParameterExpectation = Boolean(spec && spec.hasParameterExpectation);
    const fallbackArguments = matchingCalls.length > 0 ? matchingCalls[0].arguments : null;
    const baseResult: any = {
      name: spec.name,
      order: spec.order != null ? spec.order : null,
      matched: false,
      matchedByName: matchingCalls.length > 0,
      callCount: matchingCalls.length,
      hasParameterExpectation,
      requiredParams: spec.requiredParams || [],
      expectedArguments: spec.hasArgumentShape ? spec.arguments : null,
      missingParams: [],
      argumentShapePassed: spec.hasArgumentShape ? false : null,
      parameterPassed: hasParameterExpectation ? false : null,
      actualArguments: fallbackArguments,
    };

    if (matchingCalls.length === 0) {
      return baseResult;
    }

    if (!hasParameterExpectation) {
      return {
        ...baseResult,
        matched: true,
        parameterPassed: null,
      };
    }

    for (const call of matchingCalls) {
      const actualArguments = call && hasOwn(call, 'arguments') ? call.arguments : undefined;
      const missingParams = (spec.requiredParams || []).filter((pathValue: string) => {
        const state = getArgumentPathState(actualArguments, pathValue);
        return !state.found;
      });
      const argumentShapePassed = spec.hasArgumentShape
        ? matchesArgumentPattern(spec.arguments, actualArguments)
        : true;

      if (missingParams.length === 0 && argumentShapePassed) {
        return {
          ...baseResult,
          matched: true,
          parameterPassed: true,
          missingParams: [],
          argumentShapePassed,
          actualArguments,
        };
      }

      if (!baseResult.matched) {
        baseResult.missingParams = missingParams;
        baseResult.argumentShapePassed = spec.hasArgumentShape ? argumentShapePassed : null;
        baseResult.actualArguments = actualArguments;
      }
    }

    return baseResult;
  }

  const INFERRED_SESSION_TOOL_SEQUENCE_NAMES = [
    'read-skill',
    'send-public',
    'send-private',
    'read-context',
    'list-participants',
    'trellis-init',
    'trellis-write',
  ];

  function inferSequenceToolNameFromSessionCall(toolCall: any) {
    const toolName = String(toolCall && toolCall.toolName || '').trim();
    if (!toolName) {
      return '';
    }

    if (toolName === 'read') {
      const readPath = String(toolCall && toolCall.arguments && (toolCall.arguments.path || toolCall.arguments.file) || '')
        .replace(/\\/g, '/')
        .toLowerCase();
      if (readPath.includes('/skills/')) {
        return 'read-skill';
      }
      return '';
    }

    if (toolName !== 'bash') {
      return '';
    }

    const command = String(toolCall && toolCall.arguments && toolCall.arguments.command || '').trim().toLowerCase();
    if (!command) {
      return '';
    }

    for (const candidate of INFERRED_SESSION_TOOL_SEQUENCE_NAMES) {
      if (command.includes(candidate)) {
        return candidate;
      }
    }

    return '';
  }

  function buildObservedSequenceCalls(toolCallEvents: any[], sessionToolCalls: any[]) {
    const buildSequenceCalls = (entries: any[], sourceBuilder: (entry: any) => any[]) => {
      const sequenceCalls: any[] = [];
      const pushSequenceCall = (toolName: any, source: string) => {
        const normalizedToolName = String(toolName || '').trim();
        if (!normalizedToolName) {
          return;
        }
        sequenceCalls.push({
          toolName: normalizedToolName,
          source,
          orderIndex: sequenceCalls.length,
        });
      };

      for (const entry of entries) {
        for (const item of sourceBuilder(entry)) {
          pushSequenceCall(item.toolName, item.source);
        }
      }

      return sequenceCalls;
    };

    const sessionSequenceCalls = buildSequenceCalls(sessionToolCalls, (toolCall) => {
      const calls: any[] = [];
      const actualToolName = String(toolCall && toolCall.toolName || '').trim();
      if (actualToolName) {
        calls.push({ toolName: actualToolName, source: 'session' });
      }
      const inferredToolName = inferSequenceToolNameFromSessionCall(toolCall);
      if (inferredToolName && inferredToolName !== actualToolName) {
        calls.push({ toolName: inferredToolName, source: 'session-inferred' });
      }
      return calls;
    });

    if (sessionSequenceCalls.length > 0) {
      return sessionSequenceCalls;
    }

    return buildSequenceCalls(toolCallEvents, (event) => [
      { toolName: event && event.tool, source: 'event' },
    ]);
  }

  function evaluateToolSequence(expectedTools: any[], observedSequenceCalls: any[]) {
    const orderedSpecs = expectedTools
      .filter((entry: any) => entry && entry.hasSequenceExpectation)
      .sort((a: any, b: any) => {
        const orderDelta = Number(a.order || 0) - Number(b.order || 0);
        return orderDelta || Number(a.sourceOrder || 0) - Number(b.sourceOrder || 0);
      });

    if (orderedSpecs.length === 0) {
      return {
        enabled: false,
        orderedExpectedCount: 0,
        matchedCount: 0,
        passed: null,
        skipped: false,
        observedTools: observedSequenceCalls.map((entry: any) => entry.toolName),
        steps: [],
      };
    }

    let cursor = 0;
    let matchedCount = 0;
    const steps: any[] = [];

    for (const spec of orderedSpecs) {
      const expectedAfterIndex = cursor;
      let matchedCallIndex = -1;
      let observedCallCount = 0;
      let firstObservedIndex = -1;

      for (let index = 0; index < observedSequenceCalls.length; index += 1) {
        const call = observedSequenceCalls[index];
        if (!call || call.toolName !== spec.name) {
          continue;
        }
        observedCallCount += 1;
        if (firstObservedIndex === -1) {
          firstObservedIndex = index;
        }
        if (matchedCallIndex === -1 && index >= cursor) {
          matchedCallIndex = index;
        }
      }

      const matched = matchedCallIndex >= 0;
      if (matched) {
        matchedCount += 1;
        cursor = matchedCallIndex + 1;
      }

      steps.push({
        name: spec.name,
        order: spec.order != null ? spec.order : null,
        matched,
        outOfOrder: !matched && firstObservedIndex !== -1 && firstObservedIndex < expectedAfterIndex,
        matchedCallIndex: matched ? matchedCallIndex : null,
        observedCallCount,
        source: matched ? observedSequenceCalls[matchedCallIndex].source : '',
      });
    }

    return {
      enabled: true,
      orderedExpectedCount: orderedSpecs.length,
      matchedCount,
      passed: matchedCount === orderedSpecs.length,
      skipped: false,
      observedTools: observedSequenceCalls.map((entry: any) => entry.toolName),
      steps,
    };
  }

  async function evaluateRun(taskId: string, testCase: any, runtime: any = {}) {
    const toolCallEvents = collectToolCallsFromTask(taskId);
    const expectedTools = normalizeExpectedToolSpecs(testCase.expectedTools);
    const skillId = String(testCase.skillId || '').trim();
    const loadingMode = String(testCase.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
    const skill = skillRegistry ? skillRegistry.getSkill(skillId) : null;

    const observedToolCalls: any[] = [];
    let triggerPassed = false;
    let triggerEvaluation: any = {
      mode: loadingMode === 'full' ? 'full' : 'dynamic',
      matchedSignals: [],
      expectedToolMatched: false,
    };

    for (const event of toolCallEvents) {
      const toolName = String(event && event.tool || '').trim();
      if (!toolName) {
        continue;
      }
      observedToolCalls.push({
        toolName,
        arguments: event && hasOwn(event, 'request') ? event.request : undefined,
        source: 'event',
      });

      if (
        toolName === 'read-skill' &&
        event.request &&
        String(event.request.skillId || '').trim() === skillId
      ) {
        triggerPassed = true;
      }
    }

    const sessionPath = String(runtime.sessionPath || '').trim() || getSessionPathForTask(taskId);
    const sessionSnapshot = sessionPath ? readSessionAssistantSnapshot(sessionPath) : null;
    const sessionToolCalls = parseToolCallsFromSession(sessionPath);

    for (const tc of sessionToolCalls) {
      const toolName = String(tc && tc.toolName || '').trim();
      if (!toolName) {
        continue;
      }
      observedToolCalls.push({
        toolName,
        arguments: tc.arguments,
        source: 'session',
      });

      if (!triggerPassed && toolName === 'read') {
        const readPath = String(tc.arguments && (tc.arguments.path || tc.arguments.file) || '').replace(/\\/g, '/');
        if (readPath) {
          const skillsMatch = readPath.match(/\/skills\/([^/]+)\//);
          if (skillsMatch && skillsMatch[1] === skillId) {
            triggerPassed = true;
          }
        }
      }

      if (!triggerPassed && toolName === 'bash') {
        const cmd = String(tc.arguments && tc.arguments.command || '');
        if (cmd.includes('read-skill') && cmd.includes(skillId)) {
          triggerPassed = true;
        }
      }
    }

    const observedSequenceCalls = buildObservedSequenceCalls(toolCallEvents, sessionToolCalls);
    const actualTools = observedToolCalls
      .map((entry) => String(entry && entry.toolName || '').trim())
      .filter(Boolean);

    const evidenceText = [
      runtime && runtime.outputText,
      sessionSnapshot && sessionSnapshot.text,
      sessionSnapshot && sessionSnapshot.thinking,
    ]
      .filter(Boolean)
      .join('\n');

    if (!triggerPassed && loadingMode === 'full') {
      const fullModeEvaluation = await evaluateFullModeTrigger(skill, testCase, actualTools, evidenceText, {
        ...runtime,
        taskId,
      });
      triggerPassed = Boolean(fullModeEvaluation.triggerPassed);
      triggerEvaluation = fullModeEvaluation.triggerEvaluation;
    }

    const usesParameterValidation = expectedTools.some((entry: any) => entry.hasParameterExpectation);
    const usesSequenceValidation = expectedTools.some((entry: any) => entry.hasSequenceExpectation);
    const observedSequenceTools = observedSequenceCalls.map((entry: any) => entry.toolName);

    let toolAccuracy: number | null = null;
    let executionPassed: number | null = null;
    let executionEvaluation: any = {
      threshold: 0.8,
      expectedCount: expectedTools.length,
      matchedCount: 0,
      toolChecks: [],
      usedParameterValidation: usesParameterValidation,
      usedSequenceValidation: usesSequenceValidation,
      sequenceCheck: {
        enabled: usesSequenceValidation,
        orderedExpectedCount: expectedTools.filter((entry: any) => entry.hasSequenceExpectation).length,
        matchedCount: 0,
        passed: usesSequenceValidation ? false : null,
        skipped: true,
        observedTools: observedSequenceTools,
        steps: [],
      },
      skipped: !triggerPassed,
    };

    const EXECUTION_THRESHOLD = 0.8;

    if (triggerPassed && expectedTools.length > 0) {
      const toolChecks = expectedTools.map((entry: any) => evaluateExpectedToolCall(entry, observedToolCalls));
      const matchedCount = toolChecks.filter((entry: any) => entry.matched).length;
      const sequenceCheck = usesSequenceValidation
        ? { ...evaluateToolSequence(expectedTools, observedSequenceCalls), skipped: false }
        : {
            enabled: false,
            orderedExpectedCount: 0,
            matchedCount: 0,
            passed: null,
            skipped: true,
            observedTools: observedSequenceTools,
            steps: [],
          };
      toolAccuracy = matchedCount / expectedTools.length;
      executionPassed = toolAccuracy >= EXECUTION_THRESHOLD ? 1 : 0;
      if (usesSequenceValidation && !sequenceCheck.passed) {
        executionPassed = 0;
      }
      executionEvaluation = {
        threshold: EXECUTION_THRESHOLD,
        expectedCount: expectedTools.length,
        matchedCount,
        toolChecks,
        usedParameterValidation: toolChecks.some((entry: any) => entry.hasParameterExpectation),
        usedSequenceValidation: usesSequenceValidation,
        sequenceCheck,
        skipped: false,
      };
    } else if (triggerPassed && expectedTools.length === 0) {
      toolAccuracy = 1;
      executionPassed = 1;
      executionEvaluation = {
        threshold: EXECUTION_THRESHOLD,
        expectedCount: 0,
        matchedCount: 0,
        toolChecks: [],
        usedParameterValidation: false,
        usedSequenceValidation: false,
        sequenceCheck: {
          enabled: false,
          orderedExpectedCount: 0,
          matchedCount: 0,
          passed: null,
          skipped: true,
          observedTools: observedSequenceTools,
          steps: [],
        },
        skipped: false,
      };
    }

    return {
      triggerPassed: triggerPassed ? 1 : 0,
      executionPassed,
      toolAccuracy,
      actualToolsJson: JSON.stringify([...new Set(actualTools)]),
      triggerEvaluation,
      executionEvaluation,
    };
  }

  function getCaseValidityAfterEvaluation(testCase: any, evaluation: any) {
    const currentValidity = String(testCase && testCase.validityStatus || 'pending').trim() || 'pending';
    if (!evaluation || !evaluation.triggerPassed) {
      return 'invalid';
    }
    if (currentValidity === 'validated') {
      return 'validated';
    }
    return 'validated';
  }

  function classifyPromptForSmokeRun(skillId: string, triggerPrompt: string) {
    const normalizedSkillId = String(skillId || '').trim();
    const normalizedPrompt = String(triggerPrompt || '').trim();
    if (!normalizedSkillId) {
      return { valid: false, reason: 'missing-skill-id' };
    }
    if (!normalizedPrompt) {
      return { valid: false, reason: 'empty-prompt' };
    }
    if (normalizedPrompt.length < 5) {
      return { valid: false, reason: 'prompt-too-short' };
    }
    if (normalizedPrompt.length > 500) {
      return { valid: false, reason: 'prompt-too-long' };
    }
    const skillExists = !!(skillRegistry && skillRegistry.getSkill(normalizedSkillId));
    if (!skillExists) {
      return { valid: false, reason: 'skill-missing' };
    }
    return { valid: true, reason: '' };
  }

  function markTestCaseValidity(caseId: string, validityStatus: string, noteSuffix = '') {
    ensureSchema();
    const existing = getTestCase(caseId);
    if (!existing) {
      return null;
    }
    const nextNote = noteSuffix
      ? [existing.note, noteSuffix].filter(Boolean).join(' | ')
      : existing.note;
    store.db
      .prepare(
        'UPDATE skill_test_cases SET validity_status = @validityStatus, note = @note, updated_at = @updatedAt WHERE id = @id'
      )
      .run({
        id: caseId,
        validityStatus,
        note: nextNote,
        updatedAt: nowIso(),
      });
    return getTestCase(caseId);
  }

  async function smokeValidateGeneratedCases(cases: any[], runOptions: any = {}) {
    const validatedCases: any[] = [];
    const invalidCases: any[] = [];
    const smokeRuns: any[] = [];

    for (const testCase of cases) {
      const check = classifyPromptForSmokeRun(testCase && testCase.skillId, testCase && testCase.triggerPrompt);
      if (!check.valid) {
        const invalidCase = markTestCaseValidity(testCase.id, 'invalid', `Smoke validation skipped: ${check.reason}`);
        if (invalidCase) {
          invalidCases.push(invalidCase);
        }
        continue;
      }

      try {
        const result = await executeRun(testCase, {
          ...runOptions,
          smokeValidation: true,
        });
        smokeRuns.push(result);
        const refreshed = result && result.testCase ? result.testCase : getTestCase(testCase.id);
        if (refreshed && refreshed.validityStatus === 'validated') {
          validatedCases.push(refreshed);
        } else if (refreshed) {
          invalidCases.push(refreshed);
        }
      } catch (error: any) {
        const invalidCase = markTestCaseValidity(
          testCase.id,
          'invalid',
          `Smoke validation failed: ${String(error && error.message ? error.message : error || 'unknown error')}`
        );
        if (invalidCase) {
          invalidCases.push(invalidCase);
        }
      }
    }

    return {
      validatedCases,
      invalidCases,
      smokeRuns,
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
    const promptVersion = String(runOptions.promptVersion || '').trim() || 'skill-test-v1';

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
          promptVersion,
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
        const handle = startRunImpl(provider || '', model || '', prompt, {
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
      const evaluation = status === 'succeeded'
        ? await Promise.resolve(
          evaluateRunImpl
            ? evaluateRunImpl(taskId, testCase, {
              outputText,
              sessionPath,
              status,
              provider,
              model,
              promptVersion,
              agentId,
              agentName,
              taskId,
              prompt,
              sandbox,
            })
            : evaluateRun(taskId, testCase, {
              outputText,
              sessionPath,
              status,
              provider,
              model,
              promptVersion,
              agentId,
              agentName,
              taskId,
              prompt,
              sandbox,
            })
        )
        : {
          triggerPassed: 0,
          executionPassed: null,
          toolAccuracy: null,
          actualToolsJson: '[]',
          triggerEvaluation: null,
          executionEvaluation: null,
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
        promptVersion,
        triggerPassed: evaluation.triggerPassed,
        executionPassed: evaluation.executionPassed,
        toolAccuracy: evaluation.toolAccuracy,
        actualTools: safeJsonParse(evaluation.actualToolsJson) || [],
        triggerEvaluation: evaluation.triggerEvaluation || null,
        executionEvaluation: evaluation.executionEvaluation || null,
        source: 'skill_test',
      };

      store.db
        .prepare(
          `INSERT INTO eval_case_runs (
            id, case_id, variant, provider, model, prompt_version, thinking,
            prompt, run_id, task_id, status, error_message,
            output_text, result_json, session_path, created_at
          ) VALUES (
            @id, @caseId, @variant, @provider, @model, @promptVersion, @thinking,
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
          promptVersion,
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

      const newValidity = getCaseValidityAfterEvaluation(testCase, evaluation);
      store.db
        .prepare(
          'UPDATE skill_test_cases SET validity_status = @validityStatus, updated_at = @updatedAt WHERE id = @id'
        )
        .run({ id: testCase.id, validityStatus: newValidity, updatedAt: finishedAt });

      const runRow = store.db
        .prepare(
          `SELECT
             r.*, 
             e.provider AS provider,
             e.model AS model,
             e.prompt_version AS prompt_version
           FROM skill_test_runs r
           LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
           WHERE r.id = @id`
        )
        .get({ id: testRunId });
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

      // POST /api/skills/:skillId/test-cases/generate — AI generate + smoke validate
      if (req.method === 'POST' && subPath === 'generate') {
        const skill = skillRegistry ? skillRegistry.getSkill(skillId) : null;
        if (!skill) {
          throw createHttpError(404, `Skill not found: ${skillId}`);
        }

        const body = await readRequestJson(req).catch(() => ({}));
        const count = Math.max(1, Math.min(10, Number(body.count || 3)));
        const loadingMode = String(body.loadingMode || 'dynamic').trim() || 'dynamic';
        const testType = String(body.testType || 'trigger').trim() || 'trigger';
        const prompts = generateSkillTestPrompts(skill, {
          count,
          testType,
          loadingMode,
        });

        const cases: any[] = [];
        for (const prompt of prompts) {
          const tc = createTestCase({
            skillId,
            testType,
            loadingMode,
            triggerPrompt: prompt.triggerPrompt,
            expectedTools: prompt.expectedTools || [],
            expectedBehavior: prompt.expectedBehavior || '',
            note: prompt.note || 'Auto-generated',
          });
          if (tc) {
            cases.push(tc);
          }
        }

        const smoke = await smokeValidateGeneratedCases(cases, {
          provider: body.provider,
          model: body.model,
          promptVersion: body.promptVersion,
          agentId: body.agentId,
          agentName: body.agentName,
        });

        sendJson(res, 201, {
          generated: cases.length,
          validated: smoke.validatedCases.length,
          invalid: smoke.invalidCases.length,
          cases: cases.map((testCase) => getTestCase(testCase.id)).filter(Boolean),
          smokeRuns: smoke.smokeRuns,
        });
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

      // POST /api/skills/:skillId/test-cases/run-all — run all validated + invalid cases
      if (req.method === 'POST' && subPath === 'run-all') {
        ensureSchema();
        const cases = store.db
          .prepare(
            `SELECT * FROM skill_test_cases
             WHERE skill_id = @skillId AND validity_status IN ('validated', 'invalid')
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
              promptVersion: body.promptVersion,
              agentId: body.agentId,
              agentName: body.agentName,
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
              `SELECT
                 r.*, 
                 e.provider AS provider,
                 e.model AS model,
                 e.prompt_version AS prompt_version
               FROM skill_test_runs r
               LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
               WHERE r.test_case_id = @caseId
               ORDER BY r.created_at DESC
               LIMIT @limit`
            )
            .all({ caseId, limit: safeRunsLimit });
          sendJson(res, 200, { runs: rows.map(normalizeTestRunRow).filter(Boolean) });
          return true;
        }

        // GET /api/skills/:skillId/test-cases/:caseId/regression
        if (req.method === 'GET' && action === 'regression') {
          const testCase = getTestCase(caseId);
          if (!testCase) {
            throw createHttpError(404, 'Test case not found');
          }
          sendJson(res, 200, {
            testCaseId: caseId,
            regression: getCaseRegressionSummary(caseId),
          });
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
            promptVersion: body.promptVersion,
            agentId: body.agentId,
            agentName: body.agentName,
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

    const skillRegressionMatch = pathname.match(/^\/api\/skills\/([^/]+)\/regression$/);
    if (skillRegressionMatch && req.method === 'GET') {
      const skillId = decodeURIComponent(skillRegressionMatch[1]);
      sendJson(res, 200, {
        skillId,
        regression: getSkillRegressionSummary(skillId),
      });
      return true;
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
      const row = store.db
        .prepare(
          `SELECT
             r.*, 
             e.provider AS provider,
             e.model AS model,
             e.prompt_version AS prompt_version,
             e.result_json AS result_json
           FROM skill_test_runs r
           LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
           WHERE r.id = @id`
        )
        .get({ id: runId });
      const run = normalizeTestRunRow(row);
      if (!run) {
        throw createHttpError(404, 'Test run not found');
      }
      const debug = getSkillTestRunDebug(run);
      const result = safeJsonParse(row && row.result_json);
      sendJson(res, 200, { run, debug, result });
      return true;
    }

    return false;
  };
}
