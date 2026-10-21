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
  role's default setting. The room menu does not probe the account and may still
  mark a stored unsupported profile as configured; the round's request evidence
  distinguishes unsupported/out-of-scope decisions. These markers do not claim
  actual backend execution. A custom role with an empty/inherited model has no
  toggle until a supported model is explicitly selected.
- `fast` never enters the session-reuse static fingerprint
  (`[provider, model, profileId, thinking]` in `agent-executor.ts`):
  toggling must not cold-start sessions, and shipping the feature must not
  change existing fingerprints.

## Observability

- The extension reports a closed `service_tier_request` IPC event for each
  `before_provider_request` invocation. `status` is `requested`, `disabled`,
  `out_of_scope`, `unsupported`, or `error`; `supportSource` is `catalog`,
  `allowlist`, `out_of_scope`, `account_changed`, or null. It never sends a
  credential, account ID, request body, catalog entry or exception text.
  Resolver/payload exceptions preserve pi's fail-open behavior (unchanged
  payload), but emit `error`, not a successful Fast request. A diagnostic
  callback failure must not undo an already prepared priority payload.
- Message metadata stores `fastMode` (schema version 1): `configured`,
  `requestCount`, `priorityRequestCount`, `skippedRequestCount`, `errorCount`,
  `supportSources`, `lastRequest`, and safe derived display text. The summary is
  persisted/broadcast as soon as a hook report arrives, and retained on success,
  provider rejection and cancellation. It is bounded independently of call count.
  Top-level `serviceTierRequested` is `priority` iff at least one payload was
  prepared with priority; otherwise null. `serviceTierObserved` is always null
  and `executionConfirmed` false in this SDK version.
- Counts mean **request-preparation hook invocations**, including in-session
  compaction, not network attempts or completed model calls. HTTP/WS retries
  reuse the post-hook body without re-firing the hook. Hook evidence does not
  prove the request was sent, accepted, or executed at priority; later extensions
  could also replace the payload. W3 wire-capture tests establish serialization
  behavior for CAFF's configured extension chain, not backend scheduling.
- Each assistant usage call and model-call timeline event carries its own
  normalized `serviceTier` decision. A new `turn_start` clears pending evidence,
  preventing a pre-provider failure from inheriting the previous call's Fast
  status. Duplicate `agent_end` messages preserve earlier evidence without
  counting twice. Old sessions/calls without evidence remain unknown, not off.
- Display points: message timeline badge, expanded model/tool trace per-call
  pills, Trace Inspector session summary and per-call detail, and Markdown
  trace export. Labels distinguish configured/not-yet-requested, requested/
  execution-unconfirmed, partial requests, disabled, unsupported, out-of-scope
  and injection errors. Source and counts are available in tooltips/details.
- No request-derived cost multiplier is applied: CAFF preserves pi-ai's cost
  estimate. A token-price ratio is not a reliable executed-tier side channel
  (zero/unknown/custom prices and provider-specific reporting can coincide).
  Both cost and executed-tier limitations are shown in the Fast evidence detail;
  this feature does not present dollar estimates as subscription quota consumed.
  Backend confirmation may only be added with a real, separately captured
  response-tier signal; configuration, successful injection, timing or an
  unverified price ratio must never set `executionConfirmed`.

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

## Observability verification (W5)

Hermetic regression suites (no real subscription calls):

- `fast-mode-observability`: source/status isolation, allowlist/catalog paths,
  fail-open resolver/payload errors, bounded summaries, closed secret-free
  projections, partial requests, per-call usage/live timeline preservation.
- `fast-mode-sdk`: real SDK SSE/WS hook reports alongside W3 wire captures;
  counts explicitly exclude transport retries. `pi-runtime`: fake-host IPC,
  per-call correlation, duplicate terminal events and pre-provider failures.
- `agent-executor-hook`: immediate streaming metadata/SSE, terminal metadata,
  failed replies and source projection. `trace-inspector`: isolated database
  storage, API/detail/export projection and legacy unknown evidence.
- `tests/ui/fast-mode-observability.test.js`: real browser production message,
  tool trace and inspector renderers; same-card updates, configured/requested/
  unconfirmed and all skip/error statuses. Set `CAFF_FAST_UI_EVIDENCE_DIR` for
  fixture screenshots. These do not replace W6 real-room screenshots.

These tests are in `npm test`. W5 improves evidence visibility only; AC5 remains
open until W6 and must not be inferred from passing hermetic tests.

## Real-room verification (W6, partial; execution proof blocked)

Tested the unchanged implementation at
`73f413f140aa9af0a4a6de418a2c284e2ddc4405` on 2026-10-21. This is a
**room preview**, not a merged `develop` acceptance candidate or user acceptance.
Port 3261 was checked immediately before binding. The preview had a fresh private
agent directory, SQLite database, project, uploads, sessions and logs. Only the
Codex subscription credential and two model definitions were copied; the source
credential/configuration/database was not modified. Feishu/Lark delivery and
system Scribe were disabled; SSE was selected and in-session compaction/retry
was disabled for the comparison. All experimental room/API traffic targeted
the preview, not the 3100 application.
The preview was stopped and its copied `auth.json` removed after verification;
3261 was checked unbound afterward.

The fixed user prompt asked for only `READY` without tools. Six fresh rooms
alternated off/on (three samples per arm), with `gpt-6.1-sol`, thinking `low`.
One on sample selected the Fast model profile while the global default remained
off. All six replies completed, each with one model request and HTTP 200:

| Arm | Room completion times (ms) | Median (ms) |
|---|---|---|
| off | 3704, 3720, 7744 | 3720 |
| priority | 4288, 4487, 6300 | 4487 |

These times include CAFF startup/dispatch, SDK process creation, support lookup
and terminal-message persistence (200 ms observation granularity). The cold,
very short-prompt preview was **not faster** with Fast (off/on median ratio
0.83); this does not establish or refute provider scheduling speed. There was
no cache-busting or randomization beyond alternating arms, and one enabled
sample used the timeout/allowlist fallback. Do not substitute W1's faster
microbenchmark for this result, or present either as guaranteed acceleration.

Additional real-room checks:

- The role editor saved default Fast off / profile Fast on through the actual
  HTTP API; reload retained both independent booleans. Real screenshots show
  the model, usage warning, default/profile controls and selected room profile.
- In the same server process and room, changing only Fast on → off → on used the
  identical session name and static segment hash; both later traces reported
  `sessionReuseReason: reused`. Wire observations changed from priority to no
  field and back on the next turn. W3's legacy-fingerprint regression remains
  the evidence for compatibility with pre-feature sessions (not a production
  upgrade experiment).
- A separate off/on observation pair in that reused room captured response
  events: both reported `response.created.service_tier: auto` and
  `response.completed.service_tier: default`, even though the on request carried
  priority. The initial six samples captured request bodies and HTTP status but
  not SSE events: the backend omitted Content-Type and the first observer
  incorrectly gated on it. The corrected observer parsed the two later streams
  without changing their bytes. No execution confirmation was obtained.
- `gpt-5.3-codex-spark` with Fast configured produced `unsupported`, zero
  priority preparations and a wire request without `service_tier`; the backend
  returned HTTP 400 because that model is unavailable to this ChatGPT account.
  The unsupported-configuration guard is verified, **not** the behavior of an
  account-available model whose catalog lacks priority. The latter remains
  unavailable for real testing on this subscription.
- Actual message badges, Trace Inspector summary and per-call detail show
  “Fast 已请求 · 执行未确认”, with the reused-session evidence. Failed/unsupported
  messages do not claim Fast execution. Ten successful requests plus the one
  unsupported request were made in total; no tool calls were requested.

Ignored local evidence is under `.tmp/fast-w6/`: `summary.json`, `wire.jsonl`,
`*-inspector.json`, `instance.log`, `run-live.cjs`, `observe-wire.mjs`,
`capture-real.cjs`, and screenshots `real-{room-fast,trace,room-profile,
default-config,profile-config}.png`. The wire observer stores only model/tier,
HTTP status, Content-Type, timestamps and token counts, never credentials,
authorization headers, request/response bodies or output text. Screenshot replay
uses the persisted preview database with no credential present and makes no model
requests. `typecheck.log` and `tests.log`
record passing `npm run typecheck` and full `npm test` (including build).

One pre-existing API limitation was encountered: changing a family role's model
while omitting its existing profile list revalidates internally normalized
`personaPrompt: ""` and rejects it with `family_persona_not_allowed`. It also
exists at the room's `develop` baseline `ab1afd9`. The real editor sends the
complete family-safe list and saves successfully; the unsupported-model probe
likewise supplied that list. This unrelated bug is recorded, not silently fixed
or counted as a Fast regression.

**Gate:** real-room evidence completes the remaining implementation evidence for
AC2–AC4. AC5 still lacks independent priority-execution proof; neither HTTP 200,
timing nor a requested-tier cost multiplier can close it. W6/AC6 are not done:
final milestone review, integration and user acceptance have not occurred. Stop
further quota-consuming probes until a reliable backend signal is available or
the user explicitly authorizes a reviewed change to the acceptance requirement.

## Current pi execution-signal audit (W6 follow-up)

The authority for CAFF behavior is the **actually loaded** pi-coding-agent
0.85.1 and its nested pi-ai 0.85.1, not the separately installed top-level
pi-ai 1.3.0 or Codex CLI. The following source paths are relative to
`node_modules/@earendil-works/pi-coding-agent/` and were read without modification:

- `dist/core/sdk.js`: connects `before_provider_request` to `onPayload` and
  `after_provider_response` to `onResponse`.
- `node_modules/@earendil-works/pi-ai/dist/api/simple-options.js`: forwards both
  callbacks, but not `serviceTier`, through `streamSimple`.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js`:
  `onPayload` changes the body before serialization; SSE `onResponse` supplies
  HTTP status and headers before stream consumption. That callback does not
  receive a response body. This version's WebSocket path does not invoke it.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js`:
  completion processing reads the raw response tier for pricing, but does not
  preserve that tier on the assistant message. `responseId` is preserved and
  can correlate responses, but is not itself a tier signal.

An isolated diagnostic through CAFF's real SDK factory, real Fast extension
and the installed provider made one completed off request and one completed on
request, with no tools, compaction, agent retries, application port or database.
Both used a fresh private agent directory and the same short prompt/model/
thinking. Source credentials/configuration stayed unchanged; the copied
credential was deleted afterward. The only extra extension observed the SDK's
response callback; a temporary fetch observer parsed the original SSE stream
without modifying its bytes. Stored header **values** are restricted to closed
known tier labels; cookie, routing-state, account, quota and balance values are
never recorded. There was initially one failed connection attempt before CAFF's
proxy dispatcher was installed; it had no HTTP response or usage and is retained
separately, not counted as a completed sample. No transport retries were enabled.

| Evidence | Off | On |
|---|---|---|
| Serialized request tier | absent | priority |
| HTTP / assistant outcome | 200 / stop | 200 / stop |
| Raw created / completed tier | auto / default | auto / default |
| Raw input / output tokens | 61 / 5 | 61 / 5 |
| Cached / reasoning tokens | 0 / 0 | 0 / 0 |
| Tier/speed/priority response-header candidates | none | none |
| pi usage cost / same-model baseline cost | 1 | 1 |
| Assistant message tier property | absent | absent |

This adds **one** directly observed on response to the earlier real-room off/on
response pair. The initial six room comparison samples did not capture SSE
response events; the earlier pair contains only one on response, not two.

`tests/runtime/fast-mode-pi-evidence.test.js` exercises the real SDK/CAFF factory
with synthetic SSE and WebSocket responses, no real credentials or network:

- Injection plus a `default` response keeps base pricing and exposes no message
  tier; disabling Fast omits the request field.
- A synthetic raw `priority` response doubles provider pricing but still has no
  persisted tier property. The synthetic result is not a live execution claim.
- The HTTP response hook exposes only status/headers, even without Content-Type;
  the current WebSocket adapter does not emit that hook.
- A separate native low-level `serviceTier: priority` control also doubles
  pricing when the raw response says `default`, due to
  `resolveCodexServiceTier`'s **request-derived fallback**. Therefore switching
  to that option or multiplying costs cannot manufacture independent execution
  proof. The production injection approach and cost handling are unchanged.

The seven regressions are part of `npm test`. Local diagnostic evidence and
scripts are in `.tmp/fast-w6-pi/`, including `live-summary.json`,
`live-network-failure.json`, `probe-live.mjs` and a hash manifest. The diagnostic
summary stores neither output text, full response bodies nor response-header
values outside the tier-label allowlist (ordinary SDK sessions remain private). Source and live evidence agree: pi confirms the
priority request and successful completion, but **this SDK/channel currently
supplies no independent priority-execution signal**. This is an observability
limit, not proof that Fast failed. AC5 remains pending under its current wording;
Codex CLI status or access to a separate billing interface is not a prerequisite
for operating CAFF Fast and is not used to redefine its behavior.

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
