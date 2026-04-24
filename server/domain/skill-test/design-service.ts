import { createHttpError } from '../../http/http-errors';
import {
  buildValidationIssue,
  createValidationHttpError,
  isPlainObject,
  normalizePositiveInteger,
  normalizePromptText,
} from './case-schema';
import {
  SKILL_TEST_DESIGN_CONVERSATION_TYPE,
  SKILL_TEST_DESIGN_PHASES,
  buildSkillTestDesignCaseSummary,
  buildSkillTestDraftInputFromMatrixRow,
  getSkillTestDesignState,
  normalizeSkillTestPromptKey,
  setSkillTestDesignStateMetadata,
} from './chat-workbench-mode';
import { buildAutomaticTestingDocPreviewState } from './testing-doc-auto-preview';
import { buildTestingDocContractSummary } from './testing-doc-target';

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParseObject(value: any) {
  if (!value || typeof value === 'object') {
    return isPlainObject(value) ? value : {};
  }
  try {
    const parsed = JSON.parse(String(value));
    return isPlainObject(parsed) ? parsed : {};
  } catch (_parseError) {
    return {};
  }
}

function normalizeSkillTestEnvironmentBuildProfile(value: any) {
  const environmentConfig = isPlainObject(value && value.environmentConfig)
    ? value.environmentConfig
    : safeJsonParseObject(value && value.environment_config_json);
  const sourceMetadata = isPlainObject(value && value.sourceMetadata)
    ? value.sourceMetadata
    : safeJsonParseObject(value && value.source_metadata_json);
  const asset = isPlainObject(environmentConfig && environmentConfig.asset) ? environmentConfig.asset : {};
  const environmentBuild = isPlainObject(sourceMetadata && sourceMetadata.environmentBuild) ? sourceMetadata.environmentBuild : {};
  const environmentBuildAsset = isPlainObject(environmentBuild && environmentBuild.asset) ? environmentBuild.asset : {};

  const candidates = [
    environmentConfig && environmentConfig.envProfile,
    environmentConfig && environmentConfig.env_profile,
    environmentConfig && environmentConfig.profile,
    asset && asset.envProfile,
    asset && asset.env_profile,
    asset && asset.profile,
    environmentBuild && environmentBuild.envProfile,
    environmentBuild && environmentBuild.env_profile,
    environmentBuild && environmentBuild.profile,
    environmentBuildAsset && environmentBuildAsset.envProfile,
    environmentBuildAsset && environmentBuildAsset.env_profile,
    environmentBuildAsset && environmentBuildAsset.profile,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return 'default';
}

function normalizeSkillTestEnvironmentBuildContractRef(value: any) {
  const sourceMetadata = isPlainObject(value && value.sourceMetadata)
    ? value.sourceMetadata
    : safeJsonParseObject(value && value.source_metadata_json);
  const designMetadata = isPlainObject(sourceMetadata && sourceMetadata.skillTestDesign)
    ? sourceMetadata.skillTestDesign
    : {};
  return String(
    value && value.environmentContractRef
    || designMetadata && designMetadata.environmentContractRef
    || ''
  ).trim().replace(/\\/g, '/');
}

type SkillTestStoredDraftRow = {
  id?: unknown;
  loading_mode?: unknown;
  test_type?: unknown;
  trigger_prompt?: unknown;
  case_status?: unknown;
  environment_config_json?: unknown;
  source_metadata_json?: unknown;
};

type SkillTestDraftInputLike = {
  loadingMode?: unknown;
  testType?: unknown;
  triggerPrompt?: unknown;
  environmentConfig?: unknown;
  environment_config_json?: unknown;
  sourceMetadata?: unknown;
  source_metadata_json?: unknown;
  environmentContractRef?: unknown;
  [key: string]: unknown;
};

type SkillTestDesignMatrixRowLike = {
  rowId?: unknown;
  [key: string]: unknown;
};

type SkillTestDraftLookupOptions = {
  excludeCaseIds?: unknown;
};

type SkillTestDraftMatch = {
  id: string;
  loadingMode: string;
  testType: string;
  triggerPrompt: string;
  caseStatus: string;
  envProfile: string;
  environmentContractRef: string;
};

type SkillTestConversationDraftCandidate = SkillTestDraftMatch & {
  conversationId: string;
  matrixRowId: string;
  source: string;
};

function buildExcludedCaseIdsSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
      : []
  );
}

function buildSkillTestDraftMatch(storedRow: SkillTestStoredDraftRow): SkillTestDraftMatch {
  return {
    id: String(storedRow && storedRow.id || '').trim(),
    loadingMode: String(storedRow && storedRow.loading_mode || '').trim().toLowerCase() || 'dynamic',
    testType: String(storedRow && storedRow.test_type || '').trim().toLowerCase() || 'trigger',
    triggerPrompt: normalizePromptText(storedRow && storedRow.trigger_prompt),
    caseStatus: String(storedRow && storedRow.case_status || 'draft').trim().toLowerCase() || 'draft',
    envProfile: normalizeSkillTestEnvironmentBuildProfile(storedRow),
    environmentContractRef: normalizeSkillTestEnvironmentBuildContractRef(storedRow),
  };
}

function buildSkillTestConversationDraftCandidate(storedRow: SkillTestStoredDraftRow): SkillTestConversationDraftCandidate {
  const sourceMetadata = safeJsonParseObject(storedRow && storedRow.source_metadata_json);
  const designMetadata = isPlainObject(sourceMetadata && sourceMetadata.skillTestDesign)
    ? sourceMetadata.skillTestDesign
    : {};
  const draftMatch = buildSkillTestDraftMatch(storedRow);

  return {
    ...draftMatch,
    conversationId: String(sourceMetadata && sourceMetadata.conversationId || '').trim(),
    matrixRowId: String(sourceMetadata && sourceMetadata.matrixRowId || '').trim(),
    source: String(sourceMetadata && sourceMetadata.source || '').trim(),
    environmentContractRef: String(
      designMetadata && designMetadata.environmentContractRef
      || draftMatch.environmentContractRef
      || ''
    ).trim(),
  };
}

export function createSkillTestDesignService(options: any = {}) {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
  const createTestCase = typeof options.createTestCase === 'function' ? options.createTestCase : null;
  const updateTestCase = typeof options.updateTestCase === 'function' ? options.updateTestCase : null;
  const getTestCase = typeof options.getTestCase === 'function' ? options.getTestCase : () => null;
  const ensureSchema = typeof options.ensureSchema === 'function' ? options.ensureSchema : () => {};
  const nowIsoImpl = typeof options.nowIso === 'function' ? options.nowIso : nowIso;

  function requireSkillTestDesignConversation(conversationId: string) {
    const conversation = store.getConversation(conversationId);
    if (!conversation) {
      throw createHttpError(404, 'Conversation not found');
    }
    if (String(conversation.type || '').trim() !== SKILL_TEST_DESIGN_CONVERSATION_TYPE) {
      throw createHttpError(400, 'Conversation is not a Skill Test 设计模式会话');
    }
    const designState = getSkillTestDesignState(conversation);
    if (!designState || !designState.skillId) {
      throw createHttpError(400, 'Skill Test 设计模式缺少目标 skill 配置');
    }
    return { conversation, designState };
  }

  function summarizeSkillTestDesignConversation(conversation: any, designState: any) {
    const skill = skillRegistry && typeof skillRegistry.getSkill === 'function' ? skillRegistry.getSkill(designState.skillId) : null;
    const environmentContract = skill ? buildTestingDocContractSummary(skill) : (designState.environmentContract || null);
    return {
      conversationId: conversation.id,
      skill: skill
        ? {
            id: String(skill.id || '').trim(),
            name: String(skill.name || '').trim(),
            description: String(skill.description || '').trim(),
            path: String(skill.path || '').trim(),
          }
        : {
            id: designState.skillId,
            name: designState.skillName || designState.skillId,
            description: '',
            path: '',
          },
      phase: String(designState.phase || '').trim() || SKILL_TEST_DESIGN_PHASES.COLLECTING_CONTEXT,
      participantRoles: designState.participantRoles && typeof designState.participantRoles === 'object' ? designState.participantRoles : {},
      matrix: designState.matrix || null,
      confirmation: designState.confirmation || null,
      export: designState.export || null,
      testingDocDraft: designState.testingDocDraft || null,
      environmentContract,
      existingCaseSummary: buildSkillTestDesignCaseSummary(store.db, designState.skillId),
    };
  }

  function updateSkillTestDesignConversationState(conversation: any, nextState: any) {
    const currentMetadata = conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : {};
    const metadata = setSkillTestDesignStateMetadata(currentMetadata, nextState);
    return store.updateConversation(conversation.id, {
      title: conversation.title,
      metadata,
    });
  }

  function ensureAutomaticTestingDocPreview(conversation: any, designState: any) {
    const skill = skillRegistry && typeof skillRegistry.getSkill === 'function' ? skillRegistry.getSkill(designState.skillId) : null;
    const preview = buildAutomaticTestingDocPreviewState(skill, designState, {
      conversationId: conversation && conversation.id,
      createdBy: 'system',
      agentRole: 'system',
      createdAt: nowIsoImpl(),
    });

    if (!preview.created) {
      return {
        conversation,
        designState,
        environmentContract: preview.environmentContract || (designState && designState.environmentContract) || null,
      };
    }

    const nextConversation = updateSkillTestDesignConversationState(conversation, preview.nextState) || conversation;
    return {
      conversation: nextConversation,
      designState: getSkillTestDesignState(nextConversation),
      environmentContract: preview.environmentContract,
    };
  }

  function buildSkillTestDesignConfirmationRecord(conversation: any, designState: any, matrix: any, body: any = {}) {
    if (!matrix || !matrix.matrixId) {
      throw createValidationHttpError(
        buildValidationIssue('matrix_missing', 'error', 'matrix', '当前没有可确认的测试矩阵')
      );
    }

    const confirmationMessageId = String(body && (body.confirmationMessageId || body.messageId) || matrix.sourceMessageId || '').trim();
    if (!confirmationMessageId) {
      throw createValidationHttpError(
        buildValidationIssue('matrix_source_message_required', 'error', 'messageId', '确认/导出测试矩阵必须关联来源 assistant 消息')
      );
    }

    const sourceMessage = Array.isArray(conversation.messages)
      ? conversation.messages.find((message: any) => message && message.id === confirmationMessageId)
      : null;

    if (!sourceMessage || sourceMessage.role !== 'assistant') {
      throw createValidationHttpError(
        buildValidationIssue('matrix_source_message_invalid', 'error', 'messageId', 'messageId 必须指向当前会话中的 assistant 消息')
      );
    }

    const sourceAgentRole = sourceMessage && sourceMessage.agentId
      ? String(designState.participantRoles && designState.participantRoles[sourceMessage.agentId] || '').trim()
      : String(matrix.agentRole || '').trim();

    return {
      matrixId: String(matrix.matrixId || '').trim(),
      messageId: confirmationMessageId,
      agentRole: sourceAgentRole || 'scribe',
      confirmedAt: nowIsoImpl(),
    };
  }

  function normalizeSkillTestDesignEnvironmentSource(row: any) {
    const normalized = String(row && row.environmentSource || '').trim().toLowerCase();
    if (normalized === 'skill_contract' || normalized === 'user_supplied' || normalized === 'missing') {
      return normalized;
    }
    return String(row && row.environmentContractRef || '').trim() ? 'skill_contract' : 'missing';
  }

  function isSkillTestDesignRowIncludedInExport(row: any) {
    if (!row) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(row, 'includeInMvp')) {
      return row.includeInMvp !== false;
    }
    if (Object.prototype.hasOwnProperty.call(row, 'includeInExport')) {
      return row.includeInExport !== false;
    }
    if (Object.prototype.hasOwnProperty.call(row, 'include_in_export')) {
      return row.include_in_export !== false;
    }
    return true;
  }

  function hasSkillTestDesignChainMetadata(row: any) {
    return Boolean(
      String(row && row.scenarioKind || '').trim().toLowerCase() === 'chain_step'
      || String(row && row.chainId || '').trim()
      || String(row && row.chainName || '').trim()
      || normalizePositiveInteger(row && row.sequenceIndex)
      || (Array.isArray(row && row.dependsOnRowIds) && row.dependsOnRowIds.length > 0)
      || (Array.isArray(row && row.inheritance) && row.inheritance.length > 0)
    );
  }

  function isSkillTestDesignChainRow(row: any) {
    return hasSkillTestDesignChainMetadata(row);
  }

  function isSkillTestDesignDraftExportCandidate(row: any) {
    const loadingMode = String(row && row.loadingMode || '').trim().toLowerCase();
    const testType = String(row && row.testType || '').trim().toLowerCase();
    return (loadingMode === 'dynamic' || loadingMode === 'full')
      && (testType === 'trigger' || testType === 'execution' || testType === 'environment-build');
  }

  function skillTestDesignRowDependsOnRealEnvironment(row: any) {
    const testType = String(row && row.testType || '').trim().toLowerCase();
    if (testType === 'execution' || testType === 'environment-build') {
      return true;
    }

    const inheritance = Array.isArray(row && row.inheritance)
      ? row.inheritance.map((entry: any) => String(entry || '').trim())
      : [];
    if (inheritance.includes('externalState')) {
      return true;
    }

    const environmentConfig = row && row.draftingHints && typeof row.draftingHints === 'object'
      ? row.draftingHints.environmentConfig
      : null;
    return isPlainObject(environmentConfig) && Object.keys(environmentConfig).length > 0;
  }

  function buildSkillTestMatrixRowPath(matrix: any, rowId: string, field = '') {
    const rows = Array.isArray(matrix && matrix.rows) ? matrix.rows : [];
    const index = rows.findIndex((row: any) => String(row && row.rowId || '').trim() === rowId);
    const basePath = index >= 0 ? `matrix.rows[${index}]` : 'matrix.rows';
    return field ? `${basePath}.${field}` : basePath;
  }

  function buildSkillTestDesignMatrixValidationIssues(matrix: any) {
    const issues: any[] = [];
    const rows = Array.isArray(matrix && matrix.rows) ? matrix.rows : [];
    const includedRows = rows.filter((row: any) => isSkillTestDesignRowIncludedInExport(row));
    const includedRowMap = new Map<string, any>();

    for (const row of includedRows) {
      const rowId = String(row && row.rowId || '').trim();
      if (rowId) {
        includedRowMap.set(rowId, row);
      }
    }

    const exportableRowIds = new Set(
      includedRows
        .filter((row: any) => isSkillTestDesignDraftExportCandidate(row))
        .map((row: any) => String(row && row.rowId || '').trim())
        .filter(Boolean)
    );
    const chainGroups = new Map<string, any[]>();

    for (const row of includedRows) {
      const rowId = String(row && row.rowId || '').trim();
      const environmentSource = normalizeSkillTestDesignEnvironmentSource(row);
      if (environmentSource === 'missing' && skillTestDesignRowDependsOnRealEnvironment(row)) {
        issues.push(
          buildValidationIssue(
            'matrix_environment_source_missing',
            'error',
            buildSkillTestMatrixRowPath(matrix, rowId, 'environmentSource'),
            '该行需要真实环境或 execution 支持，但 environmentSource 仍为 missing，不能正式确认或导出'
          )
        );
      }

      if (!isSkillTestDesignChainRow(row)) {
        continue;
      }

      const chainId = String(row && row.chainId || '').trim();
      const sequenceIndex = normalizePositiveInteger(row && row.sequenceIndex);
      if (!chainId) {
        issues.push(
          buildValidationIssue(
            'matrix_chain_id_required',
            'error',
            buildSkillTestMatrixRowPath(matrix, rowId, 'chainId'),
            '链式 row 必须声明 chainId'
          )
        );
      } else {
        const group = chainGroups.get(chainId) || [];
        group.push(row);
        chainGroups.set(chainId, group);
      }

      if (sequenceIndex == null) {
        issues.push(
          buildValidationIssue(
            'matrix_chain_sequence_required',
            'error',
            buildSkillTestMatrixRowPath(matrix, rowId, 'sequenceIndex'),
            '链式 row 必须声明正整数 sequenceIndex'
          )
        );
      }

      const dependsOnRowIds = Array.isArray(row && row.dependsOnRowIds)
        ? row.dependsOnRowIds.map((entry: any) => String(entry || '').trim()).filter(Boolean)
        : [];

      for (const dependencyRowId of dependsOnRowIds) {
        if (dependencyRowId === rowId) {
          issues.push(
            buildValidationIssue(
              'matrix_chain_cycle',
              'error',
              buildSkillTestMatrixRowPath(matrix, rowId, 'dependsOnRowIds'),
              `链式 row ${rowId} 不能依赖自己`
            )
          );
          continue;
        }

        const dependencyRow = includedRowMap.get(dependencyRowId);
        if (!dependencyRow) {
          issues.push(
            buildValidationIssue(
              'matrix_chain_dependency_missing',
              'error',
              buildSkillTestMatrixRowPath(matrix, rowId, 'dependsOnRowIds'),
              `链式 row ${rowId} 依赖的 ${dependencyRowId} 不存在，或未纳入当前导出范围`
            )
          );
          continue;
        }

        const dependencyChainId = String(dependencyRow && dependencyRow.chainId || '').trim();
        if (chainId && dependencyChainId && dependencyChainId !== chainId) {
          issues.push(
            buildValidationIssue(
              'matrix_chain_dependency_cross_chain',
              'error',
              buildSkillTestMatrixRowPath(matrix, rowId, 'dependsOnRowIds'),
              `链式 row ${rowId} 不能跨链依赖 ${dependencyRowId}`
            )
          );
        }

        if (exportableRowIds.has(rowId) && !exportableRowIds.has(dependencyRowId)) {
          issues.push(
            buildValidationIssue(
              'matrix_chain_dependency_not_exportable',
              'error',
              buildSkillTestMatrixRowPath(matrix, rowId, 'dependsOnRowIds'),
              `链式 row ${rowId} 依赖的 ${dependencyRowId} 不在当前可导出集合中`
            )
          );
        }
      }
    }

    for (const [chainId, chainRows] of chainGroups.entries()) {
      const sequenceOwners = new Map<number, string>();
      const sequenceValues = [] as number[];

      for (const row of chainRows) {
        const rowId = String(row && row.rowId || '').trim();
        const sequenceIndex = normalizePositiveInteger(row && row.sequenceIndex);
        if (sequenceIndex == null) {
          continue;
        }

        if (sequenceOwners.has(sequenceIndex)) {
          issues.push(
            buildValidationIssue(
              'matrix_chain_sequence_duplicate',
              'error',
              buildSkillTestMatrixRowPath(matrix, rowId, 'sequenceIndex'),
              `链 ${chainId} 中 sequenceIndex=${sequenceIndex} 重复`
            )
          );
          continue;
        }

        sequenceOwners.set(sequenceIndex, rowId);
        sequenceValues.push(sequenceIndex);
      }

      sequenceValues.sort((left, right) => left - right);
      if (sequenceValues.length > 0) {
        let expectedSequence = 1;
        for (const value of sequenceValues) {
          if (value !== expectedSequence) {
            issues.push(
              buildValidationIssue(
                'matrix_chain_sequence_gap',
                'error',
                buildSkillTestMatrixRowPath(matrix, sequenceOwners.get(value) || '', 'sequenceIndex'),
                `链 ${chainId} 的 sequenceIndex 必须连续，当前缺少 ${expectedSequence}`
              )
            );
            break;
          }
          expectedSequence += 1;
        }
      }

      const chainRowMap = new Map<string, any>();
      const adjacency = new Map<string, string[]>();
      for (const row of chainRows) {
        const rowId = String(row && row.rowId || '').trim();
        chainRowMap.set(rowId, row);
        adjacency.set(
          rowId,
          (Array.isArray(row && row.dependsOnRowIds) ? row.dependsOnRowIds : [])
            .map((entry: any) => String(entry || '').trim())
            .filter((dependencyRowId: string) => chainRowMap.has(dependencyRowId) || includedRowMap.has(dependencyRowId))
        );
      }

      for (const row of chainRows) {
        const rowId = String(row && row.rowId || '').trim();
        const rowSequenceIndex = normalizePositiveInteger(row && row.sequenceIndex);
        const dependsOnRowIds = Array.isArray(row && row.dependsOnRowIds)
          ? row.dependsOnRowIds.map((entry: any) => String(entry || '').trim()).filter(Boolean)
          : [];
        for (const dependencyRowId of dependsOnRowIds) {
          const dependencyRow = includedRowMap.get(dependencyRowId);
          const dependencySequenceIndex = normalizePositiveInteger(dependencyRow && dependencyRow.sequenceIndex);
          if (rowSequenceIndex != null && dependencySequenceIndex != null && dependencySequenceIndex >= rowSequenceIndex) {
            issues.push(
              buildValidationIssue(
                'matrix_chain_sequence_conflict',
                'error',
                buildSkillTestMatrixRowPath(matrix, rowId, 'dependsOnRowIds'),
                `链 ${chainId} 中 ${rowId} 依赖的 ${dependencyRowId} 顺序不合法`
              )
            );
          }
        }
      }

      const visited = new Set<string>();
      const visiting = new Set<string>();
      let cycleDetected = false;

      function visit(rowId: string) {
        if (cycleDetected || visited.has(rowId)) {
          return;
        }
        if (visiting.has(rowId)) {
          cycleDetected = true;
          return;
        }

        visiting.add(rowId);
        for (const dependencyRowId of adjacency.get(rowId) || []) {
          if (!chainRowMap.has(dependencyRowId)) {
            continue;
          }
          visit(dependencyRowId);
          if (cycleDetected) {
            return;
          }
        }
        visiting.delete(rowId);
        visited.add(rowId);
      }

      for (const row of chainRows) {
        visit(String(row && row.rowId || '').trim());
        if (cycleDetected) {
          issues.push(
            buildValidationIssue(
              'matrix_chain_cycle',
              'error',
              buildSkillTestMatrixRowPath(matrix, String(chainRows[0] && chainRows[0].rowId || '').trim(), 'dependsOnRowIds'),
              `链 ${chainId} 存在循环依赖`
            )
          );
          break;
        }
      }
    }

    return issues;
  }

  function buildSkillTestDesignSourceMetadataUpdate(testCase: any, row: any, rowIdToCaseId: Map<string, string>) {
    const sourceMetadata = isPlainObject(testCase && testCase.sourceMetadata) ? { ...testCase.sourceMetadata } : {};
    const currentDesignMetadata = isPlainObject(sourceMetadata.skillTestDesign) ? { ...sourceMetadata.skillTestDesign } : {};
    const rowId = String(row && row.rowId || '').trim();
    const exportedCaseId = String(rowIdToCaseId.get(rowId) || testCase && testCase.id || '').trim();
    const environmentContractRef = String(currentDesignMetadata.environmentContractRef || row && row.environmentContractRef || '').trim();
    const environmentSource = normalizeSkillTestDesignEnvironmentSource({
      ...row,
      environmentContractRef,
      environmentSource: currentDesignMetadata.environmentSource || row && row.environmentSource,
    });
    const scenarioKind = String(currentDesignMetadata.scenarioKind || row && row.scenarioKind || '').trim() || (hasSkillTestDesignChainMetadata(row) ? 'chain_step' : 'single');

    currentDesignMetadata.environmentContractRef = environmentContractRef;
    currentDesignMetadata.environmentSource = environmentSource;
    currentDesignMetadata.scenarioKind = scenarioKind;

    if (hasSkillTestDesignChainMetadata(row) || isPlainObject(currentDesignMetadata.chainPlanning)) {
      const currentChainPlanning = isPlainObject(currentDesignMetadata.chainPlanning) ? { ...currentDesignMetadata.chainPlanning } : {};
      const dependsOnRowIds = Array.isArray(currentChainPlanning.dependsOnRowIds)
        ? currentChainPlanning.dependsOnRowIds.map((entry: any) => String(entry || '').trim()).filter(Boolean)
        : (Array.isArray(row && row.dependsOnRowIds) ? row.dependsOnRowIds.map((entry: any) => String(entry || '').trim()).filter(Boolean) : []);
      const dependsOnCaseIds = dependsOnRowIds.map((dependencyRowId: string) => {
        const dependencyCaseId = String(rowIdToCaseId.get(dependencyRowId) || '').trim();
        if (!dependencyCaseId) {
          throw createValidationHttpError(
            buildValidationIssue(
              'matrix_chain_dependency_missing',
              'error',
              'sourceMetadata.skillTestDesign.chainPlanning.dependsOnRowIds',
              `导出草稿时无法解析链式依赖 ${dependencyRowId}`
            )
          );
        }
        return dependencyCaseId;
      });

      currentDesignMetadata.chainPlanning = {
        ...currentChainPlanning,
        matrixId: String(currentChainPlanning.matrixId || sourceMetadata.matrixId || testCase && testCase.sourceMetadata && testCase.sourceMetadata.matrixId || '').trim(),
        rowId: String(currentChainPlanning.rowId || rowId).trim(),
        scenarioKind,
        chainId: String(currentChainPlanning.chainId || row && row.chainId || '').trim(),
        chainName: String(currentChainPlanning.chainName || row && row.chainName || '').trim(),
        sequenceIndex: normalizePositiveInteger(currentChainPlanning.sequenceIndex || row && row.sequenceIndex),
        dependsOnRowIds,
        inheritance: Array.isArray(currentChainPlanning.inheritance)
          ? currentChainPlanning.inheritance.map((entry: any) => String(entry || '').trim()).filter(Boolean)
          : (Array.isArray(row && row.inheritance) ? row.inheritance.map((entry: any) => String(entry || '').trim()).filter(Boolean) : []),
        environmentContractRef,
        environmentSource,
        exportChainId: String(currentChainPlanning.chainId || row && row.chainId || '').trim(),
        dependsOnCaseIds,
        exportedCaseId,
      };
    }

    sourceMetadata.skillTestDesign = currentDesignMetadata;
    return sourceMetadata;
  }

  function findSkillTestDraftDuplicates(skillId: string, draftInput: SkillTestDraftInputLike, options: SkillTestDraftLookupOptions = {}) {
    ensureSchema();
    const excludedCaseIds = buildExcludedCaseIdsSet(options.excludeCaseIds);
    const testType = String(draftInput && draftInput.testType || 'trigger').trim().toLowerCase() || 'trigger';

    if (testType === 'environment-build') {
      const draftEnvProfile = normalizeSkillTestEnvironmentBuildProfile(draftInput);
      const draftContractRef = normalizeSkillTestEnvironmentBuildContractRef(draftInput);
      const rows = store.db.prepare(`
        SELECT id, loading_mode, test_type, trigger_prompt, case_status, environment_config_json, source_metadata_json
        FROM skill_test_cases
        WHERE skill_id = ?
          AND test_type = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 100
      `).all(skillId, 'environment-build');

      return rows
        .map((row: SkillTestStoredDraftRow) => buildSkillTestDraftMatch(row))
        .filter((row) => row.id && !excludedCaseIds.has(row.id))
        .filter((row) => {
          if (row.envProfile && row.envProfile === draftEnvProfile) {
            return true;
          }
          return Boolean(draftContractRef && row.environmentContractRef && row.environmentContractRef === draftContractRef);
        });
    }

    const normalizedPrompt = normalizeSkillTestPromptKey(draftInput && draftInput.triggerPrompt);
    if (!normalizedPrompt) {
      return [];
    }

    const rows = store.db.prepare(`
      SELECT id, loading_mode, test_type, trigger_prompt, case_status
      FROM skill_test_cases
      WHERE skill_id = ?
        AND loading_mode = ?
        AND test_type = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 100
    `).all(skillId, draftInput.loadingMode || 'dynamic', draftInput.testType || 'trigger');

    return rows
      .map((row: SkillTestStoredDraftRow) => buildSkillTestDraftMatch(row))
      .filter((row) => row.id && !excludedCaseIds.has(row.id))
      .filter((row) => normalizeSkillTestPromptKey(row.triggerPrompt) === normalizedPrompt);
  }

  function findReusableSkillTestConversationDraft(
    skillId: string,
    conversationId: string,
    row: SkillTestDesignMatrixRowLike,
    draftInput: SkillTestDraftInputLike,
    options: SkillTestDraftLookupOptions = {}
  ) {
    ensureSchema();
    const normalizedConversationId = String(conversationId || '').trim();
    if (!normalizedConversationId) {
      return null;
    }

    const excludedCaseIds = buildExcludedCaseIdsSet(options.excludeCaseIds);
    const matrixRowId = String(row && row.rowId || '').trim();
    const testType = String(draftInput && draftInput.testType || 'trigger').trim().toLowerCase() || 'trigger';
    const loadingMode = String(draftInput && draftInput.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
    const normalizedPrompt = normalizeSkillTestPromptKey(draftInput && draftInput.triggerPrompt);
    const draftEnvProfile = testType === 'environment-build'
      ? normalizeSkillTestEnvironmentBuildProfile(draftInput)
      : '';
    const draftContractRef = testType === 'environment-build'
      ? normalizeSkillTestEnvironmentBuildContractRef(draftInput)
      : '';

    const rows = store.db.prepare(`
      SELECT id, loading_mode, test_type, trigger_prompt, case_status, environment_config_json, source_metadata_json
      FROM skill_test_cases
      WHERE skill_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 200
    `).all(skillId);

    const candidates = rows
      .map((storedRow: SkillTestStoredDraftRow) => buildSkillTestConversationDraftCandidate(storedRow))
      .filter((candidate) => candidate.id && !excludedCaseIds.has(candidate.id))
      .filter((candidate) => candidate.caseStatus === 'draft')
      .filter((candidate) => candidate.source === 'skill_test_chat_workbench')
      .filter((candidate) => candidate.conversationId === normalizedConversationId);

    if (matrixRowId) {
      const rowMatch = candidates.find((candidate) => candidate.matrixRowId === matrixRowId);
      if (rowMatch) {
        return rowMatch;
      }
    }

    if (testType === 'environment-build') {
      return candidates.find((candidate) => {
        if (candidate.testType !== 'environment-build' || candidate.loadingMode !== loadingMode) {
          return false;
        }
        if (candidate.envProfile && candidate.envProfile === draftEnvProfile) {
          return true;
        }
        return Boolean(draftContractRef && candidate.environmentContractRef && candidate.environmentContractRef === draftContractRef);
      }) || null;
    }

    if (!normalizedPrompt) {
      return null;
    }

    return candidates.find((candidate) => (
      candidate.loadingMode === loadingMode
      && candidate.testType === testType
      && normalizeSkillTestPromptKey(candidate.triggerPrompt) === normalizedPrompt
    )) || null;
  }

  function buildSkillTestDesignExportDrafts(conversation: any, designState: any, options: any = {}) {
    if (!createTestCase) {
      throw new Error('createTestCase is required');
    }

    const matrix = designState.matrix && typeof designState.matrix === 'object' ? designState.matrix : null;
    const confirmation = designState.confirmation && typeof designState.confirmation === 'object' ? designState.confirmation : null;

    if (!matrix || !matrix.matrixId) {
      throw createValidationHttpError(
        buildValidationIssue('matrix_missing', 'error', 'matrix', '当前没有可导出的测试矩阵')
      );
    }

    if (!confirmation || String(confirmation.matrixId || '').trim() !== String(matrix.matrixId || '').trim()) {
      throw createValidationHttpError(
        buildValidationIssue('matrix_not_confirmed', 'error', 'confirmation', '测试矩阵尚未确认，不能导出草稿')
      );
    }

    const validationIssues = buildSkillTestDesignMatrixValidationIssues(matrix);
    if (validationIssues.length > 0) {
      throw createValidationHttpError(validationIssues, '测试矩阵存在未解决的链路或环境问题');
    }

    const includeRows = Array.isArray(matrix.rows)
      ? matrix.rows.filter((row: any) => isSkillTestDesignRowIncludedInExport(row))
      : [];

    if (includeRows.length === 0) {
      throw createValidationHttpError(
        buildValidationIssue('matrix_rows_empty', 'error', 'matrix.rows', '当前矩阵没有可导出的行')
      );
    }

    const draftPlans = [] as any[];
    const duplicateWarnings = [] as any[];
    const skippedRows = [] as any[];
    const reservedReusableCaseIds = new Set<string>();

    for (const row of includeRows) {
      if (!isSkillTestDesignDraftExportCandidate(row)) {
        skippedRows.push({
          rowId: String(row && row.rowId || '').trim(),
          reason: '该行的 loadingMode/testType 组合当前不支持导出',
          nextAction: '请把该行调整为现有 schema 支持的组合后重试导出',
        });
        continue;
      }

      const draftInput = buildSkillTestDraftInputFromMatrixRow(designState.skillId, matrix, row, {
        conversationId: conversation.id,
        messageId: String(confirmation.messageId || matrix.sourceMessageId || '').trim(),
        agentRole: String(confirmation.agentRole || 'scribe').trim() || 'scribe',
        exportedBy: String(options.exportedBy || 'user').trim() || 'user',
      });
      const reusableDraft = findReusableSkillTestConversationDraft(designState.skillId, conversation.id, row, draftInput, {
        excludeCaseIds: [...reservedReusableCaseIds],
      });
      if (reusableDraft && reusableDraft.id) {
        reservedReusableCaseIds.add(reusableDraft.id);
      }
      const duplicates = findSkillTestDraftDuplicates(designState.skillId, draftInput, {
        excludeCaseIds: reusableDraft && reusableDraft.id ? [reusableDraft.id] : [],
      });
      if (duplicates.length > 0) {
        duplicateWarnings.push({
          rowId: String(row && row.rowId || '').trim(),
          duplicates,
        });
      }
      draftPlans.push({
        row,
        draftInput,
        reusableCaseId: reusableDraft && reusableDraft.id ? reusableDraft.id : '',
      });
    }

    const updateSourceMetadataStatement = store.db.prepare(`
      UPDATE skill_test_cases
      SET source_metadata_json = @sourceMetadataJson,
          updated_at = @updatedAt
      WHERE id = @id
    `);
    const createDraftsTransaction = store.db.transaction((plans: any[]) => {
      const createdEntries = plans.map((plan: any) => {
        const testCaseResult = plan.reusableCaseId && updateTestCase
          ? updateTestCase(plan.reusableCaseId, plan.draftInput)
          : createTestCase(plan.draftInput);
        return {
          row: plan.row,
          testCase: testCaseResult.testCase,
        };
      });
      const rowIdToCaseId = new Map<string, string>(
        createdEntries
          .map((entry: any) => [String(entry && entry.row && entry.row.rowId || '').trim(), String(entry && entry.testCase && entry.testCase.id || '').trim()] as [string, string])
          .filter(([rowId, caseId]) => rowId && caseId)
      );

      return createdEntries.map((entry: any) => {
        const patchedSourceMetadata = buildSkillTestDesignSourceMetadataUpdate(entry.testCase, entry.row, rowIdToCaseId);
        const updatedAt = nowIsoImpl();
        updateSourceMetadataStatement.run({
          id: entry.testCase.id,
          sourceMetadataJson: JSON.stringify(patchedSourceMetadata || {}),
          updatedAt,
        });
        return getTestCase(entry.testCase.id);
      });
    });
    const createdCases = draftPlans.length > 0 ? createDraftsTransaction(draftPlans) : [];

    if (createdCases.length === 0) {
      throw createValidationHttpError(
        skippedRows.map((entry: any) => buildValidationIssue(
          'export_row_skipped',
          'error',
          buildSkillTestMatrixRowPath(matrix, String(entry && entry.rowId || '').trim()),
          String(entry && entry.reason || 'No exportable rows remain')
        )),
        '没有可导出的测试草稿'
      );
    }

    return {
      cases: createdCases,
      duplicateWarnings,
      skippedRows,
    };
  }

  return {
    requireSkillTestDesignConversation,
    summarizeSkillTestDesignConversation,
    updateSkillTestDesignConversationState,
    ensureAutomaticTestingDocPreview,
    buildSkillTestDesignConfirmationRecord,
    buildSkillTestDesignMatrixValidationIssues,
    buildSkillTestDesignExportDrafts,
  };
}
