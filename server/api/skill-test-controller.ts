import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import { resolveToolRelativePath } from '../http/path-utils';
import { migrateSkillTestSchema } from '../../storage/sqlite/migrations';
import { DEFAULT_THINKING, resolveSetting, startRun } from '../../lib/minimal-pi';
import { createSqliteRunStore } from '../../lib/sqlite-store';
import { buildLlmGenerationPrompt, generateSkillTestPrompts } from '../../lib/skill-test-generator';
import { ROOT_DIR } from '../app/config';
import { ensureAgentSandbox, toPortableShellPath } from '../domain/conversation/turn/agent-sandbox';

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

function isPlainObject(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: any, key: string) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function normalizePromptText(value: any) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

const FULL_CASE_MAX_EXPECTED_STEPS = 12;
const STEP_SIGNAL_MAX_COUNT = 5;
const ALLOWED_SIGNAL_TYPES = new Set(['tool', 'text', 'state']);
const ALLOWED_SIGNAL_MATCHERS = new Set(['contains', 'equals', 'regex']);
const ALLOWED_CRITICAL_DIMENSIONS = new Set(['sequenceAdherence']);
const THRESHOLD_DIMENSION_KEYS = [
  'requiredToolCoverage',
  'toolCallSuccessRate',
  'goalAchievement',
  'instructionAdherence',
  'sequenceAdherence',
  'toolErrorRate',
];

function buildValidationIssue(code: string, severity: 'error' | 'warning' | 'needs-review', path: string, message: string) {
  return { code, severity, path, message };
}

function mergeValidationIssues(...groups: any[]) {
  const merged: any[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const entry of group) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const issue = buildValidationIssue(
        String(entry.code || 'validation_issue').trim() || 'validation_issue',
        entry.severity === 'warning' || entry.severity === 'needs-review' ? entry.severity : 'error',
        String(entry.path || '').trim(),
        String(entry.message || '').trim()
      );
      const key = `${issue.code}\u0000${issue.severity}\u0000${issue.path}\u0000${issue.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(issue);
    }
  }
  return merged;
}

function hasBlockingValidationIssue(issues: any[]) {
  return Array.isArray(issues) && issues.some((issue) => issue && issue.severity === 'error');
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

function createValidationHttpError(issueOrIssues: any, fallbackMessage?: string, extraDetails: any = {}) {
  const issues = mergeValidationIssues(Array.isArray(issueOrIssues) ? issueOrIssues : [issueOrIssues]);
  const firstMessage = issues[0] && issues[0].message ? String(issues[0].message) : '';
  return createHttpError(400, fallbackMessage || firstMessage || 'Validation failed', {
    issues,
    ...(extraDetails && typeof extraDetails === 'object' ? extraDetails : {}),
  });
}

function getCanonicalCasePrompt(value: any) {
  if (!value || typeof value !== 'object') {
    return '';
  }
  return normalizePromptText(value.userPrompt ?? value.triggerPrompt ?? value.trigger_prompt);
}

function slugifyValidationId(value: any, fallback: string) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

function normalizeBooleanFlag(value: any, fallback = true) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  return fallback;
}

function normalizePositiveInteger(value: any) {
  if (value == null || value === '') {
    return null;
  }
  const normalized = typeof value === 'string'
    ? Number.parseInt(value, 10)
    : Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizeMatcherName(value: any) {
  const normalized = String(value || '').trim().toLowerCase();
  return ALLOWED_SIGNAL_MATCHERS.has(normalized) ? normalized : '';
}

function parseExpectedToolOrder(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }

  const rawValue = hasOwn(value, 'order')
    ? value.order
    : hasOwn(value, 'sequence')
      ? value.sequence
      : hasOwn(value, 'sequenceIndex')
        ? value.sequenceIndex
        : hasOwn(value, 'sequence_index')
          ? value.sequence_index
          : null;

  if (rawValue == null || rawValue === '') {
    return null;
  }

  const order = typeof rawValue === 'string'
    ? Number.parseInt(rawValue, 10)
    : Number(rawValue);

  return Number.isInteger(order) && order > 0 ? order : null;
}

function sanitizeExpectedToolSpecEntry(value: any) {
  if (typeof value === 'string') {
    const name = String(value || '').trim();
    return name || null;
  }
  if (!isPlainObject(value)) {
    return null;
  }

  const name = String(value.name || value.tool || '').trim();
  if (!name) {
    return null;
  }

  const requiredParamsSource = Array.isArray(value.requiredParams)
    ? value.requiredParams
    : Array.isArray(value.required_params)
      ? value.required_params
      : [];
  const requiredParams = [...new Set(
    requiredParamsSource
      .map((entry: any) => String(entry || '').trim())
      .filter(Boolean)
  )];

  let argumentsShape: any;
  if (hasOwn(value, 'arguments')) {
    argumentsShape = value.arguments;
  } else if (hasOwn(value, 'args')) {
    argumentsShape = value.args;
  } else if (hasOwn(value, 'params')) {
    argumentsShape = value.params;
  }

  const order = parseExpectedToolOrder(value);
  const normalized: any = { name };
  if (argumentsShape !== undefined) {
    normalized.arguments = argumentsShape;
  }
  if (requiredParams.length > 0) {
    normalized.requiredParams = requiredParams;
  }
  if (order != null) {
    normalized.order = order;
  }
  return normalized;
}

function sanitizeExpectedToolSpecs(value: any) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => sanitizeExpectedToolSpecEntry(entry))
    .filter(Boolean);
}

function normalizeToolNameForMatch(value: any) {
  return String(value || '').trim();
}

function toolNamesMatch(expectedName: any, actualName: any) {
  return normalizeToolNameForMatch(expectedName) === normalizeToolNameForMatch(actualName);
}

function normalizeContainsComparableText(value: any) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function normalizeExpectedToolSpecs(value: any) {
  return sanitizeExpectedToolSpecs(value).map((entry: any, index: number) => {
    if (typeof entry === 'string') {
      return {
        name: normalizeToolNameForMatch(entry),
        requiredParams: [],
        hasArgumentShape: false,
        hasParameterExpectation: false,
        hasSequenceExpectation: false,
        arguments: undefined,
        order: null,
        sourceOrder: index,
      };
    }

    const requiredParams = Array.isArray(entry.requiredParams)
      ? entry.requiredParams.map((item: any) => String(item || '').trim()).filter(Boolean)
      : [];
    const hasArgumentShape = hasOwn(entry, 'arguments');
    const order = parseExpectedToolOrder(entry);

    return {
      name: normalizeToolNameForMatch(entry.name),
      requiredParams,
      hasArgumentShape,
      hasParameterExpectation: hasArgumentShape || requiredParams.length > 0,
      hasSequenceExpectation: order != null,
      arguments: hasArgumentShape ? entry.arguments : undefined,
      order,
      sourceOrder: index,
    };
  }).filter((entry: any) => entry.name);
}

function normalizeToolPathForMatch(value: any) {
  return String(value || '').replace(/\\/g, '/').trim();
}

function formatSkillMarkdownPathForMatch(skillPath: any) {
  const normalizedPath = normalizeToolPathForMatch(skillPath).replace(/\/+$/g, '');
  if (!normalizedPath) {
    return '';
  }
  return /\/skill\.md$/i.test(normalizedPath) ? normalizedPath : `${normalizedPath}/SKILL.md`;
}

function getReadToolPath(argumentsValue: any) {
  if (!argumentsValue || typeof argumentsValue !== 'object') {
    return '';
  }
  return normalizeToolPathForMatch(argumentsValue.path || argumentsValue.file || '');
}

function isSkillMarkdownReadPath(pathValue: any, skillId: any, skillPath?: any) {
  const normalizedPath = normalizeToolPathForMatch(pathValue).toLowerCase();
  const normalizedSkillId = String(skillId || '').trim().toLowerCase();
  const normalizedExpectedSkillPath = formatSkillMarkdownPathForMatch(skillPath).toLowerCase();

  if (!normalizedPath || (!normalizedSkillId && !normalizedExpectedSkillPath)) {
    return false;
  }

  if (normalizedExpectedSkillPath) {
    if (normalizedPath === normalizedExpectedSkillPath || normalizedPath.endsWith(normalizedExpectedSkillPath)) {
      return true;
    }
  }

  if (!normalizedSkillId) {
    return false;
  }

  return normalizedPath.includes(`/skills/${normalizedSkillId}/skill.md`)
    || normalizedPath.endsWith(`skills/${normalizedSkillId}/skill.md`);
}

function isTargetSkillReadToolCall(toolName: any, argumentsValue: any, skillId: any, skillPath?: any) {
  const normalizedToolName = String(toolName || '').trim();
  if (normalizedToolName === 'read') {
    return isSkillMarkdownReadPath(getReadToolPath(argumentsValue), skillId, skillPath);
  }

  return false;
}

function normalizeStoredCaseStatus(value: any) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'draft' || normalized === 'ready' || normalized === 'archived') {
    return normalized;
  }
  return '';
}

function resolveCaseStatus(row: any) {
  const explicit = normalizeStoredCaseStatus(row && row.case_status);
  return explicit || 'draft';
}

function buildEffectiveCaseStatusSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const caseStatusExpr = `LOWER(TRIM(COALESCE(${prefix}case_status, '')))`;
  return `CASE
    WHEN ${caseStatusExpr} = 'ready' THEN 'ready'
    WHEN ${caseStatusExpr} = 'archived' THEN 'archived'
    WHEN ${caseStatusExpr} = 'draft' THEN 'draft'
    ELSE 'draft'
  END`;
}

function buildEffectiveExecutionPassedSql(caseAlias = 'c', runAlias = 'r') {
  const casePrefix = caseAlias ? `${caseAlias}.` : '';
  const runPrefix = runAlias ? `${runAlias}.` : '';
  const loadingModeExpr = `LOWER(TRIM(COALESCE(${casePrefix}loading_mode, '')))`;
  const verdictExpr = `LOWER(TRIM(COALESCE(${runPrefix}verdict, '')))`;
  return `CASE
    WHEN ${loadingModeExpr} = 'full' AND ${verdictExpr} != '' THEN CASE WHEN ${verdictExpr} = 'pass' THEN 1 ELSE 0 END
    WHEN ${runPrefix}execution_passed = 1 THEN 1
    ELSE 0
  END`;
}

const SKILL_TEST_SUMMARY_AVERAGE_METRICS = [
  { key: 'avgToolAccuracy', sumColumn: 'sum_tool_accuracy', countColumn: 'tool_accuracy_count' },
  { key: 'avgRequiredStepCompletionRate', sumColumn: 'sum_required_step_completion_rate', countColumn: 'required_step_completion_rate_count' },
  { key: 'avgStepCompletionRate', sumColumn: 'sum_step_completion_rate', countColumn: 'step_completion_rate_count' },
  { key: 'avgGoalAchievement', sumColumn: 'sum_goal_achievement', countColumn: 'goal_achievement_count' },
  { key: 'avgToolCallSuccessRate', sumColumn: 'sum_tool_call_success_rate', countColumn: 'tool_call_success_rate_count' },
];

function resolveTestTypeForLoadingMode(loadingMode: any, testType?: any) {
  const normalizedLoadingMode = String(loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
  const normalizedTestType = String(testType || '').trim().toLowerCase();
  if (normalizedTestType === 'trigger' || normalizedTestType === 'execution') {
    return normalizedTestType;
  }
  return normalizedLoadingMode === 'full' ? 'execution' : 'trigger';
}

function mapCaseStatusToLegacyValidity(caseStatus: string) {
  if (caseStatus === 'ready') {
    return 'validated';
  }
  if (caseStatus === 'archived') {
    return 'archived';
  }
  return 'pending';
}

function parseCaseStatus(value: any, fallback = 'draft') {
  const normalized = String(value || fallback).trim().toLowerCase() || fallback;
  if (normalized === 'draft' || normalized === 'ready' || normalized === 'archived') {
    return normalized;
  }
  throw createHttpError(400, 'caseStatus must be one of: draft, ready, archived');
}

function buildDefaultFailureIfMissing(stepTitle: string) {
  const title = String(stepTitle || '').trim() || '该步骤';
  return `缺少“${title}”步骤，说明关键行为未完成。`;
}

function createLegacySummaryStep(stepId: string, text: string, required = false) {
  const summary = String(text || '').trim();
  return {
    id: stepId,
    title: required ? '满足整体目标' : '满足整体行为预期',
    expectedBehavior: summary,
    required,
    order: null,
    failureIfMissing: buildDefaultFailureIfMissing(required ? '满足整体目标' : '满足整体行为预期'),
    strongSignals: [],
  };
}

function normalizeStepSequenceReference(value: any) {
  if (typeof value === 'string') {
    return String(value || '').trim();
  }
  if (!isPlainObject(value)) {
    return '';
  }
  return String(value.stepId || value.id || value.name || value.tool || '').trim();
}

function normalizeSequenceEntryName(value: any) {
  if (typeof value === 'string') {
    return normalizeToolNameForMatch(value);
  }
  if (!isPlainObject(value)) {
    return '';
  }
  return normalizeToolNameForMatch(value.name || value.tool || value.id || '');
}

function normalizeJudgeConfidence(value: any) {
  if (value == null || value === '') {
    return null;
  }
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 && normalized <= 1 ? normalized : null;
}

function normalizeStrongSignalEntry(signal: any, stepId: string, stepIndex: number, signalIndex: number, issues: any[]) {
  const basePath = `expectedSteps[${stepIndex}].strongSignals[${signalIndex}]`;
  if (!isPlainObject(signal)) {
    issues.push(
      buildValidationIssue('signal_shape_invalid', 'error', basePath, 'strongSignals items must be objects')
    );
    return null;
  }

  const type = String(signal.type || '').trim().toLowerCase();
  if (!ALLOWED_SIGNAL_TYPES.has(type)) {
    issues.push(
      buildValidationIssue('signal_type_invalid', 'error', `${basePath}.type`, 'strongSignals type must be one of: tool, text, state')
    );
    return null;
  }

  const normalizedSignal: any = {
    id: String(signal.id || '').trim(),
    type,
  };

  if (!normalizedSignal.id) {
    const sourceName = type === 'tool'
      ? String(signal.toolName || signal.name || signal.tool || '').trim()
      : type === 'state'
        ? String(signal.key || '').trim()
        : String(signal.text || signal.pattern || '').trim();
    normalizedSignal.id = `sig-${stepId}-${slugifyValidationId(sourceName, `signal-${signalIndex + 1}`)}`;
  }

  const rawMatcher = signal.matcher ?? signal.argumentsMatcher;
  const matcher = normalizeMatcherName(rawMatcher);
  if (rawMatcher != null && String(rawMatcher || '').trim() && !matcher) {
    issues.push(
      buildValidationIssue(
        'unsupported_signal_matcher',
        'warning',
        `${basePath}.matcher`,
        'Unsupported signal matcher was downgraded to judge-only guidance'
      )
    );
  }

  if (type === 'tool') {
    const toolName = normalizeToolNameForMatch(signal.toolName || signal.name || signal.tool || '');
    if (!toolName) {
      issues.push(
        buildValidationIssue('signal_shape_invalid', 'error', basePath, 'Tool signals require toolName')
      );
      return null;
    }
    normalizedSignal.toolName = toolName;
    if (isPlainObject(signal.arguments)) {
      normalizedSignal.arguments = signal.arguments;
    }
    if (matcher) {
      normalizedSignal.matcher = matcher;
    }
    return normalizedSignal;
  }

  if (type === 'text') {
    const text = String(signal.text || '').trim();
    const pattern = String(signal.pattern || '').trim();
    if (!text && !pattern) {
      issues.push(
        buildValidationIssue('signal_shape_invalid', 'error', basePath, 'Text signals require text or pattern')
      );
      return null;
    }
    if (text) {
      normalizedSignal.text = text;
    }
    if (pattern) {
      normalizedSignal.pattern = pattern;
    }
    if (matcher) {
      normalizedSignal.matcher = matcher;
    }
    return normalizedSignal;
  }

  const key = String(signal.key || '').trim();
  if (!key || !hasOwn(signal, 'expected')) {
    issues.push(
      buildValidationIssue('signal_shape_invalid', 'error', basePath, 'State signals require key and expected')
    );
    return null;
  }
  normalizedSignal.key = key;
  normalizedSignal.expected = signal.expected;
  if (matcher) {
    normalizedSignal.matcher = matcher;
  }
  return normalizedSignal;
}

function normalizeExpectedStepsInput(rawValue: any, rawExpectedSequence: any, expectedTools: any[], options: { explicit?: boolean } = {}) {
  const issues: any[] = [];
  const explicit = options && options.explicit === true;
  if (rawValue == null || rawValue === '') {
    return { expectedSteps: [], sequenceStepIds: [], issues };
  }
  if (!Array.isArray(rawValue)) {
    issues.push(
      buildValidationIssue('expected_steps_required', 'error', 'expectedSteps', 'expectedSteps must be an array')
    );
    return { expectedSteps: [], sequenceStepIds: [], issues };
  }
  if ((explicit && rawValue.length === 0) || rawValue.length > FULL_CASE_MAX_EXPECTED_STEPS) {
    issues.push(
      buildValidationIssue(
        'expected_steps_required',
        'error',
        'expectedSteps',
        `expectedSteps must contain between 1 and ${FULL_CASE_MAX_EXPECTED_STEPS} steps`
      )
    );
  }

  const expectedSteps: any[] = [];
  const stepIdSet = new Set<string>();
  const signalIdSet = new Set<string>();
  const explicitOrderToStepId = new Map<number, string>();

  for (let index = 0; index < rawValue.length; index += 1) {
    const entry = rawValue[index];
    const basePath = `expectedSteps[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push(
        buildValidationIssue('step_title_or_behavior_missing', 'error', basePath, 'Each expected step must be an object')
      );
      continue;
    }

    const stepId = String(entry.id || '').trim() || `step-${index + 1}`;
    if (stepIdSet.has(stepId)) {
      issues.push(
        buildValidationIssue('step_id_duplicate', 'error', `${basePath}.id`, `Duplicate step id: ${stepId}`)
      );
      continue;
    }
    stepIdSet.add(stepId);

    const title = String(entry.title || '').trim();
    const expectedBehavior = String(entry.expectedBehavior || entry.expected_behavior || '').trim();
    if (!title || !expectedBehavior) {
      issues.push(
        buildValidationIssue(
          'step_title_or_behavior_missing',
          'error',
          basePath,
          'Each expected step requires non-empty title and expectedBehavior'
        )
      );
    }

    const step: any = {
      id: stepId,
      title,
      expectedBehavior,
      required: normalizeBooleanFlag(entry.required, true),
      order: null,
      failureIfMissing: String(entry.failureIfMissing || entry.failure_if_missing || '').trim(),
      strongSignals: [] as any[],
    };

    if (!step.failureIfMissing) {
      step.failureIfMissing = buildDefaultFailureIfMissing(title);
      issues.push(
        buildValidationIssue(
          'failure_if_missing_defaulted',
          'warning',
          `${basePath}.failureIfMissing`,
          'failureIfMissing was defaulted for this step'
        )
      );
    }

    if (hasOwn(entry, 'order') && entry.order != null && entry.order !== '') {
      const normalizedOrder = normalizePositiveInteger(entry.order);
      if (normalizedOrder == null) {
        issues.push(
          buildValidationIssue('sequence_config_invalid', 'error', `${basePath}.order`, 'Step order must be a positive integer')
        );
      } else if (explicitOrderToStepId.has(normalizedOrder)) {
        issues.push(
          buildValidationIssue(
            'sequence_config_invalid',
            'error',
            `${basePath}.order`,
            `Duplicate step order: ${normalizedOrder}`
          )
        );
      } else {
        explicitOrderToStepId.set(normalizedOrder, stepId);
        step.order = normalizedOrder;
      }
    }

    const rawSignals = hasOwn(entry, 'strongSignals') ? entry.strongSignals : [];
    if (rawSignals != null && !Array.isArray(rawSignals)) {
      issues.push(
        buildValidationIssue('signal_shape_invalid', 'error', `${basePath}.strongSignals`, 'strongSignals must be an array')
      );
    } else if (Array.isArray(rawSignals)) {
      if (rawSignals.length > STEP_SIGNAL_MAX_COUNT) {
        issues.push(
          buildValidationIssue(
            'signal_shape_invalid',
            'error',
            `${basePath}.strongSignals`,
            `Each step supports at most ${STEP_SIGNAL_MAX_COUNT} strongSignals`
          )
        );
      }
      const signalLimit = Math.min(rawSignals.length, STEP_SIGNAL_MAX_COUNT);
      for (let signalIndex = 0; signalIndex < signalLimit; signalIndex += 1) {
        const normalizedSignal = normalizeStrongSignalEntry(rawSignals[signalIndex], stepId, index, signalIndex, issues);
        if (!normalizedSignal) {
          continue;
        }
        if (signalIdSet.has(normalizedSignal.id)) {
          issues.push(
            buildValidationIssue(
              'signal_id_duplicate',
              'error',
              `${basePath}.strongSignals[${signalIndex}].id`,
              `Duplicate signal id: ${normalizedSignal.id}`
            )
          );
          continue;
        }
        signalIdSet.add(normalizedSignal.id);
        step.strongSignals.push(normalizedSignal);
      }
    }

    expectedSteps.push(step);
  }

  if (expectedSteps.length > 0 && !expectedSteps.some((step) => step.required)) {
    issues.push(
      buildValidationIssue('required_step_missing', 'error', 'expectedSteps', 'At least one expected step must be required')
    );
  }

  const expectedSequence = sanitizeExpectedSequence(Array.isArray(rawExpectedSequence) ? rawExpectedSequence : []);
  let sequenceStepIds = expectedSteps
    .filter((step) => step.order != null)
    .slice()
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0))
    .map((step) => step.id);

  if (expectedSequence.length > 0 && expectedSteps.length > 0) {
    const resolvedStepIds: string[] = [];
    const seenStepIds = new Set<string>();
    for (let index = 0; index < expectedSequence.length; index += 1) {
      const reference = normalizeStepSequenceReference(expectedSequence[index]);
      if (!reference || !stepIdSet.has(reference)) {
        issues.push(
          buildValidationIssue(
            'sequence_config_invalid',
            'error',
            `expectedSequence[${index}]`,
            `expectedSequence must reference existing step ids, received: ${reference || 'unknown'}`
          )
        );
        continue;
      }
      if (seenStepIds.has(reference)) {
        issues.push(
          buildValidationIssue(
            'sequence_config_invalid',
            'error',
            `expectedSequence[${index}]`,
            `expectedSequence contains duplicate step id: ${reference}`
          )
        );
        continue;
      }
      seenStepIds.add(reference);
      resolvedStepIds.push(reference);
    }

    if (resolvedStepIds.length > 0 && sequenceStepIds.length > 0 && JSON.stringify(sequenceStepIds) !== JSON.stringify(resolvedStepIds)) {
      issues.push(
        buildValidationIssue(
          'sequence_source_conflict',
          'warning',
          'expectedSequence',
          'expectedSequence overrides conflicting step.order values'
        )
      );
    }

    if (resolvedStepIds.length > 0) {
      sequenceStepIds = resolvedStepIds;
      const orderMap = new Map<string, number>();
      for (let index = 0; index < resolvedStepIds.length; index += 1) {
        orderMap.set(resolvedStepIds[index], index + 1);
      }
      for (const step of expectedSteps) {
        if (orderMap.has(step.id)) {
          step.order = orderMap.get(step.id);
        }
      }
    }
  }

  if (expectedTools.length > 0 && expectedSteps.length > 0) {
    issues.push(
      buildValidationIssue(
        'legacy_expected_tools_present',
        'warning',
        'expectedTools',
        'expectedTools remains a supporting legacy field when expectedSteps is present'
      )
    );
  }

  return { expectedSteps, sequenceStepIds, issues };
}

function normalizeThresholdConfig(rawValue: any, issues: any[], passThresholds: Record<string, number | null>, hardFailThresholds: Record<string, number | null>) {
  if (!isPlainObject(rawValue)) {
    return;
  }
  for (const key of THRESHOLD_DIMENSION_KEYS) {
    const hasPassThreshold = hasOwn(rawValue, 'passThresholds') && isPlainObject(rawValue.passThresholds) && hasOwn(rawValue.passThresholds, key);
    const hasHardFailThreshold = hasOwn(rawValue, 'hardFailThresholds') && isPlainObject(rawValue.hardFailThresholds) && hasOwn(rawValue.hardFailThresholds, key);
    const hasLegacyThreshold = hasOwn(rawValue, 'thresholds') && isPlainObject(rawValue.thresholds) && hasOwn(rawValue.thresholds, key);
    const passSource = hasPassThreshold
      ? rawValue.passThresholds[key]
      : hasLegacyThreshold
        ? rawValue.thresholds[key]
        : null;
    const hardFailSource = hasHardFailThreshold ? rawValue.hardFailThresholds[key] : null;

    if (passSource != null && passSource !== '') {
      const passValue = Number(passSource);
      if (!Number.isFinite(passValue) || passValue < 0 || passValue > 1) {
        issues.push(
          buildValidationIssue('threshold_range_invalid', 'error', `evaluationRubric.passThresholds.${key}`, `${key} passThreshold must be between 0 and 1`)
        );
      } else {
        passThresholds[key] = passValue;
      }
    }

    if (hardFailSource != null && hardFailSource !== '') {
      const hardFailValue = Number(hardFailSource);
      if (!Number.isFinite(hardFailValue) || hardFailValue < 0 || hardFailValue > 1) {
        issues.push(
          buildValidationIssue('threshold_range_invalid', 'error', `evaluationRubric.hardFailThresholds.${key}`, `${key} hardFailThreshold must be between 0 and 1`)
        );
      } else {
        hardFailThresholds[key] = hardFailValue;
      }
    }

    if (passThresholds[key] != null && hardFailThresholds[key] != null && Number(hardFailThresholds[key]) > Number(passThresholds[key])) {
      issues.push(
        buildValidationIssue(
          'threshold_range_invalid',
          'error',
          `evaluationRubric.hardFailThresholds.${key}`,
          `${key} hardFailThreshold must be less than or equal to passThreshold`
        )
      );
    }
  }
}

function normalizeEvaluationRubricForFullMode(rawValue: any, expectedSteps: any[], sequenceStepIds: string[]) {
  const issues: any[] = [];
  const rubric = sanitizeEvaluationRubric(rawValue);
  const stepIdSet = new Set(expectedSteps.map((step) => step.id));
  const signalKeySet = new Set<string>();
  for (const step of expectedSteps) {
    const signals = Array.isArray(step && step.strongSignals) ? step.strongSignals : [];
    for (const signal of signals) {
      signalKeySet.add(`${step.id}\u0000${String(signal && signal.id || '').trim()}`);
    }
  }

  const criticalConstraints: any[] = [];
  const seenConstraintIds = new Set<string>();
  const rawConstraints = Array.isArray(rubric.criticalConstraints) ? rubric.criticalConstraints : [];
  for (let index = 0; index < rawConstraints.length; index += 1) {
    const entry = rawConstraints[index];
    if (!isPlainObject(entry)) {
      continue;
    }
    const id = String(entry.id || '').trim() || `constraint-${index + 1}`;
    if (seenConstraintIds.has(id)) {
      issues.push(
        buildValidationIssue('evaluation_rubric_invalid', 'error', `evaluationRubric.criticalConstraints[${index}].id`, `Duplicate constraint id: ${id}`)
      );
      continue;
    }
    seenConstraintIds.add(id);
    const appliesToStepIdsSource = Array.isArray(entry.appliesToStepIds) ? entry.appliesToStepIds : [];
    const appliesToStepIds = appliesToStepIdsSource
      .map((stepId: any) => String(stepId || '').trim())
      .filter(Boolean);
    const missingTarget = appliesToStepIds.find((stepId: string) => !stepIdSet.has(stepId));
    if (missingTarget) {
      issues.push(
        buildValidationIssue(
          'constraint_target_missing',
          'error',
          `evaluationRubric.criticalConstraints[${index}].appliesToStepIds`,
          `criticalConstraints references unknown step id: ${missingTarget}`
        )
      );
    }
    criticalConstraints.push({
      id,
      description: String(entry.description || '').trim(),
      failureReason: String(entry.failureReason || entry.failure_reason || '').trim(),
      appliesToStepIds,
    });
  }

  const criticalDimensions = Array.isArray(rubric.criticalDimensions)
    ? rubric.criticalDimensions
      .map((entry: any) => String(entry || '').trim())
      .filter((entry: string) => ALLOWED_CRITICAL_DIMENSIONS.has(entry))
    : [];
  if (criticalDimensions.includes('sequenceAdherence') && sequenceStepIds.length === 0) {
    issues.push(
      buildValidationIssue(
        'critical_dimension_requires_sequence',
        'error',
        'evaluationRubric.criticalDimensions',
        'sequenceAdherence cannot be critical without a normalized sequence constraint'
      )
    );
  }

  const passThresholds: Record<string, number | null> = {};
  const hardFailThresholds: Record<string, number | null> = {};
  normalizeThresholdConfig(rubric, issues, passThresholds, hardFailThresholds);

  const supportingSignalOverrides: any[] = [];
  const seenOverrideKeys = new Set<string>();
  const rawOverrides = Array.isArray(rubric.supportingSignalOverrides) ? rubric.supportingSignalOverrides : [];
  for (let index = 0; index < rawOverrides.length; index += 1) {
    const entry = rawOverrides[index];
    if (!isPlainObject(entry)) {
      continue;
    }
    const stepId = String(entry.stepId || '').trim();
    const signalId = String(entry.signalId || '').trim();
    const severity = String(entry.severity || 'critical').trim().toLowerCase() || 'critical';
    const signalKey = `${stepId}\u0000${signalId}`;
    if (!stepId || !signalId || !signalKeySet.has(signalKey)) {
      issues.push(
        buildValidationIssue(
          'override_target_missing',
          'error',
          `evaluationRubric.supportingSignalOverrides[${index}]`,
          'supportingSignalOverrides must reference an existing stepId + signalId pair'
        )
      );
      continue;
    }
    if (severity !== 'critical') {
      issues.push(
        buildValidationIssue(
          'evaluation_rubric_invalid',
          'error',
          `evaluationRubric.supportingSignalOverrides[${index}].severity`,
          'supportingSignalOverrides severity must be "critical"'
        )
      );
      continue;
    }
    if (seenOverrideKeys.has(signalKey)) {
      issues.push(
        buildValidationIssue(
          'override_target_missing',
          'error',
          `evaluationRubric.supportingSignalOverrides[${index}]`,
          'Duplicate supportingSignalOverride target'
        )
      );
      continue;
    }
    seenOverrideKeys.add(signalKey);
    supportingSignalOverrides.push({
      stepId,
      signalId,
      severity: 'critical',
      failureReason: String(entry.failureReason || entry.failure_reason || '').trim(),
    });
  }

  return {
    evaluationRubric: {
      criticalConstraints,
      criticalDimensions,
      passThresholds,
      hardFailThresholds,
      supportingSignalOverrides,
      thresholds: { ...passThresholds },
    },
    issues,
  };
}

function buildLegacyExpectedStepFromTool(toolSpec: any, index: number) {
  const normalizedTool = typeof toolSpec === 'string'
    ? { name: String(toolSpec || '').trim() }
    : sanitizeExpectedToolSpecEntry(toolSpec);
  const toolName = normalizeToolNameForMatch(normalizedTool && normalizedTool.name || '');
  if (!normalizedTool || !toolName) {
    return null;
  }

  const stepId = `legacy-step-${index + 1}`;
  const title = `调用 ${toolName}`;
  const hints: string[] = [];
  if (Array.isArray(normalizedTool.requiredParams) && normalizedTool.requiredParams.length > 0) {
    hints.push(`包含参数 ${normalizedTool.requiredParams.join(', ')}`);
  }
  if (isPlainObject(normalizedTool.arguments)) {
    hints.push(`参数模式 ${JSON.stringify(normalizedTool.arguments)}`);
  }
  const expectedBehavior = hints.length > 0
    ? `按预期调用 ${toolName}，并满足：${hints.join('；')}`
    : `按预期调用 ${toolName} 完成步骤。`;
  const strongSignal: any = {
    id: `sig-${stepId}-${slugifyValidationId(toolName, 'tool')}`,
    type: 'tool',
    toolName,
  };
  if (isPlainObject(normalizedTool.arguments)) {
    strongSignal.arguments = normalizedTool.arguments;
  }

  return {
    id: stepId,
    title,
    expectedBehavior,
    required: true,
    order: normalizePositiveInteger((normalizedTool as any).order),
    failureIfMissing: buildDefaultFailureIfMissing(title),
    strongSignals: [strongSignal],
  };
}

function deriveLegacyExpectedSteps(testCase: any) {
  const issues: any[] = [];
  const expectedTools = sanitizeExpectedToolSpecs(Array.isArray(testCase && testCase.expectedTools) ? testCase.expectedTools : []);
  const expectedSequence = sanitizeExpectedSequence(Array.isArray(testCase && testCase.expectedSequence) ? testCase.expectedSequence : []);
  const expectedBehavior = String(testCase && testCase.expectedBehavior || '').trim();
  const note = String(testCase && testCase.note || '').trim();
  const expectedGoal = String(testCase && testCase.expectedGoal || '').trim() || expectedBehavior || note;

  const derivedSteps = expectedTools
    .map((entry, index) => buildLegacyExpectedStepFromTool(entry, index))
    .filter(Boolean) as any[];

  if (derivedSteps.length === 0 && expectedBehavior) {
    derivedSteps.push(createLegacySummaryStep('legacy-step-summary', expectedBehavior, true));
  } else if (derivedSteps.length > 0 && expectedBehavior) {
    derivedSteps.push(createLegacySummaryStep('legacy-step-behavior', expectedBehavior, false));
  }

  if (expectedSequence.length > 0 && derivedSteps.length > 0) {
    const availableSteps = derivedSteps.map((step) => ({
      step,
      toolName: String(step && step.strongSignals && step.strongSignals[0] && step.strongSignals[0].toolName || '').trim(),
    }));
    const usedStepIds = new Set<string>();
    let nextOrder = 1;
    for (let index = 0; index < expectedSequence.length; index += 1) {
      const name = normalizeSequenceEntryName(expectedSequence[index]);
      if (!name) {
        issues.push(
          buildValidationIssue('legacy_mapping_incomplete', 'warning', `expectedSequence[${index}]`, 'Legacy sequence entry could not be mapped')
        );
        continue;
      }
      const match = availableSteps.find((candidate) => candidate.toolName === name && !usedStepIds.has(candidate.step.id));
      if (!match) {
        issues.push(
          buildValidationIssue(
            'legacy_mapping_incomplete',
            'warning',
            `expectedSequence[${index}]`,
            `Legacy sequence entry could not be matched to a derived step: ${name}`
          )
        );
        continue;
      }
      match.step.order = nextOrder;
      nextOrder += 1;
      usedStepIds.add(match.step.id);
    }
  }

  if (derivedSteps.length > 0) {
    issues.unshift(
      buildValidationIssue(
        'legacy_steps_derived',
        'warning',
        'expectedSteps',
        'expectedSteps was derived from legacy expectedTools/expectedSequence fields'
      )
    );
  }

  return {
    expectedGoal,
    expectedSteps: derivedSteps,
    issues,
  };
}

function buildCriticalSequenceEvidencePreflightIssues(testCase: any) {
  if (!testCase || String(testCase.loadingMode || '').trim().toLowerCase() !== 'full') {
    return [];
  }

  const rubric = sanitizeEvaluationRubric(testCase && testCase.evaluationRubric);
  const criticalDimensions = Array.isArray(rubric.criticalDimensions)
    ? rubric.criticalDimensions.map((entry: any) => String(entry || '').trim())
    : [];
  if (!criticalDimensions.includes('sequenceAdherence')) {
    return [];
  }

  const expectedTools = Array.isArray(testCase && testCase.expectedTools) ? testCase.expectedTools : [];
  const expectedSteps = Array.isArray(testCase && testCase.expectedSteps) ? testCase.expectedSteps : [];
  const explicitSequence = sanitizeExpectedSequence(testCase && testCase.expectedSequence);
  const orderToToolName = new Map<number, string>();
  const stepIdSet = new Set<string>();
  const stepIdToToolName = new Map<string, string>();
  const unresolvedStepIds = new Set<string>();

  for (const entry of expectedTools) {
    const toolName = String(entry && entry.name || '').trim();
    const order = parseExpectedToolOrder(entry);
    if (!toolName || order == null || orderToToolName.has(order)) {
      continue;
    }
    orderToToolName.set(order, toolName);
  }

  for (const step of expectedSteps) {
    const stepId = String(step && step.id || '').trim();
    if (!stepId) {
      continue;
    }
    stepIdSet.add(stepId);

    const strongSignals = Array.isArray(step && step.strongSignals) ? step.strongSignals : [];
    let mappedToolName = '';
    for (const signal of strongSignals) {
      if (!isPlainObject(signal) || String(signal.type || '').trim() !== 'tool') {
        continue;
      }
      const toolName = String(signal.toolName || signal.tool || signal.name || '').trim();
      if (toolName) {
        mappedToolName = toolName;
        break;
      }
    }

    if (!mappedToolName) {
      const order = normalizePositiveInteger(step && step.order);
      if (order != null && orderToToolName.has(order)) {
        mappedToolName = String(orderToToolName.get(order) || '').trim();
      }
    }

    if (mappedToolName) {
      stepIdToToolName.set(stepId, mappedToolName);
    }
  }

  const sequenceSpecs = explicitSequence.length > 0
    ? explicitSequence
      .map((entry: any, index: number) => {
        const reference = normalizeStepSequenceReference(entry);
        const referencesKnownStep = Boolean(reference && stepIdSet.has(reference));
        let name = '';
        if (referencesKnownStep) {
          name = String(stepIdToToolName.get(reference) || '').trim();
          if (!name) {
            unresolvedStepIds.add(reference);
            return null;
          }
        } else {
          name = normalizeSequenceEntryName(entry);
        }
        if (!name) {
          return null;
        }
        const order = parseExpectedToolOrder(entry);
        return {
          name,
          order: order != null ? order : index + 1,
          sourceOrder: index,
        };
      })
      .filter(Boolean)
    : expectedTools
      .filter((entry: any) => entry && entry.hasSequenceExpectation)
      .map((entry: any) => ({
        name: entry.name,
        order: entry.order != null ? entry.order : null,
        sourceOrder: entry.sourceOrder != null ? entry.sourceOrder : null,
      }))
      .filter((entry: any) => entry && entry.name);

  const normalizedUnresolved = [...unresolvedStepIds];
  if (normalizedUnresolved.length > 0) {
    return [
      buildValidationIssue(
        'critical_sequence_evidence_unavailable',
        'needs-review',
        'evaluationRubric.criticalDimensions',
        `sequenceAdherence is critical, but no verifiable sequence evidence mapping exists for steps: ${normalizedUnresolved.join(', ')}`
      ),
    ];
  }
  if (sequenceSpecs.length === 0) {
    return [
      buildValidationIssue(
        'critical_sequence_evidence_unavailable',
        'needs-review',
        'evaluationRubric.criticalDimensions',
        'sequenceAdherence is critical, but no verifiable sequence evidence could be constructed'
      ),
    ];
  }
  return [];
}

export type SkillTestSchemaStatus = 'valid' | 'warning' | 'invalid';

export type SkillTestValidationEnvelope = {
  normalizedCase: any | null;
  issues: any[];
  derivedFromLegacy: boolean;
  caseSchemaStatus: SkillTestSchemaStatus;
};

export function buildValidationEnvelope(params: {
  normalizedCase: any | null;
  issues?: any[];
  issueGroups?: any[];
  derivedFromLegacy?: boolean;
}): SkillTestValidationEnvelope {
  const groups: any[] = [];
  if (Array.isArray(params.issues)) {
    groups.push(params.issues);
  }
  if (Array.isArray(params.issueGroups)) {
    for (const group of params.issueGroups) {
      if (Array.isArray(group)) {
        groups.push(group);
      }
    }
  }

  const issues = mergeValidationIssues(...groups);
  const normalizedCase = params.normalizedCase;
  const derivedFromLegacy = Boolean(params.derivedFromLegacy);

  const caseSchemaStatus: SkillTestSchemaStatus = !normalizedCase || hasBlockingValidationIssue(issues)
    ? 'invalid'
    : issues.length > 0
      ? 'warning'
      : 'valid';

  return {
    normalizedCase,
    issues,
    derivedFromLegacy,
    caseSchemaStatus,
  };
}

export function validateAndNormalizeCaseInput(input: any, options: { requireSkillId?: boolean; existing?: any; allowExpectedGoalFallback?: boolean } = {}) {
  const existing = options.existing || null;
  const allowExpectedGoalFallback = Boolean(options.allowExpectedGoalFallback);
  const skillId = String(input.skillId || existing && existing.skillId || '').trim();
  const loadingMode = String(input.loadingMode || input.loading_mode || existing && existing.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
  const testType = resolveTestTypeForLoadingMode(loadingMode, input.testType || input.test_type || existing && existing.testType);
  const issues: any[] = [];

  const explicitUserPrompt = hasOwn(input, 'userPrompt') || hasOwn(input, 'user_prompt');
  const explicitTriggerPrompt = hasOwn(input, 'triggerPrompt') || hasOwn(input, 'trigger_prompt');
  const rawUserPrompt = hasOwn(input, 'userPrompt') ? input.userPrompt : input.user_prompt;
  const rawTriggerPrompt = hasOwn(input, 'triggerPrompt') ? input.triggerPrompt : input.trigger_prompt;
  const normalizedUserPrompt = explicitUserPrompt ? normalizePromptText(rawUserPrompt) : '';
  const normalizedTriggerPrompt = explicitTriggerPrompt ? normalizePromptText(rawTriggerPrompt) : '';

  if (explicitUserPrompt && explicitTriggerPrompt && normalizedUserPrompt !== normalizedTriggerPrompt) {
    throw createValidationHttpError(
      buildValidationIssue(
        'prompt_alias_conflict',
        'error',
        'userPrompt',
        'userPrompt and triggerPrompt must match after normalization'
      )
    );
  }

  const userPrompt = normalizePromptText(
    explicitUserPrompt
      ? rawUserPrompt
      : explicitTriggerPrompt
        ? rawTriggerPrompt
        : getCanonicalCasePrompt(existing)
  );

  const hasExpectedToolsInput = hasOwn(input, 'expectedTools') || hasOwn(input, 'expected_tools');
  const rawExpectedToolsSource = hasExpectedToolsInput
    ? (hasOwn(input, 'expectedTools') ? input.expectedTools : input.expected_tools)
    : existing && Array.isArray(existing.expectedTools)
      ? existing.expectedTools
      : [];
  if (hasExpectedToolsInput && rawExpectedToolsSource != null && !Array.isArray(rawExpectedToolsSource)) {
    throw createValidationHttpError(
      buildValidationIssue('expected_tools_invalid', 'error', 'expectedTools', 'expectedTools must be an array')
    );
  }
  const expectedTools = sanitizeExpectedToolSpecs(Array.isArray(rawExpectedToolsSource) ? rawExpectedToolsSource : []);

  const hasExpectedSequenceInput = hasOwn(input, 'expectedSequence') || hasOwn(input, 'expected_sequence');
  const rawExpectedSequenceSource = hasExpectedSequenceInput
    ? (hasOwn(input, 'expectedSequence') ? input.expectedSequence : input.expected_sequence)
    : existing && Array.isArray(existing.expectedSequence)
      ? existing.expectedSequence
      : [];
  if (hasExpectedSequenceInput && rawExpectedSequenceSource != null && !Array.isArray(rawExpectedSequenceSource)) {
    throw createValidationHttpError(
      buildValidationIssue('expected_sequence_invalid', 'error', 'expectedSequence', 'expectedSequence must be an array')
    );
  }
  const expectedSequence = sanitizeExpectedSequence(Array.isArray(rawExpectedSequenceSource) ? rawExpectedSequenceSource : []);

  const hasExpectedStepsInput = hasOwn(input, 'expectedSteps') || hasOwn(input, 'expected_steps');
  const rawExpectedStepsSource = hasExpectedStepsInput
    ? (hasOwn(input, 'expectedSteps') ? input.expectedSteps : input.expected_steps)
    : existing && Array.isArray(existing.expectedSteps)
      ? existing.expectedSteps
      : [];
  if (hasExpectedStepsInput && rawExpectedStepsSource != null && !Array.isArray(rawExpectedStepsSource)) {
    throw createValidationHttpError(
      buildValidationIssue('expected_steps_required', 'error', 'expectedSteps', 'expectedSteps must be an array')
    );
  }

  const expectedBehavior = String(input.expectedBehavior || input.expected_behavior || existing && existing.expectedBehavior || '').trim();
  let expectedGoal = String(input.expectedGoal || input.expected_goal || existing && existing.expectedGoal || '').trim();
  const generationProvider = String(input.generationProvider || input.generation_provider || existing && existing.generationProvider || '').trim();
  const generationModel = String(input.generationModel || input.generation_model || existing && existing.generationModel || '').trim();
  const generationCreatedAt = String(input.generationCreatedAt || input.generation_created_at || existing && existing.generationCreatedAt || '').trim();

  const hasEvaluationRubricInput = hasOwn(input, 'evaluationRubric') || hasOwn(input, 'evaluation_rubric');
  const evaluationRubricSource = hasEvaluationRubricInput
    ? (hasOwn(input, 'evaluationRubric') ? input.evaluationRubric : input.evaluation_rubric)
    : existing && existing.evaluationRubric;
  if (hasEvaluationRubricInput && evaluationRubricSource != null && !isPlainObject(evaluationRubricSource)) {
    throw createValidationHttpError(
      buildValidationIssue('evaluation_rubric_invalid', 'error', 'evaluationRubric', 'evaluationRubric must be an object')
    );
  }

  const expectedStepsResult = normalizeExpectedStepsInput(
    Array.isArray(rawExpectedStepsSource) ? rawExpectedStepsSource : [],
    rawExpectedSequenceSource,
    expectedTools,
    { explicit: hasExpectedStepsInput }
  );
  issues.push(...expectedStepsResult.issues);

  if (!expectedGoal && loadingMode === 'full' && allowExpectedGoalFallback) {
    expectedGoal = expectedBehavior || String(existing && existing.note || input.note || '').trim();
  }
  if (!expectedGoal && loadingMode === 'full') {
    issues.push(
      buildValidationIssue('expected_goal_required', 'error', 'expectedGoal', 'expectedGoal is required for full mode')
    );
  }

  const evaluationRubricResult = loadingMode === 'full' && expectedStepsResult.expectedSteps.length > 0
    ? normalizeEvaluationRubricForFullMode(evaluationRubricSource, expectedStepsResult.expectedSteps, expectedStepsResult.sequenceStepIds)
    : { evaluationRubric: sanitizeEvaluationRubric(evaluationRubricSource), issues: [] };
  issues.push(...evaluationRubricResult.issues);

  const note = String(input.note || existing && existing.note || '').trim();
  const caseStatus = parseCaseStatus(input.caseStatus || input.case_status || existing && existing.caseStatus || 'draft');

  if (options.requireSkillId !== false && !skillId) {
    throw createHttpError(400, 'skillId is required');
  }

  const validLoadingModes = new Set(['dynamic', 'full']);
  if (!validLoadingModes.has(loadingMode)) {
    throw createHttpError(400, `loadingMode must be one of: ${[...validLoadingModes].join(', ')}`);
  }

  if (!userPrompt) {
    throw createValidationHttpError(
      buildValidationIssue('user_prompt_required', 'error', 'userPrompt', 'userPrompt is required')
    );
  }
  if (userPrompt.length < 5) {
    throw createValidationHttpError(
      buildValidationIssue('user_prompt_too_short', 'error', 'userPrompt', 'userPrompt is too short (minimum 5 characters)')
    );
  }
  if (userPrompt.length > 2000) {
    throw createValidationHttpError(
      buildValidationIssue('user_prompt_too_long', 'error', 'userPrompt', 'userPrompt is too long (maximum 2000 characters)')
    );
  }
  if (Array.isArray(rawExpectedToolsSource) && rawExpectedToolsSource.length > 0 && expectedTools.length !== rawExpectedToolsSource.length) {
    throw createValidationHttpError(
      buildValidationIssue(
        'expected_tools_invalid',
        'error',
        'expectedTools',
        'expectedTools items must be tool names or { name, arguments?, requiredParams?, order? } objects'
      )
    );
  }
  if (Array.isArray(rawExpectedSequenceSource) && rawExpectedSequenceSource.length > 0 && expectedSequence.length !== rawExpectedSequenceSource.length) {
    throw createValidationHttpError(
      buildValidationIssue(
        'expected_sequence_invalid',
        'error',
        'expectedSequence',
        'expectedSequence items must be strings or { name, arguments?, requiredParams?, order? } objects'
      )
    );
  }
  if (issues.some((issue) => issue && issue.severity === 'error')) {
    throw createValidationHttpError(issues);
  }

  return {
    skillId,
    loadingMode,
    testType,
    userPrompt,
    triggerPrompt: userPrompt,
    expectedTools,
    expectedSteps: expectedStepsResult.expectedSteps,
    expectedBehavior,
    expectedGoal,
    expectedSequence,
    sequenceStepIds: expectedStepsResult.sequenceStepIds,
    evaluationRubric: evaluationRubricResult.evaluationRubric,
    caseStatus,
    validityStatus: mapCaseStatusToLegacyValidity(caseStatus),
    generationProvider,
    generationModel,
    generationCreatedAt,
    note,
    issues: mergeValidationIssues(issues),
  };
}

export function normalizeCaseForRun(storedCase: any, options: { existing?: any; storedIssues?: any[] } = {}): SkillTestValidationEnvelope {
  const existing = options.existing || null;
  if (hasBlockingValidationIssue(options.storedIssues || [])) {
    return buildValidationEnvelope({
      normalizedCase: null,
      issueGroups: [options.storedIssues],
      derivedFromLegacy: false,
    });
  }
  try {
    const preflightInput = isPlainObject(storedCase)
      && Array.isArray(storedCase.expectedSteps)
      && storedCase.expectedSteps.length === 0
      ? (() => {
          const copied = { ...storedCase };
          delete copied.expectedSteps;
          delete copied.expected_steps;
          return copied;
        })()
      : storedCase;
    const normalizedCase = validateAndNormalizeCaseInput(preflightInput, {
      requireSkillId: true,
      existing,
      allowExpectedGoalFallback: true,
    });

    const preflightSequenceIssues = normalizedCase
      ? buildCriticalSequenceEvidencePreflightIssues(normalizedCase)
      : [];

    return buildValidationEnvelope({
      normalizedCase,
      issueGroups: [options.storedIssues, normalizedCase && normalizedCase.issues, preflightSequenceIssues],
      derivedFromLegacy: false,
    });
  } catch (error: any) {
    const errorIssues = error && Array.isArray(error.issues) ? error.issues : [];
    return buildValidationEnvelope({
      normalizedCase: null,
      issueGroups: [options.storedIssues, errorIssues],
      derivedFromLegacy: false,
    });
  }
}

export function validateJudgeOutput(judgeJson: any, normalizedCase: any = null, timelineIds: any = null) {
  const issues: any[] = [];
  if (!judgeJson || typeof judgeJson !== 'object') {
    return { judge: null, issues };
  }

  const status = String((judgeJson as any).status || '').trim();
  const normalizedStatus = status.toLowerCase();
  const allowedStatuses = new Set(['succeeded', 'parse_failed', 'runtime_failed', 'skipped']);

  if (!allowedStatuses.has(normalizedStatus)) {
    issues.push(
      buildValidationIssue(
        'judge_parse_failed',
        'error',
        'evaluation.aiJudge',
        `Execution judge status is invalid: ${status || 'unknown'}`
      )
    );
    return {
      judge: { ...(judgeJson as any), status: 'parse_failed' },
      issues: mergeValidationIssues(issues),
    };
  }

  const normalizedTimelineIds = timelineIds instanceof Set
    ? timelineIds
    : new Set(
      Array.isArray(timelineIds)
        ? timelineIds.map((entry: any) => String(entry || '').trim()).filter(Boolean)
        : []
    );
  const expectedSteps = Array.isArray(normalizedCase && normalizedCase.expectedSteps)
    ? normalizedCase.expectedSteps
    : [];
  const criticalConstraints = Array.isArray(normalizedCase && normalizedCase.evaluationRubric && normalizedCase.evaluationRubric.criticalConstraints)
    ? normalizedCase.evaluationRubric.criticalConstraints
    : [];
  const knownStepIds = new Set(expectedSteps.map((step: any) => String(step && step.id || '').trim()).filter(Boolean));
  const knownSignalIds = new Set<string>();
  for (const step of expectedSteps) {
    const strongSignals = Array.isArray(step && step.strongSignals) ? step.strongSignals : [];
    for (const signal of strongSignals) {
      const signalId = String(signal && signal.id || '').trim();
      if (signalId) {
        knownSignalIds.add(signalId);
      }
    }
  }

  if (normalizedStatus === 'parse_failed') {
    issues.push(
      buildValidationIssue(
        'judge_parse_failed',
        'error',
        'evaluation.aiJudge',
        String((judgeJson as any).errorMessage || 'Execution judge response could not be parsed')
      )
    );
    return {
      judge: { ...(judgeJson as any), status: 'parse_failed' },
      issues: mergeValidationIssues(issues),
    };
  }

  if (normalizedStatus === 'runtime_failed') {
    issues.push(
      buildValidationIssue(
        'judge_runtime_failed',
        'needs-review',
        'evaluation.aiJudge',
        String((judgeJson as any).errorMessage || 'Execution judge failed at runtime')
      )
    );
    return {
      judge: { ...(judgeJson as any), status: 'runtime_failed' },
      issues: mergeValidationIssues(issues),
    };
  }

  if (normalizedStatus === 'skipped') {
    return {
      judge: { ...(judgeJson as any), status: 'skipped' },
      issues: mergeValidationIssues(issues),
    };
  }

  const verdictSuggestion = String((judgeJson as any).verdictSuggestion || '').trim().toLowerCase();
  if (verdictSuggestion && verdictSuggestion !== 'pass' && verdictSuggestion !== 'borderline' && verdictSuggestion !== 'fail') {
    issues.push(
      buildValidationIssue(
        'judge_verdict_invalid',
        'error',
        'evaluation.aiJudge.verdictSuggestion',
        'verdictSuggestion must be one of: pass, borderline, fail'
      )
    );
    issues.push(
      buildValidationIssue(
        'judge_parse_failed',
        'error',
        'evaluation.aiJudge',
        'Execution judge response has invalid verdictSuggestion'
      )
    );
    return {
      judge: { ...(judgeJson as any), status: 'parse_failed' },
      issues: mergeValidationIssues(issues),
    };
  }

  const rawSteps = Array.isArray((judgeJson as any).steps) ? (judgeJson as any).steps : [];
  const normalizedSteps: any[] = [];
  const seenStepIds = new Set<string>();
  for (let index = 0; index < rawSteps.length; index += 1) {
    const entry = rawSteps[index];
    if (!isPlainObject(entry)) {
      continue;
    }
    const stepId = String(entry.stepId || '').trim();
    if (!stepId || !knownStepIds.has(stepId)) {
      issues.push(
        buildValidationIssue(
          'judge_unknown_step_id',
          'warning',
          `evaluation.aiJudge.steps[${index}].stepId`,
          `Judge referenced unknown step id: ${stepId || 'unknown'}`
        )
      );
      continue;
    }
    if (seenStepIds.has(stepId)) {
      issues.push(
        buildValidationIssue(
          'judge_parse_failed',
          'error',
          'evaluation.aiJudge.steps',
          `Judge returned duplicate stepId: ${stepId}`
        )
      );
      return {
        judge: { ...(judgeJson as any), status: 'parse_failed' },
        issues: mergeValidationIssues(issues),
      };
    }
    seenStepIds.add(stepId);

    const normalizedConfidence = entry.confidence == null || entry.confidence === ''
      ? 0
      : normalizeJudgeConfidence(entry.confidence);
    if (entry.confidence != null && entry.confidence !== '' && normalizedConfidence == null) {
      issues.push(
        buildValidationIssue(
          'judge_parse_failed',
          'error',
          `evaluation.aiJudge.steps[${index}].confidence`,
          `Judge returned invalid confidence for step ${stepId}`
        )
      );
      return {
        judge: { ...(judgeJson as any), status: 'parse_failed' },
        issues: mergeValidationIssues(issues),
      };
    }

    const evidenceIds = Array.isArray(entry.evidenceIds)
      ? entry.evidenceIds
        .map((value: any) => String(value || '').trim())
        .filter(Boolean)
        .filter((evidenceId: string) => {
          if (normalizedTimelineIds.size > 0 && !normalizedTimelineIds.has(evidenceId)) {
            issues.push(
              buildValidationIssue(
                'judge_unknown_evidence_id',
                'warning',
                `evaluation.aiJudge.steps[${index}].evidenceIds`,
                `Judge referenced unknown evidence id: ${evidenceId}`
              )
            );
            return false;
          }
          return true;
        })
      : [];
    const matchedSignalIds = Array.isArray(entry.matchedSignalIds)
      ? entry.matchedSignalIds
        .map((value: any) => String(value || '').trim())
        .filter(Boolean)
        .filter((signalId: string) => {
          if (!knownSignalIds.has(signalId)) {
            issues.push(
              buildValidationIssue(
                'judge_unknown_signal_id',
                'warning',
                `evaluation.aiJudge.steps[${index}].matchedSignalIds`,
                `Judge referenced unknown signal id: ${signalId}`
              )
            );
            return false;
          }
          return true;
        })
      : [];

    normalizedSteps.push({
      stepId,
      completed: normalizeBooleanFlag(entry.completed, false),
      confidence: normalizedConfidence ?? 0,
      evidenceIds,
      matchedSignalIds,
      reason: String(entry.reason || '').trim(),
    });
  }

  for (const step of expectedSteps) {
    if (!step || !step.id || seenStepIds.has(step.id)) {
      continue;
    }
    issues.push(
      buildValidationIssue(
        'judge_step_missing',
        'needs-review',
        `evaluation.aiJudge.steps.${step.id}`,
        `Judge did not return a result for step ${step.id}`
      )
    );
    normalizedSteps.push({
      stepId: step.id,
      completed: false,
      confidence: 0,
      evidenceIds: [],
      matchedSignalIds: [],
      reason: 'Judge did not provide a step result.',
    });
  }

  const rawConstraintChecks = Array.isArray((judgeJson as any).constraintChecks) ? (judgeJson as any).constraintChecks : [];
  const normalizedConstraintChecks: any[] = [];
  const knownConstraintIds = new Set(criticalConstraints.map((entry: any) => String(entry && entry.id || '').trim()).filter(Boolean));
  const seenConstraintIds = new Set<string>();
  for (let index = 0; index < rawConstraintChecks.length; index += 1) {
    const entry = rawConstraintChecks[index];
    if (!isPlainObject(entry)) {
      continue;
    }
    const constraintId = String(entry.constraintId || '').trim();
    if (!constraintId || !knownConstraintIds.has(constraintId)) {
      issues.push(
        buildValidationIssue(
          'judge_unknown_constraint_id',
          'warning',
          `evaluation.aiJudge.constraintChecks[${index}].constraintId`,
          `Judge referenced unknown constraint id: ${constraintId || 'unknown'}`
        )
      );
      continue;
    }
    if (seenConstraintIds.has(constraintId)) {
      issues.push(
        buildValidationIssue(
          'judge_parse_failed',
          'error',
          'evaluation.aiJudge.constraintChecks',
          `Judge returned duplicate constraintId: ${constraintId}`
        )
      );
      return {
        judge: { ...(judgeJson as any), status: 'parse_failed' },
        issues: mergeValidationIssues(issues),
      };
    }
    seenConstraintIds.add(constraintId);

    const evidenceIds = Array.isArray(entry.evidenceIds)
      ? entry.evidenceIds
        .map((value: any) => String(value || '').trim())
        .filter(Boolean)
        .filter((evidenceId: string) => {
          if (normalizedTimelineIds.size > 0 && !normalizedTimelineIds.has(evidenceId)) {
            issues.push(
              buildValidationIssue(
                'judge_unknown_evidence_id',
                'warning',
                `evaluation.aiJudge.constraintChecks[${index}].evidenceIds`,
                `Judge referenced unknown evidence id: ${evidenceId}`
              )
            );
            return false;
          }
          return true;
        })
      : [];

    normalizedConstraintChecks.push({
      constraintId,
      satisfied: entry.satisfied === true ? true : entry.satisfied === false ? false : null,
      evidenceIds,
      reason: String(entry.reason || '').trim(),
    });
  }

  for (const constraint of criticalConstraints) {
    if (!constraint || !constraint.id || seenConstraintIds.has(constraint.id)) {
      continue;
    }
    issues.push(
      buildValidationIssue(
        'judge_constraint_missing',
        'needs-review',
        `evaluation.aiJudge.constraintChecks.${constraint.id}`,
        `Judge did not return a result for constraint ${constraint.id}`
      )
    );
    normalizedConstraintChecks.push({
      constraintId: constraint.id,
      satisfied: null,
      evidenceIds: [],
      reason: 'Judge did not provide a constraint result.',
    });
  }

  return {
    judge: {
      ...(judgeJson as any),
      status: 'succeeded',
      verdictSuggestion: verdictSuggestion || '',
      steps: normalizedSteps,
      constraintChecks: normalizedConstraintChecks,
    },
    issues: mergeValidationIssues(issues),
  };
}

function sanitizeExpectedSequence(value: any) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        const text = String(entry || '').trim();
        return text || null;
      }
      return sanitizeExpectedToolSpecEntry(entry);
    })
    .filter(Boolean);
}

function sanitizeEvaluationRubric(value: any) {
  if (!isPlainObject(value)) {
    return {};
  }
  const rubric: any = { ...value };
  if (!Array.isArray(rubric.criticalConstraints)) {
    rubric.criticalConstraints = [];
  }
  if (!Array.isArray(rubric.criticalDimensions)) {
    rubric.criticalDimensions = [];
  }
  if (!Array.isArray(rubric.supportingSignalOverrides)) {
    rubric.supportingSignalOverrides = [];
  }
  if (!isPlainObject(rubric.passThresholds)) {
    rubric.passThresholds = {};
  }
  if (!isPlainObject(rubric.hardFailThresholds)) {
    rubric.hardFailThresholds = {};
  }
  if (!isPlainObject(rubric.thresholds)) {
    rubric.thresholds = { ...rubric.passThresholds };
  }
  return rubric;
}

function roundMetric(value: any) {
  if (value == null || !Number.isFinite(Number(value))) {
    return null;
  }
  return Math.round(Number(value) * 10000) / 10000;
}

function buildEvaluationTimelineIds(sessionSnapshot: any, toolCallEvents: any[], observedToolCalls: any[]) {
  const timelineIds: string[] = [];
  const textBlocks = Array.isArray(sessionSnapshot && sessionSnapshot.textBlocks)
    ? sessionSnapshot.textBlocks.filter((entry: any) => String(entry || '').trim())
    : (sessionSnapshot && String(sessionSnapshot.text || '').trim() ? [String(sessionSnapshot.text)] : []);
  const thinkingBlocks = Array.isArray(sessionSnapshot && sessionSnapshot.thinkingBlocks)
    ? sessionSnapshot.thinkingBlocks.filter((entry: any) => String(entry || '').trim())
    : (sessionSnapshot && String(sessionSnapshot.thinking || '').trim() ? [String(sessionSnapshot.thinking)] : []);
  for (let index = 0; index < textBlocks.length; index += 1) {
    timelineIds.push(`msg-${index + 1}`);
  }
  for (let index = 0; index < thinkingBlocks.length; index += 1) {
    timelineIds.push(`thinking-${index + 1}`);
  }
  const observedCalls = Array.isArray(observedToolCalls) ? observedToolCalls : [];
  for (let index = 0; index < observedCalls.length; index += 1) {
    timelineIds.push(`tool-call-${index + 1}`);
  }
  const toolEvents = Array.isArray(toolCallEvents) ? toolCallEvents : [];
  for (let index = 0; index < toolEvents.length; index += 1) {
    timelineIds.push(`tool-result-${index + 1}`);
  }
  return timelineIds;
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
    validityStatus,
    caseStatus: resolveCaseStatus(row),
    generationProvider: String(row.generation_provider || '').trim(),
    generationModel: String(row.generation_model || '').trim(),
    generationCreatedAt: String(row.generation_created_at || '').trim(),
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
    validationIssues: normalizedProjection.issues,
    errorMessage: String(row.error_message || '').trim(),
    createdAt: String(row.created_at || '').trim(),
  };
}

// resolveToolRelativePath is now imported from ../http/path-utils

export function createSkillTestController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  const agentToolBridge = options.agentToolBridge;
  const skillRegistry = options.skillRegistry;
  const getProjectDir = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  const toolBaseUrl = String(options.toolBaseUrl || '').trim() || 'http://127.0.0.1:3100';
  const startRunImpl = typeof options.startRunImpl === 'function' ? options.startRunImpl : startRun;
  const evaluateRunImpl = typeof options.evaluateRunImpl === 'function' ? options.evaluateRunImpl : null;
  let schemaReady = false;

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
    migrateSkillTestSchema(store.db);
    schemaReady = true;
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

  function mapCaseStatusToLegacyValidity(caseStatus: string) {
    if (caseStatus === 'ready') {
      return 'validated';
    }
    if (caseStatus === 'archived') {
      return 'archived';
    }
    return 'pending';
  }

  function parseCaseStatus(value: any, fallback = 'draft') {
    const normalized = String(value || fallback).trim().toLowerCase() || fallback;
    if (normalized === 'draft' || normalized === 'ready' || normalized === 'archived') {
      return normalized;
    }
    throw createHttpError(400, 'caseStatus must be one of: draft, ready, archived');
  }

  function _validateAndNormalizeCaseInput(input: any, options: { requireSkillId?: boolean; existing?: any } = {}) {
    const existing = options.existing || null;
    const skillId = String(input.skillId || existing && existing.skillId || '').trim();
    const loadingMode = String(input.loadingMode || input.loading_mode || existing && existing.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
    const testType = resolveTestTypeForLoadingMode(loadingMode, input.testType || input.test_type || existing && existing.testType);
    const issues: any[] = [];

    const explicitUserPrompt = hasOwn(input, 'userPrompt') || hasOwn(input, 'user_prompt');
    const explicitTriggerPrompt = hasOwn(input, 'triggerPrompt') || hasOwn(input, 'trigger_prompt');
    const rawUserPrompt = hasOwn(input, 'userPrompt') ? input.userPrompt : input.user_prompt;
    const rawTriggerPrompt = hasOwn(input, 'triggerPrompt') ? input.triggerPrompt : input.trigger_prompt;
    const normalizedUserPrompt = explicitUserPrompt ? normalizePromptText(rawUserPrompt) : '';
    const normalizedTriggerPrompt = explicitTriggerPrompt ? normalizePromptText(rawTriggerPrompt) : '';

    if (explicitUserPrompt && explicitTriggerPrompt && normalizedUserPrompt !== normalizedTriggerPrompt) {
      throw createValidationHttpError(
        buildValidationIssue(
          'prompt_alias_conflict',
          'error',
          'userPrompt',
          'userPrompt and triggerPrompt must match after normalization'
        )
      );
    }

    const userPrompt = normalizePromptText(
      explicitUserPrompt
        ? rawUserPrompt
        : explicitTriggerPrompt
          ? rawTriggerPrompt
          : getCanonicalCasePrompt(existing)
    );

    const hasExpectedToolsInput = hasOwn(input, 'expectedTools') || hasOwn(input, 'expected_tools');
    const rawExpectedToolsSource = hasExpectedToolsInput
      ? (hasOwn(input, 'expectedTools') ? input.expectedTools : input.expected_tools)
      : existing && Array.isArray(existing.expectedTools)
        ? existing.expectedTools
        : [];
    if (hasExpectedToolsInput && rawExpectedToolsSource != null && !Array.isArray(rawExpectedToolsSource)) {
      throw createValidationHttpError(
        buildValidationIssue('expected_tools_invalid', 'error', 'expectedTools', 'expectedTools must be an array')
      );
    }
    const expectedTools = sanitizeExpectedToolSpecs(Array.isArray(rawExpectedToolsSource) ? rawExpectedToolsSource : []);

    const hasExpectedSequenceInput = hasOwn(input, 'expectedSequence') || hasOwn(input, 'expected_sequence');
    const rawExpectedSequenceSource = hasExpectedSequenceInput
      ? (hasOwn(input, 'expectedSequence') ? input.expectedSequence : input.expected_sequence)
      : existing && Array.isArray(existing.expectedSequence)
        ? existing.expectedSequence
        : [];
    if (hasExpectedSequenceInput && rawExpectedSequenceSource != null && !Array.isArray(rawExpectedSequenceSource)) {
      throw createValidationHttpError(
        buildValidationIssue('expected_sequence_invalid', 'error', 'expectedSequence', 'expectedSequence must be an array')
      );
    }
    const expectedSequence = sanitizeExpectedSequence(Array.isArray(rawExpectedSequenceSource) ? rawExpectedSequenceSource : []);

    const expectedBehavior = String(input.expectedBehavior || input.expected_behavior || existing && existing.expectedBehavior || '').trim();
    const expectedGoal = String(input.expectedGoal || input.expected_goal || existing && existing.expectedGoal || '').trim();

    const hasEvaluationRubricInput = hasOwn(input, 'evaluationRubric') || hasOwn(input, 'evaluation_rubric');
    const evaluationRubricSource = hasEvaluationRubricInput
      ? (hasOwn(input, 'evaluationRubric') ? input.evaluationRubric : input.evaluation_rubric)
      : existing && existing.evaluationRubric;
    if (hasEvaluationRubricInput && evaluationRubricSource != null && !isPlainObject(evaluationRubricSource)) {
      throw createValidationHttpError(
        buildValidationIssue('evaluation_rubric_invalid', 'error', 'evaluationRubric', 'evaluationRubric must be an object')
      );
    }
    const evaluationRubric = sanitizeEvaluationRubric(evaluationRubricSource);
    const note = String(input.note || existing && existing.note || '').trim();
    const caseStatus = parseCaseStatus(input.caseStatus || input.case_status || existing && existing.caseStatus || 'draft');

    if (options.requireSkillId !== false && !skillId) {
      throw createHttpError(400, 'skillId is required');
    }

    const validLoadingModes = new Set(['dynamic', 'full']);
    if (!validLoadingModes.has(loadingMode)) {
      throw createHttpError(400, `loadingMode must be one of: ${[...validLoadingModes].join(', ')}`);
    }

    if (!userPrompt) {
      throw createValidationHttpError(
        buildValidationIssue('user_prompt_required', 'error', 'userPrompt', 'userPrompt is required')
      );
    }
    if (userPrompt.length < 5) {
      throw createValidationHttpError(
        buildValidationIssue('user_prompt_too_short', 'error', 'userPrompt', 'userPrompt is too short (minimum 5 characters)')
      );
    }
    if (userPrompt.length > 2000) {
      throw createValidationHttpError(
        buildValidationIssue('user_prompt_too_long', 'error', 'userPrompt', 'userPrompt is too long (maximum 2000 characters)')
      );
    }
    if (Array.isArray(rawExpectedToolsSource) && rawExpectedToolsSource.length > 0 && expectedTools.length !== rawExpectedToolsSource.length) {
      throw createValidationHttpError(
        buildValidationIssue(
          'expected_tools_invalid',
          'error',
          'expectedTools',
          'expectedTools items must be tool names or { name, arguments?, requiredParams?, order? } objects'
        )
      );
    }
    if (Array.isArray(rawExpectedSequenceSource) && rawExpectedSequenceSource.length > 0 && expectedSequence.length !== rawExpectedSequenceSource.length) {
      throw createValidationHttpError(
        buildValidationIssue(
          'expected_sequence_invalid',
          'error',
          'expectedSequence',
          'expectedSequence items must be strings or { name, arguments?, requiredParams?, order? } objects'
        )
      );
    }

    return {
      skillId,
      loadingMode,
      testType,
      userPrompt,
      triggerPrompt: userPrompt,
      expectedTools,
      expectedBehavior,
      expectedGoal,
      expectedSequence,
      evaluationRubric,
      caseStatus,
      validityStatus: mapCaseStatusToLegacyValidity(caseStatus),
      note,
      issues,
    };
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
          generation_provider, generation_model, generation_created_at,
          note, created_at, updated_at
        ) VALUES (
          @id, @skillId, @testType, @loadingMode, @triggerPrompt,
          @expectedToolsJson, @expectedBehavior, @validityStatus, @caseStatus,
          @expectedGoal, @expectedStepsJson, @expectedSequenceJson, @evaluationRubricJson,
          @generationProvider, @generationModel, @generationCreatedAt,
          @note, @createdAt, @updatedAt
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
        generationProvider: normalized.generationProvider || '',
        generationModel: normalized.generationModel || '',
        generationCreatedAt: normalized.generationCreatedAt || '',
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
             generation_provider = @generationProvider,
             generation_model = @generationModel,
             generation_created_at = @generationCreatedAt,
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
        generationProvider: normalized.generationProvider || '',
        generationModel: normalized.generationModel || '',
        generationCreatedAt: normalized.generationCreatedAt || '',
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
      return {
        provider: String(row.provider_label || '').trim(),
        model: String(row.model_label || '').trim(),
        promptVersion: String(row.prompt_version || '').trim() || 'skill-test-v1',
        totalRuns,
        succeededRuns: Number(row.succeeded_runs || 0),
        triggerPassedCount,
        executionPassedCount,
        triggerRate: totalRuns > 0 ? triggerPassedCount / totalRuns : null,
        executionRate: totalRuns > 0 ? executionPassedCount / totalRuns : null,
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

  function collectToolCallsFromTask(taskId: string) {
    ensureSchema();
    let rows: any[] = [];
    try {
      rows = store.db
        .prepare(
          `SELECT event_json FROM a2a_task_events
           WHERE task_id = @taskId AND event_type = 'agent_tool_call'
           ORDER BY id ASC LIMIT 200`
        )
        .all({ taskId });
    } catch {
      rows = [];
    }
    return rows
      .map((row) => safeJsonParse(row.event_json))
      .filter(Boolean);
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
  function getSessionPathForTask(taskId: string) {
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

  function normalizeSkillDisplayName(value: any) {
    return String(value || '').trim().replace(/\s+Skill$/i, '');
  }

  function normalizeLooseText(value: any) {
    return String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractTriggerSignalTokens(value: any, limit = 12) {
    const text = String(value || '').trim();
    if (!text) {
      return [];
    }

    const stopWords = new Set([
      'agent',
      'should',
      'recognize',
      'request',
      'trigger',
      'skill',
      'user',
      'mode',
      'test',
      'case',
      'expected',
      'behavior',
      'tool',
      'tools',
      'full',
      'dynamic',
      '用于',
      '后端',
      '自动',
      '主持',
      '模型',
      '测试',
      '触发',
      '执行',
      '用户',
      '技能',
    ]);

    const matches = text.match(/[A-Za-z][A-Za-z0-9-]{2,}|[\u4e00-\u9fff]{2,12}/g) || [];
    const tokens: string[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const token = String(match || '').trim();
      const normalized = normalizeLooseText(token);
      if (!normalized || stopWords.has(normalized) || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      tokens.push(token);
      if (tokens.length >= limit) {
        break;
      }
    }
    return tokens;
  }

  function buildFullModeTriggerSignals(skill: any, testCase: any) {
    const signals: string[] = [];
    const seen = new Set<string>();

    const pushSignal = (value: any) => {
      const text = String(value || '').trim();
      const normalized = normalizeLooseText(text);
      if (!text || !normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      signals.push(text);
    };

    pushSignal(normalizeSkillDisplayName(skill && skill.name));
    pushSignal(skill && skill.id);
    pushSignal(testCase && testCase.skillId);

    const secondarySources = [
      skill && skill.description,
      testCase && testCase.expectedBehavior,
      testCase && testCase.note,
    ];
    for (const source of secondarySources) {
      for (const token of extractTriggerSignalTokens(source)) {
        pushSignal(token);
      }
    }

    return signals.slice(0, 16);
  }

  function clipJudgeText(value: any, maxLength = 2400) {
    const text = String(value || '').trim();
    if (!text) {
      return '';
    }
    if (text.length <= maxLength) {
      return text;
    }
    const safeLength = Math.max(0, maxLength - 16);
    return `${text.slice(0, safeLength).trim()}\n...[truncated]`;
  }

  function extractJsonObjectFromText(value: any) {
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

    const firstBraceIndex = text.indexOf('{');
    const lastBraceIndex = text.lastIndexOf('}');
    if (firstBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
      pushCandidate(text.slice(firstBraceIndex, lastBraceIndex + 1));
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (isPlainObject(parsed)) {
          return parsed;
        }
      } catch {
      }
    }

    return null;
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

  function normalizeJudgePassed(value: any) {
    if (typeof value === 'boolean') {
      return value;
    }

    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (['true', '1', 'yes', 'y', 'pass', 'passed'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'fail', 'failed'].includes(normalized)) {
      return false;
    }
    return null;
  }

  function normalizeJudgeConfidence(value: any) {
    if (value == null || value === '') {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      return null;
    }
    return parsed;
  }

  function parseFullModeTriggerJudgeResponse(value: any) {
    const rawResponse = clipJudgeText(value, 600);
    const parsed = extractJsonObjectFromText(value);
    const matchedBehaviorsSource = parsed
      ? (Array.isArray(parsed.matchedBehaviors)
        ? parsed.matchedBehaviors
        : Array.isArray(parsed.matched_behaviors)
          ? parsed.matched_behaviors
          : Array.isArray(parsed.matchedEvidence)
            ? parsed.matchedEvidence
            : Array.isArray(parsed.evidence)
              ? parsed.evidence
              : [])
      : [];
    const matchedBehaviors = [...new Set(
      matchedBehaviorsSource
        .map((entry: any) => String(entry || '').trim())
        .filter(Boolean)
    )].slice(0, 8);

    return {
      attempted: Boolean(rawResponse),
      skipped: false,
      skippedReason: '',
      parsed: Boolean(parsed),
      passed: parsed && hasOwn(parsed, 'passed') ? normalizeJudgePassed(parsed.passed) : null,
      confidence: parsed && hasOwn(parsed, 'confidence') ? normalizeJudgeConfidence(parsed.confidence) : null,
      reason: parsed && hasOwn(parsed, 'reason') ? String(parsed.reason || '').trim() : '',
      matchedBehaviors,
      rawResponse,
      errorMessage: parsed || !rawResponse ? '' : 'judge-response-not-json',
    };
  }

  function buildFullModeTriggerJudgePrompt(skill: any, testCase: any, actualTools: string[], evidenceText: string) {
    const observedTools = [...new Set((Array.isArray(actualTools) ? actualTools : []).filter(Boolean))];
    const skillName = clipJudgeText(normalizeSkillDisplayName(skill && skill.name), 120);
    const skillId = clipJudgeText(testCase && testCase.skillId || skill && skill.id, 80);
    const skillDescription = clipJudgeText(skill && skill.description, 500);
    const skillBody = clipJudgeText(skill && skill.body, 1800);
    const expectedBehavior = clipJudgeText(testCase && testCase.expectedBehavior, 600);
    const note = clipJudgeText(testCase && testCase.note, 300);
    const triggerPrompt = clipJudgeText(getCanonicalCasePrompt(testCase), 600);
    const assistantEvidence = String(evidenceText || '').trim();
    const observedToolsJson = clipJudgeText(JSON.stringify(observedTools, null, 2), 300);

    return [
      '你是一个严格的 Skill 触发评审器。',
      '任务：判断 assistant 是否在 full mode 下真正遵循了目标 skill，而不是仅仅聊到相关话题。',
      '只依据下面提供的证据判断，不要调用工具，不要查看文件，不要补充额外解释。',
      '只返回一行 JSON，格式必须严格为：',
      '{"passed":true|false,"confidence":0.0,"reason":"一句话原因","matchedBehaviors":["命中的关键行为"]}',
      '判定规则：',
      '- 只有当 assistant 明确采用了目标 skill 的行为、身份、约束或流程时，passed 才能为 true。',
      '- 如果 assistant 只是解释概念、泛泛回答、或行为与 skill 不符，passed=false。',
      '- 如果证据不足或你不确定，passed=false。',
      '',
      `Skill Name: ${skillName || 'unknown'}`,
      `Skill ID: ${skillId || 'unknown'}`,
      `Skill Description:\n${skillDescription || '(none)'}`,
      `Expected Behavior:\n${expectedBehavior || '(none)'}`,
      `Case Note:\n${note || '(none)'}`,
      `User Prompt:\n${triggerPrompt || '(none)'}`,
      `Observed Tools:\n${observedToolsJson || '[]'}`,
      `Assistant Evidence:\n${assistantEvidence || '(none)'}`,
      `Skill Body Excerpt:\n${skillBody || '(none)'}`,
    ].join('\n\n');
  }

  async function runFullModeTriggerAiJudge(skill: any, testCase: any, actualTools: string[], evidenceText: string, runtime: any = {}) {
    const hasObservableEvidence = Boolean(String(evidenceText || '').trim()) || actualTools.length > 0;
    if (!hasObservableEvidence) {
      return {
        attempted: false,
        skipped: true,
        skippedReason: 'no-observable-evidence',
        parsed: false,
        passed: null,
        confidence: null,
        reason: '',
        matchedBehaviors: [],
        rawResponse: '',
        errorMessage: '',
        sessionPath: '',
      };
    }

    const judgePrompt = buildFullModeTriggerJudgePrompt(skill, testCase, actualTools, evidenceText);
    const judgeTaskId = `skill-test-judge-${randomUUID()}`;
    const judgeSessionName = `skill-test-judge-${String(testCase && testCase.id || 'case').trim() || 'case'}-${Date.now()}`;
    const provider = String(runtime && runtime.provider || '').trim();
    const model = String(runtime && runtime.model || '').trim();
    const judgeAgentIdBase = String(runtime && runtime.agentId || 'skill-test-agent').trim() || 'skill-test-agent';
    const sandboxDir = runtime && runtime.sandbox && runtime.sandbox.sandboxDir
      ? String(runtime.sandbox.sandboxDir)
      : '';
    const privateDir = runtime && runtime.sandbox && runtime.sandbox.privateDir
      ? String(runtime.sandbox.privateDir)
      : '';

    try {
      const handle = startRunImpl(provider, model, judgePrompt, {
        thinking: '',
        agentDir: store.agentDir,
        sqlitePath: store.databasePath,
        streamOutput: false,
        session: judgeSessionName,
        taskId: judgeTaskId,
        taskKind: 'skill_test_trigger_judge',
        taskRole: 'Skill Trigger Judge',
        metadata: {
          source: 'skill_test_trigger_judge',
          parentTaskId: runtime && runtime.taskId ? runtime.taskId : null,
          testCaseId: testCase && testCase.id ? testCase.id : null,
          skillId: testCase && testCase.skillId ? testCase.skillId : null,
        },
        extraEnv: {
          PI_AGENT_ID: `${judgeAgentIdBase}-judge`,
          PI_AGENT_NAME: 'Skill Trigger Judge',
          PI_AGENT_SANDBOX_DIR: sandboxDir,
          PI_AGENT_PRIVATE_DIR: privateDir,
          CAFF_SKILL_LOADING_MODE: 'full',
        },
      });
      const judgeResult = await handle.resultPromise;
      const parsed = parseFullModeTriggerJudgeResponse(judgeResult && judgeResult.reply ? judgeResult.reply : '');
      return {
        ...parsed,
        attempted: true,
        sessionPath: String((judgeResult && judgeResult.sessionPath) || handle.sessionPath || '').trim(),
      };
    } catch (error: any) {
      return {
        attempted: true,
        skipped: false,
        skippedReason: '',
        parsed: false,
        passed: null,
        confidence: null,
        reason: '',
        matchedBehaviors: [],
        rawResponse: '',
        errorMessage: error && error.message ? String(error.message) : String(error || 'AI judge failed'),
        sessionPath: '',
      };
    }
  }

  async function evaluateFullModeTrigger(skill: any, testCase: any, actualTools: string[], evidenceText: string, runtime: any = {}) {
    const expectedTools = normalizeExpectedToolSpecs(testCase && testCase.expectedTools).map((entry: any) => entry.name);
    const normalizedEvidence = normalizeLooseText(evidenceText);
    const triggerSignals = buildFullModeTriggerSignals(skill, testCase);
    const matchedSignals = triggerSignals.filter((signal) => {
      const normalizedSignal = normalizeLooseText(signal);
      return normalizedSignal ? normalizedEvidence.includes(normalizedSignal) : false;
    });
    const expectedToolMatched = expectedTools.some((tool) => actualTools.includes(tool));
    const hasObservableOutput = Boolean(String(evidenceText || '').trim()) || actualTools.length > 0;
    const signalMatched = matchedSignals.length > 0 && hasObservableOutput;
    const aiJudge = await runFullModeTriggerAiJudge(skill, testCase, actualTools, evidenceText, runtime);
    const triggerPassed = expectedToolMatched || signalMatched || aiJudge.passed === true;
    const decisionSources = [];

    if (expectedToolMatched) {
      decisionSources.push('expected-tool');
    }
    if (signalMatched) {
      decisionSources.push('behavior-signals');
    }
    if (aiJudge.passed === true) {
      decisionSources.push('ai-judge');
    }
    if (decisionSources.length === 0) {
      decisionSources.push('none');
    }

    return {
      triggerPassed,
      triggerEvaluation: {
        mode: 'full',
        matchedSignals,
        expectedToolMatched,
        signalMatched,
        hasObservableOutput,
        decisionSources,
        aiJudge,
      },
    };
  }

  function normalizeJudgeSuggestion(value: any) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'pass' || normalized === 'borderline' || normalized === 'fail') {
      return normalized;
    }
    return '';
  }

  function parseJudgeDimension(value: any) {
    if (!isPlainObject(value)) {
      return { score: null, reason: '', invalid: false };
    }
    const rawScore = hasOwn(value, 'score') ? value.score : null;
    const score = normalizeJudgeConfidence(rawScore);
    return {
      score,
      reason: String(value.reason || '').trim(),
      invalid: rawScore != null && rawScore !== '' && score == null,
    };
  }

  function parseFullModeExecutionJudgeResponse(value: any) {
    const rawResponse = clipJudgeText(value, 3000);
    const parsed = extractJsonObjectFromText(value);

    if (!rawResponse) {
      return {
        status: 'skipped',
        parsed: false,
        rawResponse: '',
        errorMessage: '',
        goalAchievement: { score: null, reason: '' },
        instructionAdherence: { score: null, reason: '' },
        summary: '',
        verdictSuggestion: '',
        missedExpectations: [],
        steps: [],
        constraintChecks: [],
      };
    }

    if (!parsed) {
      return {
        status: 'parse_failed',
        parsed: false,
        rawResponse,
        errorMessage: 'judge-response-not-json',
        goalAchievement: { score: null, reason: '' },
        instructionAdherence: { score: null, reason: '' },
        summary: '',
        verdictSuggestion: '',
        missedExpectations: [],
        steps: [],
        constraintChecks: [],
      };
    }

    const goalAchievement = parseJudgeDimension(parsed.goalAchievement || parsed.goal_achievement);
    const instructionAdherence = parseJudgeDimension(parsed.instructionAdherence || parsed.instruction_adherence);
    const verdictSuggestion = normalizeJudgeSuggestion(parsed.verdictSuggestion || parsed.verdict_suggestion);
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps
      : Array.isArray(parsed.stepResults)
        ? parsed.stepResults
        : null;
    const constraintChecks = Array.isArray(parsed.constraintChecks)
      ? parsed.constraintChecks
      : Array.isArray(parsed.constraint_checks)
        ? parsed.constraint_checks
        : null;
    const missedExpectationsSource = Array.isArray(parsed.missedExpectations)
      ? parsed.missedExpectations
      : Array.isArray(parsed.missed_expectations)
        ? parsed.missed_expectations
        : null;

    const hasRequiredFields = (
      (hasOwn(parsed, 'goalAchievement') || hasOwn(parsed, 'goal_achievement'))
      && (hasOwn(parsed, 'instructionAdherence') || hasOwn(parsed, 'instruction_adherence'))
      && hasOwn(parsed, 'summary')
      && (hasOwn(parsed, 'verdictSuggestion') || hasOwn(parsed, 'verdict_suggestion'))
      && (hasOwn(parsed, 'steps') || hasOwn(parsed, 'stepResults'))
      && (hasOwn(parsed, 'constraintChecks') || hasOwn(parsed, 'constraint_checks'))
      && (hasOwn(parsed, 'missedExpectations') || hasOwn(parsed, 'missed_expectations'))
    );

    if (
      !hasRequiredFields
      || goalAchievement.invalid
      || instructionAdherence.invalid
      || !verdictSuggestion
      || !Array.isArray(steps)
      || !Array.isArray(constraintChecks)
      || !Array.isArray(missedExpectationsSource)
    ) {
      return {
        status: 'parse_failed',
        parsed: false,
        rawResponse,
        errorMessage: 'judge-response-invalid-schema',
        goalAchievement: { score: null, reason: '' },
        instructionAdherence: { score: null, reason: '' },
        summary: '',
        verdictSuggestion: '',
        missedExpectations: [],
        steps: [],
        constraintChecks: [],
      };
    }

    const missedExpectations = missedExpectationsSource
      .map((entry: any) => String(entry || '').trim())
      .filter(Boolean)
      .slice(0, 16);

    return {
      status: 'succeeded',
      parsed: true,
      rawResponse,
      errorMessage: '',
      goalAchievement: { score: goalAchievement.score, reason: goalAchievement.reason },
      instructionAdherence: { score: instructionAdherence.score, reason: instructionAdherence.reason },
      summary: String(parsed.summary || '').trim(),
      verdictSuggestion,
      missedExpectations,
      steps,
      constraintChecks,
    };
  }

  function buildFullModeExecutionJudgePrompt(
    skill: any,
    testCase: any,
    actualTools: string[],
    failedCalls: any[],
    evidenceText: string,
    timelineIds: any = null
  ) {
    const observedTools = [...new Set((Array.isArray(actualTools) ? actualTools : []).filter(Boolean))];
    const skillName = clipJudgeText(normalizeSkillDisplayName(skill && skill.name), 120);
    const skillId = clipJudgeText(testCase && testCase.skillId || skill && skill.id, 80);
    const skillDescription = clipJudgeText(skill && skill.description, 500);
    const skillBody = clipJudgeText(skill && skill.body, 1800);
    const expectedBehavior = clipJudgeText(testCase && testCase.expectedBehavior, 600);
    const expectedGoal = clipJudgeText(testCase && testCase.expectedGoal, 500);
    const note = clipJudgeText(testCase && testCase.note, 300);
    const triggerPrompt = clipJudgeText(getCanonicalCasePrompt(testCase), 600);
    const assistantEvidence = String(evidenceText || '').trim();
    const observedToolsJson = clipJudgeText(JSON.stringify(observedTools, null, 2), 300);
    const failedCallsJson = clipJudgeText(JSON.stringify(failedCalls || [], null, 2), 400);
    const expectedSteps = Array.isArray(testCase && testCase.expectedSteps) ? testCase.expectedSteps : [];
    const expectedStepsJson = clipJudgeText(JSON.stringify(expectedSteps, null, 2), 2400);
    const rubric = sanitizeEvaluationRubric(testCase && testCase.evaluationRubric);
    const criticalConstraints = Array.isArray(rubric.criticalConstraints) ? rubric.criticalConstraints : [];
    const criticalConstraintsJson = clipJudgeText(JSON.stringify(criticalConstraints, null, 2), 1200);
    const normalizedTimelineIds = Array.isArray(timelineIds)
      ? timelineIds.map((entry: any) => String(entry || '').trim()).filter(Boolean)
      : [];
    const timelineIdsJson = clipJudgeText(JSON.stringify(normalizedTimelineIds, null, 2), 1500);
    const knownSignalIds = expectedSteps
      .flatMap((step: any) => (Array.isArray(step && step.strongSignals) ? step.strongSignals : []))
      .map((signal: any) => String(signal && signal.id || '').trim())
      .filter(Boolean);
    const knownSignalIdsJson = clipJudgeText(JSON.stringify(knownSignalIds, null, 2), 1000);

    return [
      '你是一个严格的 Skill 执行评审器。',
      '任务：判断 assistant 在 full mode 下是否按预期完成目标、遵循 skill 约束、并返回结构化 step / constraint 评估。',
      '只依据下面提供的证据判断，不要调用工具，不要查看文件，不要补充额外解释。',
      '只返回一行 JSON，格式必须严格为：',
      '{"steps":[{"stepId":"step-1","completed":true,"confidence":0.9,"evidenceIds":["msg-1"],"matchedSignalIds":["sig-step-1-read"],"reason":"..."}],"constraintChecks":[{"constraintId":"confirm-before-action","satisfied":true,"evidenceIds":["msg-1"],"reason":"..."}],"goalAchievement":{"score":0.0,"reason":"..."},"instructionAdherence":{"score":0.0,"reason":"..."},"summary":"一句话总结","verdictSuggestion":"pass|borderline|fail","missedExpectations":["..."]}',
      '规则：',
      '- 所有 score / confidence 必须在 0 到 1 之间。',
      '- reason 必须依据可观察证据。',
      '- evidenceIds 只能引用 Timeline IDs 中已有的 id。',
      '- matchedSignalIds 只能引用 Known Signal IDs 中已有的 id。',
      '- 不能发明 stepId / constraintId。',
      '',
      `Skill Name: ${skillName || 'unknown'}`,
      `Skill ID: ${skillId || 'unknown'}`,
      `Skill Description:\n${skillDescription || '(none)'}`,
      `Expected Goal:\n${expectedGoal || '(none)'}`,
      `Expected Behavior:\n${expectedBehavior || '(none)'}`,
      `Expected Steps:\n${expectedStepsJson || '[]'}`,
      `Critical Constraints:\n${criticalConstraintsJson || '[]'}`,
      `Known Signal IDs:\n${knownSignalIdsJson || '[]'}`,
      `Case Note:\n${note || '(none)'}`,
      `User Prompt:\n${triggerPrompt || '(none)'}`,
      `Observed Tools:\n${observedToolsJson || '[]'}`,
      `Failed Calls:\n${failedCallsJson || '[]'}`,
      `Timeline IDs:\n${timelineIdsJson || '[]'}`,
      `Assistant Evidence:\n${assistantEvidence || '(none)'}`,
      `Skill Body Excerpt:\n${skillBody || '(none)'}`,
    ].join('\n\n');
  }

  async function runFullModeExecutionAiJudge(skill: any, testCase: any, actualTools: string[], failedCalls: any[], evidenceText: string, runtime: any = {}) {
    const hasObservableEvidence = Boolean(String(evidenceText || '').trim()) || actualTools.length > 0;
    if (!hasObservableEvidence) {
      return {
        status: 'skipped',
        parsed: false,
        rawResponse: '',
        errorMessage: '',
        goalAchievement: { score: null, reason: '' },
        instructionAdherence: { score: null, reason: '' },
        summary: '',
        verdictSuggestion: '',
        missedExpectations: [],
        steps: [],
        constraintChecks: [],
        sessionPath: '',
      };
    }

    const judgePrompt = buildFullModeExecutionJudgePrompt(
      skill,
      testCase,
      actualTools,
      failedCalls,
      evidenceText,
      runtime && runtime.timelineIds
    );
    const judgeTaskId = `skill-test-execution-judge-${randomUUID()}`;
    const judgeSessionName = `skill-test-execution-judge-${String(testCase && testCase.id || 'case').trim() || 'case'}-${Date.now()}`;
    const provider = String(runtime && runtime.provider || '').trim();
    const model = String(runtime && runtime.model || '').trim();
    const judgeAgentIdBase = String(runtime && runtime.agentId || 'skill-test-agent').trim() || 'skill-test-agent';
    const sandboxDir = runtime && runtime.sandbox && runtime.sandbox.sandboxDir
      ? String(runtime.sandbox.sandboxDir)
      : '';
    const privateDir = runtime && runtime.sandbox && runtime.sandbox.privateDir
      ? String(runtime.sandbox.privateDir)
      : '';

    try {
      const handle = startRunImpl(provider, model, judgePrompt, {
        thinking: '',
        agentDir: store.agentDir,
        sqlitePath: store.databasePath,
        streamOutput: false,
        session: judgeSessionName,
        taskId: judgeTaskId,
        taskKind: 'skill_test_execution_judge',
        taskRole: 'Skill Execution Judge',
        metadata: {
          source: 'skill_test_execution_judge',
          parentTaskId: runtime && runtime.taskId ? runtime.taskId : null,
          testCaseId: testCase && testCase.id ? testCase.id : null,
          skillId: testCase && testCase.skillId ? testCase.skillId : null,
        },
        extraEnv: {
          PI_AGENT_ID: `${judgeAgentIdBase}-execution-judge`,
          PI_AGENT_NAME: 'Skill Execution Judge',
          PI_AGENT_SANDBOX_DIR: sandboxDir,
          PI_AGENT_PRIVATE_DIR: privateDir,
          CAFF_SKILL_LOADING_MODE: 'full',
        },
      });
      const judgeResult = await handle.resultPromise;
      const parsed = parseFullModeExecutionJudgeResponse(judgeResult && judgeResult.reply ? judgeResult.reply : '');
      return {
        ...parsed,
        sessionPath: String((judgeResult && judgeResult.sessionPath) || handle.sessionPath || '').trim(),
      };
    } catch (error: any) {
      return {
        status: 'runtime_failed',
        parsed: false,
        rawResponse: '',
        errorMessage: error && error.message ? String(error.message) : String(error || 'AI judge failed'),
        goalAchievement: { score: null, reason: '' },
        instructionAdherence: { score: null, reason: '' },
        summary: '',
        verdictSuggestion: '',
        missedExpectations: [],
        steps: [],
        constraintChecks: [],
        sessionPath: '',
      };
    }
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

    issues.push(...expectedToolsParsed.issues, ...expectedStepsParsed.issues, ...expectedSequenceParsed.issues, ...evaluationRubricParsed.issues);

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

  function getExecutionJudgeValidationIssues(aiJudge: any) {
    if (!aiJudge || typeof aiJudge !== 'object') {
      return [];
    }
    if (aiJudge.status === 'parse_failed') {
      return [
        buildValidationIssue(
          'judge_parse_failed',
          'error',
          'evaluation.aiJudge',
          String(aiJudge.errorMessage || 'Execution judge response could not be parsed')
        ),
      ];
    }
    if (aiJudge.status === 'runtime_failed') {
      return [
        buildValidationIssue(
          'judge_runtime_failed',
          'needs-review',
          'evaluation.aiJudge',
          String(aiJudge.errorMessage || 'Execution judge failed at runtime')
        ),
      ];
    }
    return [];
  }

  function normalizeSequenceEntryName(entry: any) {
    if (typeof entry === 'string') {
      return normalizeToolNameForMatch(entry);
    }
    if (!entry || typeof entry !== 'object') {
      return '';
    }
    return normalizeToolNameForMatch(entry.name || entry.tool || '');
  }

  function buildExpectedSequenceSpecsWithDiagnostics(testCase: any, expectedTools: any[]) {
    const expectedSteps = Array.isArray(testCase && testCase.expectedSteps) ? testCase.expectedSteps : [];
    const stepIdSet = new Set<string>();
    const stepIdToToolName = new Map<string, string>();
    const orderedExpectedTools = Array.isArray(expectedTools) ? expectedTools : [];
    const orderToToolName = new Map<number, string>();

    for (const entry of orderedExpectedTools) {
      const toolName = String(entry && entry.name || '').trim();
      const order = parseExpectedToolOrder(entry);
      if (!toolName || order == null || orderToToolName.has(order)) {
        continue;
      }
      orderToToolName.set(order, toolName);
    }

    for (const step of expectedSteps) {
      const stepId = String(step && step.id || '').trim();
      if (!stepId) {
        continue;
      }
      stepIdSet.add(stepId);

      const strongSignals = Array.isArray(step && step.strongSignals) ? step.strongSignals : [];
      let mappedToolName = '';
      for (const signal of strongSignals) {
        if (!isPlainObject(signal) || String(signal.type || '').trim() !== 'tool') {
          continue;
        }
        const toolName = String(signal.toolName || signal.tool || signal.name || '').trim();
        if (toolName) {
          mappedToolName = toolName;
          break;
        }
      }

      if (!mappedToolName) {
        const order = normalizePositiveInteger(step && step.order);
        if (order != null && orderToToolName.has(order)) {
          mappedToolName = String(orderToToolName.get(order) || '').trim();
        }
      }

      if (mappedToolName) {
        stepIdToToolName.set(stepId, mappedToolName);
      }
    }

    const explicitSequence = sanitizeExpectedSequence(testCase && testCase.expectedSequence);
    const unresolvedStepIds = new Set<string>();

    if (explicitSequence.length > 0) {
      const specs = explicitSequence
        .map((entry: any, index: number) => {
          const reference = normalizeStepSequenceReference(entry);
          const referencesKnownStep = Boolean(reference && stepIdSet.has(reference));
          let name = '';

          if (referencesKnownStep) {
            name = String(stepIdToToolName.get(reference) || '').trim();
            if (!name) {
              unresolvedStepIds.add(reference);
              return null;
            }
          } else {
            name = normalizeSequenceEntryName(entry);
          }

          if (!name) {
            return null;
          }

          const order = parseExpectedToolOrder(entry);
          return {
            name,
            order: order != null ? order : index + 1,
            sourceOrder: index,
            stepId: referencesKnownStep ? reference : '',
          };
        })
        .filter(Boolean);

      return {
        specs,
        unresolvedStepIds: [...unresolvedStepIds],
      };
    }

    return {
      specs: orderedExpectedTools
        .filter((entry: any) => entry && entry.hasSequenceExpectation)
        .map((entry: any) => ({
          name: entry.name,
          order: entry.order != null ? entry.order : null,
          sourceOrder: entry.sourceOrder != null ? entry.sourceOrder : null,
          stepId: '',
        }))
        .filter((entry: any) => entry && entry.name),
      unresolvedStepIds: [],
    };
  }

  function buildExpectedSequenceSpecs(testCase: any, expectedTools: any[]) {
    return buildExpectedSequenceSpecsWithDiagnostics(testCase, expectedTools).specs;
  }

  function buildExpectedSequenceNames(testCase: any, expectedTools: any[]) {
    return buildExpectedSequenceSpecs(testCase, expectedTools)
      .slice()
      .sort((left: any, right: any) => {
        const orderDelta = Number(left.order || 0) - Number(right.order || 0);
        return orderDelta || Number(left.sourceOrder || 0) - Number(right.sourceOrder || 0);
      })
      .map((entry: any) => entry.name)
      .filter(Boolean);
  }

  function buildCriticalSequenceEvidenceIssues(testCase: any, expectedSequenceSpecs: any[], unresolvedStepIds: string[] = []) {
    if (!testCase || String(testCase.loadingMode || '').trim().toLowerCase() !== 'full') {
      return [];
    }
    const rubric = sanitizeEvaluationRubric(testCase && testCase.evaluationRubric);
    const criticalDimensions = Array.isArray(rubric.criticalDimensions)
      ? rubric.criticalDimensions.map((entry: any) => String(entry || '').trim())
      : [];
    if (!criticalDimensions.includes('sequenceAdherence')) {
      return [];
    }

    const normalizedUnresolved = Array.isArray(unresolvedStepIds)
      ? unresolvedStepIds.map((entry: any) => String(entry || '').trim()).filter(Boolean)
      : [];
    if (normalizedUnresolved.length > 0) {
      return [
        buildValidationIssue(
          'critical_sequence_evidence_unavailable',
          'needs-review',
          'evaluationRubric.criticalDimensions',
          `sequenceAdherence is critical, but no verifiable sequence evidence mapping exists for steps: ${normalizedUnresolved.join(', ')}`
        ),
      ];
    }
    if (!Array.isArray(expectedSequenceSpecs) || expectedSequenceSpecs.length === 0) {
      return [
        buildValidationIssue(
          'critical_sequence_evidence_unavailable',
          'needs-review',
          'evaluationRubric.criticalDimensions',
          'sequenceAdherence is critical, but no verifiable sequence evidence could be constructed'
        ),
      ];
    }
    return [];
  }

  function readThresholdNumber(value: any, fallback: number | null) {
    if (value == null || value === '') {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    if (parsed < 0 || parsed > 1) {
      return fallback;
    }
    return parsed;
  }

  function getFullModeThresholds(testCase: any, hasSequenceConstraint: boolean) {
    const rubric = sanitizeEvaluationRubric(testCase && testCase.evaluationRubric);
    const passThresholds = isPlainObject(rubric.passThresholds)
      ? rubric.passThresholds
      : isPlainObject(rubric.thresholds)
        ? rubric.thresholds
        : {};
    const hardFailThresholds = isPlainObject(rubric.hardFailThresholds) ? rubric.hardFailThresholds : {};
    return {
      pass: {
        goalAchievement: readThresholdNumber(passThresholds.goalAchievement, 0.7),
        instructionAdherence: readThresholdNumber(passThresholds.instructionAdherence, 0.7),
        sequenceAdherence: hasSequenceConstraint ? readThresholdNumber(passThresholds.sequenceAdherence, 0.7) : null,
      },
      hardFail: {
        goalAchievement: readThresholdNumber(hardFailThresholds.goalAchievement, 0.5),
        instructionAdherence: readThresholdNumber(hardFailThresholds.instructionAdherence, 0.5),
        sequenceAdherence: hasSequenceConstraint ? readThresholdNumber(hardFailThresholds.sequenceAdherence, 0.4) : null,
      },
      supporting: {
        requiredToolCoverage: readThresholdNumber(passThresholds.requiredToolCoverage, 1),
        toolCallSuccessRate: readThresholdNumber(passThresholds.toolCallSuccessRate, 0.8),
        toolErrorRate: readThresholdNumber(passThresholds.toolErrorRate, 0.2),
      },
    };
  }

  function getSequenceConstraintStepIds(testCase: any) {
    const expectedSteps = Array.isArray(testCase && testCase.expectedSteps) ? testCase.expectedSteps : [];
    const knownStepIds = new Set(expectedSteps.map((entry: any) => String(entry && entry.id || '').trim()).filter(Boolean));
    const explicitSequence = Array.isArray(testCase && testCase.sequenceStepIds)
      ? testCase.sequenceStepIds.map((entry: any) => String(entry || '').trim()).filter(Boolean)
      : [];
    if (explicitSequence.length > 0) {
      return explicitSequence.filter((stepId: string) => knownStepIds.has(stepId));
    }
    return expectedSteps
      .filter((entry: any) => normalizePositiveInteger(entry && entry.order) != null)
      .slice()
      .sort((left: any, right: any) => Number(left.order || 0) - Number(right.order || 0))
      .map((entry: any) => String(entry && entry.id || '').trim())
      .filter(Boolean);
  }

  function buildTimelineOrderLookup(timelineIds: any) {
    const ids = Array.isArray(timelineIds)
      ? timelineIds.map((entry: any) => String(entry || '').trim()).filter(Boolean)
      : [];
    const lookup = new Map<string, number>();
    ids.forEach((id, index) => lookup.set(id, index));
    return lookup;
  }

  function buildJudgeStepLookup(aiJudge: any) {
    const stepLookup = new Map<string, any>();
    const judgeSteps = Array.isArray(aiJudge && aiJudge.steps) ? aiJudge.steps : [];
    for (const step of judgeSteps) {
      const stepId = String(step && step.stepId || '').trim();
      if (!stepId || stepLookup.has(stepId)) {
        continue;
      }
      stepLookup.set(stepId, step);
    }
    return stepLookup;
  }

  function resolveStepEvidenceOrder(stepResult: any, timelineOrderLookup: Map<string, number>) {
    if (!stepResult || !Array.isArray(stepResult.evidenceIds) || timelineOrderLookup.size === 0) {
      return null;
    }
    let minOrder: number | null = null;
    for (const evidenceId of stepResult.evidenceIds) {
      const id = String(evidenceId || '').trim();
      if (!id || !timelineOrderLookup.has(id)) {
        continue;
      }
      const order = Number(timelineOrderLookup.get(id));
      if (minOrder == null || order < minOrder) {
        minOrder = order;
      }
    }
    return minOrder;
  }

  function calculateSequenceAdherenceFromEvidence(sequenceStepIds: string[], stepLookup: Map<string, any>, timelineOrderLookup: Map<string, number>) {
    if (!Array.isArray(sequenceStepIds) || sequenceStepIds.length === 0) {
      return {
        score: null,
        comparableStepCount: 0,
        matchedComparableCount: 0,
        unresolvedStepIds: [],
        reason: '未配置关键顺序。',
      };
    }

    const resolved: Array<{ stepId: string; order: number }> = [];
    const unresolvedStepIds: string[] = [];

    for (const stepId of sequenceStepIds) {
      const normalizedStepId = String(stepId || '').trim();
      if (!normalizedStepId) {
        continue;
      }
      const stepResult = stepLookup.get(normalizedStepId);
      const order = resolveStepEvidenceOrder(stepResult, timelineOrderLookup);
      if (order == null) {
        unresolvedStepIds.push(normalizedStepId);
        continue;
      }
      resolved.push({ stepId: normalizedStepId, order });
    }

    if (resolved.length < 2) {
      return {
        score: null,
        comparableStepCount: resolved.length,
        matchedComparableCount: 0,
        unresolvedStepIds,
        reason: `顺序证据不足，无法计算顺序分数（已解析 ${resolved.length} / ${sequenceStepIds.length} 个步骤证据）。`,
      };
    }

    let matchedComparableCount = 1;
    for (let index = 1; index < resolved.length; index += 1) {
      if (resolved[index].order > resolved[index - 1].order) {
        matchedComparableCount += 1;
      }
    }

    return {
      score: matchedComparableCount / resolved.length,
      comparableStepCount: resolved.length,
      matchedComparableCount,
      unresolvedStepIds,
      reason: `顺序证据匹配 ${matchedComparableCount} / ${resolved.length}`,
    };
  }

  function calculateStepCompletionMetrics(testCase: any, stepLookup: Map<string, any>) {
    const expectedSteps = Array.isArray(testCase && testCase.expectedSteps) ? testCase.expectedSteps : [];
    const requiredSteps = expectedSteps.filter((entry: any) => Boolean(entry && entry.required));
    const completedSteps = expectedSteps.filter((entry: any) => {
      const stepId = String(entry && entry.id || '').trim();
      const stepResult = stepLookup.get(stepId);
      return Boolean(stepResult && stepResult.completed === true);
    });
    const completedRequiredSteps = requiredSteps.filter((entry: any) => {
      const stepId = String(entry && entry.id || '').trim();
      const stepResult = stepLookup.get(stepId);
      return Boolean(stepResult && stepResult.completed === true);
    });

    const missingRequiredSteps = requiredSteps
      .map((entry: any) => String(entry && entry.id || '').trim())
      .filter((stepId: string) => {
        const stepResult = stepLookup.get(stepId);
        return !stepResult || stepResult.completed !== true;
      });

    const missingNonRequiredSteps = expectedSteps
      .filter((entry: any) => !entry || !entry.required)
      .map((entry: any) => String(entry && entry.id || '').trim())
      .filter(Boolean)
      .filter((stepId: string) => {
        const stepResult = stepLookup.get(stepId);
        return !stepResult || stepResult.completed !== true;
      });

    return {
      requiredStepCompletionRate: requiredSteps.length > 0 ? completedRequiredSteps.length / requiredSteps.length : null,
      stepCompletionRate: expectedSteps.length > 0 ? completedSteps.length / expectedSteps.length : null,
      requiredCompletedCount: completedRequiredSteps.length,
      requiredTotalCount: requiredSteps.length,
      completedCount: completedSteps.length,
      totalCount: expectedSteps.length,
      missingRequiredSteps,
      missingNonRequiredSteps,
    };
  }

  function hasWeakStepEvidence(testCase: any, stepLookup: Map<string, any>) {
    const expectedSteps = Array.isArray(testCase && testCase.expectedSteps) ? testCase.expectedSteps : [];
    for (const step of expectedSteps) {
      if (!step || step.required !== true) {
        continue;
      }
      const stepId = String(step.id || '').trim();
      const stepResult = stepLookup.get(stepId);
      if (!stepResult || stepResult.completed !== true) {
        continue;
      }
      if (!Array.isArray(stepResult.evidenceIds) || stepResult.evidenceIds.length === 0) {
        return true;
      }
      const confidence = Number(stepResult.confidence);
      if (Number.isFinite(confidence) && confidence < 0.5) {
        return true;
      }
    }
    return false;
  }

  function buildConstraintCheckLookup(aiJudge: any) {
    const lookup = new Map<string, any>();
    const checks = Array.isArray(aiJudge && aiJudge.constraintChecks) ? aiJudge.constraintChecks : [];
    for (const check of checks) {
      const constraintId = String(check && check.constraintId || '').trim();
      if (!constraintId || lookup.has(constraintId)) {
        continue;
      }
      lookup.set(constraintId, check);
    }
    return lookup;
  }

  function violatesCriticalConstraint(constraintLookup: Map<string, any>, rubric: any) {
    const constraints = Array.isArray(rubric && rubric.criticalConstraints) ? rubric.criticalConstraints : [];
    for (const constraint of constraints) {
      const constraintId = String(constraint && constraint.id || '').trim();
      if (!constraintId) {
        continue;
      }
      const check = constraintLookup.get(constraintId);
      if (!check || check.satisfied !== false) {
        continue;
      }
      if (Array.isArray(check.evidenceIds) && check.evidenceIds.length > 0) {
        return true;
      }
    }
    return false;
  }

  function hasUnknownCriticalConstraintCheck(constraintLookup: Map<string, any>, rubric: any) {
    const constraints = Array.isArray(rubric && rubric.criticalConstraints) ? rubric.criticalConstraints : [];
    for (const constraint of constraints) {
      const constraintId = String(constraint && constraint.id || '').trim();
      if (!constraintId) {
        continue;
      }
      const check = constraintLookup.get(constraintId);
      if (!check || check.satisfied == null) {
        return true;
      }
    }
    return false;
  }

  function hasSupportingMetricWeakness(metrics: any, thresholds: any) {
    const requiredToolCoverageWeak = metrics.requiredToolCoverage != null
      && thresholds.requiredToolCoverage != null
      && metrics.requiredToolCoverage < thresholds.requiredToolCoverage;
    const toolSuccessWeak = metrics.toolCallSuccessRate != null
      && thresholds.toolCallSuccessRate != null
      && metrics.toolCallSuccessRate < thresholds.toolCallSuccessRate;
    const toolErrorWeak = metrics.toolErrorRate != null
      && thresholds.toolErrorRate != null
      && metrics.toolErrorRate > thresholds.toolErrorRate;
    return requiredToolCoverageWeak || toolSuccessWeak || toolErrorWeak;
  }

  function judgeFailIsBackedByObservableEvidence(aiJudge: any, context: any) {
    if (!aiJudge || aiJudge.status !== 'succeeded' || aiJudge.verdictSuggestion !== 'fail') {
      return false;
    }
    if (Array.isArray(context && context.hardFailReasons) && context.hardFailReasons.length > 0) {
      return true;
    }
    if (context && context.missingRequiredStep) {
      return true;
    }
    if (context && context.criticalConstraintViolated) {
      return true;
    }
    if (context && context.goalHardFail) {
      return true;
    }
    if (context && context.instructionHardFail) {
      return true;
    }
    const steps = Array.isArray(aiJudge.steps) ? aiJudge.steps : [];
    return steps.some((step: any) => step && step.completed === false && Array.isArray(step.evidenceIds) && step.evidenceIds.length > 0);
  }

  function aggregateFullVerdict(testCase: any, aiJudge: any, metrics: any, context: any) {
    const sequenceStepIds = Array.isArray(context && context.sequenceStepIds) ? context.sequenceStepIds : [];
    const hasSequenceConstraint = sequenceStepIds.length > 0;
    const rubric = sanitizeEvaluationRubric(testCase && testCase.evaluationRubric);
    const criticalDimensions = Array.isArray(rubric.criticalDimensions)
      ? rubric.criticalDimensions.map((entry: any) => String(entry || '').trim())
      : [];
    const sequenceIsCritical = hasSequenceConstraint && criticalDimensions.includes('sequenceAdherence');
    const hardFailReasons: string[] = [];
    const borderlineReasons: string[] = [];
    const supportingWarnings: string[] = [];

    const missingRequiredStep = Boolean(aiJudge && aiJudge.status === 'succeeded')
      && metrics.requiredStepCompletionRate != null
      && metrics.requiredStepCompletionRate < 1;
    const goalHardFail = metrics.goalAchievement != null
      && context.thresholds.hardFail.goalAchievement != null
      && metrics.goalAchievement < context.thresholds.hardFail.goalAchievement;
    const instructionHardFail = metrics.instructionAdherence != null
      && context.thresholds.hardFail.instructionAdherence != null
      && metrics.instructionAdherence < context.thresholds.hardFail.instructionAdherence;
    const sequenceHardFail = sequenceIsCritical
      && metrics.sequenceAdherence != null
      && context.thresholds.hardFail.sequenceAdherence != null
      && metrics.sequenceAdherence < context.thresholds.hardFail.sequenceAdherence;

    if (missingRequiredStep) {
      hardFailReasons.push('missing-required-step');
    }
    if (goalHardFail) {
      hardFailReasons.push('goal-hard-fail');
    }
    if (instructionHardFail) {
      hardFailReasons.push('instruction-hard-fail');
    }
    if (sequenceHardFail) {
      hardFailReasons.push('critical-sequence-hard-fail');
    }
    if (context.criticalConstraintViolated) {
      hardFailReasons.push('critical-constraint');
    }

    const judgeFailBacked = judgeFailIsBackedByObservableEvidence(aiJudge, {
      hardFailReasons,
      missingRequiredStep,
      criticalConstraintViolated: context.criticalConstraintViolated,
      goalHardFail,
      instructionHardFail,
    });
    if (judgeFailBacked) {
      hardFailReasons.push('judge-backed-hard-fail');
    }

    if (hardFailReasons.length > 0) {
      return {
        verdict: 'fail',
        hardFailReasons: [...new Set(hardFailReasons)],
        borderlineReasons,
        supportingWarnings,
      };
    }

    if (!aiJudge || aiJudge.status !== 'succeeded') {
      borderlineReasons.push('judge-needs-review');
    }
    if (context.unknownCriticalConstraintCheck) {
      borderlineReasons.push('critical-constraint-needs-review');
    }
    if (sequenceIsCritical && metrics.sequenceAdherence == null) {
      borderlineReasons.push('critical-sequence-needs-review');
    }

    const primaryNeedsReview = Boolean(
      (metrics.goalAchievement != null
        && context.thresholds.pass.goalAchievement != null
        && metrics.goalAchievement < context.thresholds.pass.goalAchievement)
      || (metrics.instructionAdherence != null
        && context.thresholds.pass.instructionAdherence != null
        && metrics.instructionAdherence < context.thresholds.pass.instructionAdherence)
      || (hasSequenceConstraint
        && metrics.sequenceAdherence != null
        && context.thresholds.pass.sequenceAdherence != null
        && metrics.sequenceAdherence < context.thresholds.pass.sequenceAdherence)
    );
    if (primaryNeedsReview) {
      borderlineReasons.push('primary-dimension-below-pass-threshold');
    }

    const supportingWeak = hasSupportingMetricWeakness(metrics, context.thresholds.supporting);
    const hasBorderlineSignals = Boolean(
      context.missingNonRequiredStep
      || context.weakEvidence
      || supportingWeak
      || (aiJudge && aiJudge.verdictSuggestion === 'borderline')
      || (aiJudge && aiJudge.verdictSuggestion === 'fail' && !judgeFailBacked)
    );
    if (hasBorderlineSignals) {
      borderlineReasons.push('needs-human-review-or-supporting-signals-weak');
    }
    if (supportingWeak) {
      supportingWarnings.push('supporting-metrics-weak');
    }

    if (borderlineReasons.length > 0) {
      return {
        verdict: 'borderline',
        hardFailReasons,
        borderlineReasons: [...new Set(borderlineReasons)],
        supportingWarnings: [...new Set(supportingWarnings)],
      };
    }

    supportingWarnings.push('primary-dimensions-met');
    return {
      verdict: 'pass',
      hardFailReasons,
      borderlineReasons,
      supportingWarnings: [...new Set(supportingWarnings)],
    };
  }

  async function buildFullModeExecutionEvaluation(skill: any, testCase: any, expectedTools: any[], observedToolCalls: any[], toolCallEvents: any[], _toolChecks: any[], _sequenceCheck: any, evidenceText: string, runtime: any = {}) {
    const toolChecks = Array.isArray(_toolChecks) && _toolChecks.length === expectedTools.length
      ? _toolChecks
      : expectedTools.map((entry: any) => evaluateExpectedToolCall(entry, observedToolCalls));
    const matchedToolChecks = toolChecks.filter((entry: any) => entry && entry.matched);
    const requiredToolCoverage = expectedTools.length > 0 ? matchedToolChecks.length / expectedTools.length : null;
    const successfulMatchedCount = matchedToolChecks.filter((entry: any) => String(entry.actualStatus || '').trim().toLowerCase() !== 'failed').length;
    const toolCallSuccessRate = matchedToolChecks.length > 0 ? successfulMatchedCount / matchedToolChecks.length : null;
    const failedEventCalls = toolCallEvents.filter((entry: any) => String(entry && entry.status || '').trim().toLowerCase() === 'failed');
    const totalObservedCount = toolCallEvents.length > 0 ? toolCallEvents.length : observedToolCalls.length;
    const toolErrorRate = totalObservedCount > 0 ? failedEventCalls.length / totalObservedCount : null;
    const missingTools = toolChecks.filter((entry: any) => !entry.matched).map((entry: any) => entry.name);
    const expectedToolNames = [...new Set(expectedTools.map((entry: any) => entry.name).filter(Boolean))];
    const unexpectedTools = [...new Set(observedToolCalls.map((entry: any) => entry.toolName).filter(Boolean))]
      .filter((toolName) => !expectedToolNames.some((expectedName) => toolNamesMatch(expectedName, toolName)));
    const failedCalls = failedEventCalls.map((entry: any) => ({
      tool: String(entry && entry.tool || '').trim() || 'unknown',
      reason: String(entry && entry.error && entry.error.message || 'tool call failed').trim(),
    }));

    const sequenceDiagnostics = isPlainObject(runtime && runtime.sequenceDiagnostics)
      ? runtime.sequenceDiagnostics
      : buildExpectedSequenceSpecsWithDiagnostics(testCase, expectedTools);
    const sequenceEvidenceIssues = buildCriticalSequenceEvidenceIssues(
      testCase,
      Array.isArray(sequenceDiagnostics && sequenceDiagnostics.specs) ? sequenceDiagnostics.specs : [],
      Array.isArray(sequenceDiagnostics && sequenceDiagnostics.unresolvedStepIds)
        ? sequenceDiagnostics.unresolvedStepIds
        : []
    );

    const rawAiJudge = await runFullModeExecutionAiJudge(
      skill,
      testCase,
      [...new Set(observedToolCalls.map((entry: any) => entry.toolName).filter(Boolean))],
      failedCalls,
      evidenceText,
      runtime
    );
    const validatedJudge = validateJudgeOutput(rawAiJudge, testCase, runtime && runtime.timelineIds);
    const aiJudge = validatedJudge && validatedJudge.judge ? validatedJudge.judge : rawAiJudge;

    const timelineOrderLookup = buildTimelineOrderLookup(runtime && runtime.timelineIds);
    const sequenceStepIds = getSequenceConstraintStepIds(testCase);
    const stepLookup = buildJudgeStepLookup(aiJudge);
    const rawStepMetrics = calculateStepCompletionMetrics(testCase, stepLookup);
    const stepMetrics = aiJudge && aiJudge.status === 'succeeded'
      ? rawStepMetrics
      : {
        ...rawStepMetrics,
        requiredStepCompletionRate: null,
        stepCompletionRate: null,
        missingRequiredSteps: [],
        missingNonRequiredSteps: [],
      };
    const sequenceMetrics = calculateSequenceAdherenceFromEvidence(sequenceStepIds, stepLookup, timelineOrderLookup);
    const sequenceAdherence = sequenceMetrics.score;

    const goalAchievement = aiJudge && aiJudge.goalAchievement && aiJudge.goalAchievement.score != null
      ? Number(aiJudge.goalAchievement.score)
      : null;
    const instructionAdherence = aiJudge && aiJudge.instructionAdherence && aiJudge.instructionAdherence.score != null
      ? Number(aiJudge.instructionAdherence.score)
      : null;

    const thresholds = getFullModeThresholds(testCase, sequenceStepIds.length > 0);
    const rubric = sanitizeEvaluationRubric(testCase && testCase.evaluationRubric);
    const constraintLookup = buildConstraintCheckLookup(aiJudge);
    const criticalConstraintViolated = violatesCriticalConstraint(constraintLookup, rubric);
    const unknownCriticalConstraintCheck = hasUnknownCriticalConstraintCheck(constraintLookup, rubric);
    const weakEvidence = hasWeakStepEvidence(testCase, stepLookup)
      || mergeValidationIssues(validatedJudge && validatedJudge.issues).some((issue: any) =>
        issue && (issue.code === 'judge_unknown_evidence_id' || issue.code === 'judge_unknown_signal_id'));
    const missingNonRequiredStep = Array.isArray(stepMetrics.missingNonRequiredSteps) && stepMetrics.missingNonRequiredSteps.length > 0;
    const runtimeSequenceIssues = sequenceStepIds.length > 0
      && sequenceAdherence == null
      && Array.isArray(rubric.criticalDimensions)
      && rubric.criticalDimensions.map((entry: any) => String(entry || '').trim()).includes('sequenceAdherence')
      ? [
        buildValidationIssue(
          'critical_sequence_evidence_unavailable',
          'needs-review',
          'evaluation.sequenceAdherence',
          'sequenceAdherence is critical, but evidenceIds were insufficient to compute sequence order'
        ),
      ]
      : [];

    const judgeValidationIssues = mergeValidationIssues(
      getExecutionJudgeValidationIssues(aiJudge),
      validatedJudge && validatedJudge.issues ? validatedJudge.issues : [],
      sequenceEvidenceIssues,
      runtimeSequenceIssues
    );

    const aggregated = aggregateFullVerdict(testCase, aiJudge, {
      requiredStepCompletionRate: stepMetrics.requiredStepCompletionRate,
      stepCompletionRate: stepMetrics.stepCompletionRate,
      sequenceAdherence,
      goalAchievement,
      instructionAdherence,
      requiredToolCoverage,
      toolCallSuccessRate,
      toolErrorRate,
    }, {
      thresholds,
      sequenceStepIds,
      criticalConstraintViolated,
      unknownCriticalConstraintCheck,
      weakEvidence,
      missingNonRequiredStep,
    });

    return {
      verdict: aggregated.verdict,
      summary: String(aiJudge && aiJudge.summary || '').trim()
        || (aggregated.verdict === 'pass' ? '本次 full mode 执行整体达标。' : '本次 full mode 执行存在需要人工复核的偏差。'),
      dimensions: {
        requiredStepCompletionRate: {
          score: roundMetric(stepMetrics.requiredStepCompletionRate),
          reason: stepMetrics.requiredTotalCount > 0
            ? `required 步骤完成 ${stepMetrics.requiredCompletedCount} / ${stepMetrics.requiredTotalCount}`
            : '未配置 required 步骤。',
        },
        stepCompletionRate: {
          score: roundMetric(stepMetrics.stepCompletionRate),
          reason: stepMetrics.totalCount > 0
            ? `步骤完成 ${stepMetrics.completedCount} / ${stepMetrics.totalCount}`
            : '未配置 expectedSteps。',
        },
        requiredToolCoverage: {
          score: roundMetric(requiredToolCoverage),
          reason: missingTools.length > 0 ? `缺少工具：${missingTools.join(' / ')}` : '必需工具槽位已覆盖。',
        },
        toolCallSuccessRate: {
          score: roundMetric(toolCallSuccessRate),
          reason: matchedToolChecks.length > 0 ? `成功 ${successfulMatchedCount} / ${matchedToolChecks.length}` : '没有命中任何必需工具槽位。',
        },
        toolErrorRate: {
          score: roundMetric(toolErrorRate),
          reason: totalObservedCount > 0 ? `失败调用 ${failedEventCalls.length} / ${totalObservedCount}` : '没有工具调用。',
        },
        sequenceAdherence: {
          score: roundMetric(sequenceAdherence),
          reason: sequenceMetrics.reason,
        },
        goalAchievement: {
          score: roundMetric(goalAchievement),
          reason: aiJudge && aiJudge.goalAchievement && aiJudge.goalAchievement.reason
            ? aiJudge.goalAchievement.reason
            : 'AI judge 未提供目标达成说明。',
        },
        instructionAdherence: {
          score: roundMetric(instructionAdherence),
          reason: aiJudge && aiJudge.instructionAdherence && aiJudge.instructionAdherence.reason
            ? aiJudge.instructionAdherence.reason
            : 'AI judge 未提供行为符合度说明。',
        },
      },
      aggregation: {
        hardFailReasons: aggregated.hardFailReasons,
        borderlineReasons: aggregated.borderlineReasons,
        supportingWarnings: aggregated.supportingWarnings,
      },
      aiJudge,
      steps: Array.isArray(aiJudge && aiJudge.steps) ? aiJudge.steps : [],
      constraintChecks: Array.isArray(aiJudge && aiJudge.constraintChecks) ? aiJudge.constraintChecks : [],
      missingSteps: {
        required: stepMetrics.missingRequiredSteps,
        nonRequired: stepMetrics.missingNonRequiredSteps,
      },
      missingTools,
      unexpectedTools,
      failedCalls,
      validation: {
        issues: judgeValidationIssues,
      },
    };
  }

  function getArgumentPathState(value: any, pathExpression: string) {
    const segments = String(pathExpression || '').split('.').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) {
      return { found: false, value: undefined };
    }

    let current = value;
    for (const segment of segments) {
      if (Array.isArray(current) && /^\d+$/.test(segment)) {
        current = current[Number(segment)];
      } else if (current != null && (typeof current === 'object' || Array.isArray(current))) {
        current = current[segment as keyof typeof current];
      } else {
        return { found: false, value: undefined };
      }

      if (current === undefined) {
        return { found: false, value: undefined };
      }
    }

    return { found: true, value: current };
  }

  function matchesArgumentPattern(expected: any, actual: any): boolean {
    if (typeof expected === 'string') {
      const expectedText = expected.trim();
      const normalized = expectedText.toLowerCase();
      if (normalized === '<any>') {
        return actual !== undefined;
      }
      if (normalized === '<string>') {
        return typeof actual === 'string' && actual.trim().length > 0;
      }
      if (normalized === '<number>') {
        return typeof actual === 'number' && Number.isFinite(actual);
      }
      if (normalized === '<boolean>') {
        return typeof actual === 'boolean';
      }
      if (normalized === '<array>') {
        return Array.isArray(actual);
      }
      if (normalized === '<object>') {
        return isPlainObject(actual);
      }
      if (normalized.startsWith('<contains:') && normalized.endsWith('>')) {
        if (typeof actual !== 'string') {
          return false;
        }
        const needle = expectedText.slice('<contains:'.length, -1).trim().toLowerCase();
        const normalizedNeedle = normalizeContainsComparableText(expectedText.slice('<contains:'.length, -1));
        return (needle.length > 0 && actual.toLowerCase().includes(needle))
          || (normalizedNeedle.length > 0 && normalizeContainsComparableText(actual).includes(normalizedNeedle));
      }
      return actual === expectedText;
    }

    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length < expected.length) {
        return false;
      }
      return expected.every((item, index) => matchesArgumentPattern(item, actual[index]));
    }

    if (isPlainObject(expected)) {
      if (!isPlainObject(actual)) {
        return false;
      }
      return Object.entries(expected).every(([key, value]) => matchesArgumentPattern(value, actual[key]));
    }

    return Object.is(expected, actual);
  }

  function evaluateExpectedToolCall(spec: any, observedToolCalls: any[]) {
    const matchingCalls = observedToolCalls.filter((entry) => toolNamesMatch(spec && spec.name, entry && entry.toolName));
    const hasParameterExpectation = Boolean(spec && spec.hasParameterExpectation);
    const fallbackCall = matchingCalls.length > 0 ? matchingCalls[0] : null;
    const fallbackArguments = fallbackCall ? fallbackCall.arguments : null;
    const baseResult: any = {
      name: spec.name,
      order: spec.order != null ? spec.order : null,
      matched: false,
      matchedByName: matchingCalls.length > 0,
      callCount: matchingCalls.length,
      hasParameterExpectation,
      requiredParams: spec.requiredParams || [],
      expectedArguments: spec.hasArgumentShape ? spec.arguments : null,
      missingParams: [],
      argumentShapePassed: spec.hasArgumentShape ? false : null,
      parameterPassed: hasParameterExpectation ? false : null,
      actualArguments: fallbackArguments,
      matchedCallIndex: fallbackCall && fallbackCall.orderIndex != null ? fallbackCall.orderIndex : null,
      matchedSource: fallbackCall && fallbackCall.source ? fallbackCall.source : '',
      actualStatus: fallbackCall && fallbackCall.status ? String(fallbackCall.status) : '',
    };

    if (matchingCalls.length === 0) {
      return baseResult;
    }

    if (!hasParameterExpectation) {
      return {
        ...baseResult,
        matched: true,
        parameterPassed: null,
      };
    }

    for (const call of matchingCalls) {
      const actualArguments = call && hasOwn(call, 'arguments') ? call.arguments : undefined;
      const missingParams = (spec.requiredParams || []).filter((pathValue: string) => {
        const state = getArgumentPathState(actualArguments, pathValue);
        return !state.found;
      });
      const argumentShapePassed = spec.hasArgumentShape
        ? matchesArgumentPattern(spec.arguments, actualArguments)
        : true;

      if (missingParams.length === 0 && argumentShapePassed) {
        return {
          ...baseResult,
          matched: true,
          parameterPassed: true,
          missingParams: [],
          argumentShapePassed,
          actualArguments,
          matchedCallIndex: call && call.orderIndex != null ? call.orderIndex : null,
          matchedSource: call && call.source ? call.source : '',
          actualStatus: call && call.status ? String(call.status) : '',
        };
      }

      if (!baseResult.matched) {
        baseResult.missingParams = missingParams;
        baseResult.argumentShapePassed = spec.hasArgumentShape ? argumentShapePassed : null;
        baseResult.actualArguments = actualArguments;
        baseResult.matchedCallIndex = call && call.orderIndex != null ? call.orderIndex : null;
        baseResult.matchedSource = call && call.source ? call.source : '';
        baseResult.actualStatus = call && call.status ? String(call.status) : '';
      }
    }

    return baseResult;
  }

  const INFERRED_SESSION_TOOL_SEQUENCE_NAMES = [
    'send-public',
    'send-private',
    'read-context',
    'list-participants',
    'trellis-init',
    'trellis-write',
  ];

  function inferSequenceToolNameFromSessionCall(toolCall: any) {
    const toolName = String(toolCall && toolCall.toolName || '').trim();
    if (!toolName) {
      return '';
    }

    if (toolName !== 'bash') {
      return '';
    }

    const command = String(toolCall && toolCall.arguments && toolCall.arguments.command || '').trim().toLowerCase();
    if (!command) {
      return '';
    }

    for (const candidate of INFERRED_SESSION_TOOL_SEQUENCE_NAMES) {
      if (command.includes(candidate)) {
        return candidate;
      }
    }

    return '';
  }

  function buildObservedSequenceCalls(toolCallEvents: any[], sessionToolCalls: any[]) {
    const buildSequenceCalls = (entries: any[], sourceBuilder: (entry: any) => any[]) => {
      const sequenceCalls: any[] = [];
      const pushSequenceCall = (toolName: any, source: string) => {
        const normalizedToolName = String(toolName || '').trim();
        if (!normalizedToolName) {
          return;
        }
        sequenceCalls.push({
          toolName: normalizedToolName,
          source,
          orderIndex: sequenceCalls.length,
        });
      };

      for (const entry of entries) {
        for (const item of sourceBuilder(entry)) {
          pushSequenceCall(item.toolName, item.source);
        }
      }

      return sequenceCalls;
    };

    const sessionSequenceCalls = buildSequenceCalls(sessionToolCalls, (toolCall) => {
      const calls: any[] = [];
      const actualToolName = String(toolCall && toolCall.toolName || '').trim();
      if (actualToolName) {
        calls.push({ toolName: actualToolName, source: 'session' });
      }
      const inferredToolName = inferSequenceToolNameFromSessionCall(toolCall);
      if (inferredToolName && inferredToolName !== actualToolName) {
        calls.push({ toolName: inferredToolName, source: 'session-inferred' });
      }
      return calls;
    });

    if (sessionSequenceCalls.length > 0) {
      return sessionSequenceCalls;
    }

    return buildSequenceCalls(toolCallEvents, (event) => [
      { toolName: event && event.tool, source: 'event' },
    ]);
  }

  function evaluateToolSequence(expectedSequenceSpecs: any[], observedSequenceCalls: any[]) {
    const orderedSpecs = Array.isArray(expectedSequenceSpecs)
      ? expectedSequenceSpecs
        .filter((entry: any) => entry && entry.name)
        .slice()
        .sort((a: any, b: any) => {
          const orderDelta = Number(a.order || 0) - Number(b.order || 0);
          return orderDelta || Number(a.sourceOrder || 0) - Number(b.sourceOrder || 0);
        })
      : [];

    if (orderedSpecs.length === 0) {
      return {
        enabled: false,
        orderedExpectedCount: 0,
        matchedCount: 0,
        passed: null,
        skipped: false,
        observedTools: observedSequenceCalls.map((entry: any) => entry.toolName),
        steps: [],
      };
    }

    let cursor = 0;
    let matchedCount = 0;
    const steps: any[] = [];

    for (const spec of orderedSpecs) {
      const expectedAfterIndex = cursor;
      let matchedCallIndex = -1;
      let observedCallCount = 0;
      let firstObservedIndex = -1;

      for (let index = 0; index < observedSequenceCalls.length; index += 1) {
        const call = observedSequenceCalls[index];
        if (!call || !toolNamesMatch(spec.name, call.toolName)) {
          continue;
        }
        observedCallCount += 1;
        if (firstObservedIndex === -1) {
          firstObservedIndex = index;
        }
        if (matchedCallIndex === -1 && index >= cursor) {
          matchedCallIndex = index;
        }
      }

      const matched = matchedCallIndex >= 0;
      if (matched) {
        matchedCount += 1;
        cursor = matchedCallIndex + 1;
      }

      steps.push({
        name: spec.name,
        order: spec.order != null ? spec.order : null,
        matched,
        outOfOrder: !matched && firstObservedIndex !== -1 && firstObservedIndex < expectedAfterIndex,
        matchedCallIndex: matched ? matchedCallIndex : null,
        observedCallCount,
        source: matched ? observedSequenceCalls[matchedCallIndex].source : '',
      });
    }

    return {
      enabled: true,
      orderedExpectedCount: orderedSpecs.length,
      matchedCount,
      passed: matchedCount === orderedSpecs.length,
      skipped: false,
      observedTools: observedSequenceCalls.map((entry: any) => entry.toolName),
      steps,
    };
  }

  async function evaluateRun(taskId: string, testCase: any, runtime: any = {}) {
    const toolCallEvents = collectToolCallsFromTask(taskId);
    const expectedTools = normalizeExpectedToolSpecs(testCase.expectedTools);
    const skillId = String(testCase.skillId || '').trim();
    const loadingMode = String(testCase.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
    const skill = skillRegistry ? skillRegistry.getSkill(skillId) : null;
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

    const sessionPath = String(runtime.sessionPath || '').trim() || getSessionPathForTask(taskId);
    const sessionSnapshot = sessionPath ? readSessionAssistantSnapshot(sessionPath) : null;
    const sessionToolCalls = parseToolCallsFromSession(sessionPath);

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

  async function executeRun(testCase: any, runOptions: any = {}) {
    ensureSchema();

    if (!agentToolBridge) {
      throw createHttpError(501, 'Agent tool bridge is not configured');
    }

    const preflight = normalizeCaseForRunOrThrow(testCase);
    testCase = { ...testCase, ...preflight.normalizedCase, derivedFromLegacy: preflight.derivedFromLegacy };

    const prompt = getCanonicalCasePrompt(testCase);
    if (!prompt) {
      throw createHttpError(400, 'Test case has no trigger prompt');
    }

    const skill = skillRegistry ? skillRegistry.getSkill(testCase.skillId) : null;
    const agentId = String(runOptions.agentId || 'skill-test-agent').trim();
    const agentName = String(runOptions.agentName || 'Skill Test Agent').trim();
    const provider = String(runOptions.provider || '').trim();
    const model = String(runOptions.model || '').trim();
    const promptVersion = String(runOptions.promptVersion || '').trim() || 'skill-test-v1';

    // Create or reuse eval_case for this test case
    // Only create a new one if the test case doesn't already have one
    let evalCaseId = testCase.evalCaseId;
    const timestamp = nowIso();

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
          conversationId: `skill-test-${testCase.skillId}`,
          turnId: `skill-test-turn-${testCase.id}`,
          messageId: '',
          stageTaskId: '',
          agentId,
          agentName,
          provider: provider || null,
          model: model || null,
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

      // Update test case with eval_case_id (only when newly created)
      store.db
        .prepare('UPDATE skill_test_cases SET eval_case_id = @evalCaseId, updated_at = @updatedAt WHERE id = @id')
        .run({ id: testCase.id, evalCaseId, updatedAt: timestamp });
    }

    // Set up run infrastructure
    const agent = { id: agentId, name: agentName };
    const sandbox = ensureAgentSandbox(store.agentDir, agent);
    const projectDir = getProjectDir ? String(getProjectDir() || '').trim() : '';
    const runStore = createSqliteRunStore({ agentDir: store.agentDir, sqlitePath: store.databasePath });
    const taskId = `skill-test-run-${randomUUID()}`;
    const stage = { taskId, status: 'queued', runId: null as any };
    const sessionName = `skill-test-${testCase.id}-${Date.now()}`;

    let toolInvocation: any = null;

    try {
      const promptUserMessage = {
        id: 'skill-test-user',
        turnId: `skill-test-turn-${testCase.id}`,
        role: 'user',
        senderName: 'TestUser',
        content: prompt,
        status: 'completed',
        createdAt: timestamp,
      };

      toolInvocation = agentToolBridge.registerInvocation(
        agentToolBridge.createInvocationContext({
          conversationId: `skill-test-${testCase.skillId}`,
          turnId: `skill-test-turn-${testCase.id}`,
          projectDir,
          agentId,
          agentName,
          assistantMessageId: '',
          userMessageId: promptUserMessage.id,
          promptUserMessage,
          conversationAgents: [agent],
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

      runStore.createTask({
        taskId,
        kind: 'skill_test_run',
        title: `Skill test: ${testCase.skillId}`,
        status: 'queued',
        assignedAgent: 'pi',
        assignedRole: agentName,
        provider: provider || null,
        model: model || null,
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
        },
        startedAt: timestamp,
      });

      let result: any = null;
      let outputText = '';
      let status = 'succeeded';
      let errorMessage = '';
      let runId: any = null;
      let sessionPath = '';

      try {
        const handle = startRunImpl(provider || '', model || '', prompt, {
          thinking: '',
          agentDir: store.agentDir,
          sqlitePath: store.databasePath,
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
          extraEnv: {
            PI_AGENT_ID: agentId,
            PI_AGENT_NAME: agentName,
            PI_AGENT_SANDBOX_DIR: sandbox.sandboxDir,
            PI_AGENT_PRIVATE_DIR: sandbox.privateDir,
            CAFF_CHAT_API_URL: toolBaseUrl,
            CAFF_CHAT_INVOCATION_ID: toolInvocation.invocationId,
            CAFF_CHAT_CALLBACK_TOKEN: toolInvocation.callbackToken,
            CAFF_CHAT_TOOLS_PATH: toPortableShellPath(agentToolScriptPath),
            CAFF_CHAT_TOOLS_RELATIVE_PATH: agentToolRelativePath,
            CAFF_CHAT_CONVERSATION_ID: `skill-test-${testCase.skillId}`,
            CAFF_CHAT_TURN_ID: `skill-test-turn-${testCase.id}`,
            CAFF_SKILL_LOADING_MODE: testCase.loadingMode || 'dynamic',
          },
        });

        stage.runId = handle.runId || null;
        stage.status = 'running';
        sessionPath = handle.sessionPath || '';

        runStore.updateTask(taskId, {
          status: 'running',
          runId: normalizeRunStoreRunId(handle.runId),
          requestedSession: sessionName,
          sessionPath: handle.sessionPath || null,
        });

        result = await handle.resultPromise;
        runId = result && result.runId ? result.runId : handle.runId || null;
        sessionPath = (result && result.sessionPath) || sessionPath;
        outputText = String(result.reply || '');
        status = 'succeeded';
      } catch (error) {
        const err: any = error;
        status = 'failed';
        errorMessage = err && err.message ? String(err.message) : String(err || 'Unknown error');
      } finally {
        stage.status = status === 'succeeded' ? 'completed' : 'failed';
        if (toolInvocation) {
          agentToolBridge.unregisterInvocation(toolInvocation.invocationId);
        }
      }

      // Evaluate results
      const evaluation = status === 'succeeded'
        ? await Promise.resolve(
          evaluateRunImpl
            ? evaluateRunImpl(taskId, testCase, {
              outputText,
              sessionPath,
              status,
              provider,
              model,
              promptVersion,
              agentId,
              agentName,
              taskId,
              prompt,
              sandbox,
            })
            : evaluateRun(taskId, testCase, {
              outputText,
              sessionPath,
              status,
              provider,
              model,
              promptVersion,
              agentId,
              agentName,
              taskId,
              prompt,
              sandbox,
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

      const runValidation = {
        caseSchemaStatus: preflight.caseSchemaStatus,
        derivedFromLegacy: preflight.derivedFromLegacy,
        issues: mergeValidationIssues(evaluation.validationIssues, preflight.issues),
      };
      const evaluationJsonPayload = isPlainObject(evaluation.evaluation)
        ? { ...evaluation.evaluation, validation: runValidation }
        : { validation: runValidation };
      const finishedAt = nowIso();

      // Update task
      runStore.updateTask(taskId, {
        status: status === 'succeeded' ? 'succeeded' : 'failed',
        runId: normalizeRunStoreRunId(runId),
        sessionPath: sessionPath || null,
        outputText: outputText || '',
        errorMessage: errorMessage || '',
        endedAt: finishedAt,
      });

      // Create eval_case_run
      const evalCaseRunId = randomUUID();
      const runResult = {
        status,
        promptVersion,
        triggerPassed: evaluation.triggerPassed,
        executionPassed: evaluation.executionPassed,
        toolAccuracy: evaluation.toolAccuracy,
        actualTools: safeJsonParse(evaluation.actualToolsJson) || [],
        triggerEvaluation: evaluation.triggerEvaluation || null,
        executionEvaluation: evaluation.executionEvaluation || null,
        evaluation: evaluation.evaluation || null,
        validation: runValidation,
        verdict: evaluation.verdict || '',
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
          provider: provider || null,
          model: model || null,
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

      // Create skill_test_run
      const testRunId = randomUUID();
      store.db
        .prepare(
          `INSERT INTO skill_test_runs (
            id, test_case_id, eval_case_run_id, status,
            actual_tools_json, tool_accuracy, trigger_passed, execution_passed,
            required_step_completion_rate, step_completion_rate,
            required_tool_coverage, tool_call_success_rate, tool_error_rate,
            sequence_adherence, goal_achievement, instruction_adherence,
            verdict, evaluation_json, error_message, created_at
          ) VALUES (
            @id, @testCaseId, @evalCaseRunId, @status,
            @actualToolsJson, @toolAccuracy, @triggerPassed, @executionPassed,
            @requiredStepCompletionRate, @stepCompletionRate,
            @requiredToolCoverage, @toolCallSuccessRate, @toolErrorRate,
            @sequenceAdherence, @goalAchievement, @instructionAdherence,
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
          verdict: evaluation.verdict || '',
          evaluationJson: JSON.stringify(evaluationJsonPayload),
          errorMessage: errorMessage || '',
          createdAt: finishedAt,
        });

      store.db
        .prepare(
          'UPDATE skill_test_cases SET validity_status = @validityStatus, updated_at = @updatedAt WHERE id = @id'
        )
        .run({ id: testCase.id, validityStatus: getCaseValidityAfterEvaluation(testCase, evaluation), updatedAt: finishedAt });

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
      runStore.close();
    }
  }

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
      for (const metric of SKILL_TEST_SUMMARY_AVERAGE_METRICS) {
        bucket._metricSums[metric.key] = Number(bucket._metricSums[metric.key] || 0) + Number(row[metric.sumColumn] || 0);
        bucket._metricCounts[metric.key] = Number(bucket._metricCounts[metric.key] || 0) + Number(row[metric.countColumn] || 0);
      }
    }

    for (const entry of Object.values(summary) as any[]) {
      entry.triggerRate = entry.totalRuns > 0 ? entry.triggerPassedCount / entry.totalRuns : null;
      entry.executionRate = entry.totalRuns > 0 ? entry.executionPassedCount / entry.totalRuns : null;
      for (const metric of SKILL_TEST_SUMMARY_AVERAGE_METRICS) {
        const metricCount = Number(entry._metricCounts[metric.key] || 0);
        entry[metric.key] = metricCount > 0 ? Number(entry._metricSums[metric.key] || 0) / metricCount : 0;
      }
      delete entry._metricSums;
      delete entry._metricCounts;
    }

    return Object.values(summary);
  }

  return async function handleSkillTestRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    // ---- Global summary ----
    if (req.method === 'GET' && pathname === '/api/skill-test-summary') {
      sendJson(res, 200, { summary: getSkillTestSummary() });
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

        const body = await readRequestJson(req).catch(() => ({}));
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

        const body = await readRequestJson(req).catch(() => ({}));
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

          const body = await readRequestJson(req).catch(() => ({}));
          const result = await executeRun(testCase, {
            provider: body.provider,
            model: body.model,
            promptVersion: body.promptVersion,
            agentId: body.agentId,
            agentName: body.agentName,
          });
          sendJson(res, 200, result);
          return true;
        }

        // PATCH /api/skills/:skillId/test-cases/:caseId
        if (req.method === 'PATCH' && !action) {
          requireSkillScopedTestCase();
          const body = await readRequestJson(req).catch(() => ({}));
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
          store.db.prepare('DELETE FROM skill_test_runs WHERE test_case_id = @id').run({ id: caseId });
          store.db.prepare('DELETE FROM skill_test_cases WHERE id = @id').run({ id: caseId });
          sendJson(res, 200, { deletedId: caseId });
          return true;
        }
      }
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

    // ---- Single run detail: /api/skill-test-runs/:runId ----
    const runDetailMatch = pathname.match(/^\/api\/skill-test-runs\/([^/]+)$/);
    if (runDetailMatch && req.method === 'GET') {
      ensureSchema();
      const runId = decodeURIComponent(runDetailMatch[1]);
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
      const debug = getSkillTestRunDebug(run);
      const result = safeJsonParse(row && row.result_json);
      sendJson(res, 200, { run, debug, result });
      return true;
    }

    return false;
  };
}
