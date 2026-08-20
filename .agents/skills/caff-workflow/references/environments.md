# Environment isolation

A different port alone is not an isolated environment. Before startup, verify worktree, commit SHA, port, database, log destination, credentials, and external side effects together.

| Environment | Branch/worktree | HTTP port | Purpose |
|---|---|---:|---|
| Production | repository root on `main` | `3100` | Published code only |
| Acceptance | persistent `develop` worktree | `3200` | Candidate SHA validation |
| Room preview | room's unique worktree | `3210-3299` | Temporary manual preview |
| Automated tests | test workspace | dynamic/`0` | Parallel-safe checks |

Preview ports have no lease manager in phase one: probe availability immediately before starting, report the selected port, and never claim it is reserved. A probe has a race window; stop on bind failure rather than killing an unknown process.

## Data and logs

- Set a different absolute `PI_SQLITE_PATH` for every running instance. Acceptance and previews must never open the production database.
- Send each instance's stdout/stderr or supervisor output to a different log directory. CAFF currently has no universal log-directory environment key, so configure the launcher/redirection rather than inventing one.
- Keep uploads, generated output, caches, and other mutable storage separate whenever enabled. If separation cannot be demonstrated, do not call the instance isolated.
- Back up data and obtain specific authorization before migrations, destructive tests, or production writes.

## Credentials and side effects

Acceptance and previews are side-effect-off by default:

- For ordinary validation, reuse the main CAFF instance's configured `PI_CODING_AGENT_DIR` so models and providers do not need to be rebound. This may consume real model quota; never expose its secrets. Use an isolated agent directory when validating changes to agent, provider, or Skill configuration.
- Do not reuse production delivery/integration credentials.
- Keep secrets only in ignored local environment/configuration; never commit or echo them into chat, commands, evidence, or logs.
- Leave Feishu/Lark inbound and outbound delivery disabled: do not supply production `FEISHU_*` credentials, do not start long connection mode, and do not expose a webhook. Enable a test integration only after explicit authorization with test credentials and a stated destination.
- Apply the same rule to webhooks, emails, notifications, purchases, and third-party writes.

## Startup evidence

Record only non-secret facts:

```text
Environment: production | acceptance | preview
Worktree: <path>
Branch and SHA: <branch>@<sha>
Port: <port>
Database: <distinct redacted path or identifier>
Logs: <distinct path>
External side effects: disabled | explicitly authorized test target
Health/manual check: <command or URL and result>
```

For acceptance, prove the running SHA equals `candidate_sha`. For production, require a clean `main` worktree and prove its SHA is the published commit. If any check differs, stop the startup or acceptance claim.
