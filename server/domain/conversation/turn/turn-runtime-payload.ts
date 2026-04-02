const {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING,
  resolveSetting,
  resolveThinkingSetting,
} = require('../../../../lib/minimal-pi');
const { summarizeTurnState } = require('./turn-state');

export function createRuntimePayloadBuilder(options: any = {}) {
  const host = String(options.host || '').trim();
  const port = options.port;
  const agentDir = options.agentDir;
  const store = options.store;
  const activeConversationIds = options.activeConversationIds;
  const activeTurns = options.activeTurns;

  function buildRuntimePayload() {
    const defaultProvider = resolveSetting('', process.env.PI_PROVIDER, DEFAULT_PROVIDER);
    return {
      host,
      port,
      agentDir,
      defaultProvider,
      defaultModel: resolveSetting('', process.env.PI_MODEL, DEFAULT_MODEL),
      defaultThinking: resolveThinkingSetting(defaultProvider, '', process.env.PI_THINKING, DEFAULT_THINKING),
      databasePath: store.databasePath,
      activeConversationIds: Array.from(activeConversationIds),
      activeTurns: Array.from(activeTurns.values()).map(summarizeTurnState),
    };
  }

  return {
    buildRuntimePayload,
  };
}

