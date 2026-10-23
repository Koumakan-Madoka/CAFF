import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import { validateAttentionQuery } from '../../storage/chat/planner-attention.repository';

function invalid(): never { throw createHttpError(400, 'Invalid attention query', { code: 'attention_query_invalid' }); }
function integer(value: string | null, fallback: number) {
  if (value === null) return fallback;
  if (!/^[0-9]+$/.test(value)) invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result)) invalid();
  return result;
}
function parseQuery(params: URLSearchParams, wait: boolean) {
  for (const key of ['after', 'limit', 'conversationId', 'status', 'timeoutSeconds']) {
    if (params.getAll(key).length > 1) invalid();
  }
  if (!wait && params.has('timeoutSeconds')) invalid();
  const query = validateAttentionQuery({ after: integer(params.get('after'), 0), limit: integer(params.get('limit'), 100),
    ...(params.has('conversationId') ? { conversationId: params.get('conversationId')! } : {}),
    ...(params.has('status') ? { status: params.get('status') as any } : {}) });
  const timeoutSeconds = integer(params.get('timeoutSeconds'), 60);
  if (timeoutSeconds < 1 || timeoutSeconds > 300) invalid();
  return { query, timeoutSeconds };
}
export function createPlannerAttentionController({ store, waitService }: any): RouteHandler<any> {
  function requireCapability(name: string) {
    if (typeof store?.[name] !== 'function') throw createHttpError(501, 'Planner attention projection unavailable', { code: 'planner_projection_unavailable' });
  }
  return async ({ req, res, pathname, requestUrl, principal }) => {
    const list = req.method === 'GET' && pathname === '/api/planner/attention';
    const wait = req.method === 'GET' && pathname === '/api/planner/attention/wait';
    const resolve = req.method === 'POST' && pathname.match(/^\/api\/planner\/attention\/([0-9]+)\/resolve$/);
    if (!list && !wait && !resolve) return false;
    if (principal?.kind !== 'planner') throw createHttpError(401, 'Planner credential is missing or invalid', { code: 'planner_credential_invalid' });
    if (resolve) {
      requireCapability('resolvePlannerAttention');
      const sequence = integer(resolve[1], 0); if (sequence < 1) invalid();
      const body = await readRequestJson(req);
      sendJson(res, 200, { item: store.resolvePlannerAttention(sequence, { reason: body?.reason, principal }) });
    } else {
      const { query, timeoutSeconds } = parseQuery(requestUrl.searchParams, wait);
      requireCapability('listPlannerAttention');
      if (list) sendJson(res, 200, { ...store.listPlannerAttention(query), timedOut: false });
      else {
        const abort = new AbortController();
        const onAborted = () => abort.abort();
        const onClosed = () => { if (!res.writableEnded) onAborted(); };
        req.once('aborted', onAborted); res.once('close', onClosed);
        if (req.aborted || res.destroyed) onAborted();
        try {
          const page = await waitService.wait(query, timeoutSeconds, abort.signal);
          if (!res.destroyed) sendJson(res, 200, page);
        } catch (error) { if (!res.destroyed) throw error; }
        finally { req.off('aborted', onAborted); res.off('close', onClosed); }
      }
    }
    return true;
  };
}
