const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_AGENT_DIR,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING,
  resolveSetting,
} = require('../../pi-runtime');
const { ROOT_DIR } = require('../app/config');

function createBootstrapPayloadBuilder({ store, skillRegistry, turnOrchestrator }) {
  function readConfiguredModelsFile() {
    const configuredAgentDir = resolveSetting('', process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
    const candidatePaths = [
      path.resolve(configuredAgentDir, 'models.json'),
      path.resolve(ROOT_DIR, '.pi-sandbox', 'models.json'),
    ];
    const seenPaths = new Set();

    for (const candidatePath of candidatePaths) {
      const normalizedPath = path.resolve(candidatePath);

      if (seenPaths.has(normalizedPath) || !fs.existsSync(normalizedPath)) {
        continue;
      }

      seenPaths.add(normalizedPath);

      try {
        const parsed = JSON.parse(fs.readFileSync(normalizedPath, 'utf8'));
        return {
          path: normalizedPath,
          providers: parsed && typeof parsed.providers === 'object' ? parsed.providers : {},
        };
      } catch {
        return {
          path: normalizedPath,
          providers: {},
        };
      }
    }

    return {
      path: '',
      providers: {},
    };
  }

  function buildConfiguredModelOptions() {
    const seen = new Set();
    const options = [];
    const modelsFile = readConfiguredModelsFile();

    function addOption(provider, model, sourceLabel, displayName = '') {
      const normalizedProvider = String(provider || '').trim();
      const normalizedModel = String(model || '').trim();
      const normalizedDisplayName = String(displayName || '').trim();

      if (!normalizedModel) {
        return;
      }

      const key = `${normalizedProvider}\u001f${normalizedModel}`;

      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      options.push({
        key,
        provider: normalizedProvider,
        model: normalizedModel,
        label: normalizedDisplayName || (normalizedProvider ? `${normalizedProvider} / ${normalizedModel}` : normalizedModel),
        sourceLabel: String(sourceLabel || '').trim(),
      });
    }

    addOption(
      resolveSetting('', process.env.PI_PROVIDER, DEFAULT_PROVIDER),
      resolveSetting('', process.env.PI_MODEL, DEFAULT_MODEL),
      '运行时默认配置'
    );

    for (const [providerName, providerConfig] of Object.entries(modelsFile.providers)) {
      for (const modelConfig of Array.isArray(providerConfig && providerConfig.models) ? providerConfig.models : []) {
        addOption(
          providerName,
          modelConfig && modelConfig.id,
          'models.json',
          modelConfig && modelConfig.name
        );
      }
    }

    for (const agent of store.listAgents()) {
      addOption(agent.provider, agent.model, `${agent.name} 默认配置`);

      for (const profile of Array.isArray(agent.modelProfiles) ? agent.modelProfiles : []) {
        addOption(profile.provider || agent.provider, profile.model, `${agent.name} / ${profile.name || '模型配置'}`);
      }
    }

    return options.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
  }

  function buildBootstrapPayload() {
    const starterConversation = store.ensureStarterConversation();
    const conversations = store.listConversations();
    const selectedConversationId = starterConversation ? starterConversation.id : conversations[0] ? conversations[0].id : null;

    return {
      runtime: turnOrchestrator.buildRuntimePayload(),
      modelOptions: buildConfiguredModelOptions(),
      agents: store.listAgents(),
      skills: skillRegistry.listSkills(),
      conversations,
      selectedConversationId,
    };
  }

  return {
    buildBootstrapPayload,
    buildConfiguredModelOptions,
  };
}

module.exports = {
  createBootstrapPayloadBuilder,
};
