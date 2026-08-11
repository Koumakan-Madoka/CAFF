# Review Verdict: Provider API Key 自动采用 literal 模式

- Review-Target-ID: fix-provider-secret-mode-autoliteral
- Reviewer: 宪宪/布偶猫 (opus)
- Date: 2026-08-11
- **Verdict: APPROVE**

## 核验范围

- 代码 commit `b104c18`（`public/personas/provider-editor.js` + `tests/runtime/model-input-capability-ui.test.js`）
- 后端契约：`server/domain/models/model-provider-config.ts` normalize/merge secret 路径
- 完整 `npm test` + build + typecheck:public + git diff --check

## Open Questions 逐项核验

### OQ1 已有 literal secret 留空仍保留 ✓
- 前端：`normalizePlainSecretMode('literal', '')` → value 空 → `draft.hasApiKey ? mode : 'none'` → hasApiKey=true 返回 `literal`。
- 后端：`secretValue=''` 且 `currentMode('literal') === requestedMode('literal')` → 不触发 `provider_secret_value_required`，原 secret 保留（`model-provider-config.ts:418-422`）。

### OQ2 env/command 不被归一化覆盖 ✓
- `normalizePlainSecretMode` 首行 `if (mode !== 'none' && mode !== 'literal') return mode;` → env/command 直接放行。
- input 事件与 `updateSimpleFields` 两处调用一致，不会改写高级模式。
- 边界：env 模式下误填普通 key 输入框 → buildPayload 仍走 `pendingAuthReference`，普通 key 不进入 payload，无污染。

### OQ3 非空普通 Key + none → 归一化 literal ✓
- `if (value.trim()) return 'literal';` 且即时同步 select 下拉框，payload 使用 literal + key。
- 新供应商（hasApiKey=false）空输入 → `none`，避免无凭据的 `literal + empty` 无效态。

## 风险确认

- 手动选 literal 但留空 key（hasApiKey=false）→ 保存时静默归一化为 none：这是防御正确行为（literal+空 无意义），且符合"以 Key 意图优先"原则。
- external 认证投影为 none，输入 key 会转 literal：用户显式输入 key 的意图覆盖，页面声明不写外部认证，无副作用。
- 基线失败 `tests/ui/model-family-roles-production.test.js`（index.html legacy 人格术语）为本 branch 之前既有状态：b104c18 未改 index.html，该文件也不在 `test:fast`/`test` 收录，与本改动无关。

## Verification（独立复跑）

| 检查 | 结果 |
| --- | --- |
| `node tests/runtime/model-input-capability-ui.test.js` | 4 pass / 0 fail |
| `node tests/runtime/model-provider-config.test.js` | 14 pass / 0 fail |
| `node tests/http/model-providers-controller.test.js` | 7 pass / 0 fail |
| `npm test` | exit 0 |
| `npm run build` | exit 0 |
| `npm run typecheck:public` | exit 0 |
| `git diff --check b104c18^ b104c18` | clean |

## 结论

表单边界归一化收口正确：同时避免 `none + value`（422 原痛点）与无凭据的 `literal + empty`，后端严格校验与盲读契约未放宽。APPROVE。

[宪宪/布偶猫 · opus · deepseek-v4-flash🐾]
