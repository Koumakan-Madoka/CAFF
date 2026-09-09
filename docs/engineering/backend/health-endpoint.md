---
feature_ids: [CAFF-ORPHAN-PR-RECONCILIATION]
topics: [backend, health-check, readiness, security]
doc_kind: spec
created: 2026-08-04
---

# Health Endpoint

## Scenario: Local CAFF Readiness

### Scope

`GET /api/health` distinguishes the running HTTP/SQLite core from locally resolvable default chat roles and optional Feishu configuration. The request is a local projection only: it does not call model providers, Feishu, or any other remote service.

### Response

```ts
interface HealthResponse {
  ok: boolean;
  core: {
    ready: true;
    host: string;
    port: number;
  };
  chat: {
    ready: boolean;
    defaultRoleCount: number;
    availableDefaultRoleCount: number;
    roles: Array<{
      id: string;
      name: string;
      ready: boolean;
      availability: string;
      provider?: string;
      model?: string;
    }>;
    issue?: { code: 'role_directory_unavailable' };
  };
  optional: {
    feishu: {
      configured: boolean;
      connectionMode: string;
      longConnectionSdkAvailable: boolean;
    };
  };
  timestamp: string;
}
```

`ok` is true when the core is serving and at least one default chat role resolves through `RoleService.resolveRuntimeParticipants`. It is not a claim that provider credentials or remote endpoints are reachable.

### Contracts

- The controller handles only `GET /api/health`; other methods and paths fall through to the standard API 404 response.
- Responses use `Cache-Control: no-store` and are rebuilt per request.
- Core port uses `server.address()` after listen, so ephemeral port `0` reports the actual bound port.
- Chat readiness consumes `RoleService.getDirectory()` and `RoleService.resolveRuntimeParticipants()`; it must not maintain a second provider/model parser or provider-to-env-key table.
- A role-directory failure returns `chat.ready=false` and `issue.code=role_directory_unavailable` while core status remains available.
- Feishu `configured` means both app id and app secret are locally non-empty. SDK availability uses module resolution only; it does not load a client or contact Feishu.
- The payload never contains API-key values/references, commands, custom headers, database paths, agent-directory paths, or raw exception messages.

### Validation Matrix

| Case | Expected |
|---|---|
| Core serving, one resolvable default role | `200`, `ok=true`, role provider/model projected |
| Core serving, no default roles | `200`, `core.ready=true`, `chat.ready=false`, `ok=false` |
| One default role blocked, another resolvable | `chat.ready=true`, counts and per-role availability remain explicit |
| Model/role directory fails | `200`, stable `role_directory_unavailable`, no raw error text |
| Feishu SDK omitted | Core/webhook unaffected; `longConnectionSdkAvailable=false` |
| `POST /api/health` | Standard API `404` |

### Required Tests

- Runtime projection tests for multiple defaults, failed role resolution, and catalog failure.
- Controller tests for fresh no-store GET payloads and route fallthrough.
- Spawned-server smoke coverage for actual host/port and redaction.
- Packaging guard proving the Feishu SDK is optional and OpenSandbox remains absent.
