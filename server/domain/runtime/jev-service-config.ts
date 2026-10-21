// JEV service configuration (contract §6, system-services UI).
//
// The enable chain is three gates, all required:
//   TYPESAFE_ENABLED (env, process-level master switch)
//   && TYPESAFE_API_KEY configured (env; the key itself never leaves the
//      process — no API response may carry it)
//   && the DB toggle chat_system_service_toggles['turn-time-breakdown-jev']
//      (UI-managed; an ABSENT row means off, so default installs ship off)
//
// The DB toggle is read on every classification decision, so flipping it in
// the UI takes effect in the same process without a restart. The env gates
// still require a restart, and the status surface says so.
//
// The per-project projects.json switch `timeBreakdown.jevEnabled` is
// DEPRECATED and no longer participates in the decision (it predates this
// UI; no project ever enabled it).

import { createHttpError } from '../../http/http-errors';

export const JEV_SERVICE_TYPE = 'turn-time-breakdown-jev';

export type JevStatusReason = 'enabled' | 'master_switch_off' | 'api_key_missing' | 'db_switch_off';

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

// Four distinguishable states with an accurate reason — never collapse them
// into a single boolean, or the UI cannot tell the operator WHAT is missing.
export function resolveJevRuntimeStatus(input: any = {}) {
  const masterSwitchEnabled = input.masterSwitchEnabled === true;
  const apiKeyConfigured = input.apiKeyConfigured === true;
  const dbSwitchEnabled = input.dbSwitchEnabled === true;
  const connection = input.connectionInfo && typeof input.connectionInfo === 'object'
    ? input.connectionInfo
    : { baseUrl: '', model: '' };

  let reason: JevStatusReason = 'enabled';

  if (!masterSwitchEnabled) {
    reason = 'master_switch_off';
  } else if (!apiKeyConfigured) {
    reason = 'api_key_missing';
  } else if (!dbSwitchEnabled) {
    reason = 'db_switch_off';
  }

  return {
    effective: reason === 'enabled',
    reason,
    masterSwitchEnabled,
    apiKeyConfigured,
    dbSwitchEnabled,
    endpoint: stripUrlUserinfo(connection.baseUrl),
    model: trimString(connection.model),
  };
}

// Builds the exact resolver the pipeline uses (create-server wires this into
// turnTimeBreakdownPipeline). ALL THREE gates are enforced here — including
// the API-key gate — so the stored jev_status can never disagree with the
// status card: without this, DB-on + key-missing would write rows as
// 'pending' while the card says api_key_missing, and those rows would stay
// pending forever (the classifier is null, so nothing ever resolves them).
// Reading the store per call is what makes the toggle take effect
// immediately; the store read is a single prepared primary-key lookup.
export function createJevEnabledResolver(options: any = {}) {
  const store = options.store;
  const masterSwitchEnabled = options.masterSwitchEnabled === true;
  const apiKeyConfigured = options.apiKeyConfigured === true;

  return function isJevEnabled() {
    if (!masterSwitchEnabled || !apiKeyConfigured) {
      return false;
    }

    try {
      return Boolean(store && typeof store.getSystemServiceToggle === 'function'
        && store.getSystemServiceToggle(JEV_SERVICE_TYPE));
    } catch {
      return false;
    }
  };
}

export function createJevServiceConfigService(options: any = {}) {
  const store = options.store;
  const turnTimeBreakdownRepository = options.turnTimeBreakdownRepository;
  // Static process facts captured once at startup; env changes require a
  // restart anyway, and the status surface says so.
  const masterSwitchEnabled = options.masterSwitchEnabled === true;
  const apiKeyConfigured = options.apiKeyConfigured === true;
  const connectionInfo = options.connectionInfo && typeof options.connectionInfo === 'object'
    ? options.connectionInfo
    : { baseUrl: '', model: '' };

  if (!store || typeof store.getSystemServiceToggle !== 'function' || typeof store.setSystemServiceToggle !== 'function') {
    throw new Error('JEV service configuration requires the system service toggle store');
  }

  function isEnabled() {
    try {
      return store.getSystemServiceToggle(JEV_SERVICE_TYPE) === true;
    } catch {
      return false;
    }
  }

  function getConfiguration() {
    const enabled = isEnabled();
    return {
      serviceType: JEV_SERVICE_TYPE,
      config: { enabled },
      status: resolveJevRuntimeStatus({
        masterSwitchEnabled,
        apiKeyConfigured,
        dbSwitchEnabled: enabled,
        connectionInfo,
      }),
      cache: {
        entries: turnTimeBreakdownRepository && typeof turnTimeBreakdownRepository.countJevCacheEntries === 'function'
          ? turnTimeBreakdownRepository.countJevCacheEntries()
          : 0,
      },
    };
  }

  function updateConfiguration(payload: any) {
    const source = payload && typeof payload === 'object' ? payload : {};

    // Fail closed at the service boundary too (the controller already
    // 422s this): a non-boolean `enabled` must never be silently coerced
    // into OFF, whatever caller passes it.
    if (Object.prototype.hasOwnProperty.call(source, 'enabled') && typeof source.enabled !== 'boolean') {
      throw createHttpError(422, 'enabled must be a boolean', {
        issues: [{ code: 'invalid_enabled_value', path: 'enabled' }],
      });
    }

    store.setSystemServiceToggle(JEV_SERVICE_TYPE, source.enabled === true);
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
