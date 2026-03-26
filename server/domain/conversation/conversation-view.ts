const { getAgentById } = require('./mention-routing');

export function pickConversationSummary(conversation: any) {
  if (!conversation) {
    return null;
  }

  return {
    id: conversation.id,
    title: conversation.title,
    type: conversation.type || 'standard',
    metadata: conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : {},
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
    messageCount: conversation.messageCount,
    agentCount: conversation.agentCount,
    lastMessagePreview: conversation.lastMessagePreview,
  };
}

export function serializeConversationPrivateMessageForUi(message: any, agents: any) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
  const recipientNames = (Array.isArray(message && message.recipientAgentIds) ? message.recipientAgentIds : [])
    .map((agentId: any) => getAgentById(agents, agentId))
    .filter(Boolean)
    .map((agent: any) => agent.name);

  return {
    id: message.id,
    turnId: message.turnId,
    role: 'private',
    agentId: message.senderAgentId || null,
    senderName: message.senderName,
    content: message.content,
    status: 'completed',
    taskId: null as string | null,
    runId: null as string | null,
    errorMessage: '',
    metadata: {
      visibility: 'private',
      recipientAgentIds: Array.isArray(message.recipientAgentIds) ? message.recipientAgentIds : [],
      recipientNames,
      handoffRequested: Boolean(metadata && metadata.handoffRequested),
      uiVisible: metadata ? metadata.uiVisible !== false : true,
    },
    createdAt: message.createdAt,
  };
}

export function withConversationPrivateMessages(conversation: any, store: any) {
  if (!conversation) {
    return null;
  }

  return {
    ...conversation,
    privateMessages: store
      .listPrivateMessages(conversation.id)
      .filter((message: any) => !(message && message.metadata && message.metadata.uiVisible === false))
      .map((message: any) => serializeConversationPrivateMessageForUi(message, conversation.agents)),
  };
}
