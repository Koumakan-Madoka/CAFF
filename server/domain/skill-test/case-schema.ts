import { createHttpError } from '../../http/http-errors';
import { normalizeEnvironmentConfigInput } from './environment-chain';
import { getCanonicalCasePrompt } from './run-prompt';

export function isPlainObject(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizePathForJson(value: any) {
  return String(value || '').trim().replace(/\\/g, '/');
}

export function hasOwn(value: any, key: string) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizePromptText(value: any) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

export const FULL_CASE_MAX_EXPECTED_STEPS = 12;
export const STEP_SIGNAL_MAX_COUNT = 5;
export const ALLOWED_SIGNAL_TYPES = new Set(['tool', 'text', 'state']);
export const ALLOWED_SIGNAL_MATCHERS = new Set(['contains', 'equals', 'regex']);
export const ALLOWED_CRITICAL_DIMENSIONS = new Set(['sequenceAdherence']);
export const THRESHOLD_DIMENSION_KEYS = [
  'requiredToolCoverage',
  'toolCallSuccessRate',
  'goalAchievement',
  'instructionAdherence',
  'sequenceAdherence',
  'toolErrorRate',
];
export const DEFAULT_SKILL_TEST_BRIDGE_TOKEN_TTL_SECONDS = 600;

export function buildValidationIssue(code: string, severity: 'error' | 'warning' | 'needs-review', path: string, message: string) {
  return { code, severity, path, message };
}

export function mergeValidationIssues(...groups: any[]) {
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

export function hasBlockingValidationIssue(issues: any[]) {
  return Array.isArray(issues) && issues.some((issue) => issue && issue.severity === 'error');
}


export function createValidationHttpError(issueOrIssues: any, fallbackMessage?: string, extraDetails: any = {}) {
  const issues = mergeValidationIssues(Array.isArray(issueOrIssues) ? issueOrIssues : [issueOrIssues]);
  const firstMessage = issues[0] && issues[0].message ? String(issues[0].message) : '';
  return createHttpError(400, fallbackMessage || firstMessage || 'Validation failed', {
    issues,
    ...(extraDetails && typeof extraDetails === 'object' ? extraDetails : {}),
  });
}


export function slugifyValidationId(value: any, fallback: string) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

export function normalizeBooleanFlag(value: any, fallback = true) {
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

export function normalizePositiveInteger(value: any) {
  if (value == null || value === '') {
    return null;
  }
  const normalized = typeof value === 'string'
    ? Number.parseInt(value, 10)
    : Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

export function clipSkillTestText(value: any, maxLength = 240) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

export function normalizeMatcherName(value: any) {
  const normalized = String(value || '').trim().toLowerCase();
  return ALLOWED_SIGNAL_MATCHERS.has(normalized) ? normalized : '';
}

export function parseExpectedToolOrder(value: any) {
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

export function sanitizeExpectedToolSpecEntry(value: any) {
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

export function sanitizeExpectedToolSpecs(value: any) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => sanitizeExpectedToolSpecEntry(entry))
    .filter(Boolean);
}

const TOOL_NAME_MATCH_ALIASES: Record<string, string> = {
  participants: 'list-participants',
};

export function normalizeToolNameForMatch(value: any) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return TOOL_NAME_MATCH_ALIASES[normalized.toLowerCase()] || normalized;
}

export function toolNamesMatch(expectedName: any, actualName: any) {
  return normalizeToolNameForMatch(expectedName) === normalizeToolNameForMatch(actualName);
}

export function normalizeContainsComparableText(value: any) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

export function normalizeExpectedToolSpecs(value: any) {
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

export function normalizeToolPathForMatch(value: any) {
  return String(value || '').replace(/\\/g, '/').trim();
}

export function formatSkillMarkdownPathForMatch(skillPath: any) {
  const normalizedPath = normalizeToolPathForMatch(skillPath).replace(/\/+$/g, '');
  if (!normalizedPath) {
    return '';
  }
  return /\/skill\.md$/i.test(normalizedPath) ? normalizedPath : `${normalizedPath}/SKILL.md`;
}

export function getReadToolPath(argumentsValue: any) {
  if (!argumentsValue || typeof argumentsValue !== 'object') {
    return '';
  }
  return normalizeToolPathForMatch(argumentsValue.path || argumentsValue.file || '');
}

export function isSkillMarkdownReadPath(pathValue: any, skillId: any, skillPath?: any) {
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

export function isTargetSkillReadToolCall(toolName: any, argumentsValue: any, skillId: any, skillPath?: any) {
  const normalizedToolName = String(toolName || '').trim();
  if (normalizedToolName === 'read') {
    return isSkillMarkdownReadPath(getReadToolPath(argumentsValue), skillId, skillPath);
  }

  return false;
}

export function normalizeStoredCaseStatus(value: any) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'draft' || normalized === 'ready' || normalized === 'archived') {
    return normalized;
  }
  return '';
}

export function resolveCaseStatus(row: any) {
  const explicit = normalizeStoredCaseStatus(row && row.case_status);
  return explicit || 'draft';
}

export function buildEffectiveCaseStatusSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const caseStatusExpr = `LOWER(TRIM(COALESCE(${prefix}case_status, '')))`;
  return `CASE
    WHEN ${caseStatusExpr} = 'ready' THEN 'ready'
    WHEN ${caseStatusExpr} = 'archived' THEN 'archived'
    WHEN ${caseStatusExpr} = 'draft' THEN 'draft'
    ELSE 'draft'
  END`;
}

export function buildEffectiveExecutionPassedSql(caseAlias = 'c', runAlias = 'r') {
  const casePrefix = caseAlias ? `${caseAlias}.` : '';
  const runPrefix = runAlias ? `${runAlias}.` : '';
  const loadingModeExpr = `LOWER(TRIM(COALESCE(${casePrefix}loading_mode, '')))`;
  const verdictExpr = `LOWER(TRIM(COALESCE(${runPrefix}verdict, '')))`;
  return `CASE
    WHEN ${runPrefix}id IS NULL THEN 0
    WHEN ${loadingModeExpr} != 'full' THEN 0
    WHEN ${verdictExpr} != '' THEN CASE WHEN ${verdictExpr} = 'pass' THEN 1 ELSE 0 END
    WHEN ${runPrefix}execution_passed = 1 THEN 1
    ELSE 0
  END`;
}

export function buildExecutionRateEligibleRunSql(caseAlias = 'c', runAlias = 'r') {
  const casePrefix = caseAlias ? `${caseAlias}.` : '';
  const runPrefix = runAlias ? `${runAlias}.` : '';
  const loadingModeExpr = `LOWER(TRIM(COALESCE(${casePrefix}loading_mode, '')))`;
  return `CASE
    WHEN ${runPrefix}id IS NULL THEN 0
    WHEN ${loadingModeExpr} = 'full' THEN 1
    ELSE 0
  END`;
}

export const SKILL_TEST_SUMMARY_AVERAGE_METRICS = [
  { key: 'avgToolAccuracy', sumColumn: 'sum_tool_accuracy', countColumn: 'tool_accuracy_count' },
  { key: 'avgRequiredStepCompletionRate', sumColumn: 'sum_required_step_completion_rate', countColumn: 'required_step_completion_rate_count' },
  { key: 'avgStepCompletionRate', sumColumn: 'sum_step_completion_rate', countColumn: 'step_completion_rate_count' },
  { key: 'avgGoalAchievement', sumColumn: 'sum_goal_achievement', countColumn: 'goal_achievement_count' },
  { key: 'avgToolCallSuccessRate', sumColumn: 'sum_tool_call_success_rate', countColumn: 'tool_call_success_rate_count' },
];

export function resolveTestTypeForLoadingMode(loadingMode: any, testType?: any) {
  const normalizedLoadingMode = String(loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
  const normalizedTestType = String(testType || '').trim().toLowerCase();
  if (normalizedTestType === 'trigger' || normalizedTestType === 'execution' || normalizedTestType === 'environment-build') {
    return normalizedTestType;
  }
  return normalizedLoadingMode === 'full' ? 'execution' : 'trigger';
}

export function mapCaseStatusToLegacyValidity(caseStatus: string) {
  if (caseStatus === 'ready') {
    return 'validated';
  }
  if (caseStatus === 'archived') {
    return 'archived';
  }
  return 'pending';
}

export function parseCaseStatus(value: any, fallback = 'draft') {
  const normalized = String(value || fallback).trim().toLowerCase() || fallback;
  if (normalized === 'draft' || normalized === 'ready' || normalized === 'archived') {
    return normalized;
  }
  throw createHttpError(400, 'caseStatus must be one of: draft, ready, archived');
}

export function buildDefaultFailureIfMissing(stepTitle: string) {
  const title = String(stepTitle || '').trim() || '该步骤';
  return `缺少“${title}”步骤，说明关键行为未完成。`;
}

export function createLegacySummaryStep(stepId: string, text: string, required = false) {
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

export function normalizeStepSequenceReference(value: any) {
  if (typeof value === 'string') {
    return String(value || '').trim();
  }
  if (!isPlainObject(value)) {
    return '';
  }
  return String(value.stepId || value.id || value.name || value.tool || '').trim();
}

export function normalizeSequenceEntryName(value: any) {
  if (typeof value === 'string') {
    return normalizeToolNameForMatch(value);
  }
  if (!isPlainObject(value)) {
    return '';
  }
  return normalizeToolNameForMatch(value.name || value.tool || value.id || '');
}

export function normalizeJudgeConfidence(value: any) {
  if (value == null || value === '') {
    return null;
  }
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 && normalized <= 1 ? normalized : null;
}

export function normalizeStrongSignalEntry(signal: any, stepId: string, stepIndex: number, signalIndex: number, issues: any[]) {
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

export function normalizeExpectedStepsInput(rawValue: any, rawExpectedSequence: any, expectedTools: any[], options: { explicit?: boolean } = {}) {
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

export function normalizeThresholdConfig(rawValue: any, issues: any[], passThresholds: Record<string, number | null>, hardFailThresholds: Record<string, number | null>) {
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

export function normalizeEvaluationRubricForFullMode(rawValue: any, expectedSteps: any[], sequenceStepIds: string[]) {
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

export function buildLegacyExpectedStepFromTool(toolSpec: any, index: number) {
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

export function deriveLegacyExpectedSteps(testCase: any) {
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

export function buildCriticalSequenceEvidencePreflightIssues(testCase: any) {
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
  const sourceMetadataInput = hasOwn(input, 'sourceMetadata')
    ? input.sourceMetadata
    : hasOwn(input, 'source_metadata')
      ? input.source_metadata
      : existing && existing.sourceMetadata;
  if (sourceMetadataInput != null && !isPlainObject(sourceMetadataInput)) {
    throw createValidationHttpError(
      buildValidationIssue('source_metadata_invalid', 'error', 'sourceMetadata', 'sourceMetadata must be an object')
    );
  }
  const sourceMetadata = isPlainObject(sourceMetadataInput) ? sourceMetadataInput : {};

  const hasEnvironmentConfigInput = hasOwn(input, 'environmentConfig') || hasOwn(input, 'environment_config');
  const environmentConfigSource = hasEnvironmentConfigInput
    ? (hasOwn(input, 'environmentConfig') ? input.environmentConfig : input.environment_config)
    : existing && existing.environmentConfig;
  const environmentConfigResult = normalizeEnvironmentConfigInput(environmentConfigSource);
  issues.push(...environmentConfigResult.issues);

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

  if (!expectedGoal && loadingMode === 'full' && testType !== 'environment-build' && allowExpectedGoalFallback) {
    expectedGoal = expectedBehavior || String(existing && existing.note || input.note || '').trim();
  }
  if (!expectedGoal && loadingMode === 'full' && testType !== 'environment-build') {
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
    environmentConfig: environmentConfigResult.config,
    sourceMetadata,
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

export function sanitizeExpectedSequence(value: any) {
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

export function sanitizeEvaluationRubric(value: any) {
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

export function roundMetric(value: any) {
  if (value == null || !Number.isFinite(Number(value))) {
    return null;
  }
  return Math.round(Number(value) * 10000) / 10000;
}

export function buildEvaluationTimelineIds(sessionSnapshot: any, toolCallEvents: any[], observedToolCalls: any[]) {
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

