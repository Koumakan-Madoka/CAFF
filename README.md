# CAFF

**让不同模型的 Agent 在同一个本地工作台里协作，把讨论推进到可验证的交付。**

CAFF（Conversational Agent Framework & Playground）是基于 **Pi SDK** 构建的多 Agent 工程协作工作台。你可以在 Room 中与不同模型交流、点名交接任务，将代码变更放进独立 Git 工作区，并用目标、验收证据和独立核验约束长流程执行。

它关注的不只是“多个模型能不能一起聊天”，而是：**任务交给了谁、变更发生在哪里、目标有没有漂移、完成凭什么成立。**

![Node.js](https://img.shields.io/badge/Node.js-22.19+-green?logo=node.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![License](https://img.shields.io/badge/License-MIT-yellow)

## 为什么是 CAFF

### 1. 多 Agent Room：让协作有明确的接力关系

用户与不同模型的 Agent 共享同一个协作空间，不必在多个聊天窗口之间反复复制上下文。

- **显式路由**：通过 `@mention` 点名参与者，支持串行、并行交接，而不是每条消息都让所有模型抢答。
- **Room 内任务委派**：Agent 可以创建持久化委派，等待时释放执行槽位；接收方结束后，由运行时汇总结果并安排请求方继续。
- **保留模型身份**：不同模型族以各自身份参与，可以选择模型配置与 Skills，不依赖虚构人格来组织工程分工。
- **过程可查看、可干预**：消息流、工具调用、上下文快照与执行轨迹帮助你了解 Agent 做了什么，也可以停止当前执行。

### 2. Room × Git：把讨论与代码变更放在同一个边界内

Room 不只是消息容器，也是任务工作区的组织单位。

- 创建 Room 时明确 Project、Mode 和参与者；Project 与 Mode 创建后固定。
- 开始修改前，先预览工作区，再由用户确认绑定。服务端从 Room 身份派生唯一的 `room/*` 分支和 worktree，普通 Room 以项目本地 `develop` 为基线。
- 不同任务拥有独立文件状态，Agent 在绑定的工作目录中执行；提交、差异和审查都能对应到具体任务，便于追踪与回滚。
- 验收记录绑定确切候选 SHA，不能用对旧版本的认可替代对新版本的验收。

> Git worktree 隔离的是文件状态，不是运行时安全沙箱。端口、数据库、日志、凭据和外部副作用仍需单独隔离；未绑定 Room 也没有服务端强制只读锁。

### 3. 跨 Room 投递：交接不只是一条聊天消息

当工作需要交给另一个 Room，CAFF 提供带寻址、状态与回执的投递机制，而不是依赖 Agent “记得去通知”。

- **精确寻址**：每条投递指定一个目标 Room 与其中一位 Agent；Agent 跨 Room 通信受同一非空 Project 作用域约束。
- **先落库，后派发**：投递记录本身就是 durable outbox，幂等键在规定作用域内防止重复创建投递与目标消息。
- **可恢复的生命周期**：重启后恢复持久化投递状态，尚未启动的任务可按策略重新入队；已启动但结果未知的执行不会自动重跑，避免重复副作用。
- **迟到回复不触发重新执行**：迟到回复将响应状态标记为 `late` 并追加审计事件，不重新执行、不推翻已落库的派发（dispatch）结果。
- **防循环保护**：检测重复链路并限制转发跳数；请求回复回源后默认不自动唤醒源 Agent，避免无限往返。

这些机制提供可追踪的交接与恢复边界，不承诺任意外部操作的 exactly-once 执行。

### 4. 规范 × Goal × DAG：让长任务不靠聊天记忆维持方向

CAFF 将工程约束、交付目标与执行依赖分别保留下来，减少长流程中的意图漂移。

| 层次 | 负责什么 |
| --- | --- |
| **持久工程规范** | `AGENTS.md`、项目 Skills、`docs/engineering/` 与已接受的 ADR 保存工程约束与长期决策 |
| **Session Goal** | 保存目标、决策、非目标、待决问题、工作项、验收标准与证据；符合条件时由 Goal Runner 持续推进 |
| **DAG** | 对复杂任务明确依赖、并行节点、分工与汇合，并通过 worker / verifier 协议核验节点结果 |

**“工作项做完了”不等于“验收通过了”。** Goal 的通过项需要关联证据；完成前，验收标准必须全部通过或按规则获准豁免。

Agent 提议的目标创建与结构变更需要审核，提议者不能自审；普通提案可由用户或另一参与 Agent 裁决，高风险豁免及变更已关联 ADR 的承诺决策必须由用户确认。DAG 子任务通常由不同于 worker 的 verifier 裁决完成提案，单 Agent 节点则走调度器的显式核验豁免。

按任务复杂度选择 **Direct → Goal → DAG**：简单改动直接交付，长任务保留目标，有真实并行收益和依赖关系时再拆图。这是执行编排，不是切换 Room 的 Mode。

### 5. Fresh Context First：先证明可以复用，再继续旧会话

长对话不能无限堆进模型上下文，也不应在历史已变化时盲目续跑。

CAFF 以新建 Session 作为安全回退路径：**当前版本默认开启复用检查，但只有校验通过才复用旧 Session**。

- 检查静态提示段哈希、历史与私聊游标、空闲时间、上下文占用率等条件；证据缺失、历史变异或状态异常时回退新 Session。
- Goal Runner 自动续跑额外核对 Goal 身份与版本，并要求上下文占用率严格低于 50%；普通复用阈值配置得更低时，采用更低阈值。
- 复用时只追加可见的增量消息；上下文检查器区分本轮实际输入与已保留的 Session 前缀。
- 对长对话生成摘要与五类结构化条目：**事实、决策、待解决问题、下一步、产物**，结合滚动汇总和保留预算，控制摘要进入提示词的体积。

这里的 Fresh 指模型运行 Session，不是新建 Room。结构化摘要帮助延续关键结论，但不是无损压缩；重要要求与交付证据应进入 Goal 或工程文档，而不只留在聊天历史中。

## 模型接入：从配置到协作

**接入模型不只是填一个 API Key，还要让它能被正确配置、验证，并交给合适的 Agent 使用。** CAFF 将这些步骤集中在「角色与模型管理」中，让模型连接与协作身份各司其职。

### 可视化管理，不必从手写配置开始

在 Web 界面维护 Provider 的地址、API 协议、认证方式和模型列表，既可以手动添加，也可以从 **models.dev 目录**搜索并选择导入。

目录支持在线刷新；导入前可查看来源与模型信息，确认后再写入本地配置。有效的上下文容量（`contextWindow`）和单次输出上限（`maxTokens`）随目录导入，后续也可调整，避免把两种限制混为一谈。

> 目录信息是配置参考，不是运行能力保证。某个模型出现在目录里，不代表当前 Pi 运行时、协议或账号一定支持调用；实际能力与连接仍需验证。

### API Key 与订阅登录，两条接入路径

- **API 接入**：配置 Provider 凭据，也支持环境变量引用等高级认证方式，适合已有 API 服务或兼容端点。
- **订阅登录**：提供已支持的 Claude（`anthropic`）与 OpenAI Codex（`openai-codex`）登录入口，由后端衔接授权流程，凭据保存在本地供 Pi 运行时使用。
- **入口不混淆**：models.dev 导入走 API 配置路径；OpenAI Codex 订阅渠道通过订阅登录注册，不从该目录导入。

订阅接入是否可用取决于账号资格、服务商政策与当前运行时支持，不意味着订阅能替代所有 API 权限或免除调用限制。

### 按模型能力配置 Agent

Provider 负责连接，Agent 配置负责选择实际使用的模型与推理强度。你可以为不同参与者配置不同模型，让它们在同一 Room 中讨论、实现和核验。

Thinking 档位来自所选模型的运行时能力，而不是对所有模型展示同一套固定选项；不支持的值会被校验拒绝，不会静默改成另一个档位。系统模型族 Agent 的模型选择限定在同族内，切换连接配置不等于改变其公开身份。

### 配置可验证，凭据不随读取回显

- 提供**连接验证**，帮助检查所选 Provider；这会访问外部服务，但不会执行命令型凭据来源。
- 配置读取不返回明文密钥；编辑时留空保留已有密钥，清除需要明确操作与确认。
- 配置采用**原子替换与可恢复备份**，避免半写入破坏现有连接配置。

这些保护减少配置误操作，不替代本机访问控制。更多细节见[模型 Provider 配置](docs/engineering/backend/model-provider-config.md)、[模型管理界面契约](docs/engineering/frontend/model-family-management.md)与[订阅登录说明](docs/engineering/backend/subscription-oauth-login.md)。

## 一次协作可以怎样展开

以“给项目增加一项功能”为例，下面是协作流程示意，不是自动执行脚本：

1. **澄清**：创建项目 Room，选择模型参与者，让 Agent 明确目标、非目标和验收方式。
2. **授权**：确认工作区预览，将改动绑定到专属分支和 worktree。
3. **执行**：小任务直接修改；长任务建立 Goal；需要并行时，用 DAG 拆出有依赖关系的节点。
4. **交接**：Room 内可委派实现或检查工作；跨 Room 可将明确的问题交给指定 Agent，并查看持久回执。
5. **核验**：实现者提交变更与测试证据，由独立审查者检查；DAG 节点按 verifier 协议裁决。
6. **验收**：用户对确切候选版本作出验收决定，再按项目流程集成或发布。

**你掌握方向与授权，Agent 负责推进，证据负责说明结果。**

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
| `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING` | 默认模型与推理配置 |
| `PI_CHAT_SESSION_REUSE_ENABLED` | Session 复用总开关，设为 `0` 可关闭；未收录于 `.env.example`，可自行添加 |

基础配置模板见 [`.env.example`](.env.example)，复用策略配置另见 [Session 复用契约](docs/engineering/runtime/agent-session-reuse.md)。凭据留在本地配置中，不要提交到仓库。CAFF 面向可信本地环境；不要未经访问控制与安全评估直接暴露到公网。运行多个实例时，请分别配置端口、数据库与运行目录，不要让多个实例共写同一数据库。

## 架构与扩展

```text
浏览器工作台
    │ HTTP / SSE
    ▼
Room · 显式路由 · Goal / DAG · 投递与回执
    ├── Pi SDK Host → 模型 Provider / Agent 工具
    ├── Git branch / worktree → 任务文件状态
    └── SQLite → 消息、目标、执行与投递状态
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
