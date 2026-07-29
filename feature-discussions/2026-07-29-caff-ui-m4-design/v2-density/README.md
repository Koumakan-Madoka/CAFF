---
feature_ids: [CAFF-UI-M4]
doc_kind: evidence
created: 2026-07-29
status: complete
---

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
