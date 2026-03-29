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

export function createAgentToolsController(options: any = {}): RouteHandler<ApiContext> {
  const agentToolBridge = options.agentToolBridge;

  return async function handleAgentToolsRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    if (pathname === '/api/agent-tools/post-message' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handlePostMessage(body));
      return true;
    }

    if (pathname === '/api/agent-tools/context' && req.method === 'GET') {
      sendJson(res, 200, agentToolBridge.handleReadContext(requestUrl));
      return true;
    }

    if (pathname === '/api/agent-tools/trellis/init' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handleTrellisInit(body));
      return true;
    }

    if (pathname === '/api/agent-tools/participants' && req.method === 'GET') {
      sendJson(res, 200, agentToolBridge.handleListParticipants(requestUrl));
      return true;
    }

    return false;
  };
}
