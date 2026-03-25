# Local Chat UI

## What this adds

This repository now includes a local web app that sits on top of the existing `pi` runtime and SQLite store.

It supports:

- conversation creation and deletion,
- separate room types for normal chat and `who_is_undercover`,
- conversation-level agent selection,
- agent persona creation and editing,
- multi-agent replies inside one conversation,
- reuse of the existing `runs`, `a2a_tasks`, and task-event persistence while each agent replies,
- a backend-hosted "Who is Undercover" control panel for game setup, automatic round progression, reveal, and reset.

## Run it

From the project root:

```powershell
npm install
npm start
```

Then open:

```text
http://127.0.0.1:3100
```

## Optional environment variables

- `CHAT_APP_HOST`
- `CHAT_APP_PORT`
- `PI_CODING_AGENT_DIR`
- `PI_SQLITE_PATH`
- `PI_PROVIDER`
- `PI_MODEL`
- `PI_THINKING`

## Notes

- The web app uses the same SQLite database path as the existing runtime.
- Each conversation agent gets its own stable session name, so one agent can keep continuity across turns.
- In one user turn, the room now uses mention-driven routing with plain `@Agent` mentions.
- Back-end mention routing treats `@Agent` as actionable when it starts a new line, or when the final line is a trailing mention block like `@AgentA @AgentB`; ordinary inline mid-sentence mentions remain visible in chat but do not route.
- If the user mentions multiple agents, the room defaults to a parallel first round; `#execute` forces serial and `#ideate` forces parallel.
- Later agent-to-agent routing still happens through visible `@Agent` mentions in chat replies when the turn is in serial handoff mode.
- If one agent mentions multiple visible participants in the same reply, those handoffs run as parallel fan-out batches; up to 5 run at once and any extra targets queue behind them.
- Replies produced during the parallel first round are independent and do not auto-handoff to another agent.
- Each agent turn now includes a local chat bridge CLI (`lib/agent-chat-tools.js`) so agents can send public room replies and private notes separately instead of leaking raw chain-of-thought straight into chat.
- Public room output should go through `send-public`; `send-private` without recipients is a note to yourself, while `send-private` to another visible agent privately wakes that recipient in the same turn unless you explicitly use `--no-handoff`.
- Multi-recipient private wake-up is supported; for example `send-private --to "AgentA,AgentB" --content "..."` wakes both and they run as a parallel fan-out batch when the turn mode allows handoffs.
- `who_is_undercover` rooms are distinct from normal chat rooms. The backend is the host, not the model, and the room automatically applies the `who-is-undercover` skill to participants.
- Once a Who is Undercover game starts, the backend automatically runs clue rounds, vote rounds, settlement, and reveal without requiring manual round buttons.
- Undercover identity assignments are stored as private messages with `uiVisible: false`, so they stay available to the agents but are not exposed in the normal chat UI.
- The chat composer includes a `Stop` button that cancels the active turn and prevents queued handoffs from continuing.
- If `pi` is unavailable or the provider/model is not configured correctly, the server will still start, but that agent reply will be stored as a failed assistant message.

## Main files

- `lib/app-server.js`
- `lib/chat-app-store.js`
- `public/index.html`
- `public/styles.css`
- `public/app.js`
