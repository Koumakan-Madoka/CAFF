// @ts-check

(function registerSkillTestCaseDetailView() {
  const skillTests = window.CaffSkillTests || (window.CaffSkillTests = {});

  skillTests.createCaseDetailViewHelpers = function createCaseDetailViewHelpers(deps = {}) {
    const escapeHtml = typeof deps.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '');
    const clipText = typeof deps.clipText === 'function'
      ? deps.clipText
      : (value) => String(value || '');
    const getLoadingModeLabel = typeof deps.getLoadingModeLabel === 'function'
      ? deps.getLoadingModeLabel
      : (value) => String(value || '');
    const getCaseReadinessMeta = typeof deps.getCaseReadinessMeta === 'function'
      ? deps.getCaseReadinessMeta
      : () => ({ className: '', label: '' });
    const getLatestRunStatusMeta = typeof deps.getLatestRunStatusMeta === 'function'
      ? deps.getLatestRunStatusMeta
      : () => null;
    const getCaseSchemaStatusMeta = typeof deps.getCaseSchemaStatusMeta === 'function'
      ? deps.getCaseSchemaStatusMeta
      : () => null;
    const getCasePrompt = typeof deps.getCasePrompt === 'function'
      ? deps.getCasePrompt
      : () => '';
    const formatExpectedTools = typeof deps.formatExpectedTools === 'function'
      ? deps.formatExpectedTools
      : () => '未声明';
    const formatEnvironmentConfigSummary = typeof deps.formatEnvironmentConfigSummary === 'function'
      ? deps.formatEnvironmentConfigSummary
      : () => '未配置环境链；默认直接运行 skill。';
    const getCaseStatusMeta = typeof deps.getCaseStatusMeta === 'function'
      ? deps.getCaseStatusMeta
      : () => ({ className: '', label: '' });
    const getCaseStatusHelpText = typeof deps.getCaseStatusHelpText === 'function'
      ? deps.getCaseStatusHelpText
      : () => '';
    const renderStatusCallout = typeof deps.renderStatusCallout === 'function'
      ? deps.renderStatusCallout
      : () => {};
    const getCaseActionCallout = typeof deps.getCaseActionCallout === 'function'
      ? deps.getCaseActionCallout
      : () => null;
    const syncEnvironmentBuildRunUi = typeof deps.syncEnvironmentBuildRunUi === 'function'
      ? deps.syncEnvironmentBuildRunUi
      : () => {};
    const renderIssuePanel = typeof deps.renderIssuePanel === 'function'
      ? deps.renderIssuePanel
      : () => {};
    const readCaseValidation = typeof deps.readCaseValidation === 'function'
      ? deps.readCaseValidation
      : () => ({ issues: [], caseSchemaStatus: '', derivedFromLegacy: null });
    const getChainCaseView = typeof deps.getChainCaseView === 'function'
      ? deps.getChainCaseView
      : () => null;
    const buildChainRailHtml = typeof deps.buildChainRailHtml === 'function'
      ? deps.buildChainRailHtml
      : () => '';
    const isEnvironmentConfigEnabled = typeof deps.isEnvironmentConfigEnabled === 'function'
      ? deps.isEnvironmentConfigEnabled
      : () => false;
    const getCaseChainRunRequest = typeof deps.getCaseChainRunRequest === 'function'
      ? deps.getCaseChainRunRequest
      : () => null;
    const getChainStopPolicyLabel = typeof deps.getChainStopPolicyLabel === 'function'
      ? deps.getChainStopPolicyLabel
      : (value) => String(value || '');
    const readRunChainSettings = typeof deps.readRunChainSettings === 'function'
      ? deps.readRunChainSettings
      : () => ({ stopPolicy: 'stop_on_failure' });
    const getLastOutcomeSummary = typeof deps.getLastOutcomeSummary === 'function'
      ? deps.getLastOutcomeSummary
      : () => '先运行一条再看最近结果摘要。';

    function stringifyJsonPretty(value) {
      try {
        return JSON.stringify(value == null ? null : value, null, 2);
      } catch {
        return '';
      }
    }

    function buildSkillTestDesignSourceTags(testCase) {
      const sourceMetadata = testCase && testCase.sourceMetadata && typeof testCase.sourceMetadata === 'object'
        ? testCase.sourceMetadata
        : null;
      if (!sourceMetadata || sourceMetadata.source !== 'skill_test_chat_workbench') {
        return '';
      }

      const designMetadata = sourceMetadata.skillTestDesign && typeof sourceMetadata.skillTestDesign === 'object'
        ? sourceMetadata.skillTestDesign
        : {};
      const chainPlanning = designMetadata.chainPlanning && typeof designMetadata.chainPlanning === 'object'
        ? designMetadata.chainPlanning
        : null;
      const tags = [];
      const sourceTitle = [
        sourceMetadata.conversationId ? `conversation=${sourceMetadata.conversationId}` : '',
        sourceMetadata.messageId ? `message=${sourceMetadata.messageId}` : '',
        sourceMetadata.matrixId ? `matrix=${sourceMetadata.matrixId}` : '',
        sourceMetadata.matrixRowId ? `row=${sourceMetadata.matrixRowId}` : '',
      ].filter(Boolean).join(' · ');

      tags.push(`<span class="tag tag-pending" title="${escapeHtml(sourceTitle || 'Skill Test 聊天工作台导出')}">聊天导出</span>`);
      if (sourceMetadata.matrixId) {
        tags.push(`<span class="tag">matrix ${escapeHtml(clipText(sourceMetadata.matrixId, 24))}</span>`);
      }
      if (sourceMetadata.matrixRowId) {
        tags.push(`<span class="tag">row ${escapeHtml(clipText(sourceMetadata.matrixRowId, 24))}</span>`);
      }
      if (designMetadata.environmentSource) {
        tags.push(`<span class="tag">环境 ${escapeHtml(designMetadata.environmentSource)}</span>`);
      }
      if (chainPlanning && chainPlanning.chainId) {
        tags.push(`<span class="tag">链 ${escapeHtml(clipText(chainPlanning.chainId, 24))}</span>`);
      }
      return tags.join('');
    }

    function renderDetail(dom, testCase, options = {}) {
      if (!dom || !dom.detailPanel || !testCase) return;
      const onRenderLiveRun = typeof options.onRenderLiveRun === 'function'
        ? options.onRenderLiveRun
        : () => {};
      const onLoadCaseRuns = typeof options.onLoadCaseRuns === 'function'
        ? options.onLoadCaseRuns
        : () => {};
      const onLoadCaseRegression = typeof options.onLoadCaseRegression === 'function'
        ? options.onLoadCaseRegression
        : () => {};

      if (dom.detailEmpty) dom.detailEmpty.classList.add('hidden');
      dom.detailPanel.classList.remove('hidden');

      const caseValidation = readCaseValidation(testCase);
      const readinessMeta = getCaseReadinessMeta(testCase, caseValidation);
      const latestRunMeta = getLatestRunStatusMeta(testCase.latestRun);
      const schemaStatusMeta = getCaseSchemaStatusMeta(caseValidation.caseSchemaStatus);
      const sourceTags = buildSkillTestDesignSourceTags(testCase);

      if (dom.detailCaseId) dom.detailCaseId.textContent = testCase.id;
      if (dom.detailMeta) {
        dom.detailMeta.innerHTML = `
        <span class="tag">${escapeHtml(getLoadingModeLabel(testCase.loadingMode))}</span>
        <span class="tag ${readinessMeta.className}">${escapeHtml(readinessMeta.label)}</span>
        ${latestRunMeta ? `<span class="tag ${latestRunMeta.className}">${escapeHtml(latestRunMeta.label)}</span>` : ''}
        ${isEnvironmentConfigEnabled(testCase.environmentConfig) ? '<span class="tag">环境链</span>' : ''}
        ${schemaStatusMeta && caseValidation.caseSchemaStatus === 'warning' ? `<span class="tag ${schemaStatusMeta.className}">${escapeHtml(schemaStatusMeta.label)}</span>` : ''}
        ${caseValidation.derivedFromLegacy === true ? '<span class="tag tag-pending">Legacy 映射</span>' : ''}
        ${sourceTags}
        ${testCase.note ? `<span class="tag">${escapeHtml(clipText(testCase.note, 36))}</span>` : ''}
      `;
      }
      if (dom.detailLastOutcome) {
        dom.detailLastOutcome.textContent = getLastOutcomeSummary(testCase.latestRun);
      }
      if (dom.detailChainSummary) {
        const chainView = getChainCaseView(testCase);
        if (chainView) {
          dom.detailChainSummary.innerHTML = buildChainRailHtml(chainView, { compact: false, currentCaseId: testCase.id });
          dom.detailChainSummary.classList.remove('hidden');
        } else {
          dom.detailChainSummary.innerHTML = '';
          dom.detailChainSummary.classList.add('hidden');
        }
      }
      if (dom.detailPrompt) dom.detailPrompt.value = getCasePrompt(testCase);
      if (dom.detailGoal) dom.detailGoal.value = testCase.expectedGoal || '';
      if (dom.detailBehavior) dom.detailBehavior.value = testCase.expectedBehavior || '';
      if (dom.detailStepsJson) dom.detailStepsJson.value = stringifyJsonPretty(testCase.expectedSteps || []);
      if (dom.detailToolsJson) dom.detailToolsJson.value = stringifyJsonPretty(testCase.expectedTools || []);
      if (dom.detailSequenceJson) dom.detailSequenceJson.value = stringifyJsonPretty(testCase.expectedSequence || []);
      if (dom.detailRubricJson) dom.detailRubricJson.value = stringifyJsonPretty(testCase.evaluationRubric || {});
      if (dom.detailEnvironmentJson) dom.detailEnvironmentJson.value = testCase.environmentConfig ? stringifyJsonPretty(testCase.environmentConfig) : '';
      if (dom.detailNote) {
        dom.detailNote.value = testCase.note || '';
      }
      if (dom.detailExpectedBehavior) {
        dom.detailExpectedBehavior.textContent = testCase.expectedGoal || testCase.expectedBehavior || 'Dynamic 模式主要关注能否成功加载目标 skill。';
      }
      if (dom.detailExpectedTools) {
        dom.detailExpectedTools.textContent = formatExpectedTools(testCase.expectedTools);
      }
      if (dom.detailEnvironmentSummary) {
        dom.detailEnvironmentSummary.textContent = formatEnvironmentConfigSummary(testCase.environmentConfig, testCase.latestRun);
      }
      if (dom.detailValidity) {
        const validityMeta = getCaseStatusMeta(testCase.caseStatus);
        dom.detailValidity.className = 'tag ' + validityMeta.className;
        dom.detailValidity.textContent = validityMeta.label;
      }
      if (dom.detailValidityHelp) {
        dom.detailValidityHelp.textContent = getCaseStatusHelpText(testCase);
      }
      renderStatusCallout(dom.detailStatusCallout, getCaseActionCallout(testCase, caseValidation));
      if (dom.detailToggleStatusButton) {
        dom.detailToggleStatusButton.textContent = testCase.caseStatus === 'ready'
          ? '改回 Draft'
          : (caseValidation.caseSchemaStatus === 'invalid' ? '修好后再 Ready' : '标记 Ready');
      }
      syncEnvironmentBuildRunUi(testCase);
      if (dom.detailRunChainButton) {
        const chainRunRequest = getCaseChainRunRequest(testCase);
        if (chainRunRequest && chainRunRequest.exportChainId) {
          dom.detailRunChainButton.classList.remove('hidden');
          dom.detailRunChainButton.disabled = !chainRunRequest.eligible;
          dom.detailRunChainButton.textContent = chainRunRequest.chainCases.length > 1
            ? `按链运行 (${chainRunRequest.chainCases.length})`
            : '按链运行';
          dom.detailRunChainButton.title = chainRunRequest.eligible
            ? `当前链继续策略：${getChainStopPolicyLabel(readRunChainSettings().stopPolicy)}`
            : '只有 metadata 完整的 full + execution 链才支持按链运行';
        } else {
          dom.detailRunChainButton.classList.add('hidden');
          dom.detailRunChainButton.disabled = true;
          dom.detailRunChainButton.textContent = '按链运行';
          dom.detailRunChainButton.title = '';
        }
      }

      renderIssuePanel(dom.detailIssues, caseValidation.issues, '用例校验提示');
      onRenderLiveRun();
      onLoadCaseRuns(testCase.id);
      onLoadCaseRegression(testCase.id);
    }

    function hideDetail(dom, options = {}) {
      if (!dom) return;
      const switchDetailTab = typeof options.switchDetailTab === 'function'
        ? options.switchDetailTab
        : () => {};

      if (dom.detailPanel) {
        dom.detailPanel.classList.add('hidden');
      }
      if (dom.detailEmpty) {
        dom.detailEmpty.classList.remove('hidden');
      }
      if (dom.detailLastOutcome) {
        dom.detailLastOutcome.textContent = '先运行一条再看最近结果摘要。';
      }
      if (dom.detailChainSummary) {
        dom.detailChainSummary.innerHTML = '';
        dom.detailChainSummary.classList.add('hidden');
      }
      if (dom.detailEnvironmentSummary) {
        dom.detailEnvironmentSummary.textContent = '未配置环境链；默认直接运行 skill。';
      }
      if (dom.detailRegression) {
        dom.detailRegression.innerHTML = '<p class="section-hint">先运行几次，再看不同模型或 prompt version 的表现差异。</p>';
      }
      if (dom.liveRun) {
        dom.liveRun.innerHTML = '';
        dom.liveRun.classList.add('hidden');
      }
      if (dom.detailRuns) {
        dom.detailRuns.innerHTML = '<p class="section-hint">暂无运行记录</p>';
      }
      renderStatusCallout(dom.detailStatusCallout, null);
      renderIssuePanel(dom.detailIssues, []);
      if (dom.detailRunButton) {
        dom.detailRunButton.textContent = '运行测试';
        dom.detailRunButton.title = '';
      }
      syncEnvironmentBuildRunUi(null);
      if (dom.detailRunChainButton) {
        dom.detailRunChainButton.classList.add('hidden');
        dom.detailRunChainButton.disabled = true;
        dom.detailRunChainButton.textContent = '按链运行';
        dom.detailRunChainButton.title = '';
      }
      if (dom.detailEnvironmentJson) {
        dom.detailEnvironmentJson.value = '';
      }
      if (dom.detailToggleStatusButton) {
        dom.detailToggleStatusButton.textContent = '标记 Ready';
      }
      switchDetailTab('overview');
    }

    function renderCaseRegression(container, regression) {
      if (!container) return;
      if (!Array.isArray(regression) || regression.length === 0) {
        container.innerHTML = `
        <div class="empty-state compact-empty-state">
          <p class="section-hint">还没有足够的运行记录来做对比；先跑几次不同模型或 prompt version，再回来这里看回归差异。</p>
        </div>
      `;
        return;
      }

      let html = '<div class="table-scroll"><table class="summary-table"><thead><tr>';
      html += '<th>模型</th><th>Prompt Version</th><th>运行</th><th>加载成功</th><th>执行成功</th><th>目标达成</th><th>工具成功</th><th>最近运行</th>';
      html += '</tr></thead><tbody>';

      for (const entry of regression) {
        const modelLabel = [entry.provider, entry.model].filter(Boolean).join(' / ');
        const triggerRate = entry.triggerRate != null ? `${(entry.triggerRate * 100).toFixed(1)}%` : '—';
        const executionRate = entry.executionRate != null ? `${(entry.executionRate * 100).toFixed(1)}%` : '—';
        const goalAchievement = entry.avgGoalAchievement != null ? `${(entry.avgGoalAchievement * 100).toFixed(1)}%` : '—';
        const toolSuccess = entry.avgToolCallSuccessRate != null ? `${(entry.avgToolCallSuccessRate * 100).toFixed(1)}%` : '—';
        const lastRunAt = entry.lastRunAt ? new Date(entry.lastRunAt).toLocaleString() : '—';

        html += '<tr>';
        html += `<td>${escapeHtml(modelLabel || 'default')}</td>`;
        html += `<td>${escapeHtml(entry.promptVersion || 'skill-test-v1')}</td>`;
        html += `<td>${Number(entry.totalRuns || 0)}</td>`;
        html += `<td>${escapeHtml(triggerRate)}</td>`;
        html += `<td>${escapeHtml(executionRate)}</td>`;
        html += `<td>${escapeHtml(goalAchievement)}</td>`;
        html += `<td>${escapeHtml(toolSuccess)}</td>`;
        html += `<td>${escapeHtml(lastRunAt)}</td>`;
        html += '</tr>';
      }

      html += '</tbody></table></div>';
      container.innerHTML = html;
    }

    return {
      hideDetail,
      renderCaseRegression,
      renderDetail,
    };
  };
})();
