import { createHash } from 'node:crypto';

// Keep the credential-blind server projection in fast-mode-support.ts in sync.
export const FAST_MODE_MODEL_ALLOWLIST = Object.freeze([
  'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
]);
const FALLBACK_MODELS = new Set(FAST_MODE_MODEL_ALLOWLIST);
const CODEX_API = 'openai-codex-responses';
const CATALOG_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.160.0';

/** @param {any} model */
export function isCodexSubscriptionModel(model) {
  return model?.api === CODEX_API && model?.provider === 'openai-codex';
}

/** @param {string} apiKey */
function accountIdFromKey(apiKey) {
  try {
    const claims = JSON.parse(Buffer.from(apiKey.split('.')[1], 'base64url').toString('utf8'));
    const accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof accountId === 'string' ? accountId : '';
  } catch {
    return '';
  }
}

/** @typedef {{ models: Set<string> | null, expiresAt: number }} CatalogCache */

/** Per-runtime, memory-only cache. Never persists credentials or catalog data. */
export function createFastSupportResolver({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 1500 } = {}) {
  let identity = '';
  let generation = 0;
  /** @type {CatalogCache | null} */
  let cached = null;
  /** @type {Promise<CatalogCache> | null} */
  let pending = null;

  /** @param {any} model @param {any} registry */
  return async function resolveSupport(model, registry) {
    if (!isCodexSubscriptionModel(model)) return { supported: false, source: 'out_of_scope' };
    const fallback = () => ({ supported: FALLBACK_MODELS.has(model.id), source: 'allowlist' });
    let auth;
    try {
      auth = await registry?.getApiKeyAndHeaders(model);
    } catch {
      // Do not leak authentication errors or values through extension diagnostics.
    }
    const apiKey = auth?.ok && typeof auth.apiKey === 'string' ? auth.apiKey : '';
    const headers = new Headers(auth?.ok ? auth.headers : undefined);
    const accountId = headers.get('chatgpt-account-id') || accountIdFromKey(apiKey);
    const baseUrl = auth?.baseUrl || model.baseUrl || 'https://chatgpt.com/backend-api';
    const nextIdentity = createHash('sha256').update(JSON.stringify([apiKey, accountId, baseUrl])).digest('hex');
    if (nextIdentity !== identity) {
      identity = nextIdentity;
      generation += 1;
      cached = null;
      pending = null;
    }
    const resolveGeneration = generation;
    // Never forward subscription credentials to a redirected or custom endpoint.
    if (!apiKey || !accountId || baseUrl.replace(/\/$/u, '') !== 'https://chatgpt.com/backend-api') return fallback();
    if (!cached || cached.expiresAt <= now()) {
      if (!pending) {
        const requestGeneration = generation;
        const request = (async () => {
          /** @type {Set<string> | null} */
          let models = null;
          try {
            headers.set('Authorization', `Bearer ${apiKey}`);
            headers.set('chatgpt-account-id', accountId);
            headers.set('originator', 'pi');
            const response = await fetchImpl(CATALOG_URL, {
              headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) throw new Error('catalog_unavailable');
            const body = await response.json();
            if (!Array.isArray(body?.models) || !body.models.every((/** @type {any} */ entry) => typeof entry?.slug === 'string')) {
              throw new Error('invalid_catalog');
            }
            models = new Set(body.models.filter((/** @type {any} */ entry) =>
              Array.isArray(entry.service_tiers) && entry.service_tiers.some((/** @type {any} */ tier) => tier?.id === 'priority')
            ).map((/** @type {any} */ entry) => entry.slug));
          } catch {
            // Failure-only fallback; a valid empty/negative catalog remains authoritative.
          }
          const result = { models, expiresAt: now() + (models ? 300_000 : 30_000) };
          if (generation === requestGeneration) cached = result;
          return result;
        })();
        pending = request;
        void request.finally(() => { if (pending === request) pending = null; });
      }
      const result = await pending;
      // A concurrent account switch must never consume an old account's result.
      if (generation !== resolveGeneration) return { supported: false, source: 'account_changed' };
      return result.models
        ? { supported: result.models.has(model.id), source: 'catalog' }
        : fallback();
    }
    return cached.models
      ? { supported: cached.models.has(model.id), source: 'catalog' }
      : fallback();
  };
}

/** Config is captured per SDK runtime, not inherited from ambient process env. */
export function createFastModeExtension({ enabled = false, resolveSupport = createFastSupportResolver(), onRequest = (/** @type {any} */ _request) => {} } = {}) {
  // Diagnostics must not change request behavior or expose resolver errors/auth.
  /** @param {string} status @param {string | null} [supportSource] */
  const report = (status, supportSource = null) => {
    const source = supportSource && ['catalog', 'allowlist', 'out_of_scope', 'account_changed'].includes(supportSource) ? supportSource : null;
    try {
      onRequest({ status, supportSource: source, serviceTierRequested: status === 'requested' ? 'priority' : null });
    } catch { /* Observability failure must never undo a payload rewrite. */ }
  };
  /** @param {{ on(event: string, handler: (event: any, ctx: any) => any): void }} pi */
  return function registerFastMode(pi) {
    pi.on('before_provider_request', async (event, ctx) => {
      if (enabled !== true) { report('disabled'); return; }
      try {
        if (!isCodexSubscriptionModel(ctx.model)) { report('out_of_scope', 'out_of_scope'); return; }
        const support = await resolveSupport(ctx.model, ctx.modelRegistry);
        if (!support.supported) { report('unsupported', support.source); return; }
        if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
          report('error');
          return;
        }
        const payload = { ...event.payload, service_tier: 'priority' };
        report('requested', support.source);
        return payload;
      } catch {
        // pi's extension runner is fail-open. Preserve that behavior, but expose
        // a closed error code instead of silently looking like requested Fast.
        report('error');
        return;
      }
    });
  };
}
