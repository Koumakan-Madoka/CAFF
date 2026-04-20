# PRD: 04-20-skill-test-open-sandbox-typing-pass

## Goal
- 将 `server/domain/skill-test/open-sandbox-factory.ts` 中剩余的 `tool adapter` 与 `startRun` 兼容 helper cluster 收成更明确的类型边界。
- 在不改默认执行模型的前提下，继续缩小 file-wide `@ts-nocheck` 的风险面。
- 让后续如果 sandbox tool contract、路径投影或兼容执行 evidence 接歪，能更早在 build/typecheck 阶段暴露。

## Problem Statement
- `04-20-skill-test-sandbox-type-hardening` 已经把 environment chain 依赖的公共 contract 收到 `sandbox-tool-contract.ts`，但 `open-sandbox-factory.ts` 内部 helper cluster 仍处在 file-wide `@ts-nocheck` 下。
- 这个文件同时承载了默认会走到的 sandbox tool adapter 包装层，以及保留但不应成为默认路径的 `startRun` 兼容分支。
- 如果继续把这些 helper 留在无类型区域，后续很容易在不自觉中把 host/sandbox 职责边界或 compat path 语义接歪。

## Scope
- In scope:
- 为 `createSandboxToolAdapter()` 附近的 helper cluster 补局部类型，包括 `mapHostPathToRemote`、`access`、`mkdir`、`readFile`、`writeFile`、`runCommand` 等能力。
- 为 `startRun` / execution support 相关 helper cluster 补显式输入输出类型，明确它是兼容保留路径而非默认 skill-test 执行模型。
- 视风险而定，将可独立抽离的新 typed helper 移出 file-wide `@ts-nocheck` 文件，或至少把高风险逻辑收进显式 local interface / guard。
- Out of scope:
- 修改默认 `host-loop + sandbox-tools` 执行模型。
- 改 controller 的职责边界或重新引入 full-sandbox 为默认路径。
- 借题发挥做整个 `open-sandbox-factory.ts` 的 strict typing 大扫除。

## Requirements
- 默认 skill-test 执行路径仍必须是 `host-loop + sandbox-tools`；`startRun` 兼容逻辑若保留，只能作为明确的 legacy/compat surface。
- 类型收口必须保持现有 sandbox cwd/path 语义、命令结果归一化语义与 tool adapter 能力边界不变。
- 不允许为了“类型更好看”而扩大行为改动面；controller 与 environment chain 的公开调用方式应保持稳定。
- 优先按 helper cluster 做小切口治理，而不是一把把整个 legacy file 改写成另一种结构。

## Acceptance Criteria
- [ ] `open-sandbox-factory.ts` 中默认会被环境链依赖的 tool adapter helper cluster 具备可检查类型边界，不再完全依赖 ad-hoc shape。
- [ ] `startRun` 兼容 helper cluster 的输入输出语义更显式，且不会把 full-sandbox compat path 误导成默认路径。
- [ ] 本轮不改变 controller 职责、不改变执行模型，也不把任务膨胀成全文件 strict typing。
- [ ] `npm run build` 与 `npm run typecheck` 通过。
- [ ] `tests/skill-test/skill-test-schema.test.js` 与 `tests/skill-test/skill-test-e2e.test.js --test-name-pattern "environment|cache|runtime_unsupported"` 继续通过。

## Proposed Strategy
### Step 1: Tool Adapter Cluster First
- 先收口直接被 environment chain 消费的 adapter 能力，把结果 shape、路径映射与读写能力钉成显式接口。

### Step 2: Compat `startRun` Cluster
- 再给 `startRun` 相关 helper cluster 加上类型与命名上的 compat 提示，明确它只是兼容保留，不是主执行路径。

### Step 3: Stop At the Safe Boundary
- 一旦默认路径与 compat path 的关键 contract 已可检查，就停止扩张，不顺手把整个文件都纳入这次任务。

## Validation
- `npm run build`
- `npm run typecheck`
- `node --test tests/skill-test/skill-test-schema.test.js`
- `node --test tests/skill-test/skill-test-e2e.test.js --test-name-pattern "environment|cache|runtime_unsupported"`

## Notes
- 这个任务刻意不挂回功能主任务，而是作为独立治理线跟在 `04-20-skill-test-sandbox-type-hardening` 之后推进，让已交付的 feature 任务可以独立收口。
- 成功标准是“让关键 helper cluster 有护栏”，不是“让整个 `open-sandbox-factory.ts` 一次毕业”。
