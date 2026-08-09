// @ts-check

(function registerProviderEditor() {
  const namespace = window.CaffPersonas || (window.CaffPersonas = {});

  namespace.createProviderEditor = function createProviderEditor(options) {
    const root = options.root;
    const utils = namespace.managementUtils;
    let draft = null;
    let isDraft = false;
    let sourceId = '';

    const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
    const select = (id) => /** @type {HTMLSelectElement} */ (document.getElementById(id));

    function familyOptions(selected) {
      return ['', ...Object.keys(utils.FAMILY_LABELS)].map((family) => (
        `<option value="${family}" ${family === selected ? 'selected' : ''}>${family ? utils.familyLabel(family) : '未归类'}</option>`
      )).join('');
    }

    function modelMarkup(model, index) {
      const inputCapabilities = Array.isArray(model.input) ? model.input : ['text'];
      const supportsImage = inputCapabilities.includes('image');
      return `
        <div class="provider-model-row" data-provider-model data-model-index="${index}">
          <label><span>模型 ID</span><input data-field="id" value="${utils.escapeHtml(model.id || '')}" /></label>
          <label><span>显示名称</span><input data-field="name" value="${utils.escapeHtml(model.name || '')}" /></label>
          <label><span>模型族归类</span><select data-field="family">${familyOptions(model.family || '')}</select></label>
          <label class="provider-model-reasoning"><input data-field="reasoning" type="checkbox" ${model.reasoning ? 'checked' : ''} />支持 reasoning</label>
          <label class="provider-model-reasoning"><input data-field="input-image" type="checkbox" ${supportsImage ? 'checked' : ''} />支持图片输入</label>
          <button class="ghost-button danger" type="button" data-remove-provider-model="${index}">移除</button>
        </div>`;
    }

    function authCopy() {
      if (draft.hasApiKey) return `已保存 · ${draft.apiKeyMode}`;
      if (draft.hasExternalAuth) return '外部认证已配置';
      return '尚未配置认证';
    }

    function render() {
      if (!draft) {
        root.innerHTML = '<div class="empty-state">选择一个供应商查看详情。</div>';
        return;
      }
      const locked = !options.isEnabled();
      const canClear = Boolean(draft.hasApiKey) && !locked;
      const providerId = String(draft.id || '').trim();
      const canSave = Boolean(providerId) && !locked && (!isDraft || !providerId.startsWith('__draft-'));
      const models = Array.isArray(draft.models) ? draft.models : [];
      const writableAuthMode = draft.apiKeyMode === 'external' ? 'none' : draft.apiKeyMode || 'none';
      root.innerHTML = `
        <div class="management-detail-top">
          <div><p class="eyebrow">Model Provider</p><h2>${utils.escapeHtml(draft.name || draft.id || '新供应商')}</h2><p>${isDraft ? '填写连接与模型目录后保存。' : `${models.length} 个模型条目 · ${authCopy()}`}</p></div>
          <button id="remove-provider" class="ghost-button danger" type="button" aria-expanded="false" ${locked ? 'disabled' : ''}>${isDraft ? '放弃草稿' : '移除供应商'}</button>
        </div>
        <div id="remove-provider-confirmation" class="danger-confirmation hidden" role="alert">
          <p><strong>${isDraft ? '放弃未保存草稿？' : '确认移除供应商？'}</strong><br />${isDraft ? '不会产生任何写入。' : `将从 models.json 删除 ${models.length} 个模型条目，相关模型族角色会变为不可用；历史聊天、角色身份和外部认证不会删除。`}</p>
          <div><button id="cancel-remove-provider" class="ghost-button" type="button">取消</button><button id="confirm-remove-provider" class="ghost-button danger" type="button">${isDraft ? '放弃草稿' : '确认移除'}</button></div>
        </div>
        <section class="management-card">
          <div class="management-card-title"><div><h3>连接设置</h3><p>Provider 是 catalog 上游，不直接改写角色。</p></div></div>
          <div class="field-grid">
            <label><span>Provider ID</span><input id="provider-id" value="${utils.escapeHtml(draft.id || '')}" ${isDraft ? '' : 'readonly'} placeholder="例如 openai-compatible" /></label>
            <label><span>显示名称</span><input id="provider-name" value="${utils.escapeHtml(draft.name || '')}" /></label>
            <label><span>Base URL</span><input id="provider-base-url" value="${utils.escapeHtml(draft.baseUrl || '')}" inputmode="url" /></label>
            <label><span>API 协议</span><input id="provider-api-protocol" value="${utils.escapeHtml(draft.api || '')}" placeholder="openai-responses" /></label>
            <label><span>Authorization Header</span><select id="provider-auth-header"><option value="false" ${draft.authHeader ? '' : 'selected'}>由协议处理</option><option value="true" ${draft.authHeader ? 'selected' : ''}>启用 Bearer</option></select></label>
            <label><span>models.json 认证模式</span><select id="provider-auth-mode">${['none', 'literal', 'env', 'command'].map((mode) => `<option value="${mode}" ${mode === writableAuthMode ? 'selected' : ''}>${mode}</option>`).join('')}</select></label>
          </div>
          ${draft.hasExternalAuth ? '<p id="provider-external-auth-note" class="management-note">auth.json / CLI 外部认证只读；本页不会写入、替换或清除它。</p>' : ''}
        </section>
        <section class="management-card">
          <div class="management-card-title"><div><h3>API Key</h3><p>读取接口只返回状态与模式，输入框永远为空。</p></div><span class="status-badge ${draft.hasApiKey || draft.hasExternalAuth ? '' : 'warning'}">${authCopy()}</span></div>
          <label><span>输入新密钥</span><input id="provider-api-key" type="password" value="${utils.escapeHtml(draft.pendingApiKey || '')}" autocomplete="new-password" data-has-api-key="${Boolean(draft.hasApiKey)}" placeholder="留空以保留已保存密钥" /></label>
          <details class="advanced-auth" ${(draft.apiKeyMode === 'env' || draft.apiKeyMode === 'command') ? 'open' : ''}><summary>高级认证：环境变量 / 命令引用</summary><label><span>输入新引用</span><input id="provider-auth-reference" type="password" value="${utils.escapeHtml(draft.pendingAuthReference || '')}" autocomplete="new-password" placeholder="$PROVIDER_API_KEY 或 !credential-helper" /></label><p class="management-note">已有 reference 不回显；验证连接不会执行 command。</p></details>
          <button id="clear-provider-secret" class="ghost-button danger" type="button" aria-expanded="false" ${canClear ? '' : 'disabled'}>清除已保存密钥</button>
          <div id="clear-secret-confirmation" class="danger-confirmation hidden" role="alert"><p><strong>确认清除？</strong> 普通保存不会执行此操作。</p><div><button id="cancel-clear-secret" class="ghost-button" type="button">取消</button><button id="confirm-clear-secret" class="ghost-button danger" type="button">确认清除</button></div></div>
          <div id="command-reference-confirmation" class="danger-confirmation hidden" role="alert"><p><strong>确认设置命令引用？</strong> 命令只会在实际模型运行时由 Pi 解析执行。</p><div><button id="cancel-command-reference" class="ghost-button" type="button">取消</button><button id="confirm-command-reference" class="ghost-button danger" type="button">确认并保存</button></div></div>
        </section>
        <section class="management-card">
          <div class="management-card-title"><div><h3>模型目录</h3><p>显式 family 决定系统模型族角色的可见模型。</p></div><button id="add-provider-model" class="ghost-button" type="button" ${locked ? 'disabled' : ''}>添加模型</button></div>
          <div class="provider-model-editor">${models.length ? models.map(modelMarkup).join('') : '<div id="provider-empty-models" class="empty-state">尚未添加模型。</div>'}</div>
          <p class="management-note">未展开的兼容字段由服务端 patch-merge 原样保留。</p>
        </section>
        <div class="management-actions"><button id="validate-provider" class="ghost-button" type="button" ${!isDraft && canSave ? '' : 'disabled'}>验证当前已保存连接</button><button id="save-provider" type="button" ${canSave ? '' : 'disabled'}>保存供应商</button></div>
        <p id="provider-error" class="management-error hidden" role="alert"></p>`;
      if (locked) root.querySelectorAll('input, select, button').forEach((control) => { control.disabled = true; });
      bindEvents();
    }

    function updateSimpleFields() {
      draft.id = input('provider-id').value.trim();
      draft.name = input('provider-name').value.trim();
      draft.baseUrl = input('provider-base-url').value.trim();
      draft.api = input('provider-api-protocol').value.trim();
      draft.authHeader = select('provider-auth-header').value === 'true';
      draft.apiKeyMode = select('provider-auth-mode').value;
      draft.pendingApiKey = input('provider-api-key').value;
      draft.pendingAuthReference = input('provider-auth-reference').value;
    }

    function buildPayload() {
      updateSimpleFields();
      const secret = draft.apiKeyMode === 'env' || draft.apiKeyMode === 'command'
        ? draft.pendingAuthReference.trim()
        : draft.pendingApiKey.trim();
      return {
        name: draft.name, baseUrl: draft.baseUrl, api: draft.api, authHeader: draft.authHeader,
        apiKeyMode: draft.apiKeyMode, apiKey: secret,
        models: draft.models.map((model) => ({
          id: String(model.id || '').trim(), name: String(model.name || '').trim(), family: String(model.family || '').trim(),
          reasoning: Boolean(model.reasoning), input: Array.isArray(model.input) ? model.input.slice() : ['text'],
        })),
      };
    }

    async function saveProvider(skipCommandConfirmation = false) {
      const payload = buildPayload();
      if (payload.apiKeyMode === 'command' && payload.apiKey && !skipCommandConfirmation) {
        document.getElementById('command-reference-confirmation').classList.remove('hidden');
        document.getElementById('confirm-command-reference').focus();
        return;
      }
      try { await options.onSave(draft.id, payload); } catch (error) { showError(error, '供应商保存失败'); }
    }

    function showError(error, fallback) {
      const target = document.getElementById('provider-error');
      target.textContent = utils.requestIssueMessage(error, fallback);
      target.classList.remove('hidden');
    }

    function bindEvents() {
      if (isDraft) {
        input('provider-id').addEventListener('input', () => {
          draft.id = input('provider-id').value.trim();
          /** @type {HTMLButtonElement} */ (document.getElementById('save-provider')).disabled = !draft.id || !options.isEnabled();
        });
      }
      root.querySelectorAll('[data-provider-model]').forEach((row) => {
        const index = Number(row.dataset.modelIndex);
        row.addEventListener('input', (event) => {
          const field = event.target.dataset.field;
          if (field === 'reasoning') draft.models[index].reasoning = event.target.checked;
          else if (field === 'input-image') {
            const capabilities = Array.isArray(draft.models[index].input) ? draft.models[index].input : ['text'];
            const next = capabilities.filter((entry) => entry !== 'image');
            if (event.target.checked && !next.includes('image')) next.push('image');
            draft.models[index].input = next;
          } else if (field) draft.models[index][field] = event.target.value;
        });
      });
      root.querySelectorAll('[data-remove-provider-model]').forEach((button) => button.addEventListener('click', () => {
        updateSimpleFields();
        draft.models.splice(Number(button.dataset.removeProviderModel), 1); render(); document.getElementById('add-provider-model').focus();
      }));
      document.getElementById('add-provider-model').addEventListener('click', () => {
        updateSimpleFields();
        const index = draft.models.length;
        draft.models.push({ id: '', name: '', family: '', reasoning: false, input: ['text'] });
        render();
        root.querySelector(`[data-model-index="${index}"] [data-field="id"]`).focus();
      });
      document.getElementById('save-provider').addEventListener('click', () => saveProvider());
      document.getElementById('validate-provider').addEventListener('click', async () => { try { await options.onValidate(draft.id); } catch (error) { showError(error, '连接验证失败'); } });
      document.getElementById('clear-provider-secret').addEventListener('click', () => { document.getElementById('clear-secret-confirmation').classList.remove('hidden'); document.getElementById('confirm-clear-secret').focus(); });
      document.getElementById('cancel-clear-secret').addEventListener('click', () => { document.getElementById('clear-secret-confirmation').classList.add('hidden'); document.getElementById('clear-provider-secret').focus(); });
      document.getElementById('confirm-clear-secret').addEventListener('click', async () => { try { await options.onClear(draft.id); } catch (error) { showError(error, '密钥清除失败'); } });
      document.getElementById('remove-provider').addEventListener('click', () => { document.getElementById('remove-provider-confirmation').classList.remove('hidden'); document.getElementById('confirm-remove-provider').focus(); });
      document.getElementById('cancel-remove-provider').addEventListener('click', () => { document.getElementById('remove-provider-confirmation').classList.add('hidden'); document.getElementById('remove-provider').focus(); });
      document.getElementById('confirm-remove-provider').addEventListener('click', async () => { try { await options.onRemove(isDraft ? sourceId : draft.id, isDraft); } catch (error) { showError(error, '供应商移除失败'); } });
      document.getElementById('cancel-command-reference').addEventListener('click', () => { document.getElementById('command-reference-confirmation').classList.add('hidden'); document.getElementById('save-provider').focus(); });
      document.getElementById('confirm-command-reference').addEventListener('click', () => saveProvider(true));
    }

    return {
      show(provider, draftState = false) {
        draft = provider ? utils.clone(provider) : null;
        sourceId = draft && draft.id || '';
        if (draft) {
          draft.models = Array.isArray(draft.models) ? draft.models : [];
          draft.pendingApiKey = '';
          draft.pendingAuthReference = '';
        }
        isDraft = draftState;
        render();
      },
    };
  };
})();
