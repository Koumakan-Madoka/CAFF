// @ts-check

(function registerProviderManagement() {
  const namespace = window.CaffPersonas || (window.CaffPersonas = {});
  const shared = window.CaffShared || (window.CaffShared = {});

  namespace.createProviderManagement = function createProviderManagement(options) {
    const list = options.list;
    let providers = [];
    let selectedProviderId = '';
    let mutationPending = false;
    const validationByProviderId = new Map();
    const editor = namespace.createProviderEditor({
      root: options.detail,
      isEnabled: options.isEnabled,
      onSave: async (providerId, payload) => {
        if (!providerId) throw new Error('Provider ID 不能为空');
        await runMutation(async () => {
          const result = await mutate(`/api/model-providers/${encodeURIComponent(providerId)}`, 'PUT', payload);
          validationByProviderId.delete(providerId);
          setProviders(result.providers, providerId);
          options.showToast('供应商已保存；空密钥保持原值');
          await options.onProvidersChanged();
        });
      },
      onClear: async (providerId) => {
        await runMutation(async () => {
          const result = await mutate(`/api/model-providers/${encodeURIComponent(providerId)}/secret`, 'DELETE', {});
          validationByProviderId.delete(providerId);
          setProviders(result.providers, providerId);
          options.showToast('已保存密钥已清除');
          await options.onProvidersChanged();
        });
      },
      onRemove: async (providerId, draft) => {
        if (draft) {
          setProviders(providers.filter((provider) => provider.id !== providerId));
          options.showToast('已放弃未保存的供应商草稿');
          return;
        }
        await runMutation(async () => {
          const result = await mutate(`/api/model-providers/${encodeURIComponent(providerId)}`, 'DELETE', {});
          validationByProviderId.delete(providerId);
          setProviders(result.providers);
          options.showToast('供应商已移除；历史与角色身份保持不变');
          await options.onProvidersChanged();
        });
      },
      onValidate: async (providerId) => {
        await runMutation(async () => {
          try {
            const result = await mutate(`/api/model-providers/${encodeURIComponent(providerId)}/validate`, 'POST', {});
            const validation = result.validation || {};
            validationByProviderId.set(providerId, {
              status: validation.status === 'ok' ? 'ok' : 'completed',
              modelCount: Number(validation.modelCount || 0),
            });
            renderList();
            options.showToast(`连接验证完成 · ${validation.modelCount || 0} 个模型`);
          } catch (error) {
            validationByProviderId.set(providerId, { status: 'error' });
            renderList();
            throw error;
          }
        });
      },
    });

    function setMutationPending(pending) {
      mutationPending = pending;
      options.addButton.disabled = pending || !options.isEnabled();
      options.importButton.disabled = pending || !options.isEnabled();
      options.refreshButton.disabled = pending || !options.isEnabled();
      list.inert = pending;
      options.detail.inert = pending;
      if (pending) options.detail.setAttribute('aria-busy', 'true');
      else options.detail.removeAttribute('aria-busy');
    }

    async function runMutation(operation) {
      if (mutationPending) throw new Error('供应商操作正在进行，请稍候');
      setMutationPending(true);
      try {
        return await operation();
      } finally {
        setMutationPending(false);
      }
    }

    function adminHeaders() {
      const token = options.getCsrfToken();
      return token ? { 'X-CAFF-CSRF-Token': token } : {};
    }

    function mutate(url, method, body) {
      if (!options.isEnabled()) throw new Error('当前部署不允许修改模型供应商');
      return options.fetchJson(url, { method, body, headers: adminHeaders() });
    }

    function listRow(provider) {
      const draft = Boolean(provider.__draft);
      const { row: item, button } = shared.createManagementListItem({
        id: provider.id,
        active: provider.id === selectedProviderId,
      });
      button.classList.add('management-list-row');
      button.dataset.providerId = provider.id;
      const mark = document.createElement('span');
      mark.className = 'provider-mark';
      mark.textContent = String(provider.name || provider.id || 'P').slice(0, 2).toUpperCase();
      const copy = document.createElement('span');
      copy.className = 'management-list-copy';
      const name = document.createElement('strong');
      name.textContent = draft ? '新供应商' : provider.name || provider.id || '未命名供应商';
      const meta = document.createElement('small');
      const validation = validationByProviderId.get(provider.id);
      const validationLabel = !validation
        ? '待验证'
        : validation.status === 'ok'
          ? `最近验证通过 · ${validation.modelCount} 个模型`
          : validation.status === 'error'
            ? '最近验证失败'
            : '最近验证已完成';
      meta.textContent = draft ? '尚未保存' : `${provider.id} · ${(provider.models || []).length} 个模型 · ${validationLabel}`;
      copy.append(name, meta);
      const status = document.createElement('span');
      status.className = `status-dot${validation && validation.status === 'ok' ? ' default' : ' warning'}`;
      status.title = draft ? '未保存草稿' : validationLabel;
      button.append(mark, copy, status);
      button.addEventListener('click', () => selectProvider(provider.id));
      return item;
    }

    function renderList() {
      list.innerHTML = '';
      providers.forEach((provider) => list.appendChild(listRow(provider)));
      if (!providers.length) list.innerHTML = `<li class="empty-state">${options.isEnabled() ? '还没有配置供应商。' : 'Provider 配置仅允许本机 loopback local-admin 访问。'}</li>`;
      const configuredCount = providers.filter((provider) => !provider.__draft).length;
      const draftCount = providers.length - configuredCount;
      options.count.textContent = `${configuredCount} 个连接${draftCount ? ` + ${draftCount} 个草稿` : ''}`;
    }

    function selectProvider(providerId) {
      selectedProviderId = providerId;
      renderList();
      const provider = providers.find((item) => item.id === providerId) || null;
      editor.show(provider, Boolean(provider && provider.__draft));
    }

    function setProviders(nextProviders, preferredProviderId = '') {
      providers = Array.isArray(nextProviders) ? nextProviders : [];
      selectedProviderId = preferredProviderId && providers.some((provider) => provider.id === preferredProviderId)
        ? preferredProviderId
        : selectedProviderId && providers.some((provider) => provider.id === selectedProviderId)
          ? selectedProviderId
          : providers[0] && providers[0].id || '';
      renderList();
      const selected = providers.find((provider) => provider.id === selectedProviderId) || null;
      editor.show(selected, Boolean(selected && selected.__draft));
    }

    options.addButton.addEventListener('click', () => {
      const draftId = `__draft-${Date.now()}`;
      providers.push({
        id: draftId, name: '', baseUrl: '', api: 'openai-completions', authHeader: false, hasApiKey: false,
        hasExternalAuth: false, apiKeyMode: 'none', hasCustomHeaders: false, models: [], __draft: true,
      });
      selectProvider(draftId);
      const idInput = /** @type {HTMLInputElement} */ (document.getElementById('provider-id'));
      idInput.value = '';
      idInput.focus();
    });

    const catalogImport = namespace.createCatalogImport({
      root: options.detail,
      fetchJson: options.fetchJson,
      showToast: options.showToast,
      isEnabled: options.isEnabled,
      getCsrfToken: options.getCsrfToken,
      onImported: async (providerId) => {
        await refreshProviders(providerId);
        await options.onProvidersChanged();
      },
      onClose: () => {
        const selected = providers.find((provider) => provider.id === selectedProviderId) || null;
        editor.show(selected, Boolean(selected && selected.__draft));
      },
    });

    options.importButton.addEventListener('click', async () => {
      try { await catalogImport.open(); } catch (error) { options.showToast(error.message || '目录加载失败'); }
    });

    async function refreshProviders(preferredProviderId = '') {
      const result = await options.fetchJson('/api/model-providers');
      setProviders(result.providers, preferredProviderId || selectedProviderId);
    }

    return {
      async refresh(preferredProviderId = '') {
        if (!options.isEnabled()) {
          setProviders([]);
          return;
        }
        await refreshProviders(preferredProviderId);
      },
    };
  };
})();
