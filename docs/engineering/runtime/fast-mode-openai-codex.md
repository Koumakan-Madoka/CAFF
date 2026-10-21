# Fast Mode (service_tier: priority) for openai-codex Subscription Models

Engineering contract for the per-role Fast toggle on GPT-family roles that run
through the `openai-codex` subscription provider (ChatGPT account login). Fast
adds `service_tier: "priority"` to every model request, matching Codex CLI's
`/fast`. The vendor catalog describes it as "1.5x speed, increased usage".

Research basis: live probes against the ChatGPT Codex backend on 2026-10-21
with the production subscription credential (probe scripts and redacted raw
JSON are kept in the Kimi agent sandbox, not in the repo), plus source review
of `@earendil-works/pi-ai@0.85.1` (embedded in `pi-coding-agent@0.85.1`) and
`pi-coding-agent@1.3.0` / `pi-ai@1.3.0`.

## Wire format

- Request: standard Codex Responses body plus `service_tier: "priority"`.
- Off: the field is omitted entirely (never send `"default"`); existing
  requests stay byte-identical.
- The backend validates tier values: an unknown value is rejected with
  HTTP 400 `{"detail":"Unsupported service_tier: <value>"}`. A 200 on a
  `priority` request therefore means the tier value was accepted, not ignored.
- Model availability is account-gated, not originator-gated: models the
  subscription does not offer fail with HTTP 400 `The '<model>' model is not
  supported when using Codex with a ChatGPT account.` regardless of the
  `originator` header (`pi` vs `codex_cli_rs`).

## Backend response reporting is unreliable (measured)

For `gpt-6.1-sol` and `gpt-6-astra` on this subscription:

- `response.created` reports `service_tier: "auto"` on every request.
- `response.completed` reports `service_tier: "default"` on every request,
  **including accepted `priority` requests**.

This matches pi-ai's own workaround: `resolveCodexServiceTier()` in
`openai-codex-responses.js` trusts the *request* tier when the response says
`"default"`. Consequences:

- CAFF must never claim "executed as Fast" from the response body alone.
  Display the requested tier; only show backend confirmation when the response
  actually reports `priority` (not observed on this subscription so far).
- With payload injection (`onPayload`), pi-ai's `options.serviceTier` stays
  undefined, so its service-tier cost multiplier (priority ×2, gpt-5.5 ×2.5)
  does **not** fire and CAFF cost stats under-report real quota consumption.
  Cost accounting for Fast rounds is a known limitation; the subscription
  quota is consumed at the Fast rate regardless of what CAFF's token costs
  show.

## Speedup evidence (fixed prompt, reasoning effort `low`, cache disabled)

`gpt-6.1-sol`, 5 runs per arm, 2026-10-21:

| Arm | median total | median TTFB |
|---|---|---|
| `priority` | 7 265 ms | 1 247 ms |
| default | 14 460 ms | 6 053 ms |

≈2.0× total / ≈4.9× TTFB on this small-prompt benchmark, consistent with the
vendor's "1.5x" claim (direction and magnitude). Formal per-instance timing
acceptance runs in the delivery work item, not here.

## Support detection

`GET https://chatgpt.com/backend-api/codex/models?client_version=<ver>` with
the subscription bearer token + `chatgpt-account-id` header returns the model
catalog including `service_tiers` per model. Verified:

- `client_version` is required (HTTP 400 `Field required` when missing).
- Catalog content depends on `client_version`: `0.144.6`/`0.150.0` list only
  gpt-5.6-era models; `0.160.0` lists `gpt-6.1-sol` and `gpt-6-astra`, both
  with `service_tiers: [{id: "priority", name: "Fast", description: "1.5x
  speed, increased usage"}]`.
- Every catalog entry observed on this subscription offers `priority`; no
  account-available model without Fast exists to probe the
  unsupported-model path (Codex CLI itself gates client-side via this
  catalog). The `bogus-tier` 400 shows the tier *value* is validated, but
  whether the backend rejects `priority` on a catalog model lacking the tier
  is unverifiable here — treat catalog/allowlist gating as the guardrail.

Runtime rule: a model supports Fast iff the (cached) backend catalog lists it
with a `priority` service tier; if the catalog cannot be fetched, fall back to
the static allowlist seeded from the 0.160.0 probe: `gpt-6.1-sol`,
`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`. Unsupported models do not show the toggle and never get the
injection. If the backend still rejects `priority` at request time, the round
fails with the provider error — no silent downgrade.

## Injection point

CAFF-owned pi extension registered like `lib/pi-extensions/caff-stream-read-retry.mjs`,
hooking `before_provider_request` (pi SDK `onPayload`). pi-ai calls it after
building the body and before both transports:

- SSE: `POST {baseUrl}/codex/responses`, body is JSON (optionally
  zstd-compressed after the hook runs).
- WebSocket: `wss://…/codex/responses`, first frame `{type:"response.create", ...body}`;
  incremental requests on a reused connection reuse the full body with delta
  `input`, so the hook covers them; retries within one `stream()` call reuse
  the same post-hook body.

Filter: inject only when `ctx.model.api === "openai-codex-responses"`. Relay
stations on `openai-responses` / `openai-completions`, other families
(GLM/Kimi/DeepSeek/Claude), and official API-key channels are never touched,
even if the toggle is on.

Why not a native option: `streamSimple` → `buildBaseOptions` does not
whitelist `serviceTier`, and the codex adapter does not merge
`samplingParams`; neither pi-coding-agent 0.85.1 nor 1.3.0 has a native
switch. `node_modules` stays untouched.

## Configuration

- `fast` boolean alongside `thinking`, on both the role default runtime
  config and each `modelProfiles` entry; default off; migration keeps
  existing roles/profiles off.
- Full chain mirrors `sessionReuseEnabled`: migration column →
  `agent.repository.ts` column lists → `chat-app-store.ts` normalize/save
  whitelists → `role-service.ts` family-editable fields → role editor UI.
- Room-scoped usage rides the existing room-level model-profile selection
  (`chat_conversation_agents.model_profile_id`); no new room/message-level
  override.
- The toggle reaches the SDK host per round (start-command config whitelist
  or env, precedent: `caff-capabilities`); the SDK host forks per round, so a
  toggle change applies to the next round with no service restart.
- `fast` never enters the session-reuse static fingerprint
  (`[provider, model, profileId, thinking]` in `agent-executor.ts`):
  toggling must not cold-start sessions, and shipping the feature must not
  change existing fingerprints.

## Observability

- Message metadata records the requested tier for the round
  (`serviceTierRequested: "priority" | null`).
- Backend-executed tier (or the pi-ai cost-multiplier side channel) is shown
  only when actually observed; otherwise the UI shows "requested Fast"
  without claiming execution.
- Display points: `createModelCallObservabilityEvent` (assistant_message
  handling in `agent-executor.ts`), `message-trace-inspector.ts`
  sessionProjection, `message-timeline.js` next to the token badge.

## Known limitations

- Backend under-reports the executed tier (`default` even for accepted
  `priority` requests); execution evidence is timing + the fact that invalid
  tier values are rejected, not a response field.
- CAFF token-cost stats under-report Fast rounds (pi-ai multiplier only fires
  when the response reports `priority`, which this backend does not do via
  payload injection). Subscription quota is still consumed at the Fast rate.
- Unsupported-model behavior (reject vs silent) is unverifiable on this
  subscription because every account-available catalog model offers
  `priority`; catalog/allowlist gating is the guardrail.
- System Scribe (digest/title/recovery) is out of scope; no Fast there.
