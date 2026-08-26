# Upgrade PI and Normalize `stream_read_error`

## Goal

Upgrade CAFF's PI integration from `@earendil-works/pi-coding-agent` 0.80.10
to the audited target 0.84.3, then add a removable, exact
`stream_read_error` normalization at PI's official extension boundary so PI's
native bounded auto-retry can recover transient stream failures without
replaying completed tool side effects.

## Delivery Sequence

1. PR A contains only the PI dependency upgrade and compatibility changes that
   are strictly required by 0.84.3.
2. PR B starts from the independently reviewed PR A candidate and contains the
   exact error normalization, regression tests, and executable spec updates.
3. Each candidate is frozen and independently reviewed by exact commit SHA.
4. User acceptance is required before merge. The two PRs merge to `develop` in
   order with merge commits.

## Requirements

- Audit the 0.80.10 through 0.84.3 release notes and the current PI SDK,
  extension, provider, session, event, and tool contracts before implementation.
- Audit the direct `@mariozechner/pi-ai` dependency and remove it or prove that
  it cannot create duplicate runtime/type identities after the upgrade.
- Establish an upgrade-before baseline for PI runtime/provider/session/tool,
  Goal, DAG, private mailbox, image, handoff, and smoke behavior.
- Reproduce with a controlled provider/SDK fixture that the existing PI version
  retries an ordinary retryable provider error but does not retry the exact
  `stream_read_error` failure.
- Keep PR A free of `stream_read_error` classification or mapping changes.
- For PR B, intercept only a final assistant message with
  `stopReason === "error"` whose normalized error is exactly
  `stream_read_error`.
- Perform the mapping through PI's official `message_end` extension hook before
  PI evaluates retryability. Do not modify `node_modules`, fork a provider,
  disable streaming, or implement a CAFF outer retry loop.
- Preserve the original `stream_read_error` identifier in diagnostics while
  mapping it to PI-recognized retryable semantics.
- Reuse PI's native maximum of three retries and exponential backoff. Four
  consecutive failures must close as a final failure.
- Prove that partial text followed by a stream failure is handled correctly and
  that already completed tool calls are not executed again.
- Prove that HTTP 400/401/403, quota errors, and abort/cancellation do not become
  retryable through the mapping.
- Prove `auto_retry_start`/`auto_retry_end`, `modelUsage.calls`, and final CAFF
  message/task/session status accounting for recovery and terminal failure.
- Prepare upstream issue/PR wording, but do not publish it without separate user
  confirmation.

## Non-Goals

- No CAFF-level whole-turn retry loop.
- No provider fork or broad error-substring matching.
- No non-streaming mode.
- No changes to prompt-window, routing, Goal, DAG, private mailbox, image, or
  handoff semantics beyond compatibility work forced by PI 0.84.3.
- No production port 3100 deployment, restart, configuration change, database
  access, or external side effect.
- No merge to `develop` before exact-SHA independent review and explicit user
  acceptance.

## Contracts And Error Matrix

### Extension Contract

- Input: PI `message_end` event containing a final assistant message.
- Match: assistant role, `stopReason=error`, and normalized error exactly equal
  to `stream_read_error`.
- Output on match: same-role assistant message with PI-recognized retryable
  semantics and the original identifier retained for diagnosis.
- Output on non-match: the original event/message unchanged.

### Validation Matrix

- Good: one exact `stream_read_error`, then success -> one native retry and final
  CAFF success.
- Good: ordinary PI-recognized retryable network error -> existing native retry
  behavior remains unchanged.
- Bad but bounded: four consecutive exact failures -> three retries, then final
  failure with original diagnosis.
- Bad and non-retryable: 400/401/403, quota, unrelated provider error, and abort
  -> no new retry.
- Partial response: text before exact stream failure -> retry lifecycle remains
  coherent and no duplicate committed tool side effect.
- Tool boundary: a completed tool call before a later model stream failure is
  not executed again.

## Acceptance Criteria

- [ ] Room branch is synchronized to the latest audited `origin/develop`, the
      task is active, and relevant PI/runtime/unit-test specs are loaded.
- [ ] Release-note, SDK/extension, dependency-tree, and protocol compatibility
      audit is recorded.
- [ ] Upgrade-before baseline and controlled old-behavior reproduction are
      recorded.
- [ ] PR A upgrades PI to 0.84.3 with only necessary compatibility changes.
- [ ] PR A passes check, typechecks, build, dependency-tree audit, and complete
      scoped runtime regressions; its exact SHA receives independent approval.
- [ ] PR B's required behavior is red first on the approved PR A baseline.
- [ ] PR B implements only the exact official-hook normalization and all focused
      tests pass.
- [ ] PR B passes complete regressions, fault-injection gates, executable spec
      validation, and exact-SHA independent review.
- [ ] An isolated acceptance instance proves one-failure recovery and bounded
      terminal failure across UI/SSE/log/usage/status without production access.
- [ ] The user explicitly accepts both candidates before ordered merge commits
      to `develop`; Trellis evidence is then archived.

## Environment And Evidence

- Use system Node from `PATH`; do not use `npx node`.
- Run test commands serially where shared ports or SQLite resources could
  conflict.
- Any acceptance instance must use a room-preview port, distinct SQLite path,
  uploads/temp/log destinations, isolated credentials, and disabled external
  delivery side effects.
- Record exact commands, pass/fail counts, known baseline failures, commit SHAs,
  trees, and rollback/fault-injection evidence in the task context.
