---
feature_ids: [CAFF-UI-M4]
doc_kind: design
created: 2026-07-29
status: approved-direction
---

# CAFF-UI-M4 V3 Design Gate · 结构性消息布局重做

## 退回教训（V1 → V2）

- V1 错在把"参考 Clowder"译成收窄气泡 + 大留白。
- V2 错在只调 CSS token：780→1080 列上限、gap 12→8、padding 微调——**典型消息实际几何几乎没变**（同内容 assistant 554→549.2px）。机器双绿，operator 肉眼无感。
- V3 原则：**改变典型消息的结构与几何，不是调 token**。第一眼必须看得出"更宽、更紧凑、更少卡片化 chrome"。

## Clowder 真相源（packages/web/src/components）

- `MessageBubble.tsx:62,67`：消息行 = `flex gap-2 mb-4 items-start`（avatar + bubble 横向行），user 右 `max-w-[75%]`，assistant 左 `max-w-[85%] md:max-w-[75%]`。
- `ChatMessage.tsx:341-342`：system/tool 消息 = 居中宽行（`max-w-[85%] w-full`），弱 chrome 文本条。
- 关键洞察：Clowder 的"宽感"来自**行是全宽的**（avatar 占侧、气泡在行内），而非气泡本身多宽；系统消息干脆不要气泡壳。CAFF 的问题是每条消息一张独立卡片堆在居中窄列里，卡片 chrome 重量 > 内容重量。

## V3 结构方向

### 消息行两种形态（结构分化，不是宽度微调）

| 形态 | 适用 | 布局 | chrome |
|---|---|---|---|
| **transcript 行** | assistant / 系统常规消息 | 全列宽行（w-full，占满 1080 列），内容按文档流排布 | 无气泡壳：无背景块、无大圆角、无卡片 padding；仅紧凑 meta 行（sender · time · hover 操作）贴内容上方，左侧可用 `--agent-color` 细条/点标识归属 |
| **user 气泡** | user | 右对齐、fit-content 自然宽、轻 accent 底色气泡 | 保留气泡形态作方向区分；上限对齐 Clowder `max-w-[75%]`（以 1080 列计 ≈810px，远大于 V1 的 405px 实效） |

### 保留语义（不动）

- 失败消息 = 居中窄条（G5 语义）。
- digest 状态/结果卡 = 居中卡。
- SSE connection-dot 状态机、侧栏/抽屉/pill 行为。
- 移动档 new-msg-pill 右下锚定。

### 密度

- turn 间距由消息形态承担（transcript 行无卡片壳后天然更密），列表 padding 沿用 V2（space-3）。
- meta 行字号/间距保持 V2 紧凑值。

## 证据纪律（BLOCKING 硬约束，来自砚砚 ACTION）

1. before/after 必须**同会话、同主题、同 viewport、同 sidebar/drawer 状态、同滚动位置**：桌面 1440×820 与 375×800 各一组并排 PNG。before = 41b1300（V2）。
2. Red→Green 契约必须读**真实 computed geometry**（Playwright），不只匹配 CSS 字符串；覆盖短/中/长三类典型消息：
   - assistant 中/长消息行宽 ≥ 列宽 ~95%（transcript 形态）；
   - assistant 行无卡片壳（computed background/radius/padding 断言）；
   - user 短消息右对齐、宽度 ≤ 75% 列宽且 > V1 实效（405px @1440）；
   - 单屏可见消息数 ≥ V2 的 9。
3. 实现后先自做肉眼 A/B：第一眼分不出 → 不得回报完成。

## Open Questions（自行收敛，砚砚授权）

- assistant transcript 行的归属标识：左色条 vs meta 行彩点——实现时以 screenshot A/B 决定。
- tool trace 在 transcript 行内的呈现（缩进/折叠）保持现有 DOM，仅跟随行宽。
