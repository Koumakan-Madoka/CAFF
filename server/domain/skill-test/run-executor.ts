import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { createHttpError } from '../../http/http-errors';
import { resolveToolRelativePath } from '../../http/path-utils';
import { ROOT_DIR } from '../../app/config';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, resolveSetting } from '../../../lib/minimal-pi';
import { createSqliteRunStore } from '../../../lib/sqlite-store';
import { ensureAgentSandbox, toPortableShellPath } from '../conversation/turn/agent-sandbox';
import { extractLiveSessionToolFromPiEvent } from '../conversation/turn/agent-executor';
import {
  buildSkillTestIsolationIssues,
  getSkillTestIsolationFailureMessage,
} from './isolation';
import {
  createEnvironmentFailureMessage,
  createSkippedEnvironmentResult,
  executeEnvironmentWorkflow,
  resolveEnvironmentRunConfig,
} from './environment-chain';
import {
  finalizeEnvironmentBuildCase as finalizeSkillTestEnvironmentBuildCase,
  getEnvironmentAssetRef,
  normalizeEnvironmentBuildInput,
  resolveEnvironmentAssetCheck,
  resolveSkillTestBridgeTokenTtlSeconds,
  summarizeEnvironmentBuildOutput,
} from './environment-assets';
import { createSkillTestEnvironmentRuntime } from './sandbox-tool-contract';
import {
  getReadToolPath,
  isPlainObject,
  isTargetSkillReadToolCall,
  mergeValidationIssues,
} from './case-schema';
import { buildSkillTestRunPrompt } from './run-prompt';

function safeJsonParse(value: any) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizePiToolContentType(value: any) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function extractPiToolCalls(piEvent: any) {
  const message = piEvent && piEvent.message && piEvent.message.role === 'assistant' ? piEvent.message : null;

  if (!message || !Array.isArray(message.content)) {
    return [];
  }

  const toolCalls: any[] = [];

  for (const item of message.content) {
    const type = normalizePiToolContentType(item && item.type ? item.type : '');

    if (type !== 'tool_call' && type !== 'toolcall' && type !== 'tool_use' && type !== 'tooluse') {
      continue;
    }

    if (!item || !item.name) {
      continue;
    }

    toolCalls.push({
      toolName: String(item.name || '').trim(),
      arguments: item.arguments !== undefined ? item.arguments : null,
      toolCallId: String(item.id || item.toolCallId || '').trim(),
    });
  }

  return toolCalls;
}

function liveSessionToolStepSignature(step: any) {
  if (!step || typeof step !== 'object') {
    return '';
  }

  return JSON.stringify([
    step && step.stepId ? String(step.stepId).trim() : '',
    step && step.toolName ? String(step.toolName).trim() : '',
    step && step.bridgeToolHint ? String(step.bridgeToolHint).trim() : '',
    step && step.status ? String(step.status).trim().toLowerCase() : '',
    step && step.requestSummary !== undefined ? step.requestSummary : null,
    step && step.partialJson ? String(step.partialJson) : '',
  ]);
}

function stopSkillTestRunHandle(handle: any, reason: string) {
  if (!handle || typeof handle !== 'object') {
    return;
  }

  if (typeof handle.complete === 'function') {
    handle.complete(reason);
    return;
  }

  if (typeof handle.cancel === 'function') {
    handle.cancel(reason);
  }
}

export function createSkillTestRunExecutor(options: any = {}) {
  const store = options.store;
  const agentToolBridge = options.agentToolBridge;
  const skillRegistry = options.skillRegistry;
  const getProjectDir = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  const startRunImpl = typeof options.startRunImpl === 'function' ? options.startRunImpl : null;
  const evaluateRunImpl = typeof options.evaluateRunImpl === 'function' ? options.evaluateRunImpl : null;
  const evaluateRun = typeof options.evaluateRun === 'function' ? options.evaluateRun : null;
  const skillTestIsolationDriver = options.skillTestIsolationDriver;
  const buildProviderAuthEnv = typeof options.buildProviderAuthEnv === 'function'
    ? options.buildProviderAuthEnv
    : () => ({});
  const buildSkillTestChainStepPrompt = typeof options.buildSkillTestChainStepPrompt === 'function'
    ? options.buildSkillTestChainStepPrompt
    : (basePrompt: string) => basePrompt;
  const buildSkillTestLiveTrace = typeof options.buildSkillTestLiveTrace === 'function'
    ? options.buildSkillTestLiveTrace
    : () => null;
  const broadcastSkillTestRunEvent = typeof options.broadcastSkillTestRunEvent === 'function'
    ? options.broadcastSkillTestRunEvent
    : () => {};
  const broadcastSkillTestToolEvent = typeof options.broadcastSkillTestToolEvent === 'function'
    ? options.broadcastSkillTestToolEvent
    : () => {};
  const collectSkillTestVisiblePathRoots = typeof options.collectSkillTestVisiblePathRoots === 'function'
    ? options.collectSkillTestVisiblePathRoots
    : () => [];
  const persistSkillTestRunSessionExport = typeof options.persistSkillTestRunSessionExport === 'function'
    ? options.persistSkillTestRunSessionExport
    : () => '';
  const buildSkillTestRunDebugSnapshot = typeof options.buildSkillTestRunDebugSnapshot === 'function'
    ? options.buildSkillTestRunDebugSnapshot
    : () => null;
  const mergeSkillTestRunDebugPayload = typeof options.mergeSkillTestRunDebugPayload === 'function'
    ? options.mergeSkillTestRunDebugPayload
    : (baseDebug: any, extraDebug: any) => (isPlainObject(extraDebug) ? { ...(isPlainObject(baseDebug) ? baseDebug : {}), ...extraDebug } : baseDebug);
  const buildSkillTestChatBridgeEvidence = typeof options.buildSkillTestChatBridgeEvidence === 'function'
    ? options.buildSkillTestChatBridgeEvidence
    : () => null;
  const buildSkillTestFailureDebugPayload = typeof options.buildSkillTestFailureDebugPayload === 'function'
    ? options.buildSkillTestFailureDebugPayload
    : () => null;
  const extractPiToolCallsImpl = typeof options.extractPiToolCalls === 'function'
    ? options.extractPiToolCalls
    : extractPiToolCalls;
  const liveSessionToolStepSignatureImpl = typeof options.liveSessionToolStepSignature === 'function'
    ? options.liveSessionToolStepSignature
    : liveSessionToolStepSignature;
  const stopSkillTestRunHandleImpl = typeof options.stopSkillTestRunHandle === 'function'
    ? options.stopSkillTestRunHandle
    : stopSkillTestRunHandle;
  const normalizeCaseForRunOrThrow = typeof options.normalizeCaseForRunOrThrow === 'function'
    ? options.normalizeCaseForRunOrThrow
    : null;
  const getTestCase = typeof options.getTestCase === 'function' ? options.getTestCase : () => null;
  const normalizeTestRunRow = typeof options.normalizeTestRunRow === 'function'
    ? options.normalizeTestRunRow
    : (row: any) => row;
  const getCaseValidityAfterEvaluation = typeof options.getCaseValidityAfterEvaluation === 'function'
    ? options.getCaseValidityAfterEvaluation
    : () => 'draft';
  const ensureSchema = typeof options.ensureSchema === 'function' ? options.ensureSchema : () => {};
  const normalizeRunStoreRunId = typeof options.normalizeRunStoreRunId === 'function'
    ? options.normalizeRunStoreRunId
    : (value: any) => value;
  const applySharedEnvironmentAssetDefault = typeof options.applySharedEnvironmentAssetDefault === 'function'
    ? options.applySharedEnvironmentAssetDefault
    : (_skillId: string, resolvedEnvironment: any) => ({ resolvedEnvironment, sharedAsset: null });
  const upsertSkillEnvironmentAsset = options.upsertSkillEnvironmentAsset;
  const updateTestCaseSourceMetadata = typeof options.updateTestCaseSourceMetadata === 'function'
    ? options.updateTestCaseSourceMetadata
    : () => null;
  const environmentCacheRootDir = String(options.environmentCacheRootDir || '').trim();
  const environmentManifestRootDir = String(options.environmentManifestRootDir || '').trim();
  const environmentImageBuilder = options.environmentImageBuilder;
  const skillTestBridgeTokenTtlSec = options.skillTestBridgeTokenTtlSec;
  const skillTestExecutionBridgeTokenTtlSec = options.skillTestExecutionBridgeTokenTtlSec;
  const skillTestChatApiUrl = String(options.skillTestChatApiUrl || '').trim();
  const nowIso = typeof options.nowIso === 'function' ? options.nowIso : () => new Date().toISOString();

  async function executeRun(testCase: any, runOptions: any = {}) {
    ensureSchema();

    if (!agentToolBridge) {
      throw createHttpError(501, 'Agent tool bridge is not configured');
    }
    if (!normalizeCaseForRunOrThrow) {
      throw new Error('normalizeCaseForRunOrThrow is required');
    }
    if (!startRunImpl) {
      throw new Error('startRunImpl is required');
    }
    if (!evaluateRun) {
      throw new Error('evaluateRun is required');
    }
    if (!skillTestIsolationDriver || typeof skillTestIsolationDriver.createCaseContext !== 'function') {
      throw new Error('skillTestIsolationDriver.createCaseContext is required');
    }

    const preflight = normalizeCaseForRunOrThrow(testCase);
    testCase = { ...testCase, ...preflight.normalizedCase, derivedFromLegacy: preflight.derivedFromLegacy };

    const liveSkill = skillRegistry ? skillRegistry.getSkill(testCase.skillId) : null;
    const basePrompt = buildSkillTestRunPrompt(testCase, liveSkill);
    if (!basePrompt) {
      throw createHttpError(400, 'Test case has no trigger prompt');
    }
    const prompt = buildSkillTestChainStepPrompt(basePrompt, runOptions.chainContext);

    const agentId = String(runOptions.agentId || 'skill-test-agent').trim();
    const agentName = String(runOptions.agentName || 'Skill Test Agent').trim();
    const provider = String(runOptions.provider || '').trim();
    const model = String(runOptions.model || '').trim();
    const promptVersion = String(runOptions.promptVersion || '').trim() || 'skill-test-v1';
    const effectiveProvider = resolveSetting(provider, process.env.PI_PROVIDER, DEFAULT_PROVIDER);
    const effectiveModel = resolveSetting(model, process.env.PI_MODEL, DEFAULT_MODEL);
    const loadingMode = String(testCase.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
    const testType = String(testCase.testType || '').trim().toLowerCase();
    const isEnvironmentBuildCase = testType === 'environment-build';
    const conversationId = `skill-test-${testCase.skillId}`;
    const turnId = `skill-test-turn-${testCase.id}`;
    const shouldEarlyStopOnSkillLoad = loadingMode === 'dynamic' && testType !== 'execution' && !isEnvironmentBuildCase;
    const timestamp = nowIso();
    const taskId = `skill-test-run-${randomUUID()}`;
    const liveMessageId = `skill-test-trace-${taskId}`;
    const promptUserMessage = {
      id: 'skill-test-user',
      turnId,
      role: 'user',
      senderName: 'TestUser',
      content: prompt,
      status: 'completed',
      createdAt: timestamp,
    };
    const agent = { id: agentId, name: agentName };
    const liveProjectDir = getProjectDir ? String(getProjectDir() || '').trim() : '';
    let resolvedEnvironment = resolveEnvironmentRunConfig(testCase, runOptions.environment, liveSkill, {
      allowTestingDocumentDefault: !shouldEarlyStopOnSkillLoad,
    });
    let inheritedSharedEnvironmentAsset: any = null;
    if (!isEnvironmentBuildCase) {
      const inheritedAssetResult = applySharedEnvironmentAssetDefault(testCase.skillId, resolvedEnvironment);
      resolvedEnvironment = inheritedAssetResult.resolvedEnvironment;
      inheritedSharedEnvironmentAsset = inheritedAssetResult.sharedAsset;
    }
    const environmentBuildInput = normalizeEnvironmentBuildInput(runOptions.environmentBuild);
    const environmentAsset = isEnvironmentBuildCase ? null : getEnvironmentAssetRef(resolvedEnvironment.config);

    let evalCaseId = testCase.evalCaseId;

    if (!evalCaseId) {
      evalCaseId = randomUUID();

      store.db
        .prepare(
          `INSERT INTO eval_cases (
            id, conversation_id, turn_id, message_id, stage_task_id,
            agent_id, agent_name, provider, model, thinking,
            prompt_version, expectations_json,
            prompt_a, output_a, note,
            created_at, updated_at
          ) VALUES (
            @id, @conversationId, @turnId, @messageId, @stageTaskId,
            @agentId, @agentName, @provider, @model, @thinking,
            @promptVersion, @expectationsJson,
            @promptA, @outputA, @note,
            @createdAt, @updatedAt
          )`
        )
        .run({
          id: evalCaseId,
          conversationId,
          turnId,
          messageId: '',
          stageTaskId: '',
          agentId,
          agentName,
          provider: effectiveProvider || null,
          model: effectiveModel || null,
          thinking: null,
          promptVersion,
          expectationsJson: JSON.stringify({
            source: 'skill_test',
            skillId: testCase.skillId,
            expectedTools: testCase.expectedTools || [],
          }),
          promptA: prompt,
          outputA: '',
          note: `Skill test: ${testCase.skillId} (${testCase.testType})`,
          createdAt: timestamp,
          updatedAt: timestamp,
        });

      store.db
        .prepare('UPDATE skill_test_cases SET eval_case_id = @evalCaseId, updated_at = @updatedAt WHERE id = @id')
        .run({ id: testCase.id, evalCaseId, updatedAt: timestamp });
    }

    const isolationContext = runOptions.sharedIsolationContext || await Promise.resolve(
      skillTestIsolationDriver.createCaseContext({
        caseId: testCase.id,
        runId: taskId,
        isolation: runOptions.isolation,
        agent,
        agentId,
        agentName,
        conversationId,
        turnId,
        promptUserMessage,
        liveStore: store,
        liveAgentDir: store.agentDir,
        liveDatabasePath: store.databasePath,
        liveProjectDir,
        skill: liveSkill,
        environmentImage: environmentAsset,
      })
    );
    const runtimeSkill = isolationContext && isolationContext.skill ? isolationContext.skill : liveSkill;
    const sandbox = isolationContext && isolationContext.sandbox ? isolationContext.sandbox : ensureAgentSandbox(store.agentDir, agent);
    const projectDir = isolationContext && isolationContext.projectDir ? String(isolationContext.projectDir).trim() : liveProjectDir;
    const runtimeAgentDir = isolationContext && isolationContext.agentDir ? String(isolationContext.agentDir).trim() : store.agentDir;
    const runtimeSqlitePath = isolationContext && isolationContext.sqlitePath ? String(isolationContext.sqlitePath).trim() : store.databasePath;
    const telemetryStore = isolationContext && isolationContext.store && isolationContext.store.db
      ? isolationContext.store
      : store;
    const runStore = createSqliteRunStore({
      agentDir: runtimeAgentDir,
      sqlitePath: telemetryStore && telemetryStore.databasePath ? telemetryStore.databasePath : runtimeSqlitePath,
      databasePath: telemetryStore && telemetryStore.databasePath ? telemetryStore.databasePath : runtimeSqlitePath,
      db: telemetryStore && telemetryStore.db ? telemetryStore.db : store.db,
    });
    const stage = {
      taskId,
      status: 'queued',
      runId: null as any,
      currentToolName: '',
      currentToolKind: '',
      currentToolStepId: '',
      currentToolStartedAt: null as any,
      currentToolInferred: false,
    };
    const sessionName = `skill-test-${testCase.id}-${Date.now()}`;

    let toolInvocation: any = null;
    let isolationEvidence: any = null;
    const shouldFinalizeIsolationContext = !runOptions.sharedIsolationContext && runOptions.skipIsolationFinalize !== true;
    let isolationFinalized = false;

    try {
      const bridgeTokenTtlSec = resolveSkillTestBridgeTokenTtlSeconds(testCase, runOptions, {
        defaultTtlSec: skillTestBridgeTokenTtlSec,
        executionTtlSec: skillTestExecutionBridgeTokenTtlSec,
      });

      toolInvocation = agentToolBridge.registerInvocation(
        agentToolBridge.createInvocationContext({
          conversationId,
          turnId,
          projectDir,
          agentId,
          agentName,
          assistantMessageId: liveMessageId,
          userMessageId: promptUserMessage.id,
          promptUserMessage,
          conversationAgents: [agent],
          authScope: 'skill-test',
          caseId: testCase.id,
          runId: taskId,
          taskId,
          tokenTtlSec: bridgeTokenTtlSec,
          requireAuthScope: true,
          store: isolationContext && isolationContext.store ? isolationContext.store : null,
          toolPolicy: isolationContext && isolationContext.toolPolicy ? isolationContext.toolPolicy : null,
          sandboxToolAdapter: isolationContext && isolationContext.sandboxToolAdapter ? isolationContext.sandboxToolAdapter : null,
          runStore,
          stage,
          turnState: null,
          enqueueAgent: null,
          allowHandoffs: false,
          dryRun: true,
        })
      );

      const agentToolScriptPath = path.resolve(ROOT_DIR, 'lib', 'agent-chat-tools.js');
      const agentToolRelativePath = resolveToolRelativePath(agentToolScriptPath);
      const skillTestSandboxExtensionPath = path.resolve(ROOT_DIR, 'lib', 'pi-skill-test-sandbox-extension.mjs');
      const isolationExecution = isolationContext && isolationContext.execution && typeof isolationContext.execution === 'object'
        ? isolationContext.execution
        : null;
      const visiblePathRoots = collectSkillTestVisiblePathRoots(
        isolationContext && isolationContext.extraEnv ? isolationContext.extraEnv : null,
        isolationExecution
      );
      const environmentConfigIssues = Array.isArray(resolvedEnvironment.issues) ? resolvedEnvironment.issues : [];

      runStore.createTask({
        taskId,
        kind: 'skill_test_run',
        title: `Skill test: ${testCase.skillId}`,
        status: 'queued',
        assignedAgent: 'pi',
        assignedRole: agentName,
        provider: effectiveProvider || null,
        model: effectiveModel || null,
        requestedSession: sessionName,
        sessionPath: null,
        inputText: prompt,
        metadata: {
          testCaseId: testCase.id,
          skillId: testCase.skillId,
          evalCaseId,
          source: 'skill_test',
          toolBridgeEnabled: true,
          toolBridgeDryRun: true,
          isolationMode: isolationContext && isolationContext.isolation ? isolationContext.isolation.mode : 'legacy-local',
          trellisMode: isolationContext && isolationContext.isolation ? isolationContext.isolation.trellisMode : 'none',
          isolationExecution: isolationExecution
            ? {
                loopRuntime: isolationExecution.loopRuntime || 'host',
                toolRuntime: isolationExecution.toolRuntime || 'host',
                pathSemantics: isolationExecution.pathSemantics || 'host',
              }
            : null,
          visiblePathRoots,
          environmentAssetDefault: inheritedSharedEnvironmentAsset
            ? {
                envProfile: inheritedSharedEnvironmentAsset.envProfile,
                status: inheritedSharedEnvironmentAsset.status,
                assetId: inheritedSharedEnvironmentAsset.id,
                image: inheritedSharedEnvironmentAsset.asset && inheritedSharedEnvironmentAsset.asset.image
                  ? inheritedSharedEnvironmentAsset.asset.image
                  : '',
              }
            : null,
        },
        startedAt: timestamp,
      });

      let result: any = null;
      let outputText = '';
      let liveOutputText = '';
      let status = 'succeeded';
      let errorMessage = '';
      let runId: any = null;
      let sessionPath = '';
      let dynamicSkillLoadConfirmed = false;
      let runFailureDebug: any = null;
      let environmentResult: any = resolvedEnvironment.enabled
        ? createSkippedEnvironmentResult('environment chain pending')
        : createSkippedEnvironmentResult('environment chain not requested');
      let environmentBuildResult: any = null;
      let startedEventSent = false;
      let lastLiveSessionToolStepId = '';
      let lastLiveSessionToolSignature = '';
      const liveSessionAnonymousToolTracker = {
        nextIndex: 0,
        activeStepId: '',
        activeFingerprint: '',
        activeToolName: '',
        activeToolKind: '',
      };
      const liveUsesSandboxTools = isolationExecution && isolationExecution.toolRuntime === 'sandbox';
      let liveExecutionRuntime = isolationExecution && isolationExecution.loopRuntime === 'sandbox' ? 'sandbox' : 'host';
      let liveProgressLabel = liveExecutionRuntime === 'sandbox'
        ? '正在准备 sandbox runner…'
        : liveUsesSandboxTools
          ? 'host loop 正在等待 sandbox 工具调用…'
          : '正在等待工具调用…';

      try {
        const providerAuthEnv = buildProviderAuthEnv(effectiveProvider);
        const environmentCommandEnv = {
          ...providerAuthEnv,
          ...(isolationContext && isolationContext.extraEnv ? isolationContext.extraEnv : {}),
        };
        const runtimeExtraEnv = {
          ...providerAuthEnv,
          PI_AGENT_ID: agentId,
          PI_AGENT_NAME: agentName,
          PI_AGENT_SANDBOX_DIR: sandbox.sandboxDir,
          PI_AGENT_PRIVATE_DIR: sandbox.privateDir,
          CAFF_CHAT_API_URL: skillTestChatApiUrl,
          CAFF_CHAT_INVOCATION_ID: toolInvocation.invocationId,
          CAFF_CHAT_CALLBACK_TOKEN: toolInvocation.callbackToken,
          CAFF_CHAT_TOOLS_PATH: toPortableShellPath(agentToolScriptPath),
          CAFF_CHAT_TOOLS_RELATIVE_PATH: agentToolRelativePath,
          CAFF_CHAT_CONVERSATION_ID: conversationId,
          CAFF_CHAT_TURN_ID: turnId,
          CAFF_SKILL_TEST_RUN_ID: taskId,
          CAFF_SKILL_TEST_CASE_ID: testCase.id,
          CAFF_SKILL_LOADING_MODE: testCase.loadingMode || 'dynamic',
          ...(isolationContext && isolationContext.sandboxToolAdapter ? { CAFF_SKILL_TEST_SANDBOX_TOOL_BRIDGE: '1' } : {}),
          ...(isolationContext && isolationContext.extraEnv ? isolationContext.extraEnv : {}),
        };
        const emitEnvironmentProgress = (phase: string, label: string) => {
          liveProgressLabel = label;
          const eventPhase = startedEventSent ? 'progress' : 'started';
          broadcastSkillTestRunEvent(eventPhase, {
            caseId: testCase.id,
            skillId: testCase.skillId,
            loadingMode,
            testType,
            conversationId,
            turnId,
            taskId,
            messageId: liveMessageId,
            runId: stage.runId || null,
            provider: effectiveProvider || '',
            model: effectiveModel || '',
            promptVersion,
            status: 'running',
            executionRuntime: liveExecutionRuntime,
            progressLabel: label,
            environmentPhase: phase,
            createdAt: timestamp,
            updatedAt: nowIso(),
            ...(startedEventSent ? {} : { trace: buildSkillTestLiveTrace(liveMessageId, taskId, 'streaming', stage.runId || null, timestamp, sessionPath, { runStore }) }),
          });
          startedEventSent = true;
        };

        const finalizeEnvironmentBuildCase = async () => finalizeSkillTestEnvironmentBuildCase({
          runtimeSkill,
          resolvedEnvironment,
          environmentResult,
          environmentBuildInput,
          testCase,
          taskId,
          environmentManifestRootDir,
          environmentImageBuilder,
          upsertSkillEnvironmentAsset,
          updateTestCaseSourceMetadata,
          runStore,
          emitProgress: emitEnvironmentProgress,
          nowIso,
        });

        if (isEnvironmentBuildCase && (!resolvedEnvironment.enabled || !resolvedEnvironment.config)) {
          environmentResult = {
            ...createSkippedEnvironmentResult('environment-build requires environmentConfig or TESTING.md skill-test-environment contract'),
            status: 'env_missing',
            phase: 'preflight',
            reason: 'environment-build requires environmentConfig or TESTING.md skill-test-environment contract',
          };
          status = 'failed';
          errorMessage = createEnvironmentFailureMessage(environmentResult);
        } else if (resolvedEnvironment.enabled && resolvedEnvironment.config) {
          stage.status = 'running';
          runStore.updateTask(taskId, {
            status: 'running',
            requestedSession: sessionName,
          });

          const assetCheck = isEnvironmentBuildCase ? null : resolveEnvironmentAssetCheck(resolvedEnvironment.config, runtimeSkill);
          if (assetCheck) {
            runStore.appendTaskEvent(taskId, 'skill_test_environment_phase', {
              phase: 'asset-check',
              label: assetCheck.status === 'passed' ? '已绑定可复用环境镜像…' : '环境镜像未就绪…',
              createdAt: nowIso(),
            });
            emitEnvironmentProgress('asset-check', assetCheck.status === 'passed' ? '已绑定可复用环境镜像…' : '环境镜像未就绪…');
            environmentResult = assetCheck;
          } else {
            const environmentRuntime = createSkillTestEnvironmentRuntime({
              sandboxToolAdapter: isolationContext && isolationContext.sandboxToolAdapter ? isolationContext.sandboxToolAdapter : null,
              toolRuntime: isolationExecution && isolationExecution.toolRuntime ? isolationExecution.toolRuntime : 'host',
              execution: isolationExecution || null,
              isolation: isolationContext && isolationContext.isolation ? isolationContext.isolation : null,
              driver: isolationContext && isolationContext.driver ? isolationContext.driver : null,
              projectDir,
              outputDir: isolationContext && isolationContext.outputDir ? isolationContext.outputDir : '',
              privateDir: sandbox.privateDir,
              skillId: testCase.skillId,
              environmentCacheRootDir,
              commandEnv: environmentCommandEnv,
              availableEnv: {
                ...process.env,
                ...environmentCommandEnv,
              },
            });
            environmentResult = await executeEnvironmentWorkflow(resolvedEnvironment.config, environmentRuntime, {
              allowBootstrap: resolvedEnvironment.allowBootstrap,
              persistAdvice: resolvedEnvironment.persistAdvice,
              source: resolvedEnvironment.source,
              onPhase: (phase: string, label: string) => {
                runStore.appendTaskEvent(taskId, 'skill_test_environment_phase', {
                  phase,
                  label,
                  createdAt: nowIso(),
                });
                emitEnvironmentProgress(phase, label);
              },
              onCommandResult: (phase: string, commandResult: any) => {
                runStore.appendTaskEvent(taskId, 'skill_test_environment_command', {
                  phase,
                  ...commandResult,
                  createdAt: nowIso(),
                });
              },
            });

            if (resolvedEnvironment.source && typeof resolvedEnvironment.source === 'object') {
              environmentResult.source = resolvedEnvironment.source;
            }
          }

          if (environmentResult.status !== 'passed' && environmentResult.status !== 'skipped') {
            status = 'failed';
            errorMessage = createEnvironmentFailureMessage(environmentResult);
          }
        }

        if (status === 'succeeded' && isEnvironmentBuildCase) {
          emitEnvironmentProgress('manifest', '正在写入环境 manifest…');
          environmentBuildResult = await finalizeEnvironmentBuildCase();
          outputText = summarizeEnvironmentBuildOutput(environmentBuildResult) || 'environment manifest generated';
          if (environmentBuildResult && environmentBuildResult.status === 'image_build_failed') {
            status = 'failed';
            errorMessage = environmentBuildResult.error || 'environment image build failed';
          }
        } else if (status === 'succeeded') {
          const handle = await Promise.resolve(startRunImpl(effectiveProvider, effectiveModel, prompt, {
            thinking: '',
            agentDir: runtimeAgentDir,
            sqlitePath: runtimeSqlitePath,
            cwd: projectDir || undefined,
            extensionPaths: isolationContext && isolationContext.sandboxToolAdapter ? [skillTestSandboxExtensionPath] : undefined,
            streamOutput: false,
            session: sessionName,
            taskId,
            taskKind: 'skill_test_run',
            taskRole: agentName,
            metadata: {
              testCaseId: testCase.id,
              skillId: testCase.skillId,
              evalCaseId,
              source: 'skill_test',
            },
            extraEnv: runtimeExtraEnv,
          }));

          stage.runId = handle.runId || null;
          stage.status = 'running';
          sessionPath = handle.sessionPath || '';

          runStore.updateTask(taskId, {
            status: 'running',
            runId: normalizeRunStoreRunId(handle.runId),
            requestedSession: sessionName,
            sessionPath: handle.sessionPath || null,
          });

          liveExecutionRuntime = isolationExecution && isolationExecution.loopRuntime === 'sandbox' ? 'sandbox' : 'host';
          liveProgressLabel = liveExecutionRuntime === 'sandbox'
            ? '正在准备 sandbox runner…'
            : liveUsesSandboxTools
              ? 'host loop 正在等待 sandbox 工具调用…'
              : '正在等待工具调用…';

          broadcastSkillTestRunEvent(startedEventSent ? 'progress' : 'started', {
            caseId: testCase.id,
            skillId: testCase.skillId,
            loadingMode,
            testType,
            conversationId,
            turnId,
            taskId,
            messageId: liveMessageId,
            runId: handle.runId || null,
            provider: effectiveProvider || '',
            model: effectiveModel || '',
            promptVersion,
            status: 'running',
            executionRuntime: liveExecutionRuntime,
            progressLabel: liveProgressLabel,
            createdAt: timestamp,
            updatedAt: nowIso(),
            trace: buildSkillTestLiveTrace(liveMessageId, taskId, 'streaming', handle.runId || null, timestamp, sessionPath, { runStore }),
          });
          startedEventSent = true;

          const broadcastLiveRunnerProgress = (event: any, fallbackLabel = '正在 sandbox 内执行…') => {
            const eventPayload = event && typeof event === 'object' ? event : {};
            const nextLabel = String(eventPayload.label || fallbackLabel || '').trim();
            if (!nextLabel) {
              return;
            }
            liveProgressLabel = nextLabel;
            broadcastSkillTestRunEvent('progress', {
              caseId: testCase.id,
              skillId: testCase.skillId,
              loadingMode,
              testType,
              conversationId,
              turnId,
              taskId,
              messageId: liveMessageId,
              runId: stage.runId || null,
              provider: effectiveProvider || '',
              model: effectiveModel || '',
              promptVersion,
              status: 'running',
              executionRuntime: liveExecutionRuntime,
              progressLabel: liveProgressLabel,
              runnerStage: eventPayload.stage ? String(eventPayload.stage).trim() : '',
              runnerPid: eventPayload.pid !== undefined && eventPayload.pid !== null ? eventPayload.pid : null,
              runnerSessionPath: eventPayload.sessionPath ? String(eventPayload.sessionPath).trim() : '',
              createdAt: timestamp,
              updatedAt: nowIso(),
            });
          };

          if (handle && typeof handle.on === 'function') {
            handle.on('run_started', (event: any) => {
              const eventPayload = event && typeof event === 'object' ? event : {};
              broadcastLiveRunnerProgress({
                ...eventPayload,
                stage: eventPayload.stage || 'run_started',
                label: eventPayload.label || 'sandbox runner 已启动，等待工具或输出…',
              }, 'sandbox runner 已启动，等待工具或输出…');
            });

            handle.on('runner_status', (event: any) => {
              broadcastLiveRunnerProgress(event, '正在 sandbox 内执行…');
            });

            handle.on('pi_event', (event: any) => {
              const piEvent = event && event.piEvent ? event.piEvent : null;
              const liveTool = extractLiveSessionToolFromPiEvent(piEvent, {
                agentDir: runtimeAgentDir,
                createdAt: nowIso(),
                currentToolName: stage.currentToolName,
                currentToolKind: stage.currentToolKind,
                currentToolStepId: stage.currentToolStepId,
                anonymousTracker: liveSessionAnonymousToolTracker,
              });

              if (liveTool && liveTool.currentTool) {
                const nextTool = liveTool.currentTool;
                stage.currentToolName = nextTool.toolName || '';
                stage.currentToolKind = nextTool.toolKind || '';
                stage.currentToolStepId = nextTool.toolStepId || '';
                stage.currentToolInferred = Boolean(nextTool.inferred);
                stage.currentToolStartedAt = nowIso();
              }

              const step = liveTool && liveTool.step ? liveTool.step : null;
              const stepId = step && step.stepId ? String(step.stepId).trim() : '';
              const stepSignature = liveSessionToolStepSignatureImpl(step);
              const changed = Boolean(stepId && stepId !== lastLiveSessionToolStepId);
              const detailChanged = Boolean(
                step &&
                  stepId &&
                  stepSignature &&
                  stepId === lastLiveSessionToolStepId &&
                  stepSignature !== lastLiveSessionToolSignature
              );

              if (stepId && stepSignature) {
                lastLiveSessionToolStepId = stepId;
                lastLiveSessionToolSignature = stepSignature;
              } else if (changed) {
                lastLiveSessionToolStepId = '';
                lastLiveSessionToolSignature = '';
              }

              if (step && (changed || detailChanged)) {
                broadcastSkillTestToolEvent({
                  conversationId,
                  turnId,
                  taskId,
                  agentId,
                  agentName,
                  assistantMessageId: liveMessageId,
                  messageId: liveMessageId,
                  phase: changed ? 'started' : 'updated',
                  step,
                });
              }

              const matchedSkillLoadCall = shouldEarlyStopOnSkillLoad && !dynamicSkillLoadConfirmed
                ? extractPiToolCallsImpl(piEvent).find((toolCall: any) => (
                  isTargetSkillReadToolCall(toolCall.toolName, toolCall.arguments, testCase.skillId, runtimeSkill && runtimeSkill.path)
                ))
                : null;
              if (matchedSkillLoadCall) {
                dynamicSkillLoadConfirmed = true;
                runStore.appendTaskEvent(taskId, 'skill_test_dynamic_load_confirmed', {
                  caseId: testCase.id,
                  skillId: testCase.skillId,
                  path: getReadToolPath(matchedSkillLoadCall.arguments),
                  toolCallId: matchedSkillLoadCall.toolCallId || '',
                });
                stopSkillTestRunHandleImpl(handle, 'Dynamic skill load confirmed');
              }
            });

            handle.on('assistant_text_delta', (event: any) => {
              const delta = event && event.delta !== undefined ? String(event.delta || '') : '';
              if (!delta) {
                return;
              }
              liveOutputText += delta;
              liveProgressLabel = event && event.isFallback ? '正在同步模型输出…' : '模型正在输出…';
              broadcastSkillTestRunEvent('output_delta', {
                caseId: testCase.id,
                skillId: testCase.skillId,
                loadingMode,
                testType,
                conversationId,
                turnId,
                taskId,
                messageId: liveMessageId,
                runId: stage.runId || null,
                provider: effectiveProvider || '',
                model: effectiveModel || '',
                promptVersion,
                status: 'running',
                executionRuntime: liveExecutionRuntime,
                progressLabel: liveProgressLabel,
                delta,
                outputText: liveOutputText,
                isFallback: Boolean(event && event.isFallback),
                messageKey: event && event.messageKey ? String(event.messageKey) : '',
                createdAt: timestamp,
                updatedAt: nowIso(),
              });
            });

            handle.on('run_terminating', (event: any) => {
              broadcastSkillTestRunEvent('terminating', {
                caseId: testCase.id,
                skillId: testCase.skillId,
                loadingMode,
                testType,
                conversationId,
                turnId,
                taskId,
                messageId: liveMessageId,
                runId: stage.runId || null,
                status: 'terminating',
                executionRuntime: liveExecutionRuntime,
                progressLabel: '正在收尾…',
                reason: event && event.reason ? event.reason : null,
              });
            });
          }

          result = await handle.resultPromise;
          runId = result && result.runId ? result.runId : handle.runId || null;
          sessionPath = (result && result.sessionPath) || sessionPath;
          outputText = String(result && result.reply !== undefined ? result.reply : liveOutputText || '');
          if (!outputText && liveOutputText) {
            outputText = liveOutputText;
          }
          status = 'succeeded';
        }
      } catch (error) {
        const err: any = error;
        if (shouldEarlyStopOnSkillLoad && dynamicSkillLoadConfirmed) {
          runId = err && err.runId ? err.runId : stage.runId || null;
          sessionPath = (err && err.sessionPath) || sessionPath;
          outputText = String(err && err.reply ? err.reply : liveOutputText || '');
          result = {
            reply: outputText,
            runId,
            sessionPath,
          };
          status = 'succeeded';
          errorMessage = '';
        } else {
          status = 'failed';
          outputText = String(err && err.reply ? err.reply : liveOutputText || '');
          errorMessage = err && err.message ? String(err.message) : String(err || 'Unknown error');
          runFailureDebug = buildSkillTestFailureDebugPayload(err, {
            runId: stage.runId || runId,
            sessionPath: (err && err.sessionPath) || sessionPath,
          });
        }
      } finally {
        stage.status = status === 'succeeded' ? 'completed' : 'failed';
        if (toolInvocation) {
          const closedInvocation = agentToolBridge.unregisterInvocation(toolInvocation.invocationId);
          if (closedInvocation && typeof closedInvocation === 'object') {
            toolInvocation = closedInvocation;
          }
        }
      }

      const evaluation = status === 'succeeded' && isEnvironmentBuildCase
        ? {
          triggerPassed: null,
          executionPassed: 1,
          toolAccuracy: null,
          actualToolsJson: '[]',
          triggerEvaluation: null,
          executionEvaluation: {
            verdict: 'pass',
            status: environmentBuildResult && environmentBuildResult.status || 'manifest_ready',
            manifestPath: environmentBuildResult && environmentBuildResult.manifestPath || '',
            image: environmentBuildResult && environmentBuildResult.image || '',
          },
          requiredStepCompletionRate: null,
          stepCompletionRate: null,
          requiredToolCoverage: null,
          toolCallSuccessRate: null,
          toolErrorRate: null,
          sequenceAdherence: null,
          goalAchievement: 1,
          instructionAdherence: null,
          verdict: 'pass',
          evaluation: {
            verdict: 'pass',
            summary: 'environment-build case generated an environment manifest',
            dimensions: {},
            environmentBuild: environmentBuildResult,
          },
          validationIssues: [],
        }
        : status === 'succeeded'
          ? await Promise.resolve(
            evaluateRunImpl
              ? evaluateRunImpl(taskId, testCase, {
                outputText,
                sessionPath,
                status,
                provider: effectiveProvider,
                model: effectiveModel,
                promptVersion,
                agentId,
                agentName,
                taskId,
                prompt,
                sandbox,
                projectDir,
                agentDir: runtimeAgentDir,
                sqlitePath: runtimeSqlitePath,
                extraEnv: isolationContext && isolationContext.extraEnv ? isolationContext.extraEnv : {},
                skill: runtimeSkill,
                runStore,
              })
              : evaluateRun(taskId, testCase, {
                outputText,
                sessionPath,
                status,
                provider: effectiveProvider,
                model: effectiveModel,
                promptVersion,
                agentId,
                agentName,
                taskId,
                prompt,
                sandbox,
                projectDir,
                agentDir: runtimeAgentDir,
                sqlitePath: runtimeSqlitePath,
                extraEnv: isolationContext && isolationContext.extraEnv ? isolationContext.extraEnv : {},
                skill: runtimeSkill,
                runStore,
              })
          )
          : {
            triggerPassed: null,
            executionPassed: null,
            toolAccuracy: null,
            actualToolsJson: '[]',
            triggerEvaluation: null,
            executionEvaluation: null,
            requiredStepCompletionRate: null,
            stepCompletionRate: null,
            requiredToolCoverage: null,
            toolCallSuccessRate: null,
            toolErrorRate: null,
            sequenceAdherence: null,
            goalAchievement: null,
            instructionAdherence: null,
            verdict: '',
            evaluation: null,
            validationIssues: [],
          };

      const finishedAt = nowIso();
      const completedTrace = buildSkillTestLiveTrace(
        liveMessageId,
        taskId,
        status === 'succeeded' ? 'completed' : 'failed',
        runId,
        timestamp,
        sessionPath,
        { runStore }
      );
      const debugSnapshot = buildSkillTestRunDebugSnapshot(taskId, outputText || '', sessionPath, { runStore });
      const testRunId = randomUUID();
      const sessionExportPath = persistSkillTestRunSessionExport(testRunId, sessionPath);
      const persistedDebugSnapshot = mergeSkillTestRunDebugPayload(
        debugSnapshot,
        sessionExportPath ? { sessionExportPath } : null
      );

      runStore.updateTask(taskId, {
        status: status === 'succeeded' ? 'succeeded' : 'failed',
        runId: normalizeRunStoreRunId(runId),
        sessionPath: sessionPath || null,
        outputText: outputText || '',
        errorMessage: errorMessage || '',
        endedAt: finishedAt,
      });

      isolationEvidence = isolationContext && shouldFinalizeIsolationContext ? await Promise.resolve(isolationContext.finalize()) : null;
      isolationFinalized = shouldFinalizeIsolationContext;
      if (isolationEvidence && typeof isolationEvidence === 'object') {
        isolationEvidence.chatBridge = buildSkillTestChatBridgeEvidence(toolInvocation, {
          agentToolBridge,
          toolBaseUrl: skillTestChatApiUrl,
          caseId: testCase.id,
          runId: taskId,
        });
      }
      const isolationIssues = buildSkillTestIsolationIssues(isolationEvidence);
      if (isolationEvidence && isolationEvidence.unsafe) {
        status = 'failed';
        errorMessage = errorMessage || getSkillTestIsolationFailureMessage(isolationEvidence);
      }
      const finalTraceStatus = status === 'succeeded' ? 'completed' : 'failed';
      if (completedTrace && typeof completedTrace === 'object') {
        if (completedTrace.message && typeof completedTrace.message === 'object') {
          completedTrace.message.status = finalTraceStatus;
        }
        if (completedTrace.task && typeof completedTrace.task === 'object') {
          completedTrace.task.status = status;
        }
      }
      const finalVerdict = isolationEvidence && isolationEvidence.unsafe
        ? 'fail'
        : status === 'failed'
          ? 'fail'
          : evaluation.verdict || '';
      const runValidation = {
        caseSchemaStatus: preflight.caseSchemaStatus,
        derivedFromLegacy: preflight.derivedFromLegacy,
        issues: mergeValidationIssues(evaluation.validationIssues, preflight.issues, environmentConfigIssues, isolationIssues),
      };
      const evaluationJsonPayload = isPlainObject(evaluation.evaluation)
        ? { ...evaluation.evaluation, environment: environmentResult, validation: runValidation, isolation: isolationEvidence }
        : { environment: environmentResult, validation: runValidation, isolation: isolationEvidence };
      if (environmentBuildResult) {
        evaluationJsonPayload.environmentBuild = environmentBuildResult;
      }

      broadcastSkillTestRunEvent(status === 'succeeded' ? 'completed' : 'failed', {
        caseId: testCase.id,
        skillId: testCase.skillId,
        loadingMode,
        testType,
        conversationId,
        turnId,
        taskId,
        messageId: liveMessageId,
        runId,
        provider: effectiveProvider || '',
        model: effectiveModel || '',
        promptVersion,
        status,
        executionRuntime: liveExecutionRuntime,
        progressLabel: '',
        errorMessage: errorMessage || '',
        outputText: outputText || '',
        createdAt: timestamp,
        finishedAt,
        trace: completedTrace,
      });

      const evalCaseRunId = randomUUID();
      const mergedRunDebug = mergeSkillTestRunDebugPayload(
        persistedDebugSnapshot,
        runFailureDebug ? { failure: runFailureDebug } : null
      );
      const runResult = {
        status,
        promptVersion,
        triggerPassed: evaluation.triggerPassed,
        executionPassed: evaluation.executionPassed,
        toolAccuracy: evaluation.toolAccuracy,
        actualTools: safeJsonParse(evaluation.actualToolsJson) || [],
        triggerEvaluation: evaluation.triggerEvaluation || null,
        executionEvaluation: evaluation.executionEvaluation || null,
        evaluation: evaluationJsonPayload,
        validation: runValidation,
        isolation: isolationEvidence,
        verdict: finalVerdict,
        trace: completedTrace,
        ...(mergedRunDebug ? { debug: mergedRunDebug } : {}),
        source: 'skill_test',
      };

      store.db
        .prepare(
          `INSERT INTO eval_case_runs (
            id, case_id, variant, provider, model, prompt_version, thinking,
            prompt, run_id, task_id, status, error_message,
            output_text, result_json, session_path, created_at
          ) VALUES (
            @id, @caseId, @variant, @provider, @model, @promptVersion, @thinking,
            @prompt, @runId, @taskId, @status, @errorMessage,
            @outputText, @resultJson, @sessionPath, @createdAt
          )`
        )
        .run({
          id: evalCaseRunId,
          caseId: evalCaseId,
          variant: 'B',
          provider: effectiveProvider || null,
          model: effectiveModel || null,
          promptVersion,
          thinking: null,
          prompt,
          runId,
          taskId,
          status,
          errorMessage: errorMessage || null,
          outputText: outputText || null,
          resultJson: JSON.stringify(runResult),
          sessionPath: sessionPath || null,
          createdAt: finishedAt,
        });

      store.db
        .prepare(
          `INSERT INTO skill_test_runs (
            id, test_case_id, eval_case_run_id, status,
            actual_tools_json, tool_accuracy, trigger_passed, execution_passed,
            required_step_completion_rate, step_completion_rate,
            required_tool_coverage, tool_call_success_rate, tool_error_rate,
            sequence_adherence, goal_achievement, instruction_adherence,
            environment_status, environment_phase,
            verdict, evaluation_json, error_message, created_at
          ) VALUES (
            @id, @testCaseId, @evalCaseRunId, @status,
            @actualToolsJson, @toolAccuracy, @triggerPassed, @executionPassed,
            @requiredStepCompletionRate, @stepCompletionRate,
            @requiredToolCoverage, @toolCallSuccessRate, @toolErrorRate,
            @sequenceAdherence, @goalAchievement, @instructionAdherence,
            @environmentStatus, @environmentPhase,
            @verdict, @evaluationJson, @errorMessage, @createdAt
          )`
        )
        .run({
          id: testRunId,
          testCaseId: testCase.id,
          evalCaseRunId,
          status,
          actualToolsJson: evaluation.actualToolsJson,
          toolAccuracy: evaluation.toolAccuracy,
          triggerPassed: evaluation.triggerPassed,
          executionPassed: evaluation.executionPassed,
          requiredStepCompletionRate: evaluation.requiredStepCompletionRate,
          stepCompletionRate: evaluation.stepCompletionRate,
          requiredToolCoverage: evaluation.requiredToolCoverage,
          toolCallSuccessRate: evaluation.toolCallSuccessRate,
          toolErrorRate: evaluation.toolErrorRate,
          sequenceAdherence: evaluation.sequenceAdherence,
          goalAchievement: evaluation.goalAchievement,
          instructionAdherence: evaluation.instructionAdherence,
          environmentStatus: String(environmentResult && environmentResult.status || '').trim(),
          environmentPhase: String(environmentResult && environmentResult.phase || '').trim(),
          verdict: finalVerdict,
          evaluationJson: JSON.stringify(evaluationJsonPayload),
          errorMessage: errorMessage || '',
          createdAt: finishedAt,
        });

      store.db
        .prepare(
          'UPDATE skill_test_cases SET validity_status = @validityStatus, updated_at = @updatedAt WHERE id = @id'
        )
        .run({ id: testCase.id, validityStatus: getCaseValidityAfterEvaluation(testCase, { ...evaluation, verdict: finalVerdict }), updatedAt: finishedAt });

      const runRow = store.db
        .prepare(
          `SELECT
             r.*,
             e.provider AS provider,
             e.model AS model,
             e.prompt_version AS prompt_version
           FROM skill_test_runs r
           LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
           WHERE r.id = @id`
        )
        .get({ id: testRunId });
      return {
        testCase: getTestCase(testCase.id),
        run: normalizeTestRunRow(runRow),
        issues: runValidation.issues,
        caseSchemaStatus: runValidation.caseSchemaStatus,
        derivedFromLegacy: runValidation.derivedFromLegacy,
      };
    } finally {
      if (shouldFinalizeIsolationContext && !isolationFinalized && isolationContext && typeof isolationContext.finalize === 'function') {
        try {
          await Promise.resolve(isolationContext.finalize());
        } catch {}
      }
      runStore.close();
    }
  }

  return {
    executeRun,
  };
}
