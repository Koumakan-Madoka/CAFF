const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { URL } = require('node:url');
const { DEFAULT_AGENT_DIR, resolveSetting } = require('../../lib/minimal-pi');
const { createChatAppStore } = require('../../lib/chat-app-store');
const { createSkillRegistry } = require('../../lib/skill-registry');
const { createProjectManager } = require('../../lib/project-manager');
const { createModeStore } = require('../../lib/mode-store');
const { createBootstrapPayloadBuilder } = require('../api/bootstrap-payload');
const { createAgentToolsController } = require('../api/agent-tools-controller');
const { createAgentsController } = require('../api/agents-controller');
const { createBootstrapController } = require('../api/bootstrap-controller');
const { createConversationsController } = require('../api/conversations-controller');
const { createConversationPlanController } = require('../api/conversation-plan-controller');
const {
  createConversationDeliveriesController,
} = require('../api/conversation-deliveries-controller');
const { createFeishuController } = require('../api/feishu-controller');
const { createHealthController } = require('../api/health-controller');
const { createMetricsController } = require('../api/metrics-controller');
const { createMemoryController } = require('../api/memory-controller');
const { createModelProvidersController } = require('../api/model-providers-controller');
const { createModelCatalogController } = require('../api/model-catalog-controller');
const { createProjectsController } = require('../api/projects-controller');
const { createModesController } = require('../api/modes-controller');
const { createSkillsController } = require('../api/skills-controller');
const { createImageUploadController } = require('../api/image-upload-controller');
const { createImageUploadService } = require('../../lib/image-upload-service');
const {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_PIXELS,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_WIDTH,
} = require('../../lib/image-constants');
const { resolveToolRelativePath } = require('../http/path-utils');
const { HOST, PORT, ROOT_DIR } = require('./config');
const { createTurnOrchestrator } = require('../domain/conversation/turn-orchestrator');
const { resolveBrowserCliPath } = require('../domain/conversation/turn/browser-cli');
const { resolveCurrentTrellisTaskName } = require('../domain/conversation/turn/trellis-context');
const { maybeAutoCreateConversationDigest } = require('../domain/conversation/conversation-digest');
const { createConversationSpawnService } = require('../domain/conversation/conversation-spawn');
const {
  createCrossConversationDeliveryService,
  createCrossConversationDeliveryWorker,
} = require('../domain/conversation/cross-conversation-delivery');
const { getPendingConversationExperienceDrafts } = require('../domain/conversation/experience-draft');
const { maybeAutoCreateConversationSkillDraft } = require('../domain/conversation/skill-draft');
const { pickConversationSummary } = require('../domain/conversation/conversation-view');
const { createAgentToolBridge } = require('../domain/runtime/agent-tool-bridge');
const { createDagScheduler } = require('../domain/dag/dag-scheduler');
const { prepareNodeWorktree, resolveDagWorktreePath } = require('../../lib/dag-worktree');
const { prepareMergeNodeWorktree, verifyMergeOutcome } = require('../../lib/dag-merge');
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
  const uploadsDir = path.resolve(String(options.uploadsDir || '').trim() || path.join(ROOT_DIR, 'uploads'));
  const uploadService = createImageUploadService({ store, uploadsDir });
  const roleService = createRoleService({ store, modelCatalog });
  const modeStore = createModeStore(store.db);
  const skillRegistry = createSkillRegistry({ agentDir, extraSkillDirs: [] });
  const sseBus = createSseBus();
  let turnOrchestrator: any = null;
  let dagScheduler: any = null;
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

    // D21 event hook: the DAG scheduler observes plan updates and side-slot
    // completions. Never let scheduler failures break the broadcast path.
    if (dagScheduler) {
      try {
        dagScheduler.handleEvent(eventName, payload);
      } catch (error) {
        console.error(`[dag-scheduler] handleEvent(${eventName}) failed: ${String(error)}`);
      }
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

  // DAG scheduler-owned deliveries (idempotency key prefixes dag-node: /
  // dag-resume: / dag-verify:) are dispatched directly by the scheduler
  // wiring, in parallel, bounded by the scheduler's own D24 concurrency cap.
  // The global serial drain must not claim them first — that would
  // re-serialize DAG child conversations behind one worker loop.
  // Trust boundary: the key prefix alone is model-controllable (agents may
  // pass arbitrary idempotency keys), so ownership also requires the
  // persisted operator principal — every scheduler delivery is persisted
  // via the spawn service or submitFromSystem with principalKind
  // 'operator'. A forged agent delivery with a dag-* key falls through to
  // the normal serial drain instead of hijacking the direct path.
  function isDagSchedulerDelivery(delivery: any) {
    const key = String(delivery && delivery.idempotencyKey || '');
    if (String(delivery && delivery.principalKind || '') !== 'operator') {
      return false;
    }
    return key.startsWith('dag-node:') || key.startsWith('dag-resume:') || key.startsWith('dag-verify:');
  }

  function dispatchDagDeliveryNow(result: any) {
    const delivery = result && result.delivery;
    if (!delivery || !isDagSchedulerDelivery(delivery)) {
      return;
    }
    if (!crossConversationDeliveryWorker
      || typeof crossConversationDeliveryWorker.processDeliveryById !== 'function') {
      // Custom/injected worker without direct dispatch: degrade to the drain.
      requestCrossConversationDeliveryDrain();
      return;
    }
    if (String(delivery.dispatchStatus || '') !== 'queued') {
      return; // duplicate canonical already claimed/running/completed elsewhere
    }
    void Promise.resolve(crossConversationDeliveryWorker.processDeliveryById(delivery.id))
      .catch((error: any) => {
        console.error(
          `[dag-scheduler] Direct dispatch failed for ${delivery.id}: ${
            error && (error as any).stack ? (error as any).stack : error
          }`
        );
        // Never strand the delivery: fall back to the serial drain (an
        // abandoned claim is requeued by recoverExpiredClaims).
        requestCrossConversationDeliveryDrain();
      });
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
    if (!isDagSchedulerDelivery(result.delivery)) {
      requestCrossConversationDeliveryDrain();
    }
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
    titleModelRunner: options.titleModelRunner,
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
    // D22: DAG node child conversations run inside their per-node worktree;
    // everything else uses the active project dir. dagScheduler is assigned
    // after construction, so resolve lazily and null-check.
    getProjectDir: (conversation?: any) => {
      if (conversation && dagScheduler && typeof dagScheduler.resolveConversationWorkdir === 'function') {
        const workdir = dagScheduler.resolveConversationWorkdir(conversation);
        if (workdir) {
          return workdir;
        }
      }
      if (conversation && String(conversation.worktreePath || '').trim()) {
        return String(conversation.worktreePath).trim();
      }
      if (conversation && String(conversation.projectScopeId || '').trim()) {
        const project = projectManager.listProjects()
          .find((candidate: any) => candidate && candidate.id === conversation.projectScopeId);
        if (project && project.path) {
          return String(project.path);
        }
      }
      return activeProjectDir;
    },
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
    modelCatalog,
    uploadsDir,
    executeConversationAgent: options.executeConversationAgent,
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

  const conversationSpawnService =
    options.conversationSpawnService
    || createConversationSpawnService({
      store,
      validateParticipants(input: any) {
        return roleService.validateConversationParticipants(input);
      },
      resolveProject(projectScopeId: any) {
        const normalizedProjectScopeId = String(projectScopeId || '').trim();
        return projectManager.listProjects()
          .find((project: any) => project && project.id === normalizedProjectScopeId) || null;
      },
      onBootstrapAvailable(result: any) {
        // DAG-managed bootstraps are dispatched directly by the scheduler
        // wiring (dispatchDagDeliveryNow) right after spawn returns.
        if (isDagSchedulerDelivery(result && result.delivery)) {
          return;
        }
        requestCrossConversationDeliveryDrain();
      },
    });

  // DAG execution scheduler (第二阶段, D21 event hook). Wired AFTER the spawn
  // service exists; handleEvent is called from broadcastEvent above (the
  // dagScheduler variable starts null, so early broadcasts are no-ops).
  if (options.dagScheduler !== null && options.dagScheduler !== false) {
    const resolveProjectDirForScope = (projectScopeId: any) => {
      const normalizedScopeId = String(projectScopeId || '').trim();
      const project = normalizedScopeId
        ? projectManager.listProjects().find((candidate: any) => candidate && candidate.id === normalizedScopeId)
        : null;
      return project && project.path ? String(project.path) : activeProjectDir;
    };

    const dagSchedulerFactory = typeof options.dagSchedulerFactory === 'function'
      ? options.dagSchedulerFactory
      : createDagScheduler;
    dagScheduler = dagSchedulerFactory({
      store,
      broadcastEvent,
      // D22: prepare the per-node worktree against the owning project's repo.
      // Merge nodes go through the merge executor (D11): integration branch
      // checked out from the upstream LCA into the dedicated worktree.
      prepareNodeWorktree({ ownerConversationId, plan, node }: any) {
        const owner = store.getConversationWithoutMessages(ownerConversationId);
        const repoRoot = resolveProjectDirForScope(owner && owner.projectScopeId);
        if (!repoRoot) {
          return { ok: false, error: 'no active project directory for worktree preparation' };
        }
        if (String(node && node.kind || '') === 'merge') {
          const nodeById = new Map<string, any>(
            (plan && plan.doc && Array.isArray(plan.doc.nodes) ? plan.doc.nodes : [])
              .map((candidate: any) => [String(candidate && candidate.id || '').trim(), candidate] as [string, any])
          );
          const upstreamBranches = (Array.isArray(node && node.depends_on) ? node.depends_on : [])
            .map((depId: any) => {
              const parent = nodeById.get(String(depId || '').trim());
              return parent ? String(parent.branch || '').trim() : '';
            });
          if (upstreamBranches.some((branch: string) => !branch)) {
            return { ok: false, error: 'dag_merge_missing_upstream_branch: every upstream node must declare a branch before the merge node can start' };
          }
          const mergeResult = prepareMergeNodeWorktree({
            repoRoot,
            planId: plan && plan.id,
            node: {
              id: node && node.id,
              branch: String(node && node.branch || '').trim() || `dag/${plan && String(plan.id || '').slice(0, 8)}/${node && node.id}`,
              base_branch: String(node && node.base_branch || '').trim() || undefined,
            },
            upstreamBranches,
          });
          if (!mergeResult.ok) {
            return { ok: false, error: `${mergeResult.code || 'dag_worktree_failed'}: ${mergeResult.reason || ''}`.trim() };
          }
          return { ok: true, path: mergeResult.path, reused: Boolean(mergeResult.reused) };
        }
        const result = prepareNodeWorktree({
          repoRoot,
          planId: plan && plan.id,
          nodeId: node && node.id,
          branch: String(node && node.branch || '').trim() || `dag/${plan && String(plan.id || '').slice(0, 8)}/${node && node.id}`,
          baseRef: String(node && node.base_branch || '').trim() || undefined,
        });
        if (!result.ok) {
          return { ok: false, error: `${result.code || 'dag_worktree_failed'}: ${result.error || result.reason || ''}`.trim() };
        }
        return { ok: true, path: result.path, reused: Boolean(result.reused) };
      },
      // D11/D19 fail-closed post-check: a merge node may only flip to done
      // when every source branch is merged into the integration HEAD and the
      // node verify command passes inside the integration worktree.
      verifyNodeCompletion({ ownerConversationId, plan, node }: any) {
        if (String(node && node.kind || '') !== 'merge') {
          return { ok: true };
        }
        const owner = store.getConversationWithoutMessages(ownerConversationId);
        const repoRoot = resolveProjectDirForScope(owner && owner.projectScopeId);
        if (!repoRoot) {
          return { ok: false, error: 'no active project directory for merge verification' };
        }
        const worktreePath = resolveDagWorktreePath(repoRoot, String(plan && plan.id || ''), String(node && node.id || ''));
        if (!worktreePath || !require('node:fs').existsSync(worktreePath)) {
          return { ok: false, error: 'integration worktree missing after reported merge completion' };
        }
        const nodeById = new Map<string, any>(
          (plan && plan.doc && Array.isArray(plan.doc.nodes) ? plan.doc.nodes : [])
            .map((candidate: any) => [String(candidate && candidate.id || '').trim(), candidate] as [string, any])
        );
        const sourceBranches = (Array.isArray(node && node.depends_on) ? node.depends_on : [])
          .map((depId: any) => {
            const parent = nodeById.get(String(depId || '').trim());
            return parent ? String(parent.branch || '').trim() : '';
          })
          .filter(Boolean);
        const verdict = verifyMergeOutcome({
          worktreePath,
          sourceBranches,
          verifyCommand: String(node && node.verify || '').trim() || undefined,
        });
        return verdict.ok ? { ok: true } : { ok: false, error: verdict.reason };
      },
      // D22 cwd hook backing store: derive the worktree path statelessly.
      resolveWorktreePathForNode({ ownerConversationId, plan, node }: any) {
        const owner = store.getConversationWithoutMessages(ownerConversationId);
        const repoRoot = resolveProjectDirForScope(owner && owner.projectScopeId);
        if (!repoRoot) {
          return null;
        }
        const worktreePath = resolveDagWorktreePath(repoRoot, String(plan && plan.id || ''), String(node && node.id || ''));
        if (!worktreePath) {
          return null;
        }
        try {
          return require('node:fs').existsSync(worktreePath) ? worktreePath : null;
        } catch {
          return null;
        }
      },
      // D25 reconcile support: a doing node whose scheduler-owned delivery is
      // still QUEUED (legacy pre-direct-dispatch row, or a torn persist) is
      // re-offered here for direct parallel dispatch. dispatchDagDeliveryNow
      // ignores anything not currently queued, and the claim is atomic.
      dispatchQueuedNodeDelivery({ ownerConversationId, plan, node }: any) {
        const planId = String(plan && plan.id || '').trim();
        const nodeId = String(node && node.id || '').trim();
        const activation = String(plan && plan.activatedAt || 'na');
        const keys = [
          [`operator:${ownerConversationId}:conversation_spawn`, `dag-node:${planId}:${nodeId}:${activation}`],
          [`system:${ownerConversationId}:conversation_notify`, `dag-resume:${planId}:${nodeId}:${activation}`],
        ];
        for (const [scope, key] of keys) {
          const bundle = store.getCrossConversationDeliveryBundleByIdempotency(scope, key);
          if (bundle && bundle.delivery) {
            dispatchDagDeliveryNow({ delivery: bundle.delivery });
          }
        }
      },
      // D13: spawn the node child conversation flat under the ROOT owner.
      // All root participants remain available for handoff/verification, but
      // the node's resolved worker is placed first and selected as primary so
      // normal routing and Goal Runner continuation keep driving that worker.
      async spawnNodeConversation({ ownerConversationId, node, initialMessage, clientRequestId, workerId }: any) {
        const owner = store.getConversationWithoutMessages(ownerConversationId);
        if (!owner) {
          throw new Error('Plan owner conversation not found');
        }
        const participants = (Array.isArray(owner.agents) ? owner.agents : [])
          .map((agent: any) => ({ agentId: agent && agent.id }))
          .filter((participant: any) => participant.agentId);
        if (participants.length === 0) {
          throw new Error('Plan owner conversation has no participant agents');
        }
        const primaryAgentId = String(workerId || '').trim();
        const workerIndex = participants.findIndex((participant: any) => participant.agentId === primaryAgentId);
        if (workerIndex < 0) {
          throw new Error(`Resolved DAG worker is not a participant: ${primaryAgentId || '(empty)'}`);
        }
        const [workerParticipant] = participants.splice(workerIndex, 1);
        participants.unshift(workerParticipant);
        const title = `DAG ${node.id}: ${String(node.title || node.id)}`.slice(0, 200);
        const result = await conversationSpawnService.spawn(ownerConversationId, {
          title,
          projectScopeId: owner.projectScopeId,
          participants,
          primaryAgentId,
          initialMessage,
          clientRequestId,
        });
        dispatchDagDeliveryNow(result);
        return { conversationId: result && result.conversation ? result.conversation.id : '' };
      },
      // D28 verification channel: scheduler-authored targeted delivery into
      // the spawned child conversation (verification request → verifier,
      // rejection feedback → worker), dispatched directly like resumes.
      async deliverNodeMessage({ ownerConversationId, conversationId, targetAgentId, content, idempotencyKey, messageMetadata }: any) {
        const result = crossConversationDeliveryService.submitFromSystem({
          sourceConversationId: ownerConversationId,
          targetConversationId: conversationId,
          targetAgentId,
          content,
          idempotencyKey,
          sourceAgentName: 'DAG Scheduler',
          messageMetadata,
        });
        dispatchDagDeliveryNow(result);
      },
      // D25: resume inside the ORIGINAL child conversation via a
      // system-principal notify delivery (dispatched directly, in parallel).
      async resumeNodeConversation({ ownerConversationId, conversation, node, content, idempotencyKey }: any) {
        const participants = (Array.isArray(conversation.agents) ? conversation.agents : [])
          .map((agent: any) => agent && agent.id)
          .filter(Boolean);
        if (participants.length === 0) {
          throw new Error('Spawned conversation has no participant agents');
        }
        const result = crossConversationDeliveryService.submitFromSystem({
          sourceConversationId: ownerConversationId,
          targetConversationId: conversation.id,
          targetAgentId: participants[0],
          content,
          idempotencyKey,
          sourceAgentName: 'DAG Scheduler',
          messageMetadata: {
            kind: 'dag_resume',
            dagResume: true,
            dagNodeId: String(node && node.id || '').trim(),
          },
        });
        dispatchDagDeliveryNow(result);
      },
    });
  }

  feishuIntegration = createFeishuIntegrationService({
    store,
    turnOrchestrator,
    client: feishuClient,
    modeStore,
    roleService,
    projectScopeId: projectManager.getActiveProjectId(),
    ...(Object.prototype.hasOwnProperty.call(options, 'feishuDefaultRoleIds')
      ? { defaultRoleIds: options.feishuDefaultRoleIds }
      : {}),
  });
  const feishuLongConnection = createFeishuLongConnectionSource({
    feishuService: feishuIntegration,
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
    createHealthController({ getHealthStatus }),
    createBootstrapController({ sseBus, turnOrchestrator, buildBootstrapPayload }),
    createFeishuController({ feishuService: feishuIntegration }),
    createMetricsController({ store }),
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
    createModelCatalogController({
      agentDir,
      host,
      port,
      csrfToken: providerConfigCsrfToken,
      getAuthority() {
        const address = server && server.address();
        const actualPort = address && typeof address === 'object' ? address.port : port;
        return new URL(buildToolBaseUrl(host, actualPort)).host;
      },
      catalogDocument: options.catalogDocument,
      loadCatalog: options.loadCatalog,
      onCommitted: () => modelCatalog.invalidate(),
    }),
    createProjectsController({ projectManager, syncActiveProject }),
    createAgentToolsController({ agentToolBridge }),
    createConversationDeliveriesController({
      store,
      deliveryWorker: crossConversationDeliveryWorker,
      onDeliveryAvailable: requestCrossConversationDeliveryDrain,
    }),
    createModesController({ modeStore }),
    createSkillsController({ store, skillRegistry }),
    createAgentsController({ store, skillRegistry, roleService }),
    createConversationPlanController({ store, broadcastEvent }),
    createConversationsController({
      store,
      conversationSpawnService,
      roleService,
      skillRegistry,
      projectManager,
      turnOrchestrator,
      buildBootstrapPayload,
      modeStore,
      broadcastEvent,
      agentDir,
      sqlitePath,
      digestOptions,
      skillDraftOptions,
      digestModelRunner: options.digestModelRunner,
      uploadService,
    }),
    createImageUploadController({
      store,
      uploadService,
      maxImageBytes: MAX_IMAGE_BYTES,
      maxImagesPerMessage: MAX_IMAGES_PER_MESSAGE,
      maxImageWidth: MAX_IMAGE_WIDTH,
      maxImageHeight: MAX_IMAGE_HEIGHT,
      maxImagePixels: MAX_IMAGE_PIXELS,
      allowedMimeTypes: ALLOWED_IMAGE_MIME_TYPES,
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

      if (requestUrl.pathname.startsWith('/uploads/')) {
        const uploadPathname = requestUrl.pathname.slice('/uploads'.length) || '/';
        serveStaticFile(res, uploadPathname, { publicDir: uploadsDir, isUpload: true });
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
      try {
        uploadService.reconcile();
      } catch {}

      startCrossConversationDeliveryRuntime();

      // D25: reconcile DAG execution state after restart (fire-and-forget).
      if (dagScheduler && typeof dagScheduler.reconcileOnStartup === 'function') {
        void Promise.resolve()
          .then(() => dagScheduler.reconcileOnStartup())
          .catch((error: any) => {
            console.error(`[dag-scheduler] startup reconcile failed: ${error && error.stack ? error.stack : error}`);
          });
      }

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

    const feishuClosePromise = feishuLongConnection
      ? Promise.resolve(feishuLongConnection.stop()).catch(() => null)
      : Promise.resolve();

    server.close(() => {
      const finishClose = () => {
        store.close();

        if (typeof callback === 'function') {
          callback();
        }
      };
      const pendingCloseWork = deliveryDrainPromise
        ? Promise.allSettled([deliveryDrainPromise, feishuClosePromise])
        : feishuClosePromise;

      void Promise.resolve(pendingCloseWork).then(finishClose, finishClose);
    });
  }

  return {
    close,
    agentToolBridge,
    crossConversationDeliveryService,
    crossConversationDeliveryWorker,
    conversationSpawnService,
    get dagScheduler() {
      return dagScheduler;
    },
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
