import { MAX_CONVERSATION_MESSAGE_DELETE_BATCH_SIZE } from '../../../lib/conversation-message-deletion-contract';
import { createHttpError } from '../../http/http-errors';
import { pickConversationSummary } from './conversation-view';
import {
  getConversationDigestCoverage,
  isConversationMessageCoveredByLatestDigest,
  recomputeConversationDigestState,
} from './conversation-digest';

const REASON_MESSAGES: Record<string, string> = {
  message_not_found: '消息不存在或不属于当前会话',
  message_role_not_deletable: '系统、外部 Agent 和私信消息不能删除',
  message_status_not_deletable: 'Agent 消息尚未结束，不能删除',
  message_summarized: '这条消息已被会话摘要覆盖，不能删除',
  message_cross_conversation: '跨会话投递、回执或来源消息不能删除',
};

function normalizeMessageIds(value: any) {
  return (Array.isArray(value) ? value : [])
    .map((messageId: any) => String(messageId || '').trim())
    .filter(Boolean);
}

function messageMetadata(message: any) {
  return message && message.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};
}

function hasCrossConversationMetadata(message: any) {
  const metadata = messageMetadata(message);
  return Boolean(
    String(metadata.crossConversationDeliveryId || '').trim()
    || (metadata.crossConversation && typeof metadata.crossConversation === 'object')
    || (metadata.conversationSpawn && typeof metadata.conversationSpawn === 'object')
  );
}

function runtimeMutationState(turnOrchestrator: any, conversationId: string) {
  if (turnOrchestrator && typeof turnOrchestrator.getConversationMutationState === 'function') {
    return turnOrchestrator.getConversationMutationState(conversationId);
  }

  return {
    active: false,
    dispatching: false,
    activeTurnCount: 0,
    activeAgentSlotCount: 0,
    queuedUserCount: 0,
    queuedAgentSlotCount: 0,
    busy: true,
    unavailable: true,
  };
}

function staticEligibilityByMessageId(store: any, conversation: any, messages: any[]) {
  const boundary = getConversationDigestCoverage([], conversation).boundary;
  const boundaryMessage = boundary.messageId && typeof store.getMessage === 'function'
    ? store.getMessage(boundary.messageId)
    : null;
  const crossReferencedMessageIds = new Set(
    typeof store.listCrossConversationMessageReferenceIds === 'function'
      ? store.listCrossConversationMessageReferenceIds(messages.map((message: any) => message.id))
      : []
  );
  const eligibility = new Map<string, any>();

  for (const message of messages) {
    const messageId = String(message && message.id || '').trim();
    let reasonCode = '';

    if (!messageId) {
      continue;
    }

    if (hasCrossConversationMetadata(message) || crossReferencedMessageIds.has(messageId)) {
      reasonCode = 'message_cross_conversation';
    } else if (isConversationMessageCoveredByLatestDigest(message, conversation, boundaryMessage)) {
      reasonCode = 'message_summarized';
    } else if (message.role !== 'user' && message.role !== 'assistant') {
      reasonCode = 'message_role_not_deletable';
    } else if (
      message.role === 'assistant'
      && message.status !== 'completed'
      && message.status !== 'failed'
    ) {
      reasonCode = 'message_status_not_deletable';
    }

    eligibility.set(messageId, {
      eligible: !reasonCode,
      reasonCode,
      reason: reasonCode ? REASON_MESSAGES[reasonCode] : '',
    });
  }

  return eligibility;
}

export function createConversationMessageDeletionService(options: any = {}) {
  const store = options.store;
  const turnOrchestrator = options.turnOrchestrator;
  const mutationCoordinator = options.mutationCoordinator;
  const uploadService = options.uploadService;
  const digestOptions = options.digestOptions || {};
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};

  function requireConversation(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();
    const conversation = typeof store.getConversationWithoutMessages === 'function'
      ? store.getConversationWithoutMessages(normalizedConversationId)
      : store.getConversation(normalizedConversationId);
    if (!conversation) {
      throw createHttpError(404, 'Conversation not found', { code: 'conversation_not_found' });
    }
    return conversation;
  }

  function mutationState(conversationId: string) {
    return mutationCoordinator && typeof mutationCoordinator.describe === 'function'
      ? mutationCoordinator.describe(conversationId)
      : { active: true, activeKind: '', digestScheduled: false };
  }

  function projectMessages(conversationId: any, messages: any[]) {
    const conversation = requireConversation(conversationId);
    const safeMessages = Array.isArray(messages) ? messages : [];
    const eligibility = staticEligibilityByMessageId(store, conversation, safeMessages);
    const runtime = runtimeMutationState(turnOrchestrator, conversation.id);
    const mutation = mutationState(conversation.id);
    const blockedReasonCode = mutation.digestScheduled
      ? 'conversation_digest_scheduled'
      : mutation.active
        ? 'conversation_digest_running'
        : runtime.busy
          ? 'conversation_message_delete_busy'
          : '';

    return {
      deletionState: {
        available: !blockedReasonCode,
        blockedReasonCode,
        runtime,
      },
      items: safeMessages.map((message: any) => ({
        ...message,
        deletionEligibility: eligibility.get(String(message && message.id || '').trim()) || {
          eligible: false,
          reasonCode: 'message_not_found',
          reason: REASON_MESSAGES.message_not_found,
        },
      })),
    };
  }

  function rejectBusy(runtime: any) {
    throw createHttpError(409, '当前会话正在处理或仍有待处理消息，结束后才能删除历史消息', {
      code: 'conversation_message_delete_busy',
      issues: [{
        code: 'conversation_message_delete_busy',
        message: 'Conversation has active or queued work',
        active: Boolean(runtime.active),
        dispatching: Boolean(runtime.dispatching),
        activeTurnCount: Number(runtime.activeTurnCount || 0),
        activeAgentSlotCount: Number(runtime.activeAgentSlotCount || 0),
        queuedUserCount: Number(runtime.queuedUserCount || 0),
        queuedAgentSlotCount: Number(runtime.queuedAgentSlotCount || 0),
      }],
    });
  }

  function deleteMessages(conversationId: any, input: any = {}) {
    const normalizedConversationId = String(conversationId || '').trim();
    const requestedMessageIds = normalizeMessageIds(input.messageIds);
    const uniqueMessageIds = Array.from(new Set(requestedMessageIds));

    if (
      requestedMessageIds.length === 0
      || requestedMessageIds.length > MAX_CONVERSATION_MESSAGE_DELETE_BATCH_SIZE
      || requestedMessageIds.length !== uniqueMessageIds.length
    ) {
      throw createHttpError(
        400,
        `messageIds must contain between 1 and ${MAX_CONVERSATION_MESSAGE_DELETE_BATCH_SIZE} unique message ids`,
        {
          code: 'conversation_message_delete_invalid_request',
        }
      );
    }

    const beforeMutation = mutationState(normalizedConversationId);
    if (beforeMutation.digestScheduled) {
      throw createHttpError(409, '会话摘要已排队，请等待摘要完成后再删除消息', {
        code: 'conversation_digest_scheduled',
      });
    }
    if (beforeMutation.active) {
      throw createHttpError(409, '会话摘要或其它历史修改正在运行，请稍后重试', {
        code: 'conversation_digest_running',
      });
    }

    const lease = mutationCoordinator && typeof mutationCoordinator.tryAcquire === 'function'
      ? mutationCoordinator.tryAcquire(normalizedConversationId, 'message_delete')
      : { acquired: true, release() {} };
    if (!lease.acquired) {
      throw createHttpError(409, '会话摘要或其它历史修改正在运行，请稍后重试', {
        code: 'conversation_digest_running',
      });
    }

    try {
      const runtime = runtimeMutationState(turnOrchestrator, normalizedConversationId);
      if (runtime.busy) {
        rejectBusy(runtime);
      }

      const conversation = requireConversation(normalizedConversationId);
      const allMessages = typeof store.listMessages === 'function'
        ? store.listMessages(normalizedConversationId)
        : Array.isArray(conversation.messages)
          ? conversation.messages
          : [];
      const messagesById = new Map(
        allMessages.map((message: any) => [String(message && message.id || '').trim(), message])
      );
      const selectedMessages = uniqueMessageIds.map((messageId) => messagesById.get(messageId)).filter(Boolean);
      const eligibility = staticEligibilityByMessageId(store, conversation, selectedMessages);
      const issues = uniqueMessageIds.flatMap((messageId) => {
        const message = messagesById.get(messageId);
        if (!message) {
          return [{ messageId, code: 'message_not_found', message: REASON_MESSAGES.message_not_found }];
        }
        const item = eligibility.get(messageId);
        return item && !item.eligible
          ? [{ messageId, code: item.reasonCode, message: item.reason }]
          : [];
      });

      if (issues.length > 0) {
        throw createHttpError(409, '所选消息中包含不可删除项，未删除任何消息', {
          code: 'conversation_message_delete_rejected',
          issues,
        });
      }

      const deletion = store.deleteConversationMessages(normalizedConversationId, uniqueMessageIds);
      const digestState = recomputeConversationDigestState(store, normalizedConversationId, digestOptions);
      const attachmentBatchIds = Array.isArray(deletion.attachmentBatchIds) ? deletion.attachmentBatchIds : [];
      let cleanupWarning = null;

      if (
        attachmentBatchIds.length > 0
        && uploadService
        && typeof uploadService.removeBatchDirectories === 'function'
      ) {
        try {
          const removedCount = Number(uploadService.removeBatchDirectories(attachmentBatchIds) || 0);
          if (removedCount < attachmentBatchIds.length) {
            cleanupWarning = {
              code: 'attachment_cleanup_incomplete',
              batchIds: attachmentBatchIds,
            };
          }
        } catch (error) {
          cleanupWarning = {
            code: 'attachment_cleanup_incomplete',
            batchIds: attachmentBatchIds,
          };
        }

        if (cleanupWarning) {
          console.warn(
            `[conversation-message-delete] Attachment cleanup incomplete for ${normalizedConversationId}: ${attachmentBatchIds.join(', ')}`
          );
        }
      }

      const latestConversation = digestState.conversation || store.getConversation(normalizedConversationId);
      const summary = pickConversationSummary(latestConversation);
      broadcastEvent('conversation_messages_deleted', {
        conversationId: normalizedConversationId,
        deletedMessageIds: deletion.deletedMessageIds,
      });
      broadcastEvent('conversation_summary_updated', {
        conversationId: normalizedConversationId,
        summary,
      });
      if (digestState.stateChanged) {
        broadcastEvent('conversation_digest_updated', {
          conversationId: normalizedConversationId,
          digest: null,
          stateChanged: true,
          pendingMessageCount: digestState.sourceMessages.length,
          conversation: latestConversation,
          summary,
        });
      }

      return {
        conversationId: normalizedConversationId,
        deletedMessageIds: deletion.deletedMessageIds,
        attachmentCleanup: {
          requestedBatchCount: attachmentBatchIds.length,
          warning: cleanupWarning,
        },
      };
    } finally {
      lease.release();
    }
  }

  return {
    deleteMessages,
    projectMessages,
  };
}
