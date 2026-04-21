import { randomUUID } from 'node:crypto';

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
const VALID_TEST_TYPES = new Set(['trigger', 'execution']);
const VALID_LOADING_MODES = new Set(['dynamic', 'full']);

function normalizeText(value: any) {
  return String(value || '').trim();
}

function normalizeMultilineText(value: any) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
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
  const normalized = normalizeText(value).toLowerCase() || 'trigger';
  return VALID_TEST_TYPES.has(normalized) ? normalized : 'trigger';
}

function normalizeLoadingMode(value: any) {
  const normalized = normalizeText(value).toLowerCase() || 'dynamic';
  return VALID_LOADING_MODES.has(normalized) ? normalized : 'dynamic';
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

  const skillId = normalizeText(options.skillId || input.skillId);
  if (!skillId) {
    throw new Error('测试矩阵缺少 skillId');
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

    return {
      rowId: normalizeText(row && row.rowId) || `row-${index + 1}`,
      scenario,
      priority: normalizePriority(row && row.priority),
      coverageReason,
      testType: normalizeTestType(row && row.testType),
      loadingMode: normalizeLoadingMode(row && row.loadingMode),
      riskPoints: normalizeStringArray(row && row.riskPoints),
      keyAssertions: normalizeStringArray(row && row.keyAssertions),
      includeInMvp: row && row.includeInMvp !== undefined ? Boolean(row.includeInMvp) : true,
      draftingHints: normalizeDraftingHints(row && row.draftingHints),
    };
  });

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
  const expectedBehavior = draftingHints.expectedBehavior
    || normalizeStringArray(row && row.keyAssertions).join('；')
    || normalizeMultilineText(row && row.coverageReason)
    || normalizeMultilineText(row && row.scenario);
  const noteParts = [
    `source=scenario:${normalizeMultilineText(row && row.scenario)}`,
    `priority=${normalizePriority(row && row.priority)}`,
    normalizeMultilineText(row && row.coverageReason) ? `coverage=${normalizeMultilineText(row && row.coverageReason)}` : '',
    Array.isArray(row && row.riskPoints) && row.riskPoints.length > 0 ? `risks=${row.riskPoints.join(' | ')}` : '',
    draftingHints.note || '',
  ].filter(Boolean);

  return {
    skillId: normalizedSkillId,
    loadingMode,
    testType,
    userPrompt: draftingHints.triggerPrompt || normalizeMultilineText(row && row.scenario),
    triggerPrompt: draftingHints.triggerPrompt || normalizeMultilineText(row && row.scenario),
    expectedTools: Array.isArray(draftingHints.expectedTools) ? draftingHints.expectedTools : [],
    expectedBehavior,
    expectedGoal: loadingMode === 'full' ? (draftingHints.expectedGoal || normalizeMultilineText(row && row.scenario)) : '',
    expectedSteps: loadingMode === 'full' && Array.isArray(draftingHints.expectedSteps) ? draftingHints.expectedSteps : [],
    expectedSequence: loadingMode === 'full' && Array.isArray(draftingHints.expectedSequence) ? draftingHints.expectedSequence : [],
    evaluationRubric: loadingMode === 'full' && draftingHints.evaluationRubric && typeof draftingHints.evaluationRubric === 'object'
      ? draftingHints.evaluationRubric
      : {},
    environmentConfig: draftingHints.environmentConfig && typeof draftingHints.environmentConfig === 'object'
      ? draftingHints.environmentConfig
      : {},
    caseStatus: 'draft',
    note: noteParts.join('\n'),
    sourceMetadata: {
      source: 'skill_test_chat_workbench',
      conversationId: normalizeText(options.conversationId),
      messageId: normalizeText(options.messageId),
      matrixId: normalizeText(matrix && matrix.matrixId),
      matrixRowId: normalizeText(row && row.rowId),
      matrixArtifactPath: normalizeText(matrix && matrix.sourceArtifactPath),
      agentRole: normalizeText(options.agentRole || 'scribe'),
      exportedBy: normalizeText(options.exportedBy || 'user'),
      exportedAt: new Date().toISOString(),
    },
  };
}
