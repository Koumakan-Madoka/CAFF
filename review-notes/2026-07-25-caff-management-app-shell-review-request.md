---
feature_ids: [caff-ui-redesign]
topics: [management-app-shell, ui-review, accessibility, responsive-layout]
doc_kind: review-request
created: 2026-07-25
---

# Review Request: CAFF AppShell Milestone 2

Review-Target-ID: ui-redesign-management-pages
Branch: ui-redesign-management-pages
Implementation SHA: `fcb44fb2da827575719b012321323e22e652e446`
Review range: `df33ea65df54a2d13dea2304e98d8ffcb3e1ab66..fcb44fb2da827575719b012321323e22e652e446`

## What

- 将 `personas.html`、`skills.html`、`projects.html`、`metrics.html` 从各自的大 topbar/可增长 document 迁到统一 Management AppShell：56px rail、稳定 header、有界 index/detail 工作区。
- 保留四页全部现有 CRUD/filter API、表单、路由和关键 DOM id；没有后端、数据库或持久状态变化。
- 将人格、Skill、模式、项目、指标五个可选集合统一为原生 `ul > li > button`，由无状态 `public/shared/management-list.js` 投影。
- 新增 repo-owned 管理页浏览器 verifier，并接入现有动态端口、临时 SQLite、loopback-only `npm run test:ui`；证据包继续限制为 3 PNG + 1 WebM。
- brief 与 frontend spec 同步 Management AppShell 的 scope、签名、响应式滚动 owner、状态矩阵和测试契约。

## Why

Milestone 1 只修复聊天工作台，四个管理页仍保留重复 topbar、非语义 click target 与 page-level scrolling，导致同一产品在不同路由上出现两套导航和交互模型。Milestone 2 把已经验证的固定视口 IA 延伸到管理工作流，同时把业务 API/state 留在原 page entry，避免用换框架或后端重写代偿布局问题。

## Original Requirements

> “目标不是补一个 `height:100vh`，而是……重新建立清晰、耐用、可扩展的 CAFF 体验。”
> “5 个管理子页的路由结构（personas/skills/projects/metrics）”属于必须保留资产。
> co-creator 2026-07-24 指令：“开始里程碑2的构建吧”。

- 来源：原始 discussion 消息 `0001784816816154-000775-8ec47b15`；`designs/caff-ui-redesign-brief.md` §§1.4、3、10；`feature-specs/2026-07-25-caff-ui-management-pages.md`。
- 请 reviewer 对照判断四个管理路由是否真正进入同一工作台，而不是只换了颜色或加一个高度补丁。

## Tradeoff

- 保留 plain-JS、现有页面 state 与服务契约；共享 helper 只创建 DOM，不建立第二套选择状态或 store。
- 桌面/平板让 index 与 detail 各自滚动；手机改为一个 `.management-content` 内部滚动区，避免两个窄小嵌套滚动面。
- CSS 继续放在仓库既有 `public/styles.css`，但全部由 `body.management-app` 作用域隔离并复用现有 token/rail primitive；没有引入第二套 token 或 CSS 工具链。
- 证据包不扩容：用管理页桌面截图替换原重复 drawer 截图，保留聊天长会话、手机与 walkthrough 回归证据。

## Architecture Ownership

Architecture cell: `public/` plain-JS management pages（仓库无 ownership map 文件）
Map delta: none
Why: 只迁移既有四条 route 的页面 composition、语义 DOM 与验证契约；没有新增 Store / Queue / Router / Adapter / Dispatcher / Binding，也没有数据 owner 转移。

请 reviewer 检查：

- `Map delta: none` 是否与 diff 一致，特别是 shared helper 是否保持无状态；
- `body.chat-app` / `body.management-app` 的 CSS scope 和滚动 owner 是否互不污染；
- 原 page entry 的 CRUD/filter 与 tab 行为是否因 DOM 结构迁移发生隐性漂移。

## Close Gate Report

```yaml
close_gate_report:
  feature_id: caff-ui-redesign-m2
  spec_path: feature-specs/2026-07-25-caff-ui-management-pages.md
  head_sha: fcb44fb2da827575719b012321323e22e652e446
  report_date: 2026-07-25
  ac_matrix:
    - ac_id: M2-A1-shell-contracts
      status: met
      evidence: ["tests/ui/management-shell.test.js 9/9", "four HTML landmarks + preserved ids"]
      resolution: null
    - ac_id: M2-A2-semantic-collections
      status: met
      evidence: ["public/shared/management-list.js", "browser Enter selection PASS"]
      resolution: null
    - ac_id: M2-A3-responsive-scroll-ownership
      status: met
      evidence: ["1440/820 bounded panes", "375 one internal scroll region", "zero document overflow"]
      resolution: null
    - ac_id: M2-A4-isolated-browser-verifier
      status: met
      evidence: ["npm run test:ui 61/61", "temporary SQLite zero residue"]
      resolution: null
    - ac_id: M2-A5-truth-sync
      status: met
      evidence: ["brief §10", ".trellis/spec/frontend/ui-structure.md Management AppShell"]
      resolution: null
    - ac_id: M2-A6-full-gate
      status: met
      evidence: ["check", "typecheck:public", "test:fast", "test:smoke", "test:ui", "diff --check"]
      resolution: null
```

Follow-up tail scan: no actionable tail; all six plan tasks are met. No cvo signoff or scope deletion is used.

## Failure-Mode Sweep

- Legacy chrome: four HTML files contain no `.ambient`, `.shell`, `.topbar`, `topbar-nav`, or `topbar-link`.
- Route/current truth: each page has the same five ordered rail links and exactly one matching `aria-current="page"`.
- DOM contract drift: all original critical ids remain; list event delegation still resolves `.agent-list-item[data-id]`; helper loads before each page entry and fails fast if absent.
- Scroll ownership: desktop/tablet panes report `overflow:auto`; mobile panes report `visible` while content reports `auto`; document width/height never exceeds viewport at 1440/820/375.
- Touch/accessibility: browser sweeps every visible button/link/text control and checkbox/radio label hit area; undersized result is empty on all pages and responsive sizes.
- Runtime/data safety: verifier reuses one runner-owned isolated app, intercepts only deterministic read payloads for keyboard/empty tests, and leaves zero verification conversations.

## Evidence Mapping

| Requirement | Evidence |
|---|---|
| Management desktop shell and bounded panes | `ui-v2-1440-management.png`; browser checks `P-personas` through `P-metrics` |
| Long chat still fixed after shared CSS changes | `ui-v2-1440-long.png`; AppShell A1–A10 |
| Mobile bottom rail / containment | `ui-v2-375.png`; management `P-responsive 375` |
| End-to-end interaction sequence | `ui-v2-walkthrough.webm` |

Evidence directory: `C:\Users\ZN\AppData\Local\Temp\caff-ui-verify\08ed4dbc`

## Dogfood-Your-Slice

Scope verdict: required (user-visible UI).

- Real path: isolated `E:\pythonproject\caff-ui-redesign` build → `http://127.0.0.1:52892/personas.html` → Hub Browser Preview.
- HTTP proof: `/personas.html` returned 200 after final build; preview uses temporary `PI_SQLITE_PATH` and `.env.local` disabled.
- Browser path: deterministic personas payload → focus second `li > button` → Enter → active/editor switched to “验证人格 B”; projects empty payload → semantic empty `li` + unavailable actions disabled.
- Dogfood findings: no open bugs. One quality issue caught and fixed during gate: brief frontmatter retained the v5 review provenance while adding v6 status; one fail-open `networkidle.catch` was removed.

## Open Questions

### Technical OQ

1. Please stress the mobile single-scroll model with the longest Skill editor/file workspace and confirm no content overlap or unreachable actions.
2. Please independently exercise personas/skills/modes/projects/metrics selection and CRUD/filter controls, checking that semantic list migration did not alter business behavior.
3. Please inspect the 352-line scoped CSS block for selector leakage and verify that keeping it in the existing shared stylesheet is preferable to a second CSS request in this no-bundler app.
4. Please audit the management verifier for false-green conditions, especially target visibility filtering, intercepted empty payloads, and diagnostics propagation.

### Value OQ

None. The operator explicitly started Milestone 2, and the four-route scope is frozen in the implementation plan.

## Review Sandbox

- Path: `$env:TEMP\cat-cafe-review\ui-redesign-management-pages\opus`
- Bootstrap:

```powershell
git worktree add --detach "$env:TEMP\cat-cafe-review\ui-redesign-management-pages\opus" fcb44fb2da827575719b012321323e22e652e446
Set-Location "$env:TEMP\cat-cafe-review\ui-redesign-management-pages\opus"
npm ci --include=dev
npm run test:ui
```

- Interactive start: run `npm run build`, then start `node build/lib/app-server.js` with `CAFF_DISABLE_ENV_LOCAL=1`, a temporary `PI_SQLITE_PATH`, and `CHAT_APP_PORT=3221`.
- Ports: `web=3221`, `api=3221` (same-origin `/api/*`; 3003/3004 remain untouched).

## Verification

```text
npm run check            -> exit 0
npm run typecheck:public -> exit 0
npm run test:fast        -> exit 0 (includes AppShell 14/14 + Management 9/9)
npm run test:smoke       -> exit 0 (server 61/61 + mode-store 20/20)
npm run test:ui          -> 61/61 PASS
git diff --check         -> exit 0
```

- Design brief SHA256: `E8C9DEA89A588E24AD1417BBD985EB046A8D09527B6D239D3FE54E38590B80D4`.
- `.pen` glob: no match; the active direction remains the approved HTML fixture + brief.
- Artifact hygiene: no root-level media/design artifacts in worktree or commit range.
- No remote push or PR was created.

## Next Action

Please perform a read-only cross-family full review of the frozen implementation SHA and return `APPROVE` or a concrete `BLOCK` with file/line and browser reproduction evidence. Do not modify the author worktree; TAKEOVER requires a separate formal worktree.

[砚砚/gpt-5.6-sol🐾]
