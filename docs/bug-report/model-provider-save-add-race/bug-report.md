---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [bug, provider-management, concurrency, ui, testing]
doc_kind: bug-report
created: 2026-08-03
---

# Provider save → add → cancel race

### Bug 诊断胶囊：Provider 保存期间可并发创建草稿

| 栏位 | 内容 |
|---|---|
| **1. 现象** | 保存新 Provider 后立刻点击“添加供应商”再放弃草稿，偶发残留 `__draft-*` 列表行。期望一次 Provider mutation 完成前不能开始第二个管理状态转换。 |
| **2. 证据** | Reviewer 在 detached `fcae97f` sandbox 中将 `tests/ui/model-family-roles-production.test.js` 连跑 8 次，1 次在 abandoned-draft assertion 失败。 |
| **3. 根因** | 保存请求到达 server 后，UI 的 `setProviders(result.providers)` / `onProvidersChanged()` 尚未完成；此时 Add 仍可点击，使本地草稿状态与稍后到达的 server truth 交错覆盖。测试只等待 PUT 入站，放大了这条真实交互竞态。 |
| **4. 诊断策略** | 在 production Edge fixture 中为下一次 Provider PUT 加可控 response gate；请求 pending 时读取 Add disabled、list/detail inert 与 `aria-busy`，释放 response 后再验证保存结果和草稿放弃。 |
| **5. 超时策略** | 若 20 分钟内可控 gate 不能稳定复现，则缩小到 `createProviderManagement` 的浏览器 VM 状态机测试，不靠随机压力循环。 |
| **6. 预警策略** | 若禁用 Add 后仍出现草稿残留，说明竞态来自 selection/render ownership，而不是并发 mutation 入口，需要重画 Provider management 状态转换。 |
| **7. 用户可见交互修正** | Provider 保存、清密钥、验证或移除进行中时，Provider 列表、详情和“添加供应商”暂时不可交互，并以 `aria-busy` 表明忙碌；完成后恢复。 |
| **8. 验收** | 可控 pending response 下 production Edge 测试必须先 RED 后 GREEN；单测压力复跑、`npm test`、typecheck、check 与 `git diff --check` 全绿。 |

[砚砚/gpt-5.6-sol🐾]

## Verification

- RED: controlled pending Provider response observed `addDisabled=false`, `listInert=false`, `detailInert=false`, `aria-busy=null` and failed the new assertion.
- GREEN: one centralized mutation lock now covers save, clear-secret, remove and validate through response projection and role-directory refresh; Add, Refresh, list and detail interactions remain unavailable until the transition completes.
- Failure-mode audit: the first GREEN exposed the sibling Refresh entry point; a second deterministic RED observed `refreshDisabled=false`, then the same lock closed it.
- Stress: `node tests/ui/model-family-roles-production.test.js` passed 12/12 consecutive runs for the initial fix and 8/8 after the Refresh audit.
- Regression: `npm run check`, `npm run typecheck`, `node tests/ui/new-conversation-dialog.test.js` and full `npm test` passed; smoke remained 64/64.
- Reviewer P3-1 was not changed: exact source already contains an explicit 900px viewport assertion for one-column fields and two-column model rows.
- Reviewer P3-2 was accepted: the existing-roster-only recovery invariant now has an inline comment at the construction boundary.
