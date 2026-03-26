const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { DEFAULT_AGENT_DIR, resolveSetting } = require('../../lib/minimal-pi');
const { createChatAppStore } = require('../../lib/chat-app-store');
const { createSkillRegistry } = require('../../lib/skill-registry');
const { createWhoIsUndercoverHost } = require('../../lib/who-is-undercover-game');
const { createBootstrapPayloadBuilder } = require('../api/bootstrap-payload');
const { createAgentToolsController } = require('../api/agent-tools-controller');
const { createAgentsController } = require('../api/agents-controller');
const { createBootstrapController } = require('../api/bootstrap-controller');
const { createConversationsController } = require('../api/conversations-controller');
const { createSkillsController } = require('../api/skills-controller');
const { createUndercoverController } = require('../api/undercover-controller');
const { HOST, PORT, ROOT_DIR } = require('./config');
const { createTurnOrchestrator } = require('../domain/conversation/turn-orchestrator');
const { pickConversationSummary } = require('../domain/conversation/conversation-view');
const { createUndercoverService } = require('../domain/undercover/undercover-service');
const { createAgentToolBridge } = require('../domain/runtime/agent-tool-bridge');
const { createRouter } = require('../http/router');
const { createSseBus } = require('../http/sse-bus');
const { sendJson } = require('../http/response');
const { serveStaticFile } = require('../http/static-file');
const { createHttpError } = require('../http/http-errors');

export function createServerApp(options: any = {}) {
  const host = String(options.host || HOST).trim() || HOST;
  const portValue = Number.isInteger(options.port) ? options.port : Number.parseInt(String(options.port || PORT), 10);
  const port = Number.isFinite(portValue) ? portValue : PORT;
  const agentDir = String(options.agentDir || '').trim() || resolveSetting('', process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const sqlitePath = String(options.sqlitePath || '').trim() || resolveSetting('', process.env.PI_SQLITE_PATH, '');
  const store = createChatAppStore({ agentDir, sqlitePath });
  const skillRegistry = createSkillRegistry({ agentDir });
  const undercoverHost = createWhoIsUndercoverHost({ agentDir });
  const sseBus = createSseBus();
  let turnOrchestrator: any = null;

  function broadcastEvent(eventName: any, payload: any) {
    sseBus.broadcast(eventName, payload);
  }

  function broadcastConversationSummary(conversationId: any) {
    const summary = pickConversationSummary(store.getConversation(conversationId));

    if (!summary) {
      return;
    }

    broadcastEvent('conversation_summary_updated', {
      conversationId,
      summary,
    });
  }

  function broadcastRuntimeState() {
    if (!turnOrchestrator) {
      return;
    }

    broadcastEvent('runtime_state', turnOrchestrator.buildRuntimePayload());
  }

  const agentToolBridge = createAgentToolBridge({
    store,
    broadcastEvent,
    broadcastConversationSummary,
    onTurnUpdated(turnState: any) {
      if (!turnOrchestrator) {
        return;
      }

      turnOrchestrator.syncCurrentTurnAgent(turnState);
      turnOrchestrator.emitTurnProgress(turnState);
    },
  });

  turnOrchestrator = createTurnOrchestrator({
    store,
    skillRegistry,
    agentToolBridge,
    broadcastEvent,
    broadcastConversationSummary,
    broadcastRuntimeState,
    host,
    port,
    agentDir,
    sqlitePath,
    toolBaseUrl: `http://${host}:${port}`,
    agentToolScriptPath: path.resolve(ROOT_DIR, 'lib', 'agent-chat-tools.js'),
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });

  const undercoverService = createUndercoverService({
    store,
    skillRegistry,
    undercoverHost,
    turnOrchestrator,
    broadcastEvent,
    broadcastConversationSummary,
  });
  const { buildBootstrapPayload, buildConfiguredModelOptions } = createBootstrapPayloadBuilder({
    store,
    skillRegistry,
    turnOrchestrator,
  });
  const router = createRouter([
    createBootstrapController({
      sseBus,
      turnOrchestrator,
      buildBootstrapPayload,
    }),
    createAgentToolsController({
      agentToolBridge,
    }),
    createSkillsController({
      store,
      skillRegistry,
    }),
    createAgentsController({
      store,
      skillRegistry,
      buildConfiguredModelOptions,
    }),
    createUndercoverController({
      undercoverService,
    }),
    createConversationsController({
      store,
      skillRegistry,
      undercoverHost,
      turnOrchestrator,
      undercoverService,
      buildBootstrapPayload,
    }),
  ]);

  const server = http.createServer(async (req: any, res: any) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);

    try {
      if (requestUrl.pathname.startsWith('/api/')) {
        const handled = await router.route({
          req,
          res,
          pathname: requestUrl.pathname,
          requestUrl,
        });

        if (!handled) {
          throw createHttpError(404, 'API route not found');
        }

        return;
      }

      serveStaticFile(res, requestUrl.pathname);
    } catch (error) {
      const errorValue = error as any;
      const statusCode = Number.isInteger(errorValue && errorValue.statusCode) ? errorValue.statusCode : 500;
      sendJson(res, statusCode, {
        error: (errorValue && errorValue.message) || 'Internal server error',
      });
    }
  });

  function start(onListen: any) {
    server.listen(port, host, () => {
      if (typeof onListen === 'function') {
        onListen();
      }
    });
  }

  function close(callback: any) {
    sseBus.closeAll();

    server.close(() => {
      store.close();

      if (typeof callback === 'function') {
        callback();
      }
    });
  }

  return {
    close,
    host,
    port,
    server,
    start,
    store,
  };
}
