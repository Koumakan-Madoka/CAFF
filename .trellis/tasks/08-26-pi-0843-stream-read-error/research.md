# Upgrade-Before Research

## Audited Baseline

- Room baseline: `origin/develop@abf00a112d5455316aef818513b38c2cc65e4137`.
- Current package: `@earendil-works/pi-coding-agent@0.80.10` (exact).
- Current runtime PI AI: nested `@earendil-works/pi-ai@0.80.10`.
- Current root direct PI AI: deprecated `@mariozechner/pi-ai@0.68.1`.
- Target package: npm release `@earendil-works/pi-coding-agent@0.84.3`,
  tarball integrity `sha512-Yr2p9PubrbFZm[...]IzVszO3/t0D0w==` as reported by
  `npm pack` on 2026-08-26.

## Sources Read

- PI 0.84.3 `CHANGELOG.md`, covering every release from 0.80.10 through
  0.84.3.
- PI 0.84.3 `README.md`.
- PI 0.84.3 `docs/sdk.md`, `docs/extensions.md`, `docs/session-format.md`,
  `docs/packages.md`, `docs/custom-provider.md`, `docs/models.md`,
  `docs/settings.md`, and `docs/json.md`.
- PI 0.84.3 SDK examples README, extension example, and session-runtime
  example.
- CAFF runtime, turn queue, message-detail, model-provider, and runtime-test
  specs plus cross-layer/reuse guides.

## Release Delta Relevant To CAFF

1. PI 0.81 adds complete provider extension registration, exported lifecycle
   event types, expanded tool/summary usage accounting, and OpenAI Responses
   early-stream retry fixes.
2. PI 0.82 expands provider retry classification and abort-aware retry waits.
3. PI 0.83 upgrades TypeBox aliases to 1.3.7 and removes deprecated TypeBox
   APIs. CAFF schemas use supported `Type.Object`, `Type.String`, and
   `Type.Literal` APIs.
4. PI 0.84 changes JSON/RPC `message_update` serialization to delta-only. CAFF
   subscribes directly to native `AgentSessionEvent` values in
   `lib/pi-sdk-host.mjs`, so it still receives `event.message` plus
   `assistantMessageEvent`; only JSON/RPC clients need delta reconstruction.
5. PI 0.84 adds provider/request/session fixes, including upstream request-buffer
   retry, missing `finish_reason` compatibility, improved usage reporting, and
   extension factory cleanup. The `AgentSessionRuntime`, `SessionManager`,
   `createAgentSessionServices`, `createAgentSessionFromServices`,
   `createAgentSessionRuntime`, `bindExtensions`, prompt images, and native
   lifecycle event shapes used by CAFF remain documented public SDK contracts.
6. PI 0.84.3 adds the optional PowerShell built-in. CAFF explicitly controls
   extension tools and does not change its tool allowlist as part of this
   upgrade.

## Retry And Extension Ordering

Both 0.80.10 and 0.84.3:

1. Agent core finalizes the assistant object.
2. `AgentSession._handleAgentEvent()` awaits extension `message_end` first.
3. A returned same-role replacement mutates the finalized assistant object in
   place, keeping agent state, later events, listeners, and session persistence
   aligned.
4. The post-run path calls `_isRetryableError()` on that rewritten message.
5. Native retry removes only the failed assistant from live agent context,
   preserves the session record, waits with configured exponential backoff, and
   continues the current Agent session.

This is the official and narrow boundary for PR B. PI's custom-provider docs use
this same `message_end` normalization pattern for provider-specific overflow
errors.

## Retry Classifier Gap

- PI 0.80.10 recognizes connection/network/5xx/rate-limit/timeout and several
  premature-stream phrases, but not `stream_read_error`.
- PI 0.84.3 adds `getaddrinfo`, `ENOTFOUND`, `EAI_AGAIN`, request-buffer, and
  `stream ended before a terminal response event` patterns, but still contains
  zero `stream_read_error` matches.
- Default native policy remains enabled, maximum three retries, base delay 2000
  ms, exponential delays 2/4/8 seconds.
- Quota/billing patterns remain explicitly non-retryable; aborted assistant
  messages are not retryable.

## Controlled Upgrade-Before Probe

A private real `Agent` + `AgentSession` fixture uses a deterministic custom
stream function and in-memory session/settings with the 0.80.10 package:

- exact `stream_read_error`: one provider call, zero `auto_retry_start`, zero
  `auto_retry_end`, final assistant error.
- `connection error: fixture disconnect` then success: two provider calls, one
  `auto_retry_start(attempt=1)`, one successful `auto_retry_end(attempt=1)`,
  final assistant success.

The fixture is outside the repository at
`PI_AGENT_PRIVATE_DIR/private/pi-0843-audit/baseline-retry-probe.mjs`; it does
not use credentials, network providers, production data, or CAFF outer retry.

## Direct Dependency And Type Identity Audit

Production source has two root `@mariozechner/pi-ai` consumers:

- `server/domain/conversation/conversation-digest.ts` imports `complete()` and
  model catalog helpers.
- `lib/pi-extensions/caff-capabilities.mjs` imports `Type` to build tool schemas
  handed to the 0.80.10 extension runtime.

Keeping 0.68.1 after the upgrade would retain a deprecated package family and
would hand schema objects from an old TypeBox/pi-ai graph into PI 0.84.3. PR A
should replace it with exact `@earendil-works/pi-ai@0.84.3`, migrate both import
specifiers, and verify `npm ls` resolves one 0.84.3 PI AI identity shared with
coding-agent. A direct exact dependency is justified because CAFF production
source imports it directly; relying on coding-agent's nested dependency would be
an undeclared and unstable module-resolution contract.

## Expected PR A Touch Points

- `package.json`, `package-lock.json`: coding-agent 0.84.3; replace deprecated
  direct PI AI with exact `@earendil-works/pi-ai@0.84.3`.
- `server/domain/conversation/conversation-digest.ts`: canonical PI AI default
  import specifier.
- `lib/pi-extensions/caff-capabilities.mjs`: canonical PI AI import or official
  direct TypeBox import if dependency-tree evidence requires it.
- `lib/pi-model-config-validator.mjs`: audited package versions.
- Runtime/catalog/UI tests whose purpose is to pin the audited version and
  capability snapshot.
- No `stream_read_error` mapping in PR A.

## Required Regression Surfaces

- SDK host creation/session selection/extension binding/image prompt/recovery.
- PI runtime message deltas, message end, assistant errors, usage aggregation,
  abort, watchdog recovery, and named-session persistence.
- Model config validation, model catalog capabilities, image transform parity,
  and provider configuration.
- Digest real/fake PI AI paths and JSON-mode payload behavior.
- Tool registration/execution, Goal/turn/DAG/private/image/handoff, message
  detail/model usage, server smoke, check, both typechecks, build, and dependency
  tree.
