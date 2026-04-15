# Health Endpoint

## Scenario: CAFF Readiness Health API

### 1. Scope / Trigger

- Trigger: adding or changing CAFF-owned readiness/status endpoints under `server/api/` and `server/app/`.
- Goal: distinguish server availability, effective LLM provider readiness, and optional integration status without external calls.
- Non-goal: do not call provider APIs, OpenSandbox lifecycle APIs, Feishu APIs, or perform heavy database probes.

### 2. Signatures

- HTTP: `GET /api/health` returns `200` JSON.
- Controller: `createHealthController({ getHealthStatus }): RouteHandler<ApiContext>`.
- App status source: `createServerApp(...).getHealthStatus()` returns a fresh health payload per request.

### 3. Contracts

```ts
interface HealthResponse {
  ok: boolean; // v1: true when core.ready && provider.ready
  core: {
    ready: boolean;
    host: string;
    port: number;
    databasePath: string;
  };
  provider: {
    ready: boolean;
    provider: string;
    model: string;
    apiKeyConfigured: boolean;
  };
  optional: {
    feishu: { configured: boolean };
    openSandbox: { available: boolean };
  };
  timestamp: string;
}
```

- `provider.provider` and `provider.model` must come from the same effective runtime source as bootstrap/runtime payloads, not a parallel env parser.
- `provider.apiKeyConfigured` must only check non-empty local env state for the effective provider's expected API key env var; never expose the env var value.
- Unknown providers use `PI_API_KEY` as the generic health fallback.
- `optional.feishu.configured` is true only when `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are both non-empty after trimming.
- `optional.openSandbox.available` reflects whether the configured OpenSandbox factory resolved in `create-server.ts`.

### 4. Validation & Error Matrix

| Case | Expected |
|---|---|
| `GET /api/health` | `200` with `HealthResponse` |
| Unsupported method on `/api/health` | Router falls through to standard API `404` |
| Provider API key missing | `200`, `ok=false`, `provider.ready=false`, `provider.apiKeyConfigured=false` |
| Optional integration missing | `200`, optional flag is `false`; core/provider fields still returned |
| OpenSandbox or Feishu remote unavailable | No remote probe; report only configured/factory state |

### 5. Good/Base/Bad Cases

- Good: default `kimi-coding` / `k2p5` plus `KIMI_API_KEY` returns `provider.ready=true`.
- Base: server running without provider key returns `core.ready=true`, `provider.ready=false`, and `ok=false`.
- Bad: duplicating provider/model resolution in the controller can drift from agent runtime behavior.

### 6. Tests Required

- `tests/smoke/server-smoke.test.js` must fetch `/api/health` from a spawned server and assert the response shape.
- Assert `core.host`, `core.port`, and `core.databasePath` match the spawned server configuration.
- Assert effective `provider.provider`, `provider.model`, and `provider.apiKeyConfigured` for a deterministic test env.
- Run `npm run typecheck` and `npm run test:smoke` after endpoint changes.

### 7. Wrong vs Correct

#### Wrong

```ts
// Health controller grows an independent provider parser.
const provider = process.env.PI_PROVIDER || 'kimi-coding';
const model = process.env.PI_MODEL || 'k2p5';
```

#### Correct

```ts
// App composition root builds health from the same runtime payload used by bootstrap.
const runtimePayload = turnOrchestrator.buildRuntimePayload();
const provider = runtimePayload.defaultProvider;
const model = runtimePayload.defaultModel;
```
