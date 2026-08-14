// @ts-check

(function registerConversationDirectoryModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  function normalizeQuery(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function activityTimestamp(item) {
    const value = item && (item.lastMessageAt || item.updatedAt || item.createdAt);
    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function sortByActivity(items) {
    return (Array.isArray(items) ? items : []).slice().sort((left, right) => {
      const byActivity = activityTimestamp(right) - activityTimestamp(left);
      if (byActivity !== 0) return byActivity;
      return String(right && right.id || '').localeCompare(String(left && left.id || ''));
    });
  }

  function mergeItems(existing, incoming, replace = false) {
    const itemsById = new Map();
    const order = [];

    for (const item of replace ? [] : (Array.isArray(existing) ? existing : [])) {
      if (!item || !item.id || itemsById.has(item.id)) continue;
      itemsById.set(item.id, item);
      order.push(item.id);
    }

    for (const item of Array.isArray(incoming) ? incoming : []) {
      if (!item || !item.id) continue;
      if (!itemsById.has(item.id)) order.push(item.id);
      itemsById.set(item.id, {
        ...(itemsById.get(item.id) || {}),
        ...item,
      });
    }

    return order.map((id) => itemsById.get(id)).filter(Boolean);
  }

  function createState() {
    return {
      items: [],
      query: '',
      nextCursor: null,
      hasMore: false,
      loading: false,
      error: '',
      requestId: 0,
    };
  }

  function applyBootstrap(state, payload) {
    state.items = mergeItems([], payload && payload.conversations, true);
    state.query = normalizeQuery(payload && payload.conversationsQuery);
    state.nextCursor = payload && typeof payload.conversationsNextCursor === 'string'
      ? payload.conversationsNextCursor
      : null;
    state.hasMore = payload && payload.conversationsHasMore === true;
    state.loading = false;
    state.error = '';
    return state;
  }

  function beginRequest(state, query, append = false) {
    const normalizedQuery = normalizeQuery(query);
    if ((append && state.loading) || (append && (!state.hasMore || !state.nextCursor))) {
      return null;
    }

    state.loading = true;
    state.error = '';
    if (!append) {
      state.query = normalizedQuery;
      state.nextCursor = null;
      state.hasMore = false;
    }
    state.requestId += 1;
    return {
      requestId: state.requestId,
      query: normalizedQuery,
      append,
      before: append ? state.nextCursor : null,
    };
  }

  function isRequestCurrent(state, request) {
    return Boolean(request && request.requestId === state.requestId);
  }

  function applyPage(state, page, request) {
    if (!isRequestCurrent(state, request)) return false;

    const payload = page || {};
    state.items = mergeItems(state.items, payload.conversations, !request.append);
    state.query = normalizeQuery(payload.query || request.query);
    state.nextCursor = typeof payload.nextCursor === 'string' && payload.nextCursor
      ? payload.nextCursor
      : null;
    state.hasMore = payload.hasMore === true;
    state.loading = false;
    state.error = '';
    return true;
  }

  function failRequest(state, request, error) {
    if (!isRequestCurrent(state, request)) return false;
    state.loading = false;
    state.error = error && error.message ? String(error.message) : '会话目录加载失败';
    return true;
  }

  function buildUrl(state, request) {
    const params = new URLSearchParams();
    params.set('limit', '50');
    if (request && request.query) params.set('q', request.query);
    if (request && request.append && request.before) params.set('before', request.before);
    return `/api/conversations?${params.toString()}`;
  }

  chat.conversationDirectory = {
    applyBootstrap,
    applyPage,
    beginRequest,
    buildUrl,
    createState,
    failRequest,
    isRequestCurrent,
    mergeItems,
    normalizeQuery,
    sortByActivity,
  };
})();
