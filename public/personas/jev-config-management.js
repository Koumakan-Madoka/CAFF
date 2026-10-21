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
    master_switch_off: '未生效：进程级总闸门 TYPESAFE_ENABLED 未开启。修改环境变量后需重启进程。',
    api_key_missing: '未生效：TYPESAFE_API_KEY 未配置。凭据仅来自环境变量，本页不能填写；配置后需重启进程。',
    db_switch_off: '未生效：下方启用开关处于关闭状态。',
  };
  const SHORT_REASON_TEXT = {
    master_switch_off: '总闸门 TYPESAFE_ENABLED 未开启（改 env 需重启）',
    api_key_missing: 'TYPESAFE_API_KEY 未配置（改 env 需重启）',
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

    function gateRow(label, ok, okText, offText, note) {
      const dotClass = ok ? 'status-dot default' : 'status-dot warning';
      return `<li class="jev-gate-row"><span class="${dotClass}" aria-hidden="true"></span><span class="jev-gate-label">${utils.escapeHtml(label)}</span><strong>${utils.escapeHtml(ok ? okText : offText)}</strong>${note ? `<small>${utils.escapeHtml(note)}</small>` : ''}</li>`;
    }

    function statusCardHtml(status, enabled) {
      const conclusion = CONCLUSION_TEXT[status.reason] || `未生效：${status.reason}`;
      return `
        <section class="management-card">
          <div class="management-card-title"><div><h3>当前状态</h3><p>生效链：TYPESAFE_ENABLED（env）→ API key（env）→ 本页开关（DB）。三者全部满足才生效。</p></div></div>
          <ul class="jev-gate-list">
            ${gateRow('进程级总闸门 TYPESAFE_ENABLED', status.masterSwitchEnabled, '已开启', '未开启', '改 env 需重启')}
            ${gateRow('API key（TYPESAFE_API_KEY）', status.apiKeyConfigured, '已配置', '未配置', '值永不显示')}
            ${gateRow('本页启用开关', enabled, '已开启', '已关闭', '即时生效')}
          </ul>
          <div class="field-grid recovery-scribe-config-grid">
            <label><span>Endpoint</span><input type="text" readonly value="${utils.escapeHtml(status.endpoint || '—')}" /></label>
            <label><span>模型</span><input type="text" readonly value="${utils.escapeHtml(status.model || '—')}" /></label>
          </div>
          <p id="jev-config-conclusion" class="management-note" data-reason="${utils.escapeHtml(status.reason)}"><strong>结论：</strong>${utils.escapeHtml(conclusion)}</p>
        </section>`;
    }

    function toggleCardHtml(config, status, locked) {
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
          <div class="management-card-title"><div><h3>启用开关</h3><p>存于本机数据库，保存即生效；env 两项（总闸门与 key）修改后需重启进程才会变化。</p></div></div>
          <label class="system-service-enabled-row"><input id="jev-config-enabled" type="checkbox" ${config.enabled ? 'checked' : ''} /><span>规则判不了的步骤交给 JEV 分类兜底</span></label>
          <p id="jev-config-toggle-note" class="management-note">${utils.escapeHtml(note)}</p>
          <p class="management-note">API key 永不写入本页、永不落库、永不在任何响应中显示；要配置或更换 key，请编辑环境变量后重启进程。</p>
          <p id="jev-config-error" class="management-error hidden" role="alert"></p>
          <div class="management-actions"><button id="save-jev-config" type="button" ${locked ? 'disabled' : ''}>保存并立即生效</button></div>
        </section>`;
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

      const config = configuration.config || { enabled: false };
      const status = configuration.status || {
        effective: false,
        reason: 'db_switch_off',
        masterSwitchEnabled: false,
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
        ${toggleCardHtml(config, status, locked)}
        ${cacheCardHtml(configuration.cache, locked)}`;

      const enabledInput = /** @type {HTMLInputElement} */ (document.getElementById('jev-config-enabled'));
      const saveButton = /** @type {HTMLButtonElement} */ (document.getElementById('save-jev-config'));
      const clearButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('clear-jev-cache'));

      enabledInput.addEventListener('change', updateSaveState);
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

    function updateSaveState() {
      const button = /** @type {HTMLButtonElement | null} */ (document.getElementById('save-jev-config'));
      const enabled = /** @type {HTMLInputElement | null} */ (document.getElementById('jev-config-enabled'));
      if (!button || !enabled || !configuration) return;
      const unchanged = enabled.checked === (configuration.config && configuration.config.enabled === true);
      button.disabled = !options.isEnabled() || saving || unchanged;
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
        credential_field_not_accepted: '该接口不接受凭据字段：API key 仅来自环境变量',
        invalid_enabled_value: '启用状态非法',
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
      render();
    }

    async function save() {
      if (saving || !options.isEnabled() || !configuration) return;
      const enabled = /** @type {HTMLInputElement} */ (document.getElementById('jev-config-enabled')).checked;
      saving = true;
      updateSaveState();
      try {
        configuration = await options.fetchJson(ROUTE, {
          method: 'PUT',
          headers: { 'X-CAFF-CSRF-Token': options.getCsrfToken() },
          body: { enabled },
        });
        render();
        const status = configuration.status || {};
        if (enabled && !status.effective) {
          options.showToast(`已开启，但当前不生效：${SHORT_REASON_TEXT[status.reason] || '缺少生效条件'}`);
        } else {
          options.showToast(enabled ? 'JEV 分类兜底已开启并即时生效' : 'JEV 分类兜底已关闭，新步骤立即不再走 JEV');
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
        clearButton.disabled = false;
        throw error;
      } finally {
        clearing = false;
      }
    }

    return { refresh, save, clearCache };
  };
})();
