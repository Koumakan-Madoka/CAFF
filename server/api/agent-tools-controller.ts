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

function validateConversationDeliveryBody(body: any, kind: 'notify' | 'request') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createHttpError(400, 'Request body must be a JSON object', {
      issues: [{ code: 'invalid_body', message: 'Request body must be a JSON object' }],
    });
  }

  const allowedFields = new Set([
    'invocationId',
    'callbackToken',
    'targetConversationId',
    'targetAgentId',
    'content',
    'idempotencyKey',
    ...(kind === 'request' ? ['deadlineSeconds'] : []),
  ]);
  const unknownField = Object.keys(body).find((fieldName) => !allowedFields.has(fieldName));
  if (unknownField) {
    throw createHttpError(400, `Unknown conversation delivery field: ${unknownField}`, {
      issues: [{
        code: 'cross_conversation_unknown_field',
        field: unknownField,
        message: `Unknown field: ${unknownField}`,
      }],
    });
  }

  return body;
}

function validatePiCapabilityBody(body: any) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createHttpError(400, 'Request body must be a JSON object', {
      issues: [{ code: 'invalid_body', message: 'Request body must be a JSON object' }],
    });
  }

  const allowedFields = new Set(['invocationId', 'callbackToken', 'arguments']);
  const unknownField = Object.keys(body).find((fieldName) => !allowedFields.has(fieldName));
  if (unknownField) {
    throw createHttpError(400, `Unknown Pi capability request field: ${unknownField}`, {
      issues: [{
        code: 'pi_capability_invalid_request',
        field: unknownField,
        message: `Unknown field: ${unknownField}`,
      }],
    });
  }
  if (!body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments)) {
    throw createHttpError(400, 'Pi capability arguments must be a JSON object', {
      issues: [{
        code: 'pi_capability_invalid_arguments',
        field: 'arguments',
        message: 'arguments must be a JSON object',
      }],
    });
  }
  return body;
}

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

    if (pathname === '/api/agent-tools/search-memory' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handleSearchMemory(body));
      return true;
    }

    if (pathname === '/api/agent-tools/conversation-notify' && req.method === 'POST') {
      const body = validateConversationDeliveryBody(await readRequestJson(req), 'notify');
      sendJson(res, 200, agentToolBridge.handleConversationNotify(body));
      return true;
    }

    if (pathname === '/api/agent-tools/conversation-request' && req.method === 'POST') {
      const body = validateConversationDeliveryBody(await readRequestJson(req), 'request');
      sendJson(res, 200, agentToolBridge.handleConversationRequest(body));
      return true;
    }

    const capabilityPrefix = '/api/agent-tools/capabilities/';
    if (pathname.startsWith(capabilityPrefix) && req.method === 'POST') {
      const facade = pathname.slice(capabilityPrefix.length);
      if (!facade || facade.includes('/') || !/^[a-z][a-z0-9_]*$/u.test(facade)) {
        throw createHttpError(404, 'Unknown Pi capability facade');
      }
      const body = validatePiCapabilityBody(await readRequestJson(req));
      const result = await agentToolBridge.handlePiCapability(facade, body);
      sendJson(res, 200, { ok: true, facade, result });
      return true;
    }

    if (pathname === '/api/agent-tools/goal/suggest' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handleSuggestGoal(body));
      return true;
    }

    if (pathname === '/api/agent-tools/goal/checklist' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handleUpdateGoalChecklist(body));
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

    if (pathname === '/api/agent-tools/experience/write' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handleWriteExperience(body));
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

    return false;
  };
}
