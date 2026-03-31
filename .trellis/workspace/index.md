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

## Active Agents

| Agent | Status | Last Activity |
|-------|--------|---------------|
| - | - | - |

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
