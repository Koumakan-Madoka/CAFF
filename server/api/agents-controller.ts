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
  const roleService = options.roleService;

  function withSkills(payload: any) {
    return {
      ...payload,
      skills: skillRegistry.listSkills(),
    };
  }

  return async function handleAgentsRequest(context) {
    const { req, res, pathname } = context;

    if (req.method === 'GET' && pathname === '/api/agents') {
      sendJson(res, 200, withSkills(roleService.getDirectory()));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/agents') {
      const body = await readRequestJson(req);
      sendJson(res, 201, withSkills(roleService.createCustomRole(body)));
      return true;
    }

    const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);

    if (!agentMatch) {
      return false;
    }

    const agentId = decodeURIComponent(agentMatch[1]);

    if (req.method === 'PUT') {
      const body = await readRequestJson(req);
      sendJson(res, 200, withSkills(roleService.updateRole(agentId, body)));
      return true;
    }

    if (req.method === 'DELETE') {
      const result = roleService.retireRole(agentId);
      sendJson(res, 200, {
        ...result,
        skills: skillRegistry.listSkills(),
        conversations: store.listConversations(),
      });
      return true;
    }

    return false;
  };
}
