// @ts-check

(function registerConversationPaneModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createConversationPaneRenderer = function createConversationPaneRenderer({ state, dom, helpers }) {
    const {
      activeTurnForConversation,
      activeAgentSlotsForConversation,
      agentById,
      canChatInUndercoverConversation,
      canChatInWerewolfConversation,
      clearLiveDraftFinalizingTimer,
      closeMentionMenu,
      conversationTypeLabel,
      isConversationBusy,
      isUndercoverConversation,
      isWerewolfConversation,
      liveDraftIdleMs,
      liveStageLabel,
      queueFailureForConversation,
      queuedAgentSlotMessageCountForConversation,
      queuedUserMessageCountForConversation,
      renderMessages,
      renderParticipantList,
      renderUndercoverGameCard,
      renderWerewolfGameCard,
      renderSkillTestDesignCard,
      scheduleConversationPaneRender,
      timelineMessagesForConversation,
      undercoverGameState,
      werewolfGameState,
    } = helpers;

    function render() {
      const conversation = state.currentConversation;
      const activeTurn = conversation ? activeTurnForConversation(conversation.id) : null;
      const activeAgentSlots = conversation ? activeAgentSlotsForConversation(conversation.id) : [];
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
        renderMessages(null, null, []);
        dom.composerInput.disabled = true;
        dom.stopButton.disabled = true;
        dom.stopButton.textContent = '停止';
        dom.sendButton.disabled = true;
        dom.composerStatus.textContent = '请选择一个房间开始。';
        closeMentionMenu();
        renderUndercoverGameCard();
        renderWerewolfGameCard();
        renderSkillTestDesignCard();
        return;
      }

      dom.conversationTitleDisplay.textContent = conversation.title;

      if (dom.conversationModeBadge) {
        dom.conversationModeBadge.classList.toggle('hidden', false);
        dom.conversationModeBadge.textContent = conversationTypeLabel(conversation);
        dom.conversationModeBadge.classList.toggle('game', isUndercoverConversation(conversation) || isWerewolfConversation(conversation));
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

      if (isWerewolfConversation(conversation)) {
        const game = werewolfGameState(conversation);
        const phase = game && game.phase ? game.phase : 'setup';
        const roundNumber = Number.isInteger(game && game.roundNumber) ? game.roundNumber : 1;
        dom.conversationMeta.textContent = `${conversation.agents.length} 名玩家 / ${totalMessageCount} 条消息 / 第 ${roundNumber} 轮 / ${phase}`;
      }

      const hasAgents = conversation.agents.length > 0;
      const stopRequestInFlight = state.stopRequestConversationIds.has(conversation.id);
      const queuedUserCount = queuedUserMessageCountForConversation(conversation.id);
      const queuedAgentSlotCount = queuedAgentSlotMessageCountForConversation(conversation.id);
      const queueFailure = queueFailureForConversation(conversation.id);
      const conversationBusy = isConversationBusy(conversation.id);
      dom.deleteConversationButton.disabled =
        state.sending ||
        conversationBusy ||
        Boolean(activeTurn) ||
        activeAgentSlots.length > 0 ||
        stopRequestInFlight ||
        (queuedUserCount > 0 && !queueFailure) ||
        queuedAgentSlotCount > 0;

      renderParticipantList(conversation);
      renderMessages(conversation, activeTurn, activeAgentSlots);

      const canStopTurn = Boolean(activeTurn) || activeAgentSlots.length > 0;
      const queuedUserSuffix = queuedUserCount > 0 ? ` 后面还有 ${queuedUserCount} 条新消息待处理。` : '';
      const undercoverChatLocked = isUndercoverConversation(conversation) && !canChatInUndercoverConversation(conversation);
      const werewolfChatLocked = isWerewolfConversation(conversation) && !canChatInWerewolfConversation(conversation);
      dom.composerInput.disabled = !hasAgents || undercoverChatLocked || werewolfChatLocked;
      dom.stopButton.disabled =
        !canStopTurn || stopRequestInFlight || Boolean(activeTurn && activeTurn.stopRequested) || activeAgentSlots.some((slot) => slot.stopRequested);
      dom.stopButton.textContent =
        stopRequestInFlight || (activeTurn && activeTurn.stopRequested) || activeAgentSlots.some((slot) => slot.stopRequested)
          ? '停止中...'
          : '停止';
      dom.sendButton.disabled = !hasAgents || undercoverChatLocked || werewolfChatLocked;
      dom.composerInput.placeholder = '输入 @Agent 可将当前消息路由给指定人格。';

      if (isUndercoverConversation(conversation)) {
        dom.composerInput.placeholder = canChatInUndercoverConversation(conversation)
          ? '本局谁是卧底已结束，现在可以继续和房间里的 Agent 对话。'
          : '谁是卧底对局进行中时由后端全自动主持，暂不支持手动发送聊天消息。';
      }

      if (isWerewolfConversation(conversation)) {
        dom.composerInput.placeholder = canChatInWerewolfConversation(conversation)
          ? '本局狼人杀已结束，现在可以继续和房间里的 Agent 对话。'
          : '狼人杀对局进行中时由后端全自动主持，暂不支持手动发送聊天消息。';
      }

      const activeStages = []
        .concat(
          activeTurn && Array.isArray(activeTurn.agents)
            ? activeTurn.agents.filter((agent) => agent.status === 'queued' || agent.status === 'running' || agent.status === 'terminating')
            : []
        )
        .concat(
          Array.isArray(activeAgentSlots)
            ? activeAgentSlots.filter((slot) => slot.status === 'queued' || slot.status === 'running' || slot.status === 'terminating')
            : []
        );
      const activeSlotStopRequested = activeAgentSlots.some((slot) => slot.stopRequested);

      if ((activeTurn && activeTurn.stopRequested) || activeSlotStopRequested) {
        const stoppingCount = activeStages.filter((agent) => agent.status === 'running' || agent.status === 'terminating').length;
        dom.composerStatus.textContent =
          stoppingCount > 1
            ? `正在停止 ${stoppingCount} 个活跃人格。${queuedUserCount > 0 ? ` 稍后会继续处理 ${queuedUserCount} 条补充消息。` : ''}`
            : stoppingCount === 1
              ? `正在安全停止当前人格。${queuedUserCount > 0 ? ` 稍后会继续处理 ${queuedUserCount} 条补充消息。` : ''}`
              : `正在安全停止当前回合。${queuedUserCount > 0 ? ` 稍后会继续处理 ${queuedUserCount} 条补充消息。` : ''}`;
      } else if (activeStages.length > 1) {
        dom.composerStatus.textContent = `${activeStages.length} 名人格正在并行回复。${queuedUserSuffix}`;
      } else if ((activeTurn && activeTurn.currentAgentId) || activeAgentSlots[0]) {
        const singleActiveSlot = activeAgentSlots[0] || null;
        const activeAgentId = activeTurn && activeTurn.currentAgentId ? activeTurn.currentAgentId : singleActiveSlot && singleActiveSlot.agentId;
        const activeAgent = activeAgentId ? agentById(activeAgentId) : null;
        const activeStage =
          activeTurn && Array.isArray(activeTurn.agents) && activeTurn.currentAgentId
            ? activeTurn.agents.find((agent) => agent.agentId === activeTurn.currentAgentId) || null
            : singleActiveSlot;
        const activeStageText = liveStageLabel(activeStage);
        dom.composerStatus.textContent = activeAgent
          ? activeStage && activeStage.preview
            ? activeStageText === '收尾中'
              ? `${activeAgent.name} 正在收尾下方这条回复。${queuedUserSuffix}`
              : `${activeAgent.name} 正在实时生成下方回复。${queuedUserSuffix}`
            : `${activeAgent.name} 正在回复。${queuedUserSuffix || ' 可以用 @Agent 继续接力。'}`
          : `当前房间正在按显式接力规则路由这一轮。${queuedUserSuffix}`;

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
      } else if (queuedUserCount > 0 && queueFailure) {
        const failureCount = Math.max(1, Number(queueFailure.failedBatchCount || 0));
        const failureSuffix = queueFailure.lastFailureMessage ? ` 最近一次失败：${queueFailure.lastFailureMessage}` : '';
        dom.composerStatus.textContent = `上一轮续跑失败了 ${failureCount} 次，仍有 ${queuedUserCount} 条消息排队中。继续发送会重试，也可以删除这个对话放弃队列。${failureSuffix}`;
      } else if (queuedUserCount > 0 || queuedAgentSlotCount > 0) {
        if (queuedUserCount > 0 && queuedAgentSlotCount > 0) {
          dom.composerStatus.textContent = `已收到 ${queuedUserCount} 条主队列消息，还有 ${queuedAgentSlotCount} 条按 Agent 排队的消息。`;
        } else if (queuedUserCount > 0) {
          dom.composerStatus.textContent = `已收到 ${queuedUserCount} 条新消息，正在准备下一轮。`;
        } else {
          dom.composerStatus.textContent = `当前还有 ${queuedAgentSlotCount} 条按 Agent 排队的消息等待执行。`;
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

      if (isWerewolfConversation(conversation) && !activeTurn && !state.sending && hasAgents) {
        const game = werewolfGameState(conversation);

        if (!game || game.status === 'setup') {
          dom.composerStatus.textContent = '请先开始全自动新一局狼人杀。';
        } else if (canChatInWerewolfConversation(conversation)) {
          dom.composerStatus.textContent = '本局流程已结束，现在可以继续和房间里的 Agent 自由对话。';
        } else {
          dom.composerStatus.textContent = `当前阶段：${game.phase || 'setup'}。后端正在自动推进整局流程。`;
        }
      }

      if (!hasAgents) {
        closeMentionMenu();
      }

      renderUndercoverGameCard();
      renderWerewolfGameCard();
      renderSkillTestDesignCard();
    }

    return {
      render,
    };
  };
})();
