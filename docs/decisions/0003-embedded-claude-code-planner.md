# ADR 0003: CAFF Hosts an Embedded Claude Code Planner per Room

- Status: Accepted
- Accepted: 2026-10-26
- Decision owner: CAFF project user
- Independent reviewer: Kimi (APPROVE WITH NITS on `cf37f2e`, 2026-10-26; all
  eight non-blocking notes addressed)
- Builds on: [ADR 0002](0002-external-planner-drives-caff.md)
- Amends: ADR 0002's delivery order. P2 becomes the embedded planner; the
  structured review protocol, planner-aware implementer prompts and the
  cross-room console UI move to P3.

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
  The first launch uses `--session-id`; later launches use `--resume`. The room
  session is reserved for CAFF. The user's own terminal planner works in other
  sessions, because two processes on one session interleave its transcript.
- **Working directory and prompt:**
  - The working directory is the room's bound worktree, or the project root if
    the room has none.
  - CAFF appends a system prompt that names the room, its Goal and the
    planner's role: review, rule and instruct, but never commit to the
    implementer's branch.
  - For a room without a worktree, the prompt also says the session is for
    reading and planning only: no commits until a worktree is bound. The root
    stays on `main` under AGENTS.md.
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
  `budget_exhausted`, `failure_paused`, `owner_removed` and `turn_failed`.
  `owner_removed` is included because ADR 0002 lets the planner reassign the
  owner to an agent already in the room.
- **Run:** CAFF runs `claude -p --resume <room session>` with:
  - a prompt that describes the item;
  - `--output-format stream-json`;
  - a bounded `--max-turns`;
  - tools limited to the caff CLI and read-only tools: no PowerShell, no edits
    and no other shell commands.
- **Limits:**
  - At most 4 wake-ups per room per hour.
  - While the room's interactive terminal is live, no wake-up runs; the item is
    shown in the pane instead.
  - A wake-up that finds the item is reserved to the user makes no Goal change.
    It marks the item as needing the user and does not wake up for it again.
    This stops wake-ups from triggering each other in a slow loop.
- **Catch-up:** when CAFF starts, each room with wake-ups enabled gets one
  deduplicated wake-up for unresolved trigger items that arrived while CAFF was
  down. It counts toward the hourly limit.
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
  - the system and user path variables that Claude Code and the caff CLI need
    to find their configuration, subscription login and the P1 credential file:
    `PATH`, `SystemRoot`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
    `TEMP`/`TMP` on Windows, and `HOME`, `XDG_STATE_HOME`, `TMPDIR` on POSIX;
  - no provider secrets, such as `ANTHROPIC_API_KEY`, and no credential values.
    The planner token is found through its credential file, never passed in the
    environment;
  - no inherited Claude Code session variables;
  - `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1`;
  - **User-approved amendment, 2026-10-27:** interactive PTYs also set
    `CLAUDE_CODE_NO_FLICKER=1`, alongside generated TERM/COLORTERM. This pins the
    fullscreen renderer and avoids counting early PTY stops as shared fullscreen
    boot failures, which could change the renderer in the user's own terminal.
    Print wake-ups and version probes do **not** set this flag. Parent renderer
    preferences (including `CLAUDE_CODE_NO_FLICKER=0` and
    `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`) are still not inherited; CAFF does not
    read or rewrite `~/.claude.json`. Approval/instruction: room message
    `401c0275-5006-4978-a8eb-d477cae90264`; planner's CLI 2.1.311 A'/B'/E'/D'
    observations and final-candidate verification gate are in P2 §10;
  - the CAFF base URL and the room ID.
- **CLI location and version:** CAFF finds the `claude` executable on `PATH`,
  or uses `CAFF_CLAUDE_CLI` when set. It checks the CLI version at startup;
  2.1.310 is the baseline. Below the supported minimum, the terminal and
  wake-ups are disabled and the reason is shown.
- **Not a sandbox:** as in ADR 0002, processes running under the user's
  account can reach anything the user can. Any local process can also read the
  CSRF token from the loopback bootstrap and drive a terminal. The terminal
  defends against browsers, not against local processes.

### Dependencies

- `node-pty` 1.1.0, pinned.
- `@xterm/xterm` 6.0.0 with `@xterm/addon-fit`.
- **User-approved amendment, 2026-10-27:** add experimental
  `@xterm/addon-unicode-graphemes` **0.4.0**, exactly pinned, to fix terminal
  ghosting. Its Unicode 15 grapheme-width provider requires `allowProposedApi`;
  this does not enable additional OSC/output capabilities. Pair it with
  node-pty's bundled newer ConPTY (`useConptyDll: true`) on Windows, never a
  silent fallback to OS ConPTY/Unicode 6. No additional test dependency was
  authorized. Approval/instruction: room message
  `dd5c3818-2de6-4936-b1ac-19ad52d7c38b`; details/evidence in P2 §2/§9/§10.
- `ws` 8.22.0 or later, which includes the fixes for GHSA-96hv-2xvq-fx4p and
  GHSA-58qx-3vcg-4xpx.

### Verify during implementation

These facts depend on versions or platforms. The following **implementation
verification annotations (2026-10-26)** point to evidence, not changes to the
accepted decisions. See the [P2 verification matrix](../engineering/runtime/embedded-planner.md#adr-0003-verify-during-implementation-checklist)
and [planner acceptance records](../engineering/runtime/embedded-planner.md#planner-real-cli-acceptance-records):

- **CLI flags / supported minimum:** Windows official CLI 2.1.310 verified in
  M2 session/version observations, M3 interactive/resume and M4a/M4b real print
  runs; final M4 code `1c7b10e4`. Exact runtime argv is in P2 §10. Recheck after
  CLI upgrades; numeric version success alone does not prove compatibility.
- **caff-only `--allowedTools`:** M4a `7ccdd39e` real adversarial gate passed
  positive commands and denied compound/other-program/unsafe tools in an
  untrusted worktree. Explicit dontAsk was additionally verified; M4b runtime
  pins it, 2.1.x >=2.1.310 and whitespace-free trusted prefix paths. The initial
  M4b behavioral BLOCK and successful `1c7b10e4` revalidation are both retained
  in P2 §10. Other versions/paths require another gate, never broader permission.
- **Approval in `-p`:** M4a's mkdir/redirect/git-status probes were denied,
  without hanging or sentinel effects, including dontAsk hardening. Minimal
  allowlisted environment found Git Bash without additional path variables.
- **node-pty:** Windows x64 / Node 24.13.1 / node-pty 1.1.0 prebuild installation
  and real PTY/fake CLI cleanup suites passed (M2/M3 reviews). **Linux CI has
  not run**: `.github/workflows/test.yml` requires Ubuntu/Node 22.19.0 compiler
  prerequisites, fresh install, compiled `pty.node`, and full checks. A
  candidate-pinned successful CI result still requires authorized publication;
  Windows PASS or the workflow file is not Linux build evidence.
- **ConPTY repaint — corrected 2026-10-27:** M3 `619164de` checked interaction,
  drag/narrow/desktop resize, reattach and resume; `f7de4822` rechecked readable
  light-theme trust/path and neutral exit/Stop. These short smokes did not catch
  frequent ghosting later reported on 3310. Planner deterministic capture/replay
  traced the mismatch to system ConPTY's old emoji widths plus xterm's Unicode 6
  default. Updating only browser widths worsened wrapping; bundled ConPTY plus
  15-graphemes gave zero wraps/one copy per line, with real-Claude diagnostic
  streaming/delete/resize also clean (Windows 10.0.19045 / Edge 155 / CLI 2.1.311).
  P2 §10 retains this correction and new real-PTY + fake-CLI Edge regression;
  candidate-pinned planner review/real-Claude revalidation remains required.
  No claim about untested Windows versions, arm64 execution or Linux CI.

### Change to ADR 0002's delivery order

- **P2:** the embedded planner, meaning the terminal and wake-ups. The room
  pane is the room-level part of ADR 0002's console UI.
- **P3:**
  - the structured review request and verdict protocol;
  - planner-aware implementer prompts;
  - the cross-room console UI, such as the portfolio and the attention queue;
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
