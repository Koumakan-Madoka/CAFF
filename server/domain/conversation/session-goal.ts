import { createHttpError } from '../../http/http-errors';

const SESSION_GOAL_METADATA_KEY = 'sessionGoal';
const SESSION_GOAL_PROPOSAL_METADATA_KEY = 'sessionGoalProposal';
const SESSION_GOAL_RUNNER_METADATA_KEY = 'sessionGoalRunner';
const SESSION_GOAL_STATUSES = new Set(['active', 'paused', 'complete']);
const SESSION_GOAL_PROPOSAL_ACTIONS = new Set(['set', 'pause', 'resume', 'complete', 'clear']);
const SESSION_GOAL_ACTIONS = new Set(['set', 'pause', 'resume', 'complete', 'clear', 'update-checklist', 'update_checklist']);
const SESSION_GOAL_CHECKLIST_STATUSES = new Set(['todo', 'in_progress', 'done']);
const MAX_SESSION_GOAL_OBJECTIVE_LENGTH = 2000;
const MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH = 1000;
const MAX_SESSION_GOAL_CHECKLIST_ITEMS = 20;
const MAX_SESSION_GOAL_CHECKLIST_ITEM_LENGTH = 200;

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value: any) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeText(value: any) {
  return String(value || '').trim();
}

function clipText(value: any, maxLength: number) {
  const text = normalizeText(value);

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength);
}

function normalizeObjective(value: any) {
  const objective = normalizeText(value);

  if (!objective) {
    throw createHttpError(400, 'Goal objective is required');
  }

  if (objective.length > MAX_SESSION_GOAL_OBJECTIVE_LENGTH) {
    throw createHttpError(400, `Goal objective must be ${MAX_SESSION_GOAL_OBJECTIVE_LENGTH} characters or fewer`);
  }

  return objective;
}

function normalizeProposalReason(value: any) {
  const reason = normalizeText(value);

  if (reason.length > MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH) {
    throw createHttpError(400, `Goal proposal reason must be ${MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH} characters or fewer`);
  }

  return reason;
}

function normalizeStatus(value: any) {
  const status = normalizeText(value).toLowerCase();
  return SESSION_GOAL_STATUSES.has(status) ? status : 'active';
}

function normalizeProposalAction(value: any) {
  const action = normalizeText(value).toLowerCase();
  return SESSION_GOAL_PROPOSAL_ACTIONS.has(action) ? action : '';
}

function normalizeChecklistStatus(value: any) {
  const status = normalizeText(value).toLowerCase().replace(/-/g, '_');

  if (status === 'complete' || status === 'completed' || status === 'checked' || status === 'true') {
    return 'done';
  }

  if (status === 'doing' || status === 'active' || status === 'in-progress') {
    return 'in_progress';
  }

  return SESSION_GOAL_CHECKLIST_STATUSES.has(status) ? status : 'todo';
}

function parseChecklistTextLine(value: any) {
  const text = normalizeText(value);
  const match = text.match(/^[-*]?\s*\[([ xX~>\-])\]\s*(.+)$/u);

  if (!match) {
    return { text, status: 'todo' };
  }

  const marker = String(match[1] || '').trim().toLowerCase();
  return {
    text: normalizeText(match[2]),
    status: marker === 'x' ? 'done' : marker === '~' || marker === '>' || marker === '-' ? 'in_progress' : 'todo',
  };
}

function normalizeChecklistItems(value: any, timestamp = nowIso()) {
  const rawItems = typeof value === 'string'
    ? value.split(/\r?\n/u).map(parseChecklistTextLine)
    : Array.isArray(value)
      ? value
      : [];
  const checklist = [] as any[];

  for (const item of rawItems) {
    if (checklist.length >= MAX_SESSION_GOAL_CHECKLIST_ITEMS) {
      break;
    }

    const source = isPlainObject(item) ? item : parseChecklistTextLine(item);
    const text = clipText(source.text || source.title || source.objective || source.content, MAX_SESSION_GOAL_CHECKLIST_ITEM_LENGTH);

    if (!text) {
      continue;
    }

    const status = normalizeChecklistStatus(source.status || source.state || source.checked);
    const createdAt = normalizeText(source.createdAt || source.created_at) || timestamp;
    const updatedAt = normalizeText(source.updatedAt || source.updated_at) || timestamp;
    const completedAt = status === 'done' ? normalizeText(source.completedAt || source.completed_at) || timestamp : '';

    checklist.push({
      id: normalizeText(source.id) || `item-${checklist.length + 1}`,
      text,
      status,
      createdAt,
      updatedAt,
      ...(completedAt ? { completedAt } : {}),
    });
  }

  return checklist;
}

function hasChecklistInput(input: any) {
  return isPlainObject(input) && (
    Object.prototype.hasOwnProperty.call(input, 'checklist') ||
    Object.prototype.hasOwnProperty.call(input, 'checklistText') ||
    Object.prototype.hasOwnProperty.call(input, 'checklist_text')
  );
}

function checklistInputValue(input: any) {
  if (!isPlainObject(input)) {
    return [];
  }

  if (Object.prototype.hasOwnProperty.call(input, 'checklistText')) {
    return input.checklistText;
  }

  if (Object.prototype.hasOwnProperty.call(input, 'checklist_text')) {
    return input.checklist_text;
  }

  return input.checklist;
}

function normalizeSessionGoal(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }

  const objective = normalizeText(value.objective);

  if (!objective) {
    return null;
  }

  const status = normalizeStatus(value.status);
  const createdAt = normalizeText(value.createdAt || value.created_at) || nowIso();
  const updatedAt = normalizeText(value.updatedAt || value.updated_at) || createdAt;
  const completedAt = normalizeText(value.completedAt || value.completed_at);
  const checklist = normalizeChecklistItems(value.checklist, updatedAt);

  return {
    objective,
    status,
    createdAt,
    updatedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(checklist.length > 0 ? { checklist } : {}),
  };
}

function normalizeSessionGoalProposal(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }

  const action = normalizeProposalAction(value.action);

  if (!action) {
    return null;
  }

  const objective = normalizeText(value.objective);

  if (action === 'set' && !objective) {
    return null;
  }

  const proposedBy = isPlainObject(value.proposedBy) ? value.proposedBy : {};
  const createdAt = normalizeText(value.createdAt || value.created_at) || nowIso();
  const updatedAt = normalizeText(value.updatedAt || value.updated_at) || createdAt;
  const reason = clipText(value.reason, MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH);

  return {
    action,
    status: 'pending',
    ...(objective ? { objective } : {}),
    ...(reason ? { reason } : {}),
    proposedBy: {
      agentId: normalizeText(proposedBy.agentId),
      agentName: normalizeText(proposedBy.agentName) || 'Assistant',
    },
    createdAt,
    updatedAt,
  };
}

function normalizeSessionGoalRunner(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }

  const status = normalizeText(value.status) || 'idle';
  const goalUpdatedAt = normalizeText(value.goalUpdatedAt || value.goal_updated_at);
  const updatedAt = normalizeText(value.updatedAt || value.updated_at) || nowIso();
  const lastContinuedAt = normalizeText(value.lastContinuedAt || value.last_continued_at);
  const iteration = Math.max(0, Number.parseInt(String(value.iteration || '0'), 10) || 0);
  const maxIterations = Math.max(0, Number.parseInt(String(value.maxIterations || value.max_iterations || '0'), 10) || 0);

  return {
    status,
    goalUpdatedAt,
    iteration,
    maxIterations,
    updatedAt,
    ...(lastContinuedAt ? { lastContinuedAt } : {}),
  };
}

export function getSessionGoal(conversation: any) {
  const metadata = conversation && isPlainObject(conversation.metadata) ? conversation.metadata : {};
  return normalizeSessionGoal(metadata[SESSION_GOAL_METADATA_KEY]);
}

export function getSessionGoalProposal(conversation: any) {
  const metadata = conversation && isPlainObject(conversation.metadata) ? conversation.metadata : {};
  return normalizeSessionGoalProposal(metadata[SESSION_GOAL_PROPOSAL_METADATA_KEY]);
}

export function getSessionGoalRunner(conversation: any) {
  const metadata = conversation && isPlainObject(conversation.metadata) ? conversation.metadata : {};
  return normalizeSessionGoalRunner(metadata[SESSION_GOAL_RUNNER_METADATA_KEY]);
}

function currentMetadata(conversation: any) {
  return conversation && isPlainObject(conversation.metadata) ? conversation.metadata : {};
}

function buildMetadataWithGoal(conversation: any, goal: any) {
  const metadata = currentMetadata(conversation);
  const { [SESSION_GOAL_PROPOSAL_METADATA_KEY]: _proposal, ...remainingMetadata } = metadata;
  return {
    ...remainingMetadata,
    [SESSION_GOAL_METADATA_KEY]: goal,
  };
}

function buildMetadataWithProposal(conversation: any, proposal: any) {
  const metadata = currentMetadata(conversation);
  return {
    ...metadata,
    [SESSION_GOAL_PROPOSAL_METADATA_KEY]: proposal,
  };
}

function buildMetadataWithoutGoal(conversation: any) {
  const metadata = currentMetadata(conversation);
  const {
    [SESSION_GOAL_METADATA_KEY]: _sessionGoal,
    [SESSION_GOAL_PROPOSAL_METADATA_KEY]: _proposal,
    [SESSION_GOAL_RUNNER_METADATA_KEY]: _runner,
    ...remainingMetadata
  } = metadata;
  return remainingMetadata;
}

function buildMetadataWithoutProposal(conversation: any) {
  const metadata = currentMetadata(conversation);
  const { [SESSION_GOAL_PROPOSAL_METADATA_KEY]: _proposal, ...remainingMetadata } = metadata;
  return remainingMetadata;
}

function updateConversationMetadata(store: any, conversation: any, metadata: any) {
  return store.updateConversation(conversation.id, {
    title: conversation.title,
    type: conversation.type,
    metadata,
  });
}

function updateConversationGoal(store: any, conversation: any, goal: any) {
  return updateConversationMetadata(store, conversation, buildMetadataWithGoal(conversation, goal));
}

function updateConversationProposal(store: any, conversation: any, proposal: any) {
  return updateConversationMetadata(store, conversation, buildMetadataWithProposal(conversation, proposal));
}

function buildMetadataWithGoalRunner(conversation: any, runner: any) {
  const metadata = currentMetadata(conversation);
  return {
    ...metadata,
    [SESSION_GOAL_RUNNER_METADATA_KEY]: runner,
  };
}

function updateConversationGoalRunner(store: any, conversation: any, runner: any) {
  return updateConversationMetadata(store, conversation, buildMetadataWithGoalRunner(conversation, runner));
}

function goalRunnerKey(goal: any) {
  return normalizeText(goal && (goal.updatedAt || goal.createdAt));
}

export function claimSessionGoalAutoContinue(store: any, conversationId: any, input: any = {}) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = store.getConversation(normalizedConversationId);

  if (!conversation) {
    return { claimed: false, reason: 'missing_conversation' };
  }

  const goal = getSessionGoal(conversation);

  if (!goal || goal.status !== 'active') {
    return { claimed: false, reason: 'inactive_goal', goal };
  }

  if (getSessionGoalProposal(conversation)) {
    return { claimed: false, reason: 'pending_proposal', goal };
  }

  const maxIterations = Math.max(1, Number.parseInt(String(input.maxIterations || '0'), 10) || 1);
  const existingRunner = getSessionGoalRunner(conversation);
  const key = goalRunnerKey(goal);
  const currentIteration = existingRunner && existingRunner.goalUpdatedAt === key ? existingRunner.iteration : 0;

  if (currentIteration >= maxIterations) {
    const timestamp = nowIso();
    const nextRunner = {
      status: 'budget_limited',
      goalUpdatedAt: key,
      iteration: currentIteration,
      maxIterations,
      updatedAt: timestamp,
      ...(existingRunner && existingRunner.lastContinuedAt ? { lastContinuedAt: existingRunner.lastContinuedAt } : {}),
    };
    const nextConversation = updateConversationGoalRunner(store, conversation, nextRunner);

    return {
      claimed: false,
      reason: 'budget_limited',
      goal,
      runner: getSessionGoalRunner(nextConversation),
      conversation: nextConversation,
    };
  }

  const timestamp = nowIso();
  const nextRunner = {
    status: 'running',
    goalUpdatedAt: key,
    iteration: currentIteration + 1,
    maxIterations,
    updatedAt: timestamp,
    lastContinuedAt: timestamp,
  };
  const nextConversation = updateConversationGoalRunner(store, conversation, nextRunner);

  return {
    claimed: true,
    reason: 'claimed',
    goal,
    runner: getSessionGoalRunner(nextConversation),
    conversation: nextConversation,
  };
}

function goalFromMutation(action: string, existingGoal: any, input: any, timestamp: string) {
  if (action === 'set') {
    const checklist = hasChecklistInput(input) ? normalizeChecklistItems(checklistInputValue(input), timestamp) : [];
    return {
      objective: normalizeObjective(input && input.objective),
      status: 'active',
      createdAt: existingGoal ? existingGoal.createdAt : timestamp,
      updatedAt: timestamp,
      ...(checklist.length > 0 ? { checklist } : {}),
    };
  }

  if (!existingGoal) {
    throw createHttpError(404, 'No session goal is set');
  }

  if (action === 'update-checklist' || action === 'update_checklist') {
    const checklist = normalizeChecklistItems(checklistInputValue(input), timestamp);
    return {
      objective: existingGoal.objective,
      status: existingGoal.status,
      createdAt: existingGoal.createdAt,
      updatedAt: timestamp,
      ...(existingGoal.completedAt ? { completedAt: existingGoal.completedAt } : {}),
      ...(checklist.length > 0 ? { checklist } : {}),
    };
  }

  const nextStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'complete';
  const checklist = Array.isArray(existingGoal.checklist) ? existingGoal.checklist : [];
  return {
    objective: existingGoal.objective,
    status: nextStatus,
    createdAt: existingGoal.createdAt,
    updatedAt: timestamp,
    ...(nextStatus === 'complete' ? { completedAt: timestamp } : {}),
    ...(checklist.length > 0 ? { checklist } : {}),
  };
}

function responseForConversation(conversation: any, overrides: any = {}) {
  return {
    conversation,
    goal: getSessionGoal(conversation),
    proposal: getSessionGoalProposal(conversation),
    cleared: false,
    goalChanged: false,
    proposalChanged: false,
    proposalCleared: false,
    ...overrides,
  };
}

export function applySessionGoalAction(store: any, conversationId: any, input: any = {}) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = store.getConversation(normalizedConversationId);

  if (!conversation) {
    throw createHttpError(404, 'Conversation not found');
  }

  const action = normalizeText(input.action).toLowerCase() || 'get';
  const existingGoal = getSessionGoal(conversation);
  const existingProposal = getSessionGoalProposal(conversation);
  const timestamp = nowIso();

  if (action === 'get') {
    return responseForConversation(conversation, {
      goal: existingGoal,
      proposal: existingProposal,
    });
  }

  if (action === 'clear') {
    const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithoutGoal(conversation));
    return responseForConversation(nextConversation, {
      goal: null,
      proposal: null,
      cleared: true,
      goalChanged: true,
      proposalChanged: Boolean(existingProposal),
      proposalCleared: Boolean(existingProposal),
    });
  }

  if (action === 'dismiss-proposal' || action === 'dismiss_proposal') {
    const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithoutProposal(conversation));
    return responseForConversation(nextConversation, {
      proposal: null,
      proposalChanged: Boolean(existingProposal),
      proposalCleared: Boolean(existingProposal),
    });
  }

  if (action === 'accept-proposal' || action === 'accept_proposal') {
    if (!existingProposal) {
      throw createHttpError(404, 'No session goal proposal is pending');
    }

    if (existingProposal.action === 'clear') {
      const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithoutGoal(conversation));
      return responseForConversation(nextConversation, {
        goal: null,
        proposal: null,
        cleared: true,
        goalChanged: true,
        proposalChanged: true,
        proposalCleared: true,
      });
    }

    const goal = goalFromMutation(existingProposal.action, existingGoal, existingProposal, timestamp);
    const nextConversation = updateConversationGoal(store, conversation, goal);
    return responseForConversation(nextConversation, {
      goal: getSessionGoal(nextConversation),
      proposal: null,
      goalChanged: true,
      proposalChanged: true,
      proposalCleared: true,
    });
  }

  if (!SESSION_GOAL_ACTIONS.has(action)) {
    throw createHttpError(400, 'Unsupported goal action');
  }

  if (action === 'clear') {
    const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithoutGoal(conversation));
    return responseForConversation(nextConversation, {
      goal: null,
      proposal: null,
      cleared: true,
      goalChanged: true,
      proposalChanged: Boolean(existingProposal),
      proposalCleared: Boolean(existingProposal),
    });
  }

  const goal = goalFromMutation(action, existingGoal, input, timestamp);
  const nextConversation = updateConversationGoal(store, conversation, goal);
  return responseForConversation(nextConversation, {
    goal: getSessionGoal(nextConversation),
    proposal: null,
    goalChanged: true,
    proposalChanged: Boolean(existingProposal),
    proposalCleared: Boolean(existingProposal),
    autoContinue: action !== 'update-checklist' && action !== 'update_checklist',
  });
}

export function proposeSessionGoalAction(store: any, conversationId: any, input: any = {}, proposer: any = {}) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = store.getConversation(normalizedConversationId);

  if (!conversation) {
    throw createHttpError(404, 'Conversation not found');
  }

  const action = normalizeProposalAction(input.action);

  if (!action) {
    throw createHttpError(400, 'Unsupported goal proposal action');
  }

  const existingGoal = getSessionGoal(conversation);

  if (action !== 'set' && !existingGoal) {
    throw createHttpError(404, 'No session goal is set');
  }

  const objective = action === 'set' ? normalizeObjective(input.objective) : '';
  const reason = normalizeProposalReason(input.reason);
  const timestamp = nowIso();
  const proposal = {
    action,
    status: 'pending',
    ...(objective ? { objective } : {}),
    ...(reason ? { reason } : {}),
    proposedBy: {
      agentId: normalizeText(proposer.agentId),
      agentName: normalizeText(proposer.agentName) || 'Assistant',
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const nextConversation = updateConversationProposal(store, conversation, proposal);

  return responseForConversation(nextConversation, {
    goal: existingGoal,
    proposal: getSessionGoalProposal(nextConversation),
    proposalChanged: true,
  });
}

export function createSessionGoalBudgetProposal(store: any, conversationId: any, input: any = {}) {
  const reason = normalizeProposalReason(
    input.reason || 'Automatic goal continuation reached its safety budget. Confirm whether to pause, replace, or continue the goal.'
  );
  return proposeSessionGoalAction(
    store,
    conversationId,
    {
      action: 'pause',
      reason,
    },
    {
      agentId: 'goal-runner',
      agentName: 'Goal Runner',
    }
  );
}

function formatGoalChecklistForPrompt(goal: any) {
  const checklist = goal && Array.isArray(goal.checklist) ? goal.checklist : [];

  if (checklist.length === 0) {
    return '';
  }

  const doneCount = checklist.filter((item: any) => item && item.status === 'done').length;
  const lines = checklist.map((item: any) => {
    const status = item && item.status === 'done' ? 'x' : item && item.status === 'in_progress' ? '~' : ' ';
    return `- [${status}] ${item.text}`;
  });

  return [`Checklist progress: ${doneCount}/${checklist.length} complete.`, ...lines].join('\n');
}

function formatGoalProposalForPrompt(proposal: any) {
  if (!proposal) {
    return '';
  }

  return [
    `Pending user-confirmation proposal: ${proposal.action}`,
    proposal.objective ? `Proposed objective: ${proposal.objective}` : '',
    proposal.reason ? `Agent reason: ${proposal.reason}` : '',
    proposal.proposedBy && proposal.proposedBy.agentName ? `Proposed by: ${proposal.proposedBy.agentName}` : '',
    'Do not assume this proposal is applied until the user confirms it in the UI or with a goal command.',
  ].filter(Boolean).join('\n');
}

export function formatSessionGoalForPrompt(conversation: any) {
  const goal = getSessionGoal(conversation);
  const proposal = getSessionGoalProposal(conversation);

  if (!goal && !proposal) {
    return '';
  }

  const goalLines = goal
    ? (() => {
        const statusLabel = goal.status === 'paused' ? 'paused' : goal.status === 'complete' ? 'complete' : 'active';
        const guidance = goal.status === 'paused'
          ? 'The goal is paused; keep it in context but do not actively drive new work toward it unless the user resumes or asks.'
          : goal.status === 'complete'
            ? 'The goal is marked complete; treat it as completed context, not an instruction to continue work.'
            : 'Use this as the current completion target and keep replies aligned with it. If the goal appears finished or blocked, create a goal proposal instead of directly changing the goal.';

        return [
          `Status: ${statusLabel}`,
          `Objective: ${goal.objective}`,
          formatGoalChecklistForPrompt(goal),
          goal.status === 'active' && Array.isArray(goal.checklist) && goal.checklist.length > 0
            ? 'Keep the checklist current as work progresses; use update-goal-checklist for factual progress updates.'
            : '',
          guidance,
        ].filter(Boolean).join('\n');
      })()
    : 'No active session goal is currently set.';

  const proposalLines = formatGoalProposalForPrompt(proposal);

  return [goalLines, proposalLines].filter(Boolean).join('\n');
}
