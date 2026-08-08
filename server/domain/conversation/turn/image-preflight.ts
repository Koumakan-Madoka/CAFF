const { createHttpError } = require('../../../http/http-errors');
const {
  buildAgentMentionLookup,
  extractMentionedAgentIds,
} = require('../mention-routing');

function normalize(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveInitialTargetAgentIds(turnInput: any, conversation: any) {
  const agents = Array.isArray(conversation && conversation.agents) ? conversation.agents : [];
  const lookup = buildAgentMentionLookup(agents);
  const userText = normalize(turnInput && (turnInput.cleanedContent || turnInput.content));
  const mentionedAgentIds = extractMentionedAgentIds(userText, agents, {
    lookup,
    limit: Array.isArray(agents) ? agents.length : 0,
  });

  const initialAgentIds = Array.isArray(turnInput && turnInput.initialAgentIds)
    ? turnInput.initialAgentIds
    : [];

  if (initialAgentIds.length > 0) {
    return initialAgentIds.slice();
  }

  if (mentionedAgentIds.length > 0) {
    return mentionedAgentIds.slice();
  }

  return agents[0] ? [agents[0].id] : [];
}

function resolveAgentModel(agent: any) {
  const runtimeConfig = agent && agent.runtimeConfig && typeof agent.runtimeConfig === 'object'
    ? agent.runtimeConfig
    : null;
  if (runtimeConfig) {
    return {
      provider: normalize(runtimeConfig.provider),
      model: normalize(runtimeConfig.model),
    };
  }
  const selectedProfile = agent && agent.selectedModelProfile && typeof agent.selectedModelProfile === 'object'
    ? agent.selectedModelProfile
    : null;
  return {
    provider: normalize(selectedProfile ? selectedProfile.provider : agent && agent.provider),
    model: normalize(selectedProfile ? selectedProfile.model : agent && agent.model),
  };
}

function normalizeModelInput(value: any) {
  const allowed = new Set(['text', 'image']);
  const entries = Array.isArray(value)
    ? value.map((entry: any) => String(entry || '').trim()).filter((entry: string) => allowed.has(entry))
    : [];
  return entries.length > 0 ? [...new Set(entries)] : ['text'];
}

export function resolveTargetModelCapabilities(agents: any, modelCatalog: any) {
  const options = modelCatalog && typeof modelCatalog.getOptions === 'function'
    ? modelCatalog.getOptions()
    : Array.isArray(modelCatalog) ? modelCatalog : [];
  const byKey = new Map<string, any>();
  for (const option of options) {
    if (option && option.provider && option.model) {
      byKey.set(`${normalize(option.provider)}\u001f${normalize(option.model)}`, option);
    }
  }

  return (Array.isArray(agents) ? agents : []).map((agent: any) => {
    const { provider, model } = resolveAgentModel(agent);
    const option = provider && model ? byKey.get(`${provider}\u001f${model}`) : null;
    const input = normalizeModelInput(option && option.input);
    return {
      agentId: String(agent && agent.id || '').trim(),
      provider,
      model,
      input,
      supportsImage: input.includes('image'),
    };
  });
}

export function assertImagePreflightForTargets(turnInput: any, conversation: any, options: any = {}) {
  const imageIds = Array.isArray(turnInput && turnInput.imageIds) ? turnInput.imageIds : [];
  if (imageIds.length === 0) {
    return { blocked: false, targets: [] };
  }

  const agents = Array.isArray(conversation && conversation.agents) ? conversation.agents : [];
  const targetIds = resolveInitialTargetAgentIds(turnInput, conversation);
  const targetAgents = agents.filter((agent: any) => targetIds.includes(String(agent && agent.id || '')));
  const capabilities = resolveTargetModelCapabilities(targetAgents, options.modelCatalog);
  const unsupported = capabilities.find((capability: any) => !capability.supportsImage);

  if (unsupported) {
    const agentName = String(unsupported.agentId || 'unknown-agent');
    throw createHttpError(422, `模型不支持图片输入：${agentName}（${unsupported.provider || '?'}/${unsupported.model || '?'}）。图片保持未发送，请移除图片或更换支持图片输入的模型。`, {
      code: 'MODEL_NO_IMAGE_INPUT',
      issues: [{
        code: 'MODEL_NO_IMAGE_INPUT',
        path: `conversation.agents[${agentName}]`,
        agentId: unsupported.agentId,
        provider: unsupported.provider,
        model: unsupported.model,
        imageIds: imageIds.slice(),
      }],
    });
  }

  return { blocked: false, targets: capabilities };
}
