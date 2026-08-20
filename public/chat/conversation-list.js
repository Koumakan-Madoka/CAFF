// @ts-check

(function registerConversationListModule() {
  const chat = window.CaffChat || (window.CaffChat = {});
  const crossConversationUi = chat.crossConversationUi;

  if (!crossConversationUi) {
    throw new Error('CaffChat.crossConversationUi helper is required');
  }

  chat.createConversationListRenderer = function createConversationListRenderer({ state, dom, helpers }) {
    const {
      conversationTypeLabel,
      isConversationBusy,
    } = helpers;
    let collapsedIds = new Set();
    let renamingConversationId = '';
    let openActionsConversationId = '';

    function compactStatus(conversation) {
      if (!conversation || !conversation.crossConversationStatus) return null;
      const status = crossConversationUi.deliveryView(conversation.crossConversationStatus);
      if (!status.live && !status.failed) return null;
      return status;
    }

    function signatureForRows(rows) {
      if (rows.length === 0) return 'empty';
      return rows.map((row) => {
        const conversation = row.conversation;
        const status = compactStatus(conversation);
        return [
          conversation.id,
          conversation.title,
          conversation.type || 'standard',
          conversation.agentCount || 0,
          conversation.messageCount || 0,
          conversation.lastMessageAt || '',
          row.depth,
          row.expanded ? 'expanded' : 'collapsed',
          row.hasChildren ? 'parent' : 'leaf',
          row.canSpawn ? 'spawn' : row.depthLimit ? 'depth-limit' : 'spawn-blocked',
          conversation.id === state.selectedConversationId ? 'selected' : '',
          isConversationBusy(conversation.id) ? 'busy' : '',
          status ? `${status.key}:${status.label}` : '',
        ].join('\u001f');
      }).join('\u001e');
    }

    function createToggle(row) {
      if (!row.hasChildren) {
        const marker = document.createElement('span');
        marker.className = 'conversation-tree-guide conversation-tree-leaf-marker';
        marker.setAttribute('aria-hidden', 'true');
        return marker;
      }
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'conversation-tree-guide conversation-tree-toggle';
      toggle.dataset.conversationTreeToggle = row.conversation.id;
      toggle.setAttribute('aria-expanded', String(row.expanded));
      toggle.setAttribute('aria-label', row.expanded ? '折叠子会话' : '展开子会话');
      const caret = document.createElement('span');
      caret.className = 'conversation-tree-caret';
      caret.setAttribute('aria-hidden', 'true');
      toggle.appendChild(caret);
      return toggle;
    }

    function createActionMenu(row) {
      const conversation = row.conversation;
      const isOpen = openActionsConversationId === conversation.id;
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'conversation-actions-trigger';
      trigger.dataset.conversationActionsId = conversation.id;
      trigger.setAttribute('aria-label', `“${conversation.title}”的更多操作`);
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', String(isOpen));
      trigger.setAttribute('aria-controls', `conversation-actions-menu-${conversation.id}`);
      trigger.title = '更多操作';
      const dots = document.createElement('span');
      dots.className = 'conversation-actions-dots';
      dots.setAttribute('aria-hidden', 'true');
      dots.textContent = '⋯';
      trigger.appendChild(dots);

      const menu = document.createElement('div');
      menu.id = `conversation-actions-menu-${conversation.id}`;
      menu.className = 'conversation-actions-menu';
      menu.dataset.conversationActionsMenu = conversation.id;
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', `“${conversation.title}”的操作`);
      menu.hidden = !isOpen;

      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'conversation-action-menu-item';
      rename.dataset.conversationAction = 'rename';
      rename.dataset.conversationId = conversation.id;
      rename.setAttribute('role', 'menuitem');
      rename.textContent = '重命名';
      menu.appendChild(rename);

      if (!row.depthLimit) {
        const spawn = document.createElement('button');
        spawn.type = 'button';
        spawn.className = 'conversation-action-menu-item';
        spawn.dataset.conversationAction = 'spawn';
        spawn.dataset.conversationId = conversation.id;
        spawn.setAttribute('role', 'menuitem');
        spawn.textContent = '派生子会话';
        if (!row.canSpawn) {
          spawn.disabled = true;
          spawn.title = '先在会话设置中绑定项目，才能派生子会话';
        }
        menu.appendChild(spawn);
      }

      return { trigger, menu };
    }

    function createRenameForm(conversation) {
      const form = document.createElement('form');
      form.className = 'conversation-rename-form';
      form.dataset.renameConversationId = conversation.id;

      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'title';
      input.required = true;
      input.maxLength = 120;
      input.autocomplete = 'off';
      input.value = conversation.title;
      input.setAttribute('aria-label', '\u65b0\u7684\u4f1a\u8bdd\u6807\u9898');

      const save = document.createElement('button');
      save.type = 'submit';
      save.className = 'conversation-rename-save';
      save.textContent = '\u4fdd\u5b58';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'conversation-rename-cancel';
      cancel.dataset.renameCancelId = conversation.id;
      cancel.textContent = '\u53d6\u6d88';

      form.append(input, save, cancel);
      return form;
    }

    function render() {
      const tree = crossConversationUi.buildConversationTree(state.conversations, {
        selectedConversationId: state.selectedConversationId,
        collapsedIds,
        sortMode: 'activity',
      });
      collapsedIds = tree.collapsedIds;
      const directoryState = state.conversationDirectory || {};
      const signature = [
        signatureForRows(tree.rows),
        directoryState.loading ? 'loading' : '',
        directoryState.query || '',
        directoryState.error || '',
        renamingConversationId ? `renaming:${renamingConversationId}` : '',
        openActionsConversationId ? `actions:${openActionsConversationId}` : '',
      ].join('\u001d');
      if (dom.conversationList.dataset.renderSignature === signature) return;

      dom.conversationList.dataset.renderSignature = signature;
      const previousScrollTop = dom.conversationList.scrollTop;
      dom.conversationList.replaceChildren();

      if (tree.rows.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty-state';
        empty.textContent = state.conversationDirectory && state.conversationDirectory.loading
          ? 'Loading conversations…'
          : state.conversationDirectory && state.conversationDirectory.query
            ? 'No matching conversations'
            : '还没有会话，先创建一个。';
        dom.conversationList.appendChild(empty);
        return;
      }

      tree.rows.forEach((row) => {
        const conversation = row.conversation;
        const listRow = document.createElement('li');
        listRow.className = 'conversation-list-row conversation-tree-row';
        listRow.style.setProperty('--tree-depth', String(row.depth));
        listRow.dataset.depth = String(row.depth);
        listRow.dataset.hasChildren = String(row.hasChildren);
        if (row.depthLimit) listRow.dataset.depthLimit = 'true';

        const isRenaming = renamingConversationId === conversation.id;
        if (isRenaming) {
          listRow.classList.add('is-renaming');
        }

        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'conversation-item';
        item.dataset.id = conversation.id;
        item.classList.toggle('active', conversation.id === state.selectedConversationId);
        item.classList.toggle('busy', isConversationBusy(conversation.id));

        const titleLine = document.createElement('div');
        titleLine.className = 'conversation-title-line';
        const title = document.createElement('strong');
        title.textContent = conversation.title;
        titleLine.appendChild(title);

        const status = compactStatus(conversation);
        if (status) {
          const statusBadge = document.createElement('span');
          statusBadge.className = `conversation-tree-status ${status.tone}${status.live ? ' live' : ''}`;
          statusBadge.textContent = status.label;
          titleLine.appendChild(statusBadge);
        }

        const metaLine = document.createElement('div');
        metaLine.className = 'conversation-meta-line';
        const typeBadge = document.createElement('span');
        typeBadge.className = 'conversation-type-badge';
        typeBadge.textContent = conversationTypeLabel(conversation);
        const participants = document.createElement('span');
        participants.className = 'conversation-participants';
        participants.textContent = `${conversation.agentCount || 0} 个 Agent`;
        metaLine.append(typeBadge, participants);
        if (isConversationBusy(conversation.id)) {
          const busyBadge = document.createElement('span');
          busyBadge.className = 'mini-badge busy';
          busyBadge.textContent = '处理中';
          metaLine.appendChild(busyBadge);
        }

        if (isRenaming) {
          const renameForm = createRenameForm(conversation);
          listRow.appendChild(renameForm);
          dom.conversationList.appendChild(listRow);
          const renameInput = /** @type {HTMLInputElement | null} */ (renameForm.querySelector('input[name="title"]'));
          if (renameInput) {
            renameInput.focus();
            renameInput.select();
          }
          return;
        }

        item.append(titleLine, metaLine);
        if (row.depthLimit) {
          const depthHint = document.createElement('span');
          depthHint.className = 'conversation-depth-limit-hint';
          depthHint.textContent = '已达最大层级，请新建根聊天室';
          item.appendChild(depthHint);
        }
        listRow.appendChild(item);
        listRow.appendChild(createToggle(row));
        const actions = createActionMenu(row);
        listRow.append(actions.trigger, actions.menu);
        dom.conversationList.appendChild(listRow);
      });

      dom.conversationList.scrollTop = previousScrollTop;
    }

    function toggle(conversationId) {
      const id = String(conversationId || '').trim();
      if (!id) return;
      openActionsConversationId = '';
      if (collapsedIds.has(id)) collapsedIds.delete(id);
      else collapsedIds.add(id);
      dom.conversationList.dataset.renderSignature = '';
      render();
    }

    function syncActionsDom() {
      const triggers = dom.conversationList.querySelectorAll('.conversation-actions-trigger');
      triggers.forEach((trigger) => {
        const id = trigger.dataset.conversationActionsId || '';
        trigger.setAttribute('aria-expanded', String(id === openActionsConversationId));
      });
      const menus = dom.conversationList.querySelectorAll('.conversation-actions-menu');
      menus.forEach((menu) => {
        const id = menu.dataset.conversationActionsMenu || '';
        menu.hidden = id !== openActionsConversationId;
      });
    }

    function toggleActions(conversationId) {
      const id = String(conversationId || '').trim();
      if (!id) return;
      const opening = openActionsConversationId !== id;
      openActionsConversationId = opening ? id : '';
      dom.conversationList.dataset.renderSignature = '';
      syncActionsDom();
      const selector = opening
        ? `[data-conversation-actions-menu="${id}"] [role="menuitem"]:not(:disabled)`
        : `[data-conversation-actions-id="${id}"]`;
      const focusTarget = /** @type {HTMLElement | null} */ (dom.conversationList.querySelector(selector));
      if (focusTarget) focusTarget.focus();
    }

    function closeActions(options = {}) {
      if (!openActionsConversationId) return;
      const closingId = openActionsConversationId;
      openActionsConversationId = '';
      dom.conversationList.dataset.renderSignature = '';
      syncActionsDom();
      if (options.restoreFocus) {
        const trigger = /** @type {HTMLElement | null} */ (
          dom.conversationList.querySelector(`[data-conversation-actions-id="${closingId}"]`)
        );
        if (trigger) trigger.focus();
      }
    }

    function handleActionsFocusOut(event) {
      if (!openActionsConversationId) return;
      const nextTarget = event.relatedTarget;
      const insideActions = nextTarget && typeof nextTarget.closest === 'function'
        ? nextTarget.closest('.conversation-actions-menu, .conversation-actions-trigger')
        : null;
      if (!insideActions) closeActions();
    }

    dom.conversationList.addEventListener('focusout', handleActionsFocusOut);

    function startRename(conversationId) {
      const id = String(conversationId || '').trim();
      if (!id) return;
      openActionsConversationId = '';
      renamingConversationId = id;
      dom.conversationList.dataset.renderSignature = '';
      render();
    }

    function cancelRename() {
      if (!renamingConversationId) return;
      renamingConversationId = '';
      dom.conversationList.dataset.renderSignature = '';
      render();
    }

    return { render, toggle, toggleActions, closeActions, startRename, cancelRename };
  };
})();
