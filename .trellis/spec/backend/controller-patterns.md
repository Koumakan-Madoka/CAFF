# Controller Patterns

## Request Flow

- Read JSON payloads with `readRequestJson(...)` for POST-like endpoints.
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

## Trellis-Specific Notes

- `server/api/agent-tools-controller.ts` is the HTTP entry point for
  `trellis-init` and `trellis-write`.
- Changes that alter Trellis tool payloads must stay in sync with
  `lib/agent-chat-tools.ts`, runtime prompt instructions, and tests.
