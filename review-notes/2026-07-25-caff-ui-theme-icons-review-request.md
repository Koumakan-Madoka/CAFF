---
feature_ids: [CAFF-UI-M3]
topics: [review-request, quality-gate, dark-mode, svg-icons, visual-regression]
doc_kind: review-request
created: 2026-07-25
---

# Review Request: CAFF Light/Dark 与线性图标视觉收敛

Review-Target-ID: `ui-redesign-theme-icons`
Branch: `ui-redesign-theme-icons`
Implementation SHA: `76eb5072e194cc71221a79653a0b78d1d4436634`
Review range: `9d158631612560f01e46d181070cd192825b3755..76eb5072e194cc71221a79653a0b78d1d4436634`

## What

- 五条 route 新增 CSS 前同步启动的 Light/Dark 主题 owner，首次跟随系统，显式选择后跨 route/跨 tab 持久同步。
- rail、主题、刷新、菜单、关闭、抽屉、新消息、digest 与 caret 全部改为仓库自有 `currentColor` 线性 SVG sprite；静态服务器补齐 `image/svg+xml`。
- 用平面语义 surface、细边框、6/8/10/12px 几何收敛聊天与四个管理页；删除产品 chrome 的渐变、毛玻璃、大阴影和无语义胶囊。
- 新增 12 项 M3 合同测试与两主题浏览器 verifier；最终隔离 Edge 门禁为 93/93。

## Why

M1/M2 已解决 AppShell、滚动所有权和管理页 IA，但视觉仍依赖玻璃拟态、超大圆角、emoji chrome 与浅色硬编码。M3 在不重开信息架构、不改 CRUD/API/DB 的前提下，直接回应 operator 对“AI 味”、双主题和 Clowder 式线性图标的反馈。

## Original Requirements

> “UI 比原来的好很多，但是 AI 味道还是有点重。”
> “UI 我想改支持 dark 和 light 两种风格。”
> “图标不要 emoji 风格，要线条矢量图的风格（类似 Clowder 的）。”

- 来源：`designs/caff-ui-redesign-brief.md` 的 M3 原始反馈映射（并锚定 source thread message `0001784943824058-001634-16bccd22`）。
- **请 reviewer 对照上面的摘录判断交付物是否真正降低了合成式视觉感，而不只检查 AC。**

## Tradeoff

- 保持 plain HTML/CSS/JS，不引入 Lucide、React、Tailwind 或运行时图标依赖；代价是 16 个 SVG symbol 由仓库自己维护。
- 只提供 Light/Dark，不复制 Clowder 的完整主题编辑器或服务端主题同步；主题偏好仅使用 `caff:theme`。
- “去 emoji”严格限制为产品 chrome；用户消息、人格头像和游戏语义内容保留，避免破坏业务表达。

## Architecture Ownership

Architecture cell: `public/` plain-JS AppShell + management pages（仓库无 ownership map 文件）
Map delta: `none`
Why: 新增共享表现层 token、主题偏好 owner 与图标资源，不新增服务、API、DB、Store、Queue、Router、Adapter、Dispatcher 或 Binding。

请 reviewer 检查：

- `public/shared/theme.js` 是否真的是唯一主题 lifecycle owner，五页是否存在旁路状态；
- `public/assets/icons.svg` + `public/shared/icons.js` 是否保持单一路径真相；
- `Map delta: none` 是否与 diff 一致。

## Open Questions

### 技术 OQ（给 reviewer）

1. CSS 前 bootstrap、system projection、显式偏好、storage event 和 denied-storage 降级是否存在遗漏转移边。
2. Dark 下隐藏抽屉、长 Skill editor、消息/tool/game surface 是否还有浅色硬编码亮斑或无语义 pill。
3. 浏览器 verifier 的 participant probe、target 可见性、对比度与 radius 采样是否可能 false green。
4. SVG sprite 的 MIME、路径 allowlist、`currentColor` 与动态 renderer 是否存在第二套 icon registry 或加载时序风险。

### 价值 OQ（给 operator）

无。

## Next Action

请对冻结 implementation SHA 做跨家族、只读全量 review；在独立 sandbox 复跑真实浏览器路径后返回 `APPROVE`，或返回带 severity、文件/行号和复现证据的 `BLOCK`。不要修改作者 worktree；需要接管时另开正式 worktree。

## Review Sandbox

- Path: `C:\Users\ZN\AppData\Local\Temp\cat-cafe-review\ui-redesign-theme-icons\opus`
- Bootstrap: `npm ci --include=dev`
- Start/Validation: `npm run test:ui`（自起动态 loopback 端口 + 临时 SQLite，无固定端口）
- Author preview（只供目视，不作为 reviewer 独立证据）：`http://127.0.0.1:64098/`

## Quality Gate Report

Spec: `feature-specs/2026-07-25-caff-ui-theme-icons.md`
原始需求：`designs/caff-ui-redesign-brief.md` M3 反馈映射
检查时间：2026-07-25
Worktree/URL: `E:\pythonproject\caff-ui-theme-icons` / `http://127.0.0.1:64098/`

### 愿景覆盖

| # | operator 原始需求 | AC | 实现与证据 |
|---|---|---|---|
| 1 | 降低“AI 味” | AC-6/7 | flat semantic surfaces；chrome 无 gradient/blur；radius ≤12px；Light/Dark/移动端截图已目视。 |
| 2 | 支持 Light/Dark | AC-1/2/3/7 | CSS 前 owner、系统投影、显式持久、跨 tab、denied storage；五页两主题浏览器实测。 |
| 3 | emoji 图标改为 Clowder 式线性矢量图 | AC-4/5 | repository-owned 1.75px SVG sprite；chrome glyph scan 零命中；内容语义 emoji 保留。 |

### Delivery completeness

- 完整 M3，不需要重写；五条 route、shared owner、sprite、MIME、CSS、mock/brief/spec、合同测试和浏览器 verifier 均在同一 implementation SHA。
- 未发现未处置 AC 或尾项；active truth diff 的阻塞词扫描为空。

### Dogfood-Your-Slice

Scope verdict: ✅ 必做（最终用户可感知 UI）

- 真实路径：隔离预览 → 切 Dark → 打开聊天上下文抽屉 → 检查参与者 → 滚动最长 Skill editor 至底部。
- 发现 bug：Dark 参与者仍继承 legacy `rgba(255,255,255,.72)` + `999px` 胶囊。
- 处理：先加失败合同测试与 browser computed-style probe，再把组件迁移到 `--caff-surface-elevated` + 10px；复拍得到 `rgb(37,40,37)` / 10px，随后 93/93。
- 诊断：`docs/bug-report/caff-theme-participant-card/bug-report.md`。

### 设计稿与证据

- `designs/**/*.pen`: 无匹配；本仓延续冻结的自包含 HTML mock `designs/mock-app-shell-a.html`，已升级 v7 并实测切换。
- Evidence dir: `C:\Users\ZN\AppData\Local\Temp\caff-ui-theme-icons-qg-0b3d2fc7e5f24e83bac50473b0c627b0`

| 需求 | 证据 |
|---|---|
| Light 桌面与长聊天 | `ui-v2-1440-long.png` |
| Dark 管理页与长编辑器 | `ui-v2-1440-management.png` |
| Dark 375 响应式与底部 rail | `ui-v2-375.png` |
| 主题/抽屉/移动 walkthrough | `ui-v2-walkthrough.webm` |

### Artifact Hygiene

- 工作树根目录媒体：无。
- `main...HEAD` 根目录媒体：无。
- 所有截图、录屏与 results JSON 仅在系统临时 evidence 目录。

### Architecture / fallback audit

- Architecture cell / Map delta / Why 已在 plan 与本 packet 声明；仓内没有 ownership-map checker。
- 仓内没有 hotfix/fallback 专用脚本；手工扫描新增 owner：`theme.js` 仅两处 storage `try/catch`，分别保护 read 与 write，不构成 ≥3 层 fallback。
- `caff:theme` / `dataset.theme` / theme localStorage owner bypass 扫描仅命中 `public/shared/theme.js`。
- 产品 chrome emoji/Unicode glyph 扫描零命中。

### 验证命令

```text
npm run check                                      -> exit 0
npm run typecheck:public                           -> exit 0
npm run typecheck                                  -> exit 0
node --test tests/ui/theme-icons.test.js
  tests/ui/app-shell.test.js
  tests/ui/management-shell.test.js                 -> 35/35 PASS
npm run test:fast                                  -> exit 0, all suites 0 failed
npm run test:smoke                                 -> 61/61 + 20/20 PASS
npm run test:ui                                    -> 93/93 PASS, N1/N2 zero residue
git diff --check main...HEAD                       -> exit 0
root media hygiene (worktree + main...HEAD)         -> zero matches
```

## Close Gate Report

```yaml
close_gate_report:
  feature_id: CAFF-UI-M3
  spec_path: feature-specs/2026-07-25-caff-ui-theme-icons.md
  head_sha: 76eb5072e194cc71221a79653a0b78d1d4436634
  report_date: 2026-07-25
  ac_matrix:
    - ac_id: AC-1
      status: met
      evidence: [public/shared/theme.js, tests/ui/theme-icons.test.js, "test:ui Q-*-theme"]
      resolution: null
    - ac_id: AC-2
      status: met
      evidence: ["five route theme toggles", "44px browser snapshots", "D1 keyboard order"]
      resolution: null
    - ac_id: AC-3
      status: met
      evidence: ["jsdom invalid/denied/storage/media tests", "browser system/persist/invalid checks"]
      resolution: null
    - ac_id: AC-4
      status: met
      evidence: [public/assets/icons.svg, public/shared/icons.js, "chrome glyph scan"]
      resolution: null
    - ac_id: AC-5
      status: met
      evidence: ["chrome-scoped contract test", "semantic content boundary in brief/spec"]
      resolution: null
    - ac_id: AC-6
      status: met
      evidence: ["public/styles.css M3 tokens", "max radius <= 12.1", "gradient/backdrop none"]
      resolution: null
    - ac_id: AC-7
      status: met
      evidence: ["five routes x two themes", "contrast >= 4.5", "820/375 containment", "44px targets"]
      resolution: null
    - ac_id: AC-8
      status: met
      evidence: ["check/typecheck/fast/smoke/UI all green", "N1/N2 zero residue"]
      resolution: null
```

## Relevant Documents

- Plan: `feature-specs/2026-07-25-caff-ui-theme-icons.md`
- Design truth: `designs/caff-ui-redesign-brief.md`
- Mock: `designs/mock-app-shell-a.html`
- Frontend contract: `.trellis/spec/frontend/ui-structure.md`
- Dogfood diagnosis: `docs/bug-report/caff-theme-participant-card/bug-report.md`
