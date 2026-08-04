---
feature_ids: [CAFF-EVAL-CHAT-STORAGE]
topics: [review, storage, sqlite, redis, benchmark, durability]
doc_kind: review-request
created: 2026-07-28
---

# Review Request: CAFF Chat Storage Redis vs SQLite Evaluation

Review-Target-ID: chat-storage
Branch: eval/chat-storage
Review target SHA: `2718dd1917032f1820c36ac4cc5923b680547567`

## What

- Added one deterministic, synthetic Redis-versus-SQLite chat benchmark with identical append, latest-page, cursor-page, point-read, status-update, count, and restart contracts.
- Added a benchmark-local RESP2 client and a harness-owned Redis child process. It uses a fresh temp directory, loopback binding, dynamic port allocation, and hard rejection of ports 6398/6399.
- Added balanced and strict durability profiles, per-operation latency/throughput, stable disk snapshots, scoped memory observations, and process-crash recovery accounting from acknowledged message IDs.
- Recorded standard raw results and a CAFF-specific verdict recommending SQLite as durable source of truth and Redis only for optional distributed coordination/cache responsibilities.

## Why

The operator asked whether Clowder stores long chat histories in Redis, whether Redis avoids repeated database I/O, what storage should be chosen without historical baggage, why Clowder chose Redis, and whether we could complete an evidence-backed evaluation. Repository history showed Clowder's move was from bounded process memory to Redis, not a prior Redis-versus-SQLite benchmark. This change supplies that missing comparison without reading or mutating user data.

## Original Requirements

> "clowder是这种架构吗，clowder的聊天记录是不是保存在redis中？"
>
> "这样就算某个聊天室的消息很长，也不用频繁进行数据库读写"
>
> "如果没有历史包袱，你觉得AI的聊天记录应该用redis存好还是SQLite存好？"
>
> "为什么clowder 选择了完全用redis来做存储呢"
>
> "或者我们能不能做一个评测？"
>
> "能帮我完成这个评测吗"

- Source: operator conversation `thread_mrxfv8tub5r1uvww`; executable contract in `feature-specs/2026-07-28-chat-storage-evaluation.md`.
- Reviewer: please judge both benchmark correctness and whether the verdict actually answers the operator's architecture question.

## Tradeoff

- No production adapter or migration is included. This is an isolated evaluation harness and decision artifact.
- No external Redis client dependency was added; the local RESP2 implementation is intentionally narrow, which raises protocol/lifecycle review importance.
- Process termination is measured, not host power loss. The report refuses to generalize beyond that evidence.
- Synthetic repeated-character payloads are compressible. The report explicitly rejects extrapolating the measured Redis RDB/AOF disk ratio to real chat content.
- Redis automatic AOF rewrite is disabled during timing; an explicit post-timing `BGREWRITEAOF` produces a stable disk snapshot.

## Architecture Ownership

Architecture cell: none
Map delta: none
Why: the diff adds an isolated developer evaluation harness and does not change CAFF runtime storage ownership, APIs, or production data boundaries.

Reviewer checks:

- Confirm the backend classes are benchmark adapters only and do not create a runtime ownership cell.
- Confirm `Map delta: none` matches the absence of production Store/Queue/Router/Dispatcher/Binding changes.

## Open Questions

### Technical OQ

- Does the Redis manager provably avoid attaching to an existing instance and only terminate its owned PID across startup, graceful stop, crash, and restart paths?
- Are RESP2 incremental parsing and pipelined `MULTI`/`EXEC` reply handling correct for all commands the harness emits?
- Are SQLite transactions and Redis transactions equivalent enough for the stated throughput/latency comparison, especially the 100-message append batches?
- Is acknowledged-loss accounting sound for the SQLite IPC crash writer and Redis process termination?
- Are the explicit AOF rewrite and compression limitations sufficient to prevent misleading disk conclusions?

### Value OQ

None. The recommendation does not authorize a production migration or new dependency.

## Next Action

Perform formal cross-individual review and return `APPROVE` or `REQUEST-CHANGES` for HEAD `2718dd1`, with findings prioritized around data safety, child-process lifecycle, recovery evidence, benchmark equivalence, and overclaiming.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/chat-storage/opus`
- Start Command: `npm ci`
- Ports: `web=n/a`, `api=n/a` (no runtime server is required; do not use 3003/3004 or Redis 6399)
- Redis: set `REDIS_SERVER_PATH` if `redis-server` is not already on `PATH`; all live tests allocate a dynamic loopback port.

## Self-Check Evidence

### Spec Compliance

| AC | Evidence | Status |
|---|---|---|
| Equivalent operations | Shared contract tests for SQLite and live Redis | Pass |
| Deterministic synthetic workload | Seeded generator, bounded hot/ordinary thread profiles | Pass |
| Required metrics | Raw JSON includes percentiles, throughput, disk, scoped memory, restart, acknowledged loss | Pass |
| Balanced and strict profiles | WAL NORMAL/FULL and AOF everysec/always settings are applied and read back | Pass |
| Redis isolation | Fresh directory, loopback, dynamic safe port, owned PID | Pass |
| No runtime data | Temp directories and synthetic IDs/content only | Pass |
| Evidence and verdict | Versioned JSON plus CAFF-specific Markdown with repository evidence and limitations | Pass |
| Repository verification | Harness, check, typecheck, fast, and smoke commands exit 0 | Pass |

Architecture ownership warning scan: the repository has no ownership check script; manual diff inspection found no runtime ownership change. Hotfix/fallback scripts are also absent; this is not a hotfix, and the new lifecycle fallbacks were manually inspected.

### Dogfood-Your-Slice

Scope verdict: required because the deliverable is an executable harness.

End-to-end path: `npm run eval:chat-storage:standard` -> balanced SQLite/Redis -> strict Redis/SQLite -> raw JSON -> generated verdict.

Evidence: command exited 0 in 18.8 seconds; 2 durability runs and 4 completed backend results; every backend recovered 2,000/2,000 acknowledged messages with zero loss. No Redis child remained afterward; the only observed Redis process was the pre-existing Clowder `--port 6399` process.

### Verification

```text
node tests/eval/chat-storage-eval.test.js
  18 passed, 0 failed

result contract validation
  2 complete runs, 4 backends, zero acknowledged loss

npm run eval:chat-storage:quick
  exit 0

npm run eval:chat-storage:standard
  exit 0; generated JSON and Markdown

npm run check
  exit 0

npm run typecheck
  exit 0

npm run test:fast
  exit 0

npm run test:smoke
  59 passed, 0 failed
```

Artifact hygiene: no root-level media/design artifacts in worktree or committed diff. `Microsoft/` is an unrelated pre-existing untracked directory and is not part of this branch.

### Results Snapshot

| Durability | Backend | Append | Latest p95 | Disk snapshot | Recovery |
|---|---|---:|---:|---:|---:|
| balanced | SQLite | 35,448 msg/s | 0.11 ms | 132.27 MiB | 2,000/2,000 |
| balanced | Redis | 22,524 msg/s | 1.01 ms | 23.65 MiB | 2,000/2,000 |
| strict | SQLite | 16,079 msg/s | 0.20 ms | 132.27 MiB | 2,000/2,000 |
| strict | Redis | 15,441 msg/s | 1.03 ms | 23.65 MiB | 2,000/2,000 |

Disk ratios are not decision evidence because the synthetic payload compressibility materially favors Redis RDB encoding.

## Related Documents

- Plan: `feature-specs/2026-07-28-chat-storage-evaluation.md`
- Raw results: `docs/evaluations/chat-storage/2026-07-28-results.json`
- Verdict: `docs/evaluations/chat-storage/2026-07-28-verdict.md`
- Fresh-context pre-review: skipped because no independent fresh session was available before formal review; author self-check is not represented as fresh-context evidence.
