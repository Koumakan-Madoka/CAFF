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

## Watch Points

- `server/app/create-server.ts` is the central wiring point. Changes there often
  affect multiple routes and runtime services.
- Active project handling flows through the project manager and then into the
  turn orchestrator. Treat project-path changes as cross-layer work.
- Game features and agent-tool features are backend-hosted workflows, so API
  changes often need runtime and test updates too.
