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
      if (!row.hasChildren) return null;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'conversation-tree-toggle';
      toggle.dataset.conversationTreeToggle = row.conversation.id;
      toggle.setAttribute('aria-expanded', String(row.expanded));
      toggle.setAttribute('aria-label', row.expanded ? '折叠子会话' : '展开子会话');
      toggle.textContent = row.expanded ? '−' : '+';
      return toggle;
    }

    function createRenameButton(row) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'conversation-rename-button';
      button.dataset.renameConversationId = row.conversation.id;
      button.textContent = '\u270e';
      button.setAttribute('aria-label', `\u91cd\u547d\u540d\u201c${row.conversation.title}\u201d`);
      button.title = '\u91cd\u547d\u540d\uff08\u624b\u52a8\u6807\u9898\u4e0d\u4f1a\u88ab\u81ea\u52a8\u6807\u9898\u8986\u76d6\uff09';
      return button;
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

    function createSpawnButton(row) {
      if (row.depthLimit) return null;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'conversation-spawn-button';
      button.dataset.parentConversationId = row.conversation.id;
      button.textContent = '+';
      button.setAttribute('aria-label', `从“${row.conversation.title}”派生子会话`);
      if (!row.canSpawn) {
        button.disabled = true;
        button.title = '先在会话设置中绑定项目，才能派生子会话';
      } else {
        button.title = '派生子会话';
      }
      return button;
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
        const toggle = createToggle(row);
        if (toggle) listRow.appendChild(toggle);
        listRow.appendChild(createRenameButton(row));
        const spawnButton = createSpawnButton(row);
        if (spawnButton) listRow.appendChild(spawnButton);
        dom.conversationList.appendChild(listRow);
      });

      dom.conversationList.scrollTop = previousScrollTop;
    }

    function toggle(conversationId) {
      const id = String(conversationId || '').trim();
      if (!id) return;
      if (collapsedIds.has(id)) collapsedIds.delete(id);
      else collapsedIds.add(id);
      dom.conversationList.dataset.renderSignature = '';
      render();
    }

    function startRename(conversationId) {
      const id = String(conversationId || '').trim();
      if (!id) return;
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

    return { render, toggle, startRename, cancelRename };
  };
})();
