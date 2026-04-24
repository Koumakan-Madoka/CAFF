// @ts-check

(function registerSkillTestSummaryView() {
  const skillTests = window.CaffSkillTests || (window.CaffSkillTests = {});

  skillTests.createSummaryViewHelpers = function createSummaryViewHelpers(deps = {}) {
    const escapeHtml = typeof deps.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '');
    const formatRefreshTime = typeof deps.formatRefreshTime === 'function'
      ? deps.formatRefreshTime
      : () => '';
    const renderRetryState = typeof deps.renderRetryState === 'function'
      ? deps.renderRetryState
      : () => {};
    const renderLoadingState = typeof deps.renderLoadingState === 'function'
      ? deps.renderLoadingState
      : () => {};
    const buildCompactEmptyStateHtml = typeof deps.buildCompactEmptyStateHtml === 'function'
      ? deps.buildCompactEmptyStateHtml
      : (message) => `<p class="section-hint">${escapeHtml(message)}</p>`;
    const buildInlineBannerHtml = typeof deps.buildInlineBannerHtml === 'function'
      ? deps.buildInlineBannerHtml
      : () => '';

    function renderSummary(elements = {}, summaryState = {}, options = {}) {
      const summaryBody = elements.summaryBody instanceof HTMLElement
        ? elements.summaryBody
        : null;
      const summaryHighlights = elements.summaryHighlights instanceof HTMLElement
        ? elements.summaryHighlights
        : null;
      const onRenderSelectedSkillOverview = typeof options.onRenderSelectedSkillOverview === 'function'
        ? options.onRenderSelectedSkillOverview
        : () => {};
      const onRetry = typeof options.onRetry === 'function'
        ? options.onRetry
        : () => {};

      if (!summaryBody) {
        return;
      }

      onRenderSelectedSkillOverview();

      const summary = Array.isArray(summaryState.summary) ? summaryState.summary : [];
      const summaryLoading = summaryState.summaryLoading === true;
      const summaryLoadError = String(summaryState.summaryLoadError || '').trim();
      const summaryRefreshLabel = formatRefreshTime(summaryState.summaryLastLoadedAt);

      if (summaryLoading && summary.length === 0) {
        if (summaryHighlights) {
          summaryHighlights.innerHTML = '<span class="tag tag-pending">正在加载 Skill 测试概览...</span>';
        }
        renderLoadingState(summaryBody, '加载中...');
        return;
      }
      if (summaryLoadError && summary.length === 0) {
        if (summaryHighlights) {
          summaryHighlights.innerHTML = '<span class="tag tag-error">Skill 概览加载失败</span>';
        }
        renderRetryState(summaryBody, summaryLoadError, onRetry);
        return;
      }
      if (summary.length === 0) {
        if (summaryHighlights) {
          summaryHighlights.innerHTML = '<span class="tag tag-pending">还没有可展示的 skill 测试结果</span>';
        }
        summaryBody.innerHTML = buildCompactEmptyStateHtml('暂无测试数据；先选一个 Skill 生成或手动创建用例，再回来这里看整体概览。');
        return;
      }

      const totals = summary.reduce((acc, entry) => {
        acc.totalCases += Number(entry.totalCases || 0);
        acc.totalRuns += Number(entry.totalRuns || 0);
        acc.draft += Number((entry.casesByStatus && entry.casesByStatus.draft) || 0);
        acc.ready += Number((entry.casesByStatus && entry.casesByStatus.ready) || 0);
        acc.archived += Number((entry.casesByStatus && entry.casesByStatus.archived) || 0);
        acc.triggerPassed += Number(entry.triggerPassedCount || 0);
        acc.executionPassed += Number(entry.executionPassedCount || 0);
        return acc;
      }, { totalCases: 0, totalRuns: 0, draft: 0, ready: 0, archived: 0, triggerPassed: 0, executionPassed: 0 });

      if (summaryHighlights) {
        const triggerRate = totals.totalRuns > 0 ? Math.round((totals.triggerPassed / totals.totalRuns) * 100) : 0;
        const executionRate = totals.totalRuns > 0 ? Math.round((totals.executionPassed / totals.totalRuns) * 100) : 0;
        const refreshTag = summaryRefreshLabel ? `<span class="tag">最近刷新 ${escapeHtml(summaryRefreshLabel)}</span>` : '';
        const loadingTag = summaryLoading
          ? '<span class="tag tag-pending">概览刷新中...</span>'
          : (summaryLoadError ? '<span class="tag tag-error">概览刷新失败</span>' : '');
        summaryHighlights.innerHTML = `
          <span class="tag">共 ${totals.totalCases} 条用例</span>
          <span class="tag tag-pending">Draft ${totals.draft}</span>
          <span class="tag tag-success">Ready ${totals.ready}</span>
          <span class="tag">Archived ${totals.archived}</span>
          <span class="tag">加载成功率 ${triggerRate}%</span>
          <span class="tag">执行通过率 ${executionRate || 0}%</span>
          ${refreshTag}
          ${loadingTag}
        `;
      }

      let html = '';
      if (summaryLoadError) {
        html += buildInlineBannerHtml({
          tone: 'error',
          message: `概览刷新失败，当前仍显示${summaryRefreshLabel ? `${summaryRefreshLabel} 的` : '上一次成功加载的'}结果。`,
          actionsHtml: `
            <div class="panel-actions">
              <button class="ghost-button" type="button" data-st-summary-retry="true">重试</button>
            </div>
          `,
        });
      } else if (summaryLoading) {
        html += buildInlineBannerHtml({
          tone: 'pending',
          message: summaryRefreshLabel
            ? `概览刷新中，当前先显示 ${summaryRefreshLabel} 的结果。`
            : '概览刷新中，你可以先查看已加载结果。',
        });
      }
      html += '<div class="table-scroll"><table class="summary-table"><thead><tr>';
      html += '<th>Skill</th><th>用例</th><th>运行</th>';
      html += '<th>状态</th><th>加载成功</th><th>执行通过</th><th>目标达成</th><th>工具成功</th>';
      html += '</tr></thead><tbody>';

      for (const entry of summary) {
        const triggerRate = entry.triggerRate != null ? (entry.triggerRate * 100).toFixed(1) + '%' : '—';
        const execRate = entry.executionRate != null ? (entry.executionRate * 100).toFixed(1) + '%' : '—';
        const goalAchievement = entry.avgGoalAchievement != null ? (entry.avgGoalAchievement * 100).toFixed(1) + '%' : '—';
        const toolSuccess = entry.avgToolCallSuccessRate != null ? (entry.avgToolCallSuccessRate * 100).toFixed(1) + '%' : '—';
        const draftCount = Number((entry.casesByStatus && entry.casesByStatus.draft) || 0);
        const readyCount = Number((entry.casesByStatus && entry.casesByStatus.ready) || 0);
        const archivedCount = Number((entry.casesByStatus && entry.casesByStatus.archived) || 0);

        html += '<tr>';
        html += `<td>${escapeHtml(entry.skillId)}</td>`;
        html += `<td>${entry.totalCases}</td>`;
        html += `<td>${entry.totalRuns}</td>`;
        html += `<td>Draft ${draftCount} / Ready ${readyCount} / Archived ${archivedCount}</td>`;
        html += `<td>${triggerRate}</td>`;
        html += `<td>${execRate}</td>`;
        html += `<td>${goalAchievement}</td>`;
        html += `<td>${toolSuccess}</td>`;
        html += '</tr>';
      }

      html += '</tbody></table></div>';
      summaryBody.innerHTML = html;
      const retryButton = summaryBody.querySelector('[data-st-summary-retry="true"]');
      if (retryButton) {
        retryButton.addEventListener('click', onRetry);
      }
    }

    return {
      renderSummary,
    };
  };
})();
