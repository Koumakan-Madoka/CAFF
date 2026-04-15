import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { sendJson } from '../http/response';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

export function createHealthController(options: any = {}): RouteHandler<ApiContext> {
  const getHealthStatus = typeof options.getHealthStatus === 'function' ? options.getHealthStatus : () => null;

  return async function handleHealthRequest(context) {
    const { req, res, pathname } = context;

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, getHealthStatus());
      return true;
    }

    return false;
  };
}
