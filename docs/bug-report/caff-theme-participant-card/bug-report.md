---
feature_ids:
  - caff-ui-redesign
topics:
  - dark-theme
  - participant-drawer
  - visual-regression
doc_kind: bug-report
created: 2026-07-25
---

# Dark theme participant card 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | Dark 主题打开聊天“上下文面板 → 参与者”时，Agent 卡片仍显示为浅灰色超大胶囊。期望是与抽屉同属暗色 token、采用克制的小圆角卡片；实际造成突兀亮斑并延续了用户明确不想要的“AI 风胶囊”视觉。 |
| **2. 证据** | 预览 `http://127.0.0.1:64098/`，截图 `chat-dark-drawer.png` 稳定复现；监听进程 PID 11796 在 `9d15863` 后启动。`public/styles.css` 的 legacy `.agent-chip` 直接使用 `background: rgba(255, 255, 255, 0.72)` 与 `border-radius: 999px`，M3 token override 未覆盖该组件。 |
| **3. 确认根因** | 参与者卡片遗漏在 M3 的 theme-consumer 迁移清单之外，因此 Dark 主题仍继承旧版只适合浅色玻璃拟态的颜色与 pill geometry。不是主题状态、缓存或 renderer 数据问题。 |
| **4. 诊断策略** | 对照已经 token 化的 drawer cards，逆向检查 `.agent-chip` 的 computed style；在合同测试中锁定 token 与非 pill 半径，并让浏览器 verifier 同时比较 Light/Dark 的真实 computed style。 |
| **5. 超时策略** | 若 scoped override 仍不能改变 computed style，检查 selector source order 与 specificity；若两轮仍失败，停止叠 selector，改为删除 legacy declaration 并统一组件 owner。 |
| **6. 预警策略** | 任一 Dark screenshot 出现接近白色的 chrome/card 大面积背景，或浏览器 gate 未验证隐藏抽屉/弹层组件时，视为主题覆盖不完整，不能仅凭五条 route 首屏放行。 |
| **7. 用户可见交互修正** | 参与者由浅灰胶囊改为一列紧凑暗色卡片；Light/Dark 均使用同一语义 surface/border/text token，头像环也不再硬编码白色。 |
| **8. 验收** | `theme-icons.test.js` 先红后绿；`verify-theme-icons.mjs` 对注入的 participant probe 验证 Light/Dark 背景确实不同、Dark 更暗、文字对比度 ≥ 4.5、圆角 ≤ 12px；重拍 Dark drawer 截图并跑完整 UI gate。 |
