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

    if (pathname === '/api/agent-tools/search-messages' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handleSearchMessages(body));
      return true;
    }

    if (pathname === '/api/agent-tools/memories' && req.method === 'GET') {
      sendJson(res, 200, agentToolBridge.handleListMemories(requestUrl));
      return true;
    }

    if (pathname === '/api/agent-tools/memories' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handleSaveMemory(body));
      return true;
    }

    if (pathname === '/api/agent-tools/memories/update' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handleUpdateMemory(body));
      return true;
    }

    if (pathname === '/api/agent-tools/memories/forget' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handleForgetMemory(body));
      return true;
    }

    if (pathname === '/api/agent-tools/trellis/init' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handleTrellisInit(body));
      return true;
    }

    if (pathname === '/api/agent-tools/trellis/write' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handleTrellisWrite(body));
      return true;
    }

    if (pathname === '/api/agent-tools/participants' && req.method === 'GET') {
      sendJson(res, 200, agentToolBridge.handleListParticipants(requestUrl));
      return true;
    }

    if (pathname === '/api/agent-tools/sandbox/access' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, await agentToolBridge.handleSandboxAccess(body));
      return true;
    }

    if (pathname === '/api/agent-tools/sandbox/read' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, await agentToolBridge.handleSandboxRead(body));
      return true;
    }

    if (pathname === '/api/agent-tools/sandbox/write' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, await agentToolBridge.handleSandboxWrite(body));
      return true;
    }

    if (pathname === '/api/agent-tools/sandbox/mkdir' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, await agentToolBridge.handleSandboxMkdir(body));
      return true;
    }

    if (pathname === '/api/agent-tools/sandbox/bash' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, await agentToolBridge.handleSandboxBash(body));
      return true;
    }

    return false;
  };
}
