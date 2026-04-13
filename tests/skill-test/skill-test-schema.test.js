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
const { normalizeSkillTestIsolationOptions } = require('../../build/server/domain/skill-test/isolation');

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

  const caseColumns = db.prepare('PRAGMA table_info(skill_test_cases)').all().map((row) => row.name);
  assert.ok(caseColumns.includes('expected_steps_json'));
  assert.ok(caseColumns.includes('generation_provider'));
  assert.ok(caseColumns.includes('generation_model'));
  assert.ok(caseColumns.includes('generation_created_at'));

  db.close();
});

test('migrateSkillTestSchema is idempotent', () => {
  const db = createTestDb();
  // Run migration again — should not throw
  assert.doesNotThrow(() => migrateSkillTestSchema(db));
  db.close();
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
