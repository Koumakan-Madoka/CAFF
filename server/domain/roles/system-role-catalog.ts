export const LEGACY_SYSTEM_ROLE_IDS = Object.freeze([
  'agent-strategist',
  'agent-builder',
  'agent-critic',
  'agent-tsundere-senpai',
  'agent-miko-oracle',
  'agent-mecha-engineer',
  'agent-idol-spark',
  'agent-kuudere-archivist',
  'agent-chuunibyou-visionary',
]);

export const SYSTEM_MODEL_FAMILY_ROLES = Object.freeze([
  {
    id: 'role-family-gpt',
    name: 'GPT',
    modelFamily: 'gpt',
    description: 'OpenAI GPT 模型族',
    accentColor: '#3975c6',
  },
  {
    id: 'role-family-claude',
    name: 'Claude',
    modelFamily: 'claude',
    description: 'Anthropic Claude 模型族',
    accentColor: '#a35f3f',
  },
  {
    id: 'role-family-gemini',
    name: 'Gemini',
    modelFamily: 'gemini',
    description: 'Google Gemini 模型族',
    accentColor: '#5e6fc9',
  },
  {
    id: 'role-family-deepseek',
    name: 'DeepSeek',
    modelFamily: 'deepseek',
    description: 'DeepSeek 模型族',
    accentColor: '#4d68bb',
  },
  {
    id: 'role-family-qwen',
    name: 'Qwen',
    modelFamily: 'qwen',
    description: 'Qwen 模型族',
    accentColor: '#6d55bd',
  },
  {
    id: 'role-family-glm',
    name: 'GLM',
    modelFamily: 'glm',
    description: '智谱 GLM 模型族',
    accentColor: '#277d75',
  },
  {
    id: 'role-family-kimi',
    name: 'Kimi',
    modelFamily: 'kimi',
    description: 'Moonshot Kimi 模型族',
    accentColor: '#7d5f9e',
  },
]);

export const SYSTEM_MODEL_FAMILY_ROLE_IDS = Object.freeze(
  SYSTEM_MODEL_FAMILY_ROLES.map((role) => role.id)
);
