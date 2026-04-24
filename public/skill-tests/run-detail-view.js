// @ts-check

(function registerSkillTestRunDetailView() {
  const skillTests = window.CaffSkillTests || (window.CaffSkillTests = {});

  skillTests.createRunDetailViewHelpers = function createRunDetailViewHelpers(deps = {}) {
    const escapeHtml = typeof deps.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '');
    const rebuildLiveRunTrace = typeof deps.rebuildLiveRunTrace === 'function'
      ? deps.rebuildLiveRunTrace
      : (trace) => trace || {};
    const buildToolTraceStepsHtml = typeof deps.buildToolTraceStepsHtml === 'function'
      ? deps.buildToolTraceStepsHtml
      : () => '';
    const liveRunTone = typeof deps.liveRunTone === 'function'
      ? deps.liveRunTone
      : () => 'neutral';
    const liveRunStatusLabel = typeof deps.liveRunStatusLabel === 'function'
      ? deps.liveRunStatusLabel
      : () => '运行状态';
    const getExecutionOutcomeState = typeof deps.getExecutionOutcomeState === 'function'
      ? deps.getExecutionOutcomeState
      : () => '';
    const isPassedFlag = typeof deps.isPassedFlag === 'function'
      ? deps.isPassedFlag
      : () => false;
    const isFailedFlag = typeof deps.isFailedFlag === 'function'
      ? deps.isFailedFlag
      : () => false;
    const getEnvironmentStatusMeta = typeof deps.getEnvironmentStatusMeta === 'function'
      ? deps.getEnvironmentStatusMeta
      : () => null;
    const getEnvironmentBuildStatusMeta = typeof deps.getEnvironmentBuildStatusMeta === 'function'
      ? deps.getEnvironmentBuildStatusMeta
      : () => null;

    function getRunStatusTagMeta(status, label) {
      const normalized = String(status || '').trim().toLowerCase();
      if (normalized === 'failed' || normalized === 'error' || normalized === 'aborted') {
        return { className: 'tag-error', label: label || '运行失败' };
      }
      if (normalized === 'running' || normalized === 'pending' || normalized === 'queued' || normalized === 'terminating') {
        return { className: 'tag-pending', label: label || '运行中' };
      }
      if (normalized === 'completed' || normalized === 'succeeded' || normalized === 'passed') {
        return { className: 'tag-success', label: label || '运行完成' };
      }
      return { className: 'tag', label: label || (normalized || '状态待定') };
    }

    function buildStatusTagHtml(status, label) {
      const meta = getRunStatusTagMeta(status, label);
      return `<span class="tag ${meta.className}">${escapeHtml(meta.label)}</span>`;
    }

    function buildRunOutcomeTagHtml(run, evaluation = null) {
      const verdict = String(
        (run && run.verdict)
        || (evaluation && evaluation.verdict)
        || ''
      ).trim().toLowerCase();
      if (verdict === 'pass') {
        return '<span class="tag tag-success">Verdict Pass</span>';
      }
      if (verdict === 'borderline') {
        return '<span class="tag tag-pending">Verdict Borderline</span>';
      }
      if (verdict === 'fail') {
        return '<span class="tag tag-error">Verdict Fail</span>';
      }
      const executionState = getExecutionOutcomeState(run);
      if (executionState === 'pass') {
        return '<span class="tag tag-success">执行达标</span>';
      }
      if (executionState === 'review') {
        return '<span class="tag tag-pending">执行待复核</span>';
      }
      if (executionState === 'fail') {
        return '<span class="tag tag-error">执行未达标</span>';
      }
      if (isPassedFlag(run && run.triggerPassed)) {
        return '<span class="tag tag-success">已加载 skill</span>';
      }
      if (isFailedFlag(run && run.triggerPassed)) {
        return '<span class="tag tag-error">未加载 skill</span>';
      }
      return '';
    }

    function buildEnvironmentStatusTagHtml(status) {
      const meta = getEnvironmentStatusMeta(status);
      return meta ? `<span class="tag ${meta.className}">${escapeHtml(meta.label)}</span>` : '';
    }

    function buildEnvironmentBuildTagHtml(buildResult) {
      const meta = getEnvironmentBuildStatusMeta(buildResult && buildResult.status);
      return meta ? `<span class="tag ${meta.className}">${escapeHtml(meta.label)}</span>` : '';
    }

    function buildRunSummarySectionHtml(options = {}) {
      const title = String(options.title || '运行摘要').trim() || '运行摘要';
      const tags = Array.isArray(options.tags) ? options.tags.filter(Boolean) : [];
      const metaParts = Array.isArray(options.metaParts)
        ? options.metaParts.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
      const notes = Array.isArray(options.notes)
        ? options.notes.filter((entry) => entry && String(entry.text || '').trim())
        : [];

      let html = '<div class="run-detail-section">';
      html += `<div class="section-label">${escapeHtml(title)}</div>`;
      if (tags.length > 0) {
        html += `<div class="run-detail-tag-row">${tags.join(' ')}</div>`;
      }
      if (metaParts.length > 0) {
        html += `<div class="agent-meta">${escapeHtml(metaParts.join(' · '))}</div>`;
      }
      for (const note of notes) {
        const tone = String(note.tone || '').trim().toLowerCase();
        const className = tone === 'error' ? 'run-detail-diag' : 'agent-meta';
        html += `<div class="${className}">${escapeHtml(String(note.text || '').trim())}</div>`;
      }
      html += '</div>';
      return html;
    }

    function buildToolTracePanelHtml(options = {}) {
      const trace = rebuildLiveRunTrace(options.trace);
      const sectionLabel = String(options.sectionLabel || '工具时间线').trim() || '工具时间线';
      const helperText = String(options.helperText || '').trim();
      const status = String(options.status || (trace.summary && trace.summary.status) || '').trim();
      const tone = String(options.tone || liveRunTone(status)).trim() || 'neutral';
      const statusLabel = String(options.statusLabel || liveRunStatusLabel(status || 'completed')).trim() || '运行状态';
      const extraPills = Array.isArray(options.extraPills) ? options.extraPills.filter(Boolean) : [];
      const notes = Array.isArray(options.notes) ? options.notes.filter(Boolean) : [];
      const emptyLabel = String(options.emptyLabel || '本次没有持久化工具时间线。').trim();
      const pills = [`<span class="message-tool-trace-pill ${tone}">${escapeHtml(statusLabel)}</span>`, ...extraPills]
        .filter(Boolean)
        .join(' ');

      let html = '<div class="run-detail-section">';
      html += `<div class="section-label">${escapeHtml(sectionLabel)}</div>`;
      if (helperText) {
        html += `<div class="agent-meta">${escapeHtml(helperText)}</div>`;
      }
      html += '</div>';
      html += '<section class="message-tool-trace open">';
      html += `<div class="message-tool-trace-header"><div class="message-tool-trace-summary">${pills}</div></div>`;
      html += '<div class="message-tool-trace-details">';
      html += notes.join('');
      html += '<section class="message-tool-trace-section">';
      html += '<div class="message-tool-trace-section-header">';
      html += '<div class="message-tool-trace-section-title">调用步骤</div>';
      html += '<div class="message-tool-trace-section-meta"></div>';
      html += '</div>';
      html += '<div class="message-tool-trace-steps-viewport scrollable">';
      html += `<div class="message-tool-trace-section-steps">${buildToolTraceStepsHtml(trace, emptyLabel)}</div>`;
      html += '</div>';
      html += '</section>';
      html += '</div>';
      html += '</section>';
      return html;
    }

    return {
      getRunStatusTagMeta,
      buildStatusTagHtml,
      buildRunOutcomeTagHtml,
      buildEnvironmentStatusTagHtml,
      buildEnvironmentBuildTagHtml,
      buildRunSummarySectionHtml,
      buildToolTracePanelHtml,
    };
  };
})();
