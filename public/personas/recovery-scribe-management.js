// @ts-check

(function registerRecoveryScribeManagement() {
  const namespace = window.CaffPersonas || (window.CaffPersonas = {});
  const shared = window.CaffShared || (window.CaffShared = {});
  const utils = namespace.managementUtils;
  if (!shared.modelOptions || !utils) {
    throw new Error('Recovery Scribe management requires model option helpers');
  }
  const THINKING_LABELS = {
    off: '关闭',
    minimal: '最小',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最大',
  };

  namespace.createRecoveryScribeManagement = function createRecoveryScribeManagement(options) {
    const root = options.root;
    let configuration = null;
    let saving = false;

    function selectedModelOption() {
      if (!configuration) return null;
      const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('recovery-scribe-model'));
      return configuration.modelOptions.find((option) => option.key === select?.value
        && option.runtimeResolvable === true) || null;
    }

    function thinkingLevels(option) {
      const levels = Array.isArray(option && option.supportedThinkingLevels)
        ? option.supportedThinkingLevels.filter((level) => Object.hasOwn(THINKING_LABELS, level))
        : [];
      return levels.length ? levels : ['off'];
    }

    function fillThinkingSelect(preferred = '') {
      const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('recovery-scribe-thinking'));
      if (!select) return;
      const levels = thinkingLevels(selectedModelOption());
      select.innerHTML = '';
      levels.forEach((level) => {
        const option = document.createElement('option');
        option.value = level;
        option.textContent = THINKING_LABELS[level] || level;
        select.appendChild(option);
      });
      if (preferred && !levels.includes(preferred)) {
        const stale = document.createElement('option');
        stale.value = preferred;
        stale.textContent = `${THINKING_LABELS[preferred] || preferred}（当前不支持）`;
        stale.disabled = true;
        select.appendChild(stale);
      }
      select.value = preferred || levels[0];
    }

    function sourceLabel() {
      if (!configuration) return '';
      return configuration.source === 'persisted'
        ? `已保存${configuration.updatedAt ? ` · ${new Date(configuration.updatedAt).toLocaleString('zh-CN')}` : ''}`
        : '尚未配置';
    }

    function updateSaveState() {
      const button = /** @type {HTMLButtonElement | null} */ (document.getElementById('save-recovery-scribe-config'));
      const enabled = /** @type {HTMLInputElement | null} */ (document.getElementById('recovery-scribe-enabled'));
      const model = selectedModelOption();
      const thinking = /** @type {HTMLSelectElement | null} */ (document.getElementById('recovery-scribe-thinking'));
      const validSelection = model && thinkingLevels(model).includes(thinking?.value);
      if (button) button.disabled = !options.isEnabled() || saving || Boolean(enabled?.checked && !validSelection);
      const disableUnchanged = !enabled?.checked && !validSelection;
      const timeout = /** @type {HTMLInputElement | null} */ (document.getElementById('recovery-scribe-timeout'));
      if (timeout) {
        timeout.disabled = !options.isEnabled() || saving || disableUnchanged;
        if (disableUnchanged) timeout.value = String(configuration.config.timeoutMs / 1000);
      }
      const disableNote = document.getElementById('recovery-scribe-disable-note');
      if (disableNote) disableNote.classList.toggle('hidden', !disableUnchanged);
    }

    function render() {
      if (!configuration) {
        root.innerHTML = '<div class="empty-state">系统书记配置尚未加载。</div>';
        return;
      }
      const config = configuration.config;
      const locked = !options.isEnabled();
      const hasModels = Array.isArray(configuration.modelOptions) && configuration.modelOptions.length > 0;
      const providerSetup = hasModels
        ? `<div class="provider-source-note"><p><strong>模型来自「模型供应商」中已配置的模型</strong><br />在这里直接选择即可，无需创建角色。</p><button id="manage-providers-from-recovery-scribe" class="ghost-button" type="button">管理模型供应商</button></div>`
        : `<div class="management-warning provider-source-note"><div><strong>${locked ? '当前部署为只读模式' : '还没有可用模型'}</strong><p>${locked ? '你仍可查看模型供应商目录；配置需在本机管理员环境完成。' : '请先到「模型供应商」添加连接并配置可用模型，无需创建角色。'}</p></div><button id="manage-providers-from-recovery-scribe" class="ghost-button" type="button">${locked ? '查看模型供应商' : '去配置模型供应商'}</button></div>`;
      const modelFields = hasModels
        ? `<div class="field-grid recovery-scribe-config-grid">
            <label><span>模型</span><select id="recovery-scribe-model"></select></label>
            <label><span>思考强度</span><select id="recovery-scribe-thinking"></select></label>
            <label><span>整理超时（秒，1–60）</span><input id="recovery-scribe-timeout" type="number" min="1" max="60" step="1" inputmode="numeric" value="${config.timeoutMs / 1000}" /></label>
          </div>
          <p class="management-note">整理超时后仍会生成一份简版机械摘要；摘要与标题使用各自的执行时限。</p>`
        : '';
      root.innerHTML = `
        <div class="management-detail-top">
          <div><p class="eyebrow">Recovery Scribe</p><h2>系统书记</h2><p>Agent 失败或手动停止回复的只读现场报告</p></div>
          <span id="recovery-scribe-config-source" class="status-badge">${sourceLabel()}</span>
        </div>
        <section class="management-card">
          <div class="management-card-title"><div><h3>它会做什么</h3><p>当 Agent 回复失败或被你手动停止后，系统书记会生成一份现场整理报告，汇总已完成的操作、可能已生效但未确认的改动、未完成的部分，方便你和后续 Agent 接手。它不会自动触发，只在你点击消息上的「整理失败现场」或「整理停止现场」按钮时运行一次。</p></div></div>
        </section>
        <section class="management-card">
          <div class="management-card-title"><div><h3>摘要与现场整理使用的模型</h3><p>模型和思考强度同时用于会话摘要、摘要压缩、标题润色和现场整理；保存后从下一次调用生效。</p></div></div>
          ${providerSetup}
          <p id="recovery-scribe-readiness" class="management-note"></p>
          <p class="management-note">每次生成的输出预算来自「模型供应商」中该模型的最大输出 token；未填写时使用 Pi 默认 16384。若模型因长度耗尽、只有思考或没有可见正文，CAFF 最多自动再调用一次并关闭思考，把预算留给正文。429、模型服务错误或超时不会自动重试。</p>
          <label class="system-service-enabled-row"><input id="recovery-scribe-enabled" type="checkbox" ${config.enabled ? 'checked' : ''} /><span>在失败或手动停止的消息上提供现场整理</span></label>
          <p class="management-note">关闭后，相关消息上不再显示「整理失败现场」或「整理停止现场」按钮；会话摘要和标题功能不受影响。</p>
          ${modelFields}
          <p id="recovery-scribe-disable-note" class="management-note hidden">模型配置未通过校验时，关闭仅保存启用状态，保留原模型、思考强度及超时；其他编辑值不会应用。请先修正模型配置，再修改这些设置。</p>
          <p id="recovery-scribe-config-error" class="management-error hidden" role="alert"></p>
        </section>
        <section class="management-card system-service-boundaries">
          <div class="management-card-title"><div><h3>只生成报告</h3><p>不执行命令、不修改文件、不重试任务，原始失败或取消记录保持原样。模型调用失败时仍会生成一份简版机械摘要。</p></div><span class="status-badge">只读</span></div>
        </section>
        <div class="management-actions"><button id="save-recovery-scribe-config" type="button" ${locked || !hasModels ? 'disabled' : ''}>保存并立即生效</button></div>`;

      const readinessNote = document.getElementById('recovery-scribe-readiness');
      readinessNote.textContent = !config.provider || !config.model
        ? '尚未选择摘要与系统书记共用的模型。请从 PI 模型目录选择并保存；目录中存在模型不会自动启用模型摘要、标题精炼或现场整理。'
        : configuration.readiness?.ready === false
          ? `需要配置：${config.provider} / ${config.model} 的本地模型配置未通过校验。请选择可解析模型及思考强度，或关闭现场整理。不会自动切换模型。`
          : '就绪仅表示本地模型配置通过校验，不保证凭据或上游服务可用。';
      document.getElementById('manage-providers-from-recovery-scribe').addEventListener('click', options.onManageProviders);
      document.getElementById('recovery-scribe-enabled').addEventListener('change', updateSaveState);
      if (hasModels) {
        const modelSelect = /** @type {HTMLSelectElement} */ (document.getElementById('recovery-scribe-model'));
        utils.fillModelSelect(
          modelSelect,
          configuration.modelOptions,
          config.provider,
          config.model
        );
        fillThinkingSelect(config.thinking);
        document.getElementById('recovery-scribe-thinking').addEventListener('change', updateSaveState);
        modelSelect.addEventListener('change', () => {
          fillThinkingSelect('');
          updateSaveState();
        });
      }
      document.getElementById('save-recovery-scribe-config').addEventListener('click', () => {
        void save().catch(() => {});
      });
      updateSaveState();
      if (locked) {
        root.querySelectorAll('#recovery-scribe-enabled, #recovery-scribe-model, #recovery-scribe-thinking, #recovery-scribe-timeout, #save-recovery-scribe-config').forEach((control) => {
          control.disabled = true;
        });
      }
    }

    function showError(error, fallback) {
      const target = document.getElementById('recovery-scribe-config-error');
      if (!target) return;
      const issue = error && Array.isArray(error.issues) && error.issues[0];
      const messages = {
        recovery_config_model_unconfigured: '请先选择并保存摘要与系统书记共用的模型',
        recovery_config_model_unavailable: '所选模型无法由当前运行时解析，请检查模型供应商配置',
        recovery_config_catalog_unavailable: '无法读取本地模型目录，请修正模型供应商配置，或关闭现场整理',
        recovery_config_thinking_unsupported: '所选模型不支持该思考强度',
        recovery_config_timeout_invalid: '超时必须是 1 到 60 秒的整数',
      };
      target.textContent = issue && messages[issue.code] || error && error.message || fallback;
      target.classList.remove('hidden');
    }

    async function refresh() {
      if (!options.isEnabled()) {
        configuration = {
          config: { enabled: false, provider: '', model: '', thinking: 'off', timeoutMs: 60_000 },
          source: 'runtime_defaults',
          updatedAt: null,
          modelOptions: [],
        };
        render();
        return;
      }
      configuration = await options.fetchJson('/api/system-services/recovery-scribe');
      render();
    }

    async function save() {
      if (saving || !options.isEnabled()) return;
      const model = selectedModelOption();
      const enabled = /** @type {HTMLInputElement} */ (document.getElementById('recovery-scribe-enabled')).checked;
      const thinkingSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('recovery-scribe-thinking'));
      const validSelection = model && thinkingLevels(model).includes(thinkingSelect?.value);
      const disableUnchanged = !enabled && !validSelection;
      const timeoutInput = /** @type {HTMLInputElement | null} */ (document.getElementById('recovery-scribe-timeout'));
      const thinking = disableUnchanged ? configuration.config.thinking : thinkingSelect?.value;
      const timeoutSeconds = Number(timeoutInput?.value);
      if (!validSelection && !disableUnchanged) {
        showError(null, '请选择当前可用模型及支持的思考强度');
        return;
      }
      if (!disableUnchanged && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60)) {
        showError(null, '超时必须是 1 到 60 秒的整数');
        return;
      }
      const payload = {
        enabled,
        provider: disableUnchanged ? configuration.config.provider : model.provider,
        model: disableUnchanged ? configuration.config.model : model.model,
        thinking,
        timeoutMs: disableUnchanged ? configuration.config.timeoutMs : timeoutSeconds * 1000,
      };
      saving = true;
      updateSaveState();
      try {
        configuration = await options.fetchJson('/api/system-services/recovery-scribe', {
          method: 'PUT',
          headers: { 'X-CAFF-CSRF-Token': options.getCsrfToken() },
          body: payload,
        });
        render();
        options.showToast('摘要与系统书记模型配置已保存并立即生效');
      } catch (error) {
        showError(error, '系统书记配置保存失败');
        throw error;
      } finally {
        saving = false;
        updateSaveState();
      }
    }

    return { refresh, save };
  };
})();
