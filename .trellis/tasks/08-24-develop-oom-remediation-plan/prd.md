# Develop/3100 OOM Remediation Plan

## Goal

Produce a staged remediation plan for the develop/3100 Node out-of-memory incident that is implementable, testable at production scale, observable during rollout, and reversible without data loss.

This task produces planning and acceptance artifacts only. It does not change application behavior, production configuration, production data, or running processes.

## Confirmed Incident Boundary

- The crashed main Node process, PID 31880, had run for about 64,976 seconds.
- Its final V8 Mark-Compact reduced old-space from only 4095.7 MB to 4095.3 MB before `Reached heap limit`.
- The user likely opened the memory or summary panel shortly before the incident.
- Opening the long-term memory drawer automatically calls global `GET /api/memory/health`.
- The global health and backfill paths fully hydrate every conversation and retain those objects until the operation finishes.
- Production read-only measurements found about 15,052 messages, 9.7 MB of message content, and 373 MB of `metadata_json`; about 369 MB is associated with messages containing `agentContextSnapshot` and `modelUsage`.
- No access log or heap snapshot exists for the crash window. The trigger is high confidence, not request-level forensic proof.

## Requirements

### P0: Remove The Confirmed OOM Trigger

- Global memory health must use conversation metadata/header projections and must not read message history.
- Global backfill must process one lightweight conversation projection at a time and must not accumulate hydrated conversations.
- Summary-segment persistence invoked by backfill must not reintroduce message hydration per digest.
- Existing health/backfill HTTP response fields, status values, idempotency, task attribution, and bounded diagnostics must remain compatible.
- Scoped missing-conversation and per-digest failure behavior must remain explicit and testable.
- Regression tests must fail if health, backfill, or summary-segment save calls `listMessages()`.

### P1: Bound Other Request-Driven OOM Risks

- The HTTP metrics endpoint must reject or supply a bounded date window; the offline CLI may retain explicit unbounded operator use.
- Metrics queries must avoid retaining full unbounded message and task-event rows when aggregate SQL or bounded projections suffice.
- SSE must treat `res.write() === false` as backpressure and bound or terminate slow clients instead of adding unlimited socket-buffer data.
- Lightweight process and scheduler counters must make renewed growth distinguishable from a single bounded request peak.

### P2: Reduce Continuous Hydration And Future Metadata Growth

- Goal continuation and queue discovery must use no-message or targeted message queries.
- Agent prompt construction must query only the required bounded history window and current-turn rows rather than hydrate all messages before slicing to 24.
- Per-run `modelUsage.calls` must retain exact aggregates while bounding persisted call details.
- Context snapshots must move off the ordinary message-list hydration path while historical rows remain readable.
- Database changes must be forward/backward compatible and must not rewrite the 2 GB production database during normal startup.

## Non-Goals

- Do not increase `--max-old-space-size` as the fix.
- Do not capture a multi-GB heap snapshot on production port 3100.
- Do not change memory search relevance, digest content, Goal routing, or user-visible message history semantics in P0.
- Do not perform automatic production metadata compaction or destructive history cleanup.
- Do not implement any phase in this planning Goal.

## Acceptance Criteria

- [ ] Root-cause evidence, confidence boundaries, alternatives, and falsifiers are documented.
- [ ] Every relevant full-hydration entry and its retention lifetime is inventoried on latest `origin/develop`.
- [ ] P0 names exact functions, compatibility guarantees, failures, tests, and rollback.
- [ ] P1/P2 work is ordered by risk reduction and dependency.
- [ ] A synthetic production-shape dataset and measurable heap/RSS budgets are defined.
- [ ] Slow SSE, metrics, concurrent requests, and long-running Goal workloads have acceptance tests.
- [ ] Isolation, telemetry, gray rollout, stop conditions, and rollback are explicit.
- [ ] An independent architecture reviewer approves the plan before an implementation Goal is proposed.
- [ ] The user confirms the reviewed plan before implementation starts.

## Delivery Artifacts

- `research.md`: incident evidence and code-path inventory.
- `remediation-plan.md`: phased contracts, tests, rollout, and rollback.
- A later user-approved implementation Goal or DAG, created only after this plan is reviewed.
