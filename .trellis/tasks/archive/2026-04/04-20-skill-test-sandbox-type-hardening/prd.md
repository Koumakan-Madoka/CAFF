# PRD: 04-20-skill-test-sandbox-type-hardening

## Goal
- 为 `skill-test` environment chain 依赖的 sandbox tool adapter、cwd/path 语义与二进制 cache artifact 流程补一层显式类型契约。
- 缩小 `server/domain/skill-test/isolation.ts` 与 `server/domain/skill-test/open-sandbox-factory.ts` 上 `@ts-nocheck` 的影响面，让 host/sandbox 边界漂移更容易在 build 时暴露。
- 在不改执行模型的前提下，为后续环境链继续迭代补类型护栏。

## Problem Statement
- 环境缓存、restore/save、binary write 与 sandbox tool adapter 的新逻辑已经落地，但相关宿主文件仍处在 `@ts-nocheck` 下。
- 这意味着后续如果 adapter result shape、路径投影或二进制写入协议接反，类型系统无法尽早拦截。
- 直接移除两个大文件的 file-wide `@ts-nocheck` 风险偏高，也容易把结构重写与类型修补耦在一起。

## Scope
- In scope:
- 为 environment chain 真正依赖的 sandbox adapter capability 建立显式 typed facade 或 helper interface。
- 为 binary artifact write / restore、cwd/path projection、tool result payload 等关键表面补类型约束。
- 如可控，收缩 `@ts-nocheck` 到更小的 legacy surface，或将新逻辑迁入有类型的新模块。
- 为关键 typed surface 补最小验证，确保 build 可以捕捉 contract mismatch。
- Out of scope:
- 全量移除 `isolation.ts` 与 `open-sandbox-factory.ts` 的所有 `@ts-nocheck`。
- 修改 sandbox execution model、cache policy、egress policy 或 tool semantics。
- 顺手做 controller 拆分；那是独立低风险任务。

## Requirements
- 所有 environment chain 调用位点都应依赖显式接口，而不是散落的 ad-hoc object shape。
- 类型设计必须反映 sandbox 语义，包括 sandbox cwd、sandbox path 回显、stdout/stderr / exitCode 结构与二进制写入能力。
- 如果 file-wide `@ts-nocheck` 无法一次删除，至少要避免新增环境链逻辑继续落入无类型区域。
- 优先选择“抽 typed helper / facade 出来”而非直接重写 legacy file，大改动应延后到单独重构任务。

## Acceptance Criteria
- [x] 新增 typed facade 或 helper module，覆盖 environment chain 使用到的 sandbox adapter contract。
- [x] environment cache save/restore、binary write 或 tool result shape 的关键调用位点具有可检查类型。
- [x] build 能对这些 typed surface 的 contract mismatch 提前失败，而不是只能等运行时。
- [x] 现有 isolated run、environment cache 与 runtime_unsupported 回归继续通过。
- [x] 若仍保留 file-wide `@ts-nocheck`，任务文档中明确剩余 blocker 与后续拆解建议。

## Proposed Strategy
### Step 1: Typed Facade First
- 新增靠近 `server/domain/skill-test/` 的 typed adapter contract，描述 environment chain 需要的最小能力，例如：
  - command execution in sandbox
  - text/binary file write
  - file read / directory creation
  - sandbox cwd / path projection
  - normalized command result payload

### Step 2: Redirect Sensitive Call Sites
- 将 environment cache save/restore 与命令执行相关调用切到 typed facade。
- 保留 legacy adapter 内部实现不变，先让边界变明确，再考虑更大范围清理。

### Step 3: Reduce `@ts-nocheck` Blast Radius
- 能删除就删除；删不掉时，优先把新增或高风险逻辑迁出到 typed module。
- 用更窄的 suppressions 代替 file-wide 扩散，但不强求一次性把整个 legacy file 清干净。

## Validation
- `npm run build`
- `node --test tests/skill-test/skill-test-schema.test.js`
- `node --test tests/skill-test/skill-test-e2e.test.js --test-name-pattern "environment|cache|runtime_unsupported"`

## Notes
- 这个任务的成功标准是“护栏变强”，不是“类型洁癖毕业”。只要 environment chain 依赖的高风险边界不再完全裸奔，就已经有明确价值。
- 当前仍保留 `server/domain/skill-test/isolation.ts` 与 `server/domain/skill-test/open-sandbox-factory.ts` 的 file-wide `@ts-nocheck`，因为两者仍承载较大面积的 legacy helper、SDK 兼容分支与宿主编排逻辑；本轮先把 environment chain 真正依赖的 adapter contract 迁到 `server/domain/skill-test/sandbox-tool-contract.ts` 并给导出签名补类型，后续再按 helper cluster 继续拆分、逐步缩小 suppression 面积。
