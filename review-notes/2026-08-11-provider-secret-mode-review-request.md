# Review Request: Provider API Key 自动采用 literal 模式

Review-Target-ID: fix-provider-secret-mode-autoliteral
Branch: fix/provider-secret-mode-autoliteral
Code Commit: b104c18

## What

- 普通 API Key 输入非空时，将表单模式从 `none` 自动归一化为 `literal`，并即时反映在模式下拉框。
- 尚无已保存 Key 且普通输入为空时保持 `none`；`env` / `command` 仍为显式高级模式。
- 新增聚焦回归测试，覆盖 UI 模式变化与最终保存 payload。

## Why

没有已保存凭据的供应商会投影为 `apiKeyMode: "none"`。此前用户输入明文 Key 后，前端仍提交 `none + 非空 apiKey`，后端按既有严格契约返回 422 `provider_secret_mode_invalid`。

## Original Requirements

> 配置 api-key 后，点击保存模型供应商，后端报错 422：
> `provider_secret_mode_invalid`
> 路径：`providers.kimi-for-coding.apiKey`
> 手动把认证模式切换成 `literal` 后可以保存。
> “每次都要切换成 literal 不是一个好设计吧，需要改一些。”

- 来源：CAFF 改造指挥中心当前 co-creator 对话，2026-08-11。
- 请对照上面的实际操作判断：输入普通 Key 后不应再要求用户手动选择 `literal`。

## Tradeoff

没有把所有新供应商默认设成 `literal`，否则无凭据供应商会形成 `literal + 空值` 的另一种无效状态。也没有放宽后端 validator；修复位于表单到请求 payload 的边界。

## Architecture Ownership

Architecture cell: model-provider-management-ui
Map delta: none
Why: 仅收口现有 provider editor 的表单状态归一化，不新增 Store / Queue / Router / Adapter / Dispatcher / Binding，也不改变 API 或持久化边界。

## Open Questions

### 技术 OQ

- 请重点核验：已有 literal secret 且输入框为空时仍保持“留空即保留”；`env` / `command` 不会被普通 Key 归一化逻辑覆盖。
- 请核验非空普通 Key 与 `none` 的组合是否应始终以 Key 的明确用户意图优先，归一化为 `literal`。

### 价值 OQ

无。该行为直接落实 operator 已确认的交互期望。

## Quality Gate Report

### 愿景与交付完整性

- 原始痛点：输入普通 API Key 后不应再手动切模式。
- 交付：完整修复该路径；高级认证模式、后端安全校验和凭据盲读契约均不变。
- Tips exemption：纠正既有表单状态错误，没有新增能力或使用入口。

### Functional Coverage

| 要求 | 实现 | 验证 |
| --- | --- | --- |
| 输入普通 Key 时自动切换 literal | `public/personas/provider-editor.js` | 聚焦 node:test + 浏览器 dogfood |
| 保存 payload 使用 literal + Key | 同上 | `model-input-capability-ui.test.js` |
| 不放宽后端验证 | 无后端 diff | provider config / HTTP tests + 全量 `npm test` |

### Design / Artifact / Architecture Checks

- `designs/**/*.pen`：无匹配设计稿；本次没有布局或视觉设计变化。
- 仓库根目录媒体/设计工件：无。
- Fallback layer：仅一个表单归一化 helper，无 3 层 fallback。
- PowerShell 测试缓存已从 worktree 移至系统临时目录，没有纳入提交。

### Dogfood-Your-Slice

- Worktree: `E:\pythonproject\caff-provider-secret-mode-fix`
- URL: `http://127.0.0.1:3201/personas.html`（隔离 agentDir / SQLite；验证后已停止）
- 真实路径：添加供应商 → 输入普通 API Key → 下拉框即时显示 `literal` → 保存成功 → 隔离 `models.json` 持久化 literal secret。
- 结果：`modeAfterInput=literal`，保存成功，无 422。
- 截图：
  - `C:\Users\ZN\AppData\Local\Temp\cat-cafe-evidence\provider-secret-mode\01-before-key.png`
  - `C:\Users\ZN\AppData\Local\Temp\cat-cafe-evidence\provider-secret-mode\02-key-selects-literal.png`
  - `C:\Users\ZN\AppData\Local\Temp\cat-cafe-evidence\provider-secret-mode\03-saved.png`

### Verification

```text
npm run build                         exit 0
npm run check                         exit 0
npm run typecheck:public              exit 0
node tests/runtime/model-input-capability-ui.test.js   4 pass, 0 fail
node tests/runtime/model-provider-config.test.js       14 pass, 0 fail
node tests/http/model-providers-controller.test.js      7 pass, 0 fail
node tests/runtime/model-family-roles-ui.test.js         5 pass, 0 fail
npm test                               exit 0
git diff --check                       exit 0
```

补充：`tests/ui/model-family-roles-production.test.js` 在进入 provider 流程前会因仓库既有 `public/index.html still exposes legacy 人格 terminology` 基线断言失败；本 branch 未修改该套件，真实浏览器 dogfood 已独立覆盖本修复路径。

## Review Sandbox

- Suggested path: `E:\pythonproject\caff-review-provider-secret-mode-opus`
- Source: branch `fix/provider-secret-mode-autoliteral`, code commit `b104c18`
- Bootstrap: `npm ci`, then `npm run build`
- Start: set `CHAT_APP_HOST=127.0.0.1`, `CHAT_APP_PORT=3202`, isolated `PI_CODING_AGENT_DIR` / `PI_SQLITE_PATH`, then run `node scripts/start-app.js`
- Ports: web/api=`3202`; do not use reserved `3003/3004` or Redis `6399`.

## Next Action

请 @opus 独立复跑关键测试并给出 APPROVE 或 REQUEST CHANGES；重点审查表单状态机是否同时避免 `none + value` 与无凭据的 `literal + empty`。

[砚砚/gpt-5.6-sol🐾]
