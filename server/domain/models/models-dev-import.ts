type JsonObject = Record<string, any>;

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_CATALOG_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const UNSAFE_PROVIDER_ID_PATTERN = /[\u0000-\u001f\u007f/\\]/u;
const UNSAFE_MODEL_ID_PATTERN = /[\u0000-\u001f\u007f\\]/u;

const FAMILY_ALIASES = new Map<string, string>([
  ['gpt', 'gpt'],
  ['openai', 'gpt'],
  ['chatgpt', 'gpt'],
  ['claude', 'claude'],
  ['anthropic', 'claude'],
  ['gemini', 'gemini'],
  ['google', 'gemini'],
  ['deepseek', 'deepseek'],
  ['qwen', 'qwen'],
  ['qwq', 'qwen'],
  ['glm', 'glm'],
  ['zhipu', 'glm'],
  ['kimi', 'kimi'],
  ['moonshot', 'kimi'],
]);

const KEY_ENV_ALLOWLISTS = new Map<string, Set<string>>([
  ['openai', new Set(['OPENAI_API_KEY'])],
  ['anthropic', new Set(['ANTHROPIC_API_KEY'])],
  ['google', new Set(['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'])],
  ['deepseek', new Set(['DEEPSEEK_API_KEY'])],
  ['qwen', new Set(['DASHSCOPE_API_KEY', 'QWEN_API_KEY'])],
  ['zai', new Set(['ZAI_API_KEY', 'GLM_API_KEY'])],
  ['kimi-for-coding', new Set(['MOONSHOT_API_KEY', 'KIMI_API_KEY'])],
  ['moonshot', new Set(['MOONSHOT_API_KEY', 'KIMI_API_KEY'])],
]);

const DIALECT_BY_NPM = new Map<string, string>([
  ['@ai-sdk/openai', 'openai-responses'],
  ['@ai-sdk/openai-compatible', 'openai-completions'],
  ['@ai-sdk/anthropic', 'anthropic-messages'],
  ['@ai-sdk/google-generative-ai', 'google-generative-ai'],
]);

const CAFF_DIALECTS = new Set([
  'openai-responses',
  'openai-completions',
  'anthropic-messages',
  'google-generative-ai',
]);

export class ModelCatalogError extends Error {
  code: string;
  path: string;

  constructor(code: string, path = '', message = code) {
    super(message);
    this.name = 'ModelCatalogError';
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function text(value: any): string {
  return typeof value === 'string' ? value.trim() : '';
}

function assertEnvName(value: any, path: string): string {
  const name = text(value);
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new ModelCatalogError('catalog_env_invalid', path);
  }
  return name;
}

function validateProvider(providerId: string, provider: any) {
  const providerPath = `providers.${providerId}`;
  if (!text(providerId) || RESERVED_CATALOG_IDS.has(providerId) || UNSAFE_PROVIDER_ID_PATTERN.test(providerId)) {
    throw new ModelCatalogError('catalog_provider_id_invalid', providerPath);
  }
  if (!isPlainObject(provider)) {
    throw new ModelCatalogError('catalog_provider_invalid', providerPath);
  }

  if (Object.hasOwn(provider, 'env')) {
    if (!Array.isArray(provider.env)) {
      throw new ModelCatalogError('catalog_env_invalid', `${providerPath}.env`);
    }
    provider.env.forEach((name: any, index: number) => {
      assertEnvName(name, `${providerPath}.env[${index}]`);
    });
  }

  if (!isPlainObject(provider.models)) {
    throw new ModelCatalogError('catalog_models_invalid', `${providerPath}.models`);
  }

  for (const [modelId, model] of Object.entries(provider.models)) {
    if (!text(modelId) || RESERVED_CATALOG_IDS.has(modelId) || UNSAFE_MODEL_ID_PATTERN.test(modelId)) {
      throw new ModelCatalogError('catalog_model_id_required', `${providerPath}.models`);
    }
    if (!isPlainObject(model)) {
      throw new ModelCatalogError('catalog_model_invalid', `${providerPath}.models.${modelId}`);
    }
    if (Object.hasOwn(model, 'provider') && !isPlainObject(model.provider)) {
      throw new ModelCatalogError('catalog_model_provider_invalid', `${providerPath}.models.${modelId}.provider`);
    }
  }
}

export function validateModelsDevDocument(document: any) {
  if (!isPlainObject(document)) {
    throw new ModelCatalogError('catalog_document_invalid');
  }

  for (const [providerId, provider] of Object.entries(document)) {
    validateProvider(providerId, provider);
  }

  if (Object.keys(document).length === 0) {
    throw new ModelCatalogError('catalog_providers_empty', 'providers');
  }

  return document;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function resolveProviderDefaults(provider: JsonObject): JsonObject {
  const result: JsonObject = {};
  if (isPlainObject(provider.provider)) {
    Object.assign(result, clone(provider.provider));
  }

  if (!Object.hasOwn(result, 'npm') && text(provider.npm)) {
    result.npm = text(provider.npm);
  }

  if (!Object.hasOwn(result, 'api') && text(provider.api) && !looksLikeUrl(text(provider.api))) {
    result.api = text(provider.api);
  }

  if (!Object.hasOwn(result, 'baseUrl') && looksLikeUrl(text(provider.api))) {
    result.baseUrl = text(provider.api);
  }

  return result;
}

export function mergeCatalogProviderModel(provider: any, modelId: string, providerId = 'provider') {
  validateProvider('provider', provider);
  const id = text(modelId);
  const model = Object.hasOwn(provider.models, id) ? provider.models[id] : undefined;
  if (!isPlainObject(model)) {
    throw new ModelCatalogError('catalog_model_not_found', `providers.provider.models.${id}`);
  }

  const defaults = resolveProviderDefaults(provider);
  const override = isPlainObject(model.provider) ? clone(model.provider) : {};
  const mergedProvider = { ...defaults, ...override };
  if (!text(mergedProvider.baseUrl) && looksLikeUrl(text(provider.api))) {
    mergedProvider.baseUrl = text(provider.api);
  }

  return {
    providerId: text(providerId) || 'provider',
    provider: mergedProvider,
    model: clone(model),
  };
}

function resolveDialect(provider: JsonObject): string | undefined {
  const explicit = text(provider.api);
  if (CAFF_DIALECTS.has(explicit)) {
    return explicit;
  }
  const npm = text(provider.npm);
  return DIALECT_BY_NPM.get(npm);
}

export function classifyCatalogEnv(providerId: string, rawName: string) {
  const name = assertEnvName(rawName, `providers.${providerId}.env`);
  const keyNames = KEY_ENV_ALLOWLISTS.get(text(providerId).toLowerCase()) || new Set<string>();
  const isKey = keyNames.has(name);
  return {
    name,
    kind: isKey ? 'key' as const : 'parameter' as const,
    required: isKey,
  };
}

export function mapCatalogFamily(rawFamily: any): string | undefined {
  return FAMILY_ALIASES.get(text(rawFamily).toLowerCase());
}

export function validateCatalogProvenance(provenance: any) {
  if (!isPlainObject(provenance)) {
    throw new ModelCatalogError('catalog_provenance_invalid', 'provenance');
  }
  if (provenance.kind !== 'vendored' && provenance.kind !== 'online') {
    throw new ModelCatalogError('catalog_provenance_kind_invalid', 'provenance.kind');
  }
  if (!text(provenance.sourceUrl) || !text(provenance.payloadSha256) || !text(provenance.fetchedAt)) {
    throw new ModelCatalogError('catalog_provenance_incomplete', 'provenance');
  }
}

export function projectCatalogModel(document: any, providerId: string, modelId: string, options: any = {}) {
  validateModelsDevDocument(document);
  validateCatalogProvenance(options.provenance);

  const id = text(providerId);
  const provider = document[id];
  if (!isPlainObject(provider)) {
    throw new ModelCatalogError('catalog_provider_not_found', `providers.${id}`);
  }

  const merged = mergeCatalogProviderModel(provider, modelId, id);
  const envNames = Array.isArray(provider.env) ? provider.env : [];
  const family = mapCatalogFamily(merged.model.family);
  const dialect = resolveDialect(merged.provider);

  return {
    providerId: id,
    modelId: text(modelId),
    name: text(merged.model.name) || text(modelId),
    dialect,
    baseUrl: text(merged.provider.baseUrl),
    family,
    familyStatus: family ? 'mapped' as const : 'unclassified' as const,
    env: envNames.map((name: string) => classifyCatalogEnv(id, name)),
    manualConfigurationRequired: !dialect,
    catalogMetadata: {
      modalities: clone(merged.model.modalities),
      reasoningOptions: clone(merged.model.reasoning_options ?? merged.model.reasoningOptions),
      cost: clone(merged.model.cost),
      limit: clone(merged.model.limit),
    },
    provenance: clone(options.provenance),
  };
}
