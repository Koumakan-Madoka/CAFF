import { randomUUID } from 'node:crypto';

import { createHttpError } from '../../http/http-errors';
import { ensureAgentSandbox } from '../conversation/turn/agent-sandbox';
import { getSkillTestIsolationFailureMessage } from './isolation';
import {
  createEnvironmentFailureMessage,
  executeEnvironmentWorkflow,
  resolveEnvironmentRunConfig,
} from './environment-chain';
import { createSkillTestEnvironmentRuntime } from './sandbox-tool-contract';

const SKILL_TEST_CHAIN_ALLOWED_INHERITANCE = new Set(['filesystem', 'artifacts']);
const SKILL_TEST_CHAIN_STOP_POLICY_STOP_ON_FAILURE = 'stop_on_failure';
const SKILL_TEST_CHAIN_STOP_POLICY_GOAL_THRESHOLD = 'stop_on_failure_goal_threshold';
const DEFAULT_SKILL_TEST_CHAIN_GOAL_THRESHOLD = 0.8;

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

function normalizePositiveInteger(value: any) {
  if (value == null || value === '') {
    return null;
  }
  const normalized = typeof value === 'string'
    ? Number.parseInt(value, 10)
    : Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function buildValidationIssue(code: string, severity: 'error' | 'warning' | 'needs-review', pathValue: string, message: string) {
  return { code, severity, path: pathValue, message };
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

function clipSkillTestChainText(value: any, maxLength = 96) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function normalizeSkillTestChainStopPolicy(value: any) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === SKILL_TEST_CHAIN_STOP_POLICY_STOP_ON_FAILURE) {
    return SKILL_TEST_CHAIN_STOP_POLICY_STOP_ON_FAILURE;
  }
  if (normalized === SKILL_TEST_CHAIN_STOP_POLICY_GOAL_THRESHOLD || normalized === 'goal_threshold') {
    return SKILL_TEST_CHAIN_STOP_POLICY_GOAL_THRESHOLD;
  }
  return '';
}

function buildSkillTestChainWarning(code: string, message: string) {
  return { code, message };
}

function buildSkillTestChainWarningMessage(code: string) {
  if (code === 'chain_run_environment_user_supplied') {
    return 'This chain uses user-supplied environment notes; verify them before trusting the result.';
  }
  if (code === 'chain_run_teardown_contract_missing') {
    return 'This chain has no explicit teardown contract; manual cleanup may still be required.';
  }
  if (code === 'chain_run_goal_threshold_continued') {
    return 'One or more steps continued after meeting the goal-achievement threshold despite a non-pass verdict.';
  }
  return code;
}

function buildSkillTestChainWarningsFromFlags(flags: any[]) {
  const normalizedFlags = Array.isArray(flags)
    ? flags.map((entry: any) => String(entry || '').trim()).filter(Boolean)
    : [];
  return normalizedFlags.map((code: string) => buildSkillTestChainWarning(code, buildSkillTestChainWarningMessage(code)));
}

function getSkillTestChainValidationStatusCode(issues: any[]) {
  const codes = new Set(
    Array.isArray(issues)
      ? issues.map((issue: any) => String(issue && issue.code || '').trim()).filter(Boolean)
      : []
  );
  if (codes.has('chain_run_already_running')) {
    return 409;
  }
  if (codes.size === 1 && codes.has('chain_run_cases_missing')) {
    return 404;
  }
  return 400;
}

function createSkillTestChainValidationHttpError(issueOrIssues: any, fallbackMessage = 'Chain run validation failed') {
  const issues = mergeValidationIssues(Array.isArray(issueOrIssues) ? issueOrIssues : [issueOrIssues]);
  return createHttpError(getSkillTestChainValidationStatusCode(issues), fallbackMessage, {
    issues,
    chainRun: null,
    steps: [],
  });
}

function normalizeSkillTestChainInheritance(value: any) {
  return Array.isArray(value)
    ? value.map((entry: any) => String(entry || '').trim()).filter(Boolean)
    : [];
}

function buildSkillTestChainStepSummaryFromResult(result: any) {
  const run = result && result.run && typeof result.run === 'object' ? result.run : null;
  const evaluation = run && isPlainObject(run.evaluation) ? run.evaluation : null;
  const summary = String(evaluation && evaluation.summary || '').trim();
  if (summary) {
    return summary;
  }
  const errorMessage = String(run && run.errorMessage || '').trim();
  if (errorMessage) {
    return errorMessage;
  }
  if (run && run.verdict === 'pass') {
    return 'This chain step passed.';
  }
  if (run && run.verdict === 'borderline') {
    return 'This chain step needs review.';
  }
  if (run && run.verdict === 'fail') {
    return 'This chain step failed.';
  }
  if (run && run.status === 'succeeded') {
    return 'This chain step completed.';
  }
  return 'This chain step failed to complete.';
}

function isSkillTestChainStepPassed(run: any) {
  if (!run || typeof run !== 'object') {
    return false;
  }
  if (String(run.status || '').trim().toLowerCase() !== 'succeeded') {
    return false;
  }
  if (String(run.verdict || '').trim()) {
    return String(run.verdict || '').trim() === 'pass';
  }
  if (run.executionPassed != null) {
    return Boolean(run.executionPassed);
  }
  return Boolean(run.triggerPassed);
}

function readSkillTestChainGoalAchievement(run: any) {
  if (!run || typeof run !== 'object') {
    return null;
  }
  if (run.goalAchievement != null) {
    const directScore = Number(run.goalAchievement);
    if (Number.isFinite(directScore)) {
      return directScore;
    }
  }
  const evaluation = isPlainObject(run.evaluation) ? run.evaluation : null;
  const dimensions = evaluation && isPlainObject(evaluation.dimensions) ? evaluation.dimensions : null;
  const goalAchievement = dimensions && isPlainObject(dimensions.goalAchievement) ? dimensions.goalAchievement : null;
  const score = goalAchievement && goalAchievement.score != null ? Number(goalAchievement.score) : null;
  return Number.isFinite(score) ? score : null;
}

function hasSkillTestChainCriticalConstraintFailure(run: any) {
  if (!run || typeof run !== 'object') {
    return false;
  }
  const evaluation = isPlainObject(run.evaluation) ? run.evaluation : null;
  const aggregation = evaluation && isPlainObject(evaluation.aggregation) ? evaluation.aggregation : null;
  const hardFailReasons = Array.isArray(aggregation && aggregation.hardFailReasons)
    ? aggregation.hardFailReasons.map((entry: any) => String(entry || '').trim()).filter(Boolean)
    : [];
  return hardFailReasons.includes('critical-constraint');
}

function buildSkillTestChainGoalThresholdContinueMessage(goalAchievement: number, threshold: number) {
  const goalPercent = Math.round(goalAchievement * 100);
  const thresholdPercent = Math.round(threshold * 100);
  return `Continued because goalAchievement=${goalPercent}% met the chain threshold ${thresholdPercent}% and no critical constraint failed.`;
}

function evaluateSkillTestChainStepContinuation(run: any, stopPolicy: any) {
  if (isSkillTestChainStepPassed(run)) {
    return {
      continueChain: true,
      stepStatus: 'passed',
      errorCode: '',
      errorMessage: '',
      warningFlag: '',
      progressLabel: '链步骤通过。',
    };
  }

  const normalizedStopPolicy = normalizeSkillTestChainStopPolicy(stopPolicy) || SKILL_TEST_CHAIN_STOP_POLICY_STOP_ON_FAILURE;
  if (normalizedStopPolicy !== SKILL_TEST_CHAIN_STOP_POLICY_GOAL_THRESHOLD) {
    return {
      continueChain: false,
      stepStatus: 'failed',
      errorCode: '',
      errorMessage: '',
      warningFlag: '',
      progressLabel: '',
    };
  }
  if (!run || typeof run !== 'object') {
    return {
      continueChain: false,
      stepStatus: 'failed',
      errorCode: '',
      errorMessage: '',
      warningFlag: '',
      progressLabel: '',
    };
  }
  if (String(run.status || '').trim().toLowerCase() !== 'succeeded') {
    return {
      continueChain: false,
      stepStatus: 'failed',
      errorCode: '',
      errorMessage: '',
      warningFlag: '',
      progressLabel: '',
    };
  }
  if (hasSkillTestChainCriticalConstraintFailure(run)) {
    return {
      continueChain: false,
      stepStatus: 'failed',
      errorCode: '',
      errorMessage: '',
      warningFlag: '',
      progressLabel: '',
    };
  }

  const goalAchievement = readSkillTestChainGoalAchievement(run);
  if (goalAchievement == null || goalAchievement < DEFAULT_SKILL_TEST_CHAIN_GOAL_THRESHOLD) {
    return {
      continueChain: false,
      stepStatus: 'failed',
      errorCode: '',
      errorMessage: '',
      warningFlag: '',
      progressLabel: '',
    };
  }

  const errorMessage = buildSkillTestChainGoalThresholdContinueMessage(
    goalAchievement,
    DEFAULT_SKILL_TEST_CHAIN_GOAL_THRESHOLD
  );
  return {
    continueChain: true,
    stepStatus: 'continued',
    errorCode: 'chain_run_goal_threshold_continued',
    errorMessage,
    warningFlag: 'chain_run_goal_threshold_continued',
    progressLabel: `链步骤达到目标阈值（${Math.round(goalAchievement * 100)}%），继续下一步。`,
  };
}

export function buildSkillTestChainStepPrompt(prompt: any, chainContext: any = null) {
  const basePrompt = String(prompt || '').trim();
  if (!basePrompt || !isPlainObject(chainContext)) {
    return basePrompt;
  }

  const previousStepSummary = clipSkillTestChainText(chainContext.previousStepSummary, 600);
  const artifactRefs = Array.isArray(chainContext.artifactRefs) ? chainContext.artifactRefs : [];
  const sharedEnvironmentHandle = chainContext.sharedEnvironmentHandle && typeof chainContext.sharedEnvironmentHandle === 'object'
    ? chainContext.sharedEnvironmentHandle
    : null;

  if (!previousStepSummary && artifactRefs.length === 0 && !sharedEnvironmentHandle) {
    return basePrompt;
  }

  let sharedHandleText = '';
  if (sharedEnvironmentHandle) {
    try {
      sharedHandleText = JSON.stringify(sharedEnvironmentHandle, null, 2);
    } catch {
      sharedHandleText = String(sharedEnvironmentHandle || '').trim();
    }
  }

  const artifactLines = artifactRefs
    .map((entry: any) => {
      if (!entry) {
        return '';
      }
      if (typeof entry === 'string') {
        return `- ${entry}`;
      }
      try {
        return `- ${JSON.stringify(entry)}`;
      } catch {
        return '- [unserializable artifact ref]';
      }
    })
    .filter(Boolean);

  const sections = ['[Lifecycle Chain Context]'];
  if (previousStepSummary) {
    sections.push(`Previous step summary:\n${previousStepSummary}`);
  }
  if (artifactLines.length > 0) {
    sections.push(`Artifact refs:\n${artifactLines.join('\n')}`);
  }
  if (sharedHandleText) {
    sections.push(`Shared environment handle:\n${sharedHandleText}`);
  }
  sections.push('[Current Test Prompt]');
  sections.push(basePrompt);
  return sections.join('\n\n');
}

export function createSkillTestChainRunner(options: any = {}) {
  const store = options.store;
  const ensureSchema = typeof options.ensureSchema === 'function' ? options.ensureSchema : () => {};
  const skillRegistry = options.skillRegistry;
  const getProjectDir = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  const environmentCacheRootDir = String(options.environmentCacheRootDir || '').trim();
  const skillTestIsolationDriver = options.skillTestIsolationDriver;
  const buildProviderAuthEnv = typeof options.buildProviderAuthEnv === 'function' ? options.buildProviderAuthEnv : () => ({});
  const resolveEffectiveProvider = typeof options.resolveEffectiveProvider === 'function'
    ? options.resolveEffectiveProvider
    : (provider: any) => String(provider || '').trim();
  const broadcastSkillTestChainRunEvent = typeof options.broadcastSkillTestChainRunEvent === 'function'
    ? options.broadcastSkillTestChainRunEvent
    : () => {};
  const getCanonicalCasePrompt = typeof options.getCanonicalCasePrompt === 'function'
    ? options.getCanonicalCasePrompt
    : (value: any) => String(value && (value.userPrompt || value.triggerPrompt) || '').trim();
  const normalizeTestCaseRow = typeof options.normalizeTestCaseRow === 'function'
    ? options.normalizeTestCaseRow
    : (row: any) => row;
  const getTestCase = typeof options.getTestCase === 'function'
    ? options.getTestCase
    : () => null;
  const normalizeCaseForRunOrThrow = typeof options.normalizeCaseForRunOrThrow === 'function'
    ? options.normalizeCaseForRunOrThrow
    : (testCase: any) => testCase;
  const executeRun = typeof options.executeRun === 'function'
    ? options.executeRun
    : async () => {
      throw new Error('executeRun is required');
    };
  const readSkillTestIsolationInput = typeof options.readSkillTestIsolationInput === 'function'
    ? options.readSkillTestIsolationInput
    : () => ({});
  const readSkillTestEnvironmentInput = typeof options.readSkillTestEnvironmentInput === 'function'
    ? options.readSkillTestEnvironmentInput
    : () => null;

  function listSkillTestCasesForChain(skillId: string) {
    ensureSchema();
    return store.db
      .prepare(
        `SELECT * FROM skill_test_cases
         WHERE skill_id = @skillId
         ORDER BY created_at ASC`
      )
      .all({ skillId })
      .map((row: any) => normalizeTestCaseRow(row))
      .filter(Boolean);
  }

  function getSkillTestDesignMetadata(testCase: any) {
    return isPlainObject(testCase && testCase.sourceMetadata && testCase.sourceMetadata.skillTestDesign)
      ? testCase.sourceMetadata.skillTestDesign
      : {};
  }

  function getSkillTestChainPlanning(testCase: any) {
    const designMetadata = getSkillTestDesignMetadata(testCase);
    return isPlainObject(designMetadata && designMetadata.chainPlanning)
      ? designMetadata.chainPlanning
      : {};
  }

  function getSkillTestChainEnvironmentSource(testCase: any) {
    const designMetadata = getSkillTestDesignMetadata(testCase);
    const chainPlanning = getSkillTestChainPlanning(testCase);
    const normalized = String(designMetadata.environmentSource || chainPlanning.environmentSource || '').trim().toLowerCase();
    if (normalized === 'skill_contract' || normalized === 'user_supplied' || normalized === 'missing') {
      return normalized;
    }
    return String(designMetadata.environmentContractRef || chainPlanning.environmentContractRef || '').trim() ? 'skill_contract' : 'missing';
  }

  function buildSkillTestChainStepTitle(testCase: any) {
    return clipSkillTestChainText(
      testCase && (
        testCase.expectedGoal
        || testCase.expectedBehavior
        || getCanonicalCasePrompt(testCase)
        || testCase.note
      )
      || 'chain step',
      96
    );
  }

  function buildSkillTestChainSharedEnvironmentHandle(chainRunId: string, isolationContext: any) {
    const projectDir = isolationContext && isolationContext.projectDir ? String(isolationContext.projectDir).trim().replace(/\\/g, '/') : '';
    const outputDir = isolationContext && isolationContext.outputDir ? String(isolationContext.outputDir).trim().replace(/\\/g, '/') : '';
    return {
      chainRunId,
      mode: String(isolationContext && isolationContext.isolation && isolationContext.isolation.mode || 'legacy-local').trim() || 'legacy-local',
      projectDir,
      outputDir,
    };
  }

  function updateSkillTestChainRecord(tableName: string, idField: string, idValue: string, patch: Record<string, any>) {
    const entries = Object.entries(patch || {}).filter(([, value]) => value !== undefined);
    if (!idValue || entries.length === 0) {
      return;
    }
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    store.db.prepare(`UPDATE ${tableName} SET ${assignments} WHERE ${idField} = @recordId`).run({
      recordId: idValue,
      ...Object.fromEntries(entries),
    });
  }

  function getSkillTestChainRunRow(chainRunId: string, skillId?: string) {
    ensureSchema();
    const params: Record<string, any> = { chainRunId };
    let sql = `SELECT * FROM skill_test_chain_runs WHERE id = @chainRunId`;
    if (skillId) {
      sql += ' AND skill_id = @skillId';
      params.skillId = skillId;
    }
    return store.db.prepare(sql).get(params);
  }

  function listSkillTestChainStepRows(chainRunId: string) {
    ensureSchema();
    return store.db
      .prepare(
        `SELECT
           s.*,
           c.trigger_prompt AS case_trigger_prompt,
           c.expected_goal AS case_expected_goal,
           c.expected_behavior AS case_expected_behavior,
           c.note AS case_note
         FROM skill_test_chain_run_steps s
         LEFT JOIN skill_test_cases c ON c.id = s.test_case_id
         WHERE s.chain_run_id = @chainRunId
         ORDER BY s.sequence_index ASC`
      )
      .all({ chainRunId });
  }

  function normalizeSkillTestChainRunStepRow(row: any) {
    if (!row || typeof row !== 'object') {
      return null;
    }
    const dependsOnStepIds = Array.isArray(safeJsonParse(row.depends_on_step_ids_json)) ? safeJsonParse(row.depends_on_step_ids_json) : [];
    const carryForward = isPlainObject(safeJsonParse(row.carry_forward_json)) ? safeJsonParse(row.carry_forward_json) : {};
    const artifactRefs = Array.isArray(safeJsonParse(row.artifact_refs_json)) ? safeJsonParse(row.artifact_refs_json) : [];
    const title = buildSkillTestChainStepTitle({
      expectedGoal: row.case_expected_goal,
      expectedBehavior: row.case_expected_behavior,
      triggerPrompt: row.case_trigger_prompt,
      note: row.case_note,
    });
    const summary = clipSkillTestChainText(carryForward.stepSummary || row.error_message || '', 600);
    return {
      id: String(row.id || '').trim(),
      testCaseId: String(row.test_case_id || '').trim(),
      sequenceIndex: normalizePositiveInteger(row.sequence_index) || 0,
      title,
      status: String(row.status || 'pending').trim() || 'pending',
      dependsOnStepIds,
      skillTestRunId: String(row.skill_test_run_id || '').trim(),
      summary,
      artifactRefs,
      errorCode: String(row.error_code || '').trim(),
      errorMessage: String(row.error_message || '').trim(),
      startedAt: String(row.started_at || '').trim(),
      finishedAt: String(row.finished_at || '').trim(),
    };
  }

  function normalizeSkillTestChainPollutionCheck(evidence: any, includeChanges = false) {
    const pollutionCheck = evidence && isPlainObject(evidence.pollutionCheck) ? evidence.pollutionCheck : null;
    if (!pollutionCheck) {
      return null;
    }
    const changes = Array.isArray(pollutionCheck.changes) ? pollutionCheck.changes : [];
    return {
      checked: Boolean(pollutionCheck.checked),
      ok: pollutionCheck.ok !== false,
      changeCount: normalizePositiveInteger(pollutionCheck.changeCount) || changes.length,
      ...(includeChanges ? { changes } : {}),
    };
  }

  function readSkillTestChainTeardownEvidence(row: any) {
    const parsed = safeJsonParse(row && row.teardown_evidence_json);
    return isPlainObject(parsed) ? parsed : null;
  }

  function normalizeSkillTestChainRunRow(row: any, steps: any[] = [], options: any = {}) {
    if (!row || typeof row !== 'object') {
      return null;
    }
    const includeDiagnostics = Boolean(options && options.includeDiagnostics);
    const warningFlags = Array.isArray(safeJsonParse(row.warning_flags_json)) ? safeJsonParse(row.warning_flags_json) : [];
    const teardownEvidence = readSkillTestChainTeardownEvidence(row);
    const pollutionCheck = normalizeSkillTestChainPollutionCheck(teardownEvidence, includeDiagnostics);
    const normalizedSteps = Array.isArray(steps) ? steps.filter(Boolean) : [];
    const totalSteps = normalizedSteps.length;
    const runningStep = normalizedSteps.find((step: any) => step && step.status === 'running');
    const failedStep = normalizedSteps.find((step: any) => step && step.status === 'failed');
    const lastCompletedStepIndex = normalizePositiveInteger(row.last_completed_step_index) || 0;
    const currentStepIndex = runningStep
      ? Number(runningStep.sequenceIndex || 0)
      : String(row.status || '').trim() === 'passed'
        ? totalSteps
        : String(row.status || '').trim() === 'running'
          ? Math.min(totalSteps, lastCompletedStepIndex + 1)
          : lastCompletedStepIndex;
    return {
      id: String(row.id || '').trim(),
      skillId: String(row.skill_id || '').trim(),
      exportChainId: String(row.export_chain_id || '').trim(),
      status: String(row.status || 'pending').trim() || 'pending',
      stopPolicy: String(row.stop_policy || 'stop_on_failure').trim() || 'stop_on_failure',
      sharedEnvironmentPolicy: String(row.shared_environment_policy || 'single_chain_environment').trim() || 'single_chain_environment',
      bootstrapStatus: String(row.bootstrap_status || 'pending').trim() || 'pending',
      teardownStatus: String(row.teardown_status || 'pending').trim() || 'pending',
      currentStepIndex,
      lastCompletedStepIndex,
      totalSteps,
      failedStepIndex: failedStep ? Number(failedStep.sequenceIndex || 0) : null,
      warningFlags,
      ...(pollutionCheck ? { pollutionCheck } : {}),
      ...(includeDiagnostics && teardownEvidence ? { isolation: teardownEvidence } : {}),
      errorCode: String(row.error_code || '').trim(),
      errorMessage: String(row.error_message || '').trim(),
      startedAt: String(row.started_at || '').trim(),
      finishedAt: String(row.finished_at || '').trim(),
      createdAt: String(row.created_at || '').trim(),
      updatedAt: String(row.updated_at || '').trim(),
    };
  }

  function buildSkillTestChainRunResponse(skillId: string, chainRunId: string, warningsOverride: any[] | null = null) {
    const chainRunRow = getSkillTestChainRunRow(chainRunId, skillId);
    if (!chainRunRow) {
      throw createHttpError(404, 'Chain run not found');
    }
    const steps = listSkillTestChainStepRows(chainRunId)
      .map((row: any) => normalizeSkillTestChainRunStepRow(row))
      .filter(Boolean);
    const chainRun = normalizeSkillTestChainRunRow(chainRunRow, steps, { includeDiagnostics: true });
    return {
      chainRun,
      steps,
      warnings: Array.isArray(warningsOverride)
        ? warningsOverride
        : buildSkillTestChainWarningsFromFlags(chainRun && chainRun.warningFlags),
      issues: [],
      pollUrl: `/api/skills/${encodeURIComponent(skillId)}/test-chains/${encodeURIComponent(chainRunId)}`,
    };
  }

  function broadcastSkillTestChainRunSnapshot(skillId: string, chainRunId: string, phase: string, extra: any = {}) {
    let snapshot: any = null;
    try {
      snapshot = buildSkillTestChainRunResponse(skillId, chainRunId);
    } catch {
      snapshot = null;
    }
    const chainRun = snapshot && snapshot.chainRun && typeof snapshot.chainRun === 'object' ? snapshot.chainRun : null;
    const steps = snapshot && Array.isArray(snapshot.steps) ? snapshot.steps : [];
    const extraPayload = extra && typeof extra === 'object' ? extra : {};
    const currentStepId = String(extraPayload.currentStepId || '').trim();
    const currentStep = currentStepId
      ? steps.find((step: any) => step && step.id === currentStepId) || null
      : null;

    broadcastSkillTestChainRunEvent(phase, {
      skillId,
      chainRunId,
      exportChainId: String(extraPayload.exportChainId || chainRun && chainRun.exportChainId || '').trim(),
      status: String(extraPayload.status || chainRun && chainRun.status || '').trim(),
      chainRun,
      steps,
      warnings: snapshot && Array.isArray(snapshot.warnings) ? snapshot.warnings : [],
      issues: snapshot && Array.isArray(snapshot.issues) ? snapshot.issues : [],
      pollUrl: snapshot && snapshot.pollUrl ? snapshot.pollUrl : `/api/skills/${encodeURIComponent(skillId)}/test-chains/${encodeURIComponent(chainRunId)}`,
      currentStep: extraPayload.currentStep || currentStep,
      currentStepId,
      currentStepIndex: normalizePositiveInteger(extraPayload.currentStepIndex) || (currentStep ? currentStep.sequenceIndex : chainRun && chainRun.currentStepIndex) || 0,
      currentTestCaseId: String(extraPayload.currentTestCaseId || currentStep && currentStep.testCaseId || '').trim(),
      progressLabel: String(extraPayload.progressLabel || '').trim(),
      runnerStage: String(extraPayload.runnerStage || '').trim(),
      updatedAt: nowIso(),
    });
  }

  function listSkillTestChainRunSummaries(skillId: string, exportChainId: string, limit = 20) {
    ensureSchema();
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    const rows = store.db
      .prepare(
        `SELECT * FROM skill_test_chain_runs
         WHERE skill_id = @skillId
           AND export_chain_id = @exportChainId
         ORDER BY created_at DESC
         LIMIT @limit`
      )
      .all({ skillId, exportChainId, limit: safeLimit });

    return rows
      .map((row: any) => {
        const steps = listSkillTestChainStepRows(String(row && row.id || '').trim())
          .map((stepRow: any) => normalizeSkillTestChainRunStepRow(stepRow))
          .filter(Boolean);
        const chainRun = normalizeSkillTestChainRunRow(row, steps);
        return chainRun ? { ...chainRun, steps } : null;
      })
      .filter(Boolean);
  }

  function createSkillTestChainRunAudit(skillId: string, exportChainId: string, orderedCases: any[], warnings: any[], optionsValue: any = {}) {
    ensureSchema();
    const createdAt = nowIso();
    const chainRunId = randomUUID();
    const warningFlags = Array.isArray(warnings)
      ? [...new Set(warnings.map((entry: any) => String(entry && entry.code || '').trim()).filter(Boolean))]
      : [];

    const stepDefinitions = orderedCases.map((testCase: any, index: number) => {
      const chainPlanning = getSkillTestChainPlanning(testCase);
      return {
        id: randomUUID(),
        testCaseId: String(testCase && testCase.id || '').trim(),
        sequenceIndex: normalizePositiveInteger(chainPlanning.sequenceIndex) || index + 1,
        dependsOnCaseIds: Array.isArray(chainPlanning.dependsOnCaseIds)
          ? chainPlanning.dependsOnCaseIds.map((entry: any) => String(entry || '').trim()).filter(Boolean)
          : [],
      };
    });
    const caseIdToStepId = new Map<string, string>(
      stepDefinitions
        .map((entry) => [entry.testCaseId, entry.id] as [string, string])
        .filter(([testCaseId, stepId]) => testCaseId && stepId)
    );

    const insertRun = store.db.prepare(
      `INSERT INTO skill_test_chain_runs (
        id, skill_id, export_chain_id, status, stop_policy, shared_environment_policy,
        bootstrap_status, teardown_status, warning_flags_json, teardown_evidence_json,
        error_code, error_message, last_completed_step_index,
        started_at, finished_at, created_at, updated_at
      ) VALUES (
        @id, @skillId, @exportChainId, @status, @stopPolicy, @sharedEnvironmentPolicy,
        @bootstrapStatus, @teardownStatus, @warningFlagsJson, @teardownEvidenceJson,
        @errorCode, @errorMessage, @lastCompletedStepIndex,
        @startedAt, @finishedAt, @createdAt, @updatedAt
      )`
    );
    const insertStep = store.db.prepare(
      `INSERT INTO skill_test_chain_run_steps (
        id, chain_run_id, test_case_id, sequence_index, depends_on_step_ids_json,
        status, skill_test_run_id, carry_forward_json, artifact_refs_json,
        error_code, error_message, started_at, finished_at, created_at, updated_at
      ) VALUES (
        @id, @chainRunId, @testCaseId, @sequenceIndex, @dependsOnStepIdsJson,
        @status, @skillTestRunId, @carryForwardJson, @artifactRefsJson,
        @errorCode, @errorMessage, @startedAt, @finishedAt, @createdAt, @updatedAt
      )`
    );

    const transaction = store.db.transaction(() => {
      insertRun.run({
        id: chainRunId,
        skillId,
        exportChainId,
        status: 'pending',
        stopPolicy: normalizeSkillTestChainStopPolicy(optionsValue && optionsValue.stopPolicy) || SKILL_TEST_CHAIN_STOP_POLICY_STOP_ON_FAILURE,
        sharedEnvironmentPolicy: 'single_chain_environment',
        bootstrapStatus: 'pending',
        teardownStatus: 'pending',
        warningFlagsJson: JSON.stringify(warningFlags),
        teardownEvidenceJson: '{}',
        errorCode: '',
        errorMessage: '',
        lastCompletedStepIndex: 0,
        startedAt: '',
        finishedAt: '',
        createdAt,
        updatedAt: createdAt,
      });

      for (const definition of stepDefinitions) {
        insertStep.run({
          id: definition.id,
          chainRunId,
          testCaseId: definition.testCaseId,
          sequenceIndex: definition.sequenceIndex,
          dependsOnStepIdsJson: JSON.stringify(
            definition.dependsOnCaseIds
              .map((caseId: string) => String(caseIdToStepId.get(caseId) || '').trim())
              .filter(Boolean)
          ),
          status: 'pending',
          skillTestRunId: '',
          carryForwardJson: '{}',
          artifactRefsJson: '[]',
          errorCode: '',
          errorMessage: '',
          startedAt: '',
          finishedAt: '',
          createdAt,
          updatedAt: createdAt,
        });
      }
    });

    transaction();
    return { chainRunId, stepDefinitions };
  }

  function markPendingSkillTestChainStepsSkipped(chainRunId: string, afterSequenceIndex: number, reason: string) {
    const timestamp = nowIso();
    store.db
      .prepare(
        `UPDATE skill_test_chain_run_steps
         SET status = 'skipped',
             error_code = @errorCode,
             error_message = @errorMessage,
             finished_at = @finishedAt,
             updated_at = @updatedAt
         WHERE chain_run_id = @chainRunId
           AND sequence_index > @afterSequenceIndex
           AND status = 'pending'`
      )
      .run({
        chainRunId,
        afterSequenceIndex,
        errorCode: 'chain_run_step_skipped',
        errorMessage: reason,
        finishedAt: timestamp,
        updatedAt: timestamp,
      });
  }

  function buildSkillTestChainRunCandidate(skillId: string, body: any = {}) {
    const payload = body && typeof body === 'object' ? body : {};
    const requestedExportChainId = String(payload.exportChainId || '').trim();
    const requestedCaseIds: string[] = Array.isArray(payload.caseIds)
      ? Array.from(new Set<string>(payload.caseIds.map((entry: any) => String(entry || '').trim()).filter((entry: string) => Boolean(entry))))
      : [];
    const rawStopPolicy = Object.prototype.hasOwnProperty.call(payload, 'stopPolicy') ? payload.stopPolicy : payload.stop_policy;
    const stopPolicyProvided = rawStopPolicy != null && String(rawStopPolicy).trim() !== '';
    const normalizedStopPolicy = normalizeSkillTestChainStopPolicy(rawStopPolicy);
    const issues: any[] = [];
    const warnings: any[] = [];

    if (stopPolicyProvided && !normalizedStopPolicy) {
      issues.push(
        buildValidationIssue('chain_run_stop_policy_invalid', 'error', 'stopPolicy', '不支持的链停止策略')
      );
    }

    if (!requestedExportChainId && requestedCaseIds.length === 0) {
      issues.push(
        buildValidationIssue('chain_run_cases_missing', 'error', 'caseIds', 'exportChainId 或 caseIds 至少要提供一个')
      );
      return { exportChainId: '', cases: [], warnings, issues };
    }

    const requestedCases: any[] = [];
    if (requestedCaseIds.length > 0) {
      for (const caseId of requestedCaseIds) {
        const scopedCase = getTestCase(caseId, skillId);
        if (scopedCase) {
          requestedCases.push(scopedCase);
          continue;
        }
        const anyCase = getTestCase(caseId);
        if (anyCase) {
          issues.push(
            buildValidationIssue('chain_run_skill_mismatch', 'error', 'caseIds', `用例 ${caseId} 不属于当前 skill ${skillId}`)
          );
        } else {
          issues.push(
            buildValidationIssue('chain_run_cases_missing', 'error', 'caseIds', `用例 ${caseId} 不存在或已删除`)
          );
        }
      }
    }

    const skillCases = requestedCaseIds.length > 0 ? requestedCases : listSkillTestCasesForChain(skillId);
    const candidateEntries = skillCases.map((testCase: any) => {
      const designMetadata = getSkillTestDesignMetadata(testCase);
      const chainPlanning = getSkillTestChainPlanning(testCase);
      const exportChainId = String(chainPlanning.exportChainId || '').trim();
      const sequenceIndex = normalizePositiveInteger(chainPlanning.sequenceIndex);
      const dependsOnCaseIds = Array.isArray(chainPlanning.dependsOnCaseIds)
        ? chainPlanning.dependsOnCaseIds.map((entry: any) => String(entry || '').trim()).filter(Boolean)
        : [];
      const inheritance = normalizeSkillTestChainInheritance(chainPlanning.inheritance);
      return {
        testCase,
        designMetadata,
        chainPlanning,
        exportChainId,
        sequenceIndex,
        dependsOnCaseIds,
        inheritance,
      };
    });

    const effectiveExportChainId = requestedExportChainId || String(candidateEntries[0] && candidateEntries[0].exportChainId || '').trim();
    const filteredEntries = candidateEntries.filter((entry: any) => entry.exportChainId === effectiveExportChainId);

    if (!effectiveExportChainId) {
      issues.push(
        buildValidationIssue('chain_run_metadata_incomplete', 'error', 'exportChainId', '候选用例缺少 exportChainId，不能按链运行')
      );
    }

    if (requestedCaseIds.length === 0 && effectiveExportChainId && filteredEntries.length === 0) {
      issues.push(
        buildValidationIssue('chain_run_cases_missing', 'error', 'exportChainId', `未找到 exportChainId=${effectiveExportChainId} 的链式用例`)
      );
    }

    for (const entry of candidateEntries) {
      if (effectiveExportChainId && entry.exportChainId && entry.exportChainId !== effectiveExportChainId) {
        issues.push(
          buildValidationIssue('chain_run_export_chain_mismatch', 'error', 'exportChainId', '候选用例必须属于同一个 exportChainId')
        );
        break;
      }
    }

    const sequenceOwners = new Map<number, string>();
    const caseIdSet = new Set<string>(filteredEntries.map((entry: any) => String(entry.testCase && entry.testCase.id || '').trim()).filter(Boolean));

    for (const entry of filteredEntries) {
      const testCase = entry.testCase;
      if (!entry.exportChainId || entry.sequenceIndex == null || !Array.isArray(entry.chainPlanning.dependsOnCaseIds)) {
        issues.push(
          buildValidationIssue('chain_run_metadata_incomplete', 'error', 'sourceMetadata.skillTestDesign.chainPlanning', `用例 ${testCase.id} 的链 metadata 不完整`)
        );
      }
      if (String(testCase && testCase.loadingMode || '').trim().toLowerCase() !== 'full' || String(testCase && testCase.testType || '').trim().toLowerCase() !== 'execution') {
        issues.push(
          buildValidationIssue('chain_run_mode_unsupported', 'error', 'testCase', `用例 ${testCase.id} 不是 full + execution，不能纳入链 runner 当前支持范围`)
        );
      }
      if (entry.sequenceIndex != null) {
        if (sequenceOwners.has(entry.sequenceIndex)) {
          issues.push(
            buildValidationIssue('chain_run_topology_invalid', 'error', 'sourceMetadata.skillTestDesign.chainPlanning.sequenceIndex', `sequenceIndex=${entry.sequenceIndex} 重复`)
          );
        } else {
          sequenceOwners.set(entry.sequenceIndex, testCase.id);
        }
      }
      const environmentSource = getSkillTestChainEnvironmentSource(testCase);
      if (environmentSource === 'missing') {
        issues.push(
          buildValidationIssue('chain_run_environment_missing', 'error', 'sourceMetadata.skillTestDesign.environmentSource', `用例 ${testCase.id} 缺少可执行环境契约，不能按链运行`)
        );
      } else if (environmentSource === 'user_supplied') {
        warnings.push(
          buildSkillTestChainWarning('chain_run_environment_user_supplied', buildSkillTestChainWarningMessage('chain_run_environment_user_supplied'))
        );
      }
      if (entry.inheritance.some((item: string) => !SKILL_TEST_CHAIN_ALLOWED_INHERITANCE.has(item))) {
        issues.push(
          buildValidationIssue('chain_run_inheritance_unsupported', 'error', 'sourceMetadata.skillTestDesign.chainPlanning.inheritance', `用例 ${testCase.id} 声明了当前链 runner 不支持的 inheritance`)
        );
      }
      try {
        normalizeCaseForRunOrThrow(testCase);
      } catch (error: any) {
        issues.push(
          ...mergeValidationIssues(
            [buildValidationIssue('chain_run_case_schema_invalid', 'error', 'testCase', `用例 ${testCase.id} 的 canonical schema 不合法`)],
            Array.isArray(error && error.issues) ? error.issues : []
          )
        );
      }
    }

    const orderedEntries = filteredEntries.slice().sort((left: any, right: any) => Number(left.sequenceIndex || 0) - Number(right.sequenceIndex || 0));
    let expectedSequenceIndex = 1;
    for (const entry of orderedEntries) {
      if (entry.sequenceIndex !== expectedSequenceIndex) {
        issues.push(
          buildValidationIssue('chain_run_topology_invalid', 'error', 'sourceMetadata.skillTestDesign.chainPlanning.sequenceIndex', `链的 sequenceIndex 必须从 1 连续递增，当前缺少 ${expectedSequenceIndex}`)
        );
        break;
      }
      expectedSequenceIndex += 1;
    }

    const caseIdToSequence = new Map<string, number>();
    for (const entry of orderedEntries) {
      caseIdToSequence.set(String(entry.testCase && entry.testCase.id || '').trim(), Number(entry.sequenceIndex || 0));
    }
    for (const entry of orderedEntries) {
      const currentCaseId = String(entry.testCase && entry.testCase.id || '').trim();
      const currentSequenceIndex = Number(entry.sequenceIndex || 0);
      for (const dependencyCaseId of entry.dependsOnCaseIds) {
        if (!caseIdSet.has(dependencyCaseId)) {
          issues.push(
            buildValidationIssue('chain_run_topology_invalid', 'error', 'sourceMetadata.skillTestDesign.chainPlanning.dependsOnCaseIds', `用例 ${currentCaseId} 依赖的 ${dependencyCaseId} 不在当前链集合里`)
          );
          continue;
        }
        const dependencySequenceIndex = Number(caseIdToSequence.get(dependencyCaseId) || 0);
        if (!dependencySequenceIndex || dependencySequenceIndex >= currentSequenceIndex) {
          issues.push(
            buildValidationIssue('chain_run_topology_invalid', 'error', 'sourceMetadata.skillTestDesign.chainPlanning.dependsOnCaseIds', `用例 ${currentCaseId} 的依赖顺序不合法`)
          );
        }
      }
    }

    if (effectiveExportChainId && issues.length === 0) {
      const activeRun = store.db
        .prepare(
          `SELECT id FROM skill_test_chain_runs
           WHERE skill_id = @skillId
             AND export_chain_id = @exportChainId
             AND status IN ('pending', 'running')
           ORDER BY created_at DESC
           LIMIT 1`
        )
        .get({ skillId, exportChainId: effectiveExportChainId });
      if (activeRun && activeRun.id) {
        issues.push(
          buildValidationIssue('chain_run_already_running', 'error', 'exportChainId', `链 ${effectiveExportChainId} 已有未完成运行 ${String(activeRun.id)}`)
        );
      }
    }

    return {
      exportChainId: effectiveExportChainId,
      cases: orderedEntries.map((entry: any) => entry.testCase),
      warnings,
      issues,
      stopPolicy: normalizedStopPolicy || SKILL_TEST_CHAIN_STOP_POLICY_STOP_ON_FAILURE,
    };
  }

  async function executeSkillTestChainRun(skillId: string, body: any = {}) {
    const candidate = buildSkillTestChainRunCandidate(skillId, body);
    if (candidate.issues.length > 0) {
      throw createSkillTestChainValidationHttpError(candidate.issues, 'Chain run validation failed');
    }

    const provider = String(body && body.provider || '').trim();
    const model = String(body && body.model || '').trim();
    const effectiveProvider = resolveEffectiveProvider(provider);
    const promptVersion = String(body && body.promptVersion || '').trim() || 'skill-test-v1';
    const agentId = String(body && body.agentId || 'skill-test-agent').trim();
    const agentName = String(body && body.agentName || 'Skill Test Agent').trim();
    const isolation = readSkillTestIsolationInput(body);
    const environment = readSkillTestEnvironmentInput(body);
    const firstCase = candidate.cases[0];
    const { chainRunId, stepDefinitions } = createSkillTestChainRunAudit(
      skillId,
      candidate.exportChainId,
      candidate.cases,
      candidate.warnings,
      { stopPolicy: candidate.stopPolicy }
    );
    const startedAt = nowIso();

    updateSkillTestChainRecord('skill_test_chain_runs', 'id', chainRunId, {
      status: 'running',
      started_at: startedAt,
      updated_at: startedAt,
    });
    broadcastSkillTestChainRunSnapshot(skillId, chainRunId, 'started', {
      exportChainId: candidate.exportChainId,
      status: 'running',
      progressLabel: '链运行已启动，正在准备共享环境…',
      runnerStage: 'chain_started',
    });

    let sharedIsolationContext: any = null;
    let chainStatus = 'running';
    let bootstrapStatus = 'pending';
    let teardownStatus = 'pending';
    let lastCompletedStepIndex = 0;
    let errorCode = '';
    let errorMessage = '';
    let sharedEnvironmentHandle: any = null;
    let teardownEvidenceJson = '{}';
    const chainWarningFlags = new Set(
      Array.isArray(candidate.warnings)
        ? candidate.warnings.map((entry: any) => String(entry && entry.code || '').trim()).filter(Boolean)
        : []
    );

    try {
      const liveSkill = skillRegistry ? skillRegistry.getSkill(firstCase.skillId) : null;
      const conversationId = `skill-test-chain-${candidate.exportChainId || chainRunId}`;
      const turnId = `skill-test-chain-turn-${chainRunId}`;
      const promptUserMessage = {
        id: 'skill-test-chain-user',
        turnId,
        role: 'user',
        senderName: 'TestUser',
        content: getCanonicalCasePrompt(firstCase),
        status: 'completed',
        createdAt: startedAt,
      };
      const agent = { id: agentId, name: agentName };
      const liveProjectDir = getProjectDir ? String(getProjectDir() || '').trim() : '';

      sharedIsolationContext = await Promise.resolve(
        skillTestIsolationDriver.createCaseContext({
          caseId: firstCase.id,
          runId: chainRunId,
          isolation,
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
        })
      );
      sharedEnvironmentHandle = buildSkillTestChainSharedEnvironmentHandle(chainRunId, sharedIsolationContext);
      broadcastSkillTestChainRunSnapshot(skillId, chainRunId, 'progress', {
        exportChainId: candidate.exportChainId,
        status: 'running',
        progressLabel: '共享环境已就绪，正在检查链级环境契约…',
        runnerStage: 'shared_environment_ready',
      });

      const runtimeSkill = sharedIsolationContext && sharedIsolationContext.skill ? sharedIsolationContext.skill : liveSkill;
      const sandbox = sharedIsolationContext && sharedIsolationContext.sandbox ? sharedIsolationContext.sandbox : ensureAgentSandbox(store.agentDir, agent);
      const projectDir = sharedIsolationContext && sharedIsolationContext.projectDir ? String(sharedIsolationContext.projectDir).trim() : liveProjectDir;
      const isolationExecution = sharedIsolationContext && sharedIsolationContext.execution && typeof sharedIsolationContext.execution === 'object'
        ? sharedIsolationContext.execution
        : null;
      const providerAuthEnv = buildProviderAuthEnv(effectiveProvider);
      const environmentCommandEnv = {
        ...providerAuthEnv,
        ...(sharedIsolationContext && sharedIsolationContext.extraEnv ? sharedIsolationContext.extraEnv : {}),
      };
      const resolvedEnvironment = resolveEnvironmentRunConfig(firstCase, environment, runtimeSkill);

      if (resolvedEnvironment.enabled && resolvedEnvironment.config) {
        bootstrapStatus = 'running';
        updateSkillTestChainRecord('skill_test_chain_runs', 'id', chainRunId, {
          bootstrap_status: bootstrapStatus,
          updated_at: nowIso(),
        });
        broadcastSkillTestChainRunSnapshot(skillId, chainRunId, 'progress', {
          exportChainId: candidate.exportChainId,
          status: 'running',
          progressLabel: '正在执行链级环境准备…',
          runnerStage: 'bootstrap_running',
        });
        const environmentRuntime = createSkillTestEnvironmentRuntime({
          sandboxToolAdapter: sharedIsolationContext && sharedIsolationContext.sandboxToolAdapter ? sharedIsolationContext.sandboxToolAdapter : null,
          toolRuntime: isolationExecution && isolationExecution.toolRuntime ? isolationExecution.toolRuntime : 'host',
          execution: isolationExecution || null,
          isolation: sharedIsolationContext && sharedIsolationContext.isolation ? sharedIsolationContext.isolation : null,
          driver: sharedIsolationContext && sharedIsolationContext.driver ? sharedIsolationContext.driver : null,
          projectDir,
          outputDir: sharedIsolationContext && sharedIsolationContext.outputDir ? sharedIsolationContext.outputDir : '',
          privateDir: sandbox.privateDir,
          skillId: firstCase.skillId,
          environmentCacheRootDir,
          commandEnv: environmentCommandEnv,
          availableEnv: {
            ...process.env,
            ...environmentCommandEnv,
          },
        });
        const environmentResult = await executeEnvironmentWorkflow(resolvedEnvironment.config, environmentRuntime, {
          allowBootstrap: resolvedEnvironment.allowBootstrap,
          persistAdvice: resolvedEnvironment.persistAdvice,
          source: resolvedEnvironment.source,
        });
        if (resolvedEnvironment.source && typeof resolvedEnvironment.source === 'object') {
          environmentResult.source = resolvedEnvironment.source;
        }
        if (environmentResult.status !== 'passed' && environmentResult.status !== 'skipped') {
          chainStatus = 'failed';
          bootstrapStatus = 'failed';
          errorCode = 'chain_run_bootstrap_failed';
          errorMessage = createEnvironmentFailureMessage(environmentResult);
          broadcastSkillTestChainRunSnapshot(skillId, chainRunId, 'progress', {
            exportChainId: candidate.exportChainId,
            status: chainStatus,
            progressLabel: errorMessage || '链级环境准备失败。',
            runnerStage: 'bootstrap_failed',
          });
        } else {
          bootstrapStatus = 'passed';
          broadcastSkillTestChainRunSnapshot(skillId, chainRunId, 'progress', {
            exportChainId: candidate.exportChainId,
            status: 'running',
            progressLabel: '链级环境准备完成，开始执行步骤…',
            runnerStage: 'bootstrap_passed',
          });
        }
      } else {
        bootstrapStatus = 'skipped';
        broadcastSkillTestChainRunSnapshot(skillId, chainRunId, 'progress', {
          exportChainId: candidate.exportChainId,
          status: 'running',
          progressLabel: '没有链级环境准备，直接执行步骤…',
          runnerStage: 'bootstrap_skipped',
        });
      }

      let previousStepSummary = '';
      let artifactRefs: any[] = [];

      for (let index = 0; index < candidate.cases.length && chainStatus === 'running'; index += 1) {
        const testCase = candidate.cases[index];
        const stepDefinition = stepDefinitions[index];
        const stepStartedAt = nowIso();
        updateSkillTestChainRecord('skill_test_chain_run_steps', 'id', stepDefinition.id, {
          status: 'running',
          started_at: stepStartedAt,
          carry_forward_json: JSON.stringify({
            previousStepSummary,
            artifactRefs,
            sharedEnvironmentHandle,
          }),
          updated_at: stepStartedAt,
        });
        broadcastSkillTestChainRunSnapshot(skillId, chainRunId, 'step_started', {
          exportChainId: candidate.exportChainId,
          status: 'running',
          currentStepId: stepDefinition.id,
          currentStepIndex: stepDefinition.sequenceIndex,
          currentTestCaseId: testCase.id,
          progressLabel: `正在运行链步骤 #${stepDefinition.sequenceIndex}…`,
          runnerStage: 'step_running',
        });

        let result: any = null;
        let stepSummary = '';
        const nextArtifactRefs: any[] = [];
        try {
          result = await executeRun(testCase, {
            provider,
            model,
            promptVersion,
            agentId,
            agentName,
            isolation,
            environment: { enabled: false },
            sharedIsolationContext,
            skipIsolationFinalize: true,
            chainContext: {
              previousStepSummary,
              artifactRefs,
              sharedEnvironmentHandle,
            },
          });
          stepSummary = buildSkillTestChainStepSummaryFromResult(result);
        } catch (error: any) {
          chainStatus = 'failed';
          errorCode = 'chain_run_step_failed';
          errorMessage = String(error && error.message || error || 'Chain step failed').trim();
          stepSummary = errorMessage || 'Chain step failed';
          const stepFinishedAt = nowIso();
          updateSkillTestChainRecord('skill_test_chain_run_steps', 'id', stepDefinition.id, {
            status: 'failed',
            skill_test_run_id: '',
            carry_forward_json: JSON.stringify({
              previousStepSummary,
              stepSummary,
              artifactRefs: nextArtifactRefs,
              sharedEnvironmentHandle,
            }),
            artifact_refs_json: JSON.stringify(nextArtifactRefs),
            error_code: errorCode,
            error_message: errorMessage,
            finished_at: stepFinishedAt,
            updated_at: stepFinishedAt,
          });
          markPendingSkillTestChainStepsSkipped(chainRunId, Number(stepDefinition.sequenceIndex || index + 1), `Skipped because sequenceIndex=${stepDefinition.sequenceIndex} failed.`);
          broadcastSkillTestChainRunSnapshot(skillId, chainRunId, 'step_failed', {
            exportChainId: candidate.exportChainId,
            status: chainStatus,
            currentStepId: stepDefinition.id,
            currentStepIndex: stepDefinition.sequenceIndex,
            currentTestCaseId: testCase.id,
            progressLabel: `链步骤 #${stepDefinition.sequenceIndex} 失败，后续步骤已跳过。`,
            runnerStage: 'step_failed',
          });
          break;
        }
        const stepFinishedAt = nowIso();

        const continuationDecision = evaluateSkillTestChainStepContinuation(result && result.run, candidate.stopPolicy);
        if (continuationDecision.continueChain) {
          lastCompletedStepIndex = index + 1;
          previousStepSummary = stepSummary;
          artifactRefs = nextArtifactRefs;
          updateSkillTestChainRecord('skill_test_chain_run_steps', 'id', stepDefinition.id, {
            status: continuationDecision.stepStatus,
            skill_test_run_id: String(result && result.run && result.run.id || '').trim(),
            carry_forward_json: JSON.stringify({
              previousStepSummary,
              stepSummary,
              artifactRefs: nextArtifactRefs,
              sharedEnvironmentHandle,
            }),
            artifact_refs_json: JSON.stringify(nextArtifactRefs),
            error_code: continuationDecision.errorCode || '',
            error_message: continuationDecision.errorMessage || '',
            finished_at: stepFinishedAt,
            updated_at: stepFinishedAt,
          });
          const chainRunPatch: Record<string, any> = {
            last_completed_step_index: lastCompletedStepIndex,
            updated_at: stepFinishedAt,
          };
          if (continuationDecision.warningFlag && !chainWarningFlags.has(continuationDecision.warningFlag)) {
            chainWarningFlags.add(continuationDecision.warningFlag);
            chainRunPatch.warning_flags_json = JSON.stringify([...chainWarningFlags]);
          }
          updateSkillTestChainRecord('skill_test_chain_runs', 'id', chainRunId, chainRunPatch);
          broadcastSkillTestChainRunSnapshot(skillId, chainRunId, 'step_completed', {
            exportChainId: candidate.exportChainId,
            status: 'running',
            currentStepId: stepDefinition.id,
            currentStepIndex: stepDefinition.sequenceIndex,
            currentTestCaseId: testCase.id,
            progressLabel: continuationDecision.progressLabel || `链步骤 #${stepDefinition.sequenceIndex} 通过。`,
            runnerStage: continuationDecision.stepStatus === 'continued' ? 'step_continued' : 'step_passed',
          });
          continue;
        }

        chainStatus = 'failed';
        errorCode = 'chain_run_step_failed';
        errorMessage = String(result && result.run && result.run.errorMessage || stepSummary || 'Chain step failed').trim();
        updateSkillTestChainRecord('skill_test_chain_run_steps', 'id', stepDefinition.id, {
          status: 'failed',
          skill_test_run_id: String(result && result.run && result.run.id || '').trim(),
          carry_forward_json: JSON.stringify({
            previousStepSummary,
            stepSummary,
            artifactRefs: nextArtifactRefs,
            sharedEnvironmentHandle,
          }),
          artifact_refs_json: JSON.stringify(nextArtifactRefs),
          error_code: errorCode,
          error_message: errorMessage,
          finished_at: stepFinishedAt,
          updated_at: stepFinishedAt,
        });
        markPendingSkillTestChainStepsSkipped(chainRunId, Number(stepDefinition.sequenceIndex || index + 1), `Skipped because sequenceIndex=${stepDefinition.sequenceIndex} failed.`);
        broadcastSkillTestChainRunSnapshot(skillId, chainRunId, 'step_failed', {
          exportChainId: candidate.exportChainId,
          status: chainStatus,
          currentStepId: stepDefinition.id,
          currentStepIndex: stepDefinition.sequenceIndex,
          currentTestCaseId: testCase.id,
          progressLabel: `链步骤 #${stepDefinition.sequenceIndex} 失败，后续步骤已跳过。`,
          runnerStage: 'step_failed',
        });
      }

      if (chainStatus === 'running') {
        chainStatus = 'passed';
      }
    } catch (error: any) {
      if (chainStatus === 'running') {
        chainStatus = lastCompletedStepIndex > 0 ? 'failed' : 'aborted';
      }
      errorCode = errorCode || (chainStatus === 'aborted' ? 'chain_run_aborted' : 'chain_run_step_failed');
      errorMessage = errorMessage || String(error && error.message || error || 'Chain run failed');
    } finally {
      try {
        if (sharedIsolationContext && typeof sharedIsolationContext.finalize === 'function') {
          const isolationEvidence = await Promise.resolve(sharedIsolationContext.finalize());
          teardownEvidenceJson = JSON.stringify(isolationEvidence || {});
          teardownStatus = isolationEvidence && isolationEvidence.unsafe ? 'failed' : 'passed';
          if (isolationEvidence && isolationEvidence.unsafe) {
            if (chainStatus === 'passed') {
              chainStatus = 'partial';
            } else if (chainStatus === 'running') {
              chainStatus = 'failed';
            }
            errorCode = errorCode || 'chain_run_teardown_failed';
            errorMessage = errorMessage || getSkillTestIsolationFailureMessage(isolationEvidence);
          }
        } else {
          teardownStatus = 'skipped';
        }
      } catch (error: any) {
        teardownStatus = 'failed';
        if (chainStatus === 'passed') {
          chainStatus = 'partial';
        } else if (chainStatus === 'running') {
          chainStatus = 'failed';
        }
        errorCode = errorCode || 'chain_run_teardown_failed';
        errorMessage = errorMessage || String(error && error.message || error || 'Chain teardown failed');
      }

      const finishedAt = nowIso();
      updateSkillTestChainRecord('skill_test_chain_runs', 'id', chainRunId, {
        status: chainStatus,
        bootstrap_status: bootstrapStatus,
        teardown_status: teardownStatus,
        error_code: errorCode,
        error_message: errorMessage,
        teardown_evidence_json: teardownEvidenceJson,
        last_completed_step_index: lastCompletedStepIndex,
        finished_at: finishedAt,
        updated_at: finishedAt,
      });
      broadcastSkillTestChainRunSnapshot(skillId, chainRunId, chainStatus === 'passed' || chainStatus === 'partial' ? 'completed' : 'failed', {
        exportChainId: candidate.exportChainId,
        status: chainStatus,
        progressLabel: chainStatus === 'passed'
          ? '链运行完成。'
          : chainStatus === 'partial'
            ? '链运行部分完成，请检查 teardown 或后续清理。'
            : errorMessage || '链运行失败。',
        runnerStage: 'chain_finished',
      });
    }

    return buildSkillTestChainRunResponse(skillId, chainRunId);
  }

  return {
    buildSkillTestChainRunResponse,
    executeSkillTestChainRun,
    listSkillTestChainRunSummaries,
  };
}
