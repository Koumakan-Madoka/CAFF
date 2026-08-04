---
feature_ids:
  - caff-ui-redesign
topics:
  - app-shell
  - ui-regression
  - test-gate
doc_kind: bug-report
created: 2026-07-24
---

# AppShell review R2 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 离底后的“新消息”提示会被消息 renderer 的 `replaceChildren()` 删除，随后闭包保留失效节点；tool trace 子树变化又会误报新消息。Composer 被程序化清空/恢复后仍保留 160px 高度。标准 checkout 的 `test:ui` 缺依赖且默认打固定服务/数据库。v5 brief/spec 与 v4 mock 的 tab IA 不一致。 |
| **2. 证据** | BLOCK 基线 `9935bd8`；`app-shell.js` 把 pill 放进 `#message-list` 并观察 `subtree:true`；`message-timeline.js` 把该容器视为 message-card-only；`app.js` 与 mention-menu 直接写 composer `.value`；`playwright-core` 未声明；mock 只有 5 tab。 |
| **3. 确认根因** | 两类不变量被破坏：① renderer-owned DOM 与 shell-owned UI 必须有独立所有权，消息变化必须由稳定 message id 判定；②程序化输入值变化必须与高度同步走同一入口。另有 active truth / regression gate 未自包含，导致本地证据无法在干净 checkout 重放。 |
| **4. 诊断策略** | 追踪 DOM ownership、所有 composer 写入点、服务启动/SQLite/端口路径与 brief→mock→spec 映射；为每条复现先加仓内红测。 |
| **5. 超时策略** | 若 renderer 测试无法稳定复现，降到 direct-child message-id 状态机的 jsdom 测试，并用 Playwright 连续 replacement 复核；若服务托管不稳定，复用 smoke test 的 free-port/wait/stop 模式。 |
| **6. 预警策略** | 再出现依赖 subtree mutation 推断业务事件、程序化 `.value` 写入绕过统一入口、固定端口/共享 DB、或 brief/mock/spec 分裂时停止点修，回到所有权/真相源边界。 |
| **7. 用户可见交互修正** | 新消息提示不再永久消失或被工具展开误触发；发送成功后输入框回落，失败恢复后重新撑高；UI 门禁不触碰已有本地服务/数据。 |
| **8. 验收** | jsdom：renderer replacement、tool-trace subtree、composer clear/restore、mock v5 IA；Playwright：真实连续更新与 composer 成功/失败；`test:ui` 自起隔离服务、拒绝非 loopback 目标、校验临时会话删除/零残留，并产出 3 张截图 + walkthrough；全量门禁通过。 |

## Quality-gate dogfood 补充

- 视觉取证发现 `.message-list` 在固定高度 grid 内把大量隐式行压成 34px；正文虽存在于 DOM，却溢出 `.message-card` 后被 `overflow:hidden` 裁掉。
- 根因是“固定视口”只锁了容器滚动，没有锁“消息行保持 intrinsic height”的配套不变量。
- 防护：`grid-auto-rows: max-content` + 真实浏览器断言 `message-body` 的矩形必须完整落在所属 card 内。

## Failure-mode audit

- DOM/state ownership：扫描 `public/shell/app-shell.js` 的 MutationObserver、`public/chat/message-timeline.js` 的 renderer 边界，以及 `public/app.js` / `public/chat/mention-menu.js` 的 composer 写入点。
- Active truth：扫描 `designs/caff-ui-redesign-brief.md`、`designs/mock-app-shell-a.html`、`.trellis/spec/frontend/ui-structure.md` 和 `scripts/verify-ui.mjs` 的 tab/验证声明。
- 防护：direct-child message-id diff、统一 composer setter、唯一 run id + 隔离 SQLite/动态端口、mock IA 回归断言。
