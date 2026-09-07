function normalizeDelegationRow(row: any) {
  if (!row) {
    return null;
  }

  const parse = (value: any, fallback: any) => {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  };

  return {
    id: row.id,
    parentId: row.parent_id || null,
    idempotencyScope: row.idempotency_scope,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    aggregation: row.aggregation,
    requesterConversationId: row.requester_conversation_id,
    requesterAgentId: row.requester_agent_id,
    requesterAgentName: row.requester_agent_name,
    requesterInvocationId: row.requester_invocation_id,
    requesterRunId: row.requester_run_id || null,
    requesterTurnId: row.requester_turn_id || null,
    sourceTraceId: row.source_trace_id || null,
    recipientConversationId: row.recipient_conversation_id,
    recipientAgentId: row.recipient_agent_id,
    recipientAgentName: row.recipient_agent_name,
    request: parse(row.request_json, {}),
    reference: row.reference || null,
    status: row.status,
    deadlineAt: row.deadline_at || null,
    cancelRequestedAt: row.cancel_requested_at || null,
    result: parse(row.result_json, null),
    error: parse(row.error_json, null),
    children: parse(row.children_json, []),
    lateResultCount: Number(row.late_result_count || 0),
    waitRequestedAt: row.wait_requested_at || null,
    continuationEnqueuedAt: row.continuation_enqueued_at || null,
    terminalAt: row.terminal_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentDelegationRepository {
  db: any;
  statements: Record<string, any>;

  constructor(db: any) {
    this.db = db;
    this.statements = {
      get: db.prepare('SELECT * FROM chat_agent_delegations WHERE id = ? LIMIT 1'),
      getByIdempotency: db.prepare(`
        SELECT * FROM chat_agent_delegations
        WHERE idempotency_scope = ? AND idempotency_key = ?
        LIMIT 1
      `),
      listByRequester: db.prepare(`
        SELECT * FROM chat_agent_delegations
        WHERE requester_invocation_id = ?
        ORDER BY created_at ASC, id ASC
      `),
      listByParent: db.prepare(`
        SELECT * FROM chat_agent_delegations
        WHERE parent_id = ?
        ORDER BY created_at ASC, id ASC
      `),
      listPendingForRequester: db.prepare(`
        SELECT * FROM chat_agent_delegations
        WHERE requester_invocation_id = ?
          AND status IN ('queued', 'running', 'awaiting')
        ORDER BY created_at ASC, id ASC
      `),
      listExpired: db.prepare(`
        SELECT * FROM chat_agent_delegations
        WHERE status IN ('queued', 'running', 'awaiting')
          AND deadline_at IS NOT NULL
          AND deadline_at <= ?
        ORDER BY deadline_at ASC, created_at ASC, id ASC
        LIMIT ?
      `),
      insert: db.prepare(`
        INSERT INTO chat_agent_delegations (
          id, parent_id, idempotency_scope, idempotency_key, kind, aggregation,
          requester_conversation_id, requester_agent_id, requester_agent_name,
          requester_invocation_id, requester_run_id, requester_turn_id, source_trace_id,
          recipient_conversation_id, recipient_agent_id, recipient_agent_name,
          request_json, reference, status, deadline_at, cancel_requested_at,
          result_json, error_json, children_json, late_result_count,
          wait_requested_at, continuation_enqueued_at, terminal_at, created_at, updated_at
        ) VALUES (
          @id, @parentId, @idempotencyScope, @idempotencyKey, @kind, @aggregation,
          @requesterConversationId, @requesterAgentId, @requesterAgentName,
          @requesterInvocationId, @requesterRunId, @requesterTurnId, @sourceTraceId,
          @recipientConversationId, @recipientAgentId, @recipientAgentName,
          @requestJson, @reference, @status, @deadlineAt, NULL,
          NULL, NULL, @childrenJson, 0,
          NULL, NULL, NULL, @createdAt, @updatedAt
        )
      `),
      markAwaiting: db.prepare(`
        UPDATE chat_agent_delegations
        SET status = 'awaiting', wait_requested_at = @at, updated_at = @at
        WHERE id = @id AND status IN ('queued', 'running')
        RETURNING *
      `),
      markRunning: db.prepare(`
        UPDATE chat_agent_delegations
        SET status = 'running', updated_at = @at
        WHERE id = @id AND status = 'queued'
        RETURNING *
      `),
      settle: db.prepare(`
        UPDATE chat_agent_delegations
        SET status = @status,
            result_json = @resultJson,
            error_json = @errorJson,
            terminal_at = @at,
            updated_at = @at
        WHERE id = @id AND status IN ('queued', 'running', 'awaiting')
        RETURNING *
      `),
      requestCancel: db.prepare(`
        UPDATE chat_agent_delegations
        SET cancel_requested_at = @at, updated_at = @at
        WHERE id = @id AND status IN ('queued', 'running', 'awaiting')
        RETURNING *
      `),
      cancel: db.prepare(`
        UPDATE chat_agent_delegations
        SET status = 'cancelled',
            error_json = @errorJson,
            terminal_at = @at,
            updated_at = @at
        WHERE id = @id AND status IN ('queued', 'running', 'awaiting')
        RETURNING *
      `),
      incrementLate: db.prepare(`
        UPDATE chat_agent_delegations
        SET late_result_count = late_result_count + 1, updated_at = @at
        WHERE id = @id AND status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
        RETURNING *
      `),
      markContinuation: db.prepare(`
        UPDATE chat_agent_delegations
        SET continuation_enqueued_at = @at, updated_at = @at
        WHERE id = @id AND status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
          AND continuation_enqueued_at IS NULL
        RETURNING *
      `),
      appendEvent: db.prepare(`
        INSERT INTO chat_agent_delegation_events (
          delegation_id, event_type, event_json, created_at
        ) VALUES (@delegationId, @eventType, @eventJson, @createdAt)
      `),
      getEvent: db.prepare('SELECT * FROM chat_agent_delegation_events WHERE id = ? LIMIT 1'),
      listEvents: db.prepare(`
        SELECT * FROM chat_agent_delegation_events
        WHERE delegation_id = ? ORDER BY created_at ASC, id ASC
      `),
    };
  }

  get(id: string) { return this.statements.get.get(id) || null; }
  getByIdempotency(scope: string, key: string) {
    return this.statements.getByIdempotency.get(scope, key) || null;
  }
  listByRequester(invocationId: string) { return this.statements.listByRequester.all(invocationId); }
  listByParent(parentId: string) { return this.statements.listByParent.all(parentId); }
  listPendingForRequester(invocationId: string) { return this.statements.listPendingForRequester.all(invocationId); }
  listExpired(now: string, limit = 100) { return this.statements.listExpired.all(now, limit); }

  create(payload: any) {
    this.statements.insert.run({
      id: payload.id,
      parentId: payload.parentId || null,
      idempotencyScope: payload.idempotencyScope,
      idempotencyKey: payload.idempotencyKey,
      kind: payload.kind || 'child',
      aggregation: payload.aggregation || 'all',
      requesterConversationId: payload.requesterConversationId,
      requesterAgentId: payload.requesterAgentId,
      requesterAgentName: payload.requesterAgentName,
      requesterInvocationId: payload.requesterInvocationId,
      requesterRunId: payload.requesterRunId || null,
      requesterTurnId: payload.requesterTurnId || null,
      sourceTraceId: payload.sourceTraceId || null,
      recipientConversationId: payload.recipientConversationId,
      recipientAgentId: payload.recipientAgentId,
      recipientAgentName: payload.recipientAgentName,
      requestJson: JSON.stringify(payload.request || {}),
      reference: payload.reference || null,
      status: payload.status || 'queued',
      deadlineAt: payload.deadlineAt || null,
      childrenJson: JSON.stringify(Array.isArray(payload.children) ? payload.children : []),
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt || payload.createdAt,
    });
    return this.get(payload.id);
  }

  markRunning(id: string, at: string) { return this.statements.markRunning.get({ id, at }) || null; }
  markAwaiting(id: string, at: string) { return this.statements.markAwaiting.get({ id, at }) || null; }
  settle(id: string, status: string, payload: any, at: string) {
    return this.statements.settle.get({
      id, status, at,
      resultJson: payload === undefined ? null : JSON.stringify(payload),
      errorJson: null,
    }) || null;
  }
  fail(id: string, error: any, at: string) {
    return this.statements.settle.get({
      id, status: 'failed', at, resultJson: null,
      errorJson: JSON.stringify(error || { code: 'delegation_failed', message: 'Delegation failed' }),
    }) || null;
  }
  timeout(id: string, at: string) {
    return this.statements.settle.get({
      id, status: 'timed_out', at, resultJson: null,
      errorJson: JSON.stringify({ code: 'delegation_deadline_exceeded', message: 'Delegation deadline exceeded' }),
    }) || null;
  }
  requestCancel(id: string, at: string) { return this.statements.requestCancel.get({ id, at }) || null; }
  cancel(id: string, error: any, at: string) {
    return this.statements.cancel.get({ id, at, errorJson: JSON.stringify(error || { code: 'cancelled' }) }) || null;
  }
  recordLateResult(id: string, at: string) { return this.statements.incrementLate.get({ id, at }) || null; }
  markContinuationEnqueued(id: string, at: string) { return this.statements.markContinuation.get({ id, at }) || null; }

  appendEvent(payload: any) {
    const result = this.statements.appendEvent.run({
      delegationId: payload.delegationId,
      eventType: payload.eventType,
      eventJson: payload.event === undefined ? null : JSON.stringify(payload.event),
      createdAt: payload.createdAt,
    });
    return this.statements.getEvent.get(Number(result.lastInsertRowid));
  }
  listEvents(id: string) { return this.statements.listEvents.all(id); }
}

export function createAgentDelegationRepository(db: any) {
  return new AgentDelegationRepository(db);
}

export { normalizeDelegationRow };
