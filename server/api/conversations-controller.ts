import * as path from 'node:path';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendFileDownload, sendJson } from '../http/response';

import { pickConversationSummary, withConversationPrivateMessages } from '../domain/conversation/conversation-view';
import { UNDERCOVER_CONVERSATION_TYPE } from '../../lib/who-is-undercover-game';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

export function createConversationsController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
  const turnOrchestrator = options.turnOrchestrator;
  const undercoverService = options.undercoverService;
  const buildBootstrapPayload = options.buildBootstrapPayload;

  return async function handleConversationsRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    if (req.method === 'GET' && pathname === '/api/conversations') {
      sendJson(res, 200, { conversations: store.listConversations() });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/conversations') {
      const body = await readRequestJson(req);
      const conversationType =
        String(body && body.type ? body.type : '').trim() === UNDERCOVER_CONVERSATION_TYPE
          ? UNDERCOVER_CONVERSATION_TYPE
          : 'standard';
      let conversation = store.createConversation({
        ...body,
        type: conversationType,
        metadata:
          conversationType === UNDERCOVER_CONVERSATION_TYPE
            ? {
                ...(body && body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
                undercoverGame: options.undercoverHost.buildPublicState(null),
              }
            : body && body.metadata && typeof body.metadata === 'object'
              ? body.metadata
              : {},
      });

      if (conversation.type === UNDERCOVER_CONVERSATION_TYPE) {
        conversation = undercoverService.prepareConversation(conversation.id);
      }

      sendJson(res, 201, {
        conversation,
        summary: pickConversationSummary(conversation),
        conversations: store.listConversations(),
      });
      return true;
    }

    const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);

    if (conversationMatch) {
      const conversationId = decodeURIComponent(conversationMatch[1]);

      if (req.method === 'GET') {
        const conversation = store.getConversation(conversationId);

        if (!conversation) {
          throw createHttpError(404, 'Conversation not found');
        }

        const includePrivateMessages =
          requestUrl.searchParams.get('includePrivateMessages') === '1' ||
          requestUrl.searchParams.get('includePrivateMessages') === 'true';

        sendJson(res, 200, {
          conversation: includePrivateMessages ? withConversationPrivateMessages(conversation, store) : conversation,
        });
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readRequestJson(req);
        const existingConversation = store.getConversation(conversationId);

        if (
          existingConversation &&
          existingConversation.type === UNDERCOVER_CONVERSATION_TYPE &&
          Array.isArray(body.participants) &&
          options.undercoverHost.loadState(conversationId)
        ) {
          throw createHttpError(409, '请先重置当前谁是卧底对局，再修改参与者');
        }

        let conversation = store.updateConversation(conversationId, body);

        if (!conversation) {
          throw createHttpError(404, '会话不存在');
        }

        if (conversation.type === UNDERCOVER_CONVERSATION_TYPE) {
          conversation = undercoverService.prepareConversation(conversation.id);
        }

        sendJson(res, 200, {
          conversation,
          summary: pickConversationSummary(conversation),
          conversations: store.listConversations(),
        });
        return true;
      }

      if (req.method === 'DELETE') {
        undercoverService.deleteConversationState(conversationId);
        store.deleteConversation(conversationId);
        turnOrchestrator.clearConversationState(conversationId);
        sendJson(res, 200, {
          deletedId: conversationId,
          ...buildBootstrapPayload(),
        });
        return true;
      }
    }

    const messageSessionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/session-export$/);

    if (messageSessionMatch && req.method === 'GET') {
      const conversationId = decodeURIComponent(messageSessionMatch[1]);
      const messageId = decodeURIComponent(messageSessionMatch[2]);
      const conversation = store.getConversation(conversationId);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      const message = store.getMessage(messageId);

      if (!message || message.conversationId !== conversationId) {
        throw createHttpError(404, 'Message not found');
      }

      const sessionPath = turnOrchestrator.resolveAssistantMessageSessionPath(message);
      sendFileDownload(res, sessionPath, path.basename(sessionPath));
      return true;
    }

    const messageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);

    if (messageMatch && req.method === 'POST') {
      const conversationId = decodeURIComponent(messageMatch[1]);
      const body = await readRequestJson(req);
      const conversation = store.getConversation(conversationId);

      if (!conversation) {
        throw createHttpError(404, '会话不存在');
      }

      if (
        conversation.type === UNDERCOVER_CONVERSATION_TYPE &&
        !undercoverService.canChatInConversation(conversationId)
      ) {
        throw createHttpError(409, '谁是卧底对局进行中由后端全自动主持，请等待本局结束后再发送聊天消息');
      }

      const result = await turnOrchestrator.runConversationTurn(conversationId, body.content);
      sendJson(res, 200, {
        ...result,
        conversations: store.listConversations(),
      });
      return true;
    }

    const conversationStopMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/stop$/);

    if (conversationStopMatch && req.method === 'POST') {
      const conversationId = decodeURIComponent(conversationStopMatch[1]);
      const body = await readRequestJson(req);
      const turn = turnOrchestrator.requestStopConversationTurn(conversationId, body.reason);
      sendJson(res, 200, {
        conversationId,
        turn,
        runtime: turnOrchestrator.buildRuntimePayload(),
      });
      return true;
    }

    return false;
  };
}
