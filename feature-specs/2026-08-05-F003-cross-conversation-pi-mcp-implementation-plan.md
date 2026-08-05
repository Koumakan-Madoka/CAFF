---
feature_ids: [F003]
topics: [cross-conversation, delivery, outbox, recovery, mcp, pi, conversation-tree, spawn, plan]
doc_kind: plan
created: 2026-08-05
status: implementation_ready
---

# F003 Cross-Conversation Delivery, Conversation Tree, and Pi MCP Bridge Implementation Plan

**Feature:** F003 — `docs/features/F003-cross-conversation-delivery-pi-mcp-bridge.md`
**Goal:** 让 Agent 可靠地把 notify/request 投递给同项目另一 conversation 的指定 participant Agent，让 operator 在来源与目标现场看到持久回执/provenance，并能创建非 Fork 的全新子 conversation，用一条公开完整首消息只启动 primary Agent。
**Acceptance Criteria:** AC-A1–A5、AC-B1–B4、AC-C1–C7（逐条抄录于下方 Coverage Matrix）。
**Architecture cell:** `storage/chat -> lib/chat-app-store -> server/domain/conversation + server/domain/runtime -> server/api -> public/chat`
**Map delta:** none
**Map delta why:** F003 在既有 conversation persistence、target-scoped side-dispatch、agent-tool bridge、Pi extension 与 AppShell 边界内新增显式 delivery domain，不创建平行 Store、Queue、Router 或 dashboard。
**Architecture:** delivery row 同时是 durable intent 与 outbox；目标/来源 message 只是现场投影，状态始终从 delivery row 派生。Pi 只看到固定业务 facade，server-side registry 隐藏 transport/tool/credential；spawn 复用同一 delivery worker，事务只持久化新 conversation、lineage、公开首消息与 bootstrap delivery。
**Tech Stack:** TypeScript/CommonJS、better-sqlite3、Node ESM Pi extension、精确锁定官方 `@modelcontextprotocol/sdk`、plain browser JavaScript/CSS、Node test runner、Playwright/Edge isolated acceptance。
**前端验证:** Yes — 1440px、375px，临时 SQLite 与独立开发端口；禁止 3003/3004、Redis 6399 与生产用户数据。

---

## Finish Line

同一非空 project scope 内，已认证 invocation 可用固定 `conversation_notify`/`conversation_request` 精确寻址一个 conversation + 一个当前 participant Agent。提交立即在 SQLite 原子落 delivery、目标 external peer message 与来源 receipt；worker 只启动目标 Agent 的 side-dispatch。刷新/重启后状态可恢复；started invocation 不自动重放；request 回答相关联回源但不唤醒来源 Agent；取消、超时、late reply、loop guard 与重试都有确定状态和审计。operator 可从 tree node 派生全新 conversation，显式选择 project/participants/primary Agent/initialMessage；不复制父历史或配置，只将公开首消息 bootstrap 给 primary Agent。Pi facade 不暴露任意 MCP proxy、transport、tool name、credential、HTTP 或 shell fallback。

不建设：同步 RPC、隐式广播、多 responder、跨项目默认放行、树 ACL、自动来源 Agent wake、第二队列真相源、Fork/snapshot/hidden handoff bundle、通用 `{server, tool, arguments}` MCP proxy、drag/reparent、dashboard-first 状态面。

## Existing Worktree and Baseline

- Worktree: `E:\pythonproject\caff-f003-cross-conversation-pi-mcp`
- Branch: `feat/f003-cross-conversation-pi-mcp`
- Plan baseline: `origin/main@edb134b4213f36942134b4b1266e96c2d82a4b32`
- Frozen design commits: `5b13504`, `95ea657`
- Existing worktree is already created and pushed; do not create a second F003 worktree.
- Governance bootstrap files under `.cat-cafe/`, `.claude/`, `.codex/`, `.gemini/`, `.kimi/`, root `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`/`KIMI.md`, `Microsoft/`, and injected docs are unrelated untracked operator/runtime artifacts. Never stage them.

## Terminal Contracts

```ts
type DeliveryKind = 'notify' | 'request' | 'bootstrap';
type DeliveryMessageStatus = 'pending' | 'persisted' | 'failed';
type DeliveryDispatchStatus =
  | 'not_requested' | 'queued' | 'running' | 'completed'
  | 'failed' | 'cancel_requested' | 'cancelled';
type DeliveryResponseStatus =
  | 'not_expected' | 'waiting' | 'received'
  | 'timed_out' | 'cancelled' | 'late';

type CrossConversationPrincipal = {
  kind: 'agent' | 'operator';
  sourceConversationId: string;
  sourceTurnId: string | null;
  sourceInvocationId: string | null;
  sourceAgentId: string | null;
  sourceAgentName: string;
  projectScopeId: string;
};

type ConversationDeliverySubmit = {
  kind: 'notify' | 'request';
  targetConversationId: string;
  targetAgentId: string;
  content: string;
  idempotencyKey: string;
  deadlineSeconds?: number;
  traceId?: string;
  parentDeliveryId?: string;
};

type SpawnConversationInput = {
  title: string;
  projectScopeId: string;
  participants: Array<{ agentId: string; modelProfileId?: string; conversationSkillIds?: string[] }>;
  primaryAgentId: string;
  initialMessage: string;
  sourceMessageId?: string;
  clientRequestId: string;
};
```

Pi-visible tools are fixed to:

```text
conversation_notify(targetConversationId, targetAgentId, content, idempotencyKey)
conversation_request(targetConversationId, targetAgentId, content, idempotencyKey, deadlineSeconds?)
```

Forbidden public/model-visible fields: sourceConversationId、sender、projectScopeId、server URL/ID、transport、actual MCP tool name、command、env、headers、credential、raw arguments、fallback action。

## Cross-Layer Data Flow

```text
Pi facade / operator route
  -> invocation/operator principal resolution
  -> delivery schema + permission + loop validation
  -> one SQLite transaction
       delivery row + target/source message projections + persisted event
  -> post-commit worker claim
  -> target-scoped side-dispatch
  -> assistant completion hook
  -> correlated reply persistence (request only; no source wake)
  -> SSE patch + refresh from SQLite truth
  -> tree / receipt / provenance renderers
```

Validation owns the boundary in this order: authenticate principal → derive source conversation → validate fixed facade/body → reject self → resolve target/Agent → require equal non-null scope → require active participant → validate trace/deadline → claim idempotency → persist.

## Stateful Object Census

### Object 1: ConversationScopeAndLineage

Lifecycle owner: `chat_conversations` + `ChatConversationRepository`; operator routes may bind legacy scope, spawn transaction alone may set lineage. Generic conversation update cannot mutate lineage.

| State | Event | Next | Rule |
|---|---|---|---|
| legacy_unbound | operator binds valid project | bound_root | Project must exist in `ProjectManager`; Agent delivery stays blocked before binding. |
| bound_root | normal update | bound_root | title/type/metadata/participants only; lineage fields unchanged. |
| bound_root/bound_child | spawn | bound_child | parent/origin immutable, depth = parent + 1, max depth 2 (three rendered levels). |
| bound_child | reparent/self/cycle request | rejected | v1 has no mutation path. |
| any with children/active deliveries | delete | rejected | no cascade/reparent; archive/tombstone is future work. |

Invariants:

- INV-1: Agent cross-conversation addressing requires source and target `project_scope_id` equal and non-null.
- INV-2: `parent_conversation_id` is navigation/provenance only and never grants permission.
- INV-3: `origin_conversation_id`, `origin_message_id`, and `tree_depth` are immutable after insert.
- INV-4: sibling order is `(created_at ASC, id ASC)` and never depends on `last_message_at`.

Adversarial tests: legacy null scope; different project; related tree nodes in different projects; unrelated nodes in same project; self-parent; depth overflow; cycle/reparent bypass; delete parent; delete conversation referenced by non-terminal delivery.

### Object 2: CrossConversationDelivery

Lifecycle owner: `CrossConversationDeliveryService`; repository exposes narrow insert/get/claim/transition methods, not generic update.

| State | Event | Next | Rule |
|---|---|---|---|
| absent | valid submit | persisted + queued + waiting/not_expected | One transaction writes delivery, target message, source receipt, event. |
| absent | duplicate idempotency scope/key | existing | Return the canonical existing delivery/projections; insert nothing. |
| queued | worker claim | running claim | Lease owner/expiry and attempt event set atomically. |
| queued | cancel | cancelled | Deterministic; messages/events remain. |
| running | invocation starts | running started | Persist `started_at`/invocation identity before outcome can be lost. |
| running | success | completed | notify/bootstrap terminal; request still waits for response hook. |
| running | best-effort cancel | cancel_requested/cancelled | Stop handle is attempted; unknown outcome is preserved, never rewritten as clean queued. |
| queued/running | deterministic pre-start failure | queued/failed | Only bounded pre-invocation retry may auto-reschedule. |
| started + stale lease/restart | recovery | failed unknown_outcome | Never auto-start a second invocation. Explicit operator retry creates a linked retry delivery if unsafe to reuse. |

Invariants:

- INV-5: `(idempotency_scope,idempotency_key)` and non-null `target_message_id` are unique.
- INV-6: message/dispatch/response state groups remain orthogonal; UI label is a pure selector.
- INV-7: one delivery targets exactly one conversation and one Agent; fan-out means multiple deliveries.
- INV-8: target/source projections reference the same delivery ID, but neither stores an independent lifecycle status.
- INV-9: content and credentials never enter delivery events; content remains only in `chat_messages`.

Adversarial tests: concurrent duplicate submit; crash before transaction commit; commit before worker wake; duplicate target message; malformed state transition; generic repository update attempt; cancelled queued row recovery; started invocation restart.

### Object 3: DeliveryLeaseAndAttempt

Lifecycle owner: delivery worker in `server/domain/conversation/cross-conversation-delivery.ts`.

| State | Event | Next | Rule |
|---|---|---|---|
| claimable | atomic claim | leased | `claim_owner`, `claim_expires_at`, `attempt_count+1`; one winner. |
| leased, not started | lease expiry | claimable | May be reclaimed. |
| leased, invocation started | lease expiry | failed_unknown | No automatic replay. |
| leased | process completes/fails | released terminal/next_attempt | Clear claim only through worker transition. |

Invariants:

- INV-10: claim SQL includes current status, `next_attempt_at`, and expired/no owner predicate.
- INV-11: attempt number and events monotonically increase; no decrement/reset.
- INV-12: automatic retry budget applies only before invocation start and is bounded.

Adversarial tests: two workers race; clock-expired lease; crash between claim and invocation start; crash after start marker; failure writing terminal event; restart scanner idempotency.

### Object 4: RequestResponseCorrelation

Lifecycle owner: delivery service completion hook; no independent response table/state machine.

| State | Event | Next | Rule |
|---|---|---|---|
| waiting | target final assistant reply | received | Insert one correlated reply projection in source and set canonical response message/delivery once. |
| waiting | deadline scan | timed_out | Preserve target/source messages; do not delete delivery. |
| timed_out | later target final reply | late | Persist and visibly mark late. |
| waiting | cancel | cancelled | Later reply becomes late, not received. |
| received/late | duplicate completion hook | unchanged | Unique canonical response prevents duplicates. |

Invariants:

- INV-13: request has at most one canonical response; completion hook is idempotent.
- INV-14: correlated reply persists/broadcasts to source but never enqueues a source Agent turn.
- INV-15: reverse trace edge is permitted exactly once for the canonical reply.

Adversarial tests: duplicate hook; timeout race with completion; cancelled then reply; reply persist crash before response-state update; source conversation refresh/restart; verify no source turn/task/run.

### Object 5: TraceEdge

Lifecycle owner: delivery validator + append-only delivery rows in the trace.

| State | Event | Next | Rule |
|---|---|---|---|
| new trace | first delivery | edge recorded | `root_delivery_id=self`, `hop_count=0/1` normalized consistently. |
| active trace | new directed edge | edge recorded/rejected | Same `(source,target)` only once. |
| request response | one reverse edge | edge recorded | Only canonical response path. |
| hop 8 | next delivery | rejected | Hard `maxHop=8`. |

Invariants:

- INV-16: source==target always rejected.
- INV-17: child delivery carries shared trace/root + parent ID.
- INV-18: external peer content cannot execute local `@mention` fan-out; handoffs disabled in target side-dispatch.

### Object 6: CapabilityRegistryAndMcpSession

Lifecycle owner: `PiCapabilityRegistry` at server composition; fixed adapter owns each MCP client session.

| State | Event | Next | Rule |
|---|---|---|---|
| unregistered facade | call | rejected | No dynamic discovery or fallback. |
| registered internal facade | call | completed/failed | Inject principal/trace/idempotency server-side. |
| registered MCP facade | connect | connected/failed | Fixed server/tool/transport from trusted server config only. |
| connected | call | completed/failed/timed_out | Validate request and projected result; close session in `finally`. |
| projection failure | result | rejected | Raw result/secret never reaches model/timeline/log. |

Invariants:

- INV-19: model-visible schema has no server/tool/transport/credential/raw arguments.
- INV-20: registry allowlist is the only dispatch path; no shell/HTTP fallback.
- INV-21: timeout/disconnect/projection failures are fail-closed and audited with redacted diagnostics.
- INV-22: official SDK is a direct exact dependency; tests use isolated local MCP servers only.

Adversarial tests: unknown facade; malicious extra keys; expired invocation; secret echo; malformed MCP result; disconnect/timeout; attempt to select server/tool; ensure no fallback command/fetch path.

### Object 7: SpawnCommand

Lifecycle owner: `ConversationSpawnService`; no hidden bundle/bootstrap store. Idempotency is the bootstrap delivery scope/key.

| State | Event | Next | Rule |
|---|---|---|---|
| absent | valid command | committed | One SQLite transaction creates child, participants, public first message, source receipt, bootstrap delivery. |
| absent | transaction failure | absent | No half conversation/message/delivery. |
| committed | worker failure | committed_failed_bootstrap | Child remains navigable; retry uses same delivery identity or a linked safe retry. |
| committed | duplicate clientRequestId | existing | Return canonical child; create nothing. |

Invariants:

- INV-23: participants/project/primary Agent/initialMessage are explicit and validated.
- INV-24: no history, digest, participants, model profiles, Skills, tasks, game state, or metadata inheritance path is called.
- INV-25: first child message is public role `user`; only primary Agent is dispatched and authority is normal user input.
- INV-26: source receipt, birth provenance, and tree status derive from the bootstrap delivery.

Adversarial tests: empty message; primary not participant; unavailable Agent; missing project; depth overflow; injected parent config; transaction fault at every insert; duplicate submit; bootstrap failure/retry; prove only primary task/run starts.

### Pure Projections (must not become new state owners)

- Source receipt label/actions = selector over delivery + target summary.
- Target provenance/birth card = message metadata + delivery lookup.
- Tree node status = non-terminal/failed delivery aggregate for that conversation.
- Expanded tree ancestors = browser memory only; selected-node ancestors auto-expand. No DB/localStorage contract in v1.

## Implementation Dependency Chain

```text
schema + narrow repositories
  -> store transaction primitives
  -> delivery permission/idempotency/trace service
  -> worker + side-dispatch + response hook + recovery
  -> operator/agent APIs
  -> fixed Pi facade + allowlisted MCP adapter
  -> spawn transaction
  -> tree/receipt/provenance UI
  -> full gates + isolated browser evidence
```

## Task 0: Plan Commit and Isolated Baseline

**Files:** this plan; `.env` (ignored local file only); `project-evidence/F003-baseline.md` if baseline requires recorded failures.

1. Commit only this plan on the existing F003 branch with Why/signature/thread provenance.
2. Create ignored `.env` with `REDIS_URL=redis://localhost:6398`, `NEXT_PUBLIC_API_URL=http://localhost:3102`, and sidecars disabled; verify no 6399 value.
3. Run `npm ci`, `npm run check`, `npm run typecheck`, `npm test`, `git diff --check` before production edits. If baseline fails, record exact existing failure and do not mask it.
4. Inspect installed Pi extension API and official MCP SDK package exports before writing the first RED; implementation must follow actual installed contracts.

## Task 1: Conversation Lineage and Delivery Schema — RED → GREEN

**Files:** Modify `storage/sqlite/migrations.ts`, `storage/chat/conversation.repository.ts`, `lib/chat-app-store.ts`, `server/domain/conversation/conversation-view.ts`; Create `storage/chat/cross-conversation-delivery.repository.ts`; Test `tests/storage/cross-conversation-delivery.test.js`, update `tests/storage/chat-store.test.js`.

1. Write RED migration tests for new conversation columns, FK/check/unique/indexes, legacy row preservation, stable sibling ordering, and deletion restrictions.
2. Write RED repository tests for delivery insert/get/list/atomic claim/allowed transitions and append-only event insert/list.
3. Implement safe conversation table rebuild if SQLite cannot add required self-FKs/CHECKs in place; preserve all rows and rebuild dependent triggers/indexes with `foreign_key_check` green.
4. Add delivery/event tables and partial indexes for claim scanning, deadlines, source/target lookup, trace edges, and canonical response uniqueness.
5. Normalize project/lineage fields in store/view DTOs; keep generic updates from changing lineage.
6. Run focused storage tests; expected GREEN and zero rows in `PRAGMA foreign_key_check`; commit.

## Task 2: Atomic Delivery Submit, Permission, Idempotency, and Loop Guard — RED → GREEN

**Files:** Create `server/domain/conversation/cross-conversation-delivery.ts`; Modify `lib/chat-app-store.ts`, `server/domain/runtime/agent-tool-bridge.ts`; Test `tests/runtime/cross-conversation-delivery.test.js`, `tests/runtime/agent-tool-bridge.test.js`.

1. RED permission matrix: self, unbound source/target, different project, target missing, non-participant, tree-related unauthorized, unrelated same-project allowed, expired invocation.
2. RED transaction/idempotency tests: one submit writes delivery + target external_agent message + source receipt; duplicate/concurrent key returns the same objects; injected fault rolls back all rows.
3. RED trace tests: repeated directed edge, reverse non-reply edge, allowed canonical reverse reply, maxHop 8, child delivery missing parent/trace, executable mention suppression.
4. Implement `CrossConversationDeliveryService.submitFromAgent()` deriving sender/source/scope only from authenticated invocation context. Validate before idempotency claim.
5. Persist low-authority target metadata and source receipt metadata; events contain bounded identifiers/error codes only.
6. Expose narrow `handleConversationNotify/Request` bridge handlers, but do not start worker until Task 3.
7. Run focused tests and commit.

## Task 3: Delivery Worker, Recovery, Cancel, Timeout, and Correlated Reply — RED → GREEN

**Files:** Modify `server/domain/conversation/cross-conversation-delivery.ts`, `server/domain/conversation/turn-orchestrator.ts`, `server/domain/conversation/turn/agent-executor.ts`, `server/app/create-server.ts`; Test `tests/runtime/cross-conversation-delivery.test.js`, `tests/runtime/turn-orchestrator.test.js`, `tests/runtime/agent-executor-hook.test.js`.

1. RED four crash windows: pre-commit, committed/unclaimed, claimed-not-started, invocation-started-before-terminal.
2. RED claim race/reclaim tests and bounded pre-start retry; prove started invocation never auto-replays.
3. Extract/extend a public target-scoped single-Agent dispatch entry from current side-dispatch that accepts an existing target message, disables handoffs/main turn, and reports invocation-start/completion identity to the delivery service.
4. Add startup scanner + bounded timer/deadline scanner. Tests inject clock/scheduler; no unbounded sleeps.
5. Add queued cancel, running best-effort stop, timeout, late reply, explicit retry safety policy, and append-only attempt events.
6. Propagate delivery correlation through queue item/final assistant metadata. Completion hook creates one source reply projection and updates request state without calling `submitConversationMessage()` or scheduling source work.
7. Broadcast source/target summary/message/delivery events after commits; SQLite remains refresh truth.
8. Run focused tests and commit Phase A domain/runtime.

## Task 4: Phase A Public/Operator API and Scope Binding — RED → GREEN

**Files:** Create `server/api/conversation-deliveries-controller.ts`; Modify `server/api/agent-tools-controller.ts`, `server/api/conversations-controller.ts`, `server/app/create-server.ts`, `lib/agent-chat-tools.ts`, `package.json`; Test `tests/http/conversation-deliveries-controller.test.js`, `tests/runtime/agent-chat-tools.test.js`, `tests/smoke/server-smoke.test.js`.

1. RED routes for agent notify/request, operator GET/retry/cancel, and operator-only legacy project binding.
2. Validate exact route/body fields at controller edge; domain owns permission/state transitions.
3. Project binding resolves a real `ProjectManager` ID and rejects mutation when active/non-terminal deliveries would make scope ambiguous.
4. Add CLI commands only as compatibility/manual test entrypoints; Pi model-facing API remains the extension facade in Task 5.
5. Add focused suites to `test:fast`; run Phase A focused gate: storage, bridge, orchestrator, controllers, smoke; commit.

## Task 5: CAFF-Owned Pi Facade and Official MCP Bridge — RED → GREEN

**Files:** Modify `package.json`, `package-lock.json`, `lib/pi-runtime.ts` only if installed API requires it, `server/domain/conversation/turn/agent-executor.ts`, `server/app/create-server.ts`; Create `lib/pi-extensions/caff-capabilities.mjs`, `server/domain/runtime/pi-capability-bridge.ts`; Modify `server/domain/runtime/agent-tool-bridge.ts`, `server/api/agent-tools-controller.ts`; Test `tests/runtime/pi-capability-bridge.test.js`, `tests/runtime/pi-sdk-host.test.js`, `tests/runtime/agent-tool-bridge.test.js`.

1. Resolve the current approved official SDK version from npm registry and install it as a direct exact dependency (no caret/tilde); record installed version in test diagnostics.
2. RED Pi extension schema snapshots proving only fixed facade names/business args are visible and extra generic proxy fields are rejected.
3. RED registry tests for unknown facade, principal injection, fixed internal delivery handler, fixed MCP server/tool adapter, result projection/redaction, timeout/disconnect, malformed/secret result, and no shell/HTTP fallback.
4. Implement CAFF-owned extension loaded on every conversation Agent run through `extensionPaths`; it reads only invocation credential env and calls local agent-tool facade routes.
5. Implement registry entries for `conversation_notify/request` using Phase A service. Add at least one real local stdio or Streamable HTTP MCP test server fixture through official SDK.
6. Ensure trace/event audit contains facade/result status but no credential/server config/raw secret. Run focused bridge tests and commit Phase B.

Resolved Phase B contract (2026-08-05): the npm registry `latest` and package
version both resolved to official `@modelcontextprotocol/sdk@1.30.0`, installed
as a direct exact dependency. The CAFF extension calls
`POST /api/agent-tools/capabilities/:facade` with
`{ invocationId, callbackToken, arguments }`; the server injects the persisted
project/trace principal and returns only the facade result projection. The real
transport fixture uses the SDK `Client` + `StdioClientTransport` against an
isolated SDK `McpServer` + `StdioServerTransport` child process.

## Task 6: Spawn Transaction and Bootstrap Delivery — RED → GREEN

**Files:** Create `server/domain/conversation/conversation-spawn.ts`; Modify `lib/chat-app-store.ts`, `server/api/conversations-controller.ts`, `server/app/create-server.ts`; Test `tests/runtime/conversation-spawn.test.js`, `tests/http/conversation-spawn-controller.test.js`, `tests/storage/cross-conversation-delivery.test.js`.

1. RED explicit validation, non-Fork assertions, max-depth, transaction fault matrix, duplicate `clientRequestId`, bootstrap failure retention, retry idempotency, and only-primary-dispatch tests.
2. Implement one store transaction using existing participant validator plus project accessibility/primary runnable checks.
3. First child message is public `user` with birth provenance; source receipt + bootstrap delivery share state truth.
4. After commit, wake the existing delivery worker; failure never deletes child/message.
5. Add `POST /api/conversations/:sourceConversationId/spawn`; response returns child + updated summaries + canonical bootstrap delivery. Commit Phase C backend.

## Task 7: Tree, Spawn Dialog, Receipt, and Provenance UI — RED → GREEN

**Files:** Modify `public/index.html`, `public/app.js`, `public/styles.css`, `public/chat/conversation-list.js`, `public/chat/new-conversation-dialog.js`, `public/chat/message-timeline.js`; Create `public/chat/cross-conversation-ui.js`; Modify `package.json`; Test `tests/ui/cross-conversation-ui.test.js`, `tests/runtime/new-conversation-dialog.test.js`, `tests/ui/app-shell.test.js`, `tests/ui/chat-experience-m4.test.js`, browser verifier scripts as needed.

1. RED tree builder/render tests for root/child/grandchild, stable sibling order, selected ancestor expansion, collapse/deep link, max-depth child action, semantic `ul/li/button`, and no drag/reparent affordance.
2. Extend the existing dialog controller with normal-create vs spawn modes: locked parent, project select, participants, primary Agent, initialMessage, non-Fork notice; mobile retains existing full-screen sheet/focus contract.
3. Add source receipt renderer with compact normal state, failure-only details, retry/cancel/jump actions; status selector reads delivery DTO.
4. Add external_agent provenance header/backlink and spawn birth card while keeping public user message body in normal prompt/timeline.
5. Wire SSE delivery patches to merge DTOs and rerender in place; refresh paths re-read SQLite-backed API. Do not duplicate state in message metadata.
6. Add CSS using existing trace pill/tone/live rotor and 44px interactive targets. Run jsdom/UI focused tests; commit.

## Task 8: Full Verification, Evidence, Review, and Merge Gate

**Files:** `project-evidence/F003-cross-conversation-acceptance.md`, bounded screenshots/video under isolated temporary evidence directory, F003 feature/plan truth updates after review.

1. Run `npm run check`, `npm run typecheck`, focused storage/runtime/http/UI suites, `npm run test:fast`, `npm run test:smoke`, `git diff --check`.
2. Run isolated restart fixtures with temporary SQLite and local MCP servers; assert Redis 6399 is never opened.
3. Start worktree on unreserved ports (API 3102/Web 5102 or safe offset), never 3003/3004. Browser verify 1440/375 tree, drawer close, spawn, queued/running/failed/responded, receipt retry/cancel/jump, provenance backlink, refresh persistence, stable order, keyboard/focus.
4. Evidence bundle stays bounded to at most three screenshots + one short walkthrough video, with exact DB/run IDs documented and cleanup verified.
5. Load `quality-gate` → `fresh-context-review` → cross-individual `request-review`; author does not self-review. Address review via `receive-review`, then `merge-gate`.
6. Update Feature AC/status only after evidence and reviewer approval; cross-post each Phase boundary and final merge truth to `thread_msew15gvf6vtrqbo` targeting `@砚砚`.

## Acceptance Coverage Matrix

- AC-A1: Tasks 1–4 — shared notify/request contract, single target, dual projections.
- AC-A2: Tasks 1–4, 7 — three state groups, append-only events, refresh/restart UI recovery.
- AC-A3: Tasks 1–4 — principal injection, equal non-null project scope, active participant, self/tree/legacy failures.
- AC-A4: Tasks 1–4 — idempotency, crash recovery, no replay after start, cancel/timeout/late reply.
- AC-A5: Tasks 3–4 — target-only side-dispatch, correlated no-wake reply, loop/maxHop guard.
- AC-B1: Task 5 — fixed Pi facade, forbidden generic transport/config fields absent.
- AC-B2: Task 5 — allowlist registry, principal/project/trace/idempotency injection, fail-closed errors.
- AC-B3: Task 5 — both facade tools enter Phase A and share trace/delivery audit without secret exposure.
- AC-B4: Task 5 — real MCP transport, disconnect/timeout/malicious args, no proxy fallback regression.
- AC-C1: Tasks 6–7 — explicit spawn fields and single transaction for child/lineage/participants/message/delivery.
- AC-C2: Tasks 6–7 — non-Fork, public first user message, only primary wake, normal user authority.
- AC-C3: Task 6 — rollback has no half child; bootstrap failure retains/retries without duplicates.
- AC-C4: Tasks 3, 6, 7 — one persisted state feeds receipt/provenance/tree; SSE patch only; human actions.
- AC-C5: Task 7 — stable desktop tree and existing mobile drawer at 1440/375, including all states/depths.
- AC-C6: Tasks 1, 7 — stable sibling order, no activity reorder, no drag/reparent, max-depth root guidance.
- AC-C7: Task 8 — full gates and isolated browser/SQLite verification; no Redis 6399/production data.

## Commit Boundaries

Plan/baseline、schema/repositories、delivery submit/security、worker/recovery、Phase A APIs、Pi bridge、spawn backend、UI、verification/truth updates are separate rollback units. Every commit body states Why, includes `[砚砚/gpt-5.6-sol🐾]`, and adds `Thread-Context: threadId=thread_msfq6d1fb3211bol catId=cat-ir4rwo6b` (invocation ID omitted because unavailable).

## Open Questions

Technical, self-resolved during implementation:

- Choose stdio vs Streamable HTTP for the first real MCP fixture after inspecting the installed official SDK; the facade and registry contract is unchanged.
- Choose exact worker polling/backoff constants from testable bounded defaults; invocation-start no-replay and user-visible state are frozen.
- Decide whether safe explicit retry reuses the same row or creates `retry_of_delivery_id`; unknown-outcome retry must be linked and auditable, never silently reset.

Value questions: none. Any request to allow cross-project delivery, generic MCP proxy, hidden spawn context, automatic source wake, or reparenting changes the approved product/security boundary and requires a new Decision Packet.

[砚砚/gpt-5.6-sol🐾]
