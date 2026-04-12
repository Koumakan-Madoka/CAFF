const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { DEFAULT_AGENT_DIR, resolveSetting } = require('../../lib/minimal-pi');
const { createChatAppStore } = require('../../lib/chat-app-store');
const { createSkillRegistry } = require('../../lib/skill-registry');
const { createProjectManager } = require('../../lib/project-manager');
const { createWhoIsUndercoverHost } = require('../../lib/who-is-undercover-game');
const { createWerewolfHost } = require('../../lib/werewolf-game');
const { createModeStore } = require('../../lib/mode-store');
const { createBootstrapPayloadBuilder } = require('../api/bootstrap-payload');
const { createAgentToolsController } = require('../api/agent-tools-controller');
const { createAgentsController } = require('../api/agents-controller');
const { createBootstrapController } = require('../api/bootstrap-controller');
const { createConversationsController } = require('../api/conversations-controller');
const { createEvalCasesController } = require('../api/eval-cases-controller');
const { createMetricsController } = require('../api/metrics-controller');
const { createProjectsController } = require('../api/projects-controller');
const { createModesController } = require('../api/modes-controller');
const { createSkillsController } = require('../api/skills-controller');
const { createUndercoverController } = require('../api/undercover-controller');
const { createWerewolfController } = require('../api/werewolf-controller');
const { createSkillTestController } = require('../api/skill-test-controller');
const { resolveToolRelativePath } = require('../http/path-utils');
const { HOST, PORT, ROOT_DIR } = require('./config');
const { createTurnOrchestrator } = require('../domain/conversation/turn-orchestrator');
const { pickConversationSummary } = require('../domain/conversation/conversation-view');
const { createUndercoverService } = require('../domain/undercover/undercover-service');
const { createWerewolfService } = require('../domain/werewolf/werewolf-service');
const { createAgentToolBridge } = require('../domain/runtime/agent-tool-bridge');
const { createRouter } = require('../http/router');
const { createSseBus } = require('../http/sse-bus');
const { buildErrorJsonPayload, sendJson } = require('../http/response');
const { serveStaticFile } = require('../http/static-file');
const { createHttpError } = require('../http/http-errors');

// resolveToolRelativePath is now imported from ../http/path-utils

function normalizeToolBaseHost(rawHost: any) {
  const host = String(rawHost || '').trim();

  if (!host) {
    return '127.0.0.1';
  }

  const normalized = host.toLowerCase();

  if (normalized === '0.0.0.0') {
    return '127.0.0.1';
  }

  if (normalized === '::' || normalized === '::1') {
    return '[::1]';
  }

  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }

  return host;
}

function buildToolBaseUrl(rawHost: any, rawPort: any) {
  const host = normalizeToolBaseHost(rawHost);
  const port = Number.isFinite(rawPort) ? rawPort : Number.parseInt(String(rawPort || ''), 10);
  return `http://${host}:${Number.isFinite(port) ? port : PORT}`;
}

export function createServerApp(options: any = {}) {
  const host = String(options.host || HOST).trim() || HOST;
  const portValue = Number.isInteger(options.port) ? options.port : Number.parseInt(String(options.port || PORT), 10);
  const port = Number.isFinite(portValue) ? portValue : PORT;
  const toolBaseUrl = buildToolBaseUrl(host, port);
  const agentDir = String(options.agentDir || '').trim() || resolveSetting('', process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const sqlitePath = String(options.sqlitePath || '').trim() || resolveSetting('', process.env.PI_SQLITE_PATH, '');
  const initialProjectDir = path.resolve(String(options.projectDir || '').trim() || process.cwd());
  const projectManager = createProjectManager({ agentDir, initialProjectDir });
  let activeProjectDir = initialProjectDir;

  function buildProjectExtraSkillDirs(projectDir: any) {
    const resolvedProjectDir = String(projectDir || '').trim();

    if (!resolvedProjectDir) {
      return [];
    }

    return [path.join(resolvedProjectDir, '.agents', 'skills'), path.join(resolvedProjectDir, '.codex', 'skills')];
  }

  function syncActiveProject() {
    const activeProject = projectManager.getActiveProject();

    if (!activeProject || !activeProject.path) {
      activeProjectDir = '';
      skillRegistry.setExternalSkillDirs([]);
      return null;
    }

    activeProjectDir = activeProject.path;
    skillRegistry.setExternalSkillDirs(buildProjectExtraSkillDirs(activeProjectDir));
    return activeProject;
  }

  const store = createChatAppStore({ agentDir, sqlitePath });
  const modeStore = createModeStore(store.db);
  const skillRegistry = createSkillRegistry({ agentDir, extraSkillDirs: [] });
  const undercoverHost = createWhoIsUndercoverHost({ agentDir });
  const sseBus = createSseBus();
  let turnOrchestrator: any = null;

  syncActiveProject();

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
    agentDir,
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

  const agentToolScriptPath = path.resolve(ROOT_DIR, 'lib', 'agent-chat-tools.js');
  const agentToolRelativePath = resolveToolRelativePath(agentToolScriptPath);

  turnOrchestrator = createTurnOrchestrator({
    store,
    skillRegistry,
    modeStore,
    getProjectDir: () => activeProjectDir,
    agentToolBridge,
    broadcastEvent,
    broadcastConversationSummary,
    broadcastRuntimeState,
    host,
    port,
    agentDir,
    sqlitePath,
    toolBaseUrl,
    agentToolScriptPath,
    agentToolRelativePath,
  });

  const undercoverService = createUndercoverService({
    store,
    skillRegistry,
    undercoverHost,
    turnOrchestrator,
    broadcastEvent,
    broadcastConversationSummary,
  });
  const werewolfHost = createWerewolfHost({ agentDir });
  const werewolfService = createWerewolfService({
    store,
    skillRegistry,
    werewolfHost,
    turnOrchestrator,
    broadcastEvent,
    broadcastConversationSummary,
    agentDir,
  });
  const { buildBootstrapPayload, buildConfiguredModelOptions } = createBootstrapPayloadBuilder({
    store,
    skillRegistry,
    turnOrchestrator,
    modeStore,
  });
  const router = createRouter([
    createBootstrapController({
      sseBus,
      turnOrchestrator,
      buildBootstrapPayload,
    }),
    createMetricsController({
      store,
    }),
    createEvalCasesController({
      store,
      agentToolBridge,
      getProjectDir: () => activeProjectDir,
      toolBaseUrl,
    }),
    createProjectsController({
      projectManager,
      syncActiveProject,
    }),
    createAgentToolsController({
      agentToolBridge,
    }),
    createModesController({
      modeStore,
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
    createWerewolfController({
      werewolfService,
    }),
    createConversationsController({
      store,
      skillRegistry,
      projectManager,
      undercoverHost,
      werewolfHost,
      turnOrchestrator,
      undercoverService,
      werewolfService,
      buildBootstrapPayload,
      modeStore,
    }),
    createSkillTestController({
      store,
      agentToolBridge: agentToolBridge,
      skillRegistry,
      getProjectDir: () => activeProjectDir,
      toolBaseUrl,
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
      sendJson(res, statusCode, buildErrorJsonPayload(errorValue));
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
