---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [roles, model-family, providers, credentials, persona, defaults, design-gate]
doc_kind: discussion
created: 2026-08-02
status: implementation_authorized
---

# CAFF Model-family Roles — Kickoff and Design Gate

## Status

原角色方向已收敛；operator 认可首版 UI 后新增“在前端配置具体 provider”的范围，并在 provider-inclusive 复验时要求补齐思考强度等常用运行字段。`e7bbd71` 中错误的 Kimi capability fixture 已按仓库锁定的 `@earendil-works/pi-coding-agent@0.80.10` nested `@earendil-works/pi-ai` 真值修正，并对全部手写 capability snapshot 做同类 sweep；`547e8fe` 已获精确 delta APPROVE。operator 已授权开始落地；截至本计划冻结点仍未修改 schema、seed、API、prompt 或生产 UI 代码。

Kickoff baseline: `chore/main-reconcile@455898c`。该 baseline 是 review candidate，不是 canonical main；实现前必须从最终 `origin/main` 创建新实现 worktree，并重做现状核验。

## Product Direction

CAFF 保留统一角色概念，但默认角色不再是 Strategist、Builder 或动漫人格，而是七个系统模型族角色：GPT、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi。

- 模型族角色只能使用同族模型，系统维护身份与边界。
- 自定义角色保持当前 CAFF 能力，不限制模型族。
- Persona Prompt 从系统默认体验退出，只属于自定义角色及其 Profiles。
- “模型供应商”作为独立管理 surface，负责 provider 连接、认证与模型条目；角色页只消费归类后的 configured catalog。
- 角色详情直接配置默认模型、Pi 能力感知的默认思考强度与多个运行 Profiles；family Profile 只同族且无 Persona，custom 保留跨族模型、Profile Persona 与 Skills。
- 角色可以多选为聊天 defaults；新建普通聊天只预勾选，提交前可调整。
- 旧九个系统 seed 按 ID 删除，不转 custom；用户自建角色保留。

## Evidence Read

- `lib/chat-app-store.ts:32-182` — 旧九个 system seeds。
- `lib/chat-app-store.ts:759-782` — 未指定参与者时隐式选择前 3 个角色。
- `lib/chat-app-store.ts:1192-1237` — 启动补种与 Persona Prompt 强制校验。
- `storage/sqlite/migrations.ts:245-333` — Agent schema 及会话/消息/记忆外键删除语义。
- `server/domain/conversation/turn/agent-executor.ts:450-466` — Model Profile 与 Persona 解析。
- `server/domain/conversation/turn/agent-prompt.ts:563-634` — 角色说明与 Persona 注入。
- `server/api/bootstrap-payload.ts:89-142` — 当前模型选项目录来源。
- `public/app.js:3805-3837` — 当前新建普通聊天没有参与者确认步骤。
- `public/personas.html:65-166`, `public/personas.js:250-337`, `500-537` — 当前 Persona 管理表单。

## Confirmed Decisions

1. `roleKind = model_family | custom`。
2. `modelFamily = gpt | claude | gemini | deepseek | qwen | glm | kimi | null`。
3. 自定义角色不限制模型，保留现有高级能力。
4. `isDefaultChatRole` 允许多个 true。
5. defaults 只用于新建普通聊天的预勾选，不自动写入会话。
6. 无可用模型的 family 不能设 default。
7. defaults 修改不追写已有聊天，游戏模式不使用该默认集合。
8. 旧九个 system IDs 删除，即使记录曾被修改；非 system ID 的用户角色保留。
9. 旧角色不自动映射到模型族；历史用户状态不得丢失。
10. Provider 配置进入前端，但不混入角色详情；连接 → 模型目录 → family availability 保持单向。
11. 已有密钥与原始 env/command reference 永不回传浏览器；空输入保留，清除显式确认，配置写入先校验并备份旧 snapshot，再 platform-aware 原子替换。
12. Provider mutation/clear/validate 首版 local-admin-only；严格 Origin/Host/JSON/CSRF，连接验证不执行 command。
13. Provider 移除是独立 danger action，只删除当前 `models.json` 配置条目；历史、角色身份和外部认证保留，受影响角色显式变为 unavailable。
14. 思考强度不是自由文本：值域沿用 Pi `off/minimal/low/medium/high/xhigh/max`，UI 按 catalog model 的 `supportedThinkingLevels` 过滤；空值继承 runtime default，不支持值在 save/runtime fail closed，不静默 clamp。

## Gate A — Architecture

原 Architecture Gate 于 `60234bc` 冻结；provider 新范围使其重新打开。provider-inclusive 修订见 [architecture-gate.md](architecture-gate.md)，等待跨个体 architecture/security review。核心结论：

- 永久 RoleIdentity 与活动 RoleConfig 分离，旧 seed 删除不再级联吞历史；
- configured model catalog 与 family registry 单点归类，unknown/conflict fail closed；
- provider 连接由独立管理 surface 写当前 agentDir `models.json`；API credential-blind + local-admin-only，保存/移除使用 validation + old-snapshot backup + platform-aware atomic replace；
- family role 只配置同族模型运行参数与聊天默认偏好，不承载 Persona/Persona Skills；
- store 层删除“前三名”fallback，interactive/starter/external/game 各自显式解析参与者；
- migration 使用备份 + 单事务 rebuild + 逐表 count/hash audit；
- `/api/agents` 与 `agentId` 本 Feature 内保持兼容，不制造双 API。

## Gate B — UI

必须提供真实视口中的角色管理与新建聊天流程，并由 operator 验收：

- 系统模型族 / 自定义角色分组；
- 角色管理 / 模型供应商两个同 shell surface；
- provider 连接、协议、masked secret、模型条目、显式 family、验证状态与显式移除确认；
- family availability 与默认开关；
- locked system fields；
- 默认模型、能力感知的默认思考强度与可增删运行 Profiles；custom 完整 Persona/Skills；
- defaults 预勾选、增删、取消、提交；
- 桌面与移动状态。

提案真相源：

- [UI Design Gate](ui-design-gate.md)
- [交互 fixture](../../designs/model-family-roles-ui-gate.html)

## Blocking Risks

1. **P0 data loss:** 当前 `chat_agents` 删除会级联删除参与者与记忆；不能把“删 seed”实现成裸 `DELETE`。
2. **Model boundary bypass:** Profile 覆盖可以绕过基础 provider/model，family 必须在 runtime 再校验。
3. **Distributed classification:** Provider/model 命名不稳定，不能在多个层各写一次字符串判断。
4. **False defaults:** 当前后端隐式前三名会掩盖空 defaults，必须移除普通聊天的该 fallback。
5. **Credential exposure:** 直接投影 `models.json` 会泄露 API key、custom header 或内嵌 token 的 command reference；read DTO 必须 credential-blind。
6. **HTTP RCE/SSRF:** LAN/CSRF 可把 command 与 Base URL validation 变成远程攻击面；首版只允许 loopback local-admin，validate 不执行 command。
7. **Config corruption:** provider 保存若覆盖未知字段或写到错误 agentDir，会破坏现有运行时；必须 patch-merge、完整校验、旧 snapshot 备份与 platform-aware 原子替换。
8. **Windows durability:** directory fsync 可能不支持，不能在替换成功后反报失败；必须有 Windows real-fs 契约与显式 durability state。
9. **Thinking drift:** 当前自由文本可持久化模型不支持的强度，Pi 后置 clamp 会让 UI 配置与真实执行不一致；catalog/save/runtime 必须共享 capability contract。
10. **Baseline drift:** `455898c` 尚未进入 canonical main，代码位置与契约可能在实现前变化。

## Next Action

Architecture/Security 与 capability fixture delta 已在 `547e8fe` 获跨个体 APPROVE；operator 已明确授权开始落地。实现计划见 [2026-08-03-model-family-roles-implementation-plan.md](../../feature-specs/2026-08-03-model-family-roles-implementation-plan.md)。下一步从 exact `origin/main@b9f3ddfa88b3e8942d0dd095f1dcaeb4c979d451` 创建独立实现 worktree，只转移冻结产物，按 Provider Config + Registry/Catalog → Migration → Role/API → Participant Policy → Runtime/Prompt → UI 的顺序逐段 TDD。
