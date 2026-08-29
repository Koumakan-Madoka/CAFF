# CAFF M4 Chat Experience Redesign

Status: completed

## Legacy Sources

- `feature-discussions/2026-07-29-caff-ui-m4-design/` including V2/V3 Markdown, JSON measurements, and PNGs
- `feature-specs/2026-07-29-caff-chat-ui-clowder-experience.md`

## Durable Outcome

M4 replaced card-heavy assistant messages with transcript rows, widened the chat column, retained compact user bubbles, reduced vertical density, moved runtime details into the settings drawer, and preserved responsive/mobile behavior. The reconciled M4 stack reached `develop` in `7a73aad`.

## Delivery Evidence

- Develop integration: `7a73aadabe3a3320dda9ddfbd1da85cb9c605fac`
- Regression contract: `tests/ui/chat-experience-m4.test.js`
- Final status: completed

## Current Truth Sources

- `.trellis/spec/frontend/ui-structure.md`
- `public/index.html` and `public/styles.css`
- `tests/ui/chat-experience-m4.test.js`

## Evidence Policy

Historical measurements and screenshots were useful during design but are not durable truth. New local runs write to ignored `.tmp/ui-evidence/` by default; CI may retain equivalent media as artifacts.

## History Recovery

Use `git show 7a73aad:<legacy-path>` for the last integrated copies or inspect the path log for earlier design iterations.
