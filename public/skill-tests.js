// @ts-check

(function initSkillTests() {
  const shared = window.CaffShared || {};
  const fetchJson = shared.fetchJson;
  const modelOptionUtils = shared.modelOptions || {};
  const toastEl = document.getElementById('toast');
  const toast =
    typeof shared.createToastController === 'function' ? shared.createToastController(toastEl) : { show() {} };

  function showToast(message) {
    toast.show(message);
  }

  const dom = {
    tabButtons: /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tab-button[data-tab]')),
    tabPanels: /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tab-panel')),
    // Skill Tests tab
    skillSelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-skill-select')),
    refreshSkillsButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-refresh-skills')),
    agentSelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-agent-select')),
    modelSelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-model-select')),
    promptVersionInput: /** @type {HTMLInputElement | null} */ (document.getElementById('st-prompt-version')),
    generateButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-generate-btn')),
    generateCount: /** @type {HTMLInputElement | null} */ (document.getElementById('st-generate-count')),
    generateLoadingMode: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-generate-loading-mode')),
    generateTestType: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-generate-type')),
    runAllButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-run-all-btn')),
    openCreateButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-open-create-btn')),
    selectedHighlights: /** @type {HTMLElement | null} */ (document.getElementById('st-selected-highlights')),
    selectedSummary: /** @type {HTMLElement | null} */ (document.getElementById('st-selected-summary')),
    caseList: /** @type {HTMLDivElement | null} */ (document.getElementById('st-case-list')),
    caseCount: /** @type {HTMLElement | null} */ (document.getElementById('st-case-count')),
    filterCount: /** @type {HTMLElement | null} */ (document.getElementById('st-filter-count')),
    searchInput: /** @type {HTMLInputElement | null} */ (document.getElementById('st-search-input')),
    validityFilter: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-validity-filter')),
    // Detail panel
    detailEmpty: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-empty')),
    detailPanel: /** @type {HTMLElement | null} */ (document.getElementById('st-detail')),
    detailCaseId: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-case-id')),
    detailMeta: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-meta')),
    detailLastOutcome: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-last-outcome')),
    detailPrompt: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-prompt')),
    detailNote: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-note')),
    detailExpectedBehavior: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-expected-behavior')),
    detailExpectedTools: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-expected-tools')),
    detailValidity: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-validity')),
    detailValidityHelp: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-validity-help')),
    detailRunButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-run-btn')),
    detailDownloadButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-download-btn')),
    detailDeleteButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-delete-btn')),
    detailRegression: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-regression')),
    detailRuns: /** @type {HTMLDivElement | null} */ (document.getElementById('st-detail-runs')),
    detailTabButtons: /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-st-detail-tab]')),
    detailTabPanels: /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-st-detail-panel]')),
    // Summary
    summaryBody: /** @type {HTMLElement | null} */ (document.getElementById('st-summary-body')),
    summaryHighlights: /** @type {HTMLElement | null} */ (document.getElementById('st-summary-highlights')),
    refreshSummaryButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-refresh-summary')),
    // Manual create
    createSection: /** @type {HTMLElement | null} */ (document.getElementById('st-create-section')),
    createForm: /** @type {HTMLFormElement | null} */ (document.getElementById('st-create-form')),
    createPrompt: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-prompt')),
    createTestType: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-create-type')),
    createLoadingMode: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-create-loading-mode')),
    createTools: /** @type {HTMLInputElement | null} */ (document.getElementById('st-create-tools')),
    createToolSpecs: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-tool-specs')),
    createBehavior: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-behavior')),
    createNote: /** @type {HTMLInputElement | null} */ (document.getElementById('st-create-note')),
    createSubmitButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-create-submit')),
  };

  const state = {
    skills: [],
    agents: [],
    modelOptions: [],
    selectedSkillId: '',
    testCases: [],
    selectedCaseId: '',
    summary: [],
    loading: false,
    searchQuery: '',
    validityFilter: 'all',
    activeDetailTab: 'overview',
  };

  // ---- Tab switching ----
  function switchTab(tabId) {
    dom.tabButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    dom.tabPanels.forEach((panel) => {
      panel.classList.toggle('hidden', panel.id !== tabId);
    });
    if (tabId === 'panel-skill-tests') {
      loadBootstrapOptions();
      loadSkills();
      loadSummary();
    }
  }

  dom.tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab || '';
      switchTab(tabId);
    });
  });

  function switchDetailTab(tabName) {
    const nextTab = tabName || 'overview';
    state.activeDetailTab = nextTab;
    dom.detailTabButtons.forEach((btn) => {
      const active = btn.dataset.stDetailTab === nextTab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
    });
    dom.detailTabPanels.forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.stDetailPanel !== nextTab);
    });
  }

  function focusCreateSection() {
    if (dom.createSection) {
      dom.createSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (dom.createPrompt) {
      window.setTimeout(() => {
        dom.createPrompt.focus();
      }, 120);
    }
  }

  function openCreateFlow() {
    if (!state.selectedSkillId) {
      showToast('先从顶部选择一个 Skill，再手动创建用例');
      if (dom.skillSelect) {
        dom.skillSelect.focus();
      }
      return;
    }
    focusCreateSection();
  }

  function selectCase(caseId, options = {}) {
    if (!caseId) return;
    state.selectedCaseId = caseId;
    if (options.detailTab) {
      switchDetailTab(options.detailTab);
    }
    renderCaseList();
    syncDetailPanel();
    if (options.scrollIntoView && dom.detailPanel && !dom.detailPanel.classList.contains('hidden')) {
      dom.detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  dom.detailTabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      switchDetailTab(btn.dataset.stDetailTab || 'overview');
    });
  });
  switchDetailTab(state.activeDetailTab);

  if (dom.openCreateButton) {
    dom.openCreateButton.addEventListener('click', openCreateFlow);
  }

  // ---- Agent & Model selectors ----
  async function loadBootstrapOptions() {
    try {
      const data = await fetchJson('/api/bootstrap');
      state.agents = Array.isArray(data.agents) ? data.agents : [];
      state.modelOptions = Array.isArray(data.modelOptions) ? data.modelOptions : [];
      renderAgentSelect();
      renderModelSelect();
    } catch {
      // non-critical
    }
  }

  // ---- localStorage persistence for Agent/Model ----
  const LS_KEY_AGENT = 'caff_skill_test_agent';
  const LS_KEY_MODEL = 'caff_skill_test_model';
  const LS_KEY_SKILL = 'caff_skill_test_skill';
  const LS_KEY_PROMPT_VERSION = 'caff_skill_test_prompt_version';

  function persistSelections() {
    try {
      if (dom.agentSelect) localStorage.setItem(LS_KEY_AGENT, dom.agentSelect.value);
      if (dom.modelSelect) localStorage.setItem(LS_KEY_MODEL, dom.modelSelect.value);
      if (dom.skillSelect) localStorage.setItem(LS_KEY_SKILL, dom.skillSelect.value);
      if (dom.promptVersionInput) localStorage.setItem(LS_KEY_PROMPT_VERSION, dom.promptVersionInput.value);
    } catch { /* ignore */ }
  }

  function restoreSelections() {
    try {
      const savedAgent = localStorage.getItem(LS_KEY_AGENT);
      const savedModel = localStorage.getItem(LS_KEY_MODEL);
      const savedPromptVersion = localStorage.getItem(LS_KEY_PROMPT_VERSION);
      if (savedAgent != null && dom.agentSelect) dom.agentSelect.value = savedAgent;
      if (savedModel != null && dom.modelSelect) dom.modelSelect.value = savedModel;
      if (savedPromptVersion != null && dom.promptVersionInput) dom.promptVersionInput.value = savedPromptVersion;
    } catch { /* ignore */ }
  }

  function restoreSelectedSkill() {
    if (!dom.skillSelect) return false;
    try {
      const savedSkill = localStorage.getItem(LS_KEY_SKILL);
      if (savedSkill && state.skills.some((skill) => skill.id === savedSkill)) {
        dom.skillSelect.value = savedSkill;
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  function renderAgentSelect() {
    if (!dom.agentSelect) return;
    const current = dom.agentSelect.value;
    dom.agentSelect.innerHTML = '<option value="">— 默认 —</option>';
    for (const agent of state.agents) {
      const opt = document.createElement('option');
      opt.value = agent.id || '';
      opt.textContent = agent.name || agent.id || '';
      dom.agentSelect.appendChild(opt);
    }
    if (current) dom.agentSelect.value = current;
    restoreSelections();
  }

  function renderModelSelect() {
    if (!dom.modelSelect) return;
    const current = dom.modelSelect.value;
    dom.modelSelect.innerHTML = '<option value="">系统默认模型</option>';
    const options = Array.isArray(state.modelOptions) ? state.modelOptions : [];
    for (const option of options) {
      if (!option || !option.key) continue;
      const opt = document.createElement('option');
      opt.value = option.key;
      opt.textContent = modelOptionUtils && typeof modelOptionUtils.buildModelOptionLabel === 'function'
        ? modelOptionUtils.buildModelOptionLabel(option)
        : (option.label || `${option.provider || ''} / ${option.model || ''}`);
      dom.modelSelect.appendChild(opt);
    }
    if (current) dom.modelSelect.value = current;
    restoreSelections();
  }

  // Persist on change
  if (dom.agentSelect) dom.agentSelect.addEventListener('change', persistSelections);
  if (dom.modelSelect) dom.modelSelect.addEventListener('change', persistSelections);
  if (dom.promptVersionInput) dom.promptVersionInput.addEventListener('change', persistSelections);

  function getRunOptions() {
    const agentId = dom.agentSelect ? dom.agentSelect.value.trim() : '';
    const modelKey = dom.modelSelect ? dom.modelSelect.value.trim() : '';
    let provider = '';
    let model = '';

    const selectedModelOption =
      modelOptionUtils && typeof modelOptionUtils.selectedModelOption === 'function'
        ? modelOptionUtils.selectedModelOption(dom.modelSelect, state.modelOptions)
        : null;

    if (selectedModelOption) {
      provider = String(selectedModelOption.provider || '').trim();
      model = String(selectedModelOption.model || '').trim();
    } else if (modelKey) {
      const parts = modelKey.split('\u001f');
      provider = (parts[0] || '').trim();
      model = (parts[1] || '').trim();
    }

    const opts = {};
    if (provider) opts.provider = provider;
    if (model) opts.model = model;
    if (agentId) opts.agentId = agentId;
    const promptVersion = dom.promptVersionInput ? dom.promptVersionInput.value.trim() : '';
    if (promptVersion) opts.promptVersion = promptVersion;
    if (agentId && Array.isArray(state.agents)) {
      const found = state.agents.find((agent) => agent && agent.id === agentId);
      if (found && found.name) opts.agentName = found.name;
    }
    return opts;
  }

  // ---- Skills ----
  async function loadSkills() {
    try {
      const data = await fetchJson('/api/skills');
      state.skills = Array.isArray(data.skills) ? data.skills : [];
      renderSkillSelect();
    } catch (err) {
      showToast('Failed to load skills: ' + (err.message || err));
    }
  }

  function renderSkillSelect() {
    if (!dom.skillSelect) return;
    const current = dom.skillSelect.value;
    dom.skillSelect.innerHTML = '<option value="">— 选择 Skill —</option>';
    for (const skill of state.skills) {
      const opt = document.createElement('option');
      opt.value = skill.id;
      opt.textContent = skill.name || skill.id;
      dom.skillSelect.appendChild(opt);
    }
    const restored = restoreSelectedSkill();
    if (!restored && current && state.skills.some((s) => s.id === current)) {
      dom.skillSelect.value = current;
    }
    state.selectedSkillId = dom.skillSelect.value;
    persistSelections();
    renderSelectedSkillOverview();
    if (state.selectedSkillId) {
      loadTestCases();
    }
  }

  if (dom.skillSelect) {
    dom.skillSelect.addEventListener('change', () => {
      state.selectedSkillId = dom.skillSelect.value;
      persistSelections();
      loadTestCases();
    });
  }

  if (dom.searchInput) {
    dom.searchInput.addEventListener('input', () => {
      state.searchQuery = dom.searchInput.value.trim().toLowerCase();
      renderSelectedSkillOverview();
      renderCaseList();
    });
  }

  if (dom.validityFilter) {
    dom.validityFilter.addEventListener('change', () => {
      state.validityFilter = dom.validityFilter.value || 'all';
      renderSelectedSkillOverview();
      renderCaseList();
    });
  }

  if (dom.refreshSkillsButton) {
    dom.refreshSkillsButton.addEventListener('click', loadSkills);
  }

  if (dom.caseList) {
    dom.caseList.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const actionButton = target.closest('[data-st-case-action]');
      if (!actionButton) return;
      const action = actionButton.getAttribute('data-st-case-action') || '';
      if (action === 'generate' && dom.generateButton) {
        dom.generateButton.click();
        return;
      }
      if (action === 'open-create') {
        openCreateFlow();
        return;
      }
      if (action === 'clear-filters') {
        state.searchQuery = '';
        state.validityFilter = 'all';
        if (dom.searchInput) dom.searchInput.value = '';
        if (dom.validityFilter) dom.validityFilter.value = 'all';
        renderSelectedSkillOverview();
        renderCaseList();
      }
    });
  }

  // ---- Test Cases ----
  async function loadTestCases() {
    if (!state.selectedSkillId) {
      state.testCases = [];
      state.selectedCaseId = '';
      renderSelectedSkillOverview();
      renderCaseList();
      hideDetail();
      return;
    }
    try {
      const data = await fetchJson(`/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases`);
      state.testCases = Array.isArray(data.cases) ? data.cases : [];
      if (state.selectedCaseId && !state.testCases.some((tc) => tc.id === state.selectedCaseId)) {
        state.selectedCaseId = '';
      }
      renderSelectedSkillOverview();
      renderCaseList();
      syncDetailPanel();
    } catch (err) {
      showToast('Failed to load test cases: ' + (err.message || err));
    }
  }

  async function runTestCase(caseId, options = {}) {
    if (!state.selectedSkillId || !caseId) {
      showToast('请先选择一个 Skill 和测试用例');
      return false;
    }

    const button = options.button || null;
    const idleLabel = options.idleLabel || (button ? button.textContent : '运行');
    const busyLabel = options.busyLabel || '运行中...';

    state.selectedCaseId = caseId;
    if (options.detailTab) {
      switchDetailTab(options.detailTab);
    }
    renderCaseList();
    syncDetailPanel();

    if (button) {
      button.disabled = true;
      button.textContent = busyLabel;
    }

    try {
      await fetchJson(
        `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/${encodeURIComponent(caseId)}/run`,
        { method: 'POST', body: getRunOptions() }
      );
      showToast('测试运行完成');
      await Promise.all([loadTestCases(), loadSummary()]);
      if (options.scrollIntoView && dom.detailPanel && !dom.detailPanel.classList.contains('hidden')) {
        dom.detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return true;
    } catch (err) {
      showToast('运行失败: ' + (err.message || err));
      return false;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = idleLabel;
      }
    }
  }

  function renderSelectedSkillOverview() {
    if (!dom.selectedHighlights || !dom.selectedSummary) return;
    if (!state.selectedSkillId) {
      dom.selectedHighlights.innerHTML = '<span class="tag tag-pending">先选一个 Skill</span>';
      dom.selectedSummary.textContent = '这里会显示当前 Skill 的用例数量、可重试范围和最近表现。';
      return;
    }

    const totalCases = state.testCases.length;
    const validated = state.testCases.filter((tc) => tc.validityStatus === 'validated').length;
    const invalid = state.testCases.filter((tc) => tc.validityStatus === 'invalid').length;
    const pending = Math.max(0, totalCases - validated - invalid);
    const recentFailing = state.testCases.filter((tc) => {
      const run = tc.latestRun || null;
      return isFailingRun(run);
    }).length;
    const runnable = validated + invalid;
    const selectedSummary = state.summary.find((entry) => entry.skillId === state.selectedSkillId) || null;
    const triggerRate = selectedSummary && selectedSummary.triggerRate != null
      ? `${Math.round(selectedSummary.triggerRate * 100)}%`
      : '—';
    const executionRate = selectedSummary && selectedSummary.executionRate != null
      ? `${Math.round(selectedSummary.executionRate * 100)}%`
      : '—';

    dom.selectedHighlights.innerHTML = `
      <span class="tag">共 ${totalCases} 条</span>
      <span class="tag tag-success">可运行 ${validated}</span>
      <span class="tag tag-error">触发失败 ${invalid}</span>
      <span class="tag tag-pending">待验证 ${pending}</span>
      <span class="tag">可批量重跑 ${runnable}</span>
      <span class="tag">最近失败 ${recentFailing}</span>
    `;

    const filterHint = state.searchQuery || state.validityFilter !== 'all'
      ? `当前筛选后显示 ${getFilteredCases().length} 条；`
      : '';
    dom.selectedSummary.textContent = `${filterHint}当前 Skill 的触发成功率 ${triggerRate}，执行成功率 ${executionRate}。`;
  }

  function getFilteredCases() {
    return state.testCases.filter((tc) => {
      const matchesQuery = !state.searchQuery || [
        tc.id,
        tc.triggerPrompt,
        tc.note,
        tc.expectedBehavior,
        getExpectedToolsSearchText(tc.expectedTools),
        tc.testType,
        tc.loadingMode,
      ].some((value) => String(value || '').toLowerCase().includes(state.searchQuery));

      const latestRun = tc.latestRun || null;
      const matchesValidity = state.validityFilter === 'all'
        || tc.validityStatus === state.validityFilter
        || (state.validityFilter === 'failing' && isFailingRun(latestRun));

      return matchesQuery && matchesValidity;
    });
  }

  function renderCaseList() {
    if (!dom.caseList || !dom.caseCount) return;
    dom.caseCount.textContent = `${state.testCases.length} 个用例`;

    const filteredCases = getFilteredCases();

    if (dom.filterCount) {
      dom.filterCount.textContent = `显示 ${filteredCases.length} / ${state.testCases.length}`;
    }

    if (filteredCases.length === 0) {
      if (!state.selectedSkillId) {
        dom.caseList.innerHTML = `
          <div class="empty-state compact-empty-state">
            <p class="section-hint">先从顶部选一个 Skill，再来看它的测试用例。</p>
          </div>
        `;
        return;
      }

      const hasCases = state.testCases.length > 0;
      dom.caseList.innerHTML = hasCases
        ? `
          <div class="empty-state compact-empty-state">
            <p class="section-hint">没有符合当前筛选的用例，试试清空搜索或切回“全部状态”。</p>
            <div class="panel-actions skill-test-empty-actions">
              <button class="ghost-button" type="button" data-st-case-action="clear-filters">清空筛选</button>
            </div>
          </div>
        `
        : `
          <div class="empty-state compact-empty-state">
            <p class="section-hint">这个 Skill 还没有测试用例；你可以直接生成，或者手动补一条更精确的 case。</p>
            <div class="panel-actions skill-test-empty-actions">
              <button class="ghost-button" type="button" data-st-case-action="generate">生成测试用例</button>
              <button class="ghost-button" type="button" data-st-case-action="open-create">手动创建</button>
            </div>
          </div>
        `;
      return;
    }

    dom.caseList.innerHTML = '';
    for (const tc of filteredCases) {
      const card = document.createElement('article');
      card.className = 'skill-test-case-card' + (tc.id === state.selectedCaseId ? ' agent-card-selected' : '');
      card.dataset.caseId = tc.id;

      const validityMeta = getValidityMeta(tc.validityStatus);
      const testTypeLabel = getTestTypeLabel(tc.testType);
      const loadingModeLabel = getLoadingModeLabel(tc.loadingMode);
      const expectedToolsText = formatExpectedTools(tc.expectedTools);
      const lastOutcome = getLastOutcomeSummary(tc.latestRun);
      const goalSummary = clipText(tc.expectedBehavior || tc.note || '生成后会先自动验证一次', 90);
      const latestSummary = clipText(lastOutcome, 96);
      const caseIdentity = tc.id ? `#${tc.id.slice(0, 8)}` : '未命名';
      const recentRunLabel = tc.latestRun && tc.latestRun.createdAt
        ? `最近运行 ${new Date(tc.latestRun.createdAt).toLocaleString()}`
        : '还没跑过';

      card.innerHTML = `
        <div class="skill-test-case-card-head">
          <div>
            <div class="skill-test-case-card-id">${escapeHtml(caseIdentity)}</div>
            <div class="skill-test-case-card-meta">${escapeHtml(testTypeLabel)} · ${escapeHtml(loadingModeLabel)}</div>
          </div>
          <span class="tag ${validityMeta.className}">${validityMeta.label}</span>
        </div>
        <p class="skill-test-case-card-prompt">${escapeHtml(clipText(tc.triggerPrompt, 120))}</p>
        <div class="skill-test-case-card-meta">${escapeHtml(recentRunLabel)}</div>
        <div class="skill-test-case-card-meta">${escapeHtml(goalSummary)}</div>
        <div class="skill-test-case-card-meta">${escapeHtml(clipText(expectedToolsText, 120))}</div>
        <div class="skill-test-case-card-meta">${escapeHtml(latestSummary)}</div>
      `;

      const actions = document.createElement('div');
      actions.className = 'skill-test-case-card-actions';

      const viewButton = document.createElement('button');
      viewButton.type = 'button';
      viewButton.className = 'mini-action';
      viewButton.textContent = '查看详情';
      viewButton.addEventListener('click', (event) => {
        event.stopPropagation();
        selectCase(tc.id, { detailTab: 'overview', scrollIntoView: true });
      });

      const runButton = document.createElement('button');
      runButton.type = 'button';
      runButton.className = 'mini-action';
      runButton.textContent = '运行';
      runButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        selectCase(tc.id, { detailTab: 'runs', scrollIntoView: true });
        await runTestCase(tc.id, {
          button: runButton,
          idleLabel: '运行',
          busyLabel: '运行中...',
          detailTab: 'runs',
          scrollIntoView: true,
        });
      });

      actions.appendChild(viewButton);
      actions.appendChild(runButton);
      card.appendChild(actions);

      card.addEventListener('click', () => {
        selectCase(tc.id, { detailTab: 'overview' });
      });

      dom.caseList.appendChild(card);
    }
  }

  function renderDetail(tc) {
    if (!dom.detailPanel) return;
    if (dom.detailEmpty) dom.detailEmpty.classList.add('hidden');
    dom.detailPanel.classList.remove('hidden');
    if (dom.detailCaseId) dom.detailCaseId.textContent = tc.id;
    if (dom.detailMeta) {
      dom.detailMeta.innerHTML = `
        <span class="tag">${escapeHtml(getTestTypeLabel(tc.testType))}</span>
        <span class="tag">${escapeHtml(getLoadingModeLabel(tc.loadingMode))}</span>
        ${tc.note ? `<span class="tag">${escapeHtml(clipText(tc.note, 36))}</span>` : ''}
      `;
    }
    if (dom.detailLastOutcome) {
      dom.detailLastOutcome.textContent = getLastOutcomeSummary(tc.latestRun);
    }
    if (dom.detailPrompt) dom.detailPrompt.value = tc.triggerPrompt;
    if (dom.detailNote) {
      dom.detailNote.textContent = tc.note || '无备注';
    }
    if (dom.detailExpectedBehavior) {
      dom.detailExpectedBehavior.textContent = tc.expectedBehavior || '主要关注：这条 prompt 能不能稳定触发目标 skill。';
    }
    if (dom.detailExpectedTools) {
      dom.detailExpectedTools.textContent = formatExpectedTools(tc.expectedTools);
    }
    if (dom.detailValidity) {
      const validityMeta = getValidityMeta(tc.validityStatus);
      dom.detailValidity.className = 'tag ' + validityMeta.className;
      dom.detailValidity.textContent = validityMeta.label;
    }
    if (dom.detailValidityHelp) {
      dom.detailValidityHelp.textContent = getValidityHelpText(tc);
    }

    loadCaseRuns(tc.id);
    loadCaseRegression(tc.id);
  }

  function hideDetail() {
    if (dom.detailPanel) {
      dom.detailPanel.classList.add('hidden');
    }
    if (dom.detailEmpty) {
      dom.detailEmpty.classList.remove('hidden');
    }
    if (dom.detailLastOutcome) {
      dom.detailLastOutcome.textContent = '先运行一条再看最近结果摘要。';
    }
    if (dom.detailRegression) {
      dom.detailRegression.innerHTML = '<p class="section-hint">先运行几次，再看不同模型或 prompt version 的表现差异。</p>';
    }
    if (dom.detailRuns) {
      dom.detailRuns.innerHTML = '<p class="section-hint">暂无运行记录</p>';
    }
    switchDetailTab('overview');
  }

  function syncDetailPanel() {
    if (!state.selectedCaseId) {
      hideDetail();
      return;
    }
    const selectedCase = state.testCases.find((tc) => tc.id === state.selectedCaseId);
    if (!selectedCase) {
      hideDetail();
      return;
    }
    renderDetail(selectedCase);
  }

  function renderRetryState(container, message, onRetry) {
    container.innerHTML = `
      <div class="empty-state compact-empty-state">
        <p class="section-hint">${escapeHtml(message)}</p>
        <div class="skill-test-empty-actions">
          <button type="button" class="ghost-button">重试</button>
        </div>
      </div>
    `;

    const retryButton = container.querySelector('button');
    if (retryButton) {
      retryButton.addEventListener('click', onRetry);
    }
  }

  async function loadCaseRuns(caseId) {
    if (!dom.detailRuns) return;
    const skillId = state.selectedSkillId;
    if (!skillId) return;

    dom.detailRuns.innerHTML = '<p class="section-hint">加载运行记录中...</p>';
    try {
      const data = await fetchJson(
        `/api/skills/${encodeURIComponent(skillId)}/test-cases/${encodeURIComponent(caseId)}/runs?limit=50`
      );
      if (state.selectedCaseId !== caseId) return;
      const runs = Array.isArray(data.runs) ? data.runs : [];
      renderCaseRuns(runs);
    } catch {
      if (state.selectedCaseId !== caseId) return;
      renderRetryState(dom.detailRuns, '加载运行记录失败，请重试。', () => {
        loadCaseRuns(caseId);
      });
    }
  }

  async function loadCaseRegression(caseId) {
    if (!dom.detailRegression) return;
    const skillId = state.selectedSkillId;
    if (!skillId) return;

    dom.detailRegression.innerHTML = '<p class="section-hint">加载回归对比中...</p>';
    try {
      const data = await fetchJson(
        `/api/skills/${encodeURIComponent(skillId)}/test-cases/${encodeURIComponent(caseId)}/regression`
      );
      if (state.selectedCaseId !== caseId) return;
      renderCaseRegression(Array.isArray(data.regression) ? data.regression : []);
    } catch {
      if (state.selectedCaseId !== caseId) return;
      renderRetryState(dom.detailRegression, '加载回归对比失败，请重试。', () => {
        loadCaseRegression(caseId);
      });
    }
  }

  function renderCaseRegression(regression) {
    if (!dom.detailRegression) return;
    if (!Array.isArray(regression) || regression.length === 0) {
      dom.detailRegression.innerHTML = `
        <div class="empty-state compact-empty-state">
          <p class="section-hint">还没有足够的运行记录来做对比；先跑几次不同模型或 prompt version，再回来这里看回归差异。</p>
        </div>
      `;
      return;
    }

    let html = '<div class="table-scroll"><table class="summary-table"><thead><tr>';
    html += '<th>模型</th><th>Prompt Version</th><th>运行</th><th>触发成功</th><th>执行成功</th><th>工具命中</th><th>最近运行</th>';
    html += '</tr></thead><tbody>';

    for (const entry of regression) {
      const modelLabel = [entry.provider, entry.model].filter(Boolean).join(' / ');
      const triggerRate = entry.triggerRate != null ? `${(entry.triggerRate * 100).toFixed(1)}%` : '—';
      const executionRate = entry.executionRate != null ? `${(entry.executionRate * 100).toFixed(1)}%` : '—';
      const accuracy = entry.avgToolAccuracy != null ? `${(entry.avgToolAccuracy * 100).toFixed(1)}%` : '—';
      const lastRunAt = entry.lastRunAt ? new Date(entry.lastRunAt).toLocaleString() : '—';

      html += '<tr>';
      html += `<td>${escapeHtml(modelLabel || 'default')}</td>`;
      html += `<td>${escapeHtml(entry.promptVersion || 'skill-test-v1')}</td>`;
      html += `<td>${Number(entry.totalRuns || 0)}</td>`;
      html += `<td>${escapeHtml(triggerRate)}</td>`;
      html += `<td>${escapeHtml(executionRate)}</td>`;
      html += `<td>${escapeHtml(accuracy)}</td>`;
      html += `<td>${escapeHtml(lastRunAt)}</td>`;
      html += '</tr>';
    }

    html += '</tbody></table></div>';
    dom.detailRegression.innerHTML = html;
  }

  function renderCaseRuns(runs) {
    if (!dom.detailRuns) return;
    if (runs.length === 0) {
      dom.detailRuns.innerHTML = `
        <div class="empty-state compact-empty-state">
          <p class="section-hint">这条用例还没有运行记录；点上方“运行测试”就能在这里看到失败原因和诊断信息。</p>
        </div>
      `;
      return;
    }

    dom.detailRuns.innerHTML = '';
    for (const run of runs) {
      const row = document.createElement('div');
      row.className = 'run-item';

      const triggerTag = isPassedFlag(run.triggerPassed)
        ? '<span class="tag tag-success">已触发技能</span>'
        : isFailedFlag(run.triggerPassed)
          ? '<span class="tag tag-error">未触发技能</span>'
          : '<span class="tag tag-pending">触发结果待定</span>';

      const execTag =
        run.executionPassed === null || typeof run.executionPassed === 'undefined'
          ? '<span class="tag tag-pending">未评估执行</span>'
          : isPassedFlag(run.executionPassed)
            ? '<span class="tag tag-success">工具执行符合预期</span>'
            : isFailedFlag(run.executionPassed)
              ? '<span class="tag tag-error">工具执行未达预期</span>'
              : '<span class="tag tag-pending">执行结果待定</span>';

      const accuracy =
        run.toolAccuracy != null ? `<span class="tag">工具命中 ${(run.toolAccuracy * 100).toFixed(0)}%</span>` : '';

      const tools =
        Array.isArray(run.actualTools) && run.actualTools.length > 0
          ? `<div class="agent-meta">工具: ${run.actualTools.map((toolName) => escapeHtml(toolName)).join(', ')}</div>`
          : '';

      let triggerFailHint = '';
      if (isFailedFlag(run.triggerPassed)) {
        triggerFailHint = '<div class="run-item-warning">⚠ 这次没有触发到目标 skill，可点「查看详情」看模型实际做了什么</div>';
      }

      // Action buttons
      const actionsBar = document.createElement('div');
      actionsBar.className = 'run-item-actions';
      actionsBar.style.marginTop = '0.4rem';

      const detailBtn = document.createElement('button');
      detailBtn.className = 'mini-action';
      detailBtn.textContent = '查看详情';
      detailBtn.addEventListener('click', () => toggleRunDetail(row, run.id));

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'mini-action';
      downloadBtn.textContent = '下载 JSON';
      downloadBtn.style.marginLeft = '6px';
      downloadBtn.addEventListener('click', async () => {
        try {
          const detail = await fetchJson(`/api/skill-test-runs/${encodeURIComponent(run.id)}`);
          const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `skill-test-run-${run.id}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showToast('已下载');
        } catch (err) {
          showToast('下载失败: ' + (err.message || err));
        }
      });

      actionsBar.appendChild(detailBtn);
      actionsBar.appendChild(downloadBtn);

      const runModelMeta = [run.provider, run.model].filter(Boolean).join(' / ');
      const runPromptVersion = run.promptVersion ? ` · ${run.promptVersion}` : '';

      row.innerHTML = `
        <div class="run-item-header">
          ${triggerTag} ${execTag} ${accuracy}
          <span class="agent-meta">${run.createdAt ? new Date(run.createdAt).toLocaleString() : ''}${runModelMeta ? ` · ${escapeHtml(runModelMeta)}` : ''}${runPromptVersion ? escapeHtml(runPromptVersion) : ''}</span>
        </div>
        ${tools}
        ${triggerFailHint}
        ${run.errorMessage ? `<div class="agent-meta" style="color:#e53e3e">${escapeHtml(run.errorMessage)}</div>` : ''}
      `;

      row.appendChild(actionsBar);

      dom.detailRuns.appendChild(row);
    }
  }

  /** Toggle inline expandable detail for a single run */
  async function toggleRunDetail(rowEl, runId) {
    const existing = rowEl.querySelector('.run-detail-panel');
    if (existing) {
      existing.remove();
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'run-detail-panel';
    panel.innerHTML = '<p class="section-hint">加载中...</p>';
    rowEl.appendChild(panel);

    try {
      const data = await fetchJson(`/api/skill-test-runs/${encodeURIComponent(runId)}`);
      renderRunDetailPanel(panel, data);
    } catch (err) {
      panel.innerHTML = `<p class="section-hint" style="color:#e53e3e">加载失败: ${escapeHtml(String(err.message || err))}</p>`;
    }
  }

  function renderRunDetailPanel(panel, data) {
    const debug = data.debug || {};
    const result = data.result || {};
    const triggerEvaluation = result.triggerEvaluation || null;
    const aiJudge = triggerEvaluation && triggerEvaluation.aiJudge ? triggerEvaluation.aiJudge : null;
    const executionEvaluation = result.executionEvaluation || null;
    const toolChecks = executionEvaluation && Array.isArray(executionEvaluation.toolChecks)
      ? executionEvaluation.toolChecks
      : [];
    const sequenceCheck = executionEvaluation && executionEvaluation.sequenceCheck && executionEvaluation.sequenceCheck.enabled
      ? executionEvaluation.sequenceCheck
      : null;
    const session = debug.session || {};
    const toolEvents = Array.isArray(debug.toolCalls) ? debug.toolCalls : [];
    const sessionToolCalls = Array.isArray(session.toolCalls) ? session.toolCalls : [];

    let html = '';

    // ---- Output text ----
    if (debug.outputText) {
      html += '<div class="run-detail-section">';
      html += '<div class="section-label">模型输出</div>';
      html += `<pre class="run-detail-pre">${escapeHtml(debug.outputText)}</pre>`;
      html += '</div>';
    }

    if (triggerEvaluation && (triggerEvaluation.mode === 'full' || (Array.isArray(triggerEvaluation.matchedSignals) && triggerEvaluation.matchedSignals.length > 0) || aiJudge)) {
      const sourceLabels = {
        'expected-tool': '工具命中',
        'behavior-signals': '文本/行为线索',
        'ai-judge': 'AI Judge',
        none: '未命中',
      };
      const decisionSources = Array.isArray(triggerEvaluation.decisionSources)
        ? triggerEvaluation.decisionSources.map((entry) => sourceLabels[entry] || entry)
        : [];
      const judgeStatus = !aiJudge
        ? ''
        : aiJudge.passed === true
          ? '<span class="tag tag-success">AI Judge 通过</span>'
          : aiJudge.passed === false
            ? '<span class="tag tag-error">AI Judge 未通过</span>'
            : aiJudge.attempted
              ? '<span class="tag tag-pending">AI Judge 未定</span>'
              : '<span class="tag">AI Judge 跳过</span>';
      html += '<div class="run-detail-section">';
      html += '<div class="section-label">触发评估</div>';
      html += `<div class="agent-meta">模式：${escapeHtml(triggerEvaluation.mode || 'unknown')}</div>`;
      if (decisionSources.length > 0) {
        html += `<div class="agent-meta">判定来源：${escapeHtml(decisionSources.join(' / '))}</div>`;
      }
      if (Array.isArray(triggerEvaluation.matchedSignals) && triggerEvaluation.matchedSignals.length > 0) {
        html += `<div class="agent-meta">命中文本线索：${escapeHtml(triggerEvaluation.matchedSignals.join(' / '))}</div>`;
      }
      if (judgeStatus) {
        html += judgeStatus;
        if (aiJudge && aiJudge.confidence != null) {
          html += ` <span class="agent-meta">置信度 ${escapeHtml(String(Math.round(Number(aiJudge.confidence) * 100)))}%</span>`;
        }
      }
      if (aiJudge && aiJudge.reason) {
        html += `<div class="agent-meta">AI Judge 说明：${escapeHtml(aiJudge.reason)}</div>`;
      }
      if (aiJudge && Array.isArray(aiJudge.matchedBehaviors) && aiJudge.matchedBehaviors.length > 0) {
        html += `<div class="agent-meta">AI 命中行为：${escapeHtml(aiJudge.matchedBehaviors.join(' / '))}</div>`;
      }
      if (aiJudge && aiJudge.errorMessage) {
        html += `<div class="agent-meta" style="color:#e53e3e">AI Judge 异常：${escapeHtml(aiJudge.errorMessage)}</div>`;
      }
      html += '</div>';
    }

    if (sequenceCheck) {
      const sequenceStatus = sequenceCheck.passed
        ? '<span class="tag tag-success">顺序命中</span>'
        : '<span class="tag tag-error">顺序不符</span>';
      html += '<div class="run-detail-section">';
      html += '<div class="section-label">时序校验</div>';
      html += `${sequenceStatus} <span class="agent-meta">按顺序命中 ${escapeHtml(String(sequenceCheck.matchedCount || 0))} / ${escapeHtml(String(sequenceCheck.orderedExpectedCount || 0))}</span>`;
      if (Array.isArray(sequenceCheck.observedTools) && sequenceCheck.observedTools.length > 0) {
        html += `<div class="agent-meta">实际顺序：${escapeHtml(sequenceCheck.observedTools.join(' → '))}</div>`;
      }
      const steps = Array.isArray(sequenceCheck.steps) ? sequenceCheck.steps : [];
      for (const step of steps) {
        const stepStatus = step.matched
          ? '<span class="tag tag-success">命中</span>'
          : step.outOfOrder
            ? '<span class="tag tag-error">顺序不符</span>'
            : '<span class="tag tag-error">未命中</span>';
        html += '<div class="run-detail-tool">';
        html += `${stepStatus} <span class="tag">${escapeHtml(step.name || 'unknown')}</span>`;
        if (step.order != null) {
          html += ` <span class="agent-meta">期望顺序 #${escapeHtml(String(step.order))}</span>`;
        }
        if (step.matchedCallIndex != null) {
          html += `<div class="agent-meta">命中位置：第 ${escapeHtml(String(Number(step.matchedCallIndex) + 1))} 步</div>`;
        }
        if (step.outOfOrder) {
          html += '<div class="agent-meta" style="color:#e53e3e">工具出现过，但出现在更早的位置</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    if (toolChecks.length > 0) {
      html += '<div class="run-detail-section">';
      html += '<div class="section-label">执行评估</div>';
      for (const check of toolChecks) {
        const statusTag = check.matched
          ? '<span class="tag tag-success">命中</span>'
          : check.matchedByName
            ? '<span class="tag tag-error">参数不符</span>'
            : '<span class="tag tag-error">未调用</span>';
        html += '<div class="run-detail-tool">';
        html += `${statusTag} <span class="tag">${escapeHtml(check.name || 'unknown')}</span>`;
        if (check.order != null) {
          html += ` <span class="agent-meta">期望顺序 #${escapeHtml(String(check.order))}</span>`;
        }
        if (check.requiredParams && check.requiredParams.length > 0) {
          html += `<div class="agent-meta">必填参数：${escapeHtml(check.requiredParams.join(', '))}</div>`;
        }
        if (check.expectedArguments) {
          html += `<div class="agent-meta">期望结构</div><pre class="run-detail-pre">${escapeHtml(JSON.stringify(check.expectedArguments, null, 2))}</pre>`;
        }
        if (Array.isArray(check.missingParams) && check.missingParams.length > 0) {
          html += `<div class="agent-meta" style="color:#e53e3e">缺少参数：${escapeHtml(check.missingParams.join(', '))}</div>`;
        }
        if (check.hasParameterExpectation && check.argumentShapePassed === false) {
          html += '<div class="agent-meta" style="color:#e53e3e">参数结构未通过</div>';
        }
        if (check.actualArguments && typeof check.actualArguments === 'object') {
          html += `<div class="agent-meta">实际参数</div><pre class="run-detail-pre">${escapeHtml(JSON.stringify(check.actualArguments, null, 2))}</pre>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }

    if (data.run && isFailedFlag(data.run.triggerPassed)) {
      html += '<div class="run-detail-section">';
      html += '<div class="section-label" style="color:#e53e3e">⚠ 触发失败诊断</div>';
      if (toolEvents.length === 0 && sessionToolCalls.length === 0) {
        html += '<div class="run-detail-diag">模型未调用任何工具，直接输出了文本回复</div>';
      } else {
        const allTools = [
          ...toolEvents.map(e => (e.payload && e.payload.tool) || 'unknown'),
          ...sessionToolCalls.map(t => t.toolName || 'unknown')
        ];
        html += `<div class="run-detail-diag">模型调用了以下工具，但均未触发目标 skill: <strong>${escapeHtml(allTools.join(', '))}</strong></div>`;
      }
      // Show thinking if available
      if (session.thinking) {
        html += '<div class="section-label" style="margin-top:0.4rem">模型思考过程</div>';
        html += `<pre class="run-detail-pre run-detail-thinking">${escapeHtml(session.thinking)}</pre>`;
      }
      html += '</div>';
    }

    // ---- Tool Call Events (from a2a_task_events) ----
    if (toolEvents.length > 0) {
      html += '<div class="run-detail-section">';
      html += '<div class="section-label">回调工具调用</div>';
      for (const ev of toolEvents) {
        const p = ev.payload || {};
        html += '<div class="run-detail-tool">';
        html += `<span class="tag">${escapeHtml(p.tool || 'unknown')}</span>`;
        if (p.status) html += ` <span class="agent-meta">${escapeHtml(p.status)}</span>`;
        if (p.request) html += `<pre class="run-detail-pre">${escapeHtml(JSON.stringify(p.request, null, 2))}</pre>`;
        html += '</div>';
      }
      html += '</div>';
    }

    // ---- Session tool calls (pi built-in) ----
    if (sessionToolCalls.length > 0) {
      html += '<div class="run-detail-section">';
      html += '<div class="section-label">内置工具调用</div>';
      for (const tc of sessionToolCalls) {
        html += '<div class="run-detail-tool">';
        html += `<span class="tag">${escapeHtml(tc.toolName || 'unknown')}</span>`;
        if (tc.arguments && Object.keys(tc.arguments).length > 0) {
          html += `<pre class="run-detail-pre">${escapeHtml(JSON.stringify(tc.arguments, null, 2))}</pre>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }

    // ---- Thinking ----
    if (session.thinking && data.run && isPassedFlag(data.run.triggerPassed)) {
      html += '<div class="run-detail-section">';
      html += '<div class="section-label">思考过程</div>';
      html += `<pre class="run-detail-pre run-detail-thinking">${escapeHtml(session.thinking)}</pre>`;
      html += '</div>';
    }

    if (!html) {
      html = '<p class="section-hint">无调试数据</p>';
    }

    panel.innerHTML = html;
  }

  // ---- Generate ----
  if (dom.generateButton) {
    dom.generateButton.addEventListener('click', async () => {
      if (!state.selectedSkillId) {
        showToast('请先选择一个 Skill');
        return;
      }
      const count = dom.generateCount ? Math.max(1, Math.min(10, Number(dom.generateCount.value) || 3)) : 3;
      const loadingMode = dom.generateLoadingMode ? dom.generateLoadingMode.value : 'dynamic';
      const testType = dom.generateTestType ? dom.generateTestType.value : 'trigger';
      dom.generateButton.disabled = true;
      dom.generateButton.textContent = '生成中...';
      try {
        const data = await fetchJson(
          `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/generate`,
          { method: 'POST', body: { count, loadingMode, testType, ...getRunOptions() } }
        );
        showToast(`已生成 ${data.generated || 0} 个测试用例`);
        await Promise.all([loadTestCases(), loadSummary()]);
      } catch (err) {
        showToast('生成失败: ' + (err.message || err));
      } finally {
        dom.generateButton.disabled = false;
        dom.generateButton.textContent = '生成测试用例';
      }
    });
  }

  // ---- Run single ----
  if (dom.detailRunButton) {
    dom.detailRunButton.addEventListener('click', async () => {
      if (!state.selectedCaseId) return;
      await runTestCase(state.selectedCaseId, {
        button: dom.detailRunButton,
        idleLabel: '运行测试',
        busyLabel: '运行中...',
        detailTab: 'runs',
      });
    });
  }

  // ---- Run all (with progress tracking) ----
  if (dom.runAllButton) {
    dom.runAllButton.addEventListener('click', async () => {
      if (state.selectedSkillId) {
        // proceed
      } else {
        showToast('请先选择一个 Skill');
        return;
      }
      if (!confirm('确认批量运行当前 Skill 下所有“可运行 / 触发失败”的用例吗？这可能需要一些时间。')) return;

      // First get the list of validated cases to know the total count
      let caseList = [];
      try {
        const caseData = await fetchJson(`/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases`);
        caseList = (Array.isArray(caseData.cases) ? caseData.cases : []).filter(
          c => c.validityStatus === 'validated' || c.validityStatus === 'invalid'
        );
      } catch {
        // fallback — just run run-all without progress
      }

      if (caseList.length === 0) {
        showToast('没有可运行的测试用例（仅运行可运行/触发失败的用例）');
        return;
      }

      dom.runAllButton.disabled = true;

      // Create progress bar
      let progressContainer = document.getElementById('st-run-progress');
      if (!progressContainer) {
        progressContainer = document.createElement('div');
        progressContainer.id = 'st-run-progress';
        progressContainer.className = 'run-progress-container';
        // Insert after the run-all button section
        const runAllSection = dom.runAllButton.closest('.stack-card');
        if (runAllSection) {
          runAllSection.appendChild(progressContainer);
        }
      }
      progressContainer.classList.remove('hidden');
      progressContainer.innerHTML = `
        <div class="run-progress-bar">
          <div class="run-progress-fill" style="width:0%"></div>
        </div>
        <div class="run-progress-text">0 / ${caseList.length} — 准备中...</div>
      `;

      let completed = 0;
      let triggerOk = 0;
      let execOk = 0;

      try {
        for (const tc of caseList) {
          updateProgress(progressContainer, completed, caseList.length, `运行: ${clipText(tc.triggerPrompt, 30)}`);

          try {
            const result = await fetchJson(
              `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/${encodeURIComponent(tc.id)}/run`,
              { method: 'POST', body: getRunOptions() }
            );
            if (result.run) {
              if (isPassedFlag(result.run.triggerPassed)) triggerOk++;
              if (isPassedFlag(result.run.executionPassed)) execOk++;
            }
          } catch (err) {
            void err;
          }

          completed++;
        }

        updateProgress(progressContainer, completed, caseList.length, '完成!');
        showToast(`批量运行完成：${completed} 个用例，触发成功 ${triggerOk}/${completed}，执行达标 ${execOk}/${completed}`);
        await Promise.all([loadTestCases(), loadSummary()]);
      } catch (err) {
        showToast('批量运行失败: ' + (err.message || err));
      } finally {
        dom.runAllButton.disabled = false;
        dom.runAllButton.textContent = '批量运行可重试用例';
        // Keep progress visible for 3 seconds then fade
        setTimeout(() => {
          if (progressContainer) progressContainer.classList.add('hidden');
        }, 3000);
      }
    });
  }

  function updateProgress(container, done, total, statusText) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const fill = container.querySelector('.run-progress-fill');
    const text = container.querySelector('.run-progress-text');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = `${done} / ${total} — ${statusText}`;
  }

  // ---- Download all runs as JSON ----
  if (dom.detailDownloadButton) {
    dom.detailDownloadButton.addEventListener('click', async () => {
      if (!state.selectedSkillId || !state.selectedCaseId) return;
      try {
        const data = await fetchJson(
          `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/${encodeURIComponent(state.selectedCaseId)}/runs?limit=100`
        );
        const runs = Array.isArray(data.runs) ? data.runs : [];
        // Enrich each run with debug info
        const enriched = [];
        for (const run of runs) {
          try {
            const detail = await fetchJson(`/api/skill-test-runs/${encodeURIComponent(run.id)}`);
            enriched.push(detail);
          } catch {
            enriched.push({ run });
          }
        }
        const blob = new Blob([JSON.stringify({ testCaseId: state.selectedCaseId, runs: enriched }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `skill-test-case-${state.selectedCaseId}-runs.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('已下载');
      } catch (err) {
        showToast('下载失败: ' + (err.message || err));
      }
    });
  }

  // ---- Delete ----
  if (dom.detailDeleteButton) {
    dom.detailDeleteButton.addEventListener('click', async () => {
      if (!state.selectedSkillId || !state.selectedCaseId) return;
      if (!confirm('确认删除此测试用例？')) return;
      try {
        await fetchJson(
          `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/${encodeURIComponent(state.selectedCaseId)}`,
          { method: 'DELETE' }
        );
        showToast('已删除');
        state.selectedCaseId = '';
        hideDetail();
        await Promise.all([loadTestCases(), loadSummary()]);
      } catch (err) {
        showToast('删除失败: ' + (err.message || err));
      }
    });
  }

  // ---- Manual create ----
  if (dom.createForm) {
    dom.createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.selectedSkillId) {
        showToast('请先选择一个 Skill');
        return;
      }
      const prompt = dom.createPrompt ? dom.createPrompt.value.trim() : '';
      if (!prompt) {
        showToast('触发 prompt 不能为空');
        return;
      }

      const toolsStr = dom.createTools ? dom.createTools.value.trim() : '';
      const expectedTools = toolsStr ? toolsStr.split(/[,，\s]+/).filter(Boolean) : [];
      const structuredToolsText = dom.createToolSpecs ? dom.createToolSpecs.value.trim() : '';
      const structuredTools = parseStructuredExpectedTools(structuredToolsText);
      if (structuredToolsText && !structuredTools) {
        showToast('结构化校验 JSON 需要是数组，例如 [{"name":"read-skill","order":1}]');
        return;
      }
      const expectedBehavior = dom.createBehavior ? dom.createBehavior.value.trim() : '';

      if (dom.createSubmitButton) {
        dom.createSubmitButton.disabled = true;
        dom.createSubmitButton.textContent = '创建中...';
      }
      try {
        await fetchJson(`/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases`, {
          method: 'POST',
          body: {
            triggerPrompt: prompt,
            testType: dom.createTestType ? dom.createTestType.value : 'trigger',
            loadingMode: dom.createLoadingMode ? dom.createLoadingMode.value : 'dynamic',
            expectedTools: [...expectedTools, ...(structuredTools || [])],
            expectedBehavior,
            note: dom.createNote ? dom.createNote.value.trim() : '',
          },
        });
        showToast('测试用例已创建');
        if (dom.createPrompt) dom.createPrompt.value = '';
        if (dom.createToolSpecs) dom.createToolSpecs.value = '';
        if (dom.createBehavior) dom.createBehavior.value = '';
        if (dom.createNote) dom.createNote.value = '';
        await Promise.all([loadTestCases(), loadSummary()]);
      } catch (err) {
        showToast('创建失败: ' + (err.message || err));
      } finally {
        if (dom.createSubmitButton) {
          dom.createSubmitButton.disabled = false;
          dom.createSubmitButton.textContent = '创建';
        }
      }
    });
  }

  // ---- Summary ----
  async function loadSummary() {
    if (!dom.summaryBody) return;
    try {
      const data = await fetchJson('/api/skill-test-summary');
      state.summary = Array.isArray(data.summary) ? data.summary : [];
      renderSummary();
    } catch {
      renderSelectedSkillOverview();
      // Summary is optional, don't block
    }
  }

  function renderSummary() {
    if (!dom.summaryBody) return;
    renderSelectedSkillOverview();
    if (state.summary.length === 0) {
      if (dom.summaryHighlights) {
        dom.summaryHighlights.innerHTML = '<span class="tag tag-pending">还没有可展示的 skill 测试结果</span>';
      }
      dom.summaryBody.innerHTML = '<p class="section-hint">暂无测试数据</p>';
      return;
    }

    const totals = state.summary.reduce((acc, entry) => {
      acc.totalCases += Number(entry.totalCases || 0);
      acc.totalRuns += Number(entry.totalRuns || 0);
      acc.validated += Number((entry.casesByValidity && entry.casesByValidity.validated) || 0);
      acc.invalid += Number((entry.casesByValidity && entry.casesByValidity.invalid) || 0);
      acc.triggerPassed += Number(entry.triggerPassedCount || 0);
      acc.executionPassed += Number(entry.executionPassedCount || 0);
      return acc;
    }, { totalCases: 0, totalRuns: 0, validated: 0, invalid: 0, triggerPassed: 0, executionPassed: 0 });

    if (dom.summaryHighlights) {
      const triggerRate = totals.totalRuns > 0 ? Math.round((totals.triggerPassed / totals.totalRuns) * 100) : 0;
      const executionBase = totals.triggerPassed > 0 ? totals.triggerPassed : 0;
      const executionRate = executionBase > 0 ? Math.round((totals.executionPassed / executionBase) * 100) : 0;
      dom.summaryHighlights.innerHTML = `
        <span class="tag">共 ${totals.totalCases} 条用例</span>
        <span class="tag tag-success">可运行 ${totals.validated}</span>
        <span class="tag tag-error">触发失败 ${totals.invalid}</span>
        <span class="tag">触发成功率 ${triggerRate}%</span>
        <span class="tag">执行成功率 ${executionRate || 0}%</span>
      `;
    }

    let html = '<div class="table-scroll"><table class="summary-table"><thead><tr>';
    html += '<th>Skill</th><th>用例</th><th>运行</th>';
    html += '<th>状态</th><th>触发成功</th><th>执行成功</th><th>工具命中</th>';
    html += '</tr></thead><tbody>';

    for (const entry of state.summary) {
      const triggerRate = entry.triggerRate != null ? (entry.triggerRate * 100).toFixed(1) + '%' : '—';
      const execRate = entry.executionRate != null ? (entry.executionRate * 100).toFixed(1) + '%' : '—';
      const accuracy = entry.avgToolAccuracy != null ? (entry.avgToolAccuracy * 100).toFixed(1) + '%' : '—';
      const validatedCount = Number((entry.casesByValidity && entry.casesByValidity.validated) || 0);
      const invalidCount = Number((entry.casesByValidity && entry.casesByValidity.invalid) || 0);
      const pendingCount = Math.max(0, Number(entry.totalCases || 0) - validatedCount - invalidCount);

      html += `<tr>`;
      html += `<td>${escapeHtml(entry.skillId)}</td>`;
      html += `<td>${entry.totalCases}</td>`;
      html += `<td>${entry.totalRuns}</td>`;
      html += `<td>可运行 ${validatedCount} / 失败 ${invalidCount} / 待验证 ${pendingCount}</td>`;
      html += `<td>${triggerRate}</td>`;
      html += `<td>${execRate}</td>`;
      html += `<td>${accuracy}</td>`;
      html += `</tr>`;
    }

    html += '</tbody></table></div>';
    dom.summaryBody.innerHTML = html;
  }

  if (dom.refreshSummaryButton) {
    dom.refreshSummaryButton.addEventListener('click', loadSummary);
  }

  // ---- Utilities ----
  function getTestTypeLabel(testType) {
    return testType === 'execution' ? '执行侧重点' : '触发侧重点';
  }

  function getLoadingModeLabel(loadingMode) {
    return loadingMode === 'full' ? 'Full 模式' : 'Dynamic 模式';
  }

  function normalizeExpectedToolSpec(entry) {
    if (typeof entry === 'string') {
      const name = entry.trim();
      return name ? { name, requiredParams: [], hasArgumentShape: false, arguments: null, order: null } : null;
    }
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const name = String(entry.name || entry.tool || '').trim();
    if (!name) {
      return null;
    }
    const requiredParams = Array.isArray(entry.requiredParams)
      ? entry.requiredParams.map((item) => String(item || '').trim()).filter(Boolean)
      : Array.isArray(entry.required_params)
        ? entry.required_params.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
    const hasArgumentShape = Object.prototype.hasOwnProperty.call(entry, 'arguments')
      || Object.prototype.hasOwnProperty.call(entry, 'args')
      || Object.prototype.hasOwnProperty.call(entry, 'params');
    const rawOrder = Object.prototype.hasOwnProperty.call(entry, 'order')
      ? entry.order
      : (Object.prototype.hasOwnProperty.call(entry, 'sequence')
        ? entry.sequence
        : (Object.prototype.hasOwnProperty.call(entry, 'sequenceIndex')
          ? entry.sequenceIndex
          : entry.sequence_index));
    const parsedOrder = rawOrder == null || rawOrder === '' ? null : Number.parseInt(String(rawOrder), 10);
    return {
      name,
      requiredParams,
      hasArgumentShape,
      arguments: hasArgumentShape ? (Object.prototype.hasOwnProperty.call(entry, 'arguments') ? entry.arguments : (Object.prototype.hasOwnProperty.call(entry, 'args') ? entry.args : entry.params)) : null,
      order: Number.isInteger(parsedOrder) && parsedOrder > 0 ? parsedOrder : null,
    };
  }

  function formatExpectedToolSpec(entry) {
    const spec = normalizeExpectedToolSpec(entry);
    if (!spec) return '';
    const parts = [spec.name];
    if (spec.order != null) {
      parts.push(`顺序 #${spec.order}`);
    }
    if (spec.requiredParams.length > 0) {
      parts.push(`必填 ${spec.requiredParams.join(', ')}`);
    }
    if (spec.hasArgumentShape) {
      parts.push('校验参数结构');
    }
    return parts.join(' · ');
  }

  function getExpectedToolsSearchText(expectedTools) {
    return Array.isArray(expectedTools)
      ? expectedTools.map((entry) => formatExpectedToolSpec(entry)).filter(Boolean).join(' ')
      : '';
  }

  function parseStructuredExpectedTools(value) {
    const text = String(value || '').trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function formatExpectedTools(expectedTools) {
    if (!Array.isArray(expectedTools) || expectedTools.length === 0) {
      return '主要看能否触发 skill';
    }
    const labels = expectedTools.map((entry) => formatExpectedToolSpec(entry)).filter(Boolean);
    return labels.length > 0 ? `期望工具：${labels.join('；')}` : '主要看能否触发 skill';
  }

  function getValidityMeta(validityStatus) {
    if (validityStatus === 'validated') {
      return { label: '可运行', className: 'tag-success' };
    }
    if (validityStatus === 'invalid') {
      return { label: '触发失败', className: 'tag-error' };
    }
    return { label: '待验证', className: 'tag-pending' };
  }

  function getValidityHelpText(testCase) {
    if (testCase.validityStatus === 'validated') {
      return '这条用例已经通过可触发验证，可以继续重复运行观察稳定性。';
    }
    if (testCase.validityStatus === 'invalid') {
      return getLastOutcomeSummary(testCase.latestRun) || '这条用例最近一次没有成功触发目标 skill，可以修改 prompt 后重试。';
    }
    return '这条用例还没有完成验证；生成后会自动做一次 smoke run。';
  }

  function isPassedFlag(value) {
    return value === true || value === 1;
  }

  function isFailedFlag(value) {
    return value === false || value === 0;
  }

  function isFailingRun(run) {
    return Boolean(run) && (isFailedFlag(run.triggerPassed) || isFailedFlag(run.executionPassed) || Boolean(run.errorMessage));
  }

  function getLastOutcomeSummary(run) {
    if (!run) return '还没有运行记录';
    if (run.errorMessage) return `最近失败：${run.errorMessage}`;
    if (isFailedFlag(run.triggerPassed)) return '最近失败：没有触发到目标 skill';
    if (isFailedFlag(run.executionPassed)) return '最近失败：触发成功，但工具调用不符合预期';
    if (isPassedFlag(run.triggerPassed) && isPassedFlag(run.executionPassed)) return '最近运行：触发和执行都符合预期';
    if (isPassedFlag(run.triggerPassed) && run.executionPassed === null) return '最近运行：已触发 skill，执行评估被跳过';
    return '最近运行：已记录结果';
  }

  function escapeHtml(text) {
    const el = document.createElement('span');
    el.textContent = String(text || '');
    return el.innerHTML;
  }

  function clipText(text, maxLength = 140) {
    const value = String(text || '').trim();
    if (!value) return '';
    return value.length <= maxLength ? value : value.slice(0, maxLength - 3) + '...';
  }
})();
