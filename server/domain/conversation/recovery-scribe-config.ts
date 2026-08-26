import { RECOVERY_SCRIBE_SYSTEM_ACTOR } from '../roles/system-actor-catalog';

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
  if (!config.provider || !config.model || !THINKING_LEVELS.has(config.thinking)) {
    throw new Error('Recovery scribe runtime defaults are invalid');
  }
  if (!Number.isInteger(config.timeoutMs)
    || config.timeoutMs < MIN_RECOVERY_TIMEOUT_MS
    || config.timeoutMs > MAX_RECOVERY_TIMEOUT_MS) {
    throw new Error(`recovery timeout must be between ${MIN_RECOVERY_TIMEOUT_MS} and ${MAX_RECOVERY_TIMEOUT_MS} milliseconds`);
  }
  return config;
}

function validateUpdate(payload: any, modelOptions: any[]) {
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
  if (!provider) {
    throw new RecoveryScribeConfigError('recovery_config_provider_required', 'body.provider');
  }
  if (!model) {
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

  const option = modelOptions.find((candidate) => (
    normalizeText(candidate && candidate.provider) === provider
    && normalizeText(candidate && candidate.model) === model
  ));
  if (!option) {
    throw new RecoveryScribeConfigError('recovery_config_model_unavailable', 'body.model');
  }
  const supportedThinkingLevels = Array.isArray(option.supportedThinkingLevels)
    ? option.supportedThinkingLevels.map(normalizeText).filter(Boolean)
    : ['off'];
  if (!supportedThinkingLevels.includes(thinking)) {
    throw new RecoveryScribeConfigError('recovery_config_thinking_unsupported', 'body.thinking');
  }

  return { enabled: payload.enabled, provider, model, thinking, timeoutMs };
}

export function createRecoveryScribeConfigManager(options: any = {}) {
  const store = options.store;
  const modelCatalog = options.modelCatalog || null;
  const defaults = validateDefaults(options.defaults);

  function modelOptions() {
    if (!modelCatalog || typeof modelCatalog.getOptions !== 'function') {
      return [];
    }
    const value = modelCatalog.getOptions();
    return Array.isArray(value) ? value : [];
  }

  function persisted() {
    if (!store || typeof store.getSystemServiceConfig !== 'function') {
      return null;
    }
    return store.getSystemServiceConfig(RECOVERY_SCRIBE_SYSTEM_ACTOR.type);
  }

  function getConfigSnapshot() {
    const row = persisted();
    return row ? cloneConfig(row) : cloneConfig(defaults);
  }

  function getConfiguration() {
    const row = persisted();
    return {
      config: row ? cloneConfig(row) : cloneConfig(defaults),
      source: row ? 'persisted' : 'runtime_defaults',
      updatedAt: row ? row.updatedAt : null,
      modelOptions: structuredClone(modelOptions()),
    };
  }

  function updateConfiguration(payload: any) {
    if (!store || typeof store.saveSystemServiceConfig !== 'function') {
      throw new RecoveryScribeConfigError('recovery_config_store_unavailable', 'store');
    }
    const config = validateUpdate(payload, modelOptions());
    const saved = store.saveSystemServiceConfig(RECOVERY_SCRIBE_SYSTEM_ACTOR.type, config);
    return {
      config: cloneConfig(saved),
      source: 'persisted',
      updatedAt: saved.updatedAt,
      modelOptions: structuredClone(modelOptions()),
    };
  }

  return {
    getConfigSnapshot,
    getConfiguration,
    updateConfiguration,
  };
}
