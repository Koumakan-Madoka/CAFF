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
    let lastSyncedContract = '';
    let lastSyncedOwnerId = null;
    let lastSyncedOwnerSignature = '';

    function currentGoal() {
      return sessionGoalUtils.goalForConversation(state.currentConversation);
    }

    function currentProposal() {
      return sessionGoalUtils.proposalForConversation(state.currentConversation);
    }

    function currentRunner() {
      return sessionGoalUtils.runnerForConversation(state.currentConversation);
    }

    function setOpen(nextOpen, options = {}) {
      isOpen = Boolean(nextOpen);
      render();

      if (!options.fromShell && window.caffShell) {
        if (isOpen) {
          window.caffShell.openTab('session-goal-drawer');
        } else {
          window.caffShell.releaseTab('session-goal-drawer');
        }
      }

      if (isOpen && !options.fromShell && dom.sessionGoalObjective) {
        window.setTimeout(() => dom.sessionGoalObjective && dom.sessionGoalObjective.focus(), 0);
      }
    }

    function setStatusBadge(goal, runner) {
      if (!dom.sessionGoalDrawerStatus) {
        return;
      }

      dom.sessionGoalDrawerStatus.className = `session-goal-status-badge ${sessionGoalUtils.statusValue(goal)}`;
      dom.sessionGoalDrawerStatus.textContent = runner && runner.status === 'error_paused'
        ? `会话目标（模型失败自动暂停）：${sessionGoalUtils.objectiveText(goal)}`
        : goal
          ? sessionGoalUtils.formatStatus(goal)
          : '当前没有会话目标';
    }

    function appendDetail(container, label, value) {
      if (!value) {
        return;
      }

      const item = document.createElement('div');
      item.className = 'session-goal-detail-item';
      item.classList.toggle('multiline', String(value).includes('\n'));

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
      const owner = sessionGoalUtils.ownerForGoal(goal);
      appendDetail(dom.sessionGoalDetails, '主理人', owner ? owner.agentName : '未设置');
      if (runner && runner.iteration > 0 && runner.maxIterations > 0) {
        appendDetail(dom.sessionGoalDetails, '自动续跑', `${runner.iteration}/${runner.maxIterations}`);
      }
      if (runner && runner.status === 'budget_limited') {
        appendDetail(dom.sessionGoalDetails, '续跑状态', '已到安全上限，等待确认');
      }
      if (runner && runner.status === 'error_paused') {
        appendDetail(dom.sessionGoalDetails, '续跑状态', '模型调用失败自动暂停');
        appendDetail(
          dom.sessionGoalDetails,
          '失败 streak',
          `${runner.consecutiveModelFailureCount || 0} 次连续快速失败`
        );
        appendDetail(dom.sessionGoalDetails, '暂停原因', String(runner.pauseReason || '').trim());
        appendDetail(dom.sessionGoalDetails, '最后错误', String(runner.lastFailureSummary || '').trim());
      }
      appendDetail(dom.sessionGoalDetails, '创建', formatDateTime(goal.createdAt));
      appendDetail(dom.sessionGoalDetails, '更新', formatDateTime(goal.updatedAt));
      appendDetail(dom.sessionGoalDetails, '完成', formatDateTime(goal.completedAt));
      const criteria = sessionGoalUtils.acceptanceCriteriaForGoal(goal);
      appendDetail(
        dom.sessionGoalDetails,
        '验收条件',
        criteria.map((item) => `[${item.status}] ${item.statement} | ${item.verifyBy}`).join('\n')
      );
      const evidence = sessionGoalUtils.evidenceForGoal(goal);
      appendDetail(
        dom.sessionGoalDetails,
        '证据',
        evidence.map((item) => `${item.id || 'evidence'} [${item.kind || 'artifact'}] ${item.summary || ''}`).join('\n')
      );
      const notices = goal && Array.isArray(goal.changeNotices) ? goal.changeNotices : [];
      appendDetail(
        dom.sessionGoalDetails,
        '决策变更通知',
        notices.map((notice) => {
          const changes = Array.isArray(notice && notice.changes) ? notice.changes : [];
          const changeText = changes.map((change) => `${change.previous || '(无)'} -> ${change.next || '(已移除)'}`).join('；');
          const reviewer = notice && notice.reviewer
            ? notice.reviewer.kind === 'user' ? 'user' : notice.reviewer.agentName || notice.reviewer.agentId || 'reviewer'
            : 'reviewer';
          return `${changeText}\n理由：${notice.reason || '(未填写)'}\n影响：${notice.impact || '(未填写)'}\n审核：${reviewer}`;
        }).join('\n\n')
      );
      const decisionGroups = [
        ['Committed', 'committed'],
        ['Provisional', 'provisional'],
        ['Open Questions', 'openQuestions'],
        ['Non-goals', 'nonGoals'],
        ['Rejected', 'rejectedOptions'],
      ];
      for (const [label, field] of decisionGroups) {
        appendDetail(dom.sessionGoalDetails, label, sessionGoalUtils.decisionText(goal, field));
      }
    }

    function renderOwnerSelect(goal) {
      if (!dom.sessionGoalOwnerCard || !dom.sessionGoalOwnerSelect) {
        return;
      }

      const conversation = state.currentConversation;
      const hasGoal = Boolean(goal);
      dom.sessionGoalOwnerCard.classList.toggle('hidden', !hasGoal);

      if (!hasGoal) {
        lastSyncedOwnerId = null;
        lastSyncedOwnerSignature = '';
        return;
      }

      const owner = sessionGoalUtils.ownerForGoal(goal);
      const ownerId = owner ? owner.agentId : '';
      const agents = conversation && Array.isArray(conversation.agents) ? conversation.agents : [];
      const signature = `${conversation ? conversation.id : ''}|${ownerId}|${agents
        .map((agent) => `${agent && agent.id}:${(agent && agent.name) || ''}`)
        .join(',')}`;

      // Repopulate options only when the conversation, roster, or persisted
      // owner changes so an in-flight user selection survives re-renders.
      if (signature !== lastSyncedOwnerSignature || ownerId !== lastSyncedOwnerId) {
        dom.sessionGoalOwnerSelect.innerHTML = '';

        const unsetOption = document.createElement('option');
        unsetOption.value = '';
        unsetOption.textContent = '未设置';
        dom.sessionGoalOwnerSelect.appendChild(unsetOption);

        for (const agent of agents) {
          if (!agent || !agent.id) {
            continue;
          }
          const option = document.createElement('option');
          option.value = String(agent.id);
          option.textContent = String(agent.name || agent.id);
          dom.sessionGoalOwnerSelect.appendChild(option);
        }

        // A removed owner (roster change outracing the server-side pause
        // proposal) keeps a visible option instead of silently resetting
        // the displayed selection to 未设置.
        if (owner && !agents.some((agent) => agent && String(agent.id) === ownerId)) {
          const staleOption = document.createElement('option');
          staleOption.value = ownerId;
          staleOption.textContent = `${owner.agentName}（已不在会话）`;
          dom.sessionGoalOwnerSelect.appendChild(staleOption);
        }

        dom.sessionGoalOwnerSelect.value = ownerId;
        lastSyncedOwnerSignature = signature;
        lastSyncedOwnerId = ownerId;
      }
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
        appendDetail(dom.sessionGoalProposalDetails, '拟定目标', sessionGoalUtils.objectiveText(proposal));
        appendDetail(dom.sessionGoalProposalDetails, '验收条件', sessionGoalUtils.acceptanceCriteriaText(proposal));
        appendDetail(dom.sessionGoalProposalDetails, '工作项', sessionGoalUtils.checklistTextForGoal(proposal));
        appendDetail(dom.sessionGoalProposalDetails, '提议人', sessionGoalUtils.proposalAgentName(proposal));
        appendDetail(dom.sessionGoalProposalDetails, '原因', sessionGoalUtils.proposalReasonText(proposal));
        appendDetail(dom.sessionGoalProposalDetails, '影响', String(proposal.impact || '').trim());
        appendDetail(
          dom.sessionGoalProposalDetails,
          '受影响工作项',
          Array.isArray(proposal.affectedWorkItems) ? proposal.affectedWorkItems.join('\n') : ''
        );
        appendDetail(dom.sessionGoalProposalDetails, '时间', formatDateTime(proposal.createdAt || proposal.updatedAt));
      }
    }

    function syncObjectiveInput(goal) {
      const contractInputs = [
        dom.sessionGoalAcceptance,
        dom.sessionGoalDecisionsCommitted,
        dom.sessionGoalDecisionsProvisional,
        dom.sessionGoalDecisionsOpen,
        dom.sessionGoalDecisionsNonGoals,
        dom.sessionGoalDecisionsRejected,
      ];
      if (!dom.sessionGoalObjective && !dom.sessionGoalChecklist && contractInputs.every((input) => !input)) {
        return;
      }

      const conversationId = state.currentConversation ? state.currentConversation.id : '';
      const objective = sessionGoalUtils.objectiveText(goal);
      const checklistText = goal
        ? sessionGoalUtils.checklistTextForGoal(goal)
        : sessionGoalUtils.defaultChecklistText();
      const contractValues = {
        acceptance: sessionGoalUtils.acceptanceCriteriaText(goal),
        committed: sessionGoalUtils.decisionText(goal, 'committed'),
        provisional: sessionGoalUtils.decisionText(goal, 'provisional'),
        openQuestions: sessionGoalUtils.decisionText(goal, 'openQuestions'),
        nonGoals: sessionGoalUtils.decisionText(goal, 'nonGoals'),
        rejectedOptions: sessionGoalUtils.decisionText(goal, 'rejectedOptions'),
      };
      const contractSignature = JSON.stringify(contractValues);
      const shouldSync = !isOpen || conversationId !== lastConversationId || objective !== lastSyncedObjective
        || checklistText !== lastSyncedChecklist || contractSignature !== lastSyncedContract;

      if (shouldSync) {
        if (dom.sessionGoalObjective) dom.sessionGoalObjective.value = objective;
        if (dom.sessionGoalChecklist) dom.sessionGoalChecklist.value = checklistText;
        if (dom.sessionGoalAcceptance) dom.sessionGoalAcceptance.value = contractValues.acceptance;
        if (dom.sessionGoalDecisionsCommitted) dom.sessionGoalDecisionsCommitted.value = contractValues.committed;
        if (dom.sessionGoalDecisionsProvisional) dom.sessionGoalDecisionsProvisional.value = contractValues.provisional;
        if (dom.sessionGoalDecisionsOpen) dom.sessionGoalDecisionsOpen.value = contractValues.openQuestions;
        if (dom.sessionGoalDecisionsNonGoals) dom.sessionGoalDecisionsNonGoals.value = contractValues.nonGoals;
        if (dom.sessionGoalDecisionsRejected) dom.sessionGoalDecisionsRejected.value = contractValues.rejectedOptions;
        lastConversationId = conversationId;
        lastSyncedObjective = objective;
        lastSyncedChecklist = checklistText;
        lastSyncedContract = contractSignature;
      }
    }

    function applyPresetChecklist() {
      if (!dom.sessionGoalChecklist) {
        return;
      }

      dom.sessionGoalChecklist.value = sessionGoalUtils.defaultChecklistText();
      lastSyncedChecklist = dom.sessionGoalChecklist.value;
      showToast('已填入交付工作项');
    }

    function setActionDisabled(goal, proposal) {
      const hasConversation = Boolean(state.currentConversation);
      const status = sessionGoalUtils.statusValue(goal);
      const hasGoal = Boolean(goal);
      const hasProposal = Boolean(proposal);
      const disabled = !hasConversation || isSaving;
      // DAG execution lock (D27/D28): while this conversation is a bound DAG
      // node child with an active/paused goal, direct mutations (set/pause/
      // resume/complete/clear) would bypass the worker→verifier completion
      // protocol — the server rejects them with 403 dag_goal_mutation_
      // forbidden, so disable the buttons up front. Proposal rulings
      // (accept/dismiss = user manual verification) stay available.
      const metadata = state.currentConversation && state.currentConversation.metadata;
      const dagExecutionLocked = Boolean(
        metadata && typeof metadata === 'object' && metadata.dagNodeGoalBinding
        && hasGoal && (status === 'active' || status === 'paused')
      );

      if (dom.sessionGoalSaveButton) {
        dom.sessionGoalSaveButton.disabled = disabled || dagExecutionLocked;
        dom.sessionGoalSaveButton.textContent = isSaving ? '保存中...' : hasGoal ? '保存并替换目标' : '创建目标';
        if (dagExecutionLocked) {
          dom.sessionGoalSaveButton.title = 'DAG 节点执行中：目标由调度器托管，仅支持验收裁决';
        } else {
          dom.sessionGoalSaveButton.removeAttribute('title');
        }
      }

      if (dom.sessionGoalChecklistPresetButton) {
        dom.sessionGoalChecklistPresetButton.disabled = disabled || dagExecutionLocked || !dom.sessionGoalChecklist;
      }

      if (dom.sessionGoalPauseButton) {
        dom.sessionGoalPauseButton.disabled = disabled || dagExecutionLocked || !hasGoal || status === 'paused';
      }

      if (dom.sessionGoalResumeButton) {
        dom.sessionGoalResumeButton.disabled = disabled || dagExecutionLocked || !hasGoal || status === 'active';
      }

      if (dom.sessionGoalCompleteButton) {
        const criteria = sessionGoalUtils.acceptanceCriteriaForGoal(goal);
        const acceptanceReady = criteria.length > 0 && criteria.every((criterion) => ['passed', 'waived'].includes(criterion.status));
        dom.sessionGoalCompleteButton.disabled = disabled || dagExecutionLocked || !hasGoal || status === 'complete' || !acceptanceReady;
        if (dagExecutionLocked) {
          dom.sessionGoalCompleteButton.title = 'DAG 节点执行中：完工须由工作 agent 宣布并通过验收';
        } else if (hasGoal && !acceptanceReady) {
          dom.sessionGoalCompleteButton.title = '所有验收条件通过或获准豁免后才能完成';
        } else {
          dom.sessionGoalCompleteButton.removeAttribute('title');
        }
      }

      if (dom.sessionGoalClearButton) {
        dom.sessionGoalClearButton.disabled = disabled || dagExecutionLocked || !hasGoal;
      }

      if (dom.sessionGoalAcceptProposalButton) {
        dom.sessionGoalAcceptProposalButton.disabled = disabled || !hasProposal;
      }

      if (dom.sessionGoalDismissProposalButton) {
        dom.sessionGoalDismissProposalButton.disabled = disabled || !hasProposal;
      }

      // Owner is goal lifecycle state inside the current epoch: under the
      // DAG execution lock the goal is scheduler-owned, so the dropdown is
      // disabled alongside set/pause/resume/complete/clear.
      if (dom.sessionGoalOwnerSelect) {
        dom.sessionGoalOwnerSelect.disabled = disabled || dagExecutionLocked || !hasGoal;
        if (dagExecutionLocked) {
          dom.sessionGoalOwnerSelect.title = 'DAG 节点执行中：主理人由调度器托管，不可手动变更';
        } else {
          dom.sessionGoalOwnerSelect.removeAttribute('title');
        }
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
      if (!dom.sessionGoalDrawer) {
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

      syncObjectiveInput(goal);
      setStatusBadge(goal, runner);
      renderDetails(goal, runner);
      renderOwnerSelect(goal);
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
        // A failed submit must not leave an unpersisted value on screen:
        // invalidate the owner-select cache so the finally-render rebuilds
        // the select from the persisted goal owner.
        lastSyncedOwnerId = null;
        lastSyncedOwnerSignature = '';
        showToast(error.message);
      } finally {
        isSaving = false;
        render();
      }
    }

    function textLines(input) {
      return String((input && input.value) || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    }

    // Text editors cannot expose every contract field; keep exact matching records intact.
    function preserveItems(items, previous, matches) {
      const remaining = [...(previous || [])];
      const reservedIds = new Set(remaining.map((item) => item.id));
      return items.map((item) => {
        const index = remaining.findIndex((existing) => matches(existing, item));
        if (index >= 0) {
          const existing = remaining.splice(index, 1)[0];
          return { ...existing, ...item, id: existing.id };
        }
        let id = item.id;
        let suffix = 1;
        while (reservedIds.has(id)) id = `${item.id}-new-${suffix++}`;
        reservedIds.add(id);
        return { ...item, id };
      });
    }

    function decisionItems(input, field) {
      const goal = currentGoal();
      const key = field === 'openQuestions' ? 'question' : field === 'rejectedOptions' ? 'option' : 'statement';
      const items = textLines(input).map((value, index) => ({ id: `${field}-${index + 1}`, [key]: value }));
      return preserveItems(items, goal && goal.decisions && goal.decisions[field], (a, b) => a[key] === b[key]);
    }

    function acceptanceItems(input) {
      const goal = currentGoal();
      const previous = goal && goal.acceptanceCriteria || [];
      const items = textLines(input).map((line, index) => {
        const separator = line.indexOf('|');
        const statement = (separator >= 0 ? line.slice(0, separator) : line).trim();
        const verifyBy = (separator >= 0 ? line.slice(separator + 1) : '').trim();
        return {
          id: `criterion-${index + 1}`,
          statement,
          verifyBy,
        };
      });
      return preserveItems(items, previous, (a, b) => a.statement === b.statement && a.verifyBy === b.verifyBy)
        .map((item) => ({ status: 'pending', risk: 'normal', evidenceRefs: [], ...item }));
    }

    function workItems(input) {
      const goal = currentGoal();
      const items = textLines(input).map((line, index) => {
        const match = line.match(/^[-*]?\s*\[([ xX~>\-])\]\s*(.+)$/u);
        const marker = match ? String(match[1] || '').trim().toLowerCase() : '';
        return {
          id: `work-${index + 1}`,
          text: match ? match[2].trim() : line,
          status: marker === 'x' ? 'done' : ['~', '>', '-'].includes(marker) ? 'in_progress' : 'todo',
        };
      });
      return preserveItems(items, goal && (goal.workItems || goal.checklist), (a, b) => a.text === b.text);
    }

    function buildGoalContract() {
      const goal = currentGoal();
      const acceptanceCriteria = acceptanceItems(dom.sessionGoalAcceptance);
      const criterionIds = new Set(acceptanceCriteria.map((criterion) => criterion.id));
      return {
        action: goal ? 'revise' : 'set',
        ...(goal ? { goalRevision: goal.revision } : {}),
        objective: dom.sessionGoalObjective ? dom.sessionGoalObjective.value : '',
        decisions: {
          committed: decisionItems(dom.sessionGoalDecisionsCommitted, 'committed'),
          provisional: decisionItems(dom.sessionGoalDecisionsProvisional, 'provisional'),
          openQuestions: decisionItems(dom.sessionGoalDecisionsOpen, 'openQuestions'),
          nonGoals: decisionItems(dom.sessionGoalDecisionsNonGoals, 'nonGoals'),
          rejectedOptions: decisionItems(dom.sessionGoalDecisionsRejected, 'rejectedOptions'),
        },
        acceptanceCriteria,
        workItems: workItems(dom.sessionGoalChecklist),
        // Retain artifacts, but never attach old proof to a replacement criterion.
        evidence: sessionGoalUtils.evidenceForGoal(goal).map((item) => Array.isArray(item.criterionIds)
          ? { ...item, criterionIds: item.criterionIds.filter((id) => criterionIds.has(id)) }
          : item),
      };
    }

    function bindEvents() {
      if (!dom.sessionGoalDrawer) {
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
          await submitAction(buildGoalContract());
        });
      }

      if (dom.sessionGoalChecklistPresetButton) {
        dom.sessionGoalChecklistPresetButton.addEventListener('click', applyPresetChecklist);
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

      if (dom.sessionGoalOwnerSelect) {
        dom.sessionGoalOwnerSelect.addEventListener('change', () => {
          submitAction({
            action: 'set-owner',
            ownerAgentId: dom.sessionGoalOwnerSelect.value,
          });
        });
      }

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen) {
          setOpen(false);
        }
      });

      if (window.caffShell && typeof window.caffShell.onChange === 'function') {
        window.caffShell.onChange(({ open, tab }) => {
          const shouldBeOpen = open && tab === 'session-goal-drawer';
          if (shouldBeOpen !== isOpen) {
            setOpen(shouldBeOpen, { fromShell: true });
          }
        });
      }
    }

    return {
      bindEvents,
      render,
    };
  };
})();
