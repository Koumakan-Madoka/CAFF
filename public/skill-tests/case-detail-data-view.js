// @ts-check

(function registerSkillTestCaseDetailDataView() {
  const skillTests = window.CaffSkillTests || (window.CaffSkillTests = {});
  const DETAIL_DATA_VIEW_CLEANUP_KEY = '__skillTestCaseDetailDataViewCleanup';

  skillTests.createCaseDetailDataViewHelpers = function createCaseDetailDataViewHelpers(deps = {}) {
    const previousCleanup = typeof skillTests[DETAIL_DATA_VIEW_CLEANUP_KEY] === 'function'
      ? skillTests[DETAIL_DATA_VIEW_CLEANUP_KEY]
      : null;
    if (previousCleanup) {
      previousCleanup();
    }

    const fetchJson = typeof deps.fetchJson === 'function'
      ? deps.fetchJson
      : async () => {
        throw new Error('Missing fetchJson');
      };
    const getSelectedSkillId = typeof deps.getSelectedSkillId === 'function'
      ? deps.getSelectedSkillId
      : () => '';
    const getSelectedCaseId = typeof deps.getSelectedCaseId === 'function'
      ? deps.getSelectedCaseId
      : () => '';
    const getActiveDetailTab = typeof deps.getActiveDetailTab === 'function'
      ? deps.getActiveDetailTab
      : () => 'overview';
    const findCaseById = typeof deps.findCaseById === 'function'
      ? deps.findCaseById
      : () => null;
    const getCaseChainRunRequest = typeof deps.getCaseChainRunRequest === 'function'
      ? deps.getCaseChainRunRequest
      : () => null;
    const renderCaseRuns = typeof deps.renderCaseRuns === 'function'
      ? deps.renderCaseRuns
      : () => {};
    const renderCaseRegression = typeof deps.renderCaseRegression === 'function'
      ? deps.renderCaseRegression
      : () => {};
    const renderRetryState = typeof deps.renderRetryState === 'function'
      ? deps.renderRetryState
      : () => {};
    const renderLoadingState = typeof deps.renderLoadingState === 'function'
      ? deps.renderLoadingState
      : (container, message) => {
        if (!container) return;
        container.innerHTML = `<p class="section-hint">${String(message || '')}</p>`;
      };
    const hasSelectedCaseLiveRun = typeof deps.hasSelectedCaseLiveRun === 'function'
      ? deps.hasSelectedCaseLiveRun
      : () => false;
    const hasSelectedCaseLiveChainRun = typeof deps.hasSelectedCaseLiveChainRun === 'function'
      ? deps.hasSelectedCaseLiveChainRun
      : () => false;
    const detailRunsElement = deps.detailRunsElement instanceof HTMLElement
      ? deps.detailRunsElement
      : null;
    const detailRegressionElement = deps.detailRegressionElement instanceof HTMLElement
      ? deps.detailRegressionElement
      : null;
    const RUNS_AUTO_REFRESH_MS = 2000;
    const RUNS_SSE_REFRESH_DEBOUNCE_MS = 350;
    let activeRunsRequestToken = 0;
    let runsAutoRefreshTimer = 0;
    let scheduledRunsRefreshTimer = 0;
    let destroyed = false;

    function clearRunsAutoRefreshTimer() {
      if (runsAutoRefreshTimer) {
        window.clearInterval(runsAutoRefreshTimer);
        runsAutoRefreshTimer = 0;
      }
    }

    function clearScheduledRunsRefreshTimer() {
      if (scheduledRunsRefreshTimer) {
        window.clearTimeout(scheduledRunsRefreshTimer);
        scheduledRunsRefreshTimer = 0;
      }
    }

    function destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      activeRunsRequestToken += 1;
      clearRunsAutoRefreshTimer();
      clearScheduledRunsRefreshTimer();
      if (skillTests[DETAIL_DATA_VIEW_CLEANUP_KEY] === destroy) {
        delete skillTests[DETAIL_DATA_VIEW_CLEANUP_KEY];
      }
    }

    skillTests[DETAIL_DATA_VIEW_CLEANUP_KEY] = destroy;

    function shouldRefreshSelectedCaseRuns(caseId, options = {}) {
      if (destroyed) {
        return false;
      }
      const normalizedCaseId = String(caseId || '').trim();
      const selectedCaseId = String(getSelectedCaseId() || '').trim();
      if (!normalizedCaseId || !selectedCaseId || normalizedCaseId !== selectedCaseId) {
        return false;
      }
      if (getActiveDetailTab() !== 'runs') {
        return false;
      }
      if (options.force === true) {
        return true;
      }
      return hasSelectedCaseLiveRun() || hasSelectedCaseLiveChainRun();
    }

    function syncLiveRunsAutoRefresh() {
      if (destroyed) {
        clearRunsAutoRefreshTimer();
        clearScheduledRunsRefreshTimer();
        return;
      }
      const selectedCaseId = String(getSelectedCaseId() || '').trim();
      if (!shouldRefreshSelectedCaseRuns(selectedCaseId)) {
        clearRunsAutoRefreshTimer();
        clearScheduledRunsRefreshTimer();
        return;
      }
      if (runsAutoRefreshTimer) {
        return;
      }
      runsAutoRefreshTimer = window.setInterval(() => {
        if (destroyed) {
          clearRunsAutoRefreshTimer();
          return;
        }
        const nextCaseId = String(getSelectedCaseId() || '').trim();
        if (!shouldRefreshSelectedCaseRuns(nextCaseId)) {
          syncLiveRunsAutoRefresh();
          return;
        }
        void loadCaseRuns(nextCaseId, { suppressLoadingState: true });
      }, RUNS_AUTO_REFRESH_MS);
    }

    function scheduleCaseRunsRefresh(caseId, options = {}) {
      if (destroyed) {
        return;
      }
      if (!shouldRefreshSelectedCaseRuns(caseId, options)) {
        if (options.force !== true) {
          syncLiveRunsAutoRefresh();
        }
        return;
      }
      clearScheduledRunsRefreshTimer();
      scheduledRunsRefreshTimer = window.setTimeout(() => {
        scheduledRunsRefreshTimer = 0;
        if (destroyed) {
          return;
        }
        const nextCaseId = String(getSelectedCaseId() || '').trim();
        if (!shouldRefreshSelectedCaseRuns(nextCaseId, options)) {
          syncLiveRunsAutoRefresh();
          return;
        }
        void loadCaseRuns(nextCaseId, { suppressLoadingState: true });
      }, RUNS_SSE_REFRESH_DEBOUNCE_MS);
    }

    async function loadCaseRuns(caseId, options = {}) {
      if (destroyed || !detailRunsElement) return;
      const skillId = getSelectedSkillId();
      if (!skillId) return;

      const normalizedCaseId = String(caseId || '').trim();
      const requestToken = ++activeRunsRequestToken;
      const suppressLoadingState = options && options.suppressLoadingState === true;
      if (!suppressLoadingState) {
        renderLoadingState(detailRunsElement, '加载运行记录中...');
      }
      const selectedCase = findCaseById(normalizedCaseId);
      const chainRunRequest = getCaseChainRunRequest(selectedCase);
      let chainRuns = [];

      if (chainRunRequest && chainRunRequest.exportChainId) {
        try {
          const chainData = await fetchJson(
            `/api/skills/${encodeURIComponent(skillId)}/test-chains/by-export/${encodeURIComponent(chainRunRequest.exportChainId)}/runs?limit=20`
          );
          if (destroyed || requestToken !== activeRunsRequestToken) {
            return;
          }
          chainRuns = Array.isArray(chainData.runs) ? chainData.runs : [];
        } catch (_chainRunsError) {
          chainRuns = [];
        }
      }

      try {
        const data = await fetchJson(
          `/api/skills/${encodeURIComponent(skillId)}/test-cases/${encodeURIComponent(normalizedCaseId)}/runs?limit=50`
        );
        if (destroyed || getSelectedCaseId() !== normalizedCaseId || requestToken !== activeRunsRequestToken) return;
        const runs = Array.isArray(data.runs) ? data.runs : [];
        renderCaseRuns(detailRunsElement, runs, { chainRuns, chainRunRequest });
      } catch (_runsError) {
        if (destroyed || getSelectedCaseId() !== normalizedCaseId || requestToken !== activeRunsRequestToken) return;
        renderRetryState(detailRunsElement, '加载运行记录失败，请重试。', () => {
          void loadCaseRuns(normalizedCaseId);
        });
      } finally {
        if (!destroyed && requestToken === activeRunsRequestToken) {
          syncLiveRunsAutoRefresh();
        }
      }
    }

    async function loadCaseRegression(caseId) {
      if (destroyed || !detailRegressionElement) return;
      const skillId = getSelectedSkillId();
      if (!skillId) return;

      renderLoadingState(detailRegressionElement, '加载回归对比中...');
      try {
        const data = await fetchJson(
          `/api/skills/${encodeURIComponent(skillId)}/test-cases/${encodeURIComponent(caseId)}/regression`
        );
        if (destroyed || getSelectedCaseId() !== caseId) return;
        renderCaseRegression(detailRegressionElement, Array.isArray(data.regression) ? data.regression : []);
      } catch (_regressionError) {
        if (destroyed || getSelectedCaseId() !== caseId) return;
        renderRetryState(detailRegressionElement, '加载回归对比失败，请重试。', () => {
          void loadCaseRegression(caseId);
        });
      }
    }

    return {
      destroy,
      loadCaseRegression,
      loadCaseRuns,
      scheduleCaseRunsRefresh,
      syncLiveRunsAutoRefresh,
    };
  };
})();
