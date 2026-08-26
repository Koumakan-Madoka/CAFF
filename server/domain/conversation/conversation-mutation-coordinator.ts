type ConversationMutationKind = 'auto_digest' | 'manual_digest' | 'message_delete' | 'message_recovery';

type ConversationMutationLease = {
  acquired: true;
  kind: ConversationMutationKind;
  release: () => void;
} | {
  acquired: false;
  activeKind: ConversationMutationKind | '';
};

export function createConversationMutationCoordinator() {
  const activeMutations = new Map<string, { kind: ConversationMutationKind; token: symbol }>();
  const scheduledDigestConversationIds = new Set<string>();

  function normalizeConversationId(value: any) {
    return String(value || '').trim();
  }

  function tryAcquire(conversationId: any, kind: ConversationMutationKind): ConversationMutationLease {
    const normalizedConversationId = normalizeConversationId(conversationId);

    if (!normalizedConversationId) {
      return { acquired: false, activeKind: '' };
    }

    const active = activeMutations.get(normalizedConversationId);
    if (active) {
      return { acquired: false, activeKind: active.kind };
    }

    const token = Symbol(`${normalizedConversationId}:${kind}`);
    activeMutations.set(normalizedConversationId, { kind, token });
    let released = false;

    return {
      acquired: true,
      kind,
      release() {
        if (released) {
          return;
        }
        released = true;
        const current = activeMutations.get(normalizedConversationId);
        if (current && current.token === token) {
          activeMutations.delete(normalizedConversationId);
        }
      },
    };
  }

  function describe(conversationId: any) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const active = normalizedConversationId ? activeMutations.get(normalizedConversationId) : null;

    return {
      active: Boolean(active),
      activeKind: active ? active.kind : '',
      digestScheduled: normalizedConversationId
        ? scheduledDigestConversationIds.has(normalizedConversationId)
        : false,
    };
  }

  function markDigestScheduled(conversationId: any) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId) {
      scheduledDigestConversationIds.add(normalizedConversationId);
    }
  }

  function clearDigestScheduled(conversationId: any) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId) {
      scheduledDigestConversationIds.delete(normalizedConversationId);
    }
  }

  return {
    clearDigestScheduled,
    describe,
    markDigestScheduled,
    tryAcquire,
  };
}

export type { ConversationMutationKind };
