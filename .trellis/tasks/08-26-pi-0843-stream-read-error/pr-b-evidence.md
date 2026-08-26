# PR B Evidence: Exact Stream Read Retry Normalization

## Candidate Basis

- PR B starts from independently approved PR A candidate
  `332c164aa8d6c8df5bbed936c4d651436a603003`.
- PR A parent remains `origin/develop@abf00a112d5455316aef818513b38c2cc65e4137`.
- Production 3100 was not read, written, restarted, reconfigured, or deployed.
- No network provider, credential, production database, or external delivery was
  used by the controlled fixtures.

## Red-First Evidence

The real PI test uses 0.84.3 `Agent` + `AgentSession`, an in-memory session and
settings manager, deterministic assistant streams, and the production extension
path before the extension existed.

Command:

```text
node --test tests/runtime/pi-stream-read-retry.test.js
```

Exact PR A behavior: 9 pass / 4 fail.

- one exact error then success: behavior assertion failed `1 !== 2` provider
  calls;
- four exact errors: behavior assertion failed `1 !== 4`;
- partial-text recovery: behavior assertion failed `1 !== 2`;
- completed-tool scenario: behavior assertion failed `2 !== 3` before the later
  failed model call could retry.

The non-retry matrix (400/401/403/quota/decorated strings/abort) and ordinary
PI-recognized connection retry already passed. Failures reached observable
provider-call assertions, not module loading or compilation.

The CAFF IPC fixture then reproduced the cross-layer accounting bug on PR A:

```text
node --test --test-name-pattern='native retry' tests/runtime/pi-runtime.test.js
```

It failed with actual reply `discarded partialrecovered final` instead of
`recovered final`, proving PI retry events alone did not reconcile CAFF's
already-forwarded failed attempt.

## Implementation Boundary

- `lib/pi-extensions/caff-stream-read-retry.mjs` registers one official
  `message_end` handler. It maps only assistant + `stopReason=error` + trimmed
  exact `stream_read_error` to `connection error: stream_read_error`.
- `lib/pi-sdk-host.mjs` prepends that built-in extension once to the SDK resource
  loader, preserving caller-supplied extension paths.
- `lib/pi-runtime.ts` separates unresolved assistant errors from attempt history,
  removes only a retried message key's text on `auto_retry_start`, emits
  `assistant_retry_discarded`, and retains every model-call usage.
- `server/domain/conversation/turn/agent-executor.ts` consumes the corrected
  aggregate reply after a discard event. It does not retry the turn.
- No node_modules edit, provider fork, non-streaming mode, CAFF outer retry,
  schema, migration, route, prompt, routing, Goal, private, image, or handoff
  semantic change.

## Focused Green Evidence

System Node v24.13.1, serial where shared runtime/SQLite behavior is involved:

- real PI exact/error/tool matrix: 13/13;
- `pi-runtime` full suite: 35/35;
- `agent-executor-hook`: 11/11;
- SDK host + exact retry + PI package/import probes: 25/25;
- build: pass.

Behavior proved:

- one exact failure then success: two provider calls, retry attempt 1, successful
  retry end, recovered final message;
- four exact failures: four calls, starts 1/2/3, failed retry end at attempt 3,
  final mapped diagnosis;
- failed partial text is absent from PI live context and final CAFF reply;
- completed tool executes once and its result stays in retry context;
- 400/401/403/quota/decorated errors/abort receive zero new retries;
- ordinary connection retry remains unchanged;
- recovery result has `assistantErrors=[]`, one-item diagnostic history, two
  usage calls, SQLite `status=succeeded`, `assistant_errors_json=[]`;
- terminal failure has one unresolved final error, four-item history, four usage
  calls, SQLite `status=failed`, and one final error in
  `assistant_errors_json`;
- executor completed/error detail writes preserve two/four model calls while
  metadata remains lightweight.

## Complete Regression Evidence

- `npm run check`: PASS.
- `npm run typecheck` (source + public): PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS (only existing CRLF normalization warnings on task
  JSONL files).
- Trellis validation: PASS (`implement 22`, `check 15`, `debug 2`).
- Core PI/runtime/Goal/turn/private/handoff/image/detail/SSE/tool batch:
  `318/320`; the only failures are the exact two established Windows after-hook
  `rmSync EPERM` failures for `caff-image-preflight-pass-*` and
  `caff-image-preflight-text-*`. Both test bodies completed, and the exact PR A
  baseline has the same failures.
- Additional provider/catalog/storage/bridge batch: `124/124`.
- Server smoke: `70/70`; mode store: `4/4`.
- DAG execution: `55 + 8 + 8 + 3 + 3 = 77/77`.
- DAG planning: `46/47`, identical to PR A. The sole failure is the unchanged
  async demo assertion observing `规划图加载中…` instead of `执行中`.
- Dependency tree: coding-agent and every PI AI node `0.84.3`; every TypeBox
  node `1.3.7`; no deprecated `@mariozechner/pi-ai`.
- `npm audit --omit=dev`: four existing transitive findings (Axios and fast-uri
  high; DOMPurify and Mermaid moderate), none in the PI family and no dependency
  diff in PR B. No audit fix was run.
- Added-lines credential/secret scan found no real credential. It reported two
  intentional static `fixture-key` values in the no-network PI test harness;
  both are local fake auth required by `AgentSession`. A broader first pass also
  matched the `sk-` substring inside the internal test id
  `trace-task-native-retry-1`; the boundary-aware `sk-` rerun excluded it.
- No `node_modules`, build output, environment, database, or temporary file is
  in the diff.

## Prepared But Not Published

- `.trellis/tasks/08-26-pi-0843-stream-read-error/upstream-draft.md` contains
  sanitized issue and PR wording. It names no local provider, production run,
  credential, or private path and must not be published without separate user
  confirmation.

## Remaining Gates

- Freeze a new exact PR B SHA and request independent commit-pinned review.
- Run isolated fault-injection acceptance for one recovery and four-failure
  terminal closure across UI/SSE/log/usage/status.
- Obtain explicit user acceptance before the ordered PR A then PR B merge
  commits to `develop`.
