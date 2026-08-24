// @ts-check

(function registerSessionGoalHelpers() {
  const shared = window.CaffShared || (window.CaffShared = {});
  const DEFAULT_TRELLIS_GOAL_CHECKLIST_ITEMS = [
    '和其他 agent 一起头脑风暴，收敛目标、范围和风险',
    '结论收敛后创建或更新 Trellis 任务与 PRD',
    'Agent 校验 Trellis 任务、PRD、spec 上下文是否齐全',
    '使用 before-dev 读取相关开发规范与思考指南',
    '按 checklist 实现核心功能，并持续更新事实进度',
    '补充或更新回归测试，覆盖关键行为和边界',
    '运行 check、typecheck、build 和相关测试完成质量验证',
    '使用 update-spec 同步规格、契约和关键决策',
    '使用 finish-work 完成提交前收尾检查',
    '人工验收后记录会话并归档 Trellis 任务',
  ];

  function defaultChecklistText() {
    return DEFAULT_TRELLIS_GOAL_CHECKLIST_ITEMS.map((text) => `[ ] ${text}`).join('\n');
  }

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
    const consecutiveModelFailureCount = Math.max(
      0,
      Number.parseInt(String((runner && runner.consecutiveModelFailureCount) || '0'), 10) || 0
    );

    return runner
      ? {
          ...runner,
          iteration,
          maxIterations,
          consecutiveModelFailureCount,
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

  function ownerForGoal(goal) {
    const owner = goal && goal.owner && typeof goal.owner === 'object' ? goal.owner : null;
    const agentId = String((owner && owner.agentId) || '').trim();

    if (!owner || !agentId) {
      return null;
    }

    return {
      agentId,
      agentName: String(owner.agentName || '').trim() || agentId,
    };
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
    defaultChecklistText,
    statusValue,
    statusLabel,
    proposalActionValue,
    proposalActionLabel,
    proposalReasonText,
    proposalAgentName,
    ownerForGoal,
    objectiveText,
    formatStatus,
    formatProposalStatus,
    formatInlineStatus,
    formatComposerStatus,
    formatConversationStatus,
  };
})();
