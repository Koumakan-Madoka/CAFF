# CAFF Engineering Rules

These rules apply to every human or agent working in this repository. They are procedural guardrails; they do not replace technical branch protection or runtime isolation.

- Before changing repository files, local configuration, data, processes, or external systems, load `.agents/skills/caff-workflow/SKILL.md` and follow it.
- Read-only discussion may remain unbound. Before the first repository change, obtain user authorization and bind the conversation to one unique `room/*` branch and one unique worktree. Operations-only work uses the designated persistent environment worktree.
- Clarify every state-changing request with the project-owned `grill-with-docs` protocol in `caff-workflow`; confirm goal, non-goals, and acceptance evidence, then declare Direct, Goal, or DAG mode with a reason.
- The repository root remains on `main` for production. Normal room branches start from `develop`. Never make implementation commits directly on `main` or `develop`; only an authorized, reviewed integration or release merge may update them. Never force-push either branch.
- Production, acceptance, and room previews must use isolated ports, databases, logs, credentials, and external side effects. Ports `3003` and `3004` are reserved; never connect tests or development to Redis `6399` (use `6398` if Redis is needed).
- A change is not complete without evidence. Bugs require reproduction, root-cause confirmation, a failing regression test first when feasible, and passing verification after the fix.
- Merges require an independent reviewer; nobody reviews their own change. Agents must retain their configured identity and never impersonate another participant.
- Stop and ask instead of guessing when requirements, workspace ownership, environment isolation, destructive cleanup, or release provenance are uncertain.
