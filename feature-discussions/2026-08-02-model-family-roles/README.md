---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [roles, model-family, providers, credentials, persona, defaults, design-gate]
doc_kind: discussion
created: 2026-08-02
status: done
completed: 2026-08-03
---

# CAFF Model-family Roles — Kickoff and Design Gate

## Status

原角色方向已收敛；operator 认可首版 UI 后新增“在前端配置具体 provider”的范围，并在 provider-inclusive 复验时要求补齐思考强度等常用运行字段。`e7bbd71` 中错误的 Kimi capability fixture 已按仓库锁定的 `@earendil-works/pi-coding-agent@0.80.10` nested `@earendil-works/pi-ai` 真值修正，并对全部手写 capability snapshot 做同类 sweep；`547e8fe` 已获精确 delta APPROVE。

实现已从 canonical `origin/main@b9f3ddfa88b3e8942d0dd095f1dcaeb4c979d451` 创建独立 worktree并完成 Tasks 0–8。云端 Codex 因 code-review quota 耗尽未产生 verdict；布偶猫在隔离 sandbox 对完整 104-file PR 与 exact HEAD `bec42b856c8e11fde690478097a4cb639d0c7424` 独立复验后明确 APPROVE，无 P0/P1/新增 P2。最终本地全量门禁与 GitHub CI 全绿，PR #50 于 2026-08-03 squash merge 至 `origin/main`（merge commit `4bbc260bd572fe5073c06daee588f87e9915f46d`）。烁烁随后作为非作者、非 reviewer 的第三独立个体，在 merged main 上逐步复验 operator experience、Primary Journey 与 Migration Journey，结论 APPROVE、无用户可见 mismatch；CloseGateReport 与 reflection 已落盘，Feature lifecycle 完成。

2026-08-04 post-merge acceptance 发现两处实现偏差：角色 selector 把 Pi runtime registry 的 1079 个内建路由整库暴露且隐藏 provider，Dark 主题下新增角色/供应商卡片仍使用白色硬编码。修正后的终态是：selector 只显示 `models.json` 明确模型与精确 runtime default，Pi registry 仅补元数据；每项显示 provider/source；所有新增管理 surface 使用 Light/Dark 语义 token。

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

原 Architecture Gate 于 `60234bc` 冻结；provider 新范围使其重新打开。provider-inclusive 修订见 [architecture-gate.md](architecture-gate.md)，已完成跨个体 architecture/security review，并作为本次实现的冻结契约。核心结论：

- 永久 RoleIdentity 与活动 RoleConfig 分离，旧 seed 删除不再级联吞历史；
- configured model catalog 与 family registry 单点归类，unknown/conflict fail closed；
- provider 连接由独立管理 surface 写当前 agentDir `models.json`；API credential-blind + local-admin-only，保存/移除使用 validation + old-snapshot backup + platform-aware atomic replace；
- family role 只配置同族模型运行参数与聊天默认偏好，不承载 Persona/Persona Skills；
- store 层删除“前三名”fallback，interactive/starter/external/game 各自显式解析参与者；
- migration 使用备份 + 单事务 rebuild + 逐表 count/hash audit；
- `/api/agents` 与 `agentId` 本 Feature 内保持兼容，不制造双 API。

## Gate B — UI

Design Gate 已由 operator 验收，生产 UI 按同一契约落地并经独立 review：

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

## Closed Risk Checklist

下列风险均已在实现中用 fail-closed 契约、迁移/恢复测试和跨猫 review 闭合；保留清单作为回归审计入口：

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

## Completion

- Delivery: [PR #50](https://github.com/Koumakan-Madoka/CAFF/pull/50), squash `4bbc260bd572fe5073c06daee588f87e9915f46d`.
- Final review: [APPROVE on exact HEAD `bec42b8`](https://github.com/Koumakan-Madoka/CAFF/pull/50#issuecomment-5165873252).
- Vision guard: [request](../../review-notes/2026-08-03-model-family-roles-vision-guard-request.md) / [independent APPROVE](../../review-notes/2026-08-03-model-family-roles-vision-guard-verdict-shuoshuo.md).
- Lifecycle evidence: [Close Gate Report](../../project-evidence/CAFF-model-family-roles-close-gate-report.md) / [reflection](../../project-reflections/2026-08-03-model-family-roles-capsule.md) / [browser evidence](../../project-evidence/CAFF-model-family-roles-browser/).
- Required successor: none; all acceptance work closed within this Feature.
