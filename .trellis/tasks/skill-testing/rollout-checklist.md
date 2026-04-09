# Workstream E: Tests / Rollout Checklist

## 目标

- 固化 Phase 3 canonical contract 的回归入口，避免字段语义漂移
- 明确发布前自动化与人工验收步骤，减少“手工猜字段”
- 为后续模型 / promptVersion 回归提供稳定基线

## 自动化回归矩阵

### 1) Contract / Schema

命令：

```bash
node --test tests/skill-test/skill-test-schema.test.js
```

重点覆盖：

- Full case canonical 字段校验（`userPrompt` / `expectedGoal` / `expectedSteps`）
- `expectedSteps` 结构约束（`required`、`stepId` 唯一、signal shape/type）
- `evaluationRubric` 约束（阈值范围、critical sequence、constraint/override 引用）
- Judge 输出校验（`verdictSuggestion`、unknown id 剥离、placeholder backfill、`runtime_failed`）

### 2) Generator Contract

命令：

```bash
node --test tests/skill-test/skill-test-generator.test.js
```

重点覆盖：

- dynamic/full 生成 prompt 契约
- Full draft 产出 `expectedGoal + expectedSteps + evaluationRubric`
- canonical `userPrompt` / legacy `triggerPrompt` 兼容语义
- 生成默认结构化 `expectedTools` 与 `<contains:...>` 语法

### 3) Aggregation / Persistence / Regression + API

命令：

```bash
node --test tests/skill-test/skill-test-e2e.test.js
node --test tests/storage/run-store.test.js
```

重点覆盖：

- Full run verdict 聚合（`pass/borderline/fail`）
- `evaluation_json` 真源 + 镜像列投影告警（`evaluation_projection_*`）
- 回归分桶（`provider/model/promptVersion`）
- case/runs/detail/regression API 读取行为一致性

## 人工验收清单（发布前）

### [A] 创建与编辑（UI）

- [x] 打开 Skill Tests，创建 Full case，验证必填项缺失进入 issues 面板（非仅 toast）
- [x] 编辑 `expectedSteps` / `evaluationRubric` 非法 JSON，确认显示结构化 issues
- [x] 创建成功后：新 case 自动聚焦详情，issues 清空/保留策略符合预期

### [B] 运行与诊断（UI）

- [x] 单条运行 Full case，可见 steps / constraintChecks / aggregation / aiJudge 分区
- [x] `parse_failed` 场景可见原始诊断与 `needs-review` 提示
- [x] run detail 优先读取 `result.evaluation`，缺失时回退 `run.evaluation`

### [C] 回归视图

- [x] 同 case 在不同 `provider/model/promptVersion` 下可形成回归 bucket
- [x] 回归维度展示与 run detail 的 `evaluation.dimensions` 一致
- [x] summary 与 regression 的 execution rate 以 Full verdict=pass 口径计算

### [D] 批量流程

- [x] run-all 仅运行 `caseStatus = ready` 的 case
- [x] invalid schema case 无法 mark-ready，返回结构化 `issues[]`
- [x] 草稿 case 不会被批量误跑

## 发布门禁（建议）

- [x] `npm run check`
- [x] `npm run build`
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `node --test tests/skill-test/skill-test-schema.test.js`
- [x] `node --test tests/skill-test/skill-test-generator.test.js`
- [x] `node --test tests/skill-test/skill-test-e2e.test.js`
- [x] `node --test tests/storage/run-store.test.js`

若任一门禁失败，暂停 rollout，先修复并补回归用例后再重新放行。
