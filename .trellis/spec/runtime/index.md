# Runtime Index

Use this index for pi-mono runtime work and Trellis injection changes.

## Scope

- `lib/minimal-pi.ts`, `lib/pi-runtime.ts`, and related runtime helpers
- `lib/agent-chat-tools.ts`
- `lib/skill-registry.ts` - skill discovery and loading
- `server/domain/conversation/turn/*`
- `server/domain/runtime/agent-tool-bridge.ts`
- Active project and sandbox propagation into agent runs

## Pre-Development Checklist

- [ ] Read `agent-runtime.md`
- [ ] Read `conversation-turn-queue.md` when changing conversation send/stop,
      queue drain, active-turn summaries, or runtime busy/queue payload fields
- [ ] Read `../guides/cross-platform-thinking-guide.md` for path, shell, or env
      handling changes
- [ ] Read `../guides/cross-layer-thinking-guide.md` if the change affects both
      prompt construction and backend tool execution
- [ ] Search for mirrored update points before changing tool names, env vars, or
      prompt instructions
- [ ] Read `../skills/skill-system.md` if changing skill loading or prompt injection

## Documents

- `agent-runtime.md`: pi-mono runtime flow, Trellis prompt injection, and safety
  rules
- `conversation-turn-queue.md`: continuous-send turn orchestration, batch snapshot,
  runtime queue payload, and stop/delete guardrails
- See `../skills/skill-system.md` for skill loading and dynamic `read`-path details
