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
      isUndercoverConversation,
      isWerewolfConversation,
    } = helpers;
    let collapsedIds = new Set();

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
        const spacer = document.createElement('span');
        spacer.className = 'conversation-tree-toggle-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        return spacer;
      }
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'conversation-tree-toggle';
      toggle.dataset.conversationTreeToggle = row.conversation.id;
      toggle.setAttribute('aria-expanded', String(row.expanded));
      toggle.setAttribute('aria-label', row.expanded ? '折叠子会话' : '展开子会话');
      toggle.textContent = row.expanded ? '−' : '+';
      return toggle;
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
        if (row.depthLimit) listRow.dataset.depthLimit = 'true';

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
        const isGameRoom = isUndercoverConversation(conversation) || isWerewolfConversation(conversation);
        const typeBadge = document.createElement('span');
        typeBadge.className = `conversation-type-badge${isGameRoom ? ' game' : ''}`;
        typeBadge.textContent = conversationTypeLabel(conversation);
        const participants = document.createElement('span');
        participants.textContent = isGameRoom
          ? `${conversation.agentCount || 0} 名玩家`
          : `${conversation.agentCount || 0} 个 Agent`;
        metaLine.append(typeBadge, participants);
        if (isConversationBusy(conversation.id)) {
          const busyBadge = document.createElement('span');
          busyBadge.className = 'mini-badge busy';
          busyBadge.textContent = '处理中';
          metaLine.appendChild(busyBadge);
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

    return { render, toggle };
  };
})();
