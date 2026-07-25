---
feature_ids: [CAFF-UI-M3]
topics: [bug, ui-verifier, accessibility, touch-target]
doc_kind: bug-report
created: 2026-07-25
---

# Bug 诊断胶囊：主题切换器 verifier 放宽了 44px 契约

| 栏位 | 内容 |
|------|------|
| **1. 现象** | M3 spec 要求五条 route 的主题切换按钮至少为 44px，但浏览器 verifier 使用 `>= 43.5`，会让 43.5–43.99px 的未来回退假绿。当前实际 computed size 是 44px，产品 UI 尚未发生可见失败。 |
| **2. 证据** | `scripts/ui/verify-theme-icons.mjs` 在桌面宽/高和 820/375 responsive 三处使用 43.5；合后 `test:ui` 输出的真实 `toggleSize` 为 44。来源：R-M3 P3 R1 与愿景守护复核。 |
| **3. 问题假设或根因** | 根因已确认：verifier 为可能的浏览器子像素舍入保留了 0.5px 容差，却没有同步修改 frozen AC；测试实现因此弱于唯一真相源。 |
| **4. 诊断策略** | 先新增静态合同测试，明确 verifier 必须逐处使用 `>= 44` 且不得残留 `>= 43.5`；观察其以阈值失配为原因失败，再最小修改 verifier。 |
| **5. 超时策略** | 10 分钟内若 targeted test 不能稳定红灯，停止修改并重新核对测试读取路径与 regex，而不是继续改产品 CSS。 |
| **6. 预警策略** | 若改为 44 后真实浏览器 gate 失败，说明页面确有亚像素回退，应诊断布局 computed size；禁止把阈值重新放宽来换绿灯。 |
| **7. 用户可见交互修正** | 无直接视觉变化；修复提高未来回归防护，保证 44px 触控目标承诺不会被 verifier 容差架空。 |
| **8. 验收** | RED：`node --test tests/ui/theme-icons.test.js` → 12 pass / 1 fail，失败精确命中 `>= 43.5`。GREEN：三处阈值改为 `>= 44` 后 targeted suite 13/13；`npm run check`、完整 `typecheck`、`test:fast`、`test:smoke` 全绿，`npm run test:ui` 93/93，desktop/820/375 实测主题按钮均为 44px，N1/N2 零残留。 |
