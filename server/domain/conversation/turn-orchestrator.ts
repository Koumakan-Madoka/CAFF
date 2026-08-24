const { randomUUID } = require('node:crypto');
const path = require('node:path');

const { createSqliteRunStore } = require('../../../lib/sqlite-store');
const { createHttpError } = require('../../http/http-errors');
const { pickConversationSummary } = require('./conversation-view');
const {
  claimSessionGoalAutoContinue,
  createSessionGoalBudgetProposal,
  getSessionGoal,
  getSessionGoalProposal,
  pauseSessionGoalForRemovedOwner,
  recordSessionGoalContinuationOutcome,
} = require('./session-goal');

const { getAgentById, extractMentionedAgentIds, resolveTurnExecutionMode } = require('./mention-routing');
const { buildAgentTurnPrompt, sanitizePromptMentions } = require('./turn/agent-prompt');
const { createAgentExecutor } = require('./turn/agent-executor');
const { assertImagePreflightForTargets } = require('./turn/image-preflight');
const { resolveInitialTurnTargets } = require('./turn/initial-target-resolution');
const { createSessionExporter } = require('./turn/session-export');
const { createTurnEventEmitter } = require('./turn/turn-events');
const { createRuntimePayloadBuilder } = require('./turn/turn-runtime-payload');
const { createRoutingExecutor, normalizeConversationTurnInput } = require('./turn/routing-executor');
const { createTurnStopper, registerTurnHandle, unregisterTurnHandle } = require('./turn/turn-stop');
const {
  clipText,
  createAgentSlotState,
  nowIso,
  summarizeAgentSlotState,
  summarizeTurnState,
  syncCurrentTurnAgent,
} = require('./turn/turn-state');
const { buildPromptMessages, buildPromptSnapshotMessageIds } = require('./turn/prompt-visibility');
const { createAgentSlotRegistry } = require('./turn/agent-slot-registry');

const CONVERSATION_TURN_QUEUE_METADATA_KEY = 'conversationTurnQueue';

function createAcceptedMessagePayload(conversationId: any, turnInput: any) {
  return {
    id: randomUUID(),
    conversationId,
    turnId: randomUUID(),
    role: turnInput.role,
    senderName: turnInput.senderName,
    content: turnInput.content,
    status: 'completed',
    imageIds: Array.isArray(turnInput.imageIds) ? turnInput.imageIds : [],
    metadata: turnInput.privateOnly ? { ...turnInput.metadata, privateOnly: true } : turnInput.metadata,
  };
}

function createTaskId(prefix = 'task') {
  return `${prefix}-${randomUUID()}`;
}

function cloneMessageSnapshot(message: any) {
  return message && typeof message === 'object'
    ? {
        ...message,
        metadata:
          message.metadata && typeof message.metadata === 'object'
            ? {
                ...message.metadata,
              }
            : message.metadata,
      }
    : message;
}

export function createTurnOrchestrator(options: any = {}) {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
  const modeStore = options.modeStore;
  const getProjectDir = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  const agentToolBridge = options.agentToolBridge;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const modelCatalog = options.modelCatalog;
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
  const piCapabilityExtensionPath = String(options.piCapabilityExtensionPath || '').trim();
  const browserCliPath = String(options.browserCliPath || '').trim();
  const resolveRuntimeParticipants = typeof options.resolveRuntimeParticipants === 'function'
    ? options.resolveRuntimeParticipants
    : (participants: any) => participants;
  const sessionGoalAutoContinueMaxTurns = Math.max(
    1,
    Number.parseInt(
      String(options.sessionGoalAutoContinueMaxTurns || process.env.CAFF_SESSION_GOAL_AUTO_CONTINUE_MAX_TURNS || '20'),
      10
    ) || 20
  );
  const sessionGoalFailureThreshold = Math.max(
    2,
    Number.parseInt(
      String(options.sessionGoalFailureThreshold || process.env.CAFF_SESSION_GOAL_FAILURE_THRESHOLD || '3'),
      10
    ) || 3
  );
  const sessionGoalFastFailureMs = Math.max(
    1,
    Number.parseInt(
      String(options.sessionGoalFastFailureMs || process.env.CAFF_SESSION_GOAL_FAST_FAILURE_MS || '60000'),
      10
    ) || 60_000
  );
  const sessionGoalFailureWindowMs = Math.max(
    sessionGoalFastFailureMs,
    Number.parseInt(
      String(options.sessionGoalFailureWindowMs || process.env.CAFF_SESSION_GOAL_FAILURE_WINDOW_MS || '300000'),
      10
    ) || 5 * 60_000
  );

  const activeConversationIds = new Set();
  const activeTurns = new Map();
  const activeAgentSlots = new Map();
  const queueStates = new Map();
  const dispatchingConversationIds = new Set();
  const sideDispatchMessageIds = new Map();
  const queuedSideDispatches = new Map();
  const agentSlotRegistry = createAgentSlotRegistry();

  const { emitTurnProgress, emitAgentSlotFinished } = createTurnEventEmitter({ broadcastEvent });

  function listConversationMessages(conversationId: any) {
    const conversation = store.getConversation(conversationId);
    return Array.isArray(conversation && conversation.messages) ? conversation.messages : [];
  }

  function conversationTurnQueueMetadata(conversation: any) {
    const metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object'
      ? conversation.metadata
      : {};
    const queueMetadata = metadata[CONVERSATION_TURN_QUEUE_METADATA_KEY];

    return queueMetadata && typeof queueMetadata === 'object' && !Array.isArray(queueMetadata)
      ? queueMetadata
      : null;
  }

  function persistConversationQueueState(conversationId: any, queueState: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    if (!normalizedConversationId || !store || typeof store.updateConversation !== 'function') {
      return null;
    }

    const conversation = typeof store.getConversationWithoutMessages === 'function'
      ? store.getConversationWithoutMessages(normalizedConversationId)
      : store.getConversation(normalizedConversationId);
    if (!conversation) {
      return null;
    }

    const metadata = conversation.metadata && typeof conversation.metadata === 'object'
      ? conversation.metadata
      : {};
    const existingQueueMetadata = conversationTurnQueueMetadata(conversation) || {};
    const lastConsumedUserMessageId = String(queueState && queueState.lastConsumedUserMessageId || '').trim();

    if (
      Object.prototype.hasOwnProperty.call(existingQueueMetadata, 'lastConsumedUserMessageId')
      && String(existingQueueMetadata.lastConsumedUserMessageId || '').trim() === lastConsumedUserMessageId
    ) {
      return conversation;
    }

    return store.updateConversation(normalizedConversationId, {
      metadata: {
        ...metadata,
        [CONVERSATION_TURN_QUEUE_METADATA_KEY]: {
          ...existingQueueMetadata,
          lastConsumedUserMessageId,
        },
      },
    });
  }

  function resolveConversationMessage(conversationId: any, messageId: any) {
    const normalizedMessageId = String(messageId || '').trim();

    if (!normalizedMessageId) {
      return null;
    }

    return listConversationMessages(conversationId).find((message: any) => String(message && message.id ? message.id : '').trim() === normalizedMessageId) || null;
  }

  function buildPromptMessagesFromSnapshot(conversationId: any, promptUserMessage: any, snapshotMessageIds: any) {
    const normalizedSnapshotMessageIds = Array.isArray(snapshotMessageIds)
      ? snapshotMessageIds.map((messageId: any) => String(messageId || '').trim()).filter(Boolean)
      : [];
    const snapshotMessages = normalizedSnapshotMessageIds
      .map((messageId: any) => resolveConversationMessage(conversationId, messageId))
      .filter(Boolean);

    return buildPromptMessages(snapshotMessages, promptUserMessage, {
      snapshotMessageIds: new Set(normalizedSnapshotMessageIds),
      replacePromptUserMessage: true,
    }).map(cloneMessageSnapshot);
  }

  function ensureQueuedSideDispatches(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    if (!normalizedConversationId) {
      return new Map() as Map<string, any>;
    }

    if (!queuedSideDispatches.has(normalizedConversationId)) {
      queuedSideDispatches.set(normalizedConversationId, new Map());
    }

    return queuedSideDispatches.get(normalizedConversationId) as Map<string, any>;
  }

  function trackQueuedSideDispatch(conversationId: any, request: any) {
    const normalizedRequestId = String(request && request.requestId ? request.requestId : '').trim();

    if (!normalizedRequestId) {
      return;
    }

    ensureQueuedSideDispatches(conversationId).set(normalizedRequestId, request);
  }

  function untrackQueuedSideDispatch(conversationId: any, requestId: any) {
    const normalizedConversationId = String(conversationId || '').trim();
    const normalizedRequestId = String(requestId || '').trim();

    if (!normalizedConversationId || !normalizedRequestId || !queuedSideDispatches.has(normalizedConversationId)) {
      return;
    }

    const requests = queuedSideDispatches.get(normalizedConversationId);
    requests.delete(normalizedRequestId);

    if (requests.size === 0) {
      queuedSideDispatches.delete(normalizedConversationId);
    }
  }

  function listQueuedSideDispatches(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    if (!normalizedConversationId || !queuedSideDispatches.has(normalizedConversationId)) {
      return [] as any[];
    }

    return Array.from((queuedSideDispatches.get(normalizedConversationId) as Map<string, any>).values()) as any[];
  }

  function inferLastConsumedUserMessageId(messages: any[]) {
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

    return lastConsumedUserMessageId;
  }

  function createInitialQueueState(conversationId: any) {
    const conversation = store.getConversation(conversationId);
    const messages = Array.isArray(conversation && conversation.messages) ? conversation.messages : [];
    const persistedQueueMetadata = conversationTurnQueueMetadata(conversation);
    const hasPersistedCursor = Boolean(
      persistedQueueMetadata
      && Object.prototype.hasOwnProperty.call(persistedQueueMetadata, 'lastConsumedUserMessageId')
    );

    return {
      lastConsumedUserMessageId: hasPersistedCursor
        ? String(persistedQueueMetadata.lastConsumedUserMessageId || '').trim()
        : inferLastConsumedUserMessageId(messages),
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

  function ensureSideDispatchMessageIds(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    if (!normalizedConversationId) {
      return new Set();
    }

    if (!sideDispatchMessageIds.has(normalizedConversationId)) {
      sideDispatchMessageIds.set(normalizedConversationId, new Set());
    }

    return sideDispatchMessageIds.get(normalizedConversationId);
  }

  function markSideDispatchMessage(conversationId: any, messageId: any) {
    const normalizedMessageId = String(messageId || '').trim();

    if (!normalizedMessageId) {
      return;
    }

    ensureSideDispatchMessageIds(conversationId).add(normalizedMessageId);
  }

  function isSideDispatchMessage(conversationId: any, messageId: any, message: any = null) {
    const dispatchLane =
      message && message.metadata && typeof message.metadata === 'object'
        ? String(message.metadata.dispatchLane || '').trim()
        : '';

    if (dispatchLane === 'side') {
      return true;
    }

    const normalizedConversationId = String(conversationId || '').trim();
    const normalizedMessageId = String(messageId || '').trim();

    if (!normalizedConversationId || !normalizedMessageId || !sideDispatchMessageIds.has(normalizedConversationId)) {
      return false;
    }

    return sideDispatchMessageIds.get(normalizedConversationId).has(normalizedMessageId);
  }

  function isTerminalMessageStatus(message: any) {
    const status = String(message && message.status ? message.status : '').trim();
    return status === 'completed' || status === 'failed';
  }

  function listSideDispatchReplyMessages(conversationId: any, sourceMessageId: any) {
    const normalizedSourceMessageId = String(sourceMessageId || '').trim();

    if (!normalizedSourceMessageId) {
      return [] as any[];
    }

    return listConversationMessages(conversationId).filter((message: any) => {
      if (!message || message.role !== 'assistant') {
        return false;
      }

      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      return String(metadata && metadata.triggeredByMessageId ? metadata.triggeredByMessageId : '').trim() === normalizedSourceMessageId;
    });
  }

  function updateSideDispatchSourceMessageMetadata(conversationId: any, sourceMessageId: any, updates: any = {}) {
    const normalizedSourceMessageId = String(sourceMessageId || '').trim();

    if (!normalizedSourceMessageId || !store || typeof store.updateMessage !== 'function') {
      return null;
    }

    const sourceMessage = resolveConversationMessage(conversationId, normalizedSourceMessageId);

    if (!sourceMessage || !isSideDispatchMessage(conversationId, normalizedSourceMessageId, sourceMessage)) {
      return null;
    }

    const existingMetadata = sourceMessage.metadata && typeof sourceMessage.metadata === 'object' ? sourceMessage.metadata : {};
    return store.updateMessage(normalizedSourceMessageId, {
      metadata: {
        ...existingMetadata,
        ...updates,
      },
    });
  }

  function markSideDispatchCancelled(conversationId: any, sourceMessageId: any, reason: any) {
    const stopReason = String(reason || 'Stopped by user').trim() || 'Stopped by user';

    updateSideDispatchSourceMessageMetadata(conversationId, sourceMessageId, {
      dispatchCancelled: true,
      dispatchCancelledAt: nowIso(),
      dispatchCancelReason: stopReason,
    });
  }

  function markStaleSideDispatchReplyMessages(conversationId: any, sourceMessageId: any) {
    if (!store || typeof store.updateMessage !== 'function') {
      return;
    }

    for (const message of listSideDispatchReplyMessages(conversationId, sourceMessageId)) {
      if (isTerminalMessageStatus(message)) {
        continue;
      }

      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
      store.updateMessage(message.id, {
        content: message.content === 'Thinking...' ? '' : String(message.content || ''),
        status: 'failed',
        errorMessage: 'Recovered after process restart before side dispatch completed',
        metadata: {
          ...metadata,
          failure: true,
          streaming: false,
          recoveredAfterRestart: true,
        },
      });
    }
  }

  function buildPromptSnapshotMessageIdsThroughMessage(conversationId: any, sourceMessageId: any) {
    const normalizedSourceMessageId = String(sourceMessageId || '').trim();
    const snapshotMessageIds = [] as any[];

    for (const message of listConversationMessages(conversationId)) {
      const messageId = String(message && message.id ? message.id : '').trim();

      if (!messageId) {
        continue;
      }

      snapshotMessageIds.push(messageId);

      if (messageId === normalizedSourceMessageId) {
        break;
      }
    }

    return snapshotMessageIds;
  }

  function resolvePersistedSideDispatchTarget(conversation: any, acceptedMessage: any) {
    const metadata = acceptedMessage && acceptedMessage.metadata && typeof acceptedMessage.metadata === 'object' ? acceptedMessage.metadata : null;
    const targetAgentId = String(metadata && metadata.dispatchTargetAgentId ? metadata.dispatchTargetAgentId : '').trim();

    if (!targetAgentId || !getAgentById(conversation && conversation.agents, targetAgentId)) {
      return null;
    }

    const execution = resolveTurnExecutionMode(acceptedMessage && acceptedMessage.content ? acceptedMessage.content : '', 1);

    return {
      targetAgentId,
      cleanedContent: execution.cleanedText || (acceptedMessage && acceptedMessage.content ? acceptedMessage.content : ''),
      explicitIntent: execution.explicitIntent || '',
    };
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

      if (message && message.role === 'user' && !isSideDispatchMessage(conversationId, message.id, message)) {
        pendingMessages.push(message);
      }
    }

    return pendingMessages;
  }

  function hasActiveAgentSlots(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    if (!normalizedConversationId) {
      return false;
    }

    return Array.from(activeAgentSlots.values()).some((slotState: any) => slotState.conversationId === normalizedConversationId);
  }

  function listConversationActiveAgentSlots(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    return Array.from(activeAgentSlots.values()).filter((slotState: any) => {
      return !normalizedConversationId || slotState.conversationId === normalizedConversationId;
    });
  }

  function getConversationQueueDepth(conversationId: any) {
    const turnState = activeTurns.get(conversationId) || null;
    const queueState = ensureQueueState(conversationId);
    const afterMessageId = turnState && turnState.batchEndMessageId ? turnState.batchEndMessageId : queueState.lastConsumedUserMessageId;
    return listPendingUserMessages(conversationId, afterMessageId).length;
  }

  function listTrackedConversationIds() {
    return new Set([
      ...Array.from(activeTurns.keys()),
      ...Array.from(queueStates.keys()),
      ...Array.from(dispatchingConversationIds),
      ...Array.from(activeAgentSlots.values()).map((slotState: any) => slotState.conversationId),
    ]);
  }

  function hasInMemoryQueueState() {
    return (
      activeTurns.size > 0
      || queueStates.size > 0
      || dispatchingConversationIds.size > 0
      || activeAgentSlots.size > 0
    );
  }

  function hasActiveRuntimeState(conversationId: any) {
    return (
      activeTurns.has(conversationId)
      || dispatchingConversationIds.has(conversationId)
      || hasActiveAgentSlots(conversationId)
    );
  }

  function reconcileConversationQueueAfterMessageDeletion(conversationId: any, deletedMessages: any[] = []) {
    const normalizedConversationId = String(conversationId || '').trim();
    const queueState = queueStates.get(normalizedConversationId) || null;
    const deletedItems = Array.isArray(deletedMessages) ? deletedMessages : [];
    const deletedIds = new Set(
      deletedItems.map((message: any) => String(message && message.id || '').trim()).filter(Boolean)
    );
    const consumedMessageId = String(queueState && queueState.lastConsumedUserMessageId || '').trim();

    if (!queueState) {
      return queueState;
    }

    if (consumedMessageId && deletedIds.has(consumedMessageId)) {
      const deletedCursor = deletedItems.find((message: any) => {
        return String(message && message.id || '').trim() === consumedMessageId;
      }) || null;
      const cursorCreatedAt = String(deletedCursor && deletedCursor.createdAt || '').trim();

      if (!cursorCreatedAt) {
        queueState.lastConsumedUserMessageId = inferLastConsumedUserMessageId(
          listConversationMessages(normalizedConversationId)
        );
      } else {
        let previousConsumedUserMessageId = '';
        for (const message of listConversationMessages(normalizedConversationId)) {
          const messageId = String(message && message.id || '').trim();
          const createdAt = String(message && message.createdAt || '').trim();
          const precedesDeletedCursor = createdAt < cursorCreatedAt
            || (createdAt === cursorCreatedAt && messageId < consumedMessageId);

          if (message && message.role === 'user' && messageId && precedesDeletedCursor) {
            previousConsumedUserMessageId = messageId;
          }
        }

        queueState.lastConsumedUserMessageId = previousConsumedUserMessageId;
      }
    }

    persistConversationQueueState(normalizedConversationId, queueState);
    return queueState;
  }

  function getConversationMutationState(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();
    const active = activeConversationIds.has(normalizedConversationId);
    const dispatching = dispatchingConversationIds.has(normalizedConversationId);
    const activeTurnCount = activeTurns.has(normalizedConversationId) ? 1 : 0;
    const activeAgentSlotCount = listConversationActiveAgentSlots(normalizedConversationId).length;
    const queuedUserCount = normalizedConversationId ? getConversationQueueDepth(normalizedConversationId) : 0;
    const queuedAgentSlotCount = normalizedConversationId
      ? listQueuedSideDispatches(normalizedConversationId).length
      : 0;

    return {
      active,
      dispatching,
      activeTurnCount,
      activeAgentSlotCount,
      queuedUserCount,
      queuedAgentSlotCount,
      busy: Boolean(
        active
        || dispatching
        || activeTurnCount > 0
        || activeAgentSlotCount > 0
        || queuedUserCount > 0
        || queuedAgentSlotCount > 0
      ),
    };
  }

  function buildConversationQueueSnapshot() {
    if (!hasInMemoryQueueState()) {
      return { depths: {}, failures: {} };
    }

    const queueDepths: Record<string, number> = {};
    const queueFailures: Record<string, any> = {};
    const settledConversationIds: string[] = [];

    for (const conversationId of listTrackedConversationIds()) {
      const queueState = ensureQueueState(conversationId);
      const queueDepth = getConversationQueueDepth(conversationId);

      if (queueDepth > 0) {
        queueDepths[conversationId] = queueDepth;
      }

      if (queueState.lastFailureAt && queueDepth > 0) {
        queueFailures[conversationId] = {
          failedBatchCount: Math.max(0, Number(queueState.failedBatchCount || 0)),
          lastFailureAt: queueState.lastFailureAt,
          lastFailureMessage: queueState.lastFailureMessage || '',
        };
      }

      if (
        queueDepth === 0
        && !queueState.lastFailureAt
        && !hasActiveRuntimeState(conversationId)
      ) {
        settledConversationIds.push(conversationId);
      }
    }

    for (const conversationId of settledConversationIds) {
      queueStates.delete(conversationId);
    }

    return { depths: queueDepths, failures: queueFailures };
  }

  function buildConversationQueueDepths() {
    return buildConversationQueueSnapshot().depths;
  }

  function buildConversationQueueFailures() {
    return buildConversationQueueSnapshot().failures;
  }

  function recoverPersistedQueueStates() {
    if (!store || typeof store.listConversationIdsWithPendingUserMessages !== 'function') {
      return;
    }

    const pendingConversationIds = store.listConversationIdsWithPendingUserMessages();

    for (const conversationId of Array.isArray(pendingConversationIds) ? pendingConversationIds : []) {
      const normalizedConversationId = String(conversationId || '').trim();

      if (normalizedConversationId) {
        ensureQueueState(normalizedConversationId);
      }
    }
  }

  const { buildRuntimePayload } = createRuntimePayloadBuilder({
    host,
    port,
    agentDir,
    store,
    activeConversationIds,
    activeTurns,
    activeAgentSlots,
    dispatchingConversationIds,
    getConversationQueueDepths: buildConversationQueueDepths,
    getConversationQueueFailures: buildConversationQueueFailures,
    getConversationQueueSnapshot: buildConversationQueueSnapshot,
    getAgentSlotQueueDepths: () => agentSlotRegistry.buildSideQueueDepths(),
  });
  const sessionExporter = createSessionExporter({ agentDir });
  const requestStopMainTurn = createTurnStopper({
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
        piCapabilityExtensionPath,
        browserCliPath,
        modelCatalog,
        uploadsDir: options.uploadsDir,
        onAssistantMessageCompleted: options.onAssistantMessageCompleted,
      });
  const baseExecuteConversationAgent = providedExecuteConversationAgent || agentExecutor.executeConversationAgent;

  async function executeConversationAgentWithSlot(input: any) {
    const conversationId = String(input && input.conversationId ? input.conversationId : '').trim();
    const agentId = String(input && input.agent && input.agent.id ? input.agent.id : '').trim();
    const lane = input && input.turnState && input.turnState.executionLane === 'side' ? 'side' : 'main';

    if (!conversationId || !agentId || lane === 'side') {
      return baseExecuteConversationAgent(input);
    }

    const slotRequest = agentSlotRegistry.requestSlot({
      conversationId,
      agentId,
      lane: 'main',
    });
    const waitHandle = slotRequest.queued
      ? {
          cancel(reason: any) {
            slotRequest.cancel(reason || 'Stopped by user');
          },
        }
      : null;

    if (waitHandle && input.turnState) {
      registerTurnHandle(input.turnState, waitHandle);
    }

    let grant = null as any;

    try {
      grant = await slotRequest.promise;
    } catch (error) {
      if (waitHandle && input.turnState) {
        unregisterTurnHandle(input.turnState, waitHandle);
      }

      if (input.turnState && input.turnState.stopRequested) {
        return {
          stopTurn: true,
          terminationReason: 'stopped_by_user',
        };
      }

      throw error;
    }

    if (waitHandle && input.turnState) {
      unregisterTurnHandle(input.turnState, waitHandle);
    }

    try {
      if (input.turnState && input.turnState.stopRequested) {
        return {
          stopTurn: true,
          terminationReason: 'stopped_by_user',
        };
      }

      return await baseExecuteConversationAgent(input);
    } finally {
      if (grant && typeof grant.release === 'function') {
        grant.release();
      }
    }
  }

  const baseRunConversationTurn = createRoutingExecutor({
    store,
    executeConversationAgent: executeConversationAgentWithSlot,
    resolveRuntimeParticipants,
    getProjectDir,
    broadcastEvent,
    broadcastConversationSummary,
    broadcastRuntimeState,
    emitTurnProgress,
    agentDir,
    sqlitePath,
    modelCatalog,
    activeConversationIds,
    activeTurns,
    isAgentBusy: agentSlotRegistry.isAgentBusy,
  });

  function markConversationQueueBatchConsumed(conversationId: any, messageId: any) {
    const normalizedConversationId = String(conversationId || '').trim();
    const queueState = ensureQueueState(normalizedConversationId);
    queueState.lastConsumedUserMessageId = String(messageId || '').trim();
    queueState.failedBatchCount = 0;
    queueState.lastFailureAt = null;
    queueState.lastFailureMessage = '';
    persistConversationQueueState(normalizedConversationId, queueState);
    return queueState;
  }

  async function runConversationTurn(conversationId: any, userContent: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    if (
      normalizedConversationId &&
      (dispatchingConversationIds.has(normalizedConversationId) || hasActiveAgentSlots(normalizedConversationId))
    ) {
      throw createHttpError(409, 'This conversation is already processing another turn');
    }

    const result = await baseRunConversationTurn(conversationId, userContent);
    const consumedMessageId = String(
      result && result.turn && (result.turn.consumedUpToMessageId || result.turn.batchEndMessageId) || ''
    ).trim();
    if (normalizedConversationId && consumedMessageId) {
      markConversationQueueBatchConsumed(normalizedConversationId, consumedMessageId);
    }
    return result;
  }

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

  function buildGoalContinuationContent(goal: any, runner: any) {
    const iteration = Math.max(1, Number(runner && runner.iteration ? runner.iteration : 1));
    const maxIterations = Math.max(iteration, Number(runner && runner.maxIterations ? runner.maxIterations : sessionGoalAutoContinueMaxTurns));

    return [
      `Automatic session-goal continuation (${iteration}/${maxIterations}).`,
      `Objective: ${goal.objective}`,
      'Continue with the next concrete step toward this objective.',
      'If the objective is finished or blocked, use suggest-goal to create a pending complete or pause proposal instead of continuing indefinitely.',
    ].join('\n');
  }

  function broadcastGoalProposalResult(conversationId: any, result: any) {
    const conversation = result && result.conversation ? result.conversation : store.getConversation(conversationId);
    const summary = pickConversationSummary(conversation);

    broadcastEvent(result && result.proposalCleared ? 'conversation_goal_proposal_cleared' : 'conversation_goal_proposal_updated', {
      conversationId,
      goal: result && result.goal ? result.goal : getSessionGoal(conversation),
      proposal: result && result.proposal ? result.proposal : getSessionGoalProposal(conversation),
      conversation,
      summary,
    });
    broadcastEvent('conversation_summary_updated', {
      conversationId,
      summary,
    });
    broadcastConversationSummary(conversationId);
  }

  function broadcastGoalUpdateResult(conversationId: any, result: any) {
    if (!result || !result.changed) {
      return;
    }

    const conversation = result.conversation || store.getConversation(conversationId);
    const summary = pickConversationSummary(conversation);
    broadcastEvent('conversation_goal_updated', {
      conversationId,
      goal: result.goal || getSessionGoal(conversation),
      runner: result.runner || null,
      autoPauseReason: result.paused && result.runner ? result.runner.pauseReason || '' : '',
      conversation,
      summary,
    });
    broadcastEvent('conversation_summary_updated', {
      conversationId,
      summary,
    });
    broadcastConversationSummary(conversationId);
  }

  function maybeCreateGoalBudgetProposal(conversationId: any, claim: any) {
    if (!claim || claim.reason !== 'budget_limited') {
      return null;
    }

    const conversation = store.getConversation(conversationId);

    if (!conversation || getSessionGoalProposal(conversation)) {
      return null;
    }

    const result = createSessionGoalBudgetProposal(store, conversationId, {
      reason: `Automatic goal continuation reached its ${sessionGoalAutoContinueMaxTurns}-turn safety budget. Confirm whether to pause, replace, or continue the goal.`,
    });
    broadcastGoalProposalResult(conversationId, result);
    return result;
  }

  function enqueueGoalContinuationMessage(conversationId: any, options: any = {}) {
    const normalizedConversationId = String(conversationId || '').trim();
    const allowDispatching = Boolean(options.allowDispatching);

    if (
      !normalizedConversationId ||
      activeConversationIds.has(normalizedConversationId) ||
      hasActiveAgentSlots(normalizedConversationId) ||
      (!allowDispatching && dispatchingConversationIds.has(normalizedConversationId))
    ) {
      return { scheduled: false, reason: 'busy' };
    }

    const conversation = store.getConversation(normalizedConversationId);

    if (!conversation) {
      return { scheduled: false, reason: 'missing_conversation_or_agents' };
    }

    const rosterAgents = Array.isArray(conversation.agents) ? conversation.agents : [];

    const goal = getSessionGoal(conversation);

    if (!goal || goal.status !== 'active') {
      return { scheduled: false, reason: 'inactive_goal' };
    }

    // Fail-closed owner removal (D3): the goal owner must still be a
    // conversation participant. When the roster no longer contains the
    // owner, pause the goal and raise a pending resume proposal instead of
    // silently falling back to default routing. This check runs BEFORE the
    // pending-proposal gate and BEFORE the empty-roster gate so a removed
    // owner pauses the goal even while a proposal is pending or even when
    // retiring the owner was the last roster change (agents may be empty,
    // e.g. after retiring the only custom role owning the goal); the
    // existing proposal is preserved.
    const goalOwnerId = String(goal.owner && goal.owner.agentId ? goal.owner.agentId : '').trim();

    if (
      goalOwnerId
      && !rosterAgents.some((agent: any) => String(agent && agent.id ? agent.id : '').trim() === goalOwnerId)
    ) {
      const ownerRemoved = pauseSessionGoalForRemovedOwner(store, normalizedConversationId, goal.owner);

      if (ownerRemoved.changed) {
        broadcastGoalUpdateResult(normalizedConversationId, ownerRemoved);
        broadcastGoalProposalResult(normalizedConversationId, ownerRemoved);
      }

      return { scheduled: false, reason: 'owner_removed', goal: ownerRemoved.goal || goal };
    }

    if (rosterAgents.length === 0) {
      return { scheduled: false, reason: 'missing_conversation_or_agents' };
    }

    if (getSessionGoalProposal(conversation)) {
      return { scheduled: false, reason: 'pending_proposal' };
    }

    const queueState = ensureQueueState(normalizedConversationId);

    if (listPendingUserMessages(normalizedConversationId, queueState.lastConsumedUserMessageId).length > 0) {
      return { scheduled: false, reason: 'pending_user_messages' };
    }

    const claim = claimSessionGoalAutoContinue(store, normalizedConversationId, {
      maxIterations: sessionGoalAutoContinueMaxTurns,
    });

    if (!claim || !claim.claimed) {
      maybeCreateGoalBudgetProposal(normalizedConversationId, claim);
      return { scheduled: false, reason: claim && claim.reason ? claim.reason : 'not_claimed' };
    }

    const acceptedMessage = store.createMessage(
      createAcceptedMessagePayload(normalizedConversationId, {
        role: 'user',
        senderName: 'Goal Runner',
        content: buildGoalContinuationContent(claim.goal, claim.runner),
        metadata: {
          source: 'goal-runner',
          goalAutoContinue: true,
          goalIteration: claim.runner.iteration,
          goalMaxIterations: claim.runner.maxIterations,
          goalObjective: claim.goal.objective,
          // Goal owner routing: stamp the persisted owner as the explicit
          // initial target so the queued batch routes to the owner instead
          // of drifting with default_last_agent.
          ...(goalOwnerId ? { initialAgentIds: [goalOwnerId] } : {}),
        },
      })
    );

    broadcastEvent('conversation_message_created', {
      conversationId: normalizedConversationId,
      message: acceptedMessage,
    });
    broadcastConversationSummary(normalizedConversationId);
    syncConversationQueueProgress(normalizedConversationId);

    return {
      scheduled: true,
      reason: 'scheduled',
      message: acceptedMessage,
      goal: claim.goal,
      runner: claim.runner,
    };
  }

  function scheduleGoalContinuation(conversationId: any, options: any = {}) {
    const scheduled = enqueueGoalContinuationMessage(conversationId, options);

    if (!scheduled.scheduled) {
      return scheduled;
    }

    const started = drainConversationQueue(conversationId);
    return {
      ...scheduled,
      dispatch: started ? 'started' : 'queued',
      runtime: buildRuntimePayload(),
    };
  }

  function drainConversationQueue(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    if (
      !normalizedConversationId ||
      dispatchingConversationIds.has(normalizedConversationId) ||
      hasActiveAgentSlots(normalizedConversationId)
    ) {
      return false;
    }

    dispatchingConversationIds.add(normalizedConversationId);
    broadcastRuntimeState();

    void (async () => {
      try {
        while (true) {
          if (activeConversationIds.has(normalizedConversationId) || hasActiveAgentSlots(normalizedConversationId)) {
            break;
          }

          const queueState = ensureQueueState(normalizedConversationId);
          const batchMessages = listPendingUserMessages(normalizedConversationId, queueState.lastConsumedUserMessageId);

          if (batchMessages.length === 0) {
            const continuation = enqueueGoalContinuationMessage(normalizedConversationId, {
              allowDispatching: true,
            });

            if (continuation.scheduled) {
              continue;
            }

            break;
          }

          const batchMessageIds = batchMessages.map((message: any) => message.id);
          const batchEndMessageId = batchMessageIds[batchMessageIds.length - 1] || queueState.lastConsumedUserMessageId;

          let batchSucceeded = false;

          try {
            const turnResult = await baseRunConversationTurn(normalizedConversationId, {
              batchMessageIds,
            });
            const goalOutcome = recordSessionGoalContinuationOutcome(store, normalizedConversationId, {
              sourceMessages: batchMessages,
              turn: turnResult && turnResult.turn ? turnResult.turn : null,
              replies: turnResult && Array.isArray(turnResult.replies) ? turnResult.replies : [],
              failures: turnResult && Array.isArray(turnResult.failures) ? turnResult.failures : [],
              failureThreshold: sessionGoalFailureThreshold,
              fastFailureMs: sessionGoalFastFailureMs,
              failureWindowMs: sessionGoalFailureWindowMs,
            });
            broadcastGoalUpdateResult(normalizedConversationId, goalOutcome);
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
              markConversationQueueBatchConsumed(normalizedConversationId, batchEndMessageId);
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

  function resolveSideDispatchTarget(conversation: any, turnInput: any) {
    const content = String(turnInput && turnInput.content ? turnInput.content : '').trim();

    if (!content || !Array.isArray(conversation && conversation.agents)) {
      return null;
    }

    const mentionedAgentIds = extractMentionedAgentIds(content, conversation.agents, {
      limit: 2,
    });

    if (mentionedAgentIds.length !== 1) {
      return null;
    }

    const execution = resolveTurnExecutionMode(content, mentionedAgentIds.length);

    return {
      targetAgentId: mentionedAgentIds[0],
      cleanedContent: execution.cleanedText || content,
      explicitIntent: execution.explicitIntent || '',
    };
  }

  function shouldAllowSideDispatch(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    return Boolean(
      normalizedConversationId &&
      (activeConversationIds.has(normalizedConversationId) ||
        dispatchingConversationIds.has(normalizedConversationId) ||
        hasActiveAgentSlots(normalizedConversationId))
    );
  }

  async function runSideDispatch(entry: any, grant: any) {
    let conversation = null as any;
    let agent = null as any;
    let slotState = null as any;
    let runStore = null as any;
    let rootTaskId = '';
    const completedReplies: any[] = [];
    const failedReplies: any[] = [];

    try {
      const storedConversation = store.getConversation(entry.conversationId);
      conversation = storedConversation
        ? { ...storedConversation, agents: resolveRuntimeParticipants(storedConversation.agents) }
        : null;
      agent = conversation ? getAgentById(conversation.agents, entry.targetAgentId) : null;

      if (!conversation || !agent) {
        throw createHttpError(404, 'Conversation or target agent not found for side dispatch');
      }

      slotState = createAgentSlotState(conversation, agent, {
        slotId: `${entry.conversationId}:${entry.targetAgentId}`,
        sourceMessageId: entry.acceptedMessage.id,
        turnId: randomUUID(),
      });
      activeAgentSlots.set(slotState.slotId, slotState);
      broadcastRuntimeState();
      emitTurnProgress(slotState);

      runStore = createSqliteRunStore({ agentDir, sqlitePath });
      rootTaskId = createTaskId('conversation-side-dispatch');
      const inputText = String(entry.promptUserMessage && entry.promptUserMessage.content ? entry.promptUserMessage.content : '').trim();

      runStore.createTask({
        taskId: rootTaskId,
        kind: 'conversation_side_dispatch',
        title: `Side dispatch for ${conversation.title}`,
        status: 'running',
        inputText,
        metadata: {
          conversationId: entry.conversationId,
          turnId: slotState.turnId,
          participantAgentIds: [agent.id],
          routingMode: entry.routingMode || 'mention_queue',
          entryAgentIds: [agent.id],
          entryStrategy: entry.entryStrategy || 'user_mentions',
          entryExecutionMode: 'serial',
          explicitIntent: entry.explicitIntent || '',
          dispatchLane: 'side',
          sourceMessageId: entry.acceptedMessage.id,
        },
        startedAt: nowIso(),
      });
      runStore.appendTaskEvent(rootTaskId, 'conversation_side_dispatch_started', {
        conversationId: entry.conversationId,
        turnId: slotState.turnId,
        agentId: agent.id,
        agentName: agent.name,
        sourceMessageId: entry.acceptedMessage.id,
      });

      const promptMessages = buildPromptMessagesFromSnapshot(
        entry.conversationId,
        entry.promptUserMessage,
        entry.promptSnapshotMessageIds
      );
      if (typeof entry.onInvocationStarting === 'function') {
        await entry.onInvocationStarting({
          invocationId: entry.toolInvocationId,
          conversationId: entry.conversationId,
          targetAgentId: entry.targetAgentId,
          targetMessageId: entry.acceptedMessage.id,
        });
      }
      const result = await baseExecuteConversationAgent({
        runStore,
        conversationId: entry.conversationId,
        turnId: slotState.turnId,
        rootTaskId,
        conversation,
        projectDir: entry.projectDirSnapshot,
        promptMessages,
        promptUserMessage: entry.promptUserMessage,
        queueItem: {
          agentId: agent.id,
          triggerType: entry.triggerType || 'user',
          triggeredByAgentId: entry.triggeredByAgentId || null,
          triggeredByAgentName: entry.triggeredByAgentName || 'You',
          triggeredByMessageId: entry.acceptedMessage.id,
          parentRunId: null,
          enqueueReason: entry.enqueueReason || 'user_mentions',
          privateOnly: Boolean(entry.acceptedMessage && entry.acceptedMessage.metadata && entry.acceptedMessage.metadata.privateOnly),
          crossConversationDeliveryId: entry.crossConversationDeliveryId || null,
          toolInvocationId: entry.toolInvocationId || null,
        },
        agent,
        turnState: slotState,
        completedReplies,
        failedReplies,
        routingMode: entry.routingMode || 'mention_queue',
        hop: 1,
        remainingSlots: 0,
        enqueueAgent: null,
        allowHandoffs: false,
        finalStopsTurn: false,
      });
      const finishedAt = nowIso();
      slotState.status =
        result && result.terminationReason === 'stopped_by_user'
          ? 'stopped'
          : completedReplies.length > 0
            ? 'completed'
            : failedReplies.length > 0
              ? 'failed'
              : slotState.stopRequested
                ? 'stopped'
                : 'completed';
      slotState.endedAt = finishedAt;
      slotState.updatedAt = finishedAt;
      slotState.currentAgentId = null;
      syncCurrentTurnAgent(slotState);

      runStore.updateTask(rootTaskId, {
        status:
          slotState.status === 'stopped' ? 'cancelled' : completedReplies.length > 0 ? 'succeeded' : failedReplies.length > 0 ? 'failed' : 'succeeded',
        outputText: completedReplies.map((message: any) => `${message.senderName}: ${message.content}`).join('\n\n'),
        errorMessage:
          slotState.status === 'stopped'
            ? slotState.stopReason || 'Stopped by user'
            : completedReplies.length > 0
              ? null
              : failedReplies[0] && failedReplies[0].errorMessage
                ? failedReplies[0].errorMessage
                : null,
        endedAt: finishedAt,
        artifactSummary: {
          completedAgentIds: completedReplies.map((message: any) => message.agentId),
          failedAgentIds: failedReplies.map((message: any) => message.agentId),
          dispatchLane: 'side',
          sourceMessageId: entry.acceptedMessage.id,
        },
      });
      runStore.appendTaskEvent(rootTaskId, 'conversation_side_dispatch_finished', {
        conversationId: entry.conversationId,
        turnId: slotState.turnId,
        agentId: agent.id,
        completedCount: completedReplies.length,
        failedCount: failedReplies.length,
      });

      emitAgentSlotFinished(
        slotState,
        failedReplies.map((message: any) => ({
          agentId: message.agentId,
          senderName: message.senderName,
          errorMessage: message.errorMessage,
        }))
      );
      return {
        status: slotState.status,
        replyMessage: completedReplies[0] || null,
        completedReplies,
        failedReplies,
      };
    } catch (error) {
      const errorValue = error as any;
      const finishedAt = nowIso();

      if (slotState) {
        slotState.status = slotState && slotState.stopRequested ? 'stopped' : 'failed';
        slotState.endedAt = finishedAt;
        slotState.updatedAt = finishedAt;
        slotState.currentAgentId = null;
        syncCurrentTurnAgent(slotState);
      }

      if (runStore && rootTaskId) {
        runStore.updateTask(rootTaskId, {
          status: slotState && slotState.stopRequested ? 'cancelled' : 'failed',
          errorMessage: errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown side dispatch error'),
          endedAt: finishedAt,
        });
      }

      emitAgentSlotFinished(
        slotState || {
          slotId: `${entry.conversationId}:${entry.targetAgentId}`,
          conversationId: entry.conversationId,
          conversationTitle: entry.conversationTitle || '',
          turnId: '',
          sourceMessageId: entry.acceptedMessage && entry.acceptedMessage.id ? entry.acceptedMessage.id : null,
          status: 'failed',
          updatedAt: finishedAt,
          endedAt: finishedAt,
          agents: [],
        },
        [
          {
            agentId: entry.targetAgentId || null,
            senderName: 'system',
            errorMessage: errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown side dispatch error'),
          },
        ]
      );
      console.error(
        `[turn-orchestrator] Side dispatch failed for ${entry.conversationId}/${entry.targetAgentId}: ${
          errorValue && errorValue.stack ? errorValue.stack : errorValue
        }`
      );
      if (entry.propagateError) {
        throw error;
      }
      return {
        status: slotState && slotState.status ? slotState.status : 'failed',
        replyMessage: null,
        completedReplies,
        failedReplies,
      };
    } finally {
      if (slotState && slotState.slotId) {
        activeAgentSlots.delete(slotState.slotId);
      }

      if (runStore) {
        runStore.close();
      }

      if (grant && typeof grant.release === 'function') {
        grant.release();
      }

      broadcastRuntimeState();
      drainConversationQueue(entry.conversationId);
    }
  }

  function buildSideDispatchEntry(conversation: any, turnInput: any, acceptedMessage: any, sideTarget: any, options: any = {}) {
    const conversationId = conversation.id;
    const snapshotConversation = store.getConversation(conversationId) || conversation;
    const promptUserMessage =
      options.promptUserMessage || {
        ...cloneMessageSnapshot(acceptedMessage),
        content: sideTarget.cleanedContent || acceptedMessage.content,
      };
    const promptSnapshotMessageIds = Array.isArray(options.promptSnapshotMessageIds)
      ? options.promptSnapshotMessageIds.map((messageId: any) => String(messageId || '').trim()).filter(Boolean)
      : Array.from(
          buildPromptSnapshotMessageIds(
            Array.isArray(snapshotConversation && snapshotConversation.messages) ? snapshotConversation.messages : []
          )
        );

    return {
      conversationId,
      conversationTitle: conversation.title,
      targetAgentId: sideTarget.targetAgentId,
      explicitIntent: sideTarget.explicitIntent || '',
      acceptedMessage: cloneMessageSnapshot(acceptedMessage),
      promptUserMessage: cloneMessageSnapshot(promptUserMessage),
      promptSnapshotMessageIds,
      projectDirSnapshot:
        options.projectDirSnapshot !== undefined
          ? String(options.projectDirSnapshot || '').trim()
          : getProjectDir
            ? String(getProjectDir(snapshotConversation) || '').trim()
            : '',
      metadata: turnInput && turnInput.metadata,
    };
  }

  function startSideDispatch(entry: any) {
    const conversationId = entry.conversationId;
    markSideDispatchMessage(conversationId, entry.acceptedMessage.id);

    let resolveExecution = null as any;
    let rejectExecution = null as any;
    const executionPromise = new Promise((resolve, reject) => {
      resolveExecution = resolve;
      rejectExecution = reject;
    });
    void executionPromise.catch(() => {});

    const slotRequest = agentSlotRegistry.requestSlot({
      conversationId,
      agentId: entry.targetAgentId,
      lane: 'side',
      onGranted(grant: any) {
        const runPromise = runSideDispatch(entry, grant);
        void runPromise.then(resolveExecution, rejectExecution);
        return runPromise;
      },
    });
    void slotRequest.promise.catch(rejectExecution);

    if (slotRequest.queued) {
      const queuedSideDispatch = {
        requestId: String(slotRequest.waiterId || entry.acceptedMessage.id || '').trim(),
        conversationId,
        targetAgentId: entry.targetAgentId,
        sourceMessageId: entry.acceptedMessage.id,
        cancel(reason: any) {
          return slotRequest.cancel(reason || 'Stopped by user');
        },
      };
      trackQueuedSideDispatch(conversationId, queuedSideDispatch);
      void slotRequest.promise.then(
        () => {
          untrackQueuedSideDispatch(conversationId, queuedSideDispatch.requestId);
        },
        (error: any) => {
          untrackQueuedSideDispatch(conversationId, queuedSideDispatch.requestId);

          if (!error || error.code === 'AGENT_SLOT_REQUEST_CANCELLED') {
            return;
          }

          console.error(
            `[turn-orchestrator] Side dispatch slot wait failed for ${conversationId}/${entry.targetAgentId}: ${
              error && error.stack ? error.stack : error
            }`
          );
        }
      );
      broadcastRuntimeState();
    }

    return {
      ...slotRequest,
      executionPromise,
    };
  }

  function submitSideDispatch(conversation: any, turnInput: any, acceptedMessage: any, sideTarget: any, options: any = {}) {
    const entry = buildSideDispatchEntry(conversation, turnInput, acceptedMessage, sideTarget, options);
    const slotRequest = startSideDispatch(entry);

    return {
      dispatch: slotRequest.queued ? 'queued' : 'started',
      dispatchLane: 'side',
      dispatchTargetAgentId: entry.targetAgentId,
    };
  }

  async function dispatchCrossConversationDelivery(input: any = {}) {
    const delivery = input.delivery;
    const targetMessage = input.targetMessage;
    const conversation = delivery
      ? store.getConversation(delivery.targetConversationId)
      : null;
    const targetAgent = conversation && delivery
      ? getAgentById(conversation.agents, delivery.targetAgentId)
      : null;

    if (!delivery || !targetMessage || !conversation || !targetAgent) {
      throw createHttpError(404, 'Cross-conversation delivery target is unavailable');
    }
    if (targetMessage.id !== delivery.targetMessageId || targetMessage.conversationId !== delivery.targetConversationId) {
      throw createHttpError(409, 'Cross-conversation delivery target message does not match persisted intent');
    }

    const deliveryImageBlocks = Array.isArray(targetMessage.contentBlocks)
      ? targetMessage.contentBlocks.filter((block: any) => block && block.type === 'image')
      : [];
    if (deliveryImageBlocks.length > 0) {
      throw createHttpError(
        422,
        '跨会话消息投递暂不支持图片：图片不剥离、不降级，请改用文本或直接在当前会话发送图片。',
        {
          code: 'IMAGE_DELIVERY_NOT_SUPPORTED',
          issues: [{
            code: 'IMAGE_DELIVERY_NOT_SUPPORTED',
            path: 'targetMessage.contentBlocks',
            imageCount: deliveryImageBlocks.length,
          }],
        }
      );
    }

    const crossConversation = targetMessage.metadata && targetMessage.metadata.crossConversation
      && typeof targetMessage.metadata.crossConversation === 'object'
      ? targetMessage.metadata.crossConversation
      : {};
    const sideTarget = {
      targetAgentId: delivery.targetAgentId,
      cleanedContent: targetMessage.content,
      explicitIntent: delivery.kind,
    };
    const entry: any = buildSideDispatchEntry(
      conversation,
      { content: targetMessage.content, metadata: targetMessage.metadata },
      targetMessage,
      sideTarget,
      {
        promptUserMessage: targetMessage,
        promptSnapshotMessageIds: Array.from(
          buildPromptSnapshotMessageIdsThroughMessage(conversation.id, targetMessage.id)
        ),
      }
    );
    const isBootstrap = delivery.kind === 'bootstrap';
    entry.crossConversationDeliveryId = delivery.id;
    entry.toolInvocationId = randomUUID();
    entry.triggerType = isBootstrap ? 'user' : 'external_agent';
    entry.triggeredByAgentId = isBootstrap ? null : delivery.sourceAgentId || null;
    entry.triggeredByAgentName = isBootstrap ? 'You' : delivery.sourceAgentName || 'External Agent';
    entry.enqueueReason = isBootstrap ? 'conversation_spawn_bootstrap' : 'cross_conversation_delivery';
    entry.routingMode = 'cross_conversation';
    entry.entryStrategy = isBootstrap ? 'conversation_spawn_bootstrap' : 'cross_conversation_delivery';
    entry.propagateError = true;
    entry.onInvocationStarting = input.onInvocationStarting;
    entry.sourceConversationId = crossConversation.sourceConversationId || delivery.sourceConversationId;

    const slotRequest = startSideDispatch(entry);
    return slotRequest.executionPromise;
  }

  function requestStopCrossConversationDelivery(delivery: any, reason: any = 'Cancelled by operator') {
    const conversationId = String(delivery && delivery.targetConversationId || '').trim();
    const targetMessageId = String(delivery && delivery.targetMessageId || '').trim();
    const stopReason = String(reason || 'Cancelled by operator').trim() || 'Cancelled by operator';
    let stopped = false;

    for (const queuedSideDispatch of listQueuedSideDispatches(conversationId)) {
      if (!queuedSideDispatch || queuedSideDispatch.sourceMessageId !== targetMessageId) {
        continue;
      }
      try {
        stopped = queuedSideDispatch.cancel(stopReason) || stopped;
      } catch {}
      untrackQueuedSideDispatch(conversationId, queuedSideDispatch.requestId);
    }

    for (const slotState of listConversationActiveAgentSlots(conversationId)) {
      if (!slotState || slotState.sourceMessageId !== targetMessageId) {
        continue;
      }
      slotState.stopRequested = true;
      slotState.stopReason = stopReason;
      slotState.stopRequestedAt = nowIso();
      slotState.status = 'stopping';
      const handles = slotState.runHandles instanceof Set ? (Array.from(slotState.runHandles) as any[]) : [];
      for (const handle of handles) {
        if (!handle || typeof handle.cancel !== 'function') {
          continue;
        }
        try {
          handle.cancel(stopReason);
          stopped = true;
        } catch {}
      }
      slotState.updatedAt = nowIso();
      syncCurrentTurnAgent(slotState);
      emitTurnProgress(slotState);
    }

    if (stopped) {
      broadcastRuntimeState();
    }
    return stopped;
  }

  function recoverPersistedSideDispatches() {
    const listedConversations = store && typeof store.listConversations === 'function' ? store.listConversations() : [];
    const conversationSummaries = Array.isArray(listedConversations) ? listedConversations : [];

    for (const summary of conversationSummaries) {
      const conversationId = String(summary && summary.id ? summary.id : '').trim();
      const conversation = conversationId ? store.getConversation(conversationId) : null;

      if (!conversation || !Array.isArray(conversation.messages)) {
        continue;
      }

      for (const message of conversation.messages) {
        if (!message || message.role !== 'user' || !isSideDispatchMessage(conversationId, message.id, message)) {
          continue;
        }

        const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;

        if (metadata && (metadata.dispatchCancelled === true || String(metadata.dispatchCancelledAt || '').trim())) {
          markStaleSideDispatchReplyMessages(conversationId, message.id);
          continue;
        }

        const sideTarget = resolvePersistedSideDispatchTarget(conversation, message);

        if (!sideTarget) {
          continue;
        }

        const replyMessages = listSideDispatchReplyMessages(conversationId, message.id);

        if (replyMessages.some((replyMessage: any) => isTerminalMessageStatus(replyMessage))) {
          markSideDispatchMessage(conversationId, message.id);
          continue;
        }

        markStaleSideDispatchReplyMessages(conversationId, message.id);
        submitSideDispatch(
          conversation,
          { metadata },
          message,
          sideTarget,
          {
            promptSnapshotMessageIds: buildPromptSnapshotMessageIdsThroughMessage(conversationId, message.id),
            projectDirSnapshot: getProjectDir ? String(getProjectDir(conversation) || '').trim() : '',
          }
        );
      }
    }
  }

  function submitConversationMessage(conversationId: any, input: any) {
    const storedConversation = store.getConversation(conversationId);

    if (!storedConversation) {
      throw createHttpError(404, 'Conversation not found');
    }

    const turnInput = normalizeConversationTurnInput(input, storedConversation);

    if (!turnInput.content && (!Array.isArray(turnInput.imageIds) || turnInput.imageIds.length === 0)) {
      throw createHttpError(400, 'Message content is required');
    }

    if (!Array.isArray(storedConversation.agents) || storedConversation.agents.length === 0) {
      throw createHttpError(400, 'Add at least one agent to the conversation first');
    }

    const conversation = {
      ...storedConversation,
      agents: resolveRuntimeParticipants(storedConversation.agents),
    };

    const initialTargetResolution = resolveInitialTurnTargets(turnInput, conversation);
    const sideTarget = resolveSideDispatchTarget(conversation, turnInput);
    const conversationBusy = shouldAllowSideDispatch(conversationId);
    const shouldSideDispatch = Boolean(sideTarget && conversationBusy);
    const shouldDeferDefaultImagePreflight = Boolean(
      conversationBusy
      && (initialTargetResolution.strategy === 'default_last_agent'
        || initialTargetResolution.strategy === 'default_first_agent')
    );

    if (
      Array.isArray(turnInput.imageIds)
      && turnInput.imageIds.length > 0
      && !shouldDeferDefaultImagePreflight
    ) {
      assertImagePreflightForTargets(turnInput, conversation, {
        modelCatalog,
        targetResolution: initialTargetResolution,
      });
    }

    ensureQueueState(conversationId);

    let dispatchResult = null as any;
    const acceptedMessage = store.createMessage(
      createAcceptedMessagePayload(conversationId, {
        ...turnInput,
        metadata: shouldSideDispatch
          ? {
              ...turnInput.metadata,
              dispatchLane: 'side',
              dispatchTargetAgentId: sideTarget ? sideTarget.targetAgentId : null,
            }
          : turnInput.metadata,
      })
    );

    broadcastEvent('conversation_message_created', {
      conversationId,
      message: acceptedMessage,
    });
    broadcastConversationSummary(conversationId);

    if (shouldSideDispatch) {
      dispatchResult = submitSideDispatch(conversation, turnInput, acceptedMessage, sideTarget);
    } else {
      const started = drainConversationQueue(conversationId);

      if (!started) {
        syncConversationQueueProgress(conversationId);
      }

      dispatchResult = {
        dispatch: started ? 'started' : 'queued',
        dispatchLane: 'main',
        dispatchTargetAgentId: null,
      };
    }

    return {
      acceptedMessage,
      conversation: store.getConversation(conversationId),
      conversations: store.listConversations(),
      dispatch: dispatchResult.dispatch,
      dispatchLane: dispatchResult.dispatchLane,
      dispatchTargetAgentId: dispatchResult.dispatchTargetAgentId,
      runtime: buildRuntimePayload(),
    };
  }

  function requestStopConversationExecution(conversationId: any, reason: any = 'Stopped by user') {
    const normalizedConversationId = String(conversationId || '').trim();
    const mainTurn = activeTurns.get(normalizedConversationId) || null;
    const slotStates = listConversationActiveAgentSlots(normalizedConversationId);
    const queuedSideDispatchEntries = listQueuedSideDispatches(normalizedConversationId);

    if (!mainTurn && slotStates.length === 0 && queuedSideDispatchEntries.length === 0) {
      throw createHttpError(409, 'This conversation is not processing a turn');
    }

    const stopReason = String(reason || 'Stopped by user').trim() || 'Stopped by user';
    const turn = mainTurn ? requestStopMainTurn(normalizedConversationId, stopReason) : null;
    const agentSlots = [];
    let cancelledQueuedSideDispatchCount = 0;

    for (const queuedSideDispatch of queuedSideDispatchEntries) {
      if (!queuedSideDispatch || typeof queuedSideDispatch.cancel !== 'function') {
        continue;
      }

      try {
        if (queuedSideDispatch.cancel(stopReason)) {
          cancelledQueuedSideDispatchCount += 1;
          markSideDispatchCancelled(normalizedConversationId, queuedSideDispatch.sourceMessageId, stopReason);
          untrackQueuedSideDispatch(normalizedConversationId, queuedSideDispatch.requestId);
        }
      } catch {}
    }

    for (const slotState of slotStates) {
      if (!slotState.stopRequested) {
        slotState.stopRequested = true;
        slotState.stopReason = stopReason;
        slotState.stopRequestedAt = nowIso();
        slotState.status = 'stopping';
      }

      markSideDispatchCancelled(normalizedConversationId, slotState.sourceMessageId, stopReason);

      const handles = slotState.runHandles instanceof Set ? (Array.from(slotState.runHandles) as any[]) : [];

      for (const handle of handles) {
        if (!handle || typeof handle.cancel !== 'function') {
          continue;
        }

        try {
          handle.cancel(stopReason);
        } catch {}
      }

      slotState.updatedAt = nowIso();
      syncCurrentTurnAgent(slotState);
      emitTurnProgress(slotState);
      agentSlots.push(summarizeAgentSlotState(slotState));
    }

    if (slotStates.length > 0 || cancelledQueuedSideDispatchCount > 0) {
      broadcastRuntimeState();
    }

    return {
      turn,
      agentSlots,
      cancelledQueuedSideDispatchCount,
    };
  }

  function clearConversationState(conversationId: any) {
    activeConversationIds.delete(conversationId);
    activeTurns.delete(conversationId);
    queueStates.delete(conversationId);
    dispatchingConversationIds.delete(conversationId);

    for (const [slotId, slotState] of Array.from(activeAgentSlots.entries())) {
      if (slotState && slotState.conversationId === conversationId) {
        activeAgentSlots.delete(slotId);
      }
    }

    sideDispatchMessageIds.delete(conversationId);
    queuedSideDispatches.delete(conversationId);
    agentSlotRegistry.clearConversation(conversationId);
  }

  function listTurnSummaries(options: any = {}) {
    const conversationId = String(options.conversationId || '').trim();

    return Array.from(activeTurns.values())
      .filter((turnState) => !conversationId || turnState.conversationId === conversationId)
      .map(summarizeTurnState);
  }

  function listAgentSlotSummaries(options: any = {}) {
    const conversationId = String(options.conversationId || '').trim();

    return Array.from(activeAgentSlots.values())
      .filter((turnState) => !conversationId || turnState.conversationId === conversationId)
      .map(summarizeAgentSlotState);
  }

  // P1 observability: lightweight size probes over the internal lifecycle maps.
  // The queue-state sweep reuses buildConversationQueueSnapshot's existing
  // settlement logic so a queue that finished draining is not reported as
  // active just because nothing rebuilt the runtime payload since. Queues
  // with pending failures stay visible on purpose; clearConversationState
  // remains the authoritative cleanup path.
  function getRuntimeStats() {
    buildConversationQueueSnapshot();

    return {
      activeTurns: activeTurns.size,
      activeQueues: queueStates.size,
      activeAgentSlots: activeAgentSlots.size,
    };
  }

  recoverPersistedQueueStates();
  recoverPersistedSideDispatches();

  return {
    buildRuntimePayload,
    clearConversationState,
    dispatchCrossConversationDelivery,
    emitTurnProgress,
    getConversationMutationState,
    getConversationQueueDepth,
    getRuntimeStats,
    listAgentSlotSummaries,
    listTurnSummaries,
    reconcileConversationQueueAfterMessageDeletion,
    requestStopConversationExecution,
    requestStopCrossConversationDelivery,
    requestStopConversationTurn: requestStopMainTurn,
    resolveAssistantMessageSessionPath: sessionExporter.resolveAssistantMessageSessionPath,
    runConversationTurn,
    scheduleGoalContinuation,
    submitConversationMessage,
    summarizeTurnState,
    syncCurrentTurnAgent,
  };
}

export { buildAgentTurnPrompt, sanitizePromptMentions };
