const {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING,
  resolveSetting,
  resolveThinkingSetting,
} = require('../../../../lib/minimal-pi');
const { summarizeAgentSlotState, summarizeTurnState } = require('./turn-state');

export function createRuntimePayloadBuilder(options: any = {}) {
  const host = String(options.host || '').trim();
  const port = options.port;
  const agentDir = options.agentDir;
  const store = options.store;
  const activeConversationIds = options.activeConversationIds;
  const activeTurns = options.activeTurns;
  const activeAgentSlots = options.activeAgentSlots;
  const dispatchingConversationIds = options.dispatchingConversationIds;
  const getConversationQueueDepths =
    typeof options.getConversationQueueDepths === 'function' ? options.getConversationQueueDepths : () => ({});
  const getConversationQueueFailures =
    typeof options.getConversationQueueFailures === 'function' ? options.getConversationQueueFailures : () => ({});
  const getAgentSlotQueueDepths =
    typeof options.getAgentSlotQueueDepths === 'function' ? options.getAgentSlotQueueDepths : () => ({});

  function buildRuntimePayload() {
    const defaultProvider = resolveSetting('', process.env.PI_PROVIDER, DEFAULT_PROVIDER);
    const activeTurnSummaries = Array.from(activeTurns.values()).map(summarizeTurnState);
    const activeAgentSlotSummaries = Array.from(activeAgentSlots.values()).map(summarizeAgentSlotState);
    const runtimeActiveConversationIds = Array.from(
      new Set([
        ...Array.from(activeConversationIds),
        ...activeAgentSlotSummaries.map((slot: any) => slot.conversationId).filter(Boolean),
      ])
    );

    return {
      host,
      port,
      agentDir,
      defaultProvider,
      defaultModel: resolveSetting('', process.env.PI_MODEL, DEFAULT_MODEL),
      defaultThinking: resolveThinkingSetting(defaultProvider, '', process.env.PI_THINKING, DEFAULT_THINKING),
      databasePath: store.databasePath,
      activeConversationIds: runtimeActiveConversationIds,
      dispatchingConversationIds: Array.from(dispatchingConversationIds || []),
      conversationQueueDepths: getConversationQueueDepths(),
      conversationQueueFailures: getConversationQueueFailures(),
      agentSlotQueueDepths: getAgentSlotQueueDepths(),
      activeTurns: activeTurnSummaries,
      activeAgentSlots: activeAgentSlotSummaries,
    };
  }

  return {
    buildRuntimePayload,
  };
}

