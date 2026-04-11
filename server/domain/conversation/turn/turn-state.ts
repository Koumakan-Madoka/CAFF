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
    batchStartMessageId: turnState.batchStartMessageId || null,
    batchEndMessageId: turnState.batchEndMessageId || null,
    consumedUpToMessageId: turnState.consumedUpToMessageId || null,
    inputMessageCount: turnState.inputMessageCount || 0,
    queueDepth: turnState.queueDepth || 0,
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
      currentToolName: agent.currentToolName || '',
      currentToolKind: agent.currentToolKind || '',
      currentToolStepId: agent.currentToolStepId || '',
      currentToolStartedAt: agent.currentToolStartedAt || null,
      currentToolInferred: Boolean(agent.currentToolInferred),
      startedAt: agent.startedAt || null,
      endedAt: agent.endedAt || null,
    })),
  };
}

export function summarizeAgentSlotState(turnState: any) {
  const stage = Array.isArray(turnState && turnState.agents) ? turnState.agents[0] || null : null;

  return {
    slotId: turnState.slotId || '',
    conversationId: turnState.conversationId,
    conversationTitle: turnState.conversationTitle,
    turnId: turnState.turnId,
    sourceMessageId: turnState.sourceMessageId || null,
    agentId: stage && stage.agentId ? stage.agentId : turnState.currentAgentId || null,
    agentName: stage && stage.agentName ? stage.agentName : turnState.targetAgentName || '',
    status: stage && stage.status ? stage.status : turnState.status,
    turnStatus: turnState.status,
    startedAt: turnState.startedAt,
    updatedAt: turnState.updatedAt,
    endedAt: turnState.endedAt || null,
    assistantMessageId: stage && stage.messageId ? stage.messageId : null,
    taskId: stage && stage.taskId ? stage.taskId : null,
    runId: stage && stage.runId ? stage.runId : null,
    heartbeatCount: stage && stage.heartbeatCount ? stage.heartbeatCount : 0,
    replyLength: stage && stage.replyLength ? stage.replyLength : 0,
    preview: stage && stage.preview ? stage.preview : '',
    errorMessage: stage && stage.errorMessage ? stage.errorMessage : '',
    lastTextDeltaAt: stage && stage.lastTextDeltaAt ? stage.lastTextDeltaAt : null,
    currentToolName: stage && stage.currentToolName ? stage.currentToolName : '',
    currentToolKind: stage && stage.currentToolKind ? stage.currentToolKind : '',
    currentToolStepId: stage && stage.currentToolStepId ? stage.currentToolStepId : '',
    currentToolStartedAt: stage && stage.currentToolStartedAt ? stage.currentToolStartedAt : null,
    currentToolInferred: Boolean(stage && stage.currentToolInferred),
    stopRequested: Boolean(turnState.stopRequested),
    stopReason: turnState.stopReason || '',
    stopRequestedAt: turnState.stopRequestedAt || null,
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
    batchStartMessageId: null as string | null,
    batchEndMessageId: null as string | null,
    consumedUpToMessageId: null as string | null,
    inputMessageCount: 0,
    queueDepth: 0,
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
      currentToolName: '',
      currentToolKind: '',
      currentToolStepId: '',
      currentToolStartedAt: null as string | null,
      currentToolInferred: false,
      startedAt: null as string | null,
      endedAt: null as string | null,
    })),
  };
}

export function createAgentSlotState(conversation: any, agent: any, options: any = {}) {
  const slotTurnId = String(options.turnId || '').trim() || `slot-turn-${nowIso()}`;
  const slotState = createTurnState(
    {
      id: conversation.id,
      title: conversation.title,
      agents: [agent],
    },
    slotTurnId
  ) as any;

  slotState.slotId = String(options.slotId || `${conversation.id}:${agent.id}`).trim() || `${conversation.id}:${agent.id}`;
  slotState.executionLane = 'side';
  slotState.sourceMessageId = String(options.sourceMessageId || '').trim() || null;
  slotState.targetAgentName = String(agent && agent.name ? agent.name : '').trim() || 'Assistant';
  slotState.userMessageId = slotState.sourceMessageId;
  slotState.batchStartMessageId = slotState.sourceMessageId;
  slotState.batchEndMessageId = slotState.sourceMessageId;
  slotState.consumedUpToMessageId = slotState.sourceMessageId;
  slotState.inputMessageCount = 1;
  slotState.entryAgentIds = [agent.id];
  slotState.pendingAgentIds = [];
  slotState.queueDepth = 0;
  slotState.routingMode = 'mention_queue';
  return slotState;
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
  stage.currentToolName = '';
  stage.currentToolKind = '';
  stage.currentToolStepId = '';
  stage.currentToolStartedAt = null;
  stage.currentToolInferred = false;
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
