# Backend Architecture

## Primary Layers

- `server/app/`: composition root that wires stores, services, controllers, and
  runtime configuration
- `server/api/`: thin HTTP handlers that read request input and delegate to
  services or stores
- `server/http/`: shared transport helpers such as router, JSON responses, and
  request-body parsing
- `server/domain/`: feature logic for conversations, runtime, metrics,
  undercover, and werewolf

## Conventions

- Keep controllers thin. Parse input, call a domain helper, then return JSON.
- Put reusable business rules in `server/domain/`, not inline inside controller
  files.
- Keep transport concerns in `server/http/` rather than re-implementing them in
  each controller.
- When a backend change affects agent execution or prompt contents, review the
  matching runtime files instead of guessing from the API layer alone.

## Bootstrap And API Security Lifecycle

`createServerApp` owns the per-process CSRF token, planner credential provider,
central principal/mutation guards and attention wait service. Credential rotation
runs only after `server.listen` successfully binds, using the actual bound port
(including port 0). Secure-file creation/verification failure disables planner
authentication with a sanitized diagnostic; it does not disable the browser.
Tests inject an in-memory credential through application options, never an
environment-controlled production bypass. Filesystem/ACL tests use isolated
state only. Credential layout, protection and optional `.env.example` settings
are specified in [planner-interface.md](planner-interface.md#1-principals-and-credential).

`GET /api/bootstrap` uses `server/api/bootstrap-payload.ts` and publishes
`apiSecurity: { csrfToken }` for browser writes on every page. Existing
`localAdmin.modelProviders` and `localAdmin.systemServices` keep their enabled
flags and token aliases (empty when local admin is disabled); this does not
remove their additional local-only restrictions. The shared browser client
remembers the global token or loads bootstrap before its first mutation.
Bootstrap contains **no planner bearer credential**. Normal role/model/directory
and runtime projections remain compatible.

Every API request derives its principal before router dispatch. Native agent
callbacks and the exact Feishu webhook retain their own authentication. Ordinary
mutations then pass the central guard before reading bodies or producing side
effects; see [controller-patterns.md](controller-patterns.md). Planner-specific
attention/state controllers use bounded store capabilities and fail closed
rather than hydrating full conversation data.

Store transactions couple Goal/proposal/ruling changes to durable attention;
root terminal-task persistence uses the same transaction for turn failures.
Startup reconciles current conditions and newly interrupted roots, not a replay
of historical failures. After-commit notifications accelerate waits, with a
SQLite change revision covering other connections while waiting. They are not
an additional multi-instance execution lease: one process still exclusively
owns the runtime database. On close, finish waits with 503 and disable planner
authentication before runtime teardown; stop/reconcile tasks and close SQLite
last. See [turn lifecycle](../runtime/conversation-turn-queue.md#process-restart-and-shutdown-boundary).

Verification: `tests/http/api-hardening.test.js`,
`tests/ui/api-security.test.js`, `tests/runtime/planner-credential.test.js`,
`tests/runtime/planner-attention-wait.test.js`, and interrupted-run suites.
Real-browser writes use `tests/manual/browser-writes.test.js --run` with a
random-port instance, temporary SQLite, synthetic executor and in-memory test
credential; live Windows ACL checks use only the explicitly approved exclusive
planner-tests directory, never service credentials.

## Embedded Claude Code Planner (P2)

[Embedded planner contract](../runtime/embedded-planner.md) implements
[ADR 0003](../../decisions/0003-embedded-claude-code-planner.md) over the existing
[P1 principal/Goal/attention interface](planner-interface.md). This is the
**official external CLI**, not an Agent SDK session, Room agent or implementer
model slot. Native Goal Runner/DAG/delegation/delivery/Feishu behavior is unchanged.

- `embedded-planner-runtime.ts` owns the opt-in capability and lifecycle.
  `CAFF_PLANNER_TERMINAL=1` is effective only on a loopback bind; off means no
  CLI probe, terminal/wake routes or wake timers. Configuration changes and
  shared restarts require separate user authorization, never a browser override.
- After listening and P1 credential initialization, reconcile persisted leases,
  resolve/check the CLI once, then wire the shared host and wake-up runtime.
  Terminal minimum: 2.1.310. Wake policy: verified 2.1.x >=2.1.310, exact trusted
  prefix without whitespace, fixed dontAsk/four tools; incompatible versions
  fail closed for wakes without unnecessarily disabling a valid terminal.
  Bootstrap returns capability/version/reason only, never executable paths or
  planner bearer. CLI settings/login remain the user's, separate from Pi.
- `embedded-planner-host.ts` owns synchronous per-room/session and global
  four-process admission, including retained/stopping processes. Each room
  keeps a reserved UUID and launches in its own verified worktree (unbound:
  project root, read/plan-only prompt). First interactive launch uses session-id;
  subsequent launches and all wakes use resume. No agent session-reuse or
  historical input/output replay is introduced.
- `server/http/planner-terminal.ts` installs ws/noServer on the HTTP upgrade
  event. Host/mandatory same-origin Origin/loopback checks precede handshake;
  first-message CSRF plus limits precede process allocation or data. A second
  page is refused, not another writer. Detach retains the PTY 30 minutes;
  explicit Stop, retention expiry and shutdown tear down only its owned tree.
- PTY and print guardians supervise process trees and parent loss. The lease
  repository stores guardian PID; startup signal-zero checks release only a
  proven absent guardian, never kill old PIDs. Unknown/live ownership remains
  fenced. Browser-only confirmed lease repair and separate same-UUID session
  reinitialization do not spawn/kill and cannot bypass a live in-memory entry.
- `planner-wakeup-runtime.ts` subscribes to committed P1 attention, checks the
  current matching planner-bound Goal/opt-in, and suppresses attached **and
  retained** PTYs. `PlannerWakeupRepository` atomically reserves claims and
  rolling quota before spawn; 4/hour/room, 12 turns/10 minutes per attempt.
  Restart catch-up deduplicates; failures/needs_user are never replayed just
  because attention is still unresolved. Wakes consume real CLI configured
  usage; neither the quota nor turn bound is a monetary budget cap.
- `planner-wakeup-command-card.ts` renders actual-prefix commands and canonical
  escape examples into the 64-KiB-bounded stdin envelope. The child launches
  with argv arrays, new allowlisted env and explicit tools/dontAsk/MCP boundary.
  Runtime checks init's four tools and mode before storing event text. Initial
  provider keys/session env are stripped; proxies pass through with values
  redacted; user CLI settings may still choose another billed provider.
- `lib/caff.ts` / `planner-cli.ts` is a closed current-room P1 adapter. Credentials
  are read from file only; loopback HTTP bypasses proxies and never retries as
  user. Canonical encoding/schema/size checks precede credential reads or HTTP.
  P1 authenticates/attributes actual Goal writes and owner messages. Production
  finish validates attempt/membership/current state independently, not a generic
  REST proxy, P1 acknowledgement or P3 review verdict.
- `embedded-planner-controller.ts` serves protected process state, user-only
  opt-in/recovery and cursor-paged audit/finish. Three wake tables preserve
  attempts/items/chunks: sanitized event text <=1 MiB (first 64 KiB/latest
  960 KiB), body-only expiration after 30 days, persistent summaries/claims/quota.
  Event-detail responses <=128 KiB; no thinking/tool inputs/results/raw stderr or
  credentials. CLI's own transcript is outside this API's retention policy.

Shutdown closes WS upgrades/sockets and wake admission first, stops/awaits
hosted children, finalizes interrupted wake records, then closes SQLite with
other runtime teardown. A late unconfirmed exit leaves its persisted fence for
next startup instead of writing to closed storage. P1 authentication is disabled
during shutdown; no late child may fall back to browser authority.

Verification: `test:embedded-planner` includes host/lease/session/WS/UI/adapter/
print/scheduler/store/HTTP tests using temporary state, random ports and fake
CLIs only. Real Edge fake-CLI walkthroughs use `test:planner-terminal-ui` and
`test:planner-wakeup-ui`. Planner Windows/CLI 2.1.310 real acceptance and exact
argv are in P2 §10; Linux node-pty compilation/full CI remain an explicit
candidate-pinned post-authorization gate, not inferred from Windows success.

## Watch Points

- `server/app/create-server.ts` is the central wiring point. Changes there often
  affect multiple routes and runtime services.
- Active project handling flows through the project manager and then into the
  turn orchestrator. Treat project-path changes as cross-layer work.
- Game features and agent-tool features are backend-hosted workflows, so API
  changes often need runtime and test updates too.
