# Two-Layer Skill Scoping Design

Design decisions for session-scoped project `cwd` and the two-layer skill model
(CAFF contract layer + per-session project layer). Recorded during the
`research-design` work item of the "two-layer skill scope" goal. All file and
line references were verified against `develop@38df336` plus room branch
`d6e8a48` unless noted otherwise.

## Scope

- Session-level target-project `cwd` declaration, validation, and passthrough
- CAFF contract-layer skill allowlist injection
- Retiring `.pi-sandbox/skills` as a cross-project auto-injection source
- The `skill-creator` dangling contract in `lib/mode-store.ts`
- AGENTS.md semantics after `cwd` switches away from the caff repository

Non-goals: migrating or deleting private sandbox skill copies (separate,
authorized operations step after release), changing pi package internals, and
per-turn dynamic `cwd` switching.

## DD-1: Session cwd declaration, validation, and resume compatibility

**Facts (verified)**

- `server/domain/conversation/turn/agent-executor.ts:1363-1368` already
  computes `resolvedProjectDir` from `getProjectDir(conversation)` and uses it
  for skill-registry external roots, but `runOptions` never forwards `cwd`, so
  `lib/pi-runtime.ts:396` falls back to `process.cwd()` (the caff repo root).
- `lib/pi-runtime.ts` natively supports `options.cwd`: it is used both as the
  forked SDK-host child process `cwd` (line 1048) and forwarded through the IPC
  `start` config (line 1288).
- The CAFF conversation flow always passes an explicit session name, which
  `resolveSessionPath` maps to `<agentDir>/named-sessions/<name>.jsonl`.
  `lib/pi-sdk-host.mjs:117-119` then calls
  `SessionManager.open(sessionPath, dirname, cwd)` where `cwd` is an explicit
  override parameter (`session-manager.js:1187-1205`). Session storage
  location is therefore **cwd-independent**; the cwd-derived
  `resolveSessionDir` is only a fallback that the conversation flow never
  reaches.

**Decisions**

1. Bind the target project per conversation via the existing
   `conversation.projectScopeId` → `project.path` resolution
   (`server/app/create-server.ts:813-818` `resolveProjectDirForScope`).
   The global `activeProjectDir` remains only as a fallback for conversations
   without a scope binding.
2. Granularity: conversation-level, fixed at session creation, not
   switchable mid-conversation (same one-binding semantics as room worktrees).
3. Each turn resolves `cwd` from the conversation's project scope and passes
   it through `runOptions.cwd` → pi runtime → SDK host.
4. Validation (criterion-1): the resolved project path must be absolute,
   exist, be a directory, and be registered in the project registry;
   otherwise the turn fails fast with a clear error instead of silently
   falling back to the caff root.
5. Resume compatibility (criterion-6): risk is LOW because session files are
   anchored at `agentDir/named-sessions` and `SessionManager.open` receives an
   explicit `cwd` override. A regression test must still cover the resume path
   with a changed project `cwd`, plus a manual resume check on an existing
   conversation in the isolated acceptance instance.

## DD-2: Retiring the sandbox as a global injection source

**Facts (verified)**

- pi discovers skills from: `agentDir/skills` (user scope; here
  `.pi-sandbox/skills` with all 19 sandbox skills), the cwd ancestor chain
  `.agents/skills` up to the git root plus `<cwd>/.pi/skills` (project scope),
  `~/.agents/skills` and `~/.pi/agent/skills` (home scope), and explicit
  `additionalSkillPaths` (`package-manager.js:293`, `1940-2017`;
  `resource-loader.js:330-332`).
- `noSkills: true` reduces skill paths to CLI-enabled skills plus
  `additionalSkillPaths` — it would also kill project-layer discovery, so it
  is unsuitable on its own.
- `resourceLoaderOptions.skillsOverride` (`resource-loader.js:513`) is an
  in-process function hook the SDK host can use to post-filter the loaded
  skills result.
- `additionalSkillPaths` are merged after settings enable/disable filtering,
  so they are a reliable carrier for the contract layer.

**Options considered**

| Option | Verdict |
| --- | --- |
| A. Empty `.pi-sandbox/skills` (ops) | Rejected as the mechanism: no code guarantee, any file dropped in later re-enters global scope; kept only as the post-release cleanup step |
| B. `noSkills` + fully explicit paths | Rejected: CAFF would have to re-implement pi's project discovery (git-root ancestor walk), high drift risk |
| C. `skillsOverride` filtering by source | **Selected** |
| D. `settings.json` exclude patterns | Rejected: implicit semantics, no code guarantee |

**Decisions**

1. Implement the retirement as a `skillsOverride` function in the SDK host
   that removes skills whose source is the `agentDir/skills` user-scope root
   (`.pi-sandbox/skills`).
2. Filtering MUST be by resolved source path / sourceInfo, never by skill
   name; it must not affect project-layer skills discovered from the session
   `cwd` chain, and it must not affect skills contributed through
   `additionalSkillPaths` (those are injected after the override input is
   assembled — verify with a targeted test).
3. Home-scope roots (`~/.agents/skills`, `~/.pi/agent/skills`) are currently
   empty; the same override may exclude them for defense in depth, but this
   is optional and must be documented if done.
4. The empty-directory cleanup of `.pi-sandbox/skills` remains a separate,
   explicitly authorized operations step after the git contract layer has
   been released to production (criterion-4 sequencing).

## DD-3: Contract-layer allowlist carrier and the skill-creator contract

**Facts (verified)**

- `lib/pi-sdk-host.mjs:143-145` passes
  `resourceLoaderOptions.additionalExtensionPaths` today;
  `additionalSkillPaths` is the same-shaped, already-supported option.
- `docs/engineering/skills/skill-system.md:178-183` requires
  `.agents/skills/skill-creator/SKILL.md`, and `lib/mode-store.ts:75`
  (`REQUIRED_MODE_SKILL_IDS = ['skill-creator']`) force-binds it into every
  mode, but the file does not exist on `develop` or the room branch. The
  `create-command` skill provides the same skill-scaffolding purpose.

**Decisions**

1. Allowlist carrier: a CAFF-side exported constant
   `CONTRACT_SKILL_ALLOWLIST` (six ids: `caff-workflow`, `create-command`,
   `dag-planning`, `grill-with-docs`, `grilling`, `domain-modeling`) mapping
   to `<caff repo>/.agents/skills/<id>` directories derived from the
   repository root, forwarded through the runtime IPC config into
   `resourceLoaderOptions.additionalSkillPaths`.
2. The allowlist is code, not configuration: it changes only through review,
   which is the contract-layer semantics we want.
3. `skill-creator` handling: change `REQUIRED_MODE_SKILL_IDS` (and
   `ALWAYS_DYNAMIC_MODE_SKILL_IDS`) in `lib/mode-store.ts` to reference
   `create-command`, update `skill-system.md`'s "Builtin Mode Helper Skills"
   section accordingly, and cover the re-pointing with tests (custom mode
   save / built-in seed paths must keep the helper present). Do not create a
   new `skill-creator` copy.
4. Compatibility note for the re-pointing: modes saved before the change carry
   `skill-creator` in their stored `skill_ids_json`; the repair path must
   migrate or tolerate the stale id without breaking mode loads.

## DD-4: AGENTS.md semantics after the cwd switch

**Facts (verified)**

- pi injects AGENTS.md files discovered from the `cwd` chain into
  `<project_context>` (`system-prompt.js:105-110`). Switching the session
  `cwd` to the target project therefore brings that project's AGENTS.md in
  natively — exactly the project-layer behavior we want, with zero changes.
- The caff repository's own AGENTS.md currently enters the model prompt only
  through pi's cwd-anchored discovery (cwd = caff root today).

**Decisions**

1. Target project = caff: caff's AGENTS.md is rediscovered natively; nothing
   to do.
2. Target project ≠ caff: caff's AGENTS.md no longer enters
   `<project_context>`. Engineering rules are carried by the CAFF-composed
   prompt sections (the 22-section turn text), which already embed the
   workflow rules. This is the documented semantics — acceptance reviewers
   must not flag the absence as a loss.
3. Do not use `appendSystemPromptOverride` to re-inject caff's AGENTS.md: it
   would duplicate content already carried by the CAFF-composed sections.

## Merge and sequencing constraints

- The runtime implementation must be based on a `develop` that already
  contains `d6e8a48` (contract-layer promotion). Merge order: `d6e8a48`
  first, then this goal's room-branch work.
- No deletion of `.pi-sandbox` private copies and no instance starts before
  the implementation reaches its verification stage with isolated
  port/DB/logs (criterion-5).

## Acceptance mapping

| Criterion | Covered by |
| --- | --- |
| criterion-1 (safe cwd binding) | DD-1 decisions 3-4 + unit tests |
| criterion-2 (prompt contains only allowlist + project layer) | DD-2 decision 1-2 + DD-3 decision 1 + harness_prompt snapshot check |
| criterion-3 (contract skills survive cwd change) | DD-3 decision 1 + resolution tests (readOnly=true) |
| criterion-4 (private skill inventory, no unauthorized cleanup) | DD-2 decision 4 + inventory doc |
| criterion-5 (checks/tests/acceptance pass) | full pipeline + isolated acceptance instance |
| criterion-6 (resume compatibility) | DD-1 decision 5 |
| criterion-7 (retirement mechanism selected) | this document + review |
| criterion-8 (allowlist carrier + skill-creator fix) | DD-3 |
| criterion-9 (AGENTS.md semantics documented) | DD-4 |
