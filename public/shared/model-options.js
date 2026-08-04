// @ts-check

(function registerModelOptions() {
  const shared = window.CaffShared || (window.CaffShared = {});

  function normalizeModelOptions(modelOptions) {
    return Array.isArray(modelOptions) ? modelOptions : [];
  }

  const ROLE_AVAILABILITY_LABELS = {
    available: '可运行',
    no_family_models: '尚无同族模型',
    base_model_missing: '默认模型不可用',
    base_model_unknown: '默认模型不可用',
    default_model_missing: '默认模型不可用',
    base_model_out_of_family: '默认模型跨族',
    default_model_out_of_family: '默认模型跨族',
    profile_model_missing: 'Profile 模型不可用',
    profile_model_unknown: 'Profile 模型不可用',
    profile_model_out_of_family: 'Profile 模型跨族',
    thinking_level_unsupported: '思考强度不受支持',
    role_missing: '角色配置不存在',
  };

  const ROLE_AVAILABILITY_REASONS = {
    no_family_models: '没有可用的同族模型，请先到模型供应商完成配置',
    base_model_missing: '没有可用模型：默认模型已不在当前模型目录中',
    base_model_unknown: '没有可用模型：默认模型已不在当前模型目录中',
    default_model_missing: '没有可用模型：默认模型已不在当前模型目录中',
    base_model_out_of_family: '默认模型不属于该模型族',
    default_model_out_of_family: '默认模型不属于该模型族',
    thinking_level_unsupported: '当前思考强度不受所选模型支持',
    profile_model_missing: '运行 Profile 引用了失效模型',
    profile_model_unknown: '运行 Profile 引用了失效模型',
    profile_model_out_of_family: '运行 Profile 使用了跨族模型',
    role_missing: '角色配置不存在',
  };

  function roleAvailabilityStatus(availability) {
    return String(availability && availability.status || 'available').trim() || 'available';
  }

  function roleAvailabilityLabel(availability) {
    const status = roleAvailabilityStatus(availability);
    return ROLE_AVAILABILITY_LABELS[status] || (status === 'available' ? '可运行' : '当前不可运行');
  }

  function roleAvailabilityReason(availability) {
    const status = roleAvailabilityStatus(availability);
    return ROLE_AVAILABILITY_REASONS[status] || (status === 'available' ? '' : `当前不可用：${status}`);
  }

  function isRoleAvailable(availability) {
    return roleAvailabilityStatus(availability) === 'available';
  }

  function modelOptionKey(provider, model) {
    return `${String(provider || '').trim()}\u001f${String(model || '').trim()}`;
  }

  const MODEL_SOURCE_LABELS = {
    models_json: '已配置',
    runtime: '运行时默认',
  };

  function buildModelOptionLabel(option) {
    if (!option) {
      return '系统默认模型';
    }

    const label = String(option.label || option.model || '').trim();
    const provider = String(option.provider || '').trim();
    const source = MODEL_SOURCE_LABELS[option.source] || String(option.sourceLabel || '').trim();
    return [label, provider, source].filter(Boolean).join(' · ');
  }

  function fillModelSelect(select, modelOptions, currentProvider = '', currentModel = '') {
    if (!select) {
      return;
    }

    const normalizedOptions = normalizeModelOptions(modelOptions);
    const selectedKey = currentModel ? modelOptionKey(currentProvider, currentModel) : '';
    select.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '系统默认模型';
    select.appendChild(defaultOption);

    normalizedOptions.forEach((option) => {
      const element = document.createElement('option');
      element.value = option.key;
      element.textContent = buildModelOptionLabel(option);
      select.appendChild(element);
    });

    if (selectedKey && !normalizedOptions.some((option) => option.key === selectedKey)) {
      const currentOption = document.createElement('option');
      currentOption.value = selectedKey;
      currentOption.textContent = currentProvider ? `${currentProvider} / ${currentModel}` : currentModel;
      select.appendChild(currentOption);
    }

    select.value = selectedKey;
  }

  function selectedModelOption(select, modelOptions) {
    if (!select || !select.value) {
      return null;
    }

    const normalizedOptions = normalizeModelOptions(modelOptions);
    const existingOption = normalizedOptions.find((option) => option.key === select.value);

    if (existingOption) {
      return existingOption;
    }

    const [provider, model] = String(select.value).split('\u001f');

    if (!model) {
      return null;
    }

    return {
      key: select.value,
      provider: provider || '',
      model: model || '',
      label: provider ? `${provider} / ${model}` : model,
      sourceLabel: '',
    };
  }

  function syncProviderFromModelSelect(select, providerInput, modelOptions) {
    if (!providerInput) {
      return;
    }

    const option = selectedModelOption(select, modelOptions);
    providerInput.value = option ? option.provider || '' : '';
  }

  shared.modelOptions = {
    buildModelOptionLabel,
    fillModelSelect,
    modelOptionKey,
    isRoleAvailable,
    roleAvailabilityLabel,
    roleAvailabilityReason,
    selectedModelOption,
    syncProviderFromModelSelect,
  };
})();
