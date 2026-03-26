export function nowIso() {
  return new Date().toISOString();
}

export function clipText(text, maxLength = 240) {
  const value = String(text || '').trim();

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

export function summarizeTurnState(turnState) {
  return {
    conversationId: turnState.conversationId,
    conversationTitle: turnState.conversationTitle,
    turnId: turnState.turnId,
    status: turnState.status,
    startedAt: turnState.startedAt,
    updatedAt: turnState.updatedAt,
    endedAt: turnState.endedAt || null,
    currentAgentId: turnState.currentAgentId || null,
    userMessageId: turnState.userMessageId || null,
    agentCount: turnState.agentCount,
    completedCount: turnState.completedCount,
    failedCount: turnState.failedCount,
    hopCount: turnState.hopCount || 0,
    routingMode: turnState.routingMode || 'sequential',
    pendingAgentIds: Array.isArray(turnState.pendingAgentIds) ? turnState.pendingAgentIds : [],
    entryAgentIds: Array.isArray(turnState.entryAgentIds) ? turnState.entryAgentIds : [],
    stopRequested: Boolean(turnState.stopRequested),
    stopReason: turnState.stopReason || '',
    stopRequestedAt: turnState.stopRequestedAt || null,
    terminationReason: turnState.terminationReason || '',
    agents: turnState.agents.map((agent) => ({
      agentId: agent.agentId,
      agentName: agent.agentName,
      status: agent.status,
      messageId: agent.messageId || null,
      taskId: agent.taskId || null,
      runId: agent.runId || null,
      heartbeatCount: agent.heartbeatCount || 0,
      replyLength: agent.replyLength || 0,
      preview: agent.preview || '',
      errorMessage: agent.errorMessage || '',
      triggeredByAgentId: agent.triggeredByAgentId || null,
      triggeredByAgentName: agent.triggeredByAgentName || '',
      hop: agent.hop || 0,
      lastTextDeltaAt: agent.lastTextDeltaAt || null,
      startedAt: agent.startedAt || null,
      endedAt: agent.endedAt || null,
    })),
  };
}

export function createTurnState(conversation, turnId) {
  const timestamp = nowIso();

  return {
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    turnId,
    status: 'running',
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: null,
    currentAgentId: null,
    userMessageId: null,
    agentCount: conversation.agents.length,
    completedCount: 0,
    failedCount: 0,
    hopCount: 0,
    routingMode: 'mention_queue',
    pendingAgentIds: [],
    entryAgentIds: [],
    stopRequested: false,
    stopReason: '',
    stopRequestedAt: null,
    terminationReason: '',
    runHandles: new Set(),
    agents: conversation.agents.map((agent) => ({
      agentId: agent.id,
      agentName: agent.name,
      status: 'idle',
      messageId: null,
      taskId: null,
      runId: null,
      heartbeatCount: 0,
      replyLength: 0,
      preview: '',
      errorMessage: '',
      triggeredByAgentId: null,
      triggeredByAgentName: '',
      hop: 0,
      lastTextDeltaAt: null,
      startedAt: null,
      endedAt: null,
    })),
  };
}

export function getTurnStage(turnState, agentId) {
  return turnState.agents.find((agent) => agent.agentId === agentId) || null;
}

export function resetTurnStage(stage, status = 'idle') {
  if (!stage) {
    return;
  }

  stage.status = status;
  stage.messageId = null;
  stage.taskId = null;
  stage.runId = null;
  stage.heartbeatCount = 0;
  stage.replyLength = 0;
  stage.preview = '';
  stage.errorMessage = '';
  stage.triggeredByAgentId = null;
  stage.triggeredByAgentName = '';
  stage.hop = 0;
  stage.startedAt = null;
  stage.endedAt = null;
  stage.lastTextDeltaAt = null;
}

export function syncCurrentTurnAgent(turnState) {
  const activeStage =
    Array.isArray(turnState && turnState.agents)
      ? turnState.agents.find((agent) => agent.status === 'queued' || agent.status === 'running' || agent.status === 'terminating') ||
        null
      : null;

  turnState.currentAgentId = activeStage ? activeStage.agentId : null;
  return turnState.currentAgentId;
}

export function replacePromptUserMessage(messages, promptUserMessage) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (!promptUserMessage || !message || message.id !== promptUserMessage.id) {
      return message;
    }

    return {
      ...message,
      content: promptUserMessage.content,
    };
  });
}

