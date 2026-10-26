import { createLocalAdminGuard } from '../http/local-admin-guard';
import { singleHeader } from '../http/request-authority';
import { matchesPlannerToken } from '../http/planner-terminal';
import { createHttpError } from '../http/http-errors';
import { sendJson } from '../http/response';
import { readRawRequestBody } from '../http/request-body';

export function createEmbeddedPlannerController(options: any) {
  const guard = createLocalAdminGuard({ host: options.host, getAuthority: options.getAuthority, csrfToken: options.csrfToken });
  return async function route({ req, res, pathname, requestUrl, principal }: any) {
    const repair = /^\/api\/conversations\/([^/]+)\/planner\/terminal\/repair$/.exec(pathname);
    if (repair && req.method === 'POST' && options.runtime.capability().enabled) {
      if (principal?.kind !== 'user') throw createHttpError(403, 'Only a browser user may repair a planner terminal', { code: 'planner_terminal_repair_user_required' });
      guard.assertMutation(req);
      if (requestUrl.search) throw createHttpError(400, 'Invalid planner query');
      const body = await readRawRequestBody(req, { bodyLimit: 1024 });
      // This closed, single-field protocol also rejects duplicate confirmations.
      if (!/^[\x20\t\r\n]*\{[\x20\t\r\n]*"confirm"[\x20\t\r\n]*:[\x20\t\r\n]*true[\x20\t\r\n]*\}[\x20\t\r\n]*$/.test(body.toString('utf8'))) {
        throw createHttpError(400, 'Explicit repair confirmation required', { code: 'planner_terminal_repair_confirmation_required' });
      }
      try { sendJson(res, 200, options.runtime.repair(repair[1])); }
      catch (error: any) {
        if (error?.code === 'planner_room_missing') throw createHttpError(404, 'Room not found');
        if (error?.code === 'planner_room_busy') throw createHttpError(409, 'Planner process is still owned by this instance', { code: error.code });
        throw error;
      }
      return true;
    }
    const match = /^\/api\/conversations\/([^/]+)\/planner\/state$/.exec(pathname);
    if (!match || req.method !== 'GET' || !options.runtime.capability().enabled) return false;
    const { authority } = guard.assertRead(req);
    if (principal?.kind !== 'planner') {
      const origin = singleHeader(req, 'origin');
      if (!matchesPlannerToken(singleHeader(req, 'x-caff-csrf-token'), options.csrfToken)
        || (origin && origin.toLowerCase() !== new URL('http://' + authority).origin)) {
        throw createHttpError(403, 'Planner read rejected', { code: 'planner_terminal_auth_invalid' });
      }
    }
    if (requestUrl.search) throw createHttpError(400, 'Invalid planner query');
    try { sendJson(res, 200, options.runtime.roomState(match[1])); }
    catch (error: any) {
      if (error?.code === 'planner_room_missing') throw createHttpError(404, 'Room not found');
      throw error;
    }
    return true;
  };
}
