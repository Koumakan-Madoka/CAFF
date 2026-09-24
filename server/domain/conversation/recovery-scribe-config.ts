import { RECOVERY_SCRIBE_SYSTEM_ACTOR } from '../roles/system-actor-catalog';
import { inspectModelConfiguration } from '../models/model-configuration';

export const MIN_RECOVERY_TIMEOUT_MS = 1_000;
export const MAX_RECOVERY_TIMEOUT_MS = 60_000;

const CONFIG_FIELDS = new Set(['enabled', 'provider', 'model', 'thinking', 'timeoutMs']);
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export class RecoveryScribeConfigError extends Error {
  code: string;
  path: string;

  constructor(code: string, path: string) {
    super(code);
    this.name = 'RecoveryScribeConfigError';
    this.code = code;
    this.path = path;
  }
}

function normalizeText(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneConfig(config: any) {
  return {
    enabled: Boolean(config.enabled),
    provider: normalizeText(config.provider),
    model: normalizeText(config.model),
    thinking: normalizeText(config.thinking),
    timeoutMs: Number(config.timeoutMs),
  };
}

function validateDefaults(defaults: any) {
  const config = cloneConfig(defaults);
  if (!THINKING_LEVELS.has(config.thinking)) {
    throw new Error('Recovery scribe runtime defaults are invalid');
  }
  if (!Number.isInteger(config.timeoutMs)
    || config.timeoutMs < MIN_RECOVERY_TIMEOUT_MS
    || config.timeoutMs > MAX_RECOVERY_TIMEOUT_MS) {
    throw new Error(`recovery timeout must be between ${MIN_RECOVERY_TIMEOUT_MS} and ${MAX_RECOVERY_TIMEOUT_MS} milliseconds`);
  }
  return config;
}

function validateUpdate(payload: any, allowEmptySelection = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RecoveryScribeConfigError('recovery_config_body_invalid', 'body');
  }
  for (const key of Object.keys(payload)) {
    if (!CONFIG_FIELDS.has(key)) {
      throw new RecoveryScribeConfigError('recovery_config_field_not_allowed', `body.${key}`);
    }
  }
  for (const key of CONFIG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new RecoveryScribeConfigError('recovery_config_field_required', `body.${key}`);
    }
  }
  if (typeof payload.enabled !== 'boolean') {
    throw new RecoveryScribeConfigError('recovery_config_enabled_invalid', 'body.enabled');
  }
  const provider = normalizeText(payload.provider);
  const model = normalizeText(payload.model);
  const thinking = normalizeText(payload.thinking);
  const timeoutMs = payload.timeoutMs;
  if (!provider && !allowEmptySelection) {
    throw new RecoveryScribeConfigError('recovery_config_provider_required', 'body.provider');
  }
  if (!model && !allowEmptySelection) {
    throw new RecoveryScribeConfigError('recovery_config_model_required', 'body.model');
  }
  if (!THINKING_LEVELS.has(thinking)) {
    throw new RecoveryScribeConfigError('recovery_config_thinking_invalid', 'body.thinking');
  }
  if (!Number.isInteger(timeoutMs)
    || timeoutMs < MIN_RECOVERY_TIMEOUT_MS
    || timeoutMs > MAX_RECOVERY_TIMEOUT_MS) {
    throw new RecoveryScribeConfigError('recovery_config_timeout_invalid', 'body.timeoutMs');
  }

  return { enabled: payload.enabled, provider, model, thinking, timeoutMs };
}

export function createRecoveryScribeConfigManager(options: any = {}) {
  const store = options.store;
  const modelCatalog = options.modelCatalog || null;
  const defaults = validateDefaults(options.defaults);

  function unconfigured() {
    // Startup preferences are not a saved choice of the shared system model.
    return { ...cloneConfig(defaults), provider: '', model: '', thinking: 'off' };
  }

  function persisted() {
    if (!store || typeof store.getSystemServiceConfig !== 'function') {
      return null;
    }
    return store.getSystemServiceConfig(RECOVERY_SCRIBE_SYSTEM_ACTOR.type);
  }

  function getConfigSnapshot() {
    const row = persisted();
    return row ? cloneConfig(row) : unconfigured();
  }

  function inspectConfiguration(config: any) {
    const inspection = inspectModelConfiguration(modelCatalog, config);
    const code = inspection.code ? `recovery_config_${inspection.code}` : '';
    const path = inspection.path;
    return {
      modelOptions: inspection.modelOptions,
      readiness: {
        ready: !code,
        status: code ? 'needs_configuration' : 'ready',
        code,
        path,
        configurationUrl: '/personas.html#system-services',
      },
    };
  }

  function getConfiguration() {
    const row = persisted();
    const config = row ? cloneConfig(row) : unconfigured();
    return {
      config,
      source: row ? 'persisted' : 'unconfigured',
      updatedAt: row ? row.updatedAt : null,
      ...inspectConfiguration(config),
    };
  }

  function updateConfiguration(payload: any) {
    if (!store || typeof store.saveSystemServiceConfig !== 'function') {
      throw new RecoveryScribeConfigError('recovery_config_store_unavailable', 'store');
    }
    const current = getConfigSnapshot();
    const allowEmptySelection = payload?.enabled === false && !current.provider && !current.model
      && payload.provider === '' && payload.model === '';
    const config = validateUpdate(payload, allowEmptySelection);
    const disableUnchanged = !config.enabled && (['provider', 'model', 'thinking', 'timeoutMs'] as const)
      .every((key) => config[key] === current[key]);
    const inspection = inspectConfiguration(config);
    if (!inspection.readiness.ready && !disableUnchanged) {
      throw new RecoveryScribeConfigError(inspection.readiness.code, inspection.readiness.path);
    }
    const saved = store.saveSystemServiceConfig(RECOVERY_SCRIBE_SYSTEM_ACTOR.type, config);
    return {
      config: cloneConfig(saved),
      source: 'persisted',
      updatedAt: saved.updatedAt,
      ...inspection,
    };
  }

  return {
    getConfigSnapshot,
    getConfiguration,
    updateConfiguration,
  };
}
