const { randomUUID } = require('node:crypto');
const { createHttpError } = require('../../http/http-errors');

const MAX_DELIVERY_CONTENT_LENGTH = 12_000;
const MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_DELIVERY_IDENTIFIER_LENGTH = 200;
const DEFAULT_REQUEST_DEADLINE_SECONDS = 300;
const MAX_REQUEST_DEADLINE_SECONDS = 86_400;
const MAX_TRACE_HOP = 8;

function createDeliveryError(statusCode: number, code: string, message: string, details: any = {}) {
  return createHttpError(statusCode, message, { code, ...details });
}

function normalizeRequiredText(value: any, fieldName: string, maxLength = MAX_DELIVERY_IDENTIFIER_LENGTH) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    throw createDeliveryError(400, 'cross_conversation_invalid_request', `${fieldName} is required`, {
      field: fieldName,
    });
  }

  if (normalized.length > maxLength) {
    throw createDeliveryError(
      400,
      'cross_conversation_invalid_request',
      `${fieldName} must be at most ${maxLength} characters`,
      { field: fieldName }
    );
  }

  return normalized;
}

function normalizeDeliveryContent(value: any) {
  const content = String(value || '').trim();

  if (!content) {
    throw createDeliveryError(400, 'cross_conversation_invalid_request', 'content is required', {
      field: 'content',
    });
  }

  if (content.length > MAX_DELIVERY_CONTENT_LENGTH) {
    throw createDeliveryError(
      400,
      'cross_conversation_invalid_request',
      `content must be at most ${MAX_DELIVERY_CONTENT_LENGTH} characters`,
      { field: 'content' }
    );
  }

  return content;
}

function normalizeDeadlineSeconds(kind: string, value: any) {
  if (kind !== 'request') {
    if (value !== undefined && value !== null && value !== '') {
      throw createDeliveryError(
        400,
        'cross_conversation_invalid_request',
        'deadlineSeconds is only valid for conversation requests',
        { field: 'deadlineSeconds' }
      );
    }
    return null;
  }

  if (value === undefined || value === null || value === '') {
    return DEFAULT_REQUEST_DEADLINE_SECONDS;
  }

  if (!Number.isInteger(value) || value < 1 || value > MAX_REQUEST_DEADLINE_SECONDS) {
    throw createDeliveryError(
      400,
      'cross_conversation_invalid_request',
      `deadlineSeconds must be an integer between 1 and ${MAX_REQUEST_DEADLINE_SECONDS}`,
      { field: 'deadlineSeconds' }
    );
  }

  return value;
}

function normalizeNow(value: any) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Cross-conversation delivery clock returned an invalid date');
  }
  return date;
}

function isSqliteConstraintError(error: any) {
  return String(error && error.code ? error.code : '').toUpperCase().startsWith('SQLITE_CONSTRAINT');
}

export function createCrossConversationDeliveryService(options: any = {}) {
  const store = options.store;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const createId = typeof options.createId === 'function' ? options.createId : () => randomUUID();

  if (!store) {
    throw new Error('Cross-conversation delivery service requires a chat store');
  }

  function resolveTrace(principal: any, sourceConversation: any, targetConversation: any) {
    const incomingDeliveryId = String(principal.incomingDeliveryId || '').trim();

    if (!incomingDeliveryId) {
      return null;
    }

    const parent = store.getCrossConversationDelivery(incomingDeliveryId);
    if (!parent) {
      throw createDeliveryError(
        409,
        'cross_conversation_parent_delivery_missing',
        'The incoming cross-conversation delivery is no longer available'
      );
    }

    if (
      parent.targetConversationId !== sourceConversation.id
      || parent.targetAgentId !== principal.sourceAgentId
    ) {
      throw createDeliveryError(
        403,
        'cross_conversation_parent_principal_mismatch',
        'The incoming delivery does not belong to this invocation principal'
      );
    }

    if (parent.hopCount >= MAX_TRACE_HOP) {
      throw createDeliveryError(
        409,
        'cross_conversation_max_hop_exceeded',
        `Cross-conversation delivery traces cannot exceed ${MAX_TRACE_HOP} hops`
      );
    }

    if (store.getCrossConversationTraceEdge(parent.traceId, sourceConversation.id, targetConversation.id)) {
      throw createDeliveryError(
        409,
        'cross_conversation_trace_edge_repeated',
        'This directed conversation edge already exists in the delivery trace'
      );
    }

    if (store.getCrossConversationTraceEdge(parent.traceId, targetConversation.id, sourceConversation.id)) {
      throw createDeliveryError(
        409,
        'cross_conversation_trace_reverse_reserved',
        'Reverse trace edges are reserved for the canonical request response'
      );
    }

    return {
      traceId: parent.traceId,
      rootDeliveryId: parent.rootDeliveryId,
      parentDeliveryId: parent.id,
      hopCount: parent.hopCount + 1,
    };
  }

  function submitFromAgent(principalInput: any = {}, input: any = {}) {
    const principalKind = String(principalInput.kind || '').trim();
    if (principalKind !== 'agent') {
      throw createDeliveryError(403, 'cross_conversation_agent_principal_required', 'An active Agent invocation is required');
    }

    const kind = String(input.kind || '').trim().toLowerCase();
    if (kind !== 'notify' && kind !== 'request') {
      throw createDeliveryError(
        400,
        'cross_conversation_invalid_request',
        'kind must be notify or request',
        { field: 'kind' }
      );
    }

    const sourceConversationId = normalizeRequiredText(
      principalInput.sourceConversationId,
      'sourceConversationId'
    );
    const sourceInvocationId = normalizeRequiredText(
      principalInput.sourceInvocationId,
      'sourceInvocationId'
    );
    const sourceAgentId = normalizeRequiredText(principalInput.sourceAgentId, 'sourceAgentId');
    const sourceAgentName = normalizeRequiredText(principalInput.sourceAgentName, 'sourceAgentName');
    const targetConversationId = normalizeRequiredText(input.targetConversationId, 'targetConversationId');
    const targetAgentId = normalizeRequiredText(input.targetAgentId, 'targetAgentId');
    const content = normalizeDeliveryContent(input.content);
    const idempotencyKey = normalizeRequiredText(
      input.idempotencyKey,
      'idempotencyKey',
      MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH
    );
    const deadlineSeconds = normalizeDeadlineSeconds(kind, input.deadlineSeconds);

    if (sourceConversationId === targetConversationId) {
      throw createDeliveryError(
        409,
        'cross_conversation_self_delivery',
        'Source and target conversations must be different'
      );
    }

    const sourceConversation = store.getConversationWithoutMessages(sourceConversationId);
    if (!sourceConversation) {
      throw createDeliveryError(404, 'cross_conversation_source_not_found', 'Source conversation not found');
    }
    const targetConversation = store.getConversationWithoutMessages(targetConversationId);
    if (!targetConversation) {
      throw createDeliveryError(404, 'cross_conversation_target_not_found', 'Target conversation not found');
    }

    if (!sourceConversation.projectScopeId) {
      throw createDeliveryError(
        409,
        'cross_conversation_source_unbound',
        'Source conversation must be explicitly bound to a project'
      );
    }
    if (!targetConversation.projectScopeId) {
      throw createDeliveryError(
        409,
        'cross_conversation_target_unbound',
        'Target conversation must be explicitly bound to a project'
      );
    }
    if (sourceConversation.projectScopeId !== targetConversation.projectScopeId) {
      throw createDeliveryError(
        403,
        'cross_conversation_project_mismatch',
        'Cross-conversation delivery is allowed only inside one explicitly bound project'
      );
    }

    const sourceParticipant = (Array.isArray(sourceConversation.agents) ? sourceConversation.agents : [])
      .some((agent: any) => agent && agent.id === sourceAgentId);
    if (!sourceParticipant) {
      throw createDeliveryError(
        403,
        'cross_conversation_source_not_participant',
        'The invocation Agent is not an active source conversation participant'
      );
    }
    const targetParticipant = (Array.isArray(targetConversation.agents) ? targetConversation.agents : [])
      .some((agent: any) => agent && agent.id === targetAgentId);
    if (!targetParticipant) {
      throw createDeliveryError(
        403,
        'cross_conversation_target_not_participant',
        'The target Agent is not an active target conversation participant'
      );
    }

    const idempotencyScope = `agent:${sourceInvocationId}:conversation_${kind}`;
    const canonical = store.getCrossConversationDeliveryBundleByIdempotency(
      idempotencyScope,
      idempotencyKey
    );
    if (canonical) {
      return canonical;
    }

    const createdAtDate = normalizeNow(now());
    const createdAt = createdAtDate.toISOString();
    const deliveryId = String(createId()).trim();
    const targetMessageId = String(createId()).trim();
    const sourceReceiptMessageId = String(createId()).trim();
    const trace = resolveTrace(principalInput, sourceConversation, targetConversation) || {
      traceId: String(createId()).trim(),
      rootDeliveryId: deliveryId,
      parentDeliveryId: null,
      hopCount: 0,
    };
    const deadlineAt = deadlineSeconds === null
      ? null
      : new Date(createdAtDate.getTime() + deadlineSeconds * 1000).toISOString();
    const turnId = `cross-delivery:${deliveryId}`;
    const sourceMessageId = String(principalInput.sourceMessageId || '').trim() || null;
    const sourceTurnId = String(principalInput.sourceTurnId || '').trim() || null;

    const payload = {
      delivery: {
        id: deliveryId,
        kind,
        idempotencyScope,
        idempotencyKey,
        principalKind: 'agent',
        sourceConversationId,
        sourceMessageId,
        sourceTurnId,
        sourceInvocationId,
        sourceAgentId,
        sourceAgentName,
        sourceProjectScopeId: sourceConversation.projectScopeId,
        targetConversationId,
        targetAgentId,
        targetMessageId: null,
        sourceReceiptMessageId: null,
        targetProjectScopeId: targetConversation.projectScopeId,
        traceId: trace.traceId,
        rootDeliveryId: trace.rootDeliveryId,
        parentDeliveryId: trace.parentDeliveryId,
        replyToDeliveryId: null,
        hopCount: trace.hopCount,
        messageStatus: 'pending',
        dispatchStatus: 'queued',
        responseStatus: kind === 'request' ? 'waiting' : 'not_expected',
        attemptCount: 0,
        deadlineAt,
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
      targetMessage: {
        id: targetMessageId,
        conversationId: targetConversationId,
        turnId,
        role: 'external_agent',
        agentId: sourceAgentId,
        senderName: sourceAgentName,
        content,
        status: 'completed',
        taskId: null,
        runId: null,
        errorMessage: null,
        metadata: {
          crossConversation: {
            deliveryId,
            kind,
            authority: 'external_agent',
            allowHandoffs: false,
            sourceConversationId,
            sourceConversationTitle: sourceConversation.title,
            sourceMessageId,
            sourceAgentId,
            sourceAgentName,
            traceId: trace.traceId,
            deadlineAt,
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
            kind,
            targetConversationId,
            targetConversationTitle: targetConversation.title,
            targetAgentId,
            traceId: trace.traceId,
          },
        },
        createdAt,
      },
      persistedEvent: {
        kind,
        sourceConversationId,
        targetConversationId,
        targetAgentId,
        targetMessageId,
        sourceReceiptMessageId,
        traceId: trace.traceId,
        parentDeliveryId: trace.parentDeliveryId,
        hopCount: trace.hopCount,
        messageStatus: 'persisted',
        dispatchStatus: 'queued',
        responseStatus: kind === 'request' ? 'waiting' : 'not_expected',
      },
      deliveredAt: createdAt,
    };

    try {
      return store.persistCrossConversationDelivery(payload);
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        const canonical = store.getCrossConversationDeliveryByIdempotency(
          idempotencyScope,
          idempotencyKey
        );
        if (canonical) {
          return store.persistCrossConversationDelivery(payload);
        }
      }
      throw error;
    }
  }

  return {
    submitFromAgent,
  };
}
