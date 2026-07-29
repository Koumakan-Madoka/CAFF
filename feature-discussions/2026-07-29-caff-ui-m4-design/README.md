---
feature_ids: [CAFF-UI-M4]
doc_kind: design
created: 2026-07-29
status: design_gate_pending
---

# CAFF-UI-M4 Design Gate · 聊天 UI Clowder 风格体验优化

> 真相锚（operator 原话）："很好，但是感觉聊天的UI还是可以优化一下，总而言之尽量参考clowder的UI风格吧"
> Before 证据：`${TMPDIR}/caff-ui-m4-before/`（5 张：1440 light/dark/drawer、820、375；真实 CSS + 真实 DOM 类渲染）
> Clowder 证据：`clowder-ai/packages/web/src/components/`（ChatMessage / ChatInput / ThinkingIndicator / ThreadSidebar 等实际源码）

---

## 1. Gap 分析（before 截图 → Clowder 源码对照）

### 1.1 消息流（最大差距区）

| # | 现状（before 证据） | Clowder 模式（源码证据） | 差距本质 |
|---|---|---|---|
| G1 | 所有消息全宽大卡片，用户/AI 仅靠微弱底色区分，无方向感 | 用户右对齐 `max-w-[75%]`、AI 左 `max-w-[85%]`，缺角气泡暗示归属（ChatMessage.tsx:39-44,446） | 长对话扫读时"谁在说"要靠读 sender 文字，不是一眼前置 |
| G2 | meta 行 sender 左 + time 右**横跨全宽**（1440 下相距 ~700px） | header 行紧凑承载 sender+time+badge，贴近气泡（ChatMessage.tsx:479-521） | 眼球要跳 700px 找时间戳 |
| G3 | 每条消息一张带边框大卡片，chrome 重量 > 内容重量 | 气泡轻背景块 + `mb-4` 间距，元信息不进气泡 | 信息密度低，一屏只放 2-3 条 |
| G4 | 消息级操作（导出/上下文）常显 ghost 按钮挂在 sender 区 | 低频操作 hover 才露（ThreadItem.tsx:245 同原则） | 每条消息都带两个常驻按钮噪音 |
| G5 | 失败 = 整卡变粉底 + 行内小字"生成失败·点击重试" | 分级横幅带人话解释 + 取消/重试按钮（ThinkingIndicator.tsx:124-207）；系统/错误消息居中窄条（ChatMessage.tsx:333-352） | 状态语义靠底色猜，没有解释 |
| G6 | 375 档："新消息" pill 遮挡正文；composer 三栏挤压 placeholder 溢出截断 | `↓到最新` 右下角浮钮（ScrollToBottomButton.tsx）；composer 辅助按钮移动收编 `+`（ChatInput.tsx:791-817） | 移动档细节失守 |

### 1.2 会话侧栏

| # | 现状 | Clowder 模式 | 差距本质 |
|---|---|---|---|
| G7 | 列表项噪音：标题 + 类型 tag + 3A/0M + 两行描述 + "3 个 Agent" + 日期，六层信息平铺 | 两行高密度：标题两行截断 + 相对时间 micro text（ThreadItem.tsx:203-215,363-410） | 标题不是唯一高权重元素，扫读慢 |
| G8 | 新建表单常开（标题 input + 类型 select + 大橙按钮 ≈200px） | 紧凑 + 入口，低频操作收 ⋯ 菜单 | 高频列表被低频表单挤占首屏 |

### 1.3 Chat Header / Composer

| # | 现状 | Clowder 模式 | 差距本质 |
|---|---|---|---|
| G9 | header pill 堆叠：runtime·Agent·房间处理中｜人格/消息数 + 模式 badge + 刷新 + 面板；375 下 runtime pill 挤压标题 | header 一行极简：侧栏开关 + 会话名 + 少量开关；统计/搜索收侧栏（ChatContainerHeader.tsx:39-99） | header 承担了仪表盘职责 |
| G10 | composer 三栏（输入/停止/发送）+ placeholder 当教程（@Agent、/goal 两行说明）+ 输入框下第二行重复提示 | 单行 flex：辅助低权重、发送高权重多态单按钮；placeholder 即状态文案（ChatInput.tsx:789-899,861-867） | 教学文案与状态文案混在输入路径上 |

### 1.4 已确认好的（不动）

- AppShell 骨架、rail、抽屉 6+2 tab IA、焦点/锚定状态机（M1 冻结）✅
- Light/Dark token、SVG 图标体系（M3 冻结）✅
- F001 分页与滚动锚定 ✅

---

## 2. 不迁移清单（Clowder 专属语义）

多猫 @ 路由与 DirectionPill、per-cat 气泡配色/字体 token、rich block 渲染槽、approval hub、liveness CPU 探测、@ 召唤菜单、语音输入、ghost suggestion。CAFF 的 @Agent 路由和 /goal 是自己的语义，**保留**但收敛呈现方式。

---

## 3. 推荐方向 wireframe

### 3.1 消息流 · 桌面（1440）

```
┌──────────────────────────────────────────────────────────┐
│ ☰  会话名                    ● 连接正常  [普通对话] [面板] │ ← header 一行；runtime/统计 pill 移出
├──────────────────────────────────────────────────────────┤
│  Strategy Agent · 07:02                        [▸ 4 次工具调用]│ ← meta 贴气泡，操作 hover 才露
│  ┌────────────────────────────────────────────┐          │
│  │ 第三夜的关键节点：                             │          │
│  │ 1. 守卫选择守 5 号…                           │ 80% max  │
│  └────────────────────────────────────────────┘          │
│                          ┌─────────────────────────┐     │
│              07:04 · You │ 第三夜守卫那次判定，当时…   │     │ ← 用户右对齐 75%，缺角
│                          └─────────────────────────┘     │
│  ─── ✕ 生成中断 · 网络超时，内容未完整 · [重试] ───          │ ← 居中窄条，人话解释
│              ┌────────────────────── ↓ 到最新 ┐           │ ← 右下浮钮，不遮正文
├──────────────────────────────────────────────────────────┤
│ [输入消息…  @ 路由到人格 / 用 /goal 设目标]          [发送]  │ ← 单行；placeholder 短教学
└──────────────────────────────────────────────────────────┘
```

**层级规则（三轨）**：对话气泡（用户右/AI 左，AI 带 sender 行）｜系统与错误 = 居中窄条｜tool trace = 气泡上方折叠条。

### 3.2 会话侧栏

```
┌────────────────────┐
│ 会话            [+] │ ← + 紧凑入口，点击展开新建表单（或弹层）
├────────────────────┤
│ ● M4 设计讨论       │ ← 标题一行，font-medium
│   3 人格 · 刚刚     │ ← 元信息一行 micro text
│                    │
│ ○ 狼人杀复盘        │
│   2 人格 · 15:05    │
└────────────────────┘
```
hover 露 ⋯（改名/删除，删除红字分隔）；类型 tag 从常显降为元信息行文本。

### 3.3 移动档（375）

- rail 沉底（M1 不变）；消息气泡 max-width 88%；meta 行 sender+time 紧凑不换行
- composer：输入框 + 发送单按钮；@ / /goal 教学收成一行可折叠 hint（空输入时显示）
- `↓到最新` 右下 44px 浮钮；header 只留 ☰ + 标题 + 面板

---

## 4. 需求 → 界面映射

| operator 诉求 | 设计回答 |
|---|---|
| "参考 clowder 的 UI 风格" | §3 全部模式来自 Clowder 实际源码（§1 证据列），非凭印象复刻 |
| 聊天高频路径成熟度 | 消息三轨层级（G1-G5）+ 侧栏密度（G7-G8）+ header/composer 瘦身（G9-G10） |
| 不破坏既有行为 | IA/焦点/锚定/分页/主题/图标全部不动；本阶段只动消息卡、侧栏项、header pill、composer 的表现层 |
| token/组件 ownership | 消息气泡、侧栏项、窄条各归一个 owner class，新增 token 进 `:root` 双主题表，不堆局部 fallback |

---

## 5. Design Gate 待 operator 决策（体验取舍，非技术 A/B）

**Q1 · 消息形态**：
- **A（推荐）Clowder 气泡式**：用户右/AI 左，气泡背景块。群聊多人格场景"谁在说"一眼前置，与 Clowder 同源。
- B 流式全宽：无气泡，细分隔线 + 左缘 accent 条（类 ChatGPT）。实现更简、长文阅读更顺，但多人格对话的方向感弱，且离 Clowder 参照更远。

**Q2 · 侧栏新建表单**：收起为 + 按钮（推荐，列表首屏多放 2-3 个会话）vs 保持常开（新建是高频操作时才值）。

**Q3 · header pill**：runtime/人格统计移入抽屉"设置"tab（推荐，header 一行）vs 保留现状（随时可见后台状态）。

### in_context_observability（承接 spec）

```yaml
primary_surface: "消息流内联：streaming 光标 / 失败居中窄条(重试) / ↓到最新浮钮；chat-header 连接状态点"
why_not_dashboard_only: "生成中断与连接状态发生在对话现场，用户第一动作是重试或继续"
deep_dive_surface: "runtime/统计详情移入抽屉设置 tab，评测页保持事后审计"
noise_dedup_policy: "沿用 brief §8.2 聚合策略；连接状态无事不占屏（对齐 Clowder ConnectionStatusBar 原则）"
```

### Architecture cell

```
Architecture cell: public/ plain-JS AppShell（仓库无 ownership map 文件）
Map delta: none
Why: 只动表现层组件与 token，不新增服务/API/DB/业务数据 owner。
```

## 6. 验证计划（Design Gate 通过后细化）

- 复用 `scripts/verify-ui.mjs` 门禁，新增消息形态/侧栏密度/移动档断言；证据仍为 3 PNG + 1 WebM。
- Light/Dark × 1440/820/375 全档截图对照本目录 before 证据。
