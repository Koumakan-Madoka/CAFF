// Fast mode (service_tier: "priority") support detection for openai-codex
// subscription models. See docs/engineering/runtime/fast-mode-openai-codex.md.
//
// Rule: a model supports Fast iff its provider is openai-codex, its pi-ai api
// is openai-codex-responses AND
// the model is known to offer a `priority` service tier. The preferred source
// is the live backend catalog (GET /backend-api/codex/models), which is only
// available to credential-holding runtimes; this static allowlist seeded from
// the 2026-10-21 W1 probe (client_version 0.160.0 view) is the fallback and
// the basis for credential-blind projections such as /api/agents model
// options. Keep in sync with the runtime extension allowlist (W3).

export const FAST_MODE_API = 'openai-codex-responses';

export const FAST_MODE_MODEL_ALLOWLIST = Object.freeze([
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);

const FAST_MODE_MODEL_SET = new Set(FAST_MODE_MODEL_ALLOWLIST);

function normalize(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

export function supportsFastMode(option: any) {
  return normalize(option?.provider) === 'openai-codex'
    && normalize(option?.api) === FAST_MODE_API
    && FAST_MODE_MODEL_SET.has(normalize(option?.model));
}
