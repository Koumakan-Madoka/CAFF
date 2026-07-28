---
feature_ids: [CAFF-EVAL-CHAT-STORAGE]
topics: [storage, sqlite, redis, benchmark, durability, chat]
doc_kind: plan
created: 2026-07-28
status: review_ready
---

# Chat Storage Evaluation Implementation Plan

**Feature:** CAFF-EVAL-CHAT-STORAGE - operator request in `thread_mrxfv8tub5r1uvww`
**Goal:** Produce a reproducible, evidence-backed Redis versus SQLite decision for CAFF's local AI chat workload without reading or mutating user data.
**Acceptance Criteria:**
1. Both backends implement the same append, latest-page, cursor-page, point-read, status-update, count, and restart contract.
2. Workloads are deterministic, synthetic, configurable, and include a long hot thread plus many ordinary threads.
3. Results include latency percentiles, throughput, disk usage, process memory where observable, restart recovery time, and acknowledged-message loss count.
4. Balanced and strict durability profiles are evaluated separately: Redis AOF everysec/always versus SQLite WAL NORMAL/FULL.
5. Redis runs in a fresh temporary directory on a dynamically allocated non-production port; ports 6398 and 6399 are rejected.
6. The harness never connects to an existing Redis instance and never reads CAFF's configured SQLite database.
7. Raw JSON evidence and a written verdict identify measured facts, repository evidence, limitations, and the recommended CAFF architecture.
8. Harness contract tests, repository checks, typecheck, and the existing fast/smoke suites pass.
**Architecture cell:** none (this repository does not define an ownership-cell map)
**Map delta:** none
**Map delta why:** The evaluation is an isolated development harness and does not alter runtime ownership or production storage.
**Architecture:** A backend-neutral runner drives two disposable adapters through one workload contract. SQLite uses `better-sqlite3` with cursor indexes; Redis uses a benchmark-local RESP client and a child `redis-server` with an empty temporary data directory. Results are emitted as versioned JSON and rendered into a Markdown verdict.
**Tech Stack:** Node.js, `node:test`, `better-sqlite3`, Redis RESP2, `redis-server`
**Frontend verification:** No - no browser or user-facing runtime changes

---

## Finish Line

Terminal B is a checked-in harness that another engineer can run on Windows, macOS, or Linux to reproduce the same workload shapes and receive machine-readable evidence plus a verdict template. The checked-in report must answer whether CAFF should keep SQLite as the durable message source of truth and which Redis responsibilities, if any, are justified.

We are not building a production Redis adapter, migrating CAFF data, changing the management-page milestone, benchmarking external managed services, or claiming to simulate host power loss. A killed storage process is a process-crash probe only.

## Terminal Contract

```js
// Every operation returns only after the backend considers it acknowledged.
await backend.open();
await backend.append(message);
await backend.appendBatch(messages);
await backend.latest(threadId, limit);
await backend.after(threadId, cursorSequence, limit);
await backend.getById(messageId);
await backend.updateStatus(messageId, status);
await backend.count(threadId);
await backend.close({ graceful: true });
```

```json
{
  "schemaVersion": 1,
  "environment": {},
  "configuration": {},
  "backends": {
    "sqlite": { "operations": {}, "storage": {}, "recovery": {} },
    "redis": { "operations": {}, "storage": {}, "recovery": {} }
  },
  "limitations": [],
  "verdictInputs": {}
}
```

## Evaluation Matrix

| Dimension | Balanced profile | Strict profile |
|---|---|---|
| SQLite | WAL + `synchronous=NORMAL` | WAL + `synchronous=FULL` |
| Redis | AOF + `appendfsync everysec` + RDB schedule | AOF + `appendfsync always` + RDB schedule |
| Dataset | deterministic synthetic messages | same seed and message shapes |
| Read paths | latest 50, after-cursor 50, point read | same |
| Failure probe | abrupt process termination and restart | same |

The standard checked-in run uses a bounded dataset suitable for CI-adjacent developer hardware. The CLI also exposes a stress profile; stress results are not required for ordinary repository checks.

## Stateful Object Census

| Object | Owner | Lifecycle | Invariants | Adversarial coverage |
|---|---|---|---|---|
| SQLite benchmark DB | SQLite adapter | create -> migrate -> load -> measure -> close -> temp cleanup | never resolves outside harness temp root; durability profile is explicit | abrupt writer exit; reopen and count acknowledged rows |
| Redis child process | Redis process manager | allocate port -> spawn -> readiness probe -> measure -> stop/kill -> restart -> temp cleanup | fresh temp dir; loopback bind; port not 6398/6399; spawned PID is the only kill target | startup failure, occupied port retry, abrupt kill, restart from AOF |
| Benchmark dataset | workload generator | seed -> deterministic stream -> discard | same logical messages and order for both backends; bounded content generation | invalid profile/seed/count rejection |
| Result artifact | runner/reporter | collect -> validate -> atomic write | schema versioned; incomplete backend results cannot be presented as a verdict | missing Redis produces explicit skipped status, never fabricated metrics |

### Invariants

- **INV-1:** No benchmark path may equal or descend from CAFF's configured runtime data path.
- **INV-2:** Redis ports 6398 and 6399 are always rejected.
- **INV-3:** A result marked `completed` contains every required operation and recovery field.
- **INV-4:** Both backends receive identical message IDs, sequences, payloads, users, threads, and mentions.
- **INV-5:** Cursor queries return strictly later messages in ascending order and never exceed the requested limit.
- **INV-6:** Latest queries return the newest bounded window in ascending display order.
- **INV-7:** Acknowledged-loss is computed from IDs acknowledged before termination, not from requested writes.
- **INV-8:** Process-crash evidence is not described as host-power-loss evidence.

## Task 1: Contract, Workload, And Metrics

**Files:**
- Create: `scripts/chat-storage-eval/config.js`
- Create: `scripts/chat-storage-eval/workload.js`
- Create: `scripts/chat-storage-eval/metrics.js`
- Create: `tests/eval/chat-storage-eval.test.js`

1. Write failing tests for deterministic messages, profile validation, reserved-port rejection, percentile calculation, and result completeness.
2. Run `node tests/eval/chat-storage-eval.test.js`; expect module-not-found failure.
3. Implement the smallest deterministic generator and metrics helpers.
4. Re-run the test and keep it green.

## Task 2: Equivalent SQLite Adapter

**Files:**
- Create: `scripts/chat-storage-eval/sqlite-backend.js`
- Modify: `tests/eval/chat-storage-eval.test.js`

1. Add failing conformance tests for append, bounded latest/cursor reads, point reads, updates, and restart persistence.
2. Implement the terminal contract with a normalized message table and covering cursor indexes.
3. Assert the requested durability PRAGMAs rather than assuming they were applied.
4. Re-run conformance tests.

## Task 3: Isolated Redis Adapter

**Files:**
- Create: `scripts/chat-storage-eval/resp-client.js`
- Create: `scripts/chat-storage-eval/redis-process.js`
- Create: `scripts/chat-storage-eval/redis-backend.js`
- Modify: `tests/eval/chat-storage-eval.test.js`

1. Add failing protocol parser tests and optional live conformance tests.
2. Implement only the RESP2 reply types and commands used by the harness.
3. Spawn Redis on loopback with a fresh temp directory and explicit durability settings.
4. Test that reserved ports and pre-existing data directories are rejected.
5. Run the same backend conformance suite against live Redis when `redis-server` is available.

## Task 4: Runner And Recovery Probes

**Files:**
- Create: `scripts/chat-storage-eval/runner.js`
- Create: `scripts/chat-storage-eval/sqlite-crash-writer.js`
- Create: `scripts/chat-storage-eval/report.js`
- Modify: `package.json`
- Modify: `tests/eval/chat-storage-eval.test.js`

1. Add failing tests for CLI parsing, atomic JSON output, and recovery accounting.
2. Implement warmup plus measured append/read/update phases with deterministic samples.
3. Add abrupt-process restart probes for both backends.
4. Add `eval:chat-storage:test`, `eval:chat-storage:quick`, and `eval:chat-storage:standard` scripts.
5. Ensure an unavailable Redis executable yields an explicit skipped result and non-verdict report.

## Task 5: Evidence And Verdict

**Files:**
- Create: `docs/evaluations/chat-storage/2026-07-28-results.json`
- Create: `docs/evaluations/chat-storage/2026-07-28-verdict.md`

1. Run the quick profile as a smoke check.
2. Run balanced and strict standard profiles on the same machine without other benchmark workloads.
3. Re-run any material outlier once and retain both observations in notes.
4. Record repository-history evidence separately from measured benchmark evidence.
5. State limitations: one local machine, synthetic content, process crash rather than host power loss, and no distributed deployment.
6. Issue a CAFF-specific verdict; do not generalize it to every chat product.

## Verification

```text
node tests/eval/chat-storage-eval.test.js
npm run eval:chat-storage:quick
npm run eval:chat-storage:standard
npm run check
npm run typecheck
npm run test:fast
npm run test:smoke
```

## Completed Evidence

- Harness source: `cab7d39391ec07e1d2958e797c7bd95337a90e37`
- Raw standard results: `docs/evaluations/chat-storage/2026-07-28-results.json`
- CAFF-specific verdict: `docs/evaluations/chat-storage/2026-07-28-verdict.md`
- Standard workload: 50,000 messages, 25,000-message hot thread, 500 operation samples, balanced and strict durability profiles.
- Process-crash probe: each backend recovered 2,000 of 2,000 acknowledged messages in both durability profiles; host power loss was not tested.
- Verification: harness tests, result contract validation, `npm run check`, `npm run typecheck`, `npm run test:fast`, and `npm run test:smoke` passed on 2026-07-28.
- Safety: all runs used deterministic synthetic messages, disposable temp directories, loopback-only child Redis processes, and dynamic ports excluding 6398/6399.

## Resolved Questions

- **Redis discovery:** Resolved with `REDIS_SERVER_PATH` first, then a `redis-server --version` PATH probe; absent Redis produces a skipped, non-verdict result.
- **Power-loss scope:** Resolved by limiting automated evidence to process termination and stating the host-power-loss gap in both raw results and verdict.
- **Migration authority:** No production migration is authorized by this work item; the outcome is an evaluation and recommendation only.
