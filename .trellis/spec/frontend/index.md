# Frontend Index

Use this index for changes in `public/`.

## Scope

- Standalone page entry files such as `projects.js`, `metrics.js`,
  `eval-cases.js`
- Chat UI modules under `public/chat/`
- Shared browser helpers under `public/shared/`
- Skills management UI (`skills.html`, `skills.js`)
- Skill testing UI (`skill-tests.js`, integrated with `eval-cases.html`)

## Pre-Development Checklist

- [ ] Read `ui-structure.md`
- [ ] Read `../guides/cross-layer-thinking-guide.md` if your UI depends on new
      API payloads or Trellis prompt state
- [ ] Read `../guides/code-reuse-thinking-guide.md` before adding another
      shared helper or duplicating DOM update logic
- [ ] Read `../skills/skill-testing.md` when modifying skill testing UI

## Documents

- `ui-structure.md`: browser module layout and editing expectations
- See `../skills/skill-testing.md` for skill testing UI integration patterns
