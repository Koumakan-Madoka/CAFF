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
          createdBy: String((digest && digest.createdBy) || '').trim(),
          triggerReason: String((digest && digest.triggerReason) || '').trim(),
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
        codeChange: Boolean(signalFlags.codeChange),
        fileArtifact: Boolean(signalFlags.fileArtifact),
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

    if (flags.codeChange || flags.code) {
      labels.push('代码变更');
    } else if (flags.fileArtifact) {
      labels.push('代码线索');
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

  function skillDraftsForConversation(conversation) {
    const metadata = metadataForConversation(conversation);
    const drafts = metadata && Array.isArray(metadata.skillDrafts) ? metadata.skillDrafts : [];

    return drafts
      .map((draft) => {
        const id = String((draft && draft.id) || '').trim();
        const skill = draft && draft.skill && typeof draft.skill === 'object' ? draft.skill : null;
        const skillId = String((skill && skill.id) || '').trim();
        const name = String((skill && skill.name) || '').trim();
        const description = String((skill && skill.description) || '').trim();
        const body = String((skill && skill.body) || '').trim();

        if (!id || !skillId || !name || !description || !body) {
          return null;
        }

        const source = draft && draft.source && typeof draft.source === 'object' ? draft.source : {};

        return {
          ...draft,
          id,
          status: String((draft && draft.status) || 'pending').trim() || 'pending',
          createdAt: String((draft && draft.createdAt) || '').trim(),
          updatedAt: String((draft && draft.updatedAt) || '').trim(),
          source: {
            ...source,
            type: String((source && source.type) || 'digest').trim() || 'digest',
            digestId: String((source && source.digestId) || '').trim(),
            digestKind: String((source && source.digestKind) || 'entry').trim() || 'entry',
            trigger: String((source && (source.trigger || source.triggerReason)) || '').trim(),
            createdBy: String((source && source.createdBy) || '').trim(),
            autoCreated: Boolean(source && source.autoCreated),
          },
          skill: {
            ...skill,
            id: skillId,
            name,
            description,
            body,
          },
        };
      })
      .filter(Boolean);
  }

  function latestDigest(conversation) {
    const digests = digestsForConversation(conversation);
    return digests.length > 0 ? digests[digests.length - 1] : null;
  }

  function digestKindLabel(digest) {
    const kind = typeof digest === 'string' ? digest : digest && digest.kind;
    return String(kind || '').trim().toLowerCase() === 'rollup' ? '压缩总摘要' : '详细摘要';
  }

  function digestKindHelp(digest) {
    return digestKindLabel(digest) === '压缩总摘要'
      ? '压缩总摘要是由 /digest compact 生成的——把多条旧详细摘要合并成一条长期概览，减少上下文占用。'
      : '详细摘要是由 /digest 生成的——直接总结一段近期原始聊天内容，保留关键信息。';
  }

  function digestCounts(conversation) {
    const digests = digestsForConversation(conversation);
    const rollupCount = digests.filter((digest) => digest.kind === 'rollup').length;
    return {
      total: digests.length,
      entryCount: Math.max(0, digests.length - rollupCount),
      rollupCount,
    };
  }

  function digestCount(conversation) {
    return digestCounts(conversation).total;
  }

  function formatDigestStatus(conversation) {
    const counts = digestCounts(conversation);

    if (counts.total === 0) {
      return '当前没有会话摘要。使用 /digest 生成一条详细摘要。';
    }

    const rollupText = counts.rollupCount > 0 ? `，${counts.rollupCount} 条压缩总摘要` : '';
    const autoStatus = formatAutoDigestStatus(conversation);
    const autoText = autoStatus ? `。${autoStatus}` : '';
    return `会话摘要：${counts.total} 条长期记忆（${counts.entryCount} 条详细摘要${rollupText}）${autoText}`;
  }

  function messageRangeText(digest) {
    const range = digest && digest.messageRange && typeof digest.messageRange === 'object' ? digest.messageRange : {};
    const count = Number.parseInt(String(range.messageCount || '0'), 10) || 0;
    return count > 0 ? `${count} 条公开消息` : '';
  }

  function createDigestSourceLocator({ dom, showToast }) {
    function findMessageCard(messageId) {
      const normalizedMessageId = String(messageId || '').trim();

      if (!normalizedMessageId || !dom || !dom.messageList) {
        return null;
      }

      return Array.from(dom.messageList.querySelectorAll('.message-card'))
        .find((card) => card.dataset.messageId === normalizedMessageId) || null;
    }

    function clearTargetHighlights() {
      if (!dom || !dom.messageList) {
        return;
      }

      dom.messageList.querySelectorAll('.message-card.digest-source-target')
        .forEach((card) => card.classList.remove('digest-source-target'));
    }

    function notify(message) {
      if (typeof showToast === 'function') {
        showToast(message);
      }
    }

    function focusSourceMessage(digest) {
      const messageId = String(digest && digest.messageRange && digest.messageRange.fromMessageId || '').trim();

      if (!messageId) {
        notify('这条摘要暂时没有可定位的首条消息。');
        return;
      }

      const card = findMessageCard(messageId);
      if (!card) {
        notify('首条消息当前不在时间线中，可能已被过滤或尚未加载。');
        return;
      }

      clearTargetHighlights();
      card.classList.add('digest-source-target');
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => card.classList.remove('digest-source-target'), 2200);
    }

    return {
      focusSourceMessage,
    };
  }

  shared.conversationDigest = {
    digestsForConversation,
    digestStateForConversation,
    latestDigest,
    digestKindLabel,
    digestKindHelp,
    digestCounts,
    digestCount,
    formatDigestStatus,
    formatAutoDigestStatus,
    messageRangeText,
    sectionItems,
    skillDraftsForConversation,
    createDigestSourceLocator,
  };
})();
