---
doc_kind: design-brief
feature_ids: [TBD-caff-ui-redesign]
topics: [ui-redesign, ia, workbench, scroll-model, design-tokens]
created: 2026-07-23
author: 烁烁 (k3)
status: v5 frozen · implementation review
---

# CAFF 整体 UI 重设计 · Phase 1 设计简报

> 原设计阶段范围：现状审计 + IA + 高保真 fixture；当前 v5 已冻结，方向 A 的 Milestone 1 实现处于跨个体 review。
> 基线证据：`designs/baseline-desktop-1440.png`、`designs/baseline-narrow-820.png`

---

## 1. 现状审计

### 1.1 文件结构（不是单文件巨石，但入口页仍过度集中）

| 文件 | 行数 | 职责 |
|---|---|---|
| `public/index.html` | ~536 | 聊天工作台全部 DOM + 5 个 drawer |
| `public/app.js` | 4313 | 主控制器（状态、渲染、事件、API） |
| `public/styles.css` | 3930 | 全部页面共用一份样式 |
| `public/chat/*.js` | 10 个模块 | message-timeline (50KB)、conversation-settings (28KB) 等已拆分 |
| `public/personas|skills|projects|metrics.*` | 4 对 | 独立管理页 |

### 1.2 滚动根因链（长聊天撑长整页）

```
body { overflow-y:auto }                     styles.css:40
.shell { min-height:100vh }                  styles.css:152
.layout { display:grid; align-items:start }  styles.css:258-266   ← grid 行高随内容
.panel-chat { grid-template-rows:auto auto minmax(0,1fr) auto; overflow:hidden }
                                             styles.css:296-301   ← 自身无高度约束，1fr 无法解析
.message-list { overflow:auto }              styles.css:529-534   ← 父级无界 → 永不触发滚动
```

- 侧栏用 `max-height: calc(100vh - 200px)` 魔法数硬凑（styles.css:292-293），topbar 高度一变就错位。
- `≤1180px` 时三个 panel 全部 `max-height:none`（styles.css:2719-2736）→ 窄屏是一整页超长滚动。
- `≤1440px` 时 studio 掉到第二行（styles.css:2706-2717）→ 桌面常见宽度下右侧配置已经在折叠态之外。

### 1.3 基线截图痛点

1. **Topbar 吃掉 ~230px**：eyebrow + H1 + 副标题 + 5 个导航链接 + 状态 pill + 刷新按钮，全堆在首屏顶部（baseline-desktop）。
2. **加载态 studio 已掉出视口**：1440×900 下"本次人格"配置区在首屏之外，空会话就已破窗。
3. **聊天区无独立滚动**：消息列表与 composer 之间没有视觉/结构边界，长对话直接撑 document。
4. **5 个 drawer + 头部 3 个"摘要/记忆/目标 ▸"按钮 + 右缘悬浮"目标"球**：同一类入口有三种形态，认知负担大。
5. **窄屏 = 一柱擎天**：导航换行、会话管理占掉首屏、聊天在第二屏、配置在第三屏。
6. **Composer 过高**：textarea min-height 7rem（styles.css:114-117），与消息区争抢主视觉。

### 1.4 需要保留的资产

- 暖奶油底 + 陶土橙 accent + 青绿辅助（styles.css:41-44）——CAFF 的视觉身份，保留并 token 化。
- 圆角卡片语言（`--radius-xl` 等已有变量）。
- 5 个管理子页的路由结构（personas/skills/projects/metrics）。
- chat/ 模块拆分已有雏形，重设计不需要推翻 JS 架构。

---

## 2. Clowder 可复用模式（结构原则，不抄外观）

| # | 模式 | 原则 | 证据 |
|---|---|---|---|
| C1 | **AppShell 固定视口** | 根容器 `flex h-screen h-dvh overflow-hidden`，document 永远不滚 | `packages/web/src/components/AppShell.tsx:48` |
| C2 | **min-w-0/min-h-0 纪律** | 每个 flex 祖先都显式 `min-w-0`，滚动区是有界 flex 子项 `flex-1 overflow-y-auto` | `ChatContainer.tsx:912,944-948,1243-1248` |
| C3 | **图标 rail + 可折叠侧栏** | 48px ActivityBar 常驻导航；ThreadSidebar 可拖宽、可折叠，状态入 store | `AppShell.tsx:50,59-72` |
| C4 | **二级内容走 drawer/浮层** | Approval Hub 等不进主布局，root 级挂载浮层 | `AppShell.tsx:78-81`、`ApprovalHubDrawer.tsx` |
| C5 | **语义化 token** | `--cafe-surface`、`--semantic-warning-surface` 按用途命名而非颜色名 | `app/layout.tsx:58`、globals.css |
| C6 | **非桌面隐藏侧栏** | `useIsDesktop` 门控，移动端侧栏不渲染而非压缩 | `AppShell.tsx:35,45` |
| C7 | **resize 手柄独立组件** | ResizeHandle 支持拖拽/双击复位/折叠三态 | `AppShell.tsx:64-70` |

---

## 3. 新信息架构（两方向共用滚动骨架）

**滚动骨架（两个方向相同，直接回答核心验收）：**

```
body { overflow: hidden }                        ← document 锁死
.app-shell { height: 100dvh; display: flex }     ← 唯一高度源
  rail (48px, 不滚)
  sidebar (可折叠, overflow-y: auto)             ← 独立滚动
  main (flex-1, min-w-0, display: flex, flex-direction: column)
    chat-header (flex-shrink: 0)                 ← 标题/操作恒定可达
    message-list (flex: 1, min-height: 0, overflow-y: auto)  ← 唯一长滚动区
    composer (flex-shrink: 0)                    ← 输入框恒定可达
  context-panel (可折叠 drawer, overflow-y: auto)
```

### 方向 A ·「工作台 AppShell」（推荐）

Clowder 验证过的生产型布局，适合 CAFF 高频的会话切换/人格管理/游戏面板操作。

```
┌────────────────────────────────────────────────────────────────┐
│ rail │  会话侧栏 (280px,可拖可折)  │  聊天主列        │ 上下文抽屉 │
│ ┌──┐ │ ┌──────────────────────┐ │ ┌──────────────┐ │ (按需滑出) │
│ │💬│ │ │ + 新建会话            │ │ │ 房间名 · 状态 │ │ 参与者     │
│ │👤│ │ │ ─────────            │ │ │ [摘要][记忆]  │ │ 会话目标   │
│ │🛠│ │ │ ▸ 狼人杀之夜    🟢3   │ │ │      [目标]   │ │ 记忆摘要   │
│ │📁│ │ │ ▸ 产品讨论      ⚪    │ │ ├──────────────┤ │ 会话设置   │
│ │📊│ │ │ ▸ 卧底局        ⚪    │ │ │              │ │ 游戏面板   │
│ │  │ │ │                      │ │ │  消息流       │ │ (tool     │
│ │⚙ │ │ │                      │ │ │  独立滚动     │ │  trace)   │
│ └──┘ │ └──────────────────────┘ │ ├──────────────┤ │            │
│ 48px                            │ │ ✎ composer   │ │            │
│                                 │ └──────────────┘ │            │
└────────────────────────────────────────────────────────────────┘
 全高 100dvh，document 不滚；仅消息流/侧栏/抽屉各自滚动
```

- **rail**：💬聊天 👤人格 🛠Skill 📁项目 📊评测 ⚙设置 —— 吃掉现有 topbar 的 5 个链接，省 230px 垂直空间。
- **会话侧栏**：会话列表 + 新建入口 + 活跃状态点；可折叠成 rail-only。
- **上下文抽屉**：把现有 5 个 drawer + 3 个头按钮 + 悬浮目标球统一为**一个右侧抽屉**（v5 定稿 IA：6 个常显 tab——参与者/目标/记忆/摘要/设置/上下文 + 2 个条件 tab——游戏/草稿，见 §8.8），tool trace 作为消息内联展开。
- **chat-header** 只留：房间名、模式徽标、在线状态、抽屉开关。

### 方向 B ·「对话优先 · 双缘悬浮」

默认只有聊天列，左右都是 hover/快捷键唤出的悬浮面板。沉浸感最强，但会话切换和人格管理路径变长，对 CAFF 这种"配置驱动"工具发现性偏差。

**推荐 A**。理由：CAFF 的核心动作（切会话、调人格、开游戏面板）是高频生产操作不是低频浏览；且 A 的骨架已被 Clowder 同团队验证，砚砚实现时有现成参照。

### 响应式策略（方向 A）

| 断点 | 行为 |
|---|---|
| ≥1280px | rail + 侧栏 + 聊天 + 抽屉（overlay） |
| 768–1279px | rail + 聊天；侧栏变 overlay drawer；上下文抽屉全宽 overlay |
| <768px | 单栏聊天；rail 沉底为 bottom bar；侧栏走 off-canvas drawer（`min(320px, 88vw)`）；上下文抽屉走 100vw full-sheet |

---

## 4. 设计 token 草案（映射 plain-JS，无需换栈）

现有 `var(--ink)` 等 CSS 变量直接演进，零框架依赖：

```
--caff-canvas        #f7f2ea (暖奶油，保留身份)
--caff-surface       #fffdf9 / 半透玻璃仅用于抽屉
--caff-ink           #22313f
--caff-accent        #ef7d57 (陶土橙)
--caff-accent-deep   #c45d3b
--caff-teal          #2a9d8f
--caff-radius-md/xl  已有，沿用
--caff-space-1..6    4/8/12/16/24/32
--caff-font-body     沿用现有
```

玻璃拟态从"全局卡片"降级为"仅抽屉/浮层"，正文区改暖白实底 + 1px 暖灰边——省渲染开销、提长文可读性。

---

## 5. 关键状态清单（高保真阶段逐一出稿）

| 状态 | 设计要点 |
|---|---|
| 空态 | 消息区内引导卡：示例提问 + 人格快捷入口 |
| 加载 | 骨架屏在消息区内，不锁整页 |
| streaming | 消息内联打字光标 + 头部"生成中/停止"状态 |
| 失败恢复 | 消息级错误条 + 重试按钮，不弹窗 |
| tool trace | 消息气泡内折叠条（▸ N 次工具调用），展开为时间线 |
| 长对话 | 消息区顶部"回到顶部/摘要"悬浮 chip，滚动锚定底部 |
| 抽屉 | 右滑 overlay；6 常显 tab（参与者/目标/记忆/摘要/设置/上下文）+ 2 条件 tab（游戏/草稿，§8.8） |
| 游戏面板 | 狼人杀/卧底作为上下文抽屉的一个条件 tab，不占主列 |

---

## 6. 需求 → 设计画面映射

| 验收要求 | 设计回答 |
|---|---|
| 桌面工作台固定在视口内 | §3 滚动骨架：`100dvh` + `overflow:hidden` + 三区独立滚动 |
| 标题/主操作/输入框稳定可达 | chat-header 与 composer 均 `flex-shrink:0`，永不滚出 |
| 消息区独立滚动 | message-list 是唯一 `flex:1; overflow-y:auto` 长滚动区 |
| 聊天变长不增 document 高度 | body overflow hidden + 中间列 min-height:0 链 |
| 现场可感知不挤占主区 | 上下文抽屉按需滑出；tool trace 内联折叠 |
| Skill Tests 移除 | 新 IA 无其入口（rail 无此项） |

---

## 7. 待 operator 决策（Design Gate #1）✅ 已决

**方向 A（工作台 AppShell）** —— co-creator 2026-07-23 拍板。

---

## 8. Phase 2 · 高保真 mock（方向 A）

> Pencil MCP 在当前 runtime 不可用（.pen 只能经 Antigravity Pencil 扩展读写），
> 高保真以**自包含 HTML mock** 作为设计真相源过渡；Pencil 可用后转录为
> `designs/{feature-id}-caff-ui-redesign.pen`。

### 8.1 产物

| 文件 | 说明 |
|---|---|
| `designs/mock-app-shell-a.html` | 高保真 mock，响应式 + 全部关键状态可切换（演示工具栏；`#clean` 隐藏） |
| `${TMPDIR}/caff-ui-verify/<run-id>/ui-v2-1440-long.png` | 实现证据：桌面长对话 |
| `${TMPDIR}/caff-ui-verify/<run-id>/ui-v2-1440-drawer-goal.png` | 实现证据：桌面上下文抽屉 |
| `${TMPDIR}/caff-ui-verify/<run-id>/ui-v2-375.png` | 实现证据：手机单栏 |
| `${TMPDIR}/caff-ui-verify/<run-id>/ui-v2-walkthrough.webm` | 实现证据：约 15 秒桌面→抽屉→手机 walkthrough |

### 8.2 现场可感知性自检（必产出字段）

```yaml
in_context_observability:
  primary_surface: "消息流内联：streaming 光标 / 失败卡片(重试) / tool trace 折叠条；实体状态点：会话列表 live dot、chat-header 连接状态、参与者在线 badge"
  why_not_dashboard_only: "生成中断与连接状态发生在对话现场，用户第一动作是重试或继续，切到评测页看数字违反明厨亮灶"
  deep_dive_surface: "评测报表页定位 L3 事后审计，不进日常感知路径"
  noise_dedup_policy: "同一人格同类失败 5 分钟内聚合为一条错误卡片；非阻塞状态漂移只走 dot/badge，不发系统消息"
```

### 8.3 可访问性规格（Gate #2 审查项，v3 已按复审修正）

| 项 | 设计回答 | mock 证据 |
|---|---|---|
| 键盘焦点顺序 | rail → sidebarToggle → chat-header → **消息流（`role="log"` tabindex=0 可聚焦）** → composer；`:focus-visible` 3px 橙环 | v2 实测 Tab 序列：`rail×6 > sidebarToggle > drawerToggle > messageList > tool-trace summary > composerInput` |
| 关闭态退场 | 关闭的抽屉/侧栏 **`inert` + aria-hidden 同写**，同时退出可访问树与顺序焦点；抽屉打开时 app-shell + 演示栏 inert（真模态） | v2 零泄漏；v3 实测两属性开=false 闭=true 一致 |
| 抽屉 focus trap | 打开时 focus 移到关闭钮；**trap 集合只含当前可见、未 disabled、`tabIndex≥0` 的真实顺序焦点**（hidden panel 不入序），Tab/Shift+Tab 首末双向循环；关闭归还 focus 给触发钮 | v3 实测 participants/goal/settings 三 panel 首末双向循环 |
| 窄屏侧栏 modal | <1280 侧栏打开 = **modal**：焦点移入 sidebarClose、rail/main/演示栏 inert、Tab 在侧栏内循环；Escape/关闭钮归还 ☰；≥1280 为非模态常驻 | v3 实测 820/375 焦点进入 + 背景 inert + 8 步 Tab 零逃逸 + 归还 |
| 断点重入焦点接管 | 持久 open 跨 desktop→narrow：inert 写入**前**快照恢复目标；焦点在背景（含 BODY）→ 移入 sidebarClose，在 sidebar 内 → 不抢；drawer open 期间不抢，drawer 关闭重放时完成 handoff | v4 实测 composer/BODY/sidebar 内/drawer 四种先态全闭合 |
| Escape | 关闭抽屉（优先）/ 关闭窄屏侧栏（桌面折叠不回退） | mock JS keydown |
| 抽屉 tabs | **APG tabs**：id + aria-controls/labelledby、roving tabindex、←/→/Home/End 方向键、点击与方向键均真实切换 panel | v2 实测 click/ArrowRight/End 全部联动 aria-selected + panel hidden |
| 会话列表语义 | 原生 `<ul><li><button>` 结构，不覆写 button 原生语义 | mock DOM |
| reduced-motion | `prefers-reduced-motion` 下全部动画/平滑滚动关闭 | mock CSS |
| 滚动锚定 | 贴底时新消息自动跟随；离开底部时保持阅读位置 + "↓ 新消息" pill；**手动回到底部阈值内 pill 自动清除（scroll listener）** | v2 实测离底追加出 pill、手动回底自动清除 |
| 触控目标 | 全部交互元素 ≥44px（rail 钮、会话项、icon-btn、发送、tab、tool trace summary、重试钮、新消息 pill） | v2 实测四组原不达标项全部 =44px |
| 桌面侧栏收起 | ≥1280 收起 = 真实折叠（280→0，宽度过渡 + inert + 焦点归还 ☰）；☰ 全档位可见作为重开控制 | v2 实测 collapse/reopen 生效 |
| 语义 | `aria-current`/`aria-expanded`/`aria-modal`/`role=tablist`/`role=log`/`aria-live=polite` | mock DOM |

### 8.5 v2 冻结（Gate #2 审查修正后）

审查（砚砚，BLOCK 6 findings）→ 全部修正，Playwright/Edge 实测脚本 14/14 PASS
（`designs/v2-verify-results.json`；脚本在仓外 temp，不属设计产物）：

- 1440 `#state=long` 真实 overflow：scrollHeight 1851 > clientHeight 757，页面级无破窗
- 关闭态 Tab 序列（820）：零屏外/零抽屉泄漏，消息流入序
- 桌面侧栏折叠 280→0 真实生效，重开焦点归还
- pill 离底出现（44px）、手动回底自动清除
- 修正截图：`v2-1440-long-bottom/top.png`、`v2-1440-sidebar-collapsed.png`、`v2-1440-drawer-goal-tab.png`、`v2-820-long.png`、`v2-375-long.png`

**设计铁律（本轮 audit 沉淀）**：声明的交互/可访问性契约必须有实现 + 可复现证据；
`aria-hidden` 不等于退场（用 `inert`）；失效控制不允许保留。

### 8.6 v3 冻结（Gate #2 复审修正后）

复审（砚砚，BLOCK 2 P1 + 1 P2）→ 全部修正，Playwright/Edge 实测脚本 28/28 PASS
（`designs/v3-verify-results.json`；脚本在仓外 temp，不属设计产物）：

- drawer trap 三 panel（participants/goal/settings）Shift+Tab 首边界 / Tab 末边界双向循环
- 820/375 侧栏打开：焦点进入 sidebarClose + rail/main/演示栏 inert；Tab 全程留侧栏内；Escape/关闭钮归还 ☰
- 侧栏 `aria-hidden` 与 `inert` 同写，与 §8.3 单一真相
- v2 全部 14 项回归通过
- 修正截图：`v3-1440-drawer-settings-tab.png`、`v3-820-sidebar-open.png`、`v3-375-sidebar-open.png`

**设计铁律（本轮 audit 沉淀）**：焦点状态机必须覆盖「打开进入 / 序内循环 / 关闭归还」三条边；
trap 的 focusable 集合必须按可见性实测过滤（`getClientRects`），hidden 祖先内的控制不入序；
嵌套 overlay 退场后要重应用底层 overlay 的 inert 状态。

### 8.7 v4 冻结（Gate #2 三轮复审修正后）

复审（砚砚，BLOCK 1 P1 + 2 P2，另加三轮实现边界纠偏）→ 全部修正，Playwright/Edge 实测脚本 **39/39 PASS**
（`designs/v4-verify-results.json`；脚本在仓外 temp，不属设计产物）：

- **断点重入焦点接管**（新 P1）：持久 open 跨 desktop→narrow 重入时，`setSidebar` 在任何 inert 写入**之前**快照 `prevFocus` / `prevWasAlreadyInert` / `safeRestoreTarget`；焦点位于即将 inert 的背景（含 BODY/null）→ 移入 sidebarClose 并存安全恢复目标；焦点本在 sidebar 内 → 不抢
- **drawer 优先级守卫**：drawer open 期间断点变化只同步 inert/aria 不碰焦点；drawer 关闭经既有 `setDrawer` 重放 `setSidebar` 完成底层 handoff
- 恢复目标语义：composer→composer；BODY/null→☰；进入前已 inert→☰（快照先于本次 inert 写入，防止合法目标被误降级）
- **响应式单一真相**：<768 侧栏 = off-canvas `min(320px, 88vw)`（非 full-sheet），§3 响应式表已同步；上下文抽屉保持 100vw full-sheet
- 新增 4 条断点重入测试（10 断言，含 `lastSidebarFocus` 存储阶段断言锁时序）+ 截图前置状态断言；v3 全部 28 项回归通过
- 修正截图：`v4-1440-drawer-settings-tab.png`（前置断言：drawer 真打开 + settings panel 真可见）、`v4-820-sidebar-open.png`、`v4-375-sidebar-open.png`

**设计铁律（本轮 audit 沉淀）**：焦点/inert 判定必须先快照后写入——基于变更后状态算恢复目标会误降级合法目标；
modal 不变量覆盖「响应式模式切换」第四条边：断点重入 = 一次隐式打开，焦点接管义务与显式打开相同；
嵌套 overlay 共存时焦点所有权归最上层，底层 handoff 延迟到上层退场重放。

### 8.8 v5 冻结（Gate #2 delta：条件 tab IA 与消失状态机）

实现复审（砚砚，BLOCK 5 P1 + 1 P2）→ 全部修正。本轮 delta 把实现期暴露的
两个设计盲区写死为契约：

**最终 IA（定稿）**：抽屉 tab = 6 常显（参与者/目标/记忆/摘要/设置/上下文）+ 2 条件（游戏/草稿）。
- `designs/mock-app-shell-a.html` 已同步为 v5 active fixture：狼人杀场景显示「游戏」，「草稿」保留条件态，
  「上下文」常显；APG 方向键只遍历可见 tab。mock 的冻结 SHA256 记录在本节末尾 provenance 行。
- 「上下文」是既有 agent-context-drawer 功能的常显映射——v4 基线漏列，本轮补认为常显 tab；
- 「游戏」由 undercover/werewolf 卡片可见性驱动；「草稿」由待确认 Skill 草稿存在性驱动。

**条件 tab 出现/消失/焦点规则（状态机闭合契约）**：
1. 隐藏的当前 tab 必须立即让位：fallback = 第一个可见 tab，`aria-selected`/roving tabindex/panel hidden
   三者在 drawer **开、关两态**都要同步重写（关态延后 = 重开时出现"隐藏 tab 仍为 active panel"的非法态）；
2. 焦点迁移：**hidden 写入之前**先快照焦点位置（`activeElement === tab` 或在其 panel 内）——
   写入后浏览器立即把焦点掉到 BODY，事后再算必丢；drawer 开且焦点在被隐藏的 tab/panel 内 →
   迁移到 fallback tab；其余情况不抢焦点；
3. panel 模块焦点所有权：shell 经 `openTab/releaseTab` 驱动的开闭（`fromShell`）**永不写焦点**，
   APG roving focus 归 shell 独占；模块只在用户直接动作（点击自己的触发钮）时才可聚焦自己的输入框；
4. panel controller 启动条件不得依赖已被 IA 淘汰的旧 chrome（旧头部钮/悬浮球），
   只依赖自己 panel 的 DOM 存在性。

**触控目标与窄档约束（补 §8.3）**：
- 44px 承诺改为**全量扫描**（tool trace toggle、timeline 重试钮、设置 checkbox label、全部 tab、
  header/composer 控件），抽样验收不再作数；
- ≤480px：`.runtime-pill`/`#conversation-meta` 必须可缩（min-width:0 + ellipsis），
  `#conversation-meta` 隐藏；状态文本与 header 操作钮矩形相交 >1px 即破窗（375/320 双档锁）。

**持久回归（本轮起入仓，不再仓外 temp）**：
- `tests/ui/app-shell.test.js`（jsdom，入 `test:fast`）：goal controller 启动、fromShell 焦点所有权、
  会话列表 ul>li>button、条件 tab 开/关两态、pill renderer ownership、composer 同步、v5 mock/runner truth，11 例；
- `scripts/verify-ui.mjs`（Playwright/Edge，`npm run test:ui`）：默认自起动态端口 + 临时 SQLite，49 项含全量
  44px、375/320 header overlap、条件 tab 真实焦点迁移、会话列表键盘切换、renderer replacement、
  长会话正文不被 grid 行压缩裁切、composer clear/restore、DELETE 成功与零残留；显式目标只允许 loopback，异常退场也会清理并报告失败；
- 同一 runner 生成 3 张实现截图 + 约 15 秒 walkthrough，全部写入临时证据目录，不污染仓库；
- `npm run check` 已纳入 `public/shell/app-shell.js`；active spec 见 `.trellis/spec/frontend/ui-structure.md` AppShell 节。

**设计铁律（本轮 audit 沉淀）**：先快照后写入不仅用于 inert/焦点恢复目标，同样适用于
**hidden 写入**——任何让元素退出渲染树的操作都可能瞬间清空焦点，快照必须先于写入；
契约回归必须仓内可持续，temp 脚本随 session 封印丢失 = 契约无守卫。

**v5 mock provenance**：`C64B57CEC4968B167BEC724B63D46F333786CAE167C3C119265BF067896476DD`

### 8.4 响应式三档（已实现于 mock）

- ≥1280px：rail + 侧栏 + 聊天；抽屉 overlay 360px
- 768–1279px：rail + 聊天；侧栏 overlay（☰ 唤出）
- <768px：单栏；rail 沉底 56px；抽屉全宽；mode pill ≤480px 隐藏

---

## 9. Gate #2 与实现状态

**Gate #2 APPROVED**：方向 A、v4 焦点/滚动状态机与 §8.8 v5 IA delta 均已冻结。实现 worktree 以 `4560d3e` 为祖先落地 Milestone 1；当前阶段是实现跨个体 review，而不是再次打开设计方向。Pencil 可用时仍可把 active HTML fixture 转录为 `.pen`，但不阻塞本轮实现验收。
