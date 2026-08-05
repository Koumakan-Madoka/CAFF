const { randomUUID } = require('node:crypto');
const { createHttpError } = require('../../http/http-errors');

import type { HttpError } from '../../http/http-errors';

type UnknownRecord = Record<string, unknown>;

type SpawnParticipant = UnknownRecord & {
  agentId: string;
};

type ConversationSpawnStore = UnknownRecord & {
  persistConversationSpawn: (payload: UnknownRecord) => UnknownRecord;
  getConversationWithoutMessages?: (conversationId: string) => UnknownRecord | null;
  getConversation?: (conversationId: string) => UnknownRecord | null;
  getMessage?: (messageId: string) => UnknownRecord | null;
  getCrossConversationDeliveryBundleByIdempotency?: (
    idempotencyScope: string,
    idempotencyKey: string
  ) => UnknownRecord | null;
};

type ConversationSpawnServiceOptions = {
  store: unknown;
  validateParticipants: (input: UnknownRecord) => SpawnParticipant[];
  resolveProject: (projectScopeId: string) => UnknownRecord | null;
  now?: () => Date;
  createId?: () => string;
  onBootstrapAvailable?: (result: UnknownRecord) => unknown;
};

const MAX_TITLE_LENGTH = 200;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_INITIAL_MESSAGE_LENGTH = 12_000;
const MAX_TREE_DEPTH = 2;

function createSpawnError(
  statusCode: number,
  code: string,
  message: string,
  details: UnknownRecord = {}
): HttpError & { code: string } {
  const issues = Array.isArray(details.issues)
    ? details.issues
    : [{
        code,
        message,
        ...(details.field ? { field: details.field } : {}),
      }];
  return createHttpError(statusCode, message, { code, ...details, issues }) as HttpError & { code: string };
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeRequiredText(value: unknown, fieldName: string, maxLength: number) {
  if (typeof value !== 'string') {
    throw createSpawnError(400, 'conversation_spawn_invalid_request', `${fieldName} must be a string`, {
      field: fieldName,
    });
  }
  const normalized = value.trim();
  if (!normalized) {
    throw createSpawnError(400, 'conversation_spawn_invalid_request', `${fieldName} is required`, {
      field: fieldName,
    });
  }
  if (normalized.length > maxLength) {
    throw createSpawnError(
      400,
      'conversation_spawn_invalid_request',
      `${fieldName} must be at most ${maxLength} characters`,
      { field: fieldName }
    );
  }
  return normalized;
}

function normalizeOptionalIdentifier(value: unknown, fieldName: string) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return normalizeRequiredText(value, fieldName, MAX_IDENTIFIER_LENGTH);
}

function normalizeDate(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) {
    throw new Error('Conversation spawn clock returned an invalid date');
  }
  return date;
}

function isSqliteConstraintError(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  return String((error as { code?: unknown }).code || '').toUpperCase().startsWith('SQLITE_CONSTRAINT');
}

export function createConversationSpawnService(options: ConversationSpawnServiceOptions) {
  const storeValue = options?.store;
  const validateParticipants = options?.validateParticipants;
  const resolveProject = options?.resolveProject;
  const now = typeof options?.now === 'function' ? options.now : () => new Date();
  const createId = typeof options?.createId === 'function' ? options.createId : () => randomUUID();
  const onBootstrapAvailable = typeof options?.onBootstrapAvailable === 'function'
    ? options.onBootstrapAvailable
    : null;

  if (!storeValue || typeof storeValue !== 'object' || typeof (storeValue as UnknownRecord).persistConversationSpawn !== 'function') {
    throw new Error('Conversation spawn service requires a chat store with spawn persistence');
  }
  const store = storeValue as ConversationSpawnStore;
  if (typeof validateParticipants !== 'function') {
    throw new Error('Conversation spawn service requires participant validation');
  }
  if (typeof resolveProject !== 'function') {
    throw new Error('Conversation spawn service requires project resolution');
  }

  function publishAvailable(result: UnknownRecord) {
    if (!onBootstrapAvailable) {
      return result;
    }
    try {
      const maybePromise = onBootstrapAvailable(result);
      if (maybePromise && typeof (maybePromise as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(maybePromise).catch((error: unknown) => {
          console.error(`[conversation-spawn] Post-commit bootstrap scheduling failed: ${String(error)}`);
        });
      }
    } catch (error) {
      console.error(`[conversation-spawn] Post-commit bootstrap scheduling failed: ${String(error)}`);
    }
    return result;
  }

  function getCanonical(idempotencyScope: string, idempotencyKey: string) {
    if (typeof store.getCrossConversationDeliveryBundleByIdempotency !== 'function') {
      return null;
    }
    const bundle = store.getCrossConversationDeliveryBundleByIdempotency(
      idempotencyScope,
      idempotencyKey
    ) as UnknownRecord | null;
    const delivery = bundle && isPlainObject(bundle.delivery) ? bundle.delivery : null;
    if (!delivery || delivery.kind !== 'bootstrap') {
      return null;
    }
    const targetConversationId = String(delivery.targetConversationId || '').trim();
    const conversation = typeof store.getConversation === 'function'
      ? store.getConversation(targetConversationId)
      : null;
    if (!conversation) {
      throw new Error('Canonical conversation spawn is missing its child conversation');
    }
    return {
      duplicate: true,
      conversation,
      initialMessage: bundle?.targetMessage || null,
      sourceReceipt: bundle?.sourceReceipt || null,
      delivery,
    };
  }

  function spawn(sourceConversationIdValue: unknown, inputValue: unknown = {}) {
    const sourceConversationId = normalizeRequiredText(
      sourceConversationIdValue,
      'sourceConversationId',
      MAX_IDENTIFIER_LENGTH
    );
    const input = isPlainObject(inputValue) ? inputValue : {};
    const sourceConversation = typeof store.getConversationWithoutMessages === 'function'
      ? store.getConversationWithoutMessages(sourceConversationId)
      : null;
    if (!sourceConversation) {
      throw createSpawnError(404, 'conversation_spawn_source_not_found', 'Source conversation not found');
    }
    const sourceProjectScopeId = String(sourceConversation.projectScopeId || '').trim();
    if (!sourceProjectScopeId) {
      throw createSpawnError(
        409,
        'conversation_spawn_source_unbound',
        'Source conversation must be explicitly bound to a project before spawning'
      );
    }
    const sourceDepth = Number(sourceConversation.treeDepth || 0);
    if (!Number.isInteger(sourceDepth) || sourceDepth < 0 || sourceDepth >= MAX_TREE_DEPTH) {
      throw createSpawnError(
        409,
        'conversation_spawn_max_depth',
        'The source conversation is already at the maximum child depth'
      );
    }

    const title = normalizeRequiredText(input.title, 'title', MAX_TITLE_LENGTH);
    const projectScopeId = normalizeRequiredText(
      input.projectScopeId,
      'projectScopeId',
      MAX_IDENTIFIER_LENGTH
    );
    const primaryAgentId = normalizeRequiredText(
      input.primaryAgentId,
      'primaryAgentId',
      MAX_IDENTIFIER_LENGTH
    );
    const initialMessageContent = normalizeRequiredText(
      input.initialMessage,
      'initialMessage',
      MAX_INITIAL_MESSAGE_LENGTH
    );
    const clientRequestId = normalizeRequiredText(
      input.clientRequestId,
      'clientRequestId',
      MAX_IDENTIFIER_LENGTH
    );
    const sourceMessageId = normalizeOptionalIdentifier(input.sourceMessageId, 'sourceMessageId');

    const project = resolveProject(projectScopeId);
    if (!project) {
      throw createSpawnError(404, 'conversation_spawn_project_not_found', 'Project not found', {
        field: 'projectScopeId',
      });
    }
    if (projectScopeId !== sourceProjectScopeId) {
      throw createSpawnError(
        403,
        'conversation_spawn_project_mismatch',
        'Child conversation must use the explicitly bound source project',
        { field: 'projectScopeId' }
      );
    }

    const participants = validateParticipants({ participants: input.participants });
    if (!Array.isArray(participants) || participants.length === 0) {
      throw createSpawnError(
        400,
        'conversation_spawn_participants_required',
        'At least one explicit conversation participant is required',
        { field: 'participants' }
      );
    }
    if (!participants.some((participant) => participant.agentId === primaryAgentId)) {
      throw createSpawnError(
        422,
        'conversation_spawn_primary_not_participant',
        'primaryAgentId must identify one selected runnable participant',
        { field: 'primaryAgentId' }
      );
    }

    if (sourceMessageId) {
      const sourceMessage = typeof store.getMessage === 'function' ? store.getMessage(sourceMessageId) : null;
      if (!sourceMessage || sourceMessage.conversationId !== sourceConversationId) {
        throw createSpawnError(
          404,
          'conversation_spawn_source_message_not_found',
          'sourceMessageId must identify a message in the source conversation',
          { field: 'sourceMessageId' }
        );
      }
    }

    const idempotencyScope = `operator:${sourceConversationId}:conversation_spawn`;
    const createdAt = normalizeDate(now()).toISOString();
    const conversationId = String(createId()).trim();
    const deliveryId = String(createId()).trim();
    const initialMessageId = String(createId()).trim();
    const sourceReceiptMessageId = String(createId()).trim();
    const traceId = String(createId()).trim();
    const turnId = `conversation-spawn:${deliveryId}`;
    const treeDepth = sourceDepth + 1;

    const payload = {
      conversation: {
        id: conversationId,
        title,
        type: 'standard',
        metadata: {},
        projectScopeId,
        parentConversationId: sourceConversationId,
        originConversationId: sourceConversationId,
        originMessageId: sourceMessageId,
        treeDepth,
        participants,
        createdAt,
      },
      delivery: {
        id: deliveryId,
        kind: 'bootstrap',
        idempotencyScope,
        idempotencyKey: clientRequestId,
        principalKind: 'operator',
        sourceConversationId,
        sourceMessageId,
        sourceTurnId: null,
        sourceInvocationId: null,
        sourceAgentId: null,
        sourceAgentName: 'Operator',
        sourceProjectScopeId,
        targetConversationId: conversationId,
        targetAgentId: primaryAgentId,
        targetMessageId: null,
        sourceReceiptMessageId: null,
        targetProjectScopeId: projectScopeId,
        traceId,
        rootDeliveryId: deliveryId,
        parentDeliveryId: null,
        replyToDeliveryId: null,
        hopCount: 0,
        messageStatus: 'pending',
        dispatchStatus: 'queued',
        responseStatus: 'not_expected',
        attemptCount: 0,
        deadlineAt: null,
        cancelRequestedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        claimOwner: null,
        claimExpiresAt: null,
        nextAttemptAt: createdAt,
        targetInvocationId: null,
        deliveredAt: null,
        startedAt: null,
        completedAt: null,
        respondedAt: null,
        terminalAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      initialMessage: {
        id: initialMessageId,
        conversationId,
        turnId,
        role: 'user',
        agentId: null,
        senderName: 'You',
        content: initialMessageContent,
        status: 'completed',
        taskId: null,
        runId: null,
        errorMessage: null,
        metadata: {
          kind: 'conversation_spawn_initial_message',
          crossConversation: {
            deliveryId,
            kind: 'bootstrap',
            authority: 'user',
            sourceConversationId,
            sourceConversationTitle: String(sourceConversation.title || ''),
            sourceMessageId,
            parentConversationId: sourceConversationId,
            originConversationId: sourceConversationId,
            traceId,
          },
        },
        createdAt,
      },
      sourceReceipt: {
        id: sourceReceiptMessageId,
        conversationId: sourceConversationId,
        turnId,
        role: 'system',
        agentId: null,
        senderName: 'System',
        content: '',
        status: 'completed',
        taskId: null,
        runId: null,
        errorMessage: null,
        metadata: {
          kind: 'cross_conversation_receipt',
          crossConversation: {
            deliveryId,
            kind: 'bootstrap',
            targetConversationId: conversationId,
            targetConversationTitle: title,
            targetAgentId: primaryAgentId,
            traceId,
          },
        },
        createdAt,
      },
      persistedEvent: {
        kind: 'bootstrap',
        sourceConversationId,
        sourceMessageId,
        targetConversationId: conversationId,
        targetAgentId: primaryAgentId,
        targetMessageId: initialMessageId,
        sourceReceiptMessageId,
        traceId,
        treeDepth,
        initialMessageLength: initialMessageContent.length,
        participantCount: participants.length,
        messageStatus: 'persisted',
        dispatchStatus: 'queued',
        responseStatus: 'not_expected',
      },
      deliveredAt: createdAt,
    };

    try {
      return publishAvailable(store.persistConversationSpawn(payload) as UnknownRecord);
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        const canonical = getCanonical(idempotencyScope, clientRequestId);
        if (canonical) {
          return publishAvailable(canonical);
        }
      }
      throw error;
    }
  }

  return { spawn };
}
