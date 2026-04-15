# Windows autostart for CAFF and OpenSandbox

## Goal
Make the local CAFF + OpenSandbox stack restart cleanly after Windows reboot or login, without manually re-running WSL keepalive commands.

## Requirements
- Provide a Windows-friendly startup entry point for the full local stack
- Keep OpenSandbox running through WSL Debian with Docker and `opensandbox-local`
- Start CAFF from the repo root with the existing local environment
- Document or automate scheduled task registration so the stack comes back after reboot/login
- Keep changes cross-platform safe by isolating Windows-specific behavior to dedicated scripts/docs

## Acceptance Criteria
- [ ] Repo contains a runnable Windows startup script for the local stack
- [ ] Repo contains a matching scheduled-task registration script or documented command
- [ ] Startup flow uses the current `localhost:8080` OpenSandbox endpoint and existing CAFF start command
- [ ] Instructions include how to verify CAFF and OpenSandbox health after setup

## Technical Notes
- Target environment is Windows host + WSL Debian + Docker inside WSL
- Prefer a small wrapper script over changing CAFF runtime behavior
- Avoid assuming Docker Desktop; the current setup uses Docker in WSL
