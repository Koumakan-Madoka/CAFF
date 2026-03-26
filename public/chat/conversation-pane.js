// @ts-check

(function registerConversationPaneModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createConversationPaneRenderer = function createConversationPaneRenderer({ state, dom, helpers }) {
    const {
      activeTurnForConversation,
      agentById,
      canChatInUndercoverConversation,
      clearLiveDraftFinalizingTimer,
      closeMentionMenu,
      conversationTypeLabel,
      isConversationBusy,
      isUndercoverConversation,
      liveDraftIdleMs,
      liveStageLabel,
      renderMessages,
      renderParticipantList,
      renderUndercoverGameCard,
      scheduleConversationPaneRender,
      timelineMessagesForConversation,
      undercoverGameState,
    } = helpers;

    function render() {
      const conversation = state.currentConversation;
      const activeTurn = conversation ? activeTurnForConversation(conversation.id) : null;
      clearLiveDraftFinalizingTimer();

      if (!conversation) {
        dom.conversationTitleDisplay.textContent = '请选择一个会话';

        if (dom.conversationModeBadge) {
          dom.conversationModeBadge.classList.add('hidden');
          dom.conversationModeBadge.textContent = '';
        }

        dom.conversationMeta.textContent = '选择一个房间后，这里会显示参与人格和消息记录。';
        dom.deleteConversationButton.disabled = true;
        renderParticipantList(null);
        renderMessages(null, null);
        dom.composerInput.disabled = true;
        dom.stopButton.disabled = true;
        dom.stopButton.textContent = '停止';
        dom.sendButton.disabled = true;
        dom.composerStatus.textContent = '请选择一个房间开始。';
        closeMentionMenu();
        renderUndercoverGameCard();
        return;
      }

      dom.conversationTitleDisplay.textContent = conversation.title;

      if (dom.conversationModeBadge) {
        dom.conversationModeBadge.classList.toggle('hidden', false);
        dom.conversationModeBadge.textContent = conversationTypeLabel(conversation);
        dom.conversationModeBadge.classList.toggle('game', isUndercoverConversation(conversation));
      }

      const privateCount = Array.isArray(conversation.privateMessages) ? conversation.privateMessages.length : 0;
      const totalMessageCount = timelineMessagesForConversation(conversation).length;
      dom.conversationMeta.textContent =
        privateCount > 0
          ? `${conversation.agents.length} 名人格 / ${totalMessageCount} 条消息（含 ${privateCount} 条私密消息）`
          : `${conversation.agents.length} 名人格 / ${totalMessageCount} 条消息`;

      if (isUndercoverConversation(conversation)) {
        const game = undercoverGameState(conversation);
        const phase = game && game.phase ? game.phase : 'setup';
        const roundNumber = Number.isInteger(game && game.roundNumber) ? game.roundNumber : 1;
        dom.conversationMeta.textContent = `${conversation.agents.length} 名玩家 / ${totalMessageCount} 条消息 / 第 ${roundNumber} 轮 / ${phase}`;
      }

      dom.deleteConversationButton.disabled = state.sending;

      renderParticipantList(conversation);
      renderMessages(conversation, activeTurn);

      const hasAgents = conversation.agents.length > 0;
      const stopRequestInFlight = state.stopRequestConversationIds.has(conversation.id);
      const canStopTurn = Boolean(activeTurn || isConversationBusy(conversation.id));
      const undercoverChatLocked = isUndercoverConversation(conversation) && !canChatInUndercoverConversation(conversation);
      dom.composerInput.disabled = state.sending || !hasAgents || undercoverChatLocked;
      dom.stopButton.disabled = !canStopTurn || stopRequestInFlight || Boolean(activeTurn && activeTurn.stopRequested);
      dom.stopButton.textContent = stopRequestInFlight || (activeTurn && activeTurn.stopRequested) ? '停止中...' : '停止';
      dom.sendButton.disabled = state.sending || !hasAgents || undercoverChatLocked;
      dom.composerInput.placeholder = '输入 @Agent 可将当前消息路由给指定人格。';

      if (isUndercoverConversation(conversation)) {
        dom.composerInput.placeholder = canChatInUndercoverConversation(conversation)
          ? '本局谁是卧底已结束，现在可以继续和房间里的 Agent 对话。'
          : '谁是卧底对局进行中时由后端全自动主持，暂不支持手动发送聊天消息。';
      }

      const activeStages =
        activeTurn && Array.isArray(activeTurn.agents)
          ? activeTurn.agents.filter((agent) => agent.status === 'queued' || agent.status === 'running' || agent.status === 'terminating')
          : [];

      if (activeTurn && activeTurn.stopRequested) {
        const stoppingCount = activeStages.filter((agent) => agent.status === 'running' || agent.status === 'terminating').length;
        dom.composerStatus.textContent =
          stoppingCount > 1
            ? `正在停止 ${stoppingCount} 个活跃人格，后续排队接力不会继续执行。`
            : stoppingCount === 1
              ? '正在停止当前人格，后续排队接力不会继续执行。'
              : '正在停止当前回合，后续排队接力不会继续执行。';
      } else if (activeTurn && activeStages.length > 1) {
        dom.composerStatus.textContent = `${activeStages.length} 名人格正在并行回复。`;
      } else if (activeTurn && activeTurn.currentAgentId) {
        const activeAgent = agentById(activeTurn.currentAgentId);
        const activeStage =
          Array.isArray(activeTurn.agents) && activeTurn.currentAgentId
            ? activeTurn.agents.find((agent) => agent.agentId === activeTurn.currentAgentId) || null
            : null;
        const activeStageText = liveStageLabel(activeStage);
        dom.composerStatus.textContent = activeAgent
          ? activeStage && activeStage.preview
            ? activeStageText === '收尾中'
              ? `${activeAgent.name} 正在收尾下方这条回复。`
              : `${activeAgent.name} 正在实时生成下方回复。`
            : `${activeAgent.name} 正在回复，可用 @Agent 继续接力。`
          : '当前房间正在按显式接力规则路由这一轮。';

        if (
          activeStage &&
          activeStage.status === 'running' &&
          activeStage.preview &&
          activeStage.lastTextDeltaAt &&
          activeStageText === '实时生成中'
        ) {
          const lastTextDeltaMs = new Date(activeStage.lastTextDeltaAt).getTime();

          if (!Number.isNaN(lastTextDeltaMs)) {
            const delayMs = Math.max(0, liveDraftIdleMs - (Date.now() - lastTextDeltaMs)) + 16;
            scheduleConversationPaneRender(delayMs);
          }
        }
      } else if (state.sending) {
        dom.composerStatus.textContent = '当前房间正在路由这一轮消息...';
      } else if (!hasAgents) {
        dom.composerStatus.textContent = '先在右侧为本次对话选择至少一个人格。';
      } else {
        dom.composerStatus.textContent = '可以通过 @Agent 把回合交给指定人格。';
      }

      if (isUndercoverConversation(conversation) && !activeTurn && !state.sending && hasAgents) {
        const game = undercoverGameState(conversation);

        if (!game || game.status === 'setup') {
          dom.composerStatus.textContent = '请先在右侧主持台配置词语并开始全自动新一局。';
        } else if (canChatInUndercoverConversation(conversation)) {
          dom.composerStatus.textContent = '本局流程已结束，现在可以继续和房间里的 Agent 自由对话。';
        } else {
          dom.composerStatus.textContent = `当前阶段：${game.phase || 'setup'}。后端正在自动推进整局流程。`;
        }
      }

      if (!hasAgents || state.sending) {
        closeMentionMenu();
      }

      renderUndercoverGameCard();
    }

    return {
      render,
    };
  };
})();
