const PROVIDER_API_KEY_ENV_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  google: 'GEMINI_API_KEY',
  aliyun: 'ALIYUN_API_KEY',
  qwen: 'QWEN_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  'pi-coding': 'PI_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  zai: 'ZAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  huggingface: 'HF_TOKEN',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
};

function resolveProviderApiKeyEnvName(provider: any, options: any = {}) {
  const providerId = String(provider || '').trim();
  const fallbackEnvName = String(options.fallbackEnvName || '').trim();

  if (!providerId) {
    return fallbackEnvName;
  }

  return PROVIDER_API_KEY_ENV_MAP[providerId] || fallbackEnvName;
}

export {
  PROVIDER_API_KEY_ENV_MAP,
  resolveProviderApiKeyEnvName,
};
