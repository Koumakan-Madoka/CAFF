import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import { migrateRunSchema } from '../../storage/sqlite/migrations';
import { startRun } from '../../lib/minimal-pi';
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

export function createEvalCasesController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  const agentToolBridge = options.agentToolBridge;
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

    return {
      ...normalized,
      a: buildObservedToolMetrics(message),
    };
  }

  return async function handleEvalCasesRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    if (req.method === 'GET' && pathname === '/api/eval-cases') {
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '', 10);
      sendJson(res, 200, { cases: listEvalCases(limit) });
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
          agentId: String(message.agentId || '').trim(),
          agentName: String(message.senderName || '').trim(),
          provider: taskRow.provider || null,
          model: taskRow.model || null,
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
      const promptB =
        body && body.prompt !== undefined
          ? String(body.prompt ?? '')
          : body && body.promptB !== undefined
            ? String(body.promptB ?? '')
            : existing.promptB;
      const prompt = String(promptB || '').trim();

      if (!prompt) {
        throw createHttpError(400, 'prompt is required');
      }

      const provider = existing.provider || '';
      const model = existing.model || '';
      const agent = existing.agentId ? store.getAgent(existing.agentId) : null;
      const sandbox = ensureAgentSandbox(store.agentDir, agent || { id: existing.agentId || 'eval' });

      const runStore = createSqliteRunStore({ agentDir: store.agentDir, sqlitePath: store.databasePath });
      const taskId = `eval-case-run-${randomUUID()}`;
      const stage = { taskId, status: 'queued', runId: null as any };
      const toolInvocation = agentToolBridge.registerInvocation(
        agentToolBridge.createInvocationContext({
          conversationId: existing.conversationId,
          turnId: existing.turnId,
          projectDir: '',
          agentId: existing.agentId,
          agentName: existing.agentName || (agent && agent.name) || 'Assistant',
          assistantMessageId: '',
          userMessageId: '',
          promptUserMessage: {
            id: 'eval-user',
            turnId: existing.turnId || 'eval-turn',
            role: 'user',
            senderName: 'You',
            content: '(eval case replay)',
            status: 'completed',
            createdAt: nowIso(),
          },
          conversationAgents: (store.getConversation(existing.conversationId) || {}).agents || [],
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
        requestedSession: null,
        sessionPath: null,
        inputText: prompt,
        metadata: {
          caseId: existing.id,
          variant: 'B',
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
      const endedAt = () => nowIso();

      try {
        const sessionName = `eval-case-${existing.id}-${Date.now()}`;
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
            variant: 'B',
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

        result = await handle.resultPromise;
        runId = result && result.runId ? result.runId : handle.runId || null;

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

      const bResult = {
        status,
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
        outputText: outputText || '',
        errorMessage: errorMessage || '',
        endedAt: finishedAt,
        artifactSummary: {
          kind: 'eval_case_result',
          publicToolUsed: bResult.publicToolUsed,
          publicPostCount: bResult.publicPostCount,
          privatePostCount: bResult.privatePostCount,
        },
      });

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
          resultJson: JSON.stringify(bResult),
          updatedAt: finishedAt,
        });

      runStore.close();

      sendJson(res, 200, { case: getEvalCase(existing.id) });
      return true;
    }

    return false;
  };
}
