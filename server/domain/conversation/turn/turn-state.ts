export function nowIso() {
  return new Date().toISOString();
}

export function clipText(text: any, maxLength = 240) {
  const value = String(text || '').trim();

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

export function summarizeTurnState(turnState: any) {
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
    agents: turnState.agents.map((agent: any) => ({
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

export function createTurnState(conversation: any, turnId: any) {
  const timestamp = nowIso();

  return {
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    turnId,
    status: 'running',
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: null as string | null,
    currentAgentId: null as string | null,
    userMessageId: null as string | null,
    agentCount: conversation.agents.length,
    completedCount: 0,
    failedCount: 0,
    hopCount: 0,
    routingMode: 'mention_queue',
    pendingAgentIds: [] as string[],
    entryAgentIds: [] as string[],
    stopRequested: false,
    stopReason: '',
    stopRequestedAt: null as string | null,
    terminationReason: '',
    runHandles: new Set(),
    agents: conversation.agents.map((agent: any) => ({
      agentId: agent.id,
      agentName: agent.name,
      status: 'idle',
      messageId: null as string | null,
      taskId: null as string | null,
      runId: null as string | null,
      heartbeatCount: 0,
      replyLength: 0,
      preview: '',
      errorMessage: '',
      triggeredByAgentId: null as string | null,
      triggeredByAgentName: '',
      hop: 0,
      lastTextDeltaAt: null as string | null,
      startedAt: null as string | null,
      endedAt: null as string | null,
    })),
  };
}

export function getTurnStage(turnState: any, agentId: any) {
  return turnState.agents.find((agent: any) => agent.agentId === agentId) || null;
}

export function resetTurnStage(stage: any, status = 'idle') {
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

export function syncCurrentTurnAgent(turnState: any) {
  const activeStage =
    Array.isArray(turnState && turnState.agents)
      ? turnState.agents.find(
          (agent: any) => agent.status === 'queued' || agent.status === 'running' || agent.status === 'terminating'
        ) ||
        null
      : null;

  turnState.currentAgentId = activeStage ? activeStage.agentId : null;
  return turnState.currentAgentId;
}

export function replacePromptUserMessage(messages: any, promptUserMessage: any) {
  return (Array.isArray(messages) ? messages : []).map((message: any) => {
    if (!promptUserMessage || !message || message.id !== promptUserMessage.id) {
      return message;
    }

    return {
      ...message,
      content: promptUserMessage.content,
    };
  });
}
