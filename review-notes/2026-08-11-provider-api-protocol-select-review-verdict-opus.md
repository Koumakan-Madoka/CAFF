# Review Verdict: 模型供应商 API 协议改为下拉选择

- Review-Target-ID: provider-api-protocol-select
- Reviewer: 宪宪/布偶猫 (opus)
- Date: 2026-08-11
- **Verdict: APPROVE**

## 核验范围

- 代码 commit `4f7cfa8`（`public/personas/provider-editor.js` + `tests/runtime/model-input-capability-ui.test.js`）
- 隔离 diff：`92d8225..9e75676`（仅 28 行 provider-editor 行为增量 + 56 行测试；review request 文档另算）
- 协议清单与固定 Pi SDK 版本对齐、历史自定义值转义与保存契约、锁定态/草稿态

## Review Packet 要求逐项核验

### 1. diff 是否与 `Map delta: none` 一致 ✓
- 仅改 `public/personas/provider-editor.js`（`apiProtocolOptions` 渲染 + `updateSimpleFields` 取值）+ 对应测试。
- 无 Store/Router/Adapter/Dispatcher/Binding/API 边界改动，presentation-only。符合 `Map delta: none`。

### 2. 10 个协议是否与固定 Pi SDK 的 `KnownApi` 完整对齐 ✓
- 权威来源：`@earendil-works/pi-coding-agent@0.80.10`（package.json:43 固定版本）内嵌 `@earendil-works/pi-ai` 的 `dist/types.d.ts:14`：
  `KnownApi = "openai-completions" | "mistral-conversations" | "openai-responses" | "azure-openai-responses" | "openai-codex-responses" | "anthropic-messages" | "bedrock-converse-stream" | "google-generative-ai" | "google-vertex" | "pi-messages"` — **10 项与 PR 完全一致**。
- 注意：顶层 `@mariozechner/pi-ai@^0.68.1` 的 `KnownApi` 是旧版（含 `google-gemini-cli`、无 `pi-messages`），但该包仅是间接依赖；CAFF 直接依赖且运行时使用 `pi-coding-agent@0.80.10`，故以 0.80.10 为准，PR 列表正确。

### 3. 历史自定义值的 option 文本和值是否转义且不被保存路径改写 ✓
- 自定义分支：`const escaped = utils.escapeHtml(current)` 同时用于 `value="${escaped}"` 与 `textContent`。`management-utils.js:20-24` 的 `escapeHtml` 转义 `&<>'"` 全部 5 个字符 → attribute 注入安全。
- 浏览器解析 `<option value="custom-stream-v2">` 自动解码实体，`select.value` 返回原始字符串 → `draft.api` 保持 `custom-stream-v2` 原样。测试 `preserves a historical custom API protocol` 断言 `payload.api === 'custom-stream-v2'` ✓。
- 内建 option 走 `API_PROTOCOLS` 常量（无外部输入），value 未转义无风险。

### 4. input → select 后锁定态、草稿态、保存 payload 契约 ✓
- 原 input 的 API 协议字段本就没有 readonly（对比 provider-id 有 `${isDraft ? '' : 'readonly'}`），改 select 不引入新锁定差异。
- `updateSimpleFields()` 无分支，草稿/已存 provider 一致读取 `select('provider-api-protocol').value.trim()`，payload 仍为字符串，后端校验/扩展契约未放宽（server 侧无协议枚举校验）。
- 新建默认：无 selected 时浏览器选中首项 `openai-completions`，符合"新建默认 openai-completions"。

## Open Questions 核验

### OQ1 内建协议列表归属 provider editor 是否合理 ✓
- 已搜 `public/` 与 provider 配置链，无现有浏览器侧协议常量可复用；provider-editor 是唯一消费方。硬编码 10 项常量与固定版本 Pi SDK 对齐，属可接受单一真相源。附带测试用 `KNOWN_API_PROTOCOLS` 镜像断言，防漂移。

### OQ2 历史扩展值仅作为额外 option 而不开放任意新建 ✓
- 防拼写错误与兼容性平衡正确：常规新建只能选内建协议，历史扩展值读到即保留、不被静默改写，后端扩展契约未收紧。符合 Tradeoff 声明。

## Verification（独立复跑）

| 检查 | 结果 |
| --- | --- |
| `node tests/runtime/model-input-capability-ui.test.js` | 6 pass / 0 fail（含协议 select、保存、历史自定义 3 项新增） |
| `git diff --check 92d8225 4f7cfa8` | clean |
| 协议清单 vs `pi-coding-agent@0.80.10` KnownApi | 10/10 一致 |

## 结论

协议下拉与当前固定 Pi SDK 0.80.10 完全对齐，历史扩展值转义且原样保存，input→select 不破坏锁定态/保存契约，测试覆盖三态。无 P1/P2。APPROVE，可进入 merge-gate。

[宪宪/布偶猫 · opus · deepseek-v4-flash🐾]
