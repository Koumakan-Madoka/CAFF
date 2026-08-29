// @ts-check

(function registerConversationPaneModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  const shared = window.CaffShared || {};
  const sessionGoalUtils = shared.sessionGoal;
  const digestUtils = shared.conversationDigest;

  if (!sessionGoalUtils) {
    throw new Error('CaffShared.sessionGoal helper is required');
  }

  if (!digestUtils) {
    throw new Error('CaffShared.conversationDigest helper is required');
  }

  chat.createConversationPaneRenderer = function createConversationPaneRenderer({ state, dom, helpers }) {
    const {
      activeTurnForConversation,
      activeAgentSlotsForConversation,
      agentById,
      clearLiveDraftFinalizingTimer,
      closeMentionMenu,
      conversationTypeLabel,
      isConversationBusy,
      digestStatusForConversation,
      liveDraftIdleMs,
      liveStageLabel,
      queueFailureForConversation,
      queuedAgentSlotMessageCountForConversation,
      queuedUserMessageCountForConversation,
      renderMessages,
      renderParticipantList,
      scheduleConversationPaneRender,
      timelineMessagesForConversation,
    } = helpers;

    function renderSkillDraftAlert(conversation) {
      if (!dom.skillDraftAlert) return;
      const drafts = digestUtils.skillDraftsForConversation(conversation);
      const hasDrafts = drafts.length > 0;
      dom.skillDraftAlert.classList.toggle('hidden', !hasDrafts);
      if (dom.skillDraftAlertText) {
        dom.skillDraftAlertText.textContent = hasDrafts
          ? `有 ${drafts.length} 个 Skill 草稿待确认，保存后会写入当前项目技能库。`
          : '没有待确认的 Skill 草稿。';
      }
      if (dom.skillDraftAlertButton) dom.skillDraftAlertButton.disabled = !hasDrafts;
    }

    function render() {
      const conversation = state.currentConversation;
      const activeTurn = conversation ? activeTurnForConversation(conversation.id) : null;
      const activeAgentSlots = conversation ? activeAgentSlotsForConversation(conversation.id) : [];
      clearLiveDraftFinalizingTimer();

      function renderWorkspaceContext(conversation) {
        const branch = conversation && String(conversation.branch || '').trim();
        const worktreePath = conversation && String(conversation.worktreePath || '').trim();
        if (dom.conversationWorkspaceBranch) {
          dom.conversationWorkspaceBranch.textContent = branch || '未绑定 branch';
          dom.conversationWorkspaceBranch.title = branch || '当前 Room 尚未绑定 branch';
          dom.conversationWorkspaceBranch.classList.toggle('is-bound', Boolean(branch));
        }
        if (dom.conversationWorkspacePath) {
          dom.conversationWorkspacePath.textContent = worktreePath || '未绑定 worktree';
          dom.conversationWorkspacePath.title = worktreePath || '当前 Room 尚未绑定 worktree';
          dom.conversationWorkspacePath.classList.toggle('is-bound', Boolean(worktreePath));
        }
        if (dom.conversationWorkspaceContext) {
          dom.conversationWorkspaceContext.classList.toggle('is-bound', Boolean(branch && worktreePath));
          dom.conversationWorkspaceContext.classList.toggle('is-unbound', !(branch && worktreePath));
        }
      }

      if (!conversation) {
        renderWorkspaceContext(null);
        dom.conversationTitleDisplay.textContent = '请选择一个 Room';
        if (dom.conversationModeBadge) {
          dom.conversationModeBadge.classList.add('hidden');
          dom.conversationModeBadge.textContent = '';
        }
        dom.conversationMeta.textContent = '选择一个 Room 后，这里会显示参与角色和消息记录。';
        dom.deleteConversationButton.disabled = true;
        renderParticipantList(null);
        renderSkillDraftAlert(null);
        renderMessages(null, null, []);
        dom.composerInput.disabled = true;
        dom.stopButton.disabled = true;
        dom.stopButton.textContent = '停止';
        dom.sendButton.disabled = true;
        dom.composerStatus.textContent = '请选择一个 Room 开始。';
        closeMentionMenu();
        return;
      }

      renderWorkspaceContext(conversation);
      dom.conversationTitleDisplay.textContent = conversation.title;
      if (dom.conversationModeBadge) {
        dom.conversationModeBadge.classList.remove('hidden', 'game');
        dom.conversationModeBadge.textContent = conversationTypeLabel(conversation);
      }

      const privateCount = Array.isArray(conversation.privateMessages) ? conversation.privateMessages.length : 0;
      const totalMessageCount = timelineMessagesForConversation(conversation).length;
      const conversationMetaText = privateCount > 0
        ? `${conversation.agents.length} 名角色 / ${totalMessageCount} 条消息（含 ${privateCount} 条私密消息）`
        : `${conversation.agents.length} 名角色 / ${totalMessageCount} 条消息`;
      const sessionGoalMeta = sessionGoalUtils.formatInlineStatus(
        sessionGoalUtils.goalForConversation(conversation),
        sessionGoalUtils.proposalForConversation(conversation)
      );
      dom.conversationMeta.textContent = [conversationMetaText, sessionGoalMeta].filter(Boolean).join(' / ');

      const hasAgents = conversation.agents.length > 0;
      const stopRequestInFlight = state.stopRequestConversationIds.has(conversation.id);
      const queuedUserCount = queuedUserMessageCountForConversation(conversation.id);
      const queuedAgentSlotCount = queuedAgentSlotMessageCountForConversation(conversation.id);
      const queueFailure = queueFailureForConversation(conversation.id);
      const conversationBusy = isConversationBusy(conversation.id);
      dom.deleteConversationButton.disabled =
        state.sending || conversationBusy || Boolean(activeTurn) || activeAgentSlots.length > 0 ||
        stopRequestInFlight || (queuedUserCount > 0 && !queueFailure) || queuedAgentSlotCount > 0;

      renderParticipantList(conversation);
      renderSkillDraftAlert(conversation);
      renderMessages(conversation, activeTurn, activeAgentSlots);

      const canStopTurn = Boolean(activeTurn) || activeAgentSlots.length > 0;
      const queuedUserSuffix = queuedUserCount > 0 ? ` 后面还有 ${queuedUserCount} 条新消息待处理。` : '';
      dom.composerInput.disabled = !hasAgents;
      dom.stopButton.disabled =
        !canStopTurn || stopRequestInFlight || Boolean(activeTurn && activeTurn.stopRequested) || activeAgentSlots.some((slot) => slot.stopRequested);
      dom.stopButton.textContent =
        stopRequestInFlight || (activeTurn && activeTurn.stopRequested) || activeAgentSlots.some((slot) => slot.stopRequested)
          ? '停止中...'
          : '停止';
      dom.sendButton.disabled = !hasAgents;
      dom.composerInput.placeholder = '输入 @Agent 可将当前消息路由给指定角色；输入 /goal 设置 Room 目标。';

      const activeStages = []
        .concat(activeTurn && Array.isArray(activeTurn.agents)
          ? activeTurn.agents.filter((agent) => ['queued', 'running', 'terminating'].includes(agent.status))
          : [])
        .concat(Array.isArray(activeAgentSlots)
          ? activeAgentSlots.filter((slot) => ['queued', 'running', 'terminating'].includes(slot.status))
          : []);
      const activeSlotStopRequested = activeAgentSlots.some((slot) => slot.stopRequested);
      const digestStatus = typeof digestStatusForConversation === 'function' ? digestStatusForConversation(conversation.id) : null;

      if (digestStatus && digestStatus.status === 'running') {
        dom.composerStatus.textContent = digestStatus.message || '会话摘要模型正在生成…';
      } else if ((activeTurn && activeTurn.stopRequested) || activeSlotStopRequested) {
        const stoppingCount = activeStages.filter((agent) => agent.status === 'running' || agent.status === 'terminating').length;
        dom.composerStatus.textContent = stoppingCount > 1
          ? `正在停止 ${stoppingCount} 个活跃角色。${queuedUserCount > 0 ? ` 稍后会继续处理 ${queuedUserCount} 条补充消息。` : ''}`
          : stoppingCount === 1
            ? `正在安全停止当前角色。${queuedUserCount > 0 ? ` 稍后会继续处理 ${queuedUserCount} 条补充消息。` : ''}`
            : `正在安全停止当前回合。${queuedUserCount > 0 ? ` 稍后会继续处理 ${queuedUserCount} 条补充消息。` : ''}`;
      } else if (activeStages.length > 1) {
        dom.composerStatus.textContent = `${activeStages.length} 名角色正在并行回复。${queuedUserSuffix}`;
      } else if ((activeTurn && activeTurn.currentAgentId) || activeAgentSlots[0]) {
        const singleActiveSlot = activeAgentSlots[0] || null;
        const activeAgentId = activeTurn && activeTurn.currentAgentId ? activeTurn.currentAgentId : singleActiveSlot && singleActiveSlot.agentId;
        const activeAgent = activeAgentId ? agentById(activeAgentId) : null;
        const activeStage = activeTurn && Array.isArray(activeTurn.agents) && activeTurn.currentAgentId
          ? activeTurn.agents.find((agent) => agent.agentId === activeTurn.currentAgentId) || null
          : singleActiveSlot;
        const activeStageText = liveStageLabel(activeStage);
        dom.composerStatus.textContent = activeAgent
          ? activeStage && activeStage.preview
            ? activeStageText === '收尾中'
              ? `${activeAgent.name} 正在收尾下方这条回复。${queuedUserSuffix}`
              : `${activeAgent.name} 正在实时生成下方回复。${queuedUserSuffix}`
            : `${activeAgent.name} 正在回复。${queuedUserSuffix || ' 可以用 @Agent 继续接力。'}`
          : `当前 Room 正在按显式接力规则路由这一轮。${queuedUserSuffix}`;

        if (activeStage && activeStage.status === 'running' && activeStage.preview && activeStage.lastTextDeltaAt && activeStageText === '实时生成中') {
          const lastTextDeltaMs = new Date(activeStage.lastTextDeltaAt).getTime();
          if (!Number.isNaN(lastTextDeltaMs)) {
            scheduleConversationPaneRender(Math.max(0, liveDraftIdleMs - (Date.now() - lastTextDeltaMs)) + 16);
          }
        }
      } else if (queuedUserCount > 0 && queueFailure) {
        const failureCount = Math.max(1, Number(queueFailure.failedBatchCount || 0));
        const failureSuffix = queueFailure.lastFailureMessage ? ` 最近一次失败：${queueFailure.lastFailureMessage}` : '';
        dom.composerStatus.textContent = `上一轮续跑失败了 ${failureCount} 次，仍有 ${queuedUserCount} 条消息排队中。继续发送会重试，也可以删除这个 Room 放弃队列。${failureSuffix}`;
      } else if (queuedUserCount > 0 || queuedAgentSlotCount > 0) {
        dom.composerStatus.textContent = queuedUserCount > 0 && queuedAgentSlotCount > 0
          ? `已收到 ${queuedUserCount} 条主队列消息，还有 ${queuedAgentSlotCount} 条按 Agent 排队的消息。`
          : queuedUserCount > 0
            ? `已收到 ${queuedUserCount} 条新消息，正在准备下一轮。`
            : `当前还有 ${queuedAgentSlotCount} 条按 Agent 排队的消息等待执行。`;
      } else if (state.sending) {
        dom.composerStatus.textContent = '当前 Room 正在路由这一轮消息...';
      } else if (!hasAgents) {
        dom.composerStatus.textContent = '先在右侧为本次 Room 选择至少一个角色。';
      } else {
        const goalStatus = sessionGoalUtils.formatComposerStatus(
          sessionGoalUtils.goalForConversation(conversation),
          sessionGoalUtils.proposalForConversation(conversation)
        );
        dom.composerStatus.textContent = goalStatus
          ? `可以通过 @Agent 把回合交给指定角色。${goalStatus}`
          : '可以通过 @Agent 把回合交给指定角色。';
      }

      if (!hasAgents) closeMentionMenu();
    }

    return { render };
  };
})();
