# Agent Room directory

`list_rooms` is a read-only Pi capability. The separate model-visible
`conversation_notify` / `conversation_request` capabilities perform delivery.
Discovery does not alter delivery authorization or require directory-derived addresses.
Use `search-memory` for topic recall; there is no title/content search parameter.

## Input and identity

Only `scope` and `limit` are accepted. `scope` defaults to `same_project` and may
explicitly be `all_projects`. `limit` defaults to 10 and must be an integer 1–30;
invalid values and unknown fields fail, rather than being coerced or clamped.

The existing invocation ID/callback token/liveness checks authenticate the call.
The current Room ID comes from that invocation, never model input. The store
re-reads its current project binding. Missing source Rooms fail; unbound source
Rooms must explicitly request `all_projects`.

CAFF's current local single-user read model has no per-user Room ACL. The global
scope lists this instance's Rooms (including unbound Rooms); it is not an ACL
bypass or a cross-project delivery grant. If read ACLs are introduced, directory
filtering must apply them before sorting/limiting, rather than filtering the
already limited response. Current same-project delivery restrictions stay intact.

## Projection and activity

The result is `{ rooms: [...] }`. Each entry has exactly:

- `id`, `title`, `projectScopeId` (null for unbound)
- `lastPublicMessageAt` (null when no qualifying public message exists)
- `agents`: current routable participants, each with only `id` and `name`

No message preview/body, Room metadata, model profile, credentials, project path,
or Agent private configuration is returned. Titles remain titles, including
existing automatically generated titles; this does not redact title text.

Results exclude the source Room and sort by latest qualifying message creation
time descending, then Room ID descending. Empty Rooms sort last, with null
activity; configuration/rename/receipt touches do not affect ordering. The query
excludes blank content, truthy `metadata.privateOnly`, case-insensitive trimmed
`metadata.visibility = private`, and unfinished assistant `Thinking...`
placeholders. Other visible streaming/failed public content counts as activity.
The tool reports current membership, not a promise that an Agent is running.

The dedicated storage query selects no bodies and does not reuse UI directory
headers or `last_message_at`. Its correlated latest-message lookup can use the
existing conversation/message-time index; no migration or activity-field semantic
change is made. Global ordering still evaluates activity for candidate Rooms.

## Verification

- `node tests/storage/room-directory.test.js`: scoping, unbound/missing sources,
  ordering, private/placeholder exclusion, strict inputs, limit and field whitelist.
- `node tests/runtime/pi-capability-bridge.test.js`: facade authentication,
  server-derived source, result projection, model schema registration alongside
  scoped delivery tools; existing workspace/MCP transport regressions.
- `node tests/storage/chat-store.test.js`: existing store/UI directory behavior.
