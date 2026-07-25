---
capsule_id: CAFF-UI-M3-2026-07-25
context: "CAFF UI M3：克制的 Light/Dark 双主题与仓库自有线性图标"
feature_ids: [CAFF-UI-M3]
topics: [frontend, ui, visual-design, dark-mode, svg-icons, reflection]
doc_kind: capsule
created: 2026-07-25
---

# CAFF UI M3 Reflection Capsule

## What Worked

- 把 operator 的三句原话原样放进 design truth 与 review packet，再分别转译为可验证约束：去装饰性 gradient/blur/大阴影与无语义 pill、五 route 共用 Light/Dark owner、产品 chrome 统一 `currentColor` 线性 SVG。
- `public/shared/theme.js` 以单一 lifecycle owner + 明确状态转移承载主题；`public/assets/icons.svg` 与无状态 `public/shared/icons.js` 保持单一路径真相，没有把表现层状态复制到各页面。
- Dogfood 真实走隐藏抽屉时发现 Dark `.agent-chip` 亮斑，先用合同测试与 computed-style probe 复现，再迁移到语义 surface，避免只验首屏产生假绿。
- 跨个体 code review、独立视觉守护和最终 local-main acceptance 分工清楚；R1 的 43.5px verifier 容差也经过 Red→Green 收紧为 frozen AC 的精确 44px。

## What Failed

- M1/M2 的结构与滚动契约正确，但当时没有把“AI 味”拆成 gradient、毛玻璃、超大圆角、胶囊和 emoji chrome 等可观测信号，导致结构验收通过后仍留下明显的审美偏差。
- 第一轮 M3 迁移遗漏隐藏抽屉里的参与者卡片；问题已在 implementation freeze 前通过 `docs/bug-report/caff-theme-participant-card/bug-report.md` 的 Red→Green 闭环解决。
- 初版 browser verifier 用 `>= 43.5` 检查 44px 触控目标，测试实现弱于 frozen contract；`a26a2a7` 已用合同测试锁死三处 `>= 44` 并完成 93/93 回归。
- 首次视觉守护结论中的 `@砚砚` 写在句中，没有触发路由；守护猫随后以行首 mention 正式重发，最终签收链完整。

## Trigger Missed

- 视觉重设计在最初 Design Gate 就应做 active chrome anti-pattern census，并把 operator 的审美语言转成 computed-style 与截图验收项；不能只在实现后凭“看起来更好”判断。
- 精确数值 AC 应从第一版测试开始使用同一边界，不能擅自加入没有平台证据的容差。
- 跨猫签收消息在发送前应执行行首路由出口检查；内容正确但未路由，仍然不算交付链完成。

## Doc Links

- [M3 implementation plan](../feature-specs/2026-07-25-caff-ui-theme-icons.md)
- [Design truth · Milestone 3](../designs/caff-ui-redesign-brief.md#11-milestone-3--lightdark-与线性图标)
- [Review request and original requirements](../review-notes/2026-07-25-caff-ui-theme-icons-review-request.md)
- [Participant-card diagnosis](../docs/bug-report/caff-theme-participant-card/bug-report.md)
- [Exact 44px verifier diagnosis](../docs/bug-report/caff-theme-toggle-verifier-threshold/bug-report.md)
- [Harness feedback](../docs/harness-feedback/2026-07-25-caff-ui-m3-theme-icons.md)
- [Final Close Gate Report](../review-notes/2026-07-25-caff-ui-theme-icons-close-gate.md)

## Rule Update Target

- `designs/caff-ui-redesign-brief.md §11` 已成为 CAFF 视觉 anti-pattern、主题状态与 icon boundary 的项目级规则锚点。
- `tests/ui/theme-icons.test.js` + `scripts/ui/verify-theme-icons.mjs` 已把上述规则变成 hard gate，包括隐藏 participant probe、两主题 computed style、44px 与 N1/N2 residue。
- `docs/harness-feedback/2026-07-25-caff-ui-m3-theme-icons.md` 记录本次 taste/translation gap；现有 feat lifecycle 已具备愿景守护机制，因此本次不修改跨项目 shared rules。
