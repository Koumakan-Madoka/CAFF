---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [completion, vision-guard, user-journey, visibility, acceptance]
doc_kind: vision-guard-request
created: 2026-08-03
---

# Vision Guard Request: CAFF Model-family Roles

Author: `cat-ir4rwo6b` / Maine Coon / gpt-5.6-sol
Code reviewer: `opus` / Ragdoll / glm-5.2
Required guardian: a third individual who is neither author nor reviewer
Merged PR: `Koumakan-Madoka/CAFF#50`
Reviewed feature HEAD: `bec42b856c8e11fde690478097a4cb639d0c7424`
Squash merge: `4bbc260bd572fe5073c06daee588f87e9915f46d`
Post-merge truth sync: `98eeb8dc83bd668788b7e1ea9cfe02a55fa04b5a`

## Original Operator Experience

> 削弱默认体验中的角色扮演属性，把 GPT、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi 七个模型族本身作为系统角色。
> 自定义角色继续保留现有能力。
> 把具体 Provider 配置带到前端。
> 好，现在开始落地吧。

Sources:

- `feature-discussions/2026-08-02-model-family-roles/README.md`
- `feature-specs/2026-08-02-model-family-roles.md`
- PR #50 `Original Requirements`

## Author Vision Check

1. **最初核心问题是什么？** CAFF 把默认协作身份包装成固定虚构人格，并把决定模型可用性的 Provider 配置藏在后端；同时不能为了改默认体验而丢失 custom Persona/Skills 或历史用户状态。
2. **交付物解决了吗？** 是。七个 family role、credential-blind Provider UI、configured catalog、显式 participant policy、identity-preserving migration 与 runtime fail-closed 已作为一个完整生产切片进入 main。
3. **operator 实际怎么用？** 在 Provider 页配置连接/模型与 family；在角色页配置 base/thinking/Profile/default；新建聊天时确认 roster；配置漂移后在已有会话设置中看见原因并修复或移除 participant。

## User Visibility Disclosure

| Surface | 用户能做什么（达成态） | 当前 main 实际行为 | 缺失/退化 | 处置 |
|---|---|---|---|---|
| 模型供应商 | 新增、编辑、验证、清除密钥、移除 Provider/模型 | 生产 UI 与 local-admin API 已完整提供；读取 DTO 不含密钥/reference/header | 无 | met |
| 角色目录/详情 | 看见七个永久 family role 与 custom role；配置 base、thinking、Profiles、defaults | family 只允许同族模型且无 Persona/Skills；custom 能力保留 | 无 | met |
| 新建聊天 | defaults 只预选，提交前确认最终 roster | desktop/mobile dialog、焦点圈禁、Escape/取消与 44px target 均有生产契约 | 无 | met |
| 已有聊天设置 | 看见 unavailable 原因并修复 Profile/base 或移除 participant | recovery 只开放给 already-present role，不能借此新增 unavailable participant | 无 | met |
| Runtime | 配置失效时得到明确 blocker，不被静默换模/clamp | save/participant/runtime 三层复验，在 placeholder/run task 前阻断 | 无 | met |
| 历史与迁移 | 旧 seed 退出活动目录，但历史身份、消息、记忆与 custom role 保留 | backup + transaction + identity/history ledger + count/hash/FK audit 已落地 | 无 | met |

Intentional boundaries, not deferred user-visible gaps:

- Provider admin is loopback local-admin only; LAN/remote administration is explicitly out of scope for the safe first version.
- Validation status is session-local UI feedback, not durable configuration truth.
- OAuth broker, model marketplace, billing, provider plugin system and automatic cross-family fallback are explicit non-goals, not missing parts of the operator request.

## Acceptance Evidence

- Final cross-family full-PR verdict: <https://github.com/Koumakan-Madoka/CAFF/pull/50#issuecomment-5165873252>
- PR #50 state: MERGED; GitHub unit CI 2/2 SUCCESS.
- Final feature gate: `npm run check`, `npm run typecheck`, `npm test` (smoke 64/64), both production UI contracts and `git diff --check` PASS.
- Independent Provider readiness stress: 20/20 PASS.
- Merged-main acceptance at `origin/main@98eeb8d`: reviewed squash tree identity check PASS, typecheck PASS, production management UI PASS, new-conversation UI PASS.
- Existing Edge screenshots outside Git: `%TEMP%\cat-cafe-evidence\caff-model-family-roles-final\` (desktop defaults, empty state and 375px mobile).

## Guardian Next Action

1. Read the original requirements, Architecture/UI Gates, Feature Spec and this disclosure.
2. Run the Primary Journey on merged main with isolated agentDir/SQLite; do not use production Redis 6399 or ports 3003/3004.
3. Produce the required operator-experience evidence table and User Journey step table, with screenshots or equivalent concrete browser evidence.
4. Return `APPROVE` or `BLOCKED`. Any user-visible mismatch is a blocker; do not convert it into a deferred/follow-up item without operator sign-off.

[砚砚/gpt-5.6-sol🐾]
