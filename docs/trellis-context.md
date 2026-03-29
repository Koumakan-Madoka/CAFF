# Trellis Context in CAFF

CAFF can inject lightweight **task / PRD / workflow** context into every agent prompt by reading a `.trellis/` folder from the **active project**.

This is inspired by the upstream Trellis convention, but CAFF intentionally implements a smaller subset focused on prompt context.

## What gets injected

When an active project contains `.trellis/`, CAFF injects:

- Task status derived from `.trellis/.current-task` and `task.json`
- Active PRD from `prd.md`
- JSONL context (file snippets) from `implement.jsonl` (fallback: `spec.jsonl`)
- Workflow text from `.trellis/workflow.md`
- A list of available spec index files under `.trellis/spec/**/index.md`

## Required folder layout

Minimal structure:

```
.trellis/
  workflow.md
  .current-task
  spec/
    index.md
  tasks/
    <task>/
      task.json
      prd.md
      implement.jsonl
      check.jsonl
      spec.jsonl
```

Notes:

- `.trellis/.current-task` should point to the active task directory (recommended: `.trellis/tasks/<task>`).
- A task is considered `READY` only when `prd.md` exists **and** at least one JSONL file contains a usable entry.

## JSONL format

One JSON object per line:

```jsonl
{"file": ".trellis/spec/backend/index.md", "reason": "Backend guidelines"}
{"file": "src/server/index.ts", "reason": "Entry point"}
{"file": ".trellis/spec", "type": "directory", "reason": "All spec markdown files"}
```

Supported fields:

- `file` (or `path`): project-relative path (no absolute paths)
- `reason`: why this file matters (shown in the prompt header)
- `type`: `file` (default) or `directory`

Safety rules:

- CAFF refuses to read files that resolve outside the active project directory.
- Reads are bounded (only a prefix is loaded into memory).
- Directory entries read a limited number of `*.md` files and skip hidden folders.

## Tools

These are available to agents via the chat bridge tool (`node lib/agent-chat-tools.ts ...` in the agent sandbox).

### `trellis-init`

Creates a minimal scaffold for a new task.

- Preview (no writes): `trellis-init --task "03-29-my-task"`
- Apply: `trellis-init --task "03-29-my-task" --confirm`
- Overwrite existing scaffold files: `trellis-init --task "03-29-my-task" --confirm --force`

### `trellis-write`

Writes a single file under `.trellis/**` (preview by default, requires explicit `--confirm` to apply).

Example (write PRD):

```bash
cat <<'EOF' | node "$CAFF_CHAT_TOOLS_PATH" trellis-write --path ".trellis/tasks/03-29-my-task/prd.md" --content-stdin --confirm --force
# PRD: ...
EOF
```

## Troubleshooting

- **No Trellis context injected**: ensure an active project is selected and that the project contains `.trellis/`.
- **Task shows NOT READY**: confirm `prd.md` exists and JSONL files contain valid entries pointing to files that exist.
- **Warnings show skipped entries**: JSONL may reference missing files, invalid JSON, or paths outside the project.

