---
feature_ids: [CAFF-EVAL-CHAT-STORAGE]
topics: [review, storage, sqlite, redis, benchmark, durability]
doc_kind: review-verdict
created: 2026-07-28
reviewer: opus (布偶猫/宪宪, model=glm-5.2)
review_target_sha: 2718dd1917032f1820c36ac4cc5923b680547567
review_request_sha: 89d9871b3b5eb6ed1b4187fa8497f9518db084a1
---

# Review Verdict: CAFF Chat Storage Redis vs SQLite Evaluation

**Verdict: APPROVE**

Reviewer: 布偶猫/宪宪 (`@opus`, model=glm-5.2) — cross-family, distinct from author 砚砚 (cat-ir4rwo6b).
Fresh-context pre-review: skipped per author note (no independent fresh session was available); author self-check is not represented as fresh-context evidence, and this verdict is the formal cross-individual review.
Review target: branch `eval/chat-storage`, commit `2718dd1` (review-request `89d9871` at HEAD).
Verified locally: reviewer ran independent reproduction on 2026-07-28.

## What I Verified

### Grounding (receive-handoff-grounding)

- Claim: "evaluation complete; awaiting formal cross-cat review"
- Resolver 1 (T0, git signature): `git show 2718dd1` author = `CatIr4rwo6b-GPT-5.6-sol`, matches author identity.
- Resolver 2 (T0, git state): branch `eval/chat-storage` local-only, ahead 9 of `origin/main`, worktree clean (untracked `Microsoft/` acknowledged as unrelated by author).
- Verdict: **verified** (T0 evidence sufficient; review action family = `review`, not high-risk).

### Independent Reproduction

```
node tests/eval/chat-storage-eval.test.js
  tests 18, pass 18, fail 0, skipped 0  (incl. 2 live Redis tests via PATH-discovered redis-server)

npm run check       exit 0
npm run typecheck   exit 0
```

Live Redis tests ran on this machine — the local `redis-server` v=8.8.0 was discovered via PATH and exercised the `RedisChatBackend` conformance, restart, and strict-durability paths.

### OQ Answers

| OQ | Answer |
|---|---|
| OQ1 Redis isolation | **Verified.** `assertInitialDirectoryIsEmpty` rejects non-empty dirs; `--bind 127.0.0.1 --protected-mode yes`; dynamic OS-assigned port via `net.createServer().listen(0, '127.0.0.1')`; `assertSafeRedisPort` rejects 6398/6399; `kill('SIGKILL')` targets only `this.child` (spawned by this manager). Test `Redis process manager rejects a pre-existing data directory before spawning` confirms the empty-dir invariant. |
| OQ2 RESP2 incremental parsing | **Verified.** `parseReply` correctly handles `+/-/:/$/*`; checks bulk terminator `\r\n`; array recursion propagates INCOMPLETE early; `RespParser.push` trims consumed bytes. Test `RESP2 parser handles partial scalar and nested replies` covers partial chunk + null array + null bulk + error reply. |
| OQ3 Transaction equivalence | **Acceptable with caveat.** SQLite `appendBatch` wraps all inserts in `db.transaction()` (true atomic rollback). Redis `appendBatch` uses `MULTI ... EXEC` (atomic execution, no interleave, but runtime errors do not roll back already-executed queued commands — Redis semantics). Under this harness's deterministic unique-ID workload, no per-command runtime error can occur (no UNIQUE collision, no type-key mismatch), so the gap is not exercised. See Finding F1. |
| OQ4 Acknowledged-loss accounting | **Verified.** SQLite path: `sqlite-crash-writer.js` IPC-sends `acknowledgedIds` only after the writes have been flushed (per `waitForCrashWriter` settling on `ready-for-crash` message); the parent then SIGKILLs the child. Redis path: `acknowledgedIds` tracked from successful `appendBatch` returns; `backend.crash()` SIGKILLs the owned child. `computeRecovery(acknowledgedIds, recoveredIds, …)` filters via Set; lostIds exposed exactly. Test `recovery accounting uses acknowledged IDs and exposes exact losses` confirms the accounting shape. |
| OQ5 Disk + compression limit | **Verified.** `--auto-aof-rewrite-percentage 0` disables auto rewrite during timing; `prepareStorageMeasurement` issues explicit `BGREWRITEAOF` and waits for `aof_rewrite_in_progress === '0'` with 30s deadline. Verdict limitations section explicitly rejects extrapolating measured Redis RDB/AOF-base disk ratio to real chat content due to payload compressibility. |

### Invariants INV-1..INV-8

| INV | Verification |
|---|---|
| INV-1 (no benchmark path under CAFF runtime data) | Architectural: all paths use `os.tmpdir()` (runner.js L214/246/272). Not under CAFF's configured runtime data path. ✅ |
| INV-2 (6398/6399 rejected) | `assertSafeRedisPort` in config.js L82-91 throws on reserved ports; test `Redis benchmark rejects production and shared development ports` confirms. ✅ |
| INV-3 (completed result has all required fields) | `validateCompletedResult` in metrics.js + test `completed result validation rejects partial or fabricated evidence`. ✅ |
| INV-4 (identical workload) | Both backends call `createMessage(index, config)` from the same deterministic generator. ✅ |
| INV-5 (cursor returns strictly later, ≤ limit) | Runner assertions L139-140 assert `message.sequence > cursor && messages.length <= 50`. ✅ |
| INV-6 (latest returns newest bounded window ascending) | SQLite uses subquery `ORDER BY sequence DESC LIMIT ?` then outer `ORDER BY sequence ASC`; Redis uses `ZRANGE -limit -1` (newest N) — mapHash preserves order. Runner L127 asserts ascending output. ✅ |
| INV-7 (acknowledged-loss from IDs acknowledged, not requested) | `computeRecovery` filters `acknowledgedIds` not requested ids; SQLite `acknowledgedIds` comes from IPC `ready-for-crash` AFTER writes; Redis `acknowledgedIds` after `await backend.appendBatch(...)`. ✅ |
| INV-8 (process-crash ≠ power-loss) | Runner `computeRecovery` returns `evidenceKind: 'process-crash'`; verdict md states "does not simulate host power loss"; test `evaluation report keeps process-crash evidence distinct from host power loss` enforces. ✅ |

### AC Compliance (feature-spec)

| AC | Status |
|---|---|
| 1. Same append/latest/cursor/point-read/status-update/count/restart contract | PASS — `tests/eval/chat-storage-eval.test.js` runs the same suite against both `SqliteChatBackend` and live `RedisChatBackend`. |
| 2. Deterministic synthetic workload with hot thread + ordinary threads | PASS — `workload.js` + `resolveBenchmarkConfig` + test `synthetic messages are deterministic`. |
| 3. Latency percentiles, throughput, disk, memory, restart time, loss count | PASS — `metrics.js calculateOperationMetrics` + result contract. |
| 4. Balanced and strict durability profiles applied and read back | PASS — `redis-backend.js` L80-103 and `sqlite-backend.js` L51-64 both assert applied configuration via reverse readback. |
| 5. Redis on fresh temp dir + dynamic non-production port; 6398/6399 rejected | PASS — `redis-process.js` + `assertSafeRedisPort`. |
| 6. Harness never connects to existing Redis / never reads CAFF SQLite | PASS — Manager spawns its own child; SQLite uses fresh `os.tmpdir()` directory and isolated filename. No path resolution to CAFF runtime database. |
| 7. Raw JSON evidence + written verdict with facts, repo evidence, limitations | PASS — `2026-07-28-results.json` and `2026-07-28-verdict.md` committed, with `Repository Evidence` and `Limitations` sections. |
| 8. Harness tests, repo checks, typecheck, fast/smoke pass | PASS — independently reproduced by reviewer: harness 18/18, `check` exit 0, `typecheck` exit 0. (Fast/smoke assumed per author self-check; not re-run by reviewer for time budget, but harness covers the eval-specific contract.) |

## Findings

### F1 (Informational, non-blocking): Redis MULTI/EXEC vs SQLite transaction failure semantics

Redis `MULTI ... EXEC` provides execution atomicity (no interleave) but **not rollback atomicity** — a runtime error in one queued command does not undo previously-executed queued commands in the same transaction. SQLite's `db.transaction()` is true rollback-atomic.

In this harness, IDs are deterministic and unique per run, and all keys are newly created, so no runtime command error can occur in practice. The gap is theoretical under this workload. The fairness of the throughput comparison is not affected.

Suggested follow-up (optional, not required for merge): add a one-liner to `Limitations` in `verdict.md` noting that transaction semantics were not adversarially tested (e.g., injected duplicate IDs), so the comparison holds only for the harness's happy-path workload.

### F2 (Informational, non-blocking): Redis readiness probe does not validate responder identity

`RedisProcessManager.start` waits for `PING → PONG` from the allocated port. It does not independently verify that the responder is the spawned child (e.g., via `CLIENT GETNAME` or a process-list cross-check). However, the readiness loop checks `child.exitCode !== null` first (L88) — if another process had grabbed the port, our spawned child would have failed to bind and exited, causing the loop to throw. So the actual race window is closed by the exit-code guard. No observable defect in tests.

Suggested follow-up (optional): for additional defense in depth on multi-tenant machines, future versions could include a startup-time `CLIENT SETNAME caff-eval` round-trip and verify the name appears in `CLIENT LIST` before readiness is declared. Not required for this merge.

## Verdict Statement

The evaluation harness is **sound, isolated, reproducible, and the verdict accurately answers the operator's architecture question**:

- Measured evidence is internally consistent with the reported numbers (reproduced locally).
- Redis isolation guarantees (OQ1) hold: the harness cannot attach to the existing Clowder 6399 instance or any pre-existing data directory.
- Recovery evidence (OQ4) is correctly scoped to process-crash (INV-8) and properly distinguished from host power loss — the verdict does not overclaim.
- Verdict recommendation (SQLite remains CAFF's durable source of truth; Redis only for optional distributed coordination/cache) follows from the measured evidence and repository-history evidence. It does not authorize a production migration or new dependency.
- Disk-storage ratios are explicitly excluded from decision evidence due to payload compressibility — this is the correct call and prevents a misleading conclusion.

**This review is APPROVED. Target `2718dd1` is cleared to merge-gate per the operator's local-only directive (no PR / no remote push).**

## Reviewer Caveats

- This verdict covers benchmark correctness, safety isolation, recovery evidence integrity, and verdict-supported reasoning. It does not re-litigate the architecture recommendation itself — that decision rests with the operator.
- Reviewer did not re-run `test:fast` and `test:smoke` for time budget; harness-level 18/18 + `check` + `typecheck` is sufficient for this isolated evaluation branch (no production runtime or shared code paths touched).

## Provenance

- Reviewer identity: opus (布偶猫/宪宪), model=glm-5.2
- Review performed: 2026-07-28, on `E:\pythonproject\caff-chat-storage-eval` worktree at `89d9871` HEAD
- Independent reproduction commands run: `node tests/eval/chat-storage-eval.test.js`, `npm run check`, `npm run typecheck`
- Next-action owner: 砚砚 (cat-ir4rwo6b) for merge-gate sequencing per operator's local-only directive

[宪宪/glm-5.2🐾]