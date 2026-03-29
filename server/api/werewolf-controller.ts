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
    const body = await readRequestJson(req);

    let result;

    switch (action) {
      case 'start':
        result = await werewolfService.startGame(conversationId, body);
        break;
      case 'reset':
        result = await werewolfService.resetGame(conversationId);
        break;
      case 'reveal':
        result = await werewolfService.revealGame(conversationId);
        break;
      case 'night':
        result = await werewolfService.runNightPhase(conversationId);
        break;
      case 'day':
        result = await werewolfService.runDayPhase(conversationId);
        break;
      case 'vote':
        result = await werewolfService.runVotePhase(conversationId);
        break;
      default:
        throw createHttpError(400, `未知的狼人杀操作：${action}`);
    }

    sendJson(res, 200, result);
    return true;
  };
}