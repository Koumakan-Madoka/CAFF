const { randomUUID } = require('node:crypto');
const { createHttpError } = require('../../http/http-errors');

const MAX_DELIVERY_CONTENT_LENGTH = 12_000;
const MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_DELIVERY_IDENTIFIER_LENGTH = 200;
const DEFAULT_REQUEST_DEADLINE_SECONDS = 300;
const MAX_REQUEST_DEADLINE_SECONDS = 86_400;
const MAX_TRACE_HOP = 8;

function createDeliveryError(statusCode: number, code: string, message: string, details: any = {}) {
  const issues = Array.isArray(details.issues)
    ? details.issues
    : [{
        code,
        message,
        ...(details.field ? { field: details.field } : {}),
      }];
  return createHttpError(statusCode, message, { code, ...details, issues });
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
  const onDeliveryPersisted =
    typeof options.onDeliveryPersisted === 'function' ? options.onDeliveryPersisted : null;

  if (!store) {
    throw new Error('Cross-conversation delivery service requires a chat store');
  }

  function publishPersisted(result: any) {
    if (!onDeliveryPersisted || !result) {
      return result;
    }

    try {
      const maybePromise = onDeliveryPersisted(result);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        void maybePromise.catch((error: any) => {
          console.error(
            `[cross-conversation-delivery] Post-commit publish failed: ${
              error && error.stack ? error.stack : error
            }`
          );
        });
      }
    } catch (error) {
      console.error(
        `[cross-conversation-delivery] Post-commit publish failed: ${
          error && (error as any).stack ? (error as any).stack : error
        }`
      );
    }

    return result;
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
      return publishPersisted(canonical);
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
      return publishPersisted(store.persistCrossConversationDelivery(payload));
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        const canonical = store.getCrossConversationDeliveryByIdempotency(
          idempotencyScope,
          idempotencyKey
        );
        if (canonical) {
          return publishPersisted(store.persistCrossConversationDelivery(payload));
        }
      }
      throw error;
    }
  }

  /**
   * System-principal delivery (DAG scheduler, D25 resume): persists a
   * one-way notify delivery + target message without requiring an active
   * agent invocation. principal_kind is stored as 'operator' (the schema's
   * non-agent principal) with sourceAgentName defaulting to the scheduler
   * label. Fresh trace (no incoming delivery parent).
   */
  function submitFromSystem(input: any = {}) {
    const sourceConversationId = normalizeRequiredText(input.sourceConversationId, 'sourceConversationId');
    const targetConversationId = normalizeRequiredText(input.targetConversationId, 'targetConversationId');
    const targetAgentId = normalizeRequiredText(input.targetAgentId, 'targetAgentId');
    const content = normalizeDeliveryContent(input.content);
    const idempotencyKey = normalizeRequiredText(
      input.idempotencyKey,
      'idempotencyKey',
      MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH
    );
    const sourceAgentName = String(input.sourceAgentName || '').trim() || 'DAG Scheduler';
    const messageMetadata = input.messageMetadata && typeof input.messageMetadata === 'object' && !Array.isArray(input.messageMetadata)
      ? input.messageMetadata
      : {};

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
    if (
      sourceConversation.projectScopeId
      && targetConversation.projectScopeId
      && sourceConversation.projectScopeId !== targetConversation.projectScopeId
    ) {
      throw createDeliveryError(
        403,
        'cross_conversation_project_mismatch',
        'Cross-conversation delivery is allowed only inside one explicitly bound project'
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

    const idempotencyScope = `system:${sourceConversationId}:conversation_notify`;
    const canonical = store.getCrossConversationDeliveryBundleByIdempotency(
      idempotencyScope,
      idempotencyKey
    );
    if (canonical) {
      return publishPersisted(canonical);
    }

    const createdAt = normalizeNow(now()).toISOString();
    const deliveryId = String(createId()).trim();
    const targetMessageId = String(createId()).trim();
    const sourceReceiptMessageId = String(createId()).trim();
    const traceId = String(createId()).trim();
    const turnId = `cross-delivery:${deliveryId}`;

    const payload = {
      delivery: {
        id: deliveryId,
        kind: 'notify',
        idempotencyScope,
        idempotencyKey,
        principalKind: 'operator',
        sourceConversationId,
        sourceMessageId: null,
        sourceTurnId: null,
        sourceInvocationId: null,
        sourceAgentId: null,
        sourceAgentName,
        sourceProjectScopeId: sourceConversation.projectScopeId || null,
        targetConversationId,
        targetAgentId,
        targetMessageId: null,
        sourceReceiptMessageId: null,
        targetProjectScopeId: targetConversation.projectScopeId || null,
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
      targetMessage: {
        id: targetMessageId,
        conversationId: targetConversationId,
        turnId,
        role: 'user',
        agentId: null,
        senderName: sourceAgentName,
        content,
        status: 'completed',
        taskId: null,
        runId: null,
        errorMessage: null,
        metadata: {
          ...messageMetadata,
          crossConversation: {
            deliveryId,
            kind: 'notify',
            authority: 'system',
            allowHandoffs: false,
            sourceConversationId,
            sourceConversationTitle: sourceConversation.title,
            sourceMessageId: null,
            sourceAgentId: null,
            sourceAgentName,
            traceId,
            deadlineAt: null,
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
            kind: 'notify',
            targetConversationId,
            targetConversationTitle: targetConversation.title,
            targetAgentId,
            traceId,
          },
        },
        createdAt,
      },
      persistedEvent: {
        kind: 'notify',
        sourceConversationId,
        targetConversationId,
        targetAgentId,
        targetMessageId,
        sourceReceiptMessageId,
        traceId,
        parentDeliveryId: null,
        hopCount: 0,
        messageStatus: 'persisted',
        dispatchStatus: 'queued',
        responseStatus: 'not_expected',
      },
      deliveredAt: createdAt,
    };

    try {
      return publishPersisted(store.persistCrossConversationDelivery(payload));
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        const existing = store.getCrossConversationDeliveryBundleByIdempotency(
          idempotencyScope,
          idempotencyKey
        );
        if (existing) {
          return publishPersisted(existing);
        }
      }
      throw error;
    }
  }

  return {
    submitFromAgent,
    submitFromSystem,
  };
}

function clipDeliveryError(error: any, maxLength = 500) {
  const message = String(error && error.message ? error.message : error || 'Unknown delivery error').trim();
  return message.length <= maxLength ? message : `${message.slice(0, maxLength - 3)}...`;
}

export function createCrossConversationDeliveryWorker(options: any = {}) {
  const store = options.store;
  const dispatchTarget = options.dispatchTarget;
  const stopTarget = typeof options.stopTarget === 'function' ? options.stopTarget : async () => false;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const workerId = String(options.workerId || `cross-delivery-worker-${randomUUID()}`).trim();
  const leaseMs = Number.isInteger(options.leaseMs) && options.leaseMs > 0 ? options.leaseMs : 30_000;
  const retryDelayMs = Number.isInteger(options.retryDelayMs) && options.retryDelayMs >= 0
    ? options.retryDelayMs
    : 1_000;
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : 3;
  const onDeliveryChanged =
    typeof options.onDeliveryChanged === 'function' ? options.onDeliveryChanged : null;

  if (!store) {
    throw new Error('Cross-conversation delivery worker requires a chat store');
  }
  if (typeof dispatchTarget !== 'function') {
    throw new Error('Cross-conversation delivery worker requires dispatchTarget');
  }

  function currentDate() {
    return normalizeNow(now());
  }

  function appendEvent(delivery: any, eventType: string, event: any, createdAt: string) {
    return store.appendCrossConversationDeliveryEvent(delivery.id, {
      eventType,
      attemptNumber: delivery.attemptCount,
      actorKind: 'worker',
      actorId: workerId,
      event,
      createdAt,
    });
  }

  function publishDeliveryChanged(delivery: any, reason: string, extra: any = {}) {
    if (!onDeliveryChanged || !delivery) {
      return;
    }

    try {
      const maybePromise = onDeliveryChanged({
        delivery,
        reason,
        ...extra,
      });
      if (maybePromise && typeof maybePromise.catch === 'function') {
        void maybePromise.catch((error: any) => {
          console.error(
            `[cross-conversation-delivery] State publish failed for ${delivery.id}: ${
              error && error.stack ? error.stack : error
            }`
          );
        });
      }
    } catch (error) {
      console.error(
        `[cross-conversation-delivery] State publish failed for ${delivery.id}: ${
          error && (error as any).stack ? (error as any).stack : error
        }`
      );
    }
  }

  function persistResponseIfPresent(delivery: any, result: any) {
    if (!delivery || delivery.kind !== 'request' || !result || !result.replyMessage) {
      return { response: null, responsePending: false };
    }

    try {
      const response = store.persistCrossConversationResponse({
        requestDeliveryId: delivery.id,
        assistantMessage: result.replyMessage,
        createdAt: currentDate().toISOString(),
      });
      publishDeliveryChanged(response.requestDelivery, 'response_persisted', { response });
      return { response, responsePending: false };
    } catch (error) {
      const failedAt = currentDate().toISOString();
      appendEvent(delivery, 'response_projection_failed', {
        errorMessage: clipDeliveryError(error),
      }, failedAt);
      publishDeliveryChanged(delivery, 'response_projection_pending');
      return { response: null, responsePending: true };
    }
  }

  function claimParams(claimDate: any) {
    return {
      owner: workerId,
      now: claimDate.toISOString(),
      claimExpiresAt: new Date(claimDate.getTime() + leaseMs).toISOString(),
    };
  }

  async function processNext() {
    const claimDate = currentDate();
    const claimed = store.claimNextCrossConversationDelivery(claimParams(claimDate));

    if (!claimed) {
      return null;
    }

    return processClaimedDelivery(claimed, claimDate);
  }

  // DAG direct dispatch (D21/D24): claim one specific queued delivery by id
  // and run it through the exact same lifecycle as the serial drain. The
  // claim is atomic against claimNext (same guards, SQLite single writer), so
  // a racing drain simply observes the delivery as already claimed.
  async function processDeliveryById(deliveryIdInput: any) {
    const deliveryId = normalizeRequiredText(deliveryIdInput, 'deliveryId');
    const claimDate = currentDate();
    const claimed = typeof store.claimCrossConversationDeliveryById === 'function'
      ? store.claimCrossConversationDeliveryById(deliveryId, claimParams(claimDate))
      : null;

    if (!claimed) {
      return null;
    }

    return processClaimedDelivery(claimed, claimDate);
  }

  async function processClaimedDelivery(claimed: any, claimDate: any) {
    appendEvent(claimed, 'claimed', {
      claimOwner: workerId,
      claimExpiresAt: claimed.claimExpiresAt,
    }, claimDate.toISOString());

    const targetMessage = store.getMessage(claimed.targetMessageId);
    if (!targetMessage) {
      const failedAt = currentDate().toISOString();
      const failed = store.failCrossConversationDeliveryBeforeStart(claimed.id, {
        claimOwner: workerId,
        errorCode: 'target_message_missing',
        errorMessage: 'Persisted target message is missing',
        failedAt,
      });
      if (failed) {
        appendEvent(failed, 'dispatch_failed', {
          errorCode: 'target_message_missing',
          started: false,
        }, failedAt);
        publishDeliveryChanged(failed, 'dispatch_failed');
      }
      return { status: 'failed', delivery: failed || claimed };
    }

    let invocationStarted = false;

    try {
      const result = await dispatchTarget({
        delivery: claimed,
        targetMessage,
        onInvocationStarting(input: any = {}) {
          if (invocationStarted) {
            return store.getCrossConversationDelivery(claimed.id);
          }

          const invocationId = normalizeRequiredText(input.invocationId, 'targetInvocationId');
          const startedAt = currentDate().toISOString();
          const started = store.markCrossConversationDispatchStarted(claimed.id, {
            claimOwner: workerId,
            targetInvocationId: invocationId,
            startedAt,
            updatedAt: startedAt,
          });

          if (!started) {
            throw new Error('Cross-conversation dispatch start transition was rejected');
          }

          invocationStarted = true;
          appendEvent(started, 'dispatch_started', {
            targetInvocationId: invocationId,
          }, startedAt);
          publishDeliveryChanged(started, 'dispatch_started');
          return started;
        },
      });

      if (!invocationStarted) {
        throw new Error('Target dispatcher returned without marking invocation start');
      }

      const stateAfterDispatch = store.getCrossConversationDelivery(claimed.id);
      if (stateAfterDispatch && stateAfterDispatch.dispatchStatus === 'cancel_requested') {
        const cancelledAt = currentDate().toISOString();
        const cancelled = store.markRunningCrossConversationDeliveryCancelled(claimed.id, {
          claimOwner: workerId,
          reason: stateAfterDispatch.lastErrorMessage || 'Cancelled while running',
          cancelledAt,
        });
        if (cancelled) {
          appendEvent(cancelled, 'cancelled', { phase: 'running' }, cancelledAt);
          publishDeliveryChanged(cancelled, 'cancelled');
        }
        const responseOutcome = persistResponseIfPresent(cancelled || stateAfterDispatch, result);
        return {
          status: 'cancelled',
          delivery: responseOutcome.response
            ? responseOutcome.response.requestDelivery
            : cancelled || stateAfterDispatch,
          response: responseOutcome.response,
          responsePending: responseOutcome.responsePending,
        };
      }

      const completedAt = currentDate().toISOString();
      const completed = store.markCrossConversationDispatchCompleted(claimed.id, {
        claimOwner: workerId,
        completedAt,
        terminalAt: completedAt,
        updatedAt: completedAt,
      });

      if (!completed) {
        throw new Error('Cross-conversation dispatch completion transition was rejected');
      }

      appendEvent(completed, 'dispatch_completed', {
        targetInvocationId: completed.targetInvocationId,
      }, completedAt);
      publishDeliveryChanged(completed, 'dispatch_completed');

      const responseOutcome = persistResponseIfPresent(completed, result);

      return {
        status: responseOutcome.responsePending ? 'response_pending' : 'completed',
        delivery: responseOutcome.response ? responseOutcome.response.requestDelivery : completed,
        response: responseOutcome.response,
        responsePending: responseOutcome.responsePending,
      };
    } catch (error) {
      const failedAt = currentDate().toISOString();
      const current = store.getCrossConversationDelivery(claimed.id);
      const errorMessage = clipDeliveryError(error);

      if (current && current.dispatchStatus === 'cancelled') {
        return { status: 'cancelled', delivery: current };
      }

      if (current && current.dispatchStatus === 'cancel_requested') {
        const cancelled = store.markRunningCrossConversationDeliveryCancelled(claimed.id, {
          claimOwner: workerId,
          reason: current.lastErrorMessage || errorMessage,
          cancelledAt: failedAt,
        });
        if (cancelled) {
          appendEvent(cancelled, 'cancelled', { phase: 'running', stopError: errorMessage }, failedAt);
          publishDeliveryChanged(cancelled, 'cancelled');
        }
        return { status: 'cancelled', delivery: cancelled || current };
      }

      if (invocationStarted || (current && current.startedAt)) {
        const failed = store.failCrossConversationDeliveryUnknownOutcome(claimed.id, {
          claimOwner: workerId,
          errorCode: 'dispatch_unknown_outcome',
          errorMessage,
          failedAt,
        });
        if (failed) {
          appendEvent(failed, 'dispatch_failed_unknown_outcome', {
            errorCode: 'dispatch_unknown_outcome',
          }, failedAt);
          publishDeliveryChanged(failed, 'dispatch_failed_unknown_outcome');
        }
        return { status: 'failed_unknown_outcome', delivery: failed || current };
      }

      if (claimed.attemptCount < maxAttempts) {
        const nextAttemptAt = new Date(new Date(failedAt).getTime() + retryDelayMs).toISOString();
        const retry = store.releaseCrossConversationDeliveryForRetry(claimed.id, {
          claimOwner: workerId,
          nextAttemptAt,
          errorCode: 'dispatch_pre_start_failed',
          errorMessage,
          updatedAt: failedAt,
        });
        if (retry) {
          appendEvent(retry, 'retry_scheduled', {
            errorCode: 'dispatch_pre_start_failed',
            nextAttemptAt,
          }, failedAt);
          publishDeliveryChanged(retry, 'retry_scheduled');
        }
        return { status: 'retry_scheduled', delivery: retry || current };
      }

      const failed = store.failCrossConversationDeliveryBeforeStart(claimed.id, {
        claimOwner: workerId,
        errorCode: 'dispatch_pre_start_exhausted',
        errorMessage,
        failedAt,
      });
      if (failed) {
        appendEvent(failed, 'dispatch_failed', {
          errorCode: 'dispatch_pre_start_exhausted',
          started: false,
        }, failedAt);
        publishDeliveryChanged(failed, 'dispatch_failed');
      }
      return { status: 'failed', delivery: failed || current };
    }
  }

  function recoverExpiredClaims() {
    const recoveredAt = currentDate().toISOString();
    const requeuedDeliveryIds = [] as string[];
    const failedUnknownDeliveryIds = [] as string[];

    for (const delivery of store.listExpiredCrossConversationDeliveryClaims(recoveredAt)) {
      if (delivery.startedAt || delivery.targetInvocationId) {
        if (delivery.dispatchStatus === 'cancel_requested') {
          const cancelled = store.markRunningCrossConversationDeliveryCancelled(delivery.id, {
            claimOwner: delivery.claimOwner,
            reason: delivery.lastErrorMessage || 'Recovered after cancellation request',
            cancelledAt: recoveredAt,
          });
          if (cancelled) {
            appendEvent(cancelled, 'cancelled', { recovered: true }, recoveredAt);
            publishDeliveryChanged(cancelled, 'cancelled');
          }
          continue;
        }

        const failed = store.failCrossConversationDeliveryUnknownOutcome(delivery.id, {
          claimOwner: delivery.claimOwner,
          errorCode: 'recovered_started_unknown_outcome',
          errorMessage: 'Worker lease expired after target invocation started; automatic replay is forbidden',
          failedAt: recoveredAt,
        });
        if (failed) {
          failedUnknownDeliveryIds.push(failed.id);
          appendEvent(failed, 'recovered_unknown_outcome', {
            previousClaimOwner: delivery.claimOwner,
          }, recoveredAt);
          publishDeliveryChanged(failed, 'recovered_unknown_outcome');
        }
        continue;
      }

      if (delivery.attemptCount < maxAttempts) {
        const requeued = store.releaseCrossConversationDeliveryForRetry(delivery.id, {
          claimOwner: delivery.claimOwner,
          nextAttemptAt: recoveredAt,
          errorCode: 'recovered_unstarted_claim',
          errorMessage: 'Worker lease expired before target invocation started',
          updatedAt: recoveredAt,
        });
        if (requeued) {
          requeuedDeliveryIds.push(requeued.id);
          appendEvent(requeued, 'recovered_requeued', {
            previousClaimOwner: delivery.claimOwner,
          }, recoveredAt);
          publishDeliveryChanged(requeued, 'recovered_requeued');
        }
        continue;
      }

      const failed = store.failCrossConversationDeliveryBeforeStart(delivery.id, {
        claimOwner: delivery.claimOwner,
        errorCode: 'recovered_pre_start_exhausted',
        errorMessage: 'Worker lease expired and the pre-start retry budget is exhausted',
        failedAt: recoveredAt,
      });
      if (failed) {
        appendEvent(failed, 'dispatch_failed', {
          errorCode: 'recovered_pre_start_exhausted',
        }, recoveredAt);
        publishDeliveryChanged(failed, 'dispatch_failed');
      }
    }

    return { requeuedDeliveryIds, failedUnknownDeliveryIds };
  }

  function recoverPendingResponses() {
    const recoveredDeliveryIds = [] as string[];

    for (const delivery of store.listCrossConversationRequestsPendingResponse(100)) {
      const replyMessage = store.findCrossConversationReplyMessage(delivery);
      if (!replyMessage) {
        continue;
      }

      try {
        const response = store.persistCrossConversationResponse({
          requestDeliveryId: delivery.id,
          assistantMessage: replyMessage,
          createdAt: currentDate().toISOString(),
        });
        recoveredDeliveryIds.push(delivery.id);
        publishDeliveryChanged(response.requestDelivery, 'response_persisted', {
          response,
          recovered: true,
        });
      } catch (error) {
        appendEvent(delivery, 'response_projection_recovery_failed', {
          errorMessage: clipDeliveryError(error),
        }, currentDate().toISOString());
      }
    }

    return recoveredDeliveryIds;
  }

  function expireRequestDeadlines() {
    const timedOutAt = currentDate().toISOString();
    const expiredIds = [] as string[];

    for (const delivery of store.listExpiredCrossConversationRequestDeadlines(timedOutAt)) {
      const timedOut = store.timeoutCrossConversationRequest(delivery.id, { timedOutAt });
      if (!timedOut) {
        continue;
      }
      expiredIds.push(timedOut.id);
      appendEvent(timedOut, 'request_timed_out', {
        deadlineAt: timedOut.deadlineAt,
      }, timedOutAt);
      publishDeliveryChanged(timedOut, 'request_timed_out');
    }

    return expiredIds;
  }

  async function cancel(deliveryId: any, reason: any = 'Cancelled by operator') {
    const normalizedDeliveryId = normalizeRequiredText(deliveryId, 'deliveryId');
    const cancelReason = String(reason || 'Cancelled by operator').trim() || 'Cancelled by operator';
    const delivery = store.getCrossConversationDelivery(normalizedDeliveryId);

    if (!delivery) {
      throw createDeliveryError(404, 'cross_conversation_delivery_not_found', 'Delivery not found');
    }

    const requestedAt = currentDate().toISOString();
    if (delivery.dispatchStatus === 'queued') {
      const cancelled = store.cancelQueuedCrossConversationDelivery(delivery.id, {
        reason: cancelReason,
        cancelledAt: requestedAt,
      });
      if (cancelled) {
        appendEvent(cancelled, 'cancelled', { phase: 'queued', reason: cancelReason }, requestedAt);
        publishDeliveryChanged(cancelled, 'cancelled');
      }
      if (delivery.claimOwner) {
        try {
          await stopTarget(cancelled || delivery);
        } catch (error) {
          appendEvent(cancelled || delivery, 'cancel_stop_failed', {
            errorMessage: clipDeliveryError(error),
          }, currentDate().toISOString());
        }
      }
      return cancelled || delivery;
    }

    if (delivery.dispatchStatus === 'running') {
      const cancelRequested = store.requestRunningCrossConversationDeliveryCancel(delivery.id, {
        reason: cancelReason,
        requestedAt,
      });
      if (!cancelRequested) {
        return store.getCrossConversationDelivery(delivery.id);
      }
      appendEvent(cancelRequested, 'cancel_requested', {
        phase: 'running',
        reason: cancelReason,
      }, requestedAt);
      publishDeliveryChanged(cancelRequested, 'cancel_requested');
      try {
        await stopTarget(cancelRequested);
      } catch (error) {
        appendEvent(cancelRequested, 'cancel_stop_failed', {
          errorMessage: clipDeliveryError(error),
        }, currentDate().toISOString());
      }
      return store.getCrossConversationDelivery(delivery.id);
    }

    return delivery;
  }

  async function retry(deliveryId: any, reason: any = 'Retried by operator') {
    const normalizedDeliveryId = normalizeRequiredText(deliveryId, 'deliveryId');
    const retryReason = String(reason || 'Retried by operator').trim() || 'Retried by operator';
    const delivery = store.getCrossConversationDelivery(normalizedDeliveryId);

    if (!delivery) {
      throw createDeliveryError(404, 'cross_conversation_delivery_not_found', 'Delivery not found');
    }
    if (delivery.startedAt || delivery.targetInvocationId) {
      throw createDeliveryError(
        409,
        'cross_conversation_retry_unsafe',
        'This delivery may already have executed; retry requires a new explicitly linked delivery'
      );
    }
    if (delivery.dispatchStatus !== 'failed') {
      throw createDeliveryError(
        409,
        'cross_conversation_retry_not_allowed',
        'Only a failed delivery that never started can be retried in place'
      );
    }

    const retryDate = currentDate();
    let deadlineAt = null;
    if (delivery.kind === 'request') {
      const createdAtMs = new Date(delivery.createdAt).getTime();
      const originalDeadlineMs = new Date(delivery.deadlineAt).getTime();
      const originalDurationMs = Number.isFinite(createdAtMs) && Number.isFinite(originalDeadlineMs)
        ? originalDeadlineMs - createdAtMs
        : DEFAULT_REQUEST_DEADLINE_SECONDS * 1000;
      const boundedDurationMs = Math.min(
        MAX_REQUEST_DEADLINE_SECONDS * 1000,
        Math.max(1_000, originalDurationMs > 0 ? originalDurationMs : DEFAULT_REQUEST_DEADLINE_SECONDS * 1000)
      );
      deadlineAt = new Date(retryDate.getTime() + boundedDurationMs).toISOString();
    }

    const retried = store.retryCrossConversationDeliveryBeforeStart(delivery.id, {
      deadlineAt,
      retryAt: retryDate.toISOString(),
    });
    if (!retried) {
      throw createDeliveryError(
        409,
        'cross_conversation_retry_conflict',
        'Delivery state changed before retry; refresh and try again'
      );
    }

    store.appendCrossConversationDeliveryEvent(retried.id, {
      eventType: 'retry_requested',
      attemptNumber: retried.attemptCount,
      actorKind: 'operator',
      actorId: null,
      event: { reasonProvided: Boolean(retryReason) },
      createdAt: retryDate.toISOString(),
    });
    publishDeliveryChanged(retried, 'retry_requested');
    return retried;
  }

  return {
    cancel,
    expireRequestDeadlines,
    processDeliveryById,
    processNext,
    recoverExpiredClaims,
    recoverPendingResponses,
    retry,
  };
}
