# Private Skill Migration Runbook

Post-merge release-step runbook for migrating the remaining private sandbox
skills into the untracked CAFF project layer, cleaning up contract-layer
duplicate copies, and handling secrets. This runbook executes **only after**
the two-layer skill-scoping room branch has been merged into `develop` and
released, so that the `.gitignore` rules for the migration targets are already
on the deployed baseline. Nothing in this document may be executed before that
point; until then the sandbox stays untouched (zero moves, zero deletions).

Related design: `skill-scoping.md` (DD-1..DD-4). Related evidence in the goal:
`evidence-private-skill-inventory`, `evidence-migration-ruling-execution`,
`evidence-migration-ruling-refinements`, `evidence-interim-collision-defect`.

## Authorization record

- 2026-09-14 user ruling "授权 / B组直接删掉，其他的留在机制二中，接受gitignore改动":
  B-group skills (`e2e-test-orchestrator-1.0.0`, `git-security-scanner-1.0.1`,
  `security-shield-1.1.0`) deleted immediately (zero copies remain, including
  the interim private backup, per the user's second confirmation). All other
  private skills stay in the CAFF project via mechanism 2 (main-repo
  `.agents/skills/` + repo-root `.gitignore`, untracked). Release-time cleanup
  of the three contract-layer duplicate sandbox copies is authorized.
- 2026-09-14 user second confirmation: `pdf-rw-toolkit-1.0.0` joins the
  migration set (kept as the shadowed, inactive `pdf` duplicate — no rename,
  no activation); `wows-sub-analyzer` `.env` follows plan (b) below; the zip
  is relocated to secrets storage for the user to destroy after key rotation.
- Review approvals: `d7f18fb` (early static), `0bcf39c`, `8c9f73e` (gitignore
  increments, GPT). These approvals do **not** cover execution of this
  runbook; the release-step execution still needs the user's go at cutover.

## Preconditions (all must hold before step 1)

1. `develop` contains the room-branch merge (runtime implementation +
   `.gitignore` rules for all 14 migration targets).
2. The production instance runs from a checkout that includes the merge, and
   the six contract-layer skills resolve from that checkout
   (`lib/contract-skills.ts` allowlist: caff-workflow, create-command,
   dag-planning, grill-with-docs, grilling, domain-modeling).
3. User has confirmed the release-step go for this runbook.
4. All commands run in the **main repo working area** (`E:/pythonproject/caff`),
   not a room worktree; `.pi-sandbox` is ignored storage and invisible to git.

## Source inventory (pre-execution snapshot)

`.pi-sandbox/skills/` currently holds 17 directories + 1 zip:

- 3 contract-layer duplicate copies (delete in step 4):
  `grill-with-docs`, `grilling`, `domain-modeling` — verified byte-identical
  (`diff -rq`) to the git-tracked contract copies from `d6e8a48`.
- 14 migration targets (move in step 1): see table below.
- 1 secret-bearing archive (relocate in step 3): `wows-sub-analyzer.zip`.

## Step 1 — Move 14 directories into the untracked project layer

Move (not copy) each directory from `.pi-sandbox/skills/<dir>/` to
`.agents/skills/<dir>/`. All targets are already covered by repo-root
`.gitignore` (commits `0bcf39c` + `8c9f73e`), so they stay untracked and are
never committed. Discovery works because pi scans `.agents/skills` from the
scan tree itself and does not read the repo-root `.gitignore`.

| # | Source (`.pi-sandbox/skills/`) | Target (`.agents/skills/`) | Notes |
| --- | --- | --- | --- |
| 1 | `bettergi-one-dragon` | same name | BetterGI ops skill |
| 2 | `dataview-2.0.0` | same name | exposes skill name `DataView` |
| 3 | `docx` | same name | |
| 4 | `glmocr` | same name | |
| 5 | `invoice-fraud-detection-fuzzy-match-0.1.0` | same name | exposes skill name `fuzzy-match` |
| 6 | `invoice-fraud-detection-pdf-0.1.0` | same name | exposes skill name `pdf` (active) |
| 7 | `k3s-deploy-1.0.0` | same name | exposes skill name `k3s-deploy` |
| 8 | `pdf-rw-toolkit-1.0.0` | same name | shadowed dead duplicate of `pdf`; keep as-is, do not rename or activate |
| 9 | `ppt-template-generate` | same name | |
| 10 | `pptx-craft` | same name | ~146 MB; never git-track |
| 11 | `visual-automation-1.0.0` | same name | exposes skill name `visual_automation` |
| 12 | `werewolf` | same name | |
| 13 | `who-is-undercover` | same name | |
| 14 | `wows-sub-analyzer` | same name | strip `.env` first — see step 2; ~17 MB; never git-track |

Constraints:

- None of the 14 exposes a skill name colliding with the six contract-layer
  ids, so no name-collision interim state is created (lesson from
  `evidence-interim-collision-defect`).
- After the move the skills load **only** in sessions whose target project is
  the caff repository (project-layer discovery via the session `cwd` chain).

## Step 2 — Strip `wows-sub-analyzer/.env` (plan b)

The `wows-sub-analyzer` directory contains a real, non-empty `.env` with a
`ZHIPU_API_KEY` (also present inside the zip, plus run caches). During the
move:

1. Do not copy `.env` into `.agents/skills/wows-sub-analyzer/`.
2. Relocate the `.env` file to `.pi-sandbox/secrets/wows-sub-analyzer.env`
   (gitignored, user-controlled, not under any skill discovery root).
3. Recommend the user rotate that key — it has lived in a zip and caches and
   must be considered exposed. After rotation the user destroys the relocated
   material at their own discretion; the runbook never shreds key material.

## Step 3 — Relocate the zip

Move `wows-sub-analyzer.zip` to `.pi-sandbox/secrets/`. It contains an `.env`
and caches and is treated as secret-bearing residue. The user destroys it
after key rotation; the runbook does not delete it.

## Step 4 — Delete the three contract-layer duplicate copies

Delete `.pi-sandbox/skills/grill-with-docs`, `.pi-sandbox/skills/grilling`,
`.pi-sandbox/skills/domain-modeling`. Preconditions:

1. Re-verify byte-identity with the live contract copies immediately before
   deletion (`diff -r <sandbox>/<id> <production checkout>/.agents/skills/<id>`).
2. This deletion must happen in the **same ops window as the release
   cutover**, before any user-facing turn: while the duplicates exist in
   `agentDir/skills`, pi's name-collision resolution rejects the contract
   copies *before* `skillsOverride` retires the sandbox copies, so all three
   (including user-invocable `/grill-with-docs`) vanish from the harness —
   the interim-state defect recorded in `evidence-interim-collision-defect`.
3. Touch nothing else: no other skill directory, no zip, no `.env`, no caches.

After steps 1-4, `.pi-sandbox/skills/` is empty; removing the empty directory
itself is optional and harmless.

## Step 5 — Post-execution verification

1. Production + isolated instance: the six contract-layer skills resolve and
   are visible (five in the model list; `grill-with-docs` user-invocable per
   its `disable-model-invocation` flag) — closes criterion-2.
2. With target project = caff: the 14 migrated skills appear in the project
   layer; with any other target project they do not.
3. `grep -r "\.env" .agents/skills/wows-sub-analyzer/` (and a scan for other
   key files across all 14 targets) returns nothing.
4. `git status` in the main repo shows no untracked noise from the migration
   targets (`git check-ignore` hits all 14).
5. Record the executed command list, file inventory, before/after directory
   listings, and verification outputs as criterion-4 evidence.

## Rollback

Moves are reversible (move directories back); the three deletions are
compensated by the byte-identical git contract copies, so no rollback copy is
kept. If a migration target misbehaves in the project layer, move that single
directory back to `.pi-sandbox/skills/` and re-run the verification.
