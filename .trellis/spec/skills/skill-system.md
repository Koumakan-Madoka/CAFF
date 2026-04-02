# Skill System

## Overview

CAFF uses a modular skill system that injects agent instructions (skills) into prompts. Skills can be loaded in two modes:

- **Dynamic mode** (default): Skills are described by lightweight descriptors; agents call `read-skill` to load full bodies on demand
- **Full mode**: Full skill bodies are injected into prompts upfront

## Skill Structure

### Physical Layout

```
.pi-sandbox/skills/<skillId>/
├── SKILL.md           # Skill definition (name, description, body, metadata)
├── config.json        # Optional skill configuration
└── (optional files)   # Supporting resources
```

### SKILL.md Format

```markdown
<!-- Frontmatter (YAML) ---
name: Skill Name
description: One-line description
skillType: conversation | persona
tags: tag1, tag2, ...
--->

# Skill Body

Detailed instructions, tool usage patterns, and behavioral guidance.
```

## Loading Modes

### Dynamic Mode (`CAFF_SKILL_LOADING_MODE=dynamic`)

1. **Descriptor Injection**: Skill registry injects compact descriptors into prompt:
   ```text
   Available skills:
   - werewolf: 后端全自动主持的狼人杀玩法，模型只扮演玩家，按后端推进的日夜阶段行动。
       Use: read-skill with skillId "werewolf"
   ```

2. **On-Demand Loading**: Agent calls `read-skill` tool:
   ```javascript
   // Tool call
   {
     "tool": "read-skill",
     "arguments": { "skillId": "werewolf" }
   }
   ```

3. **Flow**:
   ```
   lib/agent-chat-tools.ts (read-skill CLI)
   → GET /api/agent-tools/read-skill
   → server/domain/runtime/agent-tool-bridge.ts (handleReadSkill)
   → lib/skill-registry.ts (getSkill)
   → Returns full skill body (truncated to 32768 chars if needed)
   ```

### Full Mode (`CAFF_SKILL_LOADING_MODE=full`)

1. **Full Body Injection**: Skill registry injects complete SKILL.md body into prompt
2. **No `read-skill` tool**: Tool instructions are omitted from prompt
3. **Performance Tradeoff**: Higher token usage, lower latency (no tool calls)

### Mode Selection Logic

| Skill Type | Dynamic Mode | Full Mode |
|------------|--------------|-----------|
| Persona skills | Always full (forceFull: true) | Always full |
| Conversation skills | Descriptors only | Full body |

## Skill Registry (`lib/skill-registry.ts`)

### Key Functions

```typescript
class SkillRegistry {
  // Scan .pi-sandbox/skills/ and load all skills
  loadSkillDirectory(skillsDir: string): void

  // Get skill by ID
  getSkill(skillId: string): Skill | null

  // Get all skills
  getAllSkills(): Skill[]

  // Generate descriptor for dynamic mode
  formatSkillDescriptor(skill: Skill): string

  // Generate full body for full mode
  formatSkillBody(skill: Skill): string
}
```

### Skill Object

```typescript
interface Skill {
  id: string                    // From directory name
  name: string                  // From frontmatter
  description: string           // From frontmatter
  skillType: 'conversation' | 'persona'
  tags: string[]
  body: string                  // SKILL.md content (truncated to 32768 chars)
  bodyTruncated: boolean        // Whether body was truncated
  path: string                 // Full path to SKILL.md
  config?: any                  // Optional config.json content
}
```

## Constants and Limits

```typescript
// Maximum skill body length before truncation
const MAX_SKILL_BODY_LENGTH = 32768;

// Truncation marker
const TRUNCATION_MARKER = '\n\n...[truncated]';

// Default skill loading mode
const DEFAULT_SKILL_LOADING_MODE = 'dynamic';
```

## Integration Points

### Prompt Construction (`server/domain/conversation/turn/agent-prompt.ts`)

```typescript
// Get skill loading mode from env
const mode = getSkillLoadingMode(); // reads CAFF_SKILL_LOADING_MODE

// Inject skills based on mode
const skillDocuments = formatSkillDocuments(skills, mode);

// Generate skill descriptor section (dynamic mode only)
const skillDescriptors = formatSkillDescriptors(skills, mode);
```

### Tool Bridge (`server/domain/runtime/agent-tool-bridge.ts`)

```typescript
// Handle read-skill tool calls
async function handleReadSkill(params: { skillId: string }): Promise<string> {
  const skill = skillRegistry.getSkill(params.skillId);
  if (!skill) throw new Error('Skill not found');
  return skill.body;
}
```

### Environment Variables

```bash
CAFF_SKILL_LOADING_MODE=dynamic|full  # Default: dynamic
PI_AGENT_SANDBOX_DIR=/path/to/.pi-sandbox  # Used to locate skills/
```

## Development Guidelines

### Adding a New Skill

1. Create directory: `.pi-sandbox/skills/<skillId>/`
2. Write SKILL.md with frontmatter and instructions
3. (Optional) Add config.json for skill-specific settings
4. Restart server or reload skill registry

### Modifying Skill Loading Logic

When changing how skills are loaded or formatted:

1. Update `lib/skill-registry.ts` if changing loading/structure
2. Update `server/domain/conversation/turn/agent-prompt.ts` if changing prompt injection
3. Update `server/domain/runtime/agent-tool-bridge.ts` if changing `read-skill` handling
4. Check `lib/agent-chat-tools.ts` for CLI tool definitions
5. Add/update tests in `tests/skill-test/` or `tests/runtime/`

### Testing Skill Loading

- Use `tests/runtime/read-skill.test.js` for `read-skill` tool behavior
- Use skill testing framework (`server/api/skill-test-controller.ts`) for end-to-end validation
- Verify descriptor format matches prompt expectations
- Test truncation with oversized skill bodies

## Common Patterns

### Persona Skills Always Use Full Mode

```typescript
// In formatSkillDocuments()
if (skill.skillType === 'persona' || mode === 'full') {
  // Inject full body
  return skill.body;
}
```

### Skill Body Truncation

```typescript
// In skill-registry.ts
if (skill.body.length > MAX_SKILL_BODY_LENGTH) {
  return skill.body.substring(0, MAX_SKILL_BODY_LENGTH) + TRUNCATION_MARKER;
}
```

### Descriptor Format (Dynamic Mode)

```
- <skillId>: <description>
    Use: read-skill with skillId "<skillId>"
```

Example:
```
- werewolf: 后端全自动主持的狼人杀玩法，模型只扮演玩家，按后端推进的日夜阶段行动。
    Use: read-skill with skillId "werewolf"
```
