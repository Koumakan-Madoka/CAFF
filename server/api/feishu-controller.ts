import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

export function createFeishuController(options: any = {}): RouteHandler<ApiContext> {
  const feishuService = options.feishuService;

  return async function handleFeishuRequest(context) {
    const { req, res, pathname } = context;

    if (req.method !== 'POST' || pathname !== '/api/integrations/feishu/webhook') {
      return false;
    }

    const body = await readRequestJson(req);
    const result = await feishuService.handleWebhook(body);
    sendJson(res, result.statusCode || 200, result.payload || { ok: true });
    return true;
  };
}
