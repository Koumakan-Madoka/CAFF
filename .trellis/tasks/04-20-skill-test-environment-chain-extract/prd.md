# PRD: 04-20-skill-test-environment-chain-extract

## Goal
- 将 `server/api/skill-test-controller.ts` 中已经成型的 environment readiness chain 抽离到 `server/domain/skill-test/` 下的独立模块。
- 保持 `host-loop + sandbox-tools` 架构、API contract、结果结构与缓存语义不变。
- 降低后续继续修改 `preflight / bootstrap / verify / cache / TESTING.md fallback` 时的 review 成本与误伤面。

## Problem Statement
- `server/api/skill-test-controller.ts` 已经承载了 HTTP schema、run orchestration、result shaping 与 environment chain，多类职责叠在一起。
- 环境链经过 `04-20-skill-test-bootstrap-environment` 已经形成稳定 contract，但仍以内联顶层函数簇存在于 controller 中，后续很难局部推理、补测试或做类型约束。
- 上轮 review 已明确把 controller 体积与可维护性列为后续优先的低风险治理项。

## Scope
- In scope:
- 抽离环境配置归一化、merge 与 plan 生成逻辑。
- 抽离 `TESTING.md` 读取、解析、fallback metadata 生成逻辑。
- 抽离 `preflight -> bootstrap -> verify -> cache` orchestration helper。
- 让 controller 收敛为 request parsing、dependency wiring、persistence coordination 与 response shaping。
- 如有必要，补少量围绕新模块边界的回归或测试辅助函数。
- Out of scope:
- 修改 environment schema、result shape、cache key、TTL 或 save/restore 行为。
- 改动 UI 展示、run detail 字段、evaluation persistence 结构。
- 顺手处理 `@ts-nocheck` 或重写 sandbox execution model。

## Requirements
- 抽离后所有命令执行仍必须经由 sandbox tool adapter，不能引入 host fallback。
- 新模块之间的依赖必须显式，通过参数或窄接口传入，不依赖 controller 隐式全局状态。
- 现有错误分类与持久化字段必须保持不变，包括 `env_missing`、`env_install_failed`、`env_verify_failed`、`runtime_unsupported`。
- 优先采用一到两个聚合模块完成搬迁，避免首轮重构拆成过多碎文件。
- 除 import / helper 边界调整外，不应引入新的行为分支或新的 API 字段。

## Acceptance Criteria
- [ ] environment chain 的核心 helper 不再直接定义在 `server/api/skill-test-controller.ts` 中。
- [ ] controller 的环境相关代码主要保留协调与组装职责，不再内联完整 orchestration 细节。
- [ ] 现有 environment schema / e2e 回归在不修改断言语义的前提下继续通过。
- [ ] `host-loop + sandbox-tools` 的职责边界保持不变，sandbox-only 约束不被削弱。
- [ ] 如模块归属说明发生变化，相关 spec 文档同步最小更新。

## Proposed Cut
### Module Boundary
- 首选新增 `server/domain/skill-test/environment-chain.ts`，承载环境配置归一化、probe/bootstrap/verify orchestration、cache lookup/save helper。
- 若 `TESTING.md` 解析逻辑仍显得过重，可再拆一个轻量 `server/domain/skill-test/environment-testing-doc.ts`，但不要求首轮一定拆分。

### Controller Responsibility After Refactor
- 读取 request / case / runtime 输入。
- 组装 environment chain 所需依赖与 option。
- 接收环境结果并写入 `evaluation_json`、summary 字段与 SSE/event 链路。
- 不再内联大段 plan/execute/cache helper 实现。

## Validation
- `npm run build`
- `node --test tests/skill-test/skill-test-schema.test.js`
- `node --test tests/skill-test/skill-test-e2e.test.js --test-name-pattern "environment|cache|runtime_unsupported"`

## Notes
- 这是行为保持型重构任务，不追求新功能；如果发现需要改协议或缓存语义，应回退并另开功能任务。
