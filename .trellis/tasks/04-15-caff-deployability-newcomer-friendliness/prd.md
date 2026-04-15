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

## Non-Goals
- Implementing every improvement in this task
- Redesigning CAFF architecture
- Expanding product scope beyond deployability/onboarding

## Acceptance Criteria
- [x] A dedicated branch exists for this discussion
- [x] A Trellis task exists with scope and goals captured
- [ ] The discussion captures at least one deployability assessment and one newcomer-friendliness assessment
- [ ] The task ends with a concrete, prioritized improvement shortlist

## Seed References
- `README.md`
- `docs/windows-local-stack.md`
- `scripts/windows/run-caff-stack.ps1`
- `scripts/windows/register-caff-stack-task.ps1`
- `package.json`
