const { createHttpError } = require('../../../http/http-errors');

const FEISHU_PLATFORM = 'feishu';
const FEISHU_LEGACY_CODING_MODE_ID = 'coding';
const FEISHU_FALLBACK_CONVERSATION_TYPE = 'standard';
const FEISHU_NEW_CONVERSATION_COMMAND = '/new';

function nowIso() {
  return new Date().toISOString();
}

function trimString(value: any) {
  return String(value || '').trim();
}

function asObject(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeParseJson(value: any) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  const raw = trimString(value);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeTextAfterMentionRemoval(value: any) {
  return String(value || '')
    .split(/\r?\n/u)
    .map((line) => line.replace(/[ \t]{2,}/gu, ' ').trim())
    .filter((line, index, lines) => line || index === 0 || index === lines.length - 1)
    .join('\n')
    .trim();
}

function stripMentionKeys(text: any, mentions: any[]) {
  let cleaned = String(text || '');

  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const key = trimString(mention && mention.key);

    if (!key) {
      continue;
    }

    cleaned = cleaned.replace(new RegExp(escapeRegExp(key), 'gu'), ' ');
  }

  return normalizeTextAfterMentionRemoval(cleaned);
}

function extractVerificationToken(payload: any) {
  const header = asObject(payload && payload.header);
  return trimString(header.token || payload.token);
}

function isChallengePayload(payload: any) {
  return trimString(payload && payload.type).toLowerCase() === 'url_verification' && trimString(payload && payload.challenge);
}

function extractMessage(payload: any) {
  return asObject(asObject(payload && payload.event).message || (payload && payload.message));
}

function extractSender(payload: any) {
  return asObject(asObject(payload && payload.event).sender || (payload && payload.sender));
}

function extractSenderOpenId(payload: any) {
  const sender = extractSender(payload);
  const senderId = asObject(sender.sender_id);

  return trimString(senderId.open_id || sender.open_id || senderId.user_id || sender.user_id);
}

function extractSenderName(payload: any, senderOpenId: string) {
  const sender = extractSender(payload);
  return trimString(sender.name || sender.display_name || sender.sender_name) || `FeishuUser:${senderOpenId || 'unknown'}`;
}

function extractMentions(contentPayload: any) {
  return Array.isArray(contentPayload && contentPayload.mentions)
    ? contentPayload.mentions.filter((mention: any) => mention && typeof mention === 'object')
    : [];
}

function mergeMentions(...mentionGroups: any[][]) {
  const seen = new Set();
  const mentions = [] as any[];

  for (const mentionGroup of mentionGroups) {
    for (const mention of Array.isArray(mentionGroup) ? mentionGroup : []) {
      const key = `${trimString(mention && mention.key)}:${extractMentionOpenId(mention)}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      mentions.push(mention);
    }
  }

  return mentions;
}

function extractMentionOpenId(mention: any) {
  const mentionId = asObject(mention && mention.id);
  return trimString(mentionId.open_id || mention.open_id || mentionId.user_id || mention.user_id);
}

function isAtAllMention(mention: any) {
  const key = trimString(mention && mention.key).toLowerCase();
  const name = trimString(mention && mention.name).toLowerCase();
  return key === '@_all' || key === '@all' || name === 'all' || name === 'everyone' || name === '所有人';
}

function buildConversationTitle(chatType: string, chatId: string) {
  const suffix = chatId ? chatId.slice(-8) : 'unknown';
  return chatType === 'p2p' ? `Feishu 私聊 ${suffix}` : `Feishu 群聊 ${suffix}`;
}

function isNewConversationCommand(text: any) {
  return trimString(text) === FEISHU_NEW_CONVERSATION_COMMAND;
}

function resolveAssistantSpeakerName(message: any, store: any) {
  const senderName = trimString(message && message.senderName);
  const agentId = trimString(message && message.agentId);
  const agent = agentId && store && typeof store.getAgent === 'function' ? store.getAgent(agentId) : null;
  const agentName = trimString(agent && agent.name);

  if (senderName && senderName.toLowerCase() !== 'assistant') {
    return senderName;
  }

  return agentName || senderName || agentId || 'assistant';
}

function formatAssistantOutboundText(message: any, store: any) {
  const content = trimString(message && message.content);
  const speakerName = resolveAssistantSpeakerName(message, store);
  return {
    speakerName,
    text: `【${speakerName}】${content}`,
  };
}

function buildIgnoreResponse(reason: string, extra: any = {}) {
  return {
    statusCode: 200,
    payload: {
      ok: true,
      ignored: reason,
      ...extra,
    },
  };
}

function normalizeMentionMetadata(mentions: any[]) {
  return (Array.isArray(mentions) ? mentions : []).map((mention) => ({
    key: trimString(mention && mention.key),
    name: trimString(mention && mention.name),
    openId: extractMentionOpenId(mention),
    atAll: isAtAllMention(mention),
  }));
}

function getErrorMessage(error: any) {
  return error && error.message ? error.message : String(error || 'Unknown error');
}

export function createFeishuIntegrationService(options: any = {}) {
  const store = options.store;
  const turnOrchestrator = options.turnOrchestrator;
  const client = options.client;
  const modeStore = options.modeStore;
  const verificationToken = trimString(options.verificationToken || process.env.FEISHU_VERIFICATION_TOKEN);
  const logger = options.logger || console;

  function logInfo(message: string, payload: any = null) {
    if (logger && typeof logger.log === 'function') {
      logger.log(`[feishu] ${message}`, payload || '');
    }
  }

  function logWarn(message: string, payload: any = null) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[feishu] ${message}`, payload || '');
      return;
    }

    logInfo(message, payload);
  }

  async function initialize() {
    if (!client || typeof client.initialize !== 'function') {
      return '';
    }

    try {
      return await client.initialize();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logWarn('Failed to warm bot identity on startup', { error: errorMessage });
      return '';
    }
  }

  function markInboundEventFailed(reservedEvent: any, updates: any = {}) {
    if (!reservedEvent || !reservedEvent.id) {
      return null;
    }

    const nextMetadata = {
      ...(reservedEvent.metadata && typeof reservedEvent.metadata === 'object' ? reservedEvent.metadata : {}),
      ...(updates.metadata && typeof updates.metadata === 'object' ? updates.metadata : {}),
      failedAt: nowIso(),
      status: 'failed',
    };

    return store.updateExternalEvent(reservedEvent.id, {
      conversationId: updates.conversationId === undefined ? reservedEvent.conversationId : updates.conversationId,
      messageId: updates.messageId === undefined ? reservedEvent.messageId : updates.messageId,
      metadata: nextMetadata,
    });
  }

  async function parseInboundMessage(payload: any) {
    const header = asObject(payload && payload.header);
    const eventType = trimString(header.event_type || payload.event_type || payload.type);

    if (eventType !== 'im.message.receive_v1') {
      return { action: 'ignore', reason: 'unsupported_event_type' };
    }

    const message = extractMessage(payload);
    const messageId = trimString(message.message_id);
    const chatId = trimString(message.chat_id);
    const chatType = trimString(message.chat_type).toLowerCase() || 'unknown';
    const messageType = trimString(message.message_type).toLowerCase();
    const sender = extractSender(payload);
    const senderType = trimString(sender.sender_type).toLowerCase();
    const senderOpenId = extractSenderOpenId(payload);
    const eventId = trimString(header.event_id || payload.event_id);

    if (!chatId || !messageId) {
      return { action: 'ignore', reason: 'invalid_payload' };
    }

    if (messageType !== 'text') {
      return { action: 'ignore', reason: 'unsupported_message_type' };
    }

    const contentPayload = safeParseJson(message.content);
    const rawText = trimString(contentPayload.text);
    const mentions = mergeMentions(extractMentions(contentPayload), extractMentions(message));
    const botOpenId = client && typeof client.ensureBotOpenId === 'function' ? trimString(await client.ensureBotOpenId()) : '';

    if (senderType === 'app' || senderType === 'bot' || (botOpenId && senderOpenId && senderOpenId === botOpenId)) {
      return { action: 'ignore', reason: 'self_message' };
    }

    if (!rawText) {
      return { action: 'ignore', reason: 'empty_text' };
    }

    return {
      action: 'accept',
      chatId,
      chatType,
      cleanedText: rawText,
      eventId,
      eventType,
      mentions,
      messageId,
      rawText,
      senderName: extractSenderName(payload, senderOpenId),
      senderOpenId,
      senderType,
    };
  }

  function resolveFeishuConversationMode() {
    if (modeStore && typeof modeStore.resolveCodingMode === 'function') {
      const resolvedMode = modeStore.resolveCodingMode();

      if (resolvedMode && resolvedMode.id) {
        return resolvedMode;
      }
    }

    if (modeStore && typeof modeStore.get === 'function') {
      const legacyMode = modeStore.get(FEISHU_LEGACY_CODING_MODE_ID);

      if (legacyMode && legacyMode.id && Array.isArray(legacyMode.skillIds) && legacyMode.skillIds.length > 0) {
        return legacyMode;
      }
    }

    return {
      id: FEISHU_FALLBACK_CONVERSATION_TYPE,
      skillIds: [],
    };
  }

  function buildFeishuConversationInput(acceptedInbound: any) {
    const mode = resolveFeishuConversationMode();

    return {
      title: buildConversationTitle(String(acceptedInbound.chatType || ''), String(acceptedInbound.chatId || '')),
      type: trimString(mode && mode.id) || FEISHU_FALLBACK_CONVERSATION_TYPE,
      defaultConversationSkillIds: Array.isArray(mode && mode.skillIds) ? mode.skillIds : [],
      metadata: {
        source: FEISHU_PLATFORM,
        feishu: {
          chatId: acceptedInbound.chatId,
          chatType: acceptedInbound.chatType,
        },
      },
    };
  }

  function bindNewConversationToFeishuChat(acceptedInbound: any, bindingMetadata: any = {}) {
    const conversation = store.createConversation(buildFeishuConversationInput(acceptedInbound));
    const metadata = {
      chatType: acceptedInbound.chatType,
      ...bindingMetadata,
    };
    const existingBinding = store.getConversationChannelBinding(FEISHU_PLATFORM, acceptedInbound.chatId);
    const binding = existingBinding
      ? store.updateConversationChannelBinding({
          platform: FEISHU_PLATFORM,
          externalChatId: acceptedInbound.chatId,
          conversationId: conversation.id,
          metadata,
        })
      : store.createConversationChannelBinding({
          platform: FEISHU_PLATFORM,
          externalChatId: acceptedInbound.chatId,
          conversationId: conversation.id,
          metadata,
        });

    return {
      binding,
      conversation,
    };
  }

  async function sendNewConversationConfirmation(chatId: string) {
    if (!client || typeof client.sendTextMessage !== 'function') {
      return {
        sent: false,
        reason: 'client_unavailable',
      };
    }

    const result = await client.sendTextMessage(chatId, '已新建并切换到新的会话。');
    return {
      sent: true,
      externalMessageId: result && result.messageId ? result.messageId : null,
      payload: result && result.payload ? result.payload : null,
    };
  }

  async function handleNewConversationCommand(acceptedInbound: any, reservedEvent: any) {
    try {
      const ensured = bindNewConversationToFeishuChat(acceptedInbound, {
        command: FEISHU_NEW_CONVERSATION_COMMAND,
      });
      let confirmation = null as any;

      try {
        confirmation = await sendNewConversationConfirmation(acceptedInbound.chatId);
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        confirmation = {
          sent: false,
          error: errorMessage,
          reason: 'send_failed',
        };
        logWarn('Failed to send Feishu /new confirmation', {
          chatId: acceptedInbound.chatId,
          conversationId: ensured.conversation.id,
          error: errorMessage,
        });
      }

      store.updateExternalEvent(reservedEvent.id, {
        conversationId: ensured.conversation.id,
        metadata: {
          chatId: acceptedInbound.chatId,
          chatType: acceptedInbound.chatType,
          command: FEISHU_NEW_CONVERSATION_COMMAND,
          confirmation,
          eventType: acceptedInbound.eventType,
          senderOpenId: acceptedInbound.senderOpenId || null,
          status: 'command_processed',
        },
      });

      return {
        statusCode: 200,
        payload: {
          ok: true,
          command: FEISHU_NEW_CONVERSATION_COMMAND,
          processed: true,
          conversationId: ensured.conversation.id,
        },
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      markInboundEventFailed(reservedEvent, {
        metadata: {
          chatId: acceptedInbound.chatId,
          chatType: acceptedInbound.chatType,
          command: FEISHU_NEW_CONVERSATION_COMMAND,
          error: errorMessage,
          eventType: acceptedInbound.eventType,
          senderOpenId: acceptedInbound.senderOpenId || null,
        },
      });
      logWarn('Failed to process Feishu /new command after reserving dedupe record', {
        chatId: acceptedInbound.chatId,
        error: errorMessage,
      });
      throw error;
    }
  }

  async function handleInboundEventPayload(payload: any = {}) {
    const inbound = await parseInboundMessage(payload);
    if (inbound.action !== 'accept') {
      const header = asObject(payload.header);
      const ignoreReason = String(inbound.reason || 'ignored').trim() || 'ignored';
      logInfo('Ignoring inbound Feishu event', { reason: ignoreReason, eventType: trimString(header.event_type) });
      return buildIgnoreResponse(ignoreReason);
    }

    const acceptedInbound = inbound as any;
    const reservedEvent = store.reserveExternalEvent({
      platform: FEISHU_PLATFORM,
      direction: 'inbound',
      externalEventId: acceptedInbound.eventId || null,
      externalMessageId: acceptedInbound.messageId || null,
      metadata: {
        chatId: acceptedInbound.chatId,
        chatType: acceptedInbound.chatType,
        eventType: acceptedInbound.eventType,
        senderOpenId: acceptedInbound.senderOpenId || null,
        status: 'reserved',
      },
    });

    if (!reservedEvent) {
      return {
        statusCode: 200,
        payload: {
          ok: true,
          deduped: true,
        },
      };
    }

    if (isNewConversationCommand(acceptedInbound.rawText || acceptedInbound.cleanedText)) {
      return handleNewConversationCommand(acceptedInbound, reservedEvent);
    }

    let ensured = null as any;

    try {
      ensured = store.getOrCreateExternalConversation({
        platform: FEISHU_PLATFORM,
        externalChatId: acceptedInbound.chatId,
        ...buildFeishuConversationInput(acceptedInbound),
        bindingMetadata: {
          chatType: acceptedInbound.chatType,
        },
      });

      const submission = turnOrchestrator.submitConversationMessage(ensured.conversation.id, {
        content: acceptedInbound.cleanedText,
        senderName: acceptedInbound.senderName,
        metadata: {
          source: FEISHU_PLATFORM,
          feishu: {
            eventId: acceptedInbound.eventId || null,
            messageId: acceptedInbound.messageId,
            chatId: acceptedInbound.chatId,
            chatType: acceptedInbound.chatType,
            mentions: normalizeMentionMetadata(acceptedInbound.mentions),
            senderOpenId: acceptedInbound.senderOpenId || null,
            senderType: acceptedInbound.senderType || '',
          },
        },
      });

      store.updateExternalEvent(reservedEvent.id, {
        conversationId: ensured.conversation.id,
        messageId: submission && submission.acceptedMessage ? submission.acceptedMessage.id : null,
        metadata: {
          chatId: acceptedInbound.chatId,
          chatType: acceptedInbound.chatType,
          eventType: acceptedInbound.eventType,
          senderOpenId: acceptedInbound.senderOpenId || null,
          status: 'processed',
          acceptedMessageId: submission && submission.acceptedMessage ? submission.acceptedMessage.id : null,
        },
      });

      return {
        statusCode: 200,
        payload: {
          ok: true,
          processed: true,
          conversationId: ensured.conversation.id,
          messageId: submission && submission.acceptedMessage ? submission.acceptedMessage.id : null,
        },
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      markInboundEventFailed(reservedEvent, {
        conversationId: ensured && ensured.conversation ? ensured.conversation.id : null,
        metadata: {
          chatId: acceptedInbound.chatId,
          chatType: acceptedInbound.chatType,
          error: errorMessage,
          eventType: acceptedInbound.eventType,
          senderOpenId: acceptedInbound.senderOpenId || null,
        },
      });
      logWarn('Failed to process inbound Feishu event after reserving dedupe record', {
        chatId: acceptedInbound.chatId,
        eventId: acceptedInbound.eventId || null,
        messageId: acceptedInbound.messageId,
        error: errorMessage,
      });
      throw error;
    }
  }

  async function handleWebhook(body: any = {}) {
    if (!verificationToken) {
      throw createHttpError(503, 'Feishu webhook is not configured');
    }

    const payload = asObject(body);
    if (payload.encrypt) {
      throw createHttpError(400, 'Encrypted Feishu events are not supported yet');
    }

    const providedToken = extractVerificationToken(payload);
    if (!providedToken || providedToken !== verificationToken) {
      throw createHttpError(401, 'Invalid Feishu verification token');
    }

    if (isChallengePayload(payload)) {
      return {
        statusCode: 200,
        payload: {
          challenge: trimString(payload.challenge),
        },
      };
    }

    return handleInboundEventPayload(payload);
  }

  async function handleLongConnectionEvent(body: any = {}) {
    const payload = asObject(body);
    if (payload.encrypt) {
      logWarn('Ignoring encrypted long connection event payload');
      return buildIgnoreResponse('encrypted_event_unsupported');
    }

    return handleInboundEventPayload(payload);
  }

  async function deliverAssistantMessage(message: any) {
    const normalizedRole = trimString(message && message.role).toLowerCase();
    const normalizedStatus = trimString(message && message.status).toLowerCase();
    const content = trimString(message && message.content);

    if (normalizedRole !== 'assistant' || normalizedStatus !== 'completed') {
      return {
        delivered: false,
        reason: 'not_completed_assistant',
      };
    }

    if (!content) {
      return {
        delivered: false,
        reason: 'empty_content',
      };
    }

    const binding = store.getConversationChannelBindingByConversationId(FEISHU_PLATFORM, message.conversationId);
    if (!binding) {
      return {
        delivered: false,
        reason: 'conversation_not_bound',
      };
    }

    const outbound = formatAssistantOutboundText(message, store);

    const outboundEvent = store.reserveExternalEvent({
      platform: FEISHU_PLATFORM,
      direction: 'outbound',
      conversationId: message.conversationId,
      messageId: message.id,
      metadata: {
        externalChatId: binding.externalChatId,
        status: 'pending',
      },
    });

    if (!outboundEvent) {
      return {
        delivered: false,
        reason: 'duplicate_outbound',
      };
    }

    try {
      const result = await client.sendTextMessage(binding.externalChatId, outbound.text);
      store.updateExternalEvent(outboundEvent.id, {
        conversationId: message.conversationId,
        messageId: message.id,
        externalMessageId: result.messageId || null,
        metadata: {
          deliveredAt: nowIso(),
          externalChatId: binding.externalChatId,
          response: result.payload,
          speakerName: outbound.speakerName,
          status: 'sent',
        },
      });

      return {
        delivered: true,
        externalMessageId: result.messageId || null,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      store.updateExternalEvent(outboundEvent.id, {
        conversationId: message.conversationId,
        messageId: message.id,
        metadata: {
          error: errorMessage,
          externalChatId: binding.externalChatId,
          failedAt: nowIso(),
          status: 'failed',
        },
      });
      logWarn('Failed to deliver outbound Feishu message', {
        conversationId: message.conversationId,
        messageId: message.id,
        error: errorMessage,
      });

      return {
        delivered: false,
        error: errorMessage,
        reason: 'send_failed',
      };
    }
  }

  return {
    deliverAssistantMessage,
    handleLongConnectionEvent,
    handleWebhook,
    initialize,
    parseInboundMessage,
  };
}
