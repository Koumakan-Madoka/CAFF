# Agent Runtime

## pi-mono Flow In This Repo

- `lib/minimal-pi.ts` resolves provider/model/thinking and launches the runtime
- `lib/pi-runtime.ts` owns long-running execution details and sandbox env setup
- `server/domain/conversation/turn/agent-executor.ts` prepares each agent run
- `server/domain/conversation/turn/agent-prompt.ts` builds the prompt and
  includes Trellis guidance
- `server/domain/conversation/turn/trellis-context.ts` loads `.trellis/` task,
  PRD, JSONL, workflow, and spec index context
- `server/domain/runtime/agent-tool-bridge.ts` handles `trellis-init`,
  `trellis-write`, chat bridge calls, and conversation memory tools

## Runtime Rules

- Treat active project resolution as security-sensitive. Trellis file reads and
  writes must remain scoped to the selected project.
- Keep prompt instructions and tool behavior aligned. If you change
  `trellis-init` or `trellis-write`, check prompt text, docs, tests, and API
  handlers together.
- Prefer bounded reads for prompt context. This code intentionally clips file
  content and limits context fan-out.
- Preserve symlink and path traversal guards when touching `.trellis` file IO.
- Preserve supported SQLite `file:` URI semantics when opening runtime stores:
  on-disk URIs keep `mode=ro` / `mode=rw` intent through explicit open options,
  parent directory creation uses the decoded underlying filesystem path, and
  unsupported URI query parameters fail fast instead of being silently ignored.
- Skill-test isolated runs now default to `host-loop + sandbox-tools`: if you change runtime `cwd`, extension injection, or tool routing for skill-test runs, keep `server/api/skill-test-controller.ts`, `lib/pi-runtime.ts`, `lib/pi-skill-test-sandbox-extension.mjs`, `server/domain/runtime/agent-tool-bridge.ts`, and `server/domain/skill-test/isolation.ts` aligned.
- Sandbox-visible path semantics for host-loop skill-test runs flow through `CAFF_SKILL_TEST_VISIBLE_*` envs. Prefer those visible paths for tool `cwd`, trace redaction, and agent-facing path echoes instead of mutating the host process working directory.

## Mirrored Update Paths

- Trellis tool API:
  `lib/agent-chat-tools.ts` <-> `server/api/agent-tools-controller.ts` <->
  `server/domain/runtime/agent-tool-bridge.ts`
- Conversation memory tool API:
  `lib/chat-app-store.ts` (`searchConversationMessages`,
  `listVisibleMemoryCards`, `saveLocalUserMemoryCard`,
  `listConversationMemoryCards`, `saveConversationMemoryCard`) <->
  `server/domain/runtime/agent-tool-bridge.ts` <->
  `server/api/agent-tools-controller.ts` <-> `lib/agent-chat-tools.ts` <->
  `server/domain/conversation/turn/agent-prompt.ts`
- Skill dynamic loading (descriptor path + `read`):
  `lib/skill-registry.ts` (`skill.path`) <->
  `server/domain/conversation/turn/agent-prompt.ts` (descriptor `Path` + `read` guidance) <->
  `server/api/skill-test-controller.ts` (dynamic trigger detection via `read` path)
- Prompt guidance:
  `server/domain/conversation/turn/agent-prompt.ts` <->
  `server/domain/conversation/turn/trellis-context.ts`
- Project selection and skill loading:
  `lib/project-manager.ts` <-> `server/app/create-server.ts` <->
  `server/domain/conversation/turn/agent-prompt.ts` (`getSkillLoadingMode`, `formatSkillDocuments`, `formatSkillDescriptors`)

## Skill Dynamic Loading

CAFF uses a descriptor + on-demand loading model for conversation skills:

- **`getSkillLoadingMode()`** reads `CAFF_SKILL_LOADING_MODE` env var each turn.
  Default is `dynamic`. Set to `full` to restore legacy all-at-once injection.
- **Persona skills** always inject full body (`forceFull: true`).
- **Conversation skills** inject descriptors only in `dynamic` mode;
  agent uses the generic `read` tool on the descriptor `Path` to load `SKILL.md` on demand.
- **Body truncation:** `MAX_SKILL_BODY_LENGTH = 32768` characters;
  oversized bodies are clipped with `...[truncated]` suffix.
- **Dynamic loading flow:** prompt descriptor exposes a `Path` pointing at `SKILL.md`,
  and the agent calls the generic `read` tool with that path when it needs the full skill body.
- **Prompt instructions** for dynamic loading only appear when mode is `dynamic`;
  in `full` mode they are omitted to reduce noise.

## Conversation Memory Contract

- `search-messages` is retrieval-only and must stay scoped to the current
  conversation's public messages. Runtime derives the conversation from the
  active invocation; agents do not choose a wider scope.
- `search-messages` may optionally accept bounded speaker filters such as
  `speaker` or `agentId`, but those filters only narrow the active
  conversation-public scope and never widen it.
- Message recall stays bounded: query text is validated and clipped, speaker
  filters are length-limited, result limit is capped, and the response includes
  `searchMode`, `scope`, `resultCount`, bounded `results[]`, and
  `diagnostics[]`.
- If FTS5 is unavailable, a MATCH query fails, or FTS5 returns no results for a
  tokenizer gap such as CJK text, diagnostics must say so before the
  implementation falls back to the bounded LIKE path. Do not silently widen the
  scan beyond the active conversation.
- `save-memory` writes durable cards for the current `local-user + agent`
  scope; scope still comes from bridge invocation context, not from
  agent-provided ids.
- `update-memory` only mutates an existing durable card in the current
  `local-user + agent` scope; it requires `title`, full replacement `content`,
  a non-empty `reason`, and may use `expectedUpdatedAt` for optimistic
  concurrency.
- `forget-memory` only tombstones an existing durable card in the current
  `local-user + agent` scope; it requires `title`, a non-empty `reason`, and
  may use `expectedUpdatedAt` for optimistic concurrency. Tombstoned cards stay
  out of visible-memory lists and prompt injection, but remain auditable in
  storage.
- `list-memories` returns bounded visible cards for the current agent by
  layering current `conversation + agent` overlay cards ahead of the same
  `local-user + agent` durable cards.
- Memory title matching stays exact after trimming (case-sensitive) across
  storage, visible layering, `update-memory`, and `forget-memory` so
  case-distinct titles remain separately addressable.
- Prompt assembly may inject only bounded active visible memory cards using the
  same overlay order. Episodic recall results are not auto-injected; the prompt
  only teaches the agent when to call `search-messages`, `list-memories`,
  `save-memory`, `update-memory`, and `forget-memory`.
- Memory cards are intentionally small and durable: active-card budget is 6 per
  scope, default TTL is 30 days, max TTL is 90 days, and expired or non-active
  cards stay out of the prompt.
- `save-memory` and `update-memory` must reject obvious secrets, tokens,
  passwords, private keys, and transient TODO / next-step / temporary status
  content.
- `update-memory` and `forget-memory` must stay durable-only: they do not mutate
  current-conversation overlay cards, they must reject missing targets, and they
  should surface optimistic-concurrency conflicts instead of silently
  overwriting a newer correction.
- Tool traces should keep diagnostics such as scope, query preview, result
  count, memory title, reason tag, and rejection reason without echoing full
  memory bodies or secret-like payloads.

## Tool Trace Event Contract

- Assistant tool visibility currently has two live sources:
  `server/domain/runtime/agent-tool-bridge.ts` for bridge tool calls and
  `server/domain/conversation/turn/agent-executor.ts` for pi session tool
  events.
- Both sources must emit `conversation_tool_event` payloads keyed by
  `conversationId`, `turnId`, `taskId`, `agentId`, `agentName`,
  `assistantMessageId` / `messageId`, `phase`, and a `step` object.
- `step.stepId` must remain stable across `started` / `updated` / terminal
  events for the same logical tool call so the browser can merge live updates
  without duplicating rows or losing scroll anchors.
- `turn_progress` summaries mirror the live tool headline through
  `currentToolName`, `currentToolKind`, `currentToolStepId`,
  `currentToolStartedAt`, and `currentToolInferred`. Any contract change here
  must be mirrored in `public/app.js`, `public/chat/message-timeline.js`, and
  the runtime tests.
- Redact before persistence or UI exposure. Tool previews must strip secrets,
  auth headers, tokens, and unnecessary absolute paths, and long bridge-event
  histories must keep the newest events so the latest failure context survives
  truncation.
- `GET /api/conversations/:conversationId/messages/:messageId/tool-trace`
  remains assistant-only and should return a merged trace built from session
  snapshot data plus stored bridge events.
- Skill-test runs reuse the same `conversation_tool_event.step` shape for live
  tool rows, with `server/api/skill-test-controller.ts` emitting companion
  `skill_test_run_event` lifecycle payloads that carry the synthetic trace
  `messageId` and terminal merged `trace` snapshot.
- Dynamic skill-test trigger runs may also persist a
  `skill_test_dynamic_load_confirmed` task event when a live pi event proves the
  target `read .../SKILL.md` before session JSONL or `agent_tool_call`
  persistence catches up; evaluation treats that task event as authoritative
  load evidence for the target skill.

## Test Expectations

- Runtime changes should usually be covered by `tests/runtime/agent-tool-bridge.test.js`
  or `tests/runtime/turn-orchestrator.test.js`
- Conversation memory changes should also keep `tests/storage/chat-store.test.js`
  and `tests/runtime/agent-chat-tools.test.js` in sync with the bridge/prompt
  contract.
- Tool trace aggregation and redaction changes should also be covered by
  `tests/runtime/message-tool-trace.test.js`
- If the change affects pi runtime CLI behavior, also inspect
  `tests/runtime/pi-runtime.test.js`
- Dynamic skill path-loading prompt behavior is covered by `tests/runtime/skill-loading.test.js`
