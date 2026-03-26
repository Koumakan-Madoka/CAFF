# 测试护栏方案（caff 项目）

> 目标：在你后续让 AI/人类开发功能时，用一套“自动化质量闸门（Quality Gates）+ 分层测试”把常见回归 bug 尽量挡在合入之前。

## 1. 我读到的项目现状（用于对齐方案）

### 技术栈/结构

- Node.js（CommonJS），无额外测试框架依赖，测试基于 `node:test` + `node:assert/strict`。
- 后端：入口在 `lib/app-server.ts`（build 后运行 `build/lib/app-server.js`），依赖组装在 `server/app/create-server.ts`，HTTP 路由由 `server/http/router.ts` 串联 controllers（`server/api/*`）。
- 核心业务：对话编排在 `server/domain/conversation/turn-orchestrator.ts` 与 `server/domain/conversation/turn/*`；@mention 路由规则在 `server/domain/conversation/mention-routing.ts`。
- 持久化：SQLite（`better-sqlite3`），store 在 `lib/chat-app-store.ts`，运行/任务 store 在 `lib/sqlite-store.ts`。

### 已有“护栏”与测试

- 语法检查：`npm run check`（`node --check ...` 覆盖 `public/`；后端/存储/运行时由 `npm run build` 与 `npm run typecheck` 覆盖）。
- 测试入口：`npm test` 会先跑 `build`（`tsc` + copy assets），再跑 `test:fast`（含 `check`），最后跑 `test:smoke`：
  - `tests/runtime/*`：turn-orchestrator、agent-tool-bridge、pi-runtime、agent-chat-tools
  - `tests/storage/*`：chat-store、run-store（含迁移验证）
  - `tests/http/*`：request-body
  - `tests/smoke/*`：server-smoke（启动真实 server + fetch 验证 API/静态资源基本流）

结论：你的项目已经具备“最小可用的测试骨架”，缺的是一套**明确的分层策略、跑哪些、何时跑、失败怎么处理、以及后续新增功能应该补哪些测试**的约定。

---

## 2. 护栏总体策略：分层 + 分频（快/慢分开）

把所有验证拆成 3 层闸门，从“最便宜”到“最接近真实环境”，让开发体验和可靠性兼得：

### Gate A（必跑/最快）：静态与一致性检查

目的：秒级发现“AI 最常引入”的低级错误（语法、拼写、漏导出、require 循环导致的解析异常等）。

- 命令：`npm run check`
- 触发时机：
  - 每次让 AI 生成/修改代码后（本地）
  - CI 的每次 push/PR

### Gate B（必跑/快）：确定性测试（不依赖真实 server、不依赖外网）

目的：在不引入 flaky 的前提下，把核心业务逻辑的回归挡住；这层应该 10s~30s 内完成（视机器而定）。

建议覆盖重点：
- `server/domain/conversation/mention-routing.ts`：提取 mentions、`#ideate/#execute` 模式、边界字符/换行规则
- `server/domain/conversation/turn/*`：turn state 变更、stop、routing executor 的队列/并发批次逻辑、decision 解析
- `lib/chat-app-store.ts` / `lib/sqlite-store.ts`：迁移与写入一致性（你已有不错的覆盖）
- `server/http/*`：请求体、错误码、路由匹配（尽量用“假 req/res”或直接调用 controller.handle）

现状：你已经有不少 Gate B 的测试文件了；后续新增功能要坚持把大多数回归挡在这里。

### Gate C（必跑/慢）：启动真实进程的 smoke / E2E-ish

目的：在接近真实环境下验证最关键链路（启动 server、静态资源、核心 API 流程），抓住“跨模块集成错误”。

- 当前已有：`tests/smoke/server-smoke.test.js`（非常适合作为 Gate C 的核心）
- 建议补充：SSE 事件（`runtime_state` / `conversation_summary_updated`）的最小验证、关键 API 失败路径（400/409/404）回归用例。

触发时机：
- 本地：准备合入前/一天一次/或你觉得变更涉及“链路”时
- CI：每次 PR 都跑（这是最有效的“AI 防回归”）

---

## 3. 对“AI 额外引入 bug”最有效的规则（可写进你的开发规范）

1) **任何 bug fix 必须带回归测试**  
先在 `tests/` 里复现失败（红），再修代码（绿）。这条规则是长期可靠性的核心。

2) **新功能至少补 1 个 Gate B 测试 + 1 个 Gate C 覆盖点（若影响链路）**  
例如改了 turn routing：补 `tests/runtime/turn-orchestrator.test.js` 或新增 `tests/runtime/routing-executor.test.js`；如果改了 API：补 `tests/smoke/server-smoke.test.js` 的流程或加一条新的 smoke 用例。

3) **测试写法优先“确定性”**  
强烈建议统一以下模式（你现有测试里已经在用）：
- 用临时目录 + 临时 sqlite：`fs.mkdtempSync(os.tmpdir())`
- 所有资源在 `t.after(...)` 里清理（`rmSync({ recursive: true, force: true })`）
- 端口用 `listen(0)` 获取空闲端口
- 不依赖真实时间：对时间敏感的逻辑用可注入 `now()` 或固定 `createdAt`

4) **对外边界（HTTP/API、DB schema、事件名）用“契约”约束**  
契约不一定要上 Schema 工具，最低成本做法：在 smoke test 里断言关键字段/结构与错误码。

---

## 4. 针对本项目的“补测清单”（建议按风险优先级排期）

### P0（最值回票价：编排/路由/停止）

- `server/domain/conversation/mention-routing.ts`
  - mention 边界字符：`(@Agent)`、`@Agent,`、`email@example.com`、中文标点、代码块 ``` ``` 内不路由
  - `#execute/#ideate` 与多 agent 的 mode 组合（serial/parallel）与 cleanedText
- `server/domain/conversation/turn/routing-executor.ts`
  - 409：并发 turn（`activeConversationIds`）防重入
  - “首轮并发 + 后续 handoff 串行”的关键状态转移
  - 并发 fan-out 批次上限（`MAX_PARALLEL_MENTION_BATCH_SIZE = 5`）的排队行为
- `server/domain/conversation/turn/turn-stop.ts`
  - stop 之后不再接受 tool bridge late writes（你已有一部分覆盖，但可以补“队列阶段清空 + stage 状态一致性”）

### P1（HTTP 合约与错误码）

- `server/api/*` controllers：
  - 400/404/409 错误码保持一致（例如 conversations 不存在、内容为空、重复 turn）
  - POST body 的必填字段校验（利用 `tests/http/request-body.test.js` 的模式扩展）
- `server/http/static-file.ts`：路径穿越防护（若存在）、content-type

### P2（数据一致性与迁移回归）

- `lib/chat-app-store.ts` / `storage/sqlite/migrations.ts`
  - 新增字段/表时：必须加“旧库迁移 + 历史数据保留”的测试（你已有很好的模板：`tests/storage/chat-store.test.js`、`tests/storage/run-store.test.js`）

---

## 5. 推荐的执行流程（让“每次开发后自动验证一轮”真正落地）

### 本地开发（你/AI 每次改完就跑）

- 快速自检（几乎无成本）：`npm run check`
- 变更涉及业务逻辑：跑对应的 Gate B 测试文件（按需挑 1~3 个），最后再跑全量 `npm test`

### CI（强制闸门）

如果你用 GitHub，建议加一条 workflow（示意）：

```yaml
name: test
on:
  push:
  pull_request:
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
```

如果你希望 smoke/spawn 类测试在 CI “必须跑而不是 skip”，可以约定一个环境变量（例如 `CAFF_REQUIRE_SPAWN=1`），在相关测试里遇到不允许 spawn 时直接失败（这需要后续改一下测试代码）。

---

## 6. 维护准则：如何处理 flaky / 漏测 / 失败

- 禁止“为了合入而 skip 测试”。正确做法是：
  - 把 flaky 根因定位成：时间/并发/端口/资源回收/随机性，并改成确定性；
  - 或把慢测试下沉到 Gate C，但 Gate B 必须可靠。
- 每次线上/回归事故都要沉淀为一个最小复现测试（Gate B 优先，必要时 Gate C）。

---

## 7. 下一步我建议怎么做

如果你愿意，我可以在你确认后直接在代码里落地两件“护栏增强”（改动很小、收益很大）：

1) 把测试分成 `test:fast` 与 `test:smoke` 两个 npm scripts（CI 跑全量，本地常跑 fast）。  
2) 抽一个 `tests/helpers/*`，把 `withTempDir`、`canSpawnProcess` 这类重复逻辑统一，降低新增测试的成本。

✅ 已落地（2026-03-26）：

- `package.json`：新增 `test:fast` / `test:smoke`，`npm test` 默认跑全量（fast + smoke）。
- `tests/helpers/temp-dir.js`：统一 `withTempDir`。
- `tests/helpers/spawn.js`：统一 spawn 可用性检测；设置 `CAFF_REQUIRE_SPAWN=1` 时，spawn 不可用将直接失败（不再 skip）。
