# CAFF readiness/health view (P1)

## Goal
Implement a lightweight, CAFF-owned readiness/health endpoint so newcomers and operators can clearly distinguish `core-ready`, `provider-ready`, and optional integration status without relying on external tools or guesswork.

## Context
P0 (`a691567`) already restructured README, layered `.env.example`, and added startup status logging. The remaining gap is a programmatic, always-available health check that separates "the server is up" from "the LLM provider is usable" and from "optional integrations are merely configured vs actually available."

## Requirements
- Provide a single HTTP endpoint `/api/health` (or equivalent) that returns a structured readiness report.
- Reuse existing bootstrap/runtime config resolution; do not invent a second config parser.
- Keep the response lightweight and deterministic; no heavy side effects or external calls.
- Do not break existing routes or startup behavior.

## Response Contract (v1)
```ts
interface HealthResponse {
  ok: boolean;                 // true when core and provider are ready
  core: {
    ready: boolean;
    host: string;
    port: number;
    databasePath: string;
  };
  provider: {
    ready: boolean;            // true when a provider is configured and its API key appears present
    provider: string;
    model: string;
    apiKeyConfigured: boolean; // true when the matching env var is non-empty
  };
  optional: {
    feishu: {
      configured: boolean;     // true when FEISHU_APP_ID and FEISHU_APP_SECRET are non-empty
    };
    openSandbox: {
      available: boolean;      // true when the OpenSandbox factory resolved successfully
    };
  };
  timestamp: string;           // ISO 8601
}
```

## Implementation Notes
- `core.ready` can be `true` as soon as the server is serving requests.
- `provider.provider` and `provider.model` should reflect the **effective** values (after env + default fallback), matching what the agent runtime actually uses.
- `provider.apiKeyConfigured` should map the effective provider to its expected API key env var:
  - `kimi-coding` → `KIMI_API_KEY`
  - `openai` → `OPENAI_API_KEY`
  - `anthropic` → `ANTHROPIC_API_KEY`
  - `gemini` → `GEMINI_API_KEY`
  - `aliyun` → `ALIYUN_API_KEY`
  - `deepseek` → `DEEPSEEK_API_KEY`
  - `qwen` → `QWEN_API_KEY`
  - `pi-coding` → `PI_API_KEY`
  - fallback → check `PI_API_KEY` as a generic fallback
- `optional.openSandbox.available` should read the same factory resolution state already used in startup logging (`skillTestOpenSandboxFactory` in `create-server.ts`).
- `optional.feishu.configured` should read the same env checks already used in startup logging.

## Deliverables
- [x] `server/api/health-controller.ts` (or equivalent) implementing the endpoint
- [x] Route wired in `server/http/router.ts` (or existing router mechanism)
- [x] README Quick Start Step 2 updated to mention `curl http://127.0.0.1:3100/api/health`
- [x] `npm run typecheck` passes
- [x] Simple smoke request against running dev server returns expected shape

## Non-Goals
- Adding a UI page for health (keep it API-only for now)
- Deep liveness probes that actually call the LLM (only check env/key presence)
- Refactoring dependency structure or making packages optional

## Suggested Implementation Slice
1. Read existing bootstrap/runtime config paths to understand how `defaultProvider` / `defaultModel` are resolved.
2. Add `/api/health` route that assembles the status object from existing sources.
3. Update README verification step.
4. Run `typecheck` + manual smoke test.

## Related
- Parent task: `04-15-caff-deployability-newcomer-friendliness`
- P0 commit: `a691567`
