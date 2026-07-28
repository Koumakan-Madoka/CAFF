---
feature_ids: [F001]
topics: [chat, pagination, sqlite, browser-verification, reflection]
doc_kind: reflection
created: 2026-07-28
---

# F001 Long Conversation Cursor Pagination — Reflection Capsule

## Outcome

F001 replaced the public UI's unbounded conversation hydration with a fixed latest page and stable `(created_at, id)` cursor traversal. PR #48 merged as `241a42e`; post-merge truth sync is `f5b1027`. Internal runtime, digest, game, export, diagnostics, and recovery consumers retain their audited full-history or targeted-read semantics.

## What Worked

- The design reused `idx_chat_messages_conversation_id` after proving both query shapes with `EXPLAIN QUERY PLAN`; no synonymous index or Redis dependency was introduced.
- A dedicated public-message page contract kept UI projection semantics separate from the established full-history aggregate.
- Repository and API tests covered equal timestamps, cursor deletion, append-after-issuance, invalid/cross-conversation cursors, hard limits, and complete traversal.
- The production call-site audit prevented the performance feature from silently truncating agent prompts, digest selection, games, exports, recovery, or diagnostics.
- Cross-provider review continuity covered the original implementation, the browser-discovered behavior delta, and final feature SHA `e294982`.

## What Failed

- The first synthetic scroll-anchor test assumed `#message-list` owned scrolling. At responsive layouts the document owned scrolling, so the first real 375px run exposed a roughly 12,271px viewport jump despite green jsdom tests.
- The first review carried a literal 375px evidence gap. Closing that gap found the real defect, proving that browser evidence was part of correctness rather than presentation.

## Trigger Missed

The implementation should have treated scroll ownership as a runtime layout property from the first frontend red test. A mocked scroller cannot prove which element owns scrolling after responsive CSS is applied. The existing browser-verification gate eventually caught this; the missed trigger was its timing, not an absent governance rule.

## Doc Links

- [Feature spec](../docs/features/F001-long-conversation-cursor-pagination.md)
- [Design Gate](../feature-specs/2026-07-28-long-conversation-pagination-design.md)
- [Implementation plan](../feature-specs/2026-07-28-long-conversation-pagination-implementation-plan.md)
- [Delivery evidence](../project-evidence/F001-long-conversation-pagination.md)
- [Quality gate](../project-evidence/F001-quality-gate.md)
- [Browser bug report](../docs/bug-report/long-conversation-document-scroll-anchor/bug-report.md)
- [375px journey recording](../project-evidence/F001-browser/mobile-375-journey.webm)
- [Close Gate Report](../project-evidence/F001-close-gate-report.md)

## Rule Update Target

None. Existing TDD, real-browser verification, non-author review, and vision-guardian rules found and contained the failure. The durable prevention is already encoded in the document-scroll regression tests and the retained 375px acceptance evidence.
