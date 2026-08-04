---
feature_ids: [CAFF-UI-M3]
topics: [bug, frontend, theme-toggle, responsive-layout, navigation-rail]
doc_kind: bug-report
created: 2026-07-25
---

# Bug 诊断胶囊：Light/Dark 切换按钮跨 route 漂移

| 栏位 | 内容 |
|---|---|
| **1. 现象 / 报告人** | co-creator 在 M3 预览中反馈：“看上去好多了！就是开灯/关灯按钮的 UI 有时候会漂移”（message `0001784959791360-001861-2693bf69`）。同一页面内切换 Light/Dark 时按钮外框和 SVG 坐标不变；从 chat 进入管理页时位置明显跳动。 |
| **2. 证据 / 复现步骤** | Runtime preflight：`PORT=64098`、`PID=11796`、worktree HEAD `b4fd50f`、accepted product target `a26a2a7`；target 之后只有 verifier/test/docs 与 close docs，无产品布局变更。Edge 实测 1440×900：chat toggle `y=792`，四个 management route 均为 `y=280`；375×800：chat `x=270.34`，management `x=316.20`。每页点击前后 button/SVG 均为 `Δx=0, Δy=0`。 |
| **3. 确认根因** | `body.chat-app .rail .spacer { flex: 1; }` 只覆盖 chat，management 的同名 spacer 没有弹性，主题按钮因此紧跟第五个导航项而不是贴底。chat 又把 `rail-settings-button` 放在 theme toggle 之后；移动端 `space-around` 会按不同子项数量重新分配槽位。三处差异共同破坏了“所有 route 同一位置切换”的契约。 |
| **4. 诊断策略** | 用同一 Edge context 逐一加载五条 route，在 1440/375 读取 rail、toggle、SVG 和 rail children 的 bounding rect；切换主题后再次读取，以区分 icon swap、focus ring 与跨 route flex geometry。随后把跨 route terminal offset 加入 browser verifier。 |
| **5. 超时策略** | 若统一 spacer 与终端 DOM 顺序后仍有 `>1px` 偏差，停止叠加 margin/transform，重新采集 flex item 顺序、padding、gap 和 viewport safe-area computed style；最多两轮假设，不做视觉补丁堆叠。 |
| **6. 预警策略** | Browser gate 断言桌面主题按钮距 rail 底边 `12±1px`、375px 距 rail 右边 `8±1px`，并验证 Light→Dark 切换自身坐标变化不超过 `0.5px`。静态合同同时要求 theme toggle 是每条 route 的最后一个 interactive rail control。 |
| **7. 用户可见交互修正** | chat 将会话设置放到 theme 前；chat/management 共用弹性 spacer；移动 rail 隐藏 spacer 并使用 `space-between`。主题按钮始终占 rail 的终端槽位：桌面固定在左下，移动端固定在右下。 |
| **8. 验收** | Red：新增合同测试先得到 `13 pass / 3 fail`（chat DOM 终端顺序、共享 spacer/mobile distribution、browser offset gate）。Green：targeted contract `16/16`；首次全 UI 暴露旧 D1 focus-order 预期并得到 `108/109`，同步为 `settings → theme` 后复跑 `109/109`。最终真实 Edge 证据：五条 route 桌面 `bottomGap=12`、375px `rightGap=8`，逐 route Light/Dark 切换 `Δx=0, Δy=0`，console/page/response diagnostics 全 clean。 |
