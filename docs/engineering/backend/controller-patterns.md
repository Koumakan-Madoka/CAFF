# Controller Patterns

## Request Flow

- For `/api/*`, authenticate with `authenticateApiRequest`, then run the central
  `apiMutationGuard.assertMutation` **before routing/body parsing or side
  effects**. Use the server-derived principal, never a JSON/header claim alone.
- Read JSON payloads with `readRequestJson(...)` only after those guards for
  POST-like endpoints (image upload uses the guarded multipart path).
- Return payloads with `sendJson(...)`.
- Let the route handler return `true` only when it handled the request.
- Use `createHttpError(...)` for expected client-facing failures.

## Design Rules

- Validate and normalize request fields near the controller edge.
- Delegate non-trivial logic to domain modules or stores.
- Keep controller files readable by grouping route matching and small request
  adapters, not full workflows.
- Prefer explicit route strings over hidden indirection. The current codebase
  uses straightforward `pathname === ...` checks in several controllers.

## Authentication And Mutation Guards

The complete matrix and error/retry contract is in
[planner-interface.md](planner-interface.md#2-write-interface-hardening).

- Ordinary browser mutations (all methods except GET/HEAD/OPTIONS) require
  validated Host, same-origin Origin, `application/json` Content-Type and
  `X-CAFF-CSRF-Token`. Bodyless writes are not exempt. Only exact
  `POST /api/conversations/:id/images` accepts multipart with a valid boundary;
  it still requires Host/Origin/CSRF and the existing image validation.
- Valid bearer planner calls use a distinct principal. Bearer replaces only
  Origin/CSRF, not Host, Content-Type, domain authorization or existing
  local-admin bind/peer restrictions. Authorization or `X-CAFF-Principal: planner`
  indicates planner intent; `/api/planner/*` implies it. Missing, duplicate,
  malformed or invalid credentials return 401 with zero mutation/dispatch,
  never browser/user fallback.
- Host is checked against the actual listening authority, not forwarded
  headers or DNS lookups. Loopback binds allow literal localhost/127.0.0.1/::1
  aliases at the bound port, but Origin must match the validated request Host;
  a cross-alias pair is rejected. Non-loopback binds require the exact authority.
- `/api/agent-tools/*` uses invocationId/callbackToken and scope validation;
  exact POST `/api/integrations/feishu/webhook` uses native webhook validation.
  They are not user principals or unguarded alternatives. An explicit planner
  claim is rejected there; bearer never replaces native authentication.
- Preserve route-specific local-admin read/write restrictions and error aliases.
  Ordinary reads gain no general Host guard in P1; this is not read-side DNS
  rebinding protection. Do not add permissive CORS or expose the planner token.
- Generic Room PUT cannot alter server-owned `sessionGoal*`/DAG-binding
  metadata; Goal operations must use the Goal endpoint. REST ruling identity
  comes from authentication: `user` for the browser, `planner` with ID/name for
  valid planner requests. A planner never passes a `kind === 'user'` gate.
- Planner message/Goal/creation responses are lean acknowledgements; browser
  response compatibility is preserved. Goal GET uses header-only projections
  (no message bodies/previews). Missing bounded capabilities fail with 501,
  never full hydration.

Tests: `tests/http/api-{mutation-guard,hardening}.test.js`,
`planner-{authentication,principal,lean-retry,room-creation,attention,state}.test.js`,
and `goal-{high-risk-gate,planner-binding}.test.js` cover actual HTTP wiring,
zero-write denial, caller exemptions, projection and authority boundaries.

## Agent Tool Notes

- `server/api/agent-tools-controller.ts` is the fixed HTTP entry point for
  authenticated chat, retrieval, Goal, DAG, and memory tools.
- Conversation routes that hand work to the turn orchestrator should acknowledge
  accepted work quickly and let runtime/SSE state represent the long-running
  turn. Do not hold `POST /messages` open for the whole agent turn when the
  contract is “accept + schedule”. If the domain returns lane metadata such as
  `dispatchLane` or `dispatchTargetAgentId`, forward those fields as-is instead
  of re-inferring them in the controller. See `../runtime/conversation-turn-queue.md`.
- Delete-style recovery actions should keep the controller thin: read runtime
  queue/failure state, reject unsafe active or dispatching deletions at the edge,
  reject active side slots and queued side-slot work from the same controller
  guard, and only allow explicit `force` overrides for the narrow idle main-lane
  queued-failure recovery path documented in the runtime spec.
- Changes that alter Agent tool payloads must stay in sync with
  `lib/agent-chat-tools.ts`, runtime prompt instructions, and tests.
