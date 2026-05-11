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
- Keep prompt sections ordered from stable policy/capability context to volatile
  per-turn context: `workspace_header`, optional `private_persona`, `rules`,
  `routing_instructions`, `command_format_rules`, `local_sandbox`, optional
  skills, optional `dynamic_skill_loading`, `tool_instructions`, optional
  `browser_tool_instructions`, optional `participants`, optional mode sections,
  `trellis_context`, `session_goal`, `conversation_digest`, explicit recall
  sections, `private_mailbox`, `conversation_history`, `turn_trigger`, and
  `final_instruction`. This keeps high-churn public conversation history near
  the tail, lets current session goals beat stale digest next actions, and keeps
  recent raw messages after digest/recall context so they win conflicts. Omit the
  default first-speaker trigger section because it adds no material context; when
  a non-default host, mention, private, or handoff trigger exists, keep the
  concise `Turn routing state` section after conversation history and
  immediately before the final reply instruction. This section should explain
  only the material trigger (host/user mention/private/handoff) and must not
  expose internal queue mode or remaining slot counters.
- The `Other visible participants` prompt section must list only agents other
  than the current speaker. Filter by `agent.id` when available and fall back to
  exact `agent.name` matching only when an id is missing, so handoff guidance
  cannot invite an agent to mention itself.
- Optional prompt sections with no material body should be omitted rather than
  represented as `- none` or `No ...` placeholders. This applies to persona
  skills, conversation skills, other participants, private mailbox, legacy
  curated memory cards, and conversation history; the Inspector snapshot must reflect
  the same omitted section list because it is built from the same prompt sections.
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
  - `tokenUsage`: normalized `{ inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens }`, values are non-negative integers or `null`.

### 3. Contracts
- Runtime preserves raw usage without inventing provider fields.
- Normalization accepts common provider key variants: `input_tokens` / `inputTokens` / `prompt_tokens` / `promptTokens`, `output_tokens` / `outputTokens` / `completion_tokens` / `completionTokens`, `cacheRead` / `cache_read` / `cacheReadTokens` / `cache_read_tokens`, `cacheWrite` / `cache_write` / `cacheWriteTokens` / `cache_write_tokens`, and `total_tokens` / `totalTokens`.
- If total is absent but token fields exist, total is computed as `(input || 0) + (output || 0) + (cacheRead || 0) + (cacheWrite || 0)`.
- UI displays the token badge only for assistant messages with normalized or raw usage; older messages without usage render unchanged.
- The badge label uses total tokens when available, appends `cacheRead / totalTokens` as a cache-hit percentage when `cacheRead` exists, and keeps input/output/total/cache details in the element title.

### 4. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| Assistant message has `usage.total_tokens` | Store raw `usage`, normalize `totalTokens`, display a token badge. |
| Assistant message has only input/output counts | Compute total from available counts and display it. |
| Assistant message has `cacheRead`/`cacheWrite` counts | Normalize cache counts, include them in inferred totals when needed, and display `cacheRead / totalTokens` on the badge. |
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

## Agent Chat Bridge Prompt Guidance

### 1. Scope / Trigger
- Trigger: changing the `Chat bridge tools` prompt block in `server/domain/conversation/turn/agent-prompt.ts`.
- Goal: keep per-turn tool instructions compact while preserving operational safety, routing behavior, and command signatures that agents need to act correctly.

### 2. Signatures
- Public send: `node <agentToolRelativePath> send-public --content-stdin`.
- Private send: `node <agentToolRelativePath> send-private [--to "AgentName[,AgentB]"] [--no-handoff] --content-stdin`.
- Context recall: `read-context`, `search-messages --query "..." --limit 5`, and `search-memory --query "..." --limit 5` or `--latest`.
- Governance: `list-participants`, `suggest-goal --action complete|pause|set --reason "..."`, and `update-goal-checklist --content-stdin` with `[ ]`, `[~]`, `[x]` rows.
- Trellis writes: `trellis-init --task "my-task" [--confirm] [--force]` and `trellis-write --path ".trellis/..." --content-stdin [--confirm] [--force]`.
- Experience: `write-experience --title ... --category ... --scenario ... --step ... --validation ... --artifact ... --confidence high|medium|low`.

### 3. Contracts
- Keep one shared `command_format_rules` section instead of repeating bash/heredoc/stdin/Windows-path rules under each tool.
- Preserve exact public and private heredoc templates using `node "$CAFF_CHAT_TOOLS_PATH"` because they are the safest multiline examples and are covered by prompt tests.
- Keep safety rules explicit in `command_format_rules`: never print tokens/secrets, check public content before `send-public`, put private roles/reasoning/scratch/game identity in private notes, and mark `--force` as dangerous.
- Keep routing rules explicit in `rules` / `routing_instructions`: actionable mentions trigger only at line start or in a final pure mention block; inline mentions do not trigger; private messages wake recipients unless `--no-handoff`; no actionable mention stops the turn; up to 5 agents run at once.
- Keep `tool_instructions` focused on compact command signatures and group low-frequency tools into capability lines rather than listing preview/apply/overwrite examples separately.
- Dynamic skill loading stays a single conditional `dynamic_skill_loading` section: descriptor-only skills are loaded by reading the listed `Path`, which already points to `SKILL.md`.
- Do not advertise deprecated memory card bridge commands in `Chat bridge tools`.

### 4. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| Prompt includes chat bridge guidance | Contains public/private heredoc templates in `command_format_rules`, bash-only guidance, safety rules, and compact tool signatures in `tool_instructions`. |
| Dynamic skill descriptors are present | Includes the one-line dynamic `read`/`Path` guidance as `dynamic_skill_loading`. |
| No descriptor-only skills are present | Omits the dynamic skill-loading guidance. |
| Search-memory guidance is present | States that long-term memory is not automatic and lists only core commands plus compact optional filters. |
| Trellis write guidance is present | States preview-by-default, `--confirm` to write, and `--force` dangerous without separate overwrite examples. |
| Deprecated memory cards exist | Prompt still omits `list-memories`, `save-memory`, `update-memory`, `forget-memory`, and curated memory card sections. |

### 5. Good/Base/Bad Cases
- Good: shared format/safety rules appear once in `command_format_rules`, routing appears in `rules` / `routing_instructions`, and grouped send, retrieval, governance, write, and experience lines stay in `tool_instructions`.
- Base: a new bridge command adds one compact signature plus any unique safety rule, not a repeated heredoc tutorial.
- Bad: removing `search-memory` trigger wording, hiding `--force` danger, or reintroducing deprecated memory card commands to save a few tokens.

### 6. Tests Required
- `tests/runtime/turn-orchestrator.test.js` should assert bash/heredoc guidance, compact search-memory filters, write-experience sparse-use warning, and absence of deprecated memory commands.
- `tests/runtime/skill-loading.test.js` should assert the exact one-line dynamic skill-loading guidance in dynamic mode and its absence when no descriptor-only skills are injected.
- `npm run build`, targeted runtime tests, `npm run check`, and `npm run typecheck` should pass after prompt guidance changes.

### 7. Wrong vs Correct
#### Wrong
```typescript
`- Preview ... trellis-init --task "my-task"`,
`- Apply ... trellis-init --task "my-task" --confirm`,
`- Overwrite ... trellis-init --task "my-task" --confirm --force`,
```
- This repeats the same command shape and hides the safety model in three lines.

#### Correct
```typescript
`- Trellis writes default to preview: ${relativeCommandPrefix} trellis-init --task "my-task" [--confirm] [--force] ... Add --confirm to write; --force is dangerous.`,
```
- This preserves behavior while making the write/overwrite boundary more visible and token-efficient.

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
- Memory card bridge commands (`list-memories`, `save-memory`,
  `update-memory`, `forget-memory`) are deprecated for agent-facing prompts.
  Keep their bridge/storage behavior and existing data for compatibility and
  future migration, but do not advertise them in `Chat bridge tools` and do not
  query or inject `Curated memory cards` during prompt assembly.
- Existing memory card storage keeps its current isolation and safety contracts:
  durable writes are scoped to `local-user + agent`, update/forget require exact
  case-sensitive title matches and reasons, tombstoned cards stay auditable, and
  secret/transient-content rejection remains enforced for compatibility callers.
- Current-conversation message recall results are not auto-injected; prompt
  guidance only teaches `search-messages` for current conversation recall and
  `search-memory` for explicit digest-summary recall.
- Prompt assembly may inject same-agent `conversationRetrievalTraces` as `Last
  recalled evidence cache` before live conversation history. It must filter by
  current `agent.id`, label traces as recall evidence rather than instructions,
  and state that current task/spec context plus recent raw messages override the
  cache. Prompt selection prioritizes `pinned`, then `used`, then `seen` traces;
  `used`/`pinned` evidence includes detailed sections, `seen` evidence stays
  compact, and `expired` evidence is omitted. The cache stores only bounded
  summary-segment snippets and source digest ids, not raw messages or full tool
  transcripts.
- Prompt assembly must not run cross-conversation summary-memory search by
  default. Long-term memory enters agent context only through explicit agent/user
  actions such as `search-memory`, plus same-agent `conversationRetrievalTraces`
  captured from those explicit tool calls. Agent-facing tool guidance should tell
  agents to call `search-memory` when the user asks about prior context (for
  example “上次”, “之前”, “还记得吗”, or “回忆一下”) and must say that long-term
  memory is not automatically injected. The legacy automatic recall helper may be
  kept as an opt-in compatibility path for tests or experiments, but the default
  executor path leaves `relatedMemorySegments` empty.
- Deprecated memory cards stay small and durable for compatibility: active-card
  budget is 6 per scope, default TTL is 30 days, max TTL is 90 days, and expired
  or non-active cards stay out of prompts and visible lists.
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
