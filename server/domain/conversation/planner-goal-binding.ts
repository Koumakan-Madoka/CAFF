import { createHttpError } from '../../http/http-errors';

export const SESSION_GOAL_PLANNER_BINDING_KEY = 'sessionGoalPlannerBinding';
const own = (value: any, key: string) => Object.prototype.hasOwnProperty.call(value || {}, key);
const text = (value: any) => typeof value === 'string' ? value.trim() : '';

export function hasSessionGoalPlannerBinding(conversation: any) {
  // Presence, not successful normalization, is the enforcement anchor. A
  // malformed/stale/null binding must never turn into an unbound agent gate.
  return own(conversation?.metadata, SESSION_GOAL_PLANNER_BINDING_KEY);
}

export function getSessionGoalPlannerBinding(conversation: any) {
  const value = conversation?.metadata?.[SESSION_GOAL_PLANNER_BINDING_KEY];
  if (!value || Array.isArray(value) || !text(value.goalId) || !text(value.plannerId)
    || !text(value.plannerName) || !text(value.boundAt)) return null;
  return { goalId: value.goalId, plannerId: value.plannerId, plannerName: value.plannerName, boundAt: value.boundAt,
    ...(value.adoption ? { adoption: value.adoption } : {}) };
}

export function assertPlannerGoalRulingAllowed(conversation: any, principal: any) {
  if (principal.kind === 'user') return;
  if (principal.kind === 'planner' && own(conversation?.metadata, 'dagNodeGoalBinding')) {
    throw createHttpError(403, 'External planners cannot rule as DAG verifiers or the user', { code: 'dag_verifier_only' });
  }
  if (!hasSessionGoalPlannerBinding(conversation)) return;
  const binding = getSessionGoalPlannerBinding(conversation);
  if (principal.kind === 'planner' && binding && binding.plannerId === principal.plannerId
    && binding.goalId === conversation?.metadata?.sessionGoal?.goalId) return;
  throw createHttpError(403, 'Only the bound planner or the user may accept/reject this Goal proposal', { code: 'goal_planner_ruling_required' });
}

export function createSessionGoalPlannerBinding(conversation: any, goal: any, identity: any, boundAt: string, adoption?: any) {
  if (own(conversation?.metadata, 'dagNodeGoalBinding')) {
    throw createHttpError(403, 'DAG child Goals cannot be planner-bound', { code: 'dag_goal_mutation_forbidden' });
  }
  if (!text(identity?.plannerId) || !text(identity?.plannerName)) throw createHttpError(500, 'Configured planner identity is unavailable');
  return { goalId: goal.goalId, plannerId: identity.plannerId, plannerName: identity.plannerName, boundAt,
    ...(adoption ? { adoption } : {}) };
}
