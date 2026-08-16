import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';

type ApiContext = {
  req: any;
  res: any;
  pathname: string;
  requestUrl: URL;
};

const PLAN_ROUTE_PATTERN = /^\/api\/conversations\/([^/]+)\/plan(?:\/(activate|revert))?$/;

function readConversationId(match: RegExpMatchArray): string {
  return decodeURIComponent(match[1]);
}

function planPayload(ownerConversationId: string, plan: any, extras: Record<string, unknown> = {}) {
  return {
    ownerConversationId,
    plan,
    ...extras,
  };
}

/**
 * Plan API (PRD .trellis/tasks/dag-planning/prd.md §4):
 * - GET    /api/conversations/:id/plan          — resolve root plan; 404 when none
 * - PUT    /api/conversations/:id/plan          — draft: full replace; active: status-only
 * - POST   /api/conversations/:id/plan/activate — draft → active (user entry)
 * - POST   /api/conversations/:id/plan/revert   — active → draft
 *
 * All heavy lifting (origin-chain resolution, validation, optimistic
 * concurrency) lives in the store so the agent tool wrapper can reuse it.
 */
export function createConversationPlanController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};

  if (!store) {
    throw createHttpError(500, 'Conversation plan controller requires a store');
  }

  return async function handleConversationPlanRequest(context: ApiContext) {
    const { req, res, pathname } = context;
    const match = pathname.match(PLAN_ROUTE_PATTERN);
    if (!match) {
      return false;
    }

    const conversationId = readConversationId(match);
    const action = match[2] || '';

    if (!action && req.method === 'GET') {
      const result = store.getPlanForConversation(conversationId);
      if (!result.plan) {
        throw createHttpError(404, 'Conversation tree has no plan', {
          code: 'plan_not_found',
          issues: [{ code: 'plan_not_found', message: 'Conversation tree has no plan' }],
        });
      }
      sendJson(res, 200, planPayload(result.ownerConversationId, result.plan));
      return true;
    }

    if (!action && req.method === 'PUT') {
      const body = await readRequestJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw createHttpError(400, 'Request body must be a JSON object', {
          issues: [{ code: 'invalid_body', message: 'Request body must be a JSON object' }],
        });
      }
      const unknownField = Object.keys(body).find((field) => field !== 'doc' && field !== 'version');
      if (unknownField) {
        throw createHttpError(400, `Unknown plan field: ${unknownField}`, {
          issues: [{ code: 'unknown_field', field: unknownField, message: `Unknown field: ${unknownField}` }],
        });
      }
      if (body.doc === undefined || body.doc === null || typeof body.doc !== 'object' || Array.isArray(body.doc)) {
        throw createHttpError(400, 'doc is required and must be a JSON object', {
          issues: [{ code: 'plan_doc_required', field: 'doc', message: 'doc is required and must be a JSON object' }],
        });
      }

      const result = store.savePlanForConversation(conversationId, {
        doc: body.doc,
        version: body.version,
      }, { actor: { type: 'user' } });
      broadcastEvent('conversation_plan_updated', {
        conversationId,
        ownerConversationId: result.ownerConversationId,
        plan: result.plan,
      });
      sendJson(res, 200, planPayload(result.ownerConversationId, result.plan, {
        warnings: result.warnings || [],
      }));
      return true;
    }

    if (action === 'activate' && req.method === 'POST') {
      const result = store.activatePlanForConversation(conversationId, { type: 'user' });
      broadcastEvent('conversation_plan_updated', {
        conversationId,
        ownerConversationId: result.ownerConversationId,
        plan: result.plan,
      });
      sendJson(res, 200, planPayload(result.ownerConversationId, result.plan));
      return true;
    }

    if (action === 'revert' && req.method === 'POST') {
      const result = store.revertPlanForConversation(conversationId, { type: 'user' });
      broadcastEvent('conversation_plan_updated', {
        conversationId,
        ownerConversationId: result.ownerConversationId,
        plan: result.plan,
      });
      sendJson(res, 200, planPayload(result.ownerConversationId, result.plan));
      return true;
    }

    return false;
  };
}
