# TypeScript 迁移计划（分阶段）

更新时间：2026-03-26

## 0. 进度（本仓库）

- [x] Phase 0：基线固定为 `npm test`
- [x] Phase 1：已引入 `npm run typecheck`（`tsc --noEmit`，覆盖 `server/` + `storage/` + `lib/`，排除 `public/`）
- [x] Phase 2：已打通 build 产物可运行（`npm run build` 输出到 `build/`，`npm start` 运行 `build/lib/app-server.js`，并复制 `public/` 到 `build/public/`）
- [x] Phase 3：按目录逐步迁移 `.js` -> `.ts`（已完成：`server/http/`、`server/api/`、`storage/`、`server/domain/runtime/`、`server/domain/conversation/`、`server/domain/undercover/`、`server/app/`、`lib/`）
- [ ] Phase 4：逐步收紧类型严谨度（`strict` 等）
- [ ] Phase 5：处理 `public/`（保持 JS + `@ts-check` 或引入 bundler）

## 1. 背景与目标

你当前的代码库主要是 Node.js（CommonJS）+ 少量前端静态脚本（`public/`）。将项目从 JS 逐步迁移到 TS 的核心目标是：

- 更早发现跨模块/跨层的数据结构与参数不一致问题（减少线上/运行时才暴露的 bug）。
- 提升重构安全性（字段改名、函数签名变更、跨文件移动时更有把握）。
- 提升可维护性与开发体验（IDE 补全/跳转/导航明显更好）。

非目标（建议暂时不做）：

- 不做“一次性全量改写”（big-bang rewrite）。
- 不在第一阶段切 ESM、也不强行引入 bundler（除非要大规模改 `public/`）。

## 2. 当前仓库现状（基线）

（基于本仓库扫描结果）

- Node：`v24.13.1`
- 模块系统：`package.json` 为 `type: commonjs`
- 代码规模：约 76 个 `.js` 文件，暂无 `.ts` 文件
- 测试：使用 `node:test`（`tests/**/*.test.js`），当前 `npm test` 会跑 `test:fast + test:smoke`
- 关键目录：
  - 后端：`server/`、`storage/`、`lib/`
  - 前端静态资源：`public/`

迁移的“回归基线”建议固定为：`npm test` 全绿。

## 3. 总体策略（强烈推荐：渐进式）

原则：

1. **先类型检查收益，后运行时迁移**：第一阶段只引入 `tsc --noEmit`，不改变运行方式。
2. **小 PR、按目录切片**：一次 PR 只迁移一个目录（或一个子模块树），不要全仓库 rename。
3. **任何时候保持可运行**：每个阶段都要求 `npm test` 通过；必要时允许少量临时豁免，但要在后续阶段偿还。
4. **先后端、后前端**：`public/` 先保持 JS（或用 JSDoc + `@ts-check`），避免一开始就引入 bundler/编译输出路径问题。

建议的 PR 规模：

- Phase 1/2：1 个 PR 一个里程碑
- Phase 3：每个目录 1~N 个 PR（根据复杂度）
- 每个 PR 都必须：`npm test`、`npm run typecheck`（从 Phase 1 开始）

## 4. Phase 0：准备与约束（0~0.5 天）

目标：建立迁移的边界与验收标准，避免后续漂移。

工作项：

- 明确当前“迁移回归基线”：`npm test`
- 明确迁移顺序：先 `server/` + `storage/`，再 `lib/`，最后 `public/`
- 规定导出风格（建议）：**暂不使用 `export default`**（降低 CommonJS `require()` 互操作风险）

验收：

- `npm test` 在主分支稳定通过

## 5. Phase 1：只引入 TypeScript 类型检查（不改运行）（0.5~1 天）

目标：获得 60% 的 TS 收益，且不改变任何运行方式。

工作项（建议一口气完成在同一 PR）：

- 增加 devDependencies：
  - `typescript`
  - `@types/node`
- 增加类型检查配置（建议单独文件便于演进）：
  - `tsconfig.typecheck.json`
  - 关键选项建议：`allowJs: true`、`checkJs: true`、`noEmit: true`
- 增加脚本：
  - `npm run typecheck` -> `tsc -p tsconfig.typecheck.json`
- `include/exclude` 策略：
  - **先只覆盖后端**：`server/`、`storage/`、`lib/`
  - **先排除 `public/`**（否则 DOM 类型会把噪音放大，且需要额外决策）

处理报错策略（务实版）：

- 优先修“确定性错误”（拼写、漏参数、返回值不一致）。
- 对短期无法解决的旧代码，允许临时：
  - 在文件头添加 `// @ts-nocheck`（但要登记为 debt）
  - 或在局部使用 `/** @type {any} */`（优先于全文件 `nocheck`）

验收：

- `npm run typecheck` 通过（或仅剩少量已登记的临时豁免）
- `npm test` 仍全绿（运行方式不变）

## 6. Phase 2：打通“可运行 TS”的工程路径（1~2 天）

目标：让 `.ts` 文件在仓库内出现后，项目仍能启动与测试；为 Phase 3 做铺垫。

这里有两条路线（二选一，推荐 A）：

### A) 预编译（推荐）：`tsc` 输出到 `build/`

优点：运行时更干净、行为更确定、CI 更稳定；缺点：需要处理静态资源与路径。

关键工作项：

- 新增 `tsconfig.build.json`（`noEmit: false`，输出到 `build/`）
- 增加脚本：
  - `npm run build` -> `tsc -p tsconfig.build.json`
  - `npm start` 改为运行 `build/` 的入口（例如 `node build/lib/app-server.js`）
- 处理静态资源与根路径问题（本仓库重点）：
  - 目前 `server/app/config.js` 通过 `__dirname` 推导 `ROOT_DIR`
  - 当运行 `build/` 时，`ROOT_DIR` 会指向 `build/`，这会影响 `public/` 资源定位
  - 解决方式建议（任选其一）：
    1) 构建时复制 `public/` 到 `build/public/`
    2) 把 root 改为基于 `process.cwd()` 或引入一个明确的 `APP_ROOT` 配置

验收：

- `npm run build` 可用
- `npm start` 正常启动，页面/静态资源可访问
- `npm test` 通过（可以选择：测试仍跑源码 JS，或跑 build 产物；但建议保持一致）

### B) 运行时转译：`tsx` / `ts-node`

优点：改动更小；缺点：运行依赖更重，长期一致性略差（不同环境下转译差异/性能）。

验收同上（`start/test` 需稳定）。

## 7. Phase 3：开始目录级迁移为 `.ts`（多 PR，按模块逐步推进）

目标：把核心后端模块逐步从 JS 变为 TS，同时保持每个 PR 可回滚、可验证。

推荐顺序（每个目录单独 PR，必要时拆分子目录）：

1. `server/http/`（底层、边界清晰、联动少）
2. `server/api/`
3. `storage/`（数据结构与 repo 边界清晰，类型收益大）
4. `server/domain/`（如 `conversation/turn/*`）
5. `lib/`（被引用多，放后面更稳）

迁移做法建议：

- 单个 PR 只做：
  - `.js` -> `.ts` rename
  - require/import 语法调整
  - 让 `tsc` 过（必要时增加最小类型）
- 避免在同一 PR 里“顺手重构逻辑”（会让回归困难）

验收（每个 PR 固定三件套）：

- `npm run typecheck`
- `npm test`
- `npm start`（或至少 `npm run test:smoke`）

## 8. Phase 4：逐步收紧类型严谨度（多 PR，小步快跑）

目标：从“有类型”走向“类型可靠”，但不制造长时间红线。

建议顺序（每次只收紧 1~2 项）：

- 开启/提高 `strict` 相关规则
- 对 `any` 做局部替换：先 `unknown` + type guard，再结构化类型
- 补齐关键边界类型：
  - API 请求/响应
  - DB 记录结构
  - 运行时状态（例如 conversation / turn state）

验收：

- 每次收紧后 `npm run typecheck` + `npm test` 全绿

## 9. Phase 5：`public/`（最后动，或长期保持 JS）

方案 1（低成本，推荐优先）：继续 JS，但增强检查

- 为 `public/` 增加单独的 `tsconfig.public.json`（`checkJs` + DOM lib）
- 在关键文件头增加 `// @ts-check` 并补充 JSDoc

方案 2（高收益/高成本）：引入构建（esbuild/rollup 等）

- 将 `public/src/*.ts` 构建到 `public/*.js`
- 需要同时处理缓存、路径、发布策略（不建议在后端迁移未稳定前引入）

## 10. 建议的落地起步（本仓库）

最稳的第一步（建议下一 PR）：

- 完成 Phase 1：`typecheck` 覆盖 `server/` + `storage/` + `lib/`，先排除 `public/`

这样你会在**不改变运行**的情况下，立刻获得类型带来的错误发现与重构信心；等类型检查稳定后，再进入 Phase 2/3。
