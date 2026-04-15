# PRD: 04-15-caff-docs-lane-split

## Goal
把 README 中的 Feishu / OpenSandbox 可选集成内容拆成独立 lane 文档，使 README 只保留"最小启动指路牌"角色，每个高级集成各有 Prerequisites → Setup → Verify → Troubleshoot 四段式指南。

## Context
- 父评审任务 `04-15-caff-deployability-newcomer-friendliness` (P2) 识别出 README 承载了太多可选集成细节，新手路径不清晰。
- P1 (readiness/health view) 已落地，`/api/health` 可用于验证 optional 集成状态。
- 现有 `docs/windows-local-stack.md` 已是四段式独立 lane doc 的良好范本。

## Scope
- In scope:
  - 新建 `docs/feishu-integration.md`
  - 新建 `docs/opensandbox-setup.md`
  - README 瘦身（OpenSandbox + Feishu 部分 → 摘要 + 链接）
  - `docs/local-chat-ui.md` 补充交叉引用
- Out of scope:
  - Windows local stack 文档（已有独立 lane doc）
  - package.json 依赖优化（属于 P3 任务）
  - UI 变更

## Acceptance Criteria
- [x] 新建 `docs/feishu-integration.md`，包含 Prerequisites / Setup Steps / Environment Variables / Verification / Troubleshooting / Limitations
- [x] 新建 `docs/opensandbox-setup.md`，包含 Prerequisites / Setup Steps / Environment Variables / Recommended Config / Pre-baked Image / Verification / Troubleshooting
- [x] README OpenSandbox 段落缩减为 3~5 行摘要 + 链接到 `docs/opensandbox-setup.md`
- [x] README Feishu 段落（环境变量表 + 飞书接入 MVP + 配置步骤）缩减为 3~5 行摘要 + 链接到 `docs/feishu-integration.md`
- [x] README Step 3 进阶集成表格保持不变
- [x] `docs/local-chat-ui.md` 补充"进阶集成见…"交叉引用
- [x] 新手只读 README 能完成最小运行 + 验证
- [x] 每个 lane doc 有四段式结构（Prerequisites → Setup → Verify → Troubleshoot）
- [x] `npm run typecheck` 通过（纯文档变更）
