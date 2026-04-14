# Feishu Integration

## Scenario: Inbound Feishu Event Transports

### 1. Scope / Trigger
- Trigger: changing `server/domain/integrations/feishu/`, `server/api/feishu-controller.ts`, Feishu env keys, or tests that route external IM events into conversations.
- Goal: keep webhook and long-connection events on one parsing, deduplication, conversation-binding, and outbound-reply path.

### 2. Signatures
- Webhook entry: `POST /api/integrations/feishu/webhook` delegates to `feishuService.handleWebhook(body)`.
- Long connection entry: `createFeishuLongConnectionSource({ feishuService }).start()` creates an official `@larksuiteoapi/node-sdk` `WSClient` and registers `im.message.receive_v1` on `EventDispatcher`.
- Shared inbound entry: `feishuService.handleLongConnectionEvent(payload)` and `feishuService.handleWebhook(payload)` both call the shared inbound handler.
- Outbound entry: `feishuService.deliverAssistantMessage(message)` sends completed assistant text to the bound Feishu `chat_id` with a `【Agent名】` prefix.

### 3. Contracts
- Required env for long connection: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_CONNECTION_MODE=long-connection`.
- Optional env: `FEISHU_LONG_CONNECTION_LOGGER_LEVEL` accepts `fatal`, `error`, `warn`, `info`, `debug`, or `trace` and maps to SDK `LoggerLevel` when present.
- Webhook token validation uses `FEISHU_VERIFICATION_TOKEN`; long connection events do not require webhook token verification because SDK authentication happens during websocket connection.
- SDK event handler receives a flat event object with top-level `event_id`, `event_type`, `sender`, and `message`; normalize it to `{ header, event }` before handing it to the shared service path.
- Mention data may arrive in either parsed `message.content.mentions` or SDK-level `message.mentions`; merge both into metadata while leaving inbound text for CAFF's own group-routing logic.
- Inbound text events bind one Feishu `chat_id` to one CAFF conversation; the Feishu layer must not split conversations by `@agent` or require an `@bot` mention.
- New Feishu chats and `/new` command-created chats resolve the configured Coding mode (prefer a user-created `Coding` mode with Trellis skill bindings over the legacy empty `coding` row, otherwise fall back to `standard`); `/new` switches the existing `chat_id` binding to a newly created conversation and must not submit `/new` as a CAFF user message.

### 4. Validation & Error Matrix
- Missing long-connection app credentials: `start()` returns `false` and logs a warning; no process or network client is started.
- Missing SDK `WSClient` / `EventDispatcher`: `start()` returns `false` and logs a warning.
- Server bootstrap: Feishu bot identity warm-up and websocket start are best-effort side effects; `server.listen(...)` must not wait for `feishuIntegration.initialize()` or `feishuLongConnection.start()` to settle.
- SDK start lifecycle: log a start attempt before `WSClient.start(...)` resolves, log readiness only after the promise resolves, and clear active client references on rejection so a later `start()` can retry.
- Encrypted long-connection payload: return an ignored result from the Feishu service; encryption support remains out of scope for MVP.
- Unsupported or ignored message event: return success-shaped ignored payload to avoid Feishu retries when the event reached the service.
- Bot self messages are ignored by sender type or bot `open_id` to prevent outbound echo loops.
- Inbound failure after `reserveExternalEvent(...)`: update the reserved record with `metadata.status = 'failed'` and keep it persisted; do not delete it because Feishu retries would duplicate user messages or turns.
- Outbound assistant delivery is idempotent by local assistant message id; duplicate delivery attempts should not call Feishu again.

### 5. Good/Base/Bad Cases
- Good: long connection enabled with valid app credentials starts SDK `WSClient`, receives `im.message.receive_v1`, normalizes the event, and writes one CAFF user message into the bound `chat_id` conversation.
- Base: webhook mode remains default and starts no SDK websocket client.
- Bad: relying on `lark-cli event +subscribe` or a child-process bridge for production long connection; CAFF should use the official SDK in-process.

### 6. Tests Required
- Runtime: assert `createFeishuLongConnectionSource` constructs SDK `WSClient`, registers `im.message.receive_v1`, normalizes flat SDK events, forwards them to `handleLongConnectionEvent`, and closes the client on stop.
- Runtime: assert long-connection events are processed without webhook token verification.
- Runtime: assert long-connection start logs distinguish attempt vs ready states and `stop()` permits a later `start()` retry/reuse.
- HTTP: keep challenge/token, dedup, group text without bot mention, non-text ignore, `/new` rebinding, downstream-failure dedupe retention, and bot self-message webhook coverage green because both transports share parsing logic.
- Runtime: assert outbound delivery prefixes assistant replies with the resolved Agent display name and keeps duplicate delivery idempotent.

### 7. Wrong vs Correct

#### Wrong
```typescript
spawn('lark-cli', ['event', '+subscribe']);
```

#### Correct
```typescript
const wsClient = new lark.WSClient({ appId, appSecret, domain: lark.Domain.Feishu });
const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': (data) => handleLongConnectionEvent(normalize(data)),
});
await wsClient.start({ eventDispatcher });
```
