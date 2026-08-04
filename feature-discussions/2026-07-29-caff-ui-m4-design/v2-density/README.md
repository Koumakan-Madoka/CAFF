---
feature_ids: [CAFF-UI-M4]
doc_kind: evidence
created: 2026-07-29
status: rejected-by-operator
---

> **V2 再次被 operator 人工验收退回（2026-07-29，T0 msg 0001785323300156-003167-82755333）："不是，怎么感觉没什么区别啊"。**
> 根因：验收坐标系错了——V2 优化了"最大可用容量"与 CSS token，典型消息实际布局几乎没变（同内容 assistant 554→549.2px、user 405.1→400.3px）。机器指标双绿 ≠ 肉眼可感知。本目录保留为失败实验证据，V3 见 `../v3-structure/`。

# CAFF-UI-M4 V2 密度量测（before → after）

量测脚本：`scripts/ui/measure-density.mjs`（隔离 app + 真实浏览器，1440×820 与 375×800，28 条证据消息）。
Before = V1（HEAD 2d4dc67），After = V2 密度版。

## 桌面 1440×820（sidebar open，可用列宽 1104px）

| 指标 | V1 before | V2 after | 变化 |
|---|---|---|---|
| 内容列上限 | 780px | 1080px | +38%，填满实测可用宽 |
| 卡片间距 gap | 12px | 8px | -33% |
| 卡片 padding (X×Y) | 28.8×20.8px | 24×14.4px | Y -31% |
| 消息列表 paddingY | 48px | 24px | -50% |
| 气泡 max-width | assistant 85% / user 75% | 100%（内容自然宽） | 取消人为收窄 |
| 单屏可见消息卡 | 8 | 9 | +1（同内容更矮更密） |

## 移动 375×800

| 指标 | V1 before | V2 after | 变化 |
|---|---|---|---|
| 气泡宽 | 288.6px（88% 上限） | 336px（全列） | +16% |
| 气泡高（assistant 样例） | 121.1px | 89.5px | -26% |
| 列表 paddingX | 32px | 24px | -25% |

## V2 决策记录

- 列宽 1080px 的依据：实测 sidebar open 时 message-list 可用宽 1104px，1080 近填满；sidebar 关闭（1384px）时保留舒适边距。非拍脑袋百分比。
- 气泡去收窄：`width: fit-content` 保留短消息自然宽，长消息可至全列；方向对齐（user 右 / assistant 左）不变。
- 保留语义：失败居中窄条、digest 卡居中、SSE connection-dot 状态机、移动档 new-msg-pill 右下角锚定。
- Composer 输入列（composer-inner/footer）同步放宽至 1080px，跟随聊天列。
