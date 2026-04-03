# Research: Project Refactor Checklist

## Summary

This repository does not need a rewrite. It needs a controlled, incremental refactor plan focused on hotspot reduction, duplicate lifecycle cleanup, and stronger guardrails.

## What Looks Healthy

- Top-level layering exists: `server`, `storage`, `public`, `tests`, `lib`
- `server/http/router.ts` is already small and focused
- `server/domain/conversation/turn-orchestrator.ts` is a good example of a narrow composition module
- Core runtime/storage tests pass through `npm run test:fast`

## What Makes Change Expensive

### 1. Large hotspot files

- `server/domain/runtime/agent-tool-bridge.ts`
- `server/domain/conversation/turn/agent-executor.ts`
- `server/domain/werewolf/werewolf-service.ts`
- `public/app.js`
- `lib/chat-app-store.ts`
- `lib/pi-runtime.ts`

These files are not automatically bad just because they are large. They are risky because they mix multiple responsibilities and are likely to absorb future work.

### 2. New structure still depends on old structure

The newer `server/*` organization still depends heavily on `lib/*` runtime/store/game modules. That means some refactor benefits have landed, but the old center of gravity still exists.

### 3. Duplicated run lifecycle logic

The run lifecycle in:

- conversation agent execution
- eval case replay
- skill test execution

shares the same broad sequence:

- create run/task bookkeeping
- register tool invocation
- start a provider run
- update task state
- await result
- unregister tool invocation

This is the best first backend cleanup target because it reduces drift without changing the product shape.

### 4. Frontend shell still too heavy

`public/app.js` is partly modularized already, but still owns:

- app state
- DOM wiring
- runtime update handling
- action orchestration
- many page events

It should keep moving toward a shell/composition role.

### 5. Guardrails are incomplete

Observed status during review:

- `npm run test:fast`: passing
- `npm run typecheck`: failing

Current frontend typecheck failures were found in:

- `public/skill-tests.js`
- `public/skills.js`

This is a warning sign that code evolution is starting to outrun static verification.

## Hotspot Ranking

### Highest ROI

1. Shared run lifecycle extraction
2. `agent-tool-bridge` responsibility split
3. `public/app.js` shell reduction

### Next

4. `lib/chat-app-store.ts` thinning
5. `server/app/create-server.ts` cleanup

### Later

6. Further gameplay service cleanup
7. Broader `any` reduction and typing improvement in runtime/store hotspots

## Risks to Avoid

- Do not merge large behavior changes with structural extraction in the same PR.
- Do not move code without adding or preserving regression coverage around runtime flows.
- Do not let new features continue landing in the known hotspots during the refactor.
- Do not try to fully eliminate `lib/*` dependencies in one pass.

## Recommended Rules During Refactor

- Extract one responsibility at a time.
- Preserve API behavior first, then tighten internal shape.
- Prefer "single source of truth" cleanup over superficial file splitting.
- Treat `typecheck` parity as a gating condition, not a nice-to-have.

## Proposed Workstreams

### Workstream A: Guardrails

- fix failing typecheck
- make typecheck part of the standard validation path

### Workstream B: Runtime lifecycle unification

- unify run/task/invocation bookkeeping across execution entry points

### Workstream C: Runtime tool bridge split

- isolate message tools, read tools, Trellis tools, and telemetry helpers

### Workstream D: Frontend shell cleanup

- move app-page orchestration details out of `public/app.js`

### Workstream E: Store boundary cleanup

- reduce `chat-app-store` to a thinner orchestration facade over storage repositories
