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
const {
  createConversationDeliveriesController,
} = require('../api/conversation-deliveries-controller');
const { createFeishuController } = require('../api/feishu-controller');
const { createHealthController } = require('../api/health-controller');
const { createMetricsController } = require('../api/metrics-controller');
const { createMemoryController } = require('../api/memory-controller');
const { createModelProvidersController } = require('../api/model-providers-controller');
const { createProjectsController } = require('../api/projects-controller');
const { createModesController } = require('../api/modes-controller');
const { createSkillsController } = require('../api/skills-controller');
const { createUndercoverController } = require('../api/undercover-controller');
const { createWerewolfController } = require('../api/werewolf-controller');
const { resolveToolRelativePath } = require('../http/path-utils');
const { HOST, PORT, ROOT_DIR } = require('./config');
const { createTurnOrchestrator } = require('../domain/conversation/turn-orchestrator');
const { resolveBrowserCliPath } = require('../domain/conversation/turn/browser-cli');
const { resolveCurrentTrellisTaskName } = require('../domain/conversation/turn/trellis-context');
const { maybeAutoCreateConversationDigest } = require('../domain/conversation/conversation-digest');
const {
  createCrossConversationDeliveryService,
  createCrossConversationDeliveryWorker,
} = require('../domain/conversation/cross-conversation-delivery');
const { getPendingConversationExperienceDrafts } = require('../domain/conversation/experience-draft');
const { maybeAutoCreateConversationSkillDraft } = require('../domain/conversation/skill-draft');
const { pickConversationSummary } = require('../domain/conversation/conversation-view');
const { createUndercoverService } = require('../domain/undercover/undercover-service');
const { createWerewolfService } = require('../domain/werewolf/werewolf-service');
const { createAgentToolBridge } = require('../domain/runtime/agent-tool-bridge');
const { createFeishuClient } = require('../domain/integrations/feishu/feishu-client');
const { createFeishuIntegrationService } = require('../domain/integrations/feishu/feishu-service');
const {
  createFeishuLongConnectionSource,
  isFeishuLongConnectionSdkAvailable,
} = require('../domain/integrations/feishu/feishu-long-connection');
const { createConfiguredModelCatalog } = require('../domain/models/configured-model-catalog');
const { readExternalAuthProviderIds } = require('../domain/models/external-provider-auth');
const { createRoleService } = require('../domain/roles/role-service');
const { createReadinessHealthStatus } = require('../domain/runtime/readiness-health');
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
  let crossConversationDeliveryWorker: any = null;
  let deliveryMaintenanceTimer: any = null;
  let deliveryDrainPromise: Promise<any> | null = null;
  let deliveryDrainRequested = false;
  let deliveryRuntimeClosing = false;
  const deliveryServiceFactory =
    typeof options.deliveryServiceFactory === 'function'
      ? options.deliveryServiceFactory
      : createCrossConversationDeliveryService;
  const deliveryWorkerFactory =
    typeof options.deliveryWorkerFactory === 'function'
      ? options.deliveryWorkerFactory
      : createCrossConversationDeliveryWorker;
  const setDeliveryMaintenanceInterval =
    typeof options.setDeliveryMaintenanceInterval === 'function'
      ? options.setDeliveryMaintenanceInterval
      : setInterval;
  const clearDeliveryMaintenanceInterval =
    typeof options.clearDeliveryMaintenanceInterval === 'function'
      ? options.clearDeliveryMaintenanceInterval
      : clearInterval;
  const deliveryMaintenanceIntervalMs =
    Number.isInteger(options.deliveryMaintenanceIntervalMs)
      && options.deliveryMaintenanceIntervalMs > 0
      ? options.deliveryMaintenanceIntervalMs
      : 1_000;
  const deliveryDrainBatchSize =
    Number.isInteger(options.deliveryDrainBatchSize) && options.deliveryDrainBatchSize > 0
      ? options.deliveryDrainBatchSize
      : 32;

  syncActiveProject();

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

  function broadcastCrossConversationDelivery(delivery: any, reason: any = '') {
    if (!delivery || !delivery.id) {
      return;
    }

    const conversationIds = Array.from(new Set([
      String(delivery.sourceConversationId || '').trim(),
      String(delivery.targetConversationId || '').trim(),
    ].filter(Boolean)));

    for (const conversationId of conversationIds) {
      broadcastEvent('cross_conversation_delivery_updated', {
        conversationId,
        delivery,
        reason: String(reason || '').trim() || null,
      });
      broadcastConversationSummary(conversationId);
    }
  }

  function broadcastCrossConversationMessage(message: any) {
    const conversationId = String(message && message.conversationId || '').trim();

    if (!conversationId || !message || !message.id) {
      return;
    }

    broadcastEvent('conversation_message_created', {
      conversationId,
      message,
    });
  }

  function requestCrossConversationDeliveryDrain() {
    deliveryDrainRequested = true;

    if (deliveryRuntimeClosing || !crossConversationDeliveryWorker || deliveryDrainPromise) {
      return deliveryDrainPromise;
    }

    deliveryDrainPromise = (async () => {
      try {
        while (deliveryDrainRequested && !deliveryRuntimeClosing) {
          deliveryDrainRequested = false;
          let processedCount = 0;

          while (processedCount < deliveryDrainBatchSize && !deliveryRuntimeClosing) {
            const outcome = await crossConversationDeliveryWorker.processNext();
            if (!outcome) {
              break;
            }
            processedCount += 1;
          }

          if (processedCount === deliveryDrainBatchSize) {
            deliveryDrainRequested = true;
          }
        }
      } catch (error) {
        console.error(
          `[cross-conversation-delivery] Drain failed: ${
            error && (error as any).stack ? (error as any).stack : error
          }`
        );
      } finally {
        deliveryDrainPromise = null;

        if (deliveryDrainRequested && !deliveryRuntimeClosing) {
          requestCrossConversationDeliveryDrain();
        }
      }
    })();

    return deliveryDrainPromise;
  }

  function handleCrossConversationDeliveryPersisted(result: any) {
    if (!result || !result.delivery) {
      return;
    }

    if (!result.duplicate) {
      broadcastCrossConversationMessage(result.targetMessage);
      broadcastCrossConversationMessage(result.sourceReceipt);
    }

    broadcastCrossConversationDelivery(result.delivery, result.duplicate ? 'duplicate_submit' : 'persisted');
    requestCrossConversationDeliveryDrain();
  }

  function handleCrossConversationDeliveryChanged(change: any) {
    if (!change || !change.delivery) {
      return;
    }

    const responseMessage = change.response && change.response.responseMessage
      ? change.response.responseMessage
      : null;
    if (responseMessage && !(change.response && change.response.duplicate)) {
      broadcastCrossConversationMessage(responseMessage);
    }

    broadcastCrossConversationDelivery(change.delivery, change.reason);
  }

  function runCrossConversationDeliveryMaintenance() {
    if (deliveryRuntimeClosing || !crossConversationDeliveryWorker) {
      return;
    }

    try {
      crossConversationDeliveryWorker.recoverExpiredClaims();
      crossConversationDeliveryWorker.recoverPendingResponses();
      crossConversationDeliveryWorker.expireRequestDeadlines();
    } catch (error) {
      console.error(
        `[cross-conversation-delivery] Maintenance failed: ${
          error && (error as any).stack ? (error as any).stack : error
        }`
      );
    }

    requestCrossConversationDeliveryDrain();
  }

  function startCrossConversationDeliveryRuntime() {
    if (!crossConversationDeliveryWorker || deliveryMaintenanceTimer) {
      return;
    }

    try {
      crossConversationDeliveryWorker.recoverExpiredClaims();
      crossConversationDeliveryWorker.recoverPendingResponses();
    } catch (error) {
      console.error(
        `[cross-conversation-delivery] Startup recovery failed: ${
          error && (error as any).stack ? (error as any).stack : error
        }`
      );
    }
    requestCrossConversationDeliveryDrain();

    deliveryMaintenanceTimer = setDeliveryMaintenanceInterval(
      runCrossConversationDeliveryMaintenance,
      deliveryMaintenanceIntervalMs
    );
    if (deliveryMaintenanceTimer && typeof deliveryMaintenanceTimer.unref === 'function') {
      deliveryMaintenanceTimer.unref();
    }
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

  const crossConversationDeliveryService =
    options.crossConversationDeliveryService
    || deliveryServiceFactory({
      store,
      onDeliveryPersisted: handleCrossConversationDeliveryPersisted,
    });

  const agentToolBridge = createAgentToolBridge({
    store,
    agentDir,
    piCapabilityBridge: options.piCapabilityBridge,
    crossConversationDeliveryService,
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
  const piCapabilityExtensionPath = path.resolve(
    String(
      options.piCapabilityExtensionPath
      || path.join(ROOT_DIR, 'lib', 'pi-extensions', 'caff-capabilities.mjs')
    )
  );
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
    piCapabilityExtensionPath,
    browserCliPath,
    resolveRuntimeParticipants: roleService.resolveRuntimeParticipants,
    async onAssistantMessageCompleted(message: any) {
      await maybeAutoCreateDigestAfterAssistantMessage(message);

      if (!feishuIntegration) {
        return;
      }

      return feishuIntegration.deliverAssistantMessage(message);
    },
  });

  crossConversationDeliveryWorker =
    options.crossConversationDeliveryWorker
    || deliveryWorkerFactory({
      store,
      dispatchTarget(input: any) {
        return turnOrchestrator.dispatchCrossConversationDelivery(input);
      },
      stopTarget(delivery: any) {
        return turnOrchestrator.requestStopCrossConversationDelivery(
          delivery,
          delivery && delivery.lastErrorMessage
            ? delivery.lastErrorMessage
            : 'Cancelled by operator'
        );
      },
      onDeliveryChanged: handleCrossConversationDeliveryChanged,
    });

  feishuIntegration = createFeishuIntegrationService({
    store,
    turnOrchestrator,
    client: feishuClient,
    modeStore,
    roleService,
    ...(Object.prototype.hasOwnProperty.call(options, 'feishuDefaultRoleIds')
      ? { defaultRoleIds: options.feishuDefaultRoleIds }
      : {}),
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
  const getHealthStatus = createReadinessHealthStatus({
    host,
    port,
    getAddress() {
      return server && server.address();
    },
    getRoleDirectory: roleService.getDirectory,
    resolveRuntimeParticipants: roleService.resolveRuntimeParticipants,
    env: process.env,
    isFeishuLongConnectionSdkAvailable,
  });
  const router = createRouter([
    createHealthController({
      getHealthStatus,
    }),
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
    createProjectsController({
      projectManager,
      syncActiveProject,
    }),
    createAgentToolsController({
      agentToolBridge,
    }),
    createConversationDeliveriesController({
      store,
      deliveryWorker: crossConversationDeliveryWorker,
      onDeliveryAvailable: requestCrossConversationDeliveryDrain,
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
      roleService,
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
      startCrossConversationDeliveryRuntime();

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
    deliveryRuntimeClosing = true;
    sseBus.closeAll();

    if (deliveryMaintenanceTimer) {
      clearDeliveryMaintenanceInterval(deliveryMaintenanceTimer);
      deliveryMaintenanceTimer = null;
    }

    for (const timer of autoDigestScheduledTimers.values()) {
      clearTimeout(timer);
    }
    autoDigestScheduledTimers.clear();

    if (feishuLongConnection) {
      feishuLongConnection.stop();
    }

    server.close(() => {
      const finishClose = () => {
        store.close();

        if (typeof callback === 'function') {
          callback();
        }
      };

      if (deliveryDrainPromise) {
        void deliveryDrainPromise.then(finishClose, finishClose);
        return;
      }

      finishClose();
    });
  }

  return {
    close,
    agentToolBridge,
    crossConversationDeliveryService,
    crossConversationDeliveryWorker,
    getHealthStatus,
    host,
    port,
    runMaybeAutoCreateDigest,
    server,
    start,
    store,
    turnOrchestrator,
  };
}
