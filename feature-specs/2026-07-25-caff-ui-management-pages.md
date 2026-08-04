---
feature_ids: [CAFF-UI-M2]
topics: [frontend, ui, management-pages, accessibility, responsive-layout]
doc_kind: plan
created: 2026-07-25
---

# CAFF UI Management Pages Implementation Plan

**Feature:** CAFF UI Redesign Milestone 2 — `designs/caff-ui-redesign-brief.md`
**Goal:** 把 personas、skills、projects、metrics 四个独立管理页迁入与聊天工作台一致的固定视口 AppShell，同时完整保留现有 CRUD、筛选和 API 行为。
**Acceptance Criteria:**
1. 四页统一使用 56px rail、稳定页头、双栏管理区；桌面 document 不滚动，列表与详情各自有界滚动。
2. 小于 768px 时 rail 固定到底部，管理内容改为单列内部滚动，页面无横向破窗。
3. 五套可选列表（人格、Skill、模式、项目、指标 Agent）统一为 `ul > li > button`，支持原生 Tab/Enter，活动项有可读状态。
4. 原有元素 id、表单、API route、保存/删除/筛选行为保持不变；不改后端 payload。
5. loading / empty / full / error 状态继续成立；empty 至少有一条确定性浏览器验证。
6. 所有可见交互目标不小于 44px，1440/820/375 三档通过真实浏览器验证。
7. `npm run check`、`typecheck:public`、`test:fast`、`test:smoke`、`test:ui` 全绿。
**Architecture cell:** `public/` plain-JS management pages（仓库无 ownership map 文件）
**Map delta:** none
**Map delta why:** 只迁移既有四条 route 的展示外壳与浏览器语义，不新增服务、数据 owner 或跨层依赖。
**Architecture:** HTML 保留真实 landmarks 与 page-specific forms；CSS 提供 `body.management-app` 固定视口骨架；`public/shared/management-list.js` 只提供无状态的语义列表项 primitive。既有页面脚本继续拥有 CRUD/筛选状态，helper 不存储选择状态。
**Tech Stack:** plain HTML/CSS/JavaScript、Node test runner、jsdom、Playwright Core + Edge
**前端验证:** Yes — reviewer 必须用真实浏览器验证 1440/820/375、空态、键盘和 44px。

---

## Finish Line

终态 B：operator 从 rail 进入任一管理页时，看到与聊天工作台同一套 CAFF AppShell；标题与刷新始终可达，左侧索引和右侧编辑/报表独立滚动，手机端在单一内容滚动区内完成同样工作。

**不构建：**

- 不改 personas/skills/projects/metrics 的 API、数据模型或权限。
- 不把管理页塞进聊天 drawer，也不新增 SPA/router/framework。
- 不迁移聊天页内部面板，不重新打开 Milestone 1 已冻结的焦点状态机。
- 不新增持久化 UI 状态；当前 route 和现有页面 state 已足够派生全部展示。

## Product / State Matrix

| 维度 | 终态 |
|---|---|
| 入口层级 | 既有 L2 管理 route，由全局 rail 进入；不新增 L1 项 |
| loading | 现有“加载中”文案/空容器保留，页头和导航可用 |
| empty | 列表显示 `.empty-state`，详情操作禁用或保持空编辑态 |
| full | 左侧选择、右侧编辑/报告；两区独立滚动 |
| error | 现有 toast 显示 API 错误，外壳与导航不消失 |
| desktop ≥1100 | rail + 300px 索引 + minmax 详情；document 高度固定 |
| tablet 768–1099 | rail + 280px 索引 + 详情；允许内容压缩但不横向溢出 |
| mobile <768 | bottom rail + 单列 management content；页头固定、内容区滚动 |

## Terminal DOM / Helper Schema

每个管理页必须满足：

```html
<body class="management-app" data-page="personas|skills|projects|metrics">
  <div class="management-shell">
    <nav class="rail" aria-label="主导航">...</nav>
    <div class="management-main">
      <header class="management-header">...</header>
      <main class="management-content">
        <aside class="management-pane management-index">...</aside>
        <section class="management-pane management-detail">...</section>
      </main>
    </div>
  </div>
</body>
```

共享 helper 是纯 DOM primitive：

```js
window.CaffShared.createManagementListItem({
  id: 'stable-id',
  active: true,
  compact: false,
});
// => { row: HTMLLIElement, button: HTMLButtonElement }
// row > button.agent-list-item[data-id]; button type=button;
// active 同步 class=active + aria-current=true。
```

### Stateful Object Census

本 milestone 不新增有生命周期的持久对象。页面 `state` 仍由各 page entry 独占；management list helper 是纯投影，route active 状态来自当前 HTML 的 `aria-current`，不落独立存储，因此 Stateful Object Gate 无新增转移表。

## Task 1: Management AppShell contract tests

**Files:**
- Create: `tests/ui/management-shell.test.js`
- Modify: `package.json`

1. 写失败测试：四页都有 `body.management-app`、management landmarks、完整 rail route 集和唯一 `aria-current`。
2. 写失败测试：旧 `.shell/.topbar/.ambient` chrome 不再存在，所有原有关键 id 仍存在。
3. 写失败测试：人格/Skill/模式/项目/指标列表容器均为 `UL`。
4. 写失败测试：共享 helper 产出 `LI > BUTTON`，保留 id/active/compact，原生 click 可触发。
5. 写失败测试：CSS 含固定视口、双栏有界滚动、<768 bottom rail/单列规则、44px 规则。
6. 写失败测试：`test:ui` 引入 repository-owned management verifier。
7. 将新测试加入 `test:fast`，执行：
   `node tests/ui/management-shell.test.js`
   预期：因当前仍是旧 topbar/div list 而 FAIL。

## Task 2: Shared semantic management list primitive

**Files:**
- Create: `public/shared/management-list.js`
- Modify: `public/personas.html`
- Modify: `public/skills.html`
- Modify: `public/projects.html`
- Modify: `public/metrics.html`
- Modify: `public/personas.js`
- Modify: `public/skills.js`
- Modify: `public/projects.js`
- Modify: `public/metrics.js`
- Modify: `package.json`

1. 为四页在 page script 前加载 `management-list.js`。
2. helper 注册到 `window.CaffShared`，不保存任何 state。
3. 五个 renderer 改为 helper 创建 button；事件委托继续查找 `.agent-list-item[data-id]`，无需新增键盘模拟代码。
4. 各 page entry 对 helper fail-fast，避免静默渲染半个页面。
5. `npm run check` 纳入 helper。
6. 运行 `node tests/ui/management-shell.test.js`，helper/列表测试应 GREEN，HTML shell 测试仍 RED。

## Task 3: Four-page AppShell migration

**Files:**
- Modify: `public/personas.html`
- Modify: `public/skills.html`
- Modify: `public/projects.html`
- Modify: `public/metrics.html`
- Modify: `public/styles.css`

1. 移除四页 ambient/topbar/legacy shell，只保留一次主 rail。
2. rail route 固定为 chat/personas/skills/projects/metrics，当前页唯一 `aria-current="page"`。
3. 迁移原 panel 内容到 management index/detail，原有 id 和表单嵌套不变。
4. 把 CAFF tokens 与 rail primitive 扩展到 `management-app`，不复制颜色常量。
5. desktop/tablet：root `100dvh + overflow:hidden`，index/detail 各自 `overflow:auto`。
6. mobile：rail bottom、management-main 留出 56px、content 单列并成为唯一滚动区。
7. 所有 button/link/input/select/textarea 最小触控高度 44px；textarea 保留业务所需 rows。
8. 运行 DOM/CSS tests，预期全 GREEN；运行 `npm run check` 与 `npm run typecheck:public`。

## Task 4: Isolated browser verification

**Files:**
- Create: `scripts/ui/verify-management-pages.mjs`
- Modify: `scripts/verify-ui.mjs`
- Modify: `tests/ui/management-shell.test.js`

1. helper 接收 `{ browser, baseUrl, ok, outputDir }`，不自行启动第二个 app。
2. 依次打开四页，验证 HTTP/console、active rail、document containment、pane 几何和所有可见目标 ≥44px。
3. 在 1440、820、375 验证 personas；375 必须 rail 位于底部且 content 单列无横向溢出。
4. 拦截 `/api/projects` 返回空集合，验证 empty state 与禁用动作，作为非 happy path。
5. 生成一张 `ui-v2-1440-management.png`；删除一张旧重复 chat screenshot，使整个 bundle 仍 ≤3 PNG + 1 WebM。
6. 运行 `npm run test:ui`，预期所有原 49 项 + 新管理页项全绿且临时 SQLite 零残留。

## Task 5: Truth/spec synchronization

**Files:**
- Modify: `designs/caff-ui-redesign-brief.md`
- Modify: `.trellis/spec/frontend/ui-structure.md`

1. brief 新增 Milestone 2 management AppShell 终态、响应式表和 Source Behavior / Must Preserve / Decision / Proof。
2. spec 新增 Management AppShell scope/signatures/contracts/error matrix/tests/wrong-vs-correct。
3. 明确 `body.chat-app` 与 `body.management-app` 共用 token/rail primitive，但滚动 owner 不同。
4. 运行 `git diff --check`。

## Task 6: Full gate and review handoff

1. 运行：
   - `npm run check`
   - `npm run typecheck:public`
   - `npm run test:fast`
   - `npm run test:smoke`
   - `npm run test:ui`
2. 检查 1440/820/375 证据与 console errors。
3. 使用 `quality-gate` 对照原需求与本计划。
4. commit body 写 Why、身份签名与 thread provenance。
5. 使用 `request-review` 请求跨个体 reviewer，作者不自审。
