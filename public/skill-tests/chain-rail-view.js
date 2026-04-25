// @ts-check

(function registerSkillTestChainRailView() {
  const skillTests = window.CaffSkillTests || (window.CaffSkillTests = {});

  skillTests.createChainRailViewHelpers = function createChainRailViewHelpers(deps = {}) {
    const getSkillTestChainPlanningMeta = typeof deps.getSkillTestChainPlanningMeta === 'function'
      ? deps.getSkillTestChainPlanningMeta
      : () => ({ exportChainId: '', sequenceIndex: null, chainId: '' });
    const getChainCasesForExportChain = typeof deps.getChainCasesForExportChain === 'function'
      ? deps.getChainCasesForExportChain
      : () => [];
    const getLiveRunForCaseId = typeof deps.getLiveRunForCaseId === 'function'
      ? deps.getLiveRunForCaseId
      : () => null;
    const isFailingRun = typeof deps.isFailingRun === 'function'
      ? deps.isFailingRun
      : () => false;
    const isPassedFlag = typeof deps.isPassedFlag === 'function'
      ? deps.isPassedFlag
      : () => false;
    const clipText = typeof deps.clipText === 'function'
      ? deps.clipText
      : (value) => String(value || '');
    const escapeHtml = typeof deps.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '');
    const getCasePrompt = typeof deps.getCasePrompt === 'function'
      ? deps.getCasePrompt
      : () => '';

    function getCaseId(testCase) {
      return String(testCase && testCase.id || '').trim();
    }

    function normalizeChainCases(chainCases) {
      if (!Array.isArray(chainCases)) {
        return [];
      }
      const seenCaseIds = new Set();
      return chainCases.filter((testCase) => {
        if (!testCase) {
          return false;
        }
        const caseId = getCaseId(testCase);
        if (!caseId) {
          return true;
        }
        if (seenCaseIds.has(caseId)) {
          return false;
        }
        seenCaseIds.add(caseId);
        return true;
      });
    }

    function buildChainDisplayIndexMap(chainCases) {
      const displayIndexByCaseId = new Map();
      normalizeChainCases(chainCases).forEach((testCase, index) => {
        const caseId = getCaseId(testCase);
        if (caseId && !displayIndexByCaseId.has(caseId)) {
          displayIndexByCaseId.set(caseId, index + 1);
        }
      });
      return displayIndexByCaseId;
    }

    function isChainCase(testCase) {
      const chainMeta = getSkillTestChainPlanningMeta(testCase);
      return Boolean(chainMeta.exportChainId && chainMeta.sequenceIndex != null);
    }

    function getChainCaseView(testCase) {
      if (!testCase) {
        return null;
      }
      const chainMeta = getSkillTestChainPlanningMeta(testCase);
      if (!chainMeta.exportChainId || chainMeta.sequenceIndex == null) {
        return null;
      }
      const normalizedChainCases = normalizeChainCases(getChainCasesForExportChain(chainMeta.exportChainId));
      const chainCases = normalizedChainCases.length > 0 ? normalizedChainCases : [testCase];
      const currentCaseId = getCaseId(testCase);
      const currentPosition = currentCaseId
        ? chainCases.findIndex((entry) => getCaseId(entry) === currentCaseId)
        : -1;
      const fallbackCurrentIndex = Math.max(chainMeta.sequenceIndex || 1, 1);
      const currentIndex = currentPosition >= 0 ? currentPosition + 1 : fallbackCurrentIndex;
      const totalSteps = Math.max(chainCases.length, currentIndex, 1);
      return {
        chainMeta,
        chainCases,
        totalSteps,
        currentIndex,
        rawCurrentIndex: fallbackCurrentIndex,
        chainLabel: chainMeta.chainId || chainMeta.exportChainId || '未命名链',
      };
    }

    function getChainRailNodeState(testCase, currentCaseId) {
      const isCurrent = Boolean(currentCaseId) && Boolean(testCase) && testCase.id === currentCaseId;
      const liveRun = testCase && testCase.id ? getLiveRunForCaseId(testCase.id) : null;
      const latestRun = testCase && testCase.latestRun ? testCase.latestRun : null;
      if (liveRun) {
        const liveStatus = String(liveRun.status || liveRun.phase || '').trim().toLowerCase();
        if (liveStatus === 'failed' || liveStatus === 'error') {
          return { tone: 'failed', isCurrent };
        }
        if (liveStatus === 'completed' || liveStatus === 'succeeded') {
          return { tone: 'passed', isCurrent };
        }
        return { tone: 'running', isCurrent };
      }
      if (latestRun) {
        const runStatus = String(latestRun.status || '').trim().toLowerCase();
        if (runStatus === 'running' || runStatus === 'pending') {
          return { tone: 'running', isCurrent };
        }
        if (isFailingRun(latestRun)) {
          return { tone: 'failed', isCurrent };
        }
        if (String(latestRun.verdict || '').trim().toLowerCase() === 'borderline') {
          return { tone: 'review', isCurrent };
        }
        if (
          String(latestRun.verdict || '').trim().toLowerCase() === 'pass'
          || isPassedFlag(latestRun.executionPassed)
          || isPassedFlag(latestRun.triggerPassed)
        ) {
          return { tone: 'passed', isCurrent };
        }
      }
      return { tone: 'idle', isCurrent };
    }

    function getChainRailDescriptors(chainView, options = {}) {
      const compact = options.compact !== false;
      const chainCases = Array.isArray(chainView && chainView.chainCases) ? chainView.chainCases.filter(Boolean) : [];
      if (chainCases.length === 0) {
        return [];
      }
      if (!compact || chainCases.length <= 4) {
        return chainCases.map((testCase) => ({ kind: 'step', testCase }));
      }
      const currentPosition = Math.min(Math.max(Number(chainView.currentIndex || 1) - 1, 0), chainCases.length - 1);
      const firstCase = chainCases[0];
      const lastCase = chainCases[chainCases.length - 1];
      if (currentPosition > 0 && currentPosition < chainCases.length - 1) {
        return [
          { kind: 'step', testCase: firstCase },
          { kind: 'gap', label: '…', count: Math.max(currentPosition - 1, 0) },
          { kind: 'step', testCase: chainCases[currentPosition] },
          { kind: 'step', testCase: lastCase },
        ];
      }
      return [
        { kind: 'step', testCase: firstCase },
        { kind: 'gap', label: `+${Math.max(chainCases.length - 2, 0)}`, count: Math.max(chainCases.length - 2, 0) },
        { kind: 'step', testCase: lastCase },
      ];
    }

    function buildChainRailHtml(chainView, options = {}) {
      if (!chainView) {
        return '';
      }
      const compact = options.compact !== false;
      const currentCaseId = options.currentCaseId ? String(options.currentCaseId) : '';
      const descriptors = getChainRailDescriptors(chainView, { compact });
      const displayIndexByCaseId = buildChainDisplayIndexMap(chainView.chainCases);
      const summaryText = `第 ${chainView.currentIndex} / ${chainView.totalSteps} 步 · ${clipText(chainView.chainLabel, compact ? 30 : 52)}`;
      const ariaLabel = `链式用例，${chainView.chainLabel}，第 ${chainView.currentIndex} / ${chainView.totalSteps} 步`;
      const content = descriptors.map((descriptor, index) => {
        const isLast = index === descriptors.length - 1;
        if (descriptor.kind === 'gap') {
          const gapHtml = `<span class="skill-test-case-chain-gap" title="已折叠 ${escapeHtml(String(descriptor.count || 0))} 步">${escapeHtml(String(descriptor.label || '…'))}</span>`;
          return `${gapHtml}${isLast ? '' : '<span class="skill-test-case-chain-line"></span>'}`;
        }
        const meta = getSkillTestChainPlanningMeta(descriptor.testCase);
        const nodeState = getChainRailNodeState(descriptor.testCase, currentCaseId);
        const caseId = getCaseId(descriptor.testCase);
        const displayIndex = caseId && displayIndexByCaseId.has(caseId)
          ? displayIndexByCaseId.get(caseId)
          : (meta.sequenceIndex || '—');
        const promptTitle = clipText(getCasePrompt(descriptor.testCase), 80);
        const title = meta.sequenceIndex && meta.sequenceIndex !== displayIndex
          ? `${promptTitle} · metadata #${meta.sequenceIndex}`
          : promptTitle;
        const nodeHtml = `<span class="skill-test-case-chain-node is-${nodeState.tone}${nodeState.isCurrent ? ' is-current' : ''}" title="${escapeHtml(title)}">#${escapeHtml(String(displayIndex))}</span>`;
        return `${nodeHtml}${isLast ? '' : '<span class="skill-test-case-chain-line"></span>'}`;
      }).join('');
      return `
      <div class="skill-test-case-chain-visual${compact ? ' compact' : ''}">
        <div class="skill-test-case-chain-summary">
          <span class="skill-test-case-chain-badge">Chain</span>
          <span class="skill-test-case-chain-summary-text">${escapeHtml(summaryText)}</span>
        </div>
        <div class="skill-test-case-chain-rail" role="img" aria-label="${escapeHtml(ariaLabel)}">${content}</div>
      </div>`;
    }

    return {
      isChainCase,
      getChainCaseView,
      getChainRailNodeState,
      getChainRailDescriptors,
      buildChainRailHtml,
    };
  };
})();
