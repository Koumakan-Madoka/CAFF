import * as path from 'node:path';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendFileDownload, sendJson, sendTextDownload } from '../http/response';

import { pickConversationSummary, withConversationPrivateMessages } from '../domain/conversation/conversation-view';
import { applyConversationDigestAction } from '../domain/conversation/conversation-digest';
import { buildConversationMessagePage } from '../domain/conversation/message-pagination';
import { applyConversationSkillDraftAction } from '../domain/conversation/skill-draft';
import { applySessionGoalAction } from '../domain/conversation/session-goal';
import {
  exportAgentContextSnapshotMarkdown,
  materializeAgentContextSnapshot,
  summarizeAgentContextSnapshot,
} from '../domain/conversation/turn/context-snapshot';
import { buildAssistantMessageToolTrace } from '../domain/runtime/message-tool-trace';
import { UNDERCOVER_CONVERSATION_TYPE } from '../../lib/who-is-undercover-game';
import { WEREWOLF_CONVERSATION_TYPE } from '../../lib/werewolf-game';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

const FEISHU_PLATFORM = 'feishu';

function runtimeArray(runtime: any, key: string): any[] {
  const value = runtime && runtime[key];
  return Array.isArray(value) ? value : [];
}

function queuedUserMessageCount(runtime: any, conversationId: string): number {
  const depths = runtime && runtime.conversationQueueDepths && typeof runtime.conversationQueueDepths === 'object'
    ? runtime.conversationQueueDepths
    : {};
  const value = Number(depths[conversationId] || 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function queuedAgentSlotMessageCount(runtime: any, conversationId: string): number {
  const queueDepths = runtime && runtime.agentSlotQueueDepths && typeof runtime.agentSlotQueueDepths === 'object'
    ? runtime.agentSlotQueueDepths
    : {};
  const perAgentDepths: Record<string, any> = queueDepths[conversationId] && typeof queueDepths[conversationId] === 'object'
    ? queueDepths[conversationId]
    : {};

  return Object.values(perAgentDepths).reduce<number>((sum: number, value: any) => {
    const count = Number(value || 0);
    return sum + (Number.isFinite(count) ? Math.max(0, count) : 0);
  }, 0);
}

function conversationWorkState(runtime: any, conversationId: string) {
  const active = runtimeArray(runtime, 'activeConversationIds').includes(conversationId);
  const dispatching = runtimeArray(runtime, 'dispatchingConversationIds').includes(conversationId);
  const activeTurnCount = runtimeArray(runtime, 'activeTurns').filter(
    (turn: any) => turn && turn.conversationId === conversationId
  ).length;
  const activeAgentSlotCount = runtimeArray(runtime, 'activeAgentSlots').filter(
    (slot: any) => slot && slot.conversationId === conversationId
  ).length;
  const queuedUserCount = queuedUserMessageCount(runtime, conversationId);
  const queuedAgentSlotCount = queuedAgentSlotMessageCount(runtime, conversationId);

  return {
    active,
    dispatching,
    activeTurnCount,
    activeAgentSlotCount,
    queuedUserCount,
    queuedAgentSlotCount,
    busy: active || dispatching || activeTurnCount > 0 || activeAgentSlotCount > 0 || queuedUserCount > 0 || queuedAgentSlotCount > 0,
  };
}

function mergeFeishuBindingMetadata(existingBinding: any) {
  const metadata = existingBinding && existingBinding.metadata && typeof existingBinding.metadata === 'object'
    ? existingBinding.metadata
    : {};

  return {
    ...metadata,
    manualBinding: {
      source: 'web-ui',
      boundAt: new Date().toISOString(),
    },
  };
}

function timestampValue(value: any) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function contextSnapshotFromMessage(message: any) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
  return metadata && metadata.agentContextSnapshot && typeof metadata.agentContextSnapshot === 'object'
    ? metadata.agentContextSnapshot
    : null;
}

function defaultContextSnapshotFileName(message: any) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
  const agentName = String(message && message.senderName || metadata && metadata.agentName || 'agent').trim().replace(/[\s/\\?%*:|"<>]+/g, '-');
  const turnId = String(message && message.turnId || 'turn').trim().replace(/[\s/\\?%*:|"<>]+/g, '-');
  return `agent-context-${agentName || 'agent'}-${turnId || 'turn'}.md`;
}

function listKnownFeishuChats(store: any) {
  const conversationsById = new Map<string, any>(
    store.listConversations().map((conversation: any) => [conversation.id, conversation] as [string, any])
  );

  return store.listConversationChannelBindings(FEISHU_PLATFORM)
    .map((binding: any) => {
      const metadata = binding && binding.metadata && typeof binding.metadata === 'object' ? binding.metadata : {};
      const conversation = conversationsById.get(binding.conversationId) || null;
      const lastActivityAt = conversation
        ? conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt || binding.updatedAt || binding.createdAt || null
        : binding.updatedAt || binding.createdAt || null;

      return {
        chatId: binding.externalChatId,
        chatType: String(metadata.chatType || '').trim(),
        conversationId: binding.conversationId,
        conversationTitle: conversation ? String(conversation.title || '').trim() : '',
        lastActivityAt,
      };
    })
    .sort((left: any, right: any) => {
      const byActivity = timestampValue(right.lastActivityAt) - timestampValue(left.lastActivityAt);
      if (byActivity !== 0) {
        return byActivity;
      }

      return String(left.chatId || '').localeCompare(String(right.chatId || ''), 'zh-CN');
    });
}

function mergeModeSkillIdsIntoParticipants(input: any, mode: any) {
  if (!mode || !Array.isArray(mode.skillIds) || mode.skillIds.length === 0) {
    return input;
  }

  const modeSkillIds = mode.skillIds;
  const participants = Array.isArray(input.participants) ? input.participants : [];

  const merged = participants.map((participant: any) => {
    const normalizedParticipant = typeof participant === 'string'
      ? { agentId: participant }
      : participant && typeof participant === 'object'
        ? participant
        : {};
    const existing = Array.isArray(normalizedParticipant.conversationSkillIds || normalizedParticipant.conversationSkills)
      ? (normalizedParticipant.conversationSkillIds || normalizedParticipant.conversationSkills)
      : [];
    const mergedSkills = new Set([...existing.map((id: any) => String(id || '').trim()).filter(Boolean), ...modeSkillIds]);

    return {
      ...normalizedParticipant,
      conversationSkillIds: Array.from(mergedSkills),
    };
  });

  return { ...input, participants: merged };
}



export function createConversationsController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  const conversationSpawnService = options.conversationSpawnService;
  const roleService = options.roleService;
  const skillRegistry = options.skillRegistry;
  const projectManager = options.projectManager;
  const turnOrchestrator = options.turnOrchestrator;
  const undercoverService = options.undercoverService;
  const werewolfService = options.werewolfService;
  const buildBootstrapPayload = options.buildBootstrapPayload;
  const modeStore = options.modeStore;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};

  function listConversationHeaders() {
    return typeof store.listConversationTree === 'function'
      ? store.listConversationTree()
      : store.listConversations();
  }
  const digestOptions = {
    ...(options.digestOptions || {}),
    digestModelRunner: options.digestModelRunner,
    provider: options.digestProvider,
    model: options.digestModel,
    thinking: options.digestThinking,
    agentDir: options.agentDir,
    sqlitePath: options.sqlitePath,
  };
  const rawSkillDraftOptions = options.skillDraftOptions || {};
  const skillDraftOptions = {
    ...rawSkillDraftOptions,
    skillDraftModelRunner: options.skillDraftModelRunner || rawSkillDraftOptions.skillDraftModelRunner,
    provider: options.skillDraftProvider !== undefined ? options.skillDraftProvider : rawSkillDraftOptions.provider,
    model: options.skillDraftModel !== undefined ? options.skillDraftModel : rawSkillDraftOptions.model,
    thinking: options.skillDraftThinking !== undefined ? options.skillDraftThinking : rawSkillDraftOptions.thinking,
    agentDir: options.agentDir !== undefined ? options.agentDir : rawSkillDraftOptions.agentDir,
    sqlitePath: options.sqlitePath !== undefined ? options.sqlitePath : rawSkillDraftOptions.sqlitePath,
    getProjectDir() {
      if (typeof rawSkillDraftOptions.getProjectDir === 'function') {
        return String(rawSkillDraftOptions.getProjectDir() || '').trim();
      }

      const activeProject = projectManager && typeof projectManager.getActiveProject === 'function'
        ? projectManager.getActiveProject()
        : null;
      return String(activeProject && activeProject.path || options.projectDir || '').trim();
    },
  };

  function validateConversationParticipants(input: any, validationOptions: any = {}) {
    if (roleService && typeof roleService.validateConversationParticipants === 'function') {
      return roleService.validateConversationParticipants(input, validationOptions);
    }
    if (store && typeof store.normalizeConversationParticipantsInput === 'function') {
      return store.normalizeConversationParticipantsInput(input);
    }
    throw createHttpError(500, 'Conversation participant validation is unavailable');
  }

  return async function handleConversationsRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    if (req.method === 'GET' && pathname === '/api/conversations') {
      sendJson(res, 200, { conversations: listConversationHeaders() });
      return true;
    }

    const spawnMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/spawn$/);
    if (spawnMatch && req.method === 'POST') {
      if (!conversationSpawnService || typeof conversationSpawnService.spawn !== 'function') {
        throw createHttpError(501, 'Conversation spawn is unavailable');
      }
      const sourceConversationId = decodeURIComponent(spawnMatch[1]);
      const body = await readRequestJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw createHttpError(400, 'Request body must be a JSON object', {
          issues: [{ code: 'invalid_body', message: 'Request body must be a JSON object' }],
        });
      }
      const allowedFields = new Set([
        'title',
        'projectScopeId',
        'participants',
        'primaryAgentId',
        'initialMessage',
        'sourceMessageId',
        'clientRequestId',
      ]);
      const unknownField = Object.keys(body).find((fieldName) => !allowedFields.has(fieldName));
      if (unknownField) {
        throw createHttpError(400, `Unknown conversation spawn field: ${unknownField}`, {
          issues: [{
            code: 'conversation_spawn_unknown_field',
            field: unknownField,
            message: `Unknown field: ${unknownField}`,
          }],
        });
      }

      const result = await conversationSpawnService.spawn(sourceConversationId, body);
      const summary = pickConversationSummary(result.conversation);
      const conversations = listConversationHeaders();
      broadcastEvent('conversation_spawned', {
        sourceConversationId,
        conversationId: result.conversation.id,
        summary,
        delivery: result.delivery,
      });
      broadcastEvent('conversation_summary_updated', {
        conversationId: result.conversation.id,
        summary,
      });
      sendJson(res, 201, {
        duplicate: Boolean(result.duplicate),
        conversation: result.conversation,
        summary,
        conversations,
        initialMessage: result.initialMessage,
        sourceReceipt: result.sourceReceipt,
        delivery: result.delivery,
      });
      return true;
    }

    const projectScopeMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/project-scope$/);
    if (projectScopeMatch && req.method === 'PUT') {
      const conversationId = decodeURIComponent(projectScopeMatch[1]);
      const body = await readRequestJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw createHttpError(400, 'Request body must be a JSON object', {
          issues: [{ code: 'invalid_body', message: 'Request body must be a JSON object' }],
        });
      }
      const unknownField = Object.keys(body).find((fieldName) => fieldName !== 'projectId');
      if (unknownField) {
        throw createHttpError(400, `Unknown project scope field: ${unknownField}`, {
          issues: [{ code: 'unknown_field', field: unknownField, message: `Unknown field: ${unknownField}` }],
        });
      }
      const projectId = String(body.projectId || '').trim();
      if (!projectId) {
        throw createHttpError(400, 'projectId is required', {
          issues: [{ code: 'project_id_required', field: 'projectId', message: 'projectId is required' }],
        });
      }
      if (!projectManager || typeof projectManager.listProjects !== 'function') {
        throw createHttpError(501, 'Project manager is not configured');
      }
      const project = projectManager.listProjects()
        .find((candidate: any) => candidate && candidate.id === projectId);
      if (!project) {
        throw createHttpError(404, 'Project not found', {
          issues: [{ code: 'project_not_found', field: 'projectId', message: 'Project not found' }],
        });
      }
      if (!store || typeof store.bindConversationProjectScope !== 'function') {
        throw createHttpError(501, 'Conversation project scope binding is unavailable');
      }

      const conversation = store.bindConversationProjectScope(conversationId, project.id);
      const summary = pickConversationSummary(conversation);
      broadcastEvent('conversation_summary_updated', { conversationId, summary });
      sendJson(res, 200, {
        conversation,
        summary,
        conversations: listConversationHeaders(),
        project,
      });
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
      }

      conversationInput = {
        ...conversationInput,
        participants: validateConversationParticipants(conversationInput),
      };

      // Merge mode skill bindings only into the explicit participant roster.
      const mode = modeStore ? modeStore.get(conversationType) : null;
      const enrichedBody = mergeModeSkillIdsIntoParticipants(conversationInput, mode);

      let conversation = store.createConversation({
        ...enrichedBody,
        type: conversationType,
        metadata,
      });

      if (conversation.type === UNDERCOVER_CONVERSATION_TYPE) {
        conversation = undercoverService.prepareConversation(conversation.id);
      } else if (conversation.type === WEREWOLF_CONVERSATION_TYPE) {
        conversation = werewolfService.prepareConversation(conversation.id);
      }

      sendJson(res, 201, {
        conversation,
        summary: pickConversationSummary(conversation),
        conversations: listConversationHeaders(),
      });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/channel-bindings/feishu') {
      sendJson(res, 200, { chats: listKnownFeishuChats(store) });
      return true;
    }

    const feishuBindingMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/channel-bindings\/feishu$/);

    if (feishuBindingMatch && req.method === 'PUT') {
      const conversationId = decodeURIComponent(feishuBindingMatch[1]);
      const body = await readRequestJson(req);
      const chatId = String(body && body.chatId ? body.chatId : '').trim();

      if (!chatId) {
        throw createHttpError(400, 'Feishu chat_id 不能为空', {
          issues: [
            {
              code: 'missing_chat_id',
              message: 'Feishu chat_id is required',
            },
          ],
        });
      }

      const conversation = store.getConversationWithoutMessages(conversationId);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      const runtime = turnOrchestrator && typeof turnOrchestrator.buildRuntimePayload === 'function'
        ? turnOrchestrator.buildRuntimePayload()
        : {};
      const workState = conversationWorkState(runtime, conversationId);

      if (workState.busy) {
        throw createHttpError(409, '当前会话正在处理或仍有待处理消息，请结束后再绑定飞书 chat_id', {
          issues: [
            {
              code: 'conversation_busy',
              message: 'Conversation is busy or has queued work',
              active: workState.active,
              dispatching: workState.dispatching,
              activeTurnCount: workState.activeTurnCount,
              activeAgentSlotCount: workState.activeAgentSlotCount,
              queuedUserCount: workState.queuedUserCount,
              queuedAgentSlotCount: workState.queuedAgentSlotCount,
            },
          ],
        });
      }

      const existingConversationBinding = store.getConversationChannelBindingByConversationId(FEISHU_PLATFORM, conversationId);

      if (existingConversationBinding && existingConversationBinding.externalChatId !== chatId) {
        throw createHttpError(409, '当前会话已绑定其他飞书 chat_id，MVP 暂不支持直接覆盖', {
          issues: [
            {
              code: 'conversation_already_bound',
              message: 'Conversation is already bound to another Feishu chat_id',
              externalChatId: existingConversationBinding.externalChatId,
            },
          ],
        });
      }

      const existingChatBinding = store.getConversationChannelBinding(FEISHU_PLATFORM, chatId);
      const previousConversationId = existingChatBinding && existingChatBinding.conversationId
        ? existingChatBinding.conversationId
        : null;
      const metadata = mergeFeishuBindingMetadata(existingChatBinding || existingConversationBinding);
      const binding = existingChatBinding
        ? store.updateConversationChannelBinding({
            platform: FEISHU_PLATFORM,
            externalChatId: chatId,
            conversationId,
            metadata,
          })
        : store.createConversationChannelBinding({
            platform: FEISHU_PLATFORM,
            externalChatId: chatId,
            conversationId,
            metadata,
          });

      if (!binding) {
        throw createHttpError(409, '飞书 chat_id 绑定冲突，请刷新后重试', {
          issues: [
            {
              code: 'binding_conflict',
              message: 'Feishu chat binding could not be saved',
            },
          ],
        });
      }

      sendJson(res, 200, {
        binding,
        moved: Boolean(previousConversationId && previousConversationId !== conversationId),
        previousConversationId,
      });
      return true;
    }

    const conversationDigestMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/digest$/);

    if (conversationDigestMatch && (req.method === 'GET' || req.method === 'POST')) {
      const conversationId = decodeURIComponent(conversationDigestMatch[1]);
      const body = req.method === 'POST' ? await readRequestJson(req) : { action: 'get' };
      const action = String(body && body.action || '').trim().toLowerCase();

      if (req.method === 'POST' && action === 'extract-skill') {
        const result = await applyConversationSkillDraftAction(store, conversationId, {
          ...body,
          action: 'extract',
        }, skillDraftOptions);
        const latestConversation = store.getConversation(conversationId) || result.conversation;
        const summary = pickConversationSummary(latestConversation);

        if (result.changed) {
          broadcastEvent('conversation_skill_draft_updated', {
            conversationId,
            draft: result.draft,
            skillDrafts: result.skillDrafts,
            conversation: latestConversation,
            summary,
          });
          broadcastEvent('conversation_summary_updated', {
            conversationId,
            summary,
          });
        }

        sendJson(res, 200, {
          conversation: latestConversation,
          skillDrafts: result.skillDrafts,
          draft: result.draft,
          summary,
          conversations: listConversationHeaders(),
        });
        return true;
      }

      let shouldClearDigestStatus = false;
      let result: any;

      try {
        result = await applyConversationDigestAction(store, conversationId, body || {}, {
          ...digestOptions,
          onModelProgress(progress: any) {
            shouldClearDigestStatus = true;
            broadcastEvent('conversation_digest_status', {
              conversationId,
              status: 'running',
              reason: progress && progress.reason ? progress.reason : 'model_digest',
              phase: progress && progress.phase ? progress.phase : '',
              message: progress && progress.message ? progress.message : '会话摘要模型正在生成…',
              pendingExperienceDraftCount: 0,
              model: progress && progress.model ? progress.model : null,
              modelTrace: progress && progress.modelTrace ? progress.modelTrace : null,
            });
          },
        });
      } finally {
        if (shouldClearDigestStatus) {
          broadcastEvent('conversation_digest_status', {
            conversationId,
            status: 'idle',
            reason: 'model_digest',
          });
        }
      }

      if (req.method === 'POST' && result.digestChanged) {
        const summary = pickConversationSummary(result.conversation);
        broadcastEvent(result.deleted ? 'conversation_digest_deleted' : 'conversation_digest_updated', {
          conversationId,
          digest: result.digest,
          rollup: result.rollup,
          digests: result.digests,
          deleted: result.deleted,
          compacted: result.compacted,
          conversation: result.conversation,
          summary,
        });
        broadcastEvent('conversation_summary_updated', {
          conversationId,
          summary,
        });
      }

      const latestConversation = store.getConversation(conversationId) || result.conversation;
      sendJson(res, 200, {
        conversation: latestConversation,
        digests: result.digests,
        digest: result.digest,
        rollup: result.rollup,
        deleted: result.deleted,
        compacted: result.compacted,
        summary: pickConversationSummary(latestConversation),
        conversations: listConversationHeaders(),
      });
      return true;
    }

    const skillDraftsMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/skill-drafts(?:\/([^/]+)\/(confirm|reject))?$/);

    if (skillDraftsMatch && (req.method === 'GET' || req.method === 'POST')) {
      const conversationId = decodeURIComponent(skillDraftsMatch[1]);
      const draftId = skillDraftsMatch[2] ? decodeURIComponent(skillDraftsMatch[2]) : '';
      const routeAction = skillDraftsMatch[3] ? String(skillDraftsMatch[3]).trim().toLowerCase() : '';
      const body = req.method === 'POST' ? await readRequestJson(req) : {};
      const action = req.method === 'GET' ? 'list' : routeAction || String(body && body.action || 'list').trim().toLowerCase();
      const result = await applyConversationSkillDraftAction(store, conversationId, {
        ...(body || {}),
        action,
        draftId: draftId || body && body.draftId,
      }, skillDraftOptions);
      const latestConversation = store.getConversation(conversationId) || result.conversation;
      const summary = pickConversationSummary(latestConversation);

      if (req.method === 'POST' && result.changed) {
        broadcastEvent('conversation_skill_draft_updated', {
          conversationId,
          draft: result.draft,
          skill: result.skill,
          skillDrafts: result.skillDrafts,
          conversation: latestConversation,
          summary,
        });
        broadcastEvent('conversation_summary_updated', {
          conversationId,
          summary,
        });
      }

      sendJson(res, 200, {
        conversation: latestConversation,
        skillDrafts: result.skillDrafts,
        draft: result.draft,
        skill: result.skill,
        summary,
        conversations: listConversationHeaders(),
      });
      return true;
    }

    const conversationGoalMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/goal$/);

    if (conversationGoalMatch && (req.method === 'GET' || req.method === 'POST')) {
      const conversationId = decodeURIComponent(conversationGoalMatch[1]);
      const body = req.method === 'POST' ? await readRequestJson(req) : { action: 'get' };
      const result = applySessionGoalAction(store, conversationId, body || {});
      let autoContinuation = null;

      if (req.method === 'POST') {
        const summary = pickConversationSummary(result.conversation);

        if (result.goalChanged || result.cleared) {
          broadcastEvent(result.cleared ? 'conversation_goal_cleared' : 'conversation_goal_updated', {
            conversationId,
            goal: result.goal,
            proposal: result.proposal,
            conversation: result.conversation,
            summary,
          });
        }

        if (result.proposalChanged) {
          broadcastEvent(result.proposalCleared ? 'conversation_goal_proposal_cleared' : 'conversation_goal_proposal_updated', {
            conversationId,
            goal: result.goal,
            proposal: result.proposal,
            conversation: result.conversation,
            summary,
          });
        }

        broadcastEvent('conversation_summary_updated', {
          conversationId,
          summary,
        });

        if (
          result.goalChanged &&
          result.autoContinue !== false &&
          result.goal &&
          result.goal.status === 'active' &&
          !result.proposal &&
          turnOrchestrator &&
          typeof turnOrchestrator.scheduleGoalContinuation === 'function'
        ) {
          try {
            autoContinuation = turnOrchestrator.scheduleGoalContinuation(conversationId, {
              reason: 'goal_action',
            });
          } catch (error) {
            const errorValue = error as any;
            console.warn(
              `[conversations-controller] Failed to schedule goal continuation for ${conversationId}: ${
                errorValue && errorValue.stack ? errorValue.stack : errorValue
              }`
            );
            autoContinuation = {
              scheduled: false,
              reason: 'schedule_failed',
            };
          }
        }
      }

      const latestConversation = store.getConversation(conversationId) || result.conversation;
      sendJson(res, 200, {
        conversation: latestConversation,
        goal: result.goal,
        proposal: result.proposal,
        cleared: result.cleared,
        autoContinuation,
        summary: pickConversationSummary(latestConversation),
        conversations: listConversationHeaders(),
      });
      return true;
    }

    const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);

    if (conversationMatch) {
      const conversationId = decodeURIComponent(conversationMatch[1]);

      if (req.method === 'GET') {
        const conversation = store.getConversationWithoutMessages(conversationId);

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
        const existingConversation = store.getConversationWithoutMessages(conversationId);

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

        // Omitting both roster fields means "leave participants unchanged".
        // Callers that intend to replace or clear the roster must send an explicit array;
        // the participant validator then rejects an empty final roster.
        // Profile-based recovery is intentionally limited to IDs already persisted in this roster;
        // request payloads cannot use this exception to add a new unavailable participant.
        const recoverableRoleIds = new Set(
          Array.isArray(existingConversation && existingConversation.agents)
            ? existingConversation.agents.map((agent: any) => String(agent && agent.id || '').trim()).filter(Boolean)
            : []
        );
        const validatedBody = (Array.isArray(body.participants) || Array.isArray(body.agentIds))
          ? { ...body, participants: validateConversationParticipants(body, { recoverableRoleIds }) }
          : body;
        let conversation = store.updateConversation(conversationId, validatedBody);

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
          conversations: listConversationHeaders(),
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

    const contextSnapshotListMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/context-snapshots$/);

    if (contextSnapshotListMatch && req.method === 'GET') {
      const conversationId = decodeURIComponent(contextSnapshotListMatch[1]);
      const conversation = store.getConversation(conversationId);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      const snapshots = (Array.isArray(conversation.messages) ? conversation.messages : [])
        .filter((message: any) => message && message.role === 'assistant')
        .map((message: any) => summarizeAgentContextSnapshot(contextSnapshotFromMessage(message)))
        .filter(Boolean);

      sendJson(res, 200, { conversationId, snapshots });
      return true;
    }

    const messageContextSnapshotMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/context-snapshot(?:-(export))?$/);

    if (messageContextSnapshotMatch && req.method === 'GET') {
      const conversationId = decodeURIComponent(messageContextSnapshotMatch[1]);
      const messageId = decodeURIComponent(messageContextSnapshotMatch[2]);
      const exportMode = messageContextSnapshotMatch[3] === 'export';
      const conversation = store.getConversationWithoutMessages(conversationId);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      const message = store.getMessage(messageId);

      if (!message || message.conversationId !== conversationId) {
        throw createHttpError(404, 'Message not found');
      }

      if (message.role !== 'assistant') {
        throw createHttpError(400, 'Only assistant messages can inspect context snapshots');
      }

      const snapshot = contextSnapshotFromMessage(message);

      if (!snapshot) {
        throw createHttpError(404, 'No context snapshot is available for this message');
      }

      if (exportMode) {
        sendTextDownload(
          res,
          exportAgentContextSnapshotMarkdown(snapshot),
          defaultContextSnapshotFileName(message),
          'text/markdown; charset=utf-8'
        );
        return true;
      }

      sendJson(res, 200, { snapshot: materializeAgentContextSnapshot(snapshot) });
      return true;
    }

    const messageSessionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/session-export$/);

    if (messageSessionMatch && req.method === 'GET') {
      const conversationId = decodeURIComponent(messageSessionMatch[1]);
      const messageId = decodeURIComponent(messageSessionMatch[2]);
      const conversation = store.getConversationWithoutMessages(conversationId);

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
      const conversation = store.getConversationWithoutMessages(conversationId);

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

    if (messageMatch && req.method === 'GET') {
      const conversationId = decodeURIComponent(messageMatch[1]);
      const conversation = store.getConversationWithoutMessages(conversationId);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      sendJson(res, 200, buildConversationMessagePage(store, conversationId, requestUrl.searchParams));
      return true;
    }

    if (messageMatch && req.method === 'POST') {
      const conversationId = decodeURIComponent(messageMatch[1]);
      const body = await readRequestJson(req);
      const conversation = store.getConversationWithoutMessages(conversationId);

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
