# Backend Index

Use this index for changes in `server/api/`, `server/app/`, `server/http/`, and
backend domain services.

## Scope

- HTTP route handlers and request parsing
- App bootstrapping and server wiring
- Domain services that support chat, session goals, games, metrics, or projects
- Backend changes that may affect prompt assembly or active project resolution
- Session goal API and metadata contracts (`session-goal.md`)
- Core and role-aware readiness projection (`health-endpoint.md`)
- Conversation digest API, metadata, prompt, and UI contracts (`conversation-digest.md`)
- Atomic deletion of eligible unsummarized public messages (`conversation-message-deletion.md`)
- Automatic conversation title state, first-message derivation, first-digest
  refinement, and manual rename protection (`conversation-title.md`)
- Digest-to-skill draft extraction and confirmation (`../runtime/skill-extraction.md`)
- Cross-conversation summary segment memory search and no-message memory health/backfill projections (`summary-memory.md`)
- Bounded agent metrics window and projections (`agent-metrics.md`)
- Reversible message detail tables, atomic dual writes, dual reads, and bounded
  context-snapshot pagination (`message-detail-storage.md`)
- Manual failed-message Recovery Capsule persistence, evidence grading, isolated
  scribe runs, hot global system-service configuration, mechanical fallback,
  API/SSE, and UI (`message-recovery.md`)
- SSE per-client backpressure budget and drain deadlines (`sse-backpressure.md`)
- Conversation tree DAG plan storage, lifecycle, and plan API (`dag-planning.md`)
- Skill management and configuration (skills-controller.ts)
- Local-admin model provider projection, patching, and token limit fields (`model-provider-config.md`)

## Pre-Development Checklist

- [ ] Read `architecture.md`
- [ ] Read `controller-patterns.md` if you touch controllers, request parsing, or
      HTTP responses
- [ ] Read `conversation-message-deletion.md` if you touch message deletion,
      digest eligibility, conversation mutation locking, or attachment cleanup
- [ ] Read `message-detail-storage.md` if you touch assistant context snapshots,
      model usage metadata, message transactions, or context-snapshot routes
- [ ] Read `model-provider-config.md` if you touch `/api/model-providers`,
      `models.json` persistence, or the provider editor
- [ ] Read `feishu-integration.md` if you touch Feishu webhook, long connection,
      event parsing, external event dedup, or outbound reply delivery
- [ ] Also read `../runtime/index.md` if the change touches agent execution,
      prompt context, sandbox env vars, or tool bridge behavior
- [ ] Read `../guides/cross-layer-thinking-guide.md` when data crosses backend,
      runtime, and UI boundaries
- [ ] Read `../skills/index.md` if working with skill management or skill loading

## Documents

- `architecture.md`: backend module boundaries and ownership
- `controller-patterns.md`: handler conventions, error flow, and response shape
- `model-provider-config.md`: local-admin provider API, token-limit defaults,
  validation, patch-clear semantics, and cross-layer test points
- `feishu-integration.md`: Feishu webhook/long-connection contracts, env keys,
  event normalization, dedup expectations, and test points
- `session-goal.md`: `/goal` API, metadata, prompt, SSE, and frontend slash command contracts
- `health-endpoint.md`: `/api/health` local readiness, redaction, and optional integration contracts
- `conversation-digest.md`: `/digest` API, metadata, prompt, SSE, and frontend panel contracts
- `conversation-message-deletion.md`: deletion eligibility, batch API, mutation guard, SQLite/image cleanup, SSE, and UI contracts
- `conversation-title.md`: `titleSource` state machine, first-user-message title,
  first-auto-digest model refinement/config chain, and manual rename guards
- `room-context-workspace.md`: Room=Conversation Project/Mode identity, generated workspace binding, runtime cwd/orchestration context, destructive legacy retirement, and acceptance evidence contracts
- `../runtime/skill-extraction.md`: `/digest extract-skill` and `/skill-drafts` contracts
- `summary-memory.md`: searchable digest segment ledger, `/api/memory/search` contracts, and OOM-safe no-message health/backfill projections (`getConversationWithoutMessages()` / header-only global paths, `listMessages` poison guard, heap/RSS/latency budgets)
- `agent-metrics.md`: `/api/metrics/agent` dual-boundary ≤31-day window (400 `metrics_agent_window_invalid`, no silent default), bounded SQL projections (no raw `metadata_json`/`event_json` materialization), offline CLI explicit-unbounded mode, and production-shape gate budgets
- `message-detail-storage.md`: message-keyed context snapshot/model usage tables,
  atomic Expand dual writes, table-first metadata fallback reads, first-plus-latest
  call retention, stable cursor pagination, deletion, and rollback contracts
- `message-recovery.md`: failed-message Recovery Capsule schema, bounded toolResult
  evidence, child recovery task/run linkage, no-tools scribe, fallback, API/SSE,
  and timeline contracts
- `sse-backpressure.md`: SSE per-client 2 MiB combined budget (queued + writableLength), 5s per-blocked-episode drain deadline, FIFO no-duplicate flush, unified prelude/initial/event/ping accounting, cleanup guarantees, and `getStats()` diagnostics
- `dag-planning.md`: `chat_plans` storage, plan lifecycle (draft→active), shared
  validation, and `/api/conversations/:id/plan` contracts
- `dag-execution.md`: event-hook scheduler, per-node worktrees, merge executor,
  completion write-back, and restart reconcile contracts (D21–D26)
- See `../skills/` for skill-related backend patterns (skills-controller.ts)
