// @ts-check

(function registerSessionGoalPanelModule() {
  const chat = window.CaffChat || (window.CaffChat = {});
  const shared = window.CaffShared || {};
  const sessionGoalUtils = shared.sessionGoal;

  if (!sessionGoalUtils) {
    throw new Error('CaffShared.sessionGoal helper is required');
  }

  chat.createSessionGoalPanelController = function createSessionGoalPanelController({ state, dom, helpers, showToast }) {
    const { formatDateTime, submitGoalCommand } = helpers;
    let isOpen = false;
    let isSaving = false;
    let lastConversationId = '';
    let lastSyncedObjective = '';
    let lastSyncedChecklist = '';

    function currentGoal() {
      return sessionGoalUtils.goalForConversation(state.currentConversation);
    }

    function currentProposal() {
      return sessionGoalUtils.proposalForConversation(state.currentConversation);
    }

    function currentRunner() {
      return sessionGoalUtils.runnerForConversation(state.currentConversation);
    }

    function setOpen(nextOpen) {
      isOpen = Boolean(nextOpen);
      render();

      if (isOpen && dom.sessionGoalObjective) {
        window.setTimeout(() => dom.sessionGoalObjective && dom.sessionGoalObjective.focus(), 0);
      }
    }

    function setStatusBadge(goal) {
      if (!dom.sessionGoalDrawerStatus) {
        return;
      }

      dom.sessionGoalDrawerStatus.className = `session-goal-status-badge ${sessionGoalUtils.statusValue(goal)}`;
      dom.sessionGoalDrawerStatus.textContent = goal ? sessionGoalUtils.formatStatus(goal) : '当前没有会话目标';
    }

    function appendDetail(container, label, value) {
      if (!value) {
        return;
      }

      const item = document.createElement('div');
      item.className = 'session-goal-detail-item';

      const key = document.createElement('span');
      key.className = 'muted';
      key.textContent = label;

      const content = document.createElement('strong');
      content.textContent = value;

      item.append(key, content);
      container.appendChild(item);
    }

    function renderDetails(goal, runner) {
      if (!dom.sessionGoalDetails) {
        return;
      }

      dom.sessionGoalDetails.innerHTML = '';

      if (!goal) {
        const empty = document.createElement('div');
        empty.className = 'empty-state compact-empty-state';
        empty.textContent = '还没有目标。写下目标后点击保存，或者继续使用 /goal <目标> 快捷命令。';
        dom.sessionGoalDetails.appendChild(empty);
        return;
      }

      appendDetail(dom.sessionGoalDetails, '状态', sessionGoalUtils.statusLabel(goal));
      if (runner && runner.iteration > 0 && runner.maxIterations > 0) {
        appendDetail(dom.sessionGoalDetails, '自动续跑', `${runner.iteration}/${runner.maxIterations}`);
      }
      if (runner && runner.status === 'budget_limited') {
        appendDetail(dom.sessionGoalDetails, '续跑状态', '已到安全上限，等待确认');
      }
      appendDetail(dom.sessionGoalDetails, '创建', formatDateTime(goal.createdAt));
      appendDetail(dom.sessionGoalDetails, '更新', formatDateTime(goal.updatedAt));
      appendDetail(dom.sessionGoalDetails, '完成', formatDateTime(goal.completedAt));
    }

    function renderProgress(goal) {
      if (!dom.sessionGoalProgressCard) {
        return;
      }

      const progress = sessionGoalUtils.progressForGoal(goal);
      const hasChecklist = progress.total > 0;

      dom.sessionGoalProgressCard.classList.toggle('hidden', !hasChecklist);

      if (!hasChecklist) {
        return;
      }

      if (dom.sessionGoalProgressSummary) {
        const inProgressSuffix = progress.inProgress > 0 ? `，${progress.inProgress} 项进行中` : '';
        dom.sessionGoalProgressSummary.textContent = `${progress.done}/${progress.total} · ${progress.percent}%${inProgressSuffix}`;
      }

      if (dom.sessionGoalProgressFill) {
        dom.sessionGoalProgressFill.style.width = `${progress.percent}%`;
      }

      if (dom.sessionGoalChecklistPreview) {
        dom.sessionGoalChecklistPreview.innerHTML = '';
        for (const item of progress.checklist) {
          const row = document.createElement('li');
          row.className = `session-goal-checklist-item ${item.status}`;

          const marker = document.createElement('span');
          marker.className = 'session-goal-checklist-marker';
          marker.textContent = item.status === 'done' ? '✓' : item.status === 'in_progress' ? '…' : '○';

          const text = document.createElement('span');
          text.textContent = item.text;

          row.append(marker, text);
          dom.sessionGoalChecklistPreview.appendChild(row);
        }
      }
    }

    function renderProposal(proposal) {
      if (!dom.sessionGoalProposalCard) {
        return;
      }

      dom.sessionGoalProposalCard.classList.toggle('hidden', !proposal);

      if (!proposal) {
        return;
      }

      if (dom.sessionGoalProposalStatus) {
        dom.sessionGoalProposalStatus.textContent = sessionGoalUtils.formatProposalStatus(proposal);
      }

      if (dom.sessionGoalProposalDetails) {
        dom.sessionGoalProposalDetails.innerHTML = '';
        appendDetail(dom.sessionGoalProposalDetails, '动作', sessionGoalUtils.proposalActionLabel(proposal));
        appendDetail(dom.sessionGoalProposalDetails, '提议人', sessionGoalUtils.proposalAgentName(proposal));
        appendDetail(dom.sessionGoalProposalDetails, '原因', sessionGoalUtils.proposalReasonText(proposal));
        appendDetail(dom.sessionGoalProposalDetails, '时间', formatDateTime(proposal.createdAt || proposal.updatedAt));
      }
    }

    function syncObjectiveInput(goal) {
      if (!dom.sessionGoalObjective && !dom.sessionGoalChecklist) {
        return;
      }

      const conversationId = state.currentConversation ? state.currentConversation.id : '';
      const objective = sessionGoalUtils.objectiveText(goal);
      const checklistText = sessionGoalUtils.checklistTextForGoal(goal);
      const shouldSync = !isOpen || conversationId !== lastConversationId || objective !== lastSyncedObjective || checklistText !== lastSyncedChecklist;

      if (shouldSync) {
        if (dom.sessionGoalObjective) {
          dom.sessionGoalObjective.value = objective;
        }
        if (dom.sessionGoalChecklist) {
          dom.sessionGoalChecklist.value = checklistText;
        }
        lastConversationId = conversationId;
        lastSyncedObjective = objective;
        lastSyncedChecklist = checklistText;
      }
    }

    function setActionDisabled(goal, proposal) {
      const hasConversation = Boolean(state.currentConversation);
      const status = sessionGoalUtils.statusValue(goal);
      const hasGoal = Boolean(goal);
      const hasProposal = Boolean(proposal);
      const disabled = !hasConversation || isSaving;

      if (dom.sessionGoalSaveButton) {
        dom.sessionGoalSaveButton.disabled = disabled;
        dom.sessionGoalSaveButton.textContent = isSaving ? '保存中...' : hasGoal ? '保存并替换目标' : '创建目标';
      }

      if (dom.sessionGoalPauseButton) {
        dom.sessionGoalPauseButton.disabled = disabled || !hasGoal || status === 'paused';
      }

      if (dom.sessionGoalResumeButton) {
        dom.sessionGoalResumeButton.disabled = disabled || !hasGoal || status === 'active';
      }

      if (dom.sessionGoalCompleteButton) {
        dom.sessionGoalCompleteButton.disabled = disabled || !hasGoal || status === 'complete';
      }

      if (dom.sessionGoalClearButton) {
        dom.sessionGoalClearButton.disabled = disabled || !hasGoal;
      }

      if (dom.sessionGoalAcceptProposalButton) {
        dom.sessionGoalAcceptProposalButton.disabled = disabled || !hasProposal;
      }

      if (dom.sessionGoalDismissProposalButton) {
        dom.sessionGoalDismissProposalButton.disabled = disabled || !hasProposal;
      }
    }

    function renderToggleButton(button, goal, hasConversation) {
      if (!button) {
        return;
      }

      button.disabled = !hasConversation;
      button.textContent = isOpen ? '目标 ◂' : '目标 ▸';
      button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      button.title = goal ? sessionGoalUtils.formatStatus(goal) : '管理会话目标';
    }

    function render() {
      if (!dom.sessionGoalDrawer || (!dom.sessionGoalToggleButton && !dom.sessionGoalEdgeButton)) {
        return;
      }

      const conversation = state.currentConversation;
      const goal = currentGoal();
      const proposal = currentProposal();
      const runner = currentRunner();
      const hasConversation = Boolean(conversation);

      if (!hasConversation) {
        isOpen = false;
      }

      renderToggleButton(dom.sessionGoalToggleButton, goal, hasConversation);
      renderToggleButton(dom.sessionGoalEdgeButton, goal, hasConversation);

      dom.sessionGoalDrawer.classList.toggle('hidden', !isOpen);
      dom.sessionGoalDrawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true');

      syncObjectiveInput(goal);
      setStatusBadge(goal);
      renderDetails(goal, runner);
      renderProgress(goal);
      renderProposal(proposal);
      setActionDisabled(goal, proposal);
    }

    async function submitAction(command) {
      if (!state.currentConversation || isSaving) {
        return;
      }

      isSaving = true;
      render();

      try {
        await submitGoalCommand(state.currentConversation.id, command);
        const goal = currentGoal();
        lastSyncedObjective = sessionGoalUtils.objectiveText(goal);
        lastSyncedChecklist = sessionGoalUtils.checklistTextForGoal(goal);
      } catch (error) {
        showToast(error.message);
      } finally {
        isSaving = false;
        render();
      }
    }

    function bindEvents() {
      if (!dom.sessionGoalDrawer || (!dom.sessionGoalToggleButton && !dom.sessionGoalEdgeButton)) {
        return;
      }

      if (dom.sessionGoalToggleButton) {
        dom.sessionGoalToggleButton.addEventListener('click', () => {
          setOpen(!isOpen);
        });
      }

      if (dom.sessionGoalEdgeButton) {
        dom.sessionGoalEdgeButton.addEventListener('click', () => {
          setOpen(!isOpen);
        });
      }

      if (dom.sessionGoalCloseButton) {
        dom.sessionGoalCloseButton.addEventListener('click', () => setOpen(false));
      }

      if (dom.sessionGoalForm && dom.sessionGoalObjective) {
        dom.sessionGoalForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          await submitAction({
            action: 'set',
            objective: dom.sessionGoalObjective.value,
            checklistText: dom.sessionGoalChecklist ? dom.sessionGoalChecklist.value : '',
          });
        });
      }

      if (dom.sessionGoalPauseButton) {
        dom.sessionGoalPauseButton.addEventListener('click', () => submitAction({ action: 'pause' }));
      }

      if (dom.sessionGoalResumeButton) {
        dom.sessionGoalResumeButton.addEventListener('click', () => submitAction({ action: 'resume' }));
      }

      if (dom.sessionGoalCompleteButton) {
        dom.sessionGoalCompleteButton.addEventListener('click', () => submitAction({ action: 'complete' }));
      }

      if (dom.sessionGoalClearButton) {
        dom.sessionGoalClearButton.addEventListener('click', () => {
          if (window.confirm('清除当前会话目标？')) {
            submitAction({ action: 'clear' });
          }
        });
      }

      if (dom.sessionGoalAcceptProposalButton) {
        dom.sessionGoalAcceptProposalButton.addEventListener('click', () => submitAction({ action: 'accept-proposal' }));
      }

      if (dom.sessionGoalDismissProposalButton) {
        dom.sessionGoalDismissProposalButton.addEventListener('click', () => submitAction({ action: 'dismiss-proposal' }));
      }

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen) {
          setOpen(false);
        }
      });
    }

    return {
      bindEvents,
      render,
    };
  };
})();
