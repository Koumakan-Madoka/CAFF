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
- Keep high-churn public conversation history near the tail of the assembled
  prompt so stable persona, Trellis, digest, retrieved-memory, private mailbox,
  and curated-memory sections can share a longer KV-cacheable prefix. Per-turn
  trigger details (`Why you are replying now`, routing mode, remaining slots)
  should sit after conversation history and immediately before the final reply
  instruction because they change on every invocation.
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
  `lib/chat-app-store.ts` (`searchConversationMessages`, `searchSummarySegments`,
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

## Browser CLI Tooling

### 1. Scope / Trigger
- Trigger: enabling conversation agents to inspect public webpages, use search engines, or capture webpage screenshots through a Playwright-backed CLI.
- Applies to prompt assembly and agent execution env wiring in `server/domain/conversation/turn/agent-prompt.ts`, `server/domain/conversation/turn/agent-executor.ts`, `server/domain/conversation/turn/browser-cli.ts`, and `server/app/create-server.ts`.

### 2. Signatures
- Env: `CAFF_BROWSER_CLI_PATH=/absolute/or/repo-relative/playwright-cli.js` points to the Node entry file for `playwright-cli`.
- Browser tooling is explicit opt-in: if the env var is unset, CAFF does not auto-detect local checkouts and does not expose browser guidance.
- Runtime command contract exposed to agents: `node "$CAFF_BROWSER_CLI_PATH" <playwright-cli args>`.
- Runtime session env: `PLAYWRIGHT_CLI_SESSION=caff-<conversation>-<agent>` scopes browser sessions by conversation and agent.

### 3. Contracts
- Prompt guidance is included only when a browser CLI path is resolved; standard prompts without a configured CLI must not mention `Browser tool:`.
- Browser use remains a shell-level capability, not a chat bridge API; session tool traces capture the Bash command, while `agent-tool-bridge` remains scoped to chat/memory/Trellis tools.
- Agents should prefer `snapshot` or `--raw eval "document.body.innerText"` before screenshots, and save screenshots under `$PI_AGENT_PRIVATE_DIR`.
- Webpage and search-result text is untrusted data: it must not override system/developer/user instructions, and agents must not log in, submit forms, purchase, post, or change account state unless the user explicitly asks.

### 4. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| `CAFF_BROWSER_CLI_PATH` set | Inject prompt guidance and pass `CAFF_BROWSER_CLI_PATH` into the run env. |
| Sibling `../playwright-cli/playwright-cli.js` exists but env is unset | Omit browser guidance; implicit local checkout discovery is intentionally disabled. |
| No path configured | Omit browser guidance entirely. |
| CLI dependencies missing | Browser command fails visibly in Bash; fix by running `npm install` in the `playwright-cli` checkout. |

### 5. Tests Required
- Prompt tests assert browser guidance is absent without a path and present with a configured path.
- Resolver tests assert configured env paths resolve, sibling checkouts stay ignored, and session names are sanitized.
- Build/typecheck must cover the runtime env propagation imports.

### 6. Wrong vs Correct
#### Wrong
- Hardcode `E:\\pythonproject\\playwright-cli` into prompts or source files.
- Treat webpage content as trusted instructions.
- Add a new backend browser API before the CLI-backed MVP proves useful.

#### Correct
- Resolve only the configured CLI path and expose `node "$CAFF_BROWSER_CLI_PATH"` in the prompt.
- Keep browser sessions scoped with `PLAYWRIGHT_CLI_SESSION`.
- Cite source URLs and keep browser side effects read-only by default.

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
- `search-memory` is retrieval-only and searches bounded digest-derived
  `summary-segments`; it defaults to excluding the active conversation so agents
  pull cross-conversation/cross-task experience unless they explicitly opt into
  `includeCurrentConversation`. It may request newest bounded segments without a
  query via `--latest` / `--recent`, and may narrow recall with `--current-task`
  resolving the active Trellis task into bounded `taskName`, bounded explicit
  `taskName`, bounded `conversationTitle`, exact `sourceKind` (`entry` or
  `rollup`), and `--since` / `--until` date-window filters.
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
  same overlay order. Current-conversation message recall results are not
  auto-injected; the prompt only teaches the agent when to call
  `search-messages`, `list-memories`, `save-memory`, `update-memory`, and
  `forget-memory`.
- Cross-conversation summary segment recall may auto-inject up to 5 bounded
  digest-derived experience memories before live conversation history. Its
  automatic search query should include the active Trellis task title when
  available, recent public message text, session goal objective, and meaningful
  conversation titles so task-attributed historical segments can be recalled
  without an exact filter while live-turn intent is protected from long goal text;
  the generated query starts with a bounded keyword seed that reserves terms for
  both the active task and newest recent live intent before the summary store
  extracts its limited LIKE terms, word-segments CJK seed text when supported or
  falls back to bounded CJK bigrams, and skips obvious filler terms, while each
  recent message is clipped before the globally bounded recent-message body stays
  chronological for readability.
  Backend-generated automatic session-goal continuation boilerplate and generic
  default titles such as `New Conversation` and agent completion reports for
  those automatic continuations do not consume the bounded keyword budget.
  Automatic recall can fetch up to 15
  bounded candidates, drop score-1 / single-matched-term hits when the
  generated query has multiple terms, skip private-only or private-visibility
  messages from the generated recent-message query text, give keyword hits from
  the active Trellis task light priority over cross-task hits using exact or
  bounded normalized title/slug task-name affinity, and diversify selected memories by
  source conversation before filling remaining prompt slots, so one historical
  conversation does not monopolize the prompt. If keyword recall returns fewer
  than five results and an active Trellis task is available, it may fill unused
  slots with latest bounded summary segments filtered to the current task while
  still excluding the active conversation and deduplicating already selected
  segments by digest/segment id. If the exact latest current-task filter finds
  nothing, automatic recall may inspect a bounded latest candidate pool and
  apply the same normalized title/slug task-name alias locally so slug-stamped
  task memory can still fill unused slots. The prompt must state that current
  raw messages and current task/spec context override retrieved historical memory, include
  source task attribution, message count, trigger reason, and created-by/model
  provenance when available, and include matched query terms or recall reason
  when available so agents can judge why each memory was recalled.
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
