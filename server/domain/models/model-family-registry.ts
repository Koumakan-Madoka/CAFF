const MODEL_FAMILIES = new Set([
  'gpt',
  'claude',
  'gemini',
  'deepseek',
  'qwen',
  'glm',
  'kimi',
]);

const PROVIDER_ALIASES = new Map<string, string>([
  ['openai', 'gpt'],
  ['openai-codex', 'gpt'],
  ['anthropic', 'claude'],
  ['claude', 'claude'],
  ['google', 'gemini'],
  ['google-gemini', 'gemini'],
  ['gemini', 'gemini'],
  ['deepseek', 'deepseek'],
  ['qwen', 'qwen'],
  ['dashscope', 'qwen'],
  ['alibaba', 'qwen'],
  ['aliyun', 'qwen'],
  ['glm', 'glm'],
  ['zhipu', 'glm'],
  ['bigmodel', 'glm'],
  ['kimi', 'kimi'],
  ['kimi-coding', 'kimi'],
  ['moonshot', 'kimi'],
]);

const MODEL_ALIAS_RULES = [
  ['gpt', /^gpt-/u],
  ['claude', /^claude-/u],
  ['gemini', /^gemini-/u],
  ['deepseek', /^deepseek-/u],
  ['qwen', /^(?:qwen|qwq)/u],
  ['glm', /^glm-/u],
  ['kimi', /^(?:kimi-|k2(?:$|[.-]))/u],
] as Array<[string, RegExp]>;

function normalize(value: any) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function providerFamily(provider: any) {
  return PROVIDER_ALIASES.get(normalize(provider)) || null;
}

function modelFamily(model: any) {
  const normalized = normalize(model);
  const lastSegment = normalized.split('/').filter(Boolean).at(-1) || normalized;
  const match = MODEL_ALIAS_RULES.find(([, pattern]) => pattern.test(lastSegment));
  return match ? match[0] : null;
}

export function classifyModelFamily(input: any = {}) {
  const explicitFamily = normalize(input.explicitFamily);
  if (MODEL_FAMILIES.has(explicitFamily)) {
    return { family: explicitFamily, familySource: 'explicit' };
  }

  const providerMatch = providerFamily(input.provider);
  const modelMatch = modelFamily(input.model);
  if (providerMatch && modelMatch && providerMatch !== modelMatch) {
    return { family: null, familySource: 'conflict' };
  }
  if (providerMatch) {
    return { family: providerMatch, familySource: 'provider_alias' };
  }
  if (modelMatch) {
    return { family: modelMatch, familySource: 'model_alias' };
  }
  return { family: null, familySource: 'unknown' };
}

export const MODEL_FAMILY_VALUES = Object.freeze([...MODEL_FAMILIES]);
