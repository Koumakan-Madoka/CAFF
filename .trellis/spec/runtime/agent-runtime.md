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

## PI Package Family Upgrade Contract

### 1. Scope / Trigger

- Trigger: changing `@earendil-works/pi-coding-agent`, its PI AI companion,
  SDK host construction, model-catalog validation, or a direct PI AI consumer.
- The audited runtime baseline is coding-agent 0.84.3 plus PI AI 0.84.3.
  Dependency upgrades require a new release-note/API audit and updated exact
  version assertions; do not silently float either dependency.

### 2. Signatures And Owners

- `package.json` directly pins `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`, and `typebox` without ranges.
- `lib/pi-sdk-host.mjs` imports only `@earendil-works/pi-coding-agent` and owns
  `AgentSessionRuntime`, `SessionManager`, extension binding, native session
  events, prompt images, abort, and disposal.
- `lib/pi-model-config-validator.mjs` resolves coding-agent's nested PI AI and
  is the authority for Agent model configuration/capability validation.
- `server/domain/conversation/conversation-digest.ts` uses the direct
  `@earendil-works/pi-ai/compat` completion API as an isolated non-Agent model
  call. It must not pass its models, providers, messages, streams, or credential
  objects into `AgentSession`.
- `lib/pi-extensions/caff-capabilities.mjs` imports schema builders from the
  exact direct `typebox` dependency and passes only JSON-schema-shaped data to
  PI. It must not import a second PI AI package merely to build schemas.

### 3. Contracts

- No `@mariozechner/pi-ai` dependency or production import is allowed.
- Every resolved `@earendil-works/pi-ai` package instance must have the same
  audited version as coding-agent's declared companion, even when the published
  coding-agent shrinkwrap retains a physical nested copy.
- Runtime identity does not cross the two allowed consumers: Agent execution
  stays inside coding-agent's package graph; digest completion stays inside the
  direct compat graph. Plain JSON text/model configuration may cross CAFF
  boundaries, but class instances, streams, provider registrations, credential
  stores, messages, and TypeBox runtime values may not.
- Direct digest and Recovery Scribe requests may include one TypeBox-produced,
  JSON-schema-shaped submission tool in `Context.tools`. These definitions have
  no execute handler, are not registered with an Agent/session/extension, and
  their returned `toolCall.arguments` are validated and consumed as structured
  output rather than executed.
- CAFF subscribes to native `AgentSessionEvent` objects. JSON/RPC wire-format
  changes such as delta-only `message_update` do not change this contract unless
  CAFF explicitly switches transports.
- A pure dependency-upgrade candidate must not add provider-error
  normalization, retry classification, or CAFF outer retry behavior.

### 4. Validation And Error Matrix

| Condition | Required result |
| --- | --- |
| exact coding-agent and direct PI AI versions match | install, build, and runtime tests proceed |
| lockfile contains multiple physical PI AI nodes at the same audited version | allowed only with the isolated-consumer boundary above |
| any PI AI node resolves to another version | dependency test fails before runtime acceptance |
| deprecated `@mariozechner/pi-ai` appears in dependencies or production imports | dependency test fails |
| digest imports PI AI root instead of `/compat` and `complete()` is absent | build/smoke must fail; restore the official compat import |
| capability extension imports PI AI for `Type` | boundary test fails; use exact `typebox` |
| native SDK lifecycle signature changes | focused SDK-host tests fail and a compatibility adaptation is required |
| JSON/RPC `message_update` changes while native events remain stable | no CAFF runtime change; native delta tests remain authoritative |

### 5. Good / Base / Bad Cases

- Good: coding-agent and direct PI AI are both exactly 0.84.3; the lockfile's
  physical copies are all 0.84.3; Agent runtime objects and digest runtime
  objects remain isolated.
- Base: a PI release changes built-in model capability metadata. Update audited
  model snapshots and UI fixtures without changing persisted user provider
  configuration.
- Bad: keep an old root PI AI for digest or TypeBox while upgrading the nested
  Agent runtime, then pass its model/schema/message instances into 0.84.3.
- Bad: treat a JSON/RPC serialization breaking change as proof that native SDK
  events changed without testing the actual `AgentSession.subscribe()` path.

### 6. Tests Required

- `tests/runtime/pi-model-config-validator.test.js` asserts exact direct
  versions, zero deprecated package nodes/imports, one version across every PI
  AI lockfile node, `/compat` digest import, and `typebox` extension import.
- `tests/runtime/pi-model-catalog-host.test.js` and
  `tests/ui/model-family-roles-ui-gate.test.js` pin audited model capabilities.
- `tests/runtime/pi-sdk-host.test.js`, `tests/runtime/pi-runtime.test.js`, and
  `tests/runtime/model-input-capability-parity.test.js` cover SDK/session/event/
  image compatibility.
- `tests/runtime/pi-model-config-validator.test.js` resolves the real default
  digest compat entry and asserts `complete()` / `completeSimple()` / `getModel()` exports without
  network access. Server smoke covers digest behavior and PI/Trellis host
  startup.
- Run `npm ls`, `npm run check`, both typechecks, build, focused runtime tests,
  DAG/Goal/private/image/handoff regression, and smoke before freezing an
  upgrade candidate.

### 7. Wrong Vs Correct

#### Wrong

```js
import { Type } from '@mariozechner/pi-ai';
import { complete } from '@earendil-works/pi-ai';
```

This retains a deprecated package family for schemas and assumes the modern root
entry exports the legacy completion surface.

#### Correct

```js
import { Type } from 'typebox';
const piAi = await import('@earendil-works/pi-ai/compat');
```

Schemas use the documented TypeBox package; isolated digest completion uses the
official compatibility entry while Agent execution remains owned by
coding-agent.

## Expected Completion Assistant Tail Suppression

### 1. Scope / Trigger

- Trigger: a caller invokes `startRun(...).complete(reason)` after a public
  bridge reply succeeds, and the SDK host emits more assistant output while
  handling CAFF's intentional abort.
- PI AI 0.84.0+ can surface an auth-setup abort as an assistant message with
  `stopReason='error'`. The error text is provider/runtime dependent and is not
  part of CAFF's suppression decision.
- Applies to the `expected_completion` branch in `lib/pi-runtime.ts`; the
  executor's real assistant-error failure conversion remains unchanged.

### 2. Signatures

- `startRun(...).complete(reason)` requests
  `beginTermination({ type: 'expected_completion', message: reason })`.
- Terminal assistant output uses
  `requestExpectedCompletion(message) -> beginTermination({
  type: 'expected_completion', assistantStopReason, assistantMessageKey })`.
- `beginTermination(reason)` must enable `ignoreFurtherAssistantOutput` before
  sending `{ type: 'abort', reason }` when and only when
  `reason.type === 'expected_completion'`.
- While the flag is enabled, `handlePiEvent` ignores later `message_update`,
  `message_end`, and `agent_end` assistant processing.

### 3. Contracts

- The suppression boundary is event order, not error text. Assistant text,
  fallback text, usage, unresolved errors, and error history recorded before
  expected completion remain authoritative; later assistant output does not
  mutate them.
- Caller-driven `complete()` and terminal-message-driven
  `requestExpectedCompletion()` have symmetric post-completion behavior.
- An expected-completion close resolves with code zero only when the bounded result has no unresolved `assistantErrors`. `reply`, `usage`, and `usageCalls` then reflect only output observed before the boundary, and the runs row stores `status='succeeded'` with `assistant_errors_json=[]`.
- If a real assistant error was recorded before `complete()`, expected completion does not overwrite its semantic failure. The runtime rejects with `pi assistant reported a model invocation error`, preserves the unresolved/history/usage fields, and persists the run as `failed`. The executor then persists the message/task failure from the same structured signal.
- `agent-executor.ts` defensively fails an alternate or mocked resolved result whose `assistantErrors` is non-empty, but production `pi-runtime` owns the run terminal status. It must not infer or suppress cleanup errors from `bridgePublicCompletionRequested` or an error string.
- `cancelled`, `heartbeat_timeout`, `progress_timeout`, `run_timeout`, parent
  signals, process exits, ordinary aborts, and provider errors do not enable the
  guard. Their existing termination and failure semantics remain authoritative.
- PI session JSONL may retain the upstream cleanup record because the child owns
  session persistence; CAFF runtime result, stderr forwarding, reply, usage, and
  run/message/task state omit assistant output received after completion.
- Tool-trace projection keeps that raw child-session diagnosis visible but does
  not turn it back into `failureContext` when all authoritative persisted
  signals agree: message `completed`, task `succeeded|completed`, run
  `succeeded`, run `assistant_errors_json=[]`, and the same task has an
  `agent_reply_terminating` event with `type='expected_completion'`. The trace
  exposes `session.expectedCompletionTailIgnored=true` for this resolved state.
  Missing/malformed run state, a non-empty run error list, no expected-completion
  event, a failed message/task/tool step, or unrelated session failure remains
  a failure. This projection uses persisted lifecycle state, never error text.

### 4. Validation & Error Matrix

| Lifecycle | Required result |
| --- | --- |
| public reply, `complete()`, assistant abort error | run/message/task succeed; `assistantErrors=[]`; raw session diagnosis remains; trace sets `expectedCompletionTailIgnored=true` and has no failure context |
| text/usage, `complete()`, later text/usage/error | retain only pre-completion reply and usage |
| provider error, then `complete()` | runtime rejects, persists run failed with the unresolved assistant error, and executor fails message/task |
| terminal assistant stop, then abort tail | existing expected-completion success remains unchanged |
| user `cancel()` plus abort-shaped assistant tail | cancellation fails and tail remains diagnostic |
| heartbeat/progress/run timeout | timeout fails with its original `terminationReason.type` |
| exact `stream_read_error` retry | native retry accounting and unresolved/history reconciliation remain unchanged |
| ordinary assistant error without completion | runtime/executor provider failure remains unchanged |

### 5. Good / Base / Bad Cases

- Good: `send-public` succeeds, bridge calls `complete()`, and PI emits an abort
  setup error one millisecond later; the posted reply and its usage settle as a
  clean success.
- Base: PI emits a normal terminal assistant reply; the existing
  `requestExpectedCompletion` path ignores its cleanup tail.
- Bad: remove errors from `pendingAssistantErrors` by matching `aborted`; this
  can erase a real provider or user-cancel failure.
- Bad: suppress every resolved `assistantErrors` result in the executor when a
  bridge post happened; that loses the ordering needed to distinguish errors
  observed before and after completion.

### 6. Tests Required

- `tests/runtime/pi-runtime.test.js` uses an IPC fake host that sends a
  pre-completion tool/text message, waits for abort, then sends text delta,
  assistant error, and `agent_end`. Assert clean result/run state, unchanged
  pre-completion reply/usage, and no post-completion stderr error.
- The same suite sends a provider error before caller completion, triggers `complete()` only after the error event, and asserts rejection plus a real SQLite `runs.status='failed'` / non-empty `assistant_errors_json`. A cancellation variant asserts `terminationReason.type='cancelled'` and retains the abort-tail diagnosis.
- Existing heartbeat/progress/run timeout, terminal completion, native retry,
  and ordinary assistant-error tests remain regression gates.
- `tests/runtime/agent-executor-hook.test.js` keeps both sides of the boundary:
  successful bridge auto-completion writes a completed reply, while a mocked
  resolved result with `assistantErrors` writes a provider failure.
- `tests/runtime/message-tool-trace.test.js` uses real SQLite run/task/event rows
  plus session JSONL to prove the projection boundary. A succeeded run with
  `assistant_errors_json=[]` and an expected-completion termination event keeps
  the raw session error but has no failure context; a non-empty run error list
  or missing termination event remains a failure.
- Turn/smoke suites verify that a successful completion creates no failure
  projection and routing still closes.

### 7. Wrong vs Correct

#### Wrong

```ts
if (bridgePublicCompletionRequested) {
  result.assistantErrors = result.assistantErrors.filter((error) =>
    !String(error).includes('aborted')
  );
}
```

This is text-based and cannot preserve a real error observed before the public
post.

#### Correct

```ts
if (reason && reason.type === 'expected_completion') {
  ignoreFurtherAssistantOutput = true;
}

if (terminationReason?.type === 'expected_completion') {
  if (result.assistantErrors.length > 0) {
    finishWithError(createInvokeError('pi assistant reported a model invocation error', result));
  } else {
    finishWithResult({ ...result, code: 0, signal: null });
  }
}
```

The guard is established before abort IPC, so only causally later assistant output is ignored; the terminal branch still refuses to convert an earlier provider failure into a succeeded run.

## Exact Stream Read Retry Normalization

### 1. Scope / Trigger

- Trigger: an Agent provider finishes an assistant stream with
  `stopReason='error'` and the normalized `errorMessage` is exactly
  `stream_read_error`.
- Applies to `lib/pi-extensions/caff-stream-read-retry.mjs`, automatic extension
  loading in `lib/pi-sdk-host.mjs`, retry-attempt accounting in
  `lib/pi-runtime.ts`, and final Agent message/task persistence in
  `server/domain/conversation/turn/agent-executor.ts`.
- This is a removable compatibility shim for the audited PI 0.84.3 retry
  classifier gap. It is not a CAFF turn retry, provider fork, or streaming-mode
  switch.

### 2. Signatures

- `normalizeStreamReadErrorMessage(message) -> message` returns the original
  object for every non-match. On the exact match it returns a same-role copy
  whose `errorMessage` is `connection error: stream_read_error`.
- `registerStreamReadErrorRetry(pi)` registers one official `message_end`
  handler and no tools, commands, providers, or other lifecycle handlers.
- `resolveRuntimeExtensionPaths(extensionPaths)` prepends
  `lib/pi-extensions/caff-stream-read-retry.mjs` once to the SDK resource
  loader's `additionalExtensionPaths`; caller-supplied capability extensions
  remain present.
- `pi-runtime` emits
  `assistant_retry_discarded { attempt, messageKey, errorMessage,
  discardedText, reply }` when a subsequent PI `auto_retry_start` proves that
  the immediately preceding assistant error attempt is being retried.
- A completed run exposes `assistantErrors` as unresolved terminal assistant
  errors only, `assistantErrorHistory` as the in-process diagnostic history of
  all attempts, and `usageCalls` for every unique assistant model call,
  including retried failures.

### 3. Contracts

- Normalize `errorMessage` by string type and surrounding whitespace only. Match
  exact lowercase `stream_read_error`; do not use substring, prefix, suffix, or
  broad network-error matching.
- Require all three conditions: assistant role, `stopReason='error'`, and the
  exact normalized identifier. `aborted`, HTTP 400/401/403, quota/billing,
  unrelated provider failures, and decorated strings remain unchanged.
- The replacement keeps the assistant role and all content, usage, response,
  provider/model, timestamp, and diagnostic fields. The mapped string retains
  the original `stream_read_error` identifier while adding PI-recognized
  `connection error` semantics.
- The SDK host always loads the shim before caller-supplied CAFF extensions.
  PI's official `message_end` pipeline rewrites the finalized assistant before
  `_isRetryableError`; PI alone owns the maximum of three retries and 2/4/8
  second default exponential backoff.
- `pi-runtime` treats an assistant error as unresolved until PI emits
  `auto_retry_start`. That event removes only the immediately preceding error
  from the unresolved set and removes only that message key's streamed/fallback
  text from the aggregated reply. Earlier completed model/tool output and later
  recovered output remain.
- Error history must not populate a succeeded run's authoritative
  `assistant_errors_json`; succeeded rows store `[]`. A terminal four-attempt
  failure stores only the final unresolved error there. PI session history,
  retry events, `assistantErrorHistory`, and model-call usage retain attempt
  diagnostics.
- Usage aggregation never discards retry attempts. One failure then success
  produces two `usageCalls`; four terminal failures produce four. The executor
  persists the full calls through the existing message-detail input and stores
  only lightweight aggregate metadata.
- A completed tool call before a later model stream failure stays in PI context.
  Native retry removes only the failed assistant error message, so the tool is
  not executed again.
- Tool-trace session parsing may retain assistant error history from failed
  attempts. When the persisted message is completed, its task is succeeded, the
  final session assistant has `stopReason='stop'|'length'`, and no final session
  error exists, that history remains visible as diagnostics/model calls but does
  not create `failureContext`. A failed message/task, final error/abort, or
  unrelated final session error remains authoritative.

### 4. Validation & Error Matrix

| Input / lifecycle | Required result |
| --- | --- |
| exact error, then success | two provider calls; one retry start; one successful retry end; final CAFF message/task/run succeeded |
| four consecutive exact errors | four provider calls; retry starts 1/2/3; one failed retry end at attempt 3; final CAFF message/task/run failed |
| partial text then exact error, then success | failed message text is absent from final CAFF reply; recovered text remains |
| completed tool, later exact error, then success | tool execution count remains one; retry context keeps its tool result |
| ordinary `connection error`, then success | existing PI native retry behavior remains unchanged |
| HTTP 400/401/403, quota, decorated error, or abort | no retry introduced by this shim; original message object/diagnosis remains |
| recovery succeeds after one failed attempt | `assistantErrors=[]`, history length 1, `usageCalls.length=2`, run `assistant_errors_json=[]` |
| terminal failure after three retries | one unresolved final assistant error, history length 4, `usageCalls.length=4` |
| succeeded message/task + final successful session + prior assistant errors | tool trace keeps two model calls/history but `failureContext.hasFailure=false` |
| succeeded message/task + final abort/unrelated error | existing tool-trace failure remains visible |

### 5. Good / Base / Bad Cases

- Good: the provider emits exact `stream_read_error`; the extension maps it,
  PI retries the failed model call, and CAFF settles a clean completed message
  without replaying a prior tool.
- Base: PI already recognizes `connection error: fixture disconnect`; the shim
  leaves it untouched and CAFF still reconciles the native retry lifecycle.
- Bad: matching `HTTP 400: stream_read_error`, `stream_read_error: detail`, or
  `aborted`; these errors may encode non-retryable request or user-cancel state.
- Bad: retaining failed-attempt text or unresolved errors after successful
  native retry; that concatenates replies or converts a recovered run back to
  failed at the CAFF boundary.
- Bad: wrapping `executeConversationAgent` in an outer retry; completed tool and
  bridge side effects could execute again.

### 6. Tests Required

- `tests/runtime/pi-stream-read-retry.test.js` uses a real PI `Agent` plus
  `AgentSession`, deterministic assistant streams, the production extension,
  in-memory settings, and no network. Assert exact recovery, attempts 1/2/3,
  terminal failure, partial text, non-retry matrix, ordinary retry, usage-bearing
  assistant ends, and one-time tool execution.
- `tests/runtime/pi-sdk-host.test.js` asserts the built-in extension is loaded
  once together with caller-supplied extension paths.
- `tests/runtime/pi-runtime.test.js` replays native retry event order through a
  child IPC host. Assert reply reset, unresolved/history separation, two/four
  usage calls, discard events, and SQLite succeeded/failed plus
  `assistant_errors_json` state.
- `tests/runtime/agent-executor-hook.test.js` asserts recovered history does not
  block completion and completed/failed message detail writes preserve two/four
  full model calls with lightweight metadata.
- `tests/runtime/message-tool-trace.test.js` writes an error attempt followed by
  a successful final assistant to a real session JSONL and asserts model-call
  history remains while no failure banner is created; unrelated final session
  errors remain failures.
- Full SDK/runtime/provider/session/tool, Goal/DAG/private/image/handoff, smoke,
  check, typecheck, public typecheck, and build regressions remain required.

### 7. Wrong Vs Correct

#### Wrong

```ts
if (message.errorMessage.includes('stream_read_error')) {
  return retryWholeConversationTurn();
}
```

This broadens non-retryable errors and can replay completed side effects.

#### Correct

```js
pi.on('message_end', (event) => {
  if (
    event.message.role === 'assistant'
    && event.message.stopReason === 'error'
    && String(event.message.errorMessage || '').trim() === 'stream_read_error'
  ) {
    return {
      message: {
        ...event.message,
        errorMessage: 'connection error: stream_read_error',
      },
    };
  }
});
```

The official same-role replacement runs before PI retry classification, keeps
streaming enabled, and leaves retry count/backoff/tool context under PI control.

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
- The `private_mailbox` prompt section is bounded by a whole-message character
  budget (`MAX_PRIVATE_MAILBOX_SECTION_CHARS = 16384` in
  `server/domain/conversation/turn/agent-prompt.ts`) on top of the 8-message
  row limit (`MAX_PRIVATE_CONTEXT_MESSAGES = 8`, applied both by the executor
  fetch and the prompt formatter). The budget applies to the mailbox body
  payload (formatted message lines, separators, and the omission notice when
  any message is dropped); the fixed `Private mailbox visible only to you:`
  header line is not counted. When all formatted messages fit, the section is
  emitted unchanged. Otherwise the newest contiguous suffix of whole messages
  that fits together with an explicit `[N private mailbox message(s) omitted
  to fit the section budget; use read-context to retrieve them]` notice is
  kept; older whole messages are dropped and messages are never clipped
  mid-content. The newest four messages
  (`MIN_PRIVATE_MAILBOX_SECTION_MESSAGES = 4`, or every message when the
  mailbox holds fewer) are a display floor that overrides the budget: they are
  always kept whole even when they alone exceed it, so the agent never loses
  the most recent private context behind a notice-only section. This means the
  section is not strictly byte-bounded when four or fewer huge messages are
  pending; bounding that case would require a write-side length limit, which
  is an explicit non-goal.
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

## Agent Run Watchdogs

### Signatures and configuration

- `lib/pi-runtime.ts` accepts `startRun(provider, model, prompt, { heartbeatTimeoutMs?, progressTimeoutMs?, idleTimeoutMs?, timeoutMs? })`.
- Host liveness resolves from `heartbeatTimeoutMs` -> `PI_HEARTBEAT_TIMEOUT_MS` -> 60 seconds.
- Useful-progress timeout resolves from `progressTimeoutMs` -> legacy `idleTimeoutMs` -> `PI_PROGRESS_TIMEOUT_MS` -> legacy `PI_IDLE_TIMEOUT_MS` -> 10 minutes.
- Absolute run timeout resolves from `timeoutMs` -> `PI_TIMEOUT_MS` -> 3 hours.
- Setting any resolved timeout to `0` disables that watchdog.

### Contracts

- A host `heartbeat` refreshes only the heartbeat watchdog. It proves that the
  pi host process and IPC channel are alive; it does not prove that a model or
  tool made progress.
- A structured `pi_event` refreshes heartbeat and useful-progress watchdogs.
  Tool start/update/end and model events therefore count as progress, while the
  host's periodic heartbeat does not.
- Nothing refreshes the absolute run watchdog.
- Timeout termination keeps the existing abort-then-process-tree-kill flow and
  records distinct `termination_type` values: `heartbeat_timeout`,
  `progress_timeout`, or `run_timeout`.
- `runs.timeout_ms` stores the absolute limit and `runs.idle_timeout_ms` stores
  the useful-progress limit. `runs.heartbeat_timeout_ms` remains host liveness.

### Validation matrix

| Case | Expected behavior |
| --- | --- |
| Host emits heartbeats but no `pi_event` | Terminate with `progress_timeout`. |
| Host emits repeated `pi_event` values beyond the 3-hour default total limit | Terminate with `run_timeout`. |
| Host and IPC become silent | Terminate with `heartbeat_timeout`. |
| A timeout is configured as `0` | Disable only that watchdog. |
| Watchdog terminates a run on Windows | Kill the pi host and its descendant process tree through `taskkill /T`, forcing it after the grace period. |

### Required tests

- `tests/runtime/pi-runtime.test.js` uses heartbeat-only and progress-only fake
  hosts to assert the watchdogs do not extend one another.
- `tests/storage/run-store.test.js` asserts all three configured timeout values
  are persisted in their existing SQLite columns.
- `tests/runtime/agent-executor-hook.test.js` covers the executor-to-runtime
  options wiring when that contract changes.

## One-Shot Active-Tool Progress Recovery

### 1. Scope / Trigger

- Trigger: `PI_PROGRESS_TIMEOUT_MS` expires while `lib/pi-runtime.ts` has observed at least one unmatched `tool_execution_start` event.
- Applies to `lib/pi-runtime.ts`, `lib/pi-sdk-host.mjs`, and `server/domain/conversation/turn/agent-executor.ts`.
- This is an Agent-run recovery contract, not a general `startRun` default. Digest/title/other direct model consumers keep the existing hard-timeout and fallback behavior.

### 2. Signatures And Payloads

- `startRun(provider, model, prompt, { toolProgressRecovery?: boolean, ...watchdogOptions })` enables this behavior only when `toolProgressRecovery === true`.
- Conversation Agent execution passes `toolProgressRecovery: true`; `server/domain/conversation/conversation-digest.ts` does not.
- Parent to SDK host:
  `{ type: 'recover', reason: { type: 'progress_timeout', message }, attempt: 1, toolName: string }`.
- SDK host to parent:
  `{ type: 'recovery_started', reason, attempt: 1, toolName }` or
  `{ type: 'recovery_failed', reason, attempt: 1, toolName, code }`.
- Runtime events: `run_recovering` and `run_recovery_started` carry the same bounded reason/attempt/tool name projection.
- Executor task events: `agent_reply_recovering` and `agent_reply_recovery_started`; the stage remains running and uses the existing turn-progress SSE projection.

### 3. Contracts

- `pi-runtime` tracks active tool calls by `toolCallId`: start adds the id and end removes it. Tool arguments never enter recovery IPC, runtime recovery events, task events, or the recovery prompt; the optional tool name is reduced to a clipped ASCII identifier prefix before crossing the prompt boundary.
- The first progress timeout recovers only when the caller opted in and the active-tool set is non-empty. A no-tool model stall or an opted-out caller terminates immediately with the existing `progress_timeout` reason.
- Each run may request recovery exactly once. A second progress timeout, recovery delivery failure, invalid/missing acknowledgement, or `recovery_failed` terminates as `progress_timeout` with `recoveryAttempt: 1` and a bounded `recoveryFailureCode` when available.
- The SDK host accepts recovery only while the original turn is marked in flight and `session.isStreaming === true`. A late request after idle returns `turn_not_active` and must not create a phantom prompt.
- Recovery order is: `session.abort()` -> `session.waitForIdle()` -> recovery `session.prompt(...)` preflight accepted -> `recovery_started` -> await recovered turn idle. The same runtime/session is retained; no host or Pi session is replaced.
- The prompt may include a clipped tool name only. It tells the model not to repeat the broad operation unchanged, to use a short bounded preflight/connectivity check, and to ask the user when an external prerequisite is missing.
- `stopReason='aborted'` is not terminal expected completion. A genuine terminal assistant message from the recovered turn still follows the normal expected-completion path.
- Absolute run timeout is never reset. User cancel, parent signal, heartbeat timeout, absolute timeout, assistant/provider error, signal exit, and nonzero process exit keep their existing authoritative close-path ordering.
- A fail-closed progress timeout remains `invocationFailure.kind='timeout'`; its normal multi-minute duration keeps it outside the Goal Runner fast-failure streak. Recovered success creates no failure projection.

### 4. Validation And Error Matrix

| Condition | Expected result |
| --- | --- |
| opted in + unmatched tool start + first progress timeout | send one `recover`, abort/settle, prompt same session, continue |
| active tool emits periodic updates | refresh sliding progress timer; do not recover merely because total tool time exceeds 10 minutes |
| no active tool or caller opted out | existing immediate `progress_timeout`; no `recover` IPC |
| second progress timeout | terminate `progress_timeout`, `recoveryAttempt=1`, no second recover |
| host rejects recovery / IPC delivery fails / ack missing or mismatched | terminate `progress_timeout` with bounded recovery failure code |
| user Stop races recovery | `cancelled` remains authoritative; late recovery messages are ignored |
| provider assistant error after recovery starts | fixed provider invocation error remains authoritative and preserves `assistantErrors[]` |
| host exits nonzero during recovery | process exit remains authoritative |
| recovered terminal assistant reply | normal success/expected completion |
| aborted assistant record | not expected completion; watchdog/cancel flow continues |
| digest model timeout | no recovery prompt; existing catch and extractive fallback |

### 5. Good / Base / Bad Cases

- Good: a silent `docker pull`-like tool is stopped once; the model performs a short connectivity check and asks the user for the missing prerequisite instead of repeating the 20-minute command.
- Base: a large download emits progress events for longer than 10 minutes, so the sliding watchdog keeps refreshing and recovery never fires.
- Bad: treating heartbeat as useful progress, recovering a pure model stall, copying tool args into the recovery prompt, resetting the 3-hour absolute timer, or globally enabling recovery for digest runs.

### 6. Tests Required

- `tests/runtime/pi-runtime.test.js`: active-tool recovery success, opt-out, no-tool timeout, second timeout, host rejection, cancellation precedence, provider/process-exit precedence, aborted-message filtering, and absence of tool args in recover IPC.
- `tests/runtime/pi-sdk-host.test.js`: abort/idle/prompt order and late-idle recovery rejection without a phantom prompt.
- `tests/runtime/agent-executor-hook.test.js`: Agent opt-in, running-stage/task-event projection, and digest call-site opt-out.
- `tests/runtime/session-goal-auto-pause.test.js`: structured timeout/fast-failure behavior remains unchanged.
- `tests/runtime/message-tool-trace.test.js`, `tests/runtime/turn-orchestrator.test.js`, and smoke digest tests remain regression gates for SSE/tool traces, cancellation, expected completion, and fallback behavior.

### 7. Wrong Vs Correct

#### Wrong
```ts
progressTimeout = setTimeout(() => child.send({ type: 'recover', toolArgs }), progressTimeoutMs);
```
- This recovers unknown/model stalls, leaks command data, and permits every `startRun` consumer to receive an Agent-specific prompt.

#### Correct
```ts
if (options.toolProgressRecovery === true && activeToolCalls.size > 0 && recoveryCount === 0) {
  child.send({ type: 'recover', attempt: 1, toolName: boundedToolName });
} else {
  beginTermination({ type: 'progress_timeout', message });
}
```
- Recovery is caller-owned, active-tool-gated, single-use, and payload-bounded.

## Goal Runner Model Invocation Failure Classification

### 1. Scope / Trigger

- Trigger: `server/domain/conversation/turn/agent-executor.ts` catches a failed Pi run that may contribute to the Goal Runner fast-failure guard.
- Tool/application preflight failures that never produce structured invocation metadata must remain outside this guard.

### 2. Signatures

- `classifyAgentInvocationFailure(error, { stopRequested? }) -> { kind, code, eligible, terminationType, summary }`.
- Failed assistant message metadata stores `invocationFailure` with that exact bounded projection.
- `routing-executor` copies the projection into `turn_finished.failures[]` and the returned `failures[]`; it does not infer failure kinds from `errorMessage`.

### 3. Contracts

- `assistantErrors[]` means `kind='provider'`, `code='assistant_error'`, eligible.
- A Pi terminal assistant error remains a failed invocation even when the SDK host exits with code zero. `startRun(...).resultPromise` rejects with the bounded generic message `pi assistant reported a model invocation error`, preserves `assistantErrors[]` for structured classification, and persists the run as failed. The executor defensively applies the same conversion if an alternate or mocked runtime resolves a result that still contains `assistantErrors[]`; it must never replace the provider signal with a later `Empty agent reply` parse error.
- Structured network codes such as `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, and `UND_ERR_*` mean provider failure, eligible.
- `terminationReason.type` in `heartbeat_timeout|progress_timeout|run_timeout` means timeout, eligible; the Goal layer separately enforces the fast-duration threshold, so normal 10-minute/3-hour watchdog failures do not become fast streaks.
- Numeric exit code or process signal means `process_exit`, eligible.
- User stop or `terminationReason.type='cancelled'` means `cancelled`, ineligible. Unclassified local/application errors mean `unknown`, ineligible.
- `summary` is whitespace-normalized, clipped to 240 characters, and redacts Authorization/Bearer, token, secret, password, API-key, and `sk-*` values before message metadata or SSE projection.

### 4. Validation & Error Matrix

| Input | Projection |
| --- | --- |
| SDK host exits zero after terminal `stopReason='error'` with `assistantErrors=['insufficient balance']` | run rejects and persists failed; executor projects provider / assistant_error / eligible |
| Alternate runtime resolves an empty reply with `assistantErrors=['insufficient balance']` | executor converts it to the same structured provider failure before reply parsing |
| An assistant error is followed by `terminationReason.type='progress_timeout'` | timeout remains authoritative; `assistantErrors[]` stays attached for diagnostics |
| `terminationReason.type='progress_timeout'` | timeout / progress_timeout / eligible; normally excluded later by duration |
| `exitCode=7` | process_exit / `7` / eligible |
| `code='ECONNRESET'` | provider / econnreset / eligible |
| stop requested | cancelled / stop_requested / ineligible |
| plain local `Error` with no runtime fields | unknown / unclassified_invocation_error / ineligible |
| secret in assistant error | summary contains `[redacted]`, never the secret |

### 5. Good/Base/Bad Cases

- Good: provider billing/auth/network failure is classified once at the invocation boundary and Goal logic consumes only the structured projection.
- Base: progress timeout is classified as timeout but exceeds the Goal fast threshold, so it breaks rather than increments the streak.
- Bad: regex-matching localized provider billing text inside `turn-orchestrator`, or copying raw `assistantErrors` into Goal metadata/SSE.

### 6. Tests Required

- `tests/runtime/session-goal-auto-pause.test.js` covers every kind, network codes, eligibility, and secret redaction.
- `tests/runtime/pi-runtime.test.js` proves a terminal assistant error rejects even when the SDK host exits zero.
- `tests/runtime/agent-executor-hook.test.js` covers both a rejected run and a defensive resolved-result path, asserting failed-message `metadata.invocationFailure` keeps the provider signal.
- `tests/runtime/turn-orchestrator.test.js` proves the projected failures pause on the third automatic continuation.

### 7. Wrong vs Correct

#### Wrong
```ts
if (/insufficient balance|429|provider unavailable/iu.test(failure.errorMessage)) {
  incrementGoalFailureStreak();
}
```

#### Correct
```ts
const invocationFailure = classifyAgentInvocationFailure(error, { stopRequested });
store.updateMessage(messageId, { metadata: { ...metadata, invocationFailure } });
```

## Recovery Eligibility Evidence For User Stop

### 1. Scope / Trigger

- Trigger: `agent-executor` settles an active Agent reply after the user invokes the conversation Stop path, and Recovery later inspects that source.
- This contract does not change Pi cancellation, task settlement, or queue cancellation. It defines which persisted runtime evidence may authorize the separate manual scribe action.

### 2. Signatures

```ts
message.status = 'failed';
message.metadata.cancelled = true;
message.metadata.invocationFailure = {
  kind: 'cancelled',
  code: 'cancelled',
  eligible: false,
  terminationType: 'cancelled',
  summary: string,
};
task.status = 'cancelled';
run.status = 'failed';
run.termination_type = 'cancelled';

recoveryCapability.sourceKind = 'failed' | 'user_cancelled' | null;
```

### 3. Contracts

- `requestStopConversationExecution/requestStopConversationTurn` marks the active turn stopped and calls the registered run handle's `cancel(reason)`; it does not invoke Recovery Scribe.
- Pi persists the cancelled run as failed with `termination_type=cancelled`. The executor independently persists the failed assistant cancellation projection and changes the linked task to cancelled.
- Recovery may classify `user_cancelled` only when all exact fields above and message/task/run IDs agree. Error prose, `stopReason=aborted`, one cancelled row, queued waiter cancellation, or a provider/watchdog termination is insufficient.
- Once any structured cancellation signal appears, partial or contradictory evidence rejects with `conversation_recovery_source_cancellation_mismatch`; it cannot fall through to ordinary failed-source recovery.
- The later manual scribe creates only its existing direct non-Agent child run with one non-executed schema submission tool. It does not resume the cancelled Agent session or alter the source run/task/message.

### 4. Validation & Error Matrix

| Runtime evidence | Recovery classification |
| --- | --- |
| exact active user Stop tuple | `user_cancelled` |
| task/run cancelled but no assistant cancellation metadata | mismatch, ineligible |
| assistant cancellation metadata but task failed/run provider error | mismatch, ineligible |
| queued side waiter cancelled before an assistant run exists | missing run, ineligible |
| progress/heartbeat/run timeout with task failed | existing `failed` source path |
| provider assistant error/abort with task failed | existing `failed` source path |
| successful expected completion | no failed assistant source capability |

### 5. Good / Base / Bad Cases

- Good: Stop races an active run; cancellation remains authoritative, all producer fields agree, and a later user click can request one read-only scribe.
- Base: a provider error has `invocationFailure.kind=provider` and remains a normal failed source even when its prose contains `abort`.
- Bad: classifying `run.termination_type=cancelled` alone as user intent, or automatically calling Recovery from the Stop handler.

### 6. Tests Required

- `tests/runtime/agent-executor-hook.test.js` runs `createTurnStopper -> handle.cancel -> agent-executor catch` and asserts exact message metadata plus task cancelled state.
- `tests/runtime/pi-runtime.test.js` keeps user cancellation authoritative across ordinary abort-tail and tool-recovery races, and asserts persisted run termination type.
- `tests/runtime/message-recovery.test.js` uses real SQLite source rows to prove the exact tuple, partial-evidence refusal, failed-source controls, source immutability, manual scheduling, non-Agent schema-tool submission, and restart projection.
- Turn orchestrator Stop, side-dispatch cancellation, Goal, and smoke suites remain regression gates; queued cancellation must not gain a recovery action.

### 7. Wrong vs Correct

#### Wrong

```ts
if (terminationType === 'cancelled') scheduleRecoveryScribe();
```

#### Correct

```ts
handle.cancel(stopReason); // Settle and persist the original user Stop only.
// A later explicit Recovery POST revalidates the complete persisted tuple.
```

## Platform System Actors

- `server/domain/roles/system-actor-catalog.ts` is the single source of truth for platform-owned identities that are not conversation Agents. `recovery_scribe` is the first such actor.
- A non-routable system actor has no role row, participant row, Agent session, invocation registry entry, mention token, private mailbox, Goal owner eligibility, or DAG execution role.
- Ordinary role IDs and display names that would impersonate a system actor are reserved. Participant validation and explicit cross-conversation targets fail closed even if a caller constructs the reserved ID.
- All candidate projections must derive from routable conversation participants: role/bootstrap directories, prompt/list-participants, mention/private/handoff lookup, initial explicit/default routing, Goal owner, and DAG worker/verifier.
- Recovery result messages are conversation evidence, not Agent replies: `agentId=null`, `systemActorType=recovery_scribe`, and `systemActorRoutable=false`. The direct model-layer request remains reachable only from the manual Recovery API.
- Required regressions: `runtime-role-resolution`, `initial-target-resolution`, `cross-conversation-delivery`, `session-goal-owner`, `message-recovery`, and `dag-scheduler` lock the negative routing contract.

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
  `server/domain/conversation/turn/agent-prompt.ts` (descriptor `Path` + `read` guidance)
- Prompt guidance:
  `server/domain/conversation/turn/agent-prompt.ts` <->
  `server/domain/conversation/turn/trellis-context.ts`
- Project selection and skill loading:
  `lib/project-manager.ts` <-> `server/app/create-server.ts` <->
  `server/domain/conversation/turn/agent-prompt.ts` (`getSkillLoadingMode`, `formatSkillDocuments`, `formatSkillDescriptors`)

## Tool Trace Failure Classification and Summary

### Scope / Trigger

- Applies when `server/domain/runtime/message-tool-trace.ts` projects persisted message/task state plus Pi session JSONL into `failureContext`, and when `public/chat/message-timeline.js` renders the collapsed failure note.
- Pi expected-completion cleanup can call SDK abort after the final assistant reply has already completed. Some providers append a trailing assistant record with `stopReason=aborted` and `errorMessage="Request was aborted."` even though CAFF persisted the message as `completed` and the task as `succeeded`.

### Contract

- Authoritative completed state wins over that exact cleanup artifact only when all conditions hold: message status is `completed`; task status is `succeeded` or `completed`; session stop reason is `aborted`; session error normalizes to `Request was aborted`; and no assistant error list is present.
- Do not broadly suppress `aborted`: a different session error, a failed message/task, a failed tool step, an assistant error list, user cancellation, or watchdog timeout remains a failure.
- `failureContext.summary` is the concise, redacted, actionable headline. Priority is failed-step error/result, task error, message error, session error, assistant error, then a status-specific fallback.
- `failureContext.text` remains the full redacted diagnostic context for expansion/copy and may contain message/task IDs and status metadata. The collapsed UI uses `summary`, never the full metadata block.

### Validation Matrix

| Case | Expected behavior |
| --- | --- |
| completed message + succeeded task + trailing `aborted / Request was aborted.` | `hasFailure=false`; no failure note |
| completed message + succeeded task + another aborted-session error | session failure remains visible |
| failed step, task, or message | failure remains visible with its highest-priority summary |
| user cancellation or watchdog timeout persisted as failed | failure remains visible |

### Required Tests

- `tests/runtime/message-tool-trace.test.js` covers cleanup-noise suppression, unrelated session errors, task summary priority, and detailed context retention.
- A jsdom timeline test covers concise collapsed text and absence of UUID/status metadata from that headline.

## Conversation Reply Token Usage

### 1. Scope / Trigger
- Trigger: showing per-assistant-reply token consumption in the chat timeline.
- Applies to `lib/pi-runtime.ts`, `server/domain/conversation/turn/agent-executor.ts`, and `public/chat/message-timeline.js`.

### 2. Signatures
- pi JSON assistant message may include `usage: object` from the provider/runtime.
- `startRun(...).resultPromise` resolves with `usage` aggregated across unique assistant model-call messages from `message_end` / `agent_end` events when present.
- Completed chat assistant message metadata stores:
  - `usage`: aggregated provider usage object for the run, or `null`.
  - `tokenUsage`: normalized `{ inputTokens, uncachedInputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, inputCostUsd, outputCostUsd, cacheReadCostUsd, cacheWriteCostUsd, totalCostUsd }`; token values are non-negative integers or `null`, cost values are non-negative USD numbers or `null`.
  - `modelUsage`: normalized per-run model-call summary `{ modelCallCount, coldStartModelCallCount, postColdModelCallCount, providerMissCount, calls[] }`, where each call has a 1-based `sequence`, canonical `isColdStart` (`coldStart` remains a legacy alias), `providerMiss`, and normalized `tokenUsage`; `providerMiss` means a non-cold-start call has `cacheReadTokens === 0` and positive uncached input.
- P2C-Expand detail table `chat_message_model_usage_calls` stores the four full-run aggregate counters plus at most 16 `calls[]`: the first call and latest 15. It also stores `callsTruncated`, `retainedCallCount`, and `droppedCallCount` projections. Historical 64-call rows are converged on read without rewriting them. The message metadata remains complete during Expand.
- P2C-Contract future assistant writes pass the full model usage object as a
  Store detail input. Message metadata keeps only the four full-run aggregate
  counters plus truncation/retained/dropped counts and never stores `calls[]`.
  Queued/streaming rows have no model-usage summary; completed/error rows store
  it only when usable calls exist. Table aggregates remain authoritative and
  must not be recomputed from the retained calls.

### 3. Contracts
- Runtime preserves raw usage field names and sums numeric usage/cost fields across unique assistant model calls in the run.
- Completed/error message updates and the model usage detail UPSERT share one SQLite transaction. No usable model calls means no detail row and no detailed model-usage metadata projection.
- Detail reads prefer the table and fall back to legacy metadata. Aggregate counts always represent the full run and must not be recomputed from the retained call array. Retention preserves original `sequence` values: 65 calls retain sequences `1, 51..65`; 100 calls retain `1, 86..100`.
- Normalization accepts common provider key variants: `input_tokens` / `inputTokens` / `prompt_tokens` / `promptTokens`, `output_tokens` / `outputTokens` / `completion_tokens` / `completionTokens`, `cacheRead` / `cache_read` / `cacheReadTokens` / `cache_read_tokens`, `cacheWrite` / `cache_write` / `cacheWriteTokens` / `cache_write_tokens`, and `total_tokens` / `totalTokens`.
- Provider `input` counts may mean non-cached input only. Normalized `inputTokens` represents effective prompt/context input, computed as `uncachedInputTokens + cacheReadTokens + cacheWriteTokens` when cache fields exist; `uncachedInputTokens` preserves the raw non-cached provider input.
- If total is absent but token fields exist, total is computed as `(inputTokens || 0) + (outputTokens || 0)`, where `inputTokens` already includes cache read/write tokens.
- UI displays the token badge only for assistant messages with normalized or raw usage; older messages without usage render unchanged.
- The badge label uses model-call language first when per-call data exists (for example `3 次模型调用 · 消耗 42.1k token · $0.0312 · 命中 28.0k (66%) · provider miss 1/2 次模型调用`), appends normalized USD cost when `usage.cost.total` or cost components exist, appends `cacheRead / totalTokens` as a cache-hit percentage when `cacheRead` exists, and keeps effective input/output/total/cache plus non-cached input, model-call count, cold-start count, provider miss count, and complete input/output/cache-read/cache-write cost details in the element title.
- Tool trace summaries must keep model calls and tool executions separate: `summary.modelCallCount` counts asks to the model, `summary.toolExecutionCount` / `summary.totalSteps` count tool executions, and provider miss denominators always use `postColdModelCallCount`, never tool execution count.
- Tool trace details expose top-level `modelUsageSummary` as the canonical model-call summary and a single `timelineEvents[]` list when model-call data is available. Each event has `eventType: 'model_call' | 'tool_execution'`; model-call rows carry `modelCallSequence`, cache/cost token usage, cold-start, and provider-miss flags, while tool-execution rows preserve existing command/status/result previews and may carry `modelCallSequence` for the model call that triggered them.
- UI should render `timelineEvents[]` as the unified assistant-turn observability timeline instead of showing a separate model-usage table beside a tool-centric trace. The first model call is labeled cold start, and later calls with zero cache read plus uncached input are labeled `provider miss`.

### 4. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| Assistant message has `usage.total_tokens` | Store raw `usage`, normalize `totalTokens`, display a token badge. |
| Assistant message has only input/output counts | Compute total from available counts and display it. |
| Assistant message has `cacheRead`/`cacheWrite` counts | Normalize cache counts, show effective input including cache tokens, preserve raw provider input as non-cached input, and display `cacheRead / totalTokens` on the badge. |
| `usage.cost` contains pi-ai USD components | Normalize input/output/cache/total costs, display the total USD cost on the badge, and show input/output/cache-read/cache-write component costs in the tooltip fee detail. |
| A non-cold model call reports `cacheRead: 0` with uncached input | Count it as `providerMiss`, show `provider miss N/M 次模型调用` on the badge and trace summary, and mark that call in trace details. |
| Usage missing or malformed | Store `null` normalization and hide the badge. |
| Existing historical messages | Render without token badge and without layout errors. |

### 5. Tests Required
- `tests/runtime/pi-runtime.test.js` asserts assistant `usage` survives `startRun` completion and multiple assistant model-call usage objects aggregate without double-counting `agent_end` duplicates.
- `tests/storage/message-detail-expand.test.js` asserts 15/16/17/64/100 retention boundaries, original sequence preservation, full aggregate counters, full metadata preservation, completed/error atomicity, restart, and rollback injection.
- `scripts/p2c-expand-gate.js` records production-shape snapshot/model usage disk, heap/RSS, latency, and integrity evidence.
- `npm run check`, `npm run build`, and `npm run typecheck` must pass after UI/runtime changes.

### 6. Wrong vs Correct
#### Wrong
- Re-read session JSONL in the browser for every rendered message just to discover token counts.
- Assume only one provider key naming scheme such as `total_tokens`.

#### Correct
- Capture usage once in `lib/pi-runtime.ts`, persist it into assistant message metadata when the reply completes, and let the timeline render from the normal conversation payload.
- Normalize multiple provider key variants while preserving raw `metadata.usage` for diagnostics.
- Keep the full Expand metadata and retained detail write inside `ChatAppStore.updateMessageTransaction`; table retention must not mutate or replace the metadata object.
- Use `模型调用` / `toolExecutionCount` wording for observability; do not use tool step counts as a proxy for model-call denominators.
- Keep model price metadata in `models.json` as pi-ai per-million-token USD rates: `{ input, output, cacheRead, cacheWrite }`; if a provider only publishes cached-read pricing, set `cacheWrite` to the normal input rate unless the provider documents a distinct write rate.

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

## Private Handoff and Commit-Pinned Review Guidance

- `send-private` to another participant wakes an eligible idle recipient immediately in the current turn. A self-note or `--no-handoff` only persists the message.
- Each source trace should send at most one complete private message per recipient. Do not poll, wait at P2, or send heartbeat follow-ups: server deduplication prevents a second launch and the already-running recipient may not see later content. If the same source run later includes that recipient in an actionable public mention, the public message remains visible but the turn-local `(sourceAgentId, sourceRunId, recipientAgentId)` ledger suppresses a second model invocation. `--no-handoff` does not enter that ledger.
- Formal review requests include the exact commit SHA, review scope/risks, author validation evidence, and requested response format. After sending the request, the author does not modify repository files for the rest of that trace.
- Review worktree selection is risk-based rather than automatic: immutable `git show`/`git diff <SHA>` needs no worktree; a clean room worktree already at the requested SHA is usable when it will remain stable; tests against a SHA while the room worktree may change require a detached review worktree with isolated runtime resources; requested code changes require a separate writable branch/worktree.
- Keep bridge behavior, compact CLI projection, prompt wording, and telemetry aligned. `dispatch[]` exposes bounded outcome labels/details without private content while legacy `handoffRequested` and `enqueuedAgentIds` remain available.

## Agent Chat Bridge Prompt Guidance

## CAFF-Owned Pi Capability Facades

### Runtime path and visible signatures

- Every conversation Agent run receives `lib/pi-extensions/caff-capabilities.mjs`
  through `startRun(..., { extensionPaths })`.
- The extension registers exactly two model-visible tools:
  - `room_workspace_preview()`
  - `room_workspace_bind(confirm)`
- `conversation_notify` and `conversation_request` remain available in the
  server-side facade registry for future restricted callers, but ordinary
  conversation Agent runs must not register or expose either tool to the model.
- All TypeBox object schemas set `additionalProperties: false`. They must not
  expose server IDs/URLs, MCP tool names, transports, commands, env, headers,
  credentials, raw arguments, or fallback actions.

### Local HTTP contract

- Route: `POST /api/agent-tools/capabilities/:facade`
- Request body:
  `{ invocationId, callbackToken, arguments }`
- Successful response:
  `{ ok: true, facade, result }`
- The extension reads only `CAFF_CHAT_API_URL`, `CAFF_CHAT_INVOCATION_ID`, and
  `CAFF_CHAT_CALLBACK_TOKEN`; credentials are not part of the model schema.
- `agent-tool-bridge` validates the active invocation, then injects
  `{ invocationId, sourceConversationId, sourceAgentId, sourceAgentName,
  projectScopeId, traceId, incomingDeliveryId }`. For an incoming delivery,
  `traceId` comes from the persisted parent delivery, not from the delivery ID.

### Registry and MCP adapter contract

- `server/domain/runtime/pi-capability-bridge.ts` is the only facade registry.
  Unknown facade names fail with `pi_capability_unknown_facade`; invalid or
  proxy-shaped arguments fail with `pi_capability_invalid_arguments` before a
  handler or transport starts.
- Internal `conversation_notify/request` entries call the existing Phase A
  delivery service and return a bounded delivery/status projection.
- MCP entries are server-configured allowlist records with a fixed stdio
  command, argument list, tool name, argument mapper, result projector, and
  timeout. Invocation input cannot select or override those values.
- Timeout, disconnect/call failure, and unsafe result projection fail closed as
  `pi_capability_timeout`, `pi_capability_mcp_failed`, and
  `pi_capability_projection_failed`. Audit events contain only facade, kind,
  status, duration, bounded principal IDs, and error code.
- The official `@modelcontextprotocol/sdk` is a direct exact dependency. The
  F003 implementation is pinned to `1.30.0`.

### Required tests

- `tests/runtime/pi-capability-bridge.test.js`: model-visible tool list omits
  `conversation_notify` and `conversation_request`; server-side delivery handling
  remains covered alongside schema snapshots, forbidden fields,
  principal/project/trace injection, fixed internal handlers, real isolated stdio
  MCP transport, timeout, disconnect, malformed/secret result, no shell/HTTP
  fallback, build asset copy, and real local HTTP dogfood.
- `tests/runtime/agent-executor-hook.test.js`: fixed extension path propagation.
- `tests/runtime/pi-sdk-host.test.js`: Pi SDK host extension loading.

## Conversation Spawn and Bootstrap Delivery

### Runtime path and HTTP signature

- Route: `POST /api/conversations/:sourceConversationId/spawn`.
- Exact body fields:
  `{ title, projectScopeId, participants, primaryAgentId, initialMessage,
  sourceMessageId?, clientRequestId }`. Unknown fields fail before domain work.
- `server/domain/conversation/conversation-spawn.ts` owns validation and payload
  construction. `ChatAppStore.persistConversationSpawn(...)` owns the single
  SQLite transaction.
- `clientRequestId` maps to idempotency scope
  `operator:<sourceConversationId>:conversation_spawn`; a duplicate returns the
  canonical child/message/receipt/delivery and creates nothing.

### Persistence and dispatch contract

- The source conversation must exist, already have a non-empty project binding,
  and have `treeDepth < 2`. The explicitly supplied `projectScopeId` must resolve
  through `ProjectManager` and equal the source binding because the bootstrap
  delivery remains inside the same project permission boundary.
- Participants pass the existing runnable-role validator. `primaryAgentId` must
  identify one selected participant.
- One transaction creates the child with immutable parent/origin/depth fields,
  the explicit participant roster, one public `user` first message, one source
  receipt, the `bootstrap` delivery row, and its redacted persisted event.
- The transaction never calls parent history/digest/metadata/participant/Skill/
  task/game-state copy paths. Child metadata starts as `{}`.
- Only after commit does the server request the existing delivery-worker drain.
  Bootstrap uses the same target-scoped side lane but enters the Agent prompt as
  ordinary `user` input (`triggerType=user`, no handoffs), not `external_agent`.
- A deterministic pre-start failure updates only the delivery state. The child
  and public initial message remain navigable; the normal delivery retry endpoint
  requeues the same safe delivery identity.

### Validation and error matrix

| Case | Expected behavior |
| --- | --- |
| Missing/empty/bounded text field | `400 conversation_spawn_invalid_request`; no rows written. |
| Source missing or optional source message outside source | `404 conversation_spawn_source_not_found` / `conversation_spawn_source_message_not_found`. |
| Source unbound or source already depth 2 | `409 conversation_spawn_source_unbound` / `conversation_spawn_max_depth`. |
| Project missing or differs from source binding | `404 conversation_spawn_project_not_found` / `403 conversation_spawn_project_mismatch`. |
| Participant unavailable or primary not selected | Existing participant error / `422 conversation_spawn_primary_not_participant`. |
| Any insert/event transition fails | Whole transaction rolls back; no half child/message/delivery. |
| Worker fails before invocation start | Delivery becomes retryable failed; child/message remain. |
| Duplicate `clientRequestId` | Return canonical existing spawn with `duplicate: true`. |

### Good / Base / Bad cases

- Good: explicit same-project participants, one primary, complete public first
  message, and stable `clientRequestId`; response includes child summary and
  canonical bootstrap delivery.
- Base: `sourceMessageId` is omitted; parent conversation remains the provenance
  anchor and no parent content is copied.
- Bad: accepting model/profile/history/metadata snapshots, a hidden recipient-only
  bundle, cross-project bootstrap, or starting all participants.

### Required tests

- `tests/runtime/conversation-spawn.test.js`: validation, non-Fork assertions,
  duplicate request, fault rollback matrix, retained failure/retry, primary-only
  dispatch.
- `tests/http/conversation-spawn-controller.test.js`: exact body and response.
- `tests/storage/cross-conversation-delivery.test.js`: canonical transactional
  persistence.
- `tests/runtime/turn-orchestrator.test.js`: bootstrap stays in the side lane but
  uses ordinary user authority.
- `tests/smoke/server-smoke.test.js`: real local HTTP spawn and receipt lookup.

### 1. Scope / Trigger
- Trigger: changing the `Chat bridge tools` prompt block in `server/domain/conversation/turn/agent-prompt.ts`.
- Goal: keep per-turn tool instructions compact while preserving operational safety, routing behavior, and command signatures that agents need to act correctly.

### 2. Signatures
- Public send: `node <agentToolRelativePath> send-public [--no-finalize] --content-stdin`; the CLI maps `--no-finalize` to JSON `noFinalize: true` on `POST /api/agent-tools/post-message`.
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
- Successful `send-public` bridge calls in normal conversation turns must request runtime completion through the active run handle so the model does not need a second full-context call just to emit `{ "action": "final" }`; the final stored reply remains the last public bridge content.
- `noFinalize: true` is the explicit exception for interim public updates: the bridge still persists/broadcasts the public content and tool telemetry, but it must not request active-run completion or set `publicPostCompletionRequested`. A later public post without `noFinalize: true` in the same invocation must still request completion normally. Only the JSON boolean `true` suppresses completion; missing, false, or non-boolean values keep the default finalize behavior.
- Keep `tool_instructions` focused on compact command signatures and group low-frequency tools into capability lines rather than listing preview/apply/overwrite examples separately.
- Dynamic skill loading stays a single conditional `dynamic_skill_loading` section: descriptor-only skills are loaded by reading the listed `Path`, which already points to `SKILL.md`.
- Do not advertise deprecated memory card bridge commands in `Chat bridge tools`.

### 4. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| Prompt includes chat bridge guidance | Contains public/private heredoc templates in `command_format_rules`, bash-only guidance, safety rules, and compact tool signatures in `tool_instructions`, including the interim-only `--no-finalize` exception. |
| Public post omits `noFinalize` or sends a value other than boolean `true` | Persist/broadcast the post and request runtime completion once. |
| Public post sends `noFinalize: true` | Persist/broadcast the post, keep the invocation active, and allow a later normal public post to request completion. |
| Dynamic skill descriptors are present | Includes the one-line dynamic `read`/`Path` guidance as `dynamic_skill_loading`. |
| No descriptor-only skills are present | Omits the dynamic skill-loading guidance. |
| Search-memory guidance is present | States that long-term memory is not automatic and lists only core commands plus compact optional filters. |
| Trellis write guidance is present | States preview-by-default, `--confirm` to write, and `--force` dangerous without separate overwrite examples. |
| Deprecated memory cards exist | Prompt still omits `list-memories`, `save-memory`, `update-memory`, `forget-memory`, and curated memory card sections. |

### 5. Good/Base/Bad Cases
- Good: shared format/safety rules appear once in `command_format_rules`, routing appears in `rules` / `routing_instructions`, and grouped send, retrieval, governance, write, and experience lines stay in `tool_instructions`.
- Good: an agent uses `send-public --no-finalize` for a progress update, continues tool work, then uses normal `send-public` for the final public reply.
- Base: a new bridge command adds one compact signature plus any unique safety rule, not a repeated heredoc tutorial.
- Bad: treating every successful public post as terminal after the caller explicitly sent `noFinalize: true`.
- Bad: removing `search-memory` trigger wording, hiding `--force` danger, or reintroducing deprecated memory card commands to save a few tokens.

### 6. Tests Required
- `tests/runtime/turn-orchestrator.test.js` should assert bash/heredoc guidance, compact search-memory filters, the `--no-finalize` interim-update contract, write-experience sparse-use warning, and absence of deprecated memory commands.
- `tests/runtime/agent-chat-tools.test.js` should assert `--no-finalize` forwards JSON `noFinalize: true`.
- `tests/runtime/agent-tool-bridge.test.js` should assert a `noFinalize: true` public post does not call the completion hook and that a later normal public post still calls it once.
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

#### Wrong
```typescript
requestPublicPostCompletion(context, payload);
```
- This terminates the current run even when the CLI explicitly sent `noFinalize: true` for an interim update.

#### Correct
```typescript
if (body.noFinalize !== true) {
  requestPublicPostCompletion(context, payload);
}
```
- This preserves automatic completion by default while keeping interim public updates non-terminal.

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
  - Request: `{ invocationId, callbackToken, title, category?, scenario?, context?, steps?, pitfalls?, validation?, artifacts?, confidence? }`
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
- `tests/runtime/agent-chat-tools.test.js`: CLI forwards the bounded payload to `/api/agent-tools/experience/write`, supports pitfalls/limitations aliases, and surfaces field-level error issues.
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

## Test Expectations

- Runtime changes should usually be covered by `tests/runtime/agent-tool-bridge.test.js`
  or `tests/runtime/turn-orchestrator.test.js`; `search-memory` recall-cache
  changes must assert bridge metadata persistence, usage promotion, and prompt injection
- Conversation memory changes should also keep `tests/storage/chat-store.test.js`
  and `tests/runtime/agent-chat-tools.test.js` in sync with the bridge/prompt
  contract.
- Tool trace aggregation and redaction changes should also be covered by
  `tests/runtime/message-tool-trace.test.js`

## Bounded Live Observability Timeline

- Each assistant invocation owns one observability sequencer shared by the
  executor and its registered bridge context. Re-running the same Agent in the
  same turn creates a fresh sequencer for the new assistant message; the
  reusable turn stage carries UI lifecycle state only. `message_end` emits the
  model event before the tool projection from the same assistant message, and
  duplicate `agent_end` copies do not allocate another model sequence.
- Model and tool events carry stable `eventId`, typed `eventType`, and positive
  `timelineSequence`. Running tool updates reuse the original identity and
  sequence. SSE contains normalized usage and redacted step summaries only;
  assistant text, thinking blocks, prompts, and raw provider payloads are absent.
- The shared window retains at most 16 mixed events (`first 1 + latest 15`).
  Full model/tool counters, failure counts, duration, token usage, and cost stay
  authoritative and are never recomputed from retained rows.
- Historical bridge projection reads at most its first row plus latest 199 rows
  and obtains full count/failure/success/duration aggregates in SQL. All HTTP
  detail arrays derive from the final 16-event timeline window.
- New terminal message detail is table-first and avoids session JSONL parsing.
  If a legacy unified row reports more model calls than that message's
  authoritative model-usage detail, it is treated as cross-message
  contamination and projected from the message's own session/task evidence
  without rewriting either audit source. Historical messages without unified
  detail retain the same bounded compatibility path.
- If the change affects pi runtime CLI behavior, also inspect
  `tests/runtime/pi-runtime.test.js`
- Dynamic skill path-loading prompt behavior is covered by `tests/runtime/skill-loading.test.js`
