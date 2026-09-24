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
    let runtimeDefaults = { contextWindow: 128000, maxTokens: 16384 };
    let importPending = false;
    let importAdvisory = null;
    let importResult = null;
    // Set when an import has been persisted but the parent page has not been
    // refreshed yet. In-wizard navigation keeps it pending (the wizard still
    // owns the pane); the handback — 完成, 返回供应商 — flushes it.
    let importedIds = null;
    let importCompletionTriggered = false;
    let refreshPending = false;

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

    // Endpoint diagnostics come from the shared browser mirror of
    // server/domain/models/endpoint-diagnostics.ts, recomputed against the
    // *effective* dialect (a stored provider protocol wins over the catalog
    // dialect) and the current URL input. Advisory only.
    function effectiveDialect() {
      return (projection && (projection.effectiveDialect || projection.dialect)) || '';
    }

    function inspectEndpointDiagnostic(api, baseUrl) {
      const diagnostics = window.CaffShared && window.CaffShared.endpointDiagnostics;
      return diagnostics ? diagnostics.inspectDialectEndpoint(api, baseUrl) : null;
    }

    function dialectConflictMarkup() {
      const conflict = projection && projection.dialectConflict;
      if (!conflict) return '';
      return `<p id="catalog-import-dialect-conflict" class="management-warning"><strong>协议以已保存配置为准</strong> 该供应商已在 models.json 中配置协议 ${utils.escapeHtml(conflict.storedApi)}；导入不会修改它，目录方言 ${utils.escapeHtml(conflict.catalogDialect)} 仅作参考。下方诊断按实际生效的 ${utils.escapeHtml(conflict.storedApi)} 计算。</p>`;
    }

    // Advisory panel shown after a successful import. The import response
    // carries diagnostics computed against the *persisted* effective
    // configuration (stored provider protocol + model-level overrides), so the
    // user sees the true post-import state instead of a bare success toast.
    // Sibling conflicts (other models of the provider broken by the provider
    // URL change) are reported explicitly — a broken sibling must never be
    // silent.
    function importAdvisoryMarkup() {
      if (!importAdvisory) return '';
      const entries = [];
      if (importAdvisory.provider) entries.push(importAdvisory.provider);
      if (importAdvisory.model) entries.push(importAdvisory.model);
      const siblingConflicts = (importAdvisory.siblings || []).filter((entry) => entry && entry.diagnostic && entry.diagnostic.status === 'mismatch');
      if (!entries.length && !siblingConflicts.length) {
        return '<div id="catalog-import-post-import"><p class="management-note">已导入；落盘后的协议/地址组合未发现可诊断问题。</p></div>';
      }
      const blocks = entries.map((diagnostic) => `<p class="management-warning"><strong>落盘后诊断</strong> ${utils.escapeHtml(diagnostic.message)}</p>`);
      for (const sibling of siblingConflicts) {
        blocks.push(`<p class="management-warning"><strong>受影响的模型 ${utils.escapeHtml(sibling.modelId || '')}</strong> 供应商地址变化使其有效组合变为不匹配：${utils.escapeHtml(sibling.diagnostic.message)}</p>`);
      }
      return `<div id="catalog-import-post-import">${blocks.join('')}</div>`;
    }

    // Provider-level impact preview. A provider base URL is provider-wide: a
    // suggestion (or a manual edit) changes the effective request of every
    // sibling model that overrides the protocol but not the address. The
    // listing computes each affected sibling's effective combination under the
    // candidate URL, so a one-click fix is never offered without its
    // explanation.
    function updateSiblingImpact(diagnostic, currentUrl) {
      const impactElement = document.getElementById('catalog-import-sibling-impact');
      if (!impactElement || !projection) return;
      const siblings = Array.isArray(projection.siblingModelOverrides) ? projection.siblingModelOverrides : [];
      const affected = siblings.filter((entry) => entry && entry.modelId && !entry.baseUrl);
      const candidateUrl = diagnostic && diagnostic.suggestion ? diagnostic.suggestion : null;
      const manualUrl = currentUrl !== (projection.baseUrl || '') ? currentUrl : null;
      const impactUrl = candidateUrl || manualUrl;
      if (!affected.length || !impactUrl) {
        impactElement.innerHTML = '';
        return;
      }
      const rows = affected.map((entry) => {
        const api = entry.api || effectiveDialect();
        const siblingDiagnostic = inspectEndpointDiagnostic(api, impactUrl);
        const mismatched = siblingDiagnostic && siblingDiagnostic.status === 'mismatch';
        return `<li>${utils.escapeHtml(entry.modelId)}：协议 ${utils.escapeHtml(api)} · 地址 ${utils.escapeHtml(impactUrl)}${mismatched ? ` —— <strong>应用后将不匹配</strong>（${utils.escapeHtml(siblingDiagnostic.message)}）` : ''}</li>`;
      }).join('');
      impactElement.innerHTML = `<div class="management-warning"><strong>${candidateUrl ? '应用建议会影响同供应商的其他模型' : '修改供应商地址会影响同供应商的其他模型'}</strong> 以下模型覆盖了协议但未覆盖地址，实际请求会随供应商地址变化：<ul>${rows}</ul>如需保留它们的当前行为，请先在 models.json 中为相关模型补充 baseUrl 覆盖。</div>`;
    }

    function updateEndpointDiagnostics() {
      const container = document.getElementById('catalog-import-endpoint-diagnostic');
      if (!container || !projection) return;
      const currentUrl = input('catalog-import-base-url').value;
      const diagnostic = inspectEndpointDiagnostic(effectiveDialect(), currentUrl);
      container.innerHTML = diagnostic
        ? `<p id="catalog-import-endpoint-warning" class="management-warning"><strong>${diagnostic.status === 'mismatch' ? '协议与地址不匹配' : '请核对协议与地址'}</strong> ${utils.escapeHtml(diagnostic.message)}</p>
           ${diagnostic.suggestion ? `<div class="button-row"><button id="catalog-import-apply-endpoint-suggestion" class="ghost-button" type="button">应用建议地址：${utils.escapeHtml(diagnostic.suggestion)}</button></div>` : ''}`
        : '';
      const applyButton = document.getElementById('catalog-import-apply-endpoint-suggestion');
      if (applyButton) {
        applyButton.addEventListener('click', () => {
          // Recompute at click time so a stale suggestion can never apply.
          const current = inspectEndpointDiagnostic(effectiveDialect(), input('catalog-import-base-url').value);
          if (current && current.suggestion) {
            input('catalog-import-base-url').value = current.suggestion;
          }
          updateEndpointDiagnostics();
        });
      }
      updateSiblingImpact(diagnostic, currentUrl);

      const overrideElement = document.getElementById('catalog-import-model-override');
      if (overrideElement) {
        const override = projection.modelEndpointOverride || {};
        const fields = [
          override.api ? `api: ${override.api}` : '',
          override.baseUrl ? `baseUrl: ${override.baseUrl}` : '',
        ].filter(Boolean).join('，');
        const overrideDiagnostic = inspectEndpointDiagnostic(
          override.api || effectiveDialect(),
          override.baseUrl || input('catalog-import-base-url').value
        );
        const note = override.baseUrl
          ? `<strong>模型级覆盖仍优先生效</strong> models.json 中该模型已有模型级地址覆盖（${utils.escapeHtml(fields)}），导入后保留并优先于供应商地址；此处修改供应商地址不会改变该模型的实际请求。如需调整，请手工编辑 models.json 中该模型的覆盖字段。`
          : `<strong>模型级协议覆盖</strong> models.json 中该模型覆盖了协议（${utils.escapeHtml(fields)}）但未覆盖地址，实际请求为「协议 ${utils.escapeHtml(override.api || effectiveDialect())} + 供应商地址」；此处修改供应商地址会改变该模型的实际请求。如需固定，请手工编辑 models.json 为该模型补充 baseUrl 覆盖。`;
        overrideElement.innerHTML = note
          + (overrideDiagnostic ? `<br />${utils.escapeHtml(overrideDiagnostic.message)}` : '');
      }
    }

    function metadataMarkup() {
      const meta = projection.catalogMetadata || {};
      const cost = meta.cost && (meta.cost.input != null || meta.cost.output != null)
        ? `<p class="management-note">目录参考价（非计费真相）：input $${utils.escapeHtml(meta.cost.input)} / output $${utils.escapeHtml(meta.cost.output)} 每 M token。</p>`
        : '';
      const limit = meta.limit && (meta.limit.context != null || meta.limit.output != null)
        ? `<p class="management-note">目录原始限制：上下文 ${utils.escapeHtml(meta.limit.context ?? '?')} tokens · 输出 ${utils.escapeHtml(meta.limit.output ?? '?')} tokens。只有有效正整数会进入下方运行配置。</p>`
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

    // Read-only result card shown after a successful import. The import
    // response carries the *persisted* provider document, so the card shows
    // what was actually written — never the stale catalog projection. The
    // editable form must not survive into this state: the main button has
    // become 完成 and would not save anything, so a form that looks editable
    // would diverge from the persisted configuration.
    function extractImportResult(result, fallback) {
      const providers = result && Array.isArray(result.providers) ? result.providers : [];
      const provider = providers.find((entry) => entry && entry.id === fallback.providerId) || null;
      const models = provider && Array.isArray(provider.models) ? provider.models : [];
      const model = models.find((entry) => entry && entry.id === fallback.modelId) || null;
      return {
        providerId: fallback.providerId,
        modelId: fallback.modelId,
        providerName: provider && provider.name ? provider.name : '',
        providerApi: provider && provider.api ? provider.api : fallback.effectiveDialect,
        providerBaseUrl: provider && provider.baseUrl ? provider.baseUrl : fallback.baseUrl,
        modelName: model && model.name ? model.name : fallback.name,
        modelApi: model && model.api ? model.api : '',
        modelBaseUrl: model && model.baseUrl ? model.baseUrl : '',
      };
    }

    function importResultMarkup() {
      const result = importResult || { providerId: '', modelId: '', providerName: '', providerApi: '', providerBaseUrl: '', modelName: '', modelApi: '', modelBaseUrl: '' };
      const hasModelOverride = Boolean(result.modelApi || result.modelBaseUrl);
      return `
        <section class="management-card" id="catalog-import-result">
          <div class="management-card-title"><div><h3>导入结果（只读）</h3><p>以下为已写入 models.json 的实际配置。如需调整，请点击完成后在供应商编辑器中修改；模型级覆盖需直接编辑 models.json。</p></div></div>
          <div class="field-grid">
            <label><span>供应商</span><input value="${utils.escapeHtml(result.providerName || result.providerId || '未知')}" readonly /></label>
            <label><span>生效协议</span><input id="catalog-import-result-api" value="${utils.escapeHtml(result.providerApi || '未设置')}" readonly /></label>
            <label><span>供应商 Base URL</span><input id="catalog-import-result-base-url" value="${utils.escapeHtml(result.providerBaseUrl || '未设置')}" readonly /></label>
            <label><span>导入模型</span><input id="catalog-import-result-model" value="${utils.escapeHtml(result.modelName || result.modelId || '未知')}" readonly /></label>
          </div>
          ${hasModelOverride ? `<p class="management-note">该模型存在模型级覆盖（api: ${utils.escapeHtml(result.modelApi || '继承供应商')}，baseUrl: ${utils.escapeHtml(result.modelBaseUrl || '继承供应商')}），实际请求优先使用覆盖值。</p>` : ''}
          ${importAdvisoryMarkup()}
          <div class="management-actions"><button id="catalog-import-confirm" type="button" ${importCompletionTriggered || !options.isEnabled() ? 'disabled' : ''}>完成</button></div>
        </section>`;
    }

    function controlsMarkup() {
      const manual = Boolean(projection.manualConfigurationRequired);
      const hasContextWindow = Number.isInteger(projection.contextWindow);
      const hasMaxTokens = Number.isInteger(projection.maxTokens);
      const limitSource = hasContextWindow || hasMaxTokens
        ? '有效值来自当前 models.dev 快照，确认导入后写入模型运行配置。'
        : '目录未提供有效限制；不会猜测或写入，新的模型将使用 Pi 默认值。';
      return `
        <section class="management-card" id="catalog-import-controls">
          <div class="management-card-title"><div><h3>导入设置</h3><p>显式确认后才写入 models.json；不会提交密钥、header 或环境变量值。</p></div></div>
          ${manual ? '<p id="catalog-import-manual" class="management-warning"><strong>需手工配置</strong><p>该模型方言不在 CAFF 支持清单内，目录导入已关闭；请回到供应商编辑手工填写连接。</p></p>' : ''}
          <div class="field-grid">
            <label><span>模型显示名称</span><input id="catalog-import-name" value="${utils.escapeHtml(projection.name || '')}" /></label>
            <label><span>Base URL</span><input id="catalog-import-base-url" value="${utils.escapeHtml(projection.baseUrl || '')}" inputmode="url" /></label>
            <label><span>上下文窗口</span><input id="catalog-import-context-window" type="number" value="${hasContextWindow ? projection.contextWindow : ''}" placeholder="Pi 默认 ${utils.escapeHtml(runtimeDefaults.contextWindow)}" readonly /></label>
            <label><span>最大输出 token</span><input id="catalog-import-max-tokens" type="number" value="${hasMaxTokens ? projection.maxTokens : ''}" placeholder="Pi 默认 ${utils.escapeHtml(runtimeDefaults.maxTokens)}" readonly /></label>
            <label class="provider-model-reasoning"><input id="catalog-import-reasoning" type="checkbox" />支持 reasoning</label>
            <label class="provider-model-reasoning"><input id="catalog-import-input-image" type="checkbox" ${projection.input && projection.input.includes('image') ? 'checked' : ''} />支持图片输入</label>
          </div>
          <p id="catalog-import-limit-source" class="management-note">${limitSource}</p>
          ${dialectConflictMarkup()}
          <div id="catalog-import-endpoint-diagnostic"></div>
          <div id="catalog-import-sibling-impact"></div>
          ${projection.modelEndpointOverride ? '<p id="catalog-import-model-override" class="management-warning"></p>' : ''}
          <div class="management-actions"><button id="catalog-import-confirm" type="button" ${manual || importPending || importCompletionTriggered || !options.isEnabled() ? 'disabled' : ''}>${importAdvisory ? '完成' : '确认导入'}</button></div>
        </section>`;
    }

    function render() {
      root.innerHTML = `
        <div class="management-detail-top">
          <div><p class="eyebrow">Provider Search</p><h2>搜索供应商</h2><p>搜索 models.dev 目录；目录元数据只读参考，显式确认后才写入 models.json。</p></div>
          <button id="catalog-import-close" class="ghost-button" type="button">返回供应商</button>
        </div>
        <section class="management-card">
          <div class="management-card-title"><div><h3>models.dev 目录</h3><p>${utils.escapeHtml(provenanceSummary(index && index.provenance))}</p></div><button id="catalog-import-refresh" class="ghost-button" type="button"${refreshPending ? ' disabled' : ''}>${refreshPending ? '刷新中…' : '刷新目录'}</button></div>
          <label><span>搜索供应商</span><input id="catalog-import-search" value="${utils.escapeHtml(filter)}" placeholder="按供应商名称或 ID 过滤" /></label>
          <div class="catalog-provider-list">${index.providers.map(providerRow).join('')}</div>
        </section>
        ${projection ? metadataMarkup() + (importAdvisory ? importResultMarkup() : controlsMarkup()) : ''}
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

    async function refreshCatalog() {
      if (refreshPending) return;
      refreshPending = true;
      const button = /** @type {HTMLButtonElement} */ (document.getElementById('catalog-import-refresh'));
      if (button) {
        button.disabled = true;
        button.textContent = '刷新中…';
      }
      try {
        // 无 body 的管理变更也必须声明 application/json，否则 local admin guard 会拒 415 json_required
        const result = await options.fetchJson('/api/model-catalog/refresh', {
          method: 'POST',
          headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        });
        const message = result && result.status === 'not_modified'
          ? '目录已是最新：远端内容未变化（ETag 命中）'
          : `目录已更新：${result && result.providerCount} 家供应商`;
        refreshPending = false;
        await openCatalog();
        options.showToast(message);
      } catch (error) {
        refreshPending = false;
        render();
        showError(error, '目录刷新失败');
      }
    }

    async function confirmImport() {
      if (importPending || importAdvisory || !projection || projection.manualConfigurationRequired) return;
      const projectionAtStart = projection;
      importPending = true;
      /** @type {HTMLButtonElement} */ (document.getElementById('catalog-import-confirm')).disabled = true;
      const body = { providerId: projection.providerId, modelId: projection.modelId };
      const name = input('catalog-import-name').value.trim();
      const baseUrl = input('catalog-import-base-url').value.trim();
      if (name) body.name = name;
      if (baseUrl) body.baseUrl = baseUrl;
      if (input('catalog-import-reasoning').checked) body.reasoning = true;
      body.input = input('catalog-import-input-image').checked ? ['text', 'image'] : ['text'];
      if (Number.isInteger(projection.contextWindow)) body.contextWindow = projection.contextWindow;
      if (Number.isInteger(projection.maxTokens)) body.maxTokens = projection.maxTokens;
      try {
        const result = await options.fetchJson('/api/model-catalog/import', { method: 'POST', body, headers: adminHeaders() });
        // The import is persisted from here on: remember it so the eventual
        // handback refreshes the provider list even if the user navigates
        // away inside the wizard before finishing.
        importedIds = { providerId: projectionAtStart.providerId, modelId: projectionAtStart.modelId };
        if (projection !== projectionAtStart) {
          // The user navigated to another model while the import was in
          // flight: never paint the advisory over the new page.
          options.showToast(`已导入 ${projectionAtStart.providerId} / ${projectionAtStart.modelId}；返回供应商时将刷新列表`);
          return;
        }
        // Surface the persisted-effective diagnostics instead of discarding
        // them: the response reflects what was actually written. The wizard
        // keeps the page until the user finishes — firing onImported here
        // would replace the detail pane (refresh → editor) and erase the
        // advisory before anyone can read it.
        importAdvisory = {
          provider: (result && result.endpointDiagnostic) || null,
          model: (result && result.modelEndpointDiagnostic) || null,
          siblings: (result && Array.isArray(result.siblingEndpointDiagnostics)) ? result.siblingEndpointDiagnostics : [],
        };
        importResult = extractImportResult(result, {
          providerId: projectionAtStart.providerId,
          modelId: projectionAtStart.modelId,
          name: body.name || projectionAtStart.name,
          baseUrl,
          effectiveDialect: projectionAtStart.effectiveDialect || projectionAtStart.dialect || '',
        });
        importPending = false;
        options.showToast(`已导入 ${projection.providerId} / ${projection.modelId}；密钥请在供应商编辑中填写`);
        render();
      } catch (error) {
        importPending = false;
        if (projection !== projectionAtStart) {
          options.showToast('目录导入失败');
          return;
        }
        render();
        showError(error, '目录导入失败');
      }
    }

    // Completion hands the detail pane back to the parent (refresh + editor).
    // It fires only on an explicit user action — the 完成 button or the close
    // button — so the advisory stays readable and the provider list is never
    // left stale. A failed refresh keeps the advisory state and allows an
    // explicit retry instead of stranding the user on a disabled button.
    async function completeImport(thenClose = false) {
      if (importCompletionTriggered) return;
      const pending = importedIds || (importAdvisory && projection
        ? { providerId: projection.providerId, modelId: projection.modelId }
        : null);
      if (!pending) {
        if (thenClose) options.onClose();
        return;
      }
      importCompletionTriggered = true;
      render();
      try {
        await options.onImported(pending.providerId, pending.modelId);
      } catch (error) {
        importCompletionTriggered = false;
        render();
        showError(error, '刷新供应商列表失败，请重试完成');
        return;
      }
      importedIds = null;
      importAdvisory = null;
      importResult = null;
      importCompletionTriggered = false;
      const errorElement = document.getElementById('catalog-import-error');
      if (errorElement) errorElement.classList.add('hidden');
      // The parent now owns the detail pane (refresh → editor / onClose);
      // re-rendering here would steal it back.
      if (thenClose) options.onClose();
    }

    function requestClose() {
      if (importCompletionTriggered) return;
      if (importAdvisory || importedIds) {
        void completeImport(true);
      } else {
        options.onClose();
      }
    }

    async function openModel(providerId, modelId) {
      if (importCompletionTriggered) return;
      // In-wizard navigation away from a pending advisory: the import is
      // already persisted, so keep importedIds pending for the eventual
      // handback — but never let the parent reclaim the pane here. The target
      // page must be fully usable: no stale completion flag, no advisory.
      importAdvisory = null;
      importResult = null;
      importPending = false;
      try {
        const result = await options.fetchJson(`/api/model-catalog?providerId=${encodeURIComponent(providerId)}&modelId=${encodeURIComponent(modelId)}`);
        projection = result.projection;
        importAdvisory = null;
        if (result.runtimeDefaults && Number.isInteger(result.runtimeDefaults.contextWindow) && Number.isInteger(result.runtimeDefaults.maxTokens)) {
          runtimeDefaults = result.runtimeDefaults;
        }
        render();
      } catch (error) {
        showError(error, '目录详情加载失败');
      }
    }

    function bindEvents() {
      document.getElementById('catalog-import-close').addEventListener('click', () => {
        // Any exit from the wizard flushes a pending import handback first
        // (refresh), so the provider list is never left stale.
        requestClose();
      });
      const refreshButton = document.getElementById('catalog-import-refresh');
      if (refreshButton) refreshButton.addEventListener('click', () => {
        if (importCompletionTriggered) return;
        refreshCatalog();
      });
      input('catalog-import-search').addEventListener('input', () => {
        const search = input('catalog-import-search');
        filter = search.value.trim().toLowerCase();
        applyProviderFilter();
      });
      root.querySelectorAll('[data-catalog-open-provider]').forEach((button) => button.addEventListener('click', () => {
        if (importCompletionTriggered) return;
        const providerId = button.dataset.catalogOpenProvider;
        selectedProviderId = selectedProviderId === providerId ? '' : providerId;
        // Collapsing the model list is in-wizard navigation too: clear the
        // advisory view but keep a pending import handback alive.
        projection = null;
        importAdvisory = null;
        importResult = null;
        importPending = false;
        render();
      }));
      root.querySelectorAll('[data-catalog-open-model]').forEach((button) => button.addEventListener('click', () => {
        if (importCompletionTriggered) return;
        const providerId = button.closest('[data-catalog-provider]').dataset.catalogProvider;
        selectedProviderId = providerId;
        openModel(providerId, button.dataset.catalogOpenModel);
      }));
      const confirm = document.getElementById('catalog-import-confirm');
      if (confirm) confirm.addEventListener('click', () => {
        if (importAdvisory) {
          void completeImport(false);
        } else {
          confirmImport();
        }
      });
      const baseUrlInput = document.getElementById('catalog-import-base-url');
      if (baseUrlInput) baseUrlInput.addEventListener('input', () => updateEndpointDiagnostics());
      updateEndpointDiagnostics();
    }

    async function openCatalog() {
        if (importCompletionTriggered) return;
        // Reopening the catalog is in-wizard navigation: reset the browsing
        // state but keep a pending import handback (importedIds) alive so the
        // eventual close still refreshes the provider list.
        index = null;
        filter = '';
        selectedProviderId = '';
        projection = null;
        runtimeDefaults = { contextWindow: 128000, maxTokens: 16384 };
        importPending = false;
        importAdvisory = null;
        importResult = null;
        root.innerHTML = '<div class="empty-state">目录加载中…</div>';
        try {
          index = await options.fetchJson('/api/model-catalog');
        } catch (error) {
          const issue = error && Array.isArray(error.issues) ? error.issues[0] : null;
          if (issue && issue.code === 'catalog_source_unavailable') {
            root.innerHTML = `
              <div class="management-detail-top">
                <div><p class="eyebrow">Provider Search</p><h2>搜索供应商</h2></div>
                <button id="catalog-import-close" class="ghost-button" type="button">返回供应商</button>
              </div>
              <div id="catalog-import-unavailable" class="empty-state">目录快照未就位：vendored 快照尚未提交到仓库，models.dev 目录暂不可用。你仍可以手工添加供应商。</div>`;
            document.getElementById('catalog-import-close').addEventListener('click', () => requestClose());
            return;
          }
          root.innerHTML = '<div class="management-detail-top"><div><p class="eyebrow">Provider Search</p><h2>搜索供应商</h2></div><button id="catalog-import-close" class="ghost-button" type="button">返回供应商</button></div><p id="catalog-import-error" class="management-error" role="alert"></p>';
          document.getElementById('catalog-import-close').addEventListener('click', () => requestClose());
          showError(error, '目录加载失败');
          return;
        }
        render();
    }

    return {
      open: openCatalog,
    };
  };
})();
