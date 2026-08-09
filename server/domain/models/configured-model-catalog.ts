import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  resolveSetting,
} from '../../../lib/minimal-pi';
import { classifyModelFamily } from './model-family-registry';
import { readModelProviderDocument } from './model-provider-persistence';

const MODEL_KEY_SEPARATOR = '\u001f';
const HOST_PATH = path.resolve(__dirname, '..', '..', '..', 'lib', 'pi-model-catalog-host.mjs');
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

type CatalogSource = 'runtime' | 'models_json';
type RuntimeModel = {
  provider: string;
  id: string;
  name?: string;
  supportedThinkingLevels?: string[];
  input?: string[];
};

function normalize(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeModelInput(value: any) {
  const allowed = new Set(['text', 'image']);
  const entries = Array.isArray(value)
    ? value.map(normalize).filter((entry) => allowed.has(entry))
    : [];
  return entries.length > 0 ? [...new Set(entries)] : ['text'];
}

function normalizeThinkingLevels(value: any) {
  const levels = Array.isArray(value)
    ? value.map(normalize).filter((level) => THINKING_LEVELS.has(level))
    : [];
  return levels.length > 0 ? [...new Set(levels)] : ['off'];
}

export function buildConfiguredModelKey(provider: any, model: any) {
  return `${normalize(provider)}${MODEL_KEY_SEPARATOR}${normalize(model)}`;
}

function loadPinnedRuntimeModels(agentDir: string): RuntimeModel[] {
  const result = spawnSync(process.execPath, [HOST_PATH, '--stdin'], {
    encoding: 'utf8',
    input: JSON.stringify({ agentDir }),
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  let response: any = null;
  try {
    response = JSON.parse(String(result.stdout || ''));
  } catch {}

  if (result.status !== 0 || response?.ok !== true || !Array.isArray(response.models)) {
    throw new Error('configured_model_catalog_runtime_failed');
  }
  return response.models;
}

function sourceLabel(source: CatalogSource) {
  if (source === 'models_json') {
    return 'models.json';
  }
  return 'runtime default';
}

export function createConfiguredModelCatalog(options: any = {}) {
  const agentDir = normalize(options.agentDir);
  const loadRuntimeModels = typeof options.loadRuntimeModels === 'function'
    ? options.loadRuntimeModels
    : () => loadPinnedRuntimeModels(agentDir);
  const readProviderDocument = typeof options.readProviderDocument === 'function'
    ? options.readProviderDocument
    : () => readModelProviderDocument(agentDir);
  const readRuntimeDefault = typeof options.readRuntimeDefault === 'function'
    ? options.readRuntimeDefault
    : () => ({
        provider: resolveSetting('', process.env.PI_PROVIDER, DEFAULT_PROVIDER),
        model: resolveSetting('', process.env.PI_MODEL, DEFAULT_MODEL),
      });
  let cachedOptions: any[] | null = null;

  function rebuild() {
    const runtimeByKey = new Map<string, any>();
    const byKey = new Map<string, any>();

    for (const runtimeModel of loadRuntimeModels()) {
      const provider = normalize(runtimeModel?.provider);
      const model = normalize(runtimeModel?.id);
      if (!provider || !model) {
        continue;
      }
      const key = buildConfiguredModelKey(provider, model);
      runtimeByKey.set(key, {
        key,
        provider,
        model,
        label: normalize(runtimeModel.name) || `${provider} / ${model}`,
        supportedThinkingLevels: normalizeThinkingLevels(runtimeModel.supportedThinkingLevels),
        input: normalizeModelInput(runtimeModel.input),
      });
    }

    const document = readProviderDocument();
    for (const [providerId, providerConfig] of Object.entries(document?.providers || {})) {
      const provider = normalize(providerId);
      const models = Array.isArray((providerConfig as any)?.models) ? (providerConfig as any).models : [];
      for (const modelConfig of models) {
        const model = normalize(modelConfig?.id);
        if (!provider || !model) {
          continue;
        }
        const key = buildConfiguredModelKey(provider, model);
        const current = runtimeByKey.get(key);
        byKey.set(key, {
          key,
          provider,
          model,
          label: normalize(modelConfig?.name) || current?.label || `${provider} / ${model}`,
          source: 'models_json' as CatalogSource,
          explicitFamily: normalize(modelConfig?.family),
          supportedThinkingLevels: current?.supportedThinkingLevels || ['off'],
          input: normalizeModelInput(modelConfig?.input),
        });
      }
    }

    const runtimeDefault = readRuntimeDefault() || {};
    const defaultProvider = normalize(runtimeDefault.provider);
    const defaultModel = normalize(runtimeDefault.model);
    if (defaultModel) {
      const key = buildConfiguredModelKey(defaultProvider, defaultModel);
      if (!byKey.has(key)) {
        const current = runtimeByKey.get(key);
        byKey.set(key, {
          key,
          provider: defaultProvider,
          model: defaultModel,
          label: current?.label || (defaultProvider ? `${defaultProvider} / ${defaultModel}` : defaultModel),
          source: 'runtime' as CatalogSource,
          explicitFamily: '',
          supportedThinkingLevels: current?.supportedThinkingLevels || ['off'],
          input: current?.input || ['text'],
        });
      }
    }

    cachedOptions = [...byKey.values()].map((entry) => {
      const classification = classifyModelFamily({
        provider: entry.provider,
        model: entry.model,
        explicitFamily: entry.explicitFamily,
      });
      return {
        key: entry.key,
        provider: entry.provider,
        model: entry.model,
        label: entry.label,
        source: entry.source,
        sourceLabel: sourceLabel(entry.source),
        ...classification,
        supportedThinkingLevels: entry.supportedThinkingLevels,
        input: entry.input,
      };
    }).sort((left, right) => {
      const labelOrder = left.label.localeCompare(right.label, 'zh-CN');
      return labelOrder || left.key.localeCompare(right.key, 'en');
    });
  }

  return {
    getOptions() {
      if (!cachedOptions) {
        rebuild();
      }
      return structuredClone(cachedOptions);
    },
    invalidate() {
      cachedOptions = null;
    },
  };
}
