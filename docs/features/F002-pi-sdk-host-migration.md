---
feature_ids: [F002]
related_features: []
topics: [runtime, pi, sdk, ipc, sessions]
doc_kind: spec
created: 2026-07-28
---

# F002: Pi Runtime CLI → SDK Host Migration

> Status: active | Owner: @cat-ir4rwo6b

## Why

CAFF 的主 Agent runtime 当前通过 spawn 全局 `pi` CLI（`pi --mode json --print`）+
解析 JSONL stdout 来驱动 agent 执行。这条路径有三个根因级不确定性：

1. **版本漂移**：`pi-cli-spawn.ts` 硬编码 `@mariozechner/pi-coding-agent` 路径
   去找全局 shim 目录下的 CLI（`0.73.1`），而系统 `pi` shim 实际指向
   `@earendil-works/pi-coding-agent@0.80.10`——两个不同包族、两个不同版本，
   CAFF 无法控制实际跑的是哪个。
2. **环境脆弱**：依赖 PATH 解析、npm 全局 shim、shell 包装层（PowerShell .ps1 /
   .cmd）、Windows 进程编码问题，每一层都可能引入 framing 或编码 bug。
3. **退出分类模糊**：子进程退出码/信号的语义由 CLI 自己定义，CAFF 无法精确
   区分 expected completion / heartbeat timeout / crash / cancel。

迁移到精确锁定的 `@earendil-works/pi-coding-agent` SDK host 后，CAFF 用
`package.json` 依赖锁定版本，用 `child_process.fork()` 的 Node IPC channel
传输结构化命令和事件，用 `session.abort()` 做干净终止，同时保留独立进程的
故障隔离。

## Current State / 现状基线

- `lib/pi-runtime.ts`（1148 行）自管 spawn、JSONL 解析、heartbeat、completion
  检测、Windows 进程树终止（`taskkill /T /F`）。
- `lib/pi-cli-spawn.ts`（27 行）`tryCreateDirectPiNodeSpawnSpec()` 硬编码
  `node_modules/@mariozechner/pi-coding-agent/dist/cli.js` 路径，在 shim 目录
  下找 `0.73.1` 的 CLI 直接用 node 执行，绕过 shim 指向的 `0.80.10`。
- `lib/pi-prompt-transport.ts`（12 行）pipe stdin 传入 prompt。
- `lib/minimal-pi.ts`（227 行）re-export `startRun` + CLI 入口。
- `startRun()` 被 `agent-executor.ts:1518`（主聊天）、`eval-cases-controller.ts:923`、
  `skill-test-controller.ts:1857`、`conversation-digest.ts:1481` 等广泛调用。
- `tests/runtime/pi-runtime.test.js`（455 行）用 fake pi shim 测试 7 个场景。
- `@earendil-works/pi-coding-agent@0.80.10` 是 ESM-only（`"type": "module"`），
  CAFF 是 CommonJS（`"type": "commonjs"`）→ 不能直接 `require()`，需要
  独立 Node 进程用 dynamic `import()` 加载。
- 该 SDK 声明 `node >=22.19.0`；Node 20.19.4 实测在依赖 `undici` 初始化时
  因 `webidl.util.markAsUncloneable` 缺失而无法导入。
- SDK 导出 `AgentSession`（`subscribe`/`prompt`/`abort`/`getSessionStats`）、
  `AgentSessionRuntime`、`SessionManager`、`createAgentSession()`、
  `runPrintMode(runtime, { mode: "json" })`。
- `AgentEvent` 类型联合（`agent_start`/`agent_end`/`message_update`/
  `message_end`/`turn_start`/`turn_end`/`tool_execution_start`）与 CLI
  `--mode json --print` 的 JSONL 输出格式同源。

## What

把 `lib/pi-runtime.ts` 的 spawn 目标从全局 `pi` CLI 改为 CAFF 自管的
Node SDK host 进程（`lib/pi-sdk-host.mjs`）。SDK host 用 ESM `import()` 加载
精确锁定的 `@earendil-works/pi-coding-agent`，通过 `createAgentSessionRuntime()`
创建 runtime，在 prompt 前调用 `session.bindExtensions()`，用 `session.subscribe()`
监听 typed event 并经 Node IPC 发送结构化对象。终止时先 `session.abort()`，再由
`AgentSessionRuntime.dispose()` 发出 `session_shutdown` 并释放会话。CAFF
主进程的 `pi-runtime.ts` 保持现有 `startRun()` 签名、事件契约和结果对象不变。

## User Journey

`user_journey_exempt`: 本 Feature 是内部 runtime 迁移，不新增或改变用户操作步骤；
用户可感知结果是 Agent run 不再受全局 Pi 安装、shim 与版本漂移影响。

## Requirements Checklist

- [x] 默认生产路径不依赖 PATH、全局 npm shim 或全局 Pi 包目录。
- [x] CAFF 与 host 之间使用 Node IPC 结构化对象，不解析 JSONL stdout。
- [x] `startRun()` 调用方契约保持不变。
- [x] session/resume、extensions、usage、abort/timeout、crash 均有回归测试。
- [x] 项目、host preflight 与 OpenSandbox 默认镜像统一要求 Node >=22.19。
- [x] 运行中不自动 fallback 到 CLI。
- [x] 完整质量门禁、跨个体 review 与合入证据齐全。

## Acceptance Criteria

### AC-A1: 事件契约保持
`startRun(provider, model, prompt, options)` 的签名和返回的 handle
（`on`/`cancel`/`complete`/`resultPromise`）不变。所有现有事件
（`run_started`/`assistant_text_delta`/`assistant_message`/`heartbeat`/
`stderr`/`run_succeeded`/`run_failed`/`run_terminating`/`pi_event`/
`stdout_parse_error`/`storage_warning`/`assistant_error`）保持发射。
现有调用方（`agent-executor.ts` 等）无需修改。
**验证**：`tests/runtime/pi-runtime.test.js` 全部通过 + typecheck 通过。

### AC-A2: Session/Resume 保持
`options.session`（named session path）和 `options.resume`（continue
latest session）行为不变。SDK host 通过 `SessionManager` 与
`createAgentSessionRuntime({ sessionManager })` 映射到 SDK 的 session 机制。
**验证**：`tests/runtime/pi-runtime.test.js` 覆盖 IPC 配置传输，
`tests/runtime/pi-sdk-host.test.js` 覆盖 named session、continue recent 与 fresh session。

### AC-A3: Tool lifecycle 保持
`options.extensionPaths` / `options.extensions` 传递到 SDK host，
SDK host 通过 `createAgentSessionServices()` 加载资源，并在 prompt 前执行
`session.bindExtensions()`。正常完成与 abort 都由 `AgentSessionRuntime.dispose()`
触发 `session_shutdown`；extension command context 具备 wait/new/fork/navigate/switch/reload
动作。`options.cwd` 作为 runtime 的有效 cwd。
**验证**：runtime 测试覆盖 cwd + extensions 的 IPC 传递；host 测试覆盖
services/runtime 映射、bind-before-prompt 与 abort-before-runtime-dispose；真实 pinned SDK
dogfood 记录 `start:startup` 和 `shutdown:quit`。

### AC-A4: Usage 聚合保持
`result.usage` 和 `result.usageCalls` 的聚合逻辑不变——多个 assistant
model call 的 usage 不重复计算 `agent_end` 的 messages。
**验证**：现有 "aggregates usage across assistant model calls" 测试通过。

### AC-A5: Abort/Timeout 保持
`handle.cancel(reason)` 和 `handle.complete(reason)` 先通过 IPC 请求 host 调用
`session.abort()`，随后 `AgentSessionRuntime.dispose()`；grace period 后才强制终止
进程树。Heartbeat timeout 走同一
abort 协议；Windows `taskkill /T` 保留为兜底。
**验证**：terminal completion、external completion、explicit cancel 与 heartbeat
timeout 测试通过；host 单测证明 `abort()` 先于 `dispose()`。

### AC-A6: Host crash 恢复
SDK host 进程崩溃（非零退出/信号）时，`pi-runtime.ts` emit
`run_failed` 并 reject `resultPromise`，错误对象包含 `exitCode`/`signal`/
`stderrTail`/`reply`。
**验证**：新增测试：fake SDK host 非零退出 → run_failed。

### AC-A7: 版本锁定回归
`package.json` 精确锁定 `@earendil-works/pi-coding-agent` 版本（无 `^`）。
不再依赖 `@mariozechner/pi-coding-agent` 路径；旧 `pi-cli-spawn.ts`、
`pi-prompt-transport.ts` 与 `pi-heartbeat-extension.mjs` 删除。
`package.json.engines.node` 与 host preflight 均要求 `>=22.19.0`；OpenSandbox 默认镜像
与文档统一为 `node:22-bookworm`。
**验证**：grep 确认主 runtime 无 CLI/shim/prompt-stdin/JSONL parser 路径，
package.json 版本无 `^`，Node 20 残留扫描为空。

### AC-A8: 全量测试通过
`npm run build` + `npm run typecheck` + `tests/runtime/pi-runtime.test.js`
全部通过。不引入新的 TypeScript 编译错误。
**验证**：命令输出。

## OQ 答案

### OQ1: 当前真实 integration base
从 `origin/main`（HEAD `968e7e5`）创建 `feat/pi-sdk-host` worktree。
本地 main behind origin/main 8 个 commit（已合入的 feature PR），所以
从 origin/main 开工。基线测试 7/7 通过。

### OQ2: AgentSessionRuntime/SessionManager 与 CAFF 映射
- `createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager })` 持有 runtime；
  factory 内通过 `createAgentSessionServices()`、model resolution 与
  `createAgentSessionFromServices()` 替代 CLI
  `--provider/--model/--thinking/--session/--continue` 参数。
- `SessionManager` 管理 session 文件路径和 resume。
- CAFF 现有 `resolveSessionPath(session, agentDir)` 逻辑可以传递给 SDK host，
  SDK host 用 `SessionManager` 或直接用 session 文件路径。
- Provider/model 通过 `ModelRuntime` / `ModelRegistry` 解析，或通过
  SDK 的 settings 机制。

### OQ3: SDK typed event 到现有契约的无损映射
SDK `AgentEvent` 与 CLI JSONL 同源：
- `message_update` + `assistantMessageEvent.type === "text_delta"` →
  `assistant_text_delta`（完全相同）
- `message_end` → `assistant_message` + usage recording（完全相同）
- `agent_end` → completion detection（完全相同）
- `tool_execution_start` / `turn_start` / `turn_end` → 转发为 `pi_event`
  （和 CLI 相同）

映射是 1:1 的；原 `rl.on('line')` JSONL 解析已删除，IPC message handler 直接
消费 typed event 对象。

### OQ4: SDK host 崩溃/IPC 断开/abort/timeout/restart 恢复
- Host crash：进程 `close` 事件 + 非零退出码 → `run_failed`（和 CLI 相同）
- IPC 断开：host 的 `disconnect` / `close` 事件 → 按 terminationReason 与退出状态分类；
  非预期断开进入 `run_failed` 并保留 `exitCode` / `signal` / `stderrTail` 诊断。
- Abort：CAFF 发送结构化 `{ type: "abort", reason }` IPC 命令 → SDK host
  `session.abort()` + `dispose()` → grace period 后仍未退出才强制终止进程树。
- Timeout：heartbeat 超时走同一 IPC abort 协议；仅在 host 无响应时兜底
  `terminateProcessTree`。
- Restart：不支持执行中自动 restart；prompt 已接受或工具已执行后重启可能重复副作用，
  仅允许上层在确认干净 abort 后显式重试。

### OQ5: ESM-only SDK 在 CommonJS 构建中的加载边界
SDK 是 ESM-only，且要求 Node >=22.19；CAFF 是 CommonJS。解决方案：项目 engines、
host preflight 与 sandbox 默认镜像统一该最低版本，并 spawn 独立 Node 进程
（`lib/pi-sdk-host.mjs`，`.mjs` 扩展名强制 ESM），进程内用 `import()` 加载
SDK。CAFF 主进程不直接加载 SDK，通过 `fork()` 创建的 Node IPC channel
通信。这保持了故障隔离，且不需要改变 CAFF 的模块系统。

## Fresh-Context Finding Resolution

- **FC-1 Node runtime contract**：Node 20.19.4 真实导入失败。通过 `engines.node`、host
  preflight、README、`.env.example`、OpenSandbox factory/build image 全面统一到
  Node >=22.19；Red→Green 覆盖 package contract 与默认镜像。
- **FC-2 extension lifecycle**：原实现只创建 `AgentSession`，遗漏 mode 层负责的
  `bindExtensions`/`session_shutdown`。改为 `AgentSessionRuntime` + 官方 print-mode 等价
  bindings/dispose；真实 extension dogfood 观察到 startup/quit 生命周期。
- 根因与回归证据见
  `docs/bug-report/pi-sdk-host-fresh-context-findings/bug-report.md`。

## Timeline

| Date | Event |
| --- | --- |
| 2026-07-28 | Implementation merged via PR #49 (`6e6af44`); feature HEAD `533f0e1` passed independent peer review, cloud review, CI, and the full local quality gate. |

## Architecture

- Architecture cell: `lib/pi-runtime.ts` runtime ownership cell
- Map delta: none
- Why: host 进程替换同一 runtime 边界内的 CLI adapter，不改变调用方归属。

## Links

- [Trellis Task Archive](../../.trellis/tasks/archive/2026-07/07-28-f002-pi-sdk-host-migration/prd.md)
- [Smoke Fixture Regression](../bug-report/pi-sdk-host-smoke-fixture/bug-report.md)

## Tips Contribution

`tips_exempt`: 内部 runtime 迁移，无新增用户工作流或可操作配置入口。

## Hard Boundaries

- 精确锁版本，不使用 `^`，只保留 `@earendil-works/pi-coding-agent` 一个
  pi-coding-agent 包族作为 runtime 单一真相源。
- 禁止执行中自动 fallback 到 CLI；仅允许 preflight 失败前选路，或
  干净 abort 后由上层显式重试。
- 使用隔离 dev/test 数据；不得读取生产用户会话。
- 走完整 quality-gate → request-review → receive-review → merge-gate；
  作者不得自审。
- 保持 `@mariozechner/pi-ai` 依赖（被 `conversation-digest.ts` 用于
  digest 模型调用，不在本次迁移 scope 内）。

## Non-goals

- 不迁移 `conversation-digest.ts` 的 `@mariozechner/pi-ai` 使用到
  `@earendil-works/pi-ai`（独立任务）。
- 不改变 CAFF 的 CommonJS 模块系统。
- 不把 SDK 直接嵌入 CAFF API 进程（保持进程隔离）。
- 不修改聊天存储评测 spec（与本任务无关）。
