// @ts-check

(function registerJevConfigManagement() {
  const namespace = window.CaffPersonas || (window.CaffPersonas = {});
  const utils = namespace.managementUtils;
  if (!utils) {
    throw new Error('JEV config management requires management utils');
  }

  const ROUTE = '/api/system-services/turn-time-breakdown-jev';

  // The server is the single source of the gate verdict (contract §6): the
  // UI maps status.reason to copy, it never re-derives the decision.
  const CONCLUSION_TEXT = {
    enabled: '已生效：规则判不了的工具步骤将交给 JEV 分类。',
    api_key_missing: '未生效：API key 未配置。在下方凭据区填写并保存后即时生效，无需重启进程。',
    db_switch_off: '未生效：启用开关处于关闭状态。',
  };
  const SHORT_REASON_TEXT = {
    api_key_missing: 'API key 未配置（在下方凭据区填写）',
    db_switch_off: '启用开关处于关闭状态',
  };

  namespace.createJevConfigManagement = function createJevConfigManagement(options) {
    const root = options.root;
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    let configuration = null;
    let saving = false;
    let clearing = false;
    let clearArmed = false;
    let clearArmedTimer = 0;
    // Staged (not yet saved) "clear the stored key" intent: applied by the
    // same 保存 button as every other field, so a misclick never destroys
    // the credential on its own.
    let clearKeyStaged = false;

    function gateRow(label, ok, okText, offText, note) {
      const dotClass = ok ? 'status-dot default' : 'status-dot warning';
      return `<li class="jev-gate-row"><span class="${dotClass}" aria-hidden="true"></span><span class="jev-gate-label">${utils.escapeHtml(label)}</span><strong>${utils.escapeHtml(ok ? okText : offText)}</strong>${note ? `<small>${utils.escapeHtml(note)}</small>` : ''}</li>`;
    }

    function statusCardHtml(status, enabled) {
      const conclusion = CONCLUSION_TEXT[status.reason] || `未生效：${status.reason}`;
      return `
        <section class="management-card">
          <div class="management-card-title"><div><h3>当前状态</h3><p>生效链只有一处：本页开关（DB）+ 已配置的 API key（DB）。两者满足才生效；分类不再读取任何环境变量。</p></div></div>
          <ul class="jev-gate-list">
            ${gateRow('本页启用开关', enabled, '已开启', '已关闭', '即时生效')}
            ${gateRow('API key', status.apiKeyConfigured, '已配置', '未配置', '值永不显示')}
          </ul>
          <div class="field-grid recovery-scribe-config-grid">
            <label><span>Endpoint</span><input type="text" readonly value="${utils.escapeHtml(status.endpoint || '—')}" /></label>
            <label><span>模型</span><input type="text" readonly value="${utils.escapeHtml(status.model || '—')}" /></label>
          </div>
          <p id="jev-config-conclusion" class="management-note" data-reason="${utils.escapeHtml(status.reason)}"><strong>结论：</strong>${utils.escapeHtml(conclusion)}</p>
        </section>`;
    }

    function toggleCardHtml(config, status) {
      let note;
      if (!config.enabled) {
        note = '开启后即时生效（作用于后续轮次，无需重启进程）；进行中的一轮保持进入时的判定。';
      } else if (status.effective) {
        note = '已开启且生效中；关闭后新步骤立即不再走 JEV。';
      } else {
        note = `已开启，但当前不生效：${SHORT_REASON_TEXT[status.reason] || status.reason}。`;
      }
      return `
        <section class="management-card">
          <div class="management-card-title"><div><h3>启用开关</h3><p>存于本机数据库，保存即生效。JEV 的全部配置都在本页，没有任何藏在环境变量里的第二份开关。</p></div></div>
          <label class="system-service-enabled-row"><input id="jev-config-enabled" type="checkbox" ${config.enabled ? 'checked' : ''} /><span>规则判不了的步骤交给 JEV 分类兜底</span></label>
          <p id="jev-config-toggle-note" class="management-note">${utils.escapeHtml(note)}</p>
        </section>`;
    }

    function credentialCardHtml(config, locked) {
      const configured = config.apiKeyConfigured === true;
      return `
        <section class="management-card">
          <div class="management-card-title"><div><h3>API key 凭据</h3><p>明文存于本机数据库（与 .env.local 同盘同级），任何响应、错误与日志永不回显其值。</p></div></div>
          <label><span>${configured ? 'API key（已保存，值不显示）' : 'API key'}</span><input id="jev-api-key-input" type="password" autocomplete="off" ${locked ? 'disabled' : ''} placeholder="${configured ? '输入新 key 可替换；留空保持不变' : '输入 API key，保存后即时生效'}" value="" /></label>
          <div class="management-actions">
            <button id="clear-jev-key" class="ghost-button" type="button" ${locked || !configured ? 'disabled' : ''}>${clearKeyStaged ? '将在保存后清除（点击撤销）' : '清除已保存的 key'}</button>
          </div>
          <p class="management-note">此前通过环境变量 TYPESAFE_API_KEY 配置的 key <strong>不会</strong>自动迁移：分类管线已不再读取环境变量，请在此重新填写。</p>
        </section>`;
    }

    function advancedCardHtml(status, locked) {
      return `
        <details class="management-card jev-advanced-card">
          <summary><strong>高级：Endpoint 与模型</strong>（留空恢复默认；更换后自动清空分类缓存）</summary>
          <div class="field-grid recovery-scribe-config-grid">
            <label><span>Endpoint</span><input id="jev-endpoint-input" type="text" ${locked ? 'disabled' : ''} value="${utils.escapeHtml(status.endpoint || '')}" /></label>
            <label><span>模型</span><input id="jev-model-input" type="text" ${locked ? 'disabled' : ''} value="${utils.escapeHtml(status.model || '')}" /></label>
          </div>
        </details>`;
    }

    function cacheCardHtml(cache, locked) {
      const entries = cache && Number.isFinite(cache.entries) ? cache.entries : 0;
      return `
        <section class="management-card">
          <div class="management-card-title"><div><h3>分类缓存</h3><p>按命令特征缓存的 JEV 分类结果。清空后后续相同命令需要重新询问 JEV；已落库步骤的分类结果不受影响。</p></div></div>
          <p class="management-note">当前缓存 <strong id="jev-cache-count">${entries}</strong> 条。</p>
          <div class="management-actions"><button id="clear-jev-cache" class="ghost-button" type="button" ${locked || entries === 0 ? 'disabled' : ''}>清空分类缓存</button></div>
        </section>`;
    }

    function render() {
      const locked = !options.isEnabled();

      // Any re-render (refresh, save) replaces the clear button node, so a
      // previously armed two-step confirm must not survive into the new DOM
      // — otherwise a single click after a refresh would execute the
      // destructive DELETE while the button looks disarmed.
      clearArmed = false;
      if (clearArmedTimer) {
        clearTimeout(clearArmedTimer);
        clearArmedTimer = 0;
      }

      if (!configuration) {
        root.innerHTML = locked
          ? '<div class="empty-state">当前部署为只读模式，无法读取耗时分析分类（JEV）状态。</div>'
          : '<div class="empty-state">耗时分析分类（JEV）配置尚未加载。</div>';
        onStatus(null);
        return;
      }

      const config = configuration.config || { enabled: false, apiKeyConfigured: false };
      const status = configuration.status || {
        effective: false,
        reason: 'db_switch_off',
        apiKeyConfigured: false,
        endpoint: '',
        model: '',
      };

      root.innerHTML = `
        <div class="management-detail-top">
          <div><p class="eyebrow">Turn Time Breakdown</p><h2>耗时分析分类（JEV）</h2><p>「耗时分析」中规则判不了的工具步骤（如自写脚本里实际在跑测试）交给 JEV 模型结合命令输出兜底分类。</p></div>
          <span id="jev-config-effective" class="status-badge ${status.effective ? '' : 'neutral'}">${status.effective ? '生效中' : '未生效'}</span>
        </div>
        ${statusCardHtml(status, config.enabled === true)}
        ${toggleCardHtml(config, status)}
        ${credentialCardHtml(config, locked)}
        ${advancedCardHtml(status, locked)}
        ${cacheCardHtml(configuration.cache, locked)}
        <p id="jev-config-error" class="management-error hidden" role="alert"></p>
        <div class="management-actions"><button id="save-jev-config" type="button" ${locked ? 'disabled' : ''}>保存并立即生效</button></div>`;

      const enabledInput = /** @type {HTMLInputElement} */ (document.getElementById('jev-config-enabled'));
      const keyInput = /** @type {HTMLInputElement} */ (document.getElementById('jev-api-key-input'));
      const clearKeyButton = /** @type {HTMLButtonElement} */ (document.getElementById('clear-jev-key'));
      const endpointInput = /** @type {HTMLInputElement} */ (document.getElementById('jev-endpoint-input'));
      const modelInput = /** @type {HTMLInputElement} */ (document.getElementById('jev-model-input'));
      const saveButton = /** @type {HTMLButtonElement} */ (document.getElementById('save-jev-config'));
      const clearButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('clear-jev-cache'));

      enabledInput.addEventListener('change', updateSaveState);
      endpointInput.addEventListener('input', updateSaveState);
      modelInput.addEventListener('input', updateSaveState);
      keyInput.addEventListener('input', () => {
        // Typing a replacement key and staging a clear contradict each
        // other; the newest gesture wins instead of producing a 422.
        // Unstage in place — a full render here would wipe the typed char.
        if (keyInput.value && clearKeyStaged) {
          clearKeyStaged = false;
          clearKeyButton.textContent = '清除已保存的 key';
        }
        updateSaveState();
      });
      clearKeyButton.addEventListener('click', () => {
        clearKeyStaged = !clearKeyStaged;
        clearKeyButton.textContent = clearKeyStaged ? '将在保存后清除（点击撤销）' : '清除已保存的 key';
        updateSaveState();
      });
      saveButton.addEventListener('click', () => {
        void save().catch(() => {});
      });
      if (clearButton) {
        clearButton.addEventListener('click', () => {
          void clearCache().catch(() => {});
        });
      }
      if (locked) {
        enabledInput.disabled = true;
        saveButton.disabled = true;
      }
      updateSaveState();
      onStatus(status);
    }

    function stagedChanges() {
      const enabled = /** @type {HTMLInputElement | null} */ (document.getElementById('jev-config-enabled'));
      const keyInput = /** @type {HTMLInputElement | null} */ (document.getElementById('jev-api-key-input'));
      const endpointInput = /** @type {HTMLInputElement | null} */ (document.getElementById('jev-endpoint-input'));
      const modelInput = /** @type {HTMLInputElement | null} */ (document.getElementById('jev-model-input'));
      if (!enabled || !keyInput || !endpointInput || !modelInput || !configuration) return null;
      const status = configuration.status || {};
      const config = configuration.config || {};
      const body = { enabled: enabled.checked };
      let changed = enabled.checked !== (config.enabled === true);
      const typedKey = keyInput.value.trim();
      if (typedKey) {
        body.apiKey = typedKey;
        changed = true;
      }
      if (clearKeyStaged) {
        body.clearApiKey = true;
        changed = true;
      }
      if (endpointInput.value.trim() !== String(status.endpoint || '').trim()) {
        body.baseUrl = endpointInput.value.trim();
        changed = true;
      }
      if (modelInput.value.trim() !== String(status.model || '').trim()) {
        body.model = modelInput.value.trim();
        changed = true;
      }
      return { body, changed };
    }

    function updateSaveState() {
      const button = /** @type {HTMLButtonElement | null} */ (document.getElementById('save-jev-config'));
      if (!button || !configuration) return;
      const staged = stagedChanges();
      button.disabled = !options.isEnabled() || saving || !staged || !staged.changed;
    }

    function disarmClear() {
      clearArmed = false;
      if (clearArmedTimer) {
        clearTimeout(clearArmedTimer);
        clearArmedTimer = 0;
      }
      const clearButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('clear-jev-cache'));
      if (clearButton && configuration) {
        clearButton.textContent = '清空分类缓存';
      }
    }

    function showError(error, fallback) {
      const target = document.getElementById('jev-config-error');
      if (!target) return;
      const issue = error && Array.isArray(error.issues) && error.issues[0];
      const messages = {
        credential_field_not_accepted: '凭据只接受 apiKey 字段（写库存储、永不回显）',
        invalid_enabled_value: '启用状态非法',
        invalid_api_key: 'API key 非法：需为非空字符串（≤512 字符）',
        invalid_clear_flag: '清除标记非法',
        credential_conflict: '不能在同一次保存中同时设置与清除 API key',
        invalid_base_url: 'Endpoint 必须是 http(s) URL（留空恢复默认）',
        invalid_model: '模型名非法（留空恢复默认）',
      };
      target.textContent = issue && messages[issue.code] || error && error.message || fallback;
      target.classList.remove('hidden');
    }

    async function refresh() {
      if (!options.isEnabled()) {
        configuration = null;
        render();
        return;
      }
      configuration = await options.fetchJson(ROUTE);
      clearKeyStaged = false;
      render();
    }

    async function save() {
      if (saving || !options.isEnabled() || !configuration) return;
      const staged = stagedChanges();
      if (!staged || !staged.changed) return;
      saving = true;
      updateSaveState();
      try {
        configuration = await options.fetchJson(ROUTE, {
          method: 'PUT',
          headers: { 'X-CAFF-CSRF-Token': options.getCsrfToken() },
          body: staged.body,
        });
        clearKeyStaged = false;
        const savedKey = Boolean(staged.body.apiKey);
        const clearedKey = staged.body.clearApiKey === true;
        render();
        const status = configuration.status || {};
        if (clearedKey) {
          options.showToast('已保存：API key 已清除，新步骤立即不再走 JEV');
        } else if (savedKey && status.effective) {
          options.showToast('已保存：API key 已更新并即时生效');
        } else if (staged.body.enabled && !status.effective) {
          options.showToast(`已保存，但当前不生效：${SHORT_REASON_TEXT[status.reason] || '缺少生效条件'}`);
        } else {
          options.showToast(staged.body.enabled ? 'JEV 分类兜底已开启并即时生效' : '配置已保存；新步骤立即不再走 JEV');
        }
      } catch (error) {
        showError(error, 'JEV 配置保存失败');
        throw error;
      } finally {
        saving = false;
        updateSaveState();
      }
    }

    async function clearCache() {
      if (clearing || !options.isEnabled() || !configuration) return;
      const clearButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('clear-jev-cache'));
      if (!clearButton) return;

      // Two-step inline confirm: first click arms the button, second click
      // within 5s executes. Avoids window.confirm (untestable in JSDOM).
      if (!clearArmed) {
        clearArmed = true;
        clearButton.textContent = '确认清空？再次点击确认';
        clearArmedTimer = setTimeout(disarmClear, 5000);
        return;
      }

      clearing = true;
      clearArmed = false;
      if (clearArmedTimer) {
        clearTimeout(clearArmedTimer);
        clearArmedTimer = 0;
      }
      clearButton.disabled = true;
      try {
        const result = await options.fetchJson(`${ROUTE}/cache`, {
          method: 'DELETE',
          headers: { 'X-CAFF-CSRF-Token': options.getCsrfToken() },
          // local-admin guard requires a JSON content-type on every
          // mutation; fetchJson only adds it when a body is present.
          body: {},
        });
        const cleared = result && Number.isFinite(result.cleared) ? result.cleared : 0;
        options.showToast(`已清空 ${cleared} 条分类缓存；已落库步骤的分类结果不受影响`);
        await refresh();
      } catch (error) {
        showError(error, '清空分类缓存失败');
        // The request already consumed the armed state; reset the label too,
        // otherwise the button reads "确认清空？" while a click would only
        // re-arm (honest behavior, lying label).
        disarmClear();
        clearButton.disabled = false;
        throw error;
      } finally {
        clearing = false;
      }
    }

    return { refresh, save, clearCache };
  };
})();
