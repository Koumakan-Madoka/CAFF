// @ts-check

(function registerConversationDigestPanelModule() {
  const chat = window.CaffChat || (window.CaffChat = {});
  const shared = window.CaffShared || {};
  const digestUtils = shared.conversationDigest;

  if (!digestUtils) {
    throw new Error('CaffShared.conversationDigest helper is required');
  }

  chat.createConversationDigestPanelController = function createConversationDigestPanelController({ state, dom, helpers, showToast }) {
    const { formatDateTime, submitDigestCommand } = helpers;
    let isOpen = false;
    let isSaving = false;

    function setOpen(nextOpen) {
      isOpen = Boolean(nextOpen);
      render();
    }

    function renderToggleButton(button, hasConversation) {
      if (!button) {
        return;
      }

      button.disabled = !hasConversation;
      button.textContent = isOpen ? '摘要 ◂' : '摘要 ▸';
      button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      button.title = digestUtils.formatDigestStatus(state.currentConversation);
    }

    function appendSection(card, label, items) {
      const normalizedItems = digestUtils.sectionItems(items);

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

    function renderDigestCard(digest) {
      const card = document.createElement('article');
      card.className = 'conversation-digest-card';

      const header = document.createElement('div');
      header.className = 'conversation-digest-card-header';

      const titleWrap = document.createElement('div');
      const eyebrow = document.createElement('p');
      eyebrow.className = 'eyebrow';
      const kindLabel = digest.kind === 'rollup' ? '压缩摘要' : '摘要条目';
      eyebrow.textContent = `${kindLabel} · ${formatDateTime(digest.createdAt) || 'Digest'}`;

      const range = document.createElement('p');
      range.className = 'muted';
      const sourceCount = digest.kind === 'rollup' && Array.isArray(digest.sourceDigestIds) ? digest.sourceDigestIds.length : 0;
      const sourceText = sourceCount > 0 ? ` · 来自 ${sourceCount} 条摘要` : '';
      range.textContent = `${digestUtils.messageRangeText(digest) || digest.id}${sourceText}`;

      titleWrap.append(eyebrow, range);

      const deleteButton = document.createElement('button');
      deleteButton.className = 'ghost-button danger compact-icon-button';
      deleteButton.type = 'button';
      deleteButton.textContent = '删除';
      deleteButton.disabled = isSaving;
      deleteButton.addEventListener('click', () => {
        if (window.confirm('删除这条会话摘要？')) {
          submitAction({ action: 'delete', digestId: digest.id });
        }
      });

      header.append(titleWrap, deleteButton);

      const summary = document.createElement('p');
      summary.className = 'conversation-digest-summary';
      summary.textContent = digest.summary;

      card.append(header, summary);
      appendSection(card, '决策', digest.decisions);
      appendSection(card, '事实', digest.facts);
      appendSection(card, '未解决问题', digest.openQuestions);
      appendSection(card, '下一步', digest.nextActions);
      appendSection(card, '产物', digest.artifacts);

      return card;
    }

    function renderTimeline() {
      if (!dom.conversationDigestList || !dom.conversationDigestStatus) {
        return;
      }

      const digests = digestUtils.digestsForConversation(state.currentConversation);
      dom.conversationDigestStatus.textContent = digestUtils.formatDigestStatus(state.currentConversation);
      dom.conversationDigestList.innerHTML = '';

      if (digests.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state compact-empty-state';
        empty.textContent = '还没有摘要。点击“生成摘要”或在输入框发送 /digest。';
        dom.conversationDigestList.appendChild(empty);
        return;
      }

      for (const digest of [...digests].reverse()) {
        dom.conversationDigestList.appendChild(renderDigestCard(digest));
      }
    }

    function render() {
      if (!dom.conversationDigestDrawer || !dom.conversationDigestToggleButton) {
        return;
      }

      const hasConversation = Boolean(state.currentConversation);

      if (!hasConversation) {
        isOpen = false;
      }

      renderToggleButton(dom.conversationDigestToggleButton, hasConversation);
      dom.conversationDigestDrawer.classList.toggle('hidden', !isOpen);
      dom.conversationDigestDrawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true');

      if (dom.conversationDigestCreateButton) {
        dom.conversationDigestCreateButton.disabled = !hasConversation || isSaving;
        dom.conversationDigestCreateButton.textContent = isSaving ? '生成中...' : '生成摘要';
      }

      if (dom.conversationDigestCompactButton) {
        const digestCount = digestUtils.digestCount(state.currentConversation);
        dom.conversationDigestCompactButton.disabled = !hasConversation || isSaving || digestCount < 2;
        dom.conversationDigestCompactButton.textContent = isSaving ? '处理中...' : '压缩旧摘要';
      }

      renderTimeline();
    }

    async function submitAction(command) {
      if (!state.currentConversation || isSaving) {
        return;
      }

      isSaving = true;
      render();

      try {
        await submitDigestCommand(state.currentConversation.id, command);
      } catch (error) {
        showToast(error.message);
      } finally {
        isSaving = false;
        render();
      }
    }

    function bindEvents() {
      if (!dom.conversationDigestDrawer || !dom.conversationDigestToggleButton) {
        return;
      }

      dom.conversationDigestToggleButton.addEventListener('click', () => setOpen(!isOpen));

      if (dom.conversationDigestCloseButton) {
        dom.conversationDigestCloseButton.addEventListener('click', () => setOpen(false));
      }

      if (dom.conversationDigestCreateButton) {
        dom.conversationDigestCreateButton.addEventListener('click', () => submitAction({ action: 'create' }));
      }

      if (dom.conversationDigestCompactButton) {
        dom.conversationDigestCompactButton.addEventListener('click', () => submitAction({ action: 'compact' }));
      }

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen) {
          setOpen(false);
        }
      });
    }

    return {
      bindEvents,
      render,
    };
  };
})();
