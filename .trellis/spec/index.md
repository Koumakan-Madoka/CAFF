# CAFF Spec Index

This directory holds CAFF-specific guidance for Trellis context injection in a
pi-mono based project.

## Repo Shape

- `server/`: Node/TypeScript backend, HTTP controllers, domain services
- `public/`: browser-side JavaScript pages and shared UI modules
- `lib/`: pi-mono runtime helpers, chat bridge tooling, skill registry, and skill test generator
- `tests/`: node:test suites, with runtime tests using built artifacts
- `.trellis/`: task, PRD, spec, and workflow context injected into agent prompts
- `.pi-sandbox/`: pi sandbox runtime state, skills directory, agent sandboxes, and game state

## Spec Areas

- `backend/`: API controllers, server wiring, HTTP flow, domain services
- `frontend/`: browser UI modules under `public/`
- `runtime/`: pi-mono runtime, prompt construction, agent tool bridge
- `unit-test/`: test patterns and regression expectations
- `skills/`: skill system, dynamic loading, and skill testing framework
- `guides/`: shared thinking guides to read on cross-layer or platform-sensitive work

## Which Index To Read

- Changing `server/api`, `server/app`, or `server/http`:
  read `backend/index.md`
- Changing `server/domain/runtime`, `server/domain/conversation/turn`, or `lib/`
  pi runtime code:
  read `runtime/index.md`
- Changing `public/`:
  read `frontend/index.md`
- Adding or changing tests in `tests/`:
  read `unit-test/index.md`
- Working with skills (lib/skill-registry.ts, lib/skill-test-generator.ts, server/api/skill-test-controller.ts):
  read `skills/index.md`
- Spanning multiple layers:
  read all relevant indexes plus `guides/index.md`

## Working Rule

Indexes are entry points, not the final source of truth. Follow the
"Pre-Development Checklist" inside each area index and read the concrete docs it
points to before implementing.
