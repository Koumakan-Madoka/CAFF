# PRD: Hermes-inspired memory and skill iteration (Umbrella)

## Goal

- 将 Hermes 调研结论沉淀为 CAFF 的长期架构方向，而不是把所有实现塞进同一个任务。
- 明确分层记忆、skill-test 隔离、skill 自迭代三条线的边界与依赖关系。
- 将后续实现拆成可独立验证、可回滚、可排期的子任务。

## Problem Statement

- CAFF 已有消息持久化、动态 skill 加载和 skill-testing 基础设施，但 memory 与 skill 自迭代属于不同风险模型。
- 记忆能力主要影响 storage / prompt / tool bridge 的上下文召回与写入治理。
- skill-test 隔离主要影响 skill-testing / runtime / sandbox backend / Trellis project virtualization 的发布闸可信度。
- 如果继续放在同一个实现任务中，测试边界、回归矩阵和发布节奏会互相缠绕，容易造成 scope creep。

## Task Split

### Child A: Layered Memory Foundation

- Task path: `.trellis/tasks/04-13-layered-memory-foundation/`
- Branch metadata: `feat/layered-memory-foundation` from `main`
- Owns L2 episodic recall and L1 curated memory cards.
- Covers message retrieval, scoped memory cards, prompt injection, memory write safety, and future forget/update/cleanup flow.
- Does not own skill proposal, skill publish gate, OpenSandbox, or skill-test isolation.

### Child B: Cross-Conversation L1 Memory

- Task path: `.trellis/tasks/04-13-cross-conversation-l1-memory/`
- Branch metadata: `feat/hermes-memory-skill-iteration` follow-up on the umbrella branch
- Promotes L1 durable memory to `local-user + agent` scope while preserving `conversation + agent` overlay precedence.
- Covers schema migration, visible-memory merging, prompt injection updates, and agent-isolation regressions.
- Does not own multi-user identity, cross-agent sharing, or large memory-management UI.

### Child C: Skill-Test Isolation Foundation

- Task path: `.trellis/tasks/04-13-skill-test-isolation-foundation/`
- Branch metadata: `feat/skill-test-isolation-foundation` from `main`
- Owns `OpenSandbox + thin bridge/policy` as the container-first skill-test isolation foundation.
- Covers run/case isolation contracts, Trellis fixture/snapshot modes, independent store/env/path policy, network policy, audit evidence, and pollution checks.
- Does not own L1/L2 memory implementation or agent-facing skill proposal publishing.

### Deferred Child: Skill Proposal And Publish Gate

- Should be opened only after the isolation foundation has a reliable default gate.
- Will own draft skill proposal storage, patch review, scan/test/publish flow, rollback metadata, and human approval semantics.
- Must depend on isolated skill-testing rather than directly writing shared published skills.

## Scope

### In Scope For This Umbrella

- Record the CAFF-specific layered model:
  - L1: curated long-term memory cards
  - L2: episodic recall over persisted messages
  - L3: procedural memory via skills and draft proposals
- Define child task boundaries and dependency order.
- Keep safety defaults explicit for multi-agent rooms: scoped memory, draft/published skill separation, and no unbounded shared writes.
- Preserve the OpenSandbox decision as the preferred container backend candidate for skill-test isolation.

### Out Of Scope For This Umbrella

- Implementing new memory code after the split; that belongs to `04-13-layered-memory-foundation`.
- Implementing OpenSandbox integration; that belongs to `04-13-skill-test-isolation-foundation`.
- Implementing agent-facing skill proposal / publish gate before isolation is in place.
- Fully automated shared-skill publication without human review.
- External vector DB adoption or large frontend management-console redesign.

## Architecture Decisions

### Layered Memory

- L1 memory cards should stay small, curated, and scoped; initial safe default is `conversation + agent` scope with TTL/status/budget controls.
- L2 episodic recall should retrieve bounded historical public messages on demand, with diagnostics and result limits, instead of expanding default prompt history.
- Memory writes must reject obvious secrets, transient TODO/next-step notes, and cross-agent/cross-conversation scope pollution.

### Skill-Test Isolation

- Skill-test isolation must be treated as a publish-gate prerequisite, not a best-effort cleanup step.
- MVP direction is `OpenSandbox + thin bridge/policy`, where OpenSandbox provides container boundary and CAFF bridge/policy provides tool/path/db/Trellis/audit governance.
- The isolation granularity remains `run`-level read-only snapshot + `case`-level writable environment + `turn`-level shared case state.
- Trellis access modes should be `none | fixture | readonlySnapshot` by default; `liveExplicit` is only for manual opt-in validation and must not enter automatic regression/publish gates.

### Skill Self-Iteration

- Skill proposals must be draft-first and isolated from shared published skills.
- Proposal publication must pass isolated skill-testing and safety scans before any shared skill write.
- This umbrella records the dependency, but implementation waits for the isolation child task.

## Child Task Contracts

### Memory Child Must Define

- Storage and repository contracts for message recall and memory cards.
- Runtime/tool bridge commands and their invocation scope.
- Prompt injection budget and default compatibility behavior.
- Safety scan, TTL, conflict/upsert, cleanup, and test expectations.

### Isolation Child Must Define

- `SkillTestIsolationContext` / driver boundary for `OpenSandbox`.
- Per-run and per-case resource layout, including env variables and store paths.
- Bridge/policy contract for tool whitelist, path rewriting, Trellis project root rewriting, independent SQLite/store, network policy, and audit logs.
- Fixture/snapshot handling for Trellis-related skills.
- Pollution checks and failure diagnostics that can support a future publish gate.

## Acceptance Criteria

- [x] Memory and skill-test isolation have separate child task directories and PRDs.
- [x] Child task metadata binds each implementation line to a dedicated branch name with `main` as base.
- [x] This umbrella PRD records the architecture split and dependency order.
- [x] Memory implementation and verification are completed under `04-13-layered-memory-foundation`.
- [x] Skill-test isolation implementation and verification are completed under `04-13-skill-test-isolation-foundation`.
- [x] Skill proposal / publish gate remains deferred as a follow-up task outside this umbrella closure.

## Technical Notes

- Memory child likely touches: `storage/sqlite/`, `storage/chat/`, `lib/chat-app-store.ts`, `server/domain/runtime/agent-tool-bridge.ts`, `server/domain/conversation/turn/agent-prompt.ts`, `server/domain/conversation/turn/agent-executor.ts`, `lib/agent-chat-tools.ts`, and runtime/storage tests.
- Isolation child likely touches: `server/api/skill-test-controller.ts`, `server/domain/conversation/turn/agent-sandbox.ts`, `server/domain/runtime/agent-tool-bridge.ts`, `lib/pi-runtime.ts`, `lib/skill-registry.ts`, `tests/skill-test/`, and sandbox backend integration code.
- OpenSandbox can provide the container boundary, but it does not replace CAFF's bridge/policy semantics for tool permissions, Trellis virtualization, DB routing, and audit evidence.
- Existing memory work in the current branch should be checked and finished through the memory child task rather than expanding this umbrella further.
