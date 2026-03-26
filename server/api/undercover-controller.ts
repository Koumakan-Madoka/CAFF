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

export function createUndercoverController(options: any = {}): RouteHandler<ApiContext> {
  const undercoverService = options.undercoverService;

  return async function handleUndercoverRequest(context) {
    const { req, res, pathname } = context;
    const undercoverActionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/undercover\/(start|clue-round|vote-round|reveal|reset)$/);

    if (!undercoverActionMatch || req.method !== 'POST') {
      return false;
    }

    const conversationId = decodeURIComponent(undercoverActionMatch[1]);
    const action = undercoverActionMatch[2];
    const body = await readRequestJson(req);

    if (action !== 'start' && action !== 'reset') {
      throw createHttpError(409, '当前谁是卧底房间已切换为后端全自动模式，请直接开始新一局或重置对局');
    }

    const result =
      action === 'start'
        ? await undercoverService.startGame(conversationId, body)
        : await undercoverService.resetGame(conversationId);

    sendJson(res, 200, result);
    return true;
  };
}
