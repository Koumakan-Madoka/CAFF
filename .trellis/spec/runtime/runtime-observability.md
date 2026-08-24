# Runtime Observability

## Scenario: Lightweight Runtime Counters & Memory Sampling

### 1. Scope / Trigger
- Trigger: the develop OOM remediation plan P1 observability gap — the server had zero `process.memoryUsage` references and no exposed turn/queue/invocation/SSE-buffer counters, so a future memory incident could not distinguish "a bounded request peak" from "an ongoing leak".
- Applies when changes touch `server/domain/runtime/runtime-observability.ts`, `server/api/runtime-observability-controller.ts`, the `createServer` wiring of counter providers, `getRuntimeStats()` on `turn-orchestrator` / `agent-tool-bridge` / `sse-bus`, or `GET /api/runtime/stats` consumers.

### 2. Signatures
- `createRuntimeObservability(options)` — options: `sampleIntervalMs` (default 30 min; explicit ≤ 0 disables the sampler; garbage falls back to default), `maxHistoryEntries` (default 96), injectable `memoryUsage` / `now` / `log`.
  - `registerCounterProvider(name, provider)` / `unregisterCounterProvider(name)`: providers are called once per snapshot; a throwing provider is skipped fail-soft and never affects other providers.
  - `getSnapshot(): RuntimeObservabilitySnapshot` — `{ timestamp, memory: RuntimeMemorySample, counters: Record<string, any>, memoryHistory: RuntimeMemorySample[] }`; `memoryHistory` is a bounded ring (oldest evicted).
  - `start()` arms the periodic sampler; `dispose()` stops it and clears history/timers. The sampler timer is `unref`'d and must never keep the process alive.
- `RuntimeMemorySample` normalizes `process.memoryUsage()` fields (`heapUsed/heapTotal/rss/external/arrayBuffers` bytes; non-finite values coerce to 0).
- `createRuntimeObservabilityController({ getSnapshot })` — `GET /api/runtime/stats` returns the snapshot as JSON; a missing `getSnapshot` fails closed with `501 'Runtime observability is not configured'`.
- `createServer` wiring: registers providers `turns` (`turnOrchestrator.getRuntimeStats()`), `invocations` (`agentToolBridge.getRuntimeStats()`), `sse` (`sseBus.getStats()`); starts the sampler on `listen` and disposes on `close`; exposes `runtimeObservability` for acceptance gates.

### 3. Contracts
- **Correct lifecycle**: every counter must return to zero after cleanup — `turns` (`activeTurns`/`activeQueues`/`activeAgentSlots`) and `invocations` (`activeInvocations`) follow register/unregister ownership; `sse` counters come from the bus `getStats()` and hit zero when clients disconnect. The snapshot must not over-report: `turn-orchestrator.getRuntimeStats()` runs the existing queue settlement sweep (`buildConversationQueueSnapshot`) before reading `queueStates`, so fully-drained queues are not reported active; queues with pending failures stay visible by design (`clearConversationState` remains the authoritative cleanup).
- **Negligible overhead**: snapshot calls each provider exactly once; the sampler defaults to one `process.memoryUsage()` read per 30 minutes (unref'd); SSE counters reuse the bus's single `O(clients)` `getStats()` pass. No payload logging anywhere.
- Counters are diagnostic only: they must never gate request handling, and provider failures must not break `/api/runtime/stats` (fail-soft with the rest of the snapshot intact).

### 4. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| snapshot with registered providers | each provider called exactly once; counters merged under provider name |
| one provider throws | that provider skipped; snapshot still 200 with remaining counters |
| unregister provider / dispose | provider no longer called; timers/history cleared; no lingering handles |
| sampler interval ≤ 0 | sampler disabled; no periodic timer armed |
| `GET /api/runtime/stats` without wiring | 501 fail-closed |
| turn lifecycle (turn starts/ends) | `activeTurns` rises and returns to 0; drained queues leave `activeQueues` 0 |
| invocation register/unregister | `activeInvocations` 0 → n → 0 |
| server close | sampler disposed; no timer keeps the process alive |

### 5. Tests Required
- `tests/runtime/runtime-observability.test.js`: provider lifecycle, fail-soft, snapshot shape, bounded history ring, sampler start/stop/dispose, unref behavior, interval resolution.
- `tests/http/runtime-observability.test.js`: 501 fail-closed without `getSnapshot`.
- `tests/runtime/turn-orchestrator.test.js`: `getRuntimeStats` lifecycle including the queue-settlement sweep (stale drained queue not reported; failure backlog stays visible).
- `tests/runtime/agent-tool-bridge.test.js`: `getRuntimeStats` invocation counting lifecycle.
- `tests/smoke/server-smoke.test.js`: real server wiring — `GET /api/runtime/stats` returns 200 with `turns`/`invocations`/`sse` counters, and counters return to zero after workload.
- `scripts/p1-metrics-sse-gate.js` scenarios `concurrent-metrics-sse` and `goal-workload-stability`: counters return to zero after concurrent load and after 300 goal-continuation turns through the real orchestrator; post-GC retained heap stays bounded (≤ 32MiB).

### 6. Wrong vs Correct
#### Wrong
```ts
// Internal-only maps; no way to tell a bounded peak from a leak.
return { getRuntimeStats: undefined }; // activeTurns/queueStates stay private forever
```

#### Correct
```ts
// Expose cheap size probes; settle stale queue state before reading.
function getRuntimeStats() {
  buildConversationQueueSnapshot();
  return { activeTurns: activeTurns.size, activeQueues: queueStates.size, activeAgentSlots: activeAgentSlots.size };
}
```
