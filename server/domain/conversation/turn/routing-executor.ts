const { randomUUID } = require('node:crypto');
const { createSqliteRunStore } = require('../../../../lib/sqlite-store');
const { createHttpError } = require('../../../http/http-errors');
const {
  buildAgentMentionLookup,
  extractMentionedAgentIds,
  getAgentById,
  resolveTurnExecutionMode,
} = require('../mention-routing');
const {
  createTurnState,
  getTurnStage,
  nowIso,
  resetTurnStage,
  summarizeTurnState,
  syncCurrentTurnAgent,
} = require('./turn-state');
const { buildPromptMessages, buildPromptSnapshotMessageIds, isPrivateOnlyMessage } = require('./prompt-visibility');

const MAX_PARALLEL_MENTION_BATCH_SIZE = 5;

function createTaskId(prefix = 'task') {
  return `${prefix}-${randomUUID()}`;
}


export function normalizeConversationTurnInput(input: any, conversation: any) {
  const payload =
    input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : {
          content: input,
        };
  const content = String(payload.content || '').trim();
  const role = String(payload.role || 'user').trim() || 'user';
  const defaultSenderName = role === 'user' ? 'You' : role === 'assistant' ? 'Assistant' : 'System';
  const senderName = String(payload.senderName || '').trim() || defaultSenderName;
  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? {
          ...payload.metadata,
        }
      : {};
  const knownAgentIds = new Set(
    (Array.isArray(conversation && conversation.agents) ? conversation.agents : []).map((agent: any) => agent.id)
  );
  const initialAgentIds = [];
  const seenInitialAgentIds = new Set();

  for (const agentId of Array.isArray(payload.initialAgentIds) ? payload.initialAgentIds : []) {
    const normalizedAgentId = String(agentId || '').trim();

    if (!normalizedAgentId || seenInitialAgentIds.has(normalizedAgentId) || !knownAgentIds.has(normalizedAgentId)) {
      continue;
    }

    seenInitialAgentIds.add(normalizedAgentId);
    initialAgentIds.push(normalizedAgentId);
  }

  metadata.source = String(metadata.source || payload.source || 'web-ui').trim() || 'web-ui';

  return {
    content,
    role,
    senderName,
    metadata,
    initialAgentIds,
    executionMode: payload.executionMode === 'parallel' ? 'parallel' : 'queue',
    allowHandoffs: payload.allowHandoffs !== false,
    entryStrategy: String(payload.entryStrategy || '').trim() || 'directed',
    explicitIntent: Boolean(payload.explicitIntent),
    privateOnly: Boolean(payload.privateOnly),
    cleanedContent: String(payload.cleanedContent || content).trim() || content,
  };
}

function buildBatchedPromptContent(batchMessages: any) {
  return (Array.isArray(batchMessages) ? batchMessages : [])
    .map((message: any) => String(message && message.content ? message.content : '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function resolveExistingBatchMessages(conversation: any, batchMessageIds: any) {
  const messages = Array.isArray(conversation && conversation.messages) ? conversation.messages : [];
  const byId = new Map(messages.map((message: any) => [String(message && message.id ? message.id : ''), message]));

  return (Array.isArray(batchMessageIds) ? batchMessageIds : [])
    .map((messageId: any) => byId.get(String(messageId || '').trim()) || null)
    .filter((message: any) => message && message.role === 'user');
}

function resolveInitialSpeakerQueue(userText: any, agents: any) {
  const lookup = buildAgentMentionLookup(agents);
  const mentionedAgentIds = extractMentionedAgentIds(userText, agents, {
    lookup,
    limit: Array.isArray(agents) ? agents.length : 0,
  });
  const agentIds = mentionedAgentIds.length > 0 ? mentionedAgentIds : agents[0] ? [agents[0].id] : [];
  const execution = resolveTurnExecutionMode(userText, agentIds.length);

  if (mentionedAgentIds.length > 0) {
    return {
      agentIds,
      strategy: 'user_mentions',
      executionMode: execution.mode,
      explicitIntent: execution.explicitIntent,
      privateOnly: false,
      cleanedUserText: execution.cleanedText,
    };
  }

  return {
    agentIds,
    strategy: 'default_first_agent',
    executionMode: execution.mode,
    explicitIntent: execution.explicitIntent,
    privateOnly: false,
    cleanedUserText: execution.cleanedText,
  };
}

export function createRoutingExecutor(options: any = {}) {
  const store = options.store;
  const executeConversationAgent = options.executeConversationAgent;
  const getProjectDir = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const broadcastConversationSummary =
    typeof options.broadcastConversationSummary === 'function' ? options.broadcastConversationSummary : () => {};
  const broadcastRuntimeState = typeof options.broadcastRuntimeState === 'function' ? options.broadcastRuntimeState : () => {};
  const emitTurnProgress = typeof options.emitTurnProgress === 'function' ? options.emitTurnProgress : () => {};
  const agentDir = options.agentDir;
  const sqlitePath = options.sqlitePath;
  const activeConversationIds = options.activeConversationIds;
  const activeTurns = options.activeTurns;

  async function runConversationTurn(conversationId: any, userContent: any) {
    const conversation = store.getConversation(conversationId);

    if (!conversation) {
      throw createHttpError(404, 'Conversation not found');
    }

    if (activeConversationIds.has(conversationId)) {
      throw createHttpError(409, 'This conversation is already processing another turn');
    }

    const usesExistingBatch = Boolean(
      userContent &&
        typeof userContent === 'object' &&
        !Array.isArray(userContent) &&
        Array.isArray(userContent.batchMessageIds) &&
        userContent.batchMessageIds.length > 0
    );
    let turnInput = null as any;
    let userMessage = null as any;
    let batchMessages = [] as any[];
    let promptUserMessage = null as any;
    let promptSnapshotMessageIds = new Set();
    let inputText = '';
    let shouldBroadcastUserMessageCreated = false;

    if (usesExistingBatch) {
      batchMessages = resolveExistingBatchMessages(conversation, userContent.batchMessageIds);

      if (batchMessages.length === 0) {
        throw createHttpError(400, 'No queued user messages are available for this batch');
      }

      inputText = buildBatchedPromptContent(batchMessages);
      const anchorMessage = batchMessages[batchMessages.length - 1];
      turnInput = normalizeConversationTurnInput(
        {
          ...(userContent && typeof userContent === 'object' ? userContent : {}),
          content: inputText,
          role: anchorMessage.role || 'user',
          senderName: anchorMessage.senderName || 'You',
          metadata: anchorMessage.metadata,
          privateOnly: batchMessages.some((message: any) => isPrivateOnlyMessage(message)),
        },
        conversation
      );
      userMessage = anchorMessage;
    } else {
      turnInput = normalizeConversationTurnInput(userContent, conversation);
      inputText = turnInput.content;
    }

    if (!turnInput.content) {
      throw createHttpError(400, 'Message content is required');
    }

    if (!Array.isArray(conversation.agents) || conversation.agents.length === 0) {
      throw createHttpError(400, 'Add at least one agent to the conversation first');
    }

    const projectDirSnapshot = getProjectDir ? getProjectDir(conversation) : '';
    const runStore = createSqliteRunStore({ agentDir, sqlitePath });
    const turnId = randomUUID();
    const turnState = createTurnState(conversation, turnId);
    let cleanedUp = false;

    function cleanupActiveTurn() {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      activeConversationIds.delete(conversationId);
      if (turnState.runHandles instanceof Set) {
        turnState.runHandles.clear();
      }
      activeTurns.delete(conversationId);
      broadcastRuntimeState();
    }

    activeConversationIds.add(conversationId);
    activeTurns.set(conversationId, turnState);
    broadcastRuntimeState();
    emitTurnProgress(turnState);

    if (!usesExistingBatch) {
      userMessage = store.createMessage({
        conversationId,
        turnId,
        role: turnInput.role,
        senderName: turnInput.senderName,
        content: turnInput.content,
        status: 'completed',
        metadata: turnInput.privateOnly ? { ...turnInput.metadata, privateOnly: true } : turnInput.metadata,
      });
      shouldBroadcastUserMessageCreated = true;
      batchMessages = [userMessage];
    }

    const initialQueue =
      turnInput.initialAgentIds.length > 0
        ? {
            agentIds: turnInput.initialAgentIds.slice(),
            strategy: turnInput.entryStrategy,
            executionMode: turnInput.executionMode,
            explicitIntent: turnInput.explicitIntent,
            privateOnly: turnInput.privateOnly,
            cleanedUserText: turnInput.cleanedContent,
          }
        : resolveInitialSpeakerQueue(turnInput.cleanedContent || turnInput.content || userMessage.content, conversation.agents);

    promptUserMessage = {
      ...userMessage,
      content: initialQueue.cleanedUserText || turnInput.cleanedContent || turnInput.content || userMessage.content,
    };
    const initialPromptMessages = store.getConversation(conversationId).messages;
    promptSnapshotMessageIds = buildPromptSnapshotMessageIds(initialPromptMessages);
    const basePromptMessages = buildPromptMessages(initialPromptMessages, promptUserMessage, {
      snapshotMessageIds: promptSnapshotMessageIds,
      currentTurnId: turnId,
      replacePromptUserMessage: !usesExistingBatch,
    });
    const routingMode = initialQueue.executionMode === 'parallel' ? 'mention_parallel' : 'mention_queue';
    turnState.userMessageId = userMessage.id;
    turnState.batchStartMessageId = batchMessages[0] ? batchMessages[0].id : userMessage.id;
    turnState.batchEndMessageId = batchMessages[batchMessages.length - 1]
      ? batchMessages[batchMessages.length - 1].id
      : userMessage.id;
    turnState.consumedUpToMessageId = turnState.batchEndMessageId;
    turnState.inputMessageCount = batchMessages.length > 0 ? batchMessages.length : 1;
    turnState.queueDepth = 0;
    turnState.entryAgentIds = initialQueue.agentIds.slice();
    turnState.routingMode = routingMode;
    turnState.updatedAt = nowIso();

    if (shouldBroadcastUserMessageCreated) {
      broadcastEvent('conversation_message_created', {
        conversationId,
        message: userMessage,
      });
      broadcastConversationSummary(conversationId);
    }

    emitTurnProgress(turnState);

    const rootTaskId = createTaskId('conversation-turn');
    const completedReplies: any[] = [];
    const failedReplies: any[] = [];

    runStore.createTask({
      taskId: rootTaskId,
      kind: 'conversation_turn',
      title: `Conversation turn for ${conversation.title}`,
      status: 'running',
      inputText: inputText,
      metadata: {
        conversationId,
        turnId,
        participantAgentIds: conversation.agents.map((agent: any) => agent.id),
        routingMode,
        entryAgentIds: initialQueue.agentIds.slice(),
        entryStrategy: initialQueue.strategy,
        entryExecutionMode: initialQueue.executionMode,
        explicitIntent: initialQueue.explicitIntent,
      },
      startedAt: nowIso(),
    });
    runStore.appendTaskEvent(rootTaskId, 'conversation_turn_started', {
      conversationId,
      turnId,
      agentCount: conversation.agents.length,
      routingMode,
      entryAgentIds: initialQueue.agentIds.slice(),
      entryStrategy: initialQueue.strategy,
      entryExecutionMode: initialQueue.executionMode,
      explicitIntent: initialQueue.explicitIntent,
    });

    try {
      const queue: any[] = [];
      const queuedAgentIds = new Set();
      const maxReplies = Math.max(8, conversation.agents.length * 4);
      let terminationReason = 'queue_exhausted';

      function splitIntoMentionBatches(agentIds: any) {
        const batches = [];

        for (let index = 0; index < agentIds.length; index += MAX_PARALLEL_MENTION_BATCH_SIZE) {
          batches.push(agentIds.slice(index, index + MAX_PARALLEL_MENTION_BATCH_SIZE));
        }

        return batches;
      }

      function queueEntryItems(queueEntry: any) {
        if (!queueEntry) {
          return [];
        }

        return Array.isArray(queueEntry.items) ? queueEntry.items.filter(Boolean) : [queueEntry];
      }

      function queuePendingAgentIds() {
        return queue.flatMap((queueEntry: any) =>
          queueEntryItems(queueEntry)
            .map((item: any) => item.agentId)
            .filter(Boolean)
        );
      }

      function refreshParallelGroupMetadata(items: any) {
        const normalizedItems = Array.isArray(items) ? items.filter(Boolean) : [];
        const groupSize = normalizedItems.length;

        for (let index = 0; index < normalizedItems.length; index += 1) {
          normalizedItems[index].parallelGroupSize = groupSize;
          normalizedItems[index].parallelGroupIndex = groupSize > 1 ? index + 1 : 0;
        }

        return normalizedItems;
      }

      function canMergeQueuedPrivateBatch(queueEntry: any, queueItem: any) {
        const items = queueEntryItems(queueEntry);

        if (items.length === 0 || items.length >= MAX_PARALLEL_MENTION_BATCH_SIZE) {
          return false;
        }

        if (String(queueItem && queueItem.triggerType ? queueItem.triggerType : 'user') !== 'private') {
          return false;
        }

        return items.every(
          (item: any) =>
            String(item && item.triggerType ? item.triggerType : 'user') === 'private' &&
            String(item && item.triggeredByAgentId ? item.triggeredByAgentId : '') ===
              String(queueItem && queueItem.triggeredByAgentId ? queueItem.triggeredByAgentId : '') &&
            String(item && item.triggeredByAgentName ? item.triggeredByAgentName : '') ===
              String(queueItem && queueItem.triggeredByAgentName ? queueItem.triggeredByAgentName : '') &&
            String(item && item.parentRunId ? item.parentRunId : '') ===
              String(queueItem && queueItem.parentRunId ? queueItem.parentRunId : '') &&
            String(item && item.enqueueReason ? item.enqueueReason : '') ===
              String(queueItem && queueItem.enqueueReason ? queueItem.enqueueReason : '')
        );
      }

      function enqueueAgent(queueItem: any) {
        if (!queueItem || turnState.stopRequested) {
          return [];
        }

        const requestedAgentIds = Array.isArray(queueItem.agentIds)
          ? queueItem.agentIds.filter(Boolean)
          : queueItem.agentId
            ? [queueItem.agentId]
            : [];

        if (requestedAgentIds.length === 0) {
          return [];
        }

        const uniqueAgentIds = [];
        const seen = new Set();

        for (const agentId of requestedAgentIds) {
          if (!agentId || seen.has(agentId) || queuedAgentIds.has(agentId)) {
            continue;
          }

          seen.add(agentId);
          uniqueAgentIds.push(agentId);
        }

        if (uniqueAgentIds.length === 0) {
          return [];
        }

        for (const batchAgentIds of splitIntoMentionBatches(uniqueAgentIds)) {
          const batchItems = refreshParallelGroupMetadata(
            batchAgentIds.map((agentId: any) => ({
              agentId,
              triggerType: queueItem.triggerType || 'user',
              triggeredByAgentId: queueItem.triggeredByAgentId || null,
              triggeredByAgentName: queueItem.triggeredByAgentName || '',
              triggeredByMessageId: queueItem.triggeredByMessageId || null,
              parentRunId: queueItem.parentRunId || null,
              enqueueReason: queueItem.enqueueReason || '',
              parallelGroupSize: 0,
              parallelGroupIndex: 0,
              privateOnly: Boolean(queueItem.privateOnly),
            }))
          );

          const lastQueueEntry = queue.length > 0 ? queue[queue.length - 1] : null;

          if (batchItems.length === 1 && canMergeQueuedPrivateBatch(lastQueueEntry, batchItems[0])) {
            const mergedItems = refreshParallelGroupMetadata([...queueEntryItems(lastQueueEntry), batchItems[0]]);

            if (lastQueueEntry && Array.isArray(lastQueueEntry.items)) {
              lastQueueEntry.items = mergedItems;
            } else {
              queue[queue.length - 1] = { items: mergedItems };
            }
          } else {
            queue.push(batchItems.length > 1 ? { items: batchItems } : batchItems[0]);
          }

          for (const batchItem of batchItems) {
            queuedAgentIds.add(batchItem.agentId);

            const stage = getTurnStage(turnState, batchItem.agentId);

            if (stage) {
              resetTurnStage(stage, 'queued');
            }
          }
        }

        turnState.pendingAgentIds = queuePendingAgentIds();
        turnState.updatedAt = nowIso();
        syncCurrentTurnAgent(turnState);
        return uniqueAgentIds;
      }

      if (routingMode === 'mention_parallel' && initialQueue.agentIds.length > 1) {
        turnState.pendingAgentIds = [];
        turnState.updatedAt = nowIso();
        syncCurrentTurnAgent(turnState);
        emitTurnProgress(turnState);

        const initialBatches = splitIntoMentionBatches(initialQueue.agentIds);
        let initialHopBase = 0;

        for (let batchIndex = 0; batchIndex < initialBatches.length; batchIndex += 1) {
          const batchAgentIds = initialBatches[batchIndex];
          turnState.pendingAgentIds = initialBatches.slice(batchIndex + 1).flatMap((batch) => batch);
          turnState.updatedAt = nowIso();
          syncCurrentTurnAgent(turnState);
          emitTurnProgress(turnState);

          await Promise.all(
            batchAgentIds.map(async (agentId: any, index: any) => {
              if (turnState.stopRequested) {
                return;
              }

              const agent = getAgentById(conversation.agents, agentId);

              if (!agent) {
                return;
              }

              await executeConversationAgent({
                runStore,
                conversationId,
                turnId,
                rootTaskId,
                conversation,
                projectDir: projectDirSnapshot,
                promptMessages: basePromptMessages,
                promptUserMessage,
                queueItem: {
                  agentId,
                  triggerType: 'user',
                  triggeredByAgentId: null,
                  triggeredByAgentName: 'You',
                  triggeredByMessageId: userMessage.id,
                  parentRunId: null,
                  enqueueReason: initialQueue.strategy,
                  parallelGroupSize: batchAgentIds.length,
                  parallelGroupIndex: batchAgentIds.length > 1 ? index + 1 : 0,
                  privateOnly: initialQueue.privateOnly,
                },
                agent,
                turnState,
                completedReplies,
                failedReplies,
                routingMode,
                hop: initialHopBase + index + 1,
                remainingSlots: 0,
                enqueueAgent: null,
                allowHandoffs: false,
                finalStopsTurn: false,
              });
            })
          );

          initialHopBase += batchAgentIds.length;

          if (turnState.stopRequested) {
            break;
          }
        }

        if (turnState.stopRequested) {
          terminationReason = 'stopped_by_user';
        } else if (completedReplies.length > 0 || failedReplies.length > 0) {
          terminationReason = 'parallel_responses_completed';
        }
      } else {
        for (const agentId of initialQueue.agentIds) {
          enqueueAgent({
            agentId,
            triggerType: 'user',
            triggeredByAgentId: null,
            triggeredByAgentName: 'You',
            triggeredByMessageId: userMessage.id,
            parentRunId: null,
            enqueueReason: initialQueue.strategy,
            privateOnly: initialQueue.privateOnly,
          });
        }

        emitTurnProgress(turnState);

        while (queue.length > 0 && turnState.hopCount < maxReplies && !turnState.stopRequested) {
          const queueEntry = queue.shift();
          const queuedItems = queueEntryItems(queueEntry);

          for (const queuedItem of queuedItems) {
            queuedAgentIds.delete(queuedItem.agentId);
          }

          turnState.pendingAgentIds = queuePendingAgentIds();
          turnState.updatedAt = nowIso();
          syncCurrentTurnAgent(turnState);

          const refreshedConversation = store.getConversation(conversationId);
          const remainingCapacity = maxReplies - (turnState.hopCount || 0);

          if (remainingCapacity <= 0) {
            terminationReason = 'hop_limit_reached';
            break;
          }

          const runnableItems = queuedItems
            .map((queueItem: any) => ({
              queueItem,
              agent: getAgentById(refreshedConversation.agents, queueItem.agentId),
            }))
            .filter((item: any) => item.agent);
          const executionItems = runnableItems.slice(0, remainingCapacity);

          if (executionItems.length === 0) {
            if (runnableItems.length > remainingCapacity) {
              terminationReason = 'hop_limit_reached';
              break;
            }

            continue;
          }

          const hopBase = turnState.hopCount || 0;
          const isParallelBatch = executionItems.length > 1;
            const results = isParallelBatch
              ? await Promise.all(
                  executionItems.map(({ queueItem, agent }: any, index: any) => {
                    const hop = hopBase + index + 1;

                    return executeConversationAgent({
                      runStore,
                      conversationId,
                    turnId,
                    rootTaskId,
                    conversation: refreshedConversation,
                    projectDir: projectDirSnapshot,
                    promptMessages: buildPromptMessages(refreshedConversation.messages, promptUserMessage, {
                      snapshotMessageIds: promptSnapshotMessageIds,
                      currentTurnId: turnId,
                      replacePromptUserMessage: !usesExistingBatch,
                    }),
                    promptUserMessage,
                    queueItem,
                    agent,
                    turnState,
                    completedReplies,
                    failedReplies,
                    routingMode,
                    hop,
                    remainingSlots: maxReplies - hop,
                    enqueueAgent,
                    allowHandoffs: turnInput.allowHandoffs,
                    finalStopsTurn: false,
                  });
                })
              )
            : [
                await executeConversationAgent({
                  runStore,
                  conversationId,
                  turnId,
                  rootTaskId,
                  conversation: refreshedConversation,
                  projectDir: projectDirSnapshot,
                  promptMessages: buildPromptMessages(refreshedConversation.messages, promptUserMessage, {
                    snapshotMessageIds: promptSnapshotMessageIds,
                    currentTurnId: turnId,
                    replacePromptUserMessage: !usesExistingBatch,
                  }),
                  promptUserMessage,
                  queueItem: executionItems[0].queueItem,
                  agent: executionItems[0].agent,
                  turnState,
                  completedReplies,
                  failedReplies,
                  routingMode,
                  hop: hopBase + 1,
                  remainingSlots: maxReplies - (hopBase + 1),
                  enqueueAgent,
                  allowHandoffs: turnInput.allowHandoffs,
                  finalStopsTurn: true,
                }),
              ];

          const stopResult = results.find((result) => result && result.stopTurn);

          if (stopResult) {
            terminationReason = stopResult.terminationReason || 'agent_final';
            break;
          }

          if (runnableItems.length > executionItems.length) {
            terminationReason = 'hop_limit_reached';
            break;
          }
        }
      }

      const finalConversation = store.getConversation(conversationId);
      if (turnState.stopRequested) {
        terminationReason = 'stopped_by_user';
      } else if (routingMode !== 'mention_parallel' && queue.length > 0 && turnState.hopCount >= maxReplies) {
        terminationReason = 'hop_limit_reached';
      }
      turnState.pendingAgentIds = [];
      turnState.terminationReason = terminationReason;

      turnState.status =
        terminationReason === 'stopped_by_user' ? 'stopped' : completedReplies.length > 0 ? 'completed' : 'failed';
      turnState.endedAt = nowIso();
      turnState.currentAgentId = null;
      turnState.updatedAt = turnState.endedAt;

      runStore.updateTask(rootTaskId, {
        status: terminationReason === 'stopped_by_user' ? 'cancelled' : completedReplies.length > 0 ? 'succeeded' : 'failed',
        outputText: completedReplies.map((message: any) => `${message.senderName}: ${message.content}`).join('\n\n'),
        errorMessage:
          terminationReason === 'stopped_by_user'
            ? turnState.stopReason || 'Stopped by user'
            : completedReplies.length > 0
              ? null
              : 'No agent produced a completed reply',
        endedAt: turnState.endedAt,
        artifactSummary: {
          completedAgentIds: completedReplies.map((message: any) => message.agentId),
          failedAgentIds: failedReplies.map((message: any) => message.agentId),
          routingMode,
          entryAgentIds: initialQueue.agentIds.slice(),
          entryStrategy: initialQueue.strategy,
          entryExecutionMode: initialQueue.executionMode,
          explicitIntent: initialQueue.explicitIntent,
          terminationReason,
        },
      });
      runStore.appendTaskEvent(rootTaskId, 'conversation_turn_finished', {
        conversationId,
        turnId,
        completedCount: completedReplies.length,
        failedCount: failedReplies.length,
        hopCount: turnState.hopCount,
        terminationReason,
      });

      const finishedTurn = summarizeTurnState(turnState);
      broadcastEvent('turn_finished', {
        conversationId,
        turn: finishedTurn,
        failures: failedReplies.map((message: any) => ({
          agentId: message.agentId,
          senderName: message.senderName,
          errorMessage: message.errorMessage,
        })),
      });
      broadcastConversationSummary(conversationId);
      cleanupActiveTurn();

      return {
        turnId,
        conversation: finalConversation,
        replies: completedReplies,
        failures: failedReplies.map((message: any) => ({
          agentId: message.agentId,
          senderName: message.senderName,
          errorMessage: message.errorMessage,
        })),
        turn: finishedTurn,
      };
    } catch (error) {
      const errorValue = error as any;
      const errorMessage = errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error');
      turnState.status = 'failed';
      turnState.endedAt = nowIso();
      turnState.currentAgentId = null;
      turnState.pendingAgentIds = [];
      turnState.terminationReason = 'error';
      turnState.updatedAt = turnState.endedAt;

      runStore.updateTask(rootTaskId, {
        status: 'failed',
        errorMessage,
        endedAt: turnState.endedAt,
      });
      runStore.appendTaskEvent(rootTaskId, 'conversation_turn_failed', {
        conversationId,
        turnId,
        errorMessage,
      });

      broadcastEvent('turn_finished', {
        conversationId,
        turn: summarizeTurnState(turnState),
        failures: [
          {
            agentId: null,
            senderName: 'system',
            errorMessage,
          },
        ],
      });
      cleanupActiveTurn();
      throw error;
    } finally {
      cleanupActiveTurn();
      runStore.close();
    }
  }

  return runConversationTurn;
}
