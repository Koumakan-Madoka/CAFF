---
feature_ids: [CAFF-UI-M3]
topics: [frontend, ui, design-system, dark-mode, svg-icons, accessibility]
doc_kind: plan
created: 2026-07-25
---

# CAFF UI Theme and Line Icons Implementation Plan

**Feature:** CAFF UI Redesign Milestone 3 — `designs/caff-ui-redesign-brief.md`
**Goal:** 在不改变 M1/M2 信息架构、滚动所有权与业务契约的前提下，把 CAFF 的视觉语言收敛为克制的 light/dark 双主题，并以仓库自有线性 SVG 图标替换应用 chrome 中的 emoji。
**Acceptance Criteria:**
1. chat、personas、skills、projects、metrics 五条 route 在首帧前得到 `data-theme="light|dark"`；首次访问跟随系统，显式选择后跨 route 持久化。
2. 五条 route 都有 44px 主题切换按钮；按钮名称、title、`aria-pressed` 与图标随当前主题同步，键盘可操作。
3. 本地存储缺失、值损坏或访问被拒绝时页面仍可启动；无显式偏好时系统主题变化可实时投影，显式偏好优先。
4. 主导航、刷新、菜单、关闭、抽屉、新消息与 digest 类型等应用 chrome 不再使用 emoji/Unicode 图标，统一使用 repository-owned、`currentColor`、1.5–2px stroke 的 SVG symbol sprite。
5. 动态消息内容、用户/人格头像与游戏语义内容不被误改；“去 emoji”只约束产品 chrome。
6. light/dark 均使用平面语义 surface；应用 chrome 无装饰性渐变和毛玻璃，常规控件圆角 6–10px，12px 只用于大容器，999px 仅保留 avatar/status chip/progress 等语义圆形或胶囊。
7. 两主题下五条 route 的正文、边框、主按钮、输入框和选中态可读；1440/820/375 无 document 横向溢出，既有 44px 与滚动 ownership 契约不退化。
8. `npm run check`、`typecheck:public`、`test:fast`、`test:smoke`、`test:ui` 全绿；浏览器 verifier 独立覆盖两主题且 SQLite/会话零残留。
**Architecture cell:** `public/` plain-JS AppShell + management pages（仓库无 ownership map 文件）
**Map delta:** none
**Map delta why:** 新增的是共享表现层 token、主题偏好 owner 与图标资源，不新增服务、API、DB 或业务数据 owner。
**Architecture:** `public/shared/theme.js` 是主题偏好的唯一 lifecycle owner，在 CSS 前同步 bootstrap，并在 DOM 就绪后绑定所有 `[data-theme-toggle]`。`public/assets/icons.svg` 是唯一产品图标路径真相源；静态 HTML 直接 `<use>`，动态 renderer 通过无状态 `public/shared/icons.js` 创建同一种 SVG，不引入第三方依赖。
**Tech Stack:** plain HTML/CSS/JavaScript、SVG symbol sprite、localStorage + matchMedia、Node test runner、jsdom、Playwright Core + Edge
**前端验证:** Yes — reviewer 必须在真实 Edge 中检查 light/dark、1440/820/375、主题持久化、首帧和 SVG 图标。

---

## Finish Line

终态 B：operator 打开任一 CAFF 页面，都能在同一位置切换 light/dark；导航和动作图标像 Clowder 一样是克制的线条矢量图，页面由低层级暖中性色、细边框和少量强调色组织，不再依赖渐变、毛玻璃、大阴影、超大圆角和泛滥胶囊制造“精致感”。

**不构建：**

- 不引入 React、Tailwind、Lucide 或其他运行时/外部图标依赖。
- 不复制 Clowder 的完整主题编辑器、自定义主题或服务端主题持久化；CAFF 只提供 Light / Dark。
- 不改变 M1 drawer/sidebar 焦点状态机、M2 management scroll ownership、CRUD/API payload、元素关键 id。
- 不把用户消息、人格头像、游戏内容中的 emoji 当作产品 chrome 批量清除。
- 不 push、不创建 PR；远端边界继续由 operator 单独决定。

## Design Gate Audit

### Current CAFF（M2 @ `3087ef8`）

- 产品 rail 仍使用 💬/🎭/🛠️/📁/📊/⚙️；刷新、菜单、关闭、下拉和新消息也使用 Unicode glyph。
- `styles.css` 中有 29 处 `border-radius: 999px`、约 30 组 gradient、3 处 blur/backdrop surface 和多组 14–28px 阴影。
- 常规按钮继承橙色渐变 + 大阴影；conversation card 16px 圆角，empty state 22px，drawer tabs 和普通动作普遍胶囊化。
- 只有 light token；大量白色 alpha surface 与硬编码浅色使直接加 dark 根节点变量会出现亮斑。

### Clowder reference

- Activity rail 使用 `currentColor`、24×24 viewBox、1.5–2px stroke 的 inline/repository-owned SVG。
- Light/Dark 通过 `data-theme` token 分层；surface 以 warm neutral + 细 border 为主，accent 只用于选中/关键动作。
- 常规 rail item 约 8px 圆角，按钮与面板阴影克制，主题间保持相同布局与信息密度。

### Frozen M3 visual constraints

| Token / pattern | Light | Dark | Constraint |
|---|---|---|---|
| canvas | warm near-white | neutral charcoal | flat color, no page gradient |
| surface-sunk | slightly darker warm neutral | darkest rail/sidebar layer | rail/index ownership only |
| surface | white-warm | dark elevated neutral | main panel/input/card |
| text | near-black warm neutral | near-white neutral | normal text contrast ≥4.5:1 |
| accent | restrained burnt orange | lighter low-chroma orange | active/primary/focus only |
| border | low-contrast neutral | visible dark neutral | 1px, no glass border |
| radius | 6/8/10/12px scale | same geometry | 999px semantic-only |
| shadow | 0 1px 2px / 0 4px 12px | mostly border, rare soft shadow | no 14–80px decorative shadow |
| icons | 20px default, 1.75px stroke | `currentColor` | no colored emoji chrome |

## Terminal Theme / Icon Schema

每个 route 的 `<head>` 必须在 stylesheet 前同步加载主题 owner：

```html
<script src="/shared/theme.js"></script>
<link rel="stylesheet" href="/styles.css" />
```

每个 rail 的切换器共享同一 contract：

```html
<button class="rail-button theme-toggle" type="button" data-theme-toggle aria-pressed="false">
  <svg class="app-icon" aria-hidden="true"><use href="/assets/icons.svg#icon-moon"></use></svg>
</button>
```

静态产品图标：

```html
<svg class="app-icon" aria-hidden="true" focusable="false">
  <use href="/assets/icons.svg#icon-chat"></use>
</svg>
```

动态 renderer：

```js
window.CaffIcons.create('archive', { className: 'app-icon digest-icon' });
```

## Stateful Object Census

### Object: ThemePreference

- **唯一 lifecycle owner:** `public/shared/theme.js`
- **持久 key:** `caff:theme`
- **合法持久值:** `light | dark`
- **派生状态:** 没有合法持久值时由 `matchMedia('(prefers-color-scheme: dark)')` 纯投影，禁止另存 `system` 或复制到 page-specific state。
- **旁路禁止:** page entry、AppShell、management renderer 不得直接读写 `localStorage` 或 `document.documentElement.dataset.theme`。

| Current state | Event | Next state | Effect |
|---|---|---|---|
| boot | storage=`light|dark` | explicit-light/dark | CSS 前写 `data-theme`，忽略系统变化 |
| boot | storage missing/invalid | system-light/dark | CSS 前按 matchMedia 写 `data-theme`，监听系统变化 |
| system-light/dark | system media change | system-dark/light | 更新 DOM、toggle label/icon，不持久化 |
| system-light/dark | user toggle | explicit-dark/light | 更新 DOM，并尽力持久化合法值 |
| explicit-light/dark | user toggle | explicit-dark/light | 原子更新 DOM + 合法持久值 |
| any | storage event valid value | explicit-light/dark | 跨 tab 同步 DOM + controls |
| explicit-light/dark | storage event removes key | system-light/dark | 回到系统投影并恢复 media listener 语义 |
| any | localStorage denied | in-memory current mode | 不抛错；本页切换有效，跨 reload 不保证 |

### Invariants

- **INV-1:** stylesheet 解析前，`html[data-theme]` 必为 `light` 或 `dark`。
- **INV-2:** 持久层永远不写入 `system`、空串或未知值。
- **INV-3:** 显式偏好优先于系统主题；系统事件不能覆盖 explicit state。
- **INV-4:** 无显式偏好时，系统主题变化必须更新页面。
- **INV-5:** storage parse/read/write/remove 任一失败都不能阻断页面或点击。
- **INV-6:** route navigation/reload 后合法偏好保持一致；所有 toggle 的 label/icon 同步。
- **INV-7:** 图标 helper 是无状态纯 DOM 工厂；不存在第二套 icon path registry。

### Adversarial scenarios

1. localStorage getter 抛 `SecurityError`：bootstrap 仍使用系统/Light，点击仍切换本页。
2. key 值为 `sepia` 或损坏文本：忽略并进入 system state，不把非法值写到 DOM。
3. 页面加载后系统由 light 变 dark：仅 system state 跟随；explicit-light 保持 light。
4. 两个 tab 分别打开 chat/personas：一个 tab 切 dark，另一个通过 storage event 同步。
5. toggle 在主题 owner 初始化后才进入 DOM：DOMContentLoaded/bind 能同步正确 icon/label，无空白按钮。

## Task 1: Theme and icon contract tests（RED）

**Files:**
- Create: `tests/ui/theme-icons.test.js`
- Modify: `package.json`

1. 测五页在 stylesheet 前同步加载 `/shared/theme.js`，且每页有唯一 `[data-theme-toggle]`。
2. 用 jsdom + 可控 localStorage/matchMedia 写 ThemePreference 的 INV-1~6 失败测试。
3. 测五页 rail/chrome 使用 `/assets/icons.svg#icon-*`，应用 chrome 无 emoji/Unicode icon 文本。
4. 测 sprite 包含 chat/users/puzzle/folder/bar-chart/settings/sun/moon/menu/x/refresh/panel/arrow/archive/file-text/chevron symbols，路径统一 `fill="none"` + `currentColor` contract。
5. 测 `shared/icons.js` 创建 SVG/use 且未知 name fail-fast。
6. 测 CSS 终态 token contract：两主题、color-scheme、6/8/10/12px radius、无 scoped backdrop-filter、无产品按钮 gradient。
7. 把新测试加入 `test:fast`；运行 `node tests/ui/theme-icons.test.js`，预期因文件/contract 尚不存在而 FAIL。

## Task 2: Theme lifecycle owner（GREEN）

**Files:**
- Create: `public/shared/theme.js`
- Modify: `public/index.html`
- Modify: `public/personas.html`
- Modify: `public/skills.html`
- Modify: `public/projects.html`
- Modify: `public/metrics.html`
- Modify: `public/global.d.ts`

1. 在 IIFE 顶层同步解析合法偏好与系统主题，并立即写 `html.dataset.theme` + `colorScheme`。
2. 暴露最小 `window.CaffTheme`：`getTheme`、`hasExplicitPreference`、`setTheme`、`toggle`、`syncControls`。
3. DOMContentLoaded 绑定所有 toggle；更新 `aria-pressed`、title/label 和 sun/moon `<use>`。
4. 监听 matchMedia 与 storage event，严格遵守转移表。
5. 所有 storage 操作 try/catch；失败退化为本页内存态。
6. 跑 theme unit tests，预期 ThemePreference 测试 GREEN，其余 icon/CSS 测试仍 RED。

## Task 3: Repository-owned line icon system（GREEN）

**Files:**
- Create: `public/assets/icons.svg`
- Create: `public/shared/icons.js`
- Modify: `public/index.html`
- Modify: `public/personas.html`
- Modify: `public/skills.html`
- Modify: `public/projects.html`
- Modify: `public/metrics.html`
- Modify: `public/chat/conversation-digest-panel.js`
- Modify: `public/chat/conversation-settings.js`
- Modify: `public/global.d.ts`

1. 建立单一 SVG symbol sprite；viewBox=24，path/line/circle 使用统一圆头圆角 stroke。
2. 五页 rail、主题切换、刷新和 chat header/drawer controls 全部改为 `<svg><use>`；可见文字按钮保留文字，不为图标牺牲 label。
3. drawer toggle 使用 panel icon + 文本；new-message 使用 arrow icon + 文本。
4. digest `📦/📝` 改为 dynamic SVG；settings caret 改为 SVG chevron。
5. `shared/icons.js` 只持有 sprite URL/name validation 和 DOM 创建，不复制 path 数据。
6. 跑 icon contracts 与现有 AppShell tests，预期 GREEN。

## Task 4: Light/dark visual language convergence（GREEN / REFACTOR）

**Files:**
- Modify: `public/styles.css`
- Modify: `designs/mock-app-shell-a.html`
- Modify: `designs/caff-ui-redesign-brief.md`
- Modify: `.trellis/spec/frontend/ui-structure.md`

1. 把 legacy + `--caff-*` 变量归一为两套语义 token；保留旧 alias 仅作为迁移兼容，不让组件写主题分支。
2. 为 application scope 设置 flat canvas/surface/sunken/elevated、text/border/accent/semantic/shadow/radius/icon token。
3. 移除 scoped page/button/card/active-state gradient 与 drawer backdrop blur；普通按钮 8px、输入 8px、card 10px、大面板 12px。
4. conversation item、empty state、option card、message card、drawer tabs、file chip 等从硬编码白色/大圆角改为语义 surface；只有 avatar/status badge/chip 保留 999px。
5. dark theme 为 message/tool/game/status surfaces 提供可读语义色，不用“白色 alpha 盖在黑底”制造亮斑。
6. focus ring、danger/success/warning/info 在两主题保持 ≥3:1 非文本对比；正文/控件文字 ≥4.5:1。
7. mock 与 brief 升级为 M3/v6 truth，明确 chrome-vs-content emoji 边界、主题状态表和 visual anti-pattern。
8. 跑 `theme-icons.test.js`、`app-shell.test.js`、`management-shell.test.js`，预期全部 GREEN。

## Task 5: Isolated two-theme browser verification

**Files:**
- Create: `scripts/ui/verify-theme-icons.mjs`
- Modify: `scripts/verify-ui.mjs`
- Modify: `tests/ui/theme-icons.test.js`

1. verifier 复用现有隔离 app/browser，不自行启动第二个 server。
2. 五条 route 在 Light/Dark 各验证一次：`data-theme`、toggle label/icon、svg use、console/pageerror/HTTP、document containment。
3. 验证关键 computed styles：无 chrome gradient/backdrop blur；radius 上限；canvas/surface/text 在两主题确实不同且 contrast 达标。
4. 先清 storage 验证 system dark bootstrap，再 click 切 light、跨 route reload 验证持久化；注入非法值验证恢复。
5. 1440 覆盖五页；chat/personas 在 820/375 复跑 rail、scroll owner、44px 和横向 containment。
6. 生成 light/dark chat + dark management 三张 PNG，保留总证据上限 3 PNG + 1 WebM。
7. 运行 `npm run test:ui`，预期在原 61 项基础上新增 M3 checks，全 PASS 且 N1/N2 零残留。

## Task 6: Full gate and review handoff

1. 运行：
   - `npm run check`
   - `npm run typecheck:public`
   - `npm run test:fast`
   - `npm run test:smoke`
   - `npm run test:ui`
   - `git diff --check main...HEAD`
2. 用 `quality-gate` 对照 operator 原始反馈与本计划，而非只对照测试。
3. 启动独立临时 SQLite 预览并用 `browser-preview` 主动打开新版给 operator 看。
4. commit body 写 Why、身份签名与 thread provenance。
5. 使用 `request-review` 请求跨个体 reviewer；作者不自审，remote 继续不动。

