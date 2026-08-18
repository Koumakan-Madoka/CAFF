# Git and worktrees

## Invariants

- Repository root: persistent `main` production worktree; keep it clean and do not implement there.
- Acceptance: persistent `develop` worktree.
- Writable room: one immutable CAFF conversation ID maps to one unique branch and one unique worktree.
- A renamed/reused title never changes identity. Use the first eight conversation-ID characters for `<id>` and a short lowercase ASCII `<slug>` only for readability.
- Shared branches are never rebased or force-pushed. Merge current `develop` into a room when synchronization is needed.
- `release/*` is an immutable pointer, not a development branch.

## One-time bootstrap

Use only when `origin/develop` and local `develop` do not exist and the user explicitly approved bootstrap:

```text
git fetch origin
git branch develop origin/main
git worktree add ../worktrees/develop develop
git worktree add -b room/<id>-<slug> ../worktrees/room/<id>-<slug> develop
```

Creating local branches does not authorize pushing, merging, deploying, or modifying production. Stop if any ref/path exists unexpectedly or any target directory is dirty.

## Create a room

Before running a command, inspect:

```text
git status --short --branch
git branch --all --verbose --no-abbrev
git worktree list --porcelain
git check-ref-format --branch room/<id>-<slug>
```

Choose and record the exact base SHA without changing the persistent acceptance worktree:

```text
git fetch origin
git rev-parse develop
# Only when the remote-tracking ref exists:
git show-ref --verify --quiet refs/remotes/origin/develop && git rev-parse origin/develop
git worktree add -b room/<id>-<slug> ../worktrees/room/<id>-<slug> <verified-develop-sha>
```

Use local `develop` by default because it is the current integration baseline. If `origin/develop` exists and differs, report both SHAs and stop for a base decision; if it does not exist, report that fact and use the verified local SHA. Do not merge, pull, reset, checkout, or otherwise advance the persistent acceptance worktree as a side effect of room creation. Updating that worktree is a separate integration/acceptance operation requiring explicit authorization plus clean-status and running-instance checks.

If no remote `develop` has been authorized/published yet, use the verified local `develop`. DAG nodes keep CAFF's existing `.worktrees/dag/<plan>/<node>/` convention, but every writable node still needs a unique derived branch.

## Integrate a normal room

Run the project checks in the room. Push only with user authorization, open `room/* -> develop`, and require at least one non-author approval. Configure/use a merge commit (`--no-ff` semantics): no squash and no rebase-merge.

When no hosting gate exists, an equivalent local merge still requires recorded checks, independent review, and explicit merge authorization:

```text
git -C ../worktrees/develop merge --no-ff room/<id>-<slug>
```

Do not claim technical branch protection when this is only a documented procedure. `main` and `develop` accept no implementation commits or direct pushes; only explicitly authorized, reviewed PR merges (or the recorded local equivalent above) may update them. Protect both branches against force pushes, deletion, and approval bypass when the hosting platform supports it.

An acceptance fix is committed to the same room branch, reviewed, and merged to `develop` again with `--no-ff`. If the change must be removed, revert its merge commit; do not rewrite shared history.

## Freeze and publish an accepted SHA

After explicit user acceptance:

```text
git branch release/<version-or-date> <accepted_sha>
```

Never commit to, reset, or force-push that release branch. PR `release/* -> main`; verify the PR head is exactly `accepted_sha`. After merge, tag the published `main` commit according to the chosen version, then merge/synchronize `main` back into `develop` through the same reviewed process. Publishing time and version are user decisions; code identity is not.

## Production hotfix

```text
git worktree add -b hotfix/<id>-<slug> ../worktrees/hotfix/<id>-<slug> main
```

Review and PR the hotfix to `main`; after publication, synchronize the resulting `main` commit to `develop`. Keep production/acceptance databases and processes untouched during implementation.

## Cleanup

Inspect status, unpushed commits, and worktree ownership first. After acceptance, the room worktree may be removed cleanly while its branch remains. Delete the room branch only after its accepted release reaches `main`. Abandoned work requires user confirmation.

Never use `git worktree remove --force`, `git branch -D`, `git clean -fd`, `git reset --hard`, or equivalent destructive commands unless the user separately authorizes the exact loss after seeing what will be discarded.
