# PRD: Model Observability From Model-Call Perspective

## Goal
Unify chat runtime usage and trace observability around the question "how many times did we ask the model?" so model calls, tool executions, cache behavior, provider misses, and cost are displayed as separate but connected concepts.

## Background
The current provider miss visualization exposes useful cache data, but the UI still mixes two different notions of "rounds": model-call rounds and tool execution steps. Users can see provider miss counts that do not match tool trace counts, which is technically correct but confusing. The model observability UI should make model calls first-class and render tool calls as events caused by, or occurring between, model calls.

## Scope
- In scope:
  - Treat each model call in an assistant turn as a first-class observable item with a stable per-turn index.
  - Persist and return normalized per-model-call usage through assistant message metadata and tool trace APIs.
  - Rename ambiguous "round" wording to "model call" / "tool execution" wording in UI labels and tooltips.
  - Present a unified assistant-turn timeline that separates model calls from tool executions while preserving chronological order where available.
  - Show per-assistant-turn summary: model call count, cold-start call count, provider miss count, tool execution count, input/output/cache-read/cache-write tokens, hit ratio, and USD cost.
  - Mark provider miss only for non-cold model calls with positive uncached input and zero cache read.
  - Preserve current tool trace details and existing token badge behavior for historical messages without detailed model usage.
  - Add regression tests for normalized summaries, trace API payloads, and UI wording/format helper behavior where testable.
  - Update runtime/frontend specs with the final observability contract.
- Out of scope:
  - Do not change provider pricing configuration semantics.
  - Do not change model invocation behavior or force cache/prompt changes in this task.
  - Do not remove raw provider usage metadata used for diagnostics.
  - Do not build a full cost analytics dashboard beyond per-turn/message observability.

## Proposed UX Contract
- Top-level assistant badge uses model-call language, for example:
  - `3 次模型调用 · 42.1k token · $0.0312 · 命中 28.0k (66%) · provider miss 1/2`
- Expanded trace has separate sections or a single typed timeline:
  - `模型调用 #1 · 冷启动`
  - `工具执行 #1 · bash`
  - `模型调用 #2 · provider miss`
  - `工具执行 #2 · send-public`
- Tool execution counts never serve as the denominator for provider miss rates.
- Cold-start model calls remain visible but excluded from provider miss denominator.

## Data Contract
Per assistant message metadata should expose:
- `tokenUsage`: aggregated normalized usage for the whole assistant turn.
- `modelUsage`: normalized per-turn model-call summary:
  - `modelCallCount: number`
  - `coldStartModelCallCount: number`
  - `postColdModelCallCount: number`
  - `providerMissCount: number`
  - `toolExecutionCount?: number` when known from trace data
  - `calls: ModelUsageCall[]`
- `ModelUsageCall` fields:
  - `index: number` (1-based display index)
  - `isColdStart: boolean`
  - `providerMiss: boolean`
  - `tokenUsage: NormalizedTokenUsage | null`
  - `rawUsage?: object` only where already exposed safely for diagnostics

Trace API should preserve existing tool steps and add model usage in a way the UI can render without inferring provider miss differently from the backend.

## Acceptance Criteria
- [ ] UI labels distinguish `模型调用` from `工具执行`; no ambiguous cache "round" wording remains in the modified observability path.
- [ ] Assistant message badge summarizes model calls, total usage, cache read hit ratio, provider miss count, and cost from one normalized source.
- [ ] Expanded tool trace displays model-call usage as first-class rows or a clearly separate section, with cold-start and provider-miss labels.
- [ ] Provider miss denominator excludes cold-start model calls and never uses tool execution count.
- [ ] Tool executions remain visible with existing command/status/result previews and are counted separately.
- [ ] Historical assistant messages without per-call usage still render without errors and keep aggregate token badge behavior.
- [ ] Backend normalization and trace API tests cover cold start, cache hit, provider miss, missing usage, and multiple tool executions.
- [ ] Frontend helper tests or syntax checks cover wording/formatting changes where existing test harness supports them.
- [ ] `npm run build`, `npm run typecheck`, `npm run check`, and targeted runtime tests pass.
- [ ] Runtime/frontend specs document the unified model-call observability contract.

## Risks
- Existing messages may have aggregate `usage` but no per-call `modelUsage`; UI must degrade gracefully.
- Chronological interleaving can be approximate if historical trace events lack timestamps linking model calls to tool calls.
- Frontend duplication risk is high; prefer shared usage formatting helpers over separate badge and trace implementations.
- Provider usage field names vary; all UI should consume backend-normalized usage instead of re-normalizing raw provider objects.
