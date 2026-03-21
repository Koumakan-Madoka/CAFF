# A2A Implementation Study for `caff` (No-MCP First)

Date: 2026-03-21

## 0. Executive summary

This repository should implement A2A in a **No-MCP-first** way.

That means:

- keep `pi` as the local agent runtime,
- use `skill + local server` for tool and helper integration,
- add a supervisor that can coordinate multiple local or remote agents,
- expose the whole runtime through an A2A-facing server only after the local orchestration model is stable.

The shortest useful path for this repo is:

1. refactor `invoke()` into an event-driven runner,
2. add a local supervisor that can launch child agents,
3. persist parent/child task state in SQLite,
4. add an A2A server facade on top of the same runtime.

This document uses that path as the main recommendation.

## 1. Current project baseline

This repository already has the core pieces of an agent runtime:

- `minimal-pi.js` starts `pi`, binds sessions, parses structured JSON output, supervises heartbeats, and persists run metadata.
- `sqlite-store.js` already works as a durable run ledger.
- `pi-heartbeat-extension.mjs` already emits liveness signals that can later be translated into task updates.

This means the project does **not** need a full rewrite to support agent-to-agent collaboration. It mainly needs:

1. an internal task model,
2. a supervisor/orchestrator layer,
3. a protocol adapter for external A2A interoperability.

## 2. Mainstream approaches as of 2026-03-21

### A. A2A Protocol (open agent-to-agent protocol)

Best fit when agents must interoperate across processes, teams, runtimes, or vendors.

Why it matters:

- It is the clearest open standard for agent-to-agent communication.
- The current spec exposes `AgentCard`, task lifecycle, streaming, subscriptions, and push notifications.
- The latest public roadmap says the protocol `1.0` release was a near-term priority and the roadmap page was last updated on March 10, 2026.

Important implementation note for Node.js:

- The public protocol docs are already at `v1.0`.
- Local `npm view` checked on 2026-03-21 shows `@a2a-js/sdk` latest version is `0.3.13`.
- That version skew means this repo should keep an internal adapter layer instead of wiring business logic directly to SDK-specific types.

Verdict for this repo:

- This should be the **external contract** if the goal is real cross-agent interoperability.

### B. OpenAI Agents SDK handoffs / agents-as-tools

Best fit for intra-application multi-agent delegation.

Why it matters:

- It has two very practical patterns: manager agents and handoffs.
- It already supports agent delegation, typed tools, and tracing.
- It is a strong framework-level orchestration choice.

Limit:

- It is **not** a cross-vendor wire protocol in the same sense as A2A.
- It is best thought of as an in-process orchestration runtime, not the public interoperability boundary.

Verdict for this repo:

- Useful as inspiration for local supervisor design.
- Not the best first step as the public A2A interface of this Node project.

### C. LangChain / LangGraph multi-agent patterns

Best fit for graph-based orchestration, supervisor/subagent routing, checkpointing, and context isolation.

Why it matters:

- LangChain JS now documents explicit multi-agent patterns such as subagents, handoffs, and supervisor flows.
- It is a very good fit when the central problem is orchestration and workflow control.

Limit:

- Adopting it here would partially replace the existing runtime instead of extending it.
- This repo already has a working process/runtime boundary around `pi`; throwing that away too early would add migration cost.

Verdict for this repo:

- Good as an optional orchestration layer above `invoke()`.
- Not the first thing to standardize around.

### D. Microsoft Agent Framework

Best fit for enterprise workflow execution with typed executors, checkpoints, and mixed agent/non-agent steps.

Why it matters:

- Microsoft documents sequential, concurrent, handoff, and multi-agent workflow patterns.
- It is a serious workflow-centric option for larger systems.

Limit:

- Heavier workflow abstraction than this repo currently needs.
- More natural for Python/.NET-heavy stacks than for this small Node-first codebase.

Verdict for this repo:

- Useful reference architecture.
- Low priority as the first implementation path.

## 3. Recommendation for `caff`

The best fit is a **3-layer architecture**:

1. **Agent Runtime Layer**
   Keep `pi` plus `minimal-pi.js` as the execution engine for local agents.
2. **Supervisor / Orchestration Layer**
   Add a controller that decides whether to answer directly, spawn local child agents, or delegate to remote A2A agents.
3. **A2A Gateway Layer**
   Expose the runtime through an A2A-compatible HTTP interface with Agent Card and task APIs.

Why this fits the current code:

- `minimal-pi.js` already solves session binding, heartbeat supervision, and structured output parsing.
- `sqlite-store.js` already gives a durable persistence point.
- `pi-heartbeat-extension.mjs` already acts like task liveness telemetry.
- The current local `pi` CLI surface does not expose a native external tool protocol configuration surface in `pi --help`, so this design should not assume that kind of integration.

In short:

- keep the runtime,
- add orchestration,
- keep the tool layer custom at first if that is faster,
- then add protocol exposure.

More concretely for this repo:

- `pi` is the execution engine.
- `minimal-pi.js` becomes the reusable runtime adapter.
- `skill + local server` handles helper capabilities and local service calls.
- a new supervisor module handles delegation, routing, and fan-out/fan-in.
- a later `a2a-server.js` exposes the same runtime to external agents.

## 4. Mapping the current code to A2A concepts

| A2A concept | Current repo mapping | Next change |
| --- | --- | --- |
| Agent Card | none yet | add static or generated `agent-card.json` |
| `contextId` | session path / named session | add explicit stable context IDs |
| `taskId` | `runId` is close but not public-safe | add dedicated A2A task IDs |
| Send message | `invoke(prompt, options)` | wrap with JSON-RPC or REST handler |
| Streaming updates | parsed JSON events + heartbeats | emit task status and artifact events |
| Cancel task | terminate child process tree | expose cancellation API |
| Task store | `runs` table | add public task/event/artifact tables |
| Artifacts | final reply text, possible files | persist explicit artifact records |
| Push notifications | not implemented | add optional webhook dispatcher |

## 5. Minimum viable implementation plan

### Phase 1: internal A2A first

Goal: prove multi-agent coordination **without** adding a network protocol yet.

Changes:

- Add a supervisor module that can call `invoke()` multiple times with different `session` names and role-specific prompts.
- Add parent/child run linkage in SQLite.
- Use `skill + local server` as the tool bridge.
- Add basic routing rules such as:
  - planner agent,
  - coder agent,
  - reviewer agent,
  - summarizer agent.

Result:

- one local "agent talks to another agent" flow,
- reusing the runtime you already trust.

### Phase 2: expose an external A2A facade

Goal: let external agents call this repo as a remote agent.

Changes:

- Add `a2a-server.js`.
- Expose at least:
  - Agent Card
  - SendMessage
  - GetTask
  - SubscribeToTask
  - CancelTask
- Convert the current blocking `invoke()` into a lower-level event-driven runner.

Result:

- your project becomes a network-visible A2A server.

### Phase 3: hybrid ecosystem

Goal: combine local agents, remote A2A agents, and reusable shared tools.

Changes:

- Let child agents use local services for tools/resources.
- Let the supervisor choose between:
  - local `pi` child agents,
  - remote A2A agents,
  - direct tool calls.
- Add auth, quotas, idempotency, and push notifications.

Result:

- production-ready multi-agent architecture instead of only local orchestration.

## 6. Concrete implementation blueprint for this repo

If we implement the No-MCP-first plan here, the work should map to files like this:

- `minimal-pi.js`
  - split `invoke()` into `startRun()` and `invoke()`
  - expose structured runtime events
  - expose `cancel()` cleanly
- `sqlite-store.js`
  - add parent/child task linkage
  - add public A2A task records
  - add task event history
- `pi-heartbeat-extension.mjs`
  - keep as the liveness signal source
  - optionally enrich heartbeat payloads only if task-state mapping needs more detail
- `supervisor.js` or `a2a-supervisor.js`
  - choose whether to answer directly, spawn a local child agent, or call a remote A2A agent
  - aggregate child outputs into one final result
- `local-tool-server.js`
  - provide stable local capabilities over HTTP or stdio
  - keep this simple and explicit instead of introducing another protocol layer
- `a2a-server.js`
  - publish agent metadata
  - accept task requests
  - stream task updates
  - support cancellation and task lookup

This file layout keeps responsibilities clean:

- runtime in one place,
- persistence in one place,
- orchestration in one place,
- external protocol exposure in one place.

## 7. The first code refactor I would make

The single most important refactor is to split `invoke()` into two layers:

1. `startRun(...)`
   Returns something like:
   - `runId`
   - `sessionPath`
   - `on(event)`
   - `cancel()`
   - `resultPromise`
2. `invoke(...)`
   A convenience wrapper built on top of `startRun(...)` that waits for completion.

Why this matters:

- A2A needs task lifecycle events, not only a final string reply.
- supervisor/subagent orchestration also benefits from structured intermediate events.
- the current code already parses the right signals; it just does not expose them as a reusable event model yet.

## 8. Schema changes to add next

Keep the existing `sessions` and `runs` tables, but add A2A-specific tables:

- `a2a_tasks`
- `a2a_task_events`
- `a2a_artifacts`

Suggested responsibilities:

- `runs`: raw execution details tied to the local runtime
- `a2a_tasks`: public task lifecycle for protocol consumers
- `a2a_task_events`: streaming/status history
- `a2a_artifacts`: structured outputs, files, or final text payloads

This separation prevents public protocol IDs from being tightly coupled to local filesystem session names or child process behavior.

## 9. What not to do first

- Do not replace the whole runtime with LangGraph or OpenAI Agents SDK before standardizing the internal task model.
- Do not expose remote agents only as plain tools if you need task lifecycle, async execution, or streaming.
- Do not couple public A2A task IDs directly to `sessionPath`.
- Do not assume the current JS SDK version fully erases protocol versioning concerns.

## 10. Recommended next step for this repo

Recommended order:

1. implement **internal supervisor + child-agent orchestration**
2. refactor `invoke()` into an event-driven runner
3. extend SQLite to hold public task state
4. expose the same runtime through an A2A server facade

This order gives the fastest validation with the least rewrite risk.

The practical milestone version of that order is:

1. make `minimal-pi.js` emit reusable events
2. add one happy-path supervisor flow such as `planner -> coder -> reviewer`
3. store the task tree in SQLite
4. wrap the same flow behind an A2A endpoint

## 11. Grounding in this repository

The recommendation above is based on these existing strengths:

- `minimal-pi.js` already has a reusable execution boundary around `pi`.
- `minimal-pi.js` already parses assistant streaming updates and terminal events.
- `minimal-pi.js` already supervises liveness through heartbeat messages.
- `sqlite-store.js` already persists durable execution records.
- `pi-heartbeat-extension.mjs` already emits runtime heartbeat signals.

That combination is unusually close to what an A2A task runtime needs.

## 12. Sources

- A2A Protocol overview and spec:
  - https://a2a-protocol.org/latest/
  - https://a2a-protocol.org/latest/specification/
  - https://a2a-protocol.org/latest/topics/what-is-a2a/
  - https://a2a-protocol.org/latest/whats-new-v1/
  - https://a2a-protocol.org/latest/roadmap/
- OpenAI Agents SDK:
  - https://openai.github.io/openai-agents-js/
  - https://openai.github.io/openai-agents-js/guides/agents/
  - https://openai.github.io/openai-agents-js/guides/handoffs/
  - https://openai.github.io/openai-agents-js/guides/multi-agent/
- LangChain / LangGraph JS multi-agent docs:
  - https://docs.langchain.com/oss/javascript/langchain/multi-agent/index
  - https://docs.langchain.com/oss/javascript/langchain/multi-agent/subagents
  - https://docs.langchain.com/oss/javascript/langchain/multi-agent/handoffs
  - https://docs.langchain.com/oss/javascript/langchain/supervisor
- Microsoft Agent Framework:
  - https://learn.microsoft.com/agent-framework/workflows/
