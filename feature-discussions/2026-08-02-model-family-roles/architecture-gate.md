---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [architecture, roles, model-family, providers, credentials, identity, migration, conversation-policy]
doc_kind: architecture_design
created: 2026-08-02
status: approved_for_implementation
baseline_commit: 455898c
---

# CAFF Model-family Roles — Architecture Gate

> 上级真相源：[Feature Spec](../../feature-specs/2026-08-02-model-family-roles.md)
> 需求与 Gate 入口：[Kickoff and Design Gate](README.md)

## Gate verdict

原 Architecture Gate 曾在 `60234bc` 冻结。operator 随后要求把原本只能后台维护的 provider 配置带到前端，并在 UI 复验时要求补齐思考强度等常用运行字段。本 Gate 因架构、密钥安全与 capability-aware runtime config 边界扩大而重新打开；修订案及 capability fixture correction 已在 `547e8fe` 获跨个体 Architecture/Security delta APPROVE，operator 随后授权进入实现。实现必须继续遵守以下冻结门禁：

1. `[satisfied]` 修订后的 Architecture/Security delta 已由跨个体 reviewer 独立复验；
2. `[satisfied]` provider-inclusive UI 与 runtime-controls 方向已由 operator 验收并授权实现；
3. `[required]` kickoff baseline `chore/main-reconcile@455898c` 不是 canonical main；实现 worktree 必须从 exact `origin/main@b9f3ddf` 重建，并逐项重核本文 Current State anchors。

本 Gate 不修改 schema、seed、API、prompt 或 UI 代码。

## Architecture ownership

```text
Architecture cell: CAFF chat role + conversation domain
Canonical anchors: lib/chat-app-store.ts; storage/chat/*; server/domain/conversation/*
Map delta: none
Why: 本次拆分既有稳定身份与可运行配置，不引入新的跨产品基础设施或第二套 Agent runtime。
```

当前 CAFF 仓库没有 `docs/architecture/ownership/README.md` ownership map；以上以实际代码 owner anchors 代替，不虚构新 cell。

## Evidence and root cause

| Claim | Code evidence at `455898c` | Verdict |
|---|---|---|
| 旧九个预设会在启动时复活 | `lib/chat-app-store.ts:32-180`, `1192-1199` | seed 逻辑必须由七个 family role reconciler 取代 |
| 裸删旧 Agent 会丢用户状态 | `chat_conversation_agents.agent_id` 与 `chat_memory_cards.agent_id` 均 `ON DELETE CASCADE` | P0；不能直接删除父行 |
| 消息已有历史显示快照 | `chat_messages.sender_name`、`chat_private_messages.sender_name` 独立保存；Agent FK 为 `SET NULL` | 消息内容本身不需要复制，但身份关联不能继续依赖活动角色表 |
| Profile 可绕过基础模型 | `agent-executor.ts:450-466` 先取 selected profile，再回落 Agent base config | 保存边界和 runtime 边界都必须验证 family |
| 无模型配置会跨族 fallback | `agent-executor.ts:1223-1225` 对空 provider/model 回落 `PI_*` / Kimi 默认 | family role 必须在 fallback 前 fail closed |
| 模型目录存在自举循环 | `bootstrap-payload.ts:131-137` 把 Agent/Profile 中的值重新加入 model options | 角色配置不能作为 configured model catalog 的事实源 |
| 多类会话共用隐式前三名 | `pickDefaultParticipants()`、starter、Feishu external create 都取列表前 3 个 | store 层 fallback 必须整体删除，参与者政策上移到调用方 |
| Bootstrap 有读请求写副作用 | `buildBootstrapPayload()` 调 `ensureStarterConversation()` | 首次打开页面不得静默创建会话 |
| Thinking 目前是自由文本 | `public/personas.html` 使用 text input；`agent-executor.ts:459` 原样解析；Pi session 最终会按模型能力 clamp | UI、save 与 runtime 必须共享模型的 `supportedThinkingLevels`，不能让持久值和实际运行值分叉 |
| Pi thinking 值域与能力是现成契约 | Pi `ThinkingLevel` 为 `off|minimal|low|medium|high|xhigh|max`；`getSupportedThinkingLevels(model)` 读取 reasoning + `thinkingLevelMap` | 不发明第二套强度枚举，也不把 capability 写死在角色页 |

Capability provenance 固定为仓库 `package.json` 锁定的 `@earendil-works/pi-coding-agent@0.84.3`（`lib/pi-sdk-host.mjs` 的实际 SDK host）及其 nested @earendil-works/pi-ai 0.84.3。根级同版本 `@earendil-works/pi-ai` 仅服务隔离的 digest 完成路径；本机 global CLI 与根级直接依赖都不得用于判断 Agent runtime 的 thinking 值域或模型支持集。

## Frozen decisions

| ID | Decision | Why |
|---|---|---|
| AG-1 | 分离永久 `RoleIdentity` 与活动 `RoleConfig`；`chat_agents` 继续承载可运行配置，新增 `chat_role_identities` 承接永久身份。 | 删除角色配置不再等于删除历史主体，直接消除级联数据丢失坐标。 |
| AG-2 | `chat_conversation_agents` 只表示当前可运行参与者；被移除角色的参会事实写入 `chat_conversation_agent_history`。 | 活动 roster 与历史 roster 语义不能混在同一行。 |
| AG-3 | canonical model catalog 的可见键只来自 `models.json` 和精确 `PI_PROVIDER/PI_MODEL`；runtime registry 只为这些键补标签与能力，Agent/Profile 只是消费者。 | 避免失效引用或 Pi 内建全量目录被误判为“已配置”，让 operator 看到的模型与自己维护的供应商目录一致。 |
| AG-4 | 模型族归类仅通过 `model-family-registry`；未知或冲突模型保持 `family=null`，只能给 custom role 使用。 | 禁止 UI/API/runtime 各写一套字符串包含判断，也禁止跨族猜测 fallback。 |
| AG-5 | family role 只允许配置模型运行参数与聊天默认偏好；Persona Prompt、Persona Skills 和系统身份字段均不可编辑。 | 模型族是模型身份，不是另一层预设人格。 |
| AG-6 | 所有 conversation persistence API 都要求显式 participants；interactive、starter、external channel、game/mode 各自在调用边界解析政策。 | “默认建议”不会在无确认场景里悄悄变成强制参与者。 |
| AG-7 | family role 任一有效模型解析失败时整轮阻断，返回结构化 unavailable 列表；不跳过、不跨族、不回落环境默认。 | 多 Agent 会话中静默少跑一只角色同样会改变用户意图。 |
| AG-8 | 本 Feature 保留 `/api/agents` 路径和 `agentId` 稳定键，内部与 payload 增加 Role contract；不并行制造 `/api/roles` 双写接口。 | API 名称不是用户可见问题，双路由会扩大迁移面且没有产品收益。 |
| AG-9 | provider 连接配置成为独立“模型供应商”管理 surface；它维护连接、认证与模型条目，角色页只消费 `ConfiguredModelCatalog`，不在单个角色详情内编辑 provider。 | provider 是模型可用性的上游，不属于角色身份；把两者塞进同一表单会重新制造配置自举循环。 |
| AG-10 | UI 可录入 API key，但读取接口永不返回明文密钥；空密钥输入保留现有值，清除必须走显式 destructive action；写入当前 agentDir 的 `models.json` 时先校验，再原子替换并保留可恢复备份。 | 浏览器不应获得已有凭据，普通保存不能因空表单意外清密钥，配置损坏必须可回滚。 |
| AG-11 | `ConfiguredModelCatalog` 为每个 option 投影 Pi runtime 计算出的 `supportedThinkingLevels`；role/profile thinking 空值表示继承 runtime default，非空值在 save 与 runtime 两层都必须属于该集合，否则 422/409，禁止静默 clamp。 | 思考强度是模型能力约束下的用户偏好；持久配置必须和实际执行一致。 |

## 1. Domain model

### 1.1 Permanent identity versus runnable configuration

```text
RoleIdentity (permanent, non-runnable ledger)
    1
    └── 0..1 RoleConfig / chat_agents (active, runnable catalog entry)
             ├── model_family
             └── custom

Conversation active roster ──FK──> RoleConfig
Message / private message / memory / retired roster ──FK──> RoleIdentity
```

`RoleIdentity` 不是第三种角色，也不是旧角色归档页。它是历史外键与显示快照的永久主体；只有存在活动 `RoleConfig` 的 identity 才能出现在角色目录、被添加到会话或运行模型。

旧九个 seed 的迁移语义因此是：

- 删除其活动 `chat_agents` 配置；
- 从所有 active conversation rosters 移除；
- 保留不可运行的 identity 与历史参会记录；
- 不转成 custom，不出现在角色管理页，不允许重新激活；
- startup reconciler 永不再次 seed 这些 ID。

这满足 operator 选择的“直接删除”，同时不把用户历史一起删除。

### 1.2 Proposed storage contract

下列是约束用 schematic DDL；`chat_agents_migrated` 中未变化的现有列为节省篇幅省略，实施时必须逐列复制并由 migration test 校验。

```sql
CREATE TABLE chat_role_identities (
  role_id TEXT PRIMARY KEY,
  display_name_snapshot TEXT NOT NULL,
  avatar_data_url_snapshot TEXT,
  accent_color_snapshot TEXT,
  origin_kind TEXT NOT NULL
    CHECK (origin_kind IN ('model_family', 'custom', 'legacy_system')),
  model_family_snapshot TEXT,
  lifecycle_state TEXT NOT NULL
    CHECK (lifecycle_state IN ('active', 'retired')),
  retired_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Existing active configuration table is rebuilt, not ALTERed in place.
CREATE TABLE chat_agents_migrated (
  id TEXT PRIMARY KEY,
  -- existing name/sandbox/description/avatar/persona/model/skill/profile/timestamp columns
  role_kind TEXT NOT NULL
    CHECK (role_kind IN ('model_family', 'custom')),
  model_family TEXT,
  is_default_chat_role INTEGER NOT NULL DEFAULT 0
    CHECK (is_default_chat_role IN (0, 1)),
  CHECK (
    (role_kind = 'model_family' AND model_family IS NOT NULL)
    OR
    (role_kind = 'custom' AND model_family IS NULL)
  ),
  FOREIGN KEY (id) REFERENCES chat_role_identities(role_id) ON DELETE RESTRICT
);

CREATE TABLE chat_conversation_agent_history (
  conversation_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  role_kind_snapshot TEXT NOT NULL,
  model_family_snapshot TEXT,
  model_profile_id_snapshot TEXT,
  conversation_skills_json TEXT,
  sort_order INTEGER NOT NULL,
  joined_at TEXT,
  retired_at TEXT NOT NULL,
  retired_reason TEXT NOT NULL,
  PRIMARY KEY (conversation_id, role_id, retired_at),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES chat_role_identities(role_id) ON DELETE RESTRICT
);
```

最终 FK 归属：

| Table / field | References | Delete policy |
|---|---|---|
| `chat_agents.id` | `chat_role_identities.role_id` | identity `RESTRICT`；配置可单独删除 |
| `chat_conversation_agents.agent_id` | `chat_agents.id` | `CASCADE`，因为它只表示 active roster |
| `chat_conversation_agent_history.role_id` | `chat_role_identities.role_id` | `RESTRICT` |
| `chat_messages.agent_id` | `chat_role_identities.role_id` | `RESTRICT`；user/system message 仍可为 null |
| `chat_private_messages.sender_agent_id` | `chat_role_identities.role_id` | `RESTRICT` |
| `chat_memory_cards.agent_id` | `chat_role_identities.role_id` | `RESTRICT` |

`recipient_agent_ids_json` 继续保存稳定 role IDs；显示时先查 active RoleConfig，再查 RoleIdentity snapshot。summary segments、run/tasks/metrics 中的字符串 ID 不因配置删除改写。

### 1.3 RoleConfig invariants

```text
roleKind = model_family | custom
modelFamily = gpt | claude | gemini | deepseek | qwen | glm | kimi | null
```

- family role：`modelFamily` 必填，stable ID 属于系统保留集合。
- custom role：`modelFamily` 必须为 null，ID 不能使用 `role-family-*` 保留前缀。
- `persona_prompt` 保持 `NOT NULL DEFAULT ''`，但不再要求非空；family 必须保存为空且 runtime 无条件忽略。
- family identity fields 由 startup reconciler 逐次校正；用户配置字段不得被 seed 覆盖。
- custom 删除统一走 `retireRoleConfig()`：先写 identity/history，再删 active config；不再允许 repository 裸删。

## 2. Canonical model-family registry

### 2.1 Ownership and output

新增单一模块：

```text
server/domain/models/configured-model-catalog.ts
server/domain/models/model-family-registry.ts
server/domain/roles/system-role-catalog.ts
server/domain/roles/role-service.ts
```

`ConfiguredModelCatalog` 的每个 option 必须包含：

```ts
type ConfiguredModelOption = {
  key: string;              // provider + U+001F + model
  provider: string;
  model: string;
  label: string;
  source: 'runtime' | 'models_json';
  family: ModelFamily | null;
  familySource: 'explicit' | 'provider_alias' | 'model_alias' | 'unknown' | 'conflict';
};
```

角色、API、UI、runtime 都消费这个结果，不自行归类。

### 2.2 Classification precedence

1. `models.json` 单个 model 的可选 `family` 显式字段，且必须是七个 enum 之一；
2. 无显式字段时，registry 分别计算 provider alias 与 anchored model alias；
3. 两者同族则采用该 family；只有一方命中则采用命中值；
4. 两者异族返回 `null + conflict`；均未命中返回 `null + unknown`。

首版 provider aliases：

| Family | Provider aliases |
|---|---|
| GPT | `openai`, `openai-codex` |
| Claude | `anthropic`, `claude` |
| Gemini | `google`, `google-gemini`, `gemini` |
| DeepSeek | `deepseek` |
| Qwen | `qwen`, `dashscope`, `alibaba`, `aliyun` |
| GLM | `glm`, `zhipu`, `bigmodel` |
| Kimi | `kimi`, `kimi-coding`, `moonshot` |

`openrouter`、`ollama`、`lmstudio`、`openai-compatible`、`packycode` 与空 provider 都视为 generic；它们只能通过显式 family 或 anchored model alias 归类。

model alias 规则必须在 registry 内以 anchored matcher 表达，例如 `gpt-*`、`claude-*`、`gemini-*`、`deepseek-*`、`qwen*`/`qwq*`、`glm-*`、`kimi-*`、`k2`/`k2.*`。禁止任意 `includes('glm')` 一类宽松判断。

### 2.3 Unknown and conflict behavior

- unknown model 仍出现在 custom role 可选目录；
- unknown/conflict model 不出现在任何 family role 的可选列表；
- 已保存 family base/profile 变成 unknown 或异族后，role availability 变为结构化错误；
- 不自动改写为“看起来最像”的 family，不跨族 fallback；
- UI 展示 `未归类` / `归类冲突` 及来源，operator 可在 `models.json` model entry 上补显式 `family`。

### 2.4 Break the catalog cycle

`buildConfiguredModelOptions()` 不再读取 `store.listAgents()`。角色保存的 provider/model/profile 是对 catalog key 的引用，不是“该模型已配置”的证据。

Catalog 可见来源只包括：

- 当前有效 `models.json` entries；
- `PI_PROVIDER` + `PI_MODEL` 的精确 runtime default。

Pi/runtime registry 是 metadata lookup，不是第三个可见来源：它只为上述可见键提供 display label 与 `supportedThinkingLevels`，registry-only 键不得进入 bootstrap、角色页或聊天模型 selector。

每个 catalog option 除 `key/provider/model/label/source/family` 外还必须携带 `supportedThinkingLevels`。该字段由 Pi runtime model metadata 的 `reasoning` 与 `thinkingLevelMap` 计算；无 reasoning 的模型只返回 `['off']`。CAFF 不在 UI 或角色表中复制一份模型能力表。

### 2.5 Provider configuration boundary

```text
Provider connection
  → configured model entries
  → family classification / availability
  → model-family role selection
```

“模型供应商”管理面维护当前 agentDir 下 `models.json` 的 provider 配置：provider ID / display name、`baseUrl`、API 协议、认证方式、`authHeader`、模型条目以及每个模型可选的显式 `family`。角色管理面不写 provider 连接，只显示 catalog 产生的模型选项与 availability 来源。

首版表单必须支持 Pi 已有配置语义，不另造 provider schema：

- API protocol 至少覆盖现有 `openai-completions`、`openai-responses`、`anthropic-messages` 等字符串值；
- API key 支持 literal、`$ENV_VAR` / `${ENV_VAR}` 环境引用与 `!command` 命令引用；环境/命令引用放在“高级认证”中，但不得被普通保存降级成明文或通过读取接口回显原始 reference；
- model entry 至少编辑 `id`、display name、protocol override（可选）与显式 `family`；cost/compat/context 等现有字段在 round-trip 时必须保留，即使首版 UI 不全部展开；
- 新增或编辑后先做 schema 与重复 key 校验，再提供连接/模型验证；验证失败不得覆盖现有有效文件。
- 已存在于 `models.json` 的 provider 可以通过独立移除动作删除；确认态必须显示 provider ID、模型数量与当前引用这些模型的 roles。未保存草稿可直接放弃，但不能把清空表单伪装成移除成功。

#### Credential-blind read contract

`GET /api/model-providers` 返回 provider metadata、`hasApiKey`、`hasExternalAuth`、`apiKeyMode=literal|env|command|external|none` 与模型条目，但读取接口永不返回明文密钥、原始 env/command reference 或 credential-bearing custom header。literal/env/command 一律只显示“已保存 + mode”；因为 `!command` 可在参数中内嵌 token，不能假定 command string 本身无 secret。未由 `models.json` 持有的 `/login` / `auth.json` / CLI auth 只投影为 `external` 状态，本 Feature 不读取或删除其 secret。

写契约：

- 普通 create/update payload 中 `apiKey` 缺失或空字符串均表示“留空保留现有密钥”；新 provider 无既有 secret 时则保持未配置；
- 设置新 literal、env 或 command reference 是显式写操作；输入只存在于 mutation request，响应仍只返回 redacted state；切换 mode 但未提供新值必须拒绝，不能把旧值按新 mode 解释；
- 清除已有 secret 必须通过独立的显式清除动作（例如 `DELETE /api/model-providers/:id/secret`）并在 UI 二次确认，不能复用空输入；
- 移除 provider 必须走独立的 `DELETE /api/model-providers/:id` + UI 二次确认，只删除当前 agentDir `models.json` 中对应 provider 条目并触发 catalog/availability 重算；不删除角色身份、历史聊天、消息、记忆，也不删除 `auth.json` / CLI 等外部认证。被移除模型的现有 role config 保留引用并变为结构化 unavailable，不静默换模；
- 日志、错误、测试 snapshot、bootstrap payload 与浏览器 state 禁止出现 plaintext secret；错误只报告 provider ID 与字段路径。

#### Privileged HTTP boundary

Provider read/create/update/remove/clear/validate API 把原本需要本地文件权限的配置与网络探测能力暴露给 HTTP，首版因此是 **local-admin-only**：

- 只有当 configured listen host 与请求 socket address 都是 loopback 时才注册或放行 provider 管理 API；`CHAT_APP_HOST` 为非 loopback 时返回 403 + `provider_config_local_only`，普通聊天与 credential-blind catalog 不受影响；
- mutation / clear / validate 必须使用 JSON、严格匹配本服务的 `Origin` + `Host`，并携带 bootstrap 生成的 per-process CSRF token；不启用 CORS，也不信任 forwarded host/address；
- `!command` 是 operator 明确选择的 runtime code-execution 能力，设置/替换时使用 danger confirmation；bootstrap、GET 与“验证连接”都禁止执行 command，只有实际 Pi model runtime 按既有规则解析；
- Base URL 验证是 privileged SSRF surface：使用短 timeout、响应体上限、零 redirect，并只返回状态分类；不得把响应 body/header、request secret 或 resolved credential 写入日志/响应；
- 该边界必须以非 loopback host、非 loopback socket、foreign/missing Origin、bad Host、missing/wrong CSRF、form content type、redirect 与 command-not-executed 契约测试覆盖。

#### File ownership and recovery

服务端只写 runtime 当前解析到的 agentDir `models.json`；bootstrap 的其他 read fallback 不得被误当写目标。若 resolved agentDir 本身就是仓库 `.pi-sandbox`，则它仍是合法唯一目标；关键是不跨环境或根据“哪个文件存在”猜写入位置。

保存与 provider 移除流程由 platform-aware `atomicReplaceModelConfig()` 统一承担：读取 current snapshot → 应用 redacted-aware patch → 校验完整文档 → 从 current snapshot 写出带时间/校验和的可恢复备份并 fsync → 写同目录临时文件并 fsync → 原子替换。POSIX 在替换后 fsync parent directory；Windows 使用受测试的 replace/rename 路径，目录 fsync 的 `EPERM` / `EINVAL` / `ENOTSUP` 视为平台不支持，不能把已完成替换反报为失败。替换前的备份或校验任一步失败都不得改动原文件；替换后的结果必须明确区分 `durable` 与 `directory_sync_unsupported`，不得假装 rollback 仍可撤销已完成替换。

备份可能包含 literal secret，必须继承原配置的受限权限，禁止进入 HTTP 响应、日志、测试 artifact 或 Git；它属于用户可恢复配置，默认无 TTL，只能由用户明确清理。

## 3. Editable field boundary

| Field/capability | `model_family` | `custom` |
|---|---:|---:|
| Stable ID / kind / family / display name / icon / accent | system locked | user controlled（kind/family 除外） |
| Description | system locked，说明模型族而非人格 | user controlled |
| Sandbox name | system locked，由 stable ID 派生 | user controlled |
| Base provider/model | 可配置，但只能从同 family catalog 选择；provider 由 option 派生 | 可配置任意 configured model |
| Thinking | 可配置；空值继承，非空值必须属于当前 model `supportedThinkingLevels` | 同左 |
| Model Profiles | 允许 `name/description/provider/model/thinking`；同 family；禁止 profile Persona | 保留全部现有字段与跨 family 自由度 |
| Persona Prompt | 强制空，runtime 不注入 | 可选，继续注入 |
| Persona Skills | 强制空，不注入 | 保留现有能力 |
| Conversation/mode Skills | 允许，来自会话或 mode，而非 family 全局身份 | 允许 |
| `isDefaultChatRole` | 可配置；有效 default 还要求 role runnable | 可配置；有效 default 还要求 role runnable |
| Delete | 禁止 | 允许，但使用 identity-preserving retire flow |

family role 的 Profiles 是“模型运行预设”，不是“模型专属人格”。字段名/API 可暂时沿用 `modelProfiles`，但 family profile 的 `personaPrompt` 输入必须 422 拒绝，不能只在 UI 隐藏。角色页必须显式展示 base model、base thinking 与 Profile 的 `name/description/model/thinking`；custom 继续展示 Profile Persona。Provider 仍由选中的 catalog option 派生，不让用户手填出 provider/model 不一致组合。

Thinking 输入必须是 capability-aware select，而非自由文本：选项集合为“跟随运行时默认”加当前模型的 `supportedThinkingLevels`。切换模型后，若原 thinking 不再受支持，UI 必须回到继承态并提示，不得自动换成“最接近”的强度；直接 API 保存不受支持值返回 422 `thinking_level_unsupported`。

## 4. Availability and runtime enforcement

### 4.1 Availability state

```ts
type RoleAvailability =
  | { status: 'available'; familyModelCount: number }
  | { status: 'no_family_models'; familyModelCount: 0 }
  | { status: 'default_model_missing'; familyModelCount: number }
  | { status: 'default_model_out_of_family'; familyModelCount: number; modelKey: string }
  | { status: 'profile_model_missing'; familyModelCount: number; profileId: string }
  | { status: 'profile_model_out_of_family'; familyModelCount: number; profileId: string };
```

family role 要成为可选参与者，必须拥有有效的同族 base model。Profiles 只是会话级替代项，不能代替缺失的 base model 掩盖默认运行路径。

### 4.2 Three enforcement points

1. **Save boundary**：family base/profile key 必须存在且同族；base/profile thinking 必须为空或属于对应 model `supportedThinkingLevels`；system fields / Persona / Skills 越界返回 422。
2. **Conversation participant boundary**：unavailable role 或非法 profile 不能写入 active roster。
3. **Runtime boundary**：每轮重新用最新 catalog 验证 effective provider/model；验证失败在创建 assistant placeholder 和 run task 之前返回 409。

第三层不能复用当前 `resolveSetting(..., PI_PROVIDER, DEFAULT_PROVIDER)` fallback。family role 的 effective model 解析是：

```text
selected valid same-family profile
  OR valid same-family base model
  OR structured failure
```

custom role 继续使用现有 fallback 契约，但失效 profile 仍应显式标记，不应把已选择 profile 静默降级为 base model。

### 4.3 Existing conversation recovery

- conversation payload 给每个 active participant 返回 `availability`；
- 任一 active participant unavailable 时，普通发送整轮 409，响应列出 role ID、显示名、原因与可恢复动作；
- 用户可在会话设置里：修复 family 全局 base model、切换同族 profile、或显式移除该参与者；
- 修复配置后无需迁移 conversation row，下一次 runtime validation 自动恢复；
- 旧 seed 在迁移时退出 active roster。若会话因此零 active participant，沿用并细化现有“至少添加一个角色”阻断，同时展示历史参会身份；
- 不静默跳过 unavailable role，不自动替换为新 family role。

## 5. Conversation participant policies

### 5.1 Store boundary

删除 `pickDefaultParticipants()`。`createConversation()`、`getOrCreateExternalConversation()` 与 transaction 层都要求调用方传入显式、已验证、非空 `participants`；store 不知道 defaults、channel 或 game 规则。

### 5.2 Policy matrix

| Creation path | Participant source | Empty behavior | Uses `isDefaultChatRole`? |
|---|---|---|---|
| Interactive `standard` | UI 打开创建流程时读取一次 runnable defaults，用户增删后提交最终 IDs | UI 不提交；API 400 | 只用于预勾选 |
| Bootstrap / starter | 不再自动创建 starter conversation；无会话时返回 `selectedConversationId=null` 并打开创建入口 | 不写 DB | 否 |
| Existing external binding | 沿用该 conversation 已有 active roster | 无 active roles 时拒绝 dispatch 并返回配置提示 | 否 |
| New external chat / Feishu `/new` | adapter 的显式 `defaultRoleIds` policy；首版由 Feishu 配置提供 | 未配置或无 runnable roles 时不创建 conversation，向外部 channel 返回 setup-required | 否 |
| Undercover / Werewolf | game creation UI 显式提交玩家；host 继续使用该 roster | 不创建房间 | 否 |
| Custom mode | mode UI/调用方显式提交参与者，再合并 mode skills | API 400 | 否 |
| Direct API caller | payload 中的最终 participants | API 400 | 否 |

`isDefaultChatRole` 是交互式创建建议，不是后台自动分配策略。外部 channel 若复用它，就会把 operator 明确选择的“提交前确认”偷偷改成自动写入，因此禁止复用。

### 5.3 Bootstrap purity

`GET bootstrap` 只读：

```text
buildBootstrapPayload()
  -> list roles + availability
  -> list conversations
  -> selectedConversationId = first existing or null
  -> no ensureStarterConversation()
```

## 6. Prompt and skill behavior

### `model_family`

- Workspace Identity 显示系统模型族名与实际 effective model；
- 增加固定声明：“这是模型族身份，不模拟虚构人格”；
- 不生成 `Private Persona Instructions` section；
- 不解析/注入 Persona Skills；
- conversation/mode skills、routing rules、memory、sandbox 与协作工具继续工作；
- routing rules 中的 “Stay consistent with your persona” 改为中性 “Stay consistent with this role's configured identity and instructions”。

### `custom`

- 当前 public description、Persona Prompt、Persona Skills、Profiles 行为保持；
- Profile Persona 仍可覆盖 base Persona；
- 不限制 family，但 selected model 必须满足现有 runtime 可解析契约。

## 7. API contract and write protection

本 Feature 保留 `/api/agents` 与响应字段 `agents`，避免同时维护两套 CRUD。每个对象新增：

```ts
{
  id,
  roleKind,
  modelFamily,
  isDefaultChatRole,
  systemManaged,
  availability,
  editableFields,
  // existing fields
}
```

写入规则：

- `POST /api/agents` 只能创建 custom；传 `roleKind=model_family`、保留 ID 或非空 `modelFamily` 返回 422；
- `PUT /api/agents/:familyId` 只接受白名单配置字段；修改 locked field、Persona、Persona Skills 或跨族模型返回 422；
- role/profile thinking 为空表示继承；非空但不在 catalog option `supportedThinkingLevels` 中返回 422 `thinking_level_unsupported`，不能依赖 Pi session 的后置 clamp 代替输入校验；
- `DELETE /api/agents/:familyId` 返回 405/409；
- custom PUT 保留现有字段，`roleKind/modelFamily` 不可变；
- custom DELETE 调 `retireRoleConfig()`，不得直接 repository delete；
- `POST /api/conversations` 要求显式非空 participants，且对 role availability/profile 再校验；
- bootstrap 与 `/api/agents` 复用同一 catalog/availability service，禁止各自计算。

服务器对非法系统字段必须拒绝并返回 issue code，不做 silent ignore；否则旧客户端或手写请求会误以为保存成功。

## 8. Migration design

### 8.1 Preflight

1. 只在最终 canonical main 上重新扫描表结构、FK、seed IDs 与所有 conversation creation call sites；
2. 对文件型 SQLite 使用 `better-sqlite3` backup API 创建不覆盖的 `*.pre-model-family-roles.<timestamp>.bak`；`:memory:` 测试库跳过；
3. 记录 `chat_schema_migrations` pending ledger：migration ID、backup path、pre-counts、started_at；
4. backup 失败则 fail closed，不进入 schema transaction。

### 8.2 One exclusive migration transaction

SQLite table rebuild 在 repositories 初始化前执行：

1. 建 `chat_role_identities`，为所有现有 `chat_agents` backfill identity；旧九个标 `legacy_system`，其余标 `custom`；
2. 重建 `chat_agents`，补 `role_kind/model_family/is_default_chat_role` 与 CHECK；所有非旧 ID 角色原字段逐列原样迁移为 custom；
3. 建 `chat_conversation_agent_history`，把旧九个 ID 的全部 active participation rows 写入历史表；
4. 重建 messages/private messages/memory cards 的 identity FKs；数据逐列复制，不改变 ID、内容、sender、时间、metadata、status；
5. 删除旧九个 active configs；其 active participation rows 随 active config 移除，但历史 rows 已存在；
6. 由 `system-role-catalog` 幂等创建七个 family identities/configs；locked fields 使用代码常量，用户配置字段只在首次创建时初始化；
7. 重建 FTS triggers/indexes；
8. 运行 `PRAGMA foreign_key_check` 和 migration audit；任一不一致抛错，整个 transaction rollback；
9. ledger 标记 completed，重新开启 FK，启动 repositories。

禁止在 migration 中把旧 role ID 映射到任一新 family ID。

### 8.3 Required audit assertions

| Assertion | Expected |
|---|---|
| conversations/messages/private messages/summary segments/external events counts | 与迁移前相同 |
| message/private content + sender name + timestamps hash | 与迁移前相同 |
| memory card total count and per old role ID count | 与迁移前相同 |
| non-legacy custom role rows and profile/skill JSON | 逐字段相同，仅新增 role columns |
| active legacy config count | 0 |
| active legacy participant count | 0 |
| legacy history row count | 等于迁移前 legacy participant count |
| seven family config count | 7，stable IDs 精确匹配 spec |
| unknown IDs | 不改写、不删除 |
| restart after migration | 不复活旧 seeds，不重复 history rows |

### 8.4 Rollback

- transaction 内失败：SQLite rollback，原 DB 原样保留；
- transaction 成功但 acceptance 失败：停应用，使用 migration ledger 指向的 backup 恢复；该路径会丢弃 migration 后的新写入，因此真实数据迁移前必须先在隔离副本跑完整 acceptance；
- rollback 后旧 binary 可继续使用，七个 family role 不做跨版本逆向投影；
- backup 是用户可恢复数据，默认不设 TTL、不自动删除，由用户明确清理。

## 9. Failure-mode audit

| Failure mode | Guard / observable result |
|---|---|
| 裸删 old seed 触发 cascade | 旧 ID 删除只存在于 migration transaction；count/hash audit fail closed |
| 用户修改过 system ID 被误当 custom 保留 | 迁移按精确 ID 集合判断，不看内容是否修改 |
| 普通 custom ID 被误删 | 删除集合只有 spec 九个 ID；fixture 含相似名称与相似前缀 |
| family role 空模型回落 Kimi | family effective model resolver 不调用通用 env fallback |
| Profile 跨族绕过 | save、participant、runtime 三层验证 |
| Agent/Profile 把失效模型重新塞回 catalog | catalog 禁止读取 role configs |
| provider/model alias 冲突时误归类 | conflict 返回 unknown；无 first-match wins |
| provider GET/bootstrap 泄露已有 API key | API DTO credential-blind；只返回 `hasApiKey` / `hasExternalAuth` / mode；secret absence snapshot tests |
| env/command reference 自身内嵌 secret | 所有 raw auth reference 都不进 read DTO/browser；只返回 mode + configured state |
| LAN/CSRF 调用 provider mutation/validate | local-admin-only host + socket guard；strict Origin/Host + JSON + CSRF；无 CORS/forwarded trust |
| validate 触发 command RCE 或无界 SSRF | validate 不执行 command；短 timeout、body cap、零 redirect、redacted result |
| custom headers / backup 旁路泄密 | credential-bearing headers 不进 DTO；backup 同目录受限权限、禁止日志/artifact/Git |
| 空密钥输入误清除已有凭据 | update 将 missing/empty 解释为 preserve；清除使用独立 destructive action |
| provider 表单覆盖未展示的 compat/cost 字段 | 服务端对完整 snapshot 做 patch merge，round-trip 测试断言未知保留字段不丢失 |
| 无效 provider 配置破坏运行时 | 完整校验 + old snapshot backup 通过后才原子替换；替换前失败保留原文件；可恢复备份默认无 TTL |
| Windows directory fsync `EPERM` 导致替换后假失败 | platform-aware replace；unsupported directory sync 返回显式 durability 状态；Windows real-fs contract |
| UI 写错 agentDir 或 read fallback 文件 | runtime 内部解析唯一 write target；路径归属测试覆盖 default、`PI_ENV` 与额外 read fallback |
| UI 隐藏字段但 API 仍可覆盖 | server whitelist + 422 contract tests |
| UI 保存 unsupported thinking，runtime 静默 clamp | catalog capability DTO + save/runtime 双验证；422/409，不允许静默 clamp |
| defaults 修改已有会话 | conversation participants 是创建时快照，无 defaults FK/trigger |
| external channel 偷用 interactive defaults | adapter policy 独立，缺配置 fail closed |
| starter bootstrap 静默写会话 | bootstrap purity test 断言 DB count 不变 |
| unavailable participant 被静默跳过 | submit 前整轮 409，响应列出全部 blockers |
| custom 删除继续丢 memory | 所有删除统一 identity-preserving retire flow |
| migration 重跑重复历史 | migration ledger + history unique key + restart fixture |
| backup 自动过期 | 无 TTL；只允许用户主动删除 |

## 10. Red → Green test matrix

| Slice | Red contract | Primary test home |
|---|---|---|
| Registry | 七族 aliases、generic provider、explicit family、unknown、conflict；UI/API/runtime 得到相同 family | `tests/runtime/model-family-registry.test.js` |
| Catalog | runtime/models.json/env 是来源；Agent/Profile 不可把 stale model 变成 configured；每个 option 投影 Pi `supportedThinkingLevels` | `tests/runtime/configured-model-catalog.test.js` |
| Provider config | credential-blind GET（含 raw reference/header absence）；empty-preserve；显式 clear；literal/env/command round-trip；显式 remove 只删 `models.json` 条目并保留历史/外部认证；local-admin/Origin/Host/CSRF boundary；validation never executes command；unknown fields preserved | provider API/runtime tests |
| Provider persistence | resolved agentDir only；validation + old-snapshot backup before atomic replace；POSIX directory sync；Windows unsupported directory sync + crash/failure injection | provider config persistence tests on Windows + POSIX CI |
| Storage | role columns round-trip；CHECK；identity persists after config retirement；family/custom field normalization | `tests/storage/chat-store.test.js` |
| Migration | unmodified seed、modified seed、自建角色、消息、私信、memory、summary、external/game data；count/hash 与 restart idempotency | `tests/storage/model-family-role-migration.test.js` |
| API write protection | family locked fields/Persona/Skills/delete/cross-family model reject；unsupported base/profile thinking 422；custom CRUD preserved | `tests/smoke/server-smoke.test.js` |
| Defaults | multiple defaults persist；unavailable default cannot be newly enabled；defaults do not mutate existing rooms | storage + smoke |
| Conversation create | interactive payload is final truth；missing/empty participants reject；no first-three fallback | smoke + UI |
| Starter | empty DB bootstrap performs zero conversation writes and returns null selection | smoke |
| External | bound room keeps roster；new Feishu room requires explicit adapter role policy；no interactive defaults reuse | `tests/http/feishu-controller.test.js`, `tests/runtime/feishu-delivery.test.js` |
| Games/modes | explicit players retained；mode skills merge without injecting defaults；Undercover/Werewolf behavior unchanged | existing game/mode tests |
| Prompt | family has no Persona section/Persona Skills；custom and custom profile Persona continue | turn orchestrator / prompt tests |
| Runtime | selected profile and base model same-family validation；thinking 与当前模型能力一致且不静默 clamp；model removed/conflict returns structured blocker before run creation | turn orchestrator / executor tests |
| Existing history | old messages/private recipients/historical roster render after active config deletion；zero active roster blocks send | storage + UI |
| UI | provider/role surface switch、masked secret state、model family classification、system/custom groups、locked fields、capability-aware thinking、运行 Profiles、custom Persona/Skills、availability、multiple defaults、participant confirmation、mobile error state | UI tests + Design Gate screenshots |

## 11. Implementation slices after both Gates

1. **Provider config + registry/catalog Red→Green** — credential-blind API, safe `models.json` persistence and catalog classification；no schema changes yet.
2. **Identity/schema migration Red→Green** — isolated DB fixtures, backup/rollback and audit first.
3. **Role service + API protection** — system reconciler, custom retire flow, availability payload.
4. **Participant policies** — remove store fallback, bootstrap purity, external/game explicit policies.
5. **Runtime/prompt enforcement** — family fail-closed, Persona/Skills branching.
6. **UI implementation** — only after provider-inclusive UI Design Gate, using frozen payloads above.
7. **Full regression + isolated acceptance** — provider backup recovery, migration copy, games, Feishu, existing histories, mobile/desktop.

每个 slice 必须先有失败测试；migration slice 未绿前，不允许删除旧 seed logic。

## Open Questions

没有需要 operator 立即拍板的技术 A/B。operator 已决定 provider 应可从前端配置；本修订把它落实为独立管理 surface 与 credential-blind persistence contract。外部 channel 缺显式 participant policy 时仍 fail closed，不另行把建议语义扩大为后台自动策略。

修订 Architecture Gate 需要跨个体 architecture/security review；UI Design Gate 仍需 operator 确认 provider 页面布局、密钥交互、角色页关系及移动端流程。

## Meta-aesthetics check

本方案采用两次坐标变换：把“Agent 行既是永久身份又是可删运行配置”拆成 identity ledger + active config；再把“角色表单顺便承载 provider”拆成 provider connection → catalog → role selection 的单向数据流。没有为九个 seed 分别加例外，也没有让角色反向成为模型配置事实源。

## Convergence check

1. 否决理由 → ADR？有：否决“保留旧 `chat_agents` 行并加 hidden/archived 标记”，因为违背 operator 的直接删除选择，也继续混淆活动角色与历史身份。本 Feature 当前没有正式 ADR 目录约定，否决理由保留在本 Gate。
2. 踩坑教训 → lessons-learned？没有新增跨项目通用教训；P0 cascade 与 catalog 自举循环已在本 Gate failure-mode audit 固化。
3. 操作规则 → 指引文件？没有；未新增跨 Feature 家规。

[砚砚/gpt-5.6-sol🐾]
