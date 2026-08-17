const MODEL_FAMILIES = new Set([
  'gpt',
  'claude',
  'gemini',
  'deepseek',
  'qwen',
  'glm',
  'kimi',
]);

const WRITABLE_SECRET_MODES = new Set(['literal', 'env', 'command']);
const KNOWN_SECRET_MODES = new Set(['literal', 'env', 'command', 'external', 'none']);
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_PROVIDER_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const UNSAFE_PROVIDER_ID_PATTERN = /[\u0000-\u001f\u007f/\\]/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
// Keep aligned with the pinned Pi custom-provider fallbacks in
// @earendil-works/pi-coding-agent/dist/core/provider-composer.js.
export const PI_DEFAULT_CONTEXT_WINDOW = 128000;
export const PI_DEFAULT_MAX_TOKENS = 16384;

type ApiKeyMode = 'literal' | 'env' | 'command' | 'external' | 'none';
type JsonObject = Record<string, any>;
export type ModelInputCapability = 'text' | 'image';
const MODEL_INPUT_ALLOWED = new Set<ModelInputCapability>(['text', 'image']);

export class ModelProviderConfigError extends Error {
  code: string;
  path: string;

  constructor(code: string, path = '', message = code) {
    super(message);
    this.name = 'ModelProviderConfigError';
    this.code = code;
    this.path = path;
  }
}

function isPlainObject(value: any): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneDocument<T>(value: T): T {
  return structuredClone(value);
}

function normalizeText(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeModelInputCapabilities(value: any, path: string): ModelInputCapability[] {
  if (value === undefined || value === null) {
    return ['text'];
  }

  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || !MODEL_INPUT_ALLOWED.has(entry as ModelInputCapability))
  ) {
    throw new ModelProviderConfigError('provider_model_input_invalid', path);
  }

  return [...new Set(value as ModelInputCapability[])];
}

export function modelSupportsImageInput(value: any): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.includes('image');
}

function hasCustomHeaders(value: any) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function validateProviderId(providerId: string) {
  if (
    !providerId ||
    providerId !== providerId.trim() ||
    RESERVED_PROVIDER_IDS.has(providerId) ||
    UNSAFE_PROVIDER_ID_PATTERN.test(providerId)
  ) {
    throw new ModelProviderConfigError('provider_id_invalid', `providers.${providerId}`);
  }
}

function validateProtocol(value: any, path: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new ModelProviderConfigError('provider_protocol_invalid', path);
  }
}

function requireProvider(document: JsonObject, providerId: string) {
  const provider = document.providers && document.providers[providerId];

  if (!isPlainObject(provider)) {
    throw new ModelProviderConfigError('provider_not_found', `providers.${providerId}`);
  }

  return provider;
}

function hasEnvInterpolation(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '$') {
      continue;
    }

    const next = value[index + 1];
    if (next === '$' || next === '!') {
      index += 1;
      continue;
    }

    if (next === '{') {
      const end = value.indexOf('}', index + 2);
      if (end !== -1 && ENV_NAME_PATTERN.test(value.slice(index + 2, end))) {
        return true;
      }
      continue;
    }

    if (/[A-Za-z_]/u.test(next || '')) {
      return true;
    }
  }

  return false;
}

function normalizeEnvReference(value: string, path: string) {
  const text = value.trim();
  let name = text;

  if (name.startsWith('${') && name.endsWith('}')) {
    name = name.slice(2, -1);
  } else if (name.startsWith('$')) {
    name = name.slice(1);
  }

  if (ENV_NAME_PATTERN.test(name)) {
    return `$${name}`;
  }

  if (!text.startsWith('!') && hasEnvInterpolation(text)) {
    return text;
  }

  throw new ModelProviderConfigError('provider_secret_env_invalid', path);
}

function normalizeCommandReference(value: string, path: string) {
  const command = value.trim().replace(/^!+/u, '').trim();

  if (!command) {
    throw new ModelProviderConfigError('provider_secret_command_invalid', path);
  }

  return `!${command}`;
}

function normalizeSecretValue(mode: string, value: string, path: string) {
  if (!WRITABLE_SECRET_MODES.has(mode)) {
    throw new ModelProviderConfigError('provider_secret_mode_invalid', path);
  }

  if (mode === 'env') {
    return normalizeEnvReference(value, path);
  }

  if (mode === 'command') {
    return normalizeCommandReference(value, path);
  }

  return value.trim();
}

function validateOptionalModelLimit(value: any, path: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ModelProviderConfigError('provider_model_limit_invalid', path);
  }
}

function validateModelLimits(model: JsonObject, modelPath: string) {
  if (Object.hasOwn(model, 'contextWindow')) {
    validateOptionalModelLimit(model.contextWindow, `${modelPath}.contextWindow`);
  }
  if (Object.hasOwn(model, 'maxTokens')) {
    validateOptionalModelLimit(model.maxTokens, `${modelPath}.maxTokens`);
  }

  const contextWindow = Object.hasOwn(model, 'contextWindow')
    ? model.contextWindow
    : PI_DEFAULT_CONTEXT_WINDOW;
  const maxTokens = Object.hasOwn(model, 'maxTokens')
    ? model.maxTokens
    : PI_DEFAULT_MAX_TOKENS;
  if (maxTokens > contextWindow) {
    throw new ModelProviderConfigError('provider_model_limits_inconsistent', `${modelPath}.maxTokens`);
  }
}

function mergeModelEntries(existingModels: any[], incomingModels: any[], pathPrefix = '') {
  const existingById = new Map<string, JsonObject>();

  for (const model of existingModels) {
    if (isPlainObject(model)) {
      existingById.set(normalizeText(model.id), model);
    }
  }

  return incomingModels.map((incomingModel, index) => {
    const input = isPlainObject(incomingModel) ? incomingModel : {};
    const id = normalizeText(input.id);
    const existing = existingById.get(id);
    const next = existing ? cloneDocument(existing) : {};
    const modelPath = `${pathPrefix}.models[${index}]`;

    for (const field of ['id', 'name', 'api', 'baseUrl'] as const) {
      if (Object.hasOwn(input, field)) {
        const value = normalizeText(input[field]);
        if (value) {
          next[field] = value;
        } else {
          delete next[field];
        }
      }
    }

    if (Object.hasOwn(input, 'family')) {
      const family = normalizeText(input.family);
      if (family) {
        next.family = family;
      } else {
        delete next.family;
      }
    }

    if (Object.hasOwn(input, 'reasoning')) {
      next.reasoning = Boolean(input.reasoning);
    }

    if (Object.hasOwn(input, 'input')) {
      next.input = normalizeModelInputCapabilities(input.input, `${modelPath}.input`);
    }

    for (const field of ['contextWindow', 'maxTokens'] as const) {
      if (Object.hasOwn(input, field)) {
        if (input[field] === null || input[field] === undefined) {
          delete next[field];
        } else {
          validateOptionalModelLimit(input[field], `${modelPath}.${field}`);
          next[field] = input[field];
        }
      }
    }

    validateModelLimits(next, modelPath);
    return next;
  });
}

export function detectApiKeyMode(value: any): Exclude<ApiKeyMode, 'external'> {
  const text = normalizeText(value);

  if (!text) {
    return 'none';
  }

  if (hasEnvInterpolation(text)) {
    return 'env';
  }

  if (text.startsWith('!')) {
    return 'command';
  }

  return 'literal';
}

export function validateModelProviderDocument(document: any) {
  if (!isPlainObject(document)) {
    throw new ModelProviderConfigError('provider_document_invalid', '');
  }

  if (!isPlainObject(document.providers)) {
    throw new ModelProviderConfigError('provider_document_invalid', 'providers');
  }

  for (const [providerId, provider] of Object.entries(document.providers)) {
    const providerPath = `providers.${providerId}`;

    validateProviderId(providerId);

    if (!isPlainObject(provider)) {
      throw new ModelProviderConfigError('provider_invalid', providerPath);
    }

    if (Object.hasOwn(provider, 'api')) {
      validateProtocol(provider.api, `${providerPath}.api`);
    }

    const models = Object.hasOwn(provider, 'models') ? provider.models : [];
    if (!Array.isArray(models)) {
      throw new ModelProviderConfigError('provider_models_invalid', `${providerPath}.models`);
    }

    const modelIds = new Set<string>();
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      const modelPath = `${providerPath}.models[${index}]`;

      if (!isPlainObject(model)) {
        throw new ModelProviderConfigError('provider_model_invalid', modelPath);
      }

      const modelId = normalizeText(model.id);
      if (!modelId) {
        throw new ModelProviderConfigError('provider_model_id_required', `${modelPath}.id`);
      }

      if (modelIds.has(modelId)) {
        throw new ModelProviderConfigError('provider_model_duplicate', `${modelPath}.id`);
      }
      modelIds.add(modelId);

      if (Object.hasOwn(model, 'family')) {
        const family = normalizeText(model.family);
        if (!MODEL_FAMILIES.has(family)) {
          throw new ModelProviderConfigError('model_family_invalid', `${modelPath}.family`);
        }
      }

      if (Object.hasOwn(model, 'api')) {
        validateProtocol(model.api, `${modelPath}.api`);
      }

      if (Object.hasOwn(model, 'input')) {
        normalizeModelInputCapabilities(model.input, `${modelPath}.input`);
      }

      validateModelLimits(model, modelPath);
    }
  }

  return document;
}

export function projectModelProviderDocument(document: any, options: any = {}) {
  validateModelProviderDocument(document);
  const externalAuthProviderIds = options.externalAuthProviderIds instanceof Set
    ? options.externalAuthProviderIds
    : new Set();

  return {
    providers: Object.entries(document.providers).map(([id, rawProvider]) => {
      const provider = rawProvider as JsonObject;
      const hasApiKey = detectApiKeyMode(provider.apiKey) !== 'none';
      const hasExternalAuth = externalAuthProviderIds.has(id);
      const apiKeyMode: ApiKeyMode = hasApiKey
        ? detectApiKeyMode(provider.apiKey)
        : hasExternalAuth
          ? 'external'
          : 'none';

      return {
        id,
        name: normalizeText(provider.name),
        baseUrl: normalizeText(provider.baseUrl),
        api: normalizeText(provider.api),
        authHeader: Boolean(provider.authHeader),
        hasApiKey,
        hasExternalAuth,
        apiKeyMode,
        hasCustomHeaders: hasCustomHeaders(provider.headers),
        models: (Array.isArray(provider.models) ? provider.models : []).map((rawModel) => {
          const model = rawModel as JsonObject;
          return {
            id: normalizeText(model.id),
            name: normalizeText(model.name),
            api: normalizeText(model.api),
            baseUrl: normalizeText(model.baseUrl),
            family: normalizeText(model.family),
            reasoning: Boolean(model.reasoning),
            input: normalizeModelInputCapabilities(model.input, ''),
            contextWindow: Number.isInteger(model.contextWindow) ? model.contextWindow : null,
            maxTokens: Number.isInteger(model.maxTokens) ? model.maxTokens : null,
            hasCustomHeaders: hasCustomHeaders(model.headers),
          };
        }),
      };
    }),
  };
}

export function patchModelProvider(document: any, rawProviderId: any, patch: any = {}) {
  validateModelProviderDocument(document);
  const providerId = normalizeText(rawProviderId);
  if (!providerId) {
    throw new ModelProviderConfigError('provider_id_required', 'providerId');
  }
  validateProviderId(providerId);

  if (!isPlainObject(patch)) {
    throw new ModelProviderConfigError('provider_patch_invalid', `providers.${providerId}`);
  }

  const next = cloneDocument(document);
  const existing = isPlainObject(next.providers[providerId]) ? next.providers[providerId] : {};
  const provider = cloneDocument(existing);

  for (const field of ['name', 'baseUrl', 'api'] as const) {
    if (Object.hasOwn(patch, field)) {
      const value = normalizeText(patch[field]);
      if (value) {
        provider[field] = value;
      } else {
        delete provider[field];
      }
    }
  }

  if (Object.hasOwn(patch, 'authHeader')) {
    provider.authHeader = Boolean(patch.authHeader);
  }

  if (Object.hasOwn(patch, 'models')) {
    if (!Array.isArray(patch.models)) {
      throw new ModelProviderConfigError('provider_models_invalid', `providers.${providerId}.models`);
    }
    provider.models = mergeModelEntries(
      Array.isArray(existing.models) ? existing.models : [],
      patch.models,
      `providers.${providerId}`
    );
  } else if (!Array.isArray(provider.models)) {
    provider.models = [];
  }

  const secretPath = `providers.${providerId}.apiKey`;
  const currentMode = detectApiKeyMode(existing.apiKey);
  const requestedMode = Object.hasOwn(patch, 'apiKeyMode')
    ? normalizeText(patch.apiKeyMode).toLowerCase()
    : currentMode === 'none'
      ? 'literal'
      : currentMode;
  const secretValue = normalizeText(patch.apiKey);

  if (!KNOWN_SECRET_MODES.has(requestedMode)) {
    throw new ModelProviderConfigError('provider_secret_mode_invalid', secretPath);
  }

  if (secretValue) {
    provider.apiKey = normalizeSecretValue(requestedMode, secretValue, secretPath);
  } else if (currentMode !== 'none' && requestedMode !== currentMode) {
    throw new ModelProviderConfigError('provider_secret_value_required', secretPath);
  }

  next.providers[providerId] = provider;
  validateModelProviderDocument(next);
  return next;
}

export function clearModelProviderSecret(document: any, rawProviderId: any) {
  validateModelProviderDocument(document);
  const providerId = normalizeText(rawProviderId);
  const next = cloneDocument(document);
  const provider = requireProvider(next, providerId);
  delete provider.apiKey;
  validateModelProviderDocument(next);
  return next;
}

export function removeModelProvider(document: any, rawProviderId: any) {
  validateModelProviderDocument(document);
  const providerId = normalizeText(rawProviderId);
  const next = cloneDocument(document);
  requireProvider(next, providerId);
  delete next.providers[providerId];
  validateModelProviderDocument(next);
  return next;
}
