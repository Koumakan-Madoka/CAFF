// @ts-check

(function registerSummaryMemoryPanelModule() {
  const chat = window.CaffChat || (window.CaffChat = {});
  const shared = window.CaffShared || {};
  const memoryUtils = shared.summaryMemory;

  if (!memoryUtils) {
    throw new Error('CaffShared.summaryMemory helper is required');
  }

  chat.createSummaryMemoryPanelController = function createSummaryMemoryPanelController({ state, dom, helpers, showToast }) {
    const { backfillSummaryMemory, formatDateTime, getSummaryMemoryHealth, loadConversation, searchSummaryMemory } = helpers;
    let isOpen = false;
    let isSearching = false;
    let isBackfilling = false;
    let isCheckingHealth = false;
    let lastQuery = '';
    let lastMode = 'idle';
    let lastResults = [];
    let lastDiagnostics = [];
    let lastBackfillSummary = '';
    let lastHealth = null;
    let lastHealthError = '';

    function setOpen(nextOpen) {
      isOpen = Boolean(nextOpen);

      if (isOpen && dom.summaryMemoryQuery && !dom.summaryMemoryQuery.value.trim() && state.currentConversation) {
        dom.summaryMemoryQuery.value = state.currentConversation.title || '';
      }

      render();

      if (isOpen) {
        void refreshHealth();
      }
    }

    async function openWithQuery(query, options = {}) {
      const normalizedQuery = String(query || '').trim();
      setOpen(true);

      if (dom.summaryMemoryQuery) {
        dom.summaryMemoryQuery.value = normalizedQuery;
        dom.summaryMemoryQuery.focus();
      }

      if (normalizedQuery || options.latest) {
        await runSearch({ latest: Boolean(options.latest && !normalizedQuery) });
      }
    }

    function renderToggleButton(button, hasConversation) {
      if (!button) {
        return;
      }

      button.disabled = !hasConversation;
      button.textContent = isOpen ? '记忆 ◂' : '记忆 ▸';
      button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      button.title = '搜索跨会话 / 跨任务摘要经验';
    }

    function appendSection(card, label, items) {
      const normalizedItems = memoryUtils.sectionItems(items);

      if (normalizedItems.length === 0) {
        return;
      }

      const title = document.createElement('h3');
      title.className = 'conversation-digest-section-title';
      title.textContent = label;

      const list = document.createElement('ul');
      list.className = 'conversation-digest-section-list';

      for (const item of normalizedItems) {
        const row = document.createElement('li');
        row.textContent = item;
        list.appendChild(row);
      }

      card.append(title, list);
    }

    function renderResultCard(result) {
      const card = document.createElement('article');
      card.className = 'conversation-digest-card summary-memory-card';

      const header = document.createElement('div');
      header.className = 'conversation-digest-card-header';

      const titleWrap = document.createElement('div');
      const eyebrow = document.createElement('p');
      eyebrow.className = 'eyebrow';
      eyebrow.textContent = `${memoryUtils.kindLabel(result)} · ${formatDateTime(result.segmentUpdatedAt) || 'Memory'}`;

      const title = document.createElement('p');
      title.className = 'summary-memory-result-title';
      title.textContent = memoryUtils.resultTitle(result);

      const meta = document.createElement('p');
      meta.className = 'muted summary-memory-result-meta';
      const parts = [];

      if (result.taskName) {
        parts.push(`任务：${result.taskName}`);
      }

      const rangeText = memoryUtils.messageRangeText(result);
      if (rangeText) {
        parts.push(rangeText);
      }

      if (result.triggerReason) {
        parts.push(`触发：${result.triggerReason}`);
      }

      if (result.createdBy) {
        parts.push(`来源：${result.createdBy}`);
      }

      if (Array.isArray(result.matchedTerms) && result.matchedTerms.length > 0) {
        parts.push(`命中：${result.matchedTerms.join(' / ')}`);
      }

      if (Number.isFinite(result.score)) {
        parts.push(`相关度：${result.score}`);
      }

      meta.textContent = parts.length > 0 ? parts.join(' · ') : result.sourceDigestId;
      titleWrap.append(eyebrow, title, meta);

      const currentConversationId = String(state.currentConversation && state.currentConversation.id || '').trim();
      const sourceConversationId = String(result.conversationId || '').trim();
      const openConversationButton = document.createElement('button');
      openConversationButton.className = 'secondary-button summary-memory-open-button';
      openConversationButton.type = 'button';
      openConversationButton.textContent = sourceConversationId && sourceConversationId === currentConversationId ? '当前会话' : '打开来源会话';
      openConversationButton.disabled = isSearching || !sourceConversationId || sourceConversationId === currentConversationId;
      openConversationButton.title = result.conversationTitle ? `打开来源会话：${result.conversationTitle}` : '打开来源会话';
      openConversationButton.addEventListener('click', async () => {
        if (!sourceConversationId || openConversationButton.disabled || typeof loadConversation !== 'function') {
          return;
        }

        try {
          await loadConversation(sourceConversationId);
          setOpen(false);
          showToast(`已打开来源会话：${result.conversationTitle || sourceConversationId}`);
        } catch (error) {
          showToast(error.message);
        }
      });

      header.append(titleWrap, openConversationButton);

      const summary = document.createElement('p');
      summary.className = 'conversation-digest-summary';
      summary.textContent = result.summary;

      card.append(header, summary);
      appendSection(card, '决策', result.decisions);
      appendSection(card, '事实', result.facts);
      appendSection(card, '未解决问题', result.openQuestions);
      appendSection(card, '下一步', result.nextActions);
      appendSection(card, '产物', result.artifacts);

      return card;
    }

    function healthStatusText() {
      if (isCheckingHealth) {
        return '正在自检记忆层…';
      }

      if (lastHealthError) {
        return `记忆层自检失败：${lastHealthError}`;
      }

      if (!lastHealth) {
        return '记忆层等待自检';
      }

      const segmentCount = Number.parseInt(String(lastHealth.segments && lastHealth.segments.count || '0'), 10) || 0;
      const unsyncedDigestCount = Number.parseInt(String(lastHealth.backfill && lastHealth.backfill.unsyncedDigestCount || '0'), 10) || 0;

      if (lastHealth.status === 'unavailable') {
        const error = lastHealth.search && lastHealth.search.error ? `：${lastHealth.search.error}` : '';
        return `记忆层不可用${error}`;
      }

      if (unsyncedDigestCount > 0) {
        const firstUnsynced = Array.isArray(lastHealth.backfill && lastHealth.backfill.unsyncedDigests)
          ? lastHealth.backfill.unsyncedDigests[0]
          : null;
        const reason = firstUnsynced && firstUnsynced.reason ? `，原因：${firstUnsynced.reason}` : '';
        return `记忆层可用：${segmentCount} 条摘要段，${unsyncedDigestCount} 条旧摘要待回填${reason}`;
      }

      return `记忆层正常：${segmentCount} 条摘要段`;
    }

    function renderHealthBadge() {
      if (!dom.summaryMemoryStatus) {
        return;
      }

      const isWarning = Boolean(lastHealthError || isCheckingHealth || (lastHealth && lastHealth.status !== 'ok'));
      dom.summaryMemoryStatus.classList.toggle('paused', isWarning);
      dom.summaryMemoryStatus.classList.remove('complete');
    }

    function renderResults() {
      if (!dom.summaryMemoryStatus || !dom.summaryMemoryResults) {
        return;
      }

      dom.summaryMemoryResults.innerHTML = '';
      renderHealthBadge();

      if (isSearching) {
        dom.summaryMemoryStatus.textContent = `正在搜索长期经验记忆… · ${healthStatusText()}`;
        return;
      }

      const backfillSuffix = !isBackfilling && lastBackfillSummary ? ` · ${lastBackfillSummary}` : '';
      const healthSuffix = ` · ${healthStatusText()}`;

      if (isBackfilling) {
        dom.summaryMemoryStatus.textContent = '正在回填旧摘要到长期经验记忆柜…';
      }

      if (!lastQuery && lastMode !== 'latest') {
        if (!isBackfilling) {
          dom.summaryMemoryStatus.textContent = `输入关键词搜索跨会话 / 跨任务摘要段；默认排除当前会话。${healthSuffix}${backfillSuffix}`;
        }
        const empty = document.createElement('div');
        empty.className = 'empty-state compact-empty-state';
        empty.textContent = '可以搜任务名、文件名、bug 关键词、决策关键词，或点“最新记忆”先看最近沉淀。';
        dom.summaryMemoryResults.appendChild(empty);
        return;
      }

      const diagnosticText = lastDiagnostics.length > 0 ? ` · ${lastDiagnostics.join('；')}` : '';
      if (!isBackfilling) {
        dom.summaryMemoryStatus.textContent = lastMode === 'latest'
          ? `最新长期经验找到 ${lastResults.length} 条${diagnosticText}${healthSuffix}${backfillSuffix}`
          : `“${lastQuery}” 找到 ${lastResults.length} 条历史经验${diagnosticText}${healthSuffix}${backfillSuffix}`;
      }

      if (lastResults.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state compact-empty-state';
        empty.textContent = lastMode === 'latest'
          ? '还没有可展示的长期经验摘要段。可以先 /digest 或回填旧摘要，咕咕嘎嘎。'
          : '没有搜到匹配的摘要段。换个关键词试试，咕咕嘎嘎。';
        dom.summaryMemoryResults.appendChild(empty);
        return;
      }

      for (const result of lastResults) {
        dom.summaryMemoryResults.appendChild(renderResultCard(result));
      }
    }

    function render() {
      if (!dom.summaryMemoryDrawer || !dom.summaryMemoryToggleButton) {
        return;
      }

      const hasConversation = Boolean(state.currentConversation);

      if (!hasConversation) {
        isOpen = false;
      }

      renderToggleButton(dom.summaryMemoryToggleButton, hasConversation);
      dom.summaryMemoryDrawer.classList.toggle('hidden', !isOpen);
      dom.summaryMemoryDrawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true');

      const isBusy = isSearching || isBackfilling;

      if (dom.summaryMemorySearchButton) {
        dom.summaryMemorySearchButton.disabled = !hasConversation || isBusy;
        dom.summaryMemorySearchButton.textContent = isSearching ? '搜索中...' : '搜索记忆';
      }

      if (dom.summaryMemoryRecentButton) {
        dom.summaryMemoryRecentButton.disabled = !hasConversation || isBusy;
        dom.summaryMemoryRecentButton.textContent = isSearching && lastMode === 'latest' ? '加载中...' : '最新记忆';
      }

      if (dom.summaryMemoryBackfillButton) {
        const memoryUnavailable = Boolean(lastHealth && lastHealth.status === 'unavailable');
        dom.summaryMemoryBackfillButton.disabled = !hasConversation || isBusy || memoryUnavailable || typeof backfillSummaryMemory !== 'function';
        dom.summaryMemoryBackfillButton.textContent = isBackfilling ? '回填中...' : '回填全部旧摘要';
      }

      if (dom.summaryMemoryQuery) {
        dom.summaryMemoryQuery.disabled = !hasConversation || isBusy;
      }

      const useCurrentTask = Boolean(dom.summaryMemoryCurrentTask && dom.summaryMemoryCurrentTask.checked);

      if (dom.summaryMemoryTask) {
        dom.summaryMemoryTask.disabled = !hasConversation || isBusy || useCurrentTask;
        dom.summaryMemoryTask.placeholder = useCurrentTask ? '将自动使用当前 Trellis 任务' : '例如：05-03-conversation-digest';
      }

      if (dom.summaryMemoryCurrentTask) {
        dom.summaryMemoryCurrentTask.disabled = !hasConversation || isBusy;
      }

      if (dom.summaryMemoryConversationTitle) {
        dom.summaryMemoryConversationTitle.disabled = !hasConversation || isBusy;
      }

      if (dom.summaryMemoryUpdatedAfter) {
        dom.summaryMemoryUpdatedAfter.disabled = !hasConversation || isBusy;
      }

      if (dom.summaryMemoryUpdatedBefore) {
        dom.summaryMemoryUpdatedBefore.disabled = !hasConversation || isBusy;
      }

      if (dom.summaryMemoryKind) {
        dom.summaryMemoryKind.disabled = !hasConversation || isBusy;
      }

      if (dom.summaryMemoryIncludeCurrent) {
        dom.summaryMemoryIncludeCurrent.disabled = !hasConversation || isBusy;
      }

      renderResults();
    }

    async function refreshHealth() {
      if (!state.currentConversation || isCheckingHealth || typeof getSummaryMemoryHealth !== 'function') {
        return;
      }

      isCheckingHealth = true;
      lastHealthError = '';
      render();

      try {
        lastHealth = await getSummaryMemoryHealth();
      } catch (error) {
        lastHealth = null;
        lastHealthError = error.message;
      } finally {
        isCheckingHealth = false;
        render();
      }
    }

    async function runSearch(options = {}) {
      if (!state.currentConversation || isSearching || !dom.summaryMemoryQuery) {
        return;
      }

      const query = dom.summaryMemoryQuery.value.trim();
      const latest = Boolean(options.latest && !query);

      if (!query && !latest) {
        showToast('请输入记忆关键词，或点“最新记忆”');
        return;
      }

      lastMode = latest ? 'latest' : 'query';
      isSearching = true;
      render();

      try {
        const result = await searchSummaryMemory({
          query,
          latest,
          limit: 5,
          useCurrentTask: Boolean(dom.summaryMemoryCurrentTask && dom.summaryMemoryCurrentTask.checked),
          taskName: dom.summaryMemoryCurrentTask && dom.summaryMemoryCurrentTask.checked ? '' : (dom.summaryMemoryTask ? dom.summaryMemoryTask.value.trim() : ''),
          sourceKind: dom.summaryMemoryKind ? dom.summaryMemoryKind.value.trim() : '',
          conversationTitle: dom.summaryMemoryConversationTitle ? dom.summaryMemoryConversationTitle.value.trim() : '',
          updatedAfter: dom.summaryMemoryUpdatedAfter ? dom.summaryMemoryUpdatedAfter.value.trim() : '',
          updatedBefore: dom.summaryMemoryUpdatedBefore ? dom.summaryMemoryUpdatedBefore.value.trim() : '',
          includeCurrentConversation: Boolean(dom.summaryMemoryIncludeCurrent && dom.summaryMemoryIncludeCurrent.checked),
        });
        lastQuery = query;
        lastResults = memoryUtils.resultsFromPayload(result);
        lastDiagnostics = memoryUtils.diagnosticsFromPayload(result);
      } catch (error) {
        showToast(error.message);
      } finally {
        isSearching = false;
        render();
      }
    }

    async function submitSearch(event) {
      if (event) {
        event.preventDefault();
      }

      await runSearch();
    }

    async function submitRecent() {
      if (dom.summaryMemoryQuery) {
        dom.summaryMemoryQuery.value = '';
      }

      await runSearch({ latest: true });
    }

    function backfillStatusText(result) {
      const conversationCount = Number.parseInt(String(result && result.conversationCount || '0'), 10) || 0;
      const digestCount = Number.parseInt(String(result && result.digestCount || '0'), 10) || 0;
      const segmentCount = Number.parseInt(String(result && result.segmentCount || '0'), 10) || 0;
      const failedCount = Number.parseInt(String(result && result.failedCount || '0'), 10) || 0;
      const firstFailure = Array.isArray(result && result.failures) ? result.failures[0] : null;
      const failureSuffix = failedCount > 0
        ? `，${failedCount} 条失败${firstFailure && firstFailure.message ? `：${firstFailure.message}` : ''}`
        : '';
      return `已同步 ${segmentCount} 条摘要段（${conversationCount} 个会话 / ${digestCount} 条旧摘要）${failureSuffix}`;
    }

    async function submitBackfill() {
      if (!state.currentConversation || isSearching || isBackfilling || typeof backfillSummaryMemory !== 'function') {
        return;
      }

      if (!window.confirm('回填所有会话里的旧摘要到长期经验搜索？这个操作是幂等的，可以重复执行。')) {
        return;
      }

      isBackfilling = true;
      render();

      try {
        const result = await backfillSummaryMemory();
        lastBackfillSummary = backfillStatusText(result);
        showToast(lastBackfillSummary);
        await refreshHealth();
      } catch (error) {
        showToast(error.message);
      } finally {
        isBackfilling = false;
        render();
      }
    }

    function bindEvents() {
      if (!dom.summaryMemoryDrawer || !dom.summaryMemoryToggleButton) {
        return;
      }

      dom.summaryMemoryToggleButton.addEventListener('click', () => setOpen(!isOpen));

      if (dom.summaryMemoryCloseButton) {
        dom.summaryMemoryCloseButton.addEventListener('click', () => setOpen(false));
      }

      if (dom.summaryMemoryForm) {
        dom.summaryMemoryForm.addEventListener('submit', submitSearch);
      }

      if (dom.summaryMemoryRecentButton) {
        dom.summaryMemoryRecentButton.addEventListener('click', submitRecent);
      }

      if (dom.summaryMemoryBackfillButton) {
        dom.summaryMemoryBackfillButton.addEventListener('click', submitBackfill);
      }

      if (dom.summaryMemoryCurrentTask) {
        dom.summaryMemoryCurrentTask.addEventListener('change', render);
      }

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen) {
          setOpen(false);
        }
      });
    }

    return {
      bindEvents,
      openWithQuery,
      render,
      refreshHealth,
    };
  };
})();
