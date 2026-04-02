# Workspace Index

This directory contains developer workspaces for multi-agent collaboration.

## Structure

```
workspace/
├── index.md              # This file - workspace overview
├── {developer-name}/     # Individual developer workspace
│   ├── journal.md        # Session journal
│   └── scratchpad.md     # Personal notes
```

## Active Developers

| Developer | Status | Journal File |
|-----------|--------|-------------|
| 菲比啾比 | Active | workspace/菲比啾比/journal.md |
| 咕咕嘎嘎 | - | - |
| doro | - | - |

## Current Developer

The current developer is set in `.trellis/.developer`:
- Name: 菲比啾比
- Initialized: 2026-03-31

## Current Task

The current task is set in `.trellis/.current-task`:
- Task: skill-testing
- PRD: `.trellis/tasks/skill-testing/prd.md`

## Quick Commands

```bash
# Initialize developer
python .trellis/scripts/init_developer.py

# Get current developer
python .trellis/scripts/get_developer.py

# Add session record
python .trellis/scripts/add_session.py --message "Session description"
```

## Notes

- Each developer/agent gets their own subdirectory
- Journals auto-rotate at 2000 lines
- Sessions are automatically recorded when hooks are active
- Use the `record-session` skill to document completed work
