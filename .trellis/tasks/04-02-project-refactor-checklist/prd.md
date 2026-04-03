# Project Refactor Checklist

## Goal

Turn the current CAFF codebase from "still shippable but getting expensive to change" into "safe to extend incrementally" without a rewrite.

## Context

The repository already has useful structure:

- `server/http`, `server/api`, `server/domain`, `storage`, `public`, and `tests` are separated.
- Core runtime and storage tests currently pass.
- Turn orchestration has already started to move into dedicated modules.

The main problem is not total disorder. The problem is that several high-change, high-complexity modules still carry too many responsibilities, and some newer modules still depend on older `lib/*` implementations.

## Key Findings

- `server/app/create-server.ts` is still a high-pressure composition root that wires together store, runtime bridge, games, controllers, SSE, and project state.
- `server/domain/runtime/agent-tool-bridge.ts` has become a large multi-tool runtime/service/telemetry module.
- `server/domain/conversation/turn/agent-executor.ts` owns a long run lifecycle with queueing, persistence, tool invocation, streaming updates, replay fallback, and error handling.
- `public/app.js` has begun to delegate into `public/chat/*`, but still acts as a large state/event/orchestration shell.
- `lib/chat-app-store.ts` has repository composition now, but still remains a thick facade with validation, normalization, transactions, and domain-ish behavior mixed together.
- The repo is not failing structurally, but static confidence is slipping: `npm run test:fast` passes while `npm run typecheck` currently fails in frontend files.

## Non-Goals

- Do not rewrite the app from scratch.
- Do not switch frontend framework.
- Do not replace SQLite.
- Do not attempt one mega-PR that moves every layer at once.

## Refactor Strategy

Use staged, production-preserving refactor work:

1. Restore guardrails first.
2. Extract repeated execution flows and hotspots.
3. Shrink large files by responsibility, not by arbitrary slicing.
4. Enforce new placement rules so new features stop flowing back into the hotspots.

## Prioritized Checklist

### P0 - Stop Drift

- [ ] Make `typecheck` part of the default validation path and fix the current frontend type errors.
- [ ] Keep `test:fast` green while refactor work proceeds.
- [ ] Establish a rule that new chat UI logic goes to `public/chat/*` and shared page utilities go to `public/shared/*`.
- [ ] Establish a rule that new backend orchestration code does not get added back into `server/app/create-server.ts`.
- [ ] Document the current hotspot files and intended target boundaries before larger extraction work begins.

### P1 - Runtime and Execution Flow

- [ ] Extract the common "register invocation -> start run -> collect result -> unregister invocation" lifecycle used by conversation runs, eval cases, and skill tests.
- [ ] Split `server/domain/runtime/agent-tool-bridge.ts` by responsibility.
- [ ] Move repeated task/run-store update patterns behind dedicated helpers or a runtime service.
- [ ] Keep behavior stable with regression tests around tool invocation, dry-run mode, and cancellation.

Target split inside `agent-tool-bridge`:

- message tools
- read-only context tools
- Trellis init/write tools
- telemetry helpers
- invocation validation and lookup

### P1 - Frontend Shell Reduction

- [ ] Continue shrinking `public/app.js` so it becomes a page shell instead of a mixed state/render/event file.
- [ ] Move conversation event wiring and action handlers into focused modules where practical.
- [ ] Remove remaining duplicated DOM/data access patterns across `public/app.js`, `public/skills.js`, and `public/skill-tests.js`.
- [ ] Ensure new pages reuse shared utilities for fetch, model options, avatar handling, and toast behavior.

### P1 - Store and Domain Boundaries

- [ ] Keep repository access in `storage/*` and reduce behavior living in `lib/chat-app-store.ts`.
- [ ] Extract normalization/validation helpers that are currently embedded inside the store facade when they are reusable or independently testable.
- [ ] Define clearer boundaries between chat persistence, run/task persistence, domain services, and transport/controller code.

### P2 - Composition Root Cleanup

- [ ] Reduce `server/app/create-server.ts` to composition, dependency wiring, and process lifecycle only.
- [ ] Move project activation, bridge callbacks, and feature-specific setup behind narrower factories where possible.
- [ ] Keep gameplay services and skill/eval systems isolated from general chat bootstrapping as much as possible.

### P2 - Policy and Documentation

- [ ] Record file placement rules for future contributors.
- [ ] Record which duplicated flows were intentionally unified and where the new single source of truth lives.
- [ ] Update Trellis specs or repo docs after each major refactor slice so new contributors follow the new boundaries.

## Suggested Execution Order

1. Fix the failing frontend typecheck items and wire `typecheck` into the standard quality gate.
2. Extract shared run lifecycle helpers from `agent-executor`, `eval-cases-controller`, and `skill-test-controller`.
3. Split `agent-tool-bridge` into smaller internal modules while preserving public behavior and tests.
4. Continue carving `public/app.js` down toward page-shell responsibilities only.
5. Thin `lib/chat-app-store.ts` further by moving behavior to storage/domain helpers with tests.
6. Shrink `create-server.ts` after the lower-level pieces are cleaner.

## First Candidate PRs

- PR 1: fix current typecheck failures and make `typecheck` part of the default test path
- PR 2: extract shared runtime run-lifecycle helper used by conversation, eval case, and skill test execution
- PR 3: split `agent-tool-bridge` into message tools, read tools, Trellis tools, and telemetry helpers
- PR 4: extract more event/action logic from `public/app.js`
- PR 5: reduce `chat-app-store` to a thinner facade with targeted helper extraction

## Acceptance Criteria

- [ ] A contributor can identify where to place new runtime, store, and chat UI code without guessing.
- [ ] `npm run typecheck` and `npm run test:fast` both pass.
- [ ] At least one of the duplicated run lifecycle flows has been unified.
- [ ] At least one hotspot file is measurably smaller because a real responsibility was extracted.
- [ ] New work stops increasing the size of known hotspot files.

## Success Metric

Success is not "perfect architecture". Success is:

- safer incremental change
- fewer cross-file edits for one feature
- fewer duplicated lifecycle implementations
- clearer ownership of runtime, UI shell, and storage responsibilities
