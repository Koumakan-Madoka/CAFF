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
import {
  MAX_RECOVERY_TIMEOUT_MS,
  MIN_RECOVERY_TIMEOUT_MS,
  createRecoveryScribeConfigManager,
} from './recovery-scribe-config';
import {
  SystemModelOutputError,
  extractSystemModelVisibleText,
  markSystemModelInvalidOutput,
  projectSystemModelOutputAttempt,
  resolveSystemModelOutputBudget,
} from './system-model-output';
import { materializeAgentContextSnapshot } from './turn/context-snapshot';
import {
  MAX_RECOVERY_CAPSULE_BYTES,
  MAX_RECOVERY_OUTPUT_CHARS,
  buildMechanicalRecoveryMessage,
  buildRecoveryCapsule,
  redactRecoveryText,
} from './recovery-capsule';

const MAX_RECOVERY_PROMPT_BYTES = 72 * 1024;
const DEFAULT_RECOVERY_TIMEOUT_MS = MAX_RECOVERY_TIMEOUT_MS;
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
  const resolvedThinking = resolveThinkingSetting(
    provider,
    options.thinking,
    process.env.CAFF_RECOVERY_THINKING || process.env.CAFF_DIGEST_THINKING || process.env.PI_THINKING,
    DEFAULT_THINKING
  );
  const thinking = resolvedThinking === '' ? 'off' : resolvedThinking;
  const timeoutMs = resolveIntegerSetting(
    options.timeoutMs,
    process.env.CAFF_RECOVERY_TIMEOUT_MS,
    DEFAULT_RECOVERY_TIMEOUT_MS,
    'recovery timeout'
  );
  if (timeoutMs < MIN_RECOVERY_TIMEOUT_MS || timeoutMs > MAX_RECOVERY_TIMEOUT_MS) {
    throw new Error(`recovery timeout must be between ${MIN_RECOVERY_TIMEOUT_MS} and ${MAX_RECOVERY_TIMEOUT_MS} milliseconds`);
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
  return extractSystemModelVisibleText(output);
}

function validateScribeOutput(value: any, diagnostic: any) {
  const output = extractScribeText(value);
  if (!output) {
    throw new SystemModelOutputError('Recovery scribe output is empty', diagnostic);
  }
  if (output.length > MAX_RECOVERY_OUTPUT_CHARS) {
    throw new SystemModelOutputError(
      'Recovery scribe output exceeds the hard size limit',
      markSystemModelInvalidOutput(diagnostic)
    );
  }
  for (const heading of REQUIRED_SCRIBE_HEADINGS) {
    if (!output.includes(heading)) {
      throw new SystemModelOutputError(
        `Recovery scribe output is missing heading: ${heading}`,
        markSystemModelInvalidOutput(diagnostic)
      );
    }
  }
  if (!output.includes(NON_EXECUTION_STATEMENT)) {
    throw new SystemModelOutputError(
      'Recovery scribe output is missing the non-execution statement',
      markSystemModelInvalidOutput(diagnostic)
    );
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
    const outputBudget = resolveSystemModelOutputBudget(model);
    let attempt = 1;
    let thinking = config.thinking;

    while (attempt <= 2) {
      let output: any;
      try {
        output = await runtime.completeSimple(model, {
          systemPrompt: SCRIBE_SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          }],
        }, {
          signal: controller.signal,
          maxTokens: outputBudget,
          reasoning: thinking,
        });
      } catch (error) {
        const aborted = controller.signal.aborted || (error && (error as any).name === 'AbortError');
        const inspection = projectSystemModelOutputAttempt({
          role: 'assistant',
          stopReason: aborted ? 'aborted' : 'error',
          content: [],
          usage: {},
        }, {
          attempt,
          maxTokens: outputBudget,
          thinking,
        });
        if (typeof options.onModelAttempt === 'function') {
          options.onModelAttempt(inspection.diagnostic);
        }
        throw error;
      }
      const inspection = projectSystemModelOutputAttempt(output, {
        attempt,
        maxTokens: outputBudget,
        thinking,
      });
      if (inspection.retryEligible) {
        const diagnostic = { ...inspection.diagnostic, retryScheduled: true };
        if (typeof options.onModelAttempt === 'function') {
          options.onModelAttempt(diagnostic);
        }
        attempt += 1;
        thinking = 'off';
        continue;
      }
      if (inspection.diagnostic.diagnosticCode) {
        if (typeof options.onModelAttempt === 'function') {
          options.onModelAttempt(inspection.diagnostic);
        }
        const messages: Record<string, string> = {
          empty_text: 'Recovery scribe output is empty',
          length_exhausted: 'Recovery scribe exhausted the model output budget',
          provider_error: 'Recovery scribe reported a model invocation error',
          aborted: 'Recovery scribe was aborted',
        };
        throw new SystemModelOutputError(
          messages[inspection.diagnostic.diagnosticCode] || 'Recovery scribe output is invalid',
          inspection.diagnostic
        );
      }

      try {
        const validated = validateScribeOutput(output, inspection.diagnostic);
        if (typeof options.onModelAttempt === 'function') {
          options.onModelAttempt(inspection.diagnostic);
        }
        return { output: validated, prompt, raw: output, diagnostics: [inspection.diagnostic] };
      } catch (error) {
        if (typeof options.onModelAttempt === 'function' && error instanceof SystemModelOutputError) {
          options.onModelAttempt(error.diagnostic);
        }
        throw error;
      }
    }

    throw new Error('Recovery scribe retry budget was exhausted');
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
  const configManager = options.configManager || createRecoveryScribeConfigManager({
    store,
    modelCatalog: options.modelCatalog,
    defaults: recoveryConfig(options),
  });
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

  function inspectIdle(conversationId: string, validationOptions: any = {}) {
    let runtime: any = null;
    try {
      runtime = getConversationMutationState(conversationId) || {};
    } catch {
      return {
        eligible: false,
        reasonCode: 'conversation_recovery_state_unavailable',
        reason: '暂时无法确认会话是否空闲，请刷新后重试',
      };
    }
    if (runtime.busy) {
      return {
        eligible: false,
        reasonCode: 'conversation_recovery_conversation_busy',
        reason: '会话仍有运行中或排队任务，空闲后才能整理失败现场',
      };
    }
    if (validationOptions.ignoreMutation === true) {
      return null;
    }
    let mutation: any = null;
    try {
      mutation = mutationCoordinator && typeof mutationCoordinator.describe === 'function'
        ? mutationCoordinator.describe(conversationId)
        : { active: false, digestScheduled: false };
    } catch {
      return {
        eligible: false,
        reasonCode: 'conversation_recovery_state_unavailable',
        reason: '暂时无法确认会话是否空闲，请刷新后重试',
      };
    }
    if (mutation.active || mutation.digestScheduled) {
      return {
        eligible: false,
        reasonCode: 'conversation_recovery_conversation_busy',
        reason: '会话历史正在更新，完成后才能整理失败现场',
      };
    }
    return null;
  }

  function requireIdle(conversationId: string, validationOptions: any = {}) {
    const unavailable = inspectIdle(conversationId, validationOptions);
    if (unavailable) {
      throw recoveryError(409, unavailable.reasonCode, unavailable.reason);
    }
  }

  function inspectSourceIntegrity(conversation: any, message: any) {
    const taskId = String(message.taskId || '').trim();
    const runId = Number(message.runId);
    const task = taskId ? runStore.getTask(taskId) : null;
    const run = Number.isInteger(runId) && runId > 0 ? runStore.getRun(runId) : null;
    const unavailable = (reasonCode: string, reason: string) => ({
      eligible: false,
      reasonCode,
      reason,
      source: null,
    });

    if (!taskId || !task) {
      return unavailable('conversation_recovery_source_task_missing', '来源任务记录缺失，无法整理失败现场');
    }
    if (!Number.isInteger(runId) || runId <= 0 || !run) {
      return unavailable('conversation_recovery_source_run_missing', '来源运行记录缺失，无法整理失败现场');
    }
    if (task.status !== 'failed') {
      return unavailable('conversation_recovery_source_task_not_failed', '来源任务没有失败终态，无法整理失败现场');
    }
    const assistantErrors = Array.isArray(run.assistantErrors)
      ? run.assistantErrors.map((value: any) => String(value || '').trim()).filter(Boolean)
      : [];
    const hasCompatibleRunFailure = run.status === 'failed'
      || (run.status === 'succeeded' && assistantErrors.length > 0);
    if (!hasCompatibleRunFailure) {
      return unavailable(
        'conversation_recovery_source_run_not_failed',
        '来源运行没有可验证的失败终态或 assistant error 证据'
      );
    }
    if (
      Number(task.run_id) !== runId
      || Number(run.id) !== runId
      || String(run.task_id || '').trim() !== taskId
    ) {
      return unavailable('conversation_recovery_source_link_mismatch', '来源消息、任务与运行记录不一致');
    }

    const storedContextSnapshot = store.getMessageContextSnapshot(message.id);
    const contextSnapshot = materializeAgentContextSnapshot(storedContextSnapshot);
    if (!contextSnapshot || contextSnapshot.integrityOk === false) {
      return unavailable('conversation_recovery_source_snapshot_missing', '来源上下文快照缺失或不完整');
    }
    const snapshotConversationId = String(contextSnapshot.conversationId || '').trim();
    const snapshotMessageId = String(contextSnapshot.messageId || '').trim();
    if (
      (snapshotConversationId && snapshotConversationId !== conversation.id)
      || (snapshotMessageId && snapshotMessageId !== message.id)
    ) {
      return unavailable('conversation_recovery_source_snapshot_mismatch', '来源上下文快照与失败消息不一致');
    }

    let sessionPath = '';
    try {
      sessionPath = normalizePath(resolveAssistantMessageSessionPath(message));
    } catch {
      sessionPath = '';
    }
    if (!sessionPath || !isRegularFile(sessionPath)) {
      return unavailable('conversation_recovery_source_session_missing', '来源会话记录缺失或不可读');
    }
    if (!samePath(task.session_path, sessionPath) || !samePath(run.session_path, sessionPath)) {
      return unavailable('conversation_recovery_source_session_mismatch', '来源任务、运行与会话记录路径不一致');
    }

    return {
      eligible: true,
      reasonCode: '',
      reason: '',
      source: { conversation, message, task, run, contextSnapshot, sessionPath },
    };
  }

  function sourceIntegrity(conversation: any, message: any) {
    const inspection = inspectSourceIntegrity(conversation, message);
    if (!inspection.eligible) {
      throw recoveryError(409, inspection.reasonCode, inspection.reason);
    }
    return inspection.source;
  }

  function createDurableRecovery(source: any, config: any) {
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

  async function processRecovery(source: any, recoveryId: string, configSnapshot?: any) {
    const config = configSnapshot || configManager.getConfigSnapshot();
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

      const result = await invokeScribe(capsule, config, {
        ...options,
        agentDir,
        onModelAttempt(diagnostic: any) {
          runStore.appendTaskEvent(recovery.recoveryTaskId, 'conversation_recovery_model_attempt', {
            conversationId: source.conversation.id,
            sourceMessageId: source.message.id,
            recoveryRunId,
            ...diagnostic,
          });
        },
      });
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
            ? error instanceof SystemModelOutputError
              ? `conversation_recovery_scribe_${error.diagnosticCode}`
              : 'conversation_recovery_scribe_failed'
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
    const config = configManager.getConfigSnapshot();
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
      const created = createDurableRecovery(source, config);
      if (!created.created) {
        return { recovery: projectRecoveryRecord(created.recovery, inFlight), duplicate: true };
      }

      const work = async () => {
        try {
          return await processRecovery(source, created.recovery.id, config);
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
    const recoveryEnabled = configManager.getConfigSnapshot().enabled;
    const recoveries = store.listMessageRecoveriesBySourceMessageIds(
      safeMessages.map((message) => message && message.id)
    );
    const bySourceMessageId = new Map(
      recoveries.map((recovery: any) => [recovery.sourceMessageId, recovery])
    );
    const conversations = new Map<string, any>();
    const idleFailures = new Map<string, any>();

    return safeMessages.map((message) => {
      const recovery = bySourceMessageId.get(String(message && message.id || '').trim());
      const isEligibleSourceType = Boolean(
        message
        && message.role === 'assistant'
        && message.status === 'failed'
        && !(message.metadata && message.metadata.recoveryResult)
      );
      let recoveryCapability: any = null;

      if (isEligibleSourceType) {
        const baseCapability = {
          systemActorType: RECOVERY_SCRIBE_SYSTEM_ACTOR.type,
          routable: RECOVERY_SCRIBE_SYSTEM_ACTOR.routable,
        };
        if (!recoveryEnabled) {
          recoveryCapability = {
            enabled: false,
            eligible: false,
            reasonCode: 'conversation_recovery_disabled',
            reason: '系统书记已停用',
            ...baseCapability,
          };
        } else {
          const conversationId = String(message.conversationId || '').trim();
          if (!conversations.has(conversationId)) {
            conversations.set(conversationId, store.getConversationWithoutMessages(conversationId));
          }
          const conversation = conversations.get(conversationId);
          if (!conversation) {
            recoveryCapability = {
              enabled: true,
              eligible: false,
              reasonCode: 'conversation_recovery_conversation_not_found',
              reason: '来源会话不存在，无法整理失败现场',
              ...baseCapability,
            };
          } else {
            if (!idleFailures.has(conversationId)) {
              idleFailures.set(conversationId, inspectIdle(conversationId));
            }
            const idleFailure = idleFailures.get(conversationId);
            const inspection = idleFailure || inspectSourceIntegrity(conversation, message);
            recoveryCapability = {
              enabled: true,
              eligible: idleFailure ? false : Boolean(inspection.eligible),
              reasonCode: inspection.reasonCode,
              reason: inspection.reason,
              ...baseCapability,
            };
          }
        }
      }

      return {
        ...message,
        ...(recovery ? { recovery: projectRecoveryRecord(recovery, inFlight) } : {}),
        ...(recoveryCapability ? { recoveryCapability } : {}),
      };
    });
  }

  return {
    getConfiguration: configManager.getConfiguration,
    updateConfiguration: configManager.updateConfiguration,
    processRecovery,
    projectMessages,
    projectRecovery(recovery: any) {
      return projectRecoveryRecord(recovery, inFlight);
    },
    requestRecovery,
  };
}
