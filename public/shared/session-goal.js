// @ts-check

(function registerSessionGoalHelpers() {
  const shared = window.CaffShared || (window.CaffShared = {});

  function goalForConversation(conversation) {
    const metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : null;
    const goal = metadata && metadata.sessionGoal && typeof metadata.sessionGoal === 'object' ? metadata.sessionGoal : null;
    const objective = goal ? String(goal.objective || '').trim() : '';

    return objective ? goal : null;
  }

  function proposalForConversation(conversation) {
    const metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : null;
    const proposal = metadata && metadata.sessionGoalProposal && typeof metadata.sessionGoalProposal === 'object'
      ? metadata.sessionGoalProposal
      : null;
    const action = proposalActionValue(proposal);
    const objective = proposal ? String(proposal.objective || '').trim() : '';

    if (!action || (action === 'set' && !objective)) {
      return null;
    }

    return proposal;
  }

  function runnerForConversation(conversation) {
    const metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : null;
    const runner = metadata && metadata.sessionGoalRunner && typeof metadata.sessionGoalRunner === 'object'
      ? metadata.sessionGoalRunner
      : null;
    const iteration = Math.max(0, Number.parseInt(String((runner && runner.iteration) || '0'), 10) || 0);
    const maxIterations = Math.max(0, Number.parseInt(String((runner && runner.maxIterations) || '0'), 10) || 0);

    return runner
      ? {
          ...runner,
          iteration,
          maxIterations,
        }
      : null;
  }

  function checklistForGoal(goal) {
    const checklist = goal && Array.isArray(goal.checklist) ? goal.checklist : [];

    return checklist
      .map((item, index) => {
        const text = String((item && item.text) || '').trim();
        if (!text) {
          return null;
        }
        const rawStatus = String((item && item.status) || '').trim().toLowerCase().replace(/-/g, '_');
        const status = rawStatus === 'done' || rawStatus === 'complete' || rawStatus === 'completed'
          ? 'done'
          : rawStatus === 'in_progress' || rawStatus === 'doing'
            ? 'in_progress'
            : 'todo';
        return {
          id: String((item && item.id) || `item-${index + 1}`).trim(),
          text,
          status,
        };
      })
      .filter(Boolean);
  }

  function checklistTextForGoal(goal) {
    return checklistForGoal(goal).map((item) => {
      const marker = item.status === 'done' ? 'x' : item.status === 'in_progress' ? '~' : ' ';
      return `[${marker}] ${item.text}`;
    }).join('\n');
  }

  function progressForGoal(goal) {
    const checklist = checklistForGoal(goal);
    const total = checklist.length;
    const done = checklist.filter((item) => item.status === 'done').length;
    const inProgress = checklist.filter((item) => item.status === 'in_progress').length;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    return { checklist, total, done, inProgress, percent };
  }

  function statusValue(goal) {
    const status = String((goal && goal.status) || 'active').trim().toLowerCase();
    return status === 'paused' || status === 'complete' ? status : 'active';
  }

  function proposalActionValue(proposal) {
    const action = String((proposal && proposal.action) || '').trim().toLowerCase();
    return ['set', 'pause', 'resume', 'complete', 'clear'].includes(action) ? action : '';
  }

  function statusLabel(goal) {
    const status = statusValue(goal);
    return status === 'paused' ? '已暂停' : status === 'complete' ? '已完成' : '进行中';
  }

  function proposalActionLabel(proposal) {
    const action = proposalActionValue(proposal);
    if (action === 'set') {
      return '替换目标';
    }
    if (action === 'pause') {
      return '暂停目标';
    }
    if (action === 'resume') {
      return '恢复目标';
    }
    if (action === 'complete') {
      return '标记完成';
    }
    if (action === 'clear') {
      return '清除目标';
    }
    return '更新目标';
  }

  function objectiveText(goal) {
    return String((goal && goal.objective) || '').trim();
  }

  function proposalReasonText(proposal) {
    return String((proposal && proposal.reason) || '').trim();
  }

  function proposalAgentName(proposal) {
    const proposedBy = proposal && proposal.proposedBy && typeof proposal.proposedBy === 'object' ? proposal.proposedBy : null;
    return String((proposedBy && proposedBy.agentName) || 'Agent').trim() || 'Agent';
  }

  function formatStatus(goal) {
    if (!goal) {
      return '当前没有会话目标。使用 /goal <目标> 设置一个。';
    }

    return `会话目标（${statusLabel(goal)}）：${objectiveText(goal)}`;
  }

  function formatProposalStatus(proposal) {
    if (!proposal) {
      return '';
    }

    const actionLabel = proposalActionLabel(proposal);
    const objective = objectiveText(proposal);
    const objectiveSuffix = objective ? `：${objective}` : '';
    return `待确认提议：${proposalAgentName(proposal)} 建议${actionLabel}${objectiveSuffix}`;
  }

  function formatInlineStatus(goal, proposal) {
    return [goal ? formatStatus(goal) : '', proposal ? formatProposalStatus(proposal) : ''].filter(Boolean).join(' / ');
  }

  function formatComposerStatus(goal, proposal) {
    const parts = [goal ? `当前目标（${statusLabel(goal)}）：${objectiveText(goal)}` : '', formatProposalStatus(proposal)].filter(Boolean);
    return parts.join('；');
  }

  function formatConversationStatus(conversation) {
    const goal = goalForConversation(conversation);
    const proposal = proposalForConversation(conversation);
    const status = formatInlineStatus(goal, proposal);
    return status || '当前没有会话目标。使用 /goal <目标> 设置一个。';
  }

  shared.sessionGoal = {
    goalForConversation,
    proposalForConversation,
    runnerForConversation,
    checklistForGoal,
    checklistTextForGoal,
    progressForGoal,
    statusValue,
    statusLabel,
    proposalActionValue,
    proposalActionLabel,
    proposalReasonText,
    proposalAgentName,
    objectiveText,
    formatStatus,
    formatProposalStatus,
    formatInlineStatus,
    formatComposerStatus,
    formatConversationStatus,
  };
})();
