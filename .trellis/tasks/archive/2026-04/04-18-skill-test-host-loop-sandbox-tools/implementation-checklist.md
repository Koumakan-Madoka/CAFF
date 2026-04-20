# Implementation Checklist: 04-18-skill-test-host-loop-sandbox-tools

## 一句话目标

把 `skill-test` 默认执行路径收敛成：**host 保留 agent loop / 编排 / 日志 / chat bridge / 结果汇总，sandbox 只负责 case world 与 `read` / `write` / `edit` / `bash` / 子进程副作用。**

## 目标状态

### 最终职责边界

- **host**：`executeRun()`、`startRunImpl`、`runStore`、SSE/live event、chat bridge auth、评测与结果落库
- **sandbox**：case world 文件系统、cwd 视角、shell/子进程执行、副作用落点、路径回显语义
- **agent 感知**：看到的是 sandbox 的 `cwd` / `projectDir` / `skill path` / tool 输出，而不是 host 真实路径

### 默认语义

- 默认不再依赖 `open-sandbox-runner.js` 在 sandbox 内启动完整 PI CLI
- 默认不再把 `adapter.startRun()` 作为 skill-test 的主执行链
- 默认仍保留 OpenSandbox case world，但它是 **tool sandbox / world adapter**，不是默认的 **remote agent loop runtime**

## 先做的 1 个 Spike（必须先证伪/证实）

在正式大改前，先验证 **host 上跑的 PI CLI 能否把 `read` / `write` / `edit` / `bash` 定向到 sandbox adapter**。

建议最小验证：

- host `startRunImpl` 能接受显式 `cwd`
- 先只验证 `read` + `bash` 两类入口，不一上来铺满四个工具
- skill-test 模式下，agent 发出的 `read` / `bash` 不再直接命中 host 本地 repo
- 至少一条 `read SKILL.md` 和一条 `bash pwd` 能返回 sandbox 视角结果
- Spike 里要留下“确实命中 adapter”的可断言证据，避免出现一半还在 host 跑的双轨工具

如果这个 Spike 失败，**不要回滚到 full-sandbox 默认路径**；而是直接进入“skill-test 专用 tool shim / extension”方案，把原生 file/bash 工具在该模式下隐藏或覆盖。

## 推荐实现顺序

### Phase 0：先锁死新合同，再动代码

目标：把“loop 在 host、tools 在 sandbox”的语义写清楚，避免后面继续被旧的 `execution.runtime === 'sandbox'` 约束卡住。

必须修改：

- `server/domain/skill-test/isolation.ts`
  - 把当前偏向 full-sandbox 的 execution evidence 改成能表达：
    - loop runtime
    - tool runtime
    - path/cwd view
    - case world location
  - 不再把“没有 `adapter.startRun`”直接等价成“隔离失败”
- `server/api/skill-test-controller.ts`
  - 不再用 `typeof isolationContext.startRun === 'function'` 作为主分支判定
  - live progress 文案区分“host loop 正在运行”与“sandbox tools 已接管”
- `.trellis/spec/skills/skill-testing.md`
  - 更新 skill-test isolation contract，明确默认 execution mode 已变成 `host-loop + sandbox-tools`
- `.trellis/spec/runtime/agent-runtime.md`
  - 如果 runtime `cwd` / tool routing / path masking 合同变化，需要同步

建议新增字段（命名可再收敛，但语义要明确）：

- `execution.loopRuntime = 'host' | 'sandbox'`
- `execution.toolRuntime = 'host' | 'sandbox'`
- `execution.pathSemantics = 'host' | 'sandbox'`
- `execution.preparedOnly` 仅保留给 compat/debug，不再作为默认语义核心

旧字段处理建议：

- `execution.runtime` 降级为兼容读旧 run 的投影字段，不再承载默认语义判断
- `execution.adapterStartRun` 退出核心合同，不再作为 controller 主分支依据

Phase 0 验收：

- 不改功能时，旧 run detail 也能被新 evidence 结构兼容读取
- publish-gate / unsafe 判定改看 `toolRuntime + pathSemantics`，不再错误依赖“loop 必须在 sandbox”

### Phase 1：把 controller 收敛到单一 host-loop 主路径

目标：`executeRun()` 永远由 host 侧 `startRunImpl` 驱动；OpenSandbox 只产出 case context / tool adapter / evidence。

必须修改：

- `server/api/skill-test-controller.ts`
  - `startSkillTestRun` 默认固定为 `startRunImpl`
  - `isolationContext.startRun` 从主路径移除，不再作为默认分支
  - judge runs 继续复用 case-scoped `agentDir` / `sqlitePath` / `projectDir` / `extraEnv`
  - 保持现有 `runStore`、`broadcastSkillTestRunEvent()`、`broadcastSkillTestToolEvent()`、结果落库链路都在 host
- `server/domain/skill-test/isolation.ts`
  - `createCaseContext()` 返回 sandbox case world + tool policy + extra env + tool adapter
  - 不再把 adapter 是否带 `startRun` 当成 controller 是否走 isolated 的关键接口

建议保留的兼容窗口：

- 短期可以暂时保留 `adapter.startRun` 字段，但 controller 不再消费它
- 待回归稳定后，再删 compat 分支和相关测试

Phase 1 验收：

- OpenSandbox 已开启时，`executeRun()` 仍由 host 的 `startRunImpl` 启动
- live event / chat bridge / result aggregation 不退回 sandbox
- judge run 仍使用 case-scoped store，不回落到 live store

### Phase 2：定义最小 adapter，紧接着和 Phase 3 一起证伪

目标：先把 OpenSandbox factory 裁成“case world + 最小 tool proxy adapter”，不要先把接口设计胖；Phase 2 的接口定义完后，立刻由 Phase 3 Spike 消费验证。

必须修改：

- `server/domain/skill-test/open-sandbox-factory.ts`
  - 默认不再上传/依赖：
    - `open-sandbox-runner.js`
    - remote `pi-coding-agent` CLI
  - `remote agent-chat-tools.js` 是否继续需要，取决于 Spike 后 `bash` 内聊天桥方案；不要先武断删掉再把桥打断
  - 保留：
    - case world 创建
    - project/agent/sqlite/materialization
    - remote 文件读写
    - remote 命令执行
    - cleanup
    - host↔sandbox 路径映射
  - 返回值从“可能执行 remote PI run”收敛成“提供 sandbox tool adapter / resources / evidence”
- `server/domain/skill-test/isolation.ts`
  - 把 adapter 能力标准化为更适合 host-loop 的接口，例如：
    - `files.read(path)`
    - `files.write(path, content)`
    - `files.edit(path, edits)`
    - `commands.run(command, options)`
    - `mapPathToSandbox()` / `mapPathFromSandbox()`

建议新增：

- `server/domain/skill-test/sandbox-tool-adapter.ts`
  - 统一 adapter shape，隔离 `open-sandbox-factory.ts` 的细节
  - 初版顺手承接路径映射、错误文本路径替换、cwd/path 显示逻辑；等逻辑膨胀后再拆独立 `path-view.ts`
  - 及早固定一套虚拟根，例如 `/case/project/...`、`/case/agent/...`，供 prompt / trace / env / tool 结果统一映射

Phase 2 验收：

- 默认 isolated run 不再需要 remote runner asset
- 默认 isolated run 不再上传整套 PI CLI 到 OpenSandbox
- OpenSandbox adapter 仍能准备/清理 per-case remote world

### Phase 3：让 host PI runtime 真正使用 sandbox tools

目标：紧接着消费 Phase 2 的最小 adapter，先用 `read + bash` Spike 证实路径、cwd 与工具路由真的落进 sandbox，再补全 `write/edit`。

必须修改：

- `lib/pi-runtime.ts`
  - 给 `startRun()` / `invoke()` 增加显式 `cwd` 选项，不能再硬编码 `process.cwd()`
  - `runStore.startRun()` 记录的 `cwd` 改成 runtime 传入值
  - `spawn(...)` 的 `cwd` 改成显式 runtime cwd
- `server/api/skill-test-controller.ts`
  - skill-test run 调 `startRunImpl()` 时传入：
    - `cwd: projectDir`
    - sandbox tool adapter 所需 env
    - sandbox visible path root
    - 现有 bridge auth env
- `lib/pi-runtime.ts` 或 skill-test 专用 runtime extension/shim
  - 在 skill-test 隔离模式下，把 `read` / `write` / `edit` / `bash` / 子进程能力重定向到 sandbox adapter
  - 保证 agent 看不到一套 host 原生 file/bash 工具和一套 sandbox 工具并存的双轨状态

强约束：

- `bash` 中的 `cwd` 必须等于 sandbox project root 视角
- `read` / `write` / `edit` 只能访问 sandbox case world
- 任意 spawn/子进程也必须走 sandbox adapter，不能留 host 漏口
- `agent-tool-bridge` / `toolPolicy` 要和新工具路由同步，不然 telemetry / reject 记录会和真实执行脱节

如果 PI CLI 原生工具无法被透明重定向：

- 就实现 **skill-test 专用 tool shim**，并在该模式下关闭/遮蔽原生 file/bash 工具
- 这仍然比“整 loop 再塞回 sandbox”更符合本任务目标

Phase 3 验收：

- 一条 `read` 只读取 sandbox world 中文件
- 一条 `write` / `edit` 只修改 sandbox world
- 一条 `bash` 只在 sandbox 中执行，`pwd` / 相对路径 / 输出路径都符合 sandbox 视角

### Phase 4：把 prompt / cwd / trace / 错误输出统一成 sandbox 视角

目标：agent 与前端看到的都是同一套 sandbox 语义，不出现 host/sandbox 混杂，也不出现“本地 case snapshot 与 remote case world 各说各话”。

必须修改：

- `server/domain/conversation/turn/agent-prompt.ts`
  - skill-test prompt 中出现的 `PI_AGENT_SANDBOX_DIR`、`PI_AGENT_PRIVATE_DIR`、project path 提示要和 sandbox 视角一致
- `server/domain/runtime/message-tool-trace.ts`
  - session tool / bridge tool trace 的 requestSummary、partialJson、error message 做路径映射与脱敏
- `server/api/skill-test-controller.ts`
  - live `progressLabel` / `executionRuntime` / terminal trace 字段要表达新合同
- `server/domain/skill-test/path-view.ts`（建议新增）
  - 把 stdout/stderr/error/path 回显统一做映射

重点检查：

- `CAFF_TRELLIS_PROJECT_DIR`
- `PI_AGENT_SANDBOX_DIR`
- `PI_AGENT_PRIVATE_DIR`
- `CAFF_SKILL_TEST_SKILL_PATH`
- trace 里的 `arguments.path`
- `bash` stderr / stdout 中回显的路径
- host-loop spawn 的 `cwd` 与污染检查，确保副作用不会偷偷写回 live project

Phase 4 验收：

- agent prompt 不再泄露 host 真路径
- live trace 不再把 host caseRoot / tempDir 直接回显给 agent/frontend
- dynamic `read SKILL.md` 识别仍能命中目标 skill path

### Phase 5：删除 full-sandbox 默认分支并收尾

目标：默认模式只剩一条主执行链，避免之后继续分叉维护。

建议修改：

- `server/domain/skill-test/open-sandbox-factory.ts`
  - 将 remote runner / remote PI CLI 逻辑降级为 compat 或直接删除
- `tests/runtime/open-sandbox-factory.test.js`
  - 默认测试从“`startRun` 执行 remote PI”改成“adapter 提供 case world + tool proxy”
- `tests/skill-test/skill-test-e2e.test.js`
  - 默认 isolated run 断言改成 host-loop+sandbox-tools 语义
- `.trellis/spec/skills/skill-testing.md`
  - 删除/降级 full-sandbox 默认表述

如果你想完全一刀切：

- 不保留默认 `full-sandbox` 模式入口
- 只保留极少量隐藏 compat code，且不进 prompt / UI / 默认配置

Phase 5 验收：

- 默认 skill-test 已没有“remote PI runner”依赖
- 新人只需要理解一条执行链
- 旧 `preparedOnly` / `adapterStartRun` 语义不再主导默认行为

## 推荐改文件清单

### 核心后端

- `server/api/skill-test-controller.ts`
  - 主 orchestrator；默认 host-loop 切换的第一入口
- `server/domain/skill-test/isolation.ts`
  - case context、evidence、tool policy、unsafe/publish-gate 语义
- `server/domain/skill-test/open-sandbox-factory.ts`
  - 从 full-sandbox runner factory 收敛成 case world + tool proxy factory
- `server/domain/runtime/agent-tool-bridge.ts`
  - 继续保留 host 侧 bridge/auth/telemetry，不要被挪进 sandbox
- `server/domain/runtime/message-tool-trace.ts`
  - 路径映射、脱敏、session/bridge trace 合并

### 运行时

- `lib/pi-runtime.ts`
  - 新增显式 `cwd`；承接 skill-test sandbox tool shim / extension
- `lib/minimal-pi.ts`
  - 如 CLI 层要透传 `cwd` / skill-test runtime mode，这里同步
- `server/domain/conversation/turn/agent-prompt.ts`
  - path/cwd/tool guidance 的 sandbox 视角收口

### 建议新增模块

- `server/domain/skill-test/sandbox-tool-adapter.ts`
- `lib/pi-skill-test-sandbox-extension.mjs` 或等价 skill-test runtime shim
- `server/domain/skill-test/path-view.ts`（如 `sandbox-tool-adapter.ts` 中的路径映射逻辑后续膨胀再拆）

### 规格/任务文档

- `.trellis/spec/skills/skill-testing.md`
- `.trellis/spec/runtime/agent-runtime.md`
- `.trellis/tasks/04-18-skill-test-host-loop-sandbox-tools/prd.md`
- `.trellis/tasks/04-18-skill-test-host-loop-sandbox-tools/implementation-checklist.md`

## 最关键的回归用例

### 合同回归

- host-loop isolated run：`loopRuntime=host`，但 `toolRuntime/pathSemantics=sandbox`
- judge runs 复用 case-scoped `agentDir` / `sqlitePath` / `projectDir`
- live event / result aggregation / chat bridge 继续在 host

### 工具语义回归

- `read` 读 sandbox 中 `SKILL.md`
- `write` / `edit` 不污染 host live project
- `bash` 的 `pwd` / 相对路径 / 写文件都只落在 sandbox case world
- 任意工具错误中的路径已被映射，不直接暴露 host temp path

### 清理/污染回归

- run 完成后 case world 被清理
- pollution check 仍能发现错误落到 live project 的回归
- bridge auth scope / token TTL / toolPolicy reject 继续工作

### 兼容回归

- dynamic trigger 检测仍能识别目标 skill load
- full-mode judge 不因 cwd/pathSemantics 改动而读错 project context
- `evaluation_json` / `result.trace` / UI detail 结构不被破坏

## 测试建议顺序

先跑最窄的，再逐步放大：

```bash
node --test tests/runtime/pi-runtime.test.js
node --test tests/runtime/open-sandbox-factory.test.js
node --test tests/runtime/agent-tool-bridge.test.js
node --test tests/runtime/message-tool-trace.test.js
node --test tests/skill-test/skill-test-e2e.test.js
npm run build
```

如果有 spec 更新，再补：

```bash
node --test tests/runtime/skill-loading.test.js
```

## 明确不在这次任务里顺手做的事

- 不把 chat bridge / result aggregation 再迁回 sandbox
- 不做完整网络隔离强化
- 不扩 skill-test UI 新功能
- 不为了保留高保真场景再维护第二套默认执行链

## 我建议的实际开工顺序

1. 先做 Phase 0，把 evidence / acceptance contract 改正
2. 再做 Phase 1，把 controller 固定成 host-loop
3. 紧接着让 Phase 2/3 联动推进，先打通 `cwd + read/bash` sandbox 化 Spike
4. Spike 通了，再做完整适配与路径统一
5. 最后做 Phase 5，删默认 full-sandbox 分支和旧测试
