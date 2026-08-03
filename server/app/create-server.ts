const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
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
const { createFeishuController } = require('../api/feishu-controller');
const { createMetricsController } = require('../api/metrics-controller');
const { createMemoryController } = require('../api/memory-controller');
const { createModelProvidersController } = require('../api/model-providers-controller');
const { createProjectsController } = require('../api/projects-controller');
const { createModesController } = require('../api/modes-controller');
const { createSkillsController } = require('../api/skills-controller');
const { createUndercoverController } = require('../api/undercover-controller');
const { createWerewolfController } = require('../api/werewolf-controller');
const { createSkillTestController } = require('../api/skill-test-controller');
const { resolveToolRelativePath } = require('../http/path-utils');
const { HOST, PORT, ROOT_DIR, SKILL_TEST_OPENSANDBOX_CHAT_API_URL } = require('./config');
const { createTurnOrchestrator } = require('../domain/conversation/turn-orchestrator');
const { resolveBrowserCliPath } = require('../domain/conversation/turn/browser-cli');
const { resolveCurrentTrellisTaskName } = require('../domain/conversation/turn/trellis-context');
const { maybeAutoCreateConversationDigest } = require('../domain/conversation/conversation-digest');
const { getPendingConversationExperienceDrafts } = require('../domain/conversation/experience-draft');
const { maybeAutoCreateConversationSkillDraft } = require('../domain/conversation/skill-draft');
const { pickConversationSummary } = require('../domain/conversation/conversation-view');
const { createUndercoverService } = require('../domain/undercover/undercover-service');
const { createWerewolfService } = require('../domain/werewolf/werewolf-service');
const { createAgentToolBridge } = require('../domain/runtime/agent-tool-bridge');
const { createConfiguredOpenSandboxFactory } = require('../domain/skill-test/open-sandbox-factory');
const { createFeishuClient } = require('../domain/integrations/feishu/feishu-client');
const { createFeishuIntegrationService } = require('../domain/integrations/feishu/feishu-service');
const { createFeishuLongConnectionSource } = require('../domain/integrations/feishu/feishu-long-connection');
const { createConfiguredModelCatalog } = require('../domain/models/configured-model-catalog');
const { readExternalAuthProviderIds } = require('../domain/models/external-provider-auth');
const { createRoleService } = require('../domain/roles/role-service');
const { createRouter } = require('../http/router');
const { createSseBus } = require('../http/sse-bus');
const { buildErrorJsonPayload, sendJson } = require('../http/response');
const { serveStaticFile } = require('../http/static-file');
const { createHttpError } = require('../http/http-errors');
const { isLoopbackAddress } = require('../http/local-admin-guard');

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
  const providerConfigCsrfToken = String(options.providerConfigCsrfToken || '').trim()
    || randomBytes(32).toString('base64url');
  const providerConfigLocalEnabled = isLoopbackAddress(host);
  const agentDir = String(options.agentDir || '').trim() || resolveSetting('', process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const modelCatalog = options.modelCatalog || createConfiguredModelCatalog({ agentDir });
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
  const roleService = createRoleService({ store, modelCatalog });
  const modeStore = createModeStore(store.db);
  const skillRegistry = createSkillRegistry({ agentDir, extraSkillDirs: [] });
  const undercoverHost = createWhoIsUndercoverHost({ agentDir });
  const sseBus = createSseBus();
  let turnOrchestrator: any = null;

  syncActiveProject();

  const skillTestOpenSandboxFactory = options.openSandboxFactory !== undefined
    ? options.openSandboxFactory
    : createConfiguredOpenSandboxFactory({
        enabled: options.skillTestOpenSandboxEnabled,
        apiUrl: options.skillTestOpenSandboxApiUrl,
        apiKey: options.skillTestOpenSandboxApiKey,
        template: options.skillTestOpenSandboxTemplate,
        timeoutSeconds: options.skillTestOpenSandboxTimeoutSeconds,
        cpuCount: options.skillTestOpenSandboxCpuCount,
        memoryMB: options.skillTestOpenSandboxMemoryMB,
        remoteRoot: options.skillTestOpenSandboxRemoteRoot,
        driverVersion: options.skillTestOpenSandboxDriverVersion,
        chatApiUrl: options.skillTestOpenSandboxChatApiUrl !== undefined
          ? options.skillTestOpenSandboxChatApiUrl
          : SKILL_TEST_OPENSANDBOX_CHAT_API_URL,
      });

  function broadcastEvent(eventName: any, payload: any) {
    sseBus.broadcast(eventName, payload);

    if (typeof options.onBroadcastEvent === 'function') {
      options.onBroadcastEvent(eventName, payload);
    }
  }

  function broadcastConversationSummary(conversationId: any) {
    const summary = pickConversationSummary(store.getConversationWithoutMessages(conversationId));

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

  const digestOptions = {
    ...(options.digestOptions || {}),
    digestModelRunner: options.digestModelRunner,
    agentDir,
    sqlitePath,
    resolveSummaryMemoryTaskName:
      options.digestOptions && typeof options.digestOptions.resolveSummaryMemoryTaskName === 'function'
        ? options.digestOptions.resolveSummaryMemoryTaskName
        : () => resolveCurrentTrellisTaskName({ startDir: activeProjectDir }),
  };
  const rawSkillDraftOptions = options.skillDraftOptions || {};
  const skillDraftOptions = {
    ...rawSkillDraftOptions,
    skillDraftModelRunner: options.skillDraftModelRunner || rawSkillDraftOptions.skillDraftModelRunner,
    provider: options.skillDraftProvider !== undefined ? options.skillDraftProvider : rawSkillDraftOptions.provider,
    model: options.skillDraftModel !== undefined ? options.skillDraftModel : rawSkillDraftOptions.model,
    thinking: options.skillDraftThinking !== undefined ? options.skillDraftThinking : rawSkillDraftOptions.thinking,
    agentDir,
    sqlitePath,
    getProjectDir: () => activeProjectDir,
  };
  const autoDigestInFlightConversationIds = new Set();
  const autoDigestScheduledTimers = new Map();

  function clearScheduledAutoDigest(conversationId: any) {
    const existingTimer = autoDigestScheduledTimers.get(conversationId);

    if (existingTimer) {
      clearTimeout(existingTimer);
      autoDigestScheduledTimers.delete(conversationId);
    }
  }

  function scheduleAutoDigestRetry(conversationId: any, delayMs: any) {
    clearScheduledAutoDigest(conversationId);

    const normalizedDelayMs = Math.max(0, Number.parseInt(String(delayMs || '0'), 10) || 0);
    const timer = setTimeout(() => {
      autoDigestScheduledTimers.delete(conversationId);
      void runMaybeAutoCreateDigest(conversationId);
    }, normalizedDelayMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    autoDigestScheduledTimers.set(conversationId, timer);
  }

  async function runMaybeAutoCreateDigest(conversationId: any) {
    if (!conversationId || autoDigestInFlightConversationIds.has(conversationId)) {
      return;
    }

    const conversationBeforeDigest = store.getConversation(conversationId);
    const pendingExperienceDraftCount = getPendingConversationExperienceDrafts(conversationBeforeDigest).length;
    const shouldAnnounceExperienceDigest = pendingExperienceDraftCount > 0;
    let shouldClearDigestStatus = shouldAnnounceExperienceDigest;

    autoDigestInFlightConversationIds.add(conversationId);

    if (shouldAnnounceExperienceDigest) {
      broadcastEvent('conversation_digest_status', {
        conversationId,
        status: 'running',
        reason: 'pending_experience',
        pendingExperienceDraftCount,
        message: '正在整理本轮经验，并写入会话摘要…',
      });
    }

    try {
      const result = await maybeAutoCreateConversationDigest(store, conversationId, {
        ...digestOptions,
        onModelProgress(progress: any) {
          shouldClearDigestStatus = true;
          broadcastEvent('conversation_digest_status', {
            conversationId,
            status: 'running',
            reason: progress && progress.reason ? progress.reason : 'model_digest',
            phase: progress && progress.phase ? progress.phase : '',
            message: progress && progress.message ? progress.message : '会话摘要模型正在生成…',
            pendingExperienceDraftCount,
            model: progress && progress.model ? progress.model : null,
            modelTrace: progress && progress.modelTrace ? progress.modelTrace : null,
          });
        },
      });

      if (result && !result.digestChanged && (result.reason === 'idle_wait' || result.reason === 'cooldown') && result.retryAfterMs > 0) {
        scheduleAutoDigestRetry(conversationId, result.retryAfterMs);
      }

      if (!result || (!result.digestChanged && !result.stateChanged)) {
        return result;
      }

      let latestConversation = store.getConversation(conversationId) || result.conversation;
      let summary = pickConversationSummary(latestConversation);

      if (result.autoCreated && result.digest && result.digest.id) {
        const draftResult = await maybeAutoCreateConversationSkillDraft(store, conversationId, {
          digestId: result.digest.id,
          trigger: result.triggerReason || 'auto-digest',
        }, skillDraftOptions);

        if (draftResult && draftResult.changed) {
          latestConversation = store.getConversation(conversationId) || draftResult.conversation || latestConversation;
          summary = pickConversationSummary(latestConversation);
          broadcastEvent('conversation_skill_draft_updated', {
            conversationId,
            draft: draftResult.draft,
            skillDrafts: draftResult.skillDrafts,
            autoCreated: Boolean(draftResult.autoCreated),
            reason: draftResult.reason,
            conversation: latestConversation,
            summary,
          });
        }
      }

      broadcastEvent('conversation_digest_updated', {
        conversationId,
        digest: result.digest,
        rollup: result.rollup,
        digests: result.digests,
        compacted: result.compacted,
        autoCreated: Boolean(result.autoCreated),
        reason: result.reason,
        pendingMessageCount: result.pendingMessageCount,
        messageBudget: result.messageBudget,
        triggerReason: result.triggerReason,
        conversation: latestConversation,
        summary,
      });
      broadcastEvent('conversation_summary_updated', {
        conversationId,
        summary,
      });

      return result;
    } catch (error) {
      const errorValue = error as any;
      console.warn(`[conversation-digest] Auto-create failed for ${conversationId}: ${errorValue && errorValue.stack ? errorValue.stack : errorValue}`);
      return {
        autoCreated: false,
        reason: 'failed',
        error: errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error'),
      };
    } finally {
      if (shouldClearDigestStatus) {
        broadcastEvent('conversation_digest_status', {
          conversationId,
          status: 'idle',
          reason: shouldAnnounceExperienceDigest ? 'pending_experience' : 'model_digest',
        });
      }

      autoDigestInFlightConversationIds.delete(conversationId);
    }
  }

  async function maybeAutoCreateDigestAfterAssistantMessage(message: any) {
    const conversationId = String(message && message.conversationId || '').trim();

    clearScheduledAutoDigest(conversationId);
    await runMaybeAutoCreateDigest(conversationId);
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

  const feishuClient = createFeishuClient();
  let feishuIntegration: any = null;
  const agentToolScriptPath = path.resolve(ROOT_DIR, 'lib', 'agent-chat-tools.js');
  const agentToolRelativePath = resolveToolRelativePath(agentToolScriptPath);
  const browserCliPath = resolveBrowserCliPath({ rootDir: ROOT_DIR });

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
    browserCliPath,
    async onAssistantMessageCompleted(message: any) {
      await maybeAutoCreateDigestAfterAssistantMessage(message);

      if (!feishuIntegration) {
        return;
      }

      return feishuIntegration.deliverAssistantMessage(message);
    },
  });

  feishuIntegration = createFeishuIntegrationService({
    store,
    turnOrchestrator,
    client: feishuClient,
    modeStore,
  });
  const feishuLongConnection = createFeishuLongConnectionSource({
    feishuService: feishuIntegration,
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
  let server: any = null;
  const { buildBootstrapPayload, buildConfiguredModelOptions } = createBootstrapPayloadBuilder({
    store,
    skillRegistry,
    turnOrchestrator,
    modeStore,
    modelCatalog,
    roleService,
    localAdmin: () => ({
      modelProviders: {
        enabled: providerConfigLocalEnabled,
        csrfToken: providerConfigLocalEnabled ? providerConfigCsrfToken : '',
      },
    }),
  });
  const router = createRouter([
    createBootstrapController({
      sseBus,
      turnOrchestrator,
      buildBootstrapPayload,
    }),
    createFeishuController({
      feishuService: feishuIntegration,
    }),
    createMetricsController({
      store,
    }),
    createMemoryController({
      store,
      resolveCurrentTaskName: () => resolveCurrentTrellisTaskName({ startDir: activeProjectDir }),
    }),
    createModelProvidersController({
      agentDir,
      host,
      port,
      csrfToken: providerConfigCsrfToken,
      getAuthority() {
        const address = server && server.address();
        const actualPort = address && typeof address === 'object' ? address.port : port;
        return new URL(buildToolBaseUrl(host, actualPort)).host;
      },
      externalAuthProviderIds: options.externalAuthProviderIds !== undefined
        ? options.externalAuthProviderIds
        : () => readExternalAuthProviderIds(agentDir),
      onCommitted: () => modelCatalog.invalidate(),
      validateProvider: options.validateProvider,
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
      roleService,
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
      broadcastEvent,
      agentDir,
      sqlitePath,
      digestOptions,
      skillDraftOptions,
      digestModelRunner: options.digestModelRunner,
    }),
    createSkillTestController({
      store,
      agentToolBridge: agentToolBridge,
      skillRegistry,
      getProjectDir: () => activeProjectDir,
      toolBaseUrl,
      skillTestChatApiUrl: options.skillTestOpenSandboxChatApiUrl !== undefined
        ? options.skillTestOpenSandboxChatApiUrl
        : SKILL_TEST_OPENSANDBOX_CHAT_API_URL,
      broadcastEvent,
      openSandboxFactory: skillTestOpenSandboxFactory,
      defaultIsolationMode: options.skillTestDefaultIsolationMode,
      allowLiveTrellis: options.skillTestAllowLiveTrellis === true,
    }),
  ]);

  server = http.createServer(async (req: any, res: any) => {
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

    if (feishuIntegration) {
      void Promise.resolve(feishuIntegration.initialize()).catch(() => null);
    }

    if (feishuLongConnection) {
      feishuLongConnection.start();
    }
  }

  function close(callback: any) {
    sseBus.closeAll();

    for (const timer of autoDigestScheduledTimers.values()) {
      clearTimeout(timer);
    }
    autoDigestScheduledTimers.clear();

    if (feishuLongConnection) {
      feishuLongConnection.stop();
    }

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
    runMaybeAutoCreateDigest,
    server,
    start,
    store,
  };
}
