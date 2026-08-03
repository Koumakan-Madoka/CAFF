---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [agents, roles, model-family, providers, credentials, personas, chat-defaults, migration]
doc_kind: feature_spec
created: 2026-08-02
status: merged
---

# CAFF Model-family Roles Feature Spec

**Feature:** CAFF-MODEL-FAMILY-ROLES — 模型族作为系统默认角色，同时保留用户自定义角色
**Goal:** 削弱 CAFF 默认体验中的角色扮演属性，把 GPT、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi 建模为受模型边界约束的系统角色；保留现有自定义角色能力，让任意可用角色可以成为新建普通聊天的预选默认角色，并让 operator 能在前端安全维护决定模型可用性的 provider 连接与模型目录。
**Source:** `thread_mrxfv8tub5r1uvww` 中 operator 于 2026-08-01 的连续决策，见本文“Operator Decision Ledger”。
**Baseline:** kickoff 基于 `chore/main-reconcile@455898c`。该 SHA 尚未进入 `origin/main`；实现开始前必须重新同步最终 canonical main，并重新核对本文 Current State。

## Implementation Status

实现已从 exact canonical `origin/main@b9f3ddfa88b3e8942d0dd095f1dcaeb4c979d451` 独立落地。Provider persistence/local-admin security、Pi catalog/family registry、历史身份迁移、RoleService/API、显式参与者政策、runtime/prompt enforcement、生产 Provider/Role UI 与隔离 acceptance 均已完成。PR #50 的 final packet-inclusive HEAD `bec42b856c8e11fde690478097a4cb639d0c7424` 已获跨家族完整 PR review APPROVE，无 P0/P1/新增 P2，并于 2026-08-03 squash merge 至 `origin/main`（merge commit `4bbc260bd572fe5073c06daee588f87e9915f46d`）。当前代码已进入 main，Feature completion 仍等待非作者、非 reviewer 的愿景守护验收。

## Timeline

| Date | Event |
|---|---|
| 2026-08-03 | Tasks 0–8、隔离 acceptance、final-HEAD review 与最终 merge gate 完成；PR #50 squash merged as `4bbc260`。 |

## Acceptance Criteria

1. CAFF 只有统一的“角色”运行身份，角色分为 `model_family` 与 `custom` 两类；所有现有以 `agentId` 为稳定键的会话、消息、记忆、指标、sandbox、mention 与游戏模式接口继续使用稳定角色 ID。
2. 系统提供且只提供首版七个模型族角色：GPT、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi。模型族角色只能选择归属于自身模型族的已配置模型。
3. 模型族角色的名称、图标、颜色、稳定 ID 与模型族边界由系统维护；其默认运行路径不要求 Persona Prompt，也不注入角色扮演 Persona。
4. 用户自定义角色不限制模型族，并保留当前名称、头像、角色说明、Persona Prompt、Skills、基础模型及模型 Profiles 能力。
5. 任意可用的模型族角色或自定义角色都可设置 `isDefaultChatRole=true`；允许多个默认角色。没有可用模型的模型族角色不可设为默认。
6. 新建普通聊天进入参与者确认界面时，仅预勾选当前默认角色；用户可在提交前增删。提交之前不得创建会话或写入参与者，提交后才持久化最终选择。
7. 修改默认角色只影响之后新建的普通聊天，不改写已有聊天参与者；游戏模式继续使用自己的参与者创建流程。
8. 旧九个系统 seed 角色从可用角色目录和启动 seed 逻辑中删除，重启后不得复活。即使用户曾修改同一系统 ID，也按 operator 选择删除；用户自行创建的其他角色完整保留。
9. 删除旧系统 seed 不得删除或静默改写用户可见历史消息、摘要、记忆、任务、指标或其他持久状态。旧角色不自动映射成任何模型族角色；迁移必须保留可审计的历史身份显示。
10. 数据迁移、API、prompt、模型过滤、新建聊天交互、管理页和游戏模式均有 Red→Green 契约测试；UI 实现前完成独立 Design Gate，最终冻结 SHA 经跨个体 review 后才能进入 merge-gate。
11. 新建聊天 dialog / mobile sheet 满足键盘与模态可访问性：打开时背景 AppShell `inert` 且焦点进入表单，`focus trap` 覆盖 Tab/Shift+Tab，Escape/取消/关闭后焦点归还触发入口；所有可见交互目标不小于 44px。
12. 角色管理旁提供独立“模型供应商”管理 surface，可维护 `models.json` 中的 provider ID/name、Base URL、API 协议、认证方式及模型条目；每个模型可显式选择七族之一或“未归类”。聚合 runtime registry、env default 与 `models.json` 的 `ConfiguredModelCatalog` 仍是角色 availability 的唯一面向角色事实源。
13. Provider 读取接口永不返回明文密钥、原始 env/command reference 或 credential-bearing header；UI 只显示 configured/mode/masked state。密钥留空保留现有值，清除只能走二次确认的显式清除动作；`models.json` 写入必须先完整校验并从旧 snapshot 留下默认不设 TTL 的可恢复备份，再走 platform-aware 原子替换。
14. Provider 管理与连接验证首版只允许 loopback local-admin：非 loopback host/socket、foreign/missing Origin、Host 不匹配、非 JSON 或 CSRF 不通过均 fail closed；验证不得执行 `!command`，网络探测使用 timeout/body cap/零 redirect 的 redacted response。
15. 已保存的 `models.json` provider 可通过独立 danger action 移除：UI 二次确认必须显示模型数量与 family-role availability 影响；`DELETE /api/model-providers/:id` 只原子移除该配置条目并重算 catalog，不删除角色身份、历史聊天、消息、记忆或 `auth.json` / CLI 外部认证。失去模型的 role config 保留引用并显式变为 unavailable，不自动换模。
16. 角色详情完整开放 CAFF 真实支持的常用运行配置：base model、默认思考强度与多个 Model Profiles。思考强度使用 Pi 的 `off / minimal / low / medium / high / xhigh / max` 值域，并由所选 catalog model 的 `supportedThinkingLevels` 过滤；空值表示跟随运行时默认。family Profile 只开放 `name/description/model/thinking` 且模型必须同族；custom Profile 继续保留 Persona 覆盖。保存不支持的强度必须 422，不允许 UI 显示一个值、runtime 再静默 clamp 成另一个值。

---

## Why

当前 CAFF 把四件不同的事压在同一个 Agent 记录里，同时把它们依赖的 provider/model 配置留在后台文件中：

- 会话和消息引用的稳定运行身份；
- Provider / Model / Model Profile 配置；
- Persona Prompt 驱动的角色扮演；
- 新会话默认参与者。

这导致“选择一个模型”被表现为“选择一个虚构人格”，而 Persona Prompt 又成为所有角色的强制字段。operator 希望默认体验回到模型本身：DeepSeek、GLM、Kimi 等模型族就是系统角色；需要角色设定的用户仍可创建与当前 CAFF 相同的自定义角色。

本 Feature 的产品目标不是删除多 Agent 协作，而是把默认身份从“预设人格”改成“模型族”，明确角色类型、模型边界和默认参会语义，并把 provider connection → configured catalog → role availability 这条上游链路变成安全、可见的前端工作流。

## Operator Decision Ledger

| Message ID | 决策 |
|---|---|
| `0001785634833914-000000-b85b9bec` | 削弱角色扮演属性，去除默认角色设定层，方向转向模型族。 |
| `0001785636045374-000003-692c5c3c` | 模型族作为默认角色，同时继续支持用户自定义角色。 |
| `0001785636501813-000006-85cdc403` | 模型族是只能使用特定模型的角色；模型族本身就是角色。 |
| `0001785636780294-000009-dc0ade13` | 自定义角色不限制模型，等价于 CAFF 当前角色能力。 |
| `0001785636961712-000012-690f1767` | 旧系统预设迁移选择 C：直接删除，不隐藏、不归档、不转为自定义角色。 |
| `0001785637297322-000015-4ce9f704` | 首版模型族固定为 GPT、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi；每个角色可设置是否为聊天默认角色。 |
| `0001785637450428-000018-284c6cc5` | 默认角色选择 C：新建聊天时预勾选，提交前可增删，提交后才写入会话。 |
| `0001785637569768-000021-b2d1d3cb` | 对上述收敛结果最终确认。 |
| `0001785670702728-000129-abe47e6c` | UI 方向认可；将原本只能后台配置的具体 provider 一并带到前端，减少配置摩擦。 |
| `0001785721844031-000234-a09deb9b` | Provider-inclusive UI 方向认可，但角色详情需补齐思考强度等常用可配置字段后再验收。 |

## Current State

| Surface | Current behavior | Evidence at kickoff baseline |
|---|---|---|
| System presets | 启动时补种 Strategist、Builder、Critic 与六个动漫角色，共九个固定 ID。 | `lib/chat-app-store.ts:32-182`, `1192-1199` |
| Agent persistence | `chat_agents.persona_prompt` 为 `NOT NULL`，`saveAgent()` 还要求非空 Persona Prompt。 | `storage/sqlite/migrations.ts:245-260`, `lib/chat-app-store.ts:1210-1237` |
| Prompt assembly | Agent description 与 Persona Prompt 分别进入 Workspace Identity 和 Private Persona Instructions。 | `server/domain/conversation/turn/agent-prompt.ts:563-634` |
| Model resolution | 会话选择的 Model Profile 可覆盖 Agent 默认 provider/model/thinking/personaPrompt。 | `server/domain/conversation/turn/agent-executor.ts:450-466` |
| Model catalog | Bootstrap 从运行时默认、`models.json` 以及所有 Agent/Profile 汇总可选模型。 | `server/api/bootstrap-payload.ts:89-142` |
| Provider configuration | provider 连接与自定义模型只在 agentDir `models.json` 等后台配置中维护，角色管理 UI 无法新增、验证或修复来源。 | `lib/pi-runtime.ts`, `node_modules/@earendil-works/pi-coding-agent/docs/models.md` |
| New conversation defaults | 普通新建表单只提交标题与类型；后端在未指定参与者时选择角色列表前 3 个。 | `public/app.js:3805-3837`, `lib/chat-app-store.ts:759-782`, `1402-1417` |
| Stable identity fan-out | `agent_id` 被会话参与者、消息、私信、记忆等表引用，删除行为包含 `CASCADE` 与 `SET NULL`。 | `storage/sqlite/migrations.ts:270-333` |
| Persona management | 管理页把 Persona Prompt 作为必填项，并允许任意 Provider/Model/Profile。 | `public/personas.html:65-166`, `public/personas.js:250-337`, `500-537` |

## Terminal Product Contract

### 1. One role concept, two role kinds

```text
roleKind = model_family | custom
modelFamily = gpt | claude | gemini | deepseek | qwen | glm | kimi | null
isDefaultChatRole = boolean
```

“角色”仍是 CAFF 的稳定参与者身份。禁止为了削弱 Persona 而删除 `agentId` 抽象或用 `(provider, model)` 直接充当会话、消息、记忆的外键。

### 2. Model-family role catalog

| Stable role ID | Display name | `modelFamily` |
|---|---|---|
| `role-family-gpt` | GPT | `gpt` |
| `role-family-claude` | Claude | `claude` |
| `role-family-gemini` | Gemini | `gemini` |
| `role-family-deepseek` | DeepSeek | `deepseek` |
| `role-family-qwen` | Qwen | `qwen` |
| `role-family-glm` | GLM | `glm` |
| `role-family-kimi` | Kimi | `kimi` |

Provider 名称与模型 ID 不是可靠的产品模型族。实现必须通过一处可测试的 canonical family registry 完成归类与 alias 兼容，不能在 UI、API 与 runtime 中分别写字符串包含判断。

模型族角色的系统字段不可由普通角色保存 API 覆盖：

- stable ID
- `roleKind`
- `modelFamily`
- display name
- icon / avatar
- accent color
- family membership rule

模型族角色没有可用的已配置模型时仍显示在系统目录中，但必须标记为 unavailable，不能预选、提交为参与者或设为默认。

### 2.1 Provider management and catalog ownership

Provider 连接是角色 availability 的上游，必须作为独立“模型供应商”管理 surface，而不是嵌进某个角色详情：

```text
模型供应商（连接、认证、模型条目）
  → ConfiguredModelCatalog（归类、可用性）
  → 角色管理（只选择 catalog option）
```

- Provider 表单维护 provider ID/name、`baseUrl`、API protocol、认证方式、`authHeader` 与 model entries。
- model entry 至少可维护模型 ID、显示名和显式 `family`；未知或冲突归类必须可见，不允许静默猜测。
- API key 可在 UI 中新设或更换，但 GET/list/bootstrap 永不回传 plaintext、原始 env/command reference 或 credential-bearing custom header；浏览器只得到 `hasApiKey`、`hasExternalAuth`、masked state 与非 secret 的 auth mode。
- 更新时缺失或空的 secret 输入表示留空保留现有密钥；清除必须使用独立的显式清除动作并二次确认。
- 移除 provider 使用独立确认，不复用保存或 secret clear；仅移除当前 `models.json` 条目，历史、角色身份和外部认证保留，受影响的 family role 经 catalog 重算后显式 unavailable。
- 保留 Pi 已支持的 `$ENV_VAR` / `${ENV_VAR}` 与 `!command` 引用作为高级认证模式；GET 只显示 mode/configured，既不回显 reference，也不执行命令。`auth.json` / CLI 等外部认证只显示状态且不能由本页清除。
- 服务端只写当前 runtime resolved agentDir 的 `models.json`。保存前校验完整配置，保留未在首版 UI 展开的兼容字段；先从旧 snapshot 建立受限权限的可恢复备份，再走 platform-aware 同目录原子替换。备份可能含 secret，禁止进入响应、日志、测试 artifact 或 Git；Windows 不支持 directory fsync 时返回显式 durability 状态，不能把已完成替换反报为失败。
- 配置保存与连接验证是两种动作：两者均 local-admin-only + same-origin/Host/CSRF guarded；验证不执行 command，失败不得损坏当前有效配置；所有日志、错误、测试 fixture 与 payload 禁止包含明文 secret。

### 3. Custom roles

自定义角色保持当前能力与模型自由度：

- 用户自定义名称、头像、说明、颜色与 sandbox name；
- Persona Prompt 可配置并继续进入 prompt；
- 可绑定 Persona Skills；
- 可配置基础模型和多个 Model Profiles；
- base 与每个 Profile 都可配置能力感知的 thinking；provider 由 model option 派生；
- 每个 Profile 可继续覆盖 provider/model/thinking/personaPrompt；
- 可删除，且删除前必须遵守现有用户状态保护契约。

此次迁移只把 Persona Prompt 从“所有角色必填”改成“自定义角色可用字段”。不得顺带砍掉自定义角色的 Persona 或 Profile 能力。

### 4. Default-chat role semantics

- `isDefaultChatRole` 是角色级持久设置，允许多选。
- 仅影响交互式新建 `standard` 普通聊天。
- 打开新建聊天界面时读取一次当前 defaults 并预勾选；用户可增删。
- 点击取消或关闭不会写数据库。
- 点击创建时必须至少有一个可用角色；API 只持久化提交 payload 中的最终参与者。
- 没有任何默认角色时不再隐式选择列表前 3 个，界面以空选择开始。
- 修改 defaults 不追写已有会话，也不改变正在打开的新建表单快照。
- 游戏模式不读取这组 defaults；其玩家选择、技能注入和主持流程维持原契约。
- Feishu 已绑定房间的普通消息继续使用既有 roster；`/new` 始终按新房间的 adapter `defaultRoleIds` 政策创建，不读取既有 roster 或 interactive defaults，缺少有效政策时返回 `setup_required`。

### 5. Model enforcement

模型族约束必须在服务端保存边界与运行时解析边界各验证一次：

1. 模型族角色的基础模型与 Profile 只能引用 registry 判定属于该 family 的模型。
2. 会话级 `modelProfileId` 不能绕过 family 约束。
3. 配置文件变化导致原模型消失或改族时，角色变为 unavailable；运行时必须给出可理解的阻断错误，不得静默回落到其他模型族。
4. 自定义角色不受 family 限制，但仍要求所选模型存在或由现有 runtime 契约明确解析。

## Migration Contract

### Removed system seed IDs

以下 ID 属于旧系统预设，迁移后不得继续出现在可用角色目录，也不得被启动逻辑重新补种：

```text
agent-strategist
agent-builder
agent-critic
agent-tsundere-senpai
agent-miko-oracle
agent-mecha-engineer
agent-idol-spark
agent-kuudere-archivist
agent-chuunibyou-visionary
```

operator 已明确：按系统 ID 判定。即使对应记录曾被用户修改，也删除该旧系统角色，不转换为 `custom`。

### User-state boundary

“删除旧预设”指它们不再是可选择、可运行、可管理的角色，不授权删除由用户活动产生的持久数据。当前外键会在直接删除 `chat_agents` 时级联删除参与者和记忆，因此禁止直接执行无保护的 `DELETE`。

迁移必须先建立历史身份快照或等价的非角色历史表示，满足：

- 历史消息内容、发送者名称、时间、状态与工具痕迹可继续读取；
- 摘要、任务、指标与游戏记录不因角色删除消失；
- 记忆记录数量与内容不丢失，且不会被错误归属到新模型族角色；
- 已有会话不自动用模型族角色替换旧角色；
- 旧角色从活动参与者中退出后，历史展示仍可解释；若会话没有剩余可用参与者，用户必须显式添加新角色后才能继续发送；
- 用户创建的非上述 ID 角色及其所有关联保持不变。

迁移测试必须在包含“未修改 seed、被修改 seed、用户自建角色、历史会话、消息、记忆、摘要、游戏记录”的数据库副本上先红后绿，并逐表比较迁移前后计数与关键字段。

## UI Design Gate

当前新建聊天只是侧栏内的标题/类型快速表单，无法承载“预选但提交前可增删”的决策。前端实现前必须提供并由 operator 验收真实视口设计：

1. 角色管理与“模型供应商”是同一 management shell 内的两个清晰 surface；provider 连接不混进单个角色详情。
2. Provider 表单覆盖连接、协议、masked secret 状态、模型列表、显式 family 归类、验证、保存、secret clear 与 provider remove 语义。
3. 角色管理页清晰分组“系统模型族”与“自定义角色”，并指明 availability 来自模型供应商目录。
4. 模型族卡片显示系统身份、可用模型数量、unavailable 原因、默认聊天开关与不可编辑字段；详情以 select 明确开放默认模型、能力感知的默认思考强度与同族运行 Profiles。
5. 自定义角色继续提供完整编辑器，包括模型、思考强度、Profiles、Persona Prompt 与 Skills；不把高级 Persona 能力塞进模型族默认体验。
6. 新建普通聊天有明确的参与者确认步骤：defaults 只体现为预勾选，提交前可增删。
7. 桌面与移动端都能辨认 provider 状态、多选、不可用状态、默认标记与校验错误。
8. 提供与最终实现相同数据的浏览器截图/预览，而非脱离代码的静态概念图。

Design Gate 通过只代表产品交互方向冻结，不代表实现可合入；最终代码仍需独立 review 与 runtime acceptance。

## Architecture Gate

**Status:** 原 contract 于 2026-08-02 冻结；operator 新增前端 provider 配置后重新打开并形成 provider-inclusive revision。Canonical design: [Architecture Gate](../feature-discussions/2026-08-02-model-family-roles/architecture-gate.md)。修订 architecture/security peer review、UI Design Gate operator 验收与 canonical-main freshness check 均已完成，冻结决策已由生产实现与测试覆盖。

实现所依据的冻结中间层决策：

1. canonical model-family registry 的归属模块、provider/model alias 数据源及未知模型行为；
2. 系统字段写保护与自定义字段边界，尤其是模型族角色是否允许用户配置 Skills、thinking 或默认模型；
3. 历史身份快照与旧角色关联数据的迁移结构；
4. 交互式普通聊天、外部渠道自动建会话与 starter conversation 各自的默认参与者政策；
5. family role unavailable 后已有会话的阻断、换模与恢复 UX；
6. API 是否继续沿用 `/api/agents` 命名，或在兼容层上逐步投影为 role contract。

Architecture Gate 已给出数据流、迁移回滚方案、失败模式与测试矩阵；生产 schema 与 seed 改造在 Gate APPROVE 后才开始。

## Stateful Object Census

| Object | Owner | Invariant |
|---|---|---|
| `chat_agents.id` / role ID | role catalog + user | 稳定身份；新模型族 ID 幂等；用户自建 ID 不变。 |
| `chat_agents.role_kind` | role domain | 只能是 `model_family` 或 `custom`。 |
| `chat_agents.model_family` | role domain | family role 必填且 immutable；custom 必须为 null。 |
| `chat_agents.is_default_chat_role` | user settings | 多选、持久、只影响未来新建普通聊天。 |
| `chat_conversation_agents` | conversation | 创建时写入最终确认参与者；之后不追随 defaults。 |
| `chat_messages` / private messages | conversation history | 角色迁移不得删除或重写内容与发送者历史。 |
| memory / summaries / metrics / tasks | respective domains | 不因系统 seed 删除而丢失或误归属。 |
| agentDir `models.json` provider config | model runtime + local-admin user settings | raw secret/reference 不读回；空值保留；显式清除/移除；校验 + old snapshot backup 后 platform-aware 原子替换；移除不删除历史/角色/外部认证；备份默认 TTL=0。 |
| configured model catalog | bootstrap/runtime | family availability 的唯一事实输入，经 registry 归类。 |
| role/profile thinking | role config + runtime | 空值继承 runtime default；非空值必须属于所选模型的 `supportedThinkingLevels`，save/runtime 均验证，不静默 clamp。 |
| old seed identity snapshot | migration/history | 仅用于解释历史，不是隐藏、归档或可运行角色。 |

## Required Test Matrix

| Layer | Red contract |
|---|---|
| Migration | 旧九个 seed 不复活；修改过的 seed 仍移除；自定义角色和全部用户状态保留。 |
| Storage | 两类 role 字段 round-trip；family/custom 校验；多个 defaults 持久化。 |
| API | 系统字段不可覆盖；family 模型越界拒绝；unavailable family 不可设 default/参与会话。 |
| Provider API | list/get 无 plaintext/raw reference/header；empty preserves；clear explicit；remove explicit 且只删 `models.json` 条目；literal/env/command/external/none；local-admin + Origin/Host/JSON/CSRF；validate 不执行 command。 |
| Provider persistence | schema/duplicate validation + old-snapshot backup precede platform-aware atomic replace；Windows directory-sync unsupported 显式建模；secret-bearing backup 权限受限、TTL=0、不进 artifact/Git。 |
| Prompt | family role 不注入 Persona section；custom role 与 profile Persona 继续注入。 |
| Conversation create | defaults 只作为前端预选；API 以最终 participants 为准；无隐式前三名。 |
| Existing conversations | 改 defaults 不改变参与者；旧角色历史仍可读；零活动参与者时明确阻断。 |
| Games | Undercover/Werewolf/自定义 mode 的参与者与 skill 行为无回归。 |
| UI | provider/role 导航、masked key、显式 clear/remove、显式 family、目录来源、分组、锁定字段、unavailable、默认模型、能力感知思考强度、运行 Profiles、custom Persona/Skills、默认多选、新建确认、移动端可用性。 |
| Runtime | 会话 Profile 不能跨 family；thinking 必须受所选模型 `supportedThinkingLevels` 约束；模型消失时阻断而非跨族 fallback。 |

## Non-goals

- 不删除多 Agent、mention、handoff、private message、memory 或游戏模式。
- 不把每个具体模型都建成独立角色；角色粒度是模型族。
- 不移除自定义角色的 Persona Prompt、Skills 或 Model Profiles。
- 不把旧系统预设迁移成 custom，也不把其数据自动嫁接给任一模型族。
- 不建设模型市场、计费平台、OAuth broker，也不发明与 Pi `models.json` 并行的第二套 Provider 配置格式。
- 首版不开放非 loopback 的 Provider mutation/clear/validate；需要远程管理时必须另做有身份认证的安全设计，不能靠打开 `CHAT_APP_HOST` 顺带获得。
- 不在 Design Gate 之前进入 schema、API 或 UI 实现。

## Finish Line

operator 可以先在前端安全配置 provider 与具体模型，再看到这些模型经过显式 family 归类后驱动七个模型族角色的 availability。默认 CAFF 角色不再是预设人格；需要人格化协作时仍可创建自定义角色。新建普通聊天明确展示默认预选并允许最终确认，模型族永远不会跨族运行。旧预设消失，但用户历史、现有 provider 配置与自建角色不会随迁移丢失。
