// @ts-check

(function registerConversationDigestHelpers() {
  const shared = window.CaffShared || (window.CaffShared = {});

  function metadataForConversation(conversation) {
    return conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : null;
  }

  function digestsForConversation(conversation) {
    const metadata = metadataForConversation(conversation);
    const digests = metadata && Array.isArray(metadata.conversationDigests) ? metadata.conversationDigests : [];

    return digests
      .map((digest) => {
        const id = String((digest && digest.id) || '').trim();
        const summary = String((digest && digest.summary) || '').trim();
        const createdAt = String((digest && digest.createdAt) || '').trim();

        if (!id || !summary || !createdAt) {
          return null;
        }

        const kind = String((digest && digest.kind) || '').trim().toLowerCase() === 'rollup' ? 'rollup' : 'entry';

        return {
          ...digest,
          id,
          kind,
          summary,
          createdAt,
          updatedAt: String((digest && digest.updatedAt) || createdAt).trim(),
          compactedAt: String((digest && digest.compactedAt) || '').trim(),
          sourceDigestIds: Array.isArray(digest && digest.sourceDigestIds) ? digest.sourceDigestIds : [],
          messageRange: digest && digest.messageRange && typeof digest.messageRange === 'object' ? digest.messageRange : {},
          facts: sectionItems(digest && digest.facts),
          decisions: sectionItems(digest && digest.decisions),
          openQuestions: sectionItems(digest && digest.openQuestions),
          nextActions: sectionItems(digest && digest.nextActions),
          artifacts: sectionItems(digest && digest.artifacts),
        };
      })
      .filter(Boolean);
  }

  function sectionItems(value) {
    return (Array.isArray(value) ? value : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  function digestStateForConversation(conversation) {
    const metadata = metadataForConversation(conversation);
    const state = metadata && metadata.conversationDigestState && typeof metadata.conversationDigestState === 'object'
      ? metadata.conversationDigestState
      : null;

    if (!state) {
      return null;
    }

    const pendingPublicMessageCount = Number.parseInt(String(state.pendingPublicMessageCount || '0'), 10) || 0;
    const pendingTokenEstimate = Number.parseInt(String(state.pendingTokenEstimate || '0'), 10) || 0;
    const signalFlags = state.signalFlags && typeof state.signalFlags === 'object' ? state.signalFlags : {};

    return {
      ...state,
      pendingPublicMessageCount: Math.max(0, pendingPublicMessageCount),
      pendingTokenEstimate: Math.max(0, pendingTokenEstimate),
      signalFlags: {
        decision: Boolean(signalFlags.decision),
        code: Boolean(signalFlags.code),
        errorFix: Boolean(signalFlags.errorFix),
      },
    };
  }

  function signalFlagLabels(signalFlags) {
    const flags = signalFlags && typeof signalFlags === 'object' ? signalFlags : {};
    const labels = [];

    if (flags.decision) {
      labels.push('决策');
    }

    if (flags.code) {
      labels.push('代码');
    }

    if (flags.errorFix) {
      labels.push('修复');
    }

    return labels;
  }

  function formatAutoDigestStatus(conversation) {
    const state = digestStateForConversation(conversation);

    if (!state || !state.messageBudget) {
      return '';
    }

    const budget = Number.parseInt(String(state.messageBudget || '0'), 10) || 24;
    const pendingText = `自动摘要待总结：${state.pendingPublicMessageCount}/${budget} 条公开消息`;
    const signalLabels = signalFlagLabels(state.signalFlags);
    const signalText = signalLabels.length > 0 ? `，高价值信号：${signalLabels.join('、')}` : '';
    const triggerText = state.lastTriggerReason ? `，上次触发：${state.lastTriggerReason}` : '';

    return `${pendingText}${signalText}${triggerText}`;
  }

  function latestDigest(conversation) {
    const digests = digestsForConversation(conversation);
    return digests.length > 0 ? digests[digests.length - 1] : null;
  }

  function digestCount(conversation) {
    return digestsForConversation(conversation).length;
  }

  function formatDigestStatus(conversation) {
    const count = digestCount(conversation);

    if (count === 0) {
      return '当前没有会话摘要。使用 /digest 生成一条。';
    }

    const rollupCount = digestsForConversation(conversation).filter((digest) => digest.kind === 'rollup').length;
    const rollupText = rollupCount > 0 ? `，含 ${rollupCount} 条压缩摘要` : '';
    const autoStatus = formatAutoDigestStatus(conversation);
    const autoText = autoStatus ? `。${autoStatus}` : '';
    return `会话摘要：${count} 条长期记忆条目${rollupText}${autoText}`;
  }

  function messageRangeText(digest) {
    const range = digest && digest.messageRange && typeof digest.messageRange === 'object' ? digest.messageRange : {};
    const count = Number.parseInt(String(range.messageCount || '0'), 10) || 0;
    return count > 0 ? `${count} 条公开消息` : '';
  }

  shared.conversationDigest = {
    digestsForConversation,
    digestStateForConversation,
    latestDigest,
    digestCount,
    formatDigestStatus,
    formatAutoDigestStatus,
    messageRangeText,
    sectionItems,
  };
})();
