import { createHash, randomUUID } from 'node:crypto';

import { requiresBoundedConversationProjections } from '../../../lib/conversation-hydration-contract';
import { createHttpError } from '../../http/http-errors';
import { isNonRoutableSystemActorId } from '../roles/system-actor-catalog';
import {
  acceptedAdrChanges,
  incompleteAcceptanceCriteria,
  normalizeGoalDelivery,
  provisionalDecisionChanges,
  requireAcceptanceCriteria,
  structuralGoalProjection,
  validateGoalDelivery,
} from './goal-contract';

const SESSION_GOAL_METADATA_KEY = 'sessionGoal';
const SESSION_GOAL_PROPOSAL_METADATA_KEY = 'sessionGoalProposal';
const SESSION_GOAL_RULING_METADATA_KEY = 'sessionGoalRuling';
const SESSION_GOAL_RUNNER_METADATA_KEY = 'sessionGoalRunner';
const SESSION_GOAL_STATUSES = new Set(['active', 'paused', 'complete']);
const SESSION_GOAL_PROPOSAL_ACTIONS = new Set(['set', 'revise', 'pause', 'resume', 'complete', 'clear']);
const SESSION_GOAL_RULING_OUTCOMES = new Set(['accepted', 'rejected']);
const SESSION_GOAL_ACTIONS = new Set(['set', 'revise', 'pause', 'resume', 'complete', 'clear', 'set-owner', 'set_owner', 'update-delivery', 'update_delivery', 'update-checklist', 'update_checklist']);
const SESSION_GOAL_CHECKLIST_STATUSES = new Set(['todo', 'in_progress', 'done']);
const MAX_SESSION_GOAL_OBJECTIVE_LENGTH = 2000;
const MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH = 1000;
const MAX_SESSION_GOAL_CHECKLIST_ITEMS = 20;
const MAX_SESSION_GOAL_CHECKLIST_ITEM_LENGTH = 200;
const MAX_SESSION_GOAL_FAILURE_SUMMARY_LENGTH = 240;
const MAX_SESSION_GOAL_FAILURE_REASON_LENGTH = 500;
const SESSION_GOAL_MODEL_FAILURE_KINDS = new Set(['provider', 'timeout', 'process_exit']);
const DEFAULT_SESSION_GOAL_WORK_ITEM_TEXTS = [
  'Confirm the delivery contract and independent review',
  'Implement the smallest coherent behavior change',
  'Record criterion-linked verification evidence',
  'Run independent code review and resolve findings',
];

function nowIso() {
  return new Date().toISOString();
}

function newGoalId() {
  return `goal_${randomUUID()}`;
}

function legacyGoalId(createdAt: string, objective: string) {
  return `legacy_goal_${createHash('sha256').update(`${createdAt}\0${objective}`).digest('hex').slice(0, 24)}`;
}

function normalizeRevision(value: any) {
  const revision = Number(value === undefined || value === null ? 1 : value);
  return Number.isInteger(revision) && revision > 0 ? revision : 1;
}

function requestedGoalRevision(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }
  const raw = value.goalRevision ?? value.goal_revision ?? value.revision;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const revision = Number(raw);
  return Number.isInteger(revision) && revision > 0 ? revision : null;
}

function assertGoalRevision(existingGoal: any, input: any, options: any = {}) {
  const expectedRevision = requestedGoalRevision(input);
  if (expectedRevision === null && options.required) {
    throw createHttpError(400, 'Goal revision is required for this update', {
      code: 'goal_revision_required',
    });
  }
  if (expectedRevision !== null && existingGoal && expectedRevision !== existingGoal.revision) {
    throw createHttpError(409, `Goal revision ${expectedRevision} is stale; current revision is ${existingGoal.revision}`, {
      code: 'goal_revision_conflict',
      expectedRevision,
      currentRevision: existingGoal.revision,
    });
  }
  return expectedRevision;
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

export function defaultSessionGoalWorkItemsText() {
  return DEFAULT_SESSION_GOAL_WORK_ITEM_TEXTS.map((text) => `[ ] ${text}`).join('\n');
}

/** @deprecated Use defaultSessionGoalWorkItemsText. */
export function defaultSessionGoalChecklistText() {
  return defaultSessionGoalWorkItemsText();
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
  const storedCreatedAt = normalizeText(value.createdAt || value.created_at);
  const createdAt = storedCreatedAt || nowIso();
  const updatedAt = normalizeText(value.updatedAt || value.updated_at) || createdAt;
  const completedAt = normalizeText(value.completedAt || value.completed_at);
  const checklist = normalizeChecklistItems(value.checklist, updatedAt);
  const delivery = normalizeGoalDelivery(value, updatedAt, { legacyChecklist: checklist });
  const owner = normalizeGoalOwner(value.owner);
  const goalId = normalizeText(value.goalId || value.goal_id) || legacyGoalId(storedCreatedAt, objective);
  const revision = normalizeRevision(value.revision || value.goalRevision || value.goal_revision);

  return {
    goalId,
    revision,
    objective,
    status,
    createdAt,
    updatedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(owner ? { owner } : {}),
    ...delivery,
    ...(Array.isArray(value.changeNotices) ? { changeNotices: value.changeNotices.slice(-20) } : {}),
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

  if ((action === 'set' || action === 'revise') && !objective) {
    return null;
  }

  const proposedBy = isPlainObject(value.proposedBy) ? value.proposedBy : {};
  const createdAt = normalizeText(value.createdAt || value.created_at) || nowIso();
  const updatedAt = normalizeText(value.updatedAt || value.updated_at) || createdAt;
  const reason = clipText(value.reason, MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH);
  const impact = clipText(value.impact, MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH);
  const affectedWorkItems = Array.isArray(value.affectedWorkItems)
    ? value.affectedWorkItems.map((item: any) => clipText(item, 80)).filter(Boolean).slice(0, 40)
    : [];
  const proposalId = normalizeText(value.id);
  const baseRevision = requestedGoalRevision({ revision: value.baseRevision ?? value.base_revision });
  const checklist = action === 'set'
    ? (hasChecklistInput(value) ? normalizeChecklistItems(checklistInputValue(value), updatedAt) : [])
    : [];
  const delivery = action === 'set' || action === 'revise'
    ? normalizeGoalDelivery(value, updatedAt, { legacyChecklist: checklist })
    : null;

  return {
    action,
    status: 'pending',
    ...(proposalId ? { id: proposalId } : {}),
    ...(objective ? { objective } : {}),
    ...(reason ? { reason } : {}),
    ...(impact ? { impact } : {}),
    ...(affectedWorkItems.length > 0 ? { affectedWorkItems } : {}),
    ...(baseRevision !== null ? { baseRevision } : {}),
    ...(delivery ? delivery : {}),
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

function missingBoundedGoalProjection(name: string) {
  throw createHttpError(501, `Bounded conversation projection is unavailable: ${name}`);
}

function getGoalConversation(store: any, conversationId: any) {
  const normalizedConversationId = normalizeText(conversationId);

  if (store && typeof store.getConversationWithoutMessages === 'function') {
    return store.getConversationWithoutMessages(normalizedConversationId);
  }
  if (requiresBoundedConversationProjections(store)) {
    return missingBoundedGoalProjection('getConversationWithoutMessages');
  }

  return store && typeof store.getConversation === 'function'
    ? store.getConversation(normalizedConversationId)
    : null;
}

function updateConversationMetadata(store: any, conversation: any, metadata: any) {
  // metadata-only 写入：不传 title，避免 titleSource 状态机误判为 manual 改名。
  if (store && typeof store.updateConversationWithoutMessages === 'function') {
    return store.updateConversationWithoutMessages(conversation.id, {
      type: conversation.type,
      metadata,
    });
  }
  if (requiresBoundedConversationProjections(store)) {
    return missingBoundedGoalProjection('updateConversationWithoutMessages');
  }

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

  const proposalWithChecklist: any = proposal;
  const { checklist: _checklist, ...proposalWithoutChecklist } = proposalWithChecklist;
  const nextProposal: any = {
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
  const conversation = getGoalConversation(store, normalizedConversationId);

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
  const conversation = getGoalConversation(store, normalizedConversationId);
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
    revision: goal.revision + 1,
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
    const objective = normalizeObjective(input && input.objective);
    const delivery = normalizeGoalDelivery(input, timestamp, {
      legacyChecklist: hasChecklistInput(input) ? normalizeChecklistItems(checklistInputValue(input), timestamp) : [],
    });
    requireAcceptanceCriteria(delivery);
    return {
      objective,
      status: 'active',
      createdAt: existingGoal ? existingGoal.createdAt : timestamp,
      updatedAt: timestamp,
      goalId: newGoalId(),
      revision: 1,
      ...delivery,
    };
  }

  if (!existingGoal) {
    throw createHttpError(404, 'No session goal is set');
  }

  if (action === 'revise') {
    const objective = normalizeObjective(input && input.objective);
    const delivery = normalizeGoalDelivery(input, timestamp);
    requireAcceptanceCriteria(delivery);
    return {
      ...existingGoal,
      objective,
      revision: existingGoal.revision + 1,
      updatedAt: timestamp,
      ...delivery,
    };
  }

  if (action === 'update-delivery' || action === 'update_delivery') {
    const delivery = normalizeGoalDelivery(input, timestamp);
    validateGoalDelivery(delivery);
    const nextGoal = {
      ...existingGoal,
      revision: existingGoal.revision + 1,
      updatedAt: timestamp,
      ...delivery,
    };
    if (structuralGoalProjection(nextGoal) !== structuralGoalProjection(existingGoal)) {
      throw createHttpError(409, 'Factual Goal updates cannot change the objective, decisions, criteria, or work-item definitions', {
        code: 'goal_structural_review_required',
      });
    }
    const previousCriteria = new Map((existingGoal.acceptanceCriteria || []).map((criterion: any) => [criterion.id, criterion]));
    const newlyWaived = (nextGoal.acceptanceCriteria || []).filter((criterion: any) => {
      const previous: any = previousCriteria.get(criterion.id);
      return criterion.status === 'waived' && (!previous || previous.status !== 'waived');
    });
    if (newlyWaived.length > 0) {
      throw createHttpError(409, 'Acceptance waivers require a revise proposal and independent review', {
        code: 'goal_waiver_review_required',
        criterionIds: newlyWaived.map((criterion: any) => criterion.id),
      });
    }
    return nextGoal;
  }

  if (action === 'update-checklist' || action === 'update_checklist') {
    const workItems = normalizeGoalDelivery({
      workItems: normalizeChecklistItems(checklistInputValue(input), timestamp),
    }, timestamp).workItems;
    return {
      ...existingGoal,
      revision: existingGoal.revision + 1,
      updatedAt: timestamp,
      workItems,
    };
  }

  if (action === 'complete') {
    const incomplete = incompleteAcceptanceCriteria(existingGoal);
    if (incomplete.length > 0 || !Array.isArray(existingGoal.acceptanceCriteria) || existingGoal.acceptanceCriteria.length === 0) {
      throw createHttpError(409, 'Goal cannot complete until every acceptance criterion is passed or waived', {
        code: 'goal_acceptance_incomplete',
        criterionIds: incomplete.map((criterion: any) => criterion && criterion.id).filter(Boolean),
      });
    }
  }

  const nextStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'complete';
  return {
    ...existingGoal,
    goalId: existingGoal.goalId,
    revision: existingGoal.revision + 1,
    status: nextStatus,
    updatedAt: timestamp,
    ...(nextStatus === 'complete' ? { completedAt: timestamp } : { completedAt: undefined }),
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
  const conversation = getGoalConversation(store, normalizedConversationId);

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
    const ruling = existingProposal
      ? buildRulingRecord(existingProposal, 'rejected', input.ruledBy, input.reason, timestamp)
      : null;
    if (ruling?.ruledBy?.kind === 'agent'
      && ruling.ruledBy.agentId === existingProposal?.proposedBy?.agentId) {
      throw createHttpError(403, 'The proposer cannot review their own Goal proposal', {
        code: 'goal_proposal_self_review',
      });
    }
    // The rejection and proposal clear are persisted in the same write.
    let metadata = buildMetadataWithoutProposal(conversation);
    if (ruling) {
      metadata = {
        ...metadata,
        [SESSION_GOAL_RULING_METADATA_KEY]: ruling,
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

    if (existingProposal.action !== 'set') {
      assertGoalRevision(existingGoal, { revision: existingProposal.baseRevision }, {
        required: existingProposal.baseRevision !== undefined,
      });
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

    const ruling = buildRulingRecord(existingProposal, 'accepted', input.ruledBy, input.reason, timestamp);
    if (ruling.ruledBy.kind === 'agent'
      && ruling.ruledBy.agentId === existingProposal.proposedBy?.agentId) {
      throw createHttpError(403, 'The proposer cannot review their own Goal proposal', {
        code: 'goal_proposal_self_review',
      });
    }
    const goal = goalFromMutation(existingProposal.action, existingGoal, existingProposal, timestamp);
    const adrChanges = existingProposal.action === 'revise'
      ? acceptedAdrChanges(existingGoal, goal)
      : [];
    if (ruling.ruledBy.kind === 'agent' && adrChanges.length > 0) {
      throw createHttpError(403, 'Accepted ADR decisions can only be changed by the user', {
        code: 'goal_accepted_adr_change_user_required',
        changes: adrChanges,
      });
    }
    const previousCriteria = new Map((existingGoal && existingGoal.acceptanceCriteria || []).map((criterion: any) => [criterion.id, criterion]));
    const newlyWaivedHighRisk = (goal.acceptanceCriteria || []).filter((criterion: any) => {
      const previous: any = previousCriteria.get(criterion.id);
      return criterion.status === 'waived' && criterion.risk === 'high' && (!previous || previous.status !== 'waived');
    });
    if (ruling.ruledBy.kind === 'agent' && newlyWaivedHighRisk.length > 0) {
      throw createHttpError(403, 'High-risk acceptance criteria can only be waived by the user', {
        code: 'goal_high_risk_waiver_user_required',
        criterionIds: newlyWaivedHighRisk.map((criterion: any) => criterion.id),
      });
    }
    const reviewedGoal = newlyWaivedHighRisk.length > 0 || (goal.acceptanceCriteria || []).some((criterion: any) => {
      const previous: any = previousCriteria.get(criterion.id);
      return criterion.status === 'waived' && (!previous || previous.status !== 'waived');
    })
      ? {
          ...goal,
          acceptanceCriteria: (goal.acceptanceCriteria || []).map((criterion: any) => {
            const previous: any = previousCriteria.get(criterion.id);
            if (criterion.status !== 'waived' || (previous && previous.status === 'waived')) return criterion;
            const reviewer = ruling.ruledBy.kind === 'user'
              ? 'user'
              : ruling.ruledBy.agentName || ruling.ruledBy.agentId || 'reviewer';
            return {
              ...criterion,
              waiver: {
                ...(criterion.waiver || {}),
                reason: criterion.waiver?.reason || existingProposal.reason || 'Approved during Goal review',
                waivedBy: reviewer,
                waivedAt: timestamp,
              },
            };
          }),
        }
      : goal;
    // Goal owner: accepting a set proposal stamps the proposer as owner.
    const acceptedOwner = existingProposal.action === 'set'
      ? normalizeGoalOwner(existingProposal.proposedBy)
      : null;
    const goalWithOwner = acceptedOwner ? { ...reviewedGoal, owner: acceptedOwner } : reviewedGoal;
    const provisionalChanges = existingProposal.action === 'revise'
      ? provisionalDecisionChanges(existingGoal, goalWithOwner)
      : [];
    const changeNotice = provisionalChanges.length > 0
      ? {
          id: `notice_${randomUUID()}`,
          type: 'provisional_decision_changed',
          changes: provisionalChanges,
          reason: existingProposal.reason || '',
          impact: existingProposal.impact || '',
          affectedWorkItems: existingProposal.affectedWorkItems || [],
          reviewer: ruling.ruledBy,
          createdAt: timestamp,
        }
      : null;
    const goalWithNotice = changeNotice
      ? { ...goalWithOwner, changeNotices: [...(existingGoal?.changeNotices || []), changeNotice].slice(-20) }
      : goalWithOwner;
    const metadata = {
      ...buildMetadataWithGoal(conversation, goalWithNotice, {
        clearRunner: existingProposal.action === 'set' || existingProposal.action === 'resume',
      }),
      [SESSION_GOAL_RULING_METADATA_KEY]: ruling,
    };
    const nextConversation = updateConversationMetadata(store, conversation, metadata);
    return responseForConversation(nextConversation, {
      goal: getSessionGoal(nextConversation),
      proposal: null,
      goalChanged: true,
      proposalChanged: true,
      proposalCleared: true,
      clearedProposal: existingProposal,
      changeNotice,
    });
  }

  if (!SESSION_GOAL_ACTIONS.has(action)) {
    throw createHttpError(400, 'Unsupported goal action');
  }

  const factualOnly = action === 'update-checklist' || action === 'update_checklist'
    || action === 'update-delivery' || action === 'update_delivery';
  if (action === 'revise' || action === 'update-delivery' || action === 'update_delivery') {
    assertGoalRevision(existingGoal, input, { required: true });
  }
  if ((action === 'update-checklist' || action === 'update_checklist') && existingProposal && existingProposal.action === 'set') {
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
      if (isNonRoutableSystemActorId(ownerAgentId)) {
        throw createHttpError(400, 'Platform system actors cannot own session goals', {
          code: 'session_goal_owner_system_actor_not_routable',
        });
      }
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
        revision: existingGoal.revision + 1,
        updatedAt: timestamp,
      };
    } else {
      const { owner: _previousOwner, ...goalWithoutOwner } = existingGoal;
      nextGoal = { ...goalWithoutOwner, revision: existingGoal.revision + 1, updatedAt: timestamp };
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
  const factualRunner = factualOnly ? getSessionGoalRunner(conversation) : null;
  // Checklist progress is factual state inside the current goal epoch. It
  // must not erase a pending proposal or the durable ruling that proves how
  // the current lifecycle state was reached.
  const nextConversation = factualOnly
    ? updateConversationMetadata(store, conversation, {
      ...currentMetadata(conversation),
      [SESSION_GOAL_METADATA_KEY]: goal,
      ...(factualRunner && factualRunner.goalUpdatedAt === goalRunnerKey(existingGoal)
        ? {
          [SESSION_GOAL_RUNNER_METADATA_KEY]: {
            ...factualRunner,
            goalUpdatedAt: goalRunnerKey(goal),
            updatedAt: timestamp,
          },
        }
        : {}),
    })
    : updateConversationGoal(store, conversation, goal, {
      clearRunner: action === 'set' || action === 'resume',
    });
  return responseForConversation(nextConversation, {
    goal: getSessionGoal(nextConversation),
    proposal: factualOnly ? getSessionGoalProposal(nextConversation) : null,
    goalChanged: true,
    proposalChanged: factualOnly ? false : Boolean(existingProposal),
    proposalCleared: factualOnly ? false : Boolean(existingProposal),
    clearedProposal: factualOnly ? null : existingProposal || null,
    autoContinue: !factualOnly,
  });
}

export function proposeSessionGoalAction(store: any, conversationId: any, input: any = {}, proposer: any = {}) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = getGoalConversation(store, normalizedConversationId);

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
  if (action === 'revise') {
    assertGoalRevision(existingGoal, input);
  }

  if (action === 'complete' && existingGoal) {
    const incomplete = incompleteAcceptanceCriteria(existingGoal);
    if (incomplete.length > 0 || existingGoal.acceptanceCriteria.length === 0) {
      throw createHttpError(409, 'Goal completion cannot be proposed until every acceptance criterion is passed or waived', {
        code: 'goal_acceptance_incomplete',
        criterionIds: incomplete.map((criterion: any) => criterion && criterion.id).filter(Boolean),
      });
    }
  }

  const objective = action === 'set' || action === 'revise'
    ? normalizeObjective(input.objective || (existingGoal && existingGoal.objective))
    : '';
  const reason = normalizeProposalReason(input.reason);
  const timestamp = nowIso();
  const proposedDelivery = action === 'set' || action === 'revise'
    ? normalizeGoalDelivery(input, timestamp, {
        legacyChecklist: hasChecklistInput(input) ? normalizeChecklistItems(checklistInputValue(input), timestamp) : [],
      })
    : null;
  if (proposedDelivery) {
    requireAcceptanceCriteria(proposedDelivery);
  }
  if (action === 'revise') {
    const provisionalChanges = provisionalDecisionChanges(existingGoal, proposedDelivery);
    const impact = clipText(input.impact, MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH);
    if (provisionalChanges.length > 0 && (!reason || !impact)) {
      throw createHttpError(400, 'Changing a provisional decision requires both reason and impact', {
        code: 'goal_provisional_change_context_required',
        changes: provisionalChanges,
      });
    }
  }
  const proposal = {
    action,
    status: 'pending',
    id: newProposalId(),
    ...(objective ? { objective } : {}),
    ...(reason ? { reason } : {}),
    ...(action !== 'set' && existingGoal ? { baseRevision: existingGoal.revision } : {}),
    ...(proposedDelivery || {}),
    ...(clipText(input.impact, MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH) ? { impact: clipText(input.impact, MAX_SESSION_GOAL_PROPOSAL_REASON_LENGTH) } : {}),
    ...(Array.isArray(input.affectedWorkItems) ? { affectedWorkItems: input.affectedWorkItems } : {}),
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
 * conversation participant, the goal is paused in ONE metadata write. When
 * no proposal is pending, that same write also creates a pending resume
 * proposal; when the user already has a pending proposal, it is preserved
 * (never silently replaced) and the paused goal itself blocks future
 * auto-continuation. A crash between the pause and the proposal can
 * therefore never leave an owner-less goal silently continuing.
 */
export function pauseSessionGoalForRemovedOwner(store: any, conversationId: any, owner: any) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = getGoalConversation(store, normalizedConversationId);
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
    revision: goal.revision + 1,
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

function formatGoalDeliveryForPrompt(goal: any) {
  const workItems = goal && Array.isArray(goal.workItems) ? goal.workItems : [];
  const criteria = goal && Array.isArray(goal.acceptanceCriteria) ? goal.acceptanceCriteria : [];
  const evidence = goal && Array.isArray(goal.evidence) ? goal.evidence : [];
  const decisions = goal && goal.decisions && typeof goal.decisions === 'object' ? goal.decisions : {};
  const lines: string[] = [];

  for (const [label, field] of [
    ['Committed decisions', 'committed'],
    ['Provisional decisions', 'provisional'],
    ['Open questions', 'openQuestions'],
    ['Non-goals', 'nonGoals'],
    ['Rejected options', 'rejectedOptions'],
  ] as const) {
    const items = Array.isArray(decisions[field]) ? decisions[field] : [];
    if (items.length > 0) {
      lines.push(`${label}:`);
      for (const item of items) {
        lines.push(`- ${item.statement || item.question || item.option}`);
      }
    }
  }

  if (criteria.length > 0) {
    lines.push('Acceptance criteria:');
    for (const criterion of criteria) {
      lines.push(`- [${criterion.status}] ${criterion.statement} | verify: ${criterion.verifyBy || '(missing)'}`);
    }
  } else {
    lines.push('Acceptance criteria: MISSING. Revise the Goal before claiming completion.');
  }

  if (workItems.length > 0) {
    const doneCount = workItems.filter((item: any) => item && item.status === 'done').length;
    lines.push(`Work items: ${doneCount}/${workItems.length} complete.`);
    for (const item of workItems) {
      const status = item && item.status === 'done' ? 'x' : item && item.status === 'in_progress' ? '~' : ' ';
      lines.push(`- [${status}] ${item.text}`);
    }
  }

  if (evidence.length > 0) {
    lines.push('Evidence:');
    for (const item of evidence.slice(-20)) {
      lines.push(`- ${item.id} [${item.kind}]: ${item.summary}`);
    }
  }

  return lines.join('\n');
}

function formatGoalProposalForPrompt(proposal: any) {
  if (!proposal) {
    return '';
  }

  return [
    `Pending independent-review proposal: ${proposal.action}`,
    proposal.objective ? `Proposed objective: ${proposal.objective}` : '',
    proposal.action === 'set' || proposal.action === 'revise' ? formatGoalDeliveryForPrompt(proposal) : '',
    proposal.reason ? `Agent reason: ${proposal.reason}` : '',
    proposal.impact ? `Impact: ${proposal.impact}` : '',
    proposal.proposedBy && proposal.proposedBy.agentName ? `Proposed by: ${proposal.proposedBy.agentName}` : '',
    'The user may rule directly. Otherwise exactly one participant other than the proposer must accept or reject it.',
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
          formatGoalDeliveryForPrompt(goal),
          goal.status === 'active'
            ? 'Keep work items, criterion statuses, and evidence current with update-goal. Structural changes require a revise proposal and independent review.'
            : '',
          guidance,
        ].filter(Boolean).join('\n');
      })()
    : 'No active session goal is currently set.';

  const proposalLines = formatGoalProposalForPrompt(proposal);

  return [goalLines, proposalLines].filter(Boolean).join('\n');
}
