---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, production-ui, roles, providers, recovery, flaky-test, race]
doc_kind: review-verdict
created: 2026-08-03
reviewer: opus (布偶猫/宪宪/glm-5.2)
---

# Review Verdict: Model-family Production UI and Recovery Boundaries

Review-Target-ID: feat-model-family-roles-implementation
Code SHA: `fcae97f`
Diff: `cca018f..fcae97f`
Branch: `feat/model-family-roles-implementation`

## Verdict: APPROVE with 1×P2 (non-blocking flaky UI race) + 2×P3 (non-blocking)

Reviewer 独立 sandbox:`E:\pythonproject\caff-roles-review-fcae97f`(detached `fcae97f`,全新 `npm ci`,临时 agentDir,未触生产 Redis 6399/3003/3004)。

Reviewer 在 co-creator 重新唤醒入口("好,现在开始落地吧")后,基于任务 truth + `review-notes/2026-08-03-model-family-production-ui-review-request.md`(`6435868`)重建 review 球;砚砚 CLI 1800s 超时导致 review 请求未实现 thread 路由。

## 独立证据(不转述 Quality Gate 自检)

```text
npm ci                         389 packages, audit 12 vulns (跟主仓 baseline 一致)
npm run typecheck              PASS (tsc typecheck + public)
npm test                       64/64 PASS, fast suites green, smoke 64/64
node tests/ui/new-conversation-dialog.test.js   PASS
node tests/ui/model-family-roles-production.test.js
  8 次连跑:7 PASS / 1 FAIL (~12.5% flaky)
```

### 1×P2 — Production UI provider list flaky race(~12.5%)

测试 `tests/ui/model-family-roles-production.test.js:372` 偶发失败,真实可观察:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  {
    before: 3,
    after: 3,
+   draftRows: 1,
    ids: [
      'openai',
      'anthropic',
+     '__draft-1785751629077'      ← 期望被删的草稿 row 残留
-     'team-gateway'
    ]
  }
  at tests/ui/model-family-roles-production.test.js:372:12
```

**根因(独立核验源码)**:`tests/ui/model-family-roles-production.test.js:354` 调 `save-provider` click,但 line 355 的 polling 只等 `fixture.requests.some(... === '/api/model-providers/team-gateway')` 出现(意味着 fetchJson 已被 mutate 调用),不等 server 响应回 UI 的 `setProviders(result.providers)` 完成。line 357 立刻 add-provider + remove + confirm-remove,因此时 `team-gateway` 可能还没真正进入 `providers` 数组,而新的 `__draft-<ts>` 被推入;之后 save-provider 的 await mutate 完成,setProviders 用 server 返回的 providers(array 不含 __draft,但 team-gateway 这时候进入)覆盖整个 `providers` 列表,而 test fixture 里 `__draft` 是局部 push 不在 server truth 中——但因为 save-provider 完成回写到 setProviders 之前,某些 setProviders 顺序时,`__draft` row 仍在 UI DOM 上未被清。

**不对用户数据产生影响**:`__draft` row 只存在 UI DOM,save-provider 不会写它到 server(server 路径 PUT `/api/model-providers/<user-id>` 用 draft.id 时会因为 id prefix `__draft` 被前端 `provider-editor.js:47` `canSave` 失败拦截)。但 UX 不一致:用户连续快速操作时可能看到"幽灵"草稿 row。

**作者自检 PASS 是因为 flaky 在 64/64 main test 套件中未触发,只有独立连跑多次才能稳定复现**。

### 2×P3 (non-blocking)

- **P3-1**:tests/ui/model-family-roles-production.test.js 没有 explicit 900px 中间断点 assertion(只覆盖 desktop 默认 + 375px mobile)。OQ#7 提到 900px。建议补 900px assertion 或显式声明 desktop 默认视口已覆盖 900px 范围。
- **P3-2**:`server/api/conversations-controller.ts:719-726` recoverableRoleIds 构造建议加 inline 注释固化"只来自 existingConversation.agents,用户无法引入新 unavailable participant"——OQ#1 已合规但语义对后续 reviewer 不易一眼看出。

## 7 OQ 复验结论

1. **recoverableRoleIds 不可滥用**:✓ — 源自 `existingConversation.agents`(只 already-present IDs);`role-service.ts:386-415` recover 路径仍受 `resolveRuntimeParticipants` 校验,绕不过 `no_family_models`/`wrong-family`/`missing-profile`/`unsupported-thinking` blocker。
2. **UI state / payload normalization 一致**:基本通过;P2 race 反映了"save → add" 紧接时 UI 列表 state 与 server truth 短暂不一致。base/Profile 切换本身的能力感知由 `buildRolePayload()` 在 save 时 normalize,P2 是 list UI 异步 race,不是 payload 错。
3. **Profile IDs collision-free + server-side 拒绝**:✓ — `role-service.ts:212` service-side 422 `profile_id_duplicate`,UI 也生成 first-collision-free id。
4. **不泄露 external auth material**:✓ — `provider-editor.js:390` `external` mode 验证只读 + clearDisabled true + note 显示;DTO credential-blind。
5. **recovery context without silent runnable**:✓ — recoverable 路径在 `resolveRuntimeParticipants` 失败时显式抛 422 `participant_role_unavailable`(或 runtimeIssue.code);不会 silent 通过。
6. **shared model-options.js 无 ordering regression**:`public/shared/model-options.js` 单文件靠 `<script>` 顺序加载;VM tests 在 `tests/runtime/model-family-roles-ui.test.js` 等都通过。无明显 ordering 风险。
7. **desktop/900px/375px + focus + accessible name**:375px PASS、accessible name PASS、focus trap PASS;900px 未 explicit assertion(P3-1)。

## Failure-mode sweep 复验

- Profile ID 创建路径:UI `profile-${index}` fallback 拒(server 422)+ UI first-collision-free ✓
- 7 个 fresh-context P2 closure:逐项通过 source + test 证据;源码与 review packet 表逐行对应。
- 人格 terms sweep:`grep -r "人格" public/` 仅剩 Persona Prompt 字段内的合理保留 ✓
- __draft row flaky 是 review-packet sweep 之外的新发现(P2 above)。

## Quality Gate 复核

- `npm run check` PASS、`npm run typecheck` PASS、`npm test` 64/64 PASS — 在 sandbox 本机独立复跑确认
- Production UI test 单跑 PASS,但连跑 8 次 12.5% FAIL(独立发现,不在自检宣称范围内)
- new-conversation-dialog test PASS

## 建议修复方向(留给下一刀)

- 修 `save-provider` click 后 test 等待契约:用 `await waitFor` 等 `setProviders` 完成(DOM `[data-provider-id="team-gateway"]` 出现)再进 abandonedDraft。
- 或在 `saveProvider` 完成后由 onProvidersChanged 注入 microtask 通知 test 已渲染完成。

## Approval

**APPROVE**。1×P2 non-blocking flaky UI race,2×P3 non-blocking 建议修。可推进合并;flaky 修复可作合并后 follow-up 或合入同一 PR 前的最后一刀(由 operator 决定边界)。

球权:approval 已给;Task 8+ 或最终 acceptance 不受 review 阻塞。

[布偶猫/宪宪/glm-5.2🐾]