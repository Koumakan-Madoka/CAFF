// @ts-check

(function registerCrossConversationUiModule() {
  const chat = window.CaffChat || (window.CaffChat = {});
  const MAX_TREE_DEPTH = 2;

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function compareStableConversationOrder(left, right) {
    const leftCreatedAt = normalizeText(left && left.createdAt);
    const rightCreatedAt = normalizeText(right && right.createdAt);
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt.localeCompare(rightCreatedAt);
    }
    return normalizeText(left && left.id).localeCompare(normalizeText(right && right.id));
  }

  function buildConversationTree(conversations, options = {}) {
    const items = (Array.isArray(conversations) ? conversations : [])
      .filter((conversation) => conversation && normalizeText(conversation.id));
    const byId = new Map(items.map((conversation) => [normalizeText(conversation.id), conversation]));
    const childrenByParent = new Map();
    const roots = [];
    const collapsedIds = new Set(options.collapsedIds instanceof Set ? options.collapsedIds : options.collapsedIds || []);

    items.forEach((conversation) => {
      const parentId = normalizeText(conversation.parentConversationId);
      if (!parentId || !byId.has(parentId) || parentId === normalizeText(conversation.id)) {
        roots.push(conversation);
        return;
      }
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(conversation);
    });
    roots.sort(compareStableConversationOrder);
    childrenByParent.forEach((children) => children.sort(compareStableConversationOrder));

    let selectedId = normalizeText(options.selectedConversationId);
    const ancestorGuard = new Set();
    while (selectedId && byId.has(selectedId) && !ancestorGuard.has(selectedId)) {
      ancestorGuard.add(selectedId);
      const selected = byId.get(selectedId);
      const parentId = normalizeText(selected && selected.parentConversationId);
      if (!parentId || !byId.has(parentId)) break;
      collapsedIds.delete(parentId);
      selectedId = parentId;
    }

    const rows = [];
    const visited = new Set();
    function appendConversation(conversation, depth) {
      const id = normalizeText(conversation.id);
      if (!id || visited.has(id)) return;
      visited.add(id);
      const children = childrenByParent.get(id) || [];
      const expanded = children.length > 0 && !collapsedIds.has(id);
      const persistedDepth = Number(conversation.treeDepth);
      const normalizedDepth = Number.isInteger(persistedDepth) && persistedDepth >= 0 ? persistedDepth : depth;
      rows.push({
        conversation,
        depth: normalizedDepth,
        hasChildren: children.length > 0,
        expanded,
        canSpawn: normalizedDepth < MAX_TREE_DEPTH && Boolean(normalizeText(conversation.projectScopeId)),
        depthLimit: normalizedDepth >= MAX_TREE_DEPTH,
      });
      if (expanded) children.forEach((child) => appendConversation(child, depth + 1));
    }
    roots.forEach((root) => appendConversation(root, 0));

    return { rows, collapsedIds };
  }

  function deliveryView(delivery) {
    const value = delivery && typeof delivery === 'object' ? delivery : {};
    const messageStatus = normalizeText(value.messageStatus);
    const dispatchStatus = normalizeText(value.dispatchStatus);
    const responseStatus = normalizeText(value.responseStatus);
    const errorMessage = normalizeText(value.lastErrorMessage);
    const failed = dispatchStatus === 'failed' || responseStatus === 'timed_out' || responseStatus === 'late';
    const canRetry = dispatchStatus === 'failed' && !value.startedAt && !value.targetInvocationId;
    const canCancel = dispatchStatus === 'queued' || dispatchStatus === 'running';

    if (messageStatus && messageStatus !== 'persisted') {
      return { key: 'persisting', label: '准备中', tone: 'neutral', live: true, failed: false, canRetry: false, canCancel: false, errorMessage };
    }
    if (dispatchStatus === 'failed') {
      return { key: 'failed', label: '失败', tone: 'failed', live: false, failed: true, canRetry, canCancel: false, errorMessage };
    }
    if (responseStatus === 'timed_out') {
      return { key: 'timed_out', label: '超时', tone: 'failed', live: false, failed: true, canRetry: false, canCancel: false, errorMessage };
    }
    if (responseStatus === 'late') {
      return { key: 'late', label: '迟到回复', tone: 'failed', live: false, failed: true, canRetry: false, canCancel: false, errorMessage };
    }
    if (dispatchStatus === 'cancelled') {
      return { key: 'cancelled', label: '已取消', tone: 'neutral', live: false, failed: false, canRetry: false, canCancel: false, errorMessage };
    }
    if (dispatchStatus === 'cancel_requested') {
      return { key: 'cancel_requested', label: '正在取消', tone: 'running', live: true, failed: false, canRetry: false, canCancel: false, errorMessage };
    }
    if (dispatchStatus === 'running') {
      return { key: 'running', label: '处理中', tone: 'running', live: true, failed: false, canRetry: false, canCancel, errorMessage };
    }
    if (dispatchStatus === 'queued') {
      return { key: 'queued', label: '已排队', tone: 'neutral', live: true, failed: false, canRetry: false, canCancel, errorMessage };
    }
    if (responseStatus === 'waiting') {
      return { key: 'waiting', label: '等待回复', tone: 'neutral', live: true, failed: false, canRetry: false, canCancel: false, errorMessage };
    }
    if (responseStatus === 'received') {
      return { key: 'received', label: '已回答', tone: 'success', live: false, failed: false, canRetry: false, canCancel: false, errorMessage };
    }
    if (dispatchStatus === 'completed' || dispatchStatus === 'not_requested') {
      return { key: 'completed', label: '已完成', tone: 'success', live: false, failed: false, canRetry: false, canCancel: false, errorMessage };
    }
    return { key: 'unknown', label: '状态未知', tone: 'neutral', live: false, failed, canRetry, canCancel, errorMessage };
  }

  function conversationTitle(conversations, conversationId, fallback = '') {
    const id = normalizeText(conversationId);
    const match = (Array.isArray(conversations) ? conversations : []).find((conversation) => normalizeText(conversation && conversation.id) === id);
    return normalizeText(match && match.title) || normalizeText(fallback) || id;
  }

  function crossConversationMetadata(message) {
    const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    return metadata && metadata.crossConversation && typeof metadata.crossConversation === 'object'
      ? metadata.crossConversation
      : null;
  }

  function kindLabel(kind) {
    if (kind === 'bootstrap') return '派生子会话';
    if (kind === 'request') return '跨会话请求';
    if (kind === 'response') return '跨会话回复';
    return '跨会话通知';
  }

  function receiptModel(message, delivery, conversations) {
    const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    const crossConversation = crossConversationMetadata(message);
    if (!metadata || metadata.kind !== 'cross_conversation_receipt' || !crossConversation) return null;
    const targetConversationId = normalizeText(crossConversation.targetConversationId || (delivery && delivery.targetConversationId));
    return {
      deliveryId: normalizeText(crossConversation.deliveryId || (delivery && delivery.id)),
      kindLabel: kindLabel(normalizeText(crossConversation.kind || (delivery && delivery.kind))),
      targetConversationId,
      targetTitle: conversationTitle(conversations, targetConversationId, crossConversation.targetConversationTitle),
      targetAgentId: normalizeText(crossConversation.targetAgentId || (delivery && delivery.targetAgentId)),
      jumpConversationId: targetConversationId,
      view: deliveryView(delivery),
    };
  }

  function provenanceModel(message, conversations) {
    const crossConversation = crossConversationMetadata(message);
    if (!crossConversation || message.role !== 'external_agent') return null;
    const sourceConversationId = normalizeText(crossConversation.sourceConversationId);
    const sourceTitle = conversationTitle(conversations, sourceConversationId, crossConversation.sourceConversationTitle);
    return {
      deliveryId: normalizeText(crossConversation.deliveryId),
      label: `来自 ${sourceTitle}`,
      sourceTitle,
      sourceAgentName: normalizeText(crossConversation.sourceAgentName || message.senderName),
      kindLabel: kindLabel(normalizeText(crossConversation.kind)),
      backlinkConversationId: sourceConversationId,
    };
  }

  function birthModel(message, conversations, delivery) {
    const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    const crossConversation = crossConversationMetadata(message);
    if (!metadata || metadata.kind !== 'conversation_spawn_initial_message' || !crossConversation) return null;
    const sourceConversationId = normalizeText(crossConversation.sourceConversationId || crossConversation.parentConversationId);
    return {
      deliveryId: normalizeText(crossConversation.deliveryId),
      sourceTitle: conversationTitle(conversations, sourceConversationId, crossConversation.sourceConversationTitle),
      backlinkConversationId: sourceConversationId,
      notice: '这是全新会话，不会复制父会话历史或配置。',
      view: deliveryView(delivery),
    };
  }

  function timestamp(value) {
    const parsed = Date.parse(normalizeText(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function applyDeliveryPatch(bundles, conversations, delivery) {
    if (!delivery || !normalizeText(delivery.id)) return;
    const currentBundle = bundles.get(delivery.id) || {};
    bundles.set(delivery.id, { ...currentBundle, delivery: { ...(currentBundle.delivery || {}), ...delivery } });
    const target = (Array.isArray(conversations) ? conversations : [])
      .find((conversation) => normalizeText(conversation && conversation.id) === normalizeText(delivery.targetConversationId));
    if (!target) return;
    if (!target.crossConversationStatus || timestamp(delivery.updatedAt) >= timestamp(target.crossConversationStatus.updatedAt)) {
      target.crossConversationStatus = { ...(target.crossConversationStatus || {}), ...delivery };
    }
  }

  chat.crossConversationUi = {
    MAX_TREE_DEPTH,
    applyDeliveryPatch,
    birthModel,
    buildConversationTree,
    deliveryView,
    kindLabel,
    provenanceModel,
    receiptModel,
  };
})();
