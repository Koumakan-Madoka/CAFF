import { createLocalAdminGuard } from '../http/local-admin-guard';
import { singleHeader } from '../http/request-authority';
import { matchesPlannerToken } from '../http/planner-terminal';
import { createHttpError } from '../http/http-errors';
import { sendJson } from '../http/response';

export function createEmbeddedPlannerController(options: any) {
  const guard = createLocalAdminGuard({ host: options.host, getAuthority: options.getAuthority });
  return async function route({ req, res, pathname, requestUrl, principal }: any) {
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
