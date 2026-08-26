import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_AGENT_DIR,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING,
  resolveIntegerSetting,
  resolveSetting,
  resolveThinkingSetting,
} from '../../../lib/minimal-pi';
import { createSqliteRunStore } from '../../../lib/sqlite-store';
import { createHttpError } from '../../http/http-errors';
import { RECOVERY_SCRIBE_SYSTEM_ACTOR } from '../roles/system-actor-catalog';
import { pickConversationSummary } from './conversation-view';
import { materializeAgentContextSnapshot } from './turn/context-snapshot';
import {
  MAX_RECOVERY_CAPSULE_BYTES,
  MAX_RECOVERY_OUTPUT_CHARS,
  buildMechanicalRecoveryMessage,
  buildRecoveryCapsule,
  redactRecoveryText,
} from './recovery-capsule';

const MAX_RECOVERY_PROMPT_BYTES = 72 * 1024;
const MAX_RECOVERY_MODEL_TOKENS = 2_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 60_000;
const MAX_SAFE_ERROR_CHARS = 240;
const REQUIRED_SCRIBE_HEADINGS = [
  '已经完成',
  '失败位置',
  '可能已生效但需核验',
  '尚未完成',
  '建议恢复点',
  '无法从现场判断',
];
const NON_EXECUTION_STATEMENT = '这是只读现场整理，不会执行或重放原任务。';
const SCRIBE_SYSTEM_PROMPT = [
  'You are the CAFF failed-trace recovery scribe.',
  'You have no tools, extensions, skills, chat bridge, shell, filesystem, network side effects, or task execution authority.',
  'Use only the redacted Recovery Capsule supplied by CAFF. Never claim business completion from assistant prose.',
  'Preserve evidence grades exactly: completed, possibly effective, not completed, and unknown.',
  'Write a concise Chinese recovery note with every required heading from the user message.',
  `Include this exact non-execution statement: ${NON_EXECUTION_STATEMENT}`,
  'Do not propose automatic replay. When a side effect may have happened, require verification before any continuation.',
].join('\n');

function clipText(value: any, maxLength: number) {
  const text = String(value || '').trim().replace(/\s+/gu, ' ');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 14)).trimEnd()}...[truncated]`;
}

function safeErrorText(error: any) {
  const value = error && error.message ? error.message : String(error || 'Unknown recovery failure');
  return clipText(redactRecoveryText(value), MAX_SAFE_ERROR_CHARS);
}

function recoveryError(statusCode: number, code: string, message: string, details: any = {}) {
  return createHttpError(statusCode, message, { code, ...details });
}

function isSqliteUniqueConstraintError(error: any) {
  const code = String(error && error.code || '');
  const message = String(error && error.message || '');
  return code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || /UNIQUE constraint failed/iu.test(message);
}

function normalizePath(value: any) {
  const text = String(value || '').trim();
  return text ? path.resolve(text) : '';
}

function samePath(left: any, right: any) {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isRegularFile(filePath: any) {
  try {
    return Boolean(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizeBooleanSetting(value: any, defaultValue: boolean, label: string) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(normalized)) {
    return false;
  }
  throw new Error(`${label} must be a boolean setting`);
}

function recoveryConfig(options: any = {}) {
  const enabled = options.enabled === undefined
    ? normalizeBooleanSetting(process.env.CAFF_RECOVERY_ENABLED, true, 'recovery enabled')
    : normalizeBooleanSetting(options.enabled, true, 'recovery enabled');
  const provider = resolveSetting(
    options.provider,
    process.env.CAFF_RECOVERY_PROVIDER || process.env.CAFF_DIGEST_PROVIDER || process.env.PI_PROVIDER,
    DEFAULT_PROVIDER
  );
  const model = resolveSetting(
    options.model,
    process.env.CAFF_RECOVERY_MODEL || process.env.CAFF_DIGEST_MODEL || process.env.PI_MODEL,
    DEFAULT_MODEL
  );
  const thinking = resolveThinkingSetting(
    provider,
    options.thinking,
    process.env.CAFF_RECOVERY_THINKING || process.env.CAFF_DIGEST_THINKING || process.env.PI_THINKING,
    DEFAULT_THINKING
  );
  const timeoutMs = resolveIntegerSetting(
    options.timeoutMs,
    process.env.CAFF_RECOVERY_TIMEOUT_MS,
    DEFAULT_RECOVERY_TIMEOUT_MS,
    'recovery timeout'
  );
  if (timeoutMs < 1_000 || timeoutMs > DEFAULT_RECOVERY_TIMEOUT_MS) {
    throw new Error(`recovery timeout must be between 1000 and ${DEFAULT_RECOVERY_TIMEOUT_MS} milliseconds`);
  }

  return { enabled, provider, model, thinking, timeoutMs };
}

function buildScribePrompt(capsule: any) {
  const prompt = [
    'Create one bounded failed-trace recovery note from this Recovery Capsule.',
    'Use these exact headings: 已经完成, 失败位置, 可能已生效但需核验, 尚未完成, 建议恢复点, 无法从现场判断.',
    `Include exactly this statement: ${NON_EXECUTION_STATEMENT}`,
    'Do not include hidden reasoning or invent evidence.',
    '',
    'Recovery Capsule JSON:',
    JSON.stringify(capsule),
  ].join('\n');

  if (Buffer.byteLength(prompt, 'utf8') > MAX_RECOVERY_PROMPT_BYTES) {
    throw new Error('Recovery scribe prompt exceeds the hard size limit');
  }
  return prompt;
}

function extractScribeText(output: any) {
  if (typeof output === 'string') {
    return output.trim();
  }
  const message = output && (output.message || output.assistantMessage || output);
  if (typeof (message && message.content) === 'string') {
    return String(message.content).trim();
  }
  const content = Array.isArray(message && message.content) ? message.content : [];
  return content
    .filter((item: any) => item && item.type === 'text' && item.text)
    .map((item: any) => String(item.text).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function validateScribeOutput(value: any) {
  const message = value && (value.message || value.assistantMessage || value);
  if (message && typeof message === 'object' && String(message.stopReason || '').toLowerCase() === 'error') {
    throw new Error('Recovery scribe reported a model invocation error');
  }
  const output = extractScribeText(value);
  if (!output) {
    throw new Error('Recovery scribe output is empty');
  }
  if (output.length > MAX_RECOVERY_OUTPUT_CHARS) {
    throw new Error('Recovery scribe output exceeds the hard size limit');
  }
  for (const heading of REQUIRED_SCRIBE_HEADINGS) {
    if (!output.includes(heading)) {
      throw new Error(`Recovery scribe output is missing heading: ${heading}`);
    }
  }
  if (!output.includes(NON_EXECUTION_STATEMENT)) {
    throw new Error('Recovery scribe output is missing the non-execution statement');
  }
  return output;
}

async function defaultModelRuntimeFactory(agentDir: string) {
  const runtimeModule = await Function(
    'specifier',
    'return import(specifier)'
  )('@earendil-works/pi-coding-agent');
  if (!runtimeModule || !runtimeModule.ModelRuntime) {
    throw new Error('Pinned Pi ModelRuntime is unavailable');
  }
  return runtimeModule.ModelRuntime.create({
    modelsPath: path.join(agentDir, 'models.json'),
  });
}

function modelIdCandidates(provider: string, model: string) {
  const values = [model];
  const prefix = `${provider}/`;
  if (model.toLowerCase().startsWith(prefix.toLowerCase())) {
    values.push(model.slice(prefix.length));
  }
  return Array.from(new Set(values.filter(Boolean)));
}

async function invokeScribe(capsule: any, config: any, options: any) {
  const prompt = buildScribePrompt(capsule);
  const runtimeFactory = typeof options.modelRuntimeFactory === 'function'
    ? options.modelRuntimeFactory
    : defaultModelRuntimeFactory;
  const controller = new AbortController();
  let timeoutReject: any = null;
  const timeout: Promise<never> = new Promise((_resolve, reject) => {
    timeoutReject = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    const error = new Error('Recovery scribe timed out') as any;
    error.name = 'AbortError';
    timeoutReject(error);
  }, config.timeoutMs);
  const work = (async () => {
    const runtime = await runtimeFactory(options.agentDir, config);
    if (controller.signal.aborted) {
      const error = new Error('Recovery scribe timed out') as any;
      error.name = 'AbortError';
      throw error;
    }
    const model = modelIdCandidates(config.provider, config.model)
      .map((modelId) => runtime.getModel(config.provider, modelId))
      .find(Boolean);
    if (!model) {
      throw new Error(`Recovery model is unavailable: ${config.provider}/${config.model}`);
    }
    const output = await runtime.completeSimple(model, {
      systemPrompt: SCRIBE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      }],
    }, {
      signal: controller.signal,
      maxTokens: MAX_RECOVERY_MODEL_TOKENS,
      reasoning: config.thinking,
    });
    return { output: validateScribeOutput(output), prompt, raw: output };
  })();

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function projectRecoveryRecord(recovery: any, inFlight: Map<string, any>) {
  if (!recovery) {
    return null;
  }
  const persistedStatus = String(recovery.status || '');
  const interrupted = ['queued', 'running'].includes(persistedStatus) && !inFlight.has(recovery.id);
  return {
    id: recovery.id,
    sourceMessageId: recovery.sourceMessageId,
    sourceTaskId: recovery.sourceTaskId,
    sourceRunId: recovery.sourceRunId,
    recoveryTaskId: recovery.recoveryTaskId,
    recoveryRunId: recovery.recoveryRunId,
    recoveryMessageId: recovery.recoveryMessageId,
    status: interrupted ? 'failed' : persistedStatus,
    ...(interrupted ? { persistedStatus, interrupted: true } : {}),
    fallbackUsed: Boolean(recovery.fallbackUsed),
    errorCode: interrupted ? 'conversation_recovery_interrupted' : recovery.errorCode,
    errorMessage: interrupted ? 'Recovery was interrupted before completion' : recovery.errorMessage,
    createdAt: recovery.createdAt,
    updatedAt: recovery.updatedAt,
    startedAt: recovery.startedAt,
    endedAt: recovery.endedAt,
  };
}

function minimalCapsule(source: any, error: any) {
  const failureText = safeErrorText(error);
  return {
    version: 1,
    source: {
      conversationId: source.message.conversationId,
      messageId: source.message.id,
      taskId: source.message.taskId,
      runId: source.message.runId,
      agentId: source.message.agentId || null,
      agentName: clipText(source.message.senderName, 120),
      failedAt: source.message.createdAt || '',
    },
    objective: { originalRequest: '', acceptance: [], contextSections: [] },
    failure: {
      messageError: clipText(redactRecoveryText(source.message.errorMessage), MAX_SAFE_ERROR_CHARS),
      taskError: clipText(redactRecoveryText(source.task.error_message), MAX_SAFE_ERROR_CHARS),
      runError: failureText || clipText(redactRecoveryText(source.run.error_message), MAX_SAFE_ERROR_CHARS),
      terminationType: clipText(source.run.termination_type, 80),
      assistantErrors: [],
    },
    tools: [],
    evidenceSummary: { completed: [], possiblyEffective: [], notCompleted: [], unknown: [] },
    truncation: { truncated: true, droppedToolCount: 0, droppedChars: 0 },
  };
}

export function createMessageRecoveryService(options: any = {}) {
  const store = options.store;
  const agentDir = resolveSetting(options.agentDir, process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const runStore = options.runStore || createSqliteRunStore({
    agentDir,
    sqlitePath: options.sqlitePath,
    db: store && store.db,
  });
  const config = recoveryConfig(options);
  const mutationCoordinator = options.mutationCoordinator || null;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const getConversationMutationState = typeof options.getConversationMutationState === 'function'
    ? options.getConversationMutationState
    : () => ({ busy: true, unavailable: true });
  const resolveAssistantMessageSessionPath = typeof options.resolveAssistantMessageSessionPath === 'function'
    ? options.resolveAssistantMessageSessionPath
    : (message: any) => String(message && message.metadata && message.metadata.sessionPath || '').trim();
  const scheduleBackground = typeof options.scheduleBackground === 'function'
    ? options.scheduleBackground
    : (work: any) => setImmediate(() => void work().catch((error: any) => {
      console.error(`[message-recovery] Background recovery failed: ${safeErrorText(error)}`);
    }));
  const inFlight = new Map<string, any>();

  function emitRecovery(recovery: any) {
    try {
      broadcastEvent('conversation_recovery_updated', {
        conversationId: recovery.conversationId,
        sourceMessageId: recovery.sourceMessageId,
        recovery: projectRecoveryRecord(recovery, inFlight),
      });
    } catch {}
  }

  function requireConversation(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();
    const conversation = store.getConversationWithoutMessages(normalizedConversationId);
    if (!conversation) {
      throw recoveryError(404, 'conversation_recovery_conversation_not_found', 'Conversation not found');
    }
    return conversation;
  }

  function requireSourceMessage(conversationId: string, messageId: any) {
    const normalizedMessageId = String(messageId || '').trim();
    const message = store.getMessage(normalizedMessageId);
    if (!message || message.conversationId !== conversationId) {
      throw recoveryError(404, 'conversation_recovery_source_not_found', 'Recovery source message not found');
    }
    if (message.role !== 'assistant' || message.status !== 'failed') {
      throw recoveryError(409, 'conversation_recovery_source_not_failed', 'Only failed assistant messages can be recovered');
    }
    return message;
  }

  function requireIdle(conversationId: string, validationOptions: any = {}) {
    const runtime = getConversationMutationState(conversationId) || {};
    if (runtime.busy) {
      throw recoveryError(409, 'conversation_recovery_conversation_busy', 'Conversation has active or queued work');
    }
    if (validationOptions.ignoreMutation === true) {
      return;
    }
    const mutation = mutationCoordinator && typeof mutationCoordinator.describe === 'function'
      ? mutationCoordinator.describe(conversationId)
      : { active: false, digestScheduled: false };
    if (mutation.active || mutation.digestScheduled) {
      throw recoveryError(409, 'conversation_recovery_conversation_busy', 'Conversation history is being modified');
    }
  }

  function sourceIntegrity(conversation: any, message: any) {
    const taskId = String(message.taskId || '').trim();
    const runId = Number(message.runId);
    const task = taskId ? runStore.getTask(taskId) : null;
    const run = Number.isInteger(runId) && runId > 0 ? runStore.getRun(runId) : null;
    const storedContextSnapshot = store.getMessageContextSnapshot(message.id);
    const contextSnapshot = materializeAgentContextSnapshot(storedContextSnapshot);
    let sessionPath = '';
    try {
      sessionPath = normalizePath(resolveAssistantMessageSessionPath(message));
    } catch {
      sessionPath = '';
    }

    const snapshotConversationId = String(contextSnapshot && contextSnapshot.conversationId || '').trim();
    const snapshotMessageId = String(contextSnapshot && contextSnapshot.messageId || '').trim();
    const valid = Boolean(
      taskId
      && Number.isInteger(runId)
      && runId > 0
      && task
      && run
      && task.status === 'failed'
      && run.status === 'failed'
      && Number(task.run_id) === runId
      && Number(run.id) === runId
      && String(run.task_id || '').trim() === taskId
      && contextSnapshot
      && contextSnapshot.integrityOk !== false
      && (!snapshotConversationId || snapshotConversationId === conversation.id)
      && (!snapshotMessageId || snapshotMessageId === message.id)
      && sessionPath
      && samePath(task.session_path, sessionPath)
      && samePath(run.session_path, sessionPath)
      && isRegularFile(sessionPath)
    );

    if (!valid) {
      throw recoveryError(
        409,
        'conversation_recovery_source_incomplete',
        'Recovery source task, run, snapshot, or session is incomplete'
      );
    }

    return { conversation, message, task, run, contextSnapshot, sessionPath };
  }

  function createDurableRecovery(source: any) {
    const recoveryId = randomUUID();
    const recoveryTaskId = `conversation-recovery-${recoveryId}`;
    const createTransaction = store.db.transaction(() => {
      runStore.createTask({
        taskId: recoveryTaskId,
        parentTaskId: source.message.taskId,
        parentRunId: source.message.runId,
        kind: 'conversation_recovery',
        title: `Recover failed message ${source.message.id}`,
        status: 'queued',
        assignedAgent: 'caff-system',
        assignedRole: RECOVERY_SCRIBE_SYSTEM_ACTOR.type,
        provider: config.provider,
        model: config.model,
        inputText: `Manual read-only recovery for failed assistant message ${source.message.id}`,
        metadata: {
          conversationId: source.conversation.id,
          sourceMessageId: source.message.id,
          sourceTaskId: source.message.taskId,
          sourceRunId: source.message.runId,
          parentRunId: source.message.runId,
          noTools: true,
          systemActorType: RECOVERY_SCRIBE_SYSTEM_ACTOR.type,
          systemActorRoutable: RECOVERY_SCRIBE_SYSTEM_ACTOR.routable,
        },
      });
      store.messageRecoveryRepository.create({
        id: recoveryId,
        conversationId: source.conversation.id,
        sourceMessageId: source.message.id,
        sourceTaskId: source.message.taskId,
        sourceRunId: source.message.runId,
        recoveryTaskId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    try {
      createTransaction();
      return { recovery: store.getMessageRecovery(recoveryId), created: true };
    } catch (error) {
      if (!isSqliteUniqueConstraintError(error)) {
        throw error;
      }
      const existing = store.getMessageRecoveryBySourceMessage(source.message.id);
      if (!existing) {
        throw error;
      }
      return { recovery: existing, created: false };
    }
  }

  function persistTerminal(source: any, recovery: any, input: any) {
    const fallbackUsed = Boolean(input.fallbackUsed);
    const messageId = randomUUID();
    const endedAt = new Date().toISOString();
    const expectedStatuses = recovery.recoveryRunId ? ['running'] : ['queued', 'running'];
    let message: any = null;
    let terminal: any = null;
    const transaction = store.db.transaction(() => {
      message = store.createMessage({
        id: messageId,
        conversationId: source.conversation.id,
        turnId: `recovery-${recovery.id}`,
        role: 'assistant',
        agentId: null,
        senderName: fallbackUsed
          ? RECOVERY_SCRIBE_SYSTEM_ACTOR.mechanicalDisplayName
          : RECOVERY_SCRIBE_SYSTEM_ACTOR.displayName,
        content: input.content,
        status: 'completed',
        taskId: recovery.recoveryTaskId,
        runId: recovery.recoveryRunId,
        metadata: {
          recoveryResult: true,
          systemActorType: RECOVERY_SCRIBE_SYSTEM_ACTOR.type,
          systemActorRoutable: RECOVERY_SCRIBE_SYSTEM_ACTOR.routable,
          sourceMessageId: source.message.id,
          sourceTaskId: source.message.taskId,
          sourceRunId: source.message.runId,
          recoveryTaskId: recovery.recoveryTaskId,
          recoveryRunId: recovery.recoveryRunId,
          fallbackUsed,
          nonExecution: true,
        },
      });
      terminal = store.transitionMessageRecovery(recovery.id, expectedStatuses, {
        status: fallbackUsed ? 'failed' : 'completed',
        recoveryMessageId: message.id,
        modelOutput: fallbackUsed ? '' : input.modelOutput,
        errorCode: fallbackUsed ? input.errorCode : '',
        errorMessage: fallbackUsed ? input.errorMessage : '',
        fallbackUsed,
        endedAt,
      });
      if (!terminal) {
        throw new Error('Recovery terminal transition was rejected');
      }
      runStore.updateTask(recovery.recoveryTaskId, {
        status: fallbackUsed ? 'failed' : 'succeeded',
        runId: recovery.recoveryRunId,
        outputText: input.content,
        errorMessage: fallbackUsed ? input.errorMessage : '',
        endedAt,
      });
    });
    transaction();

    runStore.appendTaskEvent(
      recovery.recoveryTaskId,
      fallbackUsed ? 'conversation_recovery_failed' : 'conversation_recovery_completed',
      {
        conversationId: source.conversation.id,
        sourceMessageId: source.message.id,
        sourceTaskId: source.message.taskId,
        sourceRunId: source.message.runId,
        recoveryRunId: recovery.recoveryRunId,
        recoveryMessageId: message.id,
        fallbackUsed,
        ...(fallbackUsed ? { errorCode: input.errorCode } : {}),
      }
    );

    try {
      broadcastEvent('conversation_message_created', {
        conversationId: source.conversation.id,
        message,
      });
      broadcastEvent('conversation_summary_updated', {
        conversationId: source.conversation.id,
        summary: pickConversationSummary(store.getConversationWithoutMessages(source.conversation.id)),
      });
    } catch {}
    emitRecovery(terminal);
    return terminal;
  }

  async function processRecovery(source: any, recoveryId: string) {
    let recovery = store.getMessageRecovery(recoveryId);
    let capsule: any = null;
    let recoveryRunId: number | null = null;

    try {
      const visiblePathRoots = [
        source.conversation.worktreePath,
        typeof options.getProjectDir === 'function' ? options.getProjectDir(source.conversation) : '',
      ].map((value) => String(value || '').trim()).filter(Boolean);
      capsule = buildRecoveryCapsule({
        agentDir,
        sessionPath: source.sessionPath,
        message: {
          ...source.message,
          createdAt: source.run.ended_at || source.task.ended_at || source.message.createdAt,
        },
        task: {
          ...source.task,
          runId: source.task.run_id,
          errorMessage: source.task.error_message,
          metadata: {
            ...(source.task.metadata || {}),
            visiblePathRoots,
          },
        },
        run: {
          ...source.run,
          errorMessage: source.run.error_message,
          terminationType: source.run.termination_type,
          assistantErrors: source.run.assistantErrors,
        },
        contextSnapshot: source.contextSnapshot,
      });
      if (Buffer.byteLength(JSON.stringify(capsule), 'utf8') > MAX_RECOVERY_CAPSULE_BYTES) {
        throw new Error('Recovery Capsule exceeds the hard size limit');
      }
      const prompt = buildScribePrompt(capsule);
      const runRecord = runStore.startRun({
        sessionPath: null,
        requestedSession: null,
        requestedResume: false,
        provider: config.provider,
        model: config.model,
        thinking: config.thinking,
        prompt,
        timeoutMs: config.timeoutMs,
        idleTimeoutMs: null,
        heartbeatIntervalMs: null,
        heartbeatTimeoutMs: null,
        terminateGraceMs: null,
        cwd: typeof options.getProjectDir === 'function'
          ? String(options.getProjectDir(source.conversation) || process.cwd())
          : process.cwd(),
        parentRunId: source.message.runId,
        taskId: recovery.recoveryTaskId,
        taskKind: 'conversation_recovery',
        taskRole: RECOVERY_SCRIBE_SYSTEM_ACTOR.type,
        metadata: {
          conversationId: source.conversation.id,
          sourceMessageId: source.message.id,
          sourceTaskId: source.message.taskId,
          sourceRunId: source.message.runId,
          parentRunId: source.message.runId,
          capsuleVersion: 1,
          capsuleSha256: createHash('sha256').update(JSON.stringify(capsule)).digest('hex'),
          noTools: true,
          systemActorType: RECOVERY_SCRIBE_SYSTEM_ACTOR.type,
          systemActorRoutable: RECOVERY_SCRIBE_SYSTEM_ACTOR.routable,
        },
      });
      recoveryRunId = runRecord.runId;
      const startedAt = new Date().toISOString();
      runStore.updateTask(recovery.recoveryTaskId, {
        status: 'running',
        runId: recoveryRunId,
        provider: config.provider,
        model: config.model,
        startedAt,
      });
      runStore.addArtifact(recovery.recoveryTaskId, {
        kind: 'recovery_capsule',
        name: 'recovery-capsule-v1.json',
        mimeType: 'application/json',
        contentText: JSON.stringify(capsule),
        metadata: { version: 1, bounded: true, redacted: true },
      });
      recovery = store.transitionMessageRecovery(recovery.id, ['queued'], {
        status: 'running',
        recoveryRunId,
        capsule,
        startedAt,
      });
      if (!recovery) {
        throw new Error('Recovery running transition was rejected');
      }
      runStore.appendTaskEvent(recovery.recoveryTaskId, 'conversation_recovery_started', {
        conversationId: source.conversation.id,
        sourceMessageId: source.message.id,
        sourceTaskId: source.message.taskId,
        sourceRunId: source.message.runId,
        recoveryRunId,
        provider: config.provider,
        model: config.model,
        noTools: true,
      });
      emitRecovery(recovery);

      const result = await invokeScribe(capsule, config, { ...options, agentDir });
      runStore.finishRun(recoveryRunId, {
        status: 'completed',
        exitCode: 0,
        terminationType: null,
        errorMessage: null,
        reply: result.output,
        stderrTail: '',
        parseErrors: 0,
        assistantErrors: [],
      });
      return persistTerminal(source, recovery, {
        content: result.output,
        modelOutput: result.output,
        fallbackUsed: false,
      });
    } catch (error) {
      const errorMessage = safeErrorText(error);
      if (recoveryRunId) {
        runStore.finishRun(recoveryRunId, {
          status: 'failed',
          exitCode: null,
          terminationType: error && (error as any).name === 'AbortError' ? 'timeout' : 'model_error',
          errorMessage,
          reply: '',
          stderrTail: '',
          parseErrors: 0,
          assistantErrors: [],
        });
      }
      recovery = store.getMessageRecovery(recoveryId) || recovery;
      const fallbackCapsule = capsule || minimalCapsule(source, error);
      if (!capsule && recovery && recovery.status === 'queued') {
        recovery = store.transitionMessageRecovery(recoveryId, ['queued'], {
          capsule: fallbackCapsule,
        }) || recovery;
      }
      const content = buildMechanicalRecoveryMessage(fallbackCapsule);
      try {
        return persistTerminal(source, recovery, {
          content,
          modelOutput: '',
          fallbackUsed: true,
          errorCode: recoveryRunId
            ? 'conversation_recovery_scribe_failed'
            : 'conversation_recovery_capsule_failed',
          errorMessage,
        });
      } catch (persistenceError) {
        const persistenceMessage = safeErrorText(persistenceError);
        const terminal = store.transitionMessageRecovery(
          recoveryId,
          recovery && recovery.status === 'running' ? ['running'] : ['queued', 'running'],
          {
            status: 'failed',
            errorCode: 'conversation_recovery_message_persist_failed',
            errorMessage: persistenceMessage,
            fallbackUsed: true,
            endedAt: new Date().toISOString(),
          }
        );
        try {
          runStore.updateTask(recovery.recoveryTaskId, {
            status: 'failed',
            runId: recovery.recoveryRunId,
            errorMessage: persistenceMessage,
            endedAt: new Date().toISOString(),
          });
        } catch {}
        if (terminal) {
          emitRecovery(terminal);
        }
        return terminal;
      }
    }
  }

  function requestRecovery(conversationId: any, messageId: any) {
    if (!config.enabled) {
      throw recoveryError(
        503,
        'conversation_recovery_disabled',
        'The platform Recovery Scribe is disabled'
      );
    }
    const conversation = requireConversation(conversationId);
    const message = requireSourceMessage(conversation.id, messageId);
    const existing = store.getMessageRecoveryBySourceMessage(message.id);
    if (existing) {
      return { recovery: projectRecoveryRecord(existing, inFlight), duplicate: true };
    }

    requireIdle(conversation.id);
    const lease = mutationCoordinator && typeof mutationCoordinator.tryAcquire === 'function'
      ? mutationCoordinator.tryAcquire(conversation.id, 'message_recovery')
      : { acquired: true, release() {} };
    if (!lease.acquired) {
      throw recoveryError(409, 'conversation_recovery_conversation_busy', 'Conversation history is being modified');
    }

    let keepLease = false;
    try {
      const duplicateAfterLease = store.getMessageRecoveryBySourceMessage(message.id);
      if (duplicateAfterLease) {
        return { recovery: projectRecoveryRecord(duplicateAfterLease, inFlight), duplicate: true };
      }
      requireIdle(conversation.id, { ignoreMutation: true });
      const source = sourceIntegrity(conversation, message);
      const created = createDurableRecovery(source);
      if (!created.created) {
        return { recovery: projectRecoveryRecord(created.recovery, inFlight), duplicate: true };
      }

      const work = async () => {
        try {
          return await processRecovery(source, created.recovery.id);
        } finally {
          inFlight.delete(created.recovery.id);
          lease.release();
        }
      };
      inFlight.set(created.recovery.id, work);
      keepLease = true;
      emitRecovery(created.recovery);
      scheduleBackground(work);
      return { recovery: projectRecoveryRecord(created.recovery, inFlight), duplicate: false };
    } finally {
      if (!keepLease) {
        lease.release();
      }
    }
  }

  function projectMessages(messages: any[] = []) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const recoveries = store.listMessageRecoveriesBySourceMessageIds(
      safeMessages.map((message) => message && message.id)
    );
    const bySourceMessageId = new Map(
      recoveries.map((recovery: any) => [recovery.sourceMessageId, recovery])
    );
    return safeMessages.map((message) => {
      const recovery = bySourceMessageId.get(String(message && message.id || '').trim());
      const isEligibleSource = Boolean(
        message
        && message.role === 'assistant'
        && message.status === 'failed'
        && !(message.metadata && message.metadata.recoveryResult)
      );
      const recoveryCapability = isEligibleSource
        ? {
            enabled: config.enabled,
            systemActorType: RECOVERY_SCRIBE_SYSTEM_ACTOR.type,
            routable: RECOVERY_SCRIBE_SYSTEM_ACTOR.routable,
          }
        : null;
      return {
        ...message,
        ...(recovery ? { recovery: projectRecoveryRecord(recovery, inFlight) } : {}),
        ...(recoveryCapability ? { recoveryCapability } : {}),
      };
    });
  }

  return {
    processRecovery,
    projectMessages,
    projectRecovery(recovery: any) {
      return projectRecoveryRecord(recovery, inFlight);
    },
    requestRecovery,
  };
}
