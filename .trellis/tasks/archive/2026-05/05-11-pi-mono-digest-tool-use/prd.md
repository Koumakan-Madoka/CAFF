# PRD: pi-mono Digest JSON Mode Structured Output

## Goal
Use pi-mono direct model calls with OpenAI-compatible JSON Mode to generate Current Conversation Digest payloads as valid JSON objects, then validate the fixed digest schema locally before storage.

## Background
Current model digest generation asks the model to return JSON text, then parses and repairs it in `server/domain/conversation/conversation-digest.ts`. This can fail when the model emits invalid JSON shape such as anonymous top-level arrays. DeepSeek v4-flash supports `response_format: { type: "json_object" }`, which improves JSON validity without relying on forced tool calls.

## Scope
- In scope:
  - Use direct `pi-ai` calls for model digest generation when no injected `digestModelRunner` is provided.
  - Send `response_format: { type: "json_object" }` for the direct digest call.
  - Validate the returned JSON object locally before accepting it.
  - Read configured DeepSeek model details and API key from `.pi-sandbox/models.json` when the pi-ai registry lacks the requested model.
  - Preserve existing extractive fallback and existing invalid-output warning behavior.
  - Add regression tests for JSON Mode success and malformed JSON Mode fallback.
- Out of scope:
  - Do not add or expose a virtual digest tool to ordinary agent chat turns.
  - Do not force `toolChoice` for digest generation.
  - Do not change chat bridge tools or agent-facing tool prompts.
  - Do not introduce a new persisted digest section unless existing storage schema is expanded deliberately.
  - Do not remove the existing text JSON parser fallback unless all providers are migrated.

## Digest Schema
MVP must match the current persisted digest contract:
- `summary: string`
- `facts: string[]`
- `decisions: string[]`
- `openQuestions: string[]`
- `nextActions: string[]`
- `artifacts: string[]`
- `experience?: ExperienceDigestItem[]` only if existing model digest flow still requires it

`confirmations` is not part of the current persisted digest section keys and should not be added in this MVP unless the storage, rendering, rollup, Inspector, and specs are intentionally updated together.

## Acceptance Criteria
- [ ] Digest model calls for direct pi-mono generation send `response_format: { type: "json_object" }`.
- [ ] The direct digest call does not register a virtual tool and does not force `toolChoice`.
- [ ] Returned JSON is normalized and locally validated before storage.
- [ ] Missing required fields, malformed section types, or non-object JSON trigger the existing warning/fallback path without corrupting stored digests.
- [ ] Existing manual/extractive digest behavior remains unchanged.
- [ ] Tests cover valid JSON Mode payload, missing required fields, non-object JSON, and DeepSeek models.json fallback.
- [ ] Backend specs document the JSON Mode digest contract.
