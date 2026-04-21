import * as path from 'node:path';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendFileDownload, sendJson } from '../http/response';

import { pickConversationSummary, withConversationPrivateMessages } from '../domain/conversation/conversation-view';
import { buildAssistantMessageToolTrace } from '../domain/runtime/message-tool-trace';
import {
  SKILL_TEST_DESIGN_CONVERSATION_TYPE,
  buildSkillTestDesignParticipants,
  createSkillTestDesignMetadata,
  isSkillTestDesignConversation,
} from '../domain/skill-test/chat-workbench-mode';
import { UNDERCOVER_CONVERSATION_TYPE } from '../../lib/who-is-undercover-game';
import { WEREWOLF_CONVERSATION_TYPE } from '../../lib/werewolf-game';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

function mergeModeSkillIdsIntoParticipants(input: any, mode: any) {
  if (!mode || !Array.isArray(mode.skillIds) || mode.skillIds.length === 0) {
    return input;
  }

  const modeSkillIds = mode.skillIds;
  const participants = Array.isArray(input.participants) ? input.participants : [];

  const merged = participants.map((participant: any) => {
    const existing = Array.isArray(participant.conversationSkillIds || participant.conversationSkills)
      ? (participant.conversationSkillIds || participant.conversationSkills)
      : [];
    const mergedSkills = new Set([...existing.map((id: any) => String(id || '').trim()).filter(Boolean), ...modeSkillIds]);

    return {
      ...participant,
      conversationSkillIds: Array.from(mergedSkills),
    };
  });

  return { ...input, participants: merged };
}

function resolveSkillTestDesignSkillId(body: any) {
  const metadata = body && body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  const skillTestDesign = metadata.skillTestDesign && typeof metadata.skillTestDesign === 'object'
    ? metadata.skillTestDesign
    : {};
  return String(skillTestDesign.skillId || body && body.skillId || '').trim();
}

function buildSkillTestDesignConversationInput(body: any, skillRegistry: any) {
  const skillId = resolveSkillTestDesignSkillId(body);

  if (!skillId) {
    throw createHttpError(400, 'Skill Test 设计模式需要选择目标 skill');
  }

  const skill = skillRegistry && typeof skillRegistry.getSkill === 'function' ? skillRegistry.getSkill(skillId) : null;
  if (!skill) {
    throw createHttpError(404, '目标 skill 不存在');
  }

  const title = String(body && body.title || '').trim() || `Skill Test · ${String(skill.name || skill.id).trim() || skill.id}`;
  return {
    title,
    participants: buildSkillTestDesignParticipants(skill.id),
    metadata: createSkillTestDesignMetadata(skill),
  };
}

export function createConversationsController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
  const turnOrchestrator = options.turnOrchestrator;
  const undercoverService = options.undercoverService;
  const werewolfService = options.werewolfService;
  const buildBootstrapPayload = options.buildBootstrapPayload;
  const modeStore = options.modeStore;

  return async function handleConversationsRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    if (req.method === 'GET' && pathname === '/api/conversations') {
      sendJson(res, 200, { conversations: store.listConversations() });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/conversations') {
      const body = await readRequestJson(req);
      const rawType = String(body && body.type ? body.type : '').trim().toLowerCase();
      let conversationType = 'standard';
      if (rawType === UNDERCOVER_CONVERSATION_TYPE) {
        conversationType = UNDERCOVER_CONVERSATION_TYPE;
      } else if (rawType === WEREWOLF_CONVERSATION_TYPE) {
        conversationType = WEREWOLF_CONVERSATION_TYPE;
      } else if (rawType && modeStore && modeStore.get(rawType)) {
        conversationType = rawType;
      }

      let metadata = body && body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
      let conversationInput = body || {};
      if (conversationType === UNDERCOVER_CONVERSATION_TYPE) {
        metadata = {
          ...metadata,
          undercoverGame: options.undercoverHost.buildPublicState(null),
        };
      } else if (conversationType === WEREWOLF_CONVERSATION_TYPE) {
        metadata = {
          ...metadata,
          werewolfGame: options.werewolfHost.buildPublicState(null),
        };
      } else if (conversationType === SKILL_TEST_DESIGN_CONVERSATION_TYPE) {
        const skillTestConversation = buildSkillTestDesignConversationInput(body, skillRegistry);
        conversationInput = {
          ...body,
          title: skillTestConversation.title,
          participants: skillTestConversation.participants,
        };
        metadata = skillTestConversation.metadata;
      }

      // Merge mode skill bindings into participants
      const mode = modeStore ? modeStore.get(conversationType) : null;
      const enrichedBody = mergeModeSkillIdsIntoParticipants(conversationInput, mode);

      let conversation = store.createConversation({
        ...enrichedBody,
        type: conversationType,
        metadata,
      });

      // If mode has skills but the request did not include participants,
      // the default participants were created without mode skills.
      // Inject mode skills into the newly created conversation's participants.
      if (
        mode
        && Array.isArray(mode.skillIds) && mode.skillIds.length > 0
        && !Array.isArray(conversationInput.participants)
      ) {
        const currentAgents = store.listConversationAgents(conversation.id);
        const updatedParticipants = currentAgents.map((agent: any) => {
          const existing = Array.isArray(agent.conversationSkillIds || agent.conversationSkills)
            ? (agent.conversationSkillIds || agent.conversationSkills)
            : [];
          const merged = new Set([
            ...existing.map((id: any) => String(id || '').trim()).filter(Boolean),
            ...mode.skillIds,
          ]);
          return {
            agentId: agent.id,
            conversationSkillIds: Array.from(merged),
          };
        });
        conversation = store.updateConversation(conversation.id, {
          participants: updatedParticipants,
        });
      }

      if (conversation.type === UNDERCOVER_CONVERSATION_TYPE) {
        conversation = undercoverService.prepareConversation(conversation.id);
      } else if (conversation.type === WEREWOLF_CONVERSATION_TYPE) {
        conversation = werewolfService.prepareConversation(conversation.id);
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

        if (existingConversation && isSkillTestDesignConversation(existingConversation) && Array.isArray(body.participants)) {
          throw createHttpError(409, 'Skill Test 设计模式使用固定参与者，当前不支持修改参与人格');
        }

        if (
          existingConversation &&
          existingConversation.type === UNDERCOVER_CONVERSATION_TYPE &&
          Array.isArray(body.participants) &&
          options.undercoverHost.loadState(conversationId)
        ) {
          throw createHttpError(409, '请先重置当前谁是卧底对局，再修改参与者');
        }

        if (
          existingConversation &&
          existingConversation.type === WEREWOLF_CONVERSATION_TYPE &&
          Array.isArray(body.participants) &&
          options.werewolfHost.loadState(conversationId)
        ) {
          throw createHttpError(409, '请先重置当前狼人杀对局，再修改参与者');
        }

        let conversation = store.updateConversation(conversationId, body);

        if (!conversation) {
          throw createHttpError(404, '会话不存在');
        }

        if (conversation.type === UNDERCOVER_CONVERSATION_TYPE) {
          conversation = undercoverService.prepareConversation(conversation.id);
        } else if (conversation.type === WEREWOLF_CONVERSATION_TYPE) {
          conversation = werewolfService.prepareConversation(conversation.id);
        }

        sendJson(res, 200, {
          conversation,
          summary: pickConversationSummary(conversation),
          conversations: store.listConversations(),
        });
        return true;
      }

      if (req.method === 'DELETE') {
        const runtime = turnOrchestrator.buildRuntimePayload();
        const activeConversationIds = Array.isArray(runtime && runtime.activeConversationIds)
          ? runtime.activeConversationIds
          : [];
        const dispatchingConversationIds = Array.isArray(runtime && runtime.dispatchingConversationIds)
          ? runtime.dispatchingConversationIds
          : [];
        const conversationQueueDepths = runtime && runtime.conversationQueueDepths && typeof runtime.conversationQueueDepths === 'object'
          ? runtime.conversationQueueDepths
          : {};
        const conversationQueueFailures = runtime && runtime.conversationQueueFailures && typeof runtime.conversationQueueFailures === 'object'
          ? runtime.conversationQueueFailures
          : {};
        const agentSlotQueueDepths = runtime && runtime.agentSlotQueueDepths && typeof runtime.agentSlotQueueDepths === 'object'
          ? runtime.agentSlotQueueDepths
          : {};
        const activeAgentSlots = Array.isArray(runtime && runtime.activeAgentSlots) ? runtime.activeAgentSlots : [];
        const queuedUserCount = Math.max(0, Number(conversationQueueDepths[conversationId] || 0));
        const queuedAgentSlotDepths =
          agentSlotQueueDepths[conversationId] && typeof agentSlotQueueDepths[conversationId] === 'object'
            ? (agentSlotQueueDepths[conversationId] as Record<string, any>)
            : {};
        const queuedAgentSlotCount = Object.values(queuedAgentSlotDepths).reduce(
          (sum: number, value: any) => sum + Math.max(0, Number(value || 0)),
          0
        );
        const forceDelete = requestUrl.searchParams.get('force') === '1' || requestUrl.searchParams.get('force') === 'true';
        const queueFailure =
          conversationQueueFailures[conversationId] && typeof conversationQueueFailures[conversationId] === 'object'
            ? conversationQueueFailures[conversationId]
            : null;
        const hasActiveAgentSlots = activeAgentSlots.some((slot: any) => slot && slot.conversationId === conversationId);

        if (activeConversationIds.includes(conversationId) || dispatchingConversationIds.includes(conversationId) || hasActiveAgentSlots) {
          throw createHttpError(409, '当前会话正在处理消息，请先停止并等待当前回合结束后再删除');
        }

        if ((queuedUserCount > 0 && (!forceDelete || !queueFailure)) || queuedAgentSlotCount > 0) {
          throw createHttpError(409, '当前会话仍有待处理消息，请等待自动续跑完成后再删除');
        }

        undercoverService.deleteConversationState(conversationId);
        werewolfService.deleteConversationState(conversationId);
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

    const messageToolTraceMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/tool-trace$/);

    if (messageToolTraceMatch && req.method === 'GET') {
      const conversationId = decodeURIComponent(messageToolTraceMatch[1]);
      const messageId = decodeURIComponent(messageToolTraceMatch[2]);
      const conversation = store.getConversation(conversationId);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      const message = store.getMessage(messageId);

      if (!message || message.conversationId !== conversationId) {
        throw createHttpError(404, 'Message not found');
      }

      if (message.role !== 'assistant') {
        throw createHttpError(400, 'Only assistant messages can inspect a tool trace');
      }

      let resolvedSessionPath = '';

      try {
        resolvedSessionPath = turnOrchestrator.resolveAssistantMessageSessionPath(message);
      } catch {
        resolvedSessionPath = '';
      }

      sendJson(res, 200, {
        trace: buildAssistantMessageToolTrace({
          db: store.db,
          agentDir: store.agentDir,
          message,
          resolvedSessionPath,
        }),
      });
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

      if (
        conversation.type === WEREWOLF_CONVERSATION_TYPE &&
        !werewolfService.canChatInConversation(conversationId)
      ) {
        throw createHttpError(409, '狼人杀对局进行中由后端全自动主持，请等待本局结束后再发送聊天消息');
      }

      const clientRequestId = typeof body.clientRequestId === 'string' ? body.clientRequestId.trim() : '';
      const result = turnOrchestrator.submitConversationMessage(conversationId, {
        content: body.content,
        metadata: clientRequestId ? { clientRequestId } : undefined,
      });
      sendJson(res, 200, result);
      return true;
    }

    const conversationStopMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/stop$/);

    if (conversationStopMatch && req.method === 'POST') {
      const conversationId = decodeURIComponent(conversationStopMatch[1]);
      const body = await readRequestJson(req);
      const result = turnOrchestrator.requestStopConversationExecution(conversationId, body.reason);
      sendJson(res, 200, {
        conversationId,
        turn: result.turn,
        agentSlots: result.agentSlots,
        runtime: turnOrchestrator.buildRuntimePayload(),
      });
      return true;
    }

    return false;
  };
}
