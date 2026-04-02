# Skills Index

Use this index for changes involving skills, skill registry, skill testing, and the skill loading system.

## Scope

- `lib/skill-registry.ts`: skill discovery, loading, and management
- `lib/skill-test-generator.ts`: AI-powered test case generation for skills
- `server/api/skill-test-controller.ts`: HTTP endpoints for skill testing
- `server/api/skills-controller.ts`: skill management and configuration API
- `.pi-sandbox/skills/`: skill storage and SKILL.md files
- `tests/skill-test/`: skill testing unit tests
- `public/skills.html` + `public/skills.js`: skill management UI
- `public/skill-tests.js`: skill testing UI

## Pre-Development Checklist

- [ ] Read `skill-system.md` for skill loading modes, registry structure, and descriptor format
- [ ] Read `skill-testing.md` for the skill testing framework architecture
- [ ] Read `../runtime/index.md` when changing skill prompt injection or `read-skill` tool behavior
- [ ] Read `../backend/controller-patterns.md` when modifying skill HTTP endpoints
- [ ] Read `../guides/cross-layer-thinking-guide.md` when changes affect skills, runtime, and UI simultaneously

## Documents

- `skill-system.md`: skill loading modes (dynamic/full), registry structure, descriptor format, and `read-skill` tool flow
- `skill-testing.md`: skill testing framework, trigger/execution validation, test case generation, and evaluation metrics

## Key Concepts

### Skill Loading Modes

- **Dynamic mode** (default): Injects skill descriptors only; agent calls `read-skill` tool to load full body on demand. Prompt includes `read-skill` instructions.
- **Full mode**: Injects full skill body into prompt upfront. No `read-skill` tool, no on-demand loading.

### Skill Testing Framework

The skill testing system evaluates two dimensions:

1. **Trigger Test**: Verifies that the agent correctly identifies and invokes a skill (e.g., calls `read-skill` for dynamic mode)
2. **Execution Test**: Validates that the agent correctly uses the tools specified in the skill (tool name matching, parameter validation)

Test cases are persisted to `skill_test_cases` and `skill_test_runs` tables, with linkage to `eval_cases`/`eval_case_runs` for integration with the existing evaluation infrastructure.

### Skill Registry

The skill registry (`lib/skill-registry.ts`) manages skill discovery, loading, and lifecycle:

- Reads SKILL.md files from `.pi-sandbox/skills/<skillId>/`
- Parses metadata (name, description, tags, skillType)
- Generates descriptors for dynamic mode
- Enforces `MAX_SKILL_BODY_LENGTH = 32768` characters with truncation

## Mirrored Update Paths

- Skill dynamic loading (read-skill tool):
  `lib/agent-chat-tools.ts` (`read-skill` command) <->
  `server/api/agent-tools-controller.ts` (`GET /api/agent-tools/read-skill`) <-
  `server/domain/runtime/agent-tool-bridge.ts` (`handleReadSkill`)
- Skill loading mode configuration:
  `lib/skill-registry.ts` <-> `lib/project-manager.ts` <-> `server/domain/conversation/turn/agent-prompt.ts`
- Skill test API:
  `server/api/skill-test-controller.ts` <-> `public/skill-tests.js` <-> `lib/skill-test-generator.ts`
