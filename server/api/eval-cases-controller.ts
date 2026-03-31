import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import { migrateRunSchema } from '../../storage/sqlite/migrations';
import { DEFAULT_THINKING, resolveSetting, startRun } from '../../lib/minimal-pi';
import { createSqliteRunStore } from '../../lib/sqlite-store';
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

function normalizeEvalCaseRow(row: any) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const bResult = safeJsonParse(row.b_result_json);

  return {
    id: String(row.id || '').trim(),
    conversationId: String(row.conversation_id || '').trim(),
    turnId: String(row.turn_id || '').trim(),
    messageId: String(row.message_id || '').trim(),
    stageTaskId: String(row.stage_task_id || '').trim(),
    agentId: String(row.agent_id || '').trim(),
    agentName: String(row.agent_name || '').trim(),
    provider: String(row.provider || '').trim(),
    model: String(row.model || '').trim(),
    thinking: String(row.thinking || '').trim(),
    promptVersion: String(row.prompt_version || '').trim(),
    modelProfileId: String(row.model_profile_id || '').trim(),
    expectations: safeJsonParse(row.expectations_json),
    promptA: String(row.prompt_a || ''),
    outputA: String(row.output_a || ''),
    promptB: row.prompt_b === null || row.prompt_b === undefined ? '' : String(row.prompt_b),
    outputB: row.output_b === null || row.output_b === undefined ? '' : String(row.output_b),
    note: row.note === null || row.note === undefined ? '' : String(row.note),
    b: {
      runId: Number.isInteger(row.b_run_id) ? row.b_run_id : row.b_run_id ? Number(row.b_run_id) : null,
      taskId: String(row.b_task_id || '').trim(),
      status: String(row.b_status || '').trim(),
      errorMessage: row.b_error_message === null || row.b_error_message === undefined ? '' : String(row.b_error_message),
      result: bResult,
    },
    createdAt: String(row.created_at || '').trim(),
    updatedAt: String(row.updated_at || '').trim(),
  };
}

function normalizeEvalCaseRunRow(row: any) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const result = safeJsonParse(row.result_json);

  return {
    id: String(row.id || '').trim(),
    caseId: String(row.case_id || '').trim(),
    variant: String(row.variant || '').trim(),
    provider: String(row.provider || '').trim(),
    model: String(row.model || '').trim(),
    thinking: String(row.thinking || '').trim(),
    prompt: String(row.prompt || ''),
    runId: Number.isInteger(row.run_id) ? row.run_id : row.run_id ? Number(row.run_id) : null,
    taskId: String(row.task_id || '').trim(),
    status: String(row.status || '').trim(),
    errorMessage: row.error_message === null || row.error_message === undefined ? '' : String(row.error_message),
    outputText: row.output_text === null || row.output_text === undefined ? '' : String(row.output_text),
    sessionPath: row.session_path === null || row.session_path === undefined ? '' : String(row.session_path),
    result,
    createdAt: String(row.created_at || '').trim(),
  };
}

function buildObservedToolMetrics(message: any) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;

  return {
    publicToolUsed: Boolean(metadata && metadata.publicToolUsed),
    publicPostCount: Number.isInteger(metadata && metadata.publicPostCount) ? metadata.publicPostCount : 0,
    privatePostCount: Number.isInteger(metadata && metadata.privatePostCount) ? metadata.privatePostCount : 0,
    privateHandoffCount: Number.isInteger(metadata && metadata.privateHandoffCount) ? metadata.privateHandoffCount : 0,
    publiclySilent: Boolean(metadata && metadata.publiclySilent),
    privateOnly: Boolean(metadata && metadata.privateOnly),
  };
}

function resolveToolRelativePath(toolPath: string) {
  const cwd = process.cwd();
  const absolutePath = path.resolve(String(toolPath || ''));
  const relativePath = path.relative(cwd, absolutePath) || path.basename(absolutePath);
  const portablePath = relativePath.replace(/\\/g, '/');

  if (portablePath.startsWith('.') || portablePath.startsWith('/')) {
    return portablePath;
  }

  if (/^[A-Za-z]:\//.test(portablePath)) {
    return portablePath;
  }

  return `./${portablePath}`;
}

function isPathWithin(parentDir: string, targetPath: string) {
  const relative = path.relative(parentDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeSessionContentType(value: any) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function readSessionAssistantSnapshot(sessionPath: any, agentDir: any) {
  const pathValue = String(sessionPath || '').trim();
  const baseDir = String(agentDir || '').trim();

  if (!pathValue || !baseDir) {
    return null;
  }

  const sessionsDir = path.resolve(baseDir, 'named-sessions');
  const resolvedPath = path.resolve(pathValue);

  if (!isPathWithin(sessionsDir, resolvedPath)) {
    return null;
  }

  let text = '';

  try {
    if (!fs.existsSync(resolvedPath)) {
      return null;
    }

    text = fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/);
  const thinkingParts: string[] = [];
  const textParts: string[] = [];
  const toolCalls: any[] = [];
  const assistantErrors: string[] = [];
  const assistantMessagesTail: any[] = [];
  let assistantMessageTotal = 0;
  let lastAssistant: any = null;

  for (const line of lines) {
    const trimmed = String(line || '').trim();

    if (!trimmed) {
      continue;
    }

    let entry: any = null;

    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!entry || entry.type !== 'message' || !entry.message || entry.message.role !== 'assistant') {
      continue;
    }

    const message = entry.message;
    assistantMessageTotal += 1;
    lastAssistant = message;
    assistantMessagesTail.push(message);

    if (assistantMessagesTail.length > 6) {
      assistantMessagesTail.shift();
    }

    if (message.stopReason === 'error' && message.errorMessage) {
      assistantErrors.push(String(message.errorMessage));
    }

    const content = Array.isArray(message.content) ? message.content : [];

    for (const item of content) {
      const type = normalizeSessionContentType(item && item.type ? item.type : '');

      if (type === 'thinking') {
        const thinkingText = item && item.thinking ? String(item.thinking) : '';
        if (thinkingText) {
          thinkingParts.push(thinkingText);
        }
        continue;
      }

      if (type === 'text') {
        const chunk = item && item.text ? String(item.text) : '';
        if (chunk) {
          textParts.push(chunk);
        }
        continue;
      }

      if (type === 'tool_call' || type === 'toolcall' || type === 'tool_use' || type === 'tooluse') {
        toolCalls.push({
          id: item && item.id ? String(item.id) : '',
          name: item && item.name ? String(item.name) : '',
          arguments: item && item.arguments !== undefined ? item.arguments : null,
          partialJson: item && item.partialJson ? String(item.partialJson) : '',
          raw: item,
        });
      }
    }
  }

  const lastStopReason = lastAssistant && lastAssistant.stopReason ? String(lastAssistant.stopReason) : '';
  const lastApi = lastAssistant && lastAssistant.api ? String(lastAssistant.api) : '';
  const lastProvider = lastAssistant && lastAssistant.provider ? String(lastAssistant.provider) : '';
  const lastModel = lastAssistant && lastAssistant.model ? String(lastAssistant.model) : '';
  const lastError = lastAssistant && lastAssistant.errorMessage ? String(lastAssistant.errorMessage) : '';
  const lastResponseId = lastAssistant && lastAssistant.responseId ? String(lastAssistant.responseId) : '';
  const lastTimestamp = lastAssistant && lastAssistant.timestamp !== undefined ? lastAssistant.timestamp : null;

  return {
    sessionPath: resolvedPath,
    assistantMessageTotal,
    stopReason: lastStopReason,
    errorMessage: lastError,
    api: lastApi,
    provider: lastProvider,
    model: lastModel,
    responseId: lastResponseId,
    timestamp: lastTimestamp,
    usage: lastAssistant && lastAssistant.usage && typeof lastAssistant.usage === 'object' ? lastAssistant.usage : null,
    thinking: thinkingParts.filter(Boolean).join('\n\n---\n\n'),
    text: textParts.filter(Boolean).join(''),
    toolCalls,
    assistantErrors,
    assistantMessagesTail,
  };
}

export function createEvalCasesController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  const agentToolBridge = options.agentToolBridge;
  const getProjectDir = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  let runSchemaReady = false;

  if (!store || !store.db) {
    return async function handleMissingEvalCasesController(context) {
      const { req, pathname } = context;

      if (pathname.startsWith('/api/eval-cases') && req.method) {
        throw createHttpError(501, 'Eval cases store is not configured');
      }

      return false;
    };
  }

  function ensureRunSchema() {
    if (runSchemaReady) {
      return;
    }

    migrateRunSchema(store.db);
    runSchemaReady = true;
  }

  function getTaskDebug(taskId: any) {
    const normalizedTaskId = String(taskId || '').trim();

    if (!normalizedTaskId) {
      return null;
    }

    ensureRunSchema();

    let taskRow: any = null;

    try {
      taskRow = store.db
        .prepare(
          `
          SELECT
            id,
            status,
            run_id,
            session_path,
            requested_session,
            output_text,
            error_message,
            metadata_json,
            started_at,
            ended_at,
            updated_at
          FROM a2a_tasks
          WHERE id = @taskId
        `
        )
        .get({ taskId: normalizedTaskId });
    } catch {
      taskRow = null;
    }

    const taskMetadata = taskRow ? safeJsonParse(taskRow.metadata_json) : null;
    const sessionPath = taskRow && taskRow.session_path ? String(taskRow.session_path).trim() : '';
    const snapshot = sessionPath ? readSessionAssistantSnapshot(sessionPath, store.agentDir) : null;

    let toolRows: any[] = [];

    try {
      toolRows = store.db
        .prepare(
          `
          SELECT event_json, created_at
          FROM a2a_task_events
          WHERE task_id = @taskId
            AND event_type = 'agent_tool_call'
          ORDER BY id ASC
          LIMIT 200
        `
        )
        .all({ taskId: normalizedTaskId });
    } catch {
      toolRows = [];
    }

    return {
      task: taskRow
        ? {
            id: String(taskRow.id || '').trim(),
            status: String(taskRow.status || '').trim(),
            runId: Number.isInteger(taskRow.run_id) ? taskRow.run_id : taskRow.run_id ? Number(taskRow.run_id) : null,
            sessionPath: sessionPath || null,
            requestedSession: taskRow.requested_session ? String(taskRow.requested_session).trim() : '',
            outputText: taskRow.output_text === null || taskRow.output_text === undefined ? '' : String(taskRow.output_text),
            errorMessage: taskRow.error_message === null || taskRow.error_message === undefined ? '' : String(taskRow.error_message),
            metadata: taskMetadata,
            startedAt: taskRow.started_at ? String(taskRow.started_at).trim() : '',
            endedAt: taskRow.ended_at ? String(taskRow.ended_at).trim() : '',
            updatedAt: taskRow.updated_at ? String(taskRow.updated_at).trim() : '',
          }
        : null,
      session: snapshot,
      toolCalls: toolRows
        .map((row) => ({
          createdAt: row && row.created_at ? String(row.created_at).trim() : '',
          payload: safeJsonParse(row && row.event_json ? row.event_json : null),
        }))
        .filter((item) => item && item.payload),
    };
  }

  function listEvalCases(limit = 80) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 80;
    const rows = store.db
      .prepare(
        `
        SELECT
          id,
          conversation_id,
          turn_id,
          message_id,
          stage_task_id,
          agent_id,
          agent_name,
          provider,
          model,
          thinking,
          prompt_version,
          model_profile_id,
          expectations_json,
          prompt_b,
          note,
          b_status,
          created_at,
          updated_at
        FROM eval_cases
        ORDER BY created_at DESC
        LIMIT @limit
      `
      )
      .all({ limit: safeLimit });

    return rows.map(normalizeEvalCaseRow).filter(Boolean);
  }

  function getEvalCase(caseId: any) {
    const row = store.db
      .prepare('SELECT * FROM eval_cases WHERE id = @id')
      .get({ id: String(caseId || '').trim() });
    const normalized = normalizeEvalCaseRow(row);

    if (!normalized || !normalized.messageId || typeof store.getMessage !== 'function') {
      return normalized;
    }

    const message = store.getMessage(normalized.messageId);

    if (!message) {
      return normalized;
    }

    const messageMetadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    const sessionPathValue = messageMetadata && messageMetadata.sessionPath ? String(messageMetadata.sessionPath).trim() : '';
    const aSession = sessionPathValue ? readSessionAssistantSnapshot(sessionPathValue, store.agentDir) : null;
    const aDebug = getTaskDebug(normalized.stageTaskId);
    const bDebug = normalized && normalized.b && normalized.b.taskId ? getTaskDebug(normalized.b.taskId) : null;

    return {
      ...normalized,
      a: buildObservedToolMetrics(message),
      aChat: {
        status: String(message.status || '').trim(),
        errorMessage: String(message.errorMessage || '').trim(),
        sessionName: messageMetadata && messageMetadata.sessionName ? String(messageMetadata.sessionName).trim() : '',
        sessionPath: sessionPathValue,
        runId: message && message.runId !== undefined ? message.runId : null,
      },
      aSession,
      aDebug,
      bDebug,
    };
  }

  function listEvalCaseRuns(caseId: any, limit = 50) {
    const normalizedCaseId = String(caseId || '').trim();

    if (!normalizedCaseId) {
      return [];
    }

    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;

    let rows: any[] = [];

    try {
      rows = store.db
        .prepare(
          `
          SELECT *
          FROM eval_case_runs
          WHERE case_id = @caseId
          ORDER BY created_at DESC
          LIMIT @limit
        `
        )
        .all({ caseId: normalizedCaseId, limit: safeLimit });
    } catch {
      rows = [];
    }

    return rows.map(normalizeEvalCaseRunRow).filter(Boolean);
  }

  function getEvalCaseRun(runId: any) {
    const normalizedRunId = String(runId || '').trim();

    if (!normalizedRunId) {
      return null;
    }

    let row: any = null;

    try {
      row = store.db.prepare('SELECT * FROM eval_case_runs WHERE id = @id').get({ id: normalizedRunId });
    } catch {
      row = null;
    }

    const normalized = normalizeEvalCaseRunRow(row);

    if (!normalized) {
      return null;
    }

    const debug = normalized.taskId ? getTaskDebug(normalized.taskId) : null;

    return {
      ...normalized,
      debug,
    };
  }

  return async function handleEvalCasesRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    if (req.method === 'GET' && pathname === '/api/eval-cases') {
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '', 10);
      sendJson(res, 200, { cases: listEvalCases(limit) });
      return true;
    }

    const caseRunsMatch = pathname.match(/^\/api\/eval-cases\/([^/]+)\/runs$/);

    if (caseRunsMatch && req.method === 'GET') {
      const caseId = decodeURIComponent(caseRunsMatch[1]);
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '', 10);
      sendJson(res, 200, { runs: listEvalCaseRuns(caseId, limit) });
      return true;
    }

    const runDetailMatch = pathname.match(/^\/api\/eval-case-runs\/([^/]+)$/);

    if (runDetailMatch && req.method === 'GET') {
      const runId = decodeURIComponent(runDetailMatch[1]);
      const payload = getEvalCaseRun(runId);

      if (!payload) {
        throw createHttpError(404, 'Eval case run not found');
      }

      sendJson(res, 200, { run: payload });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/eval-cases') {
      ensureRunSchema();

      const body = await readRequestJson(req);
      const conversationId = String(body && body.conversationId ? body.conversationId : '').trim();
      const messageId = String(body && body.messageId ? body.messageId : '').trim();
      const note = String(body && body.note ? body.note : '').trim();

      if (!conversationId) {
        throw createHttpError(400, 'conversationId is required');
      }

      if (!messageId) {
        throw createHttpError(400, 'messageId is required');
      }

      const conversation = store.getConversation(conversationId);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      const message =
        Array.isArray(conversation.messages) ? conversation.messages.find((item: any) => item && item.id === messageId) : null;

      if (!message || message.role !== 'assistant') {
        throw createHttpError(404, 'Assistant message not found');
      }

      const stageTaskId = message.taskId ? String(message.taskId).trim() : '';

      if (!stageTaskId) {
        throw createHttpError(409, 'This assistant message does not have a taskId yet');
      }

      const taskRow = store.db
        .prepare(
          `
          SELECT
            id,
            provider,
            model,
            input_text,
            metadata_json
          FROM a2a_tasks
          WHERE id = @taskId
        `
        )
        .get({ taskId: stageTaskId });

      if (!taskRow || !taskRow.input_text) {
        throw createHttpError(404, 'Run task prompt not found');
      }

      const taskMetadata = safeJsonParse(taskRow.metadata_json) || {};
      const promptVersion = String(taskMetadata.promptVersion || '').trim();
      const modelProfileId = String(taskMetadata.modelProfileId || '').trim();
      const agentId = String(message.agentId || '').trim();
      const agent = agentId && typeof store.getAgent === 'function' ? store.getAgent(agentId) : null;
      const modelProfiles = agent && Array.isArray(agent.modelProfiles) ? agent.modelProfiles : [];
      const modelProfile = modelProfileId
        ? modelProfiles.find((profile) => profile && String(profile.id || '').trim() === modelProfileId) || null
        : null;
      const agentThinking = resolveSetting(
        modelProfile && modelProfile.thinking ? String(modelProfile.thinking) : '',
        agent && agent.thinking ? String(agent.thinking) : '',
        ''
      );
      const thinking = resolveSetting(agentThinking, process.env.PI_THINKING, DEFAULT_THINKING);

      const expectationsRow = store.db
        .prepare(
          `
          SELECT event_json
          FROM a2a_task_events
          WHERE task_id = @taskId
            AND event_type = 'agent_expectations'
          ORDER BY id DESC
          LIMIT 1
        `
        )
        .get({ taskId: stageTaskId });

      const expectationsJson = expectationsRow && expectationsRow.event_json ? String(expectationsRow.event_json) : '';

      const caseId = randomUUID();
      const timestamp = nowIso();

      store.db
        .prepare(
          `
          INSERT INTO eval_cases (
            id,
            conversation_id,
            turn_id,
            message_id,
            stage_task_id,
            agent_id,
            agent_name,
            provider,
            model,
            thinking,
            prompt_version,
            model_profile_id,
            expectations_json,
            prompt_a,
            output_a,
            note,
            created_at,
            updated_at
          ) VALUES (
            @id,
            @conversationId,
            @turnId,
            @messageId,
            @stageTaskId,
            @agentId,
            @agentName,
            @provider,
            @model,
            @thinking,
            @promptVersion,
            @modelProfileId,
            @expectationsJson,
            @promptA,
            @outputA,
            @note,
            @createdAt,
            @updatedAt
          )
        `
        )
        .run({
          id: caseId,
          conversationId,
          turnId: String(message.turnId || '').trim(),
          messageId,
          stageTaskId,
          agentId,
          agentName: String(message.senderName || '').trim(),
          provider: taskRow.provider || null,
          model: taskRow.model || null,
          thinking: thinking || null,
          promptVersion: promptVersion || null,
          modelProfileId: modelProfileId || null,
          expectationsJson: expectationsJson || null,
          promptA: String(taskRow.input_text || ''),
          outputA: String(message.content || ''),
          note: note || null,
          createdAt: timestamp,
          updatedAt: timestamp,
        });

      sendJson(res, 201, { case: getEvalCase(caseId) });
      return true;
    }

    const caseMatch = pathname.match(/^\/api\/eval-cases\/([^/]+)$/);

    if (caseMatch && req.method === 'GET') {
      const caseId = decodeURIComponent(caseMatch[1]);
      const payload = getEvalCase(caseId);

      if (!payload) {
        throw createHttpError(404, 'Eval case not found');
      }

      sendJson(res, 200, { case: payload });
      return true;
    }

    if (caseMatch && req.method === 'PATCH') {
      const caseId = decodeURIComponent(caseMatch[1]);
      const existing = getEvalCase(caseId);

      if (!existing) {
        throw createHttpError(404, 'Eval case not found');
      }

      const body = await readRequestJson(req);
      const promptB = body && body.promptB !== undefined ? String(body.promptB ?? '') : null;
      const note = body && body.note !== undefined ? String(body.note ?? '') : null;
      const timestamp = nowIso();

      store.db
        .prepare(
          `
          UPDATE eval_cases
          SET
            prompt_b = COALESCE(@promptB, prompt_b),
            note = COALESCE(@note, note),
            updated_at = @updatedAt
          WHERE id = @id
        `
        )
        .run({
          id: caseId,
          promptB,
          note,
          updatedAt: timestamp,
        });

      sendJson(res, 200, { case: getEvalCase(caseId) });
      return true;
    }

    const runMatch = pathname.match(/^\/api\/eval-cases\/([^/]+)\/run$/);

    if (runMatch && req.method === 'POST') {
      ensureRunSchema();

      if (!agentToolBridge) {
        throw createHttpError(501, 'Agent tool bridge is not configured');
      }

      const caseId = decodeURIComponent(runMatch[1]);
      const existing = getEvalCase(caseId);

      if (!existing) {
        throw createHttpError(404, 'Eval case not found');
      }

      const body = await readRequestJson(req);
      const rawVariant = body && body.variant !== undefined ? String(body.variant ?? '') : '';
      const normalizedVariant = rawVariant.trim().toUpperCase();
      const variant = normalizedVariant ? normalizedVariant : 'B';

      if (variant !== 'A' && variant !== 'B') {
        throw createHttpError(400, 'variant must be A or B');
      }

      const hasPrompt = body && Object.prototype.hasOwnProperty.call(body, 'prompt');
      const hasPromptA = body && Object.prototype.hasOwnProperty.call(body, 'promptA');
      const hasPromptB = body && Object.prototype.hasOwnProperty.call(body, 'promptB');

      const promptValue = hasPrompt
        ? String(body.prompt ?? '')
        : variant === 'A'
          ? hasPromptA
            ? String(body.promptA ?? '')
            : existing.promptA
          : hasPromptB
            ? String(body.promptB ?? '')
            : existing.promptB;
      const prompt = String(promptValue || '').trim();

      if (!prompt) {
        throw createHttpError(400, 'prompt is required');
      }

      const hasProviderOverride = body && Object.prototype.hasOwnProperty.call(body, 'provider');
      const hasModelOverride = body && Object.prototype.hasOwnProperty.call(body, 'model');
      const provider = String(hasProviderOverride ? body.provider ?? '' : existing.provider || '').trim();
      const model = String(hasModelOverride ? body.model ?? '' : existing.model || '').trim();
      const agent = existing.agentId ? store.getAgent(existing.agentId) : null;
      const sandbox = ensureAgentSandbox(store.agentDir, agent || { id: existing.agentId || 'eval' });
      const conversation = store.getConversation(existing.conversationId);
      const projectDirCandidate = getProjectDir ? String(getProjectDir(conversation) || '').trim() : '';
      const projectDir = projectDirCandidate ? path.resolve(projectDirCandidate) : '';
      const conversationAgents = conversation && Array.isArray(conversation.agents) ? conversation.agents : [];
      const conversationMessages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
      const replayUserMessage =
        conversationMessages.find(
          (message: any) =>
            message &&
            message.role === 'user' &&
            String(message.turnId || '').trim() === String(existing.turnId || '').trim()
        ) ||
        [...conversationMessages]
          .slice(0, Math.max(0, conversationMessages.findIndex((message: any) => message && message.id === existing.messageId)))
          .reverse()
          .find((message: any) => message && message.role === 'user') ||
        null;
      const promptUserMessage = replayUserMessage
        ? {
            id: String(replayUserMessage.id || '').trim() || 'eval-user',
            turnId: String(replayUserMessage.turnId || existing.turnId || 'eval-turn').trim(),
            role: 'user',
            senderName: String(replayUserMessage.senderName || 'You').trim() || 'You',
            content: replayUserMessage.content !== undefined ? replayUserMessage.content : '',
            status: String(replayUserMessage.status || 'completed').trim() || 'completed',
            createdAt: String(replayUserMessage.createdAt || nowIso()).trim() || nowIso(),
          }
        : {
            id: 'eval-user',
            turnId: existing.turnId || 'eval-turn',
            role: 'user',
            senderName: 'You',
            content: '(eval case replay)',
            status: 'completed',
            createdAt: nowIso(),
          };

      const runStore = createSqliteRunStore({ agentDir: store.agentDir, sqlitePath: store.databasePath });
      const taskId = `eval-case-run-${randomUUID()}`;
      const stage = { taskId, status: 'queued', runId: null as any };
      const sessionName = `eval-case-${existing.id}-${variant}-${Date.now()}`;
      const toolInvocation = agentToolBridge.registerInvocation(
        agentToolBridge.createInvocationContext({
          conversationId: existing.conversationId,
          turnId: existing.turnId,
          projectDir,
          agentId: existing.agentId,
          agentName: existing.agentName || (agent && agent.name) || 'Assistant',
          assistantMessageId: '',
          userMessageId: promptUserMessage && promptUserMessage.id ? promptUserMessage.id : null,
          promptUserMessage,
          conversationAgents,
          runStore,
          stage,
          turnState: null,
          enqueueAgent: null,
          allowHandoffs: false,
          dryRun: true,
        })
      );

      const toolBaseUrl = req.headers.host ? `http://${req.headers.host}` : 'http://127.0.0.1:3100';
      const agentToolScriptPath = path.resolve(ROOT_DIR, 'lib', 'agent-chat-tools.js');
      const agentToolRelativePath = resolveToolRelativePath(agentToolScriptPath);

      const timestamp = nowIso();
      runStore.createTask({
        taskId,
        kind: 'eval_case_run',
        title: `${existing.agentName || existing.agentId || 'Agent'} eval case run`,
        status: 'queued',
        assignedAgent: 'pi',
        assignedRole: existing.agentName || existing.agentId || 'Agent',
        provider: provider || null,
        model: model || null,
        requestedSession: sessionName,
        sessionPath: null,
        inputText: prompt,
        metadata: {
          caseId: existing.id,
          variant,
          conversationId: existing.conversationId || null,
          turnId: existing.turnId || null,
          messageId: existing.messageId || null,
          stageTaskId: existing.stageTaskId || null,
          agentId: existing.agentId || null,
          agentName: existing.agentName || null,
          promptVersion: existing.promptVersion || null,
          source: 'eval_cases',
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
      const endedAt = () => nowIso();

      try {
        const handle = startRun(provider, model, prompt, {
          thinking: existing.thinking || '',
          agentDir: store.agentDir,
          sqlitePath: store.databasePath,
          streamOutput: false,
          session: sessionName,
          taskId,
          taskKind: 'eval_case_run',
          taskRole: existing.agentName || existing.agentId || 'Agent',
          metadata: {
            caseId: existing.id,
            variant,
            source: 'eval_cases',
          },
          extraEnv: {
            PI_AGENT_ID: existing.agentId,
            PI_AGENT_NAME: existing.agentName,
            PI_AGENT_SANDBOX_DIR: sandbox.sandboxDir,
            PI_AGENT_PRIVATE_DIR: sandbox.privateDir,
            CAFF_CHAT_API_URL: toolBaseUrl,
            CAFF_CHAT_INVOCATION_ID: toolInvocation.invocationId,
            CAFF_CHAT_CALLBACK_TOKEN: toolInvocation.callbackToken,
            CAFF_CHAT_TOOLS_PATH: toPortableShellPath(agentToolScriptPath),
            CAFF_CHAT_TOOLS_RELATIVE_PATH: agentToolRelativePath,
            CAFF_CHAT_CONVERSATION_ID: existing.conversationId,
            CAFF_CHAT_TURN_ID: existing.turnId,
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

        outputText = toolInvocation && toolInvocation.publicToolUsed ? String(toolInvocation.lastPublicContent || '') : String(result.reply || '');
        status = 'succeeded';
      } catch (error) {
        const err: any = error;
        status = 'failed';
        errorMessage = err && err.message ? String(err.message) : String(err || 'Unknown error');
        outputText = toolInvocation && toolInvocation.publicToolUsed ? String(toolInvocation.lastPublicContent || '') : '';
      } finally {
        stage.status = status === 'succeeded' ? 'completed' : 'failed';
        if (toolInvocation) {
          agentToolBridge.unregisterInvocation(toolInvocation.invocationId);
        }
      }

      const runResult = {
        status,
        variant,
        publicToolUsed: Boolean(toolInvocation && toolInvocation.publicToolUsed),
        publicPostCount: toolInvocation ? toolInvocation.publicPostCount || 0 : 0,
        privatePostCount: toolInvocation ? toolInvocation.privatePostCount || 0 : 0,
        privateHandoffCount: toolInvocation ? toolInvocation.privateHandoffCount || 0 : 0,
        publicPosts: toolInvocation ? toolInvocation.dryRunPublicPosts || [] : [],
        privatePosts: toolInvocation ? toolInvocation.dryRunPrivatePosts || [] : [],
        rawReply: result && result.reply ? String(result.reply) : '',
      };

      const finishedAt = endedAt();
      runStore.updateTask(taskId, {
        status: status === 'succeeded' ? 'succeeded' : 'failed',
        runId,
        sessionPath: sessionPath || null,
        outputText: outputText || '',
        errorMessage: errorMessage || '',
        endedAt: finishedAt,
        artifactSummary: {
          kind: 'eval_case_result',
          publicToolUsed: runResult.publicToolUsed,
          publicPostCount: runResult.publicPostCount,
          privatePostCount: runResult.privatePostCount,
        },
      });

      const evalCaseRunId = randomUUID();

      store.db
        .prepare(
          `
          INSERT INTO eval_case_runs (
            id,
            case_id,
            variant,
            provider,
            model,
            thinking,
            prompt,
            run_id,
            task_id,
            status,
            error_message,
            output_text,
            result_json,
            session_path,
            created_at
          ) VALUES (
            @id,
            @caseId,
            @variant,
            @provider,
            @model,
            @thinking,
            @prompt,
            @runId,
            @taskId,
            @status,
            @errorMessage,
            @outputText,
            @resultJson,
            @sessionPath,
            @createdAt
          )
        `
        )
        .run({
          id: evalCaseRunId,
          caseId: existing.id,
          variant,
          provider: provider || null,
          model: model || null,
          thinking: existing.thinking || null,
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

      if (variant === 'B') {
        store.db
          .prepare(
            `
            UPDATE eval_cases
            SET
              prompt_b = @promptB,
              output_b = @outputB,
              b_run_id = @runId,
              b_task_id = @taskId,
              b_status = @status,
              b_error_message = @errorMessage,
              b_result_json = @resultJson,
              updated_at = @updatedAt
            WHERE id = @id
          `
          )
          .run({
            id: existing.id,
            promptB: prompt,
            outputB: outputText || null,
            runId,
            taskId,
            status,
            errorMessage: errorMessage || null,
            resultJson: JSON.stringify(runResult),
            updatedAt: finishedAt,
          });
      }

      runStore.close();

      const runRow = store.db.prepare('SELECT * FROM eval_case_runs WHERE id = @id').get({ id: evalCaseRunId });
      const runPayload = normalizeEvalCaseRunRow(runRow);

      sendJson(res, 200, { case: getEvalCase(existing.id), run: runPayload });
      return true;
    }

    return false;
  };
}
