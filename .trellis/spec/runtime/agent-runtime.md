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
  `server/domain/conversation/retrieval-trace.ts` <->
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

## Conversation Reply Token Usage

### 1. Scope / Trigger
- Trigger: showing per-assistant-reply token consumption in the chat timeline.
- Applies to `lib/pi-runtime.ts`, `server/domain/conversation/turn/agent-executor.ts`, and `public/chat/message-timeline.js`.

### 2. Signatures
- pi JSON assistant message may include `usage: object` from the provider/runtime.
- `startRun(...).resultPromise` resolves with `usage` copied from the latest assistant `message_end` or `agent_end` assistant message when present.
- Completed chat assistant message metadata stores:
  - `usage`: raw provider usage object, or `null`.
  - `tokenUsage`: normalized `{ inputTokens, outputTokens, totalTokens }`, values are non-negative integers or `null`.

### 3. Contracts
- Runtime preserves raw usage without inventing provider fields.
- Normalization accepts common provider key variants: `input_tokens` / `inputTokens` / `prompt_tokens` / `promptTokens`, `output_tokens` / `outputTokens` / `completion_tokens` / `completionTokens`, and `total_tokens` / `totalTokens`.
- If total is absent but input or output exists, total is computed as `(input || 0) + (output || 0)`.
- UI displays the token badge only for assistant messages with normalized or raw usage; older messages without usage render unchanged.
- The badge label uses total tokens when available and keeps input/output/total details in the element title.

### 4. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| Assistant message has `usage.total_tokens` | Store raw `usage`, normalize `totalTokens`, display a token badge. |
| Assistant message has only input/output counts | Compute total from available counts and display it. |
| Usage missing or malformed | Store `null` normalization and hide the badge. |
| Existing historical messages | Render without token badge and without layout errors. |

### 5. Tests Required
- `tests/runtime/pi-runtime.test.js` asserts assistant `usage` survives `startRun` completion.
- `npm run check`, `npm run build`, and `npm run typecheck` must pass after UI/runtime changes.

### 6. Wrong vs Correct
#### Wrong
- Re-read session JSONL in the browser for every rendered message just to discover token counts.
- Assume only one provider key naming scheme such as `total_tokens`.

#### Correct
- Capture usage once in `lib/pi-runtime.ts`, persist it into assistant message metadata when the reply completes, and let the timeline render from the normal conversation payload.
- Normalize multiple provider key variants while preserving raw `metadata.usage` for diagnostics.

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
  `rollup`), and `--since` / `--until` date-window filters. Successful
  result-bearing `search-memory` calls also write a bounded same-conversation
  `conversationRetrievalTraces` metadata entry with `status: 'seen'` so the next
  prompt for the same agent can recover evidence the tool returned even if the
  assistant only paraphrased part of it publicly. When the assistant reply
  completes, the runtime weakly matches the public reply against same-turn trace
  snippets and promotes overlapping evidence to `used`; `pinned` is reserved for
  future explicit keep actions, and `expired` is retained only for audit/omitted
  from prompt injection.
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
- Prompt assembly may inject same-agent `conversationRetrievalTraces` as `Last
  recalled evidence cache` before live conversation history. It must filter by
  current `agent.id`, label traces as recall evidence rather than instructions,
  and state that current task/spec context plus recent raw messages override the
  cache. Prompt selection prioritizes `pinned`, then `used`, then `seen` traces;
  `used`/`pinned` evidence includes detailed sections, `seen` evidence stays
  compact, and `expired` evidence is omitted. The cache stores only bounded
  summary-segment snippets and source digest ids, not raw messages or full tool
  transcripts.
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

## Experience Write Tool

### 1. Scope / Trigger
- Trigger: adding or changing the agent-facing `write-experience` command or the pending experience draft metadata it writes.
- Applies to `lib/agent-chat-tools.ts`, `server/api/agent-tools-controller.ts`, `server/domain/runtime/agent-tool-bridge.ts`, `server/domain/conversation/experience-draft.ts`, digest generation, and Skill draft extraction.
- Goal: let agents voluntarily save one bounded reusable lesson discovered during tool use without storing raw tool transcripts or directly writing Skill files.

### 2. Signatures
- CLI: `node "$CAFF_CHAT_TOOLS_PATH" write-experience --title "lesson title" --category bug_fix --scenario "when this applies" --step "short step" --validation "npm run check passed" --artifact "path/to/file.ts" --confidence high`
- CLI JSON stdin: `write-experience --content-stdin` accepts a JSON object with the same fields; non-JSON stdin is treated as `scenario` text.
- HTTP: `POST /api/agent-tools/experience/write`
  - Request: `{ invocationId, callbackToken, title, category?, scenario?, context?, steps?, pitfalls?, validation?, artifacts?, confidence?, skillTestRunId?, skillTestCaseId? }`
  - Response: `{ ok: true, draft, experienceDrafts }`
- Metadata: `conversation.metadata.experienceDrafts?: ExperienceDraft[]`.

### 3. Contracts
- The bridge authenticates the invocation exactly like other chat tools, derives `conversationId`, `agentId`, `agentName`, `turnId`, and `assistantMessageId` from the invocation context, and ignores/splices out any model-supplied source ids.
- `ExperienceDraft`: `{ id, status: 'pending'|'absorbed'|'rejected', title, category, scenario, steps, pitfalls, validation, artifacts, confidence, source, createdAt, updatedAt, absorbedAt?, absorbedDigestId?, rejectedAt?, reason? }`.
- Allowed categories: `bug_fix`, `pattern`, `decision`, `anti_pattern`, `tool_usage`, `other`; confidence: `low`, `medium`, `high`.
- The domain stores at most 8 bounded drafts per conversation. Each agent turn may write at most one draft.
- The tool is for reusable, validated, or carefully caveated lessons. It is not for simple Q&A, raw logs, full transcripts, secrets, private messages, transient TODOs, or unverified guesses.
- Digest creation projects pending drafts into `digest.experience` and then marks the projected drafts `absorbed`; pending drafts are not searchable cross-conversation before digest/Skill review. When digest auto-create is enabled, a pending draft plus at least one new public source message may trigger the next digest below the normal message budget, bypass idle/cooldown gates for that pending-experience absorption, broadcast a compact `conversation_digest_status` UI hint while the hook runs, and complete through the awaited assistant-message hook after the final completed message is already broadcast but before same-turn routing continues. The awaited assistant-completion hook has no application timeout; the visible timeline digest status is the user-facing progress indicator.
- Skill draft generation consumes `digest.experience` first, preserves experience confidence in rule-generated draft bodies, then falls back to digest facts/decisions/actions/artifacts.

### 4. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| Missing/invalid invocation auth | Same stale/unauthorized rejection as other bridge tools |
| Empty or generic title/content | `400` with field-level `issues` diagnostics such as `title is required` or `scenario, steps, pitfalls, or validation is required` |
| Secret-like content | `400 Do not save secrets...` and no metadata mutation |
| Raw transcript/full log markers | `400 Do not save raw tool transcripts...` and no metadata mutation |
| Same turn writes twice | `409 Only one experience draft can be written per agent turn` |
| Valid draft | Stores one pending bounded draft, broadcasts `conversation_experience_draft_updated`, and emits `agent_tool_call` telemetry |
| Later digest create | Copies bounded experience into `digest.experience` and marks source draft `absorbed` |

### 5. Good / Base / Bad Cases
- Good: after fixing a non-obvious bug and validating tests, the agent writes one high-confidence draft with file artifacts and validation command names.
- Good: a failed approach is captured as `pitfalls`, not as a required step.
- Base: the agent does not write experience for ordinary explanations or simple status updates.
- Bad: saving a complete Bash/read transcript, stack dump, token, password, private note, or speculative proposal as experience.
- Bad: relying on `write-experience` to create an enabled Skill; it only creates pending metadata for digest/Skill review.

### 6. Tests Required
- `tests/runtime/agent-chat-tools.test.js`: CLI forwards the bounded payload and skill-test scope to `/api/agent-tools/experience/write`, supports pitfalls/limitations aliases, and surfaces field-level error issues.
- `tests/runtime/agent-tool-bridge.test.js`: bridge writes system-owned source metadata, broadcasts updates, rejects duplicate same-turn writes, and rejects secrets.
- `tests/smoke/server-smoke.test.js`: digest absorbs pending drafts into `digest.experience`, marks drafts `absorbed`, and extracted Skill drafts include `Reusable Experience`.
- `tests/runtime/turn-orchestrator.test.js`: prompt guidance includes `write-experience` and the sparse-use warning.
- `tests/runtime/agent-executor-hook.test.js`: assistant completion hooks broadcast the final completed message first, then await digest/side-effect completion before same-turn routing continues.

### 7. Wrong vs Correct
#### Wrong
```bash
node "$CAFF_CHAT_TOOLS_PATH" write-experience --title "Full log" --scenario "$(cat huge-tool-output.log)"
```
- This stores raw tool output and can leak secrets or prompt-injection text.

#### Correct
```bash
node "$CAFF_CHAT_TOOLS_PATH" write-experience \
  --title "Keep test harnesses on rule generation by default" \
  --category pattern \
  --scenario "When tests run with local model env vars configured" \
  --step "Pass explicit rule-mode options in the test harness" \
  --validation "npm run typecheck passed" \
  --artifact "tests/smoke/server-smoke.test.js" \
  --confidence high
```
- This stores a bounded reusable lesson with validation and artifacts, while leaving Skill installation to human-confirmed draft flow.

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
  or `tests/runtime/turn-orchestrator.test.js`; `search-memory` recall-cache
  changes must assert bridge metadata persistence, usage promotion, and prompt injection
- Conversation memory changes should also keep `tests/storage/chat-store.test.js`
  and `tests/runtime/agent-chat-tools.test.js` in sync with the bridge/prompt
  contract.
- Tool trace aggregation and redaction changes should also be covered by
  `tests/runtime/message-tool-trace.test.js`
- If the change affects pi runtime CLI behavior, also inspect
  `tests/runtime/pi-runtime.test.js`
- Dynamic skill path-loading prompt behavior is covered by `tests/runtime/skill-loading.test.js`
