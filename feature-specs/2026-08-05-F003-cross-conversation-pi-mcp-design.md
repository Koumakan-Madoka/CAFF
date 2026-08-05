---
feature_ids: [F003]
topics: [architecture, cross-conversation, delivery, mcp, pi, tree, design-gate]
doc_kind: design_gate
created: 2026-08-05
status: approved_for_implementation
---

# F003 Technical Design Gate

## Status

Architecture consensus, product semantics, the exact official MCP SDK dependency, and the UI direction are approved. Implementation is unblocked under the frozen contracts in this document and the [discussion record](../feature-discussions/2026-08-05-F003-cross-conversation-pi-mcp/README.md).

## Architecture Cell

Architecture cell: `storage/chat -> lib/chat-app-store -> server/domain/conversation + server/domain/runtime -> server/api -> public/chat`

Map delta: none

Why: CAFF has no separate ownership-map document. F003 introduces one delivery domain inside the existing conversation boundary and reuses side-dispatch, the Pi SDK Host extension point, the agent-tool credential bridge, and the AppShell timeline/tree surfaces.

## Selected Coordinate System

```text
Cross-room communication
  = durable delivery intent
  + target message projection
  + target-scoped dispatch
  + optional correlated response

Spawn
  = new conversation
  + navigation/source provenance
  + one complete public initialMessage
  + bootstrap delivery to one primary Agent

Pi MCP bridge
  = Pi-native facade schema
  + CAFF server-side capability allowlist
  + hidden MCP/internal adapter
```

There is no second queue truth, hidden bootstrap store, history snapshot, generic MCP proxy, or special thread scope.

## Data Model

### `chat_conversations` additions

| Field | Contract |
|---|---|
| `project_scope_id TEXT NULL` | Explicit project binding. Agent cross-conversation delivery requires equal non-null values. Legacy null is unaddressable until operator binds it. |
| `parent_conversation_id TEXT NULL` | Navigation parent set by spawn. Immutable in v1; self-parent and cycles rejected. |
| `origin_conversation_id TEXT NULL` | Immutable creation source for provenance. Equal to parent at spawn time, retained independently for future-safe audit. |
| `origin_message_id TEXT NULL` | Optional source message anchor; provenance only, never means copied history. |
| `tree_depth INTEGER NOT NULL DEFAULT 0` | Persisted/validated depth for cheap max-depth and cycle checks. |

The migration must rebuild `chat_conversations` if necessary to add self-referential foreign keys and checks safely. Deleting a conversation with children or active deliveries is rejected; v1 uses archive/tombstone semantics rather than cascade/reparent.

### `chat_cross_conversation_deliveries`

One row is one target conversation + one target Agent + one lifecycle.

Required groups:

- Identity: `id`, `kind=notify|request|bootstrap`, `idempotency_scope`, `idempotency_key`.
- Source principal snapshot: source conversation/message/turn/invocation, operator-or-agent kind, sender Agent ID/name snapshot, project scope.
- Target: target conversation/Agent, target message ID, target project scope.
- Correlation: `trace_id`, `root_delivery_id`, `parent_delivery_id`, `reply_to_delivery_id`, `hop_count`.
- State: `message_status`, `dispatch_status`, `response_status`, `attempt_count`, `deadline_at`, `cancel_requested_at`, `last_error_code/message`.
- Claim/outbox: `claim_owner`, `claim_expires_at`, `next_attempt_at`.
- Timestamps: created/updated/delivered/started/completed/responded/terminal.

Unique contracts:

- `(idempotency_scope, idempotency_key)` is unique.
- `target_message_id` is unique when present.
- request has exactly one target Agent and at most one canonical response delivery.

### `chat_cross_conversation_delivery_events`

Append-only events record validation, persistence, claim, attempt, dispatch start/end, cancel, timeout, response, late response and recovery. Events redact content and credentials; message content remains in `chat_messages`.

### Message projections

- `notify/request` target projection: role `external_agent`, sender snapshot + `metadata.crossConversation` with delivery/provenance/deadline. It is low-authority peer input.
- source receipt projection: dedicated metadata kind rendered by timeline; status is read from delivery row, not duplicated as an independent state machine.
- spawn `initialMessage`: role `user`, public, operator-authored/approved, first target conversation message. It is not `external_agent` and not hidden.

## State Contract

```text
messageStatus  = pending | persisted | failed
dispatchStatus = not_requested | queued | running | completed | failed | cancel_requested | cancelled
responseStatus = not_expected | waiting | received | timed_out | cancelled | late
```

- `notify`: responseStatus=`not_expected`.
- `request`: responseStatus=`waiting` until received/timed_out/cancelled/late.
- `bootstrap`: message is already persisted public user input; dispatchStatus tracks only the primary Agent start/run.
- A derived UI label may combine the three facts, but persistence never collapses them into one ambiguous enum.

## Permission Contract

Validation order is fail-closed and occurs before idempotency claim:

1. Authenticate invocation/operator principal.
2. Resolve source conversation from principal, never request body.
3. Validate facade and request schema.
4. Reject self-conversation delivery.
5. Resolve target conversation and target Agent.
6. Require source and target non-null equal `project_scope_id`.
7. Require target Agent to be an active target participant.
8. Validate trace edge/maxHop and deadline.
9. Claim idempotency and persist.

Tree adjacency is neither required nor sufficient. A parent/child pair in different projects is denied; unrelated conversations in the same explicitly bound project may communicate.

## Delivery Transaction and Worker

### Notify/request submit

One SQLite transaction:

1. Insert delivery with `message=pending`, `dispatch=queued`.
2. Insert target external peer message and source receipt projection.
3. Set message status persisted and append persisted event.
4. Commit.

After commit, worker claims the delivery and calls existing target-scoped side-dispatch.

### Crash recovery

- Before commit: no delivery/messages exist.
- After commit, before claim: restart scanner claims queued row.
- Claimed but invocation not started: expired lease can be reclaimed.
- Invocation started: automatic retry never starts a second invocation; stale row becomes failed/unknown outcome and requires explicit operator retry policy.
- Target message already exists: recovery only resumes dispatch; it never inserts a duplicate message.

### Retry and cancel

- Automatic retry only for deterministic pre-invocation transport/claim failures.
- Explicit retry reuses delivery identity when safe or creates a linked retry delivery when prior invocation outcome is unknown.
- queued cancel is deterministic; running cancel is best-effort stop and preserves messages/events.
- timeout never deletes request; late response is stored and visibly marked late.

### Request response

The target side-dispatch completion hook creates one correlated reply delivery to the source conversation and updates responseStatus. It persists and broadcasts the reply but does not enqueue a source turn.

## Loop Guard

- Reject source==target.
- Every triggered child delivery must carry `parent_delivery_id` and shared `trace_id`.
- Within one trace, the same directed `(sourceConversationId, targetConversationId)` edge is allowed once.
- One correlated reply may traverse the reverse edge.
- `maxHop=8` is a hard guard.
- No cross-conversation message may carry an executable local `@mention` that expands the target set in v1.

## Pi MCP Capability Bridge

### Pi-visible facade

Initial tools:

```text
conversation_notify(targetConversationId, targetAgentId, content, idempotencyKey)
conversation_request(targetConversationId, targetAgentId, content, idempotencyKey, deadlineSeconds?)
```

The Pi extension reads invocation credentials from CAFF-provided environment and calls the existing local agent-tool HTTP boundary. It does not read MCP configuration.

### Server-side registry

Each facade registration owns:

- public name/description/input schema;
- allowed principal kinds/project scopes;
- internal domain handler or fixed MCP server/tool adapter;
- request projection and injected fields;
- result projection/redaction;
- timeout and retry class.

Forbidden model-visible/runtime-selectable fields:

- MCP server ID/URL/transport;
- actual tool name;
- command/env/headers/credential;
- arbitrary raw argument object;
- fallback shell/HTTP action.

The operator approved a direct, exactly pinned official `@modelcontextprotocol/sdk` dependency in message `0001785912003140-001436-f87dfd0e`. Cover stdio/HTTP transport behavior proportionate to the selected first server; never rely on the current transitive optional copy.

## Spawn Contract

```text
POST /api/conversations/:sourceConversationId/spawn
{
  title,
  projectScopeId,
  participants: [{ agentId, modelProfileId?, conversationSkillIds? }],
  primaryAgentId,
  initialMessage,
  sourceMessageId?,
  clientRequestId
}
```

Validation:

- source exists; requested parent depth < max depth;
- explicit non-empty participants using current participant validator;
- primary Agent is one selected participant and runnable;
- source is explicitly project-bound; project scope is explicitly selected,
  accessible, and equal to the source binding;
- initialMessage is non-empty and bounded;
- clientRequestId is non-empty and idempotently returns the canonical existing
  child/message/receipt/delivery on duplicate submission;
- no history/config/participant inheritance code path is called.

One SQLite transaction persists:

1. new conversation + project/parent/origin fields;
2. explicit participants;
3. first public user message with source provenance;
4. source receipt projection;
5. `bootstrap` delivery/outbox targeting primary Agent.

The worker starts only the primary Agent after commit. Failure preserves the conversation and message.

## API Surface

Proposed internal/public routes:

```text
POST /api/conversation-deliveries
GET  /api/conversation-deliveries/:deliveryId
POST /api/conversation-deliveries/:deliveryId/retry
POST /api/conversation-deliveries/:deliveryId/cancel
POST /api/conversations/:sourceConversationId/spawn
PUT  /api/conversations/:conversationId/project-scope   # operator-only legacy binding
```

Agent facade routes remain under invocation-scoped `/api/agent-tools/*`; public UI routes use the local operator HTTP security contract. Sender identity and source conversation are never accepted from Agent request bodies.

## UI Design Contract

### Tree

- Replace current high conversation cards with compact semantic tree rows.
- Stable sibling order; message/status updates do not move nodes.
- Root/child/grandchild supported; max depth is 3 levels in v1.
- Selected node expands ancestors.
- Node plus opens the reused new-conversation dialog/sheet with locked parent.
- No drag/reparent in v1.

### Source receipt

- Independent timeline item because the action may originate from Agent tool use or operator UI.
- Reuse trace pill tones and live rotor.
- Normal path stays one compact row; failure expands human-readable reason + retry/cancel.
- Jump action opens target conversation/message.

### Target provenance and birth card

- external peer message header shows source conversation/sender/kind/deadline and links back.
- spawn first message renders a birth/provenance treatment but remains a normal public user message in history and prompts.
- no dark context that operator cannot inspect.

### Responsive

- Desktop uses existing persistent sidebar.
- Mobile uses existing hamburger drawer; selecting a conversation closes it.
- Spawn uses existing full-screen sheet behavior at narrow width.

## In-Context Observability

```yaml
in_context_observability:
  primary_surface: "source durable receipt + target provenance/birth card + tree node compact status"
  why_not_dashboard_only: "delivery state changes the user's immediate retry/cancel/navigation action and must remain visible after refresh in the conversation where it happened"
  deep_dive_surface: "append-only delivery event/attempt trace; no new dashboard in v1"
  noise_dedup_policy: "one receipt per delivery, original-place patching, failure-only expansion, identical state/reason suppression"
```

## Verification Matrix

| Area | Required evidence |
|---|---|
| Storage | migration/rebuild, FK/check/unique, transaction rollback, event append-only |
| Permission | self/unbound/different project/non-participant/tree-not-ACL/expired invocation |
| Idempotency | duplicate submit, duplicate recovery, duplicate response |
| Recovery | four crash windows, lease reclaim, started-invocation no-auto-replay |
| Request | automatic reply, no source wake, timeout, cancel, late reply |
| Loop | repeated edge, reverse reply exception, maxHop |
| Pi bridge | facade schema, real MCP adapter, secret redaction, unknown facade, disconnect/timeout, no generic proxy |
| Spawn | explicit fields, non-Fork assertions, transaction failure, bootstrap failure retention, retry |
| UI | 1440/375 tree, drawer, receipt/provenance states, SSE patch stability, keyboard/focus |
| Full gate | `npm run check`, `npm run typecheck`, focused tests, `npm run test:fast`, `npm run test:smoke` |

All fixtures use isolated temporary SQLite and test MCP servers. Redis 6399 and production user data are prohibited.

## Rejected Designs

- Message metadata as the delivery state machine.
- A separate outbox queue in addition to the delivery row.
- `external_agent` entering the main multi-Agent turn.
- Tree adjacency as the permission rule.
- Automatic source-Agent wake on reply.
- Fork/snapshot/generated handoff bundle/recipient-only bootstrap.
- Generic MCP proxy or model-controlled transport/config.
- Toast-only failure or dashboard-first observability.

## Approved Gate

Approval evidence: message `0001785912003140-001436-f87dfd0e` — “两项都批准”。

1. ✅ Direct, exactly pinned official `@modelcontextprotocol/sdk` dependency.
2. ✅ Compact tree rows, reused new-conversation dialog/sheet, and independent durable receipt cards.

Implementation thread roles: 砚砚主理，烁烁负责 UI 设计，宪宪提供架构与实现辅助。

[砚砚/gpt-5.6-sol🐾]
