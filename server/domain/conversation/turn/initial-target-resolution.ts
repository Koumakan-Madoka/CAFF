const {
  buildAgentMentionLookup,
  extractMentionedAgentIds,
  resolveTurnExecutionMode,
} = require('../mention-routing');

function normalize(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueParticipantAgentIds(values: any, participantAgentIds: Set<string>) {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of Array.isArray(values) ? values : []) {
    const agentId = normalize(value);

    if (!agentId || seen.has(agentId) || !participantAgentIds.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    result.push(agentId);
  }

  return result;
}

function isPublicCompletedAssistantReply(message: any, participantAgentIds: Set<string>) {
  const metadata = message && message.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};
  const visibility = normalize(message && message.visibility || metadata.visibility).toLowerCase();
  const agentId = normalize(message && message.agentId);

  return Boolean(
    message
    && normalize(message.role).toLowerCase() === 'assistant'
    && normalize(message.status).toLowerCase() === 'completed'
    && normalize(message.content)
    && agentId
    && participantAgentIds.has(agentId)
    && !Boolean(metadata.privateOnly)
    && visibility !== 'private'
  );
}

function compareMessageOrder(left: any, right: any) {
  const leftCreatedAt = normalize(left && left.message && left.message.createdAt);
  const rightCreatedAt = normalize(right && right.message && right.message.createdAt);

  if (leftCreatedAt && rightCreatedAt && leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt.localeCompare(rightCreatedAt);
  }

  if (leftCreatedAt && rightCreatedAt) {
    const idOrder = normalize(left.message.id).localeCompare(normalize(right.message.id));
    if (idOrder !== 0) {
      return idOrder;
    }
  }

  return left.index - right.index;
}

export function resolveMostRecentPublicReplyAgentId(conversation: any) {
  const agents = Array.isArray(conversation && conversation.agents) ? conversation.agents : [];
  const participantAgentIds = new Set<string>(
    agents.map((agent: any) => normalize(agent && agent.id)).filter(Boolean)
  );
  const projectedAgentId = normalize(conversation && conversation.latestPublicReplyAgentId);
  if (projectedAgentId && participantAgentIds.has(projectedAgentId)) {
    return projectedAgentId;
  }

  let latest: any = null;

  (Array.isArray(conversation && conversation.messages) ? conversation.messages : []).forEach((message: any, index: number) => {
    if (!isPublicCompletedAssistantReply(message, participantAgentIds)) {
      return;
    }

    const candidate = { message, index };
    if (!latest || compareMessageOrder(candidate, latest) > 0) {
      latest = candidate;
    }
  });

  return latest ? normalize(latest.message.agentId) : '';
}

export function resolveInitialTurnTargets(turnInput: any, conversation: any) {
  const agents = Array.isArray(conversation && conversation.agents) ? conversation.agents : [];
  const participantAgentIds = new Set<string>(
    agents.map((agent: any) => normalize(agent && agent.id)).filter(Boolean)
  );
  const explicitAgentIds = uniqueParticipantAgentIds(
    turnInput && turnInput.initialAgentIds,
    participantAgentIds
  );
  const userText = normalize(turnInput && (turnInput.cleanedContent || turnInput.content));

  if (explicitAgentIds.length > 0) {
    return {
      agentIds: explicitAgentIds,
      strategy: normalize(turnInput && turnInput.entryStrategy) || 'directed',
      executionMode: turnInput && turnInput.executionMode === 'parallel' ? 'parallel' : 'queue',
      explicitIntent: Boolean(turnInput && turnInput.explicitIntent),
      privateOnly: Boolean(turnInput && turnInput.privateOnly),
      cleanedUserText: normalize(turnInput && turnInput.cleanedContent) || userText,
    };
  }

  const lookup = buildAgentMentionLookup(agents);
  const mentionedAgentIds = extractMentionedAgentIds(userText, agents, {
    lookup,
    limit: agents.length,
  });
  const defaultAgentId = resolveMostRecentPublicReplyAgentId(conversation);
  const agentIds = mentionedAgentIds.length > 0
    ? mentionedAgentIds
    : defaultAgentId
      ? [defaultAgentId]
      : agents[0] && normalize(agents[0].id)
        ? [normalize(agents[0].id)]
        : [];
  const execution = resolveTurnExecutionMode(userText, agentIds.length);

  return {
    agentIds,
    strategy: mentionedAgentIds.length > 0
      ? 'user_mentions'
      : defaultAgentId
        ? 'default_last_agent'
        : 'default_first_agent',
    executionMode: execution.mode,
    explicitIntent: execution.explicitIntent,
    privateOnly: false,
    cleanedUserText: execution.cleanedText,
  };
}
