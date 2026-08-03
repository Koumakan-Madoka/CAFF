// @ts-check

(function registerManagementUtils() {
  const namespace = window.CaffPersonas || (window.CaffPersonas = {});
  const modelOptionUtils = window.CaffShared && window.CaffShared.modelOptions;
  if (!modelOptionUtils) throw new Error('CaffShared.modelOptions helper is required');
  const FAMILY_LABELS = {
    gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek',
    qwen: 'Qwen', glm: 'GLM', kimi: 'Kimi',
  };
  const THINKING_LABELS = {
    '': '跟随运行时默认', off: '关闭', minimal: '最少', low: '低', medium: '中',
    high: '高', xhigh: '超高', max: '最大',
  };

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/gu, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[char]);
  }

  function modelOptionKey(provider, model) {
    return `${String(provider || '').trim()}\u001f${String(model || '').trim()}`;
  }

  function findModelOption(modelOptions, provider, model) {
    const key = modelOptionKey(provider, model);
    return (Array.isArray(modelOptions) ? modelOptions : []).find((option) => option && option.key === key) || null;
  }

  function roleModelOptions(role, modelOptions) {
    const options = Array.isArray(modelOptions) ? modelOptions : [];
    return role && role.roleKind === 'model_family'
      ? options.filter((option) => option && option.family === role.modelFamily)
      : options;
  }

  function fillModelSelect(select, options, provider, model, { allowEmpty = false } = {}) {
    select.innerHTML = '';
    if (allowEmpty) {
      const inherit = document.createElement('option');
      inherit.value = '';
      inherit.textContent = '跟随运行时默认模型';
      select.appendChild(inherit);
    }
    for (const option of Array.isArray(options) ? options : []) {
      const element = document.createElement('option');
      element.value = option.key;
      element.textContent = option.label || `${option.provider} / ${option.model}`;
      select.appendChild(element);
    }
    const selectedKey = model ? modelOptionKey(provider, model) : '';
    if (selectedKey && !Array.from(select.options).some((option) => option.value === selectedKey)) {
      const stale = document.createElement('option');
      stale.value = selectedKey;
      stale.textContent = `${provider ? `${provider} / ` : ''}${model} · 当前不可用`;
      stale.dataset.stale = 'true';
      select.appendChild(stale);
    }
    if (!select.options.length) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '没有可用模型';
      select.appendChild(empty);
    }
    select.value = selectedKey || '';
  }

  function supportedThinkingLevels(modelOptions, provider, model) {
    const option = findModelOption(modelOptions, provider, model);
    return option && Array.isArray(option.supportedThinkingLevels) ? option.supportedThinkingLevels : [];
  }

  function normalizeThinkingLevel(modelOptions, provider, model, current) {
    const value = String(current || '').trim();
    return supportedThinkingLevels(modelOptions, provider, model).includes(value) ? value : '';
  }

  function nextProfileId(profiles) {
    const used = new Set((Array.isArray(profiles) ? profiles : []).map((profile) => String(profile && profile.id || '').trim()).filter(Boolean));
    let index = 1;
    while (used.has(`profile-${index}`)) index += 1;
    return `profile-${index}`;
  }

  function fillThinkingSelect(select, modelOptions, provider, model, current) {
    const levels = supportedThinkingLevels(modelOptions, provider, model);
    select.innerHTML = '';
    for (const level of ['', ...levels]) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = level ? `${THINKING_LABELS[level] || level} · ${level}` : THINKING_LABELS[''];
      select.appendChild(option);
    }
    select.value = levels.includes(current) ? current : '';
  }

  function availabilityCopy(availability) {
    return modelOptionUtils.roleAvailabilityLabel(availability);
  }

  function familyLabel(family) {
    return FAMILY_LABELS[family] || family || '未归类';
  }

  function requestIssueMessage(error, fallback) {
    const issue = error && Array.isArray(error.issues) ? error.issues[0] : null;
    return issue && issue.code ? `${fallback}（${issue.code}${issue.path ? ` · ${issue.path}` : ''}）` : error.message || fallback;
  }

  function buildRolePayload(role, modelOptions) {
    const family = role && role.roleKind === 'model_family';
    const profiles = (Array.isArray(role && role.modelProfiles) ? role.modelProfiles : []).map((profile) => ({
      id: profile.id || '',
      name: profile.name || '',
      description: profile.description || '',
      provider: profile.provider || '',
      model: profile.model || '',
      thinking: normalizeThinkingLevel(modelOptions, profile.provider, profile.model, profile.thinking),
      ...(family ? {} : { personaPrompt: profile.personaPrompt || '' }),
    }));
    if (family) {
      const payload = { isDefaultChatRole: Boolean(role.isDefaultChatRole) };
      if (role.model || roleModelOptions(role, modelOptions).length > 0) {
        Object.assign(payload, {
          provider: role.provider || '',
          model: role.model || '',
          thinking: normalizeThinkingLevel(modelOptions, role.provider, role.model, role.thinking),
          modelProfiles: profiles,
        });
      }
      return payload;
    }
    return {
      id: role.id || '',
      name: role.name || '',
      description: role.description || '',
      sandboxName: role.sandboxName || '',
      avatarDataUrl: role.avatarDataUrl || '',
      personaPrompt: role.personaPrompt || '',
      provider: role.provider || '',
      model: role.model || '',
      thinking: normalizeThinkingLevel(modelOptions, role.provider, role.model, role.thinking),
      accentColor: role.accentColor || '#3d405b',
      skillIds: Array.isArray(role.skillIds) ? role.skillIds : [],
      modelProfiles: profiles,
      isDefaultChatRole: Boolean(role.isDefaultChatRole),
    };
  }

  namespace.managementUtils = {
    FAMILY_LABELS,
    THINKING_LABELS,
    availabilityCopy,
    buildRolePayload,
    clone,
    escapeHtml,
    familyLabel,
    fillModelSelect,
    fillThinkingSelect,
    findModelOption,
    modelOptionKey,
    nextProfileId,
    normalizeThinkingLevel,
    requestIssueMessage,
    roleModelOptions,
    supportedThinkingLevels,
  };
})();
