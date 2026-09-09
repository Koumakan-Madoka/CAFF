# Frontend Index

Use this index for changes in `public/`.

## Scope

- Standalone page entry files such as `projects.js`, `metrics.js`
- Chat UI modules under `public/chat/`
- Shared browser helpers under `public/shared/`
- Skills management UI (`skills.html`, `skills.js`)

## Pre-Development Checklist

- [ ] Read `ui-structure.md`
- [ ] Read `model-family-management.md` if you touch provider or role management,
      model-family selection, participant policy, or thinking controls
- [ ] Read the SSE stream recovery section in `ui-structure.md` if you touch the
      `public/app.js` stream open/error handlers or `public/chat/stream-recovery.js`
- [ ] Read `../guides/cross-layer-thinking-guide.md` if your UI depends on new
      API payloads or Trellis prompt state
- [ ] Read `../guides/code-reuse-thinking-guide.md` before adding another
      shared helper or duplicating DOM update logic
- [ ] Read `plan-panel.md` if you touch the DAG plan drawer tab, plan SVG
      rendering, or plan SSE refresh

## Documents

- `ui-structure.md`: browser module layout and editing expectations
- `model-family-management.md`: provider/role management, secret handling,
  responsive dialog, and Pi capability-source contracts
- `plan-panel.md`: DAG plan panel contracts (layout isolation, draft/active
  editing semantics, `conversation_plan_updated` SSE refresh)
