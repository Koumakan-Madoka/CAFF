const { randomUUID } = require('node:crypto');
const { buildCompletionPayload, settleAgentDelegationChild } = require('./agent-delegation');

export function createAgentDelegationRuntime(options: any = {}) {
  const store = options.store;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const onCompletion = typeof options.onCompletion === 'function' ? options.onCompletion : null;
  const onChanged = typeof options.onChanged === 'function' ? options.onChanged : null;
  const onCancelRequested = typeof options.onCancelRequested === 'function' ? options.onCancelRequested : null;
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

  function settleExpiredGroup(delegation: any, at: string) {
    const children = typeof store.listAgentDelegationChildren === 'function'
      ? store.listAgentDelegationChildren(delegation.id)
      : [];
    const childResults = children.map((item: any) => ({
      delegationId: item.id,
      recipientAgentId: item.recipientAgentId,
      status: item.status,
      result: item.result,
      error: item.error,
    }));
    if (!children.length || !children.every((item: any) => item.terminalAt)) return null;
    const terminal = store.settleAgentDelegation(
      delegation.id,
      children.some((item: any) => item.status !== 'succeeded') ? 'failed' : 'succeeded',
      { childResults },
      at
    );
    if (!terminal) return null;
    store.appendAgentDelegationEvent(delegation.id, {
      eventType: 'terminal',
      event: { delegationId: delegation.id, status: terminal.status, childResults },
      createdAt: at,
    });
    return notifyTerminal({ child: null, parent: terminal, late: false });
  }

  function scanDeadlines(limit = 100) {
    const at = currentIso();
    const results = [];
    for (const delegation of store.listExpiredAgentDelegations(at, limit)) {
      if (delegation.kind === 'child') {
        results.push(settleRecipient({ delegationId: delegation.id, status: 'timed_out', at }));
        continue;
      }
      const children = typeof store.listAgentDelegationChildren === 'function'
        ? store.listAgentDelegationChildren(delegation.id)
        : [];
      for (const child of children) {
        if (!child.terminalAt) results.push(settleRecipient({ delegationId: child.id, status: 'timed_out', at }));
      }
      const refreshed = store.getAgentDelegation(delegation.id);
      if (!refreshed || refreshed.terminalAt) continue;
      const grouped = settleExpiredGroup(refreshed, at);
      if (grouped) {
        results.push(grouped);
        continue;
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
    const children = typeof store.listAgentDelegationChildren === 'function'
      ? store.listAgentDelegationChildren(id)
      : [];
    const childDelegationIds = children.map((child: any) => child.id);

    if (onCancelRequested) {
      try {
        onCancelRequested({
          delegationId: id,
          requesterConversationId: requested.requesterConversationId,
          childDelegationIds,
          reason,
        });
      } catch {
        store.appendAgentDelegationEvent(id, {
          eventType: 'dispatch_cancel_failed',
          event: { delegationId: id, runtimeId },
          createdAt: at,
        });
      }
    }

    if (requested.parentId) {
      const settlement = settleRecipient({
        delegationId: id,
        status: 'cancelled',
        result: { message: reason },
        at,
      });
      return settlement && (settlement.parent || settlement.child)
        ? settlement.parent || settlement.child
        : store.getAgentDelegation(id);
    }

    for (const child of children) {
      if (child.terminalAt) continue;
      const cancelledChild = store.cancelAgentDelegation(
        child.id,
        { code: 'cancelled', message: 'Delegation recipient cancelled' },
        at
      );
      if (!cancelledChild) continue;
      store.appendAgentDelegationEvent(child.id, {
        eventType: 'terminal',
        event: { delegationId: child.id, status: 'cancelled' },
        createdAt: at,
      });
      publish(cancelledChild, 'child_terminal');
    }

    const childResults = children.map((child: any) => {
      const current = store.getAgentDelegation(child.id) || child;
      return {
        delegationId: current.id,
        recipientAgentId: current.recipientAgentId,
        status: current.status,
        result: current.result,
        error: current.error,
      };
    });
    const cancelled = store.cancelAgentDelegation(
      id,
      { code: 'delegation_cancelled', message: reason },
      at,
      { childResults }
    );
    if (!cancelled) return store.getAgentDelegation(id);

    store.appendAgentDelegationEvent(id, {
      eventType: 'cancelled',
      event: { delegationId: id, runtimeId, reason },
      createdAt: at,
    });
    const notified = notifyTerminal({ child: null, parent: cancelled, late: false });
    return notified && notified.parent ? notified.parent : cancelled;
  }

  return { cancel, runtimeId, scanDeadlines, settleRecipient };
}
