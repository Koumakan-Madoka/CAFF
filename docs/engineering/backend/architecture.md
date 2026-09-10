# Backend Architecture

## Primary Layers

- `server/app/`: composition root that wires stores, services, controllers, and
  runtime configuration
- `server/api/`: thin HTTP handlers that read request input and delegate to
  services or stores
- `server/http/`: shared transport helpers such as router, JSON responses, and
  request-body parsing
- `server/domain/`: feature logic for conversations, runtime, metrics,
  undercover, and werewolf

## Conventions

- Keep controllers thin. Parse input, call a domain helper, then return JSON.
- Put reusable business rules in `server/domain/`, not inline inside controller
  files.
- Keep transport concerns in `server/http/` rather than re-implementing them in
  each controller.
- When a backend change affects agent execution or prompt contents, review the
  matching runtime files instead of guessing from the API layer alone.

## Watch Points

- `server/app/create-server.ts` is the central wiring point. Changes there often
  affect multiple routes and runtime services.
- Active project handling flows through the project manager and then into the
  turn orchestrator. Treat project-path changes as cross-layer work.
- Game features and agent-tool features are backend-hosted workflows, so API
  changes often need runtime and test updates too.
