import { randomUUID } from 'node:crypto';

import { normalizeTestingDocDraftState } from './testing-doc-draft';

export const SKILL_TEST_DESIGN_CONVERSATION_TYPE = 'skill_test_design';

export const SKILL_TEST_DESIGN_PHASES = {
  COLLECTING_CONTEXT: 'collecting_context',
  PLANNING_MATRIX: 'planning_matrix',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  GENERATING_DRAFTS: 'generating_drafts',
  EXPORTED: 'exported',
} as const;

export const SKILL_TEST_DESIGN_FIXED_PARTICIPANTS = [
  { agentId: 'agent-strategist', role: 'planner' },
  { agentId: 'agent-critic', role: 'critic' },
  { agentId: 'agent-builder', role: 'scribe' },
] as const;

const VALID_PHASES = new Set(Object.values(SKILL_TEST_DESIGN_PHASES));
const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2']);
const VALID_TEST_TYPES = new Set(['trigger', 'execution', 'environment-build']);
const VALID_LOADING_MODES = new Set(['dynamic', 'full']);
const VALID_ENVIRONMENT_SOURCES = new Set(['skill_contract', 'user_supplied', 'missing']);
const VALID_SCENARIO_KINDS = new Set(['single', 'chain_step']);
const VALID_CHAIN_INHERITANCE = new Set(['filesystem', 'artifacts', 'conversation', 'externalState']);

function normalizeText(value: any) {
  return String(value || '').trim();
}

function normalizeMultilineText(value: any) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function hasOwn(value: any, key: string) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
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

function normalizeStringArray(value: any) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized = [] as string[];

  for (const entry of value) {
    const text = normalizeText(entry);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}

function normalizePriority(value: any) {
  const normalized = normalizeText(value).toUpperCase() || 'P1';
  return VALID_PRIORITIES.has(normalized) ? normalized : 'P1';
}

function normalizePhase(value: any, fallback: string = SKILL_TEST_DESIGN_PHASES.COLLECTING_CONTEXT) {
  const normalized = normalizeText(value).toLowerCase() || fallback;
  return VALID_PHASES.has(normalized as any) ? normalized : fallback;
}

function normalizeTestType(value: any) {
  const normalized = normalizeText(value).toLowerCase() || 'execution';
  return VALID_TEST_TYPES.has(normalized) ? normalized : 'execution';
}

function normalizeLoadingMode(value: any) {
  const normalized = normalizeText(value).toLowerCase() || 'full';
  return VALID_LOADING_MODES.has(normalized) ? normalized : 'full';
}

function normalizeEnvironmentContractRef(value: any) {
  const normalized = normalizeText(value).replace(/\\/g, '/');
  if (!normalized) {
    return '';
  }

  if (normalized.includes('\0') || /^file:/iu.test(normalized) || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) {
    return null;
  }

  const hashIndex = normalized.indexOf('#');
  if (hashIndex <= 0 || hashIndex >= normalized.length - 1) {
    return null;
  }

  const relativePath = normalized.slice(0, hashIndex);
  const anchor = normalized.slice(hashIndex + 1).trim();
  if (!anchor) {
    return null;
  }

  const segments = relativePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }

  return `${relativePath}#${anchor}`;
}

function normalizeEnvironmentSource(value: any, fallbackRef = '') {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized) {
    return VALID_ENVIRONMENT_SOURCES.has(normalized) ? normalized : null;
  }
  return fallbackRef ? 'skill_contract' : 'missing';
}

function hasChainMetadata(value: any) {
  return Boolean(
    normalizeText(value && value.chainId)
    || normalizeText(value && value.chainName)
    || normalizePositiveInteger(value && value.sequenceIndex)
    || (Array.isArray(value && value.dependsOnRowIds) && value.dependsOnRowIds.length > 0)
    || (Array.isArray(value && value.inheritance) && value.inheritance.length > 0)
    || normalizeText(value && value.scenarioKind).toLowerCase() === 'chain_step'
  );
}

function normalizeScenarioKind(value: any, row: any) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized) {
    return VALID_SCENARIO_KINDS.has(normalized) ? normalized : null;
  }
  return hasChainMetadata(row) ? 'chain_step' : 'single';
}

function normalizeDependsOnRowIds(value: any) {
  return normalizeStringArray(value);
}

function normalizeChainInheritanceEntry(value: any) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }

  const token = normalized.replace(/[\s_-]+/g, '').toLowerCase();
  if (token === 'filesystem') {
    return 'filesystem';
  }
  if (token === 'artifacts') {
    return 'artifacts';
  }
  if (token === 'conversation') {
    return 'conversation';
  }
  if (token === 'externalstate') {
    return 'externalState';
  }
  return null;
}

function normalizeInheritance(value: any) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized = [] as string[];

  for (const entry of value) {
    const candidate = normalizeChainInheritanceEntry(entry);
    if (candidate == null) {
      return null;
    }
    if (!candidate || seen.has(candidate) || !VALID_CHAIN_INHERITANCE.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }

  return normalized;
}

function normalizeDraftingHints(value: any) {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    return {
      note: normalizeMultilineText(value),
    };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return {
    triggerPrompt: normalizeMultilineText(value.triggerPrompt || value.userPrompt || value.prompt),
    expectedBehavior: normalizeMultilineText(value.expectedBehavior),
    expectedGoal: normalizeMultilineText(value.expectedGoal),
    expectedTools: Array.isArray(value.expectedTools) ? value.expectedTools : [],
    expectedSteps: Array.isArray(value.expectedSteps) ? value.expectedSteps : [],
    expectedSequence: Array.isArray(value.expectedSequence) ? value.expectedSequence : [],
    evaluationRubric: value.evaluationRubric && typeof value.evaluationRubric === 'object' && !Array.isArray(value.evaluationRubric)
      ? value.evaluationRubric
      : {},
    environmentConfig: value.environmentConfig && typeof value.environmentConfig === 'object' && !Array.isArray(value.environmentConfig)
      ? value.environmentConfig
      : {},
    note: normalizeMultilineText(value.note),
  };
}

export function isSkillTestDesignConversation(value: any) {
  return Boolean(value && normalizeText(value.type) === SKILL_TEST_DESIGN_CONVERSATION_TYPE);
}

export function buildSkillTestDesignParticipantRoles() {
  return Object.fromEntries(SKILL_TEST_DESIGN_FIXED_PARTICIPANTS.map((entry) => [entry.agentId, entry.role]));
}

export function buildSkillTestDesignParticipants(skillId: any) {
  const normalizedSkillId = normalizeText(skillId);
  return SKILL_TEST_DESIGN_FIXED_PARTICIPANTS.map((entry) => ({
    agentId: entry.agentId,
    modelProfileId: null,
    conversationSkillIds: normalizedSkillId ? [normalizedSkillId] : [],
  }));
}

export function createSkillTestDesignMetadata(skill: any, overrides: any = {}) {
  const timestamp = new Date().toISOString();
  const skillId = normalizeText(overrides.skillId || skill && skill.id);
  const skillName = normalizeText(overrides.skillName || skill && skill.name);
  const phase = normalizePhase(overrides.phase, SKILL_TEST_DESIGN_PHASES.COLLECTING_CONTEXT);
  const participantRoles = buildSkillTestDesignParticipantRoles();

  return {
    skillTestDesign: {
      version: 1,
      skillId,
      skillName,
      phase,
      participantRoles,
      matrix: null,
      confirmation: null,
      export: null,
      testingDocDraft: null,
      environmentContract: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

export function getSkillTestDesignState(conversation: any) {
  const metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object'
    ? conversation.metadata
    : {};
  const rawState = metadata.skillTestDesign && typeof metadata.skillTestDesign === 'object'
    ? metadata.skillTestDesign
    : null;

  if (!rawState) {
    return null;
  }

  const participantRoles = rawState.participantRoles && typeof rawState.participantRoles === 'object'
    ? rawState.participantRoles
    : buildSkillTestDesignParticipantRoles();

  return {
    version: Number.isInteger(rawState.version) ? rawState.version : 1,
    skillId: normalizeText(rawState.skillId),
    skillName: normalizeText(rawState.skillName),
    phase: normalizePhase(rawState.phase),
    participantRoles,
    matrix: rawState.matrix && typeof rawState.matrix === 'object' ? rawState.matrix : null,
    confirmation: rawState.confirmation && typeof rawState.confirmation === 'object' ? rawState.confirmation : null,
    export: rawState.export && typeof rawState.export === 'object' ? rawState.export : null,
    testingDocDraft: normalizeTestingDocDraftState(rawState.testingDocDraft),
    environmentContract: rawState.environmentContract && typeof rawState.environmentContract === 'object' ? rawState.environmentContract : null,
    createdAt: normalizeText(rawState.createdAt),
    updatedAt: normalizeText(rawState.updatedAt),
  };
}

export function setSkillTestDesignStateMetadata(metadata: any, nextState: any) {
  const baseMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    ...baseMetadata,
    skillTestDesign: {
      ...nextState,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function buildSkillTestDesignCaseSummary(db: any, skillId: any) {
  const normalizedSkillId = normalizeText(skillId);
  if (!db || !normalizedSkillId) {
    return {
      totalCases: 0,
      draftCases: 0,
      readyCases: 0,
      archivedCases: 0,
      recentPrompts: [],
    };
  }

  try {
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total_cases,
        COALESCE(SUM(CASE WHEN LOWER(TRIM(COALESCE(case_status, 'draft'))) = 'draft' THEN 1 ELSE 0 END), 0) AS draft_cases,
        COALESCE(SUM(CASE WHEN LOWER(TRIM(COALESCE(case_status, 'draft'))) = 'ready' THEN 1 ELSE 0 END), 0) AS ready_cases,
        COALESCE(SUM(CASE WHEN LOWER(TRIM(COALESCE(case_status, 'draft'))) = 'archived' THEN 1 ELSE 0 END), 0) AS archived_cases
      FROM skill_test_cases
      WHERE skill_id = ?
    `).get(normalizedSkillId);
    const promptRows = db.prepare(`
      SELECT trigger_prompt
      FROM skill_test_cases
      WHERE skill_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 5
    `).all(normalizedSkillId);

    return {
      totalCases: Number(counts && counts.total_cases || 0),
      draftCases: Number(counts && counts.draft_cases || 0),
      readyCases: Number(counts && counts.ready_cases || 0),
      archivedCases: Number(counts && counts.archived_cases || 0),
      recentPrompts: promptRows
        .map((row: any) => normalizeMultilineText(row && row.trigger_prompt))
        .filter(Boolean),
    };
  } catch {
    return {
      totalCases: 0,
      draftCases: 0,
      readyCases: 0,
      archivedCases: 0,
      recentPrompts: [],
    };
  }
}

export function normalizeSkillTestMatrix(input: any, options: any = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('测试矩阵必须是对象');
  }

  const providedSkillId = normalizeText(input.skillId);
  const skillId = normalizeText(options.skillId || providedSkillId);
  if (!skillId) {
    throw new Error('测试矩阵缺少 skillId');
  }
  if (providedSkillId && normalizeText(options.skillId) && providedSkillId !== normalizeText(options.skillId)) {
    throw new Error('测试矩阵 skillId 与当前会话目标 skill 不一致');
  }

  const rowsInput = Array.isArray(input.rows) ? input.rows : [];
  if (rowsInput.length === 0) {
    throw new Error('测试矩阵至少需要一行 rows');
  }

  const rows = rowsInput.map((row: any, index: number) => {
    const scenario = normalizeMultilineText(row && row.scenario);
    const coverageReason = normalizeMultilineText(row && row.coverageReason);
    if (!scenario) {
      throw new Error(`测试矩阵第 ${index + 1} 行缺少 scenario`);
    }
    if (!coverageReason) {
      throw new Error(`测试矩阵第 ${index + 1} 行缺少 coverageReason`);
    }

    const rowId = normalizeText(row && row.rowId) || `row-${index + 1}`;
    const environmentContractRef = normalizeEnvironmentContractRef(
      hasOwn(row, 'environmentContractRef')
        ? row.environmentContractRef
        : row && row.environment_contract_ref
    );
    if (environmentContractRef == null) {
      throw new Error(`测试矩阵第 ${index + 1} 行 environmentContractRef 格式不合法`);
    }

    const environmentSource = normalizeEnvironmentSource(
      hasOwn(row, 'environmentSource')
        ? row.environmentSource
        : row && row.environment_source,
      environmentContractRef
    );
    if (!environmentSource) {
      throw new Error(`测试矩阵第 ${index + 1} 行 environmentSource 不合法`);
    }

    const scenarioKind = normalizeScenarioKind(row && row.scenarioKind, row);
    if (!scenarioKind) {
      throw new Error(`测试矩阵第 ${index + 1} 行 scenarioKind 不合法`);
    }

    const sequenceIndex = normalizePositiveInteger(row && row.sequenceIndex);
    if (hasOwn(row, 'sequenceIndex') && row.sequenceIndex != null && row.sequenceIndex !== '' && sequenceIndex == null) {
      throw new Error(`测试矩阵第 ${index + 1} 行 sequenceIndex 必须是正整数`);
    }

    const inheritance = normalizeInheritance(row && row.inheritance);
    if (inheritance == null) {
      throw new Error(`测试矩阵第 ${index + 1} 行 inheritance 存在不支持的值`);
    }

    return {
      rowId,
      scenario,
      priority: normalizePriority(row && row.priority),
      coverageReason,
      testType: normalizeTestType(row && row.testType),
      loadingMode: normalizeLoadingMode(row && row.loadingMode),
      riskPoints: normalizeStringArray(row && row.riskPoints),
      keyAssertions: normalizeStringArray(row && row.keyAssertions),
      includeInMvp: row && row.includeInMvp !== undefined
        ? Boolean(row.includeInMvp)
        : row && row.includeInExport !== undefined
          ? Boolean(row.includeInExport)
          : row && row.include_in_export !== undefined
            ? Boolean(row.include_in_export)
            : true,
      draftingHints: normalizeDraftingHints(row && row.draftingHints),
      environmentContractRef,
      environmentSource,
      scenarioKind,
      chainId: normalizeText(row && row.chainId),
      chainName: normalizeText(row && row.chainName),
      sequenceIndex,
      dependsOnRowIds: normalizeDependsOnRowIds(row && row.dependsOnRowIds),
      inheritance,
    };
  });

  const seenRowIds = new Set<string>();
  for (const row of rows) {
    if (seenRowIds.has(row.rowId)) {
      throw new Error(`测试矩阵存在重复 rowId: ${row.rowId}`);
    }
    seenRowIds.add(row.rowId);
  }

  return {
    kind: 'skill_test_matrix',
    matrixId: normalizeText(input.matrixId) || `matrix-${randomUUID()}`,
    skillId,
    phase: normalizePhase(input.phase, SKILL_TEST_DESIGN_PHASES.PLANNING_MATRIX),
    rows,
  };
}

export function normalizeSkillTestPromptKey(value: any) {
  return normalizeMultilineText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function buildSkillTestDraftInputFromMatrixRow(skillId: any, matrix: any, row: any, options: any = {}) {
  const normalizedSkillId = normalizeText(skillId || row && row.skillId);
  if (!normalizedSkillId) {
    throw new Error('导出草稿缺少 skillId');
  }

  const draftingHints = normalizeDraftingHints(row && row.draftingHints);
  const loadingMode = normalizeLoadingMode(row && row.loadingMode);
  const testType = normalizeTestType(row && row.testType);
  const environmentContractRef = normalizeText(row && row.environmentContractRef);
  const environmentSource = normalizeEnvironmentSource(row && row.environmentSource, environmentContractRef) || 'missing';
  const scenarioKind = normalizeScenarioKind(row && row.scenarioKind, row) || 'single';
  const dependsOnRowIds = normalizeDependsOnRowIds(row && row.dependsOnRowIds);
  const inheritance = normalizeInheritance(row && row.inheritance) || [];
  const expectedBehavior = draftingHints.expectedBehavior
    || normalizeStringArray(row && row.keyAssertions).join('；')
    || normalizeMultilineText(row && row.coverageReason)
    || normalizeMultilineText(row && row.scenario);
  const noteParts = [
    `场景：${normalizeMultilineText(row && row.scenario)}`,
    `优先级：${normalizePriority(row && row.priority)}`,
    normalizeMultilineText(row && row.coverageReason) ? `覆盖理由：${normalizeMultilineText(row && row.coverageReason)}` : '',
    Array.isArray(row && row.riskPoints) && row.riskPoints.length > 0 ? `风险点：${row.riskPoints.join(' | ')}` : '',
    draftingHints.note || '',
  ].filter(Boolean);

  const sourceMetadata: any = {
    source: 'skill_test_chat_workbench',
    conversationId: normalizeText(options.conversationId),
    messageId: normalizeText(options.messageId),
    matrixId: normalizeText(matrix && matrix.matrixId),
    matrixRowId: normalizeText(row && row.rowId),
    matrixArtifactPath: normalizeText(matrix && matrix.sourceArtifactPath),
    agentRole: normalizeText(options.agentRole || 'scribe'),
    exportedBy: normalizeText(options.exportedBy || 'user'),
    exportedAt: new Date().toISOString(),
    skillTestDesign: {
      environmentContractRef,
      environmentSource,
      scenarioKind,
    },
  };

  if (scenarioKind === 'chain_step' || normalizeText(row && row.chainId) || normalizeText(row && row.chainName) || dependsOnRowIds.length > 0 || inheritance.length > 0) {
    sourceMetadata.skillTestDesign.chainPlanning = {
      matrixId: normalizeText(matrix && matrix.matrixId),
      rowId: normalizeText(row && row.rowId),
      scenarioKind,
      chainId: normalizeText(row && row.chainId),
      chainName: normalizeText(row && row.chainName),
      sequenceIndex: normalizePositiveInteger(row && row.sequenceIndex),
      dependsOnRowIds,
      inheritance,
      environmentContractRef,
      environmentSource,
    };
  }

  // environment-build rows are contract-driven: they skip prompt/goal fields
  // and rely on TESTING.md contract or user-supplied environmentConfig instead.
  if (testType === 'environment-build') {
    const envConfig = draftingHints.environmentConfig && typeof draftingHints.environmentConfig === 'object'
      ? draftingHints.environmentConfig
      : {};
    const draftInput: any = {
      skillId: normalizedSkillId,
      loadingMode,
      testType: 'environment-build',
      userPrompt: draftingHints.triggerPrompt || `构建 ${normalizedSkillId} 的测试环境`,
      expectedTools: [],
      expectedBehavior: expectedBehavior || '产出 environment-manifest.json，可选产出环境镜像',
      environmentConfig: envConfig,
      caseStatus: 'draft',
      note: noteParts.join('\n'),
      sourceMetadata,
    };
    return draftInput;
  }

  const draftInput: any = {
    skillId: normalizedSkillId,
    loadingMode,
    testType,
    userPrompt: draftingHints.triggerPrompt || normalizeMultilineText(row && row.scenario),
    triggerPrompt: draftingHints.triggerPrompt || normalizeMultilineText(row && row.scenario),
    expectedTools: Array.isArray(draftingHints.expectedTools) ? draftingHints.expectedTools : [],
    expectedBehavior,
    environmentConfig: draftingHints.environmentConfig && typeof draftingHints.environmentConfig === 'object'
      ? draftingHints.environmentConfig
      : {},
    caseStatus: 'draft',
    note: noteParts.join('\n'),
    sourceMetadata,
  };

  if (loadingMode === 'full') {
    draftInput.expectedGoal = draftingHints.expectedGoal || normalizeMultilineText(row && row.scenario);
    if (Array.isArray(draftingHints.expectedSteps)) {
      draftInput.expectedSteps = draftingHints.expectedSteps.map((step: any, idx: number) => {
        if (typeof step === 'string') {
          const title = String(step);
          return { id: `step-${idx + 1}`, title, expectedBehavior: title, failureIfMissing: `未完成: ${title}` };
        }
        return step;
      });
    }
    if (Array.isArray(draftingHints.expectedSequence) && draftInput.expectedSteps) {
      // Generate sequence from step IDs in order; the draftingHints sequence
      // uses descriptive references that don't map to generated step ids
      const steps = draftInput.expectedSteps as Array<{id?: string}>;
      draftInput.expectedSequence = steps.map((s) => s.id).filter(Boolean) as string[];
    }
    draftInput.evaluationRubric = draftingHints.evaluationRubric && typeof draftingHints.evaluationRubric === 'object'
      ? draftingHints.evaluationRubric
      : {};
  }

  return draftInput;
}
