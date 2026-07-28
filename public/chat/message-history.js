// @ts-check

(function registerMessageHistoryModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  function timestampValue(value) {
    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function compareMessages(left, right) {
    const byTime = timestampValue(left && left.createdAt) - timestampValue(right && right.createdAt);

    if (byTime !== 0) {
      return byTime;
    }

    return String(left && left.id || '').localeCompare(String(right && right.id || ''));
  }

  function mergeMessages(existing, incoming) {
    const messagesById = new Map();

    for (const message of Array.isArray(existing) ? existing : []) {
      if (message && message.id) {
        messagesById.set(message.id, message);
      }
    }

    for (const message of Array.isArray(incoming) ? incoming : []) {
      if (message && message.id) {
        messagesById.set(message.id, message);
      }
    }

    return Array.from(messagesById.values()).sort(compareMessages);
  }

  function createState() {
    return {
      conversationId: '',
      nextCursor: null,
      hasMore: false,
      loading: false,
      error: '',
      generation: 0,
      latestRequestId: 0,
    };
  }

  function reset(state, conversationId) {
    state.conversationId = String(conversationId || '').trim();
    state.nextCursor = null;
    state.hasMore = false;
    state.loading = false;
    state.error = '';
    state.generation += 1;
    state.latestRequestId = 0;
    return state.generation;
  }

  function requestToken(state) {
    return {
      conversationId: state.conversationId,
      generation: state.generation,
    };
  }

  function isRequestCurrent(state, request) {
    return Boolean(
      request &&
      request.conversationId === state.conversationId &&
      request.generation === state.generation
    );
  }

  function beginLatestRequest(state) {
    state.latestRequestId += 1;
    return {
      ...requestToken(state),
      latestRequestId: state.latestRequestId,
    };
  }

  function isLatestRequestCurrent(state, request) {
    return isRequestCurrent(state, request) && request.latestRequestId === state.latestRequestId;
  }

  function beginOlderRequest(state) {
    if (!state.conversationId || !state.hasMore || state.loading || !state.nextCursor) {
      return null;
    }

    state.loading = true;
    state.error = '';
    return {
      ...requestToken(state),
      before: state.nextCursor,
    };
  }

  function applyPageState(state, page) {
    state.nextCursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
    state.hasMore = page.hasMore === true;
    state.loading = false;
    state.error = '';
  }

  function applyInitialPage(state, page) {
    applyPageState(state, page || {});
    return mergeMessages([], page && page.items);
  }

  function applyOlderPage(state, currentMessages, page) {
    applyPageState(state, page || {});
    return mergeMessages(page && page.items, currentMessages);
  }

  function applyLatestPage(_state, currentMessages, page) {
    return mergeMessages(currentMessages, page && page.items);
  }

  function failOlderRequest(state, error) {
    state.loading = false;
    state.error = error && error.message ? String(error.message) : 'Unable to load earlier messages';
  }

  function captureScrollAnchor(scroller) {
    return {
      scrollHeight: Number(scroller && scroller.scrollHeight || 0),
      scrollTop: Number(scroller && scroller.scrollTop || 0),
    };
  }

  function restoreScrollAnchor(scroller, anchor) {
    if (!scroller || !anchor) {
      return;
    }

    const nextScrollHeight = Number(scroller.scrollHeight || 0);
    scroller.scrollTop = anchor.scrollTop + Math.max(0, nextScrollHeight - anchor.scrollHeight);
  }

  function controlView(state) {
    if (!state.conversationId || (!state.hasMore && !state.loading && !state.error)) {
      return {
        hidden: true,
        disabled: true,
        label: '加载更早消息',
        status: '',
      };
    }

    if (state.loading) {
      return {
        hidden: false,
        disabled: true,
        label: '正在加载...',
        status: '',
      };
    }

    if (state.error) {
      return {
        hidden: false,
        disabled: false,
        label: '重试加载',
        status: '更早的消息加载失败',
      };
    }

    return {
      hidden: false,
      disabled: false,
      label: '加载更早消息',
      status: '',
    };
  }

  chat.messageHistory = {
    applyInitialPage,
    applyLatestPage,
    applyOlderPage,
    beginLatestRequest,
    beginOlderRequest,
    captureScrollAnchor,
    controlView,
    createState,
    failOlderRequest,
    isLatestRequestCurrent,
    isRequestCurrent,
    mergeMessages,
    reset,
    restoreScrollAnchor,
  };
})();
