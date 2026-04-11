const { randomUUID } = require('node:crypto');

const SLOT_KEY_SEPARATOR = '\u001f';

function nowIso() {
  return new Date().toISOString();
}

function normalizeValue(value: any) {
  return String(value || '').trim();
}

function buildSlotKey(conversationId: any, agentId: any) {
  const normalizedConversationId = normalizeValue(conversationId);
  const normalizedAgentId = normalizeValue(agentId);

  if (!normalizedConversationId || !normalizedAgentId) {
    return '';
  }

  return `${normalizedConversationId}${SLOT_KEY_SEPARATOR}${normalizedAgentId}`;
}

function parseSlotKey(slotKey: any) {
  const normalizedSlotKey = normalizeValue(slotKey);

  if (!normalizedSlotKey) {
    return {
      conversationId: '',
      agentId: '',
    };
  }

  const [conversationId = '', agentId = ''] = normalizedSlotKey.split(SLOT_KEY_SEPARATOR);
  return {
    conversationId,
    agentId,
  };
}

function createCancelledError(reason: any = 'Cancelled') {
  const error = new Error(String(reason || 'Cancelled').trim() || 'Cancelled') as any;
  error.code = 'AGENT_SLOT_REQUEST_CANCELLED';
  return error;
}

export function createAgentSlotRegistry() {
  const holders = new Map();
  const waiters = new Map();
  let waiterSequence = 0;

  function listWaiters(slotKey: any) {
    const normalizedSlotKey = normalizeValue(slotKey);
    return normalizedSlotKey && waiters.has(normalizedSlotKey) ? waiters.get(normalizedSlotKey) : [];
  }

  function setWaiters(slotKey: any, items: any) {
    const normalizedSlotKey = normalizeValue(slotKey);
    const nextItems = Array.isArray(items) ? items.filter(Boolean) : [];

    if (!normalizedSlotKey) {
      return;
    }

    if (nextItems.length === 0) {
      waiters.delete(normalizedSlotKey);
      return;
    }

    waiters.set(normalizedSlotKey, nextItems);
  }

  function pruneCancelledWaiters(slotKey: any) {
    setWaiters(
      slotKey,
      listWaiters(slotKey).filter((waiter: any) => waiter && !waiter.cancelled)
    );
  }

  function createGrant(slotKey: any, holder: any) {
    return {
      token: holder.token,
      slotId: slotKey,
      conversationId: holder.conversationId,
      agentId: holder.agentId,
      lane: holder.lane,
      release() {
        const currentHolder = holders.get(slotKey);

        if (!currentHolder || currentHolder.token !== holder.token) {
          return false;
        }

        holders.delete(slotKey);
        grantNextWaiter(slotKey);
        return true;
      },
    };
  }

  function occupySlot(slotKey: any, waiter: any) {
    const { conversationId, agentId } = parseSlotKey(slotKey);
    const holder = {
      token: `agent-slot-${randomUUID()}`,
      slotKey,
      conversationId,
      agentId,
      lane: waiter && waiter.lane ? waiter.lane : 'main',
      waiterId: waiter && waiter.waiterId ? waiter.waiterId : '',
      acquiredAt: nowIso(),
    };

    holders.set(slotKey, holder);
    return createGrant(slotKey, holder);
  }

  function deliverWaiter(slotKey: any, waiter: any) {
    if (!waiter || waiter.cancelled) {
      return false;
    }

    const grant = occupySlot(slotKey, waiter);

    try {
      if (typeof waiter.resolve === 'function') {
        waiter.resolve(grant);
      }

      if (typeof waiter.onGranted === 'function') {
        const maybePromise = waiter.onGranted(grant);

        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.catch((error: any) => {
            try {
              grant.release();
            } catch {}
            console.error(
              `[agent-slot-registry] Waiter for ${slotKey} failed after grant: ${
                error && error.stack ? error.stack : error
              }`
            );
          });
        }
      }
    } catch (error) {
      try {
        grant.release();
      } catch {}

      if (typeof waiter.reject === 'function') {
        waiter.reject(error);
      }

      console.error(
        `[agent-slot-registry] Waiter for ${slotKey} failed during grant: ${error && (error as any).stack ? (error as any).stack : error}`
      );
    }

    return true;
  }

  function grantNextWaiter(slotKey: any) {
    const queue = listWaiters(slotKey).slice();

    while (queue.length > 0) {
      const waiter = queue.shift();
      setWaiters(slotKey, queue);

      if (!waiter || waiter.cancelled) {
        continue;
      }

      return deliverWaiter(slotKey, waiter);
    }

    setWaiters(slotKey, []);
    return false;
  }

  function requestSlot(input: any = {}) {
    const conversationId = normalizeValue(input.conversationId);
    const agentId = normalizeValue(input.agentId);
    const lane = normalizeValue(input.lane) || 'main';
    const slotKey = buildSlotKey(conversationId, agentId);

    if (!slotKey) {
      const error = createCancelledError('Missing conversationId or agentId for slot request');
      return {
        slotId: slotKey,
        queued: false,
        promise: Promise.reject(error),
        cancel() {
          return false;
        },
      };
    }

    const onGranted = typeof input.onGranted === 'function' ? input.onGranted : null;
    let resolvePromise = null as any;
    let rejectPromise = null as any;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const waiter = {
      waiterId: `slot-waiter-${++waiterSequence}`,
      slotKey,
      conversationId,
      agentId,
      lane,
      onGranted,
      resolve: resolvePromise,
      reject: rejectPromise,
      cancelled: false,
      createdAt: nowIso(),
    };
    const holder = holders.get(slotKey) || null;
    const queue = listWaiters(slotKey);
    const queued = Boolean(holder || queue.length > 0);

    if (!queued) {
      deliverWaiter(slotKey, waiter);
      return {
        slotId: slotKey,
        queued: false,
        promise,
        cancel() {
          return false;
        },
      };
    }

    setWaiters(slotKey, [...queue, waiter]);

    return {
      slotId: slotKey,
      queued: true,
      waiterId: waiter.waiterId,
      promise,
      cancel(reason: any = 'Cancelled') {
        if (waiter.cancelled) {
          return false;
        }

        waiter.cancelled = true;
        pruneCancelledWaiters(slotKey);

        if (typeof waiter.reject === 'function') {
          waiter.reject(createCancelledError(reason));
        }

        return true;
      },
    };
  }

  function isAgentBusy(conversationId: any, agentId: any) {
    return holders.has(buildSlotKey(conversationId, agentId));
  }

  function buildSideQueueDepths() {
    const result: Record<string, Record<string, number>> = {};

    for (const [slotKey, queue] of waiters.entries()) {
      const activeSideWaiters = (Array.isArray(queue) ? queue : []).filter(
        (waiter: any) => waiter && !waiter.cancelled && waiter.lane === 'side'
      );

      if (activeSideWaiters.length === 0) {
        continue;
      }

      const { conversationId, agentId } = parseSlotKey(slotKey);

      if (!conversationId || !agentId) {
        continue;
      }

      if (!result[conversationId]) {
        result[conversationId] = {};
      }

      result[conversationId][agentId] = activeSideWaiters.length;
    }

    return result;
  }

  function clearConversation(conversationId: any) {
    const normalizedConversationId = normalizeValue(conversationId);

    if (!normalizedConversationId) {
      return;
    }

    for (const slotKey of Array.from(waiters.keys())) {
      const parsed = parseSlotKey(slotKey);

      if (parsed.conversationId !== normalizedConversationId) {
        continue;
      }

      for (const waiter of listWaiters(slotKey)) {
        if (!waiter || waiter.cancelled) {
          continue;
        }

        waiter.cancelled = true;

        if (typeof waiter.reject === 'function') {
          waiter.reject(createCancelledError('Conversation cleared'));
        }
      }

      waiters.delete(slotKey);
      holders.delete(slotKey);
    }
  }

  return {
    buildSideQueueDepths,
    clearConversation,
    isAgentBusy,
    parseSlotKey,
    requestSlot,
  };
}
