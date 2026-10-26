# ADR 0002: An External Planner Drives CAFF

- Status: Accepted
- Accepted: 2026-10-23
- Decision owner: CAFF project user
- Independent reviewer: Kimi (APPROVE WITH NITS on `22e3423`, 2026-10-23; all
  six non-blocking notes addressed)
- Amends: ADR 0001 (who may rule on Goal proposals); the D28 rule that every
  ruling through the REST Goal endpoint is the user's
- Amended by: [ADR 0003](0003-embedded-claude-code-planner.md), which redefines
  P2 as the embedded planner and moves the review protocol and implementer
  prompts to P3

## Context

CAFF was positioned as a multi-agent collaboration workbench. The user works in
the browser with several model-family agents in a Room, routes work by
`@mention`, and keeps long work on track with Goals and DAGs.

Since 2026-10, the user has mostly driven CAFF from Claude Code instead. Claude
Code drafts Goals and has the chosen implementer submit them. It also watches
every Goal room, rules on proposals on the user's behalf, and performs
independent milestone reviews. Room `bbc07379` (interrupted-run reconciliation,
PR #166) ran entirely this way: Claude Code planned it, GPT implemented it, and
Claude Code reviewed it.

Two observations motivate this decision:

- **Rulings, not implementation, limit throughput.** On 2026-10-22, 16 of 65
  Goal rooms needed attention. Every one of them was waiting on a proposal
  ruling: 8 complete, 7 pause and 1 set proposal. Thirteen had waited six days
  or more, the longest 168 days. The Goal Runner does not continue while a
  proposal is pending.
- **Implementer inefficiency traces back to planning.** Earlier analyses found
  three causes:
  - Work items had no closed completion criteria, so agents hardened the same
    code repeatedly.
  - Agents requested formal review after every small step, which took about 40%
    of agent time in the worst room.
  - Agents updated the Goal every turn, and each update forces a fresh session
    on the next turn.

CAFF's interfaces assume a human in the browser. That makes an external planner
awkward and unsafe:

- Every REST write counts as the user's:
  - Messages are recorded as "You" from `web-ui`.
  - The Goal endpoint forces `ruledBy: { kind: 'user' }`.
  - The user-only gates in `session-goal.ts` reject only `kind: 'agent'`.

  As a result, a planner using REST can change accepted-ADR decisions and
  waive high-risk criteria. Only procedural rules on the planner's side
  prevent that today.
- REST `set` cannot name an owner. It also schedules the first continuation in
  the same request, so the first turn can go to whichever agent default routing
  picks.
- No durable signal says that something needs attention:
  - The SSE stream has no replay.
  - Reaching the runner budget is broadcast only when a new pause proposal is
    created.
- `set`, `revise`, `pause`, `resume` and `complete` discard a pending proposal
  together with the last ruling, without leaving a durable record of either.
- `revise` and `update-delivery` reset omitted fields instead of keeping them.
- Outside a few admin controllers, `/api/*` mutations check neither Host nor
  Origin. Request bodies are parsed as JSON whatever their Content-Type.

## Decision

### Positioning

CAFF becomes an execution plane driven by an external planner, and Claude Code
is the first supported planner:

- The user directs work through the planner.
- CAFF runs Goals with implementer agents in isolated room worktrees. It keeps
  the delivery record: decisions, acceptance criteria, evidence and rulings.
- The web UI becomes the user's console for watching work and making the
  decisions reserved to them.

The protocol does not depend on any particular planner. Server code names the
role (planner), not a product, and Claude Code is the reference client.

### Roles

| Role | Who | Responsibilities |
| --- | --- | --- |
| User | The human | Sets direction, has final authority and makes the reserved decisions below |
| Planner | An external client such as Claude Code | Plans, authors Goals, assigns implementers, monitors, rules within the delegated scope and reviews milestones |
| Implementer | An in-room agent such as GPT | Owns a Goal, implements it, records evidence and proposes changes. Never rules on its own proposals |
| Secondary reviewer | Another in-room agent, on request | Reviews or comments when the planner or user asks. Does not rule in planner-driven Goals |

### Planner identity

The planner is a distinct principal:

- CAFF recognizes planner requests by a local credential.
- It records planner messages and rulings under the planner's own identity,
  never as the user's.
- Only `kind: 'user'` passes the user-only gates.
- Requests from the CAFF UI still count as the user's, so the D28 rule keeps
  applying to them.
- Once mutating routes check Host and Origin (P1), a mutating request must
  either come from the CAFF UI or carry a valid planner credential. A request
  that claims to be the planner but has a missing or invalid credential is
  rejected. It is never treated as the user's.

The credential keeps principals apart for audit and gating. It is not a
security boundary against agents that run under the same OS account, unless
runtime sandboxing stops them from reading it.

### Delegated authority

A Goal is planner-driven once the user approves it with a planner. Within such a
Goal, the planner may act without asking the user each time:

- Rule on implementer pause and resume proposals.
- Resume the Goal after the runner budget is reached.
- Resume a Goal that paused after repeated failures, once the planner has
  diagnosed the cause and recorded it in the ruling reason.
- Change the Goal owner to another agent already in the room, with the reason
  recorded.
- Accept or reject structural revisions that change only work items,
  provisional decisions and open questions.
- Approve normal-risk criterion waivers, with the rationale recorded.
- Accept a complete proposal once every criterion has passed or been validly
  waived.
- Perform milestone reviews and instruct the owner.

Anything not delegated above needs the user's explicit approval of that
specific item, including:

- Creating or replacing a Goal. Creating its room and binding its workspace are
  part of this approval.
- Changing a Goal's objective, committed decisions or non-goals. Moving a
  decision between committed and provisional, in either direction, counts as
  changing a committed decision.
- Adding agents to the room.
- Changing its acceptance criteria (statement, `verifyBy`, risk).
- Push, PR, merge, acceptance (`accepted_sha`) and release. caff-workflow is
  unchanged here.
- Destructive operations: clearing a Goal, deleting data, any force operation
  and restarting shared instances.

When the user gives such an approval in the planner conversation, the planner
may submit the change. CAFF records it as planner-submitted, with the user's
approval as a planner-attested claim. The claim names where and when the user
approved: a planner session reference with a timestamp, or a quote of the
approval. ADR 0001's server-enforced user gates are
different: high-risk waivers and changes to accepted-ADR decisions remain a
direct user ruling in CAFF.

In planner-driven Goals, only the planner and the user rule on proposals. Other
in-room agents may review and comment, but they cannot rule. Enforcement
follows the DAG binding precedent (D28): the Goal carries a binding, and the
agent tool bridge rejects rulings from in-room agents. DAG node Goals keep their
worker/verifier protocol. For planner-driven Goals, this narrows ADR 0001's "one
reviewer other than the proposer" to the planner or the user. ADR 0001 is
otherwise unchanged.

### Interface

- **HTTP API:** the contract. Planner endpoints return lean payloads and check
  the Goal revision. They are idempotent wherever a retry could duplicate work.
- **`caff` CLI:** lives in the repo and wraps the API. It grows out of the
  existing Claude Code helper script. It includes a blocking `wait` that
  returns when an attention item appears.
- **Planner skill:** a skill in the repository documents the planner workflow.
  It must not collide with locally managed `CLAUDE.md` or `.claude/` content.
- **MCP server:** optional. It may come later and would sit on the same API.

### Attention queue

CAFF keeps a durable queue of items that need the planner:

- pending proposals
- review requests
- reached runner budgets
- failure pauses
- owner removals
- completions

The queue survives restarts, and the planner reads it with a cursor. When no
planner is online, items wait, and the user can still act in the UI.

### Review

The planner reviews implementer work once per milestone. When the planner and
the implementer come from different model families, the planner's review
satisfies the no-self-review rule. When they come from the same family, it does
not: a reviewer from another family, or the user, reviews instead. Secondary
reviewers join only when asked. Merging still requires the user's authorization.

### Multi-agent features

The following features are frozen:

- free-form discussion and `@mention` routing chains
- in-room delegation
- cross-room delivery
- DAG
- the Feishu channel

They remain maintained and available to implementers but get no new features.
Whether to remove any of them will be decided later from usage data.

### Delivery order

1. **P0:** this ADR and the README positioning. The planner interface is
   designed in the P1 Goal. Its committed decisions and acceptance criteria
   carry the design. The engineering contract is P1's first work item and is
   merged together with the implementation, because `docs/engineering/` holds
   only implemented contracts.
2. **P1, minimal planner support:**
   - the planner interface contract under `docs/engineering/`, written first;
   - planner identity and attribution;
   - `set` with an owner and an initial paused state;
   - room titles locked at creation;
   - a lean Goal state view and a server-side portfolio;
   - the attention queue with `wait`;
   - proposal loss that is recorded or rejected instead of silent;
   - merge semantics for `revise`;
   - Host/Origin checks and the planner credential on mutating `/api/*` routes;
   - `session-goal.md` and the D28 section of `dag-execution.md` updated to
     match this ADR.
3. **P2:**
   - a structured review request and verdict;
   - implementer prompts that know about the planner;
   - a web UI built around the console.
4. **P3:** an optional MCP server, and pruning of frozen features.

P1 runs as the first planner-driven Goal: the planner writes it, an implementer
builds it, and the planner reviews each milestone.

## Consequences

- **Audit:** rulings gain a third principal kind, and records show whether the
  user, the planner or an agent ruled.
- **Until P1 ships:** the delegated scope already applies, but CAFF records
  the planner's writes as the user's. The planner marks each such write as its
  own in the ruling reason or the message text and keeps a local log. It still
  asks the user about each reserved item, and it never uses REST for high-risk
  waivers or accepted-ADR decision changes. The planner follows these rules
  itself; the server does not enforce them before P1.
- **User control:** more rulings happen without the user. The reserved list
  and the recorded planner rulings are how the user stays in control. The user
  can take back a Goal at any time by ruling directly or pausing it.
- **Fresh sessions:** every planner ruling or Goal update bumps the Goal
  revision, which forces the implementer into a fresh session. The planner
  should batch its Goal writes. P1 should evaluate whether factual-only changes
  can keep a reusable session.
- **README and existing rooms:** the README stops presenting multi-agent chat
  as the main workflow. Existing rooms keep working.
- **Planner offline:** if no planner runs for a long time, the attention queue
  grows. That stays visible in the console, which is no worse than today's
  silent waits.
