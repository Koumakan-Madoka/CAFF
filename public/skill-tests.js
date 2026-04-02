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
    tabButtons: document.querySelectorAll('.tab-bar .tab-button'),
    tabPanels: document.querySelectorAll('.tab-panel'),
    // Skill Tests tab
    skillSelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-skill-select')),
    refreshSkillsButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-refresh-skills')),
    agentSelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-agent-select')),
    modelSelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-model-select')),
    generateButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-generate-btn')),
    generateCount: /** @type {HTMLInputElement | null} */ (document.getElementById('st-generate-count')),
    runAllButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-run-all-btn')),
    caseList: /** @type {HTMLDivElement | null} */ (document.getElementById('st-case-list')),
    caseCount: /** @type {HTMLElement | null} */ (document.getElementById('st-case-count')),
    // Detail panel
    detailPanel: /** @type {HTMLElement | null} */ (document.getElementById('st-detail')),
    detailCaseId: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-case-id')),
    detailPrompt: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-prompt')),
    detailExpectedTools: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-expected-tools')),
    detailValidity: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-validity')),
    detailRunButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-run-btn')),
    detailDownloadButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-download-btn')),
    detailDeleteButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-delete-btn')),
    detailRuns: /** @type {HTMLDivElement | null} */ (document.getElementById('st-detail-runs')),
    // Summary
    summaryBody: /** @type {HTMLElement | null} */ (document.getElementById('st-summary-body')),
    refreshSummaryButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-refresh-summary')),
    // Manual create
    createForm: /** @type {HTMLFormElement | null} */ (document.getElementById('st-create-form')),
    createPrompt: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-prompt')),
    createTestType: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-create-type')),
    createTools: /** @type {HTMLInputElement | null} */ (document.getElementById('st-create-tools')),
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
  }

  function getRunOptions() {
    const agentId = dom.agentSelect ? dom.agentSelect.value.trim() : '';
    const modelKey = dom.modelSelect ? dom.modelSelect.value.trim() : '';
    let provider = '';
    let model = '';
    if (modelKey) {
      const parts = modelKey.split('\u001f');
      provider = (parts[0] || '').trim();
      model = (parts[1] || '').trim();
    }
    const opts = {};
    if (provider) opts.provider = provider;
    if (model) opts.model = model;
    if (agentId) opts.agentId = agentId;
    // resolve agent name from agent list
    if (agentId && Array.isArray(state.agents)) {
      const found = state.agents.find(a => a && a.id === agentId);
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
    if (current && state.skills.some((s) => s.id === current)) {
      dom.skillSelect.value = current;
    }
    state.selectedSkillId = dom.skillSelect.value;
  }

  if (dom.skillSelect) {
    dom.skillSelect.addEventListener('change', () => {
      state.selectedSkillId = dom.skillSelect.value;
      loadTestCases();
    });
  }

  if (dom.refreshSkillsButton) {
    dom.refreshSkillsButton.addEventListener('click', loadSkills);
  }

  // ---- Test Cases ----
  async function loadTestCases() {
    if (!state.selectedSkillId) {
      state.testCases = [];
      renderCaseList();
      return;
    }
    try {
      const data = await fetchJson(`/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases`);
      state.testCases = Array.isArray(data.cases) ? data.cases : [];
      renderCaseList();
    } catch (err) {
      showToast('Failed to load test cases: ' + (err.message || err));
    }
  }

  function renderCaseList() {
    if (!dom.caseList) return;
    if (!dom.caseCount) return;
    dom.caseCount.textContent = String(state.testCases.length);

    if (state.testCases.length === 0) {
      dom.caseList.innerHTML = '<p class="section-hint">暂无测试用例，点击「生成」或「手动创建」</p>';
      return;
    }

    dom.caseList.innerHTML = '';
    for (const tc of state.testCases) {
      const card = document.createElement('div');
      card.className = 'agent-card' + (tc.id === state.selectedCaseId ? ' agent-card-selected' : '');
      card.dataset.caseId = tc.id;

      const validityClass =
        tc.validityStatus === 'validated'
          ? 'tag-success'
          : tc.validityStatus === 'invalid'
            ? 'tag-error'
            : 'tag-pending';

      card.innerHTML = `
        <div class="agent-card-header">
          <span class="agent-name">${escapeHtml(clipText(tc.triggerPrompt, 60))}</span>
          <span class="tag ${validityClass}">${tc.validityStatus}</span>
        </div>
        <div class="agent-meta">
          <span>${tc.testType} · ${tc.loadingMode}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        state.selectedCaseId = tc.id;
        renderCaseList();
        renderDetail(tc);
      });

      dom.caseList.appendChild(card);
    }
  }

  function renderDetail(tc) {
    if (!dom.detailPanel) return;
    dom.detailPanel.classList.remove('hidden');
    if (dom.detailCaseId) dom.detailCaseId.textContent = tc.id;
    if (dom.detailPrompt) dom.detailPrompt.value = tc.triggerPrompt;
    if (dom.detailExpectedTools) {
      dom.detailExpectedTools.textContent =
        Array.isArray(tc.expectedTools) && tc.expectedTools.length > 0
          ? tc.expectedTools.join(', ')
          : '(无特定工具期望)';
    }
    if (dom.detailValidity) {
      dom.detailValidity.className =
        'tag ' +
        (tc.validityStatus === 'validated'
          ? 'tag-success'
          : tc.validityStatus === 'invalid'
            ? 'tag-error'
            : 'tag-pending');
      dom.detailValidity.textContent = tc.validityStatus;
    }

    // Load runs for this case
    loadCaseRuns(tc.id);
  }

  async function loadCaseRuns(caseId) {
    if (!dom.detailRuns) return;
    // Fetch runs via case-specific endpoint
    const skillId = state.selectedSkillId;
    if (!skillId) return;

    try {
      const data = await fetchJson(
        `/api/skills/${encodeURIComponent(skillId)}/test-cases/${encodeURIComponent(caseId)}/runs?limit=50`
      );
      const runs = Array.isArray(data.runs) ? data.runs : [];
      renderCaseRuns(runs);
    } catch {
      dom.detailRuns.innerHTML = '<p class="section-hint">加载运行记录失败</p>';
    }
  }

  function renderCaseRuns(runs) {
    if (!dom.detailRuns) return;
    if (runs.length === 0) {
      dom.detailRuns.innerHTML = '<p class="section-hint">暂无运行记录</p>';
      return;
    }

    dom.detailRuns.innerHTML = '';
    for (const run of runs) {
      const row = document.createElement('div');
      row.className = 'run-item';

      const triggerTag = run.triggerPassed
        ? '<span class="tag tag-success">触发 ✓</span>'
        : '<span class="tag tag-error">触发 ✗</span>';

      const execTag =
        run.executionPassed === null
          ? '<span class="tag tag-pending">执行跳过</span>'
          : run.executionPassed
            ? '<span class="tag tag-success">执行 ✓</span>'
            : '<span class="tag tag-error">执行 ✗</span>';

      const accuracy =
        run.toolAccuracy != null ? `<span class="tag">准确率 ${(run.toolAccuracy * 100).toFixed(0)}%</span>` : '';

      const tools =
        Array.isArray(run.actualTools) && run.actualTools.length > 0
          ? `<div class="agent-meta">工具: ${run.actualTools.join(', ')}</div>`
          : '';

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'mini-action';
      downloadBtn.textContent = '下载 JSON';
      downloadBtn.style.marginLeft = '8px';
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

      row.innerHTML = `
        <div class="run-item-header">
          ${triggerTag} ${execTag} ${accuracy}
          <span class="agent-meta">${run.createdAt ? new Date(run.createdAt).toLocaleString() : ''}</span>
        </div>
        ${tools}
        ${run.errorMessage ? `<div class="agent-meta" style="color:#e53e3e">${escapeHtml(run.errorMessage)}</div>` : ''}
      `;

      // Append download button to the header
      const header = row.querySelector('.run-item-header');
      if (header) header.appendChild(downloadBtn);

      dom.detailRuns.appendChild(row);
    }
  }

  // ---- Generate ----
  if (dom.generateButton) {
    dom.generateButton.addEventListener('click', async () => {
      if (!state.selectedSkillId) {
        showToast('请先选择一个 Skill');
        return;
      }
      const count = dom.generateCount ? Math.max(1, Math.min(10, Number(dom.generateCount.value) || 3)) : 3;
      dom.generateButton.disabled = true;
      dom.generateButton.textContent = '生成中...';
      try {
        const data = await fetchJson(
          `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/generate`,
          { method: 'POST', body: { count } }
        );
        showToast(`已生成 ${data.generated || 0} 个测试用例`);
        await loadTestCases();
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
      if (!state.selectedSkillId || !state.selectedCaseId) return;
      dom.detailRunButton.disabled = true;
      dom.detailRunButton.textContent = '运行中...';
      try {
        await fetchJson(
          `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/${encodeURIComponent(state.selectedCaseId)}/run`,
          { method: 'POST', body: getRunOptions() }
        );
        showToast('测试运行完成');
        await loadTestCases();
        const tc = state.testCases.find((t) => t.id === state.selectedCaseId);
        if (tc) renderDetail(tc);
      } catch (err) {
        showToast('运行失败: ' + (err.message || err));
      } finally {
        dom.detailRunButton.disabled = false;
        dom.detailRunButton.textContent = '运行测试';
      }
    });
  }

  // ---- Run all ----
  if (dom.runAllButton) {
    dom.runAllButton.addEventListener('click', async () => {
      if (!state.selectedSkillId) {
        showToast('请先选择一个 Skill');
        return;
      }
      if (!confirm('确认运行所有有效测试用例？这可能需要一些时间。')) return;
      dom.runAllButton.disabled = true;
      dom.runAllButton.textContent = '批量运行中...';
      try {
        const data = await fetchJson(
          `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/run-all`,
          { method: 'POST', body: getRunOptions() }
        );
        showToast(`批量运行完成: ${data.total || 0} 个用例`);
        await loadTestCases();
      } catch (err) {
        showToast('批量运行失败: ' + (err.message || err));
      } finally {
        dom.runAllButton.disabled = false;
        dom.runAllButton.textContent = '运行全部';
      }
    });
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
        if (dom.detailPanel) dom.detailPanel.classList.add('hidden');
        await loadTestCases();
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
            expectedTools,
            note: dom.createNote ? dom.createNote.value.trim() : '',
          },
        });
        showToast('测试用例已创建');
        if (dom.createPrompt) dom.createPrompt.value = '';
        if (dom.createNote) dom.createNote.value = '';
        await loadTestCases();
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
      // Summary is optional, don't block
    }
  }

  function renderSummary() {
    if (!dom.summaryBody) return;
    if (state.summary.length === 0) {
      dom.summaryBody.innerHTML = '<p class="section-hint">暂无测试数据</p>';
      return;
    }

    let html = '<table class="summary-table"><thead><tr>';
    html += '<th>Skill</th><th>用例数</th><th>运行次数</th>';
    html += '<th>触发通过率</th><th>执行通过率</th><th>工具准确率</th>';
    html += '</tr></thead><tbody>';

    for (const entry of state.summary) {
      const triggerRate = entry.triggerRate != null ? (entry.triggerRate * 100).toFixed(1) + '%' : '—';
      const execRate = entry.executionRate != null ? (entry.executionRate * 100).toFixed(1) + '%' : '—';
      const accuracy = entry.avgToolAccuracy != null ? (entry.avgToolAccuracy * 100).toFixed(1) + '%' : '—';

      html += `<tr>`;
      html += `<td>${escapeHtml(entry.skillId)}</td>`;
      html += `<td>${entry.totalCases}</td>`;
      html += `<td>${entry.totalRuns}</td>`;
      html += `<td>${triggerRate}</td>`;
      html += `<td>${execRate}</td>`;
      html += `<td>${accuracy}</td>`;
      html += `</tr>`;
    }

    html += '</tbody></table>';
    dom.summaryBody.innerHTML = html;
  }

  if (dom.refreshSummaryButton) {
    dom.refreshSummaryButton.addEventListener('click', loadSummary);
  }

  // ---- Utilities ----
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
