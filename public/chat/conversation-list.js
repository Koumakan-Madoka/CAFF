// @ts-check

(function registerConversationListModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createConversationListRenderer = function createConversationListRenderer({ state, dom, helpers }) {
    const {
      conversationPreviewText,
      conversationTypeLabel,
      formatDateTime,
      isConversationBusy,
      isUndercoverConversation,
      isWerewolfConversation,
    } = helpers;

    function render() {
      const signature =
        state.conversations.length === 0
          ? 'empty'
          : state.conversations
              .map((conversation) =>
                [
                  conversation.id,
                  conversation.type || 'standard',
                  conversation.title,
                  conversation.agentCount || 0,
                  conversation.messageCount || 0,
                  JSON.stringify(conversation.metadata || {}),
                  conversationPreviewText(conversation.lastMessagePreview || ''),
                  conversation.lastMessageAt || '',
                  conversation.id === state.selectedConversationId ? 'selected' : '',
                  isConversationBusy(conversation.id) ? 'busy' : '',
                ].join('\u001f')
              )
              .join('\u001e');

      if (dom.conversationList.dataset.renderSignature === signature) {
        return;
      }

      dom.conversationList.dataset.renderSignature = signature;
      const previousScrollTop = dom.conversationList.scrollTop;
      dom.conversationList.innerHTML = '';

      if (state.conversations.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty-state';
        empty.textContent = '还没有会话，先创建一个。';
        dom.conversationList.appendChild(empty);
        return;
      }

      state.conversations.forEach((conversation) => {
        const row = document.createElement('li');
        row.className = 'conversation-list-row';

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

        const updated = document.createElement('span');
        updated.textContent = conversation.lastMessageAt ? formatDateTime(conversation.lastMessageAt) : '尚未开始';

        metaLine.append(typeBadge, participants, updated);

        if (isConversationBusy(conversation.id)) {
          const busyBadge = document.createElement('span');
          busyBadge.className = 'mini-badge busy';
          busyBadge.textContent = '处理中';
          metaLine.appendChild(busyBadge);
        }

        item.append(titleLine, metaLine);
        row.appendChild(item);
        dom.conversationList.appendChild(row);
      });

      dom.conversationList.scrollTop = previousScrollTop;
    }

    return {
      render,
    };
  };
})();
