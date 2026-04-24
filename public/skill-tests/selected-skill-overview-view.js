// @ts-check

(function registerSkillTestSelectedSkillOverviewView() {
  const skillTests = window.CaffSkillTests || (window.CaffSkillTests = {});

  skillTests.createSelectedSkillOverviewViewHelpers = function createSelectedSkillOverviewViewHelpers(deps = {}) {
    const escapeHtml = typeof deps.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '');
    const formatRefreshTime = typeof deps.formatRefreshTime === 'function'
      ? deps.formatRefreshTime
      : () => '';
    const renderStatusCallout = typeof deps.renderStatusCallout === 'function'
      ? deps.renderStatusCallout
      : () => {};
    const isFailingRun = typeof deps.isFailingRun === 'function'
      ? deps.isFailingRun
      : () => false;
    const readCaseValidation = typeof deps.readCaseValidation === 'function'
      ? deps.readCaseValidation
      : () => ({ caseSchemaStatus: '', derivedFromLegacy: false });
    const getSkillTestChainPlanningMeta = typeof deps.getSkillTestChainPlanningMeta === 'function'
      ? deps.getSkillTestChainPlanningMeta
      : () => ({ exportChainId: '', sequenceIndex: null });

    function isChainCase(testCase) {
      const chainMeta = getSkillTestChainPlanningMeta(testCase);
      return Boolean(chainMeta && chainMeta.exportChainId && chainMeta.sequenceIndex != null);
    }

    function renderSelectedSkillOverview(elements = {}, overviewState = {}) {
      const selectedHighlights = elements.selectedHighlights instanceof HTMLElement
        ? elements.selectedHighlights
        : null;
      const selectedSummaryElement = elements.selectedSummary instanceof HTMLElement
        ? elements.selectedSummary
        : null;
      const selectedStatusCallout = elements.selectedStatusCallout instanceof HTMLElement
        ? elements.selectedStatusCallout
        : null;
      if (!selectedHighlights || !selectedSummaryElement) {
        return;
      }

      const selectedSkillId = String(overviewState.selectedSkillId || '').trim();
      const testCases = Array.isArray(overviewState.testCases) ? overviewState.testCases : [];
      const casesLoading = overviewState.casesLoading === true;
      const casesLoadError = String(overviewState.casesLoadError || '').trim();
      const casesRefreshLabel = formatRefreshTime(overviewState.casesLastLoadedAt);
      const summary = Array.isArray(overviewState.summary) ? overviewState.summary : [];
      const summaryRefreshLabel = formatRefreshTime(overviewState.summaryLastLoadedAt);
      const environmentAssets = Array.isArray(overviewState.environmentAssets) ? overviewState.environmentAssets : [];
      const environmentAssetsLoadError = String(overviewState.environmentAssetsLoadError || '').trim();
      const environmentAssetsRefreshLabel = formatRefreshTime(overviewState.environmentAssetsLastLoadedAt);
      const searchQuery = String(overviewState.searchQuery || '').trim();
      const validityFilter = String(overviewState.validityFilter || 'all').trim() || 'all';
      const chainFilter = String(overviewState.chainFilter || 'all').trim() || 'all';
      const filteredCaseCount = Number(overviewState.filteredCaseCount || 0);
      const runSettings = overviewState.runSettings && typeof overviewState.runSettings === 'object'
        ? overviewState.runSettings
        : { isolationMode: 'isolated', trellisMode: 'none', egressMode: 'deny' };
      const runLabels = overviewState.runLabels && typeof overviewState.runLabels === 'object'
        ? overviewState.runLabels
        : {};
      const runModeLabel = String(runLabels.isolationModeLabel || runSettings.isolationMode || '').trim();
      const trellisModeLabel = String(runLabels.trellisModeLabel || runSettings.trellisMode || '').trim();
      const egressModeLabel = String(runLabels.egressModeLabel || runSettings.egressMode || '').trim();

      if (!selectedSkillId) {
        selectedHighlights.innerHTML = '<span class="tag tag-pending">先选一个 Skill</span>';
        selectedSummaryElement.textContent = '这里会显示当前 Skill 的用例数量、草稿/Ready 分布、刷新状态和下一步建议。';
        renderStatusCallout(selectedStatusCallout, {
          tone: 'pending',
          label: '先选一个 Skill',
          message: '先在顶部选择 Skill，下面的列表、详情和概览建议才会一起联动。',
        });
        return;
      }

      if (casesLoading && testCases.length === 0) {
        selectedHighlights.innerHTML = '<span class="tag tag-pending">正在加载当前 Skill 用例...</span>';
        selectedSummaryElement.textContent = '正在拉取这个 Skill 的用例、状态和最近表现。';
        renderStatusCallout(selectedStatusCallout, {
          tone: 'pending',
          label: '正在刷新当前 Skill',
          message: '正在同步这组 case 的列表、状态和最近结果；等一会儿就能继续巡检。',
        });
        return;
      }

      if (casesLoadError && testCases.length === 0) {
        selectedHighlights.innerHTML = '<span class="tag tag-error">用例加载失败</span>';
        selectedSummaryElement.textContent = casesLoadError;
        renderStatusCallout(selectedStatusCallout, {
          tone: 'error',
          label: '先重试刷新',
          message: '当前 Skill 的用例还没拉下来；先点重试拿到列表，再继续看详情或批量运行。',
        });
        return;
      }

      const totalCases = testCases.length;
      const draftCount = testCases.filter((testCase) => testCase.caseStatus === 'draft').length;
      const readyCount = testCases.filter((testCase) => testCase.caseStatus === 'ready').length;
      const archivedCount = testCases.filter((testCase) => testCase.caseStatus === 'archived').length;
      const chainCases = testCases.filter((testCase) => isChainCase(testCase));
      const chainCaseCount = chainCases.length;
      const chainGroupCount = new Set(
        chainCases
          .map((testCase) => {
            const chainMeta = getSkillTestChainPlanningMeta(testCase);
            return chainMeta && chainMeta.exportChainId ? chainMeta.exportChainId : '';
          })
          .filter(Boolean)
      ).size;
      const recentFailing = testCases.filter((testCase) => isFailingRun(testCase.latestRun || null)).length;
      const neverRunCount = testCases.filter((testCase) => !testCase.latestRun).length;
      const caseValidations = testCases.map((testCase) => readCaseValidation(testCase));
      const invalidCount = caseValidations.filter((validation) => validation.caseSchemaStatus === 'invalid').length;
      const warningCount = caseValidations.filter((validation) => validation.caseSchemaStatus === 'warning').length;
      const legacyCount = caseValidations.filter((validation) => validation.derivedFromLegacy === true).length;
      const selectedSummaryEntry = summary.find((entry) => entry.skillId === selectedSkillId) || null;
      const triggerRate = selectedSummaryEntry && selectedSummaryEntry.triggerRate != null
        ? `${Math.round(selectedSummaryEntry.triggerRate * 100)}%`
        : '—';
      const executionRate = selectedSummaryEntry && selectedSummaryEntry.executionRate != null
        ? `${Math.round(selectedSummaryEntry.executionRate * 100)}%`
        : '—';
      const readyEnvironmentAssets = environmentAssets.filter((entry) => entry && entry.asset && entry.asset.image).length;
      const manifestOnlyEnvironmentAssets = environmentAssets.filter((entry) => entry && (!entry.asset || !entry.asset.image)).length;
      const listRefreshTag = casesLoading
        ? '<span class="tag tag-pending">列表刷新中...</span>'
        : (casesLoadError ? '<span class="tag tag-error">列表刷新失败</span>' : '');

      selectedHighlights.innerHTML = [
        `<span class="tag">共 ${totalCases} 条</span>`,
        `<span class="tag tag-pending">Draft ${draftCount}</span>`,
        `<span class="tag tag-success">Ready ${readyCount}</span>`,
        `<span class="tag">Archived ${archivedCount}</span>`,
        chainCaseCount > 0 ? `<span class="tag">链步 ${chainCaseCount}</span>` : '',
        chainGroupCount > 0 ? `<span class="tag">链 ${chainGroupCount}</span>` : '',
        runModeLabel ? `<span class="tag">${escapeHtml(runModeLabel)}</span>` : '',
        runSettings.isolationMode === 'isolated'
          ? (trellisModeLabel ? `<span class="tag">${escapeHtml(trellisModeLabel)}</span>` : '')
          : '<span class="tag tag-pending">非隔离 host 运行</span>',
        runSettings.isolationMode === 'isolated' && egressModeLabel ? `<span class="tag">${escapeHtml(egressModeLabel)}</span>` : '',
        `<span class="tag">可批量运行 ${readyCount}</span>`,
        readyEnvironmentAssets > 0 ? `<span class="tag tag-success">环境资产 ${readyEnvironmentAssets}</span>` : '',
        manifestOnlyEnvironmentAssets > 0 ? `<span class="tag tag-pending">待 build 资产 ${manifestOnlyEnvironmentAssets}</span>` : '',
        environmentAssetsLoadError ? '<span class="tag tag-error">环境资产刷新失败</span>' : '',
        environmentAssetsRefreshLabel ? `<span class="tag">环境资产更新 ${escapeHtml(environmentAssetsRefreshLabel)}</span>` : '',
        `<span class="tag">最近失败 ${recentFailing}</span>`,
        neverRunCount > 0 ? `<span class="tag">未运行 ${neverRunCount}</span>` : '',
        invalidCount > 0 ? `<span class="tag tag-error">结构异常 ${invalidCount}</span>` : '',
        warningCount > 0 ? `<span class="tag tag-pending">结构提示 ${warningCount}</span>` : '',
        legacyCount > 0 ? `<span class="tag">Legacy ${legacyCount}</span>` : '',
        casesRefreshLabel ? `<span class="tag">列表更新 ${escapeHtml(casesRefreshLabel)}</span>` : '',
        summaryRefreshLabel ? `<span class="tag">概览更新 ${escapeHtml(summaryRefreshLabel)}</span>` : '',
        listRefreshTag,
      ].filter(Boolean).join('');

      const filterHint = searchQuery || validityFilter !== 'all' || chainFilter !== 'all'
        ? `当前筛选后显示 ${filteredCaseCount} 条；`
        : '';
      const refreshHint = casesLoadError
        ? `最近一次列表刷新失败，当前仍显示${casesRefreshLabel ? `${casesRefreshLabel} 的` : '上一次成功加载的'}结果；`
        : (casesRefreshLabel ? `列表最近一次成功刷新在 ${casesRefreshLabel}；` : '');
      const summaryHint = summaryRefreshLabel ? `全局概览更新在 ${summaryRefreshLabel}；` : '';
      const environmentAssetsHint = environmentAssetsLoadError
        ? '共享环境资产刷新失败；'
        : environmentAssets.length > 0
          ? `共享环境资产 ${readyEnvironmentAssets} 个可直接复用${manifestOnlyEnvironmentAssets > 0 ? `，${manifestOnlyEnvironmentAssets} 个还只有 manifest` : ''}；`
          : '';
      const chainHint = chainCaseCount > 0
        ? `当前有 ${chainCaseCount} 个链式 step，分布在 ${chainGroupCount} 条链里；`
        : '';
      const runDefaultsHint = runSettings.isolationMode === 'isolated'
        ? `当前运行默认 ${runModeLabel || runSettings.isolationMode} / ${trellisModeLabel || runSettings.trellisMode} / ${egressModeLabel || runSettings.egressMode}；`
        : '当前运行默认 legacy-local，仅适合本地调试，不能作为隔离证据；';
      const nextStep = totalCases === 0
        ? '下一步：先 AI 生成或手动创建第一条用例。'
        : invalidCount > 0
          ? `下一步：先修 ${invalidCount} 条结构异常 case，再标记 Ready 或运行。`
          : readyCount === 0
            ? '下一步：先把检查通过的 draft 标记为 Ready，再试单条或批量运行。'
            : recentFailing > 0
              ? `下一步：优先重试 ${recentFailing} 条最近失败 case，直接看失败原因。`
              : neverRunCount > 0
                ? `下一步：还有 ${neverRunCount} 条没跑过的 case，可以先单条跑一轮。`
                : '下一步：可以继续批量运行 Ready 用例，或者切到回归对比看模型差异。';
      selectedSummaryElement.textContent = `${runDefaultsHint}${refreshHint}${summaryHint}${environmentAssetsHint}${chainHint}${filterHint}当前 Skill 的加载成功率 ${triggerRate}，执行通过率 ${executionRate}。${nextStep}`;

      let overviewCallout = null;
      if (totalCases === 0) {
        overviewCallout = {
          tone: 'pending',
          label: '先创建第一条 case',
          message: '这个 Skill 还没有测试用例；先 AI 生成或手动创建，再继续跑列表和详情。',
        };
      } else if (invalidCount > 0) {
        overviewCallout = {
          tone: 'error',
          label: '先修结构异常',
          message: `当前有 ${invalidCount} 条 case 结构没过；先修 JSON / Rubric / 顺序字段，再标记 Ready 或运行。`,
        };
      } else if (recentFailing > 0) {
        overviewCallout = {
          tone: 'error',
          label: '优先看失败 case',
          message: `当前有 ${recentFailing} 条最近失败；可直接从列表点重试，或打开详情看失败原因和运行校验提示。`,
        };
      } else if (casesLoadError) {
        overviewCallout = {
          tone: 'warning',
          label: '当前先看已加载结果',
          message: `列表刷新失败，当前仍显示${casesRefreshLabel ? `${casesRefreshLabel} 的` : '上一次成功加载的'}结果；需要最新状态时点重试。`,
        };
      } else if (readyCount === 0) {
        overviewCallout = {
          tone: 'pending',
          label: '先把 Draft 变 Ready',
          message: '当前还没有可批量运行的 case；先确认详情内容，再把通过检查的 draft 标成 Ready。',
        };
      } else if (neverRunCount > 0) {
        overviewCallout = {
          tone: 'success',
          label: '可以先跑一轮',
          message: `还有 ${neverRunCount} 条 case 没跑过；先单条跑一轮，会更容易找到失败原因。`,
        };
      } else {
        overviewCallout = {
          tone: 'success',
          label: '继续巡检',
          message: '列表和概览都已就绪；可以继续批量运行 Ready 用例，或者切到回归对比看模型差异。',
        };
      }
      renderStatusCallout(selectedStatusCallout, overviewCallout);
    }

    return {
      renderSelectedSkillOverview,
    };
  };
})();
