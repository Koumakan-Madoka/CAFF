(function registerConversationListModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createConversationListRenderer = function createConversationListRenderer({ state, dom, helpers }) {
    const {
      conversationPreviewText,
      conversationTypeLabel,
      formatDateTime,
      isConversationBusy,
      isUndercoverConversation,
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
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '还没有会话，先创建一个。';
        dom.conversationList.appendChild(empty);
        return;
      }

      state.conversations.forEach((conversation) => {
        const item = document.createElement('div');
        item.className = 'conversation-item';
        item.dataset.id = conversation.id;
        item.classList.toggle('active', conversation.id === state.selectedConversationId);
        item.classList.toggle('busy', isConversationBusy(conversation.id));

        const titleLine = document.createElement('div');
        titleLine.className = 'conversation-title-line';

        const title = document.createElement('strong');
        title.textContent = conversation.title;

        const typeBadge = document.createElement('span');
        typeBadge.className = `conversation-type-badge${isUndercoverConversation(conversation) ? ' game' : ''}`;
        typeBadge.textContent = conversationTypeLabel(conversation);

        const badge = document.createElement('span');
        badge.className = `mini-badge${isConversationBusy(conversation.id) ? ' busy' : ''}`;
        badge.textContent = isConversationBusy(conversation.id)
          ? '处理中'
          : `${conversation.agentCount || 0}A / ${conversation.messageCount || 0}M`;
        titleLine.append(title, typeBadge, badge);

        const preview = document.createElement('p');
        preview.className = 'conversation-preview';
        preview.textContent =
          conversationPreviewText(conversation.lastMessagePreview || '') ||
          ((conversation.messageCount || 0) > 0 ? '[silent reply]' : '新的协作房间，等待第一条消息。');

        const footer = document.createElement('div');
        footer.className = 'section-row';

        const updated = document.createElement('span');
        updated.className = 'muted';
        updated.textContent = conversation.lastMessageAt ? formatDateTime(conversation.lastMessageAt) : '尚未开始';

        const participants = document.createElement('span');
        participants.className = 'muted';
        participants.textContent = isUndercoverConversation(conversation)
          ? `${conversation.agentCount || 0} 名玩家`
          : `${conversation.agentCount || 0} 个 Agent`;

        footer.append(updated, participants);
        item.append(titleLine, preview, footer);
        dom.conversationList.appendChild(item);
      });

      dom.conversationList.scrollTop = previousScrollTop;
    }

    return {
      render,
    };
  };
})();
