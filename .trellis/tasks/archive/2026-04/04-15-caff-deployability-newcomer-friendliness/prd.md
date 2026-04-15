# CAFF deployability and newcomer-friendliness review

## Goal
Assess CAFF's current deployability and first-run onboarding experience, then produce a prioritized improvement list for making the project easier to boot, verify, and extend.

## Context
CAFF already has a fairly rich local-stack story: `README.md` covers the main product surface and quick start, `docs/windows-local-stack.md` documents the Windows + WSL + OpenSandbox autostart path, and the repo includes Windows helper scripts under `scripts/windows/`.

The open question is not whether CAFF can run locally, but whether a newcomer can reliably understand:
- which setup path is the minimum viable path
- which dependencies are optional versus mandatory
- how to verify that the stack is healthy
- where the current deployability pain points still are

## Requirements
- Inventory the current local deployment and startup paths exposed by the repo
- Separate the "minimum happy path" from optional advanced integrations
- Identify the biggest first-run friction points for a new developer or operator
- Evaluate whether current docs/scripts provide a clear health-check and recovery path
- Produce concrete, prioritized follow-up recommendations

## Discussion Focus
### Deployability
- How many setup profiles does CAFF currently imply: minimal local UI/server, local skill-test with OpenSandbox, Feishu-integrated runtime, Windows autostart stack?
- Which of those profiles are clearly documented and which are still expert-only?
- Is there a reliable and obvious verification path after startup?

### Newcomer Friendliness
- Can a newcomer identify the shortest path to a successful first run within a few minutes?
- Are prerequisites, optional components, and advanced integrations clearly separated?
- Are recovery/debugging steps discoverable when startup fails?

## Deliverables
- A current-state deployability summary
- A newcomer first-run friction list
- A prioritized set of recommended improvements
- A suggested next implementation slice for the highest-value improvement

## Current-State Summary
- CAFF currently implies four setup profiles: minimal local chat, local OpenSandbox-backed skill-test, Feishu-integrated runtime, and Windows autostart stack.
- The real minimum happy path is now explicit: Node 20+, npm 9+, a usable provider API key, `cp .env.example .env.local`, `npm run start:dev`, then open `http://127.0.0.1:3100`.
- Advanced paths are viable but still more expert-oriented than the minimal local lane, especially around OpenSandbox and Windows autostart recovery flows.
- Verification coverage is uneven: Windows/OpenSandbox docs already have richer health and recovery guidance than CAFF core startup itself.

## Key Findings
- Newcomer confusion mostly came from mixed setup lanes: Quick Start, OpenSandbox, Feishu, and Windows autostart were too close together in the main entry flow.
- Before P0, `.env.example` omitted `PI_PROVIDER` and `PI_MODEL` even though runtime defaults existed, which made fresh-clone users hit a "UI loads, agent replies fail" half-success trap.
- CAFF had an obvious "server is up" signal but not a CAFF-owned readiness signal that separated `core-ready`, `provider-ready`, and optional integration status.
- Troubleshooting information exists, but it is easier to discover for the advanced Windows/OpenSandbox lane than for the basic local-chat lane.

## Prioritized Improvement Shortlist
### P0 — Landed in `a691567`
- Restructure `README.md` into a tiered Quick Start: minimal run, verification, then advanced integrations.
- Layer `.env.example` into Core / OpenSandbox / Feishu sections and expose `PI_PROVIDER` / `PI_MODEL` directly in the template.
- Print startup status for provider, model, Feishu, and OpenSandbox so newcomers can see their effective runtime state immediately.

### P1 — Highest-value next slice
- Add a CAFF-owned readiness/health view (`/api/health` or equivalent) that clearly reports `core-ready`, `provider-ready`, and optional integration status separately.

### P2 — Documentation lane split
- Keep the main README focused on the minimum happy path, and split OpenSandbox, Feishu, and Windows autostart into explicit setup lanes with their own prerequisites, verification, and troubleshooting sections.

### P3 — Install-path minimization
- Evaluate whether advanced integrations can move further toward optional/lazy dependency loading so the minimum install path feels obviously smaller and safer.

## Suggested Next Slice
- Implement a lightweight CAFF readiness endpoint or doctor flow that reports effective provider/model, whether the matching API key is configured, and whether Feishu/OpenSandbox are merely configured versus actually available.
- Reuse existing bootstrap/runtime config resolution instead of inventing a second config parser.
- Validate the slice with `npm run typecheck` plus a simple smoke request.

## Non-Goals
- Implementing every improvement in this task
- Redesigning CAFF architecture
- Expanding product scope beyond deployability/onboarding

## Acceptance Criteria
- [x] A dedicated branch exists for this discussion
- [x] A Trellis task exists with scope and goals captured
- [x] The discussion captures at least one deployability assessment and one newcomer-friendliness assessment
- [x] The task ends with a concrete, prioritized improvement shortlist

## Seed References
- `README.md`
- `docs/windows-local-stack.md`
- `scripts/windows/run-caff-stack.ps1`
- `scripts/windows/register-caff-stack-task.ps1`
- `package.json`
