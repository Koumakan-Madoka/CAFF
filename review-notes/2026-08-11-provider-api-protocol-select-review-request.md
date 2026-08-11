---
feature_ids: []
topics: [review-request, model-provider, api-protocol, ui]
doc_kind: review-request
created: 2026-08-11
---

# Review Request: 模型供应商 API 协议改为下拉选择

Review-Target-ID: provider-api-protocol-select
Branch: `feat/provider-api-protocol-select`
Code Commit: `4f7cfa8`

## What

- 将模型供应商编辑器的“API 协议”从自由文本输入改为原生 `select`。
- 下拉列出当前 Pi SDK 0.80.10 的 10 个内建 API 协议，新建供应商默认选择 `openai-completions`。
- 已有 provider 若携带非内建协议，将该值作为额外的“自定义”选项选中并原样保存。
- 保存 payload 继续提交协议字符串；后端校验与扩展协议契约没有变化。

## Why

API 协议是有限、稳定的运行时方言集合。自由输入会把拼写错误延迟到保存或运行阶段；下拉选择可在不放宽后端契约的前提下消除这类无效配置，同时避免无意覆盖历史扩展值。

## Original Requirements

> “模型供应商的API协议应该改成下拉可选的吧，毕竟一共就那么几种”

- 来源：CAFF 改造指挥中心 co-creator 消息 `0001786430469346-000111-e0ea89f3`，2026-08-11。
- 请对照实际操作判断：新建或编辑常规供应商时不应再手工拼写协议字符串。

## Tradeoff

没有删除后端的扩展协议能力，也没有重新开放“自定义协议”输入入口。常规新建路径只能选择内建协议；历史扩展值只在读取到该 provider 时作为兼容选项出现，避免静默改写。

## Architecture Ownership

Architecture cell: `model-provider-management-ui`
Map delta: none
Why: 只改变既有 provider 表单的输入 affordance 与客户端取值方式，不新增 Store、Router、Adapter、Dispatcher、Binding 或 API 边界。

请 reviewer 检查：

- diff 是否与 `Map delta: none` 一致；
- 10 个协议是否与当前固定 Pi SDK 的 `KnownApi` 完整对齐；
- 历史自定义值的 option 文本和值是否都经过转义且不会被保存路径改写；
- 从 input 改成 select 后，锁定态、草稿态和保存 payload 是否仍保持原契约。

## Open Questions

### 技术 OQ（给 reviewer）

1. 内建协议列表直接归属 provider editor 是否合理，还是当前代码中存在更可靠的浏览器侧单一真相源？作者已搜索 `public/` 与 provider 配置链，未发现可复用列表。
2. 历史扩展协议仅作为当前值额外 option，而不提供任意新建入口，是否正确平衡防拼写错误与兼容性？

### 价值 OQ（给 operator）

无。该交互调整与原始要求一致，不涉及新的产品取舍。

## Next Action

请独立复跑聚焦测试并审查上述 OQ；无 P1/P2 时给出 APPROVE verdict，作者随后进入 merge-gate。

## Review Sandbox

- Path: `E:\pythonproject\caff-provider-api-protocol-select`
- Bootstrap: `Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue; npm ci`
- Start Command: `npm run test:ui`（仓库 runner 自动分配隔离 loopback 端口与临时 SQLite/agentDir）
- Ports: dynamic loopback；禁止使用 `3003/3004`，不连接 Redis `6399`

## 自检证据

### Spec 合规

- 用户痛点：有限协议不应依赖手输；已改为 10 项下拉。
- 正常路径：新建 provider 选择协议并保存真实 payload。
- 非 happy path：历史自定义值显示为额外选项并原样保存。
- 交付完整性：无需后端、存储或 API 改动；无 deferred/follow-up 尾巴。
- Design：未匹配到 `designs/**/*.pen`；沿用现有字段网格、原生 select 与主题 token。
- Architecture：presentation-only，`Map delta: none`。
- Artifact hygiene：仓库根目录媒体/设计文件扫描为空。

### TDD

- RED：新增测试首先以 `INPUT !== SELECT` 失败 2 项。
- GREEN：聚焦 `model-input-capability-ui.test.js` 6/6 通过。

### 验证结果

- `npm run typecheck:public`：exit 0。
- `npm test`：exit 0（`test:fast` + `test:smoke`；smoke 68/68、ModeStore 20/20）。
- `npm run test:ui`：110/110 PASS，结构契约 15/15 green。
- `git diff --check`：clean。

### Dogfood-Your-Slice

- 隔离环境：临时 agentDir + 临时 SQLite + 动态 loopback 端口，真实 Microsoft Edge。
- 路径：`personas.html` → 模型供应商 → 添加供应商 → API 协议下拉 → 选择 `google-generative-ai` → 保存。
- 结果：DOM tag=`SELECT`、optionCount=10、PUT status=200、落盘 api=`google-generative-ai`、page/console/bad HTTP errors 均为空。
- 截图：`.tmp/provider-api-protocol-dogfood.png`。
- 历史占位扩展协议 `custom-stream-v2` 没有对应 Pi runtime，因此整站按既有规则 fail-closed；其“读到后不改写”兼容性由组件级回归测试覆盖，不把不可运行占位协议包装成 E2E 成功。
