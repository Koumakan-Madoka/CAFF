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
  `priority` request proves the tier value passed validation and the request
  was accepted; it does **not** by itself prove the backend actually
  scheduled the request on the priority tier (a legal value could still be
  downgraded or ignored server-side).
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
`openai-codex-responses.js` falls back to the *request* tier when the
response says `"default"`. That fallback is a reporting rule, not proof of
execution. Consequences:

- CAFF must never claim "executed as Fast" from the response body alone.
  Display the requested tier; only show backend confirmation when the response
  actually reports `priority` (not observed on this subscription so far).
- With payload injection (`onPayload`), pi-ai's `options.serviceTier` stays
  undefined, so its service-tier cost multiplier (priority ×2, gpt-5.5 ×2.5)
  does **not** fire. If the backend does execute these rounds as priority,
  subscription quota is presumably consumed at the Fast rate while CAFF's
  token-cost stats show the unmultiplied amount — i.e. CAFF cost accounting
  for Fast rounds may under-report. This is a known limitation, not a
  verified measurement of quota behavior.

## Speedup evidence (fixed prompt, reasoning effort `low`, cache disabled)

`gpt-6.1-sol`, 5 runs per arm, 2026-10-21:

| Arm | median total | median TTFB |
|---|---|---|
| `priority` | 7 265 ms | 1 247 ms |
| default | 14 460 ms | 6 053 ms |

≈2.0× total / ≈4.9× TTFB on this small-prompt benchmark, in the direction
of the vendor's "1.5x" claim. This timing separation is side evidence
consistent with priority execution, not proof: the sample is small and the
executed tier is not independently confirmed by the response (see above).
Formal per-instance timing acceptance runs in the delivery work item (W6),
which is also where execution-tier evidence for AC5 must come from.

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

Runtime rule: within the `openai-codex` provider / `openai-codex-responses`
API scope, a model supports Fast iff the (cached) backend catalog lists it
with a `priority` service tier; if the catalog cannot be fetched, fall back to
the static allowlist seeded from the 0.160.0 probe: `gpt-6.1-sol`,
`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`. Catalog results are per-account: cache entries must be keyed
by credential/account and discarded on account switch, never reused across
accounts. A *successful* catalog fetch that lacks the model (or lists it
without `priority`) is authoritative-negative for that account — the static
allowlist must not override it; the allowlist only covers the fetch-failed
path. Unsupported models do not show the toggle and never get the
injection. If the backend still rejects `priority` at request time, the round
fails with the provider error — no silent downgrade.

The credential-blind `/api/agents` model-option projection uses the same
provider/API filter and static allowlist, exposed as `supportsFast`. It does
not probe accounts: a catalog-only/new model may be supported at request time
but have no editor toggle until the allowlist is updated. Conversely, a
projected toggle is not proof that the active account's live catalog supports
the tier; a live negative still wins. The editor and room selector describe
Fast as configured and subject to request-time support checks, not executed.

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

Filter: inject only when `ctx.model.api === "openai-codex-responses"` **and**
`ctx.model.provider === "openai-codex"`. Relay
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
- The toggle reaches the SDK host per round as the explicit boolean
  `start.config.fast`: `agent-executor.ts` resolves it from `runtimeConfig`
  (or selected profile/default), and `pi-runtime.ts` forwards it through IPC.
  Both IPC boundaries require `=== true`; no ambient environment variable
  can enable it. The SDK host forks per round, so a toggle change applies
  to the next round with no service restart.
- `lib/pi-extensions/caff-fast-mode.mjs` supplies a named inline extension
  factory in `pi-sdk-host.mjs`'s resource-loader options. Each factory captures
  the round's setting, avoiding process-global cross-runtime state. The build
  copies this module unchanged alongside the existing stream-read extension.
- Support resolution runs only for enabled, in-scope requests. It obtains the
  active credential via `ctx.modelRegistry.getApiKeyAndHeaders(model)`, then
  probes the official catalog with a 1.5-second fetch/body deadline and no
  redirects. It does not send credentials to custom endpoints. The memory-only
  cache lasts five minutes for a valid catalog and 30 seconds for failure;
  it belongs to one runtime (one CAFF round), not a cross-round disk cache.
  Credential/account/base-URL changes clear it; generation checks discard
  in-flight results from the previous identity. Tokens/account IDs never
  enter logs or trace. No directory probe occurs when Fast is off. Since hosts
  fork each round, enabled rounds can incur up to 1.5 seconds of first-request
  catalog latency; cached results only avoid repeated probes within that round.
- Model-profile writes replace the whole profile list: omitted `fast` is
  normalized to false rather than preserving the prior profile value. Editors
  must always send an explicit boolean (the shared payload builder does).
- The role editor displays independent Fast toggles next to thinking for the
  default runtime and each profile, for both family and custom roles. New
  roles/profiles default off; the hint says approximately 1.5x speed and faster
  subscription usage. Explicitly changing to an unsupported model clears that
  draft's toggle, so switching back does not silently re-enable paid usage.
  Existing stored `fast: true` on unsupported models remains harmless: no
  visible toggle or injection. Room profile descriptions mark configured Fast
  even when a custom description is present; default-profile markers use the
  role's default setting. These markers do not claim actual backend execution.
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

## Runtime verification (W3)

Hermetic tests (no real subscription or network I/O):

- `tests/runtime/fast-mode-runtime.test.js`: explicit opt-in, API/provider
  isolation, payload immutability, static-list parity, catalog positive and
  authoritative negative results, fetch/malformed/timeout fallback, cache TTL,
  credential/account switch and stale in-flight result isolation.
- `tests/runtime/fast-mode-sdk.test.js`: actual SDK host and pi-ai serializers
  with fake OAuth, intercepted fetch and fake WebSocket; captures compressed
  SSE bodies, HTTP retries, post-tool model requests, reused WebSocket delta
  frames, WebSocket connection-limit retries and automatic SSE fallback.
  Covers on/off, catalog-negative and non-subscription providers; a separate
  non-Codex API case uses that API's SSE transport. Tier rejection remains a
  provider error; pi-ai may retry it, but never without `priority`.
- `tests/runtime/pi-sdk-host.test.js` and `pi-runtime.test.js`: per-runtime
  factory registration and explicit-boolean start-command/IPC forwarding.
- `tests/runtime/session-reuse-ab.test.js`: changing Fast false/true/false
  preserves session identity/hash and reports `reused`; the legacy fingerprint
  input array stays exactly `[provider, model, reuseProfileId, thinking]`.
  The formerly orphaned suite's model-catalog fixture now includes the
  preflight resolution/thinking evidence and the suite is in `npm test`.

These tests prove request semantics, **not** backend execution as priority;
real-subscription and screenshot acceptance remains W6.

## Editor verification (W4)

- `tests/ui/fast-mode-ui.test.js` runs the production editor, room selector and
  styles in a real headless browser with synthetic data and blocked network:
  independent family/custom default/profile values, explicit boolean payloads,
  reopening saved values, legacy/new defaults, unsupported model switches,
  provider/API filtering, mouse/keyboard access, mobile toggle geometry and
  room-specific selection markers (including custom descriptions).
- The suite is part of `npm test`. Set `CAFF_FAST_UI_EVIDENCE_DIR` to an ignored
  output directory to capture desktop/mobile editor and room-selector images.
  These are **fixture screenshots**, not real-room/API-persistence or W6 E2E
  evidence. Storage/API and runtime resolution have separate W2/W3 tests.
- `configured-model-catalog` and `fast-mode-config` regressions lock the same
  subscription provider/API gate in server projections.

## Known limitations

- Backend under-reports the executed tier (`default` even for accepted
  `priority` requests), and the executed tier is **not independently
  confirmed** by W1: request acceptance (200 vs 400 on bogus values) plus a
  small-sample timing gap are consistent with priority execution but do not
  prove it. AC5's execution evidence remains open until W6.
- In the current injection path pi-ai's priority cost multiplier does not
  fire (it only applies when the response reports `priority`, which this
  backend does not do via payload injection). If rounds actually execute as
  priority, CAFF token-cost estimates for them may be low relative to real
  quota consumption; quota behavior itself is not measured by CAFF.
- Unsupported-model behavior (reject vs silent) is unverifiable on this
  subscription because every account-available catalog model offers
  `priority`; catalog/allowlist gating is the guardrail.
- System Scribe (digest/title/recovery) is out of scope; no Fast there.
  In-session context compaction uses the same session provider hook and therefore
  inherits priority when enabled; account for that usage/latency in W6 comparisons.
