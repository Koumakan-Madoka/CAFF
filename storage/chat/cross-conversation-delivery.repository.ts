export class CrossConversationDeliveryRepository {
  getStatement: any;
  getByIdempotencyStatement: any;
  getTraceEdgeStatement: any;
  insertStatement: any;
  markMessagesPersistedStatement: any;
  claimNextStatement: any;
  markDispatchStartedStatement: any;
  markDispatchCompletedStatement: any;
  insertEventStatement: any;
  getEventStatement: any;
  listEventsStatement: any;

  constructor(db: any) {
    this.getStatement = db.prepare(`
      SELECT *
      FROM chat_cross_conversation_deliveries
      WHERE id = ?
      LIMIT 1
    `);
    this.getByIdempotencyStatement = db.prepare(`
      SELECT *
      FROM chat_cross_conversation_deliveries
      WHERE idempotency_scope = ? AND idempotency_key = ?
      LIMIT 1
    `);
    this.getTraceEdgeStatement = db.prepare(`
      SELECT *
      FROM chat_cross_conversation_deliveries
      WHERE trace_id = ?
        AND source_conversation_id = ?
        AND target_conversation_id = ?
      LIMIT 1
    `);
    this.insertStatement = db.prepare(`
      INSERT INTO chat_cross_conversation_deliveries (
        id,
        kind,
        idempotency_scope,
        idempotency_key,
        principal_kind,
        source_conversation_id,
        source_message_id,
        source_turn_id,
        source_invocation_id,
        source_agent_id,
        source_agent_name,
        source_project_scope_id,
        target_conversation_id,
        target_agent_id,
        target_message_id,
        source_receipt_message_id,
        target_project_scope_id,
        trace_id,
        root_delivery_id,
        parent_delivery_id,
        reply_to_delivery_id,
        hop_count,
        message_status,
        dispatch_status,
        response_status,
        attempt_count,
        deadline_at,
        cancel_requested_at,
        last_error_code,
        last_error_message,
        claim_owner,
        claim_expires_at,
        next_attempt_at,
        target_invocation_id,
        delivered_at,
        started_at,
        completed_at,
        responded_at,
        terminal_at,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @kind,
        @idempotencyScope,
        @idempotencyKey,
        @principalKind,
        @sourceConversationId,
        @sourceMessageId,
        @sourceTurnId,
        @sourceInvocationId,
        @sourceAgentId,
        @sourceAgentName,
        @sourceProjectScopeId,
        @targetConversationId,
        @targetAgentId,
        @targetMessageId,
        @sourceReceiptMessageId,
        @targetProjectScopeId,
        @traceId,
        @rootDeliveryId,
        @parentDeliveryId,
        @replyToDeliveryId,
        @hopCount,
        @messageStatus,
        @dispatchStatus,
        @responseStatus,
        @attemptCount,
        @deadlineAt,
        @cancelRequestedAt,
        @lastErrorCode,
        @lastErrorMessage,
        @claimOwner,
        @claimExpiresAt,
        @nextAttemptAt,
        @targetInvocationId,
        @deliveredAt,
        @startedAt,
        @completedAt,
        @respondedAt,
        @terminalAt,
        @createdAt,
        @updatedAt
      )
    `);
    this.markMessagesPersistedStatement = db.prepare(`
      UPDATE chat_cross_conversation_deliveries
      SET
        target_message_id = @targetMessageId,
        source_receipt_message_id = @sourceReceiptMessageId,
        message_status = 'persisted',
        delivered_at = @deliveredAt,
        updated_at = @updatedAt
      WHERE id = @deliveryId
        AND message_status = 'pending'
        AND target_message_id IS NULL
        AND source_receipt_message_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM chat_messages target_message
          WHERE target_message.id = @targetMessageId
            AND target_message.conversation_id = target_conversation_id
        )
        AND EXISTS (
          SELECT 1
          FROM chat_messages source_receipt
          WHERE source_receipt.id = @sourceReceiptMessageId
            AND source_receipt.conversation_id = source_conversation_id
        )
      RETURNING *
    `);
    this.claimNextStatement = db.prepare(`
      UPDATE chat_cross_conversation_deliveries
      SET
        claim_owner = @owner,
        claim_expires_at = @claimExpiresAt,
        attempt_count = attempt_count + 1,
        updated_at = @now
      WHERE id = (
        SELECT id
        FROM chat_cross_conversation_deliveries
        WHERE message_status = 'persisted'
          AND dispatch_status = 'queued'
          AND started_at IS NULL
          AND target_invocation_id IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
          AND (claim_owner IS NULL OR claim_expires_at <= @now)
        ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, id ASC
        LIMIT 1
      )
        AND dispatch_status = 'queued'
        AND started_at IS NULL
        AND target_invocation_id IS NULL
        AND (claim_owner IS NULL OR claim_expires_at <= @now)
      RETURNING *
    `);
    this.markDispatchStartedStatement = db.prepare(`
      UPDATE chat_cross_conversation_deliveries
      SET
        dispatch_status = 'running',
        target_invocation_id = @targetInvocationId,
        started_at = @startedAt,
        updated_at = @updatedAt
      WHERE id = @deliveryId
        AND dispatch_status = 'queued'
        AND claim_owner = @claimOwner
        AND target_invocation_id IS NULL
        AND started_at IS NULL
      RETURNING *
    `);
    this.markDispatchCompletedStatement = db.prepare(`
      UPDATE chat_cross_conversation_deliveries
      SET
        dispatch_status = 'completed',
        claim_owner = NULL,
        claim_expires_at = NULL,
        completed_at = @completedAt,
        terminal_at = CASE
          WHEN response_status = 'not_expected' THEN COALESCE(@terminalAt, @completedAt)
          ELSE terminal_at
        END,
        updated_at = @updatedAt
      WHERE id = @deliveryId
        AND dispatch_status = 'running'
        AND claim_owner = @claimOwner
      RETURNING *
    `);
    this.insertEventStatement = db.prepare(`
      INSERT INTO chat_cross_conversation_delivery_events (
        delivery_id,
        event_type,
        attempt_number,
        actor_kind,
        actor_id,
        event_json,
        created_at
      ) VALUES (
        @deliveryId,
        @eventType,
        @attemptNumber,
        @actorKind,
        @actorId,
        @eventJson,
        @createdAt
      )
    `);
    this.getEventStatement = db.prepare(`
      SELECT *
      FROM chat_cross_conversation_delivery_events
      WHERE id = ?
      LIMIT 1
    `);
    this.listEventsStatement = db.prepare(`
      SELECT *
      FROM chat_cross_conversation_delivery_events
      WHERE delivery_id = ?
      ORDER BY created_at ASC, id ASC
    `);
  }

  get(deliveryId: string) {
    return this.getStatement.get(deliveryId) || null;
  }

  getByIdempotency(idempotencyScope: string, idempotencyKey: string) {
    return this.getByIdempotencyStatement.get(idempotencyScope, idempotencyKey) || null;
  }

  getTraceEdge(traceId: string, sourceConversationId: string, targetConversationId: string) {
    return this.getTraceEdgeStatement.get(traceId, sourceConversationId, targetConversationId) || null;
  }

  create(payload: any) {
    this.insertStatement.run({
      id: payload.id,
      kind: payload.kind,
      idempotencyScope: payload.idempotencyScope,
      idempotencyKey: payload.idempotencyKey,
      principalKind: payload.principalKind,
      sourceConversationId: payload.sourceConversationId,
      sourceMessageId: payload.sourceMessageId || null,
      sourceTurnId: payload.sourceTurnId || null,
      sourceInvocationId: payload.sourceInvocationId || null,
      sourceAgentId: payload.sourceAgentId || null,
      sourceAgentName: payload.sourceAgentName,
      sourceProjectScopeId: payload.sourceProjectScopeId,
      targetConversationId: payload.targetConversationId,
      targetAgentId: payload.targetAgentId,
      targetMessageId: payload.targetMessageId || null,
      sourceReceiptMessageId: payload.sourceReceiptMessageId || null,
      targetProjectScopeId: payload.targetProjectScopeId,
      traceId: payload.traceId,
      rootDeliveryId: payload.rootDeliveryId,
      parentDeliveryId: payload.parentDeliveryId || null,
      replyToDeliveryId: payload.replyToDeliveryId || null,
      hopCount: Number.isInteger(payload.hopCount) ? payload.hopCount : 0,
      messageStatus: payload.messageStatus,
      dispatchStatus: payload.dispatchStatus,
      responseStatus: payload.responseStatus,
      attemptCount: Number.isInteger(payload.attemptCount) ? payload.attemptCount : 0,
      deadlineAt: payload.deadlineAt || null,
      cancelRequestedAt: payload.cancelRequestedAt || null,
      lastErrorCode: payload.lastErrorCode || null,
      lastErrorMessage: payload.lastErrorMessage || null,
      claimOwner: payload.claimOwner || null,
      claimExpiresAt: payload.claimExpiresAt || null,
      nextAttemptAt: payload.nextAttemptAt || null,
      targetInvocationId: payload.targetInvocationId || null,
      deliveredAt: payload.deliveredAt || null,
      startedAt: payload.startedAt || null,
      completedAt: payload.completedAt || null,
      respondedAt: payload.respondedAt || null,
      terminalAt: payload.terminalAt || null,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    });

    return this.get(payload.id);
  }

  markMessagesPersisted(deliveryId: string, payload: any) {
    return this.markMessagesPersistedStatement.get({
      deliveryId,
      targetMessageId: payload.targetMessageId,
      sourceReceiptMessageId: payload.sourceReceiptMessageId,
      deliveredAt: payload.deliveredAt,
      updatedAt: payload.updatedAt,
    }) || null;
  }

  claimNext(payload: any) {
    return this.claimNextStatement.get({
      owner: payload.owner,
      now: payload.now,
      claimExpiresAt: payload.claimExpiresAt,
    }) || null;
  }

  markDispatchStarted(deliveryId: string, payload: any) {
    return this.markDispatchStartedStatement.get({
      deliveryId,
      claimOwner: payload.claimOwner,
      targetInvocationId: payload.targetInvocationId,
      startedAt: payload.startedAt,
      updatedAt: payload.updatedAt,
    }) || null;
  }

  markDispatchCompleted(deliveryId: string, payload: any) {
    return this.markDispatchCompletedStatement.get({
      deliveryId,
      claimOwner: payload.claimOwner,
      completedAt: payload.completedAt,
      terminalAt: payload.terminalAt || null,
      updatedAt: payload.updatedAt,
    }) || null;
  }

  appendEvent(payload: any) {
    const result = this.insertEventStatement.run({
      deliveryId: payload.deliveryId,
      eventType: payload.eventType,
      attemptNumber: Number.isInteger(payload.attemptNumber) ? payload.attemptNumber : 0,
      actorKind: payload.actorKind || null,
      actorId: payload.actorId || null,
      eventJson: payload.eventJson || null,
      createdAt: payload.createdAt,
    });

    return this.getEventStatement.get(Number(result.lastInsertRowid));
  }

  listEvents(deliveryId: string) {
    return this.listEventsStatement.all(deliveryId);
  }
}

export function createCrossConversationDeliveryRepository(db: any) {
  return new CrossConversationDeliveryRepository(db);
}
