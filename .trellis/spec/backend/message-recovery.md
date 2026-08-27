# Failed Message Recovery Capsule

## 1. Scope

This contract applies to manual recovery of a failed public assistant message. It covers the durable recovery record, bounded Recovery Capsule, source trace linkage, scribe isolation, fallback message, HTTP/SSE projection, and UI state.

It does not authorize automatic recovery, task continuation, tool replay, external side effects, or mutation of the source message/task/run status.

## 2. Signatures

### Storage

```sql
chat_message_recoveries(
  id PRIMARY KEY,
  conversation_id,
  source_message_id UNIQUE,
  source_task_id,
  source_run_id,
  recovery_task_id,
  recovery_run_id,
  recovery_message_id,
  status CHECK queued|running|completed|failed,
  capsule_json,
  model_output,
  error_code,
  error_message,
  fallback_used,
  created_at,
  updated_at,
  started_at,
  ended_at
)
```

`source_message_id` is the durable idempotency boundary. The recovery task/run repeat `sourceMessageId`, `sourceTaskId`, and `parentRunId=sourceRunId` in their bounded metadata.

### Store APIs

```ts
ChatAppStore.createMessageRecovery(payload)
  -> { recovery, created }
ChatAppStore.getMessageRecovery(id) -> recovery | null
ChatAppStore.getMessageRecoveryBySourceMessage(sourceMessageId) -> recovery | null
ChatAppStore.listMessageRecoveriesBySourceMessageIds(ids) -> recovery[]
ChatAppStore.transitionMessageRecovery(id, expectedStatuses, updates)
  -> recovery | null
```

Transitions use compare-and-set. A terminal row cannot be reopened.

The platform-level hot configuration is one typed SQLite row:

```sql
chat_system_service_configs(
  service_type PRIMARY KEY,
  enabled CHECK 0|1,
  provider,
  model,
  thinking,
  timeout_ms CHECK 1000..60000,
  created_at,
  updated_at
)
```

```ts
ChatAppStore.getSystemServiceConfig('recovery_scribe') -> config | null
ChatAppStore.saveSystemServiceConfig('recovery_scribe', config) -> config
```

The row is a complete snapshot, not a partial key/value merge.

### Capsule

```ts
buildRecoveryCapsule({
  agentDir,
  sessionPath,
  message,
  task,
  run,
  contextSnapshot,
}) -> RecoveryCapsuleV1

buildMechanicalRecoveryMessage(capsule) -> string
```

### HTTP/SSE

```text
POST /api/conversations/:conversationId/messages/:messageId/recovery
body: {}
202 { recovery, duplicate }

GET /api/conversations/:conversationId/messages
200 {
  items: Array<Message & {
    recovery?: RecoveryProjection;
    recoveryCapability?: {
      enabled: boolean;
      eligible: boolean;
      reasonCode: string;
      reason: string;
      systemActorType: 'recovery_scribe';
      routable: false;
    };
  }>;
}

GET /api/system-services/recovery-scribe
200 { config, source, updatedAt, modelOptions }

PUT /api/system-services/recovery-scribe
body: { enabled, provider, model, thinking, timeoutMs }
200 { config, source: 'persisted', updatedAt, modelOptions }

conversation_recovery_updated {
  conversationId,
  sourceMessageId,
  recovery
}

system_service_config_updated {
  serviceType: 'recovery_scribe',
  enabled,
  updatedAt
}
```

The POST body must be exactly `{}`; unknown fields return `400 conversation_recovery_invalid_request`. Message-page projection adds a bounded `message.recovery` to source messages with a recovery row and never returns `capsule` or `modelOutput`. The terminal fallback is a normal persistent assistant message and uses `conversation_message_created`.

## 3. Contracts

### Source and lifecycle

- Only a public assistant message with `status=failed` in the addressed conversation is eligible.
- The conversation must be idle: no active/dispatching main turn, active side slot, queued user work, or queued side-slot work.
- Source task, run, context snapshot, and session JSONL must exist and agree with the message association. The source task must be `failed`. The source run is accepted when it is `failed`, or for historical compatibility only when it is `succeeded` and its persisted `assistant_errors_json` normalizes to at least one non-empty error. Run error prose, message prose, and task error prose never substitute for that structured historical evidence.
- `projectMessages()` and `requestRecovery()` share the same idle and source-integrity inspection. Failed assistant messages receive `recoveryCapability { enabled, eligible, reasonCode, reason, systemActorType, routable }`; the projection is bounded to the message page and caches conversation/idle reads per page. Disabled service, busy or unobservable runtime state, missing/mismatched source records, and a succeeded run without assistant errors fail closed with stable reason codes.
- An existing durable recovery row remains the idempotency authority. Duplicate POST returns it before revalidating transient idle/source availability and never creates second work.
- State is `absent -> queued -> running -> completed|failed`. Repository transitions filter both the expected source statuses and target status against those exact edges; completed/failed rows reject field-only updates as well as status changes.
- `completed` means a valid scribe result was persisted. `failed` means scribe/validation failed and a mechanical fallback was persisted with `fallbackUsed=true`.
- Duplicate or concurrent POST requests return the canonical row. They never create a second task, run, model call, or message.
- Startup does not replay stale queued/running recovery work. A new service instance projects such a row as `{ status: 'failed', interrupted: true, persistedStatus: 'queued|running', errorCode: 'conversation_recovery_interrupted' }` without mutating the auditable stored row.
- The source message, source task, and source run retain `failed` unchanged.

### Capsule evidence

- Context uses an allowlist of prompt snapshot sections and excludes private mailbox/persona content.
- Tool calls and `toolResult` messages pair by exact `toolCallId`.
- Paired explicit success is `completed`.
- A failed mutating/external tool result is `possibly_effective`; failure does not prove rollback.
- A failed read-only result is `not_completed`.
- A missing mutating/external result is `possibly_effective`; a missing read-only result is `unknown`.
- Assistant prose never upgrades evidence status.
- Each tool keeps bounded command/path, exit/isError state, first/last/error lines, and an evidence source label.

### Bounds and redaction

| Boundary | Limit |
| --- | --- |
| session JSONL read | 8 MiB tail |
| context section | 6,000 chars |
| all context sections | 18,000 chars / 8 sections |
| tool records | 80 |
| tool record | 1,600 bytes |
| Capsule | 64 KiB |
| scribe prompt | 72 KiB |
| scribe output | 8,000 chars / 2,000 tokens |
| scribe timeout | 60 seconds |
| safe error | 240 chars |

- Redaction runs before persistence and model input.
- It removes Authorization/Bearer, token, secret, password, API key, access key, cookies, callback credentials, known secret formats, and non-visible absolute path roots.
- Deterministic clipping records dropped tool/character counts.
- If mandatory source/failure fields cannot fit the hard bound, the model is not called and the mechanical path remains authoritative.
- When an 8 MiB tail starts inside a JSONL record, the partial first line is discarded. If the remaining tail contains no complete tool call/result pair, Capsule construction fails closed and the model is not called.

### Platform system actor and routing isolation

- The scribe is the platform system actor `recovery_scribe`. It is not a normal role and must never be persisted in `chat_agents`, `chat_role_identities`, or `chat_conversation_agents`.
- Persistent recovery messages use `role=assistant`, `agentId=null`, the sender `系统书记` or `系统书记（机械摘要）`, and metadata `systemActorType=recovery_scribe`, `systemActorRoutable=false`.
- The child task uses `assignedAgent=caff-system`, `assignedRole=recovery_scribe`; the audit run uses `task_role=recovery_scribe`. These labels do not create an Agent invocation or routing identity.
- `server/domain/roles/system-actor-catalog.ts` owns reserved non-routable IDs and sender names. Ordinary role creation/update rejects those IDs/names; participant validation rejects the actor even if a malformed role row exists.
- Role directory/selection, `list-participants`, prompt participant lists, mention/private/handoff resolution, explicit/default target resolution, cross-conversation delivery, Goal owner, and DAG worker/verifier resolution must use routable conversation participants only. A constructed `targetAgentId=recovery_scribe` fails closed.
- The only trigger is the manual failed-message Recovery API. The scribe cannot be addressed through normal conversation messages, private messages, handoff, Goal/DAG, or server-side delivery.

### Agent prompt attribution

- A persistent recovery result remains ordinary conversation history, but its source trace must be machine-identifiable to later Agents.
- Before prompt assembly, `projectRecoveryHistorySources(store, conversationId, messages)` collects only messages with `metadata.recoveryResult === true` and resolves their `metadata.sourceMessageId` values through one bounded `listMessagesByIds` call.
- A resolved source is trusted only when it is an assistant message with `status=failed` in the same conversation. The prompt derives the source Agent name and run ID from that source row, never from recovery-message metadata.
- Conversation History renders a compact label such as `系统书记 [read-only recovery; source agent GPT; source run 10159]: ...`. It does not expose the full source message/task IDs, Capsule, model output, or internal recovery metadata.
- If the source row is missing, outside the conversation, not a failed assistant, or lacks a valid Agent name/run ID, the label is `系统书记 [read-only recovery; source unavailable]: ...`. Recovery content remains visible and prompt assembly does not infer provenance from surrounding prose.
- The source point-read does not add the old source message to the bounded history window and does not change API/SSE message projections.

### Scribe isolation

- Configurable fields are only enabled/provider/model/thinking/timeout. Without a persisted row, priority is explicit options, then `CAFF_RECOVERY_ENABLED/PROVIDER/MODEL/THINKING/TIMEOUT_MS`, then digest provider/model/thinking settings, then Pi defaults. If that chain resolves `thinking` to the empty Pi sentinel, only the Recovery Scribe startup default materializes it as `off` before strict default validation; every supported non-empty value remains unchanged and every unsupported non-empty value still fails startup. This local boundary does not change the global `DEFAULT_THINKING` or any other Pi consumer. Invalid enabled values fail startup; the default is enabled. Timeout accepts `1,000..60,000 ms`; values outside the platform hard maximum fail configuration instead of widening it.
- A complete persisted `recovery_scribe` row is the shared model-selection source for both recovery and conversation digest consumers. Its `provider/model/thinking` apply to the next scribe, digest entry, digest rollup, or title-refinement invocation. `enabled` and `timeoutMs` remain scribe-only; disabling recovery does not disable summaries, and the 1..60 second scribe timeout does not replace digest/title budgets.
- Digest requests cannot override the shared model with request body `provider/model/thinking`; those fields fail before invocation or history mutation. Each consumer snapshots the three shared fields before awaiting its model call, so a concurrent save affects only the next invocation.
- A complete persisted `recovery_scribe` row overrides the startup default chain. This makes the local-admin panel authoritative after save; partial persisted overrides are not supported.
- `PUT /api/system-services/recovery-scribe` is loopback local-admin and CSRF guarded. It accepts exactly the five fields, requires strict booleans/integers, requires provider/model to exist in the configured model catalog, and requires thinking to be supported by that model.
- A Recovery POST reads one configuration snapshot at entry. The same snapshot owns enabled gating, child task/run audit fields, timeout, and `completeSimple`; a concurrent save affects the next accepted recovery and never changes in-flight work.
- Message-page capability projection reads the current persisted setting. `system_service_config_updated` makes open chat clients refresh the current conversation after a save, so disabling synchronizes the button and POST gate.
- The management UI lives under the platform-level `系统服务` tab, not the ordinary role editor. It first explains that the scribe creates a manual, read-only report for failed replies, then exposes one shared model/thinking selection for conversation summaries, rollups, title refinement, and failed-trace recovery, plus scribe-only enable/timeout controls. Model choices come from the configured model catalog maintained under `模型供应商`; selecting one never requires creating a role, and the panel links directly to provider management. With no configured model, it suppresses the empty selectors, shows a provider-setup action, and disables save. Fixed non-execution and mechanical-fallback boundaries are stated as user-visible outcomes rather than implementation jargon.
- A recovery-specific provider/model may differ from the source provider/model and should be preferred when explicitly configured.
- Production invocation uses `ModelRuntime.completeSimple` directly with one fixed system instruction and one user Capsule message.
- It creates no Agent session, extensions, skills, chat bridge, or tools. It cannot call bash/read/edit/write or replay source actions.
- The model invocation is represented by a manually persisted child `runs` row with `task_kind=conversation_recovery`, `task_role=recovery_scribe`, and `parent_run_id=sourceRunId`.
- The 60-second timeout is absolute across `ModelRuntime.create` and `completeSimple`; if initialization consumes the budget, CAFF checks the aborted signal before dispatch and performs no model request.
- Output must preserve the fixed sections: already completed, failure location, possibly effective, not completed, recovery point, unknown, and a non-execution statement. Empty, oversized, missing-heading, missing-statement, and `stopReason=error` responses use the mechanical fallback.

## 4. Validation Matrix

| Condition | Required result |
| --- | --- |
| recovery disabled | 503 `conversation_recovery_disabled`; no task/run/model/message side effect |
| no persisted system-service row | use the existing options/env/digest/Pi startup chain; materialize only an empty resolved thinking sentinel as `off` before strict default validation |
| valid local-admin PUT | atomically persist the full row; response and next recovery/digest/rollup/title model invocation use its shared model fields immediately |
| persisted row has `enabled=false` | Recovery POST returns 503; digest/rollup/title still use persisted provider/model/thinking with their own timeout budgets |
| digest request contains provider/model/thinking | 400 `conversation_digest_model_override_not_allowed`; no runner call or digest mutation |
| config PUT has unknown/missing field or non-boolean enabled | 422 stable `recovery_config_*` issue; row unchanged |
| config PUT model is absent from catalog or thinking unsupported | 422 `recovery_config_model_unavailable` / `recovery_config_thinking_unsupported`; row unchanged |
| config PUT timeout is non-integer or outside 1s..60s | 422 `recovery_config_timeout_invalid`; row unchanged |
| save races with an accepted recovery | accepted work keeps its entry snapshot; the next request sees the saved row |
| invalid `CAFF_RECOVERY_ENABLED` | fail startup/config construction; do not silently enable |
| recovery timeout below 1s or above 60s | fail startup/config construction; do not clamp or widen the hard bound |
| conversation missing | 404 `conversation_recovery_conversation_not_found` |
| source missing/outside conversation | 404 `conversation_recovery_source_not_found` |
| source not failed assistant | 409 `conversation_recovery_source_not_failed` |
| conversation busy | 409 `conversation_recovery_conversation_busy`; page capability is ineligible with the same code |
| runtime/mutation idle state cannot be inspected | 409 `conversation_recovery_state_unavailable`; page capability fails closed |
| source task missing / not failed | 409 `conversation_recovery_source_task_missing` / `conversation_recovery_source_task_not_failed` |
| source run missing | 409 `conversation_recovery_source_run_missing` |
| source run is failed | source run-state requirement passes |
| historical source run is succeeded with non-empty persisted `assistantErrors[]` | source run-state requirement passes; original message/task/run remain unchanged |
| source run is succeeded without persisted assistant errors, or has another status | 409 `conversation_recovery_source_run_not_failed` |
| message/task/run linkage mismatch | 409 `conversation_recovery_source_link_mismatch` |
| context snapshot missing/incomplete or points elsewhere | 409 `conversation_recovery_source_snapshot_missing` / `conversation_recovery_source_snapshot_mismatch` |
| session JSONL missing/unreadable or task/run paths disagree | 409 `conversation_recovery_source_session_missing` / `conversation_recovery_source_session_mismatch` |
| eligible failed source on message page | `recoveryCapability.enabled=true`, `eligible=true`, empty reason fields; UI may show the manual command |
| ineligible failed source on message page | `eligible=false` with the POST-equivalent stable reason; UI shows no command |
| first valid click | durable queued row and one scheduled job |
| duplicate/concurrent click | same row, `duplicate=true`, no second work |
| scribe succeeds with valid output | completed row and one persistent result message |
| timeout/provider/invalid output | failed row and one mechanical fallback message |
| source deletion | recovery row cascades |
| terminal transition or field update attempted | repository returns null; terminal row unchanged |
| stale queued/running row after restart | project interrupted/failed, keep persisted status unchanged, do not schedule work |
| oversized session tail without complete call/result evidence | no model call; failed recovery with mechanical message |
| recovery result with valid old failed source outside recent history | prompt labels the source Agent and authoritative source run without adding the source message to history |
| recovery source lookup missing or invalid | prompt labels `source unavailable`; ignore source Agent/run values in recovery metadata |
| ordinary role uses reserved scribe ID/name | 422 `role_identity_not_reusable` / `role_name_reserved` |
| participant/mention/private/handoff/default/explicit target is `recovery_scribe` | actor is absent/rejected; no Agent run starts |
| cross-conversation target/source is `recovery_scribe` | 403 `cross_conversation_system_actor_not_routable` |
| Goal owner or DAG worker/verifier is `recovery_scribe` | reject or resolve invalid; no continuation/dispatch |

## 5. Good / Base / Bad Cases

- Good: with no Recovery/Digest/Pi thinking environment value, server composition and stale-restart recovery construction materialize Recovery Scribe `thinking=off` while the global Pi default remains empty.
- Good: a non-empty supported startup thinking value such as `high` is preserved, while `bogus`, an unavailable persisted model, and an out-of-range timeout remain fail-closed.
- Good: a successful `kubectl apply` toolResult is listed under completed while a later stream failure remains the failure location.
- Good: a timed-out mutating command is listed under possibly effective and the recovery point tells the user to verify external state first.
- Good: a later Agent sees `系统书记 [read-only recovery; source agent GPT; source run 10159]` even when the failed source is older than the raw-history window.
- Good: a malformed roster contains `recovery_scribe`, but role/mention/default/private/Goal/DAG projections filter it and an explicit delivery target returns 403.
- Good: an administrator saves a different configured model and 45-second timeout; the next recovery task/run/model request all use that exact snapshot without restarting CAFF.
- Base: no persisted configuration exists, so the existing startup options/env/default chain remains authoritative.
- Good: a historical failed message/task points to a `succeeded` run whose persisted `assistantErrors=['connection error: stream_read_error']`; Recovery accepts it without changing any source row.
- Base: a current failed message/task/run has matching snapshot/session records and receives `eligible=true` on the message page.
- Base: a failed read has an error result and is listed as not completed.
- Bad: accepting every `succeeded` historical run because message/task prose says failed; without non-empty persisted assistant errors, the source must remain ineligible.
- Bad: deriving the button from `message.status=failed` in the browser or reimplementing a weaker source check in `projectMessages()`.
- Bad: treating a missing write result as not executed, replaying it automatically, or changing the source message from failed to completed.
- Bad: starting a normal Pi Agent session for the scribe and relying on prompt wording to keep default coding tools unused.
- Bad: registering the scribe as a configurable custom role or trusting absence from the mention UI without a server-side reserved identity/target guard.
- Bad: capturing the configuration only at server construction, reporting a successful save while later Recovery requests still use the old model.
- Bad: applying a mid-run config change to the run timeout/model after its child task already recorded the previous snapshot.
- Bad: trusting `sourceAgentName` or `sourceRunId` copied from recovery-message metadata, or injecting full Capsule/source IDs into Conversation History.

## 6. Required Tests

- `tests/runtime/recovery-capsule.test.js`: toolResult pairing, four evidence states, large output bounds, secret/path redaction, newest evidence retention, and mechanical fallback structure.
- `tests/storage/message-recovery.test.js`: real SQLite DDL, unique idempotency, compare-and-set, terminal immutability, projection, and cascade.
- `tests/storage/system-service-config.test.js`: typed singleton upsert, full-row replacement, reopen persistence, and foreign-key integrity.
- `tests/runtime/recovery-scribe-config.test.js`: default/persisted priority, shared digest model selection while recovery is disabled, in-flight snapshot isolation, request-override refusal, plus strict field/model/thinking/timeout validation.
- `tests/runtime/recovery-scribe-config-ui.test.js`: system-service purpose copy, shared digest/recovery model wording, configured-catalog provenance and provider navigation without role creation, configured model/thinking controls, no-model empty state with disabled save, read-only navigation, seconds-to-ms save payload, source label, and chat SSE refresh wiring.
- `tests/runtime/message-recovery.test.js`: same-conversation/failed/idle/source-integrity validation, duplicate clicks, task/run linkage, historical `run=succeeded + assistantErrors` compatibility without source rewrites, succeeded-run negative control, stable busy/session reason parity between capability and POST, platform actor metadata/no participant row, enable/disable validation, hot config next-request semantics, accepted-request snapshot isolation, direct no-tools invocation, provider/invalid-output fallback, source immutability, SSE order, stale restart projection, and no-environment startup materialization of `thinking=off` with unsupported non-empty thinking and timeout controls.
- `tests/runtime/cross-conversation-delivery-wiring.test.js`: both server-composition paths clear Recovery/Digest/Pi runtime defaults around construction so ambient shell configuration cannot mask the no-environment startup contract.
- `tests/http/recovery-scribe-config-controller.test.js`: loopback/Host/Origin/CSRF guard, safe GET/PUT projection, and global config-updated event.
- `tests/http/message-recovery-controller.test.js`: exact `{}` body, 202 response, and pass-through of the canonical message-page recovery/capability projection.
- `tests/ui/message-recovery.test.js`: eligible failed-card action, queued/running/completed/failed states, server-reason ineligible state, missing-capability fail-closed behavior, source provenance, non-execution declaration, stable touch geometry, and no retry/continue/source-state rewrite.
- `tests/runtime/turn-orchestrator.test.js`: one bounded source lookup, source Agent/run attribution for an old failed assistant, invalid-source fail-safe labeling, and refusal to trust recovery metadata provenance.
- `tests/runtime/runtime-role-resolution.test.js`, `initial-target-resolution.test.js`, `cross-conversation-delivery.test.js`, and `session-goal-owner.test.js`: reserved identity/name, role directory/participant, mention/private/default/explicit target, delivery, and Goal owner refusal.
- `tests/dag/dag-scheduler.test.js`: the system actor is never selected as worker or verifier.
- The runtime/storage/http/UI files above are registered in `package.json` `test:fast`; `tests/dag/dag-scheduler.test.js` runs through `test:dag-execution`. Build, check, typecheck, targeted tests, smoke, and isolated browser verification remain release gates.

## 7. Wrong vs Correct

### Wrong

```ts
const config = recoveryConfig(options); // Frozen until process restart.
await saveConfig(nextConfig); // UI claims success, but requestRecovery still uses config.
```

### Correct

```ts
const config = configManager.getConfigSnapshot();
const accepted = createDurableRecovery(source, config);
schedule(() => processRecovery(source, accepted.id, config));
```

The accepted request keeps one internally consistent snapshot; the next request observes the saved row.

### Wrong

```ts
startRun(provider, model, capsulePrompt, { session: 'recovery' });
```

This creates a normal coding Agent session with extensions, skills, and default tools, and it can replay side effects despite prompt wording.

### Correct

```ts
const childRun = runStore.startRun({
  sessionPath: null,
  parentRunId: sourceRunId,
  taskKind: 'conversation_recovery',
  taskRole: 'recovery_scribe',
  metadata: {
    sourceMessageId,
    sourceTaskId,
    noTools: true,
    systemActorType: 'recovery_scribe',
    systemActorRoutable: false,
  },
});
const output = await modelRuntime.completeSimple(model, redactedCapsuleContext, {
  signal,
  maxTokens: 2000,
});
```

The `runs` row is only an audit record around a direct model-layer request. No Agent session or tool registry is created.

### Wrong

```ts
store.transitionMessageRecovery(id, ['completed'], { status: 'running' });
```

Caller-supplied expected status alone must not be able to reopen a terminal recovery.

### Correct

```ts
// Repository admits only queued -> running|failed and running -> completed|failed.
const row = repository.transition(id, expectedStatuses, updates, updatedAt);
```

The repository filters illegal source/target edges and returns `null`, even if the caller explicitly names a terminal expected status.
