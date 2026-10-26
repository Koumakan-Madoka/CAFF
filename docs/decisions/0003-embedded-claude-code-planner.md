# ADR 0003: CAFF Hosts an Embedded Claude Code Planner per Room

- Status: Proposed
- Proposed: 2026-10-26
- Decision owner: CAFF project user
- Independent reviewer: pending
- Builds on: [ADR 0002](0002-external-planner-drives-caff.md). This ADR
  redefines ADR 0002's P2 as the embedded planner. The structured review
  protocol and planner-aware implementer prompts move to P3.

## Context

ADR 0002 made Claude Code the external planner. P1 (PR #168, merged and
deployed on 2026-10-26) gave the planner:

- its own identity and credential;
- central write guards;
- Goal control: owner and paused `set`, a proposal-loss guard, merge
  semantics and planner binding;
- a durable attention queue with long polling;
- bounded state and portfolio views.

Two gaps remain:

- **The planner lives only in the user's terminal.** The user switches between
  that terminal and the browser to see a room and talk to its planner.
- **Nobody handles attention items while that terminal is closed.** ADR 0002
  lists this under Consequences as "Planner offline".

The user wants a Claude Code window inside each room. It must run the official
CLI, not the Agent SDK. Running the unmodified CLI with the user's own
subscription keeps the setup within Anthropic's terms for personal use.

The design relies on these facts, verified on 2026-10-26 with Claude Code CLI
2.1.310 and Node 22.19 and 24.13 on Windows:

- **Session control:** `--session-id <uuid>` pins a new session. `--resume
  <id>` continues it, in the interactive TUI or in print mode (`-p`).
- **Concurrency:** two processes on one session interleave their transcripts
  with no lock.
- **Headless mode:** `-p` supports `--output-format stream-json`,
  `--max-turns`, `--allowedTools` / `--disallowedTools` and
  `--append-system-prompt`. A tool call that needs approval is denied in `-p`
  rather than left waiting.
- **Terminal:** the interactive TUI requires a TTY. ConPTY hosts need
  `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` to avoid stale fragments on screen.
- **Environment hazards:**
  - `ANTHROPIC_API_KEY` in the environment makes `-p` bill the API instead of
    the subscription.
  - Inherited Claude Code session variables exclude spawned sessions from
    `--resume`.
- **Libraries:**
  - `node-pty` 1.1.0 ships Windows prebuilds and installed without a compiler
    on this machine. On Linux it compiles with node-gyp.
  - `@xterm/xterm` 6 can be served as static files.
  - `ws` 8.22 includes the 2026 security fixes.

## Decision

### Embedded terminal

- **Process:** CAFF can run one interactive `claude` process per room in a
  pseudo-terminal (`node-pty`) and stream it to an xterm.js pane on the room
  page.
- **Pane:** a non-modal, resizable side panel, toggled from the room header. On
  narrow screens it opens as a full-width overlay.
- **Session:** each room keeps a stable Claude Code session ID in its metadata.
  The first launch uses `--session-id`; later launches use `--resume`.
- **Working directory and prompt:**
  - The working directory is the room's bound worktree, or the project root if
    the room has none.
  - CAFF appends a system prompt that names the room, its Goal and the
    planner's role: review, rule and instruct, but never commit to the
    implementer's branch.
- **Permissions:** tool permissions follow the user's Claude Code settings.
  Permission prompts appear in the pane, and the user answers them there.
- **Lifetime:**
  - A process keeps running for 30 minutes after its pane disconnects, so a
    page reload keeps the session; then it stops.
  - At most 4 Claude Code processes run at once across CAFF.
- **One process per room:** a room's session is never driven by two CAFF
  processes at once.

### Event wake-ups

- **Opt-in:** each room has its own off-by-default toggle. It applies only to
  planner-bound Goals.
- **Triggers:** that room's attention items of kinds `proposal_pending`,
  `budget_exhausted`, `failure_paused` and `turn_failed`.
- **Run:** CAFF runs `claude -p --resume <room session>` with:
  - a prompt that describes the item;
  - `--output-format stream-json`;
  - a bounded `--max-turns`;
  - tools limited to the caff CLI and read-only tools: no PowerShell, no edits
    and no other shell commands.
- **Limits:** at most 4 wake-ups per room per hour. While the room's
  interactive terminal is live, no wake-up runs; the item is shown in the pane
  instead.
- **Audit:**
  - CAFF keeps each wake-up's transcript and result, and the pane can show them.
  - CAFF writes made during a wake-up carry the planner identity from P1.

### Isolation and security

- **Off by default:** `CAFF_PLANNER_TERMINAL=1` enables the feature, and only
  when CAFF binds a loopback address.
- **Terminal WebSocket:**
  - The upgrade handler checks Host and Origin against the same-origin loopback
    aliases.
  - The client must send the CSRF token as its first message before CAFF spawns
    or sends anything.
  - Frame size is limited.
  - Unauthenticated or idle sockets are closed.
- **Child environment:** child processes get an allowlisted environment:
  - no provider secrets, such as `ANTHROPIC_API_KEY`;
  - no inherited Claude Code session variables;
  - `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1`;
  - the CAFF base URL and the room ID.
- **CLI location:** CAFF finds the `claude` executable on `PATH`, or uses
  `CAFF_CLAUDE_CLI` when set.
- **Not a sandbox:** as in ADR 0002, processes running under the user's
  account can reach anything the user can.

### Dependencies

- `node-pty` 1.1.0, pinned.
- `@xterm/xterm` 6.0.0 with `@xterm/addon-fit`.
- `ws` 8.22.0 or later.

### Change to ADR 0002's delivery order

- **P2:** the embedded planner, meaning the terminal and wake-ups.
- **P3:**
  - the structured review request and verdict protocol;
  - planner-aware implementer prompts;
  - the optional MCP server;
  - pruning of frozen features.

## Consequences

- **Room-level planning:** the user can plan and review with Claude Code
  without leaving the room. Opted-in rooms get their attention items handled
  while the user's terminal is closed.
- **New attack surface:** a WebSocket now fronts a process that can run shell
  commands. Mitigations:
  - off by default, loopback only;
  - Host and Origin checks;
  - a token in the first message;
  - an allowlisted child environment.
- **Cost:** every wake-up consumes subscription usage. Per-room opt-in, the
  hourly limit and the process cap keep it bounded.
- **Concurrent planners:** the user's own terminal planner and an embedded
  session can both act on a room. P1's revision and proposal preconditions make
  conflicting writes fail instead of overwriting each other.
- **CLI dependency:** CAFF depends on the CLI's flags and terminal behavior. If
  they change, the host must adapt. The user's environment, not CAFF, controls
  the installed CLI version.
