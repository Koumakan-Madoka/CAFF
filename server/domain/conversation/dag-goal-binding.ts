/**
 * DAG node goal binding (D28 enforcement anchor).
 *
 * When the DAG scheduler dispatches a node it sets a light session goal on
 * the child conversation AND records a binding in the child's conversation
 * metadata under `dagNodeGoalBinding`:
 *
 *   { planId, nodeId, workerId, verifierId }
 *
 * The binding is the machine-checked contract for the completion protocol:
 * - only `workerId` may create a `complete` proposal on the bound goal
 *   (bridge 403 `dag_completion_worker_only`);
 * - only `verifierId` may accept/reject that proposal (bridge 403
 *   `dag_verifier_only`) when a verifier is configured; `verifierId: null`
 *   means the node is verification-exempt (single-agent root conversation)
 *   and the scheduler auto-accepts;
 * - the user accepting/rejecting via the REST goal API bypasses these
 *   agent-only checks and is marked `ruledBy: { kind: 'user' }`.
 *
 * Kept in its own module (not session-goal.ts, not dag-scheduler.ts) so both
 * the runtime bridge and the DAG scheduler can import it without a cycle.
 */

const DAG_NODE_GOAL_BINDING_METADATA_KEY = 'dagNodeGoalBinding';

function isPlainObject(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeId(value: any): string {
  return String(value || '').trim();
}

export function normalizeDagNodeGoalBinding(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }
  const planId = normalizeId(value.planId);
  const nodeId = normalizeId(value.nodeId);
  const workerId = normalizeId(value.workerId);
  if (!planId || !nodeId || !workerId) {
    return null;
  }
  return {
    planId,
    nodeId,
    workerId,
    verifierId: normalizeId(value.verifierId) || null,
  };
}

export function getDagNodeGoalBinding(conversation: any) {
  const metadata = conversation && isPlainObject(conversation.metadata) ? conversation.metadata : {};
  return normalizeDagNodeGoalBinding(metadata[DAG_NODE_GOAL_BINDING_METADATA_KEY]);
}

/**
 * Persist the binding on the child conversation, preserving all existing
 * metadata. Idempotent: an existing binding is left untouched (a crash
 * between goal-set and binding-write is repaired by the caller re-invoking
 * this with the same values; the first write wins).
 */
export function ensureDagNodeGoalBinding(store: any, conversationId: string, binding: any) {
  const normalized = normalizeDagNodeGoalBinding(binding);
  const id = normalizeId(conversationId);
  if (!normalized || !id || !store || typeof store.getConversationWithoutMessages !== 'function') {
    return null;
  }
  const conversation = store.getConversationWithoutMessages(id);
  if (!conversation) {
    return null;
  }
  const existing = getDagNodeGoalBinding(conversation);
  if (existing) {
    return existing;
  }
  const metadata = {
    ...(isPlainObject(conversation.metadata) ? conversation.metadata : {}),
    [DAG_NODE_GOAL_BINDING_METADATA_KEY]: normalized,
  };
  store.updateConversation(id, {
    title: conversation.title,
    type: conversation.type,
    metadata,
  });
  return normalized;
}
