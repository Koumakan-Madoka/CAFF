---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, verdict, roles, participants, conversations, feishu, games, skill-test, accessibility]
doc_kind: review-verdict
created: 2026-08-03
status: approved
review_target_sha: 02e58cc
review_diff: 01d134f..02e58cc
reviewer_family: ragdoll
author_family: maine-coon
---

# Review Verdict: Model-family Explicit Participant Policies — APPROVE

## Verdict

`APPROVE` for exact code SHA `02e58cc`, diff `01d134f..02e58cc`.

独立 reviewer sandbox: `E:\pythonproject\caff-roles-review-02e58cc`（detached `02e58cc`，全新 `npm ci`，未触碰生产数据、Redis 6399、3003/3004），未在主分支上读写砚砚的工作树。

## Independent Evidence

逐项脱离作者自检自述复跑：

```text
npm ci --no-audit --no-fund
  added 389 packages

npm run typecheck
  PASS (tsc -p tsconfig.typecheck.json && tsc -p tsconfig.public.json)

npm test
  full fast suite PASS; smoke 64/64; fail 0; duration ~9.8s

node tests/ui/new-conversation-dialog.test.js
  PASS production new-conversation dialog contract (real headless Edge CDP)

node tests/runtime/new-conversation-dialog.test.js
  PASS 4/4: snapshot freezes runnable defaults / final explicit runnable roster / custom modes & games require own explicit player selection / skill test design keeps selected current roles and adds only skill metadata

node --test tests/http/feishu-controller.test.js
  PASS 11/11, 含三条针对本切片的新断言：
  - feishu new rooms use only configured default roles and merge mode skills into that explicit roster
  - feishu new rooms return setup_required and write no conversation when default roles are missing or invalid
  - feishu existing bindings keep their roster without defaults while slash-new requires setup

node --test tests/storage/chat-store.test.js
  PASS 20/20，含：chat store rejects missing/empty/unknown/duplicate/invalid-profile participant rosters before writing
  （每次断言失败后 chat_conversations 计数仍 = 0；getOrCreateExternalConversation 的 empty 路径同样被阻断）

node tests/smoke/server-smoke.test.js
  PASS 64/64，含：
  - bootstrap leaves an empty conversation database untouched（payload.selectedConversationId===null，conversation/conversation_agents 两表计数均为 0）
  - conversation create validates the explicit roster and only merges mode skills into supplied participants
    · missing/empty roster → 400 `participants_required`
    · unknown roleId        → 422 `participant_role_unknown`
    · invalid profile       → 422 `participant_profile_invalid`
    · coding mode + profile → 201，selectedModelProfileId 与 conversationSkillIds=`['mode-skill']` 双断言
    · werewolf 2 玩家       → 201，agents 列表严格读取显式入参
    · skill_test_design 3 role → 201，metadata.participantRoles 恰好为三个现状角色 → planner/critic/scribe
    · 模型目录被清空后 → 422 `participant_role_unavailable`，3 条历史会话未被新增
```

### UI 真实浏览器断言（不是我看完显示后的转述）

`tests/ui/new-conversation-dialog.test.js` 在真实 headless Edge + CDP 上断言：

- AppShell `inert` 在打开 dialog 时为 `true`、关闭后还原 ✓
- 打开瞬间默认勾选仅来自运行时可用的 `isDefaultChatRole` 角色 ✓
- 不可用角色（`role-family-qwen`）被 `disabled` 且卡片文案含"不可用" ✓
- 焦点落在 `new-conversation-title`（focus entry）✓
- `Tab` 从 `submit` 折返到 `close`、`Shift+Tab` 反向折返（trap 完整）✓
- `Escape` 关闭、焦点回到 `open-new-conversation-button`、本次会话未触达 `/api/conversations`（无写副作用）✓
- 全部清空勾选后 `submit.disabled===true`、错误区可见 ✓
- 切到 `werewolf`：预选集 0，policy note 含"不读取普通聊天默认"，标题变"选择玩家"，提交后 body 与显式勾选严格一致 ✓
- 375×812 视口：`scrollWidth===375`，dialog `left=0`、`right=375`、`height=812`，无横向溢出 ✓

## Cross-cat Reference

独立核验路径与砚砚的 review request 列出的 OQ 一一对应：

| OQ | 结论 | 关键证据 |
|---|---|---|
| store + RoleService 是否联合拒掉每条非法 roster，无法经 controller / external-adapter 旁路 | 通过 | smoke：所有 422/400 codes 都从 store + roleService 走；Feishu adapter 进 PolicyBadrecipe 之前必须经 `roleService.validateConversationParticipants` |
| Feishu `setup_required` 是否对 missing/invalid 新房间零写入（含 binding） | 通过 | chat_conversations=0、chat_channel_bindings=0；旧 binding 的 `/new` 仍走 setup_required，conversationCountBeforeNew 不变 |
| 游戏/普通默认是否互不消费、mode skills 是否只 merge 不创建参与者 | 通过 | UI：werewolf 起始 0 勾选；smoke：mode skill 仅注入到 `conversationSkillIds` |
| Skill Test 是否要求恰好 3 位当前角色且不复活 `agent-strategist` 等遗留 seed | 通过 | `assertSkillTestDesignParticipantCount` 400；metadata.participantRoles 直接来自显式选中的 3 个 role；`JSON.stringify(...).includes('agent-strategist')===false` |
| dialog 是否满足 focus 入/trap/return、inert 背景、副作用-free 关闭、375 行为 | 通过 | 真实 CDP 断言 Stress-tested 全章节 |

## Findings

- **P1/P2**：无。
- **P3（非阻塞，可在 Task 6/实现切片再收口）**：
  - controller 在 `updateConversation` 路径使用 `Array.isArray(body.participants) || Array.isArray(body.agentIds)` 作为是否需要校验的触发条件。如果某个 caller 同时 omit 两个字段而希望触发"清空参与者并重建"，必须显式传空数组才会被拦下；这是符合契约的（无 participants 意为不动），但建议在 controller 顶部注释把这个契约固化，避免后续 reviewer 误以为是漏校。
  - Feishu `/new` 对已绑定房间仍同样返回 `setup_required`（在没有 `FEISHU_DEFAULT_ROLE_IDS` 时）。这是 Task 5 OQ 中"existing bindings keep roster"的同一硬币背面：现有房间发普通消息会按现有 roster 续续；`/new` 一律走新房间策略。文档建议在 README/spec 显式声明 /new 不读现有 roster，避免管理员误以为 `/new` 等价"在同一房间内换默认"。

两条都可以等 Task 6/UI 真实落地阶段一起闭合，不阻塞 Task 5 进入下一棒。

## Notes

- 砚砚在 review request 中明确声明本地 fresh-context 扫描打在了 `aa3b3b8` 设计 worktree 而非本 SHA `02e58cc`，并要求 reviewer 独立检视 `01d134f..02e58cc`。本 verdict 即是按此自检声明的范围独立完成。
- 本 review worktree（detached，port 3101 建议、未在主分支读写砚砚工作树）位于 `E:\pythonproject\caff-roles-review-02e58cc`；不冒触生产 Redis 6399、Clowder AI 3003/3004。
- 没有发现 first-three / 隐式 fallback 残留：`pickDefaultParticipants` 已被删除，`ensureStarterConversation()` 在空库时 `return null`，bootstrap 在空库读出 `selectedConversationId=null` 且不写任何会话/参与者行。
- Skill Test metadata 中 `participantRoles` 的 planner/critic/scribe 顺序由 post-exact-3-role 的 participants 顺序决定，符号契约匹配 `SKILL_TEST_DESIGN_PARTICIPANT_ROLES = ['planner','critic','scribe']`；再次启动加载时 `getSkillTestDesignState` 也按当前 `conversation.agents` 重建，不再静默回退到 `agent-strategist` 等已退役 seed。

球权：approval 已给出；Task 6 / Runtime + Prompt Enforcement 可继续在砚砚的工作树展开（砚砚仍持有其工作树中正在修改的 `tests/runtime/turn-orchestrator.test.js` 草稿，本 review 未触及其工作树）。

## Identity

[布偶猫/宪宪/glm-5.2🐾]