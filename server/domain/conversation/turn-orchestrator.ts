const { randomUUID } = require('node:crypto');
const path = require('node:path');

const { createHttpError } = require('../../http/http-errors');

const { buildAgentTurnPrompt, sanitizePromptMentions } = require('./turn/agent-prompt');
const { createAgentExecutor } = require('./turn/agent-executor');
const { createSessionExporter } = require('./turn/session-export');
const { createTurnEventEmitter } = require('./turn/turn-events');
const { createRuntimePayloadBuilder } = require('./turn/turn-runtime-payload');
const { createRoutingExecutor, normalizeConversationTurnInput } = require('./turn/routing-executor');
const { createTurnStopper } = require('./turn/turn-stop');
const { clipText, nowIso, summarizeTurnState, syncCurrentTurnAgent } = require('./turn/turn-state');

function createAcceptedMessagePayload(conversationId: any, turnInput: any) {
  return {
    id: randomUUID(),
    conversationId,
    turnId: randomUUID(),
    role: turnInput.role,
    senderName: turnInput.senderName,
    content: turnInput.content,
    status: 'completed',
    metadata: turnInput.privateOnly ? { ...turnInput.metadata, privateOnly: true } : turnInput.metadata,
  };
}

export function createTurnOrchestrator(options: any = {}) {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
  const modeStore = options.modeStore;
  const getProjectDir = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  const agentToolBridge = options.agentToolBridge;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const broadcastConversationSummary =
    typeof options.broadcastConversationSummary === 'function' ? options.broadcastConversationSummary : () => {};
  const broadcastRuntimeState = typeof options.broadcastRuntimeState === 'function' ? options.broadcastRuntimeState : () => {};
  const host = String(options.host || '').trim();
  const port = Number.isInteger(options.port) ? options.port : Number.parseInt(options.port || '0', 10);
  const agentDir = path.resolve(String(options.agentDir || '').trim());
  const sqlitePath = String(options.sqlitePath || '').trim();
  const toolBaseUrl = String(options.toolBaseUrl || '').trim();
  const agentToolScriptPath = path.resolve(String(options.agentToolScriptPath || '').trim());
  const agentToolRelativePath = String(options.agentToolRelativePath || './lib/agent-chat-tools.js').trim() || './lib/agent-chat-tools.js';

  const activeConversationIds = new Set();
  const activeTurns = new Map();
  const queueStates = new Map();
  const dispatchingConversationIds = new Set();

  const { emitTurnProgress } = createTurnEventEmitter({ broadcastEvent });

  function listConversationMessages(conversationId: any) {
    const conversation = store.getConversation(conversationId);
    return Array.isArray(conversation && conversation.messages) ? conversation.messages : [];
  }

  function createInitialQueueState(conversationId: any) {
    const messages = listConversationMessages(conversationId);
    let lastConsumedUserMessageId = '';
    let skippingTrailingUsers = true;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];

      if (!message) {
        continue;
      }

      if (skippingTrailingUsers) {
        if (message.role === 'user') {
          continue;
        }

        skippingTrailingUsers = false;
        continue;
      }

      if (message.role === 'user') {
        lastConsumedUserMessageId = String(message.id || '').trim();
        break;
      }
    }

    return {
      lastConsumedUserMessageId,
      failedBatchCount: 0,
      lastFailureAt: null,
      lastFailureMessage: '',
    };
  }

  function ensureQueueState(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    if (!normalizedConversationId) {
      return {
        lastConsumedUserMessageId: '',
      };
    }

    if (!queueStates.has(normalizedConversationId)) {
      queueStates.set(normalizedConversationId, createInitialQueueState(normalizedConversationId));
    }

    return queueStates.get(normalizedConversationId);
  }

  function listPendingUserMessages(conversationId: any, afterMessageId: any = '') {
    const messages = listConversationMessages(conversationId);
    const normalizedAfterMessageId = String(afterMessageId || '').trim();
    const pendingMessages = [];
    const hasAfterMessageId = normalizedAfterMessageId
      ? messages.some((message: any) => String(message && message.id ? message.id : '').trim() === normalizedAfterMessageId)
      : false;
    let collecting = normalizedAfterMessageId === '' || !hasAfterMessageId;

    for (const message of messages) {
      const messageId = String(message && message.id ? message.id : '').trim();

      if (!collecting) {
        if (messageId === normalizedAfterMessageId) {
          collecting = true;
        }
        continue;
      }

      if (message && message.role === 'user') {
        pendingMessages.push(message);
      }
    }

    return pendingMessages;
  }

  function getConversationQueueDepth(conversationId: any) {
    const turnState = activeTurns.get(conversationId) || null;
    const queueState = ensureQueueState(conversationId);
    const afterMessageId = turnState && turnState.batchEndMessageId ? turnState.batchEndMessageId : queueState.lastConsumedUserMessageId;
    return listPendingUserMessages(conversationId, afterMessageId).length;
  }

  function listTrackedConversationIds() {
    return new Set([
      ...store.listConversations().map((conversation: any) => conversation.id),
      ...Array.from(activeTurns.keys()),
      ...Array.from(queueStates.keys()),
      ...Array.from(dispatchingConversationIds),
    ]);
  }

  function buildConversationQueueDepths() {
    const queueDepths: Record<string, number> = {};

    for (const conversationId of listTrackedConversationIds()) {
      const depth = getConversationQueueDepth(conversationId);

      if (depth > 0) {
        queueDepths[conversationId] = depth;
      }
    }

    return queueDepths;
  }

  function buildConversationQueueFailures() {
    const queueFailures: Record<string, any> = {};

    for (const conversationId of listTrackedConversationIds()) {
      const queueState = ensureQueueState(conversationId);
      const queueDepth = getConversationQueueDepth(conversationId);

      if (!queueState.lastFailureAt || queueDepth <= 0) {
        continue;
      }

      queueFailures[conversationId] = {
        failedBatchCount: Math.max(0, Number(queueState.failedBatchCount || 0)),
        lastFailureAt: queueState.lastFailureAt,
        lastFailureMessage: queueState.lastFailureMessage || '',
      };
    }

    return queueFailures;
  }

  const { buildRuntimePayload } = createRuntimePayloadBuilder({
    host,
    port,
    agentDir,
    store,
    activeConversationIds,
    activeTurns,
    dispatchingConversationIds,
    getConversationQueueDepths: buildConversationQueueDepths,
    getConversationQueueFailures: buildConversationQueueFailures,
  });
  const sessionExporter = createSessionExporter({ agentDir });
  const requestStopConversationTurn = createTurnStopper({
    activeTurns,
    broadcastRuntimeState,
    emitTurnProgress,
  });

  const providedExecuteConversationAgent =
    typeof options.executeConversationAgent === 'function' ? options.executeConversationAgent : null;
  const agentExecutor = providedExecuteConversationAgent
    ? null
    : createAgentExecutor({
        store,
        skillRegistry,
        modeStore,
        getProjectDir,
        agentToolBridge,
        broadcastEvent,
        broadcastConversationSummary,
        emitTurnProgress,
        agentDir,
        sqlitePath,
        toolBaseUrl,
        agentToolScriptPath,
        agentToolRelativePath,
      });
  const executeConversationAgent = providedExecuteConversationAgent || agentExecutor.executeConversationAgent;

  const runConversationTurn = createRoutingExecutor({
    store,
    executeConversationAgent,
    getProjectDir,
    broadcastEvent,
    broadcastConversationSummary,
    broadcastRuntimeState,
    emitTurnProgress,
    agentDir,
    sqlitePath,
    activeConversationIds,
    activeTurns,
  });

  function syncConversationQueueProgress(conversationId: any) {
    const turnState = activeTurns.get(conversationId) || null;
    const queueDepth = getConversationQueueDepth(conversationId);

    if (turnState && turnState.queueDepth !== queueDepth) {
      turnState.queueDepth = queueDepth;
      turnState.updatedAt = nowIso();
      syncCurrentTurnAgent(turnState);
      emitTurnProgress(turnState);
    }

    broadcastRuntimeState();
    return queueDepth;
  }

  function drainConversationQueue(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    if (!normalizedConversationId || dispatchingConversationIds.has(normalizedConversationId)) {
      return false;
    }

    dispatchingConversationIds.add(normalizedConversationId);
    broadcastRuntimeState();

    void (async () => {
      try {
        while (true) {
          if (activeConversationIds.has(normalizedConversationId)) {
            break;
          }

          const queueState = ensureQueueState(normalizedConversationId);
          const batchMessages = listPendingUserMessages(normalizedConversationId, queueState.lastConsumedUserMessageId);

          if (batchMessages.length === 0) {
            break;
          }

          const batchMessageIds = batchMessages.map((message: any) => message.id);
          const batchEndMessageId = batchMessageIds[batchMessageIds.length - 1] || queueState.lastConsumedUserMessageId;

          let batchSucceeded = false;

          try {
            await runConversationTurn(normalizedConversationId, {
              batchMessageIds,
            });
            batchSucceeded = true;
          } catch (error) {
            const errorValue = error as any;
            const failureMessage = clipText(
              errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown queued batch error'),
              280
            );
            queueState.failedBatchCount = Math.max(0, Number(queueState.failedBatchCount || 0)) + 1;
            queueState.lastFailureAt = nowIso();
            queueState.lastFailureMessage = failureMessage;
            console.error(
              `[turn-orchestrator] Failed to drain queued batch for conversation ${normalizedConversationId}: ${
                errorValue && errorValue.stack ? errorValue.stack : failureMessage
              }`
            );
          } finally {
            if (batchSucceeded) {
              queueState.lastConsumedUserMessageId = String(batchEndMessageId || '').trim();
              queueState.failedBatchCount = 0;
              queueState.lastFailureAt = null;
              queueState.lastFailureMessage = '';
            }
            syncConversationQueueProgress(normalizedConversationId);
          }

          if (!batchSucceeded) {
            break;
          }
        }
      } finally {
        dispatchingConversationIds.delete(normalizedConversationId);
        broadcastRuntimeState();
      }
    })();

    return true;
  }

  function submitConversationMessage(conversationId: any, input: any) {
    const conversation = store.getConversation(conversationId);

    if (!conversation) {
      throw createHttpError(404, 'Conversation not found');
    }

    const turnInput = normalizeConversationTurnInput(input, conversation);

    if (!turnInput.content) {
      throw createHttpError(400, 'Message content is required');
    }

    if (!Array.isArray(conversation.agents) || conversation.agents.length === 0) {
      throw createHttpError(400, 'Add at least one agent to the conversation first');
    }

    ensureQueueState(conversationId);

    const acceptedMessage = store.createMessage(createAcceptedMessagePayload(conversationId, turnInput));

    broadcastEvent('conversation_message_created', {
      conversationId,
      message: acceptedMessage,
    });
    broadcastConversationSummary(conversationId);

    const started = drainConversationQueue(conversationId);

    if (!started) {
      syncConversationQueueProgress(conversationId);
    }

    return {
      acceptedMessage,
      conversation: store.getConversation(conversationId),
      conversations: store.listConversations(),
      dispatch: started ? 'started' : 'queued',
      runtime: buildRuntimePayload(),
    };
  }

  function clearConversationState(conversationId: any) {
    activeConversationIds.delete(conversationId);
    activeTurns.delete(conversationId);
    queueStates.delete(conversationId);
    dispatchingConversationIds.delete(conversationId);
  }

  function listTurnSummaries(options: any = {}) {
    const conversationId = String(options.conversationId || '').trim();

    return Array.from(activeTurns.values())
      .filter((turnState) => !conversationId || turnState.conversationId === conversationId)
      .map(summarizeTurnState);
  }

  return {
    buildRuntimePayload,
    clearConversationState,
    emitTurnProgress,
    getConversationQueueDepth,
    listTurnSummaries,
    requestStopConversationTurn,
    resolveAssistantMessageSessionPath: sessionExporter.resolveAssistantMessageSessionPath,
    runConversationTurn,
    submitConversationMessage,
    summarizeTurnState,
    syncCurrentTurnAgent,
  };
}

export { buildAgentTurnPrompt, sanitizePromptMentions };
