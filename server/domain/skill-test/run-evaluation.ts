import { randomUUID } from 'node:crypto';

import {
  buildValidationIssue,
  hasOwn,
  isPlainObject,
  mergeValidationIssues,
  normalizeContainsComparableText,
  normalizeExpectedToolSpecs,
  normalizePositiveInteger,
  normalizeStepSequenceReference,
  normalizeToolNameForMatch,
  parseExpectedToolOrder,
  roundMetric,
  sanitizeEvaluationRubric,
  sanitizeExpectedSequence,
  toolNamesMatch,
  validateJudgeOutput,
} from './case-schema';
import { getCanonicalCasePrompt } from './run-prompt';

type StartRunImpl = (provider: any, model: any, prompt: string, options: any) => any;
type ProviderAuthEnvResolver = (provider: any) => Record<string, string>;

type SkillTestRunEvaluationDeps = {
  store?: {
    agentDir?: string;
    databasePath?: string;
  };
  startRunImpl: StartRunImpl;
  buildProviderAuthEnv?: ProviderAuthEnvResolver;
};

export function createSkillTestRunEvaluationHelpers(deps: SkillTestRunEvaluationDeps) {
  const store = deps.store || {};
  const startRunImpl = deps.startRunImpl;
  const buildProviderAuthEnv = typeof deps.buildProviderAuthEnv === 'function'
    ? deps.buildProviderAuthEnv
    : () => ({});

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
    const runtimeExtraEnv = isPlainObject(runtime && runtime.extraEnv) ? { ...(runtime.extraEnv as any) } : {};
    const providerAuthEnv = buildProviderAuthEnv(provider);
    const judgeProjectDir = String(runtime && runtime.projectDir || runtimeExtraEnv.CAFF_TRELLIS_PROJECT_DIR || '').trim();
    const judgeAgentDir = String(runtime && runtime.agentDir || store.agentDir || '').trim() || store.agentDir;
    const judgeSqlitePath = String(runtime && runtime.sqlitePath || store.databasePath || '').trim() || store.databasePath;

    let handle: any = null;

    try {
      handle = startRunImpl(provider, model, judgePrompt, {
        thinking: '',
        agentDir: judgeAgentDir,
        sqlitePath: judgeSqlitePath,
        cwd: judgeProjectDir || undefined,
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
          ...runtimeExtraEnv,
          ...providerAuthEnv,
          PI_AGENT_ID: `${judgeAgentIdBase}-judge`,
          PI_AGENT_NAME: 'Skill Trigger Judge',
          ...(sandboxDir ? { PI_AGENT_SANDBOX_DIR: sandboxDir } : {}),
          ...(privateDir ? { PI_AGENT_PRIVATE_DIR: privateDir } : {}),
          ...(judgeSqlitePath ? { PI_SQLITE_PATH: judgeSqlitePath } : {}),
          ...(judgeProjectDir ? { CAFF_TRELLIS_PROJECT_DIR: judgeProjectDir } : {}),
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
        sessionPath: String((error && error.sessionPath) || (handle && handle.sessionPath) || '').trim(),
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
    const runtimeExtraEnv = isPlainObject(runtime && runtime.extraEnv) ? { ...(runtime.extraEnv as any) } : {};
    const providerAuthEnv = buildProviderAuthEnv(provider);
    const judgeProjectDir = String(runtime && runtime.projectDir || runtimeExtraEnv.CAFF_TRELLIS_PROJECT_DIR || '').trim();
    const judgeAgentDir = String(runtime && runtime.agentDir || store.agentDir || '').trim() || store.agentDir;
    const judgeSqlitePath = String(runtime && runtime.sqlitePath || store.databasePath || '').trim() || store.databasePath;

    let handle: any = null;

    try {
      handle = startRunImpl(provider, model, judgePrompt, {
        thinking: '',
        agentDir: judgeAgentDir,
        sqlitePath: judgeSqlitePath,
        cwd: judgeProjectDir || undefined,
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
          ...runtimeExtraEnv,
          ...providerAuthEnv,
          PI_AGENT_ID: `${judgeAgentIdBase}-execution-judge`,
          PI_AGENT_NAME: 'Skill Execution Judge',
          ...(sandboxDir ? { PI_AGENT_SANDBOX_DIR: sandboxDir } : {}),
          ...(privateDir ? { PI_AGENT_PRIVATE_DIR: privateDir } : {}),
          ...(judgeSqlitePath ? { PI_SQLITE_PATH: judgeSqlitePath } : {}),
          ...(judgeProjectDir ? { CAFF_TRELLIS_PROJECT_DIR: judgeProjectDir } : {}),
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
        sessionPath: String((error && error.sessionPath) || (handle && handle.sessionPath) || '').trim(),
      };
    }
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


  return {
    buildExpectedSequenceSpecsWithDiagnostics,
    buildExpectedSequenceNames,
    normalizeSequenceEntryName,
    buildObservedSequenceCalls,
    evaluateExpectedToolCall,
    evaluateFullModeTrigger,
    evaluateToolSequence,
    buildFullModeExecutionEvaluation,
  };
}
