// @ts-check

(function registerCatalogImport() {
  const namespace = window.CaffPersonas || (window.CaffPersonas = {});

  namespace.createCatalogImport = function createCatalogImport(options) {
    const root = options.root;
    const utils = namespace.managementUtils;
    let index = null;
    let filter = '';
    let selectedProviderId = '';
    let projection = null;
    let importPending = false;

    const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

    function adminHeaders() {
      const token = options.getCsrfToken();
      return token ? { 'X-CAFF-CSRF-Token': token } : {};
    }

    function provenanceSummary(provenance) {
      if (!provenance) return '';
      const parts = [provenance.kind, provenance.sourceUrl, provenance.fetchedAt];
      if (provenance.commitSha) parts.push(provenance.commitSha);
      else if (provenance.etag) parts.push(`etag ${provenance.etag}`);
      return parts.filter(Boolean).join(' · ');
    }

    function modelRow(model) {
      const badges = [];
      if (model.dialect) badges.push(utils.escapeHtml(model.dialect));
      else badges.push('需手工配置');
      badges.push(model.family ? utils.familyLabel(model.family) : '未归类');
      return `
        <div class="catalog-model-row" data-catalog-model="${utils.escapeHtml(model.id)}">
          <button class="ghost-button" type="button" data-catalog-open-model="${utils.escapeHtml(model.id)}">
            ${utils.escapeHtml(model.name || model.id)} <small>${badges.join(' · ')}</small>
          </button>
        </div>`;
    }

    function providerRow(provider) {
      const models = Array.isArray(provider.models) ? provider.models : [];
      const providerSearch = `${provider.id} ${provider.name || ''}`.toLowerCase();
      const hidden = Boolean(filter) && !providerSearch.includes(filter);
      const open = selectedProviderId === provider.id;
      return `
        <div class="catalog-provider-row${hidden ? ' hidden' : ''}" data-catalog-provider="${utils.escapeHtml(provider.id)}" data-catalog-search="${utils.escapeHtml(providerSearch)}">
          <button class="ghost-button" type="button" data-catalog-open-provider="${utils.escapeHtml(provider.id)}" aria-expanded="${open}">
            ${utils.escapeHtml(provider.name || provider.id)} <small>${utils.escapeHtml(provider.id)} · ${models.length} 个模型 · ${provider.env.length} 个环境变量</small>
          </button>
          <div class="catalog-model-list${open ? '' : ' hidden'}">${open ? models.map(modelRow).join('') : ''}</div>
        </div>`;
    }

    function envMarkup(env) {
      if (!env.length) return '<li>目录未声明环境变量。</li>';
      return env.map((entry) => {
        const kind = entry.kind === 'key' ? '密钥' : '参数';
        const note = entry.kind === 'key'
          ? '导入后在 API Key 区用 env 模式引用本变量；值由你在本机填写，目录不接触密钥值。'
          : '非密钥参数，需手工配置。';
        return `<li><code>${utils.escapeHtml(entry.name)}</code> · ${kind}${entry.required ? ' · 必填' : ''} — ${note}</li>`;
      }).join('');
    }

    function metadataMarkup() {
      const meta = projection.catalogMetadata || {};
      const cost = meta.cost && (meta.cost.input != null || meta.cost.output != null)
        ? `<p class="management-note">目录参考价（非计费真相）：input $${utils.escapeHtml(meta.cost.input)} / output $${utils.escapeHtml(meta.cost.output)} 每 M token。</p>`
        : '';
      const limit = meta.limit && (meta.limit.context != null || meta.limit.output != null)
        ? `<p class="management-note">目录参考上下文上限：${utils.escapeHtml(meta.limit.context ?? '?')} tokens · 输出上限 ${utils.escapeHtml(meta.limit.output ?? '?')} tokens。</p>`
        : '';
      const modalities = meta.modalities
        ? `<p class="management-note">目录声明模态：<code>${utils.escapeHtml(JSON.stringify(meta.modalities))}</code>（参考元数据）。</p>`
        : '';
      const reasoning = meta.reasoningOptions
        ? '<p class="management-note">目录声明了 reasoning 选项；这只是目录元数据，Pi runtime 实际支持的 thinking 档位以运行时为准。</p>'
        : '';
      return `
        <section class="management-card" id="catalog-import-metadata">
          <div class="management-card-title"><div><h3>目录元数据（只读参考）</h3><p>来自 models.dev 目录的展示信息，不等于 Pi runtime 可执行能力。</p></div></div>
          <div class="field-grid">
            <label><span>方言</span><input value="${utils.escapeHtml(projection.dialect || '未支持方言')}" readonly /></label>
            <label><span>目录 Base URL</span><input value="${utils.escapeHtml(projection.baseUrl || '目录未提供')}" readonly /></label>
            <label><span>模型族</span><input value="${projection.family ? utils.familyLabel(projection.family) : '未归类'}" readonly /></label>
          </div>
          <h4>环境变量（仅变量名）</h4>
          <ul>${envMarkup(projection.env)}</ul>
          ${cost}${limit}${modalities}${reasoning}
          <p class="management-note">来源：${utils.escapeHtml(provenanceSummary(projection.provenance))}</p>
        </section>`;
    }

    function controlsMarkup() {
      const manual = Boolean(projection.manualConfigurationRequired);
      return `
        <section class="management-card" id="catalog-import-controls">
          <div class="management-card-title"><div><h3>导入设置</h3><p>显式确认后才写入 models.json；不会提交密钥、header 或环境变量值。</p></div></div>
          ${manual ? '<p id="catalog-import-manual" class="management-warning"><strong>需手工配置</strong><p>该模型方言不在 CAFF 支持清单内，目录导入已关闭；请回到供应商编辑手工填写连接。</p></p>' : ''}
          <div class="field-grid">
            <label><span>模型显示名称</span><input id="catalog-import-name" value="${utils.escapeHtml(projection.name || '')}" /></label>
            <label><span>Base URL</span><input id="catalog-import-base-url" value="${utils.escapeHtml(projection.baseUrl || '')}" inputmode="url" /></label>
            <label class="provider-model-reasoning"><input id="catalog-import-reasoning" type="checkbox" />支持 reasoning</label>
            <label class="provider-model-reasoning"><input id="catalog-import-input-image" type="checkbox" ${projection.input && projection.input.includes('image') ? 'checked' : ''} />支持图片输入</label>
          </div>
          <div class="management-actions"><button id="catalog-import-confirm" type="button" ${manual || importPending || !options.isEnabled() ? 'disabled' : ''}>确认导入</button></div>
        </section>`;
    }

    function render() {
      root.innerHTML = `
        <div class="management-detail-top">
          <div><p class="eyebrow">Catalog Import</p><h2>从目录导入</h2><p>目录元数据只读参考；显式确认后才写入 models.json。</p></div>
          <button id="catalog-import-close" class="ghost-button" type="button">返回供应商</button>
        </div>
        <section class="management-card">
          <div class="management-card-title"><div><h3>models.dev 目录</h3><p>${utils.escapeHtml(provenanceSummary(index && index.provenance))}</p></div></div>
          <label><span>搜索供应商</span><input id="catalog-import-search" value="${utils.escapeHtml(filter)}" placeholder="按供应商名称或 ID 过滤" /></label>
          <div class="catalog-provider-list">${index.providers.map(providerRow).join('')}</div>
        </section>
        ${projection ? metadataMarkup() + controlsMarkup() : ''}
        <p id="catalog-import-error" class="management-error hidden" role="alert"></p>`;
      bindEvents();
    }

    function applyProviderFilter() {
      root.querySelectorAll('[data-catalog-provider]').forEach((row) => {
        const providerSearch = row.dataset.catalogSearch || '';
        row.classList.toggle('hidden', Boolean(filter) && !providerSearch.includes(filter));
      });
    }

    function showError(error, fallback) {
      const target = document.getElementById('catalog-import-error');
      if (!target) return;
      target.textContent = utils.requestIssueMessage(error, fallback);
      target.classList.remove('hidden');
    }

    async function confirmImport() {
      if (importPending || !projection || projection.manualConfigurationRequired) return;
      importPending = true;
      /** @type {HTMLButtonElement} */ (document.getElementById('catalog-import-confirm')).disabled = true;
      const body = { providerId: projection.providerId, modelId: projection.modelId };
      const name = input('catalog-import-name').value.trim();
      const baseUrl = input('catalog-import-base-url').value.trim();
      if (name) body.name = name;
      if (baseUrl) body.baseUrl = baseUrl;
      if (input('catalog-import-reasoning').checked) body.reasoning = true;
      body.input = input('catalog-import-input-image').checked ? ['text', 'image'] : ['text'];
      try {
        await options.fetchJson('/api/model-catalog/import', { method: 'POST', body, headers: adminHeaders() });
        options.showToast(`已导入 ${projection.providerId} / ${projection.modelId}；密钥请在供应商编辑中填写`);
        options.onImported(projection.providerId, projection.modelId);
      } catch (error) {
        importPending = false;
        render();
        showError(error, '目录导入失败');
      }
    }

    async function openModel(providerId, modelId) {
      try {
        const result = await options.fetchJson(`/api/model-catalog?providerId=${encodeURIComponent(providerId)}&modelId=${encodeURIComponent(modelId)}`);
        projection = result.projection;
        render();
      } catch (error) {
        showError(error, '目录详情加载失败');
      }
    }

    function bindEvents() {
      document.getElementById('catalog-import-close').addEventListener('click', () => options.onClose());
      input('catalog-import-search').addEventListener('input', () => {
        const search = input('catalog-import-search');
        filter = search.value.trim().toLowerCase();
        applyProviderFilter();
      });
      root.querySelectorAll('[data-catalog-open-provider]').forEach((button) => button.addEventListener('click', () => {
        const providerId = button.dataset.catalogOpenProvider;
        selectedProviderId = selectedProviderId === providerId ? '' : providerId;
        projection = null;
        render();
      }));
      root.querySelectorAll('[data-catalog-open-model]').forEach((button) => button.addEventListener('click', () => {
        const providerId = button.closest('[data-catalog-provider]').dataset.catalogProvider;
        selectedProviderId = providerId;
        openModel(providerId, button.dataset.catalogOpenModel);
      }));
      const confirm = document.getElementById('catalog-import-confirm');
      if (confirm) confirm.addEventListener('click', () => confirmImport());
    }

    return {
      async open() {
        index = null;
        filter = '';
        selectedProviderId = '';
        projection = null;
        importPending = false;
        root.innerHTML = '<div class="empty-state">目录加载中…</div>';
        try {
          index = await options.fetchJson('/api/model-catalog');
        } catch (error) {
          const issue = error && Array.isArray(error.issues) ? error.issues[0] : null;
          if (issue && issue.code === 'catalog_source_unavailable') {
            root.innerHTML = `
              <div class="management-detail-top">
                <div><p class="eyebrow">Catalog Import</p><h2>从目录导入</h2></div>
                <button id="catalog-import-close" class="ghost-button" type="button">返回供应商</button>
              </div>
              <div id="catalog-import-unavailable" class="empty-state">目录快照未就位：vendored 快照尚未提交到仓库，models.dev 目录暂不可用。你仍可以手工添加供应商。</div>`;
            document.getElementById('catalog-import-close').addEventListener('click', () => options.onClose());
            return;
          }
          root.innerHTML = '<div class="management-detail-top"><div><p class="eyebrow">Catalog Import</p><h2>从目录导入</h2></div><button id="catalog-import-close" class="ghost-button" type="button">返回供应商</button></div><p id="catalog-import-error" class="management-error" role="alert"></p>';
          document.getElementById('catalog-import-close').addEventListener('click', () => options.onClose());
          showError(error, '目录加载失败');
          return;
        }
        render();
      },
    };
  };
})();
