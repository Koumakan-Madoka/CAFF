---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [roles, model-family, providers, credentials, ui, design-gate, responsive, participants]
doc_kind: design_gate
created: 2026-08-02
status: approved_for_implementation
---

# CAFF Model-family Roles — UI Design Gate

## Status

operator 认可首版视觉后要求增加前端 provider 配置；provider-inclusive 版本复验时又指出角色详情缺少思考强度等常用可配置字段。Kimi capability 示例及同类手写条目已按 repo-pinned Pi 真值完成 failure-mode sweep，修正版 `547e8fe` 获跨个体 delta APPROVE；operator 随后授权进入实现。本文与 [交互 fixture](../../designs/model-family-roles-ui-gate.html) 只冻结产品交互，生产 schema、API、seed、prompt 与 UI 按实施计划分段 TDD。

Architecture cell: CAFF chat role + conversation domain

Map delta: none

Why: 本次在 role payload、availability 与 participant policy 上增加其上游 provider connection 管理；仍落在同一 management shell，但 provider 与角色保持独立 owner boundary。

## Sources Read

- `public/personas.html:17-165`：当前管理页为固定 rail + index/detail 双栏；人格编辑器把 Persona Prompt、Skills 与 Model Profiles 放在同一表单。
- `public/personas.js:336-366`：当前人格列表是单一未分组集合。
- `public/index.html:49-63`：当前新建聊天是 280–320px 侧栏里的标题/类型快速表单。
- `public/app.js:3805-3840`：当前提交只发送 `title` 与 `type`，没有参与者确认。
- `public/chat/conversation-settings.js:510-601`：已有会话设置中存在可复用的角色多选卡片与 Profile 展开交互。
- `public/styles.css:3623-3950`：管理页桌面双栏、移动单栏和独立滚动 owner。
- `public/styles.css:3969-4068, 4208-4580`：v7 Light/Dark token、实底、细边框、6–12px 圆角、线性 SVG 与 44px 触控目标。
- `designs/caff-ui-redesign-brief.md`：AppShell、管理页响应式与“减少 AI 模板感”的既有设计真相。
- `server/api/bootstrap-payload.ts:89-142`：当前模型目录读取 agentDir `models.json`，并错误混入 Agent/Profile 反向来源。
- `lib/pi-runtime.ts`：runtime 当前 agentDir 解析规则。
- 仓库锁定的 `@earendil-works/pi-coding-agent@0.80.10`（由 `lib/pi-sdk-host.mjs` 加载）及其 nested @earendil-works/pi-ai：Agent runtime 的模型与 thinking capability 权威来源；本机 global CLI 和根级旧 `@mariozechner/pi-ai` 不是本 Gate 的 capability source。
- `@earendil-works/pi-coding-agent/docs/models.md`：`models.json` provider/model 字段，以及 literal、env、command 三种 API-key value syntax。
- nested `@earendil-works/pi-ai` 的 `getSupportedThinkingLevels(model)`：全局用户值域包含 `off/minimal/low/medium/high/xhigh/max`，具体模型选项受 model reasoning / `thinkingLevelMap` 约束；fixture capability 已按该 pinned package family 做 snapshot audit，生产实现仍从 catalog DTO 读取而不复制这张表。
- `lib/chat-app-store.ts:293-322`、`server/domain/conversation/turn/agent-executor.ts:451-460`：CAFF base/profile 真实运行字段为 provider/model/thinking，custom profile 另有 Persona；provider 由 model option 派生。
- [Architecture Gate](architecture-gate.md)：provider credential-blind persistence、role kind、system field protection、availability、defaults snapshot 与显式 participants 契约。

## Design Direction

### 1. 模型供应商：同一 management shell 内的独立 surface

Provider 是模型目录的上游，不塞进某个角色详情，也不伪装成第八种角色。主导航中的“模型供应商”进入 provider index/detail：

```text
┌ rail ┬ 模型供应商 300px ┬ Provider 详情 ─────────────────────┐
│      │  OpenAI      正常  │ Provider ID / 名称                │
│      │  Anthropic   正常  │ Base URL / API 协议 / Auth Header │
│      │  阿里云    待验证  │ API Key：已保存（输入框为空）       │
│      │                  │ [高级认证：env / command reference] │
│      │  + 添加供应商     │ 模型条目：ID / 名称 / 模型族归类      │
│      │                  │ [验证连接] [保存更改] [显式清除密钥]  │
└──────┴──────────────────┴─────────────────────────────────────┘
```

- provider row 展示连接状态与模型数；详情表单覆盖 Provider ID、名称、Base URL、API 协议、认证模式与 Auth Header。
- 已有 API key 只显示“已保存”，password 输入始终为空；留空保存保留现有密钥，不制造看似可编辑的 masked value。
- “清除已保存密钥”使用 danger action + 二次确认，与普通保存分离；fixture 只演示状态，不持久化任何值。
- API key 高级模式允许新设 Pi 支持的 `$ENV_VAR` / `${ENV_VAR}` 和 `!command` reference，但已有 reference 与解析值都不回显，只显示 configured + mode；`auth.json` / CLI 等外部认证只显示状态，且不能由本页清除。
- 设置/替换 `!command` 使用 danger confirmation；连接验证明确不执行 command。Provider mutation/validate 首版 local-admin-only，非 loopback 部署显示只读阻断原因。
- 模型表每行显示 model ID、名称、显式“模型族归类”与有效性；family 是七族 enum 或未归类，不通过角色名倒推。
- “验证连接”与“保存更改”分开：operator 能先校验 endpoint/auth/model，不把一次网络失败等同于覆盖配置。
- “移除供应商”是详情页独立 danger action：确认态显示模型数量与 role availability 影响，并明确历史聊天、角色身份和外部认证不删除；未保存 provider 使用“放弃草稿”。
- 此 surface 只维护 `models.json` provider；runtime registry 与 `PI_PROVIDER/PI_MODEL` 作为聚合 catalog 的只读来源。角色页只消费聚合结果，并提供“管理模型供应商”入口。

### 2. 角色管理：保留 index/detail，按角色类型分组

不新建第二套“模型中心”，继续使用现有角色管理页：

```text
┌ rail ┬ 角色目录 300px ┬ 角色详情 ─────────────────────────┐
│      │ 系统模型族      │ GPT · 系统模型族 · 可运行         │
│      │  GPT      默认  │ [系统身份：只读字段]              │
│      │  Claude   默认  │ [默认模型 / 思考强度]             │
│      │                  │ [运行 Profiles：模型 / 思考强度] │
│      │  Qwen   不可用  │ [新聊天默认开关]                  │
│      │ 自定义角色      │                                   │
│      │  架构评审 默认  │ custom 时显示完整 Persona 编辑器  │
└──────┴─────────────────┴───────────────────────────────────┘
```

- 左侧目录分为“系统模型族”和“自定义角色”，不再把两类角色混成一列。
- 系统族始终可进入详情检查；unavailable 不是隐藏，而是明确标记原因。
- 系统详情开放同族默认模型、中文“默认思考强度” select、运行 Profiles 与聊天默认开关；稳定 ID、类型、family、名称、头像、颜色均显示为系统维护。
- thinking 不再是自由文本：空选项表示跟随 runtime default，其余只列当前模型 `supportedThinkingLevels`。切换模型导致原值不支持时回到继承态并提示，不悄悄夹成相邻强度。
- family Profile 显式编辑名称、说明、同族模型和思考强度，不显示 Persona；“添加 Profile”真实增加空草稿并把焦点移入名称。
- custom 详情完整显示默认模型/思考强度、跨族 Profiles、Profile Persona、默认 Persona Prompt 与 Skills，不再只用一句“生产中保留”代替可验收设计。
- default 使用一个明确开关，并同步在目录行显示小圆点；开关文案强调“只预选未来新建聊天”。

### 3. 新建聊天：快速表单升级为单页确认 dialog

原侧栏宽度不足以安全容纳 7 个模型族、自定义角色、不可用原因和多选校验。新设计把侧栏内联表单替换为单一“新建聊天”按钮，桌面打开 880px dialog，移动端打开全屏 sheet：

```text
┌ 新建聊天 ──────────────────────────────────────── × ┐
│ 基本信息 280px       │ 确认参与角色                 │
│ 标题                 │ 系统模型族                   │
│ 类型：普通聊天       │ [✓ GPT 默认] [✓ Claude 默认] │
│                      │ [  Gemini]   [× Qwen 不可用] │
│ 创建快照说明         │ 自定义角色                   │
│                      │ [✓ 架构评审 默认] [ 翻译助手]│
├──────────────────────┴─────────────────────────────┤
│ 已选择 3 位角色                     [取消] [创建] │
└────────────────────────────────────────────────────┘
```

- 标题、类型和参与者在一个页面完成，不引入多步骤 wizard。
- fixture 中角色管理页的按钮只用于让 operator 快速打开设计状态；生产入口仍替换聊天侧栏原来的标题/类型快速表单。
- 打开 dialog 时读取一次 runnable defaults；defaults 是预勾选标签，不是锁定选择。
- 取消、遮罩关闭或 Escape 都不写数据。
- dialog 打开时背景 AppShell `inert`，焦点进入标题输入；Tab/Shift+Tab 在 dialog 内圈禁，关闭后焦点归还触发按钮。
- 普通聊天至少选择一位可用角色；清空后就地显示错误且禁用创建。
- unavailable 角色仍显示，但 checkbox disabled，并给出原因。
- 游戏类型不消费这组 defaults；选择游戏时，参与者区替换为“使用该模式自己的玩家配置流程”。

## Design-in-Context Checklist

- [x] 读过目标页面实际组件代码：见 Sources Read 路径与行号。
- [x] 已有元素：56px rail、固定 header、300px index、detail pane、刷新、新建人格、自定义编辑器；聊天侧栏已有标题/类型/新建按钮。
- [x] 新能力关系：provider 是 catalog 上游，角色是 catalog 消费者；角色页是分组与字段边界替代；新建聊天是原快速表单的替代。
- [x] 放置：provider 与角色各用同一 management shell 的 index/detail surface；provider 不进角色详情；参与者确认进入 modal/sheet。备选见下文。
- [x] 密度：桌面 participant 两列；≤860px 一列；≤700px dialog 变全屏 sheet、管理页变单内部滚动列。
- [x] UX 变化：默认语义由隐式后端 fallback 变为用户提交前可见、可取消的确认。
- [x] 状态：provider 正常/待验证、key 已保存/留空保留、显式清除、模型归类；角色可用/不可用、默认/非默认、custom、空选择、游戏类型、取消均覆盖。
- [x] 跨 surface：管理页的 default 标记与创建 dialog 的“默认”标签使用同一 accent 语义；availability 使用同一 warning 语义。
- [x] 视觉冲突：复用 v7 token、实底、细边框、8–10px 圆角和线性图标；没有新增渐变、玻璃、超大圆角或 emoji chrome。

## State Matrix

| Surface | State | UI contract |
|---|---|---|
| Provider index | configured | 显示 provider 名称、协议、模型数与最近验证状态；可进入详情。 |
| Provider detail | saved secret | `hasApiKey` 显示“已保存”；password 输入值为空；普通保存留空不清除。 |
| Provider detail | advanced auth | env / command 只显示 mode + configured；原始 reference 与解析值都不回显；输入新值才能替换。 |
| Provider detail | external auth | 显示 `auth.json / CLI` 外部认证；本页 clear disabled，不假装拥有该 secret。 |
| Provider detail | new draft | Provider ID/Base URL 为空、auth=`none`、模型目录为空；保存/验证 disabled；“添加模型”真实增加空行。 |
| Provider detail | model catalog | 每行显示 ID、名称、模型族归类与校验状态；unknown 可留给 custom，但不激活 family role。 |
| Provider detail | clear secret | 独立 danger action + 二次确认；不借用空输入表达删除。 |
| Provider detail | remove provider | 独立 danger action + 二次确认；显示模型数与 availability 影响；只删 `models.json` 条目，不删除历史/角色/外部认证。 |
| Provider detail | validate/save | 验证与保存分离；失败就地显示且不声明已写入。 |
| Provider surface | non-loopback deployment | local-admin-only banner；write/clear/validate disabled，聊天与 redacted catalog 仍可用。 |
| Role index | family available | 显示可用模型数；可选中查看；default 圆点可见。 |
| Role index | family unavailable | 保留目录位置；warning badge；不允许设 default。 |
| Role detail | family | 系统字段 readonly；无 Persona/Skills；模型只列同族 catalog。 |
| Role detail | family runtime | base 与 Profile 均显示 capability-aware thinking select；Profile 只允许同族模型；添加后焦点进入新 Profile 名称。 |
| Role detail | custom | 完整显示默认模型/思考强度、跨族 Profiles、Profile Persona、默认 Persona、Skills 与删除。 |
| New chat | defaults present | runnable defaults 预勾选并标“默认”，用户可取消。 |
| New chat | no defaults | 空选择打开；创建 disabled；就地提示至少一位角色。 |
| New chat | unavailable default drift | 不预勾选；卡片 disabled；显示 availability 原因。 |
| New chat | cancel/close | 不创建 conversation，不持久化 participant。 |
| New chat | keyboard | 背景 inert；Tab/Shift+Tab 圈禁；Escape/取消/关闭后焦点归还入口。 |
| New chat | submit | 仅提交当前最终勾选的非空 participants。 |
| New chat | game mode | 不读取普通聊天 defaults，进入现有模式专用玩家配置。 |

## Responsive Contract

| Viewport | Provider / role management | New chat |
|---|---|---|
| ≥1024px | 56px rail + 280–320px index + detail；index/detail 各自滚动；provider model rows 保持表格式密度。 | 居中 dialog；左基本信息、右参与者；参与者两列。 |
| 861–1023px | rail + 230–270px index + detail；详情字段降一列；model row 标签化两列。 | dialog 保持双区；参与者仍为两列。 |
| 701–860px | rail + 230–270px index + detail；详情字段降一列；model row 标签化两列。 | dialog 保持双区；参与者降为单列。 |
| ≤700px | rail 沉底 56px；header 固定；index/detail 在一个内部滚动列中顺序呈现；provider action 区不横向溢出。 | 100dvh 全屏 sheet；基本信息在上、参与者在下；footer 两按钮等宽。 |

## Alternatives and Trade-offs

### Chosen: modal / mobile full-screen sheet

优点：保留聊天上下文、足够展示所有角色状态、取消语义天然明确、桌面与移动共享一个状态机。代价：创建动作从侧栏的一步变为一次显式确认；这是本 Feature 为消除隐式参与者所要求的可见成本。

### Rejected: 在会话侧栏内展开多选

280–320px 宽度会把 7+ 角色压成长列表，availability 原因、custom 区分和错误信息同时出现时密度失控；移动端 off-canvas 里还会产生嵌套滚动。

### Rejected: 两步 wizard

“基本信息 → 参与者”人为增加流程层数；本次字段量足以在单页分区解决，wizard 是多项式堆项，不是必要结构。

### Rejected: 独立“模型族管理”页面

会把统一角色概念重新拆成两套信息架构，违背 `roleKind=model_family|custom` 的终态坐标系，也增加第二套导航、权限和空态。

这不等于拒绝“模型供应商”surface：模型族仍是角色，而 provider connection 是决定 catalog 的独立上游资源。二者用同一 management shell，但不共用保存表单。

## Meta-aesthetics Check

方案使用坐标变换而非叠补丁：provider connection、configured catalog、role selection 成为单向链；角色页仍是同一个角色域，只按 kind 投影不同编辑能力；新建聊天把原本后端隐藏的 participant policy 前移为一次显式提交。没有把 provider 表单复制到每个角色、没有增加 wizard、没有保留“前三名”fallback。

## Verification Evidence

- Hub Browser Preview：`http://127.0.0.1:3100/model-family-roles-ui-gate.html#providers`，已主动打开 provider-inclusive fixture 到当前 thread。
- JavaScript syntax：inline fixture script 经 `new Function(...)` 编译检查通过。
- Interaction contract：初始 3 个 runnable defaults；Qwen checkbox disabled；清空后 count=0、error visible、create disabled；重新选择后恢复；切换游戏类型后普通聊天 participant picker 退场。结果 `PASS fixture interaction contract`。
- Provider + role runtime regression：`node tests/ui/model-family-roles-ui-gate.test.js` 锁定 provider/role 双向切换、空 password + `hasApiKey` 状态、raw reference absence、显式 clear/remove、external auth、新 provider 草稿；同时断言 GPT 默认思考强度为 capability-aware select、`max` 因模型不支持而不出现、family Profile 只能选同族模型且无 Persona、custom Profile 可跨族并保留 Persona/Skills、添加 Profile 的焦点归还与 375px 宽度安全。
- Responsive regression：同一 headless Edge run 在 900px 断言连接字段一列、model row 两列，再回到 375px 验证移动宽度安全。
- Existing UI regression：同一测试继续锁定 860px 断点、生产入口说明、背景 inert、focus trap、焦点归还、游戏切换清错误与 375px new-chat 无横向溢出。
- Provider desktop evidence：`%TEMP%/caff-model-family-ui-gate-evidence-provider/desktop-provider-final.png`、`desktop-provider-new.png`；Hub Browser Preview 同步展示当前文件。
- Desktop evidence：`%TEMP%/caff-model-family-ui-gate-evidence/desktop-roles-clean.png`、`desktop-new-chat.png`。
- Mobile evidence：CDP `Emulation.setDeviceMetricsOverride(375×812, DPR=1)`；角色管理与新建聊天均 `innerWidth=375`、`scrollWidth=375`。截图为 `mobile-375-roles-final.png`、`mobile-375-new-chat-final.png`。
- Mobile bounds：new-chat close button `right=355`，create button `right=355`，均落在 375px viewport 内。

当前验证环境中 `npm run check`、`npm run build`、`npm run typecheck` 与 `npm test` 均通过；fixture 另使用零依赖静态服务和 headless Edge 契约测试验证设计状态。

## Acceptance Mapping

| UI Gate requirement | Design evidence |
|---|---|
| 模型供应商独立管理 | fixture 通过 rail / demo control 切换 provider index/detail，角色表单不含连接凭据。 |
| Provider 连接与 secret 语义 | ID、Base URL、API protocol、masked `hasApiKey`、空 password、advanced auth、验证/保存/显式清除均可见。 |
| Provider 移除语义 | 详情页独立 danger confirmation 明示模型与 availability 影响，并保护历史、角色身份与外部认证。 |
| 模型条目显式归类 | provider model rows 显示 model ID、名称与“模型族归类”；角色详情说明 availability 取自供应商目录。 |
| 系统模型族 / 自定义角色分组 | fixture 角色目录两个 group。 |
| availability 与默认开关 | Qwen unavailable 状态；family 详情 default toggle。 |
| locked system fields | family 详情中 stable ID/kind/family/name readonly + 系统维护说明。 |
| 常用运行字段 | 默认模型、能力感知的默认思考强度、可增删运行 Profiles；family 同族且无 Persona，custom 跨族并完整保留 Persona/Skills。 |
| defaults 预勾选、增删、取消、提交 | new-chat fixture 可开关 checkbox、清空触发错误、取消关闭、创建显示最终数量。 |
| 桌面与移动状态 | CSS 真实断点；≤700px 为 management 单列与 full-screen sheet。 |
| 与最终数据契约一致 | 使用七个 frozen stable role IDs、`model_family|custom`、availability 与显式 participants。 |

## Operator Decision Packet

**建议在 peer review 后放行本设计方向。** 需要 operator 确认的是产品体验，不是技术 A/B：

1. “模型供应商”与“角色管理”使用同一 management shell 的两个入口；provider 详情集中管理连接、密钥状态与模型归类，这个信息架构是否符合预期？
2. 已保存密钥只显示状态，输入框保持空；留空保存代表保留，清除走独立确认，这个交互是否清楚？
3. 移除 provider 走独立确认，只移除 `models.json` 连接并让受影响角色变为 unavailable，不删除历史聊天、角色身份或外部认证，这个边界是否清楚？
4. 角色管理继续使用“目录 + 详情”；默认模型、默认思考强度与运行 Profiles 直接可配，思考强度按模型能力过滤；family 无 Persona、custom 完整保留 Persona/Skills，这个字段边界是否符合预期？
5. 新建普通聊天继续使用“单页 dialog / 移动全屏 sheet”，defaults 仅预勾选，是否符合预期？

peer review 与 operator 验收后：本文 `status` 改为 `approved`，Feature Spec 记录 UI Gate evidence；随后才从最终 canonical main 创建实现基线并进入 TDD。

[砚砚/gpt-5.6-sol🐾]
