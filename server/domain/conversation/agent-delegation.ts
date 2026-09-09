const { randomUUID } = require('node:crypto');
const { createHttpError } = require('../../http/http-errors');

const MAX_DELEGATION_CONTENT_LENGTH = 12_000;
const MAX_DELEGATION_REFERENCE_LENGTH = 200;
const MAX_DELEGATION_IDEMPOTENCY_KEY_LENGTH = 200;
const SUPPORTED_AGGREGATIONS = new Set(['all']);
const RESERVED_AGGREGATIONS = new Set(['any', 'quorum']);

function delegationError(statusCode: number, code: string, message: string, field = '') {
  return createHttpError(statusCode, message, {
    code,
    issues: [{ code, ...(field ? { field } : {}), message }],
  });
}

function requiredText(value: any, field: string, maxLength: number) {
  const normalized = String(value || '').trim();
  if (!normalized) throw delegationError(400, 'delegation_invalid_request', `${field} is required`, field);
  if (normalized.length > maxLength) {
    throw delegationError(400, 'delegation_invalid_request', `${field} is too long`, field);
  }
  return normalized;
}

function normalizeDelegationRequest(input: any = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw delegationError(400, 'delegation_invalid_request', 'Delegation request must be an object');
  }
  const aggregation = String(input.aggregation || 'all').trim().toLowerCase();
  if (!SUPPORTED_AGGREGATIONS.has(aggregation)) {
    if (RESERVED_AGGREGATIONS.has(aggregation)) {
      throw delegationError(501, 'delegation_aggregation_unavailable', `${aggregation} aggregation is reserved but not implemented`, 'aggregation');
    }
    throw delegationError(400, 'delegation_invalid_aggregation', 'aggregation must be all, any, or quorum', 'aggregation');
  }
  const recipients: string[] = Array.from(new Set((Array.isArray(input.recipientAgentIds) ? input.recipientAgentIds : [input.recipientAgentId])
    .map((value: any) => String(value || '').trim())
    .filter(Boolean))) as string[];
  if (recipients.length === 0) {
    throw delegationError(400, 'delegation_invalid_request', 'At least one recipientAgentId is required', 'recipientAgentIds');
  }
  const content = requiredText(input.content, 'content', MAX_DELEGATION_CONTENT_LENGTH);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey', MAX_DELEGATION_IDEMPOTENCY_KEY_LENGTH);
  if (Object.prototype.hasOwnProperty.call(input, 'deadlineSeconds')) {
    throw delegationError(
      400,
      'delegation_deadline_unsupported',
      'deadlineSeconds is no longer supported; delegations remain pending until an explicit terminal result or cancellation',
      'deadlineSeconds'
    );
  }
  const reference = input.reference === undefined || input.reference === null || input.reference === ''
    ? null
    : requiredText(input.reference, 'reference', MAX_DELEGATION_REFERENCE_LENGTH);
  return { aggregation, recipients, content, idempotencyKey, reference };
}

function assertConversationParticipant(conversation: any, agentId: string, field: string) {
  if (!(Array.isArray(conversation && conversation.agents) ? conversation.agents : []).some((agent: any) => agent && agent.id === agentId)) {
    throw delegationError(403, 'delegation_agent_not_participant', `${field} must be an active conversation participant`, field);
  }
}

function createAgentDelegation(store: any, context: any, input: any, options: any = {}) {
  const request = normalizeDelegationRequest(input);
  const conversation = store.getConversationWithoutMessages(context.conversationId);
  if (!conversation) throw delegationError(404, 'delegation_conversation_not_found', 'Conversation not found');
  assertConversationParticipant(conversation, context.agentId, 'requesterAgentId');
  for (const recipientAgentId of request.recipients) {
    assertConversationParticipant(conversation, recipientAgentId, 'recipientAgentIds');
    if (recipientAgentId === context.agentId) {
      throw delegationError(409, 'delegation_self_target', 'Requester cannot delegate to itself', 'recipientAgentIds');
    }
  }

  const scope = `agent:${context.invocationId}`;
  const existing = store.getAgentDelegationByIdempotency(scope, request.idempotencyKey);
  if (existing) return { duplicate: true, delegation: existing };

  const now = typeof options.now === 'function' ? new Date(options.now()) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Delegation clock returned an invalid date');
  const createdAt = now.toISOString();
  const delegationId = String(typeof options.createId === 'function' ? options.createId() : randomUUID()).trim();
  const childIds = request.recipients.map(() => String(typeof options.createId === 'function' ? options.createId() : randomUUID()).trim());
  const deadlineAt = null;
  const recipientAgent = conversation.agents.find((agent: any) => agent && agent.id === request.recipients[0]);
  const payload = {
    id: delegationId,
    idempotencyScope: scope,
    idempotencyKey: request.idempotencyKey,
    kind: 'group',
    aggregation: request.aggregation,
    requesterConversationId: context.conversationId,
    requesterAgentId: context.agentId,
    requesterAgentName: context.agentName,
    requesterInvocationId: context.invocationId,
    requesterRunId: context.stage && context.stage.runId ? context.stage.runId : null,
    requesterTurnId: context.turnId || null,
    sourceTraceId: context.invocationId,
    recipientConversationId: context.conversationId,
    recipientAgentId: recipientAgent.id,
    recipientAgentName: recipientAgent.name,
    request: { content: request.content, recipients: request.recipients, aggregation: request.aggregation },
    reference: request.reference,
    status: 'queued',
    deadlineAt,
    children: childIds,
    createdAt,
    updatedAt: createdAt,
  };
  const childPayloads = request.recipients.map((recipientAgentId: string, index: number) => {
    const childAgent = conversation.agents.find((agent: any) => agent && agent.id === recipientAgentId);
    return {
      ...payload,
      id: childIds[index],
      parentId: delegationId,
      idempotencyScope: `${scope}:${delegationId}`,
      idempotencyKey: `${request.idempotencyKey}:${index + 1}`,
      kind: 'child',
      recipientAgentId,
      recipientAgentName: childAgent.name,
      children: [],
    };
  });
  const delegation = typeof store.createAgentDelegationGroup === 'function'
    ? store.createAgentDelegationGroup({ group: payload, children: childPayloads })
    : store.createAgentDelegation(payload);
  store.appendAgentDelegationEvent(delegationId, {
    eventType: 'created',
    event: {
      schemaVersion: 1,
      delegationId,
      aggregation: request.aggregation,
      recipientAgentIds: request.recipients,
      childDelegationIds: childIds,
      deadlineAt,
      reference: request.reference,
    },
    createdAt,
  });
  return { duplicate: false, delegation, childDelegations: childPayloads };
}

function buildCompletionPayload(delegation: any) {
  return {
    schemaVersion: 1,
    delegationId: delegation && delegation.id ? delegation.id : null,
    status: delegation && delegation.status ? delegation.status : 'unknown',
    aggregation: delegation && delegation.aggregation ? delegation.aggregation : 'all',
    children: Array.isArray(delegation && delegation.children) ? delegation.children : [],
    result: delegation && delegation.result !== undefined ? delegation.result : null,
    error: delegation && delegation.error !== undefined ? delegation.error : null,
    terminalAt: delegation && delegation.terminalAt ? delegation.terminalAt : null,
    lateResultCount: Number(delegation && delegation.lateResultCount || 0),
  };
}

function settleAgentDelegationChild(store: any, childId: any, status: string, result: any, at: string) {
  const normalizedChildId = String(childId || '').trim();
  const child = store.getAgentDelegation(normalizedChildId);
  if (!child) return null;
  if (child.terminalAt) {
    store.recordLateAgentDelegationResult(normalizedChildId, at);
    store.appendAgentDelegationEvent(normalizedChildId, {
      eventType: 'late_result',
      event: { delegationId: normalizedChildId, attemptedStatus: status },
      createdAt: at,
    });
    return { child: store.getAgentDelegation(normalizedChildId), parent: child.parentId ? store.getAgentDelegation(child.parentId) : null, late: true };
  }
  const settledChild = status === 'succeeded'
    ? store.settleAgentDelegation(normalizedChildId, 'succeeded', result, at)
    : status === 'timed_out'
      ? store.timeoutAgentDelegation(normalizedChildId, at)
      : status === 'cancelled'
        ? store.cancelAgentDelegation(normalizedChildId, { code: 'cancelled', message: 'Delegation recipient cancelled' }, at)
        : store.failAgentDelegation(normalizedChildId, { code: 'delegation_recipient_failed', message: String(result && result.message || 'Delegation recipient failed') }, at);
  if (!settledChild) {
    store.recordLateAgentDelegationResult(normalizedChildId, at);
    return { child: store.getAgentDelegation(normalizedChildId), parent: child.parentId ? store.getAgentDelegation(child.parentId) : null, late: true };
  }
  store.appendAgentDelegationEvent(normalizedChildId, {
    eventType: 'terminal',
    event: { delegationId: normalizedChildId, status: settledChild.status },
    createdAt: at,
  });
  if (!settledChild.parentId) return { child: settledChild, parent: null, late: false };
  const parent = store.getAgentDelegation(settledChild.parentId);
  const children = store.listAgentDelegationChildren(settledChild.parentId);
  if (parent && (parent.status === 'running' || parent.status === 'awaiting') && children.length > 0 && children.every((item: any) => item.terminalAt)) {
    const childResults = children.map((item: any) => ({
      delegationId: item.id,
      recipientAgentId: item.recipientAgentId,
      status: item.status,
      result: item.result,
      error: item.error,
    }));
    const parentResult = { childResults };
    const parentTerminal = children.some((item: any) => item.status !== 'succeeded')
      ? store.settleAgentDelegation(parent.id, 'failed', parentResult, at)
      : store.settleAgentDelegation(parent.id, 'succeeded', parentResult, at);
    if (parentTerminal) {
      store.appendAgentDelegationEvent(parent.id, {
        eventType: 'terminal',
        event: { delegationId: parent.id, status: parentTerminal.status, childResults },
        createdAt: at,
      });
      return { child: settledChild, parent: parentTerminal, late: false };
    }
  }
  return { child: settledChild, parent: store.getAgentDelegation(settledChild.parentId), late: false };
}

export {
  settleAgentDelegationChild,
  buildCompletionPayload,
  createAgentDelegation,
  delegationError,
  normalizeDelegationRequest,
};
