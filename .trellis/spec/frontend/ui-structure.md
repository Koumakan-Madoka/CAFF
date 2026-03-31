# UI Structure

## Current Shape

- `public/*.js`: page-level entry files
- `public/chat/*.js`: chat room UI modules
- `public/shared/*.js`: shared browser helpers like API access, avatars, and
  toasts
- `public/styles.css`: shared styling

## Conventions

- Keep page entry files focused on composition and screen-level state.
- Put reusable browser helpers in `public/shared/` instead of copying fetch or
  DOM utility logic across pages.
- When a chat feature grows beyond one screen concern, split it into
  `public/chat/` modules rather than expanding a single monolith.
- Preserve the existing plain JavaScript style; this repo is not using a
  framework build step for the browser code.

## Cross-Layer Watch Points

- UI payload expectations must stay aligned with controller and domain output.
- Trellis-related UI affordances usually depend on backend prompt/runtime state,
  so verify both sides when changing labels, status handling, or tool exposure.
