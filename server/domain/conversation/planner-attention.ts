import { getSessionGoal, getSessionGoalProposal, getSessionGoalRuling } from './session-goal';

// Invoked inside the store's metadata transaction for every caller (browser,
// planner, agent and system), never from SSE. Only bounded metadata is read.
export function syncPlannerProposalAttention(repository: any, conversationId: string,
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
  }
  ensureProposal(nextGoal, nextProposal);
}
