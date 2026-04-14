const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createHttpError } = require('../../http/http-errors');
const { pickConversationSummary, serializeConversationPrivateMessageForUi } = require('../conversation/conversation-view');
const { buildAgentMentionLookup, formatAgentMention, resolveMentionValues } = require('../conversation/mention-routing');
const { createLiveBridgeToolStep } = require('./message-tool-trace');

const MAX_HISTORY_MESSAGES = 24;
const MAX_PRIVATE_CONTEXT_MESSAGES = 16;
const MAX_MESSAGE_SEARCH_LIMIT = 5;
const MAX_MESSAGE_SEARCH_QUERY_LENGTH = 120;
const MAX_MESSAGE_SEARCH_FILTER_LENGTH = 80;
const MAX_MEMORY_CARD_LIMIT = 6;
const MAX_MEMORY_CARD_TITLE_LENGTH = 64;
const MAX_MEMORY_CARD_CONTENT_LENGTH = 280;
const MAX_MEMORY_CARD_TTL_DAYS = 90;
const DEFAULT_MEMORY_CARD_TTL_DAYS = 30;
const MAX_MEMORY_MUTATION_REASON_LENGTH = 120;
const MAX_MEMORY_UPDATED_AT_LENGTH = 80;
const MEMORY_MUTATION_REASON_TAG = 'explicit-user-request';
const TURN_PREVIEW_LENGTH = 180;
const MEMORY_SECRET_RE = /\b(password|passwd|secret|token|api[_ -]?key|private[_ -]?key|ssh[_ -]?key|cookie|session)\b|密码|口令|令牌|密钥|私钥/iu;
const MEMORY_TRANSIENT_RE = /\b(todo|fixme|later|temporary|temp|today|tomorrow|next step|pending|wip)\b|待办|临时|今天|明天|稍后|下一步|本轮|这次/iu;
const DEFAULT_SKILL_TEST_TOKEN_TTL_SECONDS = 600;
const MAX_AUTH_REJECTS = 20;

function nowIso() {
  return new Date().toISOString();
}

function clipText(text: any, maxLength = 240) {
  const value = String(text || '').trim();

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function normalizeMemoryField(value: any, maxLength: number, fieldName: string) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');

  if (!normalized) {
    throw createHttpError(400, `${fieldName} is required`);
  }

  if (normalized.length > maxLength) {
    throw createHttpError(400, `${fieldName} must be at most ${maxLength} characters`);
  }

  return normalized;
}

function normalizeMemoryTtlDays(value: any) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_MEMORY_CARD_TTL_DAYS;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    throw createHttpError(400, 'ttlDays must be a positive integer');
  }

  if (parsed > MAX_MEMORY_CARD_TTL_DAYS) {
    throw createHttpError(400, `ttlDays must be at most ${MAX_MEMORY_CARD_TTL_DAYS}`);
  }

  return parsed;
}

function validateMemoryCardCandidate(title: string, content: string) {
  const combined = `${title} ${content}`;

  if (MEMORY_SECRET_RE.test(combined)) {
    throw createHttpError(400, 'Do not save secrets, tokens, passwords, or private keys in memory cards');
  }

  if (MEMORY_TRANSIENT_RE.test(combined)) {
    throw createHttpError(400, 'Memory cards only accept stable facts, preferences, or durable agreements');
  }
}

function normalizeMemoryListLimit(value: any) {
  if (value === undefined || value === null || value === '') {
    return MAX_MEMORY_CARD_LIMIT;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    throw createHttpError(400, 'limit must be a positive integer');
  }

  return Math.max(1, Math.min(MAX_MEMORY_CARD_LIMIT, parsed));
}

function normalizeMemoryReason(value: any) {
  return normalizeMemoryField(value, MAX_MEMORY_MUTATION_REASON_LENGTH, 'reason');
}

function normalizeExpectedUpdatedAt(value: any) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    return null;
  }

  if (normalized.length > MAX_MEMORY_UPDATED_AT_LENGTH) {
    throw createHttpError(400, `expectedUpdatedAt must be at most ${MAX_MEMORY_UPDATED_AT_LENGTH} characters`);
  }

  return normalized;
}

function coerceMemoryMutationError(error: any, fallbackMessage: string) {
  if (error && error.statusCode) {
    return error;
  }

  const message = error && error.message ? String(error.message) : fallbackMessage;

  if (/not found/i.test(message)) {
    return createHttpError(404, message);
  }

  if (/changed since it was last read/i.test(message)) {
    return createHttpError(409, message);
  }

  return createHttpError(400, message || fallbackMessage);
}

function summarizeForgottenMemoryCard(card: any) {
  if (!card || typeof card !== 'object') {
    return null;
  }

  return {
    id: String(card.id || '').trim(),
    conversationId: card.conversationId || null,
    agentId: String(card.agentId || '').trim(),
    scope: String(card.scope || '').trim(),
    ownerKey: String(card.ownerKey || '').trim(),
    title: String(card.title || '').trim(),
    source: String(card.source || '').trim(),
    status: String(card.status || '').trim(),
    ttlDays: Number.isInteger(card.ttlDays) ? card.ttlDays : card.ttlDays ? Number(card.ttlDays) : null,
    expiresAt: card.expiresAt || null,
    createdAt: String(card.createdAt || '').trim(),
    updatedAt: String(card.updatedAt || '').trim(),
    metadata: card.metadata && typeof card.metadata === 'object' ? card.metadata : {},
  };
}

function normalizePromptUserMessageSnapshot(message: any, fallback: any = {}) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  return {
    id: String(message.id || fallback.userMessageId || '').trim(),
    turnId: String(message.turnId || fallback.turnId || '').trim(),
    role: String(message.role || 'user').trim() || 'user',
    agentId: message.agentId || null,
    senderName: String(message.senderName || fallback.senderName || 'You').trim() || 'You',
    content: String(message.content || ''),
    status: String(message.status || 'completed').trim() || 'completed',
    createdAt: String(message.createdAt || fallback.createdAt || '').trim() || nowIso(),
  };
}

function normalizePositiveInteger(value: any, fallback = 0) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function resolveSkillTestAuthValue(input: any, key: string) {
  const auth = input && input.auth && typeof input.auth === 'object' ? input.auth : null;
  return String(
    (auth && auth[key] !== undefined ? auth[key] : undefined) ||
      input[`skillTest${key.charAt(0).toUpperCase()}${key.slice(1)}`] ||
      input[key] ||
      ''
  ).trim();
}

function normalizeIsoTimestamp(value: any) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function createInvocationAuth(input: any = {}) {
  const auth = input && input.auth && typeof input.auth === 'object' ? input.auth : null;
  const scope = String((auth && auth.scope) || input.authScope || input.scope || 'conversation').trim() || 'conversation';
  const isSkillTest = scope === 'skill-test';
  const requestedTtlSec = normalizePositiveInteger((auth && auth.tokenTtlSec) || input.tokenTtlSec || input.ttlSec, 0);
  const tokenTtlSec = requestedTtlSec || (isSkillTest ? DEFAULT_SKILL_TEST_TOKEN_TTL_SECONDS : 0);
  const createdAt = nowIso();
  const explicitExpiresAt = normalizeIsoTimestamp((auth && auth.expiresAt) || input.expiresAt);
  const expiresAt = explicitExpiresAt || (tokenTtlSec > 0 ? new Date(Date.now() + tokenTtlSec * 1000).toISOString() : '');

  return {
    scope,
    caseId: resolveSkillTestAuthValue(input, 'caseId'),
    runId: resolveSkillTestAuthValue(input, 'runId'),
    taskId: resolveSkillTestAuthValue(input, 'taskId'),
    requireScope: (auth && auth.requireScope === true) || input.requireAuthScope === true || isSkillTest,
    tokenTtlSec,
    createdAt,
    expiresAt,
    validated: false,
    validatedCount: 0,
    lastValidatedAt: '',
    rejects: [] as any[],
  };
}

function buildRequestAuthScope(source: any = {}) {
  return {
    caseId: String(source.skillTestCaseId || source.caseId || '').trim(),
    runId: String(source.skillTestRunId || source.runId || '').trim(),
  };
}

function buildUrlRequestAuthScope(requestUrl: any) {
  const params = requestUrl && requestUrl.searchParams ? requestUrl.searchParams : null;
  if (!params) {
    return {};
  }

  return buildRequestAuthScope({
    caseId: params.get('caseId'),
    runId: params.get('runId'),
    skillTestCaseId: params.get('skillTestCaseId'),
    skillTestRunId: params.get('skillTestRunId'),
  });
}

function recordAuthReject(context: any, reason: string, details: any = {}) {
  if (!context || !context.auth) {
    return null;
  }

  const rejectEntry = {
    reason: clipText(reason, 240),
    details: details && typeof details === 'object' ? details : {},
    createdAt: nowIso(),
  };

  if (!Array.isArray(context.auth.rejects)) {
    context.auth.rejects = [];
  }
  context.auth.rejects.push(rejectEntry);
  if (context.auth.rejects.length > MAX_AUTH_REJECTS) {
    context.auth.rejects = context.auth.rejects.slice(-MAX_AUTH_REJECTS);
  }

  return rejectEntry;
}

function summarizeInvocationAuth(context: any) {
  const auth = context && context.auth && typeof context.auth === 'object' ? context.auth : null;
  if (!auth) {
    return null;
  }

  return {
    scope: String(auth.scope || '').trim(),
    caseId: String(auth.caseId || '').trim(),
    runId: String(auth.runId || '').trim(),
    taskId: String(auth.taskId || '').trim(),
    tokenTtlSec: Number.isInteger(auth.tokenTtlSec) ? auth.tokenTtlSec : 0,
    createdAt: String(auth.createdAt || '').trim(),
    expiresAt: String(auth.expiresAt || '').trim(),
    validated: auth.validated === true,
    validatedCount: Number.isInteger(auth.validatedCount) ? auth.validatedCount : 0,
    lastValidatedAt: String(auth.lastValidatedAt || '').trim(),
    rejects: Array.isArray(auth.rejects) ? auth.rejects.slice() : [],
  };
}

export function createAgentToolBridge(options: any = {}) {
  const store = options.store;
  const agentDir = String(options.agentDir || '').trim();
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const broadcastConversationSummary =
    typeof options.broadcastConversationSummary === 'function' ? options.broadcastConversationSummary : () => {};
  const onTurnUpdated = typeof options.onTurnUpdated === 'function' ? options.onTurnUpdated : () => {};
  const activeInvocations = new Map();

  function normalizePolicyToolName(value: any) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'participants' ? 'list-participants' : normalized;
  }

  function resolveContextStore(context: any) {
    return context && context.store ? context.store : store;
  }

  function recordPolicyReject(context: any, toolName: string, reason: string, details: any = {}) {
    const normalizedToolName = normalizePolicyToolName(toolName);
    const policy = context && context.toolPolicy && typeof context.toolPolicy === 'object' ? context.toolPolicy : null;
    const rejectEntry = {
      toolName: normalizedToolName,
      reason: clipText(reason, 240),
      details: details && typeof details === 'object' ? details : {},
      createdAt: nowIso(),
    };

    if (policy && Array.isArray(policy.rejects)) {
      policy.rejects.push(rejectEntry);
    }

    if (context) {
      if (!Array.isArray(context.policyRejects)) {
        context.policyRejects = [];
      }
      context.policyRejects.push(rejectEntry);
    }

    tryAppendInvocationEvent(context, 'agent_tool_policy_reject', {
      schemaVersion: 1,
      tool: normalizedToolName,
      invocationId: context && context.invocationId ? context.invocationId : '',
      conversationId: context && context.conversationId ? context.conversationId : '',
      turnId: context && context.turnId ? context.turnId : '',
      agentId: context && context.agentId ? context.agentId : '',
      agentName: context && context.agentName ? context.agentName : '',
      assistantMessageId: context && context.assistantMessageId ? context.assistantMessageId : '',
      reject: rejectEntry,
    });
  }

  function ensureToolAllowed(context: any, toolName: string, details: any = {}) {
    const policy = context && context.toolPolicy && typeof context.toolPolicy === 'object' ? context.toolPolicy : null;
    if (!policy || !Array.isArray(policy.allowedTools) || policy.allowedTools.length === 0) {
      return;
    }

    const normalizedToolName = normalizePolicyToolName(toolName);
    const allowed = policy.allowedTools.some((entry: any) => normalizePolicyToolName(entry) === normalizedToolName);
    if (allowed) {
      return;
    }

    recordPolicyReject(context, normalizedToolName, `${normalizedToolName} is blocked by tool policy`, details);
    throw createHttpError(403, `${normalizedToolName} is blocked by tool policy`);
  }

  function resolveStageTaskId(context: any) {
    const taskId = context && context.stage && context.stage.taskId ? String(context.stage.taskId).trim() : '';
    return taskId || null;
  }

  function broadcastConversationToolEvent(context: any, phase: string, step: any) {
    if (!context || !step || !context.conversationId || !context.assistantMessageId) {
      return;
    }

    broadcastEvent('conversation_tool_event', {
      conversationId: context.conversationId,
      turnId: context.turnId || '',
      taskId: resolveStageTaskId(context),
      agentId: context.agentId || '',
      agentName: context.agentName || '',
      assistantMessageId: context.assistantMessageId,
      messageId: context.assistantMessageId,
      phase,
      step,
    });
  }

  function tryAppendInvocationEvent(context: any, eventType: string, payload: any) {
    const runStore = context && context.runStore ? context.runStore : null;
    const taskId = resolveStageTaskId(context);

    if (runStore && taskId && typeof runStore.appendTaskEvent === 'function') {
      try {
        runStore.appendTaskEvent(taskId, eventType, payload);
      } catch {}
    }

    if (eventType !== 'agent_tool_call' || !payload || typeof payload !== 'object') {
      return;
    }

    const liveStep = createLiveBridgeToolStep(payload, { agentDir, createdAt: nowIso() });

    if (liveStep) {
      broadcastConversationToolEvent(context, 'updated', liveStep);
    }
  }

  function setContextCurrentTool(context: any, nextTool: any = null) {
    const stage = context && context.stage ? context.stage : null;

    if (!stage) {
      return false;
    }

    const nextToolName = nextTool && nextTool.toolName ? String(nextTool.toolName).trim() : '';
    const nextToolKind = nextTool && nextTool.toolKind ? String(nextTool.toolKind).trim() : '';
    const nextToolStepId = nextTool && nextTool.toolStepId ? String(nextTool.toolStepId).trim() : '';
    const nextToolInferred = Boolean(nextTool && nextTool.inferred && nextToolName);
    const nextToolRequest = nextTool && nextTool.request !== undefined ? nextTool.request : null;
    const currentToolName = String(stage.currentToolName || '').trim();
    const currentToolKind = String(stage.currentToolKind || '').trim();
    const currentToolStepId = String(stage.currentToolStepId || '').trim();
    const currentToolInferred = Boolean(stage.currentToolInferred);

    if (
      currentToolName === nextToolName &&
      currentToolKind === nextToolKind &&
      currentToolStepId === nextToolStepId &&
      currentToolInferred === nextToolInferred
    ) {
      return false;
    }

    stage.currentToolName = nextToolName;
    stage.currentToolKind = nextToolName ? nextToolKind || 'bridge' : '';
    stage.currentToolStepId = nextToolName ? nextToolStepId : '';
    stage.currentToolInferred = nextToolInferred;
    stage.currentToolStartedAt = nextToolName ? nowIso() : null;

    if (nextToolName) {
      const liveStep = createLiveBridgeToolStep(
        {
          toolCallId: nextToolStepId,
          tool: nextToolName,
          status: 'running',
          request: nextToolRequest,
        },
        {
          agentDir,
          createdAt: stage.currentToolStartedAt || nowIso(),
        }
      );

      if (liveStep) {
        broadcastConversationToolEvent(context, 'started', liveStep);
      }
    }

    if (context && context.turnState) {
      context.turnState.updatedAt = nowIso();
      onTurnUpdated(context.turnState);
    }

    return true;
  }

  function createInvocationContext(input: any = {}) {
    const invocationId = String(input.invocationId || randomUUID()).trim();
    const callbackToken = String(input.callbackToken || randomUUID()).trim();
    const promptUserMessage = normalizePromptUserMessageSnapshot(input.promptUserMessage, {
      userMessageId: input.userMessageId,
      turnId: input.turnId,
      createdAt: input.createdAt,
    });
    const auth = createInvocationAuth({
      ...input,
      taskId: input.taskId || (input.stage && input.stage.taskId) || '',
    });

    return {
      invocationId,
      callbackToken,
      conversationId: String(input.conversationId || '').trim(),
      turnId: String(input.turnId || '').trim(),
      projectDir: String(input.projectDir || '').trim(),
      agentId: String(input.agentId || '').trim(),
      agentName: String(input.agentName || '').trim() || 'Assistant',
      assistantMessageId: String(input.assistantMessageId || '').trim(),
      userMessageId: String(input.userMessageId || (promptUserMessage && promptUserMessage.id) || '').trim(),
      promptUserMessage,
      conversationAgents: Array.isArray(input.conversationAgents) ? input.conversationAgents.slice() : [],
      dryRun: input.dryRun === true,
      dryRunPublicPosts: [] as any[],
      dryRunPrivatePosts: [] as any[],
      store: input.store || null,
      toolPolicy: input.toolPolicy || null,
      policyRejects: [],
      runStore: input.runStore || null,
      stage: input.stage || null,
      turnState: input.turnState || null,
      enqueueAgent: typeof input.enqueueAgent === 'function' ? input.enqueueAgent : null,
      allowHandoffs: input.allowHandoffs !== false,
      publicToolUsed: false,
      publicPostCount: 0,
      privatePostCount: 0,
      privateHandoffCount: 0,
      lastPublicContent: '',
      lastPublicPostedAt: '',
      closedAt: '',
      auth,
      createdAt: nowIso(),
    };
  }

  function registerInvocation(context: any) {
    if (!context || !context.invocationId) {
      return null;
    }

    activeInvocations.set(context.invocationId, context);
    return context;
  }

  function getInvocation(invocationId: any, callbackToken: any, requestAuthScope: any = {}) {
    const normalizedInvocationId = String(invocationId || '').trim();
    const normalizedCallbackToken = String(callbackToken || '').trim();
    const normalizedRequestScope = buildRequestAuthScope(requestAuthScope);
    const context = activeInvocations.get(normalizedInvocationId);
    const stageStatus = String(context && context.stage && context.stage.status ? context.stage.status : '')
      .trim()
      .toLowerCase();

    if (!context || !normalizedCallbackToken || context.callbackToken !== normalizedCallbackToken) {
      recordAuthReject(context, 'invalid_or_expired_credentials', {
        hasInvocation: Boolean(context),
        hasCallbackToken: Boolean(normalizedCallbackToken),
        caseId: normalizedRequestScope.caseId,
        runId: normalizedRequestScope.runId,
      });
      throw createHttpError(401, 'Invalid or expired agent tool credentials');
    }

    const auth = context.auth && typeof context.auth === 'object' ? context.auth : null;
    const expiresAtMs = auth && auth.expiresAt ? Date.parse(auth.expiresAt) : NaN;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      recordAuthReject(context, 'token_expired', {
        expiresAt: auth.expiresAt,
        caseId: normalizedRequestScope.caseId,
        runId: normalizedRequestScope.runId,
      });
      activeInvocations.delete(normalizedInvocationId);
      throw createHttpError(401, 'Invalid or expired agent tool credentials');
    }

    if (auth && auth.requireScope) {
      if (auth.caseId && !normalizedRequestScope.caseId) {
        recordAuthReject(context, 'missing_case_binding', { expectedCaseId: auth.caseId });
        throw createHttpError(403, 'Agent tool credentials are missing skill-test case binding');
      }
      if (auth.runId && !normalizedRequestScope.runId) {
        recordAuthReject(context, 'missing_run_binding', { expectedRunId: auth.runId });
        throw createHttpError(403, 'Agent tool credentials are missing skill-test run binding');
      }
    }

    if (auth && auth.caseId && normalizedRequestScope.caseId && normalizedRequestScope.caseId !== auth.caseId) {
      recordAuthReject(context, 'case_binding_mismatch', {
        expectedCaseId: auth.caseId,
        requestCaseId: normalizedRequestScope.caseId,
      });
      throw createHttpError(403, 'Agent tool credentials do not match the active skill-test case');
    }

    if (auth && auth.runId && normalizedRequestScope.runId && normalizedRequestScope.runId !== auth.runId) {
      recordAuthReject(context, 'run_binding_mismatch', {
        expectedRunId: auth.runId,
        requestRunId: normalizedRequestScope.runId,
      });
      throw createHttpError(403, 'Agent tool credentials do not match the active skill-test run');
    }

    if (
      context.closedAt ||
      (context.turnState && context.turnState.stopRequested) ||
      (stageStatus && stageStatus !== 'queued' && stageStatus !== 'running')
    ) {
      recordAuthReject(context, 'invocation_no_longer_active', { stageStatus });
      activeInvocations.delete(normalizedInvocationId);
      throw createHttpError(409, 'This agent tool invocation is no longer active');
    }

    if (auth) {
      auth.validated = true;
      auth.validatedCount = (Number.isInteger(auth.validatedCount) ? auth.validatedCount : 0) + 1;
      auth.lastValidatedAt = nowIso();
    }

    return context;
  }

  function unregisterInvocation(invocationId: any) {
    const normalizedInvocationId = String(invocationId || '').trim();

    if (!normalizedInvocationId) {
      return null;
    }

    const context = activeInvocations.get(normalizedInvocationId) || null;

    if (context) {
      context.closedAt = nowIso();
    }

    activeInvocations.delete(normalizedInvocationId);
    return context;
  }

  function serializeAgentToolPublicMessage(message: any) {
    const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    const toolBridgeMetadata =
      metadata && metadata.toolBridge && typeof metadata.toolBridge === 'object' ? metadata.toolBridge : null;
    return {
      id: message.id,
      role: message.role,
      agentId: message.agentId || null,
      senderName: message.senderName,
      content: message.content,
      status: message.status,
      createdAt: message.createdAt,
      publicPostedAt: toolBridgeMetadata && toolBridgeMetadata.lastPublicPostedAt ? toolBridgeMetadata.lastPublicPostedAt : '',
      publicPostCount: toolBridgeMetadata && Number.isInteger(toolBridgeMetadata.publicPostCount) ? toolBridgeMetadata.publicPostCount : 0,
      publicPostMode: toolBridgeMetadata && toolBridgeMetadata.lastPublicMode ? toolBridgeMetadata.lastPublicMode : '',
      mentions: metadata && Array.isArray(metadata.mentions) ? metadata.mentions : [],
    };
  }

  function serializeAgentToolPrivateMessage(message: any) {
    return {
      id: message.id,
      turnId: message.turnId,
      senderAgentId: message.senderAgentId || null,
      senderName: message.senderName,
      recipientAgentIds: Array.isArray(message.recipientAgentIds) ? message.recipientAgentIds : [],
      content: message.content,
      createdAt: message.createdAt,
    };
  }

  function serializeAgentToolParticipants(agents: any) {
    return (Array.isArray(agents) ? agents : []).map((agent: any) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description || '',
      mention: formatAgentMention(agent),
    }));
  }

  function resolveContextUserMessage(context: any, conversation: any) {
    const snapshot = context && context.promptUserMessage ? normalizePromptUserMessageSnapshot(context.promptUserMessage) : null;
    const messages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
    const targetUserMessageId = String(context && context.userMessageId ? context.userMessageId : '').trim();
    const matchedConversationMessage =
      messages.find((message: any) => message && message.id === targetUserMessageId && message.role === 'user') ||
      [...messages].reverse().find((message: any) => message && message.role === 'user') ||
      null;

    if (!snapshot && !matchedConversationMessage) {
      return null;
    }

    const base = matchedConversationMessage || snapshot;
    return {
      ...(matchedConversationMessage || {}),
      ...(snapshot || {}),
      id: String(
        (snapshot && snapshot.id) || (matchedConversationMessage && matchedConversationMessage.id) || targetUserMessageId || ''
      ).trim(),
      turnId: String(
        (snapshot && snapshot.turnId) || (matchedConversationMessage && matchedConversationMessage.turnId) || context.turnId || ''
      ).trim(),
      role: 'user',
      agentId:
        (matchedConversationMessage && matchedConversationMessage.agentId) || (snapshot && snapshot.agentId) || null,
      senderName: String(
        (snapshot && snapshot.senderName) || (matchedConversationMessage && matchedConversationMessage.senderName) || 'You'
      ).trim() || 'You',
      content: String(
        snapshot && snapshot.content !== undefined
          ? snapshot.content
          : matchedConversationMessage && matchedConversationMessage.content !== undefined
            ? matchedConversationMessage.content
            : ''
      ),
      status: String(
        (snapshot && snapshot.status) || (matchedConversationMessage && matchedConversationMessage.status) || 'completed'
      ).trim() || 'completed',
      createdAt: String(
        (snapshot && snapshot.createdAt) || (matchedConversationMessage && matchedConversationMessage.createdAt) || nowIso()
      ).trim() || nowIso(),
      metadata:
        matchedConversationMessage && matchedConversationMessage.metadata && typeof matchedConversationMessage.metadata === 'object'
          ? matchedConversationMessage.metadata
          : null,
    };
  }

  function applyContextUserMessageSnapshot(message: any, contextUserMessage: any) {
    if (!message || !contextUserMessage || message.id !== contextUserMessage.id) {
      return message;
    }

    return {
      ...message,
      content: contextUserMessage.content,
      senderName: contextUserMessage.senderName,
      status: contextUserMessage.status,
      createdAt: contextUserMessage.createdAt,
    };
  }

  function buildAgentToolContextPayload(context: any, options: any = {}) {
    const activeStore = resolveContextStore(context);
    const publicLimit = Number.isInteger(options.publicLimit) && options.publicLimit > 0 ? options.publicLimit : MAX_HISTORY_MESSAGES;
    const privateLimit =
      Number.isInteger(options.privateLimit) && options.privateLimit > 0 ? options.privateLimit : MAX_PRIVATE_CONTEXT_MESSAGES;
    const conversation = activeStore.getConversation(context.conversationId);
    const contextUserMessage = resolveContextUserMessage(context, conversation);
    const publicMessageSource = conversation
      ? conversation.messages.filter((message: any) => {
          const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;

          if (metadata && metadata.privateOnly) {
            return false;
          }

          return !(
            message.id === context.assistantMessageId &&
            message.status !== 'completed' &&
            String(message.content || '').trim() === 'Thinking...'
          );
        })
      : [];
    let selectedPublicMessages = publicMessageSource
      .slice(-publicLimit)
      .map((message: any) => applyContextUserMessageSnapshot(message, contextUserMessage));

    if (
      contextUserMessage &&
      !selectedPublicMessages.some((message: any) => message && message.id === contextUserMessage.id)
    ) {
      selectedPublicMessages = [contextUserMessage, ...selectedPublicMessages];
    }

    const publicMessages = selectedPublicMessages.map(serializeAgentToolPublicMessage);
    const privateMessages = activeStore
      .listPrivateMessagesForAgent(context.conversationId, context.agentId, { limit: privateLimit })
      .map(serializeAgentToolPrivateMessage);

    return {
      conversation: conversation ? pickConversationSummary(conversation) : null,
      agent: {
        id: context.agentId,
        name: context.agentName,
      },
      participants: conversation ? serializeAgentToolParticipants(conversation.agents) : [],
      latestUserMessage: contextUserMessage ? serializeAgentToolPublicMessage(contextUserMessage) : null,
      publicMessages,
      privateMessages,
    };
  }

  function normalizeAgentToolRecipientValues(value: any): string[] {
    if (Array.isArray(value)) {
      return value.flatMap((item: any) => normalizeAgentToolRecipientValues(item));
    }

    if (typeof value === 'string') {
      return value
        .split(/[,\n\r;，；]+/u)
        .map((item: any) => item.trim())
        .filter(Boolean);
    }

    return [];
  }

  function resolveAgentToolRecipientIds(recipientValues: any, agents: any) {
    const lookup = buildAgentMentionLookup(agents);
    return resolveMentionValues(normalizeAgentToolRecipientValues(recipientValues), agents, { lookup });
  }

  function applyAgentToolPublicUpdate(context: any, content: any, mode = 'replace') {
    const activeStore = resolveContextStore(context);
    const existingMessage = activeStore.getMessage(context.assistantMessageId);

    if (!existingMessage) {
      throw createHttpError(404, 'Active assistant message not found');
    }

    const timestamp = nowIso();
    const normalizedMode = String(mode || 'replace').trim().toLowerCase();
    const currentContent = String(existingMessage.content || '');
    const nextContent =
      normalizedMode === 'append' && currentContent && currentContent !== 'Thinking...' ? `${currentContent}${content}` : content;
    const existingMetadata = existingMessage.metadata && typeof existingMessage.metadata === 'object' ? existingMessage.metadata : {};
    const nextMetadata = {
      ...existingMetadata,
      toolBridge: {
        ...(existingMetadata.toolBridge && typeof existingMetadata.toolBridge === 'object' ? existingMetadata.toolBridge : {}),
        enabled: true,
        publicPosted: true,
        publicPostCount: (context.publicPostCount || 0) + 1,
        lastPublicPostedAt: timestamp,
        lastPublicMode: normalizedMode,
      },
    };
    const updatedMessage = activeStore.updateMessage(context.assistantMessageId, {
      content: nextContent,
      metadata: nextMetadata,
    });

    context.publicToolUsed = true;
    context.publicPostCount = (context.publicPostCount || 0) + 1;
    context.lastPublicContent = nextContent;
    context.lastPublicPostedAt = timestamp;

    if (context.stage) {
      context.stage.status = 'running';
      context.stage.replyLength = nextContent.length;
      context.stage.preview = clipText(nextContent, TURN_PREVIEW_LENGTH);
      context.stage.lastTextDeltaAt = timestamp;
    }

    if (context.turnState) {
      context.turnState.updatedAt = timestamp;
      onTurnUpdated(context.turnState);
    }

    broadcastEvent('conversation_message_updated', { conversationId: context.conversationId, message: updatedMessage });
    broadcastConversationSummary(context.conversationId);

    return updatedMessage;
  }

  function handlePostMessage(body: any = {}) {
    const startedAt = Date.now();
    const context = getInvocation(body.invocationId, body.callbackToken, buildRequestAuthScope(body));
    const activeStore = resolveContextStore(context);
    const content = String(body.content || '').trim();
    const visibility = String(body.visibility || 'public').trim().toLowerCase();
    const mode = String(body.mode || 'replace').trim().toLowerCase() || 'replace';
    const rawRecipients = body.recipientAgentIds !== undefined ? body.recipientAgentIds : body.recipients;
    const requestedRecipientCount = normalizeAgentToolRecipientValues(rawRecipients).length;
    const toolCallId = randomUUID();
    const toolName = visibility === 'private' ? 'send-private' : visibility === 'public' ? 'send-public' : 'post-message';

    setContextCurrentTool(context, {
      toolName,
      toolKind: 'bridge',
      toolStepId: toolCallId,
      inferred: false,
      request:
        visibility === 'private'
          ? {
              visibility: 'private',
              contentLength: content.length,
              recipientCount: requestedRecipientCount,
            }
          : {
              visibility,
              mode,
              contentLength: content.length,
            },
    });

    try {
      ensureToolAllowed(context, toolName, {
        visibility,
      });

      if (!content) {
        throw createHttpError(400, 'Message content is required');
      }

      if (visibility === 'public') {
        if (context.dryRun) {
          const timestamp = nowIso();
          const normalizedMode = String(mode || 'replace').trim().toLowerCase() || 'replace';
          const nextContent =
            normalizedMode === 'append' && String(context.lastPublicContent || '').trim()
              ? `${context.lastPublicContent}${content}`
              : content;
          const messageId = `dryrun-${randomUUID()}`;

          context.publicToolUsed = true;
          context.publicPostCount = (context.publicPostCount || 0) + 1;
          context.lastPublicContent = nextContent;
          context.lastPublicPostedAt = timestamp;
          context.dryRunPublicPosts.push({
            id: messageId,
            content: nextContent,
            mode: normalizedMode,
            createdAt: timestamp,
          });

          if (context.stage) {
            context.stage.status = 'running';
            context.stage.replyLength = nextContent.length;
            context.stage.preview = clipText(nextContent, TURN_PREVIEW_LENGTH);
            context.stage.lastTextDeltaAt = timestamp;
          }

          if (context.turnState) {
            context.turnState.updatedAt = timestamp;
            onTurnUpdated(context.turnState);
          }

          const serialized = {
            id: messageId,
            role: 'assistant',
            agentId: context.agentId || null,
            senderName: context.agentName,
            content: nextContent,
            status: 'completed',
            createdAt: timestamp,
            publicPostedAt: timestamp,
            publicPostCount: context.publicPostCount || 0,
            publicPostMode: normalizedMode,
            mentions: [],
          };

          tryAppendInvocationEvent(context, 'agent_tool_call', {
            schemaVersion: 1,
            toolCallId,
            tool: 'send-public',
            status: 'succeeded',
            durationMs: Date.now() - startedAt,
            invocationId: context.invocationId,
            conversationId: context.conversationId,
            turnId: context.turnId,
            agentId: context.agentId,
            agentName: context.agentName,
            assistantMessageId: context.assistantMessageId,
            request: {
              visibility: 'public',
              mode: normalizedMode,
              contentLength: content.length,
            },
            result: {
              messageId: serialized.id,
              publicPostCount: serialized.publicPostCount,
              publicPostMode: serialized.publicPostMode,
              publicPostedAt: serialized.publicPostedAt,
            },
          });

          return {
            ok: true,
            visibility: 'public',
            message: serialized,
          };
        }

        const message = applyAgentToolPublicUpdate(context, content, mode);
        const serialized = serializeAgentToolPublicMessage(message);
        tryAppendInvocationEvent(context, 'agent_tool_call', {
          schemaVersion: 1,
          toolCallId,
          tool: 'send-public',
          status: 'succeeded',
          durationMs: Date.now() - startedAt,
          invocationId: context.invocationId,
          conversationId: context.conversationId,
          turnId: context.turnId,
          agentId: context.agentId,
          agentName: context.agentName,
          assistantMessageId: context.assistantMessageId,
          request: {
            visibility: 'public',
            mode,
            contentLength: content.length,
          },
          result: {
            messageId: serialized.id,
            publicPostCount: serialized.publicPostCount,
            publicPostMode: serialized.publicPostMode,
            publicPostedAt: serialized.publicPostedAt,
          },
        });
        return {
          ok: true,
          visibility: 'public',
          message: serialized,
        };
      }

      if (visibility === 'private') {
        if (context.dryRun) {
          const timestamp = nowIso();
          const recipientAgentIds = resolveAgentToolRecipientIds(
            body.recipientAgentIds !== undefined ? body.recipientAgentIds : body.recipients,
            context.conversationAgents
          );
          const resolvedRecipientAgentIds = recipientAgentIds.length > 0 ? recipientAgentIds : [context.agentId];
          const handoffAgentIds = resolvedRecipientAgentIds.filter((agentId: any) => agentId && agentId !== context.agentId);
          const explicitHandoff = body.handoff === true || body.triggerReply === true;
          const explicitNoHandoff = body.handoff === false || body.triggerReply === false || body.noHandoff === true;
          const handoffRequested =
            context.allowHandoffs && !explicitNoHandoff && (explicitHandoff || handoffAgentIds.length > 0);
          const messageId = `dryrun-${randomUUID()}`;

          const privateMessage = {
            id: messageId,
            turnId: context.turnId || 'eval',
            senderAgentId: context.agentId || null,
            senderName: context.agentName,
            recipientAgentIds: resolvedRecipientAgentIds,
            content,
            createdAt: timestamp,
          };

          context.privatePostCount = (context.privatePostCount || 0) + 1;
          context.dryRunPrivatePosts.push({
            ...privateMessage,
            handoffRequested,
          });

          const response = {
            ok: true,
            visibility: 'private',
            message: serializeAgentToolPrivateMessage(privateMessage),
            handoffRequested,
            enqueuedAgentIds: [],
          };

          tryAppendInvocationEvent(context, 'agent_tool_call', {
            schemaVersion: 1,
            toolCallId,
            tool: 'send-private',
            status: 'succeeded',
            durationMs: Date.now() - startedAt,
            invocationId: context.invocationId,
            conversationId: context.conversationId,
            turnId: context.turnId,
            agentId: context.agentId,
            agentName: context.agentName,
            assistantMessageId: context.assistantMessageId,
            request: {
              visibility: 'private',
              contentLength: content.length,
              recipientCount: resolvedRecipientAgentIds.length,
              handoffRequested,
            },
            result: {
              messageId: response.message.id,
              recipientCount: response.message.recipientAgentIds.length,
              enqueuedCount: 0,
            },
          });

          return response;
        }

        const conversation = activeStore.getConversation(context.conversationId);

        if (!conversation) {
          throw createHttpError(404, 'Conversation not found');
        }

        const recipientAgentIds = resolveAgentToolRecipientIds(
          body.recipientAgentIds !== undefined ? body.recipientAgentIds : body.recipients,
          conversation.agents
        );
        const resolvedRecipientAgentIds = recipientAgentIds.length > 0 ? recipientAgentIds : [context.agentId];
        const handoffAgentIds = resolvedRecipientAgentIds.filter((agentId: any) => agentId && agentId !== context.agentId);
        const explicitHandoff = body.handoff === true || body.triggerReply === true;
        const explicitNoHandoff = body.handoff === false || body.triggerReply === false || body.noHandoff === true;
        let handoffRequested = !explicitNoHandoff && (explicitHandoff || handoffAgentIds.length > 0);

        if (handoffRequested && !context.allowHandoffs) {
          if (explicitHandoff && !explicitNoHandoff) {
            throw createHttpError(409, 'Private handoff is not available in this turn mode');
          }

          handoffRequested = false;
        }

        if (handoffRequested && typeof context.enqueueAgent !== 'function') {
          throw createHttpError(409, 'Private handoff is not available for this run');
        }

        if (handoffRequested && handoffAgentIds.length === 0) {
          throw createHttpError(400, 'Private handoff requires at least one recipient other than yourself');
        }

        const privateMessage = activeStore.createPrivateMessage({
          conversationId: context.conversationId,
          turnId: context.turnId,
          senderAgentId: context.agentId,
          senderName: context.agentName,
          recipientAgentIds: resolvedRecipientAgentIds,
          content,
          metadata: {
            source: 'agent-tool',
            handoffRequested,
          },
        });

        context.privatePostCount = (context.privatePostCount || 0) + 1;
        let enqueuedAgentIds = [];

        if (handoffRequested) {
          enqueuedAgentIds = context.enqueueAgent({
            agentIds: handoffAgentIds,
            triggerType: 'private',
            triggeredByAgentId: context.agentId,
            triggeredByAgentName: context.agentName,
            triggeredByMessageId: privateMessage.id,
            parentRunId: context.stage && context.stage.runId ? context.stage.runId : null,
            enqueueReason: 'private_message',
          });
          context.privateHandoffCount = (context.privateHandoffCount || 0) + enqueuedAgentIds.length;

          if (context.turnState) {
            context.turnState.updatedAt = nowIso();
            onTurnUpdated(context.turnState);
          }
        }

        broadcastEvent('conversation_private_message_created', {
          conversationId: context.conversationId,
          message: serializeConversationPrivateMessageForUi(privateMessage, conversation.agents),
        });

        const response = {
          ok: true,
          visibility: 'private',
          message: serializeAgentToolPrivateMessage(privateMessage),
          handoffRequested,
          enqueuedAgentIds,
        };

        tryAppendInvocationEvent(context, 'agent_tool_call', {
          schemaVersion: 1,
          toolCallId,
          tool: 'send-private',
          status: 'succeeded',
          durationMs: Date.now() - startedAt,
          invocationId: context.invocationId,
          conversationId: context.conversationId,
          turnId: context.turnId,
          agentId: context.agentId,
          agentName: context.agentName,
          assistantMessageId: context.assistantMessageId,
          request: {
            visibility: 'private',
            contentLength: content.length,
            recipientCount: resolvedRecipientAgentIds.length,
            handoffRequested,
          },
          result: {
            messageId: response.message.id,
            recipientCount: response.message.recipientAgentIds.length,
            enqueuedCount: Array.isArray(enqueuedAgentIds) ? enqueuedAgentIds.length : 0,
          },
        });

        return response;
      }

      throw createHttpError(400, 'Unsupported visibility. Use public or private.');
    } catch (error) {
      const errorValue = error as any;
      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: toolName,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          visibility,
          contentLength: content.length,
        },
        error: {
          statusCode: Number.isInteger(errorValue && errorValue.statusCode) ? errorValue.statusCode : null,
          message: clipText(errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error')),
        },
      });

      throw error;
    } finally {
      setContextCurrentTool(context, null);
    }
  }

  function handleReadContext(requestUrl: any) {
    const startedAt = Date.now();
    const context = getInvocation(
      requestUrl.searchParams.get('invocationId'),
      requestUrl.searchParams.get('callbackToken'),
      buildUrlRequestAuthScope(requestUrl)
    );
    const publicLimit = Number.parseInt(requestUrl.searchParams.get('publicLimit') || '', 10);
    const privateLimit = Number.parseInt(requestUrl.searchParams.get('privateLimit') || '', 10);
    const toolCallId = randomUUID();

    setContextCurrentTool(context, {
      toolName: 'read-context',
      toolKind: 'bridge',
      toolStepId: toolCallId,
      inferred: false,
      request: {
        publicLimit: Number.isFinite(publicLimit) ? publicLimit : null,
        privateLimit: Number.isFinite(privateLimit) ? privateLimit : null,
      },
    });

    try {
      ensureToolAllowed(context, 'read-context');

      if (context.dryRun) {
        let payload: any = null;

        try {
          payload = buildAgentToolContextPayload(context, {
            publicLimit: Number.isFinite(publicLimit) ? publicLimit : undefined,
            privateLimit: Number.isFinite(privateLimit) ? privateLimit : undefined,
          });
        } catch {
          payload = null;
        }

        const response =
          payload && typeof payload === 'object'
            ? {
                ok: true,
                ...payload,
              }
            : {
                ok: true,
                conversation: null,
                agent: {
                  id: context.agentId,
                  name: context.agentName,
                },
                participants: serializeAgentToolParticipants(context.conversationAgents),
                latestUserMessage: context.promptUserMessage
                  ? serializeAgentToolPublicMessage(context.promptUserMessage)
                  : null,
                publicMessages: [],
                privateMessages: [],
              };

        tryAppendInvocationEvent(context, 'agent_tool_call', {
          schemaVersion: 1,
          toolCallId,
          tool: 'read-context',
          status: 'succeeded',
          durationMs: Date.now() - startedAt,
          invocationId: context.invocationId,
          conversationId: context.conversationId,
          turnId: context.turnId,
          agentId: context.agentId,
          agentName: context.agentName,
          assistantMessageId: context.assistantMessageId,
          request: {
            publicLimit: Number.isFinite(publicLimit) ? publicLimit : null,
            privateLimit: Number.isFinite(privateLimit) ? privateLimit : null,
          },
          result: {
            publicMessageCount: Array.isArray(response.publicMessages) ? response.publicMessages.length : 0,
            privateMessageCount: Array.isArray(response.privateMessages) ? response.privateMessages.length : 0,
            participantCount: Array.isArray(response.participants) ? response.participants.length : 0,
          },
        });

        return response;
      }

      const payload = buildAgentToolContextPayload(context, {
        publicLimit: Number.isFinite(publicLimit) ? publicLimit : undefined,
        privateLimit: Number.isFinite(privateLimit) ? privateLimit : undefined,
      });
      const response = {
        ok: true,
        ...payload,
      };

      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'read-context',
        status: 'succeeded',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          publicLimit: Number.isFinite(publicLimit) ? publicLimit : null,
          privateLimit: Number.isFinite(privateLimit) ? privateLimit : null,
        },
        result: {
          publicMessageCount: Array.isArray(response.publicMessages) ? response.publicMessages.length : 0,
          privateMessageCount: Array.isArray(response.privateMessages) ? response.privateMessages.length : 0,
          participantCount: Array.isArray(response.participants) ? response.participants.length : 0,
        },
      });

      return response;
    } catch (error) {
      const errorValue = error as any;
      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'read-context',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          publicLimit: Number.isFinite(publicLimit) ? publicLimit : null,
          privateLimit: Number.isFinite(privateLimit) ? privateLimit : null,
        },
        error: {
          statusCode: Number.isInteger(errorValue && errorValue.statusCode) ? errorValue.statusCode : null,
          message: clipText(errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error')),
        },
      });

      throw error;
    } finally {
      setContextCurrentTool(context, null);
    }
  }

  function handleListParticipants(requestUrl: any) {
    const startedAt = Date.now();
    const context = getInvocation(
      requestUrl.searchParams.get('invocationId'),
      requestUrl.searchParams.get('callbackToken'),
      buildUrlRequestAuthScope(requestUrl)
    );
    const activeStore = resolveContextStore(context);
    const conversation = context.dryRun ? null : activeStore.getConversation(context.conversationId);
    const toolCallId = randomUUID();

    setContextCurrentTool(context, {
      toolName: 'participants',
      toolKind: 'bridge',
      toolStepId: toolCallId,
      inferred: false,
      request: {
        scope: 'conversation',
      },
    });

    try {
      ensureToolAllowed(context, 'list-participants');

      const response = {
        ok: true,
        conversation: conversation ? pickConversationSummary(conversation) : null,
        participants: context.dryRun
          ? serializeAgentToolParticipants(context.conversationAgents)
          : conversation
            ? serializeAgentToolParticipants(conversation.agents)
            : [],
      };

      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'participants',
        status: 'succeeded',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        result: {
          participantCount: Array.isArray(response.participants) ? response.participants.length : 0,
        },
      });

      return response;
    } catch (error) {
      const errorValue = error as any;
      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'participants',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        error: {
          statusCode: Number.isInteger(errorValue && errorValue.statusCode) ? errorValue.statusCode : null,
          message: clipText(errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error')),
        },
      });

      throw error;
    } finally {
      setContextCurrentTool(context, null);
    }
  }

  function handleSearchMessages(body: any = {}) {
    const startedAt = Date.now();
    const context = getInvocation(body.invocationId, body.callbackToken, buildRequestAuthScope(body));
    const activeStore = resolveContextStore(context);
    const query = String(body.query || '').trim().replace(/\s+/g, ' ');
    const speaker = String(body.speaker || body.senderName || body.sender || '').trim().replace(/\s+/g, ' ');
    const agentId = String(body.agentId || body.agentID || '').trim().replace(/\s+/g, ' ');
    const requestedLimit = Number.parseInt(String(body.limit || ''), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(MAX_MESSAGE_SEARCH_LIMIT, requestedLimit))
      : MAX_MESSAGE_SEARCH_LIMIT;
    const filters = {
      ...(speaker ? { speaker } : {}),
      ...(agentId ? { agentId } : {}),
    };
    const toolCallId = randomUUID();

    setContextCurrentTool(context, {
      toolName: 'search-messages',
      toolKind: 'bridge',
      toolStepId: toolCallId,
      inferred: false,
      request: {
        scope: 'conversation-public',
        queryPreview: clipText(query, MAX_MESSAGE_SEARCH_QUERY_LENGTH),
        limit,
        filters,
      },
    });

    try {
      if (!query && !speaker && !agentId) {
        throw createHttpError(400, 'query is required unless speaker or agentId filter is provided');
      }

      if (query && query.length < 2) {
        throw createHttpError(400, 'query must be at least 2 characters');
      }

      if (query.length > MAX_MESSAGE_SEARCH_QUERY_LENGTH) {
        throw createHttpError(400, `query must be at most ${MAX_MESSAGE_SEARCH_QUERY_LENGTH} characters`);
      }

      if (speaker.length > MAX_MESSAGE_SEARCH_FILTER_LENGTH) {
        throw createHttpError(400, `speaker must be at most ${MAX_MESSAGE_SEARCH_FILTER_LENGTH} characters`);
      }

      if (agentId.length > MAX_MESSAGE_SEARCH_FILTER_LENGTH) {
        throw createHttpError(400, `agentId must be at most ${MAX_MESSAGE_SEARCH_FILTER_LENGTH} characters`);
      }

      ensureToolAllowed(context, 'search-messages', {
        scope: 'conversation-public',
      });

      if (!activeStore || typeof activeStore.searchConversationMessages !== 'function') {
        throw createHttpError(501, 'Message search is not available');
      }

      const response = {
        ok: true,
        ...activeStore.searchConversationMessages(context.conversationId, {
          query,
          limit,
          speaker,
          agentId,
        }),
      };

      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'search-messages',
        status: 'succeeded',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          scope: 'conversation-public',
          queryPreview: clipText(query, MAX_MESSAGE_SEARCH_QUERY_LENGTH),
          limit,
          filters,
        },
        result: {
          searchMode: response.searchMode,
          resultCount: Array.isArray(response.results) ? response.results.length : 0,
          diagnosticCount: Array.isArray(response.diagnostics) ? response.diagnostics.length : 0,
          filters: response.filters || {},
        },
      });

      return response;
    } catch (error) {
      const errorValue = error as any;
      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'search-messages',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          scope: 'conversation-public',
          queryPreview: clipText(query, MAX_MESSAGE_SEARCH_QUERY_LENGTH),
          limit,
          filters,
        },
        error: {
          statusCode: Number.isInteger(errorValue && errorValue.statusCode) ? errorValue.statusCode : null,
          message: clipText(errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error')),
        },
      });

      throw error;
    } finally {
      setContextCurrentTool(context, null);
    }
  }

  function handleListMemories(requestUrl: any) {
    const startedAt = Date.now();
    const context = getInvocation(
      requestUrl.searchParams.get('invocationId'),
      requestUrl.searchParams.get('callbackToken'),
      buildUrlRequestAuthScope(requestUrl)
    );
    const activeStore = resolveContextStore(context);
    const limit = normalizeMemoryListLimit(requestUrl.searchParams.get('limit'));
    const toolCallId = randomUUID();

    setContextCurrentTool(context, {
      toolName: 'list-memories',
      toolKind: 'bridge',
      toolStepId: toolCallId,
      inferred: false,
      request: {
        scope: 'agent-visible',
        limit,
      },
    });

    try {
      ensureToolAllowed(context, 'list-memories', {
        scope: 'agent-visible',
      });

      if (!activeStore || typeof activeStore.listVisibleMemoryCards !== 'function') {
        throw createHttpError(501, 'Memory cards are not available');
      }

      const cards = activeStore.listVisibleMemoryCards(context.conversationId, context.agentId, { limit });
      const response = {
        ok: true,
        scope: 'agent-visible',
        scopes: ['conversation-agent', 'local-user-agent'],
        cardCount: Array.isArray(cards) ? cards.length : 0,
        budget: {
          maxCards: MAX_MEMORY_CARD_LIMIT,
          maxCardsPerScope: MAX_MEMORY_CARD_LIMIT,
        },
        cards: Array.isArray(cards) ? cards : [],
      };

      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'list-memories',
        status: 'succeeded',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          scope: 'agent-visible',
          limit,
        },
        result: {
          cardCount: response.cardCount,
          maxCards: MAX_MEMORY_CARD_LIMIT,
        },
      });

      return response;
    } catch (error) {
      const errorValue = error as any;
      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'list-memories',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          scope: 'agent-visible',
          limit,
        },
        error: {
          statusCode: Number.isInteger(errorValue && errorValue.statusCode) ? errorValue.statusCode : null,
          message: clipText(errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error')),
        },
      });

      throw error;
    } finally {
      setContextCurrentTool(context, null);
    }
  }

  function handleSaveMemory(body: any = {}) {
    const startedAt = Date.now();
    const context = getInvocation(body.invocationId, body.callbackToken, buildRequestAuthScope(body));
    const activeStore = resolveContextStore(context);
    const title = normalizeMemoryField(body.title, MAX_MEMORY_CARD_TITLE_LENGTH, 'title');
    const content = normalizeMemoryField(body.content, MAX_MEMORY_CARD_CONTENT_LENGTH, 'content');
    const ttlDays = normalizeMemoryTtlDays(body.ttlDays);
    const toolCallId = randomUUID();

    setContextCurrentTool(context, {
      toolName: 'save-memory',
      toolKind: 'bridge',
      toolStepId: toolCallId,
      inferred: false,
      request: {
        scope: 'local-user-agent',
        title,
        ttlDays,
      },
    });

    try {
      validateMemoryCardCandidate(title, content);
      ensureToolAllowed(context, 'save-memory', {
        scope: 'local-user-agent',
        title,
      });

      if (!activeStore || typeof activeStore.saveLocalUserMemoryCard !== 'function') {
        throw createHttpError(501, 'Memory cards are not available');
      }

      const saved = activeStore.saveLocalUserMemoryCard(context.agentId, {
        title,
        content,
        ttlDays,
        source: 'agent-tool',
        metadata: {
          tool: 'save-memory',
          invocationId: context.invocationId,
          turnId: context.turnId,
          assistantMessageId: context.assistantMessageId,
          conversationId: context.conversationId,
        },
      });
      const response = {
        ok: true,
        scope: 'local-user-agent',
        ...saved,
      };

      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'save-memory',
        status: 'succeeded',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          scope: 'local-user-agent',
          title,
          ttlDays,
        },
        result: {
          cardId: response.card && response.card.id ? response.card.id : null,
          cardCount: Number.isInteger(response.cardCount) ? response.cardCount : 0,
          maxCards: MAX_MEMORY_CARD_LIMIT,
        },
      });

      return response;
    } catch (error) {
      const errorValue = error as any;
      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'save-memory',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          scope: 'local-user-agent',
          title: clipText(title, MAX_MEMORY_CARD_TITLE_LENGTH),
          ttlDays,
        },
        error: {
          statusCode: Number.isInteger(errorValue && errorValue.statusCode) ? errorValue.statusCode : null,
          message: clipText(errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error')),
        },
      });

      if (errorValue && errorValue.statusCode) {
        throw error;
      }

      throw createHttpError(400, errorValue && errorValue.message ? String(errorValue.message) : 'Failed to save memory');
    } finally {
      setContextCurrentTool(context, null);
    }
  }

  function handleUpdateMemory(body: any = {}) {
    const startedAt = Date.now();
    const context = getInvocation(body.invocationId, body.callbackToken, buildRequestAuthScope(body));
    const activeStore = resolveContextStore(context);
    const title = normalizeMemoryField(body.title, MAX_MEMORY_CARD_TITLE_LENGTH, 'title');
    const content = normalizeMemoryField(body.content, MAX_MEMORY_CARD_CONTENT_LENGTH, 'content');
    const reason = normalizeMemoryReason(body.reason);
    const expectedUpdatedAt = normalizeExpectedUpdatedAt(body.expectedUpdatedAt || body['expected-updated-at']);
    const toolCallId = randomUUID();

    setContextCurrentTool(context, {
      toolName: 'update-memory',
      toolKind: 'bridge',
      toolStepId: toolCallId,
      inferred: false,
      request: {
        scope: 'local-user-agent',
        title,
        reasonTag: MEMORY_MUTATION_REASON_TAG,
        reasonLength: reason.length,
        hasExpectedUpdatedAt: Boolean(expectedUpdatedAt),
      },
    });

    try {
      validateMemoryCardCandidate(title, content);
      ensureToolAllowed(context, 'update-memory', {
        scope: 'local-user-agent',
        title,
      });

      if (!activeStore || typeof activeStore.updateLocalUserMemoryCard !== 'function') {
        throw createHttpError(501, 'Memory cards are not available');
      }

      const updated = activeStore.updateLocalUserMemoryCard(context.agentId, {
        title,
        content,
        expectedUpdatedAt,
        source: 'agent-tool',
        metadata: {
          tool: 'update-memory',
          invocationId: context.invocationId,
          turnId: context.turnId,
          assistantMessageId: context.assistantMessageId,
          conversationId: context.conversationId,
        },
        lastMutation: {
          action: 'update',
          reasonTag: MEMORY_MUTATION_REASON_TAG,
          reasonLength: reason.length,
          tool: 'update-memory',
        },
      });
      const response = {
        ok: true,
        scope: 'local-user-agent',
        action: 'update',
        card: updated.card,
      };

      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'update-memory',
        status: 'succeeded',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          scope: 'local-user-agent',
          title,
          reasonTag: MEMORY_MUTATION_REASON_TAG,
          reasonLength: reason.length,
          hasExpectedUpdatedAt: Boolean(expectedUpdatedAt),
        },
        result: {
          cardId: response.card && response.card.id ? response.card.id : null,
          status: response.card && response.card.status ? response.card.status : null,
          updatedAt: response.card && response.card.updatedAt ? response.card.updatedAt : null,
        },
      });

      return response;
    } catch (error) {
      const normalizedError = coerceMemoryMutationError(error, 'Failed to update memory');
      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'update-memory',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          scope: 'local-user-agent',
          title: clipText(title, MAX_MEMORY_CARD_TITLE_LENGTH),
          reasonTag: MEMORY_MUTATION_REASON_TAG,
          reasonLength: reason.length,
          hasExpectedUpdatedAt: Boolean(expectedUpdatedAt),
        },
        error: {
          statusCode: Number.isInteger(normalizedError && normalizedError.statusCode) ? normalizedError.statusCode : null,
          message: clipText(normalizedError && normalizedError.message ? normalizedError.message : String(normalizedError || 'Unknown error')),
        },
      });

      throw normalizedError;
    } finally {
      setContextCurrentTool(context, null);
    }
  }

  function handleForgetMemory(body: any = {}) {
    const startedAt = Date.now();
    const context = getInvocation(body.invocationId, body.callbackToken, buildRequestAuthScope(body));
    const activeStore = resolveContextStore(context);
    const title = normalizeMemoryField(body.title, MAX_MEMORY_CARD_TITLE_LENGTH, 'title');
    const reason = normalizeMemoryReason(body.reason);
    const expectedUpdatedAt = normalizeExpectedUpdatedAt(body.expectedUpdatedAt || body['expected-updated-at']);
    const toolCallId = randomUUID();

    setContextCurrentTool(context, {
      toolName: 'forget-memory',
      toolKind: 'bridge',
      toolStepId: toolCallId,
      inferred: false,
      request: {
        scope: 'local-user-agent',
        title,
        reasonTag: MEMORY_MUTATION_REASON_TAG,
        reasonLength: reason.length,
        hasExpectedUpdatedAt: Boolean(expectedUpdatedAt),
      },
    });

    try {
      ensureToolAllowed(context, 'forget-memory', {
        scope: 'local-user-agent',
        title,
      });

      if (!activeStore || typeof activeStore.forgetLocalUserMemoryCard !== 'function') {
        throw createHttpError(501, 'Memory cards are not available');
      }

      const forgotten = activeStore.forgetLocalUserMemoryCard(context.agentId, {
        title,
        expectedUpdatedAt,
        source: 'agent-tool',
        metadata: {
          tool: 'forget-memory',
          invocationId: context.invocationId,
          turnId: context.turnId,
          assistantMessageId: context.assistantMessageId,
          conversationId: context.conversationId,
        },
        lastMutation: {
          action: 'forget',
          reasonTag: MEMORY_MUTATION_REASON_TAG,
          reasonLength: reason.length,
          tool: 'forget-memory',
        },
      });
      const response = {
        ok: true,
        scope: 'local-user-agent',
        action: 'forget',
        card: summarizeForgottenMemoryCard(forgotten.card),
      };

      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'forget-memory',
        status: 'succeeded',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          scope: 'local-user-agent',
          title,
          reasonTag: MEMORY_MUTATION_REASON_TAG,
          reasonLength: reason.length,
          hasExpectedUpdatedAt: Boolean(expectedUpdatedAt),
        },
        result: {
          cardId: response.card && response.card.id ? response.card.id : null,
          status: response.card && response.card.status ? response.card.status : null,
          updatedAt: response.card && response.card.updatedAt ? response.card.updatedAt : null,
        },
      });

      return response;
    } catch (error) {
      const normalizedError = coerceMemoryMutationError(error, 'Failed to forget memory');
      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'forget-memory',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          scope: 'local-user-agent',
          title: clipText(title, MAX_MEMORY_CARD_TITLE_LENGTH),
          reasonTag: MEMORY_MUTATION_REASON_TAG,
          reasonLength: reason.length,
          hasExpectedUpdatedAt: Boolean(expectedUpdatedAt),
        },
        error: {
          statusCode: Number.isInteger(normalizedError && normalizedError.statusCode) ? normalizedError.statusCode : null,
          message: clipText(normalizedError && normalizedError.message ? normalizedError.message : String(normalizedError || 'Unknown error')),
        },
      });

      throw normalizedError;
    } finally {
      setContextCurrentTool(context, null);
    }
  }

  function safeStat(filePath: any) {
    try {
      return fs.statSync(filePath);
    } catch {
      return null;
    }
  }

  function safeLstat(filePath: any) {
    try {
      return fs.lstatSync(filePath);
    } catch {
      return null;
    }
  }

  function isPathWithinDir(rootDir: any, candidatePath: any) {
    const resolvedRoot = path.resolve(String(rootDir || '').trim());
    const resolvedCandidate = path.resolve(String(candidatePath || '').trim());

    if (!resolvedRoot || !resolvedCandidate) {
      return false;
    }

    const rootKey = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
    const candidateKey = process.platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;

    const relative = path.relative(rootKey, candidateKey);

    if (!relative) {
      return true;
    }

    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  function normalizeTaskName(value: any, fallback = 'demo') {
    const normalized = String(value || '').trim() || String(fallback || '').trim();

    if (!normalized) {
      return '';
    }

    if (normalized === '.' || normalized === '..') {
      return '';
    }

    if (normalized.includes('/') || normalized.includes('\\')) {
      return '';
    }

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
      return '';
    }

    return normalized;
  }

  function normalizeTrellisRelativePath(value: any) {
    let normalized = String(value || '').trim();

    if (!normalized) {
      return '';
    }

    if (path.isAbsolute(normalized)) {
      return '';
    }

    normalized = normalized.replace(/\\/g, '/');
    while (normalized.startsWith('./')) {
      normalized = normalized.slice(2);
    }
    while (normalized.startsWith('/')) {
      normalized = normalized.slice(1);
    }

    const parts = normalized
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => part !== '.');

    if (parts.length === 0) {
      return '';
    }

    if (parts.some((part) => part === '..')) {
      return '';
    }

    if (parts[0] !== '.trellis') {
      parts.unshift('.trellis');
    }

    if (parts.length <= 1) {
      return '';
    }

    return parts.join('/');
  }

  function hasSymlinkInPath(rootDir: any, candidatePath: any) {
    const resolvedRoot = path.resolve(String(rootDir || '').trim());
    const resolvedCandidate = path.resolve(String(candidatePath || '').trim());

    if (!resolvedRoot || !resolvedCandidate) {
      return false;
    }

    if (!isPathWithinDir(resolvedRoot, resolvedCandidate)) {
      return false;
    }

    const relative = path.relative(resolvedRoot, resolvedCandidate);

    if (!relative) {
      const stat = safeLstat(resolvedRoot);
      return Boolean(stat && stat.isSymbolicLink());
    }

    const parts = relative.split(path.sep).filter(Boolean);
    let current = resolvedRoot;

    for (const part of parts) {
      current = path.join(current, part);
      const stat = safeLstat(current);
      if (stat && stat.isSymbolicLink()) {
        return true;
      }
    }

    return false;
  }

  function buildTrellisInitFiles(taskName: string) {
    const safeTaskName = String(taskName || '').trim() || 'demo';

    const trellisGitignore = [
      '# Local-only Trellis runtime files',
      '.developer',
      '.current-task',
      '.ralph-state.json',
      '.agents/',
      '.agent-log',
      '.session-id',
      '.plan-log',
      '',
      '# Atomic update temp files',
      '*.tmp',
      '*.new',
      '',
      '# Update backup directories',
      '.backup-*',
      '',
      '# Python cache (if you use Trellis scripts)',
      '**/__pycache__/',
      '**/*.pyc',
      '',
    ].join('\n');

    const workflow = [
      '# Trellis Workflow',
      '',
      'This folder is used by CAFF to inject lightweight task/PRD/workflow context into agent prompts.',
      '',
      'Quick start:',
      `1) Set the current task in \`.trellis/.current-task\` (example: \`.trellis/tasks/${safeTaskName}\`).`,
      '2) Write a PRD in `.trellis/tasks/<task>/prd.md`.',
      '3) Edit JSONL context files to list relevant specs/files for each phase:',
      '   - implement.jsonl: dev specs + patterns to follow',
      '   - check.jsonl: review/quality criteria',
      '   - spec.jsonl: fallback specs (used when phase-specific JSONL is empty)',
      '',
      'JSONL format (one JSON object per line):',
      '  {"file": ".trellis/spec/backend/index.md", "reason": "Backend guidelines"}',
      '  {"file": "src/server/index.ts", "reason": "Entry point"}',
      '',
      'Optional:',
      '- Add spec index files under `.trellis/spec/**/index.md` for discoverability hints.',
      '',
    ].join('\n');

    const taskJson = JSON.stringify(
      {
        title: `Task: ${safeTaskName}`,
        status: 'active',
        createdAt: new Date().toISOString().slice(0, 10),
      },
      null,
      2
    );

    const prd = [
      `# PRD: ${safeTaskName}`,
      '',
      '## Goal',
      '- Describe what you want to build.',
      '',
      '## Scope',
      '- In scope:',
      '- Out of scope:',
      '',
      '## Acceptance Criteria',
      '- [ ] Item 1',
      '',
    ].join('\n');

    const taskDirRef = `.trellis/tasks/${safeTaskName}`;
    const implementJsonl = [
      JSON.stringify({ file: `${taskDirRef}/prd.md`, reason: 'Task requirements (PRD).' }),
      JSON.stringify({ file: '.trellis/spec/index.md', reason: 'Project spec index (edit/add more spec files).' }),
    ].join('\n');

    const checkJsonl = [JSON.stringify({ file: `${taskDirRef}/prd.md`, reason: 'Acceptance criteria to verify.' })].join(
      '\n'
    );

    const specJsonl = [JSON.stringify({ file: '.trellis/spec/index.md', reason: 'Shared spec fallback.' })].join('\n');

    const specIndex = ['# Spec Index', '', 'Add relevant spec links here.', ''].join('\n');

    return [
      { relativePath: '.trellis/.gitignore', content: trellisGitignore },
      { relativePath: '.trellis/workflow.md', content: workflow },
      { relativePath: '.trellis/.current-task', content: `${taskDirRef}\n` },
      { relativePath: '.trellis/spec/index.md', content: specIndex },
      { relativePath: `.trellis/tasks/${safeTaskName}/task.json`, content: `${taskJson}\n` },
      { relativePath: `.trellis/tasks/${safeTaskName}/prd.md`, content: `${prd}\n` },
      { relativePath: `.trellis/tasks/${safeTaskName}/implement.jsonl`, content: `${implementJsonl}\n` },
      { relativePath: `.trellis/tasks/${safeTaskName}/check.jsonl`, content: `${checkJsonl}\n` },
      { relativePath: `.trellis/tasks/${safeTaskName}/spec.jsonl`, content: `${specJsonl}\n` },
    ];
  }

  function handleTrellisInit(body: any = {}) {
    const startedAt = Date.now();
    const context = getInvocation(body.invocationId, body.callbackToken, buildRequestAuthScope(body));
    const includeContent = body.includeContent === true;
    const confirm = body.confirm === true;
    const force = body.force === true;
    const taskName = normalizeTaskName(body.taskName || body.task || body.name, 'demo');

    const toolCallId = randomUUID();

    setContextCurrentTool(context, {
      toolName: 'trellis-init',
      toolKind: 'bridge',
      toolStepId: toolCallId,
      inferred: false,
      request: {
        taskName,
        confirm,
        force,
        includeContent,
      },
    });

    try {
      ensureToolAllowed(context, 'trellis-init');

      if (!taskName) {
        throw createHttpError(400, 'taskName must be a simple directory name (letters/numbers/._-)');
      }

      const projectDirRaw = String(context.projectDir || '').trim();

      if (!projectDirRaw) {
        throw createHttpError(409, 'No active project directory is available for this invocation');
      }

      const projectDir = path.resolve(projectDirRaw);
      const projectStat = safeStat(projectDir);

      if (!projectStat || !projectStat.isDirectory()) {
        throw createHttpError(409, 'Active project directory does not exist or is not a folder');
      }

      const trellisDir = path.join(projectDir, '.trellis');
      const trellisLstat = safeLstat(trellisDir);

      if (trellisLstat && trellisLstat.isSymbolicLink()) {
        throw createHttpError(400, 'Refusing to write .trellis because it is a symlink');
      }

      if (trellisLstat && !trellisLstat.isDirectory()) {
        throw createHttpError(409, 'Refusing to write .trellis because it exists and is not a directory');
      }

      const files = buildTrellisInitFiles(taskName);
      const operations: any[] = [];

      for (const file of files) {
        const absolutePath = path.resolve(projectDir, file.relativePath);
        const withinTrellis = isPathWithinDir(trellisDir, absolutePath);

        if (!withinTrellis) {
          throw createHttpError(400, `Refusing to write outside .trellis: ${file.relativePath}`);
        }

        const exists = fs.existsSync(absolutePath);
        const existingStat = exists ? safeStat(absolutePath) : null;
        const action =
          existingStat && existingStat.isDirectory()
            ? 'conflict-directory'
            : exists
              ? force
                ? 'overwrite'
                : 'skip-existing'
              : 'create';

        operations.push({
          path: file.relativePath.replace(/\\/g, '/'),
          action,
          bytes: Buffer.byteLength(file.content, 'utf8'),
          ...(includeContent ? { content: file.content } : {}),
        });
      }

      if (!confirm) {
        const response = {
          ok: true,
          applied: false,
          projectDir,
          trellisDir,
          taskName,
          operations,
          willWriteCount: operations.filter((op) => op.action === 'create' || op.action === 'overwrite').length,
          skippedCount: operations.filter((op) => op.action === 'skip-existing').length,
          confirmRequired: true,
        };

        tryAppendInvocationEvent(context, 'agent_tool_call', {
          schemaVersion: 1,
          toolCallId,
          tool: 'trellis-init',
          status: 'succeeded',
          durationMs: Date.now() - startedAt,
          invocationId: context.invocationId,
          conversationId: context.conversationId,
          turnId: context.turnId,
          agentId: context.agentId,
          agentName: context.agentName,
          assistantMessageId: context.assistantMessageId,
          request: {
            taskName,
            confirm,
            force,
            includeContent,
          },
          result: {
            applied: false,
            operationCount: operations.length,
            willWriteCount: response.willWriteCount,
            skippedCount: response.skippedCount,
          },
        });

        return response;
      }

      fs.mkdirSync(trellisDir, { recursive: true });

      if (hasSymlinkInPath(projectDir, trellisDir)) {
        throw createHttpError(400, 'Refusing to write .trellis because it contains a symlink');
      }

      for (const file of files) {
        const absolutePath = path.resolve(projectDir, file.relativePath);
        const exists = fs.existsSync(absolutePath);
        const existingStat = exists ? safeStat(absolutePath) : null;

        if (existingStat && existingStat.isDirectory()) {
          throw createHttpError(400, `Refusing to write because path is a directory: ${file.relativePath}`);
        }

        if (exists && !force) {
          continue;
        }

        if (hasSymlinkInPath(trellisDir, absolutePath)) {
          throw createHttpError(400, `Refusing to write because path includes a symlink: ${file.relativePath}`);
        }
      }

      const writtenFiles: string[] = [];
      const skippedFiles: string[] = [];

      for (const file of files) {
        const absolutePath = path.resolve(projectDir, file.relativePath);
        const exists = fs.existsSync(absolutePath);
        const existingStat = exists ? safeStat(absolutePath) : null;

        if (exists && !force) {
          skippedFiles.push(file.relativePath.replace(/\\/g, '/'));
          continue;
        }

        if (existingStat && existingStat.isDirectory()) {
          throw createHttpError(400, `Refusing to write because path is a directory: ${file.relativePath}`);
        }

        if (hasSymlinkInPath(trellisDir, absolutePath)) {
          throw createHttpError(400, `Refusing to write because path includes a symlink: ${file.relativePath}`);
        }

        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, file.content, 'utf8');
        writtenFiles.push(file.relativePath.replace(/\\/g, '/'));
      }

      const response = {
        ok: true,
        applied: true,
        projectDir,
        trellisDir,
        taskName,
        writtenFiles,
        skippedFiles,
      };

      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'trellis-init',
        status: 'succeeded',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          taskName,
          confirm,
          force,
          includeContent,
        },
        result: {
          applied: true,
          writtenCount: writtenFiles.length,
          skippedCount: skippedFiles.length,
        },
      });

      return response;
    } catch (error) {
      const errorValue = error as any;
      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'trellis-init',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          taskName,
          confirm,
          force,
          includeContent,
        },
        error: {
          statusCode: Number.isInteger(errorValue && errorValue.statusCode) ? errorValue.statusCode : null,
          message: clipText(errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error')),
        },
      });

      throw error;
    } finally {
      setContextCurrentTool(context, null);
    }
  }

  function handleTrellisWrite(body: any = {}) {
    const startedAt = Date.now();
    const context = getInvocation(body.invocationId, body.callbackToken, buildRequestAuthScope(body));
    const includeContent = body.includeContent === true;
    const confirm = body.confirm === true;
    const force = body.force === true;
    const toolCallId = randomUUID();

    setContextCurrentTool(context, {
      toolName: 'trellis-write',
      toolKind: 'bridge',
      toolStepId: toolCallId,
      inferred: false,
      request: {
        confirm,
        force,
        includeContent,
      },
    });

    let fileCount = 0;
    let totalBytes = 0;
    let pathsSample: string[] = [];

    try {
      ensureToolAllowed(context, 'trellis-write');
      const filesPayload = Array.isArray(body.files) ? body.files : null;
      const files = filesPayload
        ? filesPayload
        : [
            {
              relativePath: body.relativePath || body.path,
              content: body.content,
            },
          ];

      const normalizedFiles: any[] = [];
      const rejectedPaths: string[] = [];

      for (const file of Array.isArray(files) ? files : []) {
        const record = file && typeof file === 'object' ? file : null;
        if (!record) {
          rejectedPaths.push('[invalid file entry]');
          continue;
        }

        const rawPath = record.relativePath ?? record.path ?? '';
        const normalizedPath = normalizeTrellisRelativePath(rawPath);
        if (!normalizedPath) {
          rejectedPaths.push(String(rawPath || '').trim() || '[empty]');
          continue;
        }

        normalizedFiles.push({
          relativePath: normalizedPath,
          content: typeof record.content === 'string' ? record.content : String(record.content ?? ''),
        });
      }

      fileCount = normalizedFiles.length;
      pathsSample = normalizedFiles.slice(0, 6).map((file: any) => file.relativePath);

      if (rejectedPaths.length > 0) {
        const examples = rejectedPaths
          .filter(Boolean)
          .slice(0, 6)
          .map((item) => clipText(item, 120));
        const suffix = rejectedPaths.length > examples.length ? ` (+${rejectedPaths.length - examples.length} more)` : '';
        throw createHttpError(
          400,
          `Invalid .trellis paths. Expected a file path under .trellis/**. Rejected: ${examples.join(', ')}${suffix}`
        );
      }

      if (normalizedFiles.length === 0) {
        throw createHttpError(400, 'files must include at least one .trellis-relative path');
      }

      if (normalizedFiles.length > 20) {
        throw createHttpError(400, 'Refusing to write more than 20 files in one request');
      }

      totalBytes = normalizedFiles.reduce((sum: number, file: any) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
      if (totalBytes > 256 * 1024) {
        throw createHttpError(400, 'Refusing to write more than 256KB of content in one request');
      }

      const projectDirRaw = String(context.projectDir || '').trim();

      if (!projectDirRaw) {
        throw createHttpError(409, 'No active project directory is available for this invocation');
      }

      const projectDir = path.resolve(projectDirRaw);
      const projectStat = safeStat(projectDir);

      if (!projectStat || !projectStat.isDirectory()) {
        throw createHttpError(409, 'Active project directory does not exist or is not a folder');
      }

      const trellisDir = path.join(projectDir, '.trellis');
      const trellisLstat = safeLstat(trellisDir);

      if (trellisLstat && trellisLstat.isSymbolicLink()) {
        throw createHttpError(400, 'Refusing to write .trellis because it is a symlink');
      }

      if (trellisLstat && !trellisLstat.isDirectory()) {
        throw createHttpError(409, 'Refusing to write .trellis because it exists and is not a directory');
      }

      const operations: any[] = [];

      for (const file of normalizedFiles) {
        const absolutePath = path.resolve(projectDir, file.relativePath);
        const withinTrellis = isPathWithinDir(trellisDir, absolutePath);

        if (!withinTrellis) {
          throw createHttpError(400, `Refusing to write outside .trellis: ${file.relativePath}`);
        }

        const exists = fs.existsSync(absolutePath);
        const existingStat = exists ? safeStat(absolutePath) : null;

        if (existingStat && existingStat.isDirectory()) {
          throw createHttpError(400, `Refusing to write because path is a directory: ${file.relativePath}`);
        }
        const action = exists ? (force ? 'overwrite' : 'skip-existing') : 'create';

        operations.push({
          path: file.relativePath.replace(/\\/g, '/'),
          action,
          bytes: Buffer.byteLength(file.content, 'utf8'),
          ...(includeContent ? { content: file.content } : {}),
        });
      }

      if (!confirm) {
        const response = {
          ok: true,
          applied: false,
          projectDir,
          trellisDir,
          operations,
          willWriteCount: operations.filter((op) => op.action === 'create' || op.action === 'overwrite').length,
          skippedCount: operations.filter((op) => op.action === 'skip-existing').length,
          confirmRequired: true,
        };

        tryAppendInvocationEvent(context, 'agent_tool_call', {
          schemaVersion: 1,
          toolCallId,
          tool: 'trellis-write',
          status: 'succeeded',
          durationMs: Date.now() - startedAt,
          invocationId: context.invocationId,
          conversationId: context.conversationId,
          turnId: context.turnId,
          agentId: context.agentId,
          agentName: context.agentName,
          assistantMessageId: context.assistantMessageId,
          request: {
            confirm,
            force,
            includeContent,
            fileCount,
            totalBytes,
            paths: pathsSample,
          },
          result: {
            applied: false,
            operationCount: operations.length,
            willWriteCount: response.willWriteCount,
            skippedCount: response.skippedCount,
          },
        });

        return response;
      }

      fs.mkdirSync(trellisDir, { recursive: true });

      if (hasSymlinkInPath(projectDir, trellisDir)) {
        throw createHttpError(400, 'Refusing to write .trellis because it contains a symlink');
      }

      const writtenFiles: string[] = [];
      const skippedFiles: string[] = [];

      for (const file of normalizedFiles) {
        const absolutePath = path.resolve(projectDir, file.relativePath);
        const exists = fs.existsSync(absolutePath);

        if (exists && !force) {
          skippedFiles.push(file.relativePath.replace(/\\/g, '/'));
          continue;
        }

        const existingStat = exists ? safeStat(absolutePath) : null;

        if (existingStat && existingStat.isDirectory()) {
          throw createHttpError(400, `Refusing to write because path is a directory: ${file.relativePath}`);
        }

        if (hasSymlinkInPath(trellisDir, absolutePath)) {
          throw createHttpError(400, `Refusing to write because path includes a symlink: ${file.relativePath}`);
        }

        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, file.content, 'utf8');
        writtenFiles.push(file.relativePath.replace(/\\/g, '/'));
      }

      const response = {
        ok: true,
        applied: true,
        projectDir,
        trellisDir,
        writtenFiles,
        skippedFiles,
      };

      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'trellis-write',
        status: 'succeeded',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          confirm,
          force,
          includeContent,
          fileCount,
          totalBytes,
          paths: pathsSample,
        },
        result: {
          applied: true,
          writtenCount: writtenFiles.length,
          skippedCount: skippedFiles.length,
        },
      });

      return response;
    } catch (error) {
      const errorValue = error as any;
      tryAppendInvocationEvent(context, 'agent_tool_call', {
        schemaVersion: 1,
        toolCallId,
        tool: 'trellis-write',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        invocationId: context.invocationId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        agentId: context.agentId,
        agentName: context.agentName,
        assistantMessageId: context.assistantMessageId,
        request: {
          confirm,
          force,
          includeContent,
          fileCount,
          totalBytes,
          paths: pathsSample,
        },
        error: {
          statusCode: Number.isInteger(errorValue && errorValue.statusCode) ? errorValue.statusCode : null,
          message: clipText(errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error')),
        },
      });

      throw error;
    } finally {
      setContextCurrentTool(context, null);
    }
  }

  return {
    createInvocationContext,
    handleForgetMemory,
    handleListMemories,
    handleListParticipants,
    handlePostMessage,
    handleReadContext,
    handleSaveMemory,
    handleSearchMessages,
    handleTrellisInit,
    handleTrellisWrite,
    handleUpdateMemory,
    registerInvocation,
    summarizeInvocationAuth,
    unregisterInvocation,
  };
}
