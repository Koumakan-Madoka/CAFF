# PRD: 04-20-skill-test-isolation-typing-pass

## Goal
- 将 `server/domain/skill-test/isolation.ts` 中和 execution evidence、publish gate、case context、driver assembly 相关的 helper cluster 补成更显式的类型边界。
- 继续缩小 file-wide `@ts-nocheck` 的有效风险面，同时保持 `host-loop + sandbox-tools` 语义不漂移。
- 让后续如果 execution/path semantics、publish gate reason 或 case context wiring 被改歪，能更早被 build/typecheck 捕获。

## Problem Statement
- `isolation.ts` 仍是 skill-test 隔离编排里的大文件，虽然导出签名已经接上 shared contract，但内部关键 helper cluster 还处在 file-wide `@ts-nocheck` 保护伞下。
- 这些 helper 直接决定 execution evidence、publish gate、sandbox path semantics 与 case context 组装结果，一旦 contract 漂移，影响面会跨 controller、environment chain 与结果汇总。
- 上轮 review 已经证明这里适合继续做低风险治理，但不适合一口气做全文件 strict typing 或结构重写。

## Scope
- In scope:
- 为 execution evidence / path semantics / publish gate 附近的 helper cluster 补 local interface、guard 或可独立抽离的 typed helper。
- 为 case context、store、driver assembly 等 wiring cluster 补显式类型，减少 `unknown` 与 ad-hoc object shape 的扩散。
- 在不改变行为的前提下，修补容易误导类型系统的 null/object 判定或 capability 检查细节。
- Out of scope:
- 修改 skill-test 的执行模型、publish gate 对外 contract、controller 职责边界或 case world 生命周期。
- 顺手做数据库层重构、全文件 strict typing、或 unrelated helper 清理。
- 扩大到 UI、结果持久化 schema 或评测逻辑变更。

## Requirements
- 类型收口必须保持 loop-on-host / tool-in-sandbox 的现有语义，包括 execution evidence、path semantics、publish gate reason 与 sandbox-only 限制。
- 不允许通过类型重构改变 controller 与 domain 的职责分工，也不允许重新引入 host fallback。
- 优先做 helper cluster 级的小切口治理；若某块开始牵连过大，应停在清晰边界并把剩余部分留给后续任务。
- 对 null-safe adapter 判定、driver capability 检查、case context wiring 等容易出错的点，要优先用显式 guard 收口。

## Acceptance Criteria
- [ ] `isolation.ts` 中 execution evidence / publish gate / case context / driver assembly 的关键 helper cluster 具备更可检查的类型边界。
- [ ] `host-loop + sandbox-tools` 相关 execution 和 path semantics 的公开语义保持不变，不新增 host fallback 或新公共字段。
- [ ] 本轮不改 controller 职责、不改执行模型，也不把任务膨胀成整个 `isolation.ts` 的 strict typing 工程。
- [ ] `npm run build` 与 `npm run typecheck` 通过。
- [ ] `tests/skill-test/skill-test-schema.test.js` 与 `tests/skill-test/skill-test-e2e.test.js --test-name-pattern "environment|cache|runtime_unsupported"` 继续通过。

## Proposed Strategy
### Step 1: Evidence and Publish Gate Cluster
- 先处理最容易造成语义漂移的 execution evidence、path semantics 与 publish gate helper，确保默认执行模型相关 contract 不会在无类型区悄悄变形。

### Step 2: Case Context and Driver Assembly Cluster
- 再收口 case context / store / driver assembly 这些 wiring helper，让跨模块输入输出形状更清楚。

### Step 3: Leave Residual Legacy Surface Explicit
- 若 file-wide `@ts-nocheck` 仍不能完全拿掉，就把剩余 blocker 明确记在任务产物里，不为了“清零”而扩大行为风险。

## Validation
- `npm run build`
- `npm run typecheck`
- `node --test tests/skill-test/skill-test-schema.test.js`
- `node --test tests/skill-test/skill-test-e2e.test.js --test-name-pattern "environment|cache|runtime_unsupported"`

## Notes
- 这个任务同样故意保持 `parent: null`，只在 notes / meta 中回链 `04-20-skill-test-sandbox-type-hardening`，避免把功能交付线和后续类型治理线缠成一坨。
- 成功标准是让最容易漂移的 isolation helper cluster 先有护栏，而不是强行把整个 `isolation.ts` 一次改成全绿类型文件。
