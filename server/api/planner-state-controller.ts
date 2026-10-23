import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { sendJson } from '../http/response';

const STATE_BYTES = 64 * 1024;
function unavailable(): never {
  throw createHttpError(501, 'Bounded planner projection unavailable', { code: 'planner_projection_unavailable' });
}
function budget(value: any, bytes: number) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > bytes) unavailable();
  return value;
}
export function createPlannerStateController({ store, turnOrchestrator }: any): RouteHandler<any> {
  function capability(owner: any, key: string) {
    if (typeof owner?.[key] !== 'function') unavailable();
  }
  function state(item: any) {
    capability(turnOrchestrator, 'getPlannerBusyState');
    const busy = turnOrchestrator.getPlannerBusyState(item.conversationId) === true;
    return { ...item.state, busy };
  }
  return async ({ req, res, pathname, principal }) => {
    const match = pathname.match(/^\/api\/planner\/conversations\/([^/]+)\/state$/);
    const portfolio = pathname === '/api/planner/portfolio';
    if (req.method !== 'GET' || (!match && !portfolio)) return false;
    if (principal?.kind !== 'planner') throw createHttpError(401, 'Planner credential is missing or invalid', { code: 'planner_credential_invalid' });
    if (match) {
      capability(store, 'getPlannerConversationState');
      const item = store.getPlannerConversationState(decodeURIComponent(match[1]));
      if (!item) throw createHttpError(404, 'Conversation not found');
      sendJson(res, 200, budget({ conversationId: item.conversationId, ...state(item) }, STATE_BYTES));
    } else {
      capability(store, 'listPlannerGoalStates'); capability(store, 'countUnresolvedPlannerAttention');
      const observedAt = new Date().toISOString();
      const counts = store.countUnresolvedPlannerAttention();
      const items = store.listPlannerGoalStates().map((item: any) => {
        const view = budget({ conversationId: item.conversationId, ...state(item) }, STATE_BYTES);
        const { conversationId, ...goalState } = view;
        const identity = { conversationId, title: item.title, projectScopeId: item.projectScopeId };
        budget(identity, 1024);
        const unresolvedAttentionCount = Object.hasOwn(counts, conversationId) ? counts[conversationId] : 0;
        return budget({ ...identity, state: goalState, unresolvedAttentionCount }, STATE_BYTES + 1024);
      });
      sendJson(res, 200, { items, observedAt });
    }
    return true;
  };
}
