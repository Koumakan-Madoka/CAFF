# Skills Index

Use this index for changes involving skills, skill registry, and the skill loading system.

## Scope

- `lib/skill-registry.ts`: skill discovery, loading, and management
- `server/api/skills-controller.ts`: skill management and configuration API
- `.pi-sandbox/skills/`: skill storage and SKILL.md files
- `public/skills.html` + `public/skills.js`: skill management UI

## Pre-Development Checklist

- [ ] Read `skill-system.md` for skill loading modes, registry structure, and descriptor format
- [ ] Read `../runtime/index.md` when changing skill prompt injection or dynamic skill path-loading behavior
- [ ] Read `../backend/controller-patterns.md` when modifying skill HTTP endpoints
- [ ] Read `../guides/cross-layer-thinking-guide.md` when changes affect skills, runtime, and UI simultaneously

## Documents

- `skill-system.md`: skill loading modes (dynamic/full), registry structure, descriptor format, and dynamic skill path-loading flow

## Key Concepts

### Skill Loading Modes

- **Dynamic mode** (default): Injects skill descriptors only; agent uses the generic `read` tool on the descriptor `Path` to load `SKILL.md` on demand. Prompt includes `read` + `Path` guidance.
- **Full mode**: Injects full skill body into prompt upfront. No extra skill-loading step is needed.

### Skill Registry

The skill registry (`lib/skill-registry.ts`) manages skill discovery, loading, and lifecycle:

- Reads SKILL.md files from `.pi-sandbox/skills/<skillId>/`
- Parses metadata (name, description, tags, skillType)
- Generates descriptors for dynamic mode
- Enforces `MAX_SKILL_BODY_LENGTH = 32768` characters with truncation

## Mirrored Update Paths

- Skill dynamic loading (descriptor path + `read`):
  `lib/skill-registry.ts` (`skill.path`) <->
  `server/domain/conversation/turn/agent-prompt.ts` (descriptor `Path` + `read` guidance)
- Skill loading mode configuration:
  `lib/skill-registry.ts` <-> `lib/project-manager.ts` <-> `server/domain/conversation/turn/agent-prompt.ts`
