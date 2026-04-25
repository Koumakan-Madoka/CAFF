const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

// Test migration and basic CRUD operations for skill_test schema
const { migrateSkillTestSchema } = require('../../build/storage/sqlite/migrations');
const {
  validateAndNormalizeCaseInput,
  normalizeCaseForRun,
  validateJudgeOutput,
} = require('../../build/server/api/skill-test-controller');
const {
  buildSkillTestIsolationIssues,
  getSkillTestIsolationFailureMessage,
  normalizeSkillTestIsolationOptions,
} = require('../../build/server/domain/skill-test/isolation');
const {
  buildSkillTestDraftInputFromMatrixRow,
  normalizeSkillTestMatrix,
} = require('../../build/server/domain/skill-test/chat-workbench-mode');
const {
  buildTestingDocDraftFromSkillContext,
  normalizeTestingDocDraft,
} = require('../../build/server/domain/skill-test/testing-doc-draft');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  migrateSkillTestSchema(db);
  return db;
}

// ---- Schema migration ----

test('migrateSkillTestSchema creates tables without error', () => {
  const db = createTestDb();

  // Verify tables exist
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'skill_test%'")
    .all()
    .map((r) => r.name);

  assert.ok(tables.includes('skill_test_cases'), 'skill_test_cases table should exist');
  assert.ok(tables.includes('skill_test_runs'), 'skill_test_runs table should exist');
  assert.ok(tables.includes('skill_test_environment_assets'), 'skill_test_environment_assets table should exist');
  assert.ok(tables.includes('skill_test_chain_runs'), 'skill_test_chain_runs table should exist');
  assert.ok(tables.includes('skill_test_chain_run_steps'), 'skill_test_chain_run_steps table should exist');

  const caseColumns = db.prepare('PRAGMA table_info(skill_test_cases)').all().map((row) => row.name);
  assert.ok(caseColumns.includes('expected_steps_json'));
  assert.ok(caseColumns.includes('environment_config_json'));
  assert.ok(caseColumns.includes('generation_provider'));
  assert.ok(caseColumns.includes('generation_model'));
  assert.ok(caseColumns.includes('generation_created_at'));
  assert.ok(caseColumns.includes('source_metadata_json'));

  const runColumns = db.prepare('PRAGMA table_info(skill_test_runs)').all().map((row) => row.name);
  assert.ok(runColumns.includes('environment_status'));
  assert.ok(runColumns.includes('environment_phase'));

  const environmentAssetColumns = db.prepare('PRAGMA table_info(skill_test_environment_assets)').all().map((row) => row.name);
  assert.ok(environmentAssetColumns.includes('skill_id'));
  assert.ok(environmentAssetColumns.includes('env_profile'));
  assert.ok(environmentAssetColumns.includes('image'));
  assert.ok(environmentAssetColumns.includes('manifest_hash'));
  assert.ok(environmentAssetColumns.includes('source_metadata_json'));

  const chainRunColumns = db.prepare('PRAGMA table_info(skill_test_chain_runs)').all().map((row) => row.name);
  assert.ok(chainRunColumns.includes('export_chain_id'));
  assert.ok(chainRunColumns.includes('bootstrap_status'));
  assert.ok(chainRunColumns.includes('teardown_status'));
  assert.ok(chainRunColumns.includes('warning_flags_json'));
  assert.ok(chainRunColumns.includes('teardown_evidence_json'));

  const chainStepColumns = db.prepare('PRAGMA table_info(skill_test_chain_run_steps)').all().map((row) => row.name);
  assert.ok(chainStepColumns.includes('depends_on_step_ids_json'));
  assert.ok(chainStepColumns.includes('skill_test_run_id'));
  assert.ok(chainStepColumns.includes('carry_forward_json'));
  assert.ok(chainStepColumns.includes('artifact_refs_json'));

  db.close();
});

test('migrateSkillTestSchema is idempotent', () => {
  const db = createTestDb();
  // Run migration again — should not throw
  assert.doesNotThrow(() => migrateSkillTestSchema(db));
  db.close();
});

test('source_metadata_json preserves skill test design audit metadata', () => {
  const db = createTestDb();
  const now = new Date().toISOString();
  const sourceMetadata = {
    source: 'skill_test_chat_workbench',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    matrixId: 'matrix-1',
    matrixRowId: 'row-1',
    agentRole: 'scribe',
    exportedBy: 'user',
    exportedAt: now,
    skillTestDesign: {
      environmentContractRef: 'TESTING.md#Bootstrap',
      environmentSource: 'skill_contract',
      chainPlanning: {
        chainId: 'chain-1',
        dependsOnRowIds: ['row-0'],
        dependsOnCaseIds: ['tc-000'],
        exportedCaseId: 'tc-006',
      },
    },
  };

  db.prepare(`
    INSERT INTO skill_test_cases (
      id, skill_id, test_type, loading_mode, trigger_prompt,
      source_metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'tc-006', 'demo-skill', 'trigger', 'dynamic', 'load the demo skill',
    JSON.stringify(sourceMetadata), now, now
  );

  const row = db.prepare('SELECT source_metadata_json FROM skill_test_cases WHERE id = ?').get('tc-006');
  const parsed = JSON.parse(row.source_metadata_json);
  assert.equal(parsed.source, 'skill_test_chat_workbench');
  assert.equal(parsed.conversationId, 'conv-1');
  assert.equal(parsed.messageId, 'msg-1');
  assert.equal(parsed.matrixId, 'matrix-1');
  assert.equal(parsed.matrixRowId, 'row-1');
  assert.equal(parsed.skillTestDesign.environmentContractRef, 'TESTING.md#Bootstrap');
  assert.equal(parsed.skillTestDesign.environmentSource, 'skill_contract');
  assert.deepEqual(parsed.skillTestDesign.chainPlanning.dependsOnCaseIds, ['tc-000']);
  assert.equal(parsed.skillTestDesign.chainPlanning.exportedCaseId, 'tc-006');

  db.close();
});

test('skill test design draft builder keeps environment and chain metadata out of note', () => {
  const draft = buildSkillTestDraftInputFromMatrixRow(
    'demo-skill',
    { matrixId: 'matrix-structured-note' },
    {
      rowId: 'row-verify',
      scenario: 'verify the skill after bootstrap',
      priority: 'P1',
      coverageReason: 'covers the follow-up verification step',
      testType: 'trigger',
      loadingMode: 'dynamic',
      environmentSource: 'skill_contract',
      environmentContractRef: 'TESTING.md#Verification',
      scenarioKind: 'chain_step',
      chainId: 'chain-1',
      chainName: 'Demo Chain',
      sequenceIndex: 2,
      dependsOnRowIds: ['row-bootstrap'],
      inheritance: ['filesystem'],
      riskPoints: ['metadata drift'],
      keyAssertions: ['metadata is structured'],
      includeInMvp: true,
      draftingHints: {
        triggerPrompt: 'verify the demo skill after bootstrap',
        note: 'human readable note',
      },
    },
    {
      conversationId: 'conv-structured-note',
      messageId: 'msg-structured-note',
      agentRole: 'scribe',
      exportedBy: 'user',
    }
  );

  assert.match(draft.note, /场景：verify the skill after bootstrap/);
  assert.match(draft.note, /human readable note/);
  assert.doesNotMatch(draft.note, /environmentSource=/);
  assert.doesNotMatch(draft.note, /environmentContractRef=/);
  assert.doesNotMatch(draft.note, /chain=/);
  assert.equal(draft.sourceMetadata.source, 'skill_test_chat_workbench');
  assert.equal(draft.sourceMetadata.conversationId, 'conv-structured-note');
  assert.equal(draft.sourceMetadata.messageId, 'msg-structured-note');
  assert.equal(draft.sourceMetadata.matrixId, 'matrix-structured-note');
  assert.equal(draft.sourceMetadata.matrixRowId, 'row-verify');
  assert.equal(draft.sourceMetadata.skillTestDesign.environmentContractRef, 'TESTING.md#Verification');
  assert.equal(draft.sourceMetadata.skillTestDesign.environmentSource, 'skill_contract');
  assert.equal(draft.sourceMetadata.skillTestDesign.chainPlanning.chainId, 'chain-1');
  assert.deepEqual(draft.sourceMetadata.skillTestDesign.chainPlanning.dependsOnRowIds, ['row-bootstrap']);
  assert.deepEqual(draft.sourceMetadata.skillTestDesign.chainPlanning.inheritance, ['filesystem']);
});

test('normalizeSkillTestMatrix defaults chat workbench rows to full execution and accepts includeInExport alias', () => {
  const matrix = normalizeSkillTestMatrix({
    kind: 'skill_test_matrix',
    matrixId: 'matrix-default-full-execution',
    skillId: 'demo-skill',
    phase: 'planning_matrix',
    rows: [
      {
        rowId: 'row-1',
        scenario: 'apply tracked changes to the target document',
        priority: 'P0',
        coverageReason: 'default chat-workbench planning should target a complete execution case',
        riskPoints: ['tracked-change fidelity'],
        keyAssertions: ['writes the requested edits'],
        includeInExport: true,
      },
    ],
  }, { skillId: 'demo-skill' });

  assert.equal(matrix.rows[0].testType, 'execution');
  assert.equal(matrix.rows[0].loadingMode, 'full');
  assert.equal(matrix.rows[0].includeInMvp, true);
});

test('TESTING.md draft builder creates structured sections and source kinds from skill context', () => {
  const draft = buildTestingDocDraftFromSkillContext(
    {
      id: 'demo-skill',
      body: [
        '# Demo Skill',
        '',
        '## Setup',
        '- npm install demo-cli',
        '- demo-cli bootstrap',
        '',
        '## Verification',
        '- demo-cli --version',
        '',
      ].join('\n'),
    },
    {
      skillId: 'demo-skill',
      conversationId: 'conv-testing-doc',
      messageId: 'msg-testing-doc',
      agentRole: 'scribe',
      createdBy: 'user',
      fileExistsAtPreview: false,
    }
  );

  assert.equal(draft.skillId, 'demo-skill');
  assert.equal(draft.targetPath, 'TESTING.md');
  assert.equal(draft.status, 'proposed');
  assert.equal(draft.sections.length, 5);
  assert.equal(draft.sections.find((section) => section.heading === 'Setup').sourceKind, 'skill_md');
  assert.equal(draft.sections.find((section) => section.heading === 'Verification').sourceKind, 'skill_md');
  assert.equal(draft.sections.find((section) => section.heading === 'Prerequisites').sourceKind, 'missing');
  assert.equal(draft.readiness.executionBlocked, true);
  assert.match(draft.content, /# Testing Environment/);
  assert.match(draft.content, /## Machine Contract/);
  assert.match(draft.content, /```skill-test-environment/);
  assert.match(draft.content, /npm install demo-cli/);
  assert.doesNotMatch(draft.content, /"installable"/);
  assert.match(draft.content, /## Setup/);
  assert.match(draft.content, /## Open Questions/);
});

test('TESTING.md draft builder rejects unsupported section headings as validation errors', () => {
  assert.throws(
    () => normalizeTestingDocDraft({
      skillId: 'demo-skill',
      sections: [
        {
          heading: 'Random Notes',
          content: '- should not become a stable TESTING.md section',
          sourceKind: 'user_supplied',
        },
      ],
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'testing_doc_section_heading_invalid'));
      return true;
    }
  );
});

// ---- skill_test_cases CRUD ----

test('can insert and read a skill_test_case', () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO skill_test_cases (
      id, skill_id, test_type, loading_mode, trigger_prompt,
      expected_tools_json, expected_behavior, validity_status, note,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'tc-001', 'werewolf', 'trigger', 'dynamic', '我们来狼人杀吧',
    '["read"]', 'Agent should trigger werewolf skill', 'pending', 'Auto-generated',
    now, now
  );

  const row = db.prepare('SELECT * FROM skill_test_cases WHERE id = ?').get('tc-001');
  assert.ok(row);
  assert.equal(row.skill_id, 'werewolf');
  assert.equal(row.test_type, 'trigger');
  assert.equal(row.loading_mode, 'dynamic');
  assert.equal(row.trigger_prompt, '我们来狼人杀吧');
  assert.equal(row.validity_status, 'pending');

  db.close();
});

test('can insert and read a skill_test_run', () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  // Create a test case first
  db.prepare(`
    INSERT INTO skill_test_cases (id, skill_id, test_type, loading_mode, trigger_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('tc-002', 'werewolf', 'trigger', 'dynamic', 'test prompt', now, now);

  // Create a test run
  db.prepare(`
    INSERT INTO skill_test_runs (
      id, test_case_id, status, actual_tools_json, tool_accuracy,
      trigger_passed, execution_passed, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'tr-001', 'tc-002', 'succeeded', '["read","send-public"]', 0.8,
    1, 1, '', now
  );

  const row = db.prepare('SELECT * FROM skill_test_runs WHERE id = ?').get('tr-001');
  assert.ok(row);
  assert.equal(row.test_case_id, 'tc-002');
  assert.equal(row.status, 'succeeded');
  assert.equal(row.trigger_passed, 1);
  assert.equal(row.execution_passed, 1);
  assert.ok(Math.abs(row.tool_accuracy - 0.8) < 0.001);

  db.close();
});

test('execution_passed supports NULL (three-state)', () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO skill_test_cases (id, skill_id, test_type, loading_mode, trigger_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('tc-003', 'werewolf', 'trigger', 'dynamic', 'test', now, now);

  // Run with trigger_failed — execution_passed should be NULL
  db.prepare(`
    INSERT INTO skill_test_runs (
      id, test_case_id, status, actual_tools_json, trigger_passed, execution_passed, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tr-002', 'tc-003', 'succeeded', '[]', 0, null, '', now);

  const row = db.prepare('SELECT * FROM skill_test_runs WHERE id = ?').get('tr-002');
  assert.equal(row.trigger_passed, 0);
  assert.equal(row.execution_passed, null);

  db.close();
});

test('validity_status transitions work correctly', () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO skill_test_cases (id, skill_id, test_type, loading_mode, trigger_prompt, validity_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tc-004', 'werewolf', 'trigger', 'dynamic', 'test', 'pending', now, now);

  // Transition: pending → validated
  db.prepare("UPDATE skill_test_cases SET validity_status = 'validated', updated_at = ? WHERE id = ?")
    .run(now, 'tc-004');

  let row = db.prepare('SELECT validity_status FROM skill_test_cases WHERE id = ?').get('tc-004');
  assert.equal(row.validity_status, 'validated');

  // Transition: pending → invalid
  db.prepare(`
    INSERT INTO skill_test_cases (id, skill_id, test_type, loading_mode, trigger_prompt, validity_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tc-005', 'werewolf', 'trigger', 'dynamic', 'test', 'pending', now, now);

  db.prepare("UPDATE skill_test_cases SET validity_status = 'invalid', updated_at = ? WHERE id = ?")
    .run(now, 'tc-005');

  row = db.prepare('SELECT validity_status FROM skill_test_cases WHERE id = ?').get('tc-005');
  assert.equal(row.validity_status, 'invalid');

  db.close();
});

// ---- Index verification ----

test('indexes are created correctly', () => {
  const db = createTestDb();

  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_skill_test%'")
    .all()
    .map((r) => r.name);

  assert.ok(indexes.includes('idx_skill_test_cases_skill_id'));
  assert.ok(indexes.includes('idx_skill_test_cases_validity'));
  assert.ok(indexes.includes('idx_skill_test_environment_assets_skill_profile'));
  assert.ok(indexes.includes('idx_skill_test_runs_case_id'));

  db.close();
});

test('normalizeSkillTestIsolationOptions defaults to legacy-local without a driver', () => {
  const normalized = normalizeSkillTestIsolationOptions({}, {
    driverAvailable: false,
    defaultMode: 'legacy-local',
  });

  assert.equal(normalized.mode, 'legacy-local');
  assert.equal(normalized.notIsolated, true);
  assert.equal(normalized.trellisMode, 'none');
  assert.equal(normalized.egressMode, 'deny');
});

test('normalizeSkillTestIsolationOptions fails closed when isolated mode lacks a driver', () => {
  assert.throws(
    () => normalizeSkillTestIsolationOptions({ mode: 'isolated' }, { driverAvailable: false }),
    (error) => {
      assert.equal(error.statusCode, 503);
      return true;
    }
  );
});

test('buildSkillTestIsolationIssues escalates publish-gate sandbox mismatches to errors', () => {
  const issues = buildSkillTestIsolationIssues({
    mode: 'isolated',
    publishGate: true,
    toolPolicy: { rejects: [] },
    execution: { toolRuntime: 'host', pathSemantics: 'host' },
    egress: { mode: 'deny', enforced: false, reason: 'record only' },
    pollutionCheck: { checked: false, ok: true },
    cleanup: { ok: true },
  });

  assert.deepEqual(
    issues.map((issue) => issue.code),
    [
      'skill_test_tools_not_sandboxed',
      'skill_test_path_semantics_not_sandboxed',
      'skill_test_egress_not_enforced',
    ]
  );
  assert.ok(issues.every((issue) => issue.severity === 'error'));
});

test('getSkillTestIsolationFailureMessage prefers the combined sandbox mismatch message', () => {
  const message = getSkillTestIsolationFailureMessage({
    unsafeReasons: ['tool_runtime_not_sandboxed', 'path_semantics_not_sandboxed'],
  });

  assert.match(message, /sandbox-routed tools and sandbox path semantics/);
});

test('validateAndNormalizeCaseInput rejects full case without expectedGoal', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      skillId: 'werewolf',
      loadingMode: 'full',
      userPrompt: '进入房间后请只以玩家身份参与狼人杀。',
      expectedBehavior: '先确认规则，再以玩家身份发言。',
      expectedGoal: '',
      expectedSteps: [
        {
          id: 'step-1',
          title: '确认规则',
          expectedBehavior: '先确认规则约束后再继续发言。',
          required: true,
          failureIfMissing: '未先确认规则。',
          strongSignals: [],
        },
      ],
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(Array.isArray(error.issues));
      assert.equal(error.issues[0].code, 'expected_goal_required');
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput preserves canonical expectedSteps with warnings', () => {
  const normalized = validateAndNormalizeCaseInput({
    skillId: 'werewolf',
    loadingMode: 'full',
    userPrompt: '进入房间后请只以玩家身份参与狼人杀。',
    expectedTools: ['read'],
    expectedBehavior: '先确认规则，再以玩家身份发言。',
    expectedGoal: '完成玩家视角回应。',
    expectedSteps: [
      {
        title: '确认规则',
        expectedBehavior: '先确认规则约束后再继续发言。',
        strongSignals: [
          {
            type: 'tool',
            toolName: 'read',
          },
        ],
      },
    ],
    evaluationRubric: {
      criticalConstraints: [
        {
          id: 'confirm-before-action',
          description: '继续前先确认规则。',
          appliesToStepIds: ['step-1'],
        },
      ],
    },
  });

  assert.equal(normalized.expectedSteps.length, 1);
  assert.equal(normalized.expectedSteps[0].id, 'step-1');
  assert.equal(normalized.expectedSteps[0].required, true);
  assert.ok(normalized.expectedSteps[0].failureIfMissing);
  assert.equal(normalized.expectedSteps[0].strongSignals[0].id, 'sig-step-1-read');
  assert.ok(normalized.issues.some((issue) => issue.code === 'failure_if_missing_defaulted'));
  assert.ok(normalized.issues.some((issue) => issue.code === 'legacy_expected_tools_present'));
});

test('validateAndNormalizeCaseInput accepts environment-build case type', () => {
  const normalized = validateAndNormalizeCaseInput({
    skillId: 'docx',
    loadingMode: 'dynamic',
    testType: 'environment-build',
    userPrompt: '请构建 docx skill 的完整测试环境。',
    expectedBehavior: '只产出环境 manifest，不执行普通 skill 行为。',
    environmentConfig: {
      enabled: true,
      requirements: [{ kind: 'command', name: 'pandoc' }],
      bootstrap: { commands: ['apt-get update && apt-get install -y pandoc'] },
      verify: { commands: ['pandoc --version'] },
    },
  });

  assert.equal(normalized.testType, 'environment-build');
  assert.equal(normalized.loadingMode, 'dynamic');
  assert.equal(normalized.environmentConfig.bootstrap.commands[0], 'apt-get update && apt-get install -y pandoc');
});

test('validateAndNormalizeCaseInput accepts environmentConfig', () => {
  const normalized = validateAndNormalizeCaseInput({
    skillId: 'werewolf',
    loadingMode: 'dynamic',
    userPrompt: '请先检查并准备运行环境。',
    expectedBehavior: '先准备环境再执行 skill。',
    environmentConfig: {
      enabled: true,
      policy: 'optional',
      requirements: [
        {
          kind: 'command',
          name: 'python',
          versionHint: '>=3.10',
        },
      ],
      bootstrap: {
        commands: ['python --version'],
      },
      verify: {
        commands: ['python --version'],
      },
      cache: {
        enabled: true,
        paths: [
          { root: 'project', path: '.venv' },
        ],
        ttlHours: 24,
      },
      docs: {
        mode: 'suggest-patch',
        target: 'TESTING.md',
      },
      asset: {
        envProfile: 'full',
        image: 'caff-skill-env-werewolf:full-123456789abc',
        imageDigest: 'sha256:image123',
        baseImageDigest: 'sha256:base123',
        testingMdHash: 'sha256:testing123',
        manifestHash: 'sha256:manifest123',
        buildCaseId: 'build-case-1',
      },
    },
  });

  assert.ok(normalized.environmentConfig);
  assert.equal(normalized.environmentConfig.enabled, true);
  assert.equal(normalized.environmentConfig.requirements[0].name, 'python');
  assert.equal(normalized.environmentConfig.bootstrap.commands[0], 'python --version');
  assert.equal(normalized.environmentConfig.cache.enabled, true);
  assert.equal(normalized.environmentConfig.cache.paths[0].path, '.venv');
  assert.equal(normalized.environmentConfig.asset.envProfile, 'full');
  assert.equal(normalized.environmentConfig.asset.image, 'caff-skill-env-werewolf:full-123456789abc');
  assert.equal(normalized.environmentConfig.asset.manifestHash, 'sha256:manifest123');
});

test('normalizeCaseForRun keeps legacy full-mode fields as-is without step derivation', () => {
  const validation = normalizeCaseForRun({
    skillId: 'werewolf',
    loadingMode: 'full',
    testType: 'execution',
    userPrompt: '进入房间后请只以玩家身份参与狼人杀。',
    expectedTools: [
      {
        name: 'read',
        order: 1,
        requiredParams: ['path'],
      },
      {
        name: 'send-public',
        order: 2,
      },
    ],
    expectedBehavior: '只以玩家身份行动，不承担主持职责。',
    expectedGoal: '',
    expectedSequence: ['read', 'send-public'],
    evaluationRubric: {},
    note: 'legacy case',
  });

  assert.equal(validation.caseSchemaStatus, 'valid');
  assert.equal(validation.derivedFromLegacy, false);
  assert.ok(validation.normalizedCase);
  assert.equal(validation.normalizedCase.expectedGoal, '只以玩家身份行动，不承担主持职责。');
  assert.equal(validation.normalizedCase.expectedSteps.length, 0);
  assert.ok(!validation.issues.some((issue) => issue.code === 'legacy_steps_derived'));
});

test('normalizeCaseForRun flags critical sequence evidence gaps as needs-review', () => {
  const validation = normalizeCaseForRun({
    skillId: 'werewolf',
    loadingMode: 'full',
    testType: 'execution',
    userPrompt: '进入房间后请只以玩家身份参与狼人杀。',
    expectedGoal: '完成玩家视角回应。',
    expectedBehavior: '先确认规则，再继续玩家视角回复。',
    expectedSteps: [
      {
        id: 'step-1',
        title: '确认规则',
        expectedBehavior: '继续前先确认规则。',
        required: true,
        order: 1,
        failureIfMissing: '未先确认规则。',
        strongSignals: [],
      },
    ],
    expectedSequence: ['step-1'],
    evaluationRubric: {
      criticalDimensions: ['sequenceAdherence'],
    },
  });

  assert.equal(validation.caseSchemaStatus, 'warning');
  assert.ok(validation.normalizedCase);
  assert.ok(validation.issues.some((issue) => issue.code === 'critical_sequence_evidence_unavailable'));
  assert.ok(validation.issues.some((issue) => issue.severity === 'needs-review'));
});

test('validateJudgeOutput backfills missing step and constraint results', () => {
  const normalizedCase = validateAndNormalizeCaseInput({
    skillId: 'werewolf',
    loadingMode: 'full',
    userPrompt: '进入房间后请只以玩家身份参与狼人杀。',
    expectedGoal: '完成玩家视角回应。',
    expectedSteps: [
      {
        id: 'step-1',
        title: '确认规则',
        expectedBehavior: '先确认规则约束后再继续发言。',
        strongSignals: [{ id: 'sig-step-1-read', type: 'tool', toolName: 'read' }],
      },
      {
        id: 'step-2',
        title: '以玩家身份回应',
        expectedBehavior: '只给出玩家视角发言。',
      },
    ],
    evaluationRubric: {
      criticalConstraints: [
        {
          id: 'confirm-before-action',
          description: '继续前先确认规则。',
          appliesToStepIds: ['step-1'],
        },
      ],
    },
  });

  const result = validateJudgeOutput({
    status: 'succeeded',
    goalAchievement: { score: 0.82, reason: '完成目标。' },
    instructionAdherence: { score: 0.8, reason: '遵循规则。' },
    summary: '整体符合预期。',
    verdictSuggestion: 'pass',
    steps: [
      {
        stepId: 'step-1',
        completed: true,
        confidence: 0.91,
        evidenceIds: ['tool-call-1', 'missing-id'],
        matchedSignalIds: ['sig-step-1-read', 'unknown-signal'],
        reason: '先读取了规则。',
      },
    ],
  }, normalizedCase, ['tool-call-1', 'msg-1']);

  assert.equal(result.judge.status, 'succeeded');
  assert.equal(result.judge.steps.length, 2);
  assert.equal(result.judge.steps[0].evidenceIds.length, 1);
  assert.equal(result.judge.steps[1].stepId, 'step-2');
  assert.equal(result.judge.steps[1].completed, false);
  assert.equal(result.judge.constraintChecks.length, 1);
  assert.equal(result.judge.constraintChecks[0].constraintId, 'confirm-before-action');
  assert.equal(result.judge.constraintChecks[0].satisfied, null);
  assert.ok(result.issues.some((issue) => issue.code === 'judge_unknown_evidence_id'));
  assert.ok(result.issues.some((issue) => issue.code === 'judge_unknown_signal_id'));
  assert.ok(result.issues.some((issue) => issue.code === 'judge_step_missing'));
  assert.ok(result.issues.some((issue) => issue.code === 'judge_constraint_missing'));
});

function createValidFullCaseInput() {
  return {
    skillId: 'werewolf',
    loadingMode: 'full',
    userPrompt: '进入房间后请只以玩家身份参与狼人杀。',
    expectedBehavior: '先确认规则，再以玩家身份发言。',
    expectedGoal: '完成玩家视角回应。',
    expectedSteps: [
      {
        id: 'step-1',
        title: '确认规则',
        expectedBehavior: '先确认规则约束后再继续发言。',
        required: true,
        order: 1,
        failureIfMissing: '未先确认规则。',
        strongSignals: [{ id: 'sig-step-1-read', type: 'tool', toolName: 'read' }],
      },
    ],
    expectedSequence: ['step-1'],
    evaluationRubric: {
      criticalConstraints: [
        {
          id: 'confirm-before-action',
          description: '继续前先确认规则。',
          appliesToStepIds: ['step-1'],
        },
      ],
      passThresholds: {
        goalAchievement: 0.7,
        instructionAdherence: 0.7,
        sequenceAdherence: 0.7,
      },
      hardFailThresholds: {
        goalAchievement: 0.5,
        instructionAdherence: 0.5,
        sequenceAdherence: 0.4,
      },
      supportingSignalOverrides: [
        {
          stepId: 'step-1',
          signalId: 'sig-step-1-read',
          severity: 'critical',
        },
      ],
    },
  };
}

test('validateAndNormalizeCaseInput rejects userPrompt that is too short', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      ...createValidFullCaseInput(),
      userPrompt: '太短',
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'user_prompt_too_short'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput rejects userPrompt that is too long', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      ...createValidFullCaseInput(),
      userPrompt: 'a'.repeat(2001),
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'user_prompt_too_long'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput rejects non-array expectedTools', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      skillId: 'werewolf',
      loadingMode: 'dynamic',
      userPrompt: '请先读取目标 skill 文档。',
      expectedTools: { name: 'read' },
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'expected_tools_invalid'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput rejects non-array expectedSteps', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      ...createValidFullCaseInput(),
      expectedSteps: { id: 'step-1' },
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'expected_steps_required'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput rejects expectedSteps without required items', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      ...createValidFullCaseInput(),
      expectedSequence: [],
      evaluationRubric: {},
      expectedSteps: [
        {
          id: 'step-1',
          title: '确认规则',
          expectedBehavior: '先确认规则约束后再继续发言。',
          required: false,
          failureIfMissing: '未先确认规则。',
          strongSignals: [],
        },
      ],
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'required_step_missing'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput rejects duplicate step ids', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      ...createValidFullCaseInput(),
      expectedSequence: [],
      evaluationRubric: {},
      expectedSteps: [
        {
          id: 'step-1',
          title: '确认规则',
          expectedBehavior: '先确认规则约束后再继续发言。',
          required: true,
          failureIfMissing: '未先确认规则。',
          strongSignals: [],
        },
        {
          id: 'step-1',
          title: '再次确认规则',
          expectedBehavior: '再次确认规则。',
          required: false,
          failureIfMissing: '未再次确认规则。',
          strongSignals: [],
        },
      ],
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'step_id_duplicate'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput rejects invalid strong signal types', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      ...createValidFullCaseInput(),
      expectedSequence: [],
      evaluationRubric: {},
      expectedSteps: [
        {
          id: 'step-1',
          title: '确认规则',
          expectedBehavior: '先确认规则约束后再继续发言。',
          required: true,
          failureIfMissing: '未先确认规则。',
          strongSignals: [
            {
              id: 'sig-step-1-invalid',
              type: 'unknown',
            },
          ],
        },
      ],
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'signal_type_invalid'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput rejects malformed strong signal payloads', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      ...createValidFullCaseInput(),
      expectedSequence: [],
      evaluationRubric: {},
      expectedSteps: [
        {
          id: 'step-1',
          title: '确认规则',
          expectedBehavior: '先确认规则约束后再继续发言。',
          required: true,
          failureIfMissing: '未先确认规则。',
          strongSignals: [
            {
              id: 'sig-step-1-broken',
              type: 'tool',
            },
          ],
        },
      ],
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'signal_shape_invalid'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput rejects out-of-range rubric thresholds', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      ...createValidFullCaseInput(),
      evaluationRubric: {
        passThresholds: {
          goalAchievement: 1.2,
        },
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'threshold_range_invalid'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput rejects critical sequence dimensions without sequence constraints', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      ...createValidFullCaseInput(),
      expectedSequence: [],
      expectedSteps: [
        {
          id: 'step-1',
          title: '确认规则',
          expectedBehavior: '先确认规则约束后再继续发言。',
          required: true,
          failureIfMissing: '未先确认规则。',
          strongSignals: [],
        },
      ],
      evaluationRubric: {
        criticalDimensions: ['sequenceAdherence'],
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'critical_dimension_requires_sequence'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput rejects critical constraints that reference missing steps', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      ...createValidFullCaseInput(),
      evaluationRubric: {
        criticalConstraints: [
          {
            id: 'missing-step-ref',
            description: '必须命中缺失步骤。',
            appliesToStepIds: ['step-missing'],
          },
        ],
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'constraint_target_missing'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput rejects supporting overrides that reference unknown signals', () => {
  assert.throws(
    () => validateAndNormalizeCaseInput({
      ...createValidFullCaseInput(),
      evaluationRubric: {
        supportingSignalOverrides: [
          {
            stepId: 'step-1',
            signalId: 'sig-step-1-missing',
            severity: 'critical',
          },
        ],
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.issues.some((issue) => issue.code === 'override_target_missing'));
      return true;
    }
  );
});

test('validateAndNormalizeCaseInput emits warning when expectedSequence overrides step.order', () => {
  const normalized = validateAndNormalizeCaseInput({
    ...createValidFullCaseInput(),
    evaluationRubric: {},
    expectedSteps: [
      {
        id: 'step-1',
        title: '第一步',
        expectedBehavior: '先执行第一步。',
        required: true,
        order: 1,
        failureIfMissing: '第一步缺失。',
        strongSignals: [],
      },
      {
        id: 'step-2',
        title: '第二步',
        expectedBehavior: '再执行第二步。',
        required: false,
        order: 2,
        failureIfMissing: '第二步缺失。',
        strongSignals: [],
      },
    ],
    expectedSequence: ['step-2', 'step-1'],
  });

  assert.deepEqual(normalized.sequenceStepIds, ['step-2', 'step-1']);
  assert.ok(normalized.issues.some((issue) => issue.code === 'sequence_source_conflict'));
});

test('validateAndNormalizeCaseInput emits warning for unsupported strong signal matcher', () => {
  const normalized = validateAndNormalizeCaseInput({
    ...createValidFullCaseInput(),
    expectedSequence: [],
    evaluationRubric: {},
    expectedSteps: [
      {
        id: 'step-1',
        title: '确认规则',
        expectedBehavior: '先确认规则约束后再继续发言。',
        required: true,
        failureIfMissing: '未先确认规则。',
        strongSignals: [
          {
            id: 'sig-step-1-read',
            type: 'tool',
            toolName: 'read',
            matcher: 'unsupported-matcher',
          },
        ],
      },
    ],
  });

  assert.ok(normalized.issues.some((issue) => issue.code === 'unsupported_signal_matcher'));
});

test('validateJudgeOutput marks runtime failures as needs-review issues', () => {
  const normalizedCase = validateAndNormalizeCaseInput(createValidFullCaseInput());
  const result = validateJudgeOutput(
    {
      status: 'runtime_failed',
      errorMessage: 'judge timeout',
    },
    normalizedCase,
    ['msg-1']
  );

  assert.equal(result.judge.status, 'runtime_failed');
  assert.ok(result.issues.some((issue) => issue.code === 'judge_runtime_failed'));
});

test('validateJudgeOutput degrades invalid verdictSuggestion to parse_failed', () => {
  const normalizedCase = validateAndNormalizeCaseInput(createValidFullCaseInput());
  const result = validateJudgeOutput(
    {
      status: 'succeeded',
      verdictSuggestion: 'maybe',
      steps: [],
      constraintChecks: [],
    },
    normalizedCase,
    ['msg-1']
  );

  assert.equal(result.judge.status, 'parse_failed');
  assert.ok(result.issues.some((issue) => issue.code === 'judge_verdict_invalid'));
  assert.ok(result.issues.some((issue) => issue.code === 'judge_parse_failed'));
});

test('validateJudgeOutput strips unknown step and constraint ids and backfills required placeholders', () => {
  const normalizedCase = validateAndNormalizeCaseInput(createValidFullCaseInput());
  const result = validateJudgeOutput(
    {
      status: 'succeeded',
      verdictSuggestion: 'pass',
      goalAchievement: { score: 0.9, reason: '目标达成。' },
      instructionAdherence: { score: 0.88, reason: '行为符合。' },
      summary: '结果正常。',
      steps: [
        {
          stepId: 'step-unknown',
          completed: true,
          confidence: 0.9,
          evidenceIds: ['msg-1'],
          matchedSignalIds: [],
          reason: '未知步骤。',
        },
      ],
      constraintChecks: [
        {
          constraintId: 'constraint-unknown',
          satisfied: true,
          evidenceIds: ['msg-1'],
          reason: '未知约束。',
        },
      ],
    },
    normalizedCase,
    ['msg-1']
  );

  assert.equal(result.judge.status, 'succeeded');
  assert.ok(result.issues.some((issue) => issue.code === 'judge_unknown_step_id'));
  assert.ok(result.issues.some((issue) => issue.code === 'judge_unknown_constraint_id'));
  assert.ok(result.issues.some((issue) => issue.code === 'judge_step_missing'));
  assert.ok(result.issues.some((issue) => issue.code === 'judge_constraint_missing'));
  assert.equal(result.judge.steps.length, 1);
  assert.equal(result.judge.steps[0].stepId, 'step-1');
  assert.equal(result.judge.constraintChecks.length, 1);
  assert.equal(result.judge.constraintChecks[0].constraintId, 'confirm-before-action');
});

test('buildSkillTestDraftInputFromMatrixRow produces environment-build draft without trigger prompt', () => {
  const draft = buildSkillTestDraftInputFromMatrixRow(
    'docx',
    { matrixId: 'matrix-envbuild-1' },
    {
      rowId: 'row-envbuild',
      scenario: 'build test environment for docx skill',
      priority: 'P0',
      coverageReason: 'environment-build produces manifest and optional image for docx execution cases',
      testType: 'environment-build',
      loadingMode: 'full',
      environmentSource: 'skill_contract',
      environmentContractRef: 'TESTING.md#skill-test-environment',
      riskPoints: ['pandoc not available in base image'],
      keyAssertions: ['environment-manifest.json is produced'],
      includeInMvp: true,
      draftingHints: {
        environmentConfig: {
          enabled: true,
          requirements: [{ kind: 'command', name: 'pandoc' }],
          bootstrap: { commands: ['apt-get update && apt-get install -y pandoc'] },
          verify: { commands: ['pandoc --version'] },
        },
      },
    },
    {
      conversationId: 'conv-envbuild',
      messageId: 'msg-envbuild',
      agentRole: 'scribe',
      exportedBy: 'user',
    }
  );

  assert.equal(draft.skillId, 'docx');
  assert.equal(draft.testType, 'environment-build');
  assert.equal(draft.loadingMode, 'full');
  assert.equal(Object.prototype.hasOwnProperty.call(draft, 'triggerPrompt'), false);
  assert.ok(draft.userPrompt.includes('docx'));
  assert.equal(draft.expectedTools.length, 0);
  assert.equal(draft.caseStatus, 'draft');
  assert.deepEqual(draft.environmentConfig.requirements[0], { kind: 'command', name: 'pandoc' });
  assert.equal(draft.sourceMetadata.source, 'skill_test_chat_workbench');
  assert.equal(draft.sourceMetadata.matrixId, 'matrix-envbuild-1');
  assert.equal(draft.sourceMetadata.matrixRowId, 'row-envbuild');
  assert.equal(draft.sourceMetadata.skillTestDesign.environmentSource, 'skill_contract');
  assert.equal(draft.sourceMetadata.skillTestDesign.environmentContractRef, 'TESTING.md#skill-test-environment');
});

test('buildSkillTestDraftInputFromMatrixRow environment-build with empty environmentConfig still exports', () => {
  const draft = buildSkillTestDraftInputFromMatrixRow(
    'docx',
    { matrixId: 'matrix-envbuild-2' },
    {
      rowId: 'row-envbuild-noconfig',
      scenario: 'build docx environment without explicit config',
      priority: 'P1',
      coverageReason: 'contract-driven, reads from TESTING.md',
      testType: 'environment-build',
      loadingMode: 'full',
      environmentSource: 'skill_contract',
      environmentContractRef: 'TESTING.md#skill-test-environment',
      keyAssertions: ['reads contract from TESTING.md'],
      includeInMvp: true,
    },
    {
      conversationId: 'conv-envbuild-2',
      messageId: 'msg-envbuild-2',
    }
  );

  assert.equal(draft.testType, 'environment-build');
  assert.equal(Object.prototype.hasOwnProperty.call(draft, 'triggerPrompt'), false);
  assert.deepEqual(draft.environmentConfig, {});
  assert.equal(draft.sourceMetadata.skillTestDesign.environmentContractRef, 'TESTING.md#skill-test-environment');
});
