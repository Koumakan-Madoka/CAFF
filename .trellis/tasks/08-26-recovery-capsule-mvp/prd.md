# 失败 Trace 书记恢复 MVP

## Goal

用户可对同一会话中的失败 assistant 消息手动生成一份有界、脱敏、证据分级的 Recovery Capsule。CAFF 使用独立、无工具的平台级 `recovery_scribe` 系统主体在新的关联 recovery run 中整理现场，并在同一会话追加带来源标识的兜底消息。系统书记可全局配置但不属于普通 Agent、角色或会话参与者，也不能被任何普通对话路由触发。原消息、原 task 和原 run 始终保持 failed；书记失败或输出无效时仍追加机械摘要。

## Non-Goals

- 不自动触发恢复，不自动继续或重试原任务。
- 不重放原工具调用，不执行 bash/read/write/chat bridge 或外部副作用。
- 不修改原失败消息正文、状态、task 状态或 run 状态。
- 不实现运行中的 checkpoint、上下文换段或 handoff。
- 不在 MVP 中提供“从此处继续”操作。
- 不创建每会话书记角色，不允许通过 mention、私信、handoff、Goal/DAG 或跨会话投递触发书记。
- 不允许配置书记工具、系统提示词、输入输出边界或其他执行权限。

## Data Flow

```text
failed assistant message
  -> POST manual recovery
  -> validate same conversation + idle + source integrity
  -> durable unique recovery row (queued)
  -> build bounded/redacted Recovery Capsule
  -> child a2a task + child run linked to source task/run
  -> independent no-tools scribe invocation (running)
  -> validate and bound output
  -> append persistent recovery assistant message
  -> broadcast recovery/message SSE
  -> completed, or failed with mechanical fallback
```

## Recovery Record Contract

SQLite table `chat_message_recoveries`:

| Field | Contract |
| --- | --- |
| `id` | UUID primary key |
| `conversation_id` | Source conversation; FK cascade |
| `source_message_id` | Failed assistant source; FK cascade and UNIQUE idempotency key |
| `source_task_id` | Required original task id |
| `source_run_id` | Required original run id |
| `recovery_task_id` | New `a2a_tasks` id, kind `conversation_recovery` |
| `recovery_run_id` | New child run id when the model invocation starts |
| `recovery_message_id` | Appended fallback message id after terminal persistence |
| `status` | `queued | running | completed | failed` |
| `capsule_json` | Fully bounded/redacted versioned Capsule |
| `model_output` | Validated bounded scribe output, otherwise null |
| `error_code/error_message` | Bounded safe failure projection |
| `fallback_used` | 1 only when mechanical output was persisted |
| timestamps | created/updated/started/ended ISO timestamps |

The unique `source_message_id` constraint is the durable idempotency boundary. Duplicate clicks return the canonical row and never create another task, run, model call, or message. A process-local in-flight map coalesces scheduling only; correctness does not depend on it.

The source linkage is repeated on the child task/run metadata as `sourceMessageId`, `sourceTaskId`, and `parentRunId=sourceRunId`. The recovery message metadata carries `recoveryResult`, `sourceMessageId`, `sourceTaskId`, `sourceRunId`, `recoveryTaskId`, and `recoveryRunId`.

## State Machine

```text
absent -> queued -> running -> completed
                         \-> failed
```

- `queued`: durable row and recovery task exist; no model request has started.
- `running`: Capsule persisted and child run started.
- `completed`: valid scribe output and recovery message persisted.
- `failed`: model/validation failure, but mechanical fallback message persisted with `fallback_used=1`.
- Terminal states are immutable in MVP. Duplicate POST returns the same terminal record.
- Startup does not auto-replay queued/running rows. A stale non-terminal row is shown as failed/interrupted by projection and remains auditable; no model call or side effect is replayed automatically.

## Recovery Capsule v1

```ts
type RecoveryCapsule = {
  version: 1;
  source: {
    conversationId: string;
    messageId: string;
    taskId: string;
    runId: number;
    agentId: string | null;
    agentName: string;
    failedAt: string;
  };
  objective: {
    originalRequest: string;
    acceptance: string[];
    contextSections: Array<{ key: string; title: string; content: string; truncated: boolean }>;
  };
  failure: {
    messageError: string;
    taskError: string;
    runError: string;
    terminationType: string;
    assistantErrors: string[];
  };
  tools: Array<{
    sequence: number;
    toolCallId: string;
    toolName: string;
    status: 'completed' | 'possibly_effective' | 'not_completed' | 'unknown';
    command?: string;
    path?: string;
    exitCode?: number | null;
    isError?: boolean | null;
    outputHead: string[];
    outputTail: string[];
    errorLines: string[];
    evidence: 'tool_result' | 'tool_call_only' | 'bridge_event';
    truncated: boolean;
  }>;
  evidenceSummary: {
    completed: string[];
    possiblyEffective: string[];
    notCompleted: string[];
    unknown: string[];
  };
  truncation: { truncated: boolean; droppedToolCount: number; droppedChars: number };
};
```

Tool evidence rules:

- A paired `toolResult` with explicit success is `completed`.
- An error result for a mutating/external command is `possibly_effective`; the failure does not prove rollback.
- An error result for a read-only tool is `not_completed`.
- A tool call without a paired result is `possibly_effective` for mutating/external tools and `unknown` otherwise.
- Never infer business completion from assistant prose. Evidence labels describe observed tool lifecycle only.

Per-tool projection keeps normalized command/path, explicit exit/isError state, first 6 non-empty lines, last 6 non-empty lines, and up to 8 error-like lines. Secrets, authorization headers, tokens, passwords, API keys, cookies, callback credentials, high-entropy secret forms, and non-visible absolute paths are redacted before any text is persisted or sent to the model.

## Limits

| Boundary | Limit |
| --- | --- |
| Session JSONL read | 8 MiB tail; reject larger unavailable/truncated source only when no complete call/result evidence can be recovered |
| Context sections | allowlist only; max 8 sections, 6,000 chars each, 18,000 chars total |
| Tool records | newest 80 with deterministic first/last preservation; 1,600 chars per record |
| Capsule serialized size | 64 KiB hard maximum after redaction |
| Scribe prompt | 72 KiB hard maximum including fixed instructions |
| Scribe output | 8,000 chars; model max 2,000 output tokens |
| Scribe timeout | 60 seconds absolute |
| Safe error text | 240 chars |

Oversized inputs are deterministically clipped and report dropped counts. A Capsule that cannot fit the hard maximum after mandatory source/failure fields is rejected as incomplete; the model is never called.

## Scribe Contract

- The scribe is the platform system actor `recovery_scribe`, never a `chat_agents`, `chat_role_identities`, or `chat_conversation_agents` row. Recovery result messages use `agentId=null`, a system-scribe sender label, and `systemActorType=recovery_scribe`, `systemActorRoutable=false` metadata.
- Without a saved platform setting, configuration priority is explicit service options, then `CAFF_RECOVERY_ENABLED/PROVIDER/MODEL/THINKING/TIMEOUT_MS`, then digest settings for provider/model/thinking, then Pi defaults. A complete persisted `recovery_scribe` SQLite row overrides that startup chain so a local-admin save is immediately authoritative. Its `provider/model/thinking` are also the authoritative shared model selection for the next conversation digest, digest rollup, title refinement, and recovery invocation. Invalid startup enable values fail startup; timeout is configurable only within the fixed `1,000..60,000 ms` hard bound; disabled recovery returns a bounded 503 and projects the service as disabled on eligible failed messages without disabling summaries.
- Prefer a provider/model different from the source when recovery-specific configuration is available. The source model is never selected merely to match provenance.
- Invocation uses Pi `ModelRuntime.completeSimple` directly with a single fixed system instruction and one user Capsule message. It creates no Agent session, no extensions, no skills and no tools.
- The recovery run is manually persisted in `runs` with `task_kind=conversation_recovery`, `task_role=recovery_scribe`, `parent_run_id=sourceRunId`, and bounded metadata. Its task uses `assignedAgent=caff-system` and `assignedRole=recovery_scribe`; those are audit labels, not routeable Agent identities.
- Output must contain the fixed headings: `已经完成`, `失败位置`, `可能已生效但需核验`, `尚未完成`, `建议恢复点`, `无法从现场判断`, and the non-execution statement. Invalid/empty/oversized output triggers mechanical fallback.

## API and SSE

```text
POST /api/conversations/:conversationId/messages/:messageId/recovery
body: {}
202 { recovery, duplicate }

GET /api/system-services/recovery-scribe
200 { config, source, updatedAt, modelOptions }

PUT /api/system-services/recovery-scribe
body: { enabled, provider, model, thinking, timeoutMs }
200 { config, source: 'persisted', updatedAt, modelOptions }
```

- Reject unknown body fields.
- Response acknowledges the durable recovery before the background model call finishes.
- Message-page projection adds `message.recovery` for source messages with a recovery row and a server-owned `message.recoveryCapability` for every failed assistant source: `{ enabled, eligible, reasonCode, reason, systemActorType: 'recovery_scribe', routable: false }`.
- Capability and POST share the same idle/source inspection. Historical `run=succeeded` is accepted only when message/task are failed and the persisted run has at least one non-empty `assistantErrors` entry; source rows are never rewritten. A succeeded run without that structured evidence is ineligible.
- SSE `conversation_recovery_updated` carries `{ conversationId, sourceMessageId, recovery }` for queued/running/terminal states.
- Terminal processing also emits normal `conversation_message_created` for the appended recovery message and `conversation_summary_updated`.
- System-service GET/PUT is loopback local-admin guarded and credential-blind. PUT rejects unknown/missing fields, models outside the configured catalog, unsupported thinking, and timeout outside 1..60 seconds. Digest POST bodies reject `provider/model/thinking`; model selection is changed only through this system-service configuration.
- A valid PUT atomically replaces one complete configuration row and emits `system_service_config_updated`; open chat clients refresh the current message page.
- Each Recovery POST snapshots configuration at acceptance. A concurrent save applies to the next accepted recovery, not the already queued/running task.

## Validation and Error Matrix

| Condition | Result |
| --- | --- |
| Conversation missing | 404 `conversation_recovery_conversation_not_found` |
| Source missing/outside conversation | 404 `conversation_recovery_source_not_found` |
| Source not assistant or not failed | 409 `conversation_recovery_source_not_failed` |
| Recovery globally disabled | 503 `conversation_recovery_disabled` |
| Conversation active, dispatching, queued, or has active side slot | 409 `conversation_recovery_conversation_busy`; page capability uses the same reason code |
| Runtime/mutation state cannot be inspected | 409 `conversation_recovery_state_unavailable`; page fails closed |
| Missing/not-failed task or missing run | 409 `conversation_recovery_source_task_missing` / `_task_not_failed` / `_run_missing` |
| Current run failed | Eligible run-state evidence |
| Historical run succeeded with non-empty persisted assistant errors | Eligible compatibility source; original run stays succeeded |
| Succeeded run without assistant errors or another run status | 409 `conversation_recovery_source_run_not_failed` |
| Message/task/run linkage mismatch | 409 `conversation_recovery_source_link_mismatch` |
| Snapshot missing/mismatched | 409 `conversation_recovery_source_snapshot_missing` / `_snapshot_mismatch` |
| Session missing/unreadable/mismatched | 409 `conversation_recovery_source_session_missing` / `_session_mismatch` |
| First valid click | 202, durable queued row, one background job |
| Duplicate/concurrent click | 202 canonical row with `duplicate=true`; no second work |
| Capsule exceeds limit after deterministic clipping | terminal failed mechanical message; no scribe model call |
| Scribe timeout/provider error/invalid output | recovery `failed`, mechanical fallback message persisted |
| Message persistence fails | recovery remains failed with safe error; never rewrite source |
| Server restarts with queued/running recovery | no automatic replay; state remains auditable and projects interrupted |

## UI

- Failed assistant cards show `整理失败现场` only when server-projected `recoveryCapability.enabled === true && eligible === true`; browser message status alone never grants the action.
- Ineligible failed sources show the server-projected bounded reason and no action. Missing capability fails closed with a hidden panel.
- State labels: `等待整理`, `正在整理`, `整理完成`, `机械摘要`.
- Queued/running disable the button. Completed/failed show the canonical state and do not offer retry in MVP.
- Recovery messages visibly identify themselves as `系统书记`, the source trace/message and state: `这是只读现场整理，不会执行或重放原任务。`
- When recovery is disabled by startup default or saved platform configuration, eligible failed cards show `系统书记已停用` and expose no recovery command.
- The global `系统服务` management tab provides one shared configured model/thinking selection for conversation summaries, rollups, title refinement, and recovery. Recovery enable and 1..60 second timeout remain recovery-only; the UI states both boundaries and keeps fixed prompt/zero-tool/bounds/fallback non-editable.
- Saving succeeds only after persistent readback and takes effect for the next Recovery request without restarting CAFF.
- No automatic continue/retry controls and no source failed-state rewrite.

## Acceptance Criteria

- [ ] Contract/spec records the Capsule, state machine, limits, redaction, linkage and error matrix above.
- [ ] Real SQLite stores one idempotent recovery per failed source and links a child task/run through sourceMessageId/sourceTaskId/parentRunId.
- [ ] Synthetic large JSONL proves toolResult pairing, bounded output and secret/path redaction.
- [ ] External/mutating error and missing-result cases project as possibly effective, never completed.
- [ ] Scribe invocation has zero tools/extensions and obeys input/output/timeout limits.
- [ ] `recovery_scribe` is absent from role/participant/mention/private/handoff/default/explicit/cross-conversation/Goal/DAG candidates; reserved IDs/names and constructed delivery targets fail closed.
- [ ] Model failure and invalid output append one mechanical fallback message.
- [ ] HTTP duplicate/concurrent/busy/source-integrity behavior is covered, including historical succeeded-run compatibility, no-evidence rejection, and message-page/POST reason parity.
- [ ] SSE and UI show queued/running/completed/failed without changing the original failed state; UI action is driven only by server capability and ineligible/missing capability states expose no misleading button.
- [ ] Platform admin can save and read back enabled/provider/model/thinking/timeout; the next recovery, digest, rollup, and title refinement use the saved shared model snapshot without restart, disable synchronizes recovery UI/POST without disabling summaries, request-level digest model overrides are rejected, and invalid values leave the row unchanged.
- [ ] Build, check, typecheck, target tests, smoke and isolated browser acceptance pass.

## Likely Files

- `storage/sqlite/migrations.ts`
- `storage/chat/message-recovery.repository.ts`
- `storage/chat/system-service-config.repository.ts`
- `lib/chat-app-store.ts`
- `server/domain/conversation/recovery-capsule.ts`
- `server/domain/conversation/message-recovery.ts`
- `server/domain/conversation/recovery-scribe-config.ts`
- `server/api/recovery-scribe-config-controller.ts`
- `server/api/conversations-controller.ts`
- `server/app/create-server.ts`
- `public/app.js`
- `public/personas.html`
- `public/personas/recovery-scribe-management.js`
- `public/chat/message-timeline.js`
- `public/styles.css`
- `tests/storage/message-recovery.test.js`
- `tests/http/message-recovery-controller.test.js`
- `tests/runtime/recovery-capsule.test.js`
- `tests/ui/message-recovery.test.js`
- `.trellis/spec/backend/message-recovery.md`
