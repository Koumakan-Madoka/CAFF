// @ts-check

(function registerConversationDigestPanelModule() {
  const chat = window.CaffChat || (window.CaffChat = {});
  const shared = window.CaffShared || {};
  const digestUtils = shared.conversationDigest;

  if (!digestUtils) {
    throw new Error('CaffShared.conversationDigest helper is required');
  }

  chat.createConversationDigestPanelController = function createConversationDigestPanelController({ state, dom, helpers, showToast }) {
    const { formatDateTime, submitDigestCommand, submitSkillDraftCommand } = helpers;
    const digestSourceLocator = digestUtils.createDigestSourceLocator({ dom, showToast });
    let isDigestOpen = false;
    let isSkillDraftOpen = false;
    let isSaving = false;
    let focusedDigestId = '';

    function setDigestOpen(nextOpen, options = {}) {
      isDigestOpen = Boolean(nextOpen);
      if (isDigestOpen) {
        isSkillDraftOpen = false;
      }
      render();
      if (!options.fromShell && window.caffShell) {
        if (isDigestOpen) {
          window.caffShell.openTab('conversation-digest-drawer');
        } else {
          window.caffShell.releaseTab('conversation-digest-drawer');
        }
      }
    }

    function setSkillDraftOpen(nextOpen, options = {}) {
      isSkillDraftOpen = Boolean(nextOpen);
      if (isSkillDraftOpen) {
        isDigestOpen = false;
      }
      render();
      if (!options.fromShell && window.caffShell) {
        if (isSkillDraftOpen) {
          window.caffShell.openTab('skill-draft-drawer');
        } else {
          window.caffShell.releaseTab('skill-draft-drawer');
        }
      }
    }

    function renderToggleButton(button, hasConversation) {
      if (!button) {
        return;
      }

      button.disabled = !hasConversation;
      button.textContent = isDigestOpen ? '摘要 ◂' : '摘要 ▸';
      button.setAttribute('aria-expanded', isDigestOpen ? 'true' : 'false');
      button.title = digestUtils.formatDigestStatus(state.currentConversation);
    }

    function renderSkillDraftShortcut(button, hasConversation, drafts) {
      const draftCount = Array.isArray(drafts) ? drafts.length : 0;
      const hasDrafts = hasConversation && draftCount > 0;
      if (window.caffShell && typeof window.caffShell.setTabVisible === 'function') {
        window.caffShell.setTabVisible('skill-draft-drawer', hasDrafts, { count: draftCount });
      }
      if (!button) {
        return;
      }

      button.classList.toggle('hidden', !hasDrafts);
      button.disabled = !hasDrafts || isSaving;
      button.textContent = draftCount > 1 ? `Skill 草稿 ${draftCount}` : 'Skill 草稿 1';
      button.setAttribute('aria-expanded', isSkillDraftOpen ? 'true' : 'false');
      button.title = '查看并确认待保存的 Skill 草稿';
    }

    function focusDigestCard(digestId) {
      const normalizedDigestId = String(digestId || '').trim();

      if (!normalizedDigestId || !dom.conversationDigestList) {
        return;
      }

      const card = Array.from(dom.conversationDigestList.querySelectorAll('.conversation-digest-card'))
        .find((candidate) => candidate.dataset.digestId === normalizedDigestId);

      if (!card) {
        return;
      }

      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      card.dataset.digestId = digest.id;
      card.classList.toggle('focused', Boolean(focusedDigestId && digest.id === focusedDigestId));

      const header = document.createElement('div');
      header.className = 'conversation-digest-card-header';

      const titleWrap = document.createElement('div');
      const eyebrow = document.createElement('p');
      eyebrow.className = 'eyebrow';
      const kindLabel = digestUtils.digestKindLabel(digest);
      const kindIcon = window.CaffIcons.create(digest.kind === 'rollup' ? 'archive' : 'file-text', {
        className: 'app-icon digest-kind-icon',
      });
      eyebrow.append(kindIcon, document.createTextNode(`${kindLabel} · ${formatDateTime(digest.createdAt) || 'Digest'}`));

      const range = document.createElement('p');
      range.className = 'muted';
      const sourceCount = digest.kind === 'rollup' && Array.isArray(digest.sourceDigestIds) ? digest.sourceDigestIds.length : 0;
      const sourceText = sourceCount > 0 ? ` · 来自 ${sourceCount} 条详细摘要` : '';
      const rangeText = digestUtils.messageRangeText(digest);
      range.textContent = digest.kind === 'rollup'
        ? `${rangeText || digest.id}${sourceText}`
        : `${rangeText ? `覆盖 ${rangeText}` : digest.id}`;

      const kindHelp = document.createElement('p');
      kindHelp.className = 'muted tiny-meta';
      kindHelp.textContent = digestUtils.digestKindHelp(digest);

      const provenance = document.createElement('p');
      provenance.className = 'muted tiny-meta';
      const provenanceParts = [];
      if (digest.triggerReason) {
        provenanceParts.push(`触发：${digest.triggerReason}`);
      }
      if (digest.createdBy) {
        provenanceParts.push(`来源：${digest.createdBy}`);
      }
      provenance.textContent = provenanceParts.join(' · ');

      titleWrap.append(eyebrow, range, kindHelp);
      if (provenanceParts.length > 0) {
        titleWrap.appendChild(provenance);
      }

      const actions = document.createElement('div');
      actions.className = 'conversation-digest-card-actions';

      const locateButton = document.createElement('button');
      locateButton.className = 'secondary-button compact-icon-button';
      locateButton.type = 'button';
      locateButton.textContent = '定位首条';
      locateButton.disabled = isSaving || !String(digest.messageRange && digest.messageRange.fromMessageId || '').trim();
      locateButton.title = locateButton.disabled
        ? '这条摘要暂时没有可定位的首条消息'
        : '滚动到这条摘要覆盖范围的第一条消息';
      locateButton.addEventListener('click', () => digestSourceLocator.focusSourceMessage(digest));

      const extractButton = document.createElement('button');
      extractButton.className = 'secondary-button compact-icon-button';
      extractButton.type = 'button';
      extractButton.textContent = '提炼 Skill';
      extractButton.disabled = isSaving;
      extractButton.title = '从这条摘要生成待确认的 Skill 草稿';
      extractButton.addEventListener('click', () => submitAction({ action: 'extract-skill', digestId: digest.id }));

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

      actions.append(locateButton, extractButton, deleteButton);
      header.append(titleWrap, actions);

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

    function renderSkillDraftCard(draft) {
      const card = document.createElement('article');
      card.className = 'conversation-digest-card skill-draft-card';

      const header = document.createElement('div');
      header.className = 'conversation-digest-card-header';

      const titleWrap = document.createElement('div');
      const eyebrow = document.createElement('p');
      eyebrow.className = 'eyebrow';
      eyebrow.textContent = draft.source && draft.source.autoCreated ? '自动 Skill 草稿' : 'Skill 草稿';

      const title = document.createElement('p');
      title.className = 'summary-memory-result-title';
      title.textContent = draft.skill.name;

      const meta = document.createElement('p');
      meta.className = 'muted tiny-meta';
      const target = draft.target || { action: 'create' };
      const targetLabel = target.action === 'update'
        ? `目标：融入已有 Skill ${target.skillName || target.skillId || draft.skill.id}`
        : '目标：新建 Skill';
      const metaParts = [`ID：${draft.skill.id}`, targetLabel];
      if (draft.source && draft.source.digestId) {
        metaParts.push(`来源摘要：${draft.source.digestId}`);
      }
      if (draft.source && draft.source.trigger) {
        metaParts.push(`触发：${draft.source.trigger}`);
      }
      if (draft.createdAt) {
        metaParts.push(formatDateTime(draft.createdAt));
      }
      meta.textContent = metaParts.join(' · ');
      titleWrap.append(eyebrow, title, meta);

      const actions = document.createElement('div');
      actions.className = 'conversation-digest-card-actions';

      const confirmButton = document.createElement('button');
      confirmButton.className = 'secondary-button compact-icon-button';
      confirmButton.type = 'button';
      confirmButton.textContent = target.action === 'update' ? '合并' : '保存';
      confirmButton.disabled = isSaving;
      confirmButton.title = target.action === 'update'
        ? '确认后更新当前项目中已有的 .agents/skills/ Skill'
        : '确认后写入当前项目 .agents/skills/';
      confirmButton.addEventListener('click', () => {
        const message = target.action === 'update'
          ? `将经验合并进已有 Skill「${target.skillName || target.skillId || draft.skill.name}」？`
          : `保存 Skill 草稿「${draft.skill.name}」到当前项目？`;
        if (window.confirm(message)) {
          submitDraftAction(draft, 'confirm');
        }
      });

      const rejectButton = document.createElement('button');
      rejectButton.className = 'ghost-button danger compact-icon-button';
      rejectButton.type = 'button';
      rejectButton.textContent = '拒绝';
      rejectButton.disabled = isSaving;
      rejectButton.addEventListener('click', () => {
        if (window.confirm('拒绝并移除这条 Skill 草稿？')) {
          submitDraftAction(draft, 'reject');
        }
      });

      actions.append(confirmButton, rejectButton);
      header.append(titleWrap, actions);

      const description = document.createElement('p');
      description.className = 'conversation-digest-summary';
      description.textContent = draft.skill.description;

      let targetReason = null;
      if (target.action === 'update' && target.reason) {
        targetReason = document.createElement('p');
        targetReason.className = 'muted tiny-meta';
        targetReason.textContent = `合并理由：${target.reason}`;
      }

      const preview = document.createElement('details');
      preview.className = 'skill-draft-preview';
      const summary = document.createElement('summary');
      summary.textContent = '预览草稿内容';
      const body = document.createElement('pre');
      body.textContent = draft.skill.body;
      preview.append(summary, body);

      card.append(...[header, description, targetReason, preview].filter(Boolean));
      return card;
    }

    function renderDigestList() {
      if (!dom.conversationDigestList || !dom.conversationDigestStatus) {
        return;
      }

      const digests = digestUtils.digestsForConversation(state.currentConversation);
      dom.conversationDigestStatus.textContent = digestUtils.formatDigestStatus(state.currentConversation);
      dom.conversationDigestList.innerHTML = '';

      if (digests.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state compact-empty-state';
        empty.textContent = '还没有摘要。点击“生成摘要”或发送 /digest，会创建一条“详细摘要”。';
        dom.conversationDigestList.appendChild(empty);
        return;
      }

      for (const digest of [...digests].reverse()) {
        dom.conversationDigestList.appendChild(renderDigestCard(digest));
      }
    }

    function renderSkillDraftList() {
      if (!dom.skillDraftList || !dom.skillDraftStatus) {
        return;
      }

      const drafts = digestUtils.skillDraftsForConversation(state.currentConversation);
      dom.skillDraftStatus.textContent = drafts.length > 0
        ? `${drafts.length} 个 Skill 草稿待确认`
        : '当前没有待确认草稿';
      dom.skillDraftList.innerHTML = '';

      if (drafts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state compact-empty-state';
        empty.textContent = '还没有 Skill 草稿。可以从摘要卡片点击“提炼 Skill”生成。';
        dom.skillDraftList.appendChild(empty);
        return;
      }

      for (const draft of [...drafts].reverse()) {
        dom.skillDraftList.appendChild(renderSkillDraftCard(draft));
      }
    }

    function render() {
      const hasConversation = Boolean(state.currentConversation);

      if (!hasConversation) {
        isDigestOpen = false;
        isSkillDraftOpen = false;
      }

      const drafts = digestUtils.skillDraftsForConversation(state.currentConversation);
      renderToggleButton(dom.conversationDigestToggleButton, hasConversation);
      renderSkillDraftShortcut(dom.skillDraftToggleButton, hasConversation, drafts);

      if (dom.conversationDigestCreateButton) {
        dom.conversationDigestCreateButton.disabled = !hasConversation || isSaving;
        dom.conversationDigestCreateButton.textContent = isSaving ? '生成中...' : '生成详细摘要';
      }

      if (dom.conversationDigestCompactButton) {
        const digestCount = digestUtils.digestCount(state.currentConversation);
        const digestCounts = typeof digestUtils.digestCounts === 'function'
          ? digestUtils.digestCounts(state.currentConversation)
          : { entryCount: digestCount };
        dom.conversationDigestCompactButton.disabled = !hasConversation || isSaving || digestCount < 2;
        dom.conversationDigestCompactButton.textContent = isSaving ? '处理中...' : '压缩旧详细摘要';
        dom.conversationDigestCompactButton.title = digestCounts.entryCount > 1
          ? '把旧详细摘要合并为一条压缩总摘要；近期详细摘要会保留。'
          : '需要先生成更多详细摘要，才可能压缩成压缩总摘要。';
      }

      renderDigestList();
      renderSkillDraftList();
    }

    async function submitAction(command) {
      if (!state.currentConversation || isSaving) {
        return;
      }

      isSaving = true;
      render();

      try {
        const result = await submitDigestCommand(state.currentConversation.id, command);
        if (command && command.action === 'extract-skill' && result && result.draft) {
          setSkillDraftOpen(true);
        }
      } catch (error) {
        showToast(error.message);
      } finally {
        isSaving = false;
        render();
      }
    }

    async function submitDraftAction(draft, action) {
      if (!state.currentConversation || isSaving || !draft || !draft.id || typeof submitSkillDraftCommand !== 'function') {
        return;
      }

      isSaving = true;
      render();

      try {
        await submitSkillDraftCommand(state.currentConversation.id, draft.id, action);
      } catch (error) {
        showToast(error.message);
      } finally {
        isSaving = false;
        render();
      }
    }

    function bindEvents() {
      if (dom.conversationDigestToggleButton) {
        dom.conversationDigestToggleButton.addEventListener('click', () => setDigestOpen(!isDigestOpen));
      }

      if (dom.skillDraftToggleButton) {
        dom.skillDraftToggleButton.addEventListener('click', () => openSkillDrafts());
      }

      if (dom.conversationDigestCloseButton) {
        dom.conversationDigestCloseButton.addEventListener('click', () => setDigestOpen(false));
      }

      if (dom.skillDraftCloseButton) {
        dom.skillDraftCloseButton.addEventListener('click', () => setSkillDraftOpen(false));
      }

      if (dom.conversationDigestCreateButton) {
        dom.conversationDigestCreateButton.addEventListener('click', () => submitAction({ action: 'create' }));
      }

      if (dom.conversationDigestCompactButton) {
        dom.conversationDigestCompactButton.addEventListener('click', () => submitAction({ action: 'compact' }));
      }

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && (isDigestOpen || isSkillDraftOpen)) {
          isDigestOpen = false;
          isSkillDraftOpen = false;
          render();
        }
      });

      if (window.caffShell && typeof window.caffShell.onChange === 'function') {
        window.caffShell.onChange(({ open, tab }) => {
          const digestShouldBeOpen = open && tab === 'conversation-digest-drawer';
          const draftShouldBeOpen = open && tab === 'skill-draft-drawer';
          if (digestShouldBeOpen !== isDigestOpen || draftShouldBeOpen !== isSkillDraftOpen) {
            isDigestOpen = digestShouldBeOpen;
            isSkillDraftOpen = draftShouldBeOpen;
            render();
          }
        });
      }
    }

    function openDigest(digestId) {
      if (!state.currentConversation) {
        return;
      }

      focusedDigestId = String(digestId || '').trim();
      setDigestOpen(true);
      window.requestAnimationFrame(() => focusDigestCard(focusedDigestId));
    }

    function openSkillDrafts() {
      if (!state.currentConversation) {
        return;
      }

      setSkillDraftOpen(true);
    }

    return {
      bindEvents,
      openDigest,
      openSkillDrafts,
      render,
    };
  };
})();
