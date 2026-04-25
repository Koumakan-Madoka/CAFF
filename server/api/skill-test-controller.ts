import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendJson, sendTextDownload } from '../http/response';
import { migrateChatSchema, migrateRunSchema, migrateSkillTestSchema } from '../../storage/sqlite/migrations';
import { DEFAULT_PROVIDER, DEFAULT_THINKING, resolveSetting, startRun } from '../../lib/minimal-pi';
import { buildLlmGenerationPrompt, generateSkillTestPrompts } from '../../lib/skill-test-generator';
import { ROOT_DIR } from '../app/config';
import { isPathWithin } from '../domain/conversation/turn/session-export';
import { buildAssistantMessageToolTrace } from '../domain/runtime/message-tool-trace';
import { createSkillTestIsolationDriver } from '../domain/skill-test/isolation';
import {
  DEFAULT_ENVIRONMENT_CACHE_ROOT_DIR,
  DEFAULT_ENVIRONMENT_MANIFEST_ROOT_DIR,
  normalizeEnvironmentConfigInput,
} from '../domain/skill-test/environment-chain';
import {
  buildEnvironmentImageFromManifest,
  createSkillTestEnvironmentAssetStore,
} from '../domain/skill-test/environment-assets';
import {
  buildValidationEnvelope,
  buildValidationIssue,
  buildEffectiveCaseStatusSql,
  buildEffectiveExecutionPassedSql,
  buildEvaluationTimelineIds,
  buildExecutionRateEligibleRunSql,
  createValidationHttpError,
  DEFAULT_SKILL_TEST_BRIDGE_TOKEN_TTL_SECONDS,
  formatSkillMarkdownPathForMatch,
  getReadToolPath,
  hasBlockingValidationIssue,
  hasOwn,
  isPlainObject,
  isSkillMarkdownReadPath,
  isTargetSkillReadToolCall,
  mapCaseStatusToLegacyValidity,
  mergeValidationIssues,
  normalizeBooleanFlag,
  normalizeCaseForRun,
  normalizeExpectedStepsInput,
  normalizeExpectedToolSpecs,
  normalizePathForJson,
  normalizePositiveInteger,
  normalizePromptText,
  normalizeStepSequenceReference,
  normalizeToolPathForMatch,
  parseCaseStatus,
  resolveCaseStatus,
  resolveTestTypeForLoadingMode,
  roundMetric,
  sanitizeEvaluationRubric,
  sanitizeExpectedSequence,
  sanitizeExpectedToolSpecs,
  SKILL_TEST_SUMMARY_AVERAGE_METRICS,
  validateAndNormalizeCaseInput,
  validateJudgeOutput,
} from '../domain/skill-test/case-schema';
import { getCanonicalCasePrompt } from '../domain/skill-test/run-prompt';
import {
  SKILL_TESTING_DOC_TARGET_PATH,
  assertCanWriteTestingDocTarget,
  buildTestingDocContractSummary,
  hashTestingDocContent,
  readTestingDocFileInfo,
  resolveSkillTestingDocTarget,
} from '../domain/skill-test/testing-doc-target';
import { buildTestingDocDraftFromSkillContext } from '../domain/skill-test/testing-doc-draft';
import {
  SKILL_TEST_DESIGN_PHASES,
  getSkillTestDesignState,
  normalizeSkillTestMatrix,
} from '../domain/skill-test/chat-workbench-mode';
import { createSkillTestDesignService } from '../domain/skill-test/design-service';
import {
  buildSkillTestChainStepPrompt,
  createSkillTestChainRunner,
} from '../domain/skill-test/chain-runner';
import { createSkillTestRunEvaluationHelpers } from '../domain/skill-test/run-evaluation';
import { createSkillTestRunExecutor } from '../domain/skill-test/run-executor';
const { resolveProviderAuthEnv } = require('../domain/skill-test/open-sandbox-factory');

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

function nowIso() {
  return new Date().toISOString();
}

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

function summarizeBridgeAuthFromInvocation(toolInvocation: any, agentToolBridge: any = null) {
  if (agentToolBridge && typeof agentToolBridge.summarizeInvocationAuth === 'function') {
    const summary = agentToolBridge.summarizeInvocationAuth(toolInvocation);
    if (summary && typeof summary === 'object') {
      return summary;
    }
  }

  const auth = toolInvocation && toolInvocation.auth && typeof toolInvocation.auth === 'object' ? toolInvocation.auth : null;
  if (!auth) {
    return null;
  }

  return {
    scope: String(auth.scope || '').trim(),
    caseId: String(auth.caseId || '').trim(),
    runId: String(auth.runId || '').trim(),
    taskId: String(auth.taskId || '').trim(),
    tokenTtlSec: Number.isInteger(auth.tokenTtlSec) ? auth.tokenTtlSec : 0,
    createdAt: String(auth.createdAt || '').trim(),
    expiresAt: String(auth.expiresAt || '').trim(),
    validated: auth.validated === true,
    validatedCount: Number.isInteger(auth.validatedCount) ? auth.validatedCount : 0,
    lastValidatedAt: String(auth.lastValidatedAt || '').trim(),
    rejects: Array.isArray(auth.rejects) ? auth.rejects.slice() : [],
  };
}

function buildSkillTestChatBridgeEvidence(toolInvocation: any, options: any = {}) {
  const auth = summarizeBridgeAuthFromInvocation(toolInvocation, options.agentToolBridge);
  const configuredUrl = String(options.toolBaseUrl || '').trim();
  const rejects = auth && Array.isArray(auth.rejects) ? auth.rejects.slice() : [];
  const validatedCount = auth && Number.isInteger(auth.validatedCount) ? auth.validatedCount : 0;

  return {
    mode: 'direct-http',
    configured: Boolean(configuredUrl),
    configuredUrl,
    reachable: validatedCount > 0,
    dryRun: true,
    auth: auth
      ? {
          scope: auth.scope || '',
          caseId: auth.caseId || '',
          runId: auth.runId || '',
          taskId: auth.taskId || '',
          tokenTtlSec: auth.tokenTtlSec || 0,
          expiresAt: auth.expiresAt || '',
          validated: auth.validated === true,
          validatedCount,
          lastValidatedAt: auth.lastValidatedAt || '',
        }
      : {
          scope: 'skill-test',
          caseId: String(options.caseId || '').trim(),
          runId: String(options.runId || '').trim(),
          taskId: String(options.runId || '').trim(),
          tokenTtlSec: 0,
          expiresAt: '',
          validated: false,
          validatedCount: 0,
          lastValidatedAt: '',
        },
    rejects,
  };
}

function buildSkillTestFailureDebugPayload(error: any, options: any = {}) {
  const stderrTail = String(error && error.stderrTail || '').trim();
  const stdoutLines = Array.isArray(error && error.stdoutLines)
    ? error.stdoutLines.map((entry: any) => String(entry))
    : [];
  const assistantErrors = Array.isArray(error && error.assistantErrors)
    ? error.assistantErrors.map((entry: any) => String(entry))
    : [];
  const parseErrors = Number.isInteger(error && error.parseErrors) ? error.parseErrors : 0;
  const exitCode = Number.isInteger(error && error.exitCode) ? error.exitCode : null;
  const signal = error && error.signal ? String(error.signal).trim() : '';
  const runId = String(options.runId || error && error.runId || '').trim();
  const sessionPath = String(options.sessionPath || error && error.sessionPath || '').trim();
  const sandboxCommand = isPlainObject(error && error.sandboxCommand) ? { ...error.sandboxCommand } : null;

  if (
    !stderrTail &&
    stdoutLines.length === 0 &&
    assistantErrors.length === 0 &&
    parseErrors === 0 &&
    exitCode == null &&
    !signal &&
    !sandboxCommand &&
    !runId &&
    !sessionPath
  ) {
    return null;
  }

  return {
    ...(runId ? { runId } : {}),
    ...(sessionPath ? { sessionPath } : {}),
    stderrTail,
    stdoutLines,
    parseErrors,
    assistantErrors,
    sandboxCommand,
    exitCode,
    signal: signal || null,
  };
}

function mergeSkillTestRunDebugPayload(baseDebug: any, extraDebug: any) {
  if (!isPlainObject(extraDebug)) {
    return baseDebug;
  }

  return {
    ...(isPlainObject(baseDebug) ? baseDebug : {}),
    ...extraDebug,
  };
}

function parseStoredJsonField(rawValue: any, fieldName: string, expectedKind: 'array' | 'object', invalidCode: string) {
  const fallbackValue = expectedKind === 'array' ? [] : {};
  const text = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!text) {
    return { value: fallbackValue, issues: [] };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      value: fallbackValue,
      issues: [
        buildValidationIssue(invalidCode, 'error', fieldName, `${fieldName} stored JSON is invalid`),
      ],
    };
  }

  const valid = expectedKind === 'array' ? Array.isArray(parsed) : isPlainObject(parsed);
  if (!valid) {
    return {
      value: fallbackValue,
      issues: [
        buildValidationIssue(invalidCode, 'error', fieldName, `${fieldName} must be an ${expectedKind}`),
      ],
    };
  }

  return { value: parsed, issues: [] };
}

const SKILL_TEST_MATRIX_ARTIFACT_ROOT = '.tmp/skill-test-design';
const SKILL_TEST_MATRIX_ARTIFACT_MAX_BYTES = 1024 * 1024;

function normalizeSkillTestMatrixArtifactPath(value: any) {
  return String(value || '')
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/^[\'"]+|[\'"]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function isPathWithinDirectory(candidatePath: string, directoryPath: string) {
  const relativePath = path.relative(directoryPath, candidatePath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function resolveSkillTestMatrixArtifactPath(rawPath: any, projectDir: any) {
  const relativePath = normalizeSkillTestMatrixArtifactPath(rawPath);
  if (!relativePath) {
    throw createValidationHttpError(
      buildValidationIssue('matrix_artifact_path_required', 'error', 'matrixPath', '矩阵 artifact 路径不能为空')
    );
  }
  if (relativePath.includes('\0') || /^file:/iu.test(relativePath) || path.isAbsolute(relativePath) || /^[A-Za-z]:\//u.test(relativePath)) {
    throw createValidationHttpError(
      buildValidationIssue('matrix_artifact_path_invalid', 'error', 'matrixPath', '矩阵 artifact 必须使用项目内相对路径')
    );
  }
  if (!relativePath.startsWith(`${SKILL_TEST_MATRIX_ARTIFACT_ROOT}/`) || !relativePath.toLowerCase().endsWith('.json')) {
    throw createValidationHttpError(
      buildValidationIssue('matrix_artifact_path_invalid', 'error', 'matrixPath', '矩阵 artifact 必须位于 .tmp/skill-test-design/ 且使用 .json 文件')
    );
  }
  if (relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw createValidationHttpError(
      buildValidationIssue('matrix_artifact_path_invalid', 'error', 'matrixPath', '矩阵 artifact 路径不能包含空段或路径跳转')
    );
  }

  const projectRoot = path.resolve(String(projectDir || '').trim() || process.cwd());
  const artifactRoot = path.resolve(projectRoot, SKILL_TEST_MATRIX_ARTIFACT_ROOT);
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!isPathWithinDirectory(absolutePath, artifactRoot)) {
    throw createValidationHttpError(
      buildValidationIssue('matrix_artifact_path_invalid', 'error', 'matrixPath', '矩阵 artifact 路径越过了允许目录')
    );
  }

  return { relativePath, absolutePath };
}

function readSkillTestMatrixArtifact(rawPath: any, projectDir: any) {
  const resolved = resolveSkillTestMatrixArtifactPath(rawPath, projectDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.absolutePath);
  } catch {
    throw createValidationHttpError(
      buildValidationIssue('matrix_artifact_missing', 'error', 'matrixPath', '矩阵 artifact 文件不存在或不可读取')
    );
  }
  if (!stat.isFile()) {
    throw createValidationHttpError(
      buildValidationIssue('matrix_artifact_invalid', 'error', 'matrixPath', '矩阵 artifact 路径必须指向文件')
    );
  }
  if (stat.size > SKILL_TEST_MATRIX_ARTIFACT_MAX_BYTES) {
    throw createValidationHttpError(
      buildValidationIssue('matrix_artifact_too_large', 'error', 'matrixPath', '矩阵 artifact 超过 1MB 限制')
    );
  }

  try {
    return {
      relativePath: resolved.relativePath,
      matrix: JSON.parse(fs.readFileSync(resolved.absolutePath, 'utf8')),
    };
  } catch {
    throw createValidationHttpError(
      buildValidationIssue('matrix_artifact_json_invalid', 'error', 'matrixPath', '矩阵 artifact 必须是合法 JSON')
    );
  }
}

function sourceMessageMentionsMatrixArtifactPath(message: any, matrixPath: any) {
  const relativePath = normalizeSkillTestMatrixArtifactPath(matrixPath);
  if (!relativePath) {
    return false;
  }
  const content = normalizePathForJson(String(message && message.content || ''));
  return content.includes(relativePath) || content.includes(`./${relativePath}`);
}

function findConversationMessage(conversation: any, messageId: any) {
  const normalizedMessageId = String(messageId || '').trim();
  const messages = Array.isArray(conversation && conversation.messages) ? conversation.messages : [];
  if (!normalizedMessageId) {
    return null;
  }
  return messages.find((message: any) => message && String(message.id || '').trim() === normalizedMessageId) || null;
}

function findLatestConversationMessage(conversation: any) {
  const messages = Array.isArray(conversation && conversation.messages) ? conversation.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.id && (message.role === 'user' || message.role === 'assistant')) {
      return message;
    }
  }
  return null;
}

function normalizeRunStoreRunId(value: any) {
  const numericValue = typeof value === 'string'
    ? Number.parseInt(String(value).trim(), 10)
    : Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : null;
}

function normalizeTestCaseRow(row: any) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const loadingMode = String(row.loading_mode || 'dynamic').trim() || 'dynamic';
  const validityStatus = String(row.validity_status || 'pending').trim() || 'pending';
  const prompt = normalizePromptText(row.trigger_prompt);
  const environmentConfig = normalizeEnvironmentConfigInput(safeJsonParse(row.environment_config_json) || null).config;
  return {
    id: String(row.id || '').trim(),
    skillId: String(row.skill_id || '').trim(),
    evalCaseId: row.eval_case_id ? String(row.eval_case_id).trim() : null,
    testType: resolveTestTypeForLoadingMode(loadingMode, row.test_type),
    loadingMode,
    userPrompt: prompt,
    triggerPrompt: prompt,
    expectedTools: sanitizeExpectedToolSpecs(safeJsonParse(row.expected_tools_json) || []),
    expectedSteps: normalizeExpectedStepsInput(safeJsonParse(row.expected_steps_json) || [], safeJsonParse(row.expected_sequence_json) || [], safeJsonParse(row.expected_tools_json) || []).expectedSteps,
    expectedBehavior: String(row.expected_behavior || '').trim(),
    expectedGoal: String(row.expected_goal || '').trim(),
    expectedSequence: sanitizeExpectedSequence(safeJsonParse(row.expected_sequence_json) || []),
    evaluationRubric: sanitizeEvaluationRubric(safeJsonParse(row.evaluation_rubric_json) || {}),
    environmentConfig,
    validityStatus,
    caseStatus: resolveCaseStatus(row),
    generationProvider: String(row.generation_provider || '').trim(),
    generationModel: String(row.generation_model || '').trim(),
    generationCreatedAt: String(row.generation_created_at || '').trim(),
    sourceMetadata: isPlainObject(safeJsonParse(row.source_metadata_json)) ? safeJsonParse(row.source_metadata_json) : {},
    note: String(row.note || '').trim(),
    createdAt: String(row.created_at || '').trim(),
    updatedAt: String(row.updated_at || '').trim(),
  };
}

const EVALUATION_PROJECTION_DIMENSION_MAP = [
  { runKey: 'requiredStepCompletionRate', dimensionKey: 'requiredStepCompletionRate' },
  { runKey: 'stepCompletionRate', dimensionKey: 'stepCompletionRate' },
  { runKey: 'requiredToolCoverage', dimensionKey: 'requiredToolCoverage' },
  { runKey: 'toolCallSuccessRate', dimensionKey: 'toolCallSuccessRate' },
  { runKey: 'toolErrorRate', dimensionKey: 'toolErrorRate' },
  { runKey: 'sequenceAdherence', dimensionKey: 'sequenceAdherence' },
  { runKey: 'goalAchievement', dimensionKey: 'goalAchievement' },
  { runKey: 'instructionAdherence', dimensionKey: 'instructionAdherence' },
];

function normalizeProjectionMetricValue(value: any) {
  if (value == null || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return roundMetric(numeric);
}

function isSameNullableMetricValue(left: any, right: any) {
  if (left == null && right == null) {
    return true;
  }
  if (left == null || right == null) {
    return false;
  }
  return Math.abs(Number(left) - Number(right)) < 1e-6;
}

function mergeEvaluationValidationIssues(evaluation: any, issues: any[]) {
  if (!isPlainObject(evaluation) || !Array.isArray(issues) || issues.length === 0) {
    return evaluation;
  }
  const currentValidation = isPlainObject((evaluation as any).validation) ? (evaluation as any).validation : {};
  const currentIssues = Array.isArray((currentValidation as any).issues) ? (currentValidation as any).issues : [];
  return {
    ...(evaluation as any),
    validation: {
      ...currentValidation,
      issues: mergeValidationIssues(currentIssues, issues),
    },
  };
}

function normalizeRunEvaluationProjection(row: any) {
  const rowMetrics: Record<string, number | null> = {
    requiredStepCompletionRate: row && row.required_step_completion_rate != null ? Number(row.required_step_completion_rate) : null,
    stepCompletionRate: row && row.step_completion_rate != null ? Number(row.step_completion_rate) : null,
    requiredToolCoverage: row && row.required_tool_coverage != null ? Number(row.required_tool_coverage) : null,
    toolCallSuccessRate: row && row.tool_call_success_rate != null ? Number(row.tool_call_success_rate) : null,
    toolErrorRate: row && row.tool_error_rate != null ? Number(row.tool_error_rate) : null,
    sequenceAdherence: row && row.sequence_adherence != null ? Number(row.sequence_adherence) : null,
    goalAchievement: row && row.goal_achievement != null ? Number(row.goal_achievement) : null,
    instructionAdherence: row && row.instruction_adherence != null ? Number(row.instruction_adherence) : null,
  };
  const rowVerdict = String(row && row.verdict || '').trim();
  const issues: any[] = [];

  const rawEvaluationText = typeof row && typeof row.evaluation_json === 'string' ? row.evaluation_json.trim() : '';
  const parsedEvaluation = safeJsonParse(row && row.evaluation_json);
  if (!rawEvaluationText) {
    return {
      metrics: rowMetrics,
      verdict: rowVerdict,
      evaluation: null,
      issues,
    };
  }

  if (!isPlainObject(parsedEvaluation)) {
    issues.push(
      buildValidationIssue(
        'evaluation_projection_failed',
        'warning',
        'evaluation',
        'evaluation_json is not a valid object; mirror metrics projection was skipped'
      )
    );
    return {
      metrics: {
        ...rowMetrics,
        requiredStepCompletionRate: null,
        stepCompletionRate: null,
        requiredToolCoverage: null,
        toolCallSuccessRate: null,
        toolErrorRate: null,
        sequenceAdherence: null,
        goalAchievement: null,
        instructionAdherence: null,
      },
      verdict: rowVerdict,
      evaluation: null,
      issues,
    };
  }

  const evaluation = { ...(parsedEvaluation as any) };
  const dimensions = isPlainObject((evaluation as any).dimensions) ? (evaluation as any).dimensions : null;
  const hasMirrorMetrics = EVALUATION_PROJECTION_DIMENSION_MAP.some((entry) => rowMetrics[entry.runKey] != null);

  if (!dimensions) {
    if (hasMirrorMetrics) {
      issues.push(
        buildValidationIssue(
          'evaluation_projection_failed',
          'warning',
          'evaluation.dimensions',
          'evaluation_json.dimensions is missing; mirror metrics cannot be projected'
        )
      );
    }
    return {
      metrics: hasMirrorMetrics
        ? {
          ...rowMetrics,
          requiredStepCompletionRate: null,
          stepCompletionRate: null,
          requiredToolCoverage: null,
          toolCallSuccessRate: null,
          toolErrorRate: null,
          sequenceAdherence: null,
          goalAchievement: null,
          instructionAdherence: null,
        }
        : rowMetrics,
      verdict: String((evaluation as any).verdict || '').trim() || rowVerdict,
      evaluation: mergeEvaluationValidationIssues(evaluation, issues),
      issues,
    };
  }

  const projectedMetrics: Record<string, number | null> = {
    requiredStepCompletionRate: null,
    stepCompletionRate: null,
    requiredToolCoverage: null,
    toolCallSuccessRate: null,
    toolErrorRate: null,
    sequenceAdherence: null,
    goalAchievement: null,
    instructionAdherence: null,
  };
  const mismatchedFields: string[] = [];
  const invalidProjectionFields: string[] = [];

  for (const entry of EVALUATION_PROJECTION_DIMENSION_MAP) {
    const rawDimension = (dimensions as any)[entry.dimensionKey];
    if (rawDimension == null) {
      projectedMetrics[entry.runKey] = null;
      if (!isSameNullableMetricValue(rowMetrics[entry.runKey], null)) {
        mismatchedFields.push(entry.runKey);
      }
      continue;
    }

    if (!isPlainObject(rawDimension) || !hasOwn(rawDimension, 'score')) {
      invalidProjectionFields.push(entry.runKey);
      continue;
    }

    const projectedValue = normalizeProjectionMetricValue((rawDimension as any).score);
    if ((rawDimension as any).score != null && projectedValue == null) {
      invalidProjectionFields.push(entry.runKey);
      continue;
    }

    projectedMetrics[entry.runKey] = projectedValue;
    if (!isSameNullableMetricValue(rowMetrics[entry.runKey], projectedValue)) {
      mismatchedFields.push(entry.runKey);
    }
  }

  const projectedVerdict = String((evaluation as any).verdict || '').trim();
  if (projectedVerdict && rowVerdict && projectedVerdict !== rowVerdict) {
    mismatchedFields.push('verdict');
  }

  if (invalidProjectionFields.length > 0) {
    issues.push(
      buildValidationIssue(
        'evaluation_projection_failed',
        'warning',
        'evaluation.dimensions',
        `evaluation_json dimensions cannot be projected for fields: ${invalidProjectionFields.join(', ')}`
      )
    );
    return {
      metrics: {
        ...projectedMetrics,
        requiredStepCompletionRate: null,
        stepCompletionRate: null,
        requiredToolCoverage: null,
        toolCallSuccessRate: null,
        toolErrorRate: null,
        sequenceAdherence: null,
        goalAchievement: null,
        instructionAdherence: null,
      },
      verdict: projectedVerdict || rowVerdict,
      evaluation: mergeEvaluationValidationIssues(evaluation, issues),
      issues,
    };
  }

  if (mismatchedFields.length > 0) {
    issues.push(
      buildValidationIssue(
        'evaluation_projection_mismatch',
        'warning',
        'evaluation',
        `Mirror columns diverge from evaluation_json for fields: ${mismatchedFields.join(', ')}`
      )
    );
  }

  return {
    metrics: projectedMetrics,
    verdict: projectedVerdict || rowVerdict,
    evaluation: mergeEvaluationValidationIssues(evaluation, issues),
    issues,
  };
}

function normalizeTestRunRow(row: any) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const normalizedProjection = normalizeRunEvaluationProjection(row);
  const evaluationEnvironment = normalizedProjection.evaluation && typeof normalizedProjection.evaluation === 'object'
    ? normalizedProjection.evaluation.environment || null
    : null;
  const isolation = normalizedProjection.evaluation && typeof normalizedProjection.evaluation === 'object'
    ? normalizedProjection.evaluation.isolation || null
    : null;
  return {
    id: String(row.id || '').trim(),
    testCaseId: String(row.test_case_id || '').trim(),
    evalCaseRunId: row.eval_case_run_id ? String(row.eval_case_run_id).trim() : null,
    status: String(row.status || 'pending').trim(),
    provider: String(row.provider || '').trim(),
    model: String(row.model || '').trim(),
    promptVersion: String(row.prompt_version || '').trim(),
    actualTools: safeJsonParse(row.actual_tools_json) || [],
    toolAccuracy: row.tool_accuracy != null ? Number(row.tool_accuracy) : null,
    triggerPassed: row.trigger_passed != null ? Boolean(row.trigger_passed) : null,
    executionPassed: row.execution_passed != null ? Boolean(row.execution_passed) : null,
    requiredStepCompletionRate: normalizedProjection.metrics.requiredStepCompletionRate,
    stepCompletionRate: normalizedProjection.metrics.stepCompletionRate,
    requiredToolCoverage: normalizedProjection.metrics.requiredToolCoverage,
    toolCallSuccessRate: normalizedProjection.metrics.toolCallSuccessRate,
    toolErrorRate: normalizedProjection.metrics.toolErrorRate,
    sequenceAdherence: normalizedProjection.metrics.sequenceAdherence,
    goalAchievement: normalizedProjection.metrics.goalAchievement,
    instructionAdherence: normalizedProjection.metrics.instructionAdherence,
    verdict: normalizedProjection.verdict,
    evaluation: normalizedProjection.evaluation,
    environmentStatus: String(row.environment_status || evaluationEnvironment && evaluationEnvironment.status || '').trim(),
    environmentPhase: String(row.environment_phase || evaluationEnvironment && evaluationEnvironment.phase || '').trim(),
    isolation,
    notIsolated: Boolean(isolation && isolation.notIsolated),
    validationIssues: normalizedProjection.issues,
    errorMessage: String(row.error_message || '').trim(),
    createdAt: String(row.created_at || '').trim(),
  };
}

export { buildValidationEnvelope, normalizeCaseForRun, validateAndNormalizeCaseInput, validateJudgeOutput };

export function createSkillTestController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  const agentToolBridge = options.agentToolBridge;
  const skillRegistry = options.skillRegistry;
  const getProjectDir = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  const toolBaseUrl = String(options.toolBaseUrl || '').trim() || 'http://127.0.0.1:3100';
  const skillTestChatApiUrl = String(options.skillTestChatApiUrl || '').trim() || toolBaseUrl;
  const skillTestBridgeTokenTtlSec =
    normalizePositiveInteger(options.skillTestBridgeTokenTtlSec || process.env.CAFF_SKILL_TEST_BRIDGE_TOKEN_TTL_SEC) ||
    DEFAULT_SKILL_TEST_BRIDGE_TOKEN_TTL_SECONDS;
  const skillTestExecutionBridgeTokenTtlSec = normalizePositiveInteger(
    options.skillTestExecutionBridgeTokenTtlSec || process.env.CAFF_SKILL_TEST_EXECUTION_BRIDGE_TOKEN_TTL_SEC
  );
  const startRunImpl = typeof options.startRunImpl === 'function' ? options.startRunImpl : startRun;
  const evaluateRunImpl = typeof options.evaluateRunImpl === 'function' ? options.evaluateRunImpl : null;
  const environmentCacheRootDir = typeof options.environmentCacheRootDir === 'string' && options.environmentCacheRootDir.trim()
    ? String(options.environmentCacheRootDir).trim()
    : DEFAULT_ENVIRONMENT_CACHE_ROOT_DIR;
  const environmentManifestRootDir = typeof options.environmentManifestRootDir === 'string' && options.environmentManifestRootDir.trim()
    ? String(options.environmentManifestRootDir).trim()
    : DEFAULT_ENVIRONMENT_MANIFEST_ROOT_DIR;
  const environmentImageBuilderImpl = typeof options.environmentImageBuilder === 'function'
    ? options.environmentImageBuilder
    : buildEnvironmentImageFromManifest;
  const resolveProviderAuthEnvImpl = typeof options.resolveProviderAuthEnvImpl === 'function'
    ? options.resolveProviderAuthEnvImpl
    : resolveProviderAuthEnv;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const skillTestIsolationDriver = createSkillTestIsolationDriver({
    openSandboxFactory: options.openSandboxFactory,
    defaultMode: options.defaultIsolationMode,
    allowLiveTrellis: options.allowLiveTrellis === true,
  });
  let schemaReady = false;

  function buildProviderAuthEnv(provider: any) {
    const resolved = typeof resolveProviderAuthEnvImpl === 'function'
      ? resolveProviderAuthEnvImpl(provider, process.env, options)
      : null;

    if (!isPlainObject(resolved)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(resolved)
        .filter(([key, value]) => String(key || '').trim() && value !== undefined && value !== null && String(value).trim())
        .map(([key, value]) => [String(key), String(value)])
    );
  }

  if (!store || !store.db) {
    return async function handleMissingSkillTestController(context) {
      const { req, pathname } = context;
      if (pathname.startsWith('/api/skill-test') && req.method) {
        throw createHttpError(501, 'Skill test store is not configured');
      }
      return false;
    };
  }

  function ensureSchema() {
    if (schemaReady) {
      return;
    }
    migrateChatSchema(store.db);
    migrateRunSchema(store.db);
    migrateSkillTestSchema(store.db);
    schemaReady = true;
  }

  const environmentAssetStore = createSkillTestEnvironmentAssetStore({
    db: store.db,
    ensureSchema,
  });
  const {
    applySharedEnvironmentAssetDefault,
    getSkillEnvironmentAsset,
    listSkillEnvironmentAssets,
    upsertSkillEnvironmentAsset,
  } = environmentAssetStore;

  function buildSkillTestLiveTrace(messageId: string, taskId: string, status: string, runId: any, createdAt: string, sessionPath = '', options: any = {}) {
    const traceRunStore = options && typeof options === 'object' ? options.runStore : null;
    const traceDb = traceRunStore && traceRunStore.db ? traceRunStore.db : store.db;
    const traceAgentDir = traceRunStore && traceRunStore.agentDir ? traceRunStore.agentDir : store.agentDir;

    return buildAssistantMessageToolTrace({
      db: traceDb,
      agentDir: traceAgentDir,
      message: {
        id: messageId,
        status,
        taskId,
        runId,
        createdAt,
      },
      resolvedSessionPath: sessionPath,
    });
  }

  function collectSkillTestVisiblePathRoots(extraEnv: any = {}, execution: any = null) {
    if (!execution || execution.pathSemantics !== 'sandbox') {
      return [];
    }

    const env = extraEnv && typeof extraEnv === 'object' ? extraEnv : {};
    const roots = [
      env.CAFF_SKILL_TEST_VISIBLE_ROOT || env.CAFF_SKILL_TEST_REMOTE_ROOT,
      env.CAFF_SKILL_TEST_VISIBLE_PROJECT_DIR || env.CAFF_SKILL_TEST_REMOTE_PROJECT_DIR || env.CAFF_TRELLIS_PROJECT_DIR,
      env.CAFF_SKILL_TEST_VISIBLE_AGENT_DIR || env.CAFF_SKILL_TEST_REMOTE_AGENT_DIR,
      env.CAFF_SKILL_TEST_VISIBLE_OUTPUT_DIR || env.CAFF_SKILL_TEST_REMOTE_OUTPUT_DIR,
      env.CAFF_SKILL_TEST_VISIBLE_SANDBOX_DIR || env.PI_AGENT_SANDBOX_DIR,
      env.CAFF_SKILL_TEST_VISIBLE_PRIVATE_DIR || env.PI_AGENT_PRIVATE_DIR,
      env.CAFF_SKILL_TEST_VISIBLE_SQLITE_PATH || env.CAFF_SKILL_TEST_REMOTE_SQLITE_PATH,
    ];
    const skillPath = String(env.CAFF_SKILL_TEST_VISIBLE_SKILL_PATH || env.CAFF_SKILL_TEST_SKILL_PATH || '').trim();

    if (skillPath) {
      roots.push(skillPath);
      roots.push(skillPath.replace(/[\\/]+SKILL\.md$/i, ''));
    }

    return Array.from(new Set(
      roots
        .map((entry) => String(entry || '').trim().replace(/\\/g, '/').replace(/\/+$/u, ''))
        .filter(Boolean)
    ));
  }

  function broadcastSkillTestRunEvent(phase: string, payload: any = {}) {
    broadcastEvent('skill_test_run_event', {
      phase,
      ...(payload && typeof payload === 'object' ? payload : {}),
    });
  }

  function broadcastSkillTestToolEvent(payload: any = {}) {
    broadcastEvent('conversation_tool_event', payload);
  }

  function broadcastSkillTestChainRunEvent(phase: string, payload: any = {}) {
    broadcastEvent('skill_test_chain_run_event', {
      ...(payload && typeof payload === 'object' ? payload : {}),
      phase,
    });
  }

  function readSkillTestIsolationInput(body: any = {}) {
    const payload = body && typeof body === 'object' ? body : {};
    const isolation = payload.isolation && typeof payload.isolation === 'object' ? payload.isolation : {};

    if (payload.isolationMode !== undefined) {
      isolation.mode = payload.isolationMode;
    }
    if (payload.trellisMode !== undefined) {
      isolation.trellisMode = payload.trellisMode;
    }
    if (payload.egressMode !== undefined) {
      isolation.egressMode = payload.egressMode;
    }
    if (payload.allowedBridgeTools !== undefined) {
      isolation.allowedBridgeTools = payload.allowedBridgeTools;
    }
    if (payload.publishGate !== undefined) {
      isolation.publishGate = payload.publishGate;
    }

    return isolation;
  }

  function readSkillTestEnvironmentInput(body: any = {}) {
    const payload = body && typeof body === 'object' ? body : {};
    if (!hasOwn(payload, 'environment')) {
      return null;
    }
    return payload.environment;
  }

  function readSkillTestEnvironmentBuildInput(body: any = {}) {
    const payload = body && typeof body === 'object' ? body : {};
    if (hasOwn(payload, 'environmentBuild')) {
      return payload.environmentBuild;
    }
    if (hasOwn(payload, 'environment_build')) {
      return payload.environment_build;
    }
    return null;
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

  function getSkillTestRunDebug(run: any) {
    if (!run || !run.evalCaseRunId) return null;
    // Look up the eval_case_run to get task_id and session info
    let evalRun: any = null;
    try {
      evalRun = store.db.prepare('SELECT * FROM eval_case_runs WHERE id = @id').get({ id: run.evalCaseRunId });
    } catch { return null; }
    if (!evalRun) return null;

    const taskId = evalRun.task_id ? String(evalRun.task_id).trim() : '';
    const sessionPath = evalRun.session_path ? String(evalRun.session_path).trim() : '';

    // Collect tool call events
    let toolEvents: any[] = [];
    if (taskId) {
      try {
        toolEvents = store.db
          .prepare(
            `SELECT event_json, created_at FROM a2a_task_events
             WHERE task_id = @taskId AND event_type = 'agent_tool_call'
             ORDER BY id ASC LIMIT 200`
          )
          .all({ taskId });
      } catch { toolEvents = []; }
    }

    // Read session assistant snapshot
    let sessionSnapshot: any = null;
    if (sessionPath) {
      sessionSnapshot = readSessionAssistantSnapshot(sessionPath);
    }

    return {
      taskId,
      sessionPath,
      outputText: evalRun.output_text || '',
      toolCalls: toolEvents.map(r => ({
        createdAt: r.created_at || '',
        payload: safeJsonParse(r.event_json),
      })),
      session: sessionSnapshot,
    };
  }

  /**
   * Read session JSONL and extract thinking, text, toolCalls, errors from assistant messages.
   */
  function readSessionAssistantSnapshot(sessionPath: string) {
    const resolved = String(sessionPath || '').trim();
    if (!resolved) return null;
    let text = '';
    try {
      if (!fs.existsSync(resolved)) return null;
      text = fs.readFileSync(resolved, 'utf8');
    } catch { return null; }

    const lines = text.split(/\r?\n/);
    const thinkingParts: string[] = [];
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    const assistantMessages: any[] = [];

    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      let entry: any = null;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      if (!entry || entry.type !== 'message' || !entry.message || entry.message.role !== 'assistant') continue;

      const message = entry.message;
      assistantMessages.push(message);

      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block.type === 'thinking' && block.thinking) thinkingParts.push(block.thinking);
        if (block.type === 'text' && block.text) textParts.push(block.text);
        if (block.type === 'toolCall' && block.name) {
          toolCalls.push({ toolName: block.name, toolCallId: block.id || '', arguments: block.arguments || {} });
        }
      }
    }

    return {
      thinking: thinkingParts.join('\n'),
      text: textParts.join('\n'),
      thinkingBlocks: thinkingParts,
      textBlocks: textParts,
      toolCalls,
      assistantMessageCount: assistantMessages.length,
      assistantMessagesTail: assistantMessages.slice(-6),
    };
  }

  // ---- Query helpers ----

  function getLatestRunForCase(caseId: string) {
    ensureSchema();
    const row = store.db
      .prepare(
        `SELECT
           r.*,
           e.provider AS provider,
           e.model AS model,
           e.prompt_version AS prompt_version
         FROM skill_test_runs r
         LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
         WHERE r.test_case_id = @caseId
         ORDER BY r.created_at DESC
         LIMIT 1`
      )
      .get({ caseId });
    return normalizeTestRunRow(row);
  }

  function attachLatestRun(testCase: any) {
    if (!testCase || !testCase.id) {
      return testCase;
    }
    return {
      ...testCase,
      latestRun: getLatestRunForCase(testCase.id),
    };
  }

  function attachCaseValidation(testCase: any, row?: any) {
    if (!testCase || typeof testCase !== 'object') {
      return testCase;
    }
    const validation = getStoredCaseValidationSnapshot(testCase, row);
    return {
      ...testCase,
      validation: {
        issues: validation.issues,
        caseSchemaStatus: validation.caseSchemaStatus,
        derivedFromLegacy: validation.derivedFromLegacy,
      },
    };
  }

  function listTestCases(skillId: string, limit = 100) {
    ensureSchema();
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    const rows = store.db
      .prepare(
        `SELECT * FROM skill_test_cases
         WHERE skill_id = @skillId
         ORDER BY created_at DESC
         LIMIT @limit`
      )
      .all({ skillId, limit: safeLimit });
    return rows
      .map((row: any) => {
        const testCase = normalizeTestCaseRow(row);
        if (!testCase) {
          return null;
        }
        return attachLatestRun(attachCaseValidation(testCase, row));
      })
      .filter(Boolean);
  }

  function getTestCase(caseId: string, skillId?: string) {
    ensureSchema();
    const params: Record<string, any> = { id: caseId };
    let sql = 'SELECT * FROM skill_test_cases WHERE id = @id';
    if (skillId) {
      sql += ' AND skill_id = @skillId';
      params.skillId = skillId;
    }
    const row = store.db
      .prepare(sql)
      .get(params);
    const testCase = normalizeTestCaseRow(row);
    return attachLatestRun(attachCaseValidation(testCase, row));
  }

  function updateTestCaseSourceMetadata(caseId: string, updater: any) {
    ensureSchema();
    const existingRow = store.db
      .prepare('SELECT source_metadata_json FROM skill_test_cases WHERE id = @id')
      .get({ id: caseId });
    if (!existingRow) {
      return null;
    }
    const existingMetadata = isPlainObject(safeJsonParse(existingRow.source_metadata_json))
      ? safeJsonParse(existingRow.source_metadata_json)
      : {};
    const nextMetadata = typeof updater === 'function'
      ? updater(existingMetadata)
      : {
          ...existingMetadata,
          ...(isPlainObject(updater) ? updater : {}),
        };
    store.db
      .prepare('UPDATE skill_test_cases SET source_metadata_json = @sourceMetadataJson, updated_at = @updatedAt WHERE id = @id')
      .run({
        id: caseId,
        sourceMetadataJson: JSON.stringify(nextMetadata || {}),
        updatedAt: nowIso(),
      });
    return nextMetadata;
  }

  function createTestCase(input: any) {
    ensureSchema();
    const normalized = validateAndNormalizeCaseInput(input, { requireSkillId: true });
    const id = randomUUID();
    const timestamp = nowIso();

    store.db
      .prepare(
        `INSERT INTO skill_test_cases (
          id, skill_id, test_type, loading_mode, trigger_prompt,
          expected_tools_json, expected_behavior, validity_status, case_status,
          expected_goal, expected_steps_json, expected_sequence_json, evaluation_rubric_json,
          environment_config_json, generation_provider, generation_model, generation_created_at,
          source_metadata_json, note, created_at, updated_at
        ) VALUES (
          @id, @skillId, @testType, @loadingMode, @triggerPrompt,
          @expectedToolsJson, @expectedBehavior, @validityStatus, @caseStatus,
          @expectedGoal, @expectedStepsJson, @expectedSequenceJson, @evaluationRubricJson,
          @environmentConfigJson, @generationProvider, @generationModel, @generationCreatedAt,
          @sourceMetadataJson, @note, @createdAt, @updatedAt
        )`
      )
      .run({
        id,
        skillId: normalized.skillId,
        testType: normalized.testType,
        loadingMode: normalized.loadingMode,
        triggerPrompt: normalized.triggerPrompt,
        expectedToolsJson: JSON.stringify(normalized.expectedTools),
        expectedBehavior: normalized.expectedBehavior,
        validityStatus: normalized.validityStatus,
        caseStatus: normalized.caseStatus,
        expectedGoal: normalized.expectedGoal,
        expectedStepsJson: JSON.stringify(normalized.expectedSteps || []),
        expectedSequenceJson: JSON.stringify(normalized.expectedSequence),
        evaluationRubricJson: JSON.stringify(normalized.evaluationRubric),
        environmentConfigJson: JSON.stringify(normalized.environmentConfig || {}),
        generationProvider: normalized.generationProvider || '',
        generationModel: normalized.generationModel || '',
        generationCreatedAt: normalized.generationCreatedAt || '',
        sourceMetadataJson: JSON.stringify(normalized.sourceMetadata || {}),
        note: normalized.note,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

    return { testCase: getTestCase(id), issues: normalized.issues || [] };
  }

  function updateTestCase(caseId: string, input: any) {
    ensureSchema();
    const existing = getTestCase(caseId);
    if (!existing) {
      throw createHttpError(404, 'Test case not found');
    }

    const normalized = validateAndNormalizeCaseInput(input, { requireSkillId: false, existing });
    const updatedAt = nowIso();

    store.db
      .prepare(
        `UPDATE skill_test_cases
         SET test_type = @testType,
             loading_mode = @loadingMode,
             trigger_prompt = @triggerPrompt,
             expected_tools_json = @expectedToolsJson,
             expected_behavior = @expectedBehavior,
             validity_status = @validityStatus,
             case_status = @caseStatus,
             expected_goal = @expectedGoal,
             expected_steps_json = @expectedStepsJson,
             expected_sequence_json = @expectedSequenceJson,
             evaluation_rubric_json = @evaluationRubricJson,
             environment_config_json = @environmentConfigJson,
             generation_provider = @generationProvider,
             generation_model = @generationModel,
             generation_created_at = @generationCreatedAt,
             source_metadata_json = @sourceMetadataJson,
             note = @note,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: caseId,
        testType: normalized.testType,
        loadingMode: normalized.loadingMode,
        triggerPrompt: normalized.triggerPrompt,
        expectedToolsJson: JSON.stringify(normalized.expectedTools),
        expectedBehavior: normalized.expectedBehavior,
        validityStatus: normalized.validityStatus,
        caseStatus: normalized.caseStatus,
        expectedGoal: normalized.expectedGoal,
        expectedStepsJson: JSON.stringify(normalized.expectedSteps || []),
        expectedSequenceJson: JSON.stringify(normalized.expectedSequence),
        evaluationRubricJson: JSON.stringify(normalized.evaluationRubric),
        environmentConfigJson: JSON.stringify(normalized.environmentConfig || {}),
        generationProvider: normalized.generationProvider || '',
        generationModel: normalized.generationModel || '',
        generationCreatedAt: normalized.generationCreatedAt || '',
        sourceMetadataJson: JSON.stringify(normalized.sourceMetadata || {}),
        note: normalized.note,
        updatedAt,
      });

    return { testCase: getTestCase(caseId), issues: normalized.issues || [] };
  }

  function markTestCaseStatus(caseId: string, nextStatus: string) {
    if (nextStatus === 'ready') {
      const existing = getTestCase(caseId);
      if (!existing) {
        throw createHttpError(404, 'Test case not found');
      }
      const validation = getStoredCaseValidationSnapshot(existing);
      if (validation.caseSchemaStatus === 'invalid') {
        throw createValidationHttpError(
          mergeValidationIssues([
            buildValidationIssue('case_schema_invalid', 'error', 'testCase', 'Test case schema is invalid for ready status'),
          ], validation.issues),
          'Test case schema is invalid for ready status',
          {
            caseSchemaStatus: validation.caseSchemaStatus,
            derivedFromLegacy: validation.derivedFromLegacy,
          }
        );
      }
    }
    return updateTestCase(caseId, { caseStatus: nextStatus });
  }

  const skillTestDesignService = createSkillTestDesignService({
    store,
    skillRegistry,
    createTestCase,
    updateTestCase,
    getTestCase,
    ensureSchema,
    nowIso,
  });
  const {
    requireSkillTestDesignConversation,
    summarizeSkillTestDesignConversation,
    updateSkillTestDesignConversationState,
    ensureAutomaticTestingDocPreview,
    buildSkillTestDesignConfirmationRecord,
    buildSkillTestDesignMatrixValidationIssues,
    buildSkillTestDesignExportDrafts,
  } = skillTestDesignService;

  function listTestRuns(skillId: string, limit = 100) {
    ensureSchema();
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    const rows = store.db
      .prepare(
        `SELECT
           r.*,
           e.provider AS provider,
           e.model AS model,
           e.prompt_version AS prompt_version
         FROM skill_test_runs r
         INNER JOIN skill_test_cases c ON r.test_case_id = c.id
         LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
         WHERE c.skill_id = @skillId
         ORDER BY r.created_at DESC
         LIMIT @limit`
      )
      .all({ skillId, limit: safeLimit });
    return rows.map(normalizeTestRunRow).filter(Boolean);
  }

  function getRegressionBuckets(whereSql: string, params: Record<string, any>) {
    ensureSchema();
    const rows = store.db
      .prepare(
        `SELECT
           COALESCE(NULLIF(e.provider, ''), 'default') AS provider_label,
           COALESCE(NULLIF(e.model, ''), 'default') AS model_label,
           COALESCE(NULLIF(e.prompt_version, ''), 'skill-test-v1') AS prompt_version,
           COUNT(r.id) AS total_runs,
           COALESCE(SUM(CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded_runs,
           COALESCE(SUM(CASE WHEN r.trigger_passed = 1 THEN 1 ELSE 0 END), 0) AS trigger_passed_count,
           COALESCE(SUM(${buildEffectiveExecutionPassedSql('c', 'r')}), 0) AS execution_passed_count,
           COALESCE(SUM(${buildExecutionRateEligibleRunSql('c', 'r')}), 0) AS execution_eligible_runs,
           COALESCE(AVG(CASE WHEN r.tool_accuracy IS NOT NULL THEN r.tool_accuracy END), 0) AS avg_tool_accuracy,
           COALESCE(AVG(CASE WHEN r.required_step_completion_rate IS NOT NULL THEN r.required_step_completion_rate END), 0) AS avg_required_step_completion_rate,
           COALESCE(AVG(CASE WHEN r.step_completion_rate IS NOT NULL THEN r.step_completion_rate END), 0) AS avg_step_completion_rate,
           COALESCE(AVG(CASE WHEN r.goal_achievement IS NOT NULL THEN r.goal_achievement END), 0) AS avg_goal_achievement,
           COALESCE(AVG(CASE WHEN r.sequence_adherence IS NOT NULL THEN r.sequence_adherence END), 0) AS avg_sequence_adherence,
           COALESCE(AVG(CASE WHEN r.tool_call_success_rate IS NOT NULL THEN r.tool_call_success_rate END), 0) AS avg_tool_call_success_rate,
           COALESCE(AVG(CASE WHEN r.tool_error_rate IS NOT NULL THEN r.tool_error_rate END), 0) AS avg_tool_error_rate,
           MAX(r.created_at) AS last_run_at
         FROM skill_test_runs r
         INNER JOIN skill_test_cases c ON r.test_case_id = c.id
         LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
         WHERE ${whereSql}
         GROUP BY provider_label, model_label, prompt_version
         ORDER BY total_runs DESC, last_run_at DESC`
      )
      .all(params);

    return rows.map((row: any) => {
      const totalRuns = Number(row.total_runs || 0);
      const triggerPassedCount = Number(row.trigger_passed_count || 0);
      const executionPassedCount = Number(row.execution_passed_count || 0);
      const executionEligibleRuns = Number(row.execution_eligible_runs || 0);
      return {
        provider: String(row.provider_label || '').trim(),
        model: String(row.model_label || '').trim(),
        promptVersion: String(row.prompt_version || '').trim() || 'skill-test-v1',
        totalRuns,
        succeededRuns: Number(row.succeeded_runs || 0),
        triggerPassedCount,
        executionPassedCount,
        triggerRate: totalRuns > 0 ? triggerPassedCount / totalRuns : null,
        executionRate: executionEligibleRuns > 0 ? executionPassedCount / executionEligibleRuns : null,
        avgToolAccuracy: row.avg_tool_accuracy != null ? Number(row.avg_tool_accuracy) : null,
        avgRequiredStepCompletionRate: row.avg_required_step_completion_rate != null ? Number(row.avg_required_step_completion_rate) : null,
        avgStepCompletionRate: row.avg_step_completion_rate != null ? Number(row.avg_step_completion_rate) : null,
        avgGoalAchievement: row.avg_goal_achievement != null ? Number(row.avg_goal_achievement) : null,
        avgSequenceAdherence: row.avg_sequence_adherence != null ? Number(row.avg_sequence_adherence) : null,
        avgToolCallSuccessRate: row.avg_tool_call_success_rate != null ? Number(row.avg_tool_call_success_rate) : null,
        avgToolErrorRate: row.avg_tool_error_rate != null ? Number(row.avg_tool_error_rate) : null,
        lastRunAt: String(row.last_run_at || '').trim(),
      };
    });
  }

  function getSkillRegressionSummary(skillId: string) {
    return getRegressionBuckets('c.skill_id = @skillId', { skillId });
  }

  function getCaseRegressionSummary(caseId: string) {
    return getRegressionBuckets('c.id = @caseId', { caseId });
  }

  // ---- Run execution ----

  function collectTaskEvents(taskId: string, options: any = {}) {
    if (!taskId) {
      return [];
    }

    const runStore = options && typeof options === 'object' ? options.runStore : null;
    if (runStore && typeof runStore.listTaskEvents === 'function') {
      try {
        return runStore
          .listTaskEvents(taskId)
          .map((row: any) => ({
            eventType: String(row && (row.event_type || row.eventType) || '').trim(),
            createdAt: String(row && (row.created_at || row.createdAt) || '').trim(),
            payload: row && Object.prototype.hasOwnProperty.call(row, 'payload') ? row.payload : safeJsonParse(row && row.event_json),
          }))
          .filter((row: any) => row && row.payload)
          .slice(0, 200);
      } catch {
      }
    }

    ensureSchema();
    let rows: any[] = [];
    try {
      rows = store.db
        .prepare(
          `SELECT event_type, event_json, created_at FROM a2a_task_events
           WHERE task_id = @taskId
           ORDER BY id ASC LIMIT 200`
        )
        .all({ taskId });
    } catch {
      rows = [];
    }

    return rows
      .map((row) => ({
        eventType: String(row && row.event_type || '').trim(),
        createdAt: String(row && row.created_at || '').trim(),
        payload: safeJsonParse(row && row.event_json),
      }))
      .filter((row) => row && row.payload);
  }

  function collectTaskEventPayloads(taskId: string, eventType: string, options: any = {}) {
    return collectTaskEvents(taskId, options)
      .filter((row: any) => row && row.eventType === eventType)
      .map((row: any) => row.payload)
      .filter(Boolean);
  }

  function collectToolCallsFromTask(taskId: string, options: any = {}) {
    return collectTaskEventPayloads(taskId, 'agent_tool_call', options);
  }

  function collectDynamicSkillLoadConfirmationsFromTask(taskId: string, options: any = {}) {
    return collectTaskEventPayloads(taskId, 'skill_test_dynamic_load_confirmed', options);
  }

  /**
   * Parse tool calls from a pi session JSONL file.
   * Returns an array of { toolName, toolCallId, arguments } objects
   * extracted from assistant messages that contain toolCall content blocks.
   */
  function parseToolCallsFromSession(sessionPath: string) {
    if (!sessionPath) return [];
    let lines: string[] = [];
    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      lines = content.split('\n');
    } catch {
      return [];
    }
    const toolCalls: Array<{ toolName: string; toolCallId: string; arguments: any }> = [];
    for (const line of lines) {
      const entry = safeJsonParse(line);
      if (!entry || entry.type !== 'message') continue;
      const msg = entry.message || {};
      if (msg.role !== 'assistant') continue;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block.type === 'toolCall' && block.name) {
          toolCalls.push({
            toolName: block.name,
            toolCallId: block.id || '',
            arguments: block.arguments || {},
          });
        }
      }
    }
    return toolCalls;
  }

  /**
   * Find session path for a given taskId from a2a_tasks table.
   */
  function getSessionPathForTask(taskId: string, options: any = {}) {
    const runStore = options && typeof options === 'object' ? options.runStore : null;
    if (runStore && typeof runStore.getTask === 'function') {
      try {
        const task = runStore.getTask(taskId);
        if (task && task.sessionPath) {
          return String(task.sessionPath).trim();
        }
      } catch {
      }
    }

    ensureSchema();
    try {
      const row = store.db
        .prepare('SELECT session_path FROM a2a_tasks WHERE id = @id')
        .get({ id: taskId });
      return row && row.session_path ? String(row.session_path).trim() : '';
    } catch {
      return '';
    }
  }

  function buildSkillTestRunDebugSnapshot(taskId: string, outputText: string, sessionPath = '', options: any = {}) {
    const resolvedSessionPath = String(sessionPath || '').trim() || getSessionPathForTask(taskId, options);
    const toolCalls = collectTaskEvents(taskId, options)
      .filter((row: any) => row && row.eventType === 'agent_tool_call')
      .map((row: any) => ({
        createdAt: row.createdAt || '',
        payload: row.payload,
      }));

    return {
      taskId,
      sessionPath: resolvedSessionPath,
      outputText: outputText || '',
      toolCalls,
      session: resolvedSessionPath ? readSessionAssistantSnapshot(resolvedSessionPath) : null,
    };
  }

  function hasSkillTestTraceEvidence(trace: any) {
    if (!isPlainObject(trace)) {
      return false;
    }

    const steps = Array.isArray(trace.steps) ? trace.steps.filter(Boolean) : [];
    const totalSteps = Number(trace && trace.summary && trace.summary.totalSteps);
    const failureText = String(trace && trace.failureContext && trace.failureContext.text || '').trim();
    return steps.length > 0 || (Number.isFinite(totalSteps) && totalSteps > 0) || Boolean(failureText);
  }

  function buildStoredSkillTestRunTrace(run: any, result: any, debug: any) {
    const storedTrace = result && isPlainObject(result.trace) ? { ...result.trace } : null;
    if (hasSkillTestTraceEvidence(storedTrace)) {
      if (storedTrace.message && typeof storedTrace.message === 'object') {
        storedTrace.message = {
          ...storedTrace.message,
          status: String(run && run.status || storedTrace.message.status || '').trim() || 'completed',
          ...(run && run.id ? { runId: run.id } : {}),
        };
      }
      if (storedTrace.task && typeof storedTrace.task === 'object') {
        storedTrace.task = {
          ...storedTrace.task,
          status: String(run && run.status || storedTrace.task.status || '').trim() || 'completed',
        };
      }
      return storedTrace;
    }

    const traceTaskId = debug && debug.taskId ? String(debug.taskId).trim() : '';
    const traceSessionPath = debug && debug.sessionPath ? String(debug.sessionPath).trim() : '';
    return traceTaskId || traceSessionPath
      ? buildSkillTestLiveTrace(
          traceTaskId ? `skill-test-trace-${traceTaskId}` : `skill-test-run-${run && run.id ? run.id : ''}`,
          traceTaskId,
          String(run && run.status || 'completed').trim() || 'completed',
          run && run.id ? run.id : null,
          String(run && run.createdAt || '').trim(),
          traceSessionPath
        )
      : null;
  }

  function getSkillTestRunDetailPayload(runId: string) {
    ensureSchema();
    const row = store.db
      .prepare(
        `SELECT
           r.*,
           e.provider AS provider,
           e.model AS model,
           e.prompt_version AS prompt_version,
           e.result_json AS result_json
         FROM skill_test_runs r
         LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
         WHERE r.id = @id`
      )
      .get({ id: runId });
    const run = normalizeTestRunRow(row);
    if (!run) {
      throw createHttpError(404, 'Test run not found');
    }
    const result = safeJsonParse(row && row.result_json);
    const debug = mergeSkillTestRunDebugPayload(getSkillTestRunDebug(run), result && result.debug);
    const trace = buildStoredSkillTestRunTrace(run, result, debug);
    return { row, run, result, debug, trace };
  }

  function persistSkillTestRunSessionExport(runId: string, sessionPath: string) {
    const normalizedRunId = String(runId || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_');
    const sourcePath = String(sessionPath || '').trim();
    if (!normalizedRunId || !sourcePath) {
      return '';
    }

    try {
      const resolvedSourcePath = path.resolve(sourcePath);
      if (!fs.existsSync(resolvedSourcePath) || !fs.statSync(resolvedSourcePath).isFile()) {
        return '';
      }
      const exportRoot = path.join(path.resolve(String(store.agentDir || ROOT_DIR || '.').trim() || '.'), 'skill-test-session-exports');
      fs.mkdirSync(exportRoot, { recursive: true });
      const persistedPath = path.join(exportRoot, `${normalizedRunId}.jsonl`);
      fs.copyFileSync(resolvedSourcePath, persistedPath);
      return persistedPath;
    } catch {
      return '';
    }
  }

  function collectSkillTestRunSessionExportRoots() {
    const roots = new Set<string>();

    function normalizeRoot(value: any) {
      const trimmed = String(value || '').trim();
      if (!trimmed || trimmed === ':memory:' || /^file:/i.test(trimmed)) {
        return '';
      }
      return path.resolve(trimmed);
    }

    function addRoot(value: any) {
      const normalized = normalizeRoot(value);
      if (!normalized) {
        return '';
      }
      roots.add(normalized);
      return normalized;
    }

    const agentDir = addRoot(store.agentDir);
    if (agentDir) {
      addRoot(path.dirname(agentDir));
      addRoot(path.join(agentDir, 'skill-test-session-exports'));
    }
    const databasePath = addRoot(store.databasePath);
    if (databasePath) {
      addRoot(path.dirname(databasePath));
    }
    addRoot(ROOT_DIR);
    return Array.from(roots);
  }

  function resolveSkillTestRunSessionExportPath(runDetail: any) {
    const persistedSessionPath = String(runDetail && runDetail.debug && runDetail.debug.sessionExportPath || '').trim();
    const sessionPath = persistedSessionPath || String(runDetail && runDetail.debug && runDetail.debug.sessionPath || '').trim();
    if (!sessionPath) {
      throw createHttpError(404, 'No session export is available for this test run yet');
    }

    const resolvedSessionPath = path.resolve(sessionPath);
    const allowedRoots = collectSkillTestRunSessionExportRoots();
    const allowed = allowedRoots.some((root) => isPathWithin(root, resolvedSessionPath));
    if (!allowed) {
      throw createHttpError(400, 'Session path is outside the allowed export roots');
    }
    if (!fs.existsSync(resolvedSessionPath) || !fs.statSync(resolvedSessionPath).isFile()) {
      throw createHttpError(404, 'Requested session export was not found');
    }
    return resolvedSessionPath;
  }

  function extractJsonArrayFromText(value: any) {
    const text = String(value || '').trim();
    if (!text) {
      return null;
    }

    const candidates: string[] = [];
    const pushCandidate = (candidateValue: any) => {
      const candidate = String(candidateValue || '').trim();
      if (!candidate || candidates.includes(candidate)) {
        return;
      }
      candidates.push(candidate);
    };

    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch && fencedMatch[1]) {
      pushCandidate(fencedMatch[1]);
    }

    pushCandidate(text);

    const firstBracketIndex = text.indexOf('[');
    const lastBracketIndex = text.lastIndexOf(']');
    if (firstBracketIndex !== -1 && lastBracketIndex > firstBracketIndex) {
      pushCandidate(text.slice(firstBracketIndex, lastBracketIndex + 1));
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) {
          return parsed;
        }
        if (isPlainObject(parsed)) {
          for (const key of ['cases', 'prompts', 'items', 'drafts', 'testCases', 'test_cases', 'data']) {
            if (Array.isArray(parsed[key])) {
              return parsed[key];
            }
          }
        }
      } catch {
      }
    }

    return null;
  }

  function readGeneratedDraftString(entry: any, keys: string[]) {
    if (typeof entry === 'string') {
      const normalized = String(entry || '').trim();
      return normalized || '';
    }
    if (!isPlainObject(entry)) {
      return '';
    }
    for (const key of keys) {
      const value = String(entry[key] || '').trim();
      if (value) {
        return value;
      }
    }
    return '';
  }

  function readGeneratedDraftArray(entry: any, keys: string[]) {
    if (!isPlainObject(entry)) {
      return null;
    }
    for (const key of keys) {
      if (Array.isArray(entry[key])) {
        return entry[key];
      }
    }
    return null;
  }

  function readGeneratedDraftObject(entry: any, keys: string[]) {
    if (!isPlainObject(entry)) {
      return null;
    }
    for (const key of keys) {
      if (isPlainObject(entry[key])) {
        return entry[key];
      }
    }
    return null;
  }

  function normalizeAiGeneratedDrafts(
    rawReply: any,
    fallbackDrafts: any[],
    options: {
      count?: number;
      loadingMode?: string;
      generationProvider?: string;
      generationModel?: string;
      generationCreatedAt?: string;
    } = {}
  ) {
    const loadingMode = String(options.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
    const count = Math.max(1, Math.min(10, Number(options.count || 3)));
    const generationProvider = String(options.generationProvider || '').trim();
    const generationModel = String(options.generationModel || '').trim();
    const generationCreatedAt = String(options.generationCreatedAt || nowIso()).trim();
    const rawDrafts = extractJsonArrayFromText(rawReply);
    if (!Array.isArray(rawDrafts) || rawDrafts.length === 0) {
      throw createHttpError(502, 'AI generation did not return a valid JSON array of draft cases');
    }

    const normalizedDrafts = rawDrafts
      .slice(0, count)
      .map((entry: any, index: number) => {
        const fallback = fallbackDrafts[index] || fallbackDrafts[0] || {
          expectedTools: [],
          expectedSteps: [],
          expectedBehavior: '',
          expectedGoal: '',
          expectedSequence: [],
          evaluationRubric: {},
          note: 'AI-generated draft',
        };
        const userPrompt = readGeneratedDraftString(entry, ['userPrompt', 'user_prompt', 'triggerPrompt', 'trigger_prompt', 'prompt', 'message', 'input'])
          .slice(0, 2000)
          .trim();
        if (!userPrompt || userPrompt.length < 5) {
          return null;
        }

        const expectedBehavior = readGeneratedDraftString(entry, ['expectedBehavior', 'expected_behavior', 'behavior'])
          || String(fallback.expectedBehavior || '').trim();
        const note = readGeneratedDraftString(entry, ['note', 'reason', 'summary', 'rationale'])
          || String(fallback.note || 'AI-generated draft').trim()
          || 'AI-generated draft';

        if (loadingMode === 'dynamic') {
          return {
            userPrompt,
            triggerPrompt: userPrompt,
            expectedTools: Array.isArray(fallback.expectedTools) ? fallback.expectedTools : [],
            expectedSteps: [],
            expectedBehavior,
            expectedGoal: String(fallback.expectedGoal || '').trim(),
            expectedSequence: [],
            evaluationRubric: {},
            generationProvider,
            generationModel,
            generationCreatedAt,
            note,
          };
        }

        return {
          userPrompt,
          triggerPrompt: userPrompt,
          expectedTools: readGeneratedDraftArray(entry, ['expectedTools', 'expected_tools', 'tools']) || fallback.expectedTools || [],
          expectedSteps: readGeneratedDraftArray(entry, ['expectedSteps', 'expected_steps', 'steps']) || fallback.expectedSteps || [],
          expectedBehavior,
          expectedGoal: readGeneratedDraftString(entry, ['expectedGoal', 'expected_goal', 'goal']) || String(fallback.expectedGoal || '').trim(),
          expectedSequence: readGeneratedDraftArray(entry, ['expectedSequence', 'expected_sequence', 'sequence']) || fallback.expectedSequence || [],
          evaluationRubric: readGeneratedDraftObject(entry, ['evaluationRubric', 'evaluation_rubric', 'rubric']) || fallback.evaluationRubric || {},
          generationProvider,
          generationModel,
          generationCreatedAt,
          note,
        };
      })
      .filter(Boolean);

    if (normalizedDrafts.length === 0) {
      throw createHttpError(502, 'AI generation returned draft candidates, but none matched the required schema');
    }

    return normalizedDrafts;
  }

  async function generateDraftsWithAi(skill: any, input: any = {}) {
    const count = Math.max(1, Math.min(10, Number(input.count || 3)));
    const loadingMode = String(input.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
    const testType = resolveTestTypeForLoadingMode(loadingMode, input.testType || input.test_type);
    const provider = String(input.provider || '').trim();
    const model = String(input.model || '').trim();
    const generationPrompt = buildLlmGenerationPrompt(skill, { count, loadingMode, testType });
    const taskId = `skill-test-generate-${randomUUID()}`;
    const sessionName = `skill-test-generate-${String(skill && skill.id || 'skill').trim() || 'skill'}-${Date.now()}`;

    const providerAuthEnv = buildProviderAuthEnv(provider);

    let generationResult: any;
    try {
      const handle = startRunImpl(provider, model, generationPrompt, {
        thinking: '',
        agentDir: store.agentDir,
        sqlitePath: store.databasePath,
        streamOutput: false,
        session: sessionName,
        taskId,
        taskKind: 'skill_test_case_generation',
        taskRole: 'Skill Test Generator',
        metadata: {
          source: 'skill_test_generate',
          skillId: skill && skill.id ? skill.id : null,
          loadingMode,
          testType,
          requestedCount: count,
        },
        extraEnv: {
          ...providerAuthEnv,
          PI_AGENT_ID: 'skill-test-generator',
          PI_AGENT_NAME: 'Skill Test Generator',
          CAFF_SKILL_LOADING_MODE: 'full',
        },
      });
      generationResult = await handle.resultPromise;
    } catch (error: any) {
      throw createHttpError(502, `AI generation failed: ${String(error && error.message ? error.message : error || 'unknown error')}`);
    }

    const fallbackDrafts = generateSkillTestPrompts(skill, { count, loadingMode, testType });
    return normalizeAiGeneratedDrafts(generationResult && generationResult.reply ? generationResult.reply : '', fallbackDrafts, {
      count,
      loadingMode,
      generationProvider: provider,
      generationModel: model,
      generationCreatedAt: nowIso(),
    });
  }

  function buildStoredCaseValidationInputFromRow(row: any) {
    const issues: any[] = [];
    if (!row || typeof row !== 'object') {
      return { input: null, issues };
    }

    const expectedToolsParsed = parseStoredJsonField(row.expected_tools_json, 'expectedTools', 'array', 'expected_tools_invalid');
    const expectedStepsParsed = parseStoredJsonField(row.expected_steps_json, 'expectedSteps', 'array', 'expected_steps_required');
    const expectedSequenceParsed = parseStoredJsonField(row.expected_sequence_json, 'expectedSequence', 'array', 'expected_sequence_invalid');
    const evaluationRubricParsed = parseStoredJsonField(row.evaluation_rubric_json, 'evaluationRubric', 'object', 'evaluation_rubric_invalid');
    const environmentConfigParsed = parseStoredJsonField(row.environment_config_json, 'environmentConfig', 'object', 'environment_config_invalid');
    const normalizedEnvironmentConfig = normalizeEnvironmentConfigInput(environmentConfigParsed.value).config;

    issues.push(...expectedToolsParsed.issues, ...expectedStepsParsed.issues, ...expectedSequenceParsed.issues, ...evaluationRubricParsed.issues, ...environmentConfigParsed.issues);

    return {
      input: {
        skillId: row.skill_id,
        testType: row.test_type,
        loadingMode: row.loading_mode,
        userPrompt: row.trigger_prompt,
        triggerPrompt: row.trigger_prompt,
        expectedTools: expectedToolsParsed.value,
        expectedSteps: expectedStepsParsed.value,
        expectedBehavior: row.expected_behavior,
        expectedGoal: row.expected_goal,
        expectedSequence: expectedSequenceParsed.value,
        evaluationRubric: evaluationRubricParsed.value,
        environmentConfig: normalizedEnvironmentConfig,
        generationProvider: row.generation_provider,
        generationModel: row.generation_model,
        generationCreatedAt: row.generation_created_at,
        note: row.note,
        caseStatus: resolveCaseStatus(row),
      },
      issues,
    };
  }

  function buildStoredCaseValidationInput(testCase: any) {
    const issues: any[] = [];
    if (!testCase || !testCase.id) {
      return { input: testCase, issues, row: null };
    }

    const row = store.db
      .prepare('SELECT * FROM skill_test_cases WHERE id = @id')
      .get({ id: testCase.id });
    if (!row) {
      return { input: testCase, issues, row: null };
    }

    const prepared = buildStoredCaseValidationInputFromRow(row);
    return {
      input: prepared.input,
      issues: prepared.issues,
      row,
    };
  }

  function getStoredCaseValidationSnapshot(testCase: any, row?: any) {
    const prepared = row
      ? { ...buildStoredCaseValidationInputFromRow(row), row }
      : buildStoredCaseValidationInput(testCase);
    const existing = testCase || normalizeTestCaseRow(prepared && prepared.row);
    return normalizeCaseForRun(prepared.input || existing, {
      existing,
      storedIssues: prepared.issues,
    });
  }

  function normalizeCaseForRunOrThrow(testCase: any) {
    const validation = getStoredCaseValidationSnapshot(testCase);
    if (validation.caseSchemaStatus === 'invalid' || !validation.normalizedCase) {
      throw createValidationHttpError(
        mergeValidationIssues([
          buildValidationIssue('case_schema_invalid', 'error', 'testCase', 'Test case schema is invalid for run'),
        ], validation.issues),
        'Test case schema is invalid for run',
        {
          caseSchemaStatus: validation.caseSchemaStatus,
          derivedFromLegacy: validation.derivedFromLegacy,
        }
      );
    }
    return validation;
  }

  const runEvaluationHelpers = createSkillTestRunEvaluationHelpers({
    store,
    startRunImpl,
    buildProviderAuthEnv,
  });
  const {
    buildExpectedSequenceSpecsWithDiagnostics,
    normalizeSequenceEntryName,
    buildObservedSequenceCalls,
    evaluateExpectedToolCall,
    evaluateFullModeTrigger,
    evaluateToolSequence,
    buildFullModeExecutionEvaluation,
  } = runEvaluationHelpers;

  async function evaluateRun(taskId: string, testCase: any, runtime: any = {}) {
    const runtimeRunStore = runtime && runtime.runStore ? runtime.runStore : null;
    const toolCallEvents = collectToolCallsFromTask(taskId, { runStore: runtimeRunStore });
    const expectedTools = normalizeExpectedToolSpecs(testCase.expectedTools);
    const skillId = String(testCase.skillId || '').trim();
    const loadingMode = String(testCase.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
    const skill = runtime && runtime.skill ? runtime.skill : skillRegistry ? skillRegistry.getSkill(skillId) : null;
    const targetSkillMarkdownPath = formatSkillMarkdownPathForMatch(skill && skill.path);

    const observedToolCalls: any[] = [];
    let observedOrderIndex = 0;
    let triggerPassed = false;
    let triggerEvaluation: any = null;

    for (const event of toolCallEvents) {
      const toolName = String(event && event.tool || '').trim();
      if (!toolName) {
        continue;
      }
      observedToolCalls.push({
        toolName,
        arguments: event && hasOwn(event, 'request') ? event.request : undefined,
        source: 'event',
        status: String(event && event.status || '').trim(),
        orderIndex: observedOrderIndex,
      });
      observedOrderIndex += 1;

      if (loadingMode === 'dynamic' && isTargetSkillReadToolCall(toolName, event.request, skillId, targetSkillMarkdownPath)) {
        triggerPassed = true;
      }
    }

    const sessionPath = String(runtime.sessionPath || '').trim() || getSessionPathForTask(taskId, { runStore: runtimeRunStore });
    const sessionSnapshot = sessionPath ? readSessionAssistantSnapshot(sessionPath) : null;
    const sessionToolCalls = parseToolCallsFromSession(sessionPath);
    const dynamicSkillLoadConfirmations = loadingMode === 'dynamic'
      ? collectDynamicSkillLoadConfirmationsFromTask(taskId, { runStore: runtimeRunStore })
      : [];

    for (const tc of sessionToolCalls) {
      const toolName = String(tc && tc.toolName || '').trim();
      if (!toolName) {
        continue;
      }
      observedToolCalls.push({
        toolName,
        arguments: tc.arguments,
        source: 'session',
        status: '',
        orderIndex: observedOrderIndex,
      });
      observedOrderIndex += 1;

      if (loadingMode === 'dynamic' && !triggerPassed && isTargetSkillReadToolCall(toolName, tc.arguments, skillId, targetSkillMarkdownPath)) {
        triggerPassed = true;
      }
    }

    for (const confirmation of dynamicSkillLoadConfirmations) {
      const confirmationPath = normalizeToolPathForMatch(confirmation && confirmation.path || '');
      if (!isSkillMarkdownReadPath(confirmationPath, skillId, targetSkillMarkdownPath)) {
        continue;
      }

      triggerPassed = true;

      const alreadyObserved = observedToolCalls.some((entry: any) => {
        if (String(entry && entry.toolName || '').trim() !== 'read') {
          return false;
        }
        const observedPath = getReadToolPath(entry && entry.arguments);
        return isSkillMarkdownReadPath(observedPath, skillId, targetSkillMarkdownPath)
          && (!confirmationPath || observedPath === confirmationPath);
      });
      if (alreadyObserved) {
        continue;
      }

      observedToolCalls.push({
        toolName: 'read',
        arguments: confirmationPath ? { path: confirmationPath } : {},
        source: 'task',
        status: 'succeeded',
        orderIndex: observedOrderIndex,
      });
      observedOrderIndex += 1;
    }

    const observedSequenceCalls = buildObservedSequenceCalls(toolCallEvents, sessionToolCalls);
    const actualTools = observedToolCalls
      .map((entry) => String(entry && entry.toolName || '').trim())
      .filter(Boolean);

    const evidenceText = [
      runtime && runtime.outputText,
      sessionSnapshot && sessionSnapshot.text,
      sessionSnapshot && sessionSnapshot.thinking,
    ]
      .filter(Boolean)
      .join('\n');
    const timelineIds = buildEvaluationTimelineIds(sessionSnapshot, toolCallEvents, observedToolCalls);

    const usesParameterValidation = expectedTools.some((entry: any) => entry.hasParameterExpectation);
    const sequenceDiagnostics = buildExpectedSequenceSpecsWithDiagnostics(testCase, expectedTools);
    const expectedSequenceSpecs = sequenceDiagnostics.specs;
    const usesSequenceValidation = expectedSequenceSpecs.length > 0;
    const observedSequenceTools = observedSequenceCalls.map((entry: any) => entry.toolName);
    const toolChecks = expectedTools.map((entry: any) => evaluateExpectedToolCall(entry, observedToolCalls));
    const matchedCount = toolChecks.filter((entry: any) => entry.matched).length;
    const sequenceCheck = usesSequenceValidation
      ? { ...evaluateToolSequence(expectedSequenceSpecs, observedSequenceCalls), skipped: false }
      : {
          enabled: false,
          orderedExpectedCount: 0,
          matchedCount: 0,
          passed: null,
          skipped: true,
          observedTools: observedSequenceTools,
          steps: [],
        };

    let toolAccuracy: number | null = expectedTools.length > 0 ? matchedCount / expectedTools.length : null;
    let executionPassed: number | null = null;
    let executionEvaluation: any = {
      threshold: 0.8,
      expectedCount: expectedTools.length,
      matchedCount,
      toolChecks,
      usedParameterValidation: usesParameterValidation,
      usedSequenceValidation: usesSequenceValidation,
      sequenceCheck,
      skipped: true,
    };
    let fullEvaluation: any = null;

    if (loadingMode === 'dynamic') {
      const legacyDynamicExecution = String(testCase && testCase.testType || '').trim().toLowerCase() === 'execution';
      triggerEvaluation = {
        mode: 'dynamic',
        loaded: triggerPassed,
        loadEvidence: observedToolCalls
          .filter((entry: any) => isTargetSkillReadToolCall(entry.toolName, entry.arguments, skillId, targetSkillMarkdownPath))
          .map((entry: any) => ({ toolName: entry.toolName, source: entry.source, path: getReadToolPath(entry.arguments) })),
      };

      if (legacyDynamicExecution && triggerPassed) {
        if (expectedTools.length > 0) {
          toolAccuracy = matchedCount / expectedTools.length;
          executionPassed = toolAccuracy >= 0.8 ? 1 : 0;
          if (usesSequenceValidation && !sequenceCheck.passed) {
            executionPassed = 0;
          }
          executionEvaluation = {
            ...executionEvaluation,
            skipped: false,
          };
        } else {
          toolAccuracy = 1;
          executionPassed = 1;
          executionEvaluation = {
            ...executionEvaluation,
            skipped: false,
          };
        }
      } else {
        toolAccuracy = null;
        executionPassed = null;
        executionEvaluation = {
          ...executionEvaluation,
          skipped: true,
          reason: 'dynamic-mode-load-only',
        };
      }
    } else {
      const legacyFullTrigger = await evaluateFullModeTrigger(skill, testCase, actualTools, evidenceText, {
        ...runtime,
        taskId,
      });
      triggerEvaluation = legacyFullTrigger ? legacyFullTrigger.triggerEvaluation : null;
      fullEvaluation = await buildFullModeExecutionEvaluation(
        skill,
        testCase,
        expectedTools,
        observedToolCalls,
        toolCallEvents,
        toolChecks,
        sequenceCheck,
        evidenceText,
        {
          ...runtime,
          taskId,
          timelineIds,
          sequenceDiagnostics,
        }
      );
      executionPassed = fullEvaluation && fullEvaluation.verdict === 'pass' ? 1 : 0;
      triggerPassed = Boolean((legacyFullTrigger && legacyFullTrigger.triggerPassed) || executionPassed === 1 || matchedCount > 0);
      executionEvaluation = {
        ...executionEvaluation,
        skipped: false,
        verdict: fullEvaluation.verdict,
        summary: fullEvaluation.summary,
        dimensions: fullEvaluation.dimensions,
        missingTools: fullEvaluation.missingTools,
        unexpectedTools: fullEvaluation.unexpectedTools,
        failedCalls: fullEvaluation.failedCalls,
        aiJudge: fullEvaluation.aiJudge,
      };
    }

    return {
      triggerPassed: triggerPassed ? 1 : 0,
      executionPassed,
      toolAccuracy,
      actualToolsJson: JSON.stringify([...new Set(actualTools)]),
      triggerEvaluation,
      executionEvaluation,
      requiredStepCompletionRate: fullEvaluation ? fullEvaluation.dimensions.requiredStepCompletionRate.score : null,
      stepCompletionRate: fullEvaluation ? fullEvaluation.dimensions.stepCompletionRate.score : null,
      requiredToolCoverage: fullEvaluation ? fullEvaluation.dimensions.requiredToolCoverage.score : null,
      toolCallSuccessRate: fullEvaluation ? fullEvaluation.dimensions.toolCallSuccessRate.score : null,
      toolErrorRate: fullEvaluation ? fullEvaluation.dimensions.toolErrorRate.score : null,
      sequenceAdherence: fullEvaluation ? fullEvaluation.dimensions.sequenceAdherence.score : null,
      goalAchievement: fullEvaluation ? fullEvaluation.dimensions.goalAchievement.score : null,
      instructionAdherence: fullEvaluation ? fullEvaluation.dimensions.instructionAdherence.score : null,
      verdict: fullEvaluation ? fullEvaluation.verdict : '',
      evaluation: fullEvaluation,
      validationIssues: fullEvaluation && fullEvaluation.validation ? fullEvaluation.validation.issues || [] : [],
    };
  }

  function getCaseValidityAfterEvaluation(testCase: any, _evaluation: any) {
    return mapCaseStatusToLegacyValidity(String(testCase && testCase.caseStatus || 'draft').trim().toLowerCase() || 'draft');
  }

  function classifyPromptForSmokeRun(skillId: string, triggerPrompt: string) {
    const normalizedSkillId = String(skillId || '').trim();
    const normalizedPrompt = String(triggerPrompt || '').trim();
    if (!normalizedSkillId) {
      return { valid: false, reason: 'missing-skill-id' };
    }
    if (!normalizedPrompt) {
      return { valid: false, reason: 'empty-prompt' };
    }
    if (normalizedPrompt.length < 5) {
      return { valid: false, reason: 'prompt-too-short' };
    }
    if (normalizedPrompt.length > 500) {
      return { valid: false, reason: 'prompt-too-long' };
    }
    const skillExists = !!(skillRegistry && skillRegistry.getSkill(normalizedSkillId));
    if (!skillExists) {
      return { valid: false, reason: 'skill-missing' };
    }
    return { valid: true, reason: '' };
  }

  function markTestCaseValidity(caseId: string, validityStatus: string, noteSuffix = '') {
    ensureSchema();
    const existing = getTestCase(caseId);
    if (!existing) {
      return null;
    }
    const nextNote = noteSuffix
      ? [existing.note, noteSuffix].filter(Boolean).join(' | ')
      : existing.note;
    store.db
      .prepare(
        'UPDATE skill_test_cases SET validity_status = @validityStatus, note = @note, updated_at = @updatedAt WHERE id = @id'
      )
      .run({
        id: caseId,
        validityStatus,
        note: nextNote,
        updatedAt: nowIso(),
      });
    return getTestCase(caseId);
  }

  async function smokeValidateGeneratedCases(cases: any[], runOptions: any = {}) {
    const validatedCases: any[] = [];
    const invalidCases: any[] = [];
    const smokeRuns: any[] = [];

    for (const testCase of cases) {
      const check = classifyPromptForSmokeRun(testCase && testCase.skillId, testCase && testCase.triggerPrompt);
      if (!check.valid) {
        const invalidCase = markTestCaseValidity(testCase.id, 'invalid', `Smoke validation skipped: ${check.reason}`);
        if (invalidCase) {
          invalidCases.push(invalidCase);
        }
        continue;
      }

      try {
        const result = await executeRun(testCase, {
          ...runOptions,
          smokeValidation: true,
        });
        smokeRuns.push(result);
        const refreshed = result && result.testCase ? result.testCase : getTestCase(testCase.id);
        if (refreshed && refreshed.validityStatus === 'validated') {
          validatedCases.push(refreshed);
        } else if (refreshed) {
          invalidCases.push(refreshed);
        }
      } catch (error: any) {
        const invalidCase = markTestCaseValidity(
          testCase.id,
          'invalid',
          `Smoke validation failed: ${String(error && error.message ? error.message : error || 'unknown error')}`
        );
        if (invalidCase) {
          invalidCases.push(invalidCase);
        }
      }
    }

    return {
      validatedCases,
      invalidCases,
      smokeRuns,
    };
  }

  const skillTestRunExecutor = createSkillTestRunExecutor({
    store,
    agentToolBridge,
    skillRegistry,
    getProjectDir,
    startRunImpl,
    evaluateRunImpl,
    evaluateRun,
    skillTestIsolationDriver,
    buildProviderAuthEnv,
    buildSkillTestChainStepPrompt,
    buildSkillTestLiveTrace,
    broadcastSkillTestRunEvent,
    broadcastSkillTestToolEvent,
    collectSkillTestVisiblePathRoots,
    persistSkillTestRunSessionExport,
    buildSkillTestRunDebugSnapshot,
    mergeSkillTestRunDebugPayload,
    buildSkillTestChatBridgeEvidence,
    buildSkillTestFailureDebugPayload,
    normalizeCaseForRunOrThrow,
    getTestCase,
    normalizeTestRunRow,
    getCaseValidityAfterEvaluation,
    ensureSchema,
    normalizeRunStoreRunId,
    applySharedEnvironmentAssetDefault,
    upsertSkillEnvironmentAsset,
    updateTestCaseSourceMetadata,
    environmentCacheRootDir,
    environmentManifestRootDir,
    environmentImageBuilder: environmentImageBuilderImpl,
    skillTestBridgeTokenTtlSec,
    skillTestExecutionBridgeTokenTtlSec,
    skillTestChatApiUrl,
    nowIso,
  });
  const { executeRun } = skillTestRunExecutor;

  function getSkillTestSummary() {
    ensureSchema();

    const rows = store.db
      .prepare(
        `SELECT
          c.skill_id,
          ${buildEffectiveCaseStatusSql('c')} AS case_status_bucket,
          COUNT(DISTINCT c.id) AS case_count,
          COALESCE(SUM(CASE WHEN r.trigger_passed = 1 THEN 1 ELSE 0 END), 0) AS trigger_passed_count,
          COALESCE(SUM(${buildEffectiveExecutionPassedSql('c', 'r')}), 0) AS execution_passed_count,
          COALESCE(SUM(${buildExecutionRateEligibleRunSql('c', 'r')}), 0) AS execution_eligible_runs,
          COALESCE(SUM(CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS total_runs,
          COALESCE(SUM(CASE WHEN r.tool_accuracy IS NOT NULL THEN r.tool_accuracy ELSE 0 END), 0) AS sum_tool_accuracy,
          COUNT(r.tool_accuracy) AS tool_accuracy_count,
          COALESCE(SUM(CASE WHEN r.required_step_completion_rate IS NOT NULL THEN r.required_step_completion_rate ELSE 0 END), 0) AS sum_required_step_completion_rate,
          COUNT(r.required_step_completion_rate) AS required_step_completion_rate_count,
          COALESCE(SUM(CASE WHEN r.step_completion_rate IS NOT NULL THEN r.step_completion_rate ELSE 0 END), 0) AS sum_step_completion_rate,
          COUNT(r.step_completion_rate) AS step_completion_rate_count,
          COALESCE(SUM(CASE WHEN r.goal_achievement IS NOT NULL THEN r.goal_achievement ELSE 0 END), 0) AS sum_goal_achievement,
          COUNT(r.goal_achievement) AS goal_achievement_count,
          COALESCE(SUM(CASE WHEN r.tool_call_success_rate IS NOT NULL THEN r.tool_call_success_rate ELSE 0 END), 0) AS sum_tool_call_success_rate,
          COUNT(r.tool_call_success_rate) AS tool_call_success_rate_count
         FROM skill_test_cases c
         LEFT JOIN skill_test_runs r ON r.test_case_id = c.id
         GROUP BY c.skill_id, case_status_bucket
         ORDER BY c.skill_id`
      )
      .all();

    const summary: Record<string, any> = {};

    for (const row of rows) {
      const skillId = String(row.skill_id || '').trim();
      if (!summary[skillId]) {
        summary[skillId] = {
          skillId,
          casesByStatus: {},
          totalCases: 0,
          totalRuns: 0,
          triggerPassedCount: 0,
          executionPassedCount: 0,
          avgToolAccuracy: 0,
          avgRequiredStepCompletionRate: 0,
          avgStepCompletionRate: 0,
          avgGoalAchievement: 0,
          avgToolCallSuccessRate: 0,
          _executionEligibleRuns: 0,
          _metricSums: {},
          _metricCounts: {},
        };
      }
      const bucket = summary[skillId];
      bucket.casesByStatus[String(row.case_status_bucket || 'draft')] = Number(row.case_count || 0);
      bucket.totalCases += Number(row.case_count || 0);
      bucket.totalRuns += Number(row.total_runs || 0);
      bucket.triggerPassedCount += Number(row.trigger_passed_count || 0);
      bucket.executionPassedCount += Number(row.execution_passed_count || 0);
      bucket._executionEligibleRuns += Number(row.execution_eligible_runs || 0);
      for (const metric of SKILL_TEST_SUMMARY_AVERAGE_METRICS) {
        bucket._metricSums[metric.key] = Number(bucket._metricSums[metric.key] || 0) + Number(row[metric.sumColumn] || 0);
        bucket._metricCounts[metric.key] = Number(bucket._metricCounts[metric.key] || 0) + Number(row[metric.countColumn] || 0);
      }
    }

    for (const entry of Object.values(summary) as any[]) {
      entry.triggerRate = entry.totalRuns > 0 ? entry.triggerPassedCount / entry.totalRuns : null;
      entry.executionRate = entry._executionEligibleRuns > 0 ? entry.executionPassedCount / entry._executionEligibleRuns : null;
      for (const metric of SKILL_TEST_SUMMARY_AVERAGE_METRICS) {
        const metricCount = Number(entry._metricCounts[metric.key] || 0);
        entry[metric.key] = metricCount > 0 ? Number(entry._metricSums[metric.key] || 0) / metricCount : 0;
      }
      delete entry._executionEligibleRuns;
      delete entry._metricSums;
      delete entry._metricCounts;
    }

    return Object.values(summary);
  }

  const skillTestChainRunner = createSkillTestChainRunner({
    store,
    ensureSchema,
    skillRegistry,
    getProjectDir,
    environmentCacheRootDir,
    skillTestIsolationDriver,
    buildProviderAuthEnv,
    resolveEffectiveProvider: (provider: any) => resolveSetting(provider, process.env.PI_PROVIDER, DEFAULT_PROVIDER),
    broadcastSkillTestChainRunEvent,
    getCanonicalCasePrompt,
    normalizeTestCaseRow,
    getTestCase,
    normalizeCaseForRunOrThrow,
    executeRun,
    readSkillTestIsolationInput,
    readSkillTestEnvironmentInput,
  });
  const {
    buildSkillTestChainRunResponse,
    executeSkillTestChainRun,
    listSkillTestChainRunSummaries,
  } = skillTestChainRunner;

  return async function handleSkillTestRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    const skillTestDesignMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/skill-test-design(?:\/(import-matrix|confirm-matrix|export-drafts|preview-testing-doc-draft|apply-testing-doc-draft|refresh-environment-contract))?$/);
    if (skillTestDesignMatch) {
      ensureSchema();
      const conversationId = decodeURIComponent(skillTestDesignMatch[1]);
      const action = skillTestDesignMatch[2] || '';
      const { conversation, designState } = requireSkillTestDesignConversation(conversationId);

      if (req.method === 'GET' && !action) {
        const prepared = ensureAutomaticTestingDocPreview(conversation, designState);
        sendJson(res, 200, {
          conversation: prepared.conversation,
          state: summarizeSkillTestDesignConversation(prepared.conversation, prepared.designState),
        });
        return true;
      }

      if (req.method === 'POST' && action === 'preview-testing-doc-draft') {
        const body = await readRequestJson(req);
        const requestedMessageId = String(body && (body.messageId || body.sourceMessageId) || '').trim();
        const sourceMessage = requestedMessageId
          ? findConversationMessage(conversation, requestedMessageId)
          : findLatestConversationMessage(conversation);
        if (requestedMessageId && !sourceMessage) {
          throw createValidationHttpError(
            buildValidationIssue('testing_doc_source_message_invalid', 'error', 'messageId', 'messageId 必须指向当前会话中的消息')
          );
        }
        if (!sourceMessage) {
          throw createValidationHttpError(
            buildValidationIssue('testing_doc_source_message_required', 'error', 'messageId', '起草 TESTING.md 需要关联当前会话中的一条用户或 assistant 消息')
          );
        }

        const target = resolveSkillTestingDocTarget(skillRegistry, designState.skillId, {
          projectDir: getProjectDir ? getProjectDir() : '',
        });
        const fileInfo = readTestingDocFileInfo(target);
        let draft: any;
        try {
          draft = buildTestingDocDraftFromSkillContext(target.skill, {
            skillId: designState.skillId,
            conversationId: conversation.id,
            messageId: String(sourceMessage.id || '').trim(),
            agentRole: sourceMessage.agentId
              ? String(designState.participantRoles && designState.participantRoles[sourceMessage.agentId] || '').trim() || 'scribe'
              : String(body && body.agentRole || sourceMessage.role || 'user').trim() || 'user',
            createdBy: String(body && body.requestedBy || 'user').trim() || 'user',
            fileExistsAtPreview: fileInfo.exists,
            fileHashAtPreview: fileInfo.hash,
            fileSizeAtPreview: fileInfo.size,
            sections: Array.isArray(body && body.sections) ? body.sections : undefined,
            draft: body && body.draft && typeof body.draft === 'object' ? body.draft : undefined,
          });
        } catch (error: any) {
          if (error && Number.isInteger(error.statusCode) && Array.isArray(error.issues)) {
            throw error;
          }
          throw createValidationHttpError(
            buildValidationIssue('testing_doc_draft_invalid', 'error', 'testingDocDraft', String(error && error.message || 'TESTING.md 草稿不合法'))
          );
        }

        const environmentContract = buildTestingDocContractSummary(target.skill);
        const nextConversation = updateSkillTestDesignConversationState(conversation, {
          ...designState,
          testingDocDraft: draft,
          environmentContract,
        });
        const nextState = getSkillTestDesignState(nextConversation);
        sendJson(res, 200, {
          conversation: nextConversation,
          state: summarizeSkillTestDesignConversation(nextConversation, nextState),
          draft,
          environmentContract,
        });
        return true;
      }

      if (req.method === 'POST' && action === 'apply-testing-doc-draft') {
        const body = await readRequestJson(req);
        const draftId = String(body && body.draftId || '').trim();
        const currentDraft = designState.testingDocDraft && typeof designState.testingDocDraft === 'object'
          ? designState.testingDocDraft
          : null;
        if (!currentDraft || !currentDraft.draftId) {
          throw createValidationHttpError(
            buildValidationIssue('testing_doc_draft_missing', 'error', 'testingDocDraft', '当前没有可写入的 TESTING.md 草稿')
          );
        }
        if (!draftId || draftId !== String(currentDraft.draftId || '').trim()) {
          throw createValidationHttpError(
            buildValidationIssue('testing_doc_draft_id_mismatch', 'error', 'draftId', 'draftId 与当前 TESTING.md 草稿不一致')
          );
        }
        const draftStatus = String(currentDraft.status || '').trim();
        if (draftStatus === 'applied' || draftStatus === 'rejected' || draftStatus === 'superseded') {
          throw createValidationHttpError(
            buildValidationIssue('testing_doc_draft_not_applyable', 'error', 'testingDocDraft.status', '当前 TESTING.md 草稿状态不可写入')
          );
        }

        const target = resolveSkillTestingDocTarget(skillRegistry, designState.skillId, {
          projectDir: getProjectDir ? getProjectDir() : '',
        });
        const fileInfo = readTestingDocFileInfo(target);
        const expectedExists = Boolean(currentDraft.file && currentDraft.file.existsAtPreview);
        const expectedHash = String(currentDraft.file && currentDraft.file.hashAtPreview || '').trim();
        if (fileInfo.exists !== expectedExists || (fileInfo.exists && expectedHash && fileInfo.hash !== expectedHash)) {
          const supersededDraft = {
            ...currentDraft,
            status: 'superseded',
            supersededAt: nowIso(),
            supersededReason: 'target_file_changed',
          };
          updateSkillTestDesignConversationState(conversation, {
            ...designState,
            testingDocDraft: supersededDraft,
          });
          throw createValidationHttpError(
            buildValidationIssue('testing_doc_draft_superseded', 'error', 'testingDocDraft', '目标 TESTING.md 已在预览后变化，请重新生成预览再写入')
          );
        }
        if (fileInfo.exists && body && body.confirmOverwrite !== true) {
          throw createValidationHttpError(
            buildValidationIssue('testing_doc_overwrite_confirmation_required', 'error', 'confirmOverwrite', '目标 TESTING.md 已存在，必须基于完整覆盖预览显式确认后才能覆盖')
          );
        }

        assertCanWriteTestingDocTarget(target);
        const content = String(currentDraft.content || '').trim();
        if (!content) {
          throw createValidationHttpError(
            buildValidationIssue('testing_doc_content_required', 'error', 'testingDocDraft.content', 'TESTING.md 草稿内容不能为空')
          );
        }
        fs.writeFileSync(target.fullPath, `${content}\n`, 'utf8');
        const appliedAt = nowIso();
        const appliedContentHash = hashTestingDocContent(`${content}\n`);
        const appliedDraft = {
          ...currentDraft,
          status: 'applied',
          file: {
            ...(currentDraft.file && typeof currentDraft.file === 'object' ? currentDraft.file : {}),
            targetPath: SKILL_TESTING_DOC_TARGET_PATH,
            appliedHash: appliedContentHash,
            appliedAt,
          },
          audit: {
            ...(currentDraft.audit && typeof currentDraft.audit === 'object' ? currentDraft.audit : {}),
            appliedBy: String(body && body.appliedBy || 'user').trim() || 'user',
            appliedAt,
          },
        };
        const environmentContract = buildTestingDocContractSummary(target.skill);
        const nextConversation = updateSkillTestDesignConversationState(conversation, {
          ...designState,
          phase: designState.matrix && designState.matrix.matrixId ? SKILL_TEST_DESIGN_PHASES.AWAITING_CONFIRMATION : designState.phase,
          confirmation: null,
          export: null,
          testingDocDraft: appliedDraft,
          environmentContract: {
            ...environmentContract,
            refreshedAt: appliedAt,
            requiresMatrixReconfirmation: Boolean(designState.matrix && designState.matrix.matrixId),
          },
        });
        const nextState = getSkillTestDesignState(nextConversation);
        sendJson(res, 200, {
          conversation: nextConversation,
          state: summarizeSkillTestDesignConversation(nextConversation, nextState),
          draft: appliedDraft,
          environmentContract,
          requiresMatrixReconfirmation: Boolean(designState.matrix && designState.matrix.matrixId),
        });
        return true;
      }

      if (req.method === 'POST' && action === 'refresh-environment-contract') {
        const target = resolveSkillTestingDocTarget(skillRegistry, designState.skillId, {
          projectDir: getProjectDir ? getProjectDir() : '',
        });
        const environmentContract = {
          ...buildTestingDocContractSummary(target.skill),
          refreshedAt: nowIso(),
        };
        const nextConversation = updateSkillTestDesignConversationState(conversation, {
          ...designState,
          environmentContract,
        });
        const nextState = getSkillTestDesignState(nextConversation);
        sendJson(res, 200, {
          conversation: nextConversation,
          state: summarizeSkillTestDesignConversation(nextConversation, nextState),
          environmentContract,
        });
        return true;
      }

      if (req.method === 'POST' && action === 'import-matrix') {
        const body = await readRequestJson(req);
        const sourceMessageId = String(body && body.messageId || '').trim();
        if (!sourceMessageId) {
          throw createValidationHttpError(
            buildValidationIssue('matrix_source_message_required', 'error', 'messageId', '导入测试矩阵必须关联来源 assistant 消息')
          );
        }
        const sourceMessage = Array.isArray(conversation.messages)
          ? conversation.messages.find((message: any) => message && message.id === sourceMessageId)
          : null;
        if (!sourceMessage || sourceMessage.role !== 'assistant') {
          throw createValidationHttpError(
            buildValidationIssue('matrix_source_message_invalid', 'error', 'messageId', 'messageId 必须指向当前会话中的 assistant 消息')
          );
        }

        let matrixInput = body && body.matrix;
        let sourceArtifactPath = '';
        const matrixPath = normalizeSkillTestMatrixArtifactPath(body && (body.matrixPath || body.artifactPath || body.matrixArtifactPath));
        if (!matrixInput && matrixPath) {
          if (!sourceMessageMentionsMatrixArtifactPath(sourceMessage, matrixPath)) {
            throw createValidationHttpError(
              buildValidationIssue('matrix_artifact_source_mismatch', 'error', 'matrixPath', '矩阵 artifact 路径必须出现在来源 assistant 消息中')
            );
          }
          const artifact = readSkillTestMatrixArtifact(matrixPath, getProjectDir ? getProjectDir() : process.cwd());
          matrixInput = artifact.matrix;
          sourceArtifactPath = artifact.relativePath;
        }
        if (!matrixInput) {
          throw createValidationHttpError(
            buildValidationIssue('matrix_missing', 'error', 'matrix', '导入测试矩阵需要提供 matrix 对象或 matrixPath artifact')
          );
        }

        let matrix: any = null;
        try {
          matrix = normalizeSkillTestMatrix(matrixInput, { skillId: designState.skillId });
        } catch (error: any) {
          throw createValidationHttpError(
            buildValidationIssue('matrix_invalid', 'error', 'matrix', String(error && error.message ? error.message : error || '测试矩阵不合法'))
          );
        }
        const sourceAgentRole = sourceMessage && sourceMessage.agentId
          ? String(designState.participantRoles && designState.participantRoles[sourceMessage.agentId] || '').trim()
          : '';
        const nextConversation = updateSkillTestDesignConversationState(conversation, {
          ...designState,
          phase: SKILL_TEST_DESIGN_PHASES.AWAITING_CONFIRMATION,
          matrix: {
            ...matrix,
            sourceMessageId,
            sourceArtifactPath,
            agentRole: sourceAgentRole || 'scribe',
            importedAt: nowIso(),
          },
          confirmation: null,
          export: null,
        });
        const nextState = getSkillTestDesignState(nextConversation);
        sendJson(res, 200, {
          conversation: nextConversation,
          state: summarizeSkillTestDesignConversation(nextConversation, nextState),
        });
        return true;
      }

      if (req.method === 'POST' && action === 'confirm-matrix') {
        const body = await readRequestJson(req);
        const matrix = designState.matrix && typeof designState.matrix === 'object' ? designState.matrix : null;
        const requestedMatrixId = String(body && body.matrixId || '').trim();
        if (!matrix || !matrix.matrixId) {
          throw createValidationHttpError(
            buildValidationIssue('matrix_missing', 'error', 'matrix', '当前没有可确认的测试矩阵')
          );
        }
        if (requestedMatrixId && requestedMatrixId !== String(matrix.matrixId || '').trim()) {
          throw createValidationHttpError(
            buildValidationIssue('matrix_id_mismatch', 'error', 'matrixId', 'matrixId 与当前导入矩阵不一致')
          );
        }

        const matrixValidationIssues = buildSkillTestDesignMatrixValidationIssues(matrix);
        if (matrixValidationIssues.length > 0) {
          throw createValidationHttpError(matrixValidationIssues, '测试矩阵仍有未解决的链路或环境问题');
        }

        const nextConversation = updateSkillTestDesignConversationState(conversation, {
          ...designState,
          phase: SKILL_TEST_DESIGN_PHASES.GENERATING_DRAFTS,
          confirmation: buildSkillTestDesignConfirmationRecord(conversation, designState, matrix, body),
        });
        const nextState = getSkillTestDesignState(nextConversation);
        sendJson(res, 200, {
          conversation: nextConversation,
          state: summarizeSkillTestDesignConversation(nextConversation, nextState),
        });
        return true;
      }

      if (req.method === 'POST' && action === 'export-drafts') {
        const body = await readRequestJson(req);
        const requestedMatrixId = String(body && body.matrixId || '').trim();
        const matrix = designState.matrix && typeof designState.matrix === 'object' ? designState.matrix : null;
        if (!matrix || !matrix.matrixId) {
          throw createValidationHttpError(
            buildValidationIssue('matrix_missing', 'error', 'matrix', '当前没有可导出的测试矩阵')
          );
        }
        if (requestedMatrixId && requestedMatrixId !== String(matrix.matrixId || '').trim()) {
          throw createValidationHttpError(
            buildValidationIssue('matrix_id_mismatch', 'error', 'matrixId', 'matrixId 与当前导入矩阵不一致')
          );
        }

        const matrixValidationIssues = buildSkillTestDesignMatrixValidationIssues(matrix);
        if (matrixValidationIssues.length > 0) {
          throw createValidationHttpError(matrixValidationIssues, '测试矩阵仍有未解决的链路或环境问题');
        }

        const requestedConfirmation = body && body.confirmMatrix
          ? buildSkillTestDesignConfirmationRecord(conversation, designState, matrix, body)
          : null;
        const exportState = requestedConfirmation
          ? {
              ...designState,
              confirmation: requestedConfirmation,
            }
          : designState;
        const exported = buildSkillTestDesignExportDrafts(conversation, exportState, {
          exportedBy: body && body.exportedBy ? body.exportedBy : 'user',
        });
        const nextConversation = updateSkillTestDesignConversationState(conversation, {
          ...exportState,
          phase: SKILL_TEST_DESIGN_PHASES.EXPORTED,
          export: {
            matrixId: String(matrix.matrixId || '').trim(),
            exportedAt: nowIso(),
            exportedCaseIds: exported.cases.map((entry: any) => entry.id),
            exportedCount: exported.cases.length,
            duplicateWarningCount: Array.isArray(exported.duplicateWarnings) ? exported.duplicateWarnings.length : 0,
            skippedRowCount: Array.isArray(exported.skippedRows) ? exported.skippedRows.length : 0,
            skippedRows: Array.isArray(exported.skippedRows) ? exported.skippedRows : [],
          },
        });
        const nextState = getSkillTestDesignState(nextConversation);
        sendJson(res, 200, {
          conversation: nextConversation,
          state: summarizeSkillTestDesignConversation(nextConversation, nextState),
          exportedCount: exported.cases.length,
          cases: exported.cases,
          duplicateWarnings: exported.duplicateWarnings,
          skippedRows: exported.skippedRows,
        });
        return true;
      }
    }

    // ---- Global summary ----
    if (req.method === 'GET' && pathname === '/api/skill-test-summary') {
      sendJson(res, 200, { summary: getSkillTestSummary() });
      return true;
    }

    const environmentAssetsMatch = pathname.match(/^\/api\/skills\/([^/]+)\/environment-assets(?:\/([^/]+))?$/);
    if (environmentAssetsMatch && req.method === 'GET') {
      const skillId = decodeURIComponent(environmentAssetsMatch[1]);
      const envProfile = environmentAssetsMatch[2] ? decodeURIComponent(environmentAssetsMatch[2]) : '';
      if (envProfile) {
        const asset = getSkillEnvironmentAsset(skillId, envProfile);
        if (!asset) {
          throw createHttpError(404, 'Environment asset not found');
        }
        sendJson(res, 200, { skillId, asset });
        return true;
      }
      sendJson(res, 200, {
        skillId,
        assets: listSkillEnvironmentAssets(skillId),
      });
      return true;
    }

    // ---- Skill-scoped routes: /api/skills/:skillId/test-cases/... ----
    const testCasesBaseMatch = pathname.match(/^\/api\/skills\/([^/]+)\/test-cases(?:\/|$)(.*)/);
    if (testCasesBaseMatch) {
      const skillId = decodeURIComponent(testCasesBaseMatch[1]);
      const subPath = testCasesBaseMatch[2] || '';

      // GET /api/skills/:skillId/test-cases — list
      if (req.method === 'GET' && !subPath) {
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '', 10);
        sendJson(res, 200, { cases: listTestCases(skillId, limit) });
        return true;
      }

      // POST /api/skills/:skillId/test-cases/generate — AI generate drafts only
      if (req.method === 'POST' && subPath === 'generate') {
        const skill = skillRegistry ? skillRegistry.getSkill(skillId) : null;
        if (!skill) {
          throw createHttpError(404, `Skill not found: ${skillId}`);
        }

        const body = await readRequestJson(req);
        const count = Math.max(1, Math.min(10, Number(body.count || 3)));
        const loadingMode = String(body.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
        const createDrafts = body.createDrafts !== false;
        if (loadingMode !== 'dynamic' && loadingMode !== 'full') {
          throw createHttpError(400, 'loadingMode must be one of: dynamic, full');
        }

        const prompts = await generateDraftsWithAi(skill, {
          ...body,
          count,
          loadingMode,
        });

        const cases: any[] = [];
        for (const prompt of prompts) {
          const promptValue: Record<string, any> = isPlainObject(prompt)
            ? (prompt as Record<string, any>)
            : {};
          const promptUserPrompt = promptValue.userPrompt || promptValue.triggerPrompt;
          const promptExpectedTools = Array.isArray(promptValue.expectedTools) ? promptValue.expectedTools : [];
          const promptExpectedSteps = Array.isArray(promptValue.expectedSteps) ? promptValue.expectedSteps : [];
          const promptExpectedSequence = Array.isArray(promptValue.expectedSequence) ? promptValue.expectedSequence : [];

          const createInput: any = {
            skillId,
            loadingMode,
            caseStatus: createDrafts ? 'draft' : 'ready',
            userPrompt: promptUserPrompt,
            triggerPrompt: promptValue.triggerPrompt,
            expectedTools: promptExpectedTools,
            expectedBehavior: promptValue.expectedBehavior || '',
            generationProvider: promptValue.generationProvider || '',
            generationModel: promptValue.generationModel || '',
            generationCreatedAt: promptValue.generationCreatedAt || '',
            note: promptValue.note || 'AI-generated draft',
          };

          if (loadingMode === 'full') {
            createInput.expectedGoal = promptValue.expectedGoal || '';

            if (promptExpectedSteps.length > 0) {
              createInput.expectedSteps = promptExpectedSteps;
            }

            if (promptExpectedSequence.length > 0) {
              if (promptExpectedSteps.length > 0) {
                const stepIdSet = new Set<string>();
                const toolNameToStepIds = new Map<string, string[]>();
                for (const step of promptExpectedSteps) {
                  const stepId = String(step && step.id || '').trim();
                  if (!stepId) {
                    continue;
                  }
                  stepIdSet.add(stepId);
                  const strongSignals = Array.isArray(step && step.strongSignals) ? step.strongSignals : [];
                  for (const signal of strongSignals) {
                    if (!isPlainObject(signal) || String(signal.type || '').trim() !== 'tool') {
                      continue;
                    }
                    const toolName = String(signal.toolName || signal.tool || signal.name || '').trim();
                    if (!toolName) {
                      continue;
                    }
                    const existingStepIds = toolNameToStepIds.get(toolName) || [];
                    if (!existingStepIds.includes(stepId)) {
                      existingStepIds.push(stepId);
                      toolNameToStepIds.set(toolName, existingStepIds);
                    }
                  }
                }

                const mappedSequence: string[] = [];
                const usedStepIds = new Set<string>();
                for (const entry of promptExpectedSequence) {
                  const directRef = normalizeStepSequenceReference(entry);
                  let mappedStepId = directRef && stepIdSet.has(directRef) ? directRef : '';
                  if (!mappedStepId) {
                    const legacyName = normalizeSequenceEntryName(entry);
                    const candidates = legacyName ? (toolNameToStepIds.get(legacyName) || []) : [];
                    mappedStepId = candidates.find((candidate) => !usedStepIds.has(candidate)) || '';
                  }
                  if (!mappedStepId || usedStepIds.has(mappedStepId)) {
                    continue;
                  }
                  usedStepIds.add(mappedStepId);
                  mappedSequence.push(mappedStepId);
                }

                if (mappedSequence.length > 0) {
                  createInput.expectedSequence = mappedSequence;
                }
              } else {
                createInput.expectedSequence = promptExpectedSequence;
              }
            }

            if (isPlainObject(promptValue.evaluationRubric)) {
              createInput.evaluationRubric = promptValue.evaluationRubric;
            }
          }

          const createdCase = createTestCase(createInput);
          if (createdCase && createdCase.testCase) {
            cases.push(createdCase.testCase);
          }
        }

        sendJson(res, 201, {
          generated: cases.length,
          draftCount: cases.filter((testCase) => testCase.caseStatus === 'draft').length,
          cases,
        });
        return true;
      }

      // POST /api/skills/:skillId/test-cases — manual create
      if (req.method === 'POST' && !subPath) {
        const body = await readRequestJson(req);
        const createdCase = createTestCase({
          ...body,
          skillId,
        });
        sendJson(res, 201, { testCase: createdCase.testCase, issues: createdCase.issues });
        return true;
      }

      // POST /api/skills/:skillId/test-cases/run-all — run explicit ready cases
      if (req.method === 'POST' && subPath === 'run-all') {
        ensureSchema();
        const cases = store.db
          .prepare(
            `SELECT * FROM skill_test_cases c
             WHERE c.skill_id = @skillId
               AND ${buildEffectiveCaseStatusSql('c')} = 'ready'
             ORDER BY c.created_at ASC`
          )
          .all({ skillId });

        if (cases.length === 0) {
          throw createHttpError(404, 'No test cases to run');
        }

        const body = await readRequestJson(req);
        const results: any[] = [];

        for (const caseRow of cases) {
          const testCase = normalizeTestCaseRow(caseRow);
          if (!testCase) continue;
          try {
            const result = await executeRun(testCase, {
              provider: body.provider,
              model: body.model,
              promptVersion: body.promptVersion,
              agentId: body.agentId,
              agentName: body.agentName,
              isolation: readSkillTestIsolationInput(body),
              environment: readSkillTestEnvironmentInput(body),
              environmentBuild: readSkillTestEnvironmentBuildInput(body),
            });
            results.push(result);
          } catch (error: any) {
            results.push({
              testCase,
              run: null,
              error: String(error.message || error),
              issues: Array.isArray(error && error.issues) ? error.issues : [],
            });
          }
        }

        sendJson(res, 200, { total: results.length, results });
        return true;
      }

      // Sub-resource routes: :caseId/...
      const subMatch = subPath.match(/^([^/]+)(?:\/(.*))?$/);
      if (subMatch) {
        const caseId = decodeURIComponent(subMatch[1]);
        const action = subMatch[2] || '';
        const requireSkillScopedTestCase = () => {
          const testCase = getTestCase(caseId, skillId);
          if (!testCase) {
            throw createHttpError(404, 'Test case not found');
          }
          return testCase;
        };

        // GET /api/skills/:skillId/test-cases/:caseId/runs — runs for specific case
        if (req.method === 'GET' && action === 'runs') {
          ensureSchema();
          requireSkillScopedTestCase();
          const runsLimit = Number.parseInt(requestUrl.searchParams.get('limit') || '', 10);
          const safeRunsLimit = Number.isInteger(runsLimit) && runsLimit > 0 ? Math.min(runsLimit, 500) : 50;
          const rows = store.db
            .prepare(
              `SELECT
                 r.*,
                 e.provider AS provider,
                 e.model AS model,
                 e.prompt_version AS prompt_version
               FROM skill_test_runs r
               LEFT JOIN eval_case_runs e ON e.id = r.eval_case_run_id
               WHERE r.test_case_id = @caseId
               ORDER BY r.created_at DESC
               LIMIT @limit`
            )
            .all({ caseId, limit: safeRunsLimit });
          sendJson(res, 200, { runs: rows.map(normalizeTestRunRow).filter(Boolean) });
          return true;
        }

        // GET /api/skills/:skillId/test-cases/:caseId/regression
        if (req.method === 'GET' && action === 'regression') {
          requireSkillScopedTestCase();
          sendJson(res, 200, {
            testCaseId: caseId,
            regression: getCaseRegressionSummary(caseId),
          });
          return true;
        }

        // POST /api/skills/:skillId/test-cases/:caseId/run
        if (req.method === 'POST' && action === 'run') {
          const testCase = requireSkillScopedTestCase();

          const body = await readRequestJson(req);
          const result = await executeRun(testCase, {
            provider: body.provider,
            model: body.model,
            promptVersion: body.promptVersion,
            agentId: body.agentId,
            agentName: body.agentName,
            isolation: readSkillTestIsolationInput(body),
            environment: readSkillTestEnvironmentInput(body),
            environmentBuild: readSkillTestEnvironmentBuildInput(body),
          });
          sendJson(res, 200, result);
          return true;
        }

        // PATCH /api/skills/:skillId/test-cases/:caseId
        if (req.method === 'PATCH' && !action) {
          requireSkillScopedTestCase();
          const body = await readRequestJson(req);
          const updatedCase = updateTestCase(caseId, body || {});
          sendJson(res, 200, { testCase: updatedCase.testCase, issues: updatedCase.issues });
          return true;
        }

        // POST /api/skills/:skillId/test-cases/:caseId/mark-ready
        if (req.method === 'POST' && action === 'mark-ready') {
          requireSkillScopedTestCase();
          const updatedCase = markTestCaseStatus(caseId, 'ready');
          sendJson(res, 200, { testCase: updatedCase.testCase, issues: updatedCase.issues });
          return true;
        }

        // POST /api/skills/:skillId/test-cases/:caseId/mark-draft
        if (req.method === 'POST' && action === 'mark-draft') {
          requireSkillScopedTestCase();
          const updatedCase = markTestCaseStatus(caseId, 'draft');
          sendJson(res, 200, { testCase: updatedCase.testCase, issues: updatedCase.issues });
          return true;
        }

        // GET /api/skills/:skillId/test-cases/:caseId
        if (req.method === 'GET' && !action) {
          const testCase = requireSkillScopedTestCase();
          sendJson(res, 200, { testCase });
          return true;
        }

        // DELETE /api/skills/:skillId/test-cases/:caseId
        if (req.method === 'DELETE' && !action) {
          ensureSchema();
          requireSkillScopedTestCase();
          const deleteSkillTestCaseTransaction = store.db.transaction((id: string) => {
            store.db.prepare('DELETE FROM skill_test_chain_run_steps WHERE test_case_id = @id').run({ id });
            store.db.prepare('DELETE FROM skill_test_runs WHERE test_case_id = @id').run({ id });
            store.db.prepare('DELETE FROM skill_test_cases WHERE id = @id').run({ id });
          });
          deleteSkillTestCaseTransaction(caseId);
          sendJson(res, 200, { deletedId: caseId });
          return true;
        }
      }
    }

    const testChainsRunMatch = pathname.match(/^\/api\/skills\/([^/]+)\/test-chains\/run$/);
    if (testChainsRunMatch && req.method === 'POST') {
      const skillId = decodeURIComponent(testChainsRunMatch[1]);
      const body = await readRequestJson(req);
      const result = await executeSkillTestChainRun(skillId, body || {});
      sendJson(res, 200, result);
      return true;
    }

    const testChainsByExportMatch = pathname.match(/^\/api\/skills\/([^/]+)\/test-chains\/by-export\/([^/]+)\/runs$/);
    if (testChainsByExportMatch && req.method === 'GET') {
      const skillId = decodeURIComponent(testChainsByExportMatch[1]);
      const exportChainId = decodeURIComponent(testChainsByExportMatch[2]);
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '', 10);
      sendJson(res, 200, {
        skillId,
        exportChainId,
        runs: listSkillTestChainRunSummaries(skillId, exportChainId, limit),
      });
      return true;
    }

    const testChainsDetailMatch = pathname.match(/^\/api\/skills\/([^/]+)\/test-chains\/([^/]+)$/);
    if (testChainsDetailMatch && req.method === 'GET') {
      const skillId = decodeURIComponent(testChainsDetailMatch[1]);
      const chainRunId = decodeURIComponent(testChainsDetailMatch[2]);
      sendJson(res, 200, buildSkillTestChainRunResponse(skillId, chainRunId));
      return true;
    }

    const skillRegressionMatch = pathname.match(/^\/api\/skills\/([^/]+)\/regression$/);
    if (skillRegressionMatch && req.method === 'GET') {
      const skillId = decodeURIComponent(skillRegressionMatch[1]);
      sendJson(res, 200, {
        skillId,
        regression: getSkillRegressionSummary(skillId),
      });
      return true;
    }

    // ---- Skill-scoped runs: /api/skills/:skillId/test-runs ----
    const testRunsMatch = pathname.match(/^\/api\/skills\/([^/]+)\/test-runs$/);
    if (testRunsMatch && req.method === 'GET') {
      const skillId = decodeURIComponent(testRunsMatch[1]);
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '', 10);
      sendJson(res, 200, { runs: listTestRuns(skillId, limit) });
      return true;
    }

    const runSessionExportMatch = pathname.match(/^\/api\/skill-test-runs\/([^/]+)\/session-export$/);
    if (runSessionExportMatch && req.method === 'GET') {
      const runId = decodeURIComponent(runSessionExportMatch[1]);
      const runDetail = getSkillTestRunDetailPayload(runId);
      const sessionPath = resolveSkillTestRunSessionExportPath(runDetail);
      const sessionContent = fs.readFileSync(sessionPath, 'utf8');
      sendTextDownload(res, sessionContent, `skill-test-run-${runDetail.run.id}-session.jsonl`, 'application/x-ndjson; charset=utf-8');
      return true;
    }

    // ---- Single run detail: /api/skill-test-runs/:runId ----
    const runDetailMatch = pathname.match(/^\/api\/skill-test-runs\/([^/]+)$/);
    if (runDetailMatch && req.method === 'GET') {
      const runId = decodeURIComponent(runDetailMatch[1]);
      const runDetail = getSkillTestRunDetailPayload(runId);
      sendJson(res, 200, { run: runDetail.run, debug: runDetail.debug, result: runDetail.result, trace: runDetail.trace });
      return true;
    }

    return false;
  };
}
