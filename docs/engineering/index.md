# CAFF Engineering Index

This directory contains the current, executable engineering contracts for CAFF.
Historical delivery records are recoverable from Git; they are not a second
runtime truth source.

## Repository Shape

- `server/`: Node/TypeScript backend, HTTP controllers, and domain services
- `public/`: browser-side JavaScript pages and shared UI modules
- `lib/`: runtime helpers, chat bridge tooling, skill registry, and DAG helpers
- `tests/`: `node:test` suites, with runtime tests using built artifacts
- `docs/engineering/`: current contracts and development guidance
- `docs/decisions/`: accepted cross-task architecture decisions
- `.agents/`: project workflow and planning skills
- `.pi-sandbox/`: local Pi runtime state, skills, Agent sandboxes, and game state

Goal metadata is the delivery authority. CAFF does not inject project PRDs,
task JSONL ledgers, or a project-local current-task pointer into prompts.

## Areas

- `backend/`: API controllers, server wiring, HTTP flow, and domain services
- `frontend/`: browser UI modules under `public/`
- `runtime/`: Pi runtime, prompt construction, and Agent tool bridge
- `unit-test/`: test patterns and regression expectations
- `skills/`: skill discovery, loading, and execution contracts
- `guides/`: cross-layer, reuse, and platform-sensitive engineering guidance
- `archive/`: historical reference only; never treat it as a current contract

## Reading Path

- Changes under `server/api`, `server/app`, or `server/http`: read
  `backend/index.md` and the relevant domain contract.
- Changes under `server/domain/runtime`, `server/domain/conversation/turn`, or
  Pi-related `lib/`: read `runtime/index.md`.
- Changes under `public/`: read `frontend/index.md`.
- Test changes: read `unit-test/index.md`.
- Skill changes: read `skills/index.md`.
- Cross-layer changes: read all applicable indexes and `guides/index.md`.

Indexes are entry points. Follow their links to concrete signatures, validation
matrices, and required tests before implementation.
