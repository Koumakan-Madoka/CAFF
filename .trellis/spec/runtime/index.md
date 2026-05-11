# Runtime Index

Use this index for pi-mono runtime work and Trellis injection changes.

## Scope

- `lib/minimal-pi.ts`, `lib/pi-runtime.ts`, and related runtime helpers
- `lib/agent-chat-tools.ts`
- `lib/skill-registry.ts` - skill discovery and loading
- `server/domain/conversation/skill-draft.ts` - digest-to-skill draft extraction and confirmation
- `server/domain/conversation/turn/*`
- `server/domain/runtime/agent-tool-bridge.ts`
- Active project and sandbox propagation into agent runs

## Pre-Development Checklist

- [ ] Read `agent-runtime.md`
- [ ] Read `conversation-turn-queue.md` when changing conversation send/stop,
      queue drain, active-turn summaries, or runtime busy/queue payload fields
- [ ] Read `../guides/cross-platform-thinking-guide.md` for path, shell, or env
      handling changes
- [ ] Read `skill-extraction.md` when changing digest-to-skill draft extraction or confirmation
- [ ] Read `../guides/cross-layer-thinking-guide.md` if the change affects both
      prompt construction and backend tool execution
- [ ] Search for mirrored update points before changing tool names, env vars, or
      prompt instructions
- [ ] Read `../skills/skill-system.md` if changing skill loading or prompt injection

## Documents

- `agent-runtime.md`: pi-mono runtime flow, Trellis prompt injection, and safety
  rules
- `agent-context-inspector.md`: per-agent-turn prompt section snapshots,
  visibility policy, safe rendering, and Markdown export contracts
- `skill-extraction.md`: manual digest-to-skill draft contract and active-project save guardrails
- `conversation-turn-queue.md`: continuous-send turn orchestration, batch snapshot,
  runtime queue payload, and stop/delete guardrails
- See `../skills/skill-system.md` for skill loading and dynamic `read`-path details
