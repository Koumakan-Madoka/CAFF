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
  `trellis-write`, and chat bridge calls

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

## Mirrored Update Paths

- Trellis tool API:
  `lib/agent-chat-tools.ts` <-> `server/api/agent-tools-controller.ts` <->
  `server/domain/runtime/agent-tool-bridge.ts`
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

## Test Expectations

- Runtime changes should usually be covered by `tests/runtime/agent-tool-bridge.test.js`
  or `tests/runtime/turn-orchestrator.test.js`
- Tool trace aggregation and redaction changes should also be covered by
  `tests/runtime/message-tool-trace.test.js`
- If the change affects pi runtime CLI behavior, also inspect
  `tests/runtime/pi-runtime.test.js`
- Dynamic skill path-loading prompt behavior is covered by `tests/runtime/skill-loading.test.js`
