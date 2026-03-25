(function registerModelOptions() {
  const shared = window.CaffShared || (window.CaffShared = {});

  function normalizeModelOptions(modelOptions) {
    return Array.isArray(modelOptions) ? modelOptions : [];
  }

  function modelOptionKey(provider, model) {
    return `${String(provider || '').trim()}\u001f${String(model || '').trim()}`;
  }

  function buildModelOptionLabel(option) {
    if (!option) {
      return '系统默认模型';
    }

    const detail = option.sourceLabel ? ` 路 ${option.sourceLabel}` : '';
    return `${option.label}${detail}`;
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
    selectedModelOption,
    syncProviderFromModelSelect,
  };
})();
