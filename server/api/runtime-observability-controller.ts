import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { sendJson } from '../http/response';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

export function createRuntimeObservabilityController(options: any = {}): RouteHandler<ApiContext> {
  return async function handleRuntimeObservabilityRequest(context) {
    const { req, res, pathname } = context;

    if (req.method !== 'GET' || pathname !== '/api/runtime/stats') {
      return false;
    }

    const getSnapshot = options.getSnapshot;

    if (typeof getSnapshot !== 'function') {
      throw createHttpError(501, 'Runtime observability is not configured');
    }

    sendJson(res, 200, getSnapshot());
    return true;
  };
}
