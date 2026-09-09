# ADR 0001: Goal-Driven Delivery Workflow

- Status: Accepted
- Accepted: 2026-09-09
- Decision owner: CAFF project user
- Independent reviewer: Kimi

## Context

CAFF previously combined conversation goals with a Trellis task pointer, PRD,
JSONL context lists, project specs, and lifecycle skills. The Goal itself was
only an objective plus a checklist, so implementation steps could appear done
without explicit, observable acceptance criteria or linked evidence.

## Decision

CAFF uses `grill-with-docs` to clarify changes and routes execution directly to
one of three native modes:

- Direct: short, atomic work completed in the current turn.
- Goal: long, sequential work that needs durable progress across turns.
- DAG: work with genuinely parallel slices or dependency and merge edges.

A Goal is the delivery aggregate. It contains an objective, committed and
provisional decisions, open questions, non-goals, rejected options, acceptance
criteria, work items, and evidence. Work-item completion never substitutes for
acceptance. A Goal can complete only when every criterion passed or was
explicitly waived.

Agent-proposed Goal creation and material changes require one reviewer other
than the proposer. The user may rule directly. A normal criterion waiver may
use the same independent review; high-risk criteria involving security, data,
external side effects, or core user behavior require the user. Replacing a
provisional decision records and visibly presents the old decision, new
decision, reason/evidence, reviewer, and affected work.

Durable, cross-task decisions are promoted to ADRs immediately after Goal
approval. Replacing an accepted ADR or making an irreversible/high-risk choice
requires prior user approval.

DAG planning owns the useful parts of ticket decomposition: vertically
verifiable slices, explicit dependencies, review before activation, parallel
frontier execution in isolated child conversations/worktrees, and merge-node
integration verification. CAFF has no `to-spec`, `to-tickets`, spec entity, or
ticket truth source.

Trellis PRDs, JSONL context, `.current-task`, scripts, task archives, and
lifecycle skills are removed. Still-current engineering contracts move to
`docs/engineering/`.

## Consequences

- Goal metadata and APIs become richer but remain persisted with the
  conversation, so restart behavior stays simple.
- Goal UI must distinguish decisions, acceptance, work progress, and evidence.
- Agent tools may update factual work/evidence state directly, while structural
  Goal changes continue through independent review.
- Legacy checklist-only Goals normalize into work items. They do not invent
  acceptance criteria.
- External trackers may later receive a one-way projection from DAG nodes, but
  cannot become CAFF's source of truth.
