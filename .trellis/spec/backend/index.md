# Backend Index

Use this index for changes in `server/api/`, `server/app/`, `server/http/`, and
backend domain services.

## Scope

- HTTP route handlers and request parsing
- App bootstrapping and server wiring
- Domain services that support chat, session goals, games, metrics, or projects
- Backend changes that may affect prompt assembly or active project resolution
- Session goal API and metadata contracts (`session-goal.md`)
- Core and role-aware readiness projection (`health-endpoint.md`)
- Conversation digest API, metadata, prompt, and UI contracts (`conversation-digest.md`)
- Digest-to-skill draft extraction and confirmation (`../runtime/skill-extraction.md`)
- Cross-conversation summary segment memory search (`summary-memory.md`)
- Conversation tree DAG plan storage, lifecycle, and plan API (`dag-planning.md`)
- Skill management and configuration (skills-controller.ts)
- Local-admin model provider projection, patching, and token limit fields (`model-provider-config.md`)

## Pre-Development Checklist

- [ ] Read `architecture.md`
- [ ] Read `controller-patterns.md` if you touch controllers, request parsing, or
      HTTP responses
- [ ] Read `model-provider-config.md` if you touch `/api/model-providers`,
      `models.json` persistence, or the provider editor
- [ ] Read `feishu-integration.md` if you touch Feishu webhook, long connection,
      event parsing, external event dedup, or outbound reply delivery
- [ ] Also read `../runtime/index.md` if the change touches agent execution,
      prompt context, sandbox env vars, or tool bridge behavior
- [ ] Read `../guides/cross-layer-thinking-guide.md` when data crosses backend,
      runtime, and UI boundaries
- [ ] Read `../skills/index.md` if working with skill management or skill loading

## Documents

- `architecture.md`: backend module boundaries and ownership
- `controller-patterns.md`: handler conventions, error flow, and response shape
- `model-provider-config.md`: local-admin provider API, token-limit defaults,
  validation, patch-clear semantics, and cross-layer test points
- `feishu-integration.md`: Feishu webhook/long-connection contracts, env keys,
  event normalization, dedup expectations, and test points
- `session-goal.md`: `/goal` API, metadata, prompt, SSE, and frontend slash command contracts
- `health-endpoint.md`: `/api/health` local readiness, redaction, and optional integration contracts
- `conversation-digest.md`: `/digest` API, metadata, prompt, SSE, and frontend panel contracts
- `../runtime/skill-extraction.md`: `/digest extract-skill` and `/skill-drafts` contracts
- `summary-memory.md`: searchable digest segment ledger and `/api/memory/search` contracts
- `dag-planning.md`: `chat_plans` storage, plan lifecycle (draft→active), shared
  validation, and `/api/conversations/:id/plan` contracts
- `dag-execution.md`: event-hook scheduler, per-node worktrees, merge executor,
  completion write-back, and restart reconcile contracts (D21–D26)
- See `../skills/` for skill-related backend patterns (skills-controller.ts)
