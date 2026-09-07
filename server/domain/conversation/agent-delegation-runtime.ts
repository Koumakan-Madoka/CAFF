const { randomUUID } = require('node:crypto');
const { buildCompletionPayload, settleAgentDelegationChild } = require('./agent-delegation');

export function createAgentDelegationRuntime(options: any = {}) {
  const store = options.store;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const onCompletion = typeof options.onCompletion === 'function' ? options.onCompletion : null;
  const onChanged = typeof options.onChanged === 'function' ? options.onChanged : null;
  const runtimeId = String(options.runtimeId || `delegation-runtime-${randomUUID()}`).trim();

  if (!store) throw new Error('Agent delegation runtime requires a chat store');

  function currentIso() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('Delegation clock returned an invalid date');
    return date.toISOString();
  }

  function publish(delegation: any, reason: string) {
    if (!delegation || !onChanged) return;
    try { onChanged({ delegation, reason, completion: buildCompletionPayload(delegation) }); } catch {}
  }

  function notifyTerminal(settlement: any) {
    const parent = settlement && settlement.parent;
    if (!parent || !parent.terminalAt) return settlement;
    const marked = store.markAgentDelegationContinuationEnqueued(parent.id, currentIso());
    if (!marked) return settlement;
    store.appendAgentDelegationEvent(parent.id, {
      eventType: 'continuation_enqueued',
      event: { runtimeId, delegationId: parent.id },
      createdAt: marked.updatedAt,
    });
    const completion = buildCompletionPayload(marked);
    publish(marked, 'terminal');
    if (onCompletion) {
      try { onCompletion({ delegation: marked, completion }); } catch {}
    }
    return { ...settlement, parent: marked, completion };
  }

  function settleRecipient(input: any = {}) {
    const at = input.at || currentIso();
    const settlement = settleAgentDelegationChild(
      store,
      input.delegationId,
      String(input.status || 'failed').trim().toLowerCase(),
      input.result,
      at
    );
    if (!settlement) return null;
    publish(settlement.child, settlement.late ? 'late_result' : 'child_terminal');
    return notifyTerminal(settlement);
  }

  function scanDeadlines(limit = 100) {
    const at = currentIso();
    const results = [];
    for (const delegation of store.listExpiredAgentDelegations(at, limit)) {
      if (delegation.kind === 'child') {
        results.push(settleRecipient({ delegationId: delegation.id, status: 'timed_out', at }));
        continue;
      }
      for (const child of typeof store.listAgentDelegationChildren === 'function' ? store.listAgentDelegationChildren(delegation.id) : []) {
        if (!child.terminalAt) results.push(settleRecipient({ delegationId: child.id, status: 'timed_out', at }));
      }
      const timedOut = store.timeoutAgentDelegation(delegation.id, at);
      if (timedOut) {
        store.appendAgentDelegationEvent(delegation.id, {
          eventType: 'deadline_exceeded',
          event: { delegationId: delegation.id, runtimeId },
          createdAt: at,
        });
        results.push(notifyTerminal({ child: null, parent: timedOut, late: false }));
      }
    }
    return results.filter(Boolean);
  }

  function cancel(delegationId: any, reason = 'Cancelled by requester') {
    const id = String(delegationId || '').trim();
    const at = currentIso();
    const requested = store.requestAgentDelegationCancel(id, at);
    if (!requested) return null;
    if (typeof store.listAgentDelegationChildren === 'function') {
      for (const child of store.listAgentDelegationChildren(id)) {
        if (!child.terminalAt) {
          settleRecipient({ delegationId: child.id, status: 'cancelled', result: { message: reason }, at });
        }
      }
    }
    const cancelled = store.cancelAgentDelegation(id, { code: 'delegation_cancelled', message: reason }, at);
    if (!cancelled) return store.getAgentDelegation(id);
    store.appendAgentDelegationEvent(id, {
      eventType: 'cancelled',
      event: { delegationId: id, runtimeId, reason },
      createdAt: at,
    });
    return notifyTerminal({ child: cancelled, parent: cancelled.parentId ? store.getAgentDelegation(cancelled.parentId) : null, late: false });
  }

  return { cancel, runtimeId, scanDeadlines, settleRecipient };
}
