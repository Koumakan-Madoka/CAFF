const path = require('node:path');

const { buildAgentTurnPrompt, sanitizePromptMentions } = require('./turn/agent-prompt');
const { createAgentExecutor } = require('./turn/agent-executor');
const { createSessionExporter } = require('./turn/session-export');
const { createTurnEventEmitter } = require('./turn/turn-events');
const { createRuntimePayloadBuilder } = require('./turn/turn-runtime-payload');
const { createRoutingExecutor } = require('./turn/routing-executor');
const { createTurnStopper } = require('./turn/turn-stop');
const { summarizeTurnState, syncCurrentTurnAgent } = require('./turn/turn-state');

export function createTurnOrchestrator(options: any = {}) {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
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

  const { emitTurnProgress } = createTurnEventEmitter({ broadcastEvent });
  const { buildRuntimePayload } = createRuntimePayloadBuilder({
    host,
    port,
    agentDir,
    store,
    activeConversationIds,
    activeTurns,
  });
  const sessionExporter = createSessionExporter({ agentDir });
  const requestStopConversationTurn = createTurnStopper({
    activeTurns,
    broadcastRuntimeState,
    emitTurnProgress,
  });

  const agentExecutor = createAgentExecutor({
    store,
    skillRegistry,
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

  const runConversationTurn = createRoutingExecutor({
    store,
    executeConversationAgent: agentExecutor.executeConversationAgent,
    broadcastEvent,
    broadcastConversationSummary,
    broadcastRuntimeState,
    emitTurnProgress,
    agentDir,
    sqlitePath,
    activeConversationIds,
    activeTurns,
  });

  function clearConversationState(conversationId: any) {
    activeConversationIds.delete(conversationId);
    activeTurns.delete(conversationId);
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
    listTurnSummaries,
    requestStopConversationTurn,
    resolveAssistantMessageSessionPath: sessionExporter.resolveAssistantMessageSessionPath,
    runConversationTurn,
    summarizeTurnState,
    syncCurrentTurnAgent,
  };
}

export { buildAgentTurnPrompt, sanitizePromptMentions };
