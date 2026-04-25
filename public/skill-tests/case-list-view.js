// @ts-check

(function registerSkillTestCaseListView() {
  const skillTests = window.CaffSkillTests || (window.CaffSkillTests = {});

  skillTests.createCaseListViewHelpers = function createCaseListViewHelpers(deps = {}) {
    const escapeHtml = typeof deps.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '');
    const clipText = typeof deps.clipText === 'function'
      ? deps.clipText
      : (value) => String(value || '');
    const formatRefreshTime = typeof deps.formatRefreshTime === 'function'
      ? deps.formatRefreshTime
      : () => '';
    const buildCompactEmptyStateHtml = typeof deps.buildCompactEmptyStateHtml === 'function'
      ? deps.buildCompactEmptyStateHtml
      : (message) => `<p class="section-hint">${escapeHtml(message)}</p>`;
    const buildInlineBannerHtml = typeof deps.buildInlineBannerHtml === 'function'
      ? deps.buildInlineBannerHtml
      : () => '';
    const getChainCaseView = typeof deps.getChainCaseView === 'function'
      ? deps.getChainCaseView
      : () => null;
    const buildChainRailHtml = typeof deps.buildChainRailHtml === 'function'
      ? deps.buildChainRailHtml
      : () => '';
    const getCaseStatusMeta = typeof deps.getCaseStatusMeta === 'function'
      ? deps.getCaseStatusMeta
      : () => ({ className: '', label: '' });
    const readCaseValidation = typeof deps.readCaseValidation === 'function'
      ? deps.readCaseValidation
      : () => ({ caseSchemaStatus: 'valid', derivedFromLegacy: false, issues: [] });
    const getCaseReadinessMeta = typeof deps.getCaseReadinessMeta === 'function'
      ? deps.getCaseReadinessMeta
      : () => ({ className: '', label: '' });
    const getLatestRunStatusMeta = typeof deps.getLatestRunStatusMeta === 'function'
      ? deps.getLatestRunStatusMeta
      : () => null;
    const getLoadingModeLabel = typeof deps.getLoadingModeLabel === 'function'
      ? deps.getLoadingModeLabel
      : () => '';
    const formatExpectedTools = typeof deps.formatExpectedTools === 'function'
      ? deps.formatExpectedTools
      : () => '';
    const isEnvironmentConfigEnabled = typeof deps.isEnvironmentConfigEnabled === 'function'
      ? deps.isEnvironmentConfigEnabled
      : () => false;
    const formatEnvironmentConfigSummary = typeof deps.formatEnvironmentConfigSummary === 'function'
      ? deps.formatEnvironmentConfigSummary
      : () => '';
    const getLastOutcomeSummary = typeof deps.getLastOutcomeSummary === 'function'
      ? deps.getLastOutcomeSummary
      : () => '';
    const getCasePrompt = typeof deps.getCasePrompt === 'function'
      ? deps.getCasePrompt
      : () => '';
    const buildIssueSummary = typeof deps.buildIssueSummary === 'function'
      ? deps.buildIssueSummary
      : (issues) => `${Array.isArray(issues) ? issues.length : 0} 条`;
    const getCaseSchemaStatusMeta = typeof deps.getCaseSchemaStatusMeta === 'function'
      ? deps.getCaseSchemaStatusMeta
      : () => null;
    const getCaseActionCallout = typeof deps.getCaseActionCallout === 'function'
      ? deps.getCaseActionCallout
      : () => null;
    const isFailingRun = typeof deps.isFailingRun === 'function'
      ? deps.isFailingRun
      : () => false;

    function renderCaseList(elements = {}, listState = {}, handlers = {}) {
      const caseList = elements.caseList instanceof HTMLElement
        ? elements.caseList
        : null;
      const caseCount = elements.caseCount instanceof HTMLElement
        ? elements.caseCount
        : null;
      const filterCount = elements.filterCount instanceof HTMLElement
        ? elements.filterCount
        : null;
      if (!caseList || !caseCount) {
        return;
      }

      const selectedSkillId = String(listState.selectedSkillId || '').trim();
      const testCases = Array.isArray(listState.testCases) ? listState.testCases : [];
      const filteredCases = Array.isArray(listState.filteredCases) ? listState.filteredCases : [];
      const selectedCaseId = String(listState.selectedCaseId || '').trim();
      const casesLoading = listState.casesLoading === true;
      const casesLoadError = String(listState.casesLoadError || '').trim();
      const casesRefreshLabel = formatRefreshTime(listState.casesLastLoadedAt);
      const onSelectCase = typeof handlers.onSelectCase === 'function'
        ? handlers.onSelectCase
        : () => {};
      const onRunCase = typeof handlers.onRunCase === 'function'
        ? handlers.onRunCase
        : async () => {};
      const onToggleCaseStatus = typeof handlers.onToggleCaseStatus === 'function'
        ? handlers.onToggleCaseStatus
        : async () => {};

      caseCount.textContent = `${testCases.length} 个用例`;
      if (filterCount) {
        filterCount.textContent = `显示 ${filteredCases.length} / ${testCases.length}`;
      }

      if (casesLoading && testCases.length === 0) {
        caseList.innerHTML = buildCompactEmptyStateHtml('正在加载测试用例...');
        return;
      }

      if (casesLoadError && testCases.length === 0) {
        caseList.innerHTML = buildCompactEmptyStateHtml(casesLoadError, {
          actionsHtml: `
            <div class="panel-actions skill-test-empty-actions">
              <button class="ghost-button" type="button" data-st-case-action="retry-load">重试</button>
            </div>
          `,
        });
        return;
      }

      if (filteredCases.length === 0) {
        if (!selectedSkillId) {
          caseList.innerHTML = buildCompactEmptyStateHtml('先从顶部选一个 Skill，再来看它的测试用例。');
          return;
        }

        caseList.innerHTML = testCases.length > 0
          ? buildCompactEmptyStateHtml('没有符合当前筛选的用例，试试清空搜索或把状态 / 形态都切回“全部”。', {
              actionsHtml: `
                <div class="panel-actions skill-test-empty-actions">
                  <button class="ghost-button" type="button" data-st-case-action="clear-filters">清空筛选</button>
                </div>
              `,
            })
          : buildCompactEmptyStateHtml('这个 Skill 还没有测试用例；你可以直接生成，或者手动补一条更精确的 case。', {
              actionsHtml: `
                <div class="panel-actions skill-test-empty-actions">
                  <button class="ghost-button" type="button" data-st-case-action="generate">AI 生成测试用例</button>
                  <button class="ghost-button" type="button" data-st-case-action="open-create">手动创建</button>
                </div>
              `,
            });
        return;
      }

      caseList.innerHTML = '';
      if (casesLoading || casesLoadError) {
        caseList.insertAdjacentHTML('beforeend', buildInlineBannerHtml({
          tone: casesLoadError ? 'error' : 'pending',
          message: casesLoadError
            ? `列表刷新失败，当前仍显示${casesRefreshLabel ? `${casesRefreshLabel} 的` : '上一次成功加载的'}结果。`
            : (casesRefreshLabel ? `列表刷新中，当前先显示 ${casesRefreshLabel} 的结果。` : '列表刷新中，你可以先查看已加载结果。'),
          actionsHtml: casesLoadError
            ? `
              <div class="panel-actions">
                <button class="ghost-button" type="button" data-st-case-action="retry-load">重试</button>
              </div>
            `
            : '',
        }));
      }

      for (const testCase of filteredCases) {
        caseList.appendChild(buildCaseCard(testCase, {
          selectedCaseId,
          onSelectCase,
          onRunCase,
          onToggleCaseStatus,
        }));
      }
    }

    function buildCaseCard(testCase, handlers = {}) {
      const selectedCaseId = String(handlers.selectedCaseId || '').trim();
      const onSelectCase = typeof handlers.onSelectCase === 'function'
        ? handlers.onSelectCase
        : () => {};
      const onRunCase = typeof handlers.onRunCase === 'function'
        ? handlers.onRunCase
        : async () => {};
      const onToggleCaseStatus = typeof handlers.onToggleCaseStatus === 'function'
        ? handlers.onToggleCaseStatus
        : async () => {};
      const chainView = getChainCaseView(testCase);
      const card = document.createElement('article');
      card.className = 'skill-test-case-card'
        + (chainView ? ' skill-test-case-card-chain' : '')
        + (testCase.id === selectedCaseId ? ' agent-card-selected' : '');
      card.dataset.caseId = testCase.id;

      const validityMeta = getCaseStatusMeta(testCase.caseStatus);
      const caseValidation = readCaseValidation(testCase);
      const readinessMeta = getCaseReadinessMeta(testCase, caseValidation);
      const latestRunMeta = getLatestRunStatusMeta(testCase.latestRun);
      const schemaStatusMeta = getCaseSchemaStatusMeta(caseValidation.caseSchemaStatus);
      const loadingModeLabel = getLoadingModeLabel(testCase.loadingMode);
      const expectedToolsText = formatExpectedTools(testCase.expectedTools);
      const environmentEnabled = isEnvironmentConfigEnabled(testCase.environmentConfig);
      const environmentSummary = environmentEnabled
        ? clipText(formatEnvironmentConfigSummary(testCase.environmentConfig, testCase.latestRun), 120)
        : '';
      const lastOutcome = getLastOutcomeSummary(testCase.latestRun);
      const goalSummary = clipText(
        testCase.expectedGoal || testCase.expectedBehavior || testCase.note || '生成后先进入 draft，等待你修改。',
        90
      );
      const latestSummary = clipText(lastOutcome, 96);
      const caseIdentity = testCase.id ? `#${testCase.id.slice(0, 8)}` : '未命名';
      const recentRunLabel = testCase.latestRun && testCase.latestRun.createdAt
        ? `最近运行 ${new Date(testCase.latestRun.createdAt).toLocaleString()}`
        : '还没跑过';
      const validationSummary = caseValidation.issues.length > 0
        ? `用例校验 ${buildIssueSummary(caseValidation.issues)}`
        : caseValidation.derivedFromLegacy === true
          ? '用例由 legacy 结构映射而来'
          : '';
      const schemaTag = schemaStatusMeta && caseValidation.caseSchemaStatus !== 'valid'
        ? `<span class="tag ${schemaStatusMeta.className}">${escapeHtml(schemaStatusMeta.label)}</span>`
        : '';
      const tagsHtml = `
            <span class="tag ${validityMeta.className}">${validityMeta.label}</span>
            <span class="tag ${readinessMeta.className}">${escapeHtml(readinessMeta.label)}</span>
            ${latestRunMeta ? `<span class="tag ${latestRunMeta.className}">${escapeHtml(latestRunMeta.label)}</span>` : ''}
            ${environmentEnabled ? '<span class="tag">环境链</span>' : ''}
            ${schemaTag}
      `;
      const caseCallout = getCaseActionCallout(testCase, caseValidation);
      const calloutHtml = caseCallout
        ? `
        <div class="skill-test-case-callout skill-test-status-callout skill-test-status-callout-${caseCallout.tone}">
          <div class="skill-test-status-callout-label">${escapeHtml(caseCallout.label)}</div>
          <p class="section-hint">${escapeHtml(caseCallout.message)}</p>
        </div>
      `
        : '';
      const headHtml = chainView
        ? `
        <div class="skill-test-case-card-head skill-test-case-card-head-chain">
          <div class="skill-test-case-card-head-main">
            <div class="skill-test-case-card-id">${escapeHtml(caseIdentity)}</div>
            ${buildChainRailHtml(chainView, { compact: true, currentCaseId: testCase.id })}
            <p class="skill-test-case-card-prompt">${escapeHtml(clipText(getCasePrompt(testCase), 120))}</p>
            <div class="skill-test-case-card-meta">${escapeHtml(loadingModeLabel)}</div>
          </div>
          <div class="skill-test-case-card-tags">${tagsHtml}</div>
        </div>
      `
        : `
        <div class="skill-test-case-card-head">
          <div>
            <div class="skill-test-case-card-id">${escapeHtml(caseIdentity)}</div>
            <div class="skill-test-case-card-meta">${escapeHtml(loadingModeLabel)}</div>
          </div>
          <div class="skill-test-case-card-tags">${tagsHtml}</div>
        </div>
        <p class="skill-test-case-card-prompt">${escapeHtml(clipText(getCasePrompt(testCase), 120))}</p>
      `;

      card.innerHTML = `
        ${headHtml}
        <div class="skill-test-case-card-meta">${escapeHtml(recentRunLabel)}</div>
        <div class="skill-test-case-card-meta">${escapeHtml(goalSummary)}</div>
        <div class="skill-test-case-card-meta">${escapeHtml(clipText(expectedToolsText, 120))}</div>
        ${environmentSummary ? `<div class="skill-test-case-card-meta">${escapeHtml(environmentSummary)}</div>` : ''}
        ${validationSummary ? `<div class="skill-test-case-card-meta">${escapeHtml(validationSummary)}</div>` : ''}
        <div class="skill-test-case-card-meta">${escapeHtml(latestSummary)}</div>
        ${calloutHtml}
      `;

      const actions = document.createElement('div');
      actions.className = 'skill-test-case-card-actions';

      const viewButton = document.createElement('button');
      viewButton.type = 'button';
      viewButton.className = 'mini-action';
      viewButton.textContent = '查看详情';
      viewButton.addEventListener('click', (event) => {
        event.stopPropagation();
        onSelectCase(testCase.id, { detailTab: 'overview', scrollIntoView: true });
      });

      const runButton = document.createElement('button');
      runButton.type = 'button';
      runButton.className = 'mini-action';
      runButton.textContent = isFailingRun(testCase.latestRun) ? '重试' : '运行';
      runButton.addEventListener('click', (event) => {
        event.stopPropagation();
        Promise.resolve(onRunCase(testCase, runButton)).catch(() => {});
      });

      const statusButton = document.createElement('button');
      statusButton.type = 'button';
      statusButton.className = 'mini-action';
      statusButton.textContent = testCase.caseStatus === 'ready'
        ? '改回 Draft'
        : (caseValidation.caseSchemaStatus === 'invalid' ? '修好后再 Ready' : '标记 Ready');
      statusButton.addEventListener('click', (event) => {
        event.stopPropagation();
        Promise.resolve(onToggleCaseStatus(testCase)).catch(() => {});
      });

      actions.appendChild(viewButton);
      actions.appendChild(runButton);
      actions.appendChild(statusButton);
      card.appendChild(actions);

      card.addEventListener('click', () => {
        onSelectCase(testCase.id, { detailTab: 'overview' });
      });

      return card;
    }

    return {
      renderCaseList,
    };
  };
})();
