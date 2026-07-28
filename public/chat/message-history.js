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

  function scrollTarget(scroller) {
    if (!scroller) {
      return null;
    }

    const scrollHeight = Number(scroller.scrollHeight || 0);
    const clientHeight = Number(scroller.clientHeight);

    if (!Number.isFinite(clientHeight) || clientHeight <= 0 || scrollHeight > clientHeight + 1) {
      return scroller;
    }

    const ownerDocument = scroller.ownerDocument;
    return ownerDocument && (ownerDocument.scrollingElement || ownerDocument.documentElement) || scroller;
  }

  function setScrollTopInstantly(scroller, value) {
    if (!scroller) {
      return;
    }

    const inlineStyle = scroller.style;
    const previousScrollBehavior = inlineStyle && inlineStyle.scrollBehavior;

    if (inlineStyle) {
      inlineStyle.scrollBehavior = 'auto';
    }

    scroller.scrollTop = Math.max(0, Number(value || 0));

    if (inlineStyle) {
      inlineStyle.scrollBehavior = previousScrollBehavior;
    }
  }

  function captureScrollAnchor(scroller) {
    const target = scrollTarget(scroller);
    return {
      scrollHeight: Number(target && target.scrollHeight || 0),
      scrollTop: Number(target && target.scrollTop || 0),
    };
  }

  function restoreScrollAnchor(scroller, anchor) {
    const target = scrollTarget(scroller);

    if (!target || !anchor) {
      return;
    }

    const nextScrollHeight = Number(target.scrollHeight || 0);
    setScrollTopInstantly(target, anchor.scrollTop + Math.max(0, nextScrollHeight - anchor.scrollHeight));
  }

  function scrollToBottom(scroller) {
    const target = scrollTarget(scroller);

    if (!target) {
      return;
    }

    if (target === scroller) {
      setScrollTopInstantly(target, Number(target.scrollHeight || 0));
      return;
    }

    const ownerDocument = scroller.ownerDocument;
    const viewportHeight = Number(
      ownerDocument && ownerDocument.defaultView && ownerDocument.defaultView.innerHeight || target.clientHeight || 0
    );
    const bounds = typeof scroller.getBoundingClientRect === 'function'
      ? scroller.getBoundingClientRect()
      : null;
    const bottom = Number(bounds && bounds.bottom || 0);
    setScrollTopInstantly(target, Number(target.scrollTop || 0) + bottom - viewportHeight);
  }

  function isNearBottom(scroller, threshold = 72) {
    const target = scrollTarget(scroller);

    if (!target) {
      return false;
    }

    if (target === scroller) {
      const distanceFromBottom = Number(target.scrollHeight || 0) -
        Number(target.scrollTop || 0) -
        Number(target.clientHeight || 0);
      return distanceFromBottom < threshold;
    }

    const ownerDocument = scroller.ownerDocument;
    const viewportHeight = Number(
      ownerDocument && ownerDocument.defaultView && ownerDocument.defaultView.innerHeight || target.clientHeight || 0
    );
    const bounds = typeof scroller.getBoundingClientRect === 'function'
      ? scroller.getBoundingClientRect()
      : null;
    return Number(bounds && bounds.bottom || 0) - viewportHeight < threshold;
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
    isNearBottom,
    isRequestCurrent,
    mergeMessages,
    reset,
    restoreScrollAnchor,
    scrollToBottom,
  };
})();
