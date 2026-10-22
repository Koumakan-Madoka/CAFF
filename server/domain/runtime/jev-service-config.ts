// JEV service configuration (contract §6, system-services UI).
//
// The enable chain is a SINGLE decision point, both gates read from the DB:
//   the DB toggle chat_system_service_toggles['turn-time-breakdown-jev']
//   && a configured API key in
//      chat_system_service_credentials['turn-time-breakdown-jev']
// Both are managed from the system-services UI and read on every
// classification decision, so flipping the toggle or writing/clearing the
// key takes effect in the same process without a restart.
//
// The classification pipeline NEVER reads TYPESAFE_ENABLED /
// TYPESAFE_API_KEY / TYPESAFE_BASE_URL / TYPESAFE_MODEL from the
// environment: the panel is the only switch and the DB row the only key
// source (user-ruled 2026-10-22: multiple switches in different places only
// confuse operators). A leftover env key is ignored — the status surface
// says so. The separate `jev_ask` agent tool (disabled by default) still
// uses the env convention; it is not part of this pipeline.
//
// The API key is stored in plaintext in the local sqlite (user-ruled: for a
// loopback-only local tool this is the same exposure as .env.local on the
// same disk) and is WRITE-ONLY: GET returns a `configured` boolean, and no
// API response, error body, log line, or event payload may carry the value.
//
// The per-project projects.json switch `timeBreakdown.jevEnabled` is
// DEPRECATED and no longer participates in the decision (it predates this
// UI; no project ever enabled it).

import { createHash } from 'node:crypto';

import { createHttpError } from '../../http/http-errors';
import { resolveTypeSafeConnectionInfo } from '../integrations/typesafe/typesafe-client';

export const JEV_SERVICE_TYPE = 'turn-time-breakdown-jev';

export type JevStatusReason = 'enabled' | 'api_key_missing' | 'db_switch_off';

const MAX_API_KEY_LENGTH = 512;
const MAX_BASE_URL_LENGTH = 2048;
const MAX_MODEL_LENGTH = 200;

// Pure client defaults with NO env fallback: the panel shows these values
// until the operator overrides them in the DB, and the pipeline client is
// built from exactly the same source.
const DEFAULT_CONNECTION = resolveTypeSafeConnectionInfo({ env: {} });

function trimString(value: any) {
  return String(value === undefined || value === null ? '' : value).trim();
}

// GET responses may show the endpoint, but a URL like https://u:p@host would
// leak credentials to any reader. Strip userinfo; an unparseable value is
// redacted outright rather than shown raw.
export function stripUrlUserinfo(rawUrl: any) {
  const value = trimString(rawUrl);

  if (!value) {
    return '';
  }

  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/+$/u, '');
  } catch {
    return '<invalid-url>';
  }
}

// Three distinguishable states with an accurate reason — never collapse them
// into a single boolean, or the UI cannot tell the operator WHAT is missing.
export function resolveJevRuntimeStatus(input: any = {}) {
  const apiKeyConfigured = input.apiKeyConfigured === true;
  const dbSwitchEnabled = input.dbSwitchEnabled === true;
  const connection = input.connectionInfo && typeof input.connectionInfo === 'object'
    ? input.connectionInfo
    : { baseUrl: '', model: '' };

  let reason: JevStatusReason = 'enabled';

  if (!apiKeyConfigured) {
    reason = 'api_key_missing';
  } else if (!dbSwitchEnabled) {
    reason = 'db_switch_off';
  }

  return {
    effective: reason === 'enabled',
    reason,
    apiKeyConfigured,
    dbSwitchEnabled,
    endpoint: stripUrlUserinfo(connection.baseUrl),
    model: trimString(connection.model),
  };
}

function readCredentialRow(store: any) {
  try {
    return store && typeof store.getSystemServiceCredential === 'function'
      ? store.getSystemServiceCredential(JEV_SERVICE_TYPE)
      : null;
  } catch {
    return null;
  }
}

// The pipeline's only configuration source. Returns null when no usable key
// is stored; otherwise the full client material plus a fingerprint of it so
// the pipeline can rebuild its cached client exactly when the material
// changes (key rotation, endpoint/model override, key cleared). Rebuilding
// intentionally resets the client's process-local budget counters.
export function readJevClientMaterial(store: any) {
  const credential = readCredentialRow(store);
  const apiKey = trimString(credential && credential.apiKey);

  if (!apiKey) {
    return null;
  }

  const baseUrl = trimString(credential && credential.baseUrl) || DEFAULT_CONNECTION.baseUrl;
  const model = trimString(credential && credential.model) || DEFAULT_CONNECTION.model;
  const fingerprint = createHash('sha256')
    .update(`${apiKey}\n${baseUrl}\n${model}`)
    .digest('hex')
    .slice(0, 16);

  return { fingerprint, apiKey, baseUrl, model };
}

// Builds the exact resolver the pipeline uses (create-server wires this into
// turnTimeBreakdownPipeline). BOTH gates are enforced here — the DB toggle
// and the stored API key — so the stored jev_status can never disagree with
// the status card: without the key gate, toggle-on + key-missing would write
// rows as 'pending' while the card says api_key_missing, and those rows
// would stay pending forever (the classifier is null, so nothing ever
// resolves them). Reading the store per call is what makes changes take
// effect immediately; each read is a single prepared primary-key lookup.
export function createJevEnabledResolver(options: any = {}) {
  const store = options.store;

  return function isJevEnabled() {
    try {
      if (!store || typeof store.getSystemServiceToggle !== 'function'
        || store.getSystemServiceToggle(JEV_SERVICE_TYPE) !== true) {
        return false;
      }

      return Boolean(readJevClientMaterial(store));
    } catch {
      return false;
    }
  };
}

export function createJevServiceConfigService(options: any = {}) {
  const store = options.store;
  const turnTimeBreakdownRepository = options.turnTimeBreakdownRepository;

  if (!store || typeof store.getSystemServiceToggle !== 'function' || typeof store.setSystemServiceToggle !== 'function'
    || typeof store.getSystemServiceCredential !== 'function' || typeof store.updateSystemServiceCredential !== 'function') {
    throw new Error('JEV service configuration requires the system service toggle and credential stores');
  }

  function isEnabled() {
    try {
      return store.getSystemServiceToggle(JEV_SERVICE_TYPE) === true;
    } catch {
      return false;
    }
  }

  function effectiveConnectionInfo(credential: any) {
    return {
      baseUrl: trimString(credential && credential.baseUrl) || DEFAULT_CONNECTION.baseUrl,
      model: trimString(credential && credential.model) || DEFAULT_CONNECTION.model,
    };
  }

  function getConfiguration() {
    const enabled = isEnabled();
    const credential = readCredentialRow(store);
    const apiKeyConfigured = Boolean(credential && trimString(credential.apiKey));
    return {
      serviceType: JEV_SERVICE_TYPE,
      config: { enabled, apiKeyConfigured },
      status: resolveJevRuntimeStatus({
        apiKeyConfigured,
        dbSwitchEnabled: enabled,
        connectionInfo: effectiveConnectionInfo(credential),
      }),
      cache: {
        entries: turnTimeBreakdownRepository && typeof turnTimeBreakdownRepository.countJevCacheEntries === 'function'
          ? turnTimeBreakdownRepository.countJevCacheEntries()
          : 0,
      },
    };
  }

  // Validation lives at the service boundary too (the controller mirrors
  // it): a future caller bypassing HTTP (script, migration) must inherit
  // the same fail-closed semantics. Every rejection is a 422 with a stable
  // issue code; nothing is silently coerced.
  function assertValidPayload(source: any) {
    if (Object.prototype.hasOwnProperty.call(source, 'enabled') && typeof source.enabled !== 'boolean') {
      throw createHttpError(422, 'enabled must be a boolean', {
        issues: [{ code: 'invalid_enabled_value', path: 'enabled' }],
      });
    }

    const hasApiKey = Object.prototype.hasOwnProperty.call(source, 'apiKey');
    const hasClearApiKey = Object.prototype.hasOwnProperty.call(source, 'clearApiKey');

    if (hasApiKey && (typeof source.apiKey !== 'string' || !trimString(source.apiKey) || source.apiKey.length > MAX_API_KEY_LENGTH)) {
      throw createHttpError(422, 'apiKey must be a non-empty string', {
        issues: [{ code: 'invalid_api_key', path: 'apiKey' }],
      });
    }

    if (hasClearApiKey && source.clearApiKey !== true) {
      throw createHttpError(422, 'clearApiKey must be exactly true when present', {
        issues: [{ code: 'invalid_clear_flag', path: 'clearApiKey' }],
      });
    }

    // Set and clear are mutually exclusive — accepting both would make the
    // outcome order-dependent.
    if (hasApiKey && hasClearApiKey) {
      throw createHttpError(422, 'apiKey and clearApiKey cannot be combined in one write', {
        issues: [{ code: 'credential_conflict', path: 'apiKey' }],
      });
    }

    if (Object.prototype.hasOwnProperty.call(source, 'baseUrl')) {
      const baseUrl = trimString(source.baseUrl);
      if (typeof source.baseUrl !== 'string' || source.baseUrl.length > MAX_BASE_URL_LENGTH
        || (baseUrl && !/^https?:\/\//u.test(baseUrl))) {
        throw createHttpError(422, 'baseUrl must be an http(s) URL (empty resets to the default)', {
          issues: [{ code: 'invalid_base_url', path: 'baseUrl' }],
        });
      }
    }

    if (Object.prototype.hasOwnProperty.call(source, 'model')) {
      if (typeof source.model !== 'string' || source.model.length > MAX_MODEL_LENGTH) {
        throw createHttpError(422, 'model must be a short string (empty resets to the default)', {
          issues: [{ code: 'invalid_model', path: 'model' }],
        });
      }
    }
  }

  function updateConfiguration(payload: any) {
    const source = payload && typeof payload === 'object' ? payload : {};
    assertValidPayload(source);

    // Snapshot the effective connection BEFORE writing: an endpoint/model
    // change invalidates every cached classification (they were produced by
    // a different model/endpoint), while a key rotation against the same
    // model does not.
    const before = effectiveConnectionInfo(readCredentialRow(store));

    if (Object.prototype.hasOwnProperty.call(source, 'enabled')) {
      store.setSystemServiceToggle(JEV_SERVICE_TYPE, source.enabled === true);
    }

    const credentialChanges: any = {};
    if (Object.prototype.hasOwnProperty.call(source, 'apiKey')) {
      credentialChanges.setApiKey = source.apiKey;
    }
    if (source.clearApiKey === true) {
      credentialChanges.clearApiKey = true;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'baseUrl')) {
      credentialChanges.baseUrl = trimString(source.baseUrl);
    }
    if (Object.prototype.hasOwnProperty.call(source, 'model')) {
      credentialChanges.model = trimString(source.model);
    }

    if (Object.keys(credentialChanges).length > 0) {
      store.updateSystemServiceCredential(JEV_SERVICE_TYPE, credentialChanges);
    }

    const after = effectiveConnectionInfo(readCredentialRow(store));
    if ((after.baseUrl !== before.baseUrl || after.model !== before.model)
      && turnTimeBreakdownRepository && typeof turnTimeBreakdownRepository.clearJevCache === 'function') {
      // Cached categories came from the old model/endpoint; keeping them
      // would silently apply stale verdicts under new settings.
      turnTimeBreakdownRepository.clearJevCache();
    }

    return getConfiguration();
  }

  function clearCache() {
    if (!turnTimeBreakdownRepository || typeof turnTimeBreakdownRepository.clearJevCache !== 'function') {
      throw new Error('JEV cache store unavailable');
    }

    const cleared = turnTimeBreakdownRepository.clearJevCache();
    return { cleared };
  }

  return {
    getConfiguration,
    updateConfiguration,
    clearCache,
  };
}
