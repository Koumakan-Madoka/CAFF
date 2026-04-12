## Relevant Specs

- `.trellis/spec/skills/skill-system.md`: defines dynamic loading as `read` on the descriptor `Path` pointing at `SKILL.md`.
- `.trellis/spec/skills/skill-testing.md`: defines dynamic mode as load-only, details trigger detection semantics, and documents the skill test UI/result contract.
- `.trellis/spec/runtime/agent-runtime.md`: documents runtime cancel handles and the live `conversation_tool_event` contract that chat UI already consumes.
- `.trellis/spec/frontend/ui-structure.md`: says page entry files should stay focused and reusable browser UI should live in shared/chat modules.
- `.trellis/spec/backend/controller-patterns.md`: reminds us to keep controller HTTP adapters thin and delegate workflow logic.
- `.trellis/spec/guides/cross-layer-thinking-guide.md`: relevant because this task touches backend, runtime, frontend, and tests.
- `.trellis/spec/guides/code-reuse-thinking-guide.md`: relevant because the requested UI should reuse existing chat workbench trace logic.

## Code Patterns Found

- Dynamic load contract is already regression-tested in `tests/runtime/skill-loading.test.js`.
- Skill test run orchestration currently lives in `server/api/skill-test-controller.ts`, especially the `executeRun(...)` flow that starts the run and waits on `handle.resultPromise`.
- The runtime handle already exposes `cancel(reason)` in `lib/pi-runtime.ts`, which is the most natural stop path for dynamic-mode early exit.
- Completed trace normalization already exists in `server/domain/runtime/message-tool-trace.ts`.
- Live chat trace state and SSE merging already exist in `public/app.js`.
- The existing expandable tool trace renderer already exists in `public/chat/message-timeline.js`.
- The current skill test page (`public/skill-tests.js`) only renders post-run debug details from persisted `toolEvents` and `sessionToolCalls`; it does not yet expose live run progress.

## Files To Modify

- `server/api/skill-test-controller.ts`: add dynamic-mode early-stop logic after confirming target skill load; possibly surface live-run identifiers or trace payloads needed by the UI.
- `lib/pi-runtime.ts`: reuse the existing run handle cancellation path if skill-test execution needs an explicit stop hook.
- `server/domain/runtime/message-tool-trace.ts`: reuse or adapt trace shaping for skill-test live display if the page needs the same merged timeline structure.
- `public/skill-tests.js`: show live tool calls and outputs for the currently running skill-test agent.
- `public/eval-cases.html`: add a live trace surface in the skill test workspace.
- `public/styles.css`: style the live trace block consistently with existing tool-trace UI.
- `public/app.js` and/or `public/chat/message-timeline.js`: extract or reuse existing trace helpers instead of duplicating them inside the skill test page.
- `tests/skill-test/skill-test-e2e.test.js`: cover dynamic early-stop and any response payload changes.
- `tests/runtime/message-tool-trace.test.js`: cover any shared trace contract changes.

## Open Implementation Questions

- Can the skill-test page subscribe to the existing runtime event stream directly, or does it need a narrower skill-test-specific live endpoint?
- Is dynamic early-stop best triggered from live tool-call observation during the run, or from a post-step hook inside the skill test controller that can safely call `handle.cancel(...)` once target load is proven?
- Which trace helpers can move into a smaller shared browser module without over-coupling the skill test page to chat-specific conversation state?

## Implementation Breakdown

### 1. Confirm Current Contracts

- Read `server/api/skill-test-controller.ts` run orchestration and identify where tool events are observed, persisted, and converted into trigger diagnostics.
- Read `lib/pi-runtime.ts` and `server/domain/conversation/turn/agent-executor.ts` to confirm the safest cancellation boundary and how cancellation errors surface to callers.
- Read `public/app.js`, `public/chat/message-timeline.js`, and `server/domain/runtime/message-tool-trace.ts` to map the existing chat live-trace state shape and renderer expectations.
- Inspect existing tests around `skill-loading`, `skill-test`, and `message-tool-trace` before choosing assertion style.

### 2. Backend Dynamic Early Stop

- Add a small matcher that recognizes the expected dynamic skill load evidence: a `read` tool invocation targeting the target skill's `SKILL.md` path, with path normalization for Windows and POSIX separators.
- Wire the matcher into the live tool-event collection path for dynamic trigger runs only.
- On first match, mark trigger-load evidence as successful, record a concise diagnostic, and call the runtime handle's `cancel(...)` with a dedicated reason such as `skill-test-dynamic-load-confirmed`.
- Treat that dedicated cancellation as a successful dynamic trigger outcome instead of a runtime failure.
- Preserve existing no-match dynamic failure diagnostics and all full-mode execution/verdict behavior.

### 3. Live Trace Payload

- Reuse the existing runtime tool-event normalization contract where possible instead of inventing a second shape.
- Ensure active-run state can expose current tool name, summarized args/input, status, and output/result summary when available.
- Keep completed run diagnostics backed by persisted `toolEvents` / `sessionToolCalls`, so final detail views still work after SSE or polling stops.
- Include enough run identity in live events or polling responses to ignore stale events from older skill-test runs.

### 4. Frontend Trace Reuse

- Extract the reusable chat tool-trace rendering/state helpers into a shared browser module if current helpers are too chat-specific.
- Update chat imports to use the shared helper without changing existing chat behavior.
- Add a live trace panel to `public/eval-cases.html` / `public/skill-tests.js` for the currently running skill test.
- Subscribe or poll while a run is active, merge incoming tool events through the shared trace state, and finalize from persisted run details on completion or failure.
- Keep the empty/loading/error states simple: no active run, waiting for first tool call, running tool, completed trace.

### 5. Regression Tests

- Add a dynamic-mode test where the agent reads the expected `SKILL.md`; assert success is recorded immediately and the runtime cancel path is invoked.
- Add a dynamic-mode test where the expected skill is never read; assert existing failure diagnostics remain intact.
- Add a full-mode regression test or existing assertion proving full runs still wait for end-to-end verdict semantics.
- Add tests for any new trace payload normalization or live-run API contract.
- If frontend test infrastructure exists, add a focused DOM/state test for live trace merge/finalization; otherwise document manual UI verification steps in the task notes.

### 6. Suggested Execution Order

1. Backend matcher + early-stop cancellation.
2. Backend tests for dynamic success/failure/full-mode preservation.
3. Shared trace helper extraction with chat behavior kept unchanged.
4. Skill-test live trace UI and payload wiring.
5. Frontend/contract tests and targeted validation.
6. Spec updates for any new event or payload contract.

### 7. Risk Controls

- Keep early-stop gated by `loading_mode === 'dynamic'` and trigger/load-only test paths.
- Do not cancel on arbitrary `read`; require the normalized expected `SKILL.md` path.
- Do not remove persisted diagnostics; live trace is an additional active-run view.
- Avoid copying chat trace renderer wholesale into `skill-tests.js`; extract the smallest reusable pieces instead.
