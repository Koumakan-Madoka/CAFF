// @ts-check

(function registerRoutingPreviewModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  // Server returns raw enums (server/domain/conversation/turn/initial-target-resolution.ts);
  // all user-facing wording maps live here so the preview bar and the sent-message
  // annotation stay consistent.
  const STRATEGY_LABELS = {
    directed: '指定目标',
    user_mentions: 'mention 命中',
    default_last_agent: '跟随最近回复者',
    default_first_agent: '默认首位参与者',
  };

  function strategyLabel(strategy) {
    const code = String(strategy || '').trim();
    return STRATEGY_LABELS[code] || '';
  }

  function executionModeLabel(mode) {
    const code = String(mode || '').trim();

    if (code === 'parallel') {
      return '并行执行';
    }

    if (code === 'queue') {
      return '排队执行';
    }

    return code ? '串行执行' : '';
  }

  function explicitIntentLabel(intent) {
    const code = String(intent || '').trim().toLowerCase();

    if (code === 'ideate' || code === 'execute') {
      return `#${code}`;
    }

    return '';
  }

  function previewTargetNames(preview) {
    const agents = Array.isArray(preview && preview.agents) ? preview.agents : [];
    return agents
      .map((agent) => String((agent && agent.name) || (agent && agent.id) || '').trim())
      .filter(Boolean);
  }

  function previewBarText(preview) {
    const names = previewTargetNames(preview);

    if (names.length === 0) {
      return '';
    }

    const segments = [
      names.length > 1 ? `将唤醒 ${names.join('、')}` : `将唤醒 ${names[0]}`,
    ];
    const reason = strategyLabel(preview && preview.strategy);

    if (reason) {
      segments.push(reason);
    }

    const intent = explicitIntentLabel(preview && preview.explicitIntent);

    if (intent) {
      segments.push(intent);
    }

    const mode = executionModeLabel(preview && preview.executionMode);

    if (mode) {
      segments.push(mode);
    }

    return segments.join(' · ');
  }

  // Sent-message annotation. The annotation reflects the accept-time routing that was
  // persisted in metadata.routing; a side dispatch (busy conversation) overrides the
  // displayed target because that is what actually ran.
  function routingAnnotationForMessage(message, agentById) {
    const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    const routing = metadata && metadata.routing && typeof metadata.routing === 'object' ? metadata.routing : null;

    if (!routing) {
      return null;
    }

    const resolveName = (agentId) => {
      const id = String(agentId || '').trim();
      const agent = id && typeof agentById === 'function' ? agentById(id) : null;
      return String((agent && agent.name) || id).trim();
    };

    const dispatchTargetAgentId = metadata ? String(metadata.dispatchTargetAgentId || '').trim() : '';

    if (metadata && metadata.dispatchLane === 'side' && dispatchTargetAgentId) {
      return {
        lane: 'side',
        text: `已路由 → ${resolveName(dispatchTargetAgentId)} · 旁路派发`,
      };
    }

    const agentIds = Array.isArray(routing.agentIds)
      ? routing.agentIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];

    if (agentIds.length === 0) {
      return null;
    }

    const segments = [`已路由 → ${agentIds.map(resolveName).join('、')}`];
    const reason = strategyLabel(routing.strategy);

    if (reason) {
      segments.push(reason);
    }

    const intent = explicitIntentLabel(routing.explicitIntent);

    if (intent) {
      segments.push(intent);
    }

    const mode = executionModeLabel(routing.executionMode);

    if (mode) {
      segments.push(mode);
    }

    return {
      lane: 'main',
      text: segments.join(' · '),
    };
  }

  chat.routingPreview = {
    strategyLabel,
    executionModeLabel,
    explicitIntentLabel,
    previewBarText,
    routingAnnotationForMessage,
  };

  chat.createRoutingPreviewController = function createRoutingPreviewController({ dom, helpers }) {
    const input = dom && dom.composerInput ? dom.composerInput : null;
    const bar = dom && dom.routingPreview ? dom.routingPreview : null;
    const getConversationId = helpers && typeof helpers.getConversationId === 'function'
      ? helpers.getConversationId
      : () => '';
    const fetchPreview = helpers && typeof helpers.fetchPreview === 'function' ? helpers.fetchPreview : null;
    const debounceMs = Math.max(0, Number(helpers && helpers.debounceMs) || 300);

    let debounceTimer = null;
    // Monotonic version guarding against out-of-order responses: a response is only
    // rendered when its version is still the latest AND the captured conversation id
    // and draft text both still match the live composer state.
    let draftVersion = 0;

    function hideBar() {
      if (bar) {
        bar.textContent = '';
        bar.classList.add('hidden');
      }
    }

    function cancelPendingFetch() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    }

    function currentDraft() {
      return input ? String(input.value || '') : '';
    }

    function currentConversationId() {
      return String(getConversationId() || '').trim();
    }

    function isPreviewable(conversationId, content) {
      return Boolean(
        conversationId
          && content.trim()
          && input
          && !input.disabled
          && fetchPreview
      );
    }

    async function runPreview(conversationId, content, version) {
      try {
        const preview = await fetchPreview(conversationId, content);

        if (version !== draftVersion) {
          return;
        }

        if (conversationId !== currentConversationId() || currentDraft() !== content) {
          return;
        }

        const text = previewBarText(preview);

        if (!text) {
          hideBar();
          return;
        }

        if (bar) {
          bar.textContent = text;
          bar.classList.remove('hidden');
        }
      } catch (_error) {
        // Preview is best-effort; never surface routing-preview errors to the user.
        if (version === draftVersion) {
          hideBar();
        }
      }
    }

    function scheduleRefresh() {
      draftVersion += 1;
      cancelPendingFetch();

      const conversationId = currentConversationId();
      const content = currentDraft();

      if (!isPreviewable(conversationId, content)) {
        hideBar();
        return;
      }

      const version = draftVersion;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void runPreview(conversationId, content, version);
      }, debounceMs);
    }

    // Immediate refresh used when conversation state moved (e.g. an assistant reply
    // completed and default_last_agent may now point at a different agent).
    function refreshNow() {
      draftVersion += 1;
      cancelPendingFetch();

      const conversationId = currentConversationId();
      const content = currentDraft();

      if (!isPreviewable(conversationId, content)) {
        hideBar();
        return;
      }

      void runPreview(conversationId, content, draftVersion);
    }

    // The composer value can change without an input event (programmatic clears and
    // restores via caffShell.setComposerValue); call sites use this to stay in sync.
    function syncDraft() {
      scheduleRefresh();
    }

    function bindEvents() {
      if (input) {
        input.addEventListener('input', () => {
          scheduleRefresh();
        });
      }
    }

    hideBar();

    return {
      bindEvents,
      refreshNow,
      scheduleRefresh,
      syncDraft,
    };
  };
})();
