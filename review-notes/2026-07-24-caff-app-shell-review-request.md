---
feature_ids: [caff-ui-redesign]
topics: [app-shell, ui-review, accessibility, regression-gate]
doc_kind: review-request
created: 2026-07-24
---

# Review Request: CAFF AppShell Milestone 1 · review R3

Review-Target-ID: ui-redesign-app-shell
Branch: ui-redesign-app-shell
Implementation SHA: `7fbde58b76ee80e6873c6fbe3ced9aaeff672dc5`
Review range: `9935bd8143cf8c478b3a8e622bd589494d218bf3..7fbde58b76ee80e6873c6fbe3ced9aaeff672dc5`

## What

- 将新消息 pill 移出 renderer-owned `#message-list`，以 direct-child `data-message-id` 差集驱动提示，忽略 tool-trace 子树变化。
- 统一 composer 程序化 clear / restore / mention 插入到 `caffShell.setComposerValue()`，同步 44–160px 高度。
- `npm run test:ui` 改为 repo-owned Playwright runner：动态端口、临时 SQLite、`.env.local` 禁用、loopback-only override、run-id 清理与零残留断言。
- v5 mock/brief/spec 同步为 6 常显 + 2 条件 tab；证据包固定为 3 张截图 + 16 秒 walkthrough。
- Quality Gate dogfood 额外修复长会话 grid 行被压成 34px、正文被裁切的 P1，并补真实浏览器矩形断言。

## Why

固定视口只解决 document 无限增长还不够：shell chrome 与消息 renderer 必须分属不同 DOM ownership；程序化输入变化必须与布局同步；真实浏览器门禁必须可在干净 checkout 用隔离数据重放。视觉取证又证明，若消息行不保持 intrinsic height，固定视口会把“页面变长”替换成“正文被裁掉”，同样违背长期会话目标。

## Original Requirements

> 桌面聊天工作台固定在视口内；标题、主要操作、输入框稳定可达。
> 消息区独立滚动；聊天变长不会增加 document 高度，也不能牺牲消息正文可见性。
> 目标是整体重设计聊天工作台，而不是局部补一个 `height:100vh`。

- 来源：`designs/caff-ui-redesign-brief.md` §§1.2、3、6、8.8
- **请对照以上摘录判断交付物是否真正解决了长期会话体验。**

## Tradeoff

- 保留 plain-JS 与既有 panel controller，只通过 `window.caffShell` 总线接线；没有借机换框架。
- 采用稳定 message id，而不是继续从任意 DOM mutation 猜业务事件；要求 renderer 输出 id，但避免 tool trace/streaming 内部变化误报。
- 采用 `grid-auto-rows: max-content` 保留现有居中 grid，而非改写为 flex 列；改动更小，浏览器断言锁住正文 containment。
- `playwright-core` 进入 devDependency，浏览器继续使用宿主 Edge channel；这是既定本地 CAFF 验证环境，不下载额外浏览器包。
- HTML mock 继续是 active design fixture；无 `.pen`，不伪造 Pencil provenance。

## Architecture Ownership

Architecture cell: `frontend/chat-app-shell`
Map delta: none
Why: 本轮扩展既有 AppShell 的 DOM ownership、composer bus 与验证契约；没有新增并行 Store / Queue / Router / Adapter / Dispatcher / Binding。

请 reviewer 检查：

- diff 是否与 `Map delta: none` 一致；
- shell/renderer ownership 是否还有交叉写入；
- `window.caffShell` 新增方法是否保持单一入口而非制造第二套状态源。

## Failure-Mode Sweep

- DOM ownership：扫描 `app-shell.js` MutationObserver 与 `message-timeline.js` renderer replacement；pill 只在 `.message-viewport`，observer 关闭 `subtree`。
- 程序化输入：扫描全部 `public/**/*.js`，除 shell setter 内部外无 `composerInput.value =` 写入。
- 隔离门禁：扫描启动、端口、SQLite、env、DELETE 与 finally；非 loopback target 先拒绝，异常清理不再 silent catch。
- 固定视口内容：A4 新增 `message-body` rect 必须完整位于 card rect 内，防止“能滚但内容被裁”。

## Open Questions

### 技术 OQ

1. 请重点复核 pill 在 renderer replacement、离底/回底和 conversation render 交错下的 pinned ownership。
2. 请独立验证 `grid-auto-rows: max-content` 对真实长文本、tool trace 与 375px 视口均没有新的高度/横向溢出。
3. 请核对 emergency cleanup 在主流程失败时既不吞错，也不会触碰非本 run title prefix 的会话。

### 价值 OQ

无。管理子页仍不迁入 AppShell，是已确认的 Milestone 1 边界。

## Next Action

请布偶猫/宪宪对冻结 implementation SHA 做跨个体全量 review，浏览器实操后给出 `APPROVE` 或带复现证据的 `BLOCK`。不要修改作者 worktree；若需 TAKEOVER，另开正式 worktree。

## Review Sandbox

- Path: `$env:TEMP\cat-cafe-review\ui-redesign-app-shell\opus`
- Bootstrap:

```powershell
git worktree add --detach "$env:TEMP\cat-cafe-review\ui-redesign-app-shell\opus" 7fbde58b76ee80e6873c6fbe3ced9aaeff672dc5
Set-Location "$env:TEMP\cat-cafe-review\ui-redesign-app-shell\opus"
npm ci --include=dev
npm run test:ui
```

- Interactive start: `npm run build` 后以临时 `PI_SQLITE_PATH`、`CAFF_DISABLE_ENV_LOCAL=1`、`CHAT_APP_PORT=3220` 启动 `node build/lib/app-server.js`。
- Ports: `web=3220`, `api=3220`（同源 `/api/*`；避开 3003/3004）。

## 自检证据

### Spec 合规

- 原始固定视口/独立滚动/稳定 header+composer 需求已覆盖。
- v5 active truth：mock SHA256 `C64B57CEC4968B167BEC724B63D46F333786CAE167C3C119265BF067896476DD`。
- brief SHA256 `01B629FF4453AC99C83E43AFAC594D60EE1EAC7E8BB3D6F6422FED044728777E`。
- `.pen` glob：无匹配；HTML mock 是明确记录的 active fixture。
- Architecture ownership：`Map delta: none`；active UI spec 已同步。

### 测试结果

```text
npm run check       -> exit 0
npm run typecheck   -> exit 0
npm run test:fast   -> exit 0（含 app-shell 14/14、message-tool-trace 10/10）
npm run test:smoke  -> exit 0（server 61/61、mode-store 20/20）
npm run test:ui     -> 49/49 PASS
git diff --check    -> exit 0
```

Browser evidence: `C:\Users\ZN\AppData\Local\Temp\caff-ui-verify\c47bc9d7`

- `ui-v2-1440-long.png`
- `ui-v2-1440-drawer-goal.png`
- `ui-v2-375.png`
- `ui-v2-walkthrough.webm`（16.00s, 1280×720, VP8）

Artifact hygiene: repository root media/design artifacts = none；worktree 在 implementation commit 后 clean。

[砚砚/gpt-5.6-sol🐾]
