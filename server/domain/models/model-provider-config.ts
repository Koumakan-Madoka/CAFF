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
const ENV_REFERENCE_PATTERN = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

type ApiKeyMode = 'literal' | 'env' | 'command' | 'external' | 'none';
type JsonObject = Record<string, any>;

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

function hasCustomHeaders(value: any) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function requireProvider(document: JsonObject, providerId: string) {
  const provider = document.providers && document.providers[providerId];

  if (!isPlainObject(provider)) {
    throw new ModelProviderConfigError('provider_not_found', `providers.${providerId}`);
  }

  return provider;
}

function normalizeEnvReference(value: string, path: string) {
  let name = value.trim();

  if (name.startsWith('${') && name.endsWith('}')) {
    name = name.slice(2, -1);
  } else if (name.startsWith('$')) {
    name = name.slice(1);
  }

  if (!ENV_NAME_PATTERN.test(name)) {
    throw new ModelProviderConfigError('provider_secret_env_invalid', path);
  }

  return `$${name}`;
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

function mergeModelEntries(existingModels: any[], incomingModels: any[]) {
  const existingById = new Map<string, JsonObject>();

  for (const model of existingModels) {
    if (isPlainObject(model)) {
      existingById.set(normalizeText(model.id), model);
    }
  }

  return incomingModels.map((incomingModel) => {
    const input = isPlainObject(incomingModel) ? incomingModel : {};
    const id = normalizeText(input.id);
    const existing = existingById.get(id);
    const next = existing ? cloneDocument(existing) : {};

    for (const field of ['id', 'name', 'api', 'baseUrl'] as const) {
      if (Object.hasOwn(input, field)) {
        next[field] = normalizeText(input[field]);
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

    return next;
  });
}

export function detectApiKeyMode(value: any): Exclude<ApiKeyMode, 'external'> {
  const text = normalizeText(value);

  if (!text) {
    return 'none';
  }

  if (ENV_REFERENCE_PATTERN.test(text)) {
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

    if (!providerId || !isPlainObject(provider)) {
      throw new ModelProviderConfigError('provider_invalid', providerPath);
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

  if (!isPlainObject(patch)) {
    throw new ModelProviderConfigError('provider_patch_invalid', `providers.${providerId}`);
  }

  const next = cloneDocument(document);
  const existing = isPlainObject(next.providers[providerId]) ? next.providers[providerId] : {};
  const provider = cloneDocument(existing);

  for (const field of ['name', 'baseUrl', 'api'] as const) {
    if (Object.hasOwn(patch, field)) {
      provider[field] = normalizeText(patch[field]);
    }
  }

  if (Object.hasOwn(patch, 'authHeader')) {
    provider.authHeader = Boolean(patch.authHeader);
  }

  if (Object.hasOwn(patch, 'models')) {
    if (!Array.isArray(patch.models)) {
      throw new ModelProviderConfigError('provider_models_invalid', `providers.${providerId}.models`);
    }
    provider.models = mergeModelEntries(Array.isArray(existing.models) ? existing.models : [], patch.models);
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
