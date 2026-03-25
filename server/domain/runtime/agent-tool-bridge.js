const { randomUUID } = require('node:crypto');
const { createHttpError } = require('../../http/http-errors');
const { pickConversationSummary, serializeConversationPrivateMessageForUi } = require('../conversation/conversation-view');
const { buildAgentMentionLookup, formatAgentMention, resolveMentionValues } = require('../conversation/mention-routing');

const MAX_HISTORY_MESSAGES = 24;
const MAX_PRIVATE_CONTEXT_MESSAGES = 16;
const TURN_PREVIEW_LENGTH = 180;

function nowIso() {
  return new Date().toISOString();
}

function clipText(text, maxLength = 240) {
  const value = String(text || '').trim();

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function normalizePromptUserMessageSnapshot(message, fallback = {}) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  return {
    id: String(message.id || fallback.userMessageId || '').trim(),
    turnId: String(message.turnId || fallback.turnId || '').trim(),
    role: String(message.role || 'user').trim() || 'user',
    agentId: message.agentId || null,
    senderName: String(message.senderName || fallback.senderName || 'You').trim() || 'You',
    content: String(message.content || ''),
    status: String(message.status || 'completed').trim() || 'completed',
    createdAt: String(message.createdAt || fallback.createdAt || '').trim() || nowIso(),
  };
}

function createAgentToolBridge(options = {}) {
  const store = options.store;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const broadcastConversationSummary =
    typeof options.broadcastConversationSummary === 'function' ? options.broadcastConversationSummary : () => {};
  const onTurnUpdated = typeof options.onTurnUpdated === 'function' ? options.onTurnUpdated : () => {};
  const activeInvocations = new Map();

  function createInvocationContext(input = {}) {
    const invocationId = String(input.invocationId || randomUUID()).trim();
    const callbackToken = String(input.callbackToken || randomUUID()).trim();
    const promptUserMessage = normalizePromptUserMessageSnapshot(input.promptUserMessage, {
      userMessageId: input.userMessageId,
      turnId: input.turnId,
      createdAt: input.createdAt,
    });

    return {
      invocationId,
      callbackToken,
      conversationId: String(input.conversationId || '').trim(),
      turnId: String(input.turnId || '').trim(),
      agentId: String(input.agentId || '').trim(),
      agentName: String(input.agentName || '').trim() || 'Assistant',
      assistantMessageId: String(input.assistantMessageId || '').trim(),
      userMessageId: String(input.userMessageId || (promptUserMessage && promptUserMessage.id) || '').trim(),
      promptUserMessage,
      conversationAgents: Array.isArray(input.conversationAgents) ? input.conversationAgents.slice() : [],
      stage: input.stage || null,
      turnState: input.turnState || null,
      enqueueAgent: typeof input.enqueueAgent === 'function' ? input.enqueueAgent : null,
      allowHandoffs: input.allowHandoffs !== false,
      publicToolUsed: false,
      publicPostCount: 0,
      privatePostCount: 0,
      privateHandoffCount: 0,
      lastPublicContent: '',
      lastPublicPostedAt: '',
      closedAt: '',
      createdAt: nowIso(),
    };
  }

  function registerInvocation(context) {
    if (!context || !context.invocationId) {
      return null;
    }

    activeInvocations.set(context.invocationId, context);
    return context;
  }

  function getInvocation(invocationId, callbackToken) {
    const normalizedInvocationId = String(invocationId || '').trim();
    const normalizedCallbackToken = String(callbackToken || '').trim();
    const context = activeInvocations.get(normalizedInvocationId);
    const stageStatus = String(context && context.stage && context.stage.status ? context.stage.status : '')
      .trim()
      .toLowerCase();

    if (!context || !normalizedCallbackToken || context.callbackToken !== normalizedCallbackToken) {
      throw createHttpError(401, 'Invalid or expired agent tool credentials');
    }

    if (
      context.closedAt ||
      (context.turnState && context.turnState.stopRequested) ||
      (stageStatus && stageStatus !== 'queued' && stageStatus !== 'running')
    ) {
      activeInvocations.delete(normalizedInvocationId);
      throw createHttpError(409, 'This agent tool invocation is no longer active');
    }

    return context;
  }

  function unregisterInvocation(invocationId) {
    const normalizedInvocationId = String(invocationId || '').trim();

    if (!normalizedInvocationId) {
      return null;
    }

    const context = activeInvocations.get(normalizedInvocationId) || null;

    if (context) {
      context.closedAt = nowIso();
    }

    activeInvocations.delete(normalizedInvocationId);
    return context;
  }

  function serializeAgentToolPublicMessage(message) {
    const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    const toolBridgeMetadata =
      metadata && metadata.toolBridge && typeof metadata.toolBridge === 'object' ? metadata.toolBridge : null;
    return {
      id: message.id,
      role: message.role,
      agentId: message.agentId || null,
      senderName: message.senderName,
      content: message.content,
      status: message.status,
      createdAt: message.createdAt,
      publicPostedAt: toolBridgeMetadata && toolBridgeMetadata.lastPublicPostedAt ? toolBridgeMetadata.lastPublicPostedAt : '',
      publicPostCount: toolBridgeMetadata && Number.isInteger(toolBridgeMetadata.publicPostCount) ? toolBridgeMetadata.publicPostCount : 0,
      publicPostMode: toolBridgeMetadata && toolBridgeMetadata.lastPublicMode ? toolBridgeMetadata.lastPublicMode : '',
      mentions: metadata && Array.isArray(metadata.mentions) ? metadata.mentions : [],
    };
  }

  function serializeAgentToolPrivateMessage(message) {
    return {
      id: message.id,
      turnId: message.turnId,
      senderAgentId: message.senderAgentId || null,
      senderName: message.senderName,
      recipientAgentIds: Array.isArray(message.recipientAgentIds) ? message.recipientAgentIds : [],
      content: message.content,
      createdAt: message.createdAt,
    };
  }

  function serializeAgentToolParticipants(agents) {
    return (Array.isArray(agents) ? agents : []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description || '',
      mention: formatAgentMention(agent),
    }));
  }

  function resolveContextUserMessage(context, conversation) {
    const snapshot = context && context.promptUserMessage ? normalizePromptUserMessageSnapshot(context.promptUserMessage) : null;
    const messages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
    const targetUserMessageId = String(context && context.userMessageId ? context.userMessageId : '').trim();
    const matchedConversationMessage =
      messages.find((message) => message && message.id === targetUserMessageId && message.role === 'user') ||
      [...messages].reverse().find((message) => message && message.role === 'user') ||
      null;

    if (!snapshot && !matchedConversationMessage) {
      return null;
    }

    const base = matchedConversationMessage || snapshot;
    return {
      ...(matchedConversationMessage || {}),
      ...(snapshot || {}),
      id: String(
        (snapshot && snapshot.id) || (matchedConversationMessage && matchedConversationMessage.id) || targetUserMessageId || ''
      ).trim(),
      turnId: String(
        (snapshot && snapshot.turnId) || (matchedConversationMessage && matchedConversationMessage.turnId) || context.turnId || ''
      ).trim(),
      role: 'user',
      agentId:
        (matchedConversationMessage && matchedConversationMessage.agentId) || (snapshot && snapshot.agentId) || null,
      senderName: String(
        (snapshot && snapshot.senderName) || (matchedConversationMessage && matchedConversationMessage.senderName) || 'You'
      ).trim() || 'You',
      content: String(
        snapshot && snapshot.content !== undefined
          ? snapshot.content
          : matchedConversationMessage && matchedConversationMessage.content !== undefined
            ? matchedConversationMessage.content
            : ''
      ),
      status: String(
        (snapshot && snapshot.status) || (matchedConversationMessage && matchedConversationMessage.status) || 'completed'
      ).trim() || 'completed',
      createdAt: String(
        (snapshot && snapshot.createdAt) || (matchedConversationMessage && matchedConversationMessage.createdAt) || nowIso()
      ).trim() || nowIso(),
      metadata:
        matchedConversationMessage && matchedConversationMessage.metadata && typeof matchedConversationMessage.metadata === 'object'
          ? matchedConversationMessage.metadata
          : null,
    };
  }

  function applyContextUserMessageSnapshot(message, contextUserMessage) {
    if (!message || !contextUserMessage || message.id !== contextUserMessage.id) {
      return message;
    }

    return {
      ...message,
      content: contextUserMessage.content,
      senderName: contextUserMessage.senderName,
      status: contextUserMessage.status,
      createdAt: contextUserMessage.createdAt,
    };
  }

  function buildAgentToolContextPayload(context, options = {}) {
    const publicLimit = Number.isInteger(options.publicLimit) && options.publicLimit > 0 ? options.publicLimit : MAX_HISTORY_MESSAGES;
    const privateLimit =
      Number.isInteger(options.privateLimit) && options.privateLimit > 0 ? options.privateLimit : MAX_PRIVATE_CONTEXT_MESSAGES;
    const conversation = store.getConversation(context.conversationId);
    const contextUserMessage = resolveContextUserMessage(context, conversation);
    const publicMessageSource = conversation
      ? conversation.messages.filter((message) => {
          return !(
            message.id === context.assistantMessageId &&
            message.status !== 'completed' &&
            String(message.content || '').trim() === 'Thinking...'
          );
        })
      : [];
    let selectedPublicMessages = publicMessageSource
      .slice(-publicLimit)
      .map((message) => applyContextUserMessageSnapshot(message, contextUserMessage));

    if (
      contextUserMessage &&
      !selectedPublicMessages.some((message) => message && message.id === contextUserMessage.id)
    ) {
      selectedPublicMessages = [contextUserMessage, ...selectedPublicMessages];
    }

    const publicMessages = selectedPublicMessages.map(serializeAgentToolPublicMessage);
    const privateMessages = store
      .listPrivateMessagesForAgent(context.conversationId, context.agentId, { limit: privateLimit })
      .map(serializeAgentToolPrivateMessage);

    return {
      conversation: conversation ? pickConversationSummary(conversation) : null,
      agent: {
        id: context.agentId,
        name: context.agentName,
      },
      participants: conversation ? serializeAgentToolParticipants(conversation.agents) : [],
      latestUserMessage: contextUserMessage ? serializeAgentToolPublicMessage(contextUserMessage) : null,
      publicMessages,
      privateMessages,
    };
  }

  function normalizeAgentToolRecipientValues(value) {
    if (Array.isArray(value)) {
      return value.flatMap((item) => normalizeAgentToolRecipientValues(item));
    }

    if (typeof value === 'string') {
      return value
        .split(/[,\n\r;，；]+/u)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return [];
  }

  function resolveAgentToolRecipientIds(recipientValues, agents) {
    const lookup = buildAgentMentionLookup(agents);
    return resolveMentionValues(normalizeAgentToolRecipientValues(recipientValues), agents, { lookup });
  }

  function applyAgentToolPublicUpdate(context, content, mode = 'replace') {
    const existingMessage = store.getMessage(context.assistantMessageId);

    if (!existingMessage) {
      throw createHttpError(404, 'Active assistant message not found');
    }

    const timestamp = nowIso();
    const normalizedMode = String(mode || 'replace').trim().toLowerCase();
    const currentContent = String(existingMessage.content || '');
    const nextContent =
      normalizedMode === 'append' && currentContent && currentContent !== 'Thinking...' ? `${currentContent}${content}` : content;
    const existingMetadata = existingMessage.metadata && typeof existingMessage.metadata === 'object' ? existingMessage.metadata : {};
    const nextMetadata = {
      ...existingMetadata,
      toolBridge: {
        ...(existingMetadata.toolBridge && typeof existingMetadata.toolBridge === 'object' ? existingMetadata.toolBridge : {}),
        enabled: true,
        publicPosted: true,
        publicPostCount: (context.publicPostCount || 0) + 1,
        lastPublicPostedAt: timestamp,
        lastPublicMode: normalizedMode,
      },
    };
    const updatedMessage = store.updateMessage(context.assistantMessageId, {
      content: nextContent,
      metadata: nextMetadata,
    });

    context.publicToolUsed = true;
    context.publicPostCount = (context.publicPostCount || 0) + 1;
    context.lastPublicContent = nextContent;
    context.lastPublicPostedAt = timestamp;

    if (context.stage) {
      context.stage.status = 'running';
      context.stage.replyLength = nextContent.length;
      context.stage.preview = clipText(nextContent, TURN_PREVIEW_LENGTH);
      context.stage.lastTextDeltaAt = timestamp;
    }

    if (context.turnState) {
      context.turnState.updatedAt = timestamp;
      onTurnUpdated(context.turnState);
    }

    broadcastEvent('conversation_message_updated', { conversationId: context.conversationId, message: updatedMessage });
    broadcastConversationSummary(context.conversationId);

    return updatedMessage;
  }

  function handlePostMessage(body = {}) {
    const context = getInvocation(body.invocationId, body.callbackToken);
    const content = String(body.content || '').trim();

    if (!content) {
      throw createHttpError(400, 'Message content is required');
    }

    const visibility = String(body.visibility || 'public').trim().toLowerCase();

    if (visibility === 'public') {
      const message = applyAgentToolPublicUpdate(context, content, body.mode);
      return {
        ok: true,
        visibility: 'public',
        message: serializeAgentToolPublicMessage(message),
      };
    }

    if (visibility === 'private') {
      const conversation = store.getConversation(context.conversationId);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      const recipientAgentIds = resolveAgentToolRecipientIds(
        body.recipientAgentIds !== undefined ? body.recipientAgentIds : body.recipients,
        conversation.agents
      );
      const resolvedRecipientAgentIds = recipientAgentIds.length > 0 ? recipientAgentIds : [context.agentId];
      const handoffAgentIds = resolvedRecipientAgentIds.filter((agentId) => agentId && agentId !== context.agentId);
      const explicitHandoff = body.handoff === true || body.triggerReply === true;
      const explicitNoHandoff = body.handoff === false || body.triggerReply === false || body.noHandoff === true;
      const handoffRequested = !explicitNoHandoff && (explicitHandoff || handoffAgentIds.length > 0);

      if (handoffRequested && !context.allowHandoffs) {
        throw createHttpError(409, 'Private handoff is not available in this turn mode');
      }

      if (handoffRequested && typeof context.enqueueAgent !== 'function') {
        throw createHttpError(409, 'Private handoff is not available for this run');
      }

      if (handoffRequested && handoffAgentIds.length === 0) {
        throw createHttpError(400, 'Private handoff requires at least one recipient other than yourself');
      }

      const privateMessage = store.createPrivateMessage({
        conversationId: context.conversationId,
        turnId: context.turnId,
        senderAgentId: context.agentId,
        senderName: context.agentName,
        recipientAgentIds: resolvedRecipientAgentIds,
        content,
        metadata: {
          source: 'agent-tool',
          handoffRequested,
        },
      });

      context.privatePostCount = (context.privatePostCount || 0) + 1;
      let enqueuedAgentIds = [];

      if (handoffRequested) {
        enqueuedAgentIds = context.enqueueAgent({
          agentIds: handoffAgentIds,
          triggerType: 'private',
          triggeredByAgentId: context.agentId,
          triggeredByAgentName: context.agentName,
          triggeredByMessageId: privateMessage.id,
          parentRunId: context.stage && context.stage.runId ? context.stage.runId : null,
          enqueueReason: 'private_message',
        });
        context.privateHandoffCount = (context.privateHandoffCount || 0) + enqueuedAgentIds.length;

        if (context.turnState) {
          context.turnState.updatedAt = nowIso();
          onTurnUpdated(context.turnState);
        }
      }

      broadcastEvent('conversation_private_message_created', {
        conversationId: context.conversationId,
        message: serializeConversationPrivateMessageForUi(privateMessage, conversation.agents),
      });

      return {
        ok: true,
        visibility: 'private',
        message: serializeAgentToolPrivateMessage(privateMessage),
        handoffRequested,
        enqueuedAgentIds,
      };
    }

    throw createHttpError(400, 'Unsupported visibility. Use public or private.');
  }

  function handleReadContext(requestUrl) {
    const context = getInvocation(
      requestUrl.searchParams.get('invocationId'),
      requestUrl.searchParams.get('callbackToken')
    );
    const publicLimit = Number.parseInt(requestUrl.searchParams.get('publicLimit') || '', 10);
    const privateLimit = Number.parseInt(requestUrl.searchParams.get('privateLimit') || '', 10);

    return {
      ok: true,
      ...buildAgentToolContextPayload(context, {
        publicLimit: Number.isFinite(publicLimit) ? publicLimit : undefined,
        privateLimit: Number.isFinite(privateLimit) ? privateLimit : undefined,
      }),
    };
  }

  function handleListParticipants(requestUrl) {
    const context = getInvocation(
      requestUrl.searchParams.get('invocationId'),
      requestUrl.searchParams.get('callbackToken')
    );
    const conversation = store.getConversation(context.conversationId);

    return {
      ok: true,
      conversation: conversation ? pickConversationSummary(conversation) : null,
      participants: conversation ? serializeAgentToolParticipants(conversation.agents) : [],
    };
  }

  return {
    createInvocationContext,
    handleListParticipants,
    handlePostMessage,
    handleReadContext,
    registerInvocation,
    unregisterInvocation,
  };
}

module.exports = {
  createAgentToolBridge,
};
