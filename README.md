# CAFF

**Conversational Agent Framework & Playground** — 一个本地多 Agent 聊天平台，集成多人协作、游戏模式、技能系统、评测面板，以及飞书与 CLI 自动化接入能力。

![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![License](https://img.shields.io/badge/License-MIT-yellow)
![Tests](https://img.shields.io/badge/tests-passing-brightgreen)

## ✨ 当前能力概览

- **多 Agent 聊天工作台** — 在同一个房间里让多个 Agent 协作，支持 `@mention` 路由、串行/并行 handoff、停止当前 turn，以及公开 / 私有消息通道。
- **人格管理** — 在 Web UI 中维护 Agent 的基础 persona、头像、默认模型，以及按模型拆分的 persona profile。
- **Skill 与模式系统** — 统一管理 `.pi-sandbox/skills` 下的技能目录，并支持会话模式绑定、`dynamic` / `full` 两种注入策略。
- **项目管理与 Trellis 上下文** — 选择当前激活项目目录，联动 Trellis 工作流上下文和项目内额外技能目录。
- **后端主持游戏模式** — 内置“谁是卧底”和“狼人杀”两种玩法，由后端推进阶段、分配身份、处理结算。
- **评测与回归工具** — 提供 Agent 指标报表、错题本 / A/B 重放，以及 Skill 测试工作台。
- **飞书接入 MVP** — 支持通过 webhook 或 long connection 收发飞书私聊 / 群聊文本消息。
- **CLI 自动化友好** — Agent 聊天桥接工具与 GitHub CLI (`gh`) 都能直接融入本地自动化流程。

## 🏗 Architecture

CAFF 目前是一个以本地 Web 工作台为入口、Node/TypeScript 后端为核心的分层应用：

```text
┌──────────────────────────────────────────────────────────┐
│                        Browser UI                        │
│ /  /personas.html  /skills.html  /projects.html         │
│ /metrics.html  /eval-cases.html                         │
└─────────────────────────────┬────────────────────────────┘
                              │ HTTP / SSE
┌─────────────────────────────▼────────────────────────────┐
│                    server/api + server/http              │
│ bootstrap / conversations / agents / skills / modes     │
│ projects / metrics / eval-cases / skill-tests / feishu  │
└─────────────────────────────┬────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────┐
│                       Domain Services                    │
│ turn-orchestrator / mention-routing / agent-tool-bridge │
│ skill-registry / project-manager / mode-store           │
│ undercover / werewolf / feishu integration              │
└─────────────────────────────┬────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────┐
│                         Storage                          │
│ chat repositories / run repositories / SQLite / modes   │
└─────────────────────────────┬────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────┐
│                    External Runtime & Tools              │
│ pi coding agent / .pi-sandbox / Feishu / GitHub CLI     │
└──────────────────────────────────────────────────────────┘
```

**核心目录：**

| Path | Description |
|---|---|
| `server/app/` | 服务启动、配置读取、依赖装配 |
| `server/http/` | HTTP 路由、SSE 总线、请求响应工具 |
| `server/api/` | 各资源控制器：会话、人格、技能、项目、评测、飞书等 |
| `server/domain/` | 领域逻辑：turn 编排、运行时桥接、游戏服务、飞书集成 |
| `storage/` | SQLite 仓储：聊天数据、运行记录、模式与外部事件 |
| `lib/` | 共享运行时辅助、pi 集成、skill registry、project manager |
| `public/` | 前端页面与共享 JS 模块 |
| `tests/` | runtime、HTTP、storage、skill-test、smoke 测试 |
| `.trellis/` | Trellis 工作流、spec、task 与 workspace 上下文 |
| `.pi-sandbox/` | skills、agent sandboxes、本地 runtime 状态 |

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- npm 9+
- 一个可用的 LLM provider API key（默认使用 `kimi-coding` / `k2p5`，可在 `.env.local` 中修改）

### Step 1 — 最小运行（3 分钟）

```bash
git clone https://github.com/Koumakan-Madoka/caff.git
cd caff
npm install
cp .env.example .env.local  # Windows PowerShell: copy .env.example .env.local
npm run start:dev
```

> 默认配置下无需修改 `.env.local` 即可启动。如需更换 provider 或模型，打开 `.env.local` 编辑 `PI_PROVIDER` 和 `PI_MODEL`。

### Step 2 — 验证成功

1. 运行 `curl http://127.0.0.1:3100/api/health`，确认 `core.ready`、`provider.ready` 和 `optional` 状态符合预期。
2. 打开浏览器访问 **http://127.0.0.1:3100**，看到聊天界面即表示服务已启动。
3. 在终端查看启动日志，确认 `Provider` 和 `Model` 是否为你期望的值。
4. 在聊天页面发送一条消息，观察 Agent 是否能正常回复。

> **注意**：如果 provider 或 API key 未正确配置，服务仍然可以启动，但 Agent 回复会失败。详见 [`docs/local-chat-ui.md`](docs/local-chat-ui.md)。

### Step 3 — 进阶集成（可选）

| 能力 | 说明 | 文档 |
|---|---|---|
| **OpenSandbox skill-test** | 在隔离 sandbox 中运行 Skill 测试 | [`docs/opensandbox-setup.md`](docs/opensandbox-setup.md) |
| **飞书接入** | 通过 webhook 或 long connection 收发飞书消息 | [`docs/feishu-integration.md`](docs/feishu-integration.md) |
| **Windows 自启动** | 登录后自动恢复 WSL + OpenSandbox + CAFF 全栈 | [`docs/windows-local-stack.md`](docs/windows-local-stack.md) |

### Environment Variables

CAFF 在 `npm run start` / `npm run start:dev` 时会自动读取 `./.env.local`。如果变量已经存在于当前进程环境中，则进程环境优先。

#### Core

| Variable | Default | Description |
|---|---|---|
| `CHAT_APP_HOST` | `127.0.0.1` | 服务监听地址 |
| `CHAT_APP_PORT` | `3100` | 服务端口 |
| `PI_PROVIDER` | `kimi-coding` | 默认模型提供商 |
| `PI_MODEL` | `k2p5` | 默认模型名 |
| `PI_THINKING` | — | 默认 thinking / reasoning 配置 |
| `PI_CODING_AGENT_DIR` | auto-detected | pi 运行目录（默认 `.pi-sandbox/`） |
| `PI_SQLITE_PATH` | auto-detected | SQLite 数据文件路径 |

#### OpenSandbox (optional)

在隔离 Docker 容器中运行 Skill 测试。需要 Docker 可用，配置 8 个环境变量（API 地址、SDK 路径、镜像、TTL 等）。高级用法支持预烘焙镜像加速。

→ **完整配置指南**：[`docs/opensandbox-setup.md`](docs/opensandbox-setup.md)

#### Feishu (optional)

通过 webhook 或 long connection 收发飞书私聊 / 群聊文本消息。配置 6 个环境变量。

→ **完整接入指南**：[`docs/feishu-integration.md`](docs/feishu-integration.md)

如果你希望 Windows 登录后自动恢复整条本地链路（`WSL Debian` + `docker` + `opensandbox-local` + `CAFF`），详见 [`docs/windows-local-stack.md`](docs/windows-local-stack.md)。

## 🧭 Web 工作台

| Page | What it does |
|---|---|
| `/` | 聊天工作台：会话列表、消息流、参与人格、游戏主持台、发送 / 停止控制 |
| `/personas.html` | 人格管理：基础 persona、模型 profile、头像、默认模型与常驻 skill |
| `/skills.html` | Skill 与模式管理：维护 `SKILL.md`、额外文件、模式绑定与加载策略 |
| `/projects.html` | 项目管理：维护项目列表、切换激活项目、联动 Trellis 与额外技能目录 |
| `/metrics.html` | Agent 指标报表：工具调用成功率、public/private 工具使用率、延迟分位数 |
| `/eval-cases.html` | 错题本 / A/B 测试 + Skill 测试工作台 |

## 🎛 Built-in Modes

当前内置 4 种会话模式：

- `standard`：普通对话，不自动注入额外 skill。
- `coding`：面向编码协作的默认会话模式。
- `werewolf`：狼人杀，全自动后端主持，默认 `full` 注入。
- `who_is_undercover`：谁是卧底，全自动后端主持，默认 `full` 注入。

## 🔌 Automation & Integrations

### Agent 聊天桥接 CLI

CAFF 内置一个给 Agent 使用的本地聊天桥：运行时入口是 `build/lib/agent-chat-tools.js`（源码在 `lib/agent-chat-tools.ts`）。

常见能力包括：

- `send-public`：把内容发到公开聊天室
- `send-private`：给自己或其他 Agent 发私有消息
- `read-context`：读取最新公开 / 私有上下文
- `list-participants`：读取当前房间参与者
- `trellis-init` / `trellis-write`：辅助初始化或写入 `.trellis/` 文件

这套工具是多 Agent 本地协作、private mailbox、handoff 路由和工具埋点的基础。

### 飞书接入

CAFF 支持通过 webhook 或 long connection 接入飞书，收发私聊和群聊文本消息。一个飞书 `chat_id` 映射到一个 CAFF conversation。

快速开始：创建自建应用 → 启用 Bot → 配置环境变量 → 启动验证。详细步骤、权限要求和常见问题见 [`docs/feishu-integration.md`](docs/feishu-integration.md)。

### GitHub CLI 自动化接入

CAFF 的本地开发与 Agent 自动化推荐优先通过官方 GitHub CLI (`gh`) 接入 GitHub；复杂场景再按需落到 GitHub REST 或 GraphQL API。

**安装示例：**

```bash
winget install --id GitHub.cli
# or
choco install gh
```

**本地登录验证：**

```bash
gh auth login
gh auth status
gh repo view
```

**脚本与 Agent 常用命令：**

- 输出结构化数据：`gh pr list --json number,title,url,state`
- 调 REST API：`gh api repos/OWNER/REPO/issues`
- 调 GraphQL：`gh api graphql -f query='query { viewer { login } }'`
- 创建 PR：`gh pr create --fill`
- 非交互认证优先使用 `GH_TOKEN`，GitHub Actions 内优先使用 `GITHUB_TOKEN`
- 不要把 token 写进代码、日志、README 示例或共享配置

## 🧪 Testing

CAFF 使用三道测试门来保证基础健康：

| Gate | Command | What it checks |
|---|---|---|
| **A — Syntax** | `npm run check` | 前端 JS 语法检查 |
| **B — Types** | `npm run typecheck` | TypeScript `--noEmit` + `public/` 的 `checkJs` |
| **C — Tests** | `npm run test:fast` | runtime、HTTP、storage、飞书、skill-loading 等快速测试 |

常用命令：

```bash
npm run check
npm run typecheck
npm run test:fast
npm run test:smoke
npm test
```

- `npm run test:smoke` 会构建并执行服务启动 smoke test。
- `npm test` 会串联 `test:fast` 与 `test:smoke`。
- 测试基于 Node.js 内置 `node:test` 与 `node:assert/strict`。

## 📊 Evaluation & Skill Testing

### 指标报表

`/metrics.html` 会从本地 SQLite 中汇总：

- 每个 Agent 的工具调用成功率
- `send-public` / `send-private` 使用情况
- public/private 工具调用的提示词回归指标
- 工具延迟分位数（如 p50 / p95）

### 错题本 / A/B 测试

`/eval-cases.html` 支持：

- 记录问题 turn 的输入 prompt
- 批量重放 A/B prompt 或配置
- 对比输出与工具调用行为
- 沉淀回归样例

### Skill 测试工作台

同一页面下还集成了 Skill 测试面板，可用于：

- 让 AI 生成 Skill 测试草稿
- 手动编辑 test case 并标记 `draft` / `ready`
- 批量运行 ready 用例
- 查看运行历史、回归对比和工具轨迹

## 🎮 Game Modes

### Who is Undercover

1. 创建 `who_is_undercover` 房间
2. 选择参与 Agent 作为玩家
3. 配置平民词、卧底词、卧底人数、白板人数等参数
4. 点击开始后，由后端自动完成发言、投票、结算与揭晓

### Werewolf

1. 创建 `werewolf` 房间
2. 配置狼人、预言家、女巫数量
3. 选择参与 Agent 作为玩家
4. 点击开始后，由后端自动推进夜晚、白天讨论、投票与胜负判定

## 📁 Project Structure

```text
caff/
├── server/
│   ├── app/                # 启动、配置、依赖装配
│   ├── http/               # Router、SSE、请求/响应工具
│   ├── api/                # REST controllers
│   └── domain/
│       ├── conversation/   # Turn orchestration、mention routing、session export
│       ├── runtime/        # Agent tool bridge、message tool trace
│       ├── integrations/   # Feishu 集成
│       ├── undercover/     # 谁是卧底服务
│       ├── werewolf/       # 狼人杀服务
│       └── metrics/        # Agent 评测报表
├── storage/
│   ├── chat/               # Conversations、messages、participants、channel bindings
│   ├── run/                # Runs、sessions、tasks
│   └── sqlite/             # 连接与迁移
├── lib/                    # pi runtime、skill registry、project manager、CLI 工具
├── public/                 # 聊天页、人格页、技能页、项目页、报表页、错题本
├── tests/                  # runtime / http / storage / skill-test / smoke
├── docs/                   # 设计文档与迁移笔记
├── scripts/                # 构建与实用脚本
├── types/                  # TypeScript 类型声明
├── .trellis/               # Trellis workflow / spec / tasks / workspace
└── .pi-sandbox/            # skills、agent sandboxes、本地状态与配置
```

## 🤝 Contributing

欢迎继续扩展 CAFF。提交前建议至少完成：

- `npm run check`
- `npm run typecheck`
- `npm test`

并遵循以下约定：

- 新功能优先放到对应 domain module，不要把逻辑堆回 server 入口
- 新页面优先复用 `public/shared/` 中的公共模块
- 变更技能、运行时或跨层协议时，同步更新 `.trellis/spec/` 中的相关文档

## 📜 License

This project is licensed under the [MIT License](LICENSE).

---

*CAFF — where agents chat, collaborate, play games, and regression-test each other.* 🐧
