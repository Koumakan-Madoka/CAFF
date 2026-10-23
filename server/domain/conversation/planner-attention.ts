import { getSessionGoal, getSessionGoalProposal, getSessionGoalRuling, getSessionGoalRunner,
  isSessionGoalModelFailurePaused } from './session-goal';
import { filterRoutableConversationAgents } from '../roles/system-actor-catalog';

// Invoked inside the store's metadata transaction for every caller (browser,
// planner, agent and system), never from SSE. Only bounded metadata is read.
export function syncPlannerAttention(repository: any, conversationId: string,
  previousMetadata: any, nextMetadata: any, options: any = {}) {
  const previous = { metadata: previousMetadata || {} }, next = { metadata: nextMetadata || {} };
  const previousGoal = getSessionGoal(previous), nextGoal = getSessionGoal(next);
  const previousProposal = getSessionGoalProposal(previous), nextProposal = getSessionGoalProposal(next);
  const at = new Date().toISOString();

  function ensureProposal(goal: any, proposal: any) {
    if (!proposal?.id) return null;
    return repository.append({ conversationId, goalId: goal?.goalId || null, goalRevision: goal?.revision || 0,
      kind: 'proposal_pending', sourceId: proposal.id, summary: `Pending Goal ${proposal.action} proposal`,
      createdAt: proposal.createdAt });
  }

  const previousItem = ensureProposal(previousGoal, previousProposal);
  if (previousItem && previousProposal && previousProposal.id !== nextProposal?.id && !previousItem.resolvedAt) {
    // Clear may archive its final verdict without keeping a live projection.
    const ruling = [...(options.goalRulings || []), getSessionGoalRuling(next)]
      .find((entry: any) => entry?.proposalId === previousProposal.id);
    const resolution = ruling?.outcome === 'accepted' ? 'proposal_accepted'
      : ruling?.outcome === 'rejected' ? 'proposal_rejected' : 'proposal_superseded';
    repository.resolve(previousItem.sequence, resolution, ruling?.ruledBy || { kind: 'system' }, ruling?.ruledAt || at);
  }

  if (previousGoal && previousGoal.goalId !== nextGoal?.goalId) {
    const resolution = nextGoal ? 'goal_replaced' : 'goal_cleared';
    repository.resolveGoal(conversationId, previousGoal.goalId, resolution, at);
    repository.clearGoalConditions(conversationId, previousGoal.goalId);
  }
  ensureProposal(nextGoal, nextProposal);
  if (!nextGoal) return;

  if (options.goalAction === 'resume') repository.resolveKind(conversationId, nextGoal.goalId, 'turn_failed', 'goal_resumed', at);
  const runner = getSessionGoalRunner(next);
  const effectiveRunner = runner && runner.goalUpdatedAt === nextGoal.updatedAt ? runner : null;
  function ensure(kind: string, summary: string, createdAt = at) {
    repository.ensureCondition({ conversationId, goalId: nextGoal!.goalId, goalRevision: nextGoal!.revision,
      kind, summary, createdAt });
  }
  function resolve(kind: string, resolution: string) {
    repository.resolveKind(conversationId, nextGoal!.goalId, kind, resolution, at);
    repository.clearCondition(conversationId, kind);
  }

  if (nextGoal.status === 'complete') {
    for (const kind of ['budget_exhausted', 'failure_paused', 'owner_removed', 'turn_failed']) resolve(kind, 'goal_completed');
    ensure('goal_completed', 'Goal completed; planner acknowledgement required', nextGoal.completedAt || nextGoal.updatedAt);
    return;
  }
  // Completion notification remains pending until acknowledgement/retirement;
  // leaving complete ends the condition, so another completion gets a new ID.
  repository.clearCondition(conversationId, 'goal_completed');

  if (effectiveRunner && effectiveRunner.maxIterations > 0 && effectiveRunner.iteration >= effectiveRunner.maxIterations) {
    ensure('budget_exhausted', 'Goal runner continuation budget exhausted', effectiveRunner.updatedAt);
  } else if (nextGoal.status === 'active') {
    resolve('budget_exhausted', previousGoal?.status === 'paused' ? 'goal_resumed' : 'runner_cycle_changed');
  }

  if (isSessionGoalModelFailurePaused(next)) {
    ensure('failure_paused', 'Goal paused after repeated invocation failures', runner?.errorPausedAt || runner?.updatedAt);
  } else if (nextGoal.status === 'active') {
    resolve('failure_paused', 'goal_resumed');
  }

  const ownerId = nextGoal.owner?.agentId;
  if (ownerId) {
    const ownerPresent = filterRoutableConversationAgents(options.agents).some((agent: any) => agent.id === ownerId);
    const ownerWasPresent = filterRoutableConversationAgents(options.previousAgents).some((agent: any) => agent.id === ownerId);
    const ownerChanged = previousGoal?.owner?.agentId !== ownerId;
    if (!ownerPresent || options.ownerRemovedAgentId === ownerId) {
      ensure('owner_removed', 'Goal owner is no longer a routable Room participant');
    } else if (ownerChanged || options.ownerValidated === true || (Array.isArray(options.previousAgents) && !ownerWasPresent)) {
      // A lazy runtime may discover an unavailable owner still in the roster.
      // An unrelated write/restart is not proof that this condition was fixed.
      resolve('owner_removed', ownerChanged ? 'owner_assigned' : 'owner_restored');
    }
  }
}
