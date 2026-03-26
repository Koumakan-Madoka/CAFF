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

export function createAgentsController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
  const buildConfiguredModelOptions = options.buildConfiguredModelOptions;

  return async function handleAgentsRequest(context) {
    const { req, res, pathname } = context;

    if (req.method === 'GET' && pathname === '/api/agents') {
      sendJson(res, 200, {
        agents: store.listAgents(),
        modelOptions: buildConfiguredModelOptions(),
        skills: skillRegistry.listSkills(),
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/agents') {
      const body = await readRequestJson(req);
      const agent = store.saveAgent(body);
      sendJson(res, 201, {
        agent,
        agents: store.listAgents(),
        modelOptions: buildConfiguredModelOptions(),
        skills: skillRegistry.listSkills(),
      });
      return true;
    }

    const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);

    if (!agentMatch) {
      return false;
    }

    const agentId = decodeURIComponent(agentMatch[1]);

    if (req.method === 'PUT') {
      const body = await readRequestJson(req);
      const agent = store.saveAgent({ ...body, id: agentId });
      sendJson(res, 200, {
        agent,
        agents: store.listAgents(),
        modelOptions: buildConfiguredModelOptions(),
        skills: skillRegistry.listSkills(),
      });
      return true;
    }

    if (req.method === 'DELETE') {
      store.deleteAgent(agentId);
      sendJson(res, 200, {
        deletedId: agentId,
        agents: store.listAgents(),
        modelOptions: buildConfiguredModelOptions(),
        skills: skillRegistry.listSkills(),
        conversations: store.listConversations(),
      });
      return true;
    }

    return false;
  };
}
