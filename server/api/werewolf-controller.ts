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

export function createWerewolfController(options: any = {}): RouteHandler<ApiContext> {
  const werewolfService = options.werewolfService;

  return async function handleWerewolfRequest(context) {
    const { req, res, pathname } = context;
    const werewolfActionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/werewolf\/(start|night|day|vote|reveal|reset)$/);

    if (!werewolfActionMatch || req.method !== 'POST') {
      return false;
    }

    const conversationId = decodeURIComponent(werewolfActionMatch[1]);
    const action = werewolfActionMatch[2];

    if (action !== 'start' && action !== 'reset') {
      throw createHttpError(409, '当前狼人杀房间已切换为后端全自动模式，请直接开始新一局或重置对局');
    }

    const body = action === 'start' ? await readRequestJson(req) : null;

    const result =
      action === 'start' ? await werewolfService.startGame(conversationId, body) : await werewolfService.resetGame(conversationId);

    sendJson(res, 200, result);
    return true;
  };
}

