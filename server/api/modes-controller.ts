import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

export function createModesController(options: any = {}): RouteHandler<ApiContext> {
  const modeStore = options.modeStore;

  return async function handleModesRequest(context) {
    const { req, res, pathname } = context;

    if (req.method === 'GET' && pathname === '/api/modes') {
      sendJson(res, 200, { modes: modeStore.list() });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/modes') {
      const body = await readRequestJson(req);
      const mode = modeStore.save(body);
      sendJson(res, 201, { mode, modes: modeStore.list() });
      return true;
    }

    const modeMatch = pathname.match(/^\/api\/modes\/([^/]+)$/);

    if (modeMatch) {
      const modeId = decodeURIComponent(modeMatch[1]);

      if (req.method === 'GET') {
        const mode = modeStore.get(modeId);

        if (!mode) {
          throw createHttpError(404, 'Mode not found');
        }

        sendJson(res, 200, { mode });
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readRequestJson(req);
        const mode = modeStore.save({ ...body, id: modeId });
        sendJson(res, 200, { mode, modes: modeStore.list() });
        return true;
      }

      if (req.method === 'DELETE') {
        try {
          modeStore.delete(modeId);
          sendJson(res, 200, { deletedId: modeId, modes: modeStore.list() });
        } catch (error: any) {
          throw createHttpError(400, error.message || 'Cannot delete mode');
        }
        return true;
      }

      return false;
    }

    return false;
  };
}
