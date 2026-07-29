---
feature_ids: [CAFF-UI-M4]
topics: [frontend, ui, chat, message-list, composer, design-system, clowder-parity]
doc_kind: plan
created: 2026-07-29
status: implementing
---

# CAFF Chat UI — Clowder 风格体验优化（Milestone 4）

**Status:** implementing（V2 再退回 → V3 结构性重做，design gate 见 feature-discussions/2026-07-29-caff-ui-m4-design/v3-structure/）
**Feature:** CAFF UI Redesign Milestone 4 — `designs/caff-ui-redesign-brief.md` 的演进阶段
**Evolved from:** CAFF-UI-M1（AppShell）→ CAFF-UI-M2（management pages）→ CAFF-UI-M3（theme/icons），以及 F001 长会话分页。

**Goal:** 让聊天高频路径（消息阅读、输入区、状态反馈、侧栏/抽屉、响应式细节）在信息层级与交互反馈上达到 Clowder 同类工作台的成熟度，不重开 M1/M2 已冻结的 IA、滚动 ownership 与业务契约。

**operator 原话（真相锚，2026-07-29）：**
> "很好，但是感觉聊天的UI还是可以优化一下，总而言之尽量参考clowder的UI风格吧，新建一个线程，让暹罗猫作为主理人来干"

**Acceptance Criteria（Design Gate 后冻结；当前为草案）：**
1. 消息列表的信息层级（时间/发送者/正文/状态/tool trace）经重排后，1440/820/375 三档下消息扫读路径连续，无视觉噪音元素干扰正文。
2. Composer 区形态与 Clowder 工作台同级：输入框、发送、附件/模式等辅助动作的视觉权重与键盘可达性有明确层级，不与消息区争抢主视觉。
3. 状态反馈（streaming / 失败重试 / 连接状态 / 新消息 pill）在消息现场内联呈现，视觉样式与 Clowder 同类模式一致；不改 M1 已锁定的焦点/锚定状态机语义。
4. 侧栏会话列表与上下文抽屉的视觉密度、hover/active 态、分组层级达到 Clowder 同类面板水准。
5. 视觉收敛通过统一 token/组件 ownership 完成，不新增散点局部 CSS fallback；新增样式有明确 owner 文件。
6. F001 cursor pagination/scroll anchoring、M1 drawer/sidebar 焦点状态机、M2 management 契约、M3 主题与图标资源边界全部不退化。
7. `npm run check`、`typecheck:public`、`test:fast`、`test:smoke`、`test:ui` 全绿；浏览器 verifier 覆盖三断点与 Light/Dark。
8. 验收只使用隔离 SQLite/临时数据；禁止连接 Redis 6399 或生产用户库。

**Architecture cell:** `public/` plain-JS AppShell（仓库无 ownership map 文件）
**Map delta:** none
**Map delta why:** 本阶段是同一 cell 内的表现层与组件收敛，不新增服务、API、DB 或业务数据 owner。
**Tech Stack:** plain HTML/CSS/JavaScript、既有 token/图标体系、Node test runner、jsdom、Playwright Core + Edge
**前端验证:** Yes — 全部改动以真实 Edge 截图/verifier 证据验收。

---

## Why（本 feat 自己的语言重写，不继承上游模糊表述）

M1–M3 把 CAFF 的骨架（AppShell、管理页、双主题、线性图标）拉到了可用水准，review 全部通过。但 operator 人工验收后仍明确感到"聊天的 UI 还是可以优化一下"——**问题不在外壳，在聊天高频路径的成熟度**：消息怎么读、输入怎么打、状态怎么感知、列表怎么扫。这些是用户每天成百上千次交互的路径，信息层级和反馈密度差一档，体验就差一档。Clowder 是同团队验证过的同类工作台参照系，本阶段把 CAFF 聊天界面拉到这个参照系的水准。

## Current State / 现状基线

- 基线 worktree：`E:\pythonproject\caff-main-reconcile`，冻结 `chore/main-reconcile@455898cb096d484a4b550f77a58ce738f80ce870`（尚未合入 GitHub main）。
- 已实现：AppShell 固定视口 + rail + 可折叠侧栏 + 上下文抽屉（6 常显 + 2 条件 tab）、Light/Dark 双主题、仓库自有 SVG 图标、F001 分页与滚动锚定。
- 已知剩余差距（Design Gate 前现场侦查确认，详见 `feature-discussions/2026-07-29-caff-ui-m4-design/`）：
  - 消息气泡/元信息/tool trace 的视觉层级仍是 M1 结构的延续，未按 Clowder 消息层级重排。
  - Composer 区仍是旧形态的视觉延续，辅助动作权重未分层。
  - 会话列表/抽屉面板密度与 Clowder 同类面板有差距。

## User Journey

### Primary Journey：日常多轮聊天
- **Scope unit:** 单次会话内的消息阅读与发送（不是 thread/会话管理，那是 M1 侧栏已覆盖的路径）。
- **Entry:** operator 打开 `index.html`（或切到某会话）。
- **Flow:**
  1. 扫读消息流：快速定位"谁说了什么、AI 还在不在生成、上次失败在哪"。
  2. 在 composer 输入并发送；发送中/生成中有明确内联反馈。
  3. 长对话滚动离开底部时，"新消息 pill"提示；回到底部自动锚定。
  4. 需要上下文时滑出右侧抽屉查参与者/目标/记忆，查完回到消息流，焦点与阅读位置不被打断。
- **Done:** 上述每一步的视觉层级、密度、反馈达到 Clowder 同类路径水准。

### Secondary Journey：窄屏（820/375）聊天
- 与 Primary 相同路径，但布局落到 M1 响应式档；本阶段只优化密度与细节，不改 M1 断点结构。

## Design Gate 计划

1. 现场侦查：`browser-preview` 检查本地预览（`http://127.0.0.1:3110`，隔离 SQLite）+ 读 Clowder 实际聊天 UI 源码（不凭印象复刻）。
2. 产出 before/after 对照、响应式 wireframe（≤3 个方向）和"需求→界面"映射，归档 `feature-discussions/2026-07-29-caff-ui-m4-design/`。
3. operator 确认方向后进入实现；需要 operator 选择时给体验取舍，不给纯技术 A/B。

### 现场可感知性（in_context_observability，Design Gate 必填草案）

```yaml
in_context_observability:
  primary_surface: "消息流内联：streaming 光标 / 失败卡片(重试) / 新消息 pill；chat-header 连接状态点（沿用 M1 语义，视觉对齐 Clowder）"
  why_not_dashboard_only: "生成中断与连接状态发生在对话现场，用户第一动作是重试或继续，切页看数字违反明厨亮灶"
  deep_dive_surface: "评测页定位事后审计，不进日常感知路径（沿用 brief §8.2）"
  noise_dedup_policy: "沿用 brief §8.2 聚合策略，本阶段只改视觉呈现不改语义"
```

## Non-goals

- 不重开 M1 已冻结的 IA（rail/侧栏/抽屉结构、条件 tab 状态机、焦点/滚动 ownership）。
- 不改 F001 cursor pagination 与 scroll anchoring 行为契约。
- 不把 Clowder 专属协作语义（多猫 @、approval hub、rich block 等）硬塞进 CAFF。
- 不引入新运行时依赖（React/Tailwind/图标库）。
- 不修改 `caff-main-reconcile` 本体；实现必须新建独立 worktree/branch 并明确 stack base。
- 不 push、不建 PR（reconciliation 未成为 canonical base 前）；远端边界由 operator 决定。

## Open Questions（Design Gate 前收敛）

1. Clowder 的哪些聊天布局、消息层级、composer、状态反馈模式适合 CAFF，哪些属于 Clowder 专属语义不应照搬？
2. 当前 1440/820/375 三档中，最影响高频聊天体验的真实断点分别是什么？
3. 视觉优化能否通过统一 token/组件 ownership 完成，避免继续堆局部 CSS fallback？

## Dependencies

- Base：`455898c`（CAFF-MAIN-RECONCILIATION review_ready）；实现 branch 必须明确 stack base 并在 PR 阶段 retarget。
- 真相源：`designs/caff-ui-redesign-brief.md`（v7 frozen）、`feature-specs/2026-07-25-caff-ui-management-pages.md`、`feature-specs/2026-07-25-caff-ui-theme-icons.md`。
