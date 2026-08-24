import { randomUUID } from 'node:crypto';

import { createHttpError } from '../../http/http-errors';

const SESSION_GOAL_METADATA_KEY = 'sessionGoal';
const SESSION_GOAL_PROPOSAL_METADATA_KEY = 'sessionGoalProposal';
const SESSION_GOAL_RULING_METADATA_KEY = 'sessionGoalRuling';
const SESSION_GOAL_RUNNER_METADATA_KEY = 'sessionGoalRunner';
const SESSION_GOAL_STATUSES = new Set(['active', 'paused', 'complete']);
const SESSION_GOAL_PROPOSAL_ACTIONS = new Set(['set', 'pause', 'resume', 'complete', 'clear']);
const SESSION_GOAL_RULING_OUTCOMES = new Set(['accepted', 'rejected']);
const SESSION_GOAL_ACTIONS = new Set(['set', 'pause', 'resume', 'complete', 'clear', 'set-owner', 'set_owner', 'update-checklist', 'update_checklist']);
const SESSION_GOAL_CHECKLIST_STATUSES = new Set(['todo', 'in_progress', 'done']);
const MAX_SESSION_GOAL_OBJECTIVE_LENGTH = 2000;
const MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH = 1000;
const MAX_SESSION_GOAL_CHECKLIST_ITEMS = 20;
const MAX_SESSION_GOAL_CHECKLIST_ITEM_LENGTH = 200;
const MAX_SESSION_GOAL_FAILURE_SUMMARY_LENGTH = 240;
const MAX_SESSION_GOAL_FAILURE_REASON_LENGTH = 500;
const SESSION_GOAL_MODEL_FAILURE_KINDS = new Set(['provider', 'timeout', 'process_exit']);
const DEFAULT_SESSION_GOAL_CHECKLIST_TEXTS = [
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

function nowIso() {
  return new Date().toISOString();
}

/**
 * Unique proposal id. Consumers (e.g. the DAG scheduler) derive idempotency
 * keys from the proposal; createdAt alone has only millisecond resolution
 * and two proposals in the same ms would collide.
 */
function newProposalId() {
  return `prop_${randomUUID()}`;
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

function redactGoalFailureSummary(value: any) {
  let text = normalizeText(value).replace(/\s+/gu, ' ');
  text = text.replace(/(authorization\s*[:=]\s*bearer\s+)([^\s,;]+)/giu, '$1[redacted]');
  text = text.replace(/(authorization\s*[:=]\s*)(?!bearer\b)([^\s,;]+)/giu, '$1[redacted]');
  text = text.replace(/((?:api[_ -]?key|token|secret|password|passwd)\s*[:=]\s*)([^\s,;]+)/giu, '$1[redacted]');
  text = text.replace(/\bsk-[a-z0-9_-]{6,}\b/giu, '[redacted]');
  return clipText(text, MAX_SESSION_GOAL_FAILURE_SUMMARY_LENGTH);
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

function normalizeGoalOwner(value: any) {
  const source = isPlainObject(value) ? value : {};
  const agentId = normalizeText(source.agentId);

  if (!agentId) {
    return null;
  }

  return {
    agentId,
    agentName: normalizeText(source.agentName) || agentId,
  };
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

export function defaultSessionGoalChecklistText() {
  return DEFAULT_SESSION_GOAL_CHECKLIST_TEXTS.map((text) => `[ ] ${text}`).join('\n');
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
  const owner = normalizeGoalOwner(value.owner);

  return {
    objective,
    status,
    createdAt,
    updatedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(owner ? { owner } : {}),
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
  const proposalId = normalizeText(value.id);
  const checklist = action === 'set'
    ? (hasChecklistInput(value) ? normalizeChecklistItems(checklistInputValue(value), updatedAt) : normalizeChecklistItems(defaultSessionGoalChecklistText(), updatedAt))
    : [];

  return {
    action,
    status: 'pending',
    ...(proposalId ? { id: proposalId } : {}),
    ...(objective ? { objective } : {}),
    ...(reason ? { reason } : {}),
    ...(action === 'set' ? { checklist } : {}),
    proposedBy: {
      agentId: normalizeText(proposedBy.agentId),
      agentName: normalizeText(proposedBy.agentName) || 'Assistant',
    },
    createdAt,
    updatedAt,
  };
}

/**
 * Who ruled on a proposal. `user` = UI/REST manual ruling (forced
 * server-side by the controller, never client-supplied); `agent` = bridge
 * ruling by a participant agent; `system` = no authoritative principal was
 * recorded (internal/legacy call) — the DAG scheduler never treats a system
 * ruling as a valid verification.
 */
function normalizeRuledBy(value: any) {
  const source = isPlainObject(value) ? value : {};
  const kind = normalizeText(source.kind).toLowerCase();
  if (kind === 'user' || kind === 'system') {
    return { kind };
  }
  const agentId = normalizeText(source.agentId);
  if (agentId) {
    return {
      kind: 'agent',
      agentId,
      agentName: normalizeText(source.agentName) || 'Assistant',
    };
  }
  return { kind: 'system' };
}

/**
 * Durable ruling record (D28). Written ATOMICALLY with the proposal clear /
 * goal mutation so a crash between mutation and event broadcast never loses
 * the verdict: the DAG scheduler validates THIS record (outcome, ruled
 * proposal snapshot, ruling principal) at settle/reconcile time instead of
 * trusting the ephemeral cleared-event payload.
 */
function normalizeSessionGoalRuling(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }
  const outcome = normalizeText(value.outcome).toLowerCase();
  if (!SESSION_GOAL_RULING_OUTCOMES.has(outcome)) {
    return null;
  }
  const action = normalizeProposalAction(value.action);
  if (!action) {
    return null;
  }
  const proposalSnapshot = normalizeSessionGoalProposal(value.proposalSnapshot || value.proposal_snapshot);
  if (!proposalSnapshot) {
    return null;
  }
  const proposalId = normalizeText(value.proposalId || value.proposal_id);
  const snapshotProposalId = normalizeText(proposalSnapshot.id);
  if (!proposalId || !snapshotProposalId || proposalId !== snapshotProposalId) {
    return null;
  }
  const reason = clipText(value.reason, MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH);
  return {
    id: normalizeText(value.id) || `ruling_${randomUUID()}`,
    proposalId,
    action,
    outcome,
    ...(reason ? { reason } : {}),
    ruledBy: normalizeRuledBy(value.ruledBy || value.ruled_by),
    proposalSnapshot,
    ruledAt: normalizeText(value.ruledAt || value.ruled_at) || nowIso(),
  };
}

function buildRulingRecord(proposal: any, outcome: string, ruledBy: any, reason: any, timestamp: string) {
  const snapshot = normalizeSessionGoalProposal(proposal);
  if (!snapshot) {
    throw createHttpError(500, 'Cannot record a ruling without a valid proposal snapshot');
  }
  const proposalId = normalizeText(snapshot.id) || newProposalId();
  const proposalSnapshot = {
    ...snapshot,
    id: proposalId,
  };
  const normalizedReason = clipText(reason, MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH);
  return {
    id: `ruling_${randomUUID()}`,
    proposalId,
    action: proposalSnapshot.action,
    outcome,
    ...(normalizedReason ? { reason: normalizedReason } : {}),
    ruledBy: normalizeRuledBy(ruledBy),
    proposalSnapshot,
    ruledAt: timestamp,
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
  const consecutiveModelFailureCount = Math.max(
    0,
    Number.parseInt(String(value.consecutiveModelFailureCount || value.consecutive_model_failure_count || '0'), 10) || 0
  );
  const failureThreshold = Math.max(
    2,
    Number.parseInt(String(value.failureThreshold || value.failure_threshold || '3'), 10) || 3
  );
  const failureStreakStartedAt = normalizeText(value.failureStreakStartedAt || value.failure_streak_started_at);
  const lastFailureAt = normalizeText(value.lastFailureAt || value.last_failure_at);
  const lastFailureKindValue = normalizeText(value.lastFailureKind || value.last_failure_kind).toLowerCase();
  const lastFailureKind = SESSION_GOAL_MODEL_FAILURE_KINDS.has(lastFailureKindValue) ? lastFailureKindValue : '';
  const lastFailureCode = clipText(value.lastFailureCode || value.last_failure_code, 80);
  const lastFailureSummary = redactGoalFailureSummary(value.lastFailureSummary || value.last_failure_summary);
  const pauseReason = clipText(value.pauseReason || value.pause_reason, MAX_SESSION_GOAL_FAILURE_REASON_LENGTH);
  const errorPausedAt = normalizeText(value.errorPausedAt || value.error_paused_at);

  return {
    status,
    goalUpdatedAt,
    iteration,
    maxIterations,
    updatedAt,
    ...(lastContinuedAt ? { lastContinuedAt } : {}),
    consecutiveModelFailureCount,
    failureThreshold,
    ...(failureStreakStartedAt ? { failureStreakStartedAt } : {}),
    ...(lastFailureAt ? { lastFailureAt } : {}),
    ...(lastFailureKind ? { lastFailureKind } : {}),
    ...(lastFailureCode ? { lastFailureCode } : {}),
    ...(lastFailureSummary ? { lastFailureSummary } : {}),
    ...(pauseReason ? { pauseReason } : {}),
    ...(errorPausedAt ? { errorPausedAt } : {}),
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

export function getSessionGoalRuling(conversation: any) {
  const metadata = conversation && isPlainObject(conversation.metadata) ? conversation.metadata : {};
  return normalizeSessionGoalRuling(metadata[SESSION_GOAL_RULING_METADATA_KEY]);
}

export function getSessionGoalRunner(conversation: any) {
  const metadata = conversation && isPlainObject(conversation.metadata) ? conversation.metadata : {};
  return normalizeSessionGoalRunner(metadata[SESSION_GOAL_RUNNER_METADATA_KEY]);
}

export function isSessionGoalModelFailurePaused(conversation: any) {
  const goal = getSessionGoal(conversation);
  const runner = getSessionGoalRunner(conversation);

  return Boolean(
    goal
    && goal.status === 'paused'
    && runner
    && runner.status === 'error_paused'
    && runner.goalUpdatedAt === goalRunnerKey(goal)
    && runner.consecutiveModelFailureCount >= runner.failureThreshold
  );
}

function currentMetadata(conversation: any) {
  return conversation && isPlainObject(conversation.metadata) ? conversation.metadata : {};
}

function buildMetadataWithGoal(conversation: any, goal: any, options: any = {}) {
  const metadata = currentMetadata(conversation);
  const {
    [SESSION_GOAL_PROPOSAL_METADATA_KEY]: _proposal,
    [SESSION_GOAL_RULING_METADATA_KEY]: _ruling,
    [SESSION_GOAL_RUNNER_METADATA_KEY]: existingRunner,
    ...remainingMetadata
  } = metadata;
  return {
    ...remainingMetadata,
    ...(!options.clearRunner && existingRunner ? { [SESSION_GOAL_RUNNER_METADATA_KEY]: existingRunner } : {}),
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
    [SESSION_GOAL_RULING_METADATA_KEY]: _ruling,
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
  // metadata-only 写入：不传 title，避免 titleSource 状态机误判为 manual 改名。
  return store.updateConversation(conversation.id, {
    type: conversation.type,
    metadata,
  });
}

function updateConversationGoal(store: any, conversation: any, goal: any, options: any = {}) {
  return updateConversationMetadata(store, conversation, buildMetadataWithGoal(conversation, goal, options));
}

function updateConversationProposal(store: any, conversation: any, proposal: any) {
  return updateConversationMetadata(store, conversation, buildMetadataWithProposal(conversation, proposal));
}

function updateConversationProposalChecklist(store: any, conversation: any, checklist: any, timestamp: string) {
  const proposal = getSessionGoalProposal(conversation);
  if (!proposal) {
    throw createHttpError(404, 'No session goal proposal is pending');
  }

  const { checklist: _checklist, ...proposalWithoutChecklist } = proposal;
  const nextProposal = {
    ...proposalWithoutChecklist,
    updatedAt: timestamp,
    checklist,
  };
  return updateConversationProposal(store, conversation, nextProposal);
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
  const sameEpochRunner = existingRunner && existingRunner.goalUpdatedAt === key ? existingRunner : null;
  const currentIteration = sameEpochRunner ? sameEpochRunner.iteration : 0;

  if (currentIteration >= maxIterations) {
    const timestamp = nowIso();
    const nextRunner = {
      ...(sameEpochRunner || {}),
      status: 'budget_limited',
      goalUpdatedAt: key,
      iteration: currentIteration,
      maxIterations,
      updatedAt: timestamp,
      ...(sameEpochRunner && sameEpochRunner.lastContinuedAt ? { lastContinuedAt: sameEpochRunner.lastContinuedAt } : {}),
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
    ...(sameEpochRunner || {}),
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

function runnerWithoutFailureStreak(runner: any, timestamp: string) {
  const {
    consecutiveModelFailureCount: _failureCount,
    failureStreakStartedAt: _streakStartedAt,
    lastFailureAt: _lastFailureAt,
    lastFailureKind: _lastFailureKind,
    lastFailureCode: _lastFailureCode,
    lastFailureSummary: _lastFailureSummary,
    pauseReason: _pauseReason,
    errorPausedAt: _errorPausedAt,
    ...remainingRunner
  } = runner || {};

  return {
    ...remainingRunner,
    status: remainingRunner.status === 'error_paused' ? 'running' : remainingRunner.status || 'running',
    consecutiveModelFailureCount: 0,
    updatedAt: timestamp,
  };
}

function isGoalRunnerSourceMessage(message: any) {
  const metadata = message && isPlainObject(message.metadata) ? message.metadata : {};
  return Boolean(metadata.goalAutoContinue) && normalizeText(metadata.source).toLowerCase() === 'goal-runner';
}

export function recordSessionGoalContinuationOutcome(store: any, conversationId: any, input: any = {}) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = store.getConversation(normalizedConversationId);
  const goal = getSessionGoal(conversation);

  if (!conversation || !goal || goal.status !== 'active') {
    return { changed: false, paused: false, conversation, goal, runner: getSessionGoalRunner(conversation) };
  }

  const turn = isPlainObject(input.turn) ? input.turn : {};
  if (Boolean(turn.stopRequested) || normalizeText(turn.terminationReason) === 'stopped_by_user') {
    return { changed: false, paused: false, conversation, goal, runner: getSessionGoalRunner(conversation) };
  }

  const sourceMessages = Array.isArray(input.sourceMessages) ? input.sourceMessages : [];
  const goalRunnerBatch = sourceMessages.length > 0 && sourceMessages.every(isGoalRunnerSourceMessage);
  const failures = Array.isArray(input.failures) ? input.failures : [];
  const replies = Array.isArray(input.replies) ? input.replies : [];
  const completedCount = Math.max(0, Number(turn.completedCount || 0) || 0, replies.length);
  const currentRunner = getSessionGoalRunner(conversation);
  const key = goalRunnerKey(goal);
  const sameEpochRunner = currentRunner && currentRunner.goalUpdatedAt === key ? currentRunner : null;
  const currentFailureCount = sameEpochRunner ? sameEpochRunner.consecutiveModelFailureCount : 0;
  const occurredAt = normalizeText(turn.endedAt) || nowIso();

  function resetStreak(reason: string) {
    if (!sameEpochRunner || currentFailureCount === 0) {
      return { changed: false, paused: false, reason, conversation, goal, runner: currentRunner };
    }
    const nextRunner = runnerWithoutFailureStreak(sameEpochRunner, occurredAt);
    const nextConversation = updateConversationGoalRunner(store, conversation, nextRunner);
    return {
      changed: true,
      paused: false,
      reason,
      conversation: nextConversation,
      goal: getSessionGoal(nextConversation),
      runner: getSessionGoalRunner(nextConversation),
    };
  }

  if (!goalRunnerBatch) {
    return resetStreak('ordinary_user_turn');
  }

  if (completedCount > 0) {
    return resetStreak('completed_reply');
  }

  const startedAtMs = Date.parse(normalizeText(turn.startedAt));
  const endedAtMs = Date.parse(occurredAt);
  const fastFailureMs = Math.max(1, Number(input.fastFailureMs) || 60_000);
  const failureWindowMs = Math.max(fastFailureMs, Number(input.failureWindowMs) || 5 * 60_000);
  const failureThreshold = Math.max(2, Number.parseInt(String(input.failureThreshold || '3'), 10) || 3);
  const durationMs = endedAtMs - startedAtMs;
  const invocationFailures = failures
    .map((failure: any) => failure && isPlainObject(failure.invocationFailure) ? failure.invocationFailure : null)
    .filter(Boolean);
  const pureModelInvocationFailure = failures.length > 0
    && invocationFailures.length === failures.length
    && invocationFailures.every((failure: any) => (
      failure.eligible === true
      && SESSION_GOAL_MODEL_FAILURE_KINDS.has(normalizeText(failure.kind).toLowerCase())
    ));
  const fastFailure = Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= fastFailureMs;

  if (!pureModelInvocationFailure || !fastFailure) {
    return resetStreak(pureModelInvocationFailure ? 'slow_failure' : 'non_model_failure');
  }

  const previousStartedAtMs = sameEpochRunner && sameEpochRunner.failureStreakStartedAt
    ? Date.parse(sameEpochRunner.failureStreakStartedAt)
    : Number.NaN;
  const withinWindow = currentFailureCount > 0
    && Number.isFinite(previousStartedAtMs)
    && endedAtMs - previousStartedAtMs <= failureWindowMs;
  const nextFailureCount = withinWindow ? currentFailureCount + 1 : 1;
  const streakStartedAt = withinWindow && sameEpochRunner
    ? sameEpochRunner.failureStreakStartedAt
    : occurredAt;
  const lastFailure = invocationFailures[0];
  const lastFailureKind = normalizeText(lastFailure.kind).toLowerCase();
  const lastFailureCode = clipText(lastFailure.code, 80) || 'model_invocation_failed';
  const lastFailureSummary = redactGoalFailureSummary(lastFailure.summary || failures[0].errorMessage)
    || 'Provider/model invocation failed';
  const baseRunner = sameEpochRunner || {
    status: 'running',
    goalUpdatedAt: key,
    iteration: 0,
    maxIterations: 0,
  };

  if (nextFailureCount < failureThreshold) {
    const nextRunner = {
      ...baseRunner,
      status: 'running',
      goalUpdatedAt: key,
      consecutiveModelFailureCount: nextFailureCount,
      failureThreshold,
      failureStreakStartedAt: streakStartedAt,
      lastFailureAt: occurredAt,
      lastFailureKind,
      lastFailureCode,
      lastFailureSummary,
      updatedAt: occurredAt,
    };
    const nextConversation = updateConversationGoalRunner(store, conversation, nextRunner);
    return {
      changed: true,
      paused: false,
      reason: 'failure_recorded',
      conversation: nextConversation,
      goal: getSessionGoal(nextConversation),
      runner: getSessionGoalRunner(nextConversation),
    };
  }

  const pauseReason = clipText(
    `连续 ${nextFailureCount} 次快速模型调用失败，Goal 已自动暂停。最后原因：${lastFailureSummary}`,
    MAX_SESSION_GOAL_FAILURE_REASON_LENGTH
  );
  const pausedGoal = {
    ...goal,
    status: 'paused',
    updatedAt: occurredAt,
  };
  const pausedRunner = {
    ...baseRunner,
    status: 'error_paused',
    goalUpdatedAt: occurredAt,
    consecutiveModelFailureCount: nextFailureCount,
    failureThreshold,
    failureStreakStartedAt: streakStartedAt,
    lastFailureAt: occurredAt,
    lastFailureKind,
    lastFailureCode,
    lastFailureSummary,
    pauseReason,
    errorPausedAt: occurredAt,
    updatedAt: occurredAt,
  };
  const metadata = currentMetadata(conversation);
  const {
    [SESSION_GOAL_PROPOSAL_METADATA_KEY]: _proposal,
    [SESSION_GOAL_RULING_METADATA_KEY]: _ruling,
    ...remainingMetadata
  } = metadata;
  const nextConversation = updateConversationMetadata(store, conversation, {
    ...remainingMetadata,
    [SESSION_GOAL_METADATA_KEY]: pausedGoal,
    [SESSION_GOAL_RUNNER_METADATA_KEY]: pausedRunner,
  });

  return {
    changed: true,
    paused: true,
    reason: 'error_paused',
    conversation: nextConversation,
    goal: getSessionGoal(nextConversation),
    runner: getSessionGoalRunner(nextConversation),
  };
}

function goalFromMutation(action: string, existingGoal: any, input: any, timestamp: string) {
  if (action === 'set') {
    const checklist = hasChecklistInput(input)
      ? normalizeChecklistItems(checklistInputValue(input), timestamp)
      : normalizeChecklistItems(defaultSessionGoalChecklistText(), timestamp);
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
      ...(existingGoal.owner ? { owner: existingGoal.owner } : {}),
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
    ...(existingGoal.owner ? { owner: existingGoal.owner } : {}),
    ...(nextStatus === 'complete' ? { completedAt: timestamp } : {}),
    ...(checklist.length > 0 ? { checklist } : {}),
  };
}

function responseForConversation(conversation: any, overrides: any = {}) {
  return {
    conversation,
    goal: getSessionGoal(conversation),
    proposal: getSessionGoalProposal(conversation),
    ruling: getSessionGoalRuling(conversation),
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
      clearedProposal: existingProposal || null,
    });
  }

  if (action === 'dismiss-proposal' || action === 'dismiss_proposal') {
    // D28 durable ruling: the rejection (who ruled + feedback reason + the
    // ruled proposal snapshot) is persisted in the SAME write that clears
    // the proposal, so a crash before the cleared-event broadcast never
    // loses the verdict — the scheduler re-drives feedback from this record.
    let metadata = buildMetadataWithoutProposal(conversation);
    if (existingProposal) {
      metadata = {
        ...metadata,
        [SESSION_GOAL_RULING_METADATA_KEY]: buildRulingRecord(existingProposal, 'rejected', input.ruledBy, input.reason, timestamp),
      };
    }
    const nextConversation = updateConversationMetadata(store, conversation, metadata);
    return responseForConversation(nextConversation, {
      proposal: null,
      proposalChanged: Boolean(existingProposal),
      proposalCleared: Boolean(existingProposal),
      clearedProposal: existingProposal || null,
    });
  }

  if (action === 'accept-proposal' || action === 'accept_proposal') {
    if (!existingProposal) {
      throw createHttpError(404, 'No session goal proposal is pending');
    }

    if (existingProposal.action === 'clear') {
      // Approving a clear wipes the whole goal epoch — including rulings.
      const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithoutGoal(conversation));
      return responseForConversation(nextConversation, {
        goal: null,
        proposal: null,
        cleared: true,
        goalChanged: true,
        proposalChanged: true,
        proposalCleared: true,
        clearedProposal: existingProposal,
      });
    }

    const goal = goalFromMutation(existingProposal.action, existingGoal, existingProposal, timestamp);
    // Goal owner (D1): accepting a 'set' proposal stamps the proposer as the
    // goal owner — only on the accept-proposal path, so a client-supplied
    // proposedBy in a direct 'set' body can never forge an owner.
    const acceptedOwner = existingProposal.action === 'set'
      ? normalizeGoalOwner(existingProposal.proposedBy)
      : null;
    const goalWithOwner = acceptedOwner ? { ...goal, owner: acceptedOwner } : goal;
    // D28 durable ruling: goal mutation + proposal clear + ruling record in
    // ONE metadata write (buildMetadataWithGoal strips the stale proposal
    // and any prior ruling; the fresh ruling is then attached atomically).
    const metadata = {
      ...buildMetadataWithGoal(conversation, goalWithOwner, {
        clearRunner: existingProposal.action === 'set' || existingProposal.action === 'resume',
      }),
      [SESSION_GOAL_RULING_METADATA_KEY]: buildRulingRecord(existingProposal, 'accepted', input.ruledBy, input.reason, timestamp),
    };
    const nextConversation = updateConversationMetadata(store, conversation, metadata);
    return responseForConversation(nextConversation, {
      goal: getSessionGoal(nextConversation),
      proposal: null,
      goalChanged: true,
      proposalChanged: true,
      proposalCleared: true,
      clearedProposal: existingProposal,
    });
  }

  if (!SESSION_GOAL_ACTIONS.has(action)) {
    throw createHttpError(400, 'Unsupported goal action');
  }

  const checklistOnly = action === 'update-checklist' || action === 'update_checklist';
  if (checklistOnly && existingProposal && existingProposal.action === 'set') {
    const checklist = normalizeChecklistItems(checklistInputValue(input), timestamp);
    const nextConversation = updateConversationProposalChecklist(store, conversation, checklist, timestamp);
    return responseForConversation(nextConversation, {
      goal: existingGoal,
      proposal: getSessionGoalProposal(nextConversation),
      goalChanged: false,
      proposalChanged: true,
      checklistTarget: 'proposal',
      autoContinue: false,
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

  if (action === 'set-owner' || action === 'set_owner') {
    if (!existingGoal) {
      throw createHttpError(404, 'No session goal is set');
    }

    const ownerAgentId = normalizeText(input.ownerAgentId || input.owner_agent_id);
    let nextGoal: any;

    if (ownerAgentId) {
      const participants = Array.isArray(conversation.agents) ? conversation.agents : [];
      const agent = participants.find((participant: any) => participant && normalizeText(participant.id) === ownerAgentId);

      if (!agent) {
        throw createHttpError(400, 'Goal owner must be a current conversation participant');
      }

      nextGoal = {
        ...existingGoal,
        owner: {
          agentId: ownerAgentId,
          agentName: normalizeText(agent.name) || ownerAgentId,
        },
        updatedAt: timestamp,
      };
    } else {
      const { owner: _previousOwner, ...goalWithoutOwner } = existingGoal;
      nextGoal = { ...goalWithoutOwner, updatedAt: timestamp };
    }

    // set-owner is a factual owner change inside the current goal epoch: it
    // must not erase a pending proposal, the durable ruling, or runner state.
    // The updatedAt refresh rotates the epoch key, so a same-epoch runner is
    // atomically migrated to the new key in the SAME metadata write — an
    // owner change must never reset the continuation budget or drop the
    // failure streak. A stale (different-epoch) runner is left untouched.
    const existingRunner = getSessionGoalRunner(conversation);
    const previousEpochKey = goalRunnerKey(existingGoal);
    const nextEpochKey = goalRunnerKey(nextGoal);
    const migratedRunner = existingRunner
      && existingRunner.goalUpdatedAt === previousEpochKey
      && previousEpochKey !== nextEpochKey
      ? { ...existingRunner, goalUpdatedAt: nextEpochKey }
      : null;

    const nextMetadata: any = {
      ...currentMetadata(conversation),
      [SESSION_GOAL_METADATA_KEY]: nextGoal,
    };
    if (migratedRunner) {
      nextMetadata[SESSION_GOAL_RUNNER_METADATA_KEY] = migratedRunner;
    }
    const nextConversation = updateConversationMetadata(store, conversation, nextMetadata);
    return responseForConversation(nextConversation, {
      goal: getSessionGoal(nextConversation),
      proposal: getSessionGoalProposal(nextConversation),
      goalChanged: true,
      proposalChanged: false,
      autoContinue: false,
    });
  }

  const goal = goalFromMutation(action, existingGoal, input, timestamp);
  // Checklist progress is factual state inside the current goal epoch. It
  // must not erase a pending proposal or the durable ruling that proves how
  // the current lifecycle state was reached.
  const nextConversation = checklistOnly
    ? updateConversationMetadata(store, conversation, {
      ...currentMetadata(conversation),
      [SESSION_GOAL_METADATA_KEY]: goal,
    })
    : updateConversationGoal(store, conversation, goal, {
      clearRunner: action === 'set' || action === 'resume',
    });
  return responseForConversation(nextConversation, {
    goal: getSessionGoal(nextConversation),
    proposal: checklistOnly ? getSessionGoalProposal(nextConversation) : null,
    goalChanged: true,
    proposalChanged: checklistOnly ? false : Boolean(existingProposal),
    proposalCleared: checklistOnly ? false : Boolean(existingProposal),
    clearedProposal: checklistOnly ? null : existingProposal || null,
    autoContinue: !checklistOnly,
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
    id: newProposalId(),
    ...(objective ? { objective } : {}),
    ...(reason ? { reason } : {}),
    ...(action === 'set'
      ? { checklist: normalizeChecklistItems(
        hasChecklistInput(input) ? checklistInputValue(input) : defaultSessionGoalChecklistText(),
        timestamp
      ) }
      : {}),
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

/**
 * Fail-closed owner removal (D3): when the goal owner is no longer a
 * conversation participant, the goal is paused and a pending resume
 * proposal is created in ONE metadata write. A crash between the pause and
 * the proposal can therefore never leave an owner-less goal silently
 * continuing; the pending proposal also blocks future auto-continuation.
 */
export function pauseSessionGoalForRemovedOwner(store: any, conversationId: any, owner: any) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = store.getConversation(normalizedConversationId);
  const goal = conversation ? getSessionGoal(conversation) : null;

  if (!conversation || !goal || goal.status !== 'active') {
    return { changed: false, conversation, goal, proposal: conversation ? getSessionGoalProposal(conversation) : null };
  }

  const normalizedOwner = normalizeGoalOwner(owner);

  if (!normalizedOwner) {
    return { changed: false, conversation, goal, proposal: getSessionGoalProposal(conversation) };
  }

  const timestamp = nowIso();
  const pausedGoal = {
    ...goal,
    status: 'paused',
    updatedAt: timestamp,
  };
  const reason = clipText(
    `主理人 ${normalizedOwner.agentName} 已被移出会话，Goal 已自动暂停。请确认新的主理人后恢复 Goal。`,
    MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH
  );
  const proposal = {
    action: 'resume',
    status: 'pending',
    id: newProposalId(),
    reason,
    proposedBy: {
      agentId: 'goal-runner',
      agentName: 'Goal Runner',
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const existingProposal = getSessionGoalProposal(conversation);
  const nextMetadata: any = {
    ...currentMetadata(conversation),
    [SESSION_GOAL_METADATA_KEY]: pausedGoal,
  };
  // When another proposal is already pending, keep it: the user already has
  // an unresolved decision, and silently replacing it would destroy that
  // context. The paused goal blocks continuation either way, and a later
  // accepted resume re-triggers this check when the owner is still gone.
  if (!existingProposal) {
    nextMetadata[SESSION_GOAL_PROPOSAL_METADATA_KEY] = proposal;
  }
  const nextConversation = updateConversationMetadata(store, conversation, nextMetadata);

  return {
    changed: true,
    paused: true,
    reason: 'owner_removed',
    conversation: nextConversation,
    goal: getSessionGoal(nextConversation),
    runner: null,
    proposal: getSessionGoalProposal(nextConversation),
  };
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

  const checklist = Array.isArray(proposal.checklist) ? proposal.checklist : [];
  const checklistLines = checklist.map((item: any) => {
    const status = item && item.status === 'done' ? 'x' : item && item.status === 'in_progress' ? '~' : ' ';
    return `- [${status}] ${item.text}`;
  });

  return [
    `Pending user-confirmation proposal: ${proposal.action}`,
    proposal.objective ? `Proposed objective: ${proposal.objective}` : '',
    ...(checklistLines.length > 0 ? ['Proposed checklist:', ...checklistLines] : []),
    proposal.reason ? `Agent reason: ${proposal.reason}` : '',
    proposal.proposedBy && proposal.proposedBy.agentName ? `Proposed by: ${proposal.proposedBy.agentName}` : '',
    proposal.action === 'set'
      ? 'Before approval, update-goal-checklist edits this pending proposed checklist; it does not activate the goal.'
      : '',
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
          goal.owner ? `Owner: ${goal.owner.agentName}` : '',
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
