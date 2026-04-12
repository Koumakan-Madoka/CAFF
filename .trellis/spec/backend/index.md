# Backend Index

Use this index for changes in `server/api/`, `server/app/`, `server/http/`, and
backend domain services.

## Scope

- HTTP route handlers and request parsing
- App bootstrapping and server wiring
- Domain services that support chat, games, metrics, or projects
- Backend changes that may affect prompt assembly or active project resolution
- Skill testing framework (skill-test-controller.ts)
- Skill management and configuration (skills-controller.ts)

## Pre-Development Checklist

- [ ] Read `architecture.md`
- [ ] Read `controller-patterns.md` if you touch controllers, request parsing, or
      HTTP responses
- [ ] Also read `../runtime/index.md` if the change touches agent execution,
      prompt context, sandbox env vars, or tool bridge behavior
- [ ] Read `../guides/cross-layer-thinking-guide.md` when data crosses backend,
      runtime, and UI boundaries
- [ ] Read `../skills/index.md` if working with skill testing, skill management, or skill loading

## Documents

- `architecture.md`: backend module boundaries and ownership
- `controller-patterns.md`: handler conventions, error flow, and response shape
- See `../skills/` for skill-related backend patterns (skill-test-controller.ts, skills-controller.ts)
