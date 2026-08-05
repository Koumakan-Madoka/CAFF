---
feature_ids: [F003]
topics: [review, cross-conversation, tree, receipt, provenance, spawn, responsive]
doc_kind: review-request
created: 2026-08-05
---

# F003 Phase C UI Review Request

Review-Target-ID: `f003`
PR: https://github.com/Koumakan-Madoka/CAFF/pull/55
Branch: `feat/f003-cross-conversation-pi-mcp`
Exact HEAD: `dbb7d43`
Reviewer: `[烁烁/k3-256k🐾]`

## What

- Compact stable root/child/grandchild conversation tree with selected-ancestor expansion, collapse, bounded depth, and no drag/reparent.
- Durable source receipt, target provenance backlink, and public spawn birth card with original-place state patch and failure actions.
- Reused new-conversation dialog/sheet with explicit parent, project scope, participants, primary Agent, complete initialMessage, idempotency key, and non-Fork notice.
- Tree headers and SSE patches consume durable delivery DTO state.

## Why

F003 requires operator-visible cross-conversation status and an explicit full-context child conversation start without silently copying parent state.

## Tradeoff

The implementation reuses existing AppShell/sidebar/dialog/timeline primitives. It does not add a dashboard, history snapshot, Fork path, drag/reparent, recipient-only bootstrap, or generic MCP proxy.

## Original Requirements

Source: `docs/features/F003-cross-conversation-delivery-pi-mcp-bridge.md` and approved design gate `feature-specs/2026-08-05-F003-cross-conversation-pi-mcp-design.md`.

Operator journey to verify:

1. A source conversation keeps a durable receipt that exposes target, state, provenance, failure reason, and legal next actions after refresh.
2. A target conversation shows the source backlink and the spawn birth card while the initial message remains a public user message.
3. An operator can derive a new child with explicit project, roster, primary Agent, and complete initial message; the dialog clearly states this is not Fork.
4. Desktop tree and mobile drawer remain compact, stable, keyboard-operable, and bounded at the v1 depth limit.

## Architecture Ownership

Architecture cell: `storage/chat -> lib/chat-app-store -> server/domain/conversation + server/domain/runtime -> server/api -> public/chat`

Map delta: none.

Why: this extends existing F003 delivery/tree/timeline surfaces and AppShell primitives; no new Store, Queue, Router, Adapter, Dispatcher, or Binding ownership cell is introduced.

## Technical OQ for reviewer

- Does the client preserve the DTO as state truth across hydration and SSE patches without stale status regression?
- Are tree navigation, max-depth spawn gating, and mobile drawer focus behavior correct for root/child/grandchild and deep-link selection?
- Do receipt/provenance/birth renderers expose only safe user-visible metadata and keep failure details/action affordances bounded?
- Are explicit spawn fields and non-Fork semantics enforced in both dialog and request builder?

Value OQ: none; product direction is approved.

## Self-check evidence

- `npm test` → exit 0.
- `npm run check` → exit 0.
- `npm run typecheck:public` → exit 0.
- `npm run test:ui` → 110/110 PASS; structure contract 15/15 green.
- Focused suites (`tests/ui/cross-conversation-ui.test.js`, `tests/runtime/new-conversation-dialog.test.js`, `tests/ui/app-shell.test.js`, `tests/ui/chat-experience-m4.test.js`) → all green.
- Isolated browser fixture on `127.0.0.1:5102` with temporary SQLite verified 1440/375 tree, collapse/depth limit, spawn dialog, public birth/provenance, and mobile drawer close.
- Quality gate report: `review-notes/2026-08-05-f003-cross-conversation-ui-quality-gate.md`.

## Fresh-Context Findings

Requested from `[烁烁/k3-256k🐾]`; pending at request time. Finding generator only; formal reviewer owns the verdict.

`[砚砚/gpt-5.6-sol🐾]`
