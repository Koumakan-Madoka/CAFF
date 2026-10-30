# CAFF

**Claude Code 负责规划，多模型 Agent 负责实现，验收证据说明结果：一个本地 AI 工程执行平台。**

CAFF（Conversational Agent Framework & Playground）基于 **Pi SDK** 构建。独立于实现者的规划者（目前是 Claude Code）拆解任务、编写 Goal、指派实现者，并按里程碑评审。GPT、GLM、Kimi、DeepSeek 等模型族的 Agent 在独立的 Git worktree 中按 Goal 实现，提交变更与验收证据。方向和关键授权始终在你手里。

CAFF 把执行过程中的关键问题放在一起：**谁在执行、改动在哪里、Goal 推进到哪一步、有哪些验收证据、哪些事在等你拍板。**

![Node.js](https://img.shields.io/badge/Node.js-22.19+-green?logo=node.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![License](https://img.shields.io/badge/License-MIT-yellow)

## 工作方式

| 角色 | 由谁担任 | 负责什么 |
| --- | --- | --- |
| 你 | 项目负责人 | 定方向；批准 Goal，以及目标、承诺决策、非目标和验收标准的变更；推送、合并、验收与发布 |
| 规划者 | 官方 Claude Code CLI，在用户终端或房间内嵌终端中运行 | 规划并编写 Goal，指派实现者，跟踪进度，在委托范围内裁决提案，按里程碑评审 |
| 实现者 | Room 里的模型族 Agent，如 GPT | 作为 Goal 负责人实现、记录证据、提出变更，不能裁决自己的提案 |

在规划者驱动的 Goal 里，只有规划者和你能裁决提案，其他 Agent 可以评审、提意见。每个模型族 Agent 以各自身份参与。消息流、工具调用、上下文快照与执行轨迹都可以查看，执行也可以随时停止。

哪些事规划者可以自己决定、哪些必须由你批准，以及后续的推进顺序，见 [ADR 0002](docs/decisions/0002-external-planner-drives-caff.md)。

> 本版本已实现 P1 规划者身份、写守卫、Goal 绑定与待处理队列，以及 P2 最小 `caff` CLI、默认开启（仅回环绑定）的房间内嵌终端和按房间开启、默认关闭的叫醒。规划者通过凭证文件以自己的身份操作，不冒充用户；高风险豁免、已关联 ADR 的承诺决策等仍有直接用户守卫。其他用户保留授权仍须规划者逐项取得，内嵌进程不是 OS 沙箱。结构化评审协议、规划者感知的实现者提示词和跨房间控制台属于 P3。实现/评审不等于已部署；见 [P1 接口](docs/engineering/backend/planner-interface.md)、[ADR 0003](docs/decisions/0003-embedded-claude-code-planner.md) 和 [P2 契约](docs/engineering/runtime/embedded-planner.md)。

## 为什么是 CAFF

### 1. Goal × 证据：让长任务不靠聊天记忆维持方向

Goal 是交付的依据：规划者把和你确认过的目标、决策和验收标准写进 Goal，实现者按它推进。CAFF 将工程约束、交付目标与执行依赖分别保留下来，减少长流程中的意图漂移。

| 层次 | 负责什么 |
| --- | --- |
| **持久工程规范** | `AGENTS.md`、项目 Skills、`docs/engineering/` 与已接受的 ADR 保存工程约束与长期决策 |
| **Session Goal** | 保存目标、决策、非目标、待决问题、工作项、验收标准与证据；符合条件时由 Goal Runner 持续推进 |
| **DAG** | 对复杂任务明确依赖、并行节点、分工与汇合，并通过 worker / verifier 协议核验节点结果 |

**用证据确认完成。** 工作项记录执行进度，验收标准记录交付是否达标。Goal 的通过项需要关联证据；完成前，验收标准必须全部通过或按规则获准豁免。

**谁能裁决提案。** 提议者不能裁决自己的提案。
- **规划者驱动的 Goal**：提案由规划者或你裁决。以下变更需要你批准：目标、承诺决策、非目标、验收标准，以及高风险豁免和变更已关联 ADR 的承诺决策。
- **其他 Goal**：沿用原规则，普通提案可由用户或另一参与 Agent 裁决。
- **DAG 子任务**：通常由不同于 worker 的 verifier 裁决完成提案；单 Agent 节点走调度器的显式核验豁免。

按任务复杂度选择 **Direct → Goal → DAG**：简单改动直接交付，长任务保留目标，有真实并行收益和依赖关系时再拆图。执行编排可以随任务演进，Room 的 Mode 保持固定。

### 2. Room × Git：把讨论与代码变更放在同一个边界内

Room 将讨论、参与者与任务工作区组织在一起。

- 创建 Room 时明确 Project、Mode 和参与者；Project 与 Mode 创建后固定。
- 开始修改前，先预览工作区，再由用户确认绑定。服务端从 Room 身份派生唯一的 `room/*` 分支和 worktree，普通 Room 以项目本地 `develop` 为基线。
- 不同任务拥有独立文件状态，Agent 在绑定的工作目录中执行；提交、差异和审查都能对应到具体任务，便于追踪与回滚。
- 验收记录绑定确切候选 SHA，不能用对旧版本的认可替代对新版本的验收。

> Git worktree 提供文件状态隔离；运行时安全沙箱需另行配置。端口、数据库、日志、凭据和外部副作用仍需单独隔离；未绑定 Room 也没有服务端强制只读锁。

### 3. Fresh Context First：先证明可以复用，再继续旧会话

长对话不能无限堆进模型上下文，也不应在历史已变化时盲目续跑。

CAFF 以新建 Session 作为安全回退路径：**当前版本默认开启复用检查，但只有校验通过才复用旧 Session**。

- 检查静态提示段哈希、历史与私聊游标、空闲时间、上下文占用率等条件；证据缺失、历史变异或状态异常时回退新 Session。
- Goal Runner 自动续跑额外核对 Goal 身份与版本，并要求上下文占用率严格低于 50%；普通复用阈值配置得更低时，采用更低阈值。
- 复用时只追加可见的增量消息；上下文检查器区分本轮实际输入与已保留的 Session 前缀。
- 对长对话生成摘要与五类结构化条目：**事实、决策、待解决问题、下一步、产物**，结合滚动汇总和保留预算，控制摘要进入提示词的体积。

Fresh 会在当前 Room 内新建模型运行 Session。结构化摘要帮助延续关键结论；压缩可能丢失细节，重要要求与交付证据应进入 Goal 或工程文档。

### 4. 多 Agent 协作能力：继续维护，不再扩展

下面这些能力来自 CAFF 作为多 Agent 协作工作台的阶段。按 ADR 0002，它们继续维护、供实现者使用，但不再新增功能；之后按使用数据决定是否保留。DAG 编排和飞书文本入口也一样。

- **显式路由**：通过 `@mention` 点名参与者，支持串行、并行交接，明确每一步由谁响应。
- **Room 内任务委派**：Agent 可以创建持久化委派，等待时释放执行槽位；接收方结束后，由运行时汇总结果并安排请求方继续。
- **跨 Room 投递**：工作需要交给另一个 Room 时，Agent 可以明确指定接收者，通过持久化状态与回执跟踪交接进展。
  - **精确寻址**：每条投递指定一个目标 Room 与其中一位 Agent；Agent 跨 Room 通信受同一非空 Project 作用域约束。
  - **先落库，后派发**：投递记录本身就是 durable outbox，幂等键在规定作用域内防止重复创建投递与目标消息。
  - **可恢复的生命周期**：重启后恢复持久化投递状态，尚未启动的任务可按策略重新入队；已启动但结果未知的执行不会自动重跑，避免重复副作用。
  - **迟到回复不触发重新执行**：迟到回复将响应状态标记为 `late` 并追加审计事件，不重新执行、不推翻已落库的派发（dispatch）结果。
  - **防循环保护**：检测重复链路并限制转发跳数；请求回复回源后默认不自动唤醒源 Agent，避免无限往返。

这些投递机制提供可追踪的交接与恢复边界，不承诺任意外部操作的 exactly-once 执行。

## 模型接入：从配置到协作

**在同一个界面完成模型接入、参数配置与 Agent 分配。** CAFF 将这些步骤集中在「角色与模型管理」中，让模型连接与协作身份各司其职。

### 可视化管理与模型目录导入

在 Web 界面维护 Provider 的地址、API 协议、认证方式和模型列表，既可以手动添加，也可以从 **models.dev 目录**搜索并选择导入。

目录支持在线刷新；导入前可查看来源与模型信息，确认后再写入本地配置。有效的上下文容量（`contextWindow`）和单次输出上限（`maxTokens`）随目录导入，后续也可调整，避免把两种限制混为一谈。

> 目录提供配置参考。实际调用还取决于 Pi 运行时、协议兼容性与账号权限，需单独验证。

### API Key 与订阅登录，两条接入路径

- **API 接入**：配置 Provider 凭据，也支持环境变量引用等高级认证方式，适合已有 API 服务或兼容端点。
- **订阅登录**：提供已支持的 Claude（`anthropic`）与 OpenAI Codex（`openai-codex`）登录入口，由后端衔接授权流程，凭据保存在本地供 Pi 运行时使用。
- **入口不混淆**：models.dev 导入走 API 配置路径；OpenAI Codex 订阅渠道通过订阅登录注册，不从该目录导入。

订阅接入是否可用取决于账号资格、服务商政策与当前运行时支持，不意味着订阅能替代所有 API 权限或免除调用限制。

### 按模型能力配置 Agent

Provider 负责连接，Agent 配置负责选择实际使用的模型与推理强度。你可以为不同参与者配置不同模型，让它们在同一 Room 中讨论、实现和核验。

Thinking 档位随所选模型的运行时能力呈现；不支持的值会被校验拒绝，避免静默调整推理强度。系统模型族 Agent 的模型选择限定在同族内，切换连接配置时保留其公开身份。

### 配置可验证，凭据不随读取回显

- 提供**连接验证**，通过不带凭据的请求探测 Provider 地址可达性；API Key 与实际模型调用需另行验证，探测不会执行命令型凭据来源。
- 配置读取不返回明文密钥；编辑时留空保留已有密钥，清除需要明确操作与确认。
- 配置采用**原子替换与可恢复备份**，避免半写入破坏现有连接配置。

这些保护减少配置误操作，不替代本机访问控制。更多细节见[模型 Provider 配置](docs/engineering/backend/model-provider-config.md)、[模型管理界面契约](docs/engineering/frontend/model-family-management.md)与[订阅登录说明](docs/engineering/backend/subscription-oauth-login.md)。

## 可观测性：看清每一次 Agent 执行

从消息旁的执行时间线进入 Trace / Context 检查视图，可以沿着一次调用查看触发、Session 决策、上下文投递、模型与工具活动、用量和结果落库等环节。排查问题时，证据与对应消息放在一起，方便定位和复查。

| 你想了解什么 | 可以查看的证据 |
| --- | --- |
| **这轮执行进行到哪里了？** | 执行时间线、模型与工具活动、完成或失败状态；工具详情按需展开请求、结果与阶段性输出 |
| **Agent 实际收到了什么？** | 调用前保存的上下文快照，包含实际投递的分区、来源、可见性、内容哈希与估算 Token 数 |
| **为什么新建了 Session？** | 新建 / 复用标记与未复用原因；复用时区分本轮增量输入和保留的历史前缀引用 |
| **这次调用消耗了多少？** | 运行后可用的 Token 用量、模型调用与缓存证据；缺失数据明确标为未知 |
| **如何保留排查依据？** | 复制检查结果或导出脱敏后的 Trace / Context Markdown，用于复查与沟通 |

例如，发现某轮重新建立了 Session，可以先查看未复用原因，再检查上下文占用率、Goal 版本或历史变化；发现 Agent 遗漏了要求，可以打开该轮 Context，核对实际投递内容，定位遗漏发生在哪个环节。

检查器采用有界展示：模型与工具时间线保留首条及最近 15 条事件，并标明中间省略部分；Session 历史追溯最多 8 层。上下文中的敏感值会脱敏，受保护内容按可见性规则展示。Session 复用、Provider 缓存和上下文 Token 估算分别呈现，便于区分不同证据的含义。

详见[上下文与执行轨迹检查器](docs/engineering/runtime/agent-context-inspector.md)。

## 一次交付怎样展开

以“给项目增加一项功能”为例：

1. **规划**：你在 Claude Code 里说明要做什么。Claude Code 调研代码，和你确认目标、非目标和验收方式，写成 Goal。
2. **派活**：你批准 Goal 后，Claude Code 创建 Room，绑定专属分支和 worktree，并指派实现者作为 Goal 负责人。
3. **执行**：实现者按 Goal 推进，由 Goal Runner 自动续跑。遇到需要决定的事，实现者提出提案。
4. **裁决**：委托范围内的提案由 Claude Code 裁决；目标、验收标准的变更和高风险事项交给你。
5. **评审**：每个里程碑由 Claude Code 做一次独立评审。如果 Claude Code 和实现者属于同一模型族，就改由其他模型族的 Agent 或你来评审。
6. **验收**：你对确切的候选版本作出验收决定，再按项目流程集成或发布。

**方向与授权在你手里。Claude Code 负责规划和把关，实现者负责推进，证据负责说明结果。**

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) **22.19+** 与 npm
- Git；使用 Room 工作区的项目需要本地 `develop` 分支
- 可用的模型 Provider 与对应凭据或受支持的订阅登录

Pi SDK 随项目依赖安装，无需另外安装全局 Pi CLI。

### 安装与启动

```bash
git clone https://github.com/Koumakan-Madoka/caff.git
cd caff
npm ci
cp .env.example .env.local
npm run start:dev
```

Windows PowerShell 中，将复制命令替换为 `Copy-Item .env.example .env.local`。

访问 **http://127.0.0.1:3100**。首次使用建议：

1. 在 **角色与模型管理**（`/personas.html`）配置 Provider、认证和模型，并为参与 Agent 选择可用模型配置。
2. 在 **项目管理**（`/projects.html`）登记本地项目；需要代码工作区时，确认项目是 Git 仓库且存在本地 `develop`。
3. 回到聊天工作台，选择 Project、Mode（普通对话为 `standard`）和参与者，创建 Room。
4. 先发起讨论；需要改文件时，再确认独立工作区授权。

健康检查：

```bash
curl http://127.0.0.1:3100/api/health
```

`core.ready` 表示核心服务就绪，`chat.ready` 表示至少一个默认聊天角色能解析到可用模型配置；**健康接口不联网验证 Provider 凭据或模型调用是否成功**。

### 常用配置

启动脚本自动加载 `.env.local`，已有进程环境变量优先。

| 变量 | 用途 |
| --- | --- |
| `CHAT_APP_HOST` / `CHAT_APP_PORT` | 监听地址与端口，默认 `127.0.0.1:3100` |
| `PI_CODING_AGENT_DIR` | Pi 配置与本地运行状态目录，默认自动定位 `.pi-sandbox/` |
| `PI_SQLITE_PATH` | SQLite 数据文件路径 |
| `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING` | 用户显式指定的运行模型与推理配置；无厂商默认兜底，不替代系统书记选择 |
| `PI_CHAT_SESSION_REUSE_ENABLED` | Session 复用总开关，设为 `0` 可关闭；未收录于 `.env.example`，可自行添加 |
| `CAFF_PLANNER_TERMINAL` | 默认开启，仅回环绑定生效；不设或 `1`/`true`/`on`/`yes` 开启，`0`/`false`/`off`/`no` 关闭（去首尾空白、不分大小写）；其他值关闭并报 `planner_terminal_flag_invalid`。修改共享实例配置/重启须另行授权 |
| `CAFF_CLAUDE_CLI` | 可选的官方 Claude CLI 单个可执行路径；不设置时从 PATH 查找，不接受 shell 命令 |
| `CAFF_PLANNER_NAME` / `CAFF_PLANNER_CREDENTIAL_FILE` | P1 规划者显示名及可选绝对凭证文件路径；令牌由服务安全生成/轮换，不手工填入环境 |

基础配置模板见 [`.env.example`](.env.example)，复用策略配置另见 [Session 复用契约](docs/engineering/runtime/agent-session-reuse.md)。凭据留在本地配置中，不要提交到仓库。CAFF 面向可信本地环境；不要未经访问控制与安全评估直接暴露到公网。运行多个实例时，请分别配置端口、数据库与运行目录，不要让多个实例共写同一数据库。

摘要、标题精炼与现场整理共用「系统服务 → 系统书记」中显式保存的模型选择，底层继续使用 PI 模型目录。升级后不会自动迁移旧的隐式默认；未配置时需先选择模型。详见 [模型选择与升级说明](docs/engineering/backend/model-selection.md)。

### 房间里的 Claude Code（P2，默认开启，仅回环绑定）

1. 单独安装官方 Claude Code CLI 并完成自己的登录；这不是 Pi 的订阅登录。交互终端要求 **>=2.1.310**。CAFF 不自动安装、升级或确认权限。Windows 使用 node-pty 1.1.0 自带新版 ConPTY（需要 conpty.dll 和 OpenConsole.exe）；浏览器使用固定的 Unicode 字素插件 0.4.0。缺失时显示固定原因并停止连接，不回退旧版以免重影。
2. 保持目标实例回环绑定；`CAFF_PLANNER_TERMINAL` 不设置即默认开启。要关闭，在本地配置设 `CAFF_PLANNER_TERMINAL=0`（或 `false`/`off`/`no`）；`1`/`true`/`on`/`yes` 显式开启，去首尾空白且不分大小写。其他值（含空串）一律关闭，bootstrap 返回 `planner_terminal_flag_invalid`，不回显原值；非回环绑定始终不可用。**先取得该实例配置变更与重启授权**；默认值变更不表示已升级运行中的实例，本文不授权重启 3100。启动后，房间页头可打开非模态终端分栏（窄屏覆盖），目录为绑定 worktree，否则为项目根目录、提示只读规划。确认信任前核对路径，至少发送并保存一次消息后才能可靠续接。
   内嵌交互终端固定 `CLAUDE_CODE_NO_FLICKER=1` 使用全屏渲染器：避免经典渲染器重连空白，也避免提前停止被计入全机共享的全屏启动失败、影响用户自己终端的渲染器（规划者实测 CLI 2.1.311）。该变量由 CAFF 生成，不继承父进程的渲染器偏好，不读写共享 `~/.claude.json`；版本探测与 `-p` 叫醒不设置。版本相关实测与边界见 [契约 §10](docs/engineering/runtime/embedded-planner.md#2026-10-27-interactive-renderer-pin)。
3. 每房间固定一个 CAFF 专用会话 UUID；不要在自己的另一终端 resume 同一 UUID。仅一个页面可连接；关闭分栏只断开，进程保留 30 分钟，全实例最多 4 个。**附着和保留中的终端都会抑制叫醒**；要让叫醒运行，正常退出 CLI 或明确 Stop。正常退出/Stop 后手动连接即可，不需要恢复操作。
4. 叫醒是另一个默认关闭的**按房间用户确认**开关，仅针对当前规划者绑定、未完成且非 DAG 的 Goal。只响应五类待处理事项，每房间滚动一小时最多 4 次，每次最多 12 turns／10 分钟；使用 CLI 自己的订阅或配置的 provider，**消耗真实用量，不是免费任务，也不是美元金额上限**。只能由用户处理的事项记为 needs_user，不会反复叫醒；配额、原因和脱敏分页记录在面板查看。
5. 自动叫醒还要求已验证的 **2.1.x 且 >=2.1.310**、可信 Node/适配器前缀路径无空白；其他版本/路径保持 `planner_wakeup_tools_unverified`，等待规划者重跑权限关卡，不扩大权限。终端交互遵循用户 CLI 权限；叫醒固定四个工具、六个 caff-only Bash 前缀和 dontAsk，只加载用户级设置，不加载房间的项目/本地设置。文件读取限定在工作目录内，不裸放行 Read/Glob/Grep；每次启动前检查用户级及文件形式的托管设置，Bash 放行、非空 additionalDirectories、文件读不了或解析不了时以 `planner_wakeup_settings_unsafe` 阻止叫醒，面板只显示文件和问题类型，不占配额、不认领事项。注册表/MDM/服务端托管策略不检查；最终 SHA 的真实 CLI 权限复验仍待规划者完成。

**安全与恢复**：WebSocket 校验 Host/Origin，CSRF 令牌只在首消息传递；认证前不启动进程或发送输出。子进程仅继承路径/代理白名单，不继承 provider 密钥或 Claude 会话变量；用户专属 provider/网关/模型偏好放在自己的 `~/.claude/settings.json` 的 `env` 中，CAFF 不复制这些值或改写设置；仅叫醒启动前读取设置文件做上述安全检查，不回显内容。CLI 后续设置仍可选择付费 provider，不能据此保证订阅计费。caff 仅从 P1 凭证文件鉴权、直连固定回环房间，不打印令牌。此边界防浏览器跨源滥用，不隔离同账号本地进程，不支持远程/多用户开放。

崩溃后若旧租约阻断，先确认旧会话进程全已停止，再用**修复租约**；若首次没有保存消息或记录消失导致“会话可能不可用”，在无进程/租约占用时确认**同 UUID 重新初始化**。二者不相互替代、不自动重连；记录若仍存在，CLI 可能拒绝一次初始化，再打开即可 resume。详见 [使用、命令卡与恢复契约](docs/engineering/runtime/embedded-planner.md)。Windows/CLI 2.1.310 已有规划者真机证据；Linux CI 仍需授权发布候选后执行，不能把 Windows PASS 当作 Linux 通过。

## 架构与扩展

```text
外部 Claude Code → caff / P1 HTTP     浏览器工作台（观察与审批）
                  │                    │ HTTP / SSE / 首消息鉴权 WS
                  ▼                    ▼
Room · Goal / 证据 / 裁决 · 显式路由 · DAG · 投递与回执
    ├── Pi SDK Host → 模型 Provider / 实现者 Agent 工具
    ├── 内嵌规划者宿主 → node-pty 交互 / 受限管道叫醒 → 官方 Claude CLI
    │                       └── caff 适配器 → P1 规划者身份 HTTP
    ├── Git branch / worktree → 任务文件状态
    └── SQLite → 消息、目标、执行、租约与有界叫醒记录
```

- **Skills**：按项目与会话组织工作规范和专门能力。
- **聊天桥与受控能力桥**：Agent 通过公开消息、上下文读取、委派、Goal 等工具参与协作；固定能力门面约束跨 Room 等调用的权限与参数。
- **飞书**：可选的文本消息入口，支持 webhook 与官方 SDK long connection，见[接入说明](docs/feishu-integration.md)。

| 目录 | 内容 |
| --- | --- |
| `server/` | API、Room 与执行编排、领域服务 |
| `lib/` | Pi 集成、聊天桥与共享模块 |
| `storage/` | SQLite 仓储与迁移 |
| `public/` | 本地 Web 工作台 |
| `tests/` | runtime、HTTP、storage、UI、smoke 等测试 |
| `.agents/` | 项目级工作流与规划 Skills |
| `docs/engineering/` / `docs/decisions/` | 当前工程契约与已接受的长期决策 |

## 深入了解

- [ADR 0003：每房间内嵌 Claude Code](docs/decisions/0003-embedded-claude-code-planner.md) · [内嵌规划者契约与交互 caff 指南](docs/engineering/runtime/embedded-planner.md)
- [ADR 0002：外部规划者驱动 CAFF](docs/decisions/0002-external-planner-drives-caff.md) · [ADR 0001：Goal 驱动的交付流程](docs/decisions/0001-goal-driven-workflow.md)
- [工程文档入口](docs/engineering/index.md)
- [Room 工作区与验收边界](docs/engineering/backend/room-context-workspace.md)
- [Room 内 Agent 委派](docs/engineering/runtime/agent-delegation.md)
- [跨 Room 投递、回执与能力桥](docs/features/F003-cross-conversation-delivery-pi-mcp-bridge.md)
- [Session Goal](docs/engineering/backend/session-goal.md) · [DAG 执行](docs/engineering/backend/dag-execution.md)
- [Session 复用策略](docs/engineering/runtime/agent-session-reuse.md) · [结构化摘要](docs/engineering/backend/conversation-digest.md)
- [上下文与执行轨迹检查器](docs/engineering/runtime/agent-context-inspector.md)
- [模型 Provider 配置](docs/engineering/backend/model-provider-config.md) · [订阅登录](docs/engineering/backend/subscription-oauth-login.md)

## 开发与贡献

开始修改前，请阅读 [`AGENTS.md`](AGENTS.md) 与 [CAFF 工作流](.agents/skills/caff-workflow/SKILL.md)：先澄清范围，再绑定独立工作区，保留验证证据，并由非作者审查后集成。

常用检查命令：

```bash
npm run check
npm run typecheck
npm test
```

`npm test` 串联快速测试与启动 smoke test；DAG 相关改动还应执行 `npm run test:dag-planning` 和 `npm run test:dag-execution`。具体变更按对应工程契约补充验证，不把测试脚本存在等同于当前版本已全部通过。

## 许可证

[MIT](LICENSE)
