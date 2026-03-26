// @ts-check

(function registerMessageTimelineModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createMessageTimelineRenderer = function createMessageTimelineRenderer({ dom, helpers }) {
    const {
      agentById,
      appendHighlightedMessageBody,
      buildAgentAvatarElement,
      displayedMessageBody,
      formatDateTime,
      isPrivateTimelineMessage,
      liveStageForMessage,
      liveStageLabel,
      messageSessionInfo,
      privateRecipientNames,
      timelineMessagesForConversation,
    } = helpers;

    function createMessageCard(message, agents, activeTurn) {
      const card = document.createElement('article');
      const meta = document.createElement('div');
      const sender = document.createElement('span');
      const time = document.createElement('span');
      const body = document.createElement('p');
      const liveHint = document.createElement('div');

      meta.className = 'message-meta';
      sender.className = 'message-sender';
      time.className = 'message-time';
      body.className = 'message-body';
      liveHint.className = 'message-live-hint hidden';

      meta.append(sender, time);
      card.append(meta, body, liveHint);
      syncMessageCard(card, message, agents, activeTurn);

      return card;
    }

    function syncMessageCard(card, message, agents, activeTurn) {
      const agent = message.agentId
        ? (Array.isArray(agents) ? agents.find((item) => item.id === message.agentId) : null) || agentById(message.agentId)
        : null;
      const liveStage = isPrivateTimelineMessage(message) ? null : liveStageForMessage(activeTurn, message.id);
      const liveLabel = liveStageLabel(liveStage);
      const bodyText = displayedMessageBody(message, liveStage);
      const sessionInfo = messageSessionInfo(message);
      const recipients = privateRecipientNames(message);
      const privacyLabel =
        isPrivateTimelineMessage(message) && recipients.length > 0 ? `Private -> ${recipients.join(', ')}` : 'Private';
      const signature = [
        message.id,
        message.role,
        message.senderName || '',
        message.createdAt || '',
        message.status || '',
        bodyText,
        message.errorMessage || '',
        agent && agent.accentColor ? agent.accentColor : '',
        agent && agent.avatarDataUrl ? agent.avatarDataUrl : '',
        liveLabel,
        liveStage && liveStage.status ? liveStage.status : '',
        privacyLabel,
        sessionInfo.sessionPath,
        sessionInfo.sessionName,
        sessionInfo.canExport ? 'exportable' : 'locked',
      ].join('\u001f');

      if (card.dataset.renderSignature === signature) {
        return;
      }

      card.dataset.messageId = message.id;
      card.dataset.renderSignature = signature;
      card.className = `message-card ${message.role}`;
      card.classList.toggle('failed', message.status === 'failed');

      if (agent && agent.accentColor) {
        card.style.setProperty('--agent-color', agent.accentColor);
      } else {
        card.style.removeProperty('--agent-color');
      }

      const sender = card.querySelector('.message-sender');
      const time = card.querySelector('.message-time');
      const body = card.querySelector('.message-body');
      const liveHint = card.querySelector('.message-live-hint');

      sender.textContent = '';

      if (message.role !== 'user' && agent) {
        sender.appendChild(buildAgentAvatarElement(agent, 'tiny'));

        if (message.role === 'assistant') {
          const exportButton = document.createElement('button');
          exportButton.type = 'button';
          exportButton.className = 'message-export-button ghost-button';
          exportButton.dataset.messageId = message.id;
          exportButton.disabled = !sessionInfo.canExport;
          exportButton.textContent = '导出';
          exportButton.title = sessionInfo.canExport ? '导出这条 AI 消息的会话轨迹' : '这条消息的会话轨迹暂时不可导出';
          sender.appendChild(exportButton);
        }
      }

      const senderLabel = document.createElement('span');
      senderLabel.className = 'message-sender-label';
      senderLabel.textContent = message.role === 'user' ? 'You' : message.senderName;
      sender.appendChild(senderLabel);

      if (isPrivateTimelineMessage(message)) {
        const privacyBadge = document.createElement('span');
        privacyBadge.className = 'message-privacy-badge';
        privacyBadge.textContent = privacyLabel;
        sender.appendChild(privacyBadge);
      }

      time.textContent = formatDateTime(message.createdAt);
      body.textContent = '';
      appendHighlightedMessageBody(body, bodyText, agents);

      if (liveHint) {
        const shouldShowLiveHint = Boolean(liveLabel);
        liveHint.textContent = shouldShowLiveHint ? liveLabel : '';
        liveHint.classList.toggle('hidden', !shouldShowLiveHint);
      }

      card.classList.toggle('live-preview', Boolean(liveLabel));
      card.classList.toggle('streaming', liveStage ? liveStage.status === 'running' : message.status === 'streaming');
      card.classList.toggle('queued', liveStage ? liveStage.status === 'queued' : message.status === 'queued');
      card.classList.toggle('terminating', liveStage ? liveStage.status === 'terminating' : false);
    }

    function render(conversation, activeTurn) {
      const messages = timelineMessagesForConversation(conversation);
      const hasMessages = messages.length > 0;

      if (!hasMessages) {
        if (dom.messageList.childElementCount === 1 && dom.messageList.firstElementChild.classList.contains('empty-state')) {
          return;
        }

        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent =
          conversation && conversation.type === 'who_is_undercover'
            ? '开始新一局后，后端会自动推进整局对话。'
            : '发送一条消息，开始多人格讨论。';
        dom.messageList.replaceChildren(empty);
        return;
      }

      const existingCards = Array.from(dom.messageList.querySelectorAll('.message-card'));
      const hasOnlyMessageCards = existingCards.length === dom.messageList.childElementCount;
      const matchesExistingPrefix =
        hasOnlyMessageCards &&
        existingCards.every((card, index) => card.dataset.messageId === (messages[index] ? messages[index].id : undefined));

      if (matchesExistingPrefix && existingCards.length === messages.length) {
        existingCards.forEach((card, index) => {
          syncMessageCard(card, messages[index], conversation.agents, activeTurn);
        });
        return;
      }

      if (matchesExistingPrefix && existingCards.length < messages.length) {
        existingCards.forEach((card, index) => {
          syncMessageCard(card, messages[index], conversation.agents, activeTurn);
        });

        messages.slice(existingCards.length).forEach((message) => {
          dom.messageList.appendChild(createMessageCard(message, conversation.agents, activeTurn));
        });
        return;
      }

      const fragment = document.createDocumentFragment();
      messages.forEach((message) => {
        fragment.appendChild(createMessageCard(message, conversation.agents, activeTurn));
      });
      dom.messageList.replaceChildren(fragment);
    }

    return {
      render,
    };
  };
})();
