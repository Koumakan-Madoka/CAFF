# Local Chat UI

## What this adds

This repository now includes a local web app that sits on top of the existing `pi` runtime and SQLite store.

It supports:

- conversation creation and deletion,
- conversation-level agent selection,
- agent persona creation and editing,
- multi-agent replies inside one conversation,
- reuse of the existing `runs`, `a2a_tasks`, and task-event persistence while each agent replies.

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
- In one user turn, the room now uses mention-driven routing: the first speaker is chosen from user `@mentions` or the first room agent, and later speakers are chosen by visible agent `@mentions`.
- If `pi` is unavailable or the provider/model is not configured correctly, the server will still start, but that agent reply will be stored as a failed assistant message.

## Main files

- `app-server.js`
- `chat-app-store.js`
- `public/index.html`
- `public/styles.css`
- `public/app.js`
