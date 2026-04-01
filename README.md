# CAFF

**Conversational Agent Framework & Playground** — a local multi-agent chat platform with built-in game modes and evaluation tooling.

![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![License](https://img.shields.io/badge/License-MIT-yellow)
![Tests](https://img.shields.io/badge/tests-passing-brightgreen)

## ✨ Features

- **Multi-Agent Chat Rooms** — Create conversations with multiple AI agents, each with a unique persona. Agents can talk to each other via `@mention` routing with parallel and serial turn modes.
- **Persona Management** — Create and edit agent personas (system prompts, avatar, model settings) through a web UI.
- **Skill System** — Attach reusable skill files to agents for domain-specific behavior (e.g. game hosting, code review).
- **Who is Undercover** 🕵️ — A fully backend-hosted "Who is Undercover" game mode with automatic clue rounds, voting, and reveal. Agents play as participants while the backend acts as the host.
- **Werewolf** 🐺 — A backend-hosted Werewolf game with day/night phase progression, role assignment, and win condition checks.
- **A/B Evaluation Framework** — Run batch A/B replays on prompt pairs, compare agent outputs with metrics, and track evaluation history over time.
- **Trellis Workflow** — Built-in project workflow context system (`.trellis/`) for AI-assisted development sessions.

## 🏗 Architecture

CAFF uses a clean layered architecture, refactored from an original monolithic design:

```
┌─────────────────────────────────────────────────┐
│                   Browser UI                     │
│  (Vanilla JS, SSE, modular page structure)       │
└────────────────────┬────────────────────────────┘
                     │ HTTP / SSE
┌────────────────────▼────────────────────────────┐
│               server/api/                        │
│         (controllers per resource)               │
├──────────────────────────────────────────────────┤
│             server/domain/                       │
│  ┌──────────────┐ ┌───────────┐ ┌────────────┐  │
│  │ conversation  │ │ undercover│ │  werewolf  │  │
│  │  orchestrator │ │  service  │ │  service   │  │
│  └──────────────┘ └───────────┘ └────────────┘  │
│  ┌──────────────────────────────────────────┐    │
│  │       runtime (agent-tool-bridge)         │    │
│  └──────────────────────────────────────────┘    │
├──────────────────────────────────────────────────┤
│               storage/                           │
│  ┌─────────────┐  ┌──────────┐  ┌────────────┐  │
│  │  chat store  │  │ run store│  │   SQLite   │  │
│  └─────────────┘  └──────────┘  └────────────┘  │
└──────────────────────────────────────────────────┘
```

**Key directories:**

| Path | Description |
|---|---|
| `server/app/` | Server bootstrap, config, dependency wiring |
| `server/http/` | HTTP router, SSE bus, request/response helpers |
| `server/api/` | Resource controllers (one per API domain) |
| `server/domain/` | Business logic — conversation orchestration, game services, runtime bridge |
| `server/domain/conversation/turn/` | Turn lifecycle — agent execution, routing, stop, events |
| `storage/` | SQLite repositories for chat data and run records |
| `lib/` | Shared utilities — Pi runtime integration, skill registry, project manager |
| `public/` | Frontend — chat UI, persona editor, skill editor, metrics dashboard |
| `tests/` | Test suites — runtime, storage, HTTP, smoke |

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- npm 9+
- A running [pi coding agent](https://github.com/nicholasgasior/pi-coding-agent) (or compatible provider endpoint)

### Install & Run

```bash
# Clone the repository
git clone https://github.com/Koumakan-Madoka/caff.git
cd caff

# Install dependencies
npm install

# Build and start
npm run start:dev
```

Then open **http://127.0.0.1:3100** in your browser.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CHAT_APP_HOST` | `127.0.0.1` | Server bind address |
| `CHAT_APP_PORT` | `3100` | Server port |
| `PI_CODING_AGENT_DIR` | auto-detected | Path to pi coding agent installation |
| `PI_SQLITE_PATH` | auto-detected | SQLite database file path |
| `PI_PROVIDER` | — | LLM provider identifier |
| `PI_MODEL` | — | Default model name |
| `PI_THINKING` | — | Enable thinking/reasoning mode |

## 🧪 Testing

CAFF uses a three-gate testing strategy:

| Gate | Command | What it checks |
|---|---|---|
| **A — Syntax** | `npm run check` | `node --check` on all frontend JS files |
| **B — Types** | `npm run typecheck` | TypeScript `--noEmit` for backend + `checkJs` for frontend |
| **C — Tests** | `npm run test:fast` | Unit tests for runtime, storage, HTTP layers |

Run everything:

```bash
npm test          # check + typecheck + build + unit + smoke
npm run test:fast # check + build + unit (no server startup)
npm run test:smoke # build + server smoke test
```

Tests use Node.js built-in `node:test` + `node:assert/strict` — no extra test framework required.

## 🎮 Game Modes

### Who is Undercover

1. Create a conversation with type `who_is_undercover`
2. Add agents as players
3. The backend automatically acts as host — assigning identities, running clue/vote rounds, and revealing results
4. Agents play using a dedicated skill that guides their responses

### Werewolf

1. Create a conversation with type `werewolf`
2. Configure roles (werewolf, seer, witch, villager)
3. The backend manages day/night phases, role actions, and win conditions
4. Each agent receives role-specific private instructions

## 📊 Evaluation Framework

The metrics dashboard (`/metrics.html`) provides:

- **A/B Batch Replay** — Run the same prompt with two different agent configurations and compare outputs
- **Per-Case History** — Track evaluation results over time
- **Metrics Collection** — Automated scoring on configurable dimensions

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, TypeScript (CommonJS) |
| Database | SQLite via `better-sqlite3` |
| Frontend | Vanilla JavaScript, Server-Sent Events (SSE) |
| Testing | `node:test`, `node:assert/strict` |
| CI | GitHub Actions |

## 📁 Project Structure

```
caff/
├── server/
│   ├── app/          # Server bootstrap & config
│   ├── http/         # Router, SSE, request/response
│   ├── api/          # REST controllers
│   └── domain/       # Business logic
│       ├── conversation/   # Turn orchestration, mention routing
│       ├── undercover/     # "Who is Undercover" game
│       ├── werewolf/       # Werewolf game
│       ├── runtime/        # Agent tool bridge
│       └── metrics/        # Eval report generation
├── storage/
│   ├── chat/         # Chat repository (conversations, messages, agents)
│   ├── run/          # Run & task repository
│   └── sqlite/       # DB connection & migrations
├── lib/              # Shared: Pi runtime, skill registry, project manager
├── public/           # Frontend: chat UI, editors, metrics
├── tests/            # Test suites (runtime, storage, HTTP, smoke)
├── docs/             # Design documents & migration plans
├── scripts/          # Build & utility scripts
└── types/            # Shared TypeScript type definitions
```

## 📜 License

This project is licensed under the [MIT License](LICENSE).

## 🤝 Contributing

Contributions are welcome! Please make sure:

- `npm test` passes before submitting a PR
- New features go into the appropriate domain module (not the server entry point)
- New pages use shared utilities from `public/shared/` instead of duplicating code

---

*CAFF — where agents chat, play games, and (sometimes) get evaluated.* 🐧
