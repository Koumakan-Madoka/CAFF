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
import { buildConversationDirectoryPage } from '../domain/conversation/conversation-directory-pagination';
import { applyConversationSkillDraftAction } from '../domain/conversation/skill-draft';
import {
  bindAndPersistRoomWorkspace,
  previewRoomWorkspace,
} from '../domain/conversation/room-workspace';
import { applySessionGoalAction } from '../domain/conversation/session-goal';
import {
  getDagNodeExecutionContext,
  isDagBoundGoalMutationAllowed,
} from '../domain/conversation/dag-goal-binding';
import {
  exportAgentContextSnapshotMarkdown,
  materializeAgentContextSnapshot,
  summarizeAgentContextSnapshot,
} from '../domain/conversation/turn/context-snapshot';
import { buildAssistantMessageToolTrace } from '../domain/runtime/message-tool-trace';

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

function isPlainObject(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const CREATE_ROOM_FIELDS = new Set(['title', 'projectScopeId', 'modeId', 'participants']);

function projectById(projectManager: any, projectScopeId: any) {
  const normalized = String(projectScopeId || '').trim();
  return (projectManager && typeof projectManager.listProjects === 'function'
    ? projectManager.listProjects()
    : []).find((project: any) => project && project.id === normalized) || null;
}

function roomCreationError(statusCode: number, code: string, message: string, field: string) {
  return createHttpError(statusCode, message, { code, issues: [{ code, field, message }] });
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
  const buildBootstrapPayload = options.buildBootstrapPayload;
  const modeStore = options.modeStore;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const agentToolBridge = options.agentToolBridge || null;
  const conversationMessageDeletionService = options.conversationMessageDeletionService || null;
  const conversationMutationCoordinator = options.conversationMutationCoordinator || null;

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
      sendJson(res, 200, buildConversationDirectoryPage(store, requestUrl.searchParams));
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
      const projectId = String(body.projectId || '').trim();
      const project = projectById(projectManager, projectId);
      if (!project) {
        throw createHttpError(404, 'Project not found', {
          issues: [{ code: 'project_not_found', field: 'projectId', message: 'Project not found' }],
        });
      }
      const conversation = store.bindConversationProjectScope(conversationId, project.id);
      if (!conversation) throw createHttpError(409, 'Conversation project is already bound or missing');
      const summary = pickConversationSummary(conversation);
      broadcastEvent('conversation_summary_updated', { conversationId, summary });
      sendJson(res, 200, { conversation, summary, conversations: listConversationHeaders(), project });
      return true;
    }

    const acceptanceRecordsMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/acceptance-records$/);
    if (acceptanceRecordsMatch && req.method === 'GET') {
      const conversationId = decodeURIComponent(acceptanceRecordsMatch[1]);
      const conversation = store.getConversationWithoutMessages(conversationId);
      if (!conversation) throw createHttpError(404, 'Conversation not found');
      const records = store.listAcceptanceRecords(conversationId);
      sendJson(res, 200, { records });
      return true;
    }
    if (acceptanceRecordsMatch && req.method === 'POST') {
      const conversationId = decodeURIComponent(acceptanceRecordsMatch[1]);
      const body = await readRequestJson(req);
      const conversation = store.getConversationWithoutMessages(conversationId);
      if (!conversation) throw createHttpError(404, 'Conversation not found');
      const candidateSha = String(body && body.candidateSha || '').trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/u.test(candidateSha)) {
        throw roomCreationError(400, 'acceptance_record_invalid', 'candidateSha must be a full Git SHA', 'candidateSha');
      }
      const requiredArrays = ['mergeCommits', 'automatedChecks', 'manualChecks', 'knownLimitations'];
      if (requiredArrays.some((field) => !Array.isArray(body && body[field]))) {
        throw roomCreationError(400, 'acceptance_record_invalid', 'Acceptance evidence arrays are required', 'evidence');
      }
      const record = store.createAcceptanceRecord(conversationId, {
        candidateSha,
        roomBranch: conversation.branch || null,
        mergeCommits: body.mergeCommits,
        automatedChecks: body.automatedChecks,
        manualChecks: body.manualChecks,
        knownLimitations: body.knownLimitations,
        environment: isPlainObject(body.environment) ? body.environment : {},
        createdBy: String(body.createdBy || 'operator').trim() || 'operator',
      });
      sendJson(res, 201, { record });
      return true;
    }

    const acceptanceDecisionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/acceptance-records\/([^/]+)\/decision$/);
    if (acceptanceDecisionMatch && req.method === 'POST') {
      const conversationId = decodeURIComponent(acceptanceDecisionMatch[1]);
      const recordId = decodeURIComponent(acceptanceDecisionMatch[2]);
      const body = await readRequestJson(req);
      const conversation = store.getConversationWithoutMessages(conversationId);
      if (!conversation) throw createHttpError(404, 'Conversation not found');
      const current = store.getAcceptanceRecord(conversationId, recordId);
      if (!current) throw createHttpError(404, 'Acceptance record not found');
      const decision = String(body && body.decision || '').trim();
      if (!['accepted', 'rejected'].includes(decision)) {
        throw roomCreationError(400, 'acceptance_decision_invalid', 'decision must be accepted or rejected', 'decision');
      }
      if (current.status !== 'pending') {
        if (current.status === decision) {
          sendJson(res, 200, { record: current, conversation });
          return true;
        }
        throw roomCreationError(409, 'acceptance_record_decided', 'Acceptance record is already decided', 'decision');
      }
      const acceptedSha = decision === 'accepted' ? String(body.acceptedSha || '').trim().toLowerCase() : null;
      if (decision === 'accepted' && acceptedSha !== current.candidateSha) {
        throw roomCreationError(409, 'acceptance_sha_mismatch', 'acceptedSha must equal candidateSha', 'acceptedSha');
      }
      const decided = store.decideAcceptanceRecord(conversationId, recordId, {
        status: decision,
        acceptedSha,
        decisionNote: String(body.note || '').trim(),
      });
      if (!decided) {
        throw roomCreationError(409, 'acceptance_record_decided', 'Acceptance record changed concurrently', 'decision');
      }
      sendJson(res, 200, { record: decided });
      return true;
    }

    const workspaceAuthorizationMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/workspace\/authorizations$/);
    if (workspaceAuthorizationMatch && req.method === 'GET') {
      if (!agentToolBridge || typeof agentToolBridge.listRoomWorkspaceAuthorizations !== 'function') {
        throw createHttpError(501, 'Workspace authorization is not available');
      }
      const conversationId = decodeURIComponent(workspaceAuthorizationMatch[1]);
      sendJson(res, 200, {
        authorizations: agentToolBridge.listRoomWorkspaceAuthorizations(conversationId),
      });
      return true;
    }

    const workspaceAuthorizationDecisionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/workspace\/authorizations\/([^/]+)\/decision$/);
    if (workspaceAuthorizationDecisionMatch && req.method === 'POST') {
      if (!agentToolBridge || typeof agentToolBridge.handleRoomWorkspaceAuthorization !== 'function') {
        throw createHttpError(501, 'Workspace authorization is not available');
      }
      const conversationId = decodeURIComponent(workspaceAuthorizationDecisionMatch[1]);
      const authorizationId = decodeURIComponent(workspaceAuthorizationDecisionMatch[2]);
      const body = await readRequestJson(req);
      const allowedFields = new Set(['token', 'fingerprint', 'decision']);
      const unknownField = body && typeof body === 'object'
        ? Object.keys(body).find((fieldName) => !allowedFields.has(fieldName))
        : null;
      if (unknownField) {
        throw roomCreationError(400, 'room_workspace_authorization_invalid_request', `Unknown authorization field: ${unknownField}`, unknownField);
      }
      const outcome = await agentToolBridge.handleRoomWorkspaceAuthorization({
        conversationId,
        authorizationId,
        token: body && body.token,
        fingerprint: body && body.fingerprint,
        decision: body && body.decision,
      });
      const result = outcome && outcome.result;
      if (result && result.conversation) {
        broadcastEvent('conversation_summary_updated', {
          conversationId,
          summary: pickConversationSummary(result.conversation),
        });
      }
      broadcastEvent('room_workspace_authorization_updated', {
        conversationId,
        authorization: outcome.record,
      });
      sendJson(res, 200, {
        authorization: outcome.record,
        conversation: result ? result.conversation : null,
        workspace: result ? result.workspace : null,
      });
      return true;
    }
    const workspacePreviewMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/workspace\/preview$/);
    if (workspacePreviewMatch && req.method === 'GET') {
      const conversationId = decodeURIComponent(workspacePreviewMatch[1]);
      const conversation = store.getConversationWithoutMessages(conversationId);
      if (!conversation) throw createHttpError(404, 'Conversation not found');
      const project = projectById(projectManager, conversation.projectScopeId);
      if (!project) throw roomCreationError(404, 'room_project_not_found', 'Room Project not found', 'projectScopeId');
      sendJson(res, 200, { preview: previewRoomWorkspace({ conversation, project }) });
      return true;
    }

    const workspaceMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/workspace$/);
    if (workspaceMatch && req.method === 'POST') {
      const conversationId = decodeURIComponent(workspaceMatch[1]);
      const body = await readRequestJson(req);
      if (!body || body.confirm !== true) {
        throw roomCreationError(400, 'room_workspace_confirmation_required', 'confirm=true is required', 'confirm');
      }
      const conversation = store.getConversationWithoutMessages(conversationId);
      if (!conversation) throw createHttpError(404, 'Conversation not found');
      const project = projectById(projectManager, conversation.projectScopeId);
      if (!project) throw roomCreationError(404, 'room_project_not_found', 'Room Project not found', 'projectScopeId');
      const result = bindAndPersistRoomWorkspace({
        store,
        conversation,
        project,
        workspaceBoundAt: new Date().toISOString(),
      });
      sendJson(res, result.created ? 201 : 200, {
        conversation: result.conversation,
        workspace: result.workspace,
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/conversations') {
      const body = await readRequestJson(req);
      if (!isPlainObject(body)) {
        throw roomCreationError(400, 'room_invalid_request', 'Room request must be an object', 'body');
      }
      const unknownField = Object.keys(body).find((key) => !CREATE_ROOM_FIELDS.has(key));
      if (unknownField) {
        throw roomCreationError(400, 'room_unknown_field', `Unknown Room field: ${unknownField}`, unknownField);
      }
      const projectScopeId = String(body.projectScopeId || '').trim();
      if (!projectScopeId) {
        throw roomCreationError(400, 'room_project_required', 'Project is required', 'projectScopeId');
      }
      const project = projectById(projectManager, projectScopeId);
      if (!project) {
        throw roomCreationError(404, 'room_project_not_found', 'Project not found', 'projectScopeId');
      }
      const modeId = String(body.modeId || '').trim();
      if (!modeId) {
        throw roomCreationError(400, 'room_mode_required', 'Mode is required', 'modeId');
      }
      const mode = modeStore && modeStore.get(modeId);
      if (!mode) {
        throw roomCreationError(404, 'room_mode_not_found', 'Mode not found', 'modeId');
      }
      const conversationInput = {
        ...body,
        participants: validateConversationParticipants(body),
      };
      const enrichedBody = mergeModeSkillIdsIntoParticipants(conversationInput, mode);
      const conversation = store.createConversation({
        ...enrichedBody,
        projectScopeId,
        modeId,
        metadata: {},
      });

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
      const requiresMutation = req.method === 'POST' && action !== 'get';
      const mutationLease = requiresMutation && conversationMutationCoordinator
        && typeof conversationMutationCoordinator.tryAcquire === 'function'
        ? conversationMutationCoordinator.tryAcquire(conversationId, 'manual_digest')
        : { acquired: true, release() {} };

      if (!mutationLease.acquired) {
        throw createHttpError(409, '会话摘要或其它历史修改正在运行，请稍后重试', {
          code: 'conversation_digest_running',
        });
      }

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
        mutationLease.release();
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
      // D28 fail-closed: while a DAG node is doing, the bound child
      // conversation's goal may only be read, checklist-updated, or have its
      // pending proposal ruled on (accept/dismiss = user manual
      // verification). Direct complete/clear/set/pause/resume would bypass
      // the worker→verifier completion protocol.
      if (req.method === 'POST' && getDagNodeExecutionContext(store, conversationId)
        && !isDagBoundGoalMutationAllowed(body && body.action)) {
        throw createHttpError(403, '该会话正在执行 DAG 节点，目标仅支持验收裁决（接受/驳回提案），不能直接完成/清除/替换', {
          code: 'dag_goal_mutation_forbidden',
        });
      }
      const result = applySessionGoalAction(store, conversationId, {
        ...(body || {}),
        // D28: a ruling via this endpoint is ALWAYS the user (manual
        // verification). Forced server-side — a client-supplied ruledBy is
        // never trusted. The principal is persisted atomically with the
        // proposal clear (durable ruling record), not just broadcast.
        ruledBy: { kind: 'user' },
      });
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
          // D28: the user accepting/rejecting via the UI is a legitimate
          // ruling path (manual verification). The cleared event must carry
          // the authoritative pre-clear proposal snapshot (the scheduler
          // derives the node result summary from it) plus an explicit user
          // ruling marker — an absent ruledBy would be indistinguishable
          // from a missing enforcement check.
          const goalAction = String(body && body.action || '').trim().toLowerCase();
          const isRulingAction = result.proposalCleared
            && (goalAction === 'accept-proposal' || goalAction === 'accept_proposal'
              || goalAction === 'dismiss-proposal' || goalAction === 'dismiss_proposal');
          broadcastEvent(result.proposalCleared ? 'conversation_goal_proposal_cleared' : 'conversation_goal_proposal_updated', {
            conversationId,
            goal: result.goal,
            proposal: result.proposalCleared ? (result.clearedProposal || null) : result.proposal,
            ...(isRulingAction ? {
              outcome: goalAction.startsWith('accept') ? 'accepted' : 'rejected',
              ruledBy: { kind: 'user' },
            } : {}),
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
        if (body && (body.projectScopeId !== undefined || body.modeId !== undefined || body.type !== undefined)) {
          throw roomCreationError(409, 'room_context_immutable', 'Room Project and Mode cannot be changed', 'modeId');
        }
        const existingConversation = store.getConversationWithoutMessages(conversationId);

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
        const conversation = store.updateConversation(conversationId, validatedBody);

        if (!conversation) {
          throw createHttpError(404, '会话不存在');
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

        const batchIds = Array.from(
          new Set(
            [
              ...store.listImageUploadsByConversation(conversationId),
              ...store.listImageUploadBatchesByConversation(conversationId),
            ]
              .map((row: any) => String(row && row.batchId || '').trim())
              .filter(Boolean)
          )
        );

        store.deleteConversation(conversationId);

        if (batchIds.length > 0 && options.uploadService && typeof options.uploadService.removeBatchDirectories === 'function') {
          try {
            options.uploadService.removeBatchDirectories(batchIds);
          } catch {}
        }

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

    const messageDeleteMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/delete$/);

    if (messageDeleteMatch && req.method === 'POST') {
      if (!conversationMessageDeletionService || typeof conversationMessageDeletionService.deleteMessages !== 'function') {
        throw createHttpError(501, 'Conversation message deletion is unavailable');
      }

      const conversationId = decodeURIComponent(messageDeleteMatch[1]);
      const body = await readRequestJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw createHttpError(400, 'Request body must be a JSON object', {
          code: 'conversation_message_delete_invalid_request',
        });
      }
      const unknownField = Object.keys(body).find((fieldName) => fieldName !== 'messageIds');
      if (unknownField) {
        throw createHttpError(400, `Unknown message deletion field: ${unknownField}`, {
          code: 'conversation_message_delete_invalid_request',
        });
      }

      const result = conversationMessageDeletionService.deleteMessages(conversationId, body);
      sendJson(res, 200, result);
      return true;
    }

    const messageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);

    if (messageMatch && req.method === 'GET') {
      const conversationId = decodeURIComponent(messageMatch[1]);
      const conversation = store.getConversationWithoutMessages(conversationId);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      const page = buildConversationMessagePage(store, conversationId, requestUrl.searchParams);
      if (
        conversationMessageDeletionService
        && typeof conversationMessageDeletionService.projectMessages === 'function'
      ) {
        const projection = conversationMessageDeletionService.projectMessages(conversationId, page.items);
        sendJson(res, 200, {
          ...page,
          items: projection.items,
          deletionState: projection.deletionState,
        });
        return true;
      }

      sendJson(res, 200, page);
      return true;
    }

    if (messageMatch && req.method === 'POST') {
      const conversationId = decodeURIComponent(messageMatch[1]);
      const body = await readRequestJson(req);
      const conversation = store.getConversationWithoutMessages(conversationId);

      if (!conversation) {
        throw createHttpError(404, '会话不存在');
      }

      const clientRequestId = typeof body.clientRequestId === 'string' ? body.clientRequestId.trim() : '';
      const submittedMetadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};

      if (submittedMetadata.contentBlocks) {
        throw createHttpError(400, 'Client must not submit contentBlocks; content + imageIds only', {
          code: 'TEXT_BLOCK_FROM_CLIENT_REJECTED',
        });
      }

      const result = turnOrchestrator.submitConversationMessage(conversationId, {
        content: body.content,
        imageIds: Array.isArray(body.imageIds) ? body.imageIds : [],
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
