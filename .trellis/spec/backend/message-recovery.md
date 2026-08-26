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

conversation_recovery_updated {
  conversationId,
  sourceMessageId,
  recovery
}
```

The POST body must be exactly `{}`; unknown fields return `400 conversation_recovery_invalid_request`. Message-page projection adds a bounded `message.recovery` to source messages with a recovery row and never returns `capsule` or `modelOutput`. The terminal fallback is a normal persistent assistant message and uses `conversation_message_created`.

## 3. Contracts

### Source and lifecycle

- Only a public assistant message with `status=failed` in the addressed conversation is eligible.
- The conversation must be idle: no active/dispatching main turn, active side slot, queued user work, or queued side-slot work.
- Source task, run, context snapshot, and session JSONL must exist and agree with the message association.
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

### Scribe isolation

- Configuration priority is explicit options, `CAFF_RECOVERY_*`, digest settings, then Pi defaults.
- A recovery-specific provider/model may differ from the source provider/model and should be preferred when explicitly configured.
- Production invocation uses `ModelRuntime.completeSimple` directly with one fixed system instruction and one user Capsule message.
- It creates no Agent session, extensions, skills, chat bridge, or tools. It cannot call bash/read/edit/write or replay source actions.
- The model invocation is represented by a manually persisted child `runs` row with `task_kind=conversation_recovery`, `task_role=scribe`, and `parent_run_id=sourceRunId`.
- The 60-second timeout is absolute across `ModelRuntime.create` and `completeSimple`; if initialization consumes the budget, CAFF checks the aborted signal before dispatch and performs no model request.
- Output must preserve the fixed sections: already completed, failure location, possibly effective, not completed, recovery point, unknown, and a non-execution statement. Empty, oversized, missing-heading, missing-statement, and `stopReason=error` responses use the mechanical fallback.

## 4. Validation Matrix

| Condition | Required result |
| --- | --- |
| conversation missing | 404 `conversation_recovery_conversation_not_found` |
| source missing/outside conversation | 404 `conversation_recovery_source_not_found` |
| source not failed assistant | 409 `conversation_recovery_source_not_failed` |
| conversation busy | 409 `conversation_recovery_conversation_busy` |
| task/run/snapshot/session missing or mismatched | 409 `conversation_recovery_source_incomplete` |
| first valid click | durable queued row and one scheduled job |
| duplicate/concurrent click | same row, `duplicate=true`, no second work |
| scribe succeeds with valid output | completed row and one persistent result message |
| timeout/provider/invalid output | failed row and one mechanical fallback message |
| source deletion | recovery row cascades |
| terminal transition or field update attempted | repository returns null; terminal row unchanged |
| stale queued/running row after restart | project interrupted/failed, keep persisted status unchanged, do not schedule work |
| oversized session tail without complete call/result evidence | no model call; failed recovery with mechanical message |

## 5. Good / Base / Bad Cases

- Good: a successful `kubectl apply` toolResult is listed under completed while a later stream failure remains the failure location.
- Good: a timed-out mutating command is listed under possibly effective and the recovery point tells the user to verify external state first.
- Base: a failed read has an error result and is listed as not completed.
- Bad: treating a missing write result as not executed, replaying it automatically, or changing the source message from failed to completed.
- Bad: starting a normal Pi Agent session for the scribe and relying on prompt wording to keep default coding tools unused.

## 6. Required Tests

- `tests/runtime/recovery-capsule.test.js`: toolResult pairing, four evidence states, large output bounds, secret/path redaction, newest evidence retention, and mechanical fallback structure.
- `tests/storage/message-recovery.test.js`: real SQLite DDL, unique idempotency, compare-and-set, terminal immutability, projection, and cascade.
- `tests/runtime/message-recovery.test.js`: same-conversation/failed/idle/source-integrity validation, duplicate clicks, task/run linkage, direct no-tools invocation, provider/invalid-output fallback, source immutability, SSE order, and stale restart projection.
- `tests/http/message-recovery-controller.test.js`: exact `{}` body, 202 response, and message-page projection.
- `tests/ui/message-recovery.test.js`: failed-card action, queued/running/completed/failed states, source provenance, non-execution declaration, stable touch geometry, and no retry/continue/source-state rewrite.
- These files are registered in `package.json` `test:fast`. Build, check, typecheck, targeted tests, smoke, and isolated browser verification remain release gates.

## 7. Wrong vs Correct

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
  taskRole: 'scribe',
  metadata: { sourceMessageId, sourceTaskId, noTools: true },
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
