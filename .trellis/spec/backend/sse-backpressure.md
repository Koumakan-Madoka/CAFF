# SSE Backpressure (Bounded Per-Client Budget)

## Scenario: SSE Bus Per-Client Byte Budget & Drain Deadline (OOM Safety)

### 1. Scope / Trigger
- Trigger: the develop OOM remediation plan P1B — `sse-bus.ts` `writeEvent` performed 6 `res.write()` calls while ignoring `write() === false`; a slow or half-open client (suspended laptop, stalled network) accumulated unbounded socket-queue data inside the Node process. With single frames up to ~323KB (message `metadata_json`), multiple stalled tabs could pile up tens/hundreds of MB of live, unreachable-by-GC-until-flushed memory — matching the near-zero Mark-Compact recovery shape of the production crash.
- Applies when changes touch `server/http/sse-bus.ts`, any caller of `broadcast`/`writeEvent`/`openStream`, or SSE diagnostics consumers (`getStats`, `/api/runtime/stats` SSE counters).

### 2. Signatures
- `createSseBus(options)` — options: `keepAliveMs` (default 15000), `now`, `drainDeadlineMs` (default 5000), `maxBufferBytes` (default 2 MiB). All injectable for tests.
- `openStream(req, res, { conversationId?, initialEvents? })` — writes prelude (`: connected`), arms keepalive ping interval, sends initial events; all writes share the same accounting.
- `broadcast(eventName, payload)` — serializes the frame once per event and reuses it for every matching client (one `write` per client, identical frame bytes as the baseline's per-client writes); clients with a `conversationId` only receive payloads whose `payload.conversationId` matches (or payloads without one).
- `writeEvent(res, eventName, payload)` — legacy path for streams registered with the bus; unregistered streams fall back to a direct write.
- `getStats(): SseBusStats` — `{ activeClients, backpressuredClients, queuedFrameBytes, writableBytes, disconnects: { byteBudget, drainTimeout } }`.
- `closeAll()` — ends every client and clears all timers/queues/listeners.

### 3. Contracts
- **Combined per-client budget**: before every direct write or enqueue, `queuedBytes + res.writableLength + frameBytes` must be ≤ `maxBufferBytes` (default 2 MiB). A single frame larger than the budget removes the client **before that frame is written**, even when buffers are otherwise empty. Budget exceed removes the client (`disconnects.byteBudget++`) and force-destroys the stream.
- **Forced physical teardown on backpressure removal**: byte-budget, drain-deadline, oversize-frame, and write-error removals call `endClientStream(client, { force: true })` — `end()` followed by `destroy()`. `end()` alone leaves the accepted writable buffer alive on a stalled socket until the OS flushes it (possibly never), so the removal must physically destroy the socket to release its buffered bytes immediately; the bus must never deregister a client from stats while its socket still holds a live write queue. Normal client-initiated close and `closeAll` keep the polite `end()` path.
- **Backpressure handling**: `res.write(frame) === false` marks the client blocked and arms a `drainDeadlineMs` (default 5s) timer. The frame that returned `false` was already accepted by Node and is never re-enqueued. While blocked, subsequent frames are appended to a per-client FIFO (accounted in `queuedBytes`).
- **Deadline re-arm**: each new blocked episode gets a fresh deadline; drain/close/error/removal clears the timer. Deadline expiry removes the client (`disconnects.drainTimeout++`) and force-destroys the stream.
- **Drain flush**: on `drain`, flush the FIFO in order until empty or another `false`; FIFO order is preserved and no frame is duplicated. If flushing would exceed the budget, remove for `byte_budget`.
- **Unified accounting**: prelude, initial events, normal events, and keepalive pings all pass through the same budget/blocked/FIFO path — no exempt write sites.
- **Cleanup**: removal (budget/timeout/close/error) clears keepAliveTimer, drainTimer, drain/close/error listeners, and the queue; 100 connect/close cycles must leave zero clients, queues, listeners, and timers.
- **No payload logging**: diagnostics are counters only (`getStats`), never frame payloads.
- Timers are `unref`'d so the bus never keeps the process alive.

### 4. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| healthy client, 6 × 256KiB burst | all frames delivered in order; connection stays open; queued bytes return to zero |
| client never reads (10,000+ × 256KiB) | removed at the 2 MiB budget; peak RSS delta stays tiny; zero writes after removal; **server-side socket physically destroyed in bounded time** (not merely ended) |
| single frame > 2 MiB | client removed before the frame is written; frame bytes never written; stream force-destroyed |
| `write() === false` on healthy-but-slow client | blocked + FIFO + ≤5s deadline; drains and stays connected |
| drain flush hits `false` again | new blocked episode with re-armed deadline; no re-enqueue, no reorder |
| res emits `error` or `close` / req `close` | client removed; all timers/listeners/queue cleared |
| 100 connect/close cycles | zero active clients/queues/listeners/timers; no handle leak |
| provider read (`getStats`) | exact counters incl. disconnect reasons; lifecycle returns to zero after cleanup |

### 5. Tests Required
- `tests/http/sse-bus-backpressure.test.js`: fake `ServerResponse` modeling Node semantics (accepted frames increment `writableLength`; `write()` returns false past a modeled high-water mark; simulated flush decrements `writableLength` before emitting `drain`) — non-tautological by construction. Locks: direct-write-while-blocked forbidden, budget removal **with physical `destroy()`**, oversize pre-write rejection **with physical `destroy()`**, deadline removal **with physical `destroy()`**, per-episode re-arm, keepalive/initial accounting, `getStats` surface, and the baseline conversationId filter lock.
- Real-socket end-to-end verification (prelude → initial → broadcast ordering, stats lifecycle, clean teardown) performed against the real `ServerResponse` `writableLength`/`drain` path.
- `scripts/p1-metrics-sse-gate.js` scenarios: `sse-healthy-burst` (6×256KiB in-order, stays connected), `sse-blocked-client` (10,100×256KiB to a never-reading client: removed at budget, RSS delta ≤ 64MiB, zero writes after removal, **server-side socket physically destroyed** — the authoritative check is the server-side socket state, since a paused client may keep unread bytes in its own kernel receive buffer), `sse-oversize-frame` (2.5MiB frame pre-write rejection), `sse-connect-cycles` (100 cycles → zero residue). Non-tautological proof: reverting `writeFrame` to ignore backpressure makes `sse-blocked-client` fail with ~2.6GiB RSS delta (the exact production OOM mechanism) while `sse-healthy-burst` still passes.
- The gate child process must clear Feishu credentials from its environment before `createServerApp` (isolation requirement; the app otherwise connects the production WS).

### 6. Wrong vs Correct
#### Wrong
```ts
// Ignoring backpressure: data piles up in Node's write queue without bound.
res.write(`id: ${id}\n`);
res.write(`event: ${eventName}\n`);
res.write(`data: ${body}\n\n`); // return value never checked
```

#### Correct
```ts
// Budget check before every write/enqueue; false → blocked + FIFO + deadline.
const bytes = Buffer.byteLength(text);
if (bytes > maxBufferBytes || client.queuedBytes + client.res.writableLength + bytes > maxBufferBytes) {
  removeClient(client.id, 'byte_budget');
  endClientStream(client, { force: true }); // end() + destroy(): release the stalled socket's buffered bytes
  return;
}
if (client.blocked) { client.queue.push({ text, bytes }); client.queuedBytes += bytes; return; }
if (client.res.write(text) === false) { client.blocked = true; armDrainDeadline(client); }
```
