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
    runAllButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-run-all-btn')),
    runProgress: /** @type {HTMLDivElement | null} */ (document.getElementById('st-run-progress')),
    toolbarPanel: /** @type {HTMLElement | null} */ (document.querySelector('.skill-tests-toolbar-panel')),
    openCreateButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-open-create-btn')),
    selectedHighlights: /** @type {HTMLElement | null} */ (document.getElementById('st-selected-highlights')),
    selectedSummary: /** @type {HTMLElement | null} */ (document.getElementById('st-selected-summary')),
    selectedStatusCallout: /** @type {HTMLElement | null} */ (document.getElementById('st-selected-callout')),
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
    detailGoal: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-goal')),
    detailBehavior: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-behavior')),
    detailStepsJson: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-steps-json')),
    detailToolsJson: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-tools-json')),
    detailSequenceJson: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-sequence-json')),
    detailRubricJson: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-rubric-json')),
    detailNote: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-note')),
    detailExpectedBehavior: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-expected-behavior')),
    detailExpectedTools: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-expected-tools')),
    detailValidity: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-validity')),
    detailValidityHelp: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-validity-help')),
    detailStatusCallout: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-status-callout')),
    detailIssues: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-issues')),
    detailSaveButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-save-btn')),
    detailToggleStatusButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-toggle-status-btn')),
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
    createLoadingMode: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-create-loading-mode')),
    createTools: /** @type {HTMLInputElement | null} */ (document.getElementById('st-create-tools')),
    createToolSpecs: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-tool-specs')),
    createGoal: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-goal')),
    createSteps: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-steps')),
    createSequence: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-sequence')),
    createRubric: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-rubric')),
    createBehavior: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-behavior')),
    createNote: /** @type {HTMLInputElement | null} */ (document.getElementById('st-create-note')),
    createIssues: /** @type {HTMLElement | null} */ (document.getElementById('st-create-issues')),
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
    casesLoading: false,
    casesLoadError: '',
    casesLastLoadedAt: '',
    summaryLoading: false,
    summaryLoadError: '',
    summaryLastLoadedAt: '',
  };

  function normalizeIssueSeverity(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'error' || normalized === 'warning' || normalized === 'needs-review') {
      return normalized;
    }
    return 'warning';
  }

  function normalizeValidationIssue(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const code = String(value.code || 'validation_issue').trim() || 'validation_issue';
    const path = String(value.path || '').trim();
    const message = String(value.message || value.reason || code).trim();
    if (!message) {
      return null;
    }
    return {
      code,
      path,
      message,
      severity: normalizeIssueSeverity(value.severity),
    };
  }

  function normalizeIssueList(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((issue) => normalizeValidationIssue(issue)).filter(Boolean);
  }

  function extractIssuesFromError(error) {
    if (!error || typeof error !== 'object') {
      return [];
    }
    if (Array.isArray(error.issues)) {
      return normalizeIssueList(error.issues);
    }
    const payload = error.payload && typeof error.payload === 'object' ? error.payload : null;
    if (payload && Array.isArray(payload.issues)) {
      return normalizeIssueList(payload.issues);
    }
    return [];
  }

  const ISSUE_SEVERITY_ORDER = {
    error: 0,
    'needs-review': 1,
    warning: 2,
  };

  function getIssueCounters(issues) {
    return normalizeIssueList(issues).reduce((acc, issue) => {
      acc.total += 1;
      if (issue.severity === 'error') {
        acc.error += 1;
      } else if (issue.severity === 'needs-review') {
        acc.needsReview += 1;
      } else {
        acc.warning += 1;
      }
      return acc;
    }, { total: 0, error: 0, warning: 0, needsReview: 0 });
  }

  function sortIssuesBySeverity(issues) {
    return normalizeIssueList(issues).slice().sort((left, right) => {
      const leftOrder = ISSUE_SEVERITY_ORDER[left.severity] ?? 99;
      const rightOrder = ISSUE_SEVERITY_ORDER[right.severity] ?? 99;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return `${left.code || ''}:${left.path || ''}`.localeCompare(`${right.code || ''}:${right.path || ''}`);
    });
  }

  function getHighestIssueSeverity(issues) {
    const normalized = sortIssuesBySeverity(issues);
    return normalized.length > 0 ? normalized[0].severity : '';
  }

  function getIssuePanelToneClass(issues) {
    const severity = getHighestIssueSeverity(issues);
    return severity ? `skill-test-issues-${severity}` : '';
  }

  function buildIssueSummary(issues) {
    const normalized = normalizeIssueList(issues);
    if (normalized.length === 0) {
      return '无校验提示';
    }
    const counters = getIssueCounters(normalized);
    const parts = [`${counters.total} 条`];
    if (counters.error > 0) {
      parts.push(`${counters.error} 错误`);
    }
    if (counters.warning > 0) {
      parts.push(`${counters.warning} 提示`);
    }
    if (counters.needsReview > 0) {
      parts.push(`${counters.needsReview} 待复核`);
    }
    return parts.join('，');
  }

  function buildIssueToastMessage(prefix, issues) {
    const normalized = sortIssuesBySeverity(issues);
    if (normalized.length === 0) {
      return '';
    }
    const firstIssue = normalized[0];
    return `${prefix}${buildIssueSummary(normalized)}：${getIssueDisplayMessage(firstIssue)}`;
  }

  function getIssueSeverityLabel(severity) {
    if (severity === 'error') {
      return '错误';
    }
    if (severity === 'needs-review') {
      return '待复核';
    }
    return '提示';
  }

  const ISSUE_MESSAGE_BY_CODE = {
    prompt_alias_conflict: 'userPrompt 与 triggerPrompt 归一化后不一致',
    user_prompt_required: '用户任务输入不能为空',
    user_prompt_too_short: '用户任务输入过短（至少 5 个字符）',
    user_prompt_too_long: '用户任务输入过长（最多 2000 个字符）',
    expected_steps_required: 'Expected Steps JSON 需要是数组',
    expected_tools_invalid: '期望工具字段格式无效',
    expected_sequence_invalid: '关键顺序字段必须是数组',
    evaluation_rubric_invalid: '评估 Rubric 字段必须是对象',
    case_schema_invalid: '用例结构校验未通过，无法继续运行',
    judge_parse_failed: '评审结果解析失败，需人工复核',
    judge_runtime_failed: '评审执行失败，需人工复核',
    sequence_config_invalid: '顺序配置无效，请检查 step/order 配置',
    signal_shape_invalid: '信号结构不完整，请补齐必填字段',
  };

  const FULL_DIMENSION_LABELS = {
    requiredStepCompletionRate: '必选步骤完成度',
    stepCompletionRate: '步骤完成度',
    sequenceAdherence: '顺序执行度',
    goalAchievement: '目标达成度',
    instructionAdherence: '行为符合度',
    requiredToolCoverage: '工具覆盖度',
    toolCallSuccessRate: '工具成功度',
    toolErrorRate: '工具错误率',
  };

  const FULL_AGGREGATION_REASON_LABELS = {
    'missing-required-step': '缺少必选步骤',
    'goal-hard-fail': '目标达成度低于硬失败阈值',
    'instruction-hard-fail': '行为符合度低于硬失败阈值',
    'critical-sequence-hard-fail': '关键顺序约束未达标',
    'critical-constraint': '违反关键约束',
    'judge-backed-hard-fail': 'AI Judge 给出有证据的 fail',
    'judge-needs-review': 'AI Judge 结果需复核',
    'critical-constraint-needs-review': '关键约束检查不完整，需人工复核',
    'critical-sequence-needs-review': '关键顺序证据不足，需人工复核',
    'primary-dimension-below-pass-threshold': '主判维度未达到通过阈值',
    'needs-human-review-or-supporting-signals-weak': '证据偏弱或存在可疑信号，建议人工复核',
    'supporting-metrics-weak': '辅证维度偏弱',
    'primary-dimensions-met': '主判维度已达标',
  };

  function getIssueDisplayMessage(issue) {
    if (!issue || typeof issue !== 'object') {
      return '';
    }
    return ISSUE_MESSAGE_BY_CODE[issue.code] || issue.message || issue.code || '校验提示';
  }

  function normalizeRunDetailStringList(value, maxItems = 16) {
    if (!Array.isArray(value)) {
      return [];
    }
    const normalized = [];
    for (const entry of value) {
      const text = String(entry || '').trim();
      if (!text) {
        continue;
      }
      normalized.push(text);
      if (normalized.length >= maxItems) {
        break;
      }
    }
    return normalized;
  }

  function formatRunDetailPercent(value) {
    if (value == null || value === '') {
      return 'n/a';
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 'n/a';
    }
    return `${(numeric * 100).toFixed(1)}%`;
  }

  function getFullAggregationReasonLabel(reason) {
    const key = String(reason || '').trim();
    if (!key) {
      return '';
    }
    return FULL_AGGREGATION_REASON_LABELS[key] || key;
  }

  function getFullJudgeStatusMeta(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'succeeded') {
      return { label: 'AI Judge 成功', className: 'tag-success' };
    }
    if (normalized === 'parse_failed') {
      return { label: 'AI Judge 解析失败', className: 'tag-error' };
    }
    if (normalized === 'runtime_failed') {
      return { label: 'AI Judge 运行失败', className: 'tag-error' };
    }
    if (normalized === 'skipped') {
      return { label: 'AI Judge 跳过', className: 'tag-pending' };
    }
    if (!normalized) {
      return null;
    }
    return { label: `AI Judge ${normalized}`, className: 'tag' };
  }

  function buildRunDetailReasonListHtml(title, reasons, formatter = null) {
    const normalized = normalizeRunDetailStringList(reasons);
    if (normalized.length === 0) {
      return `<div class="agent-meta">${escapeHtml(title)}：无</div>`;
    }
    const listItems = normalized
      .map((reason) => `<li>${escapeHtml(formatter ? formatter(reason) : reason)}</li>`)
      .join('');
    return `<div class="run-detail-subsection"><div class="agent-meta">${escapeHtml(title)}</div><ul class="run-detail-list">${listItems}</ul></div>`;
  }

  function mergeIssues(...issueLists) {
    const merged = [];
    const seen = new Set();
    issueLists.forEach((list) => {
      normalizeIssueList(list).forEach((issue) => {
        const dedupeKey = [issue.severity, issue.code, issue.path, issue.message].join('|');
        if (seen.has(dedupeKey)) {
          return;
        }
        seen.add(dedupeKey);
        merged.push(issue);
      });
    });
    return merged;
  }

  function buildLocalValidationIssue(code, path, message, severity = 'error') {
    return normalizeValidationIssue({ code, path, message, severity });
  }

  function buildLocalValidationError(message, issues) {
    return {
      message: String(message || '本地校验失败'),
      issues: normalizeIssueList(issues),
    };
  }

  function buildIssuePanelHtml(issues, title = '') {
    const normalized = sortIssuesBySeverity(issues);
    if (normalized.length === 0) {
      return '';
    }

    const counters = getIssueCounters(normalized);
    const summaryText = title
      ? `${title}（${buildIssueSummary(normalized)}）`
      : buildIssueSummary(normalized);
    const summaryBadges = [
      counters.error > 0 ? `<span class="skill-test-issue-chip skill-test-issue-chip-error">错误 ${counters.error}</span>` : '',
      counters.warning > 0 ? `<span class="skill-test-issue-chip skill-test-issue-chip-warning">提示 ${counters.warning}</span>` : '',
      counters.needsReview > 0 ? `<span class="skill-test-issue-chip skill-test-issue-chip-needs-review">待复核 ${counters.needsReview}</span>` : '',
    ].filter(Boolean).join('');

    let html = '<div class="skill-test-issues-heading">';
    html += `<p class="section-hint skill-test-issues-summary">${escapeHtml(summaryText)}</p>`;
    if (summaryBadges) {
      html += `<div class="skill-test-issue-badges">${summaryBadges}</div>`;
    }
    html += '</div>';
    html += '<ul class="skill-test-issue-list">';
    for (const issue of normalized) {
      const severityClass = `skill-test-issue-item-${issue.severity}`;
      const codeLabel = issue.code ? `<span class="skill-test-issue-code">${escapeHtml(issue.code)}</span>` : '';
      const pathLabel = issue.path ? `<span class="skill-test-issue-path">${escapeHtml(issue.path)}</span>` : '';
      html += `<li class="skill-test-issue-item ${severityClass}"><span class="skill-test-issue-severity skill-test-issue-severity-${issue.severity}">${escapeHtml(getIssueSeverityLabel(issue.severity))}</span>${codeLabel}<span class="skill-test-issue-message">${escapeHtml(getIssueDisplayMessage(issue))}</span>${pathLabel}</li>`;
    }
    html += '</ul>';
    return html;
  }

  function renderIssuePanel(container, issues, title = '') {
    if (!container) {
      return;
    }
    container.classList.remove('skill-test-issues-error', 'skill-test-issues-warning', 'skill-test-issues-needs-review');
    const html = buildIssuePanelHtml(issues, title);
    if (!html) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    const toneClass = getIssuePanelToneClass(issues);
    if (toneClass) {
      container.classList.add(toneClass);
    }
    container.innerHTML = html;
    container.classList.remove('hidden');
  }

  function readRunValidation(data) {
    const payload = data && typeof data === 'object' ? data : {};
    const resultValidation = payload.result && payload.result.validation && typeof payload.result.validation === 'object'
      ? payload.result.validation
      : null;
    const runValidation = payload.run
      && payload.run.evaluation
      && payload.run.evaluation.validation
      && typeof payload.run.evaluation.validation === 'object'
      ? payload.run.evaluation.validation
      : null;

    const issues = mergeIssues(
      payload.issues,
      resultValidation ? resultValidation.issues : null,
      runValidation ? runValidation.issues : null
    );

    let caseSchemaStatus = '';
    const schemaCandidates = [payload.caseSchemaStatus, resultValidation && resultValidation.caseSchemaStatus, runValidation && runValidation.caseSchemaStatus];
    for (const candidate of schemaCandidates) {
      const normalized = String(candidate || '').trim().toLowerCase();
      if (normalized) {
        caseSchemaStatus = normalized;
        break;
      }
    }

    let derivedFromLegacy = null;
    const legacyCandidates = [payload.derivedFromLegacy, resultValidation && resultValidation.derivedFromLegacy, runValidation && runValidation.derivedFromLegacy];
    for (const candidate of legacyCandidates) {
      if (typeof candidate === 'boolean') {
        derivedFromLegacy = candidate;
        break;
      }
    }

    return {
      issues,
      caseSchemaStatus,
      derivedFromLegacy,
    };
  }

  function readCaseValidation(testCase) {
    const payload = testCase && typeof testCase === 'object' ? testCase : {};
    const storedValidation = payload.validation && typeof payload.validation === 'object'
      ? payload.validation
      : null;

    const issues = mergeIssues(
      payload.issues,
      storedValidation ? storedValidation.issues : null
    );

    let caseSchemaStatus = '';
    const schemaCandidates = [payload.caseSchemaStatus, storedValidation && storedValidation.caseSchemaStatus];
    for (const candidate of schemaCandidates) {
      const normalized = String(candidate || '').trim().toLowerCase();
      if (normalized) {
        caseSchemaStatus = normalized;
        break;
      }
    }

    let derivedFromLegacy = null;
    const legacyCandidates = [payload.derivedFromLegacy, storedValidation && storedValidation.derivedFromLegacy];
    for (const candidate of legacyCandidates) {
      if (typeof candidate === 'boolean') {
        derivedFromLegacy = candidate;
        break;
      }
    }

    return {
      issues,
      caseSchemaStatus,
      derivedFromLegacy,
    };
  }

  function getCaseSchemaStatusMeta(caseSchemaStatus) {
    const normalized = String(caseSchemaStatus || '').trim().toLowerCase();
    if (normalized === 'invalid') {
      return { label: 'Case Schema Invalid', className: 'tag-error' };
    }
    if (normalized === 'warning') {
      return { label: 'Case Schema Warning', className: 'tag-pending' };
    }
    if (normalized === 'valid') {
      return { label: 'Case Schema Valid', className: 'tag-success' };
    }
    return null;
  }

  function getCaseReadinessMeta(testCase, caseValidation) {
    if (testCase && testCase.caseStatus === 'archived') {
      return { label: '已归档', className: 'tag' };
    }
    if (caseValidation && String(caseValidation.caseSchemaStatus || '').trim().toLowerCase() === 'invalid') {
      return { label: '需修结构', className: 'tag-error' };
    }
    if (!testCase || testCase.caseStatus !== 'ready') {
      return { label: '待验证', className: 'tag-pending' };
    }
    return { label: '可运行', className: 'tag-success' };
  }

  function getLatestRunStatusMeta(run) {
    if (!run) {
      return null;
    }
    if (run.errorMessage) {
      return { label: '运行失败', className: 'tag-error' };
    }
    if (isFailedFlag(run.triggerPassed)) {
      return { label: '触发失败', className: 'tag-error' };
    }
    const executionState = getExecutionOutcomeState(run);
    if (executionState === 'fail') {
      return { label: '执行失败', className: 'tag-error' };
    }
    if (executionState === 'review') {
      return { label: '待复核', className: 'tag-pending' };
    }
    if (executionState === 'pass') {
      return { label: '最近通过', className: 'tag-success' };
    }
    if (isPassedFlag(run.triggerPassed)) {
      return { label: '已触发', className: 'tag-success' };
    }
    return { label: '已运行', className: 'tag' };
  }

  function getCasePrompt(testCase) {
    return String((testCase && (testCase.userPrompt ?? testCase.triggerPrompt)) || '').trim();
  }

  function formatRefreshTime(value) {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function getCaseActionCallout(testCase, caseValidation) {
    if (!testCase) {
      return null;
    }

    const validation = caseValidation || readCaseValidation(testCase);
    const latestRun = testCase.latestRun || null;
    const highestIssueSeverity = getHighestIssueSeverity(validation.issues);
    const schemaStatus = String(validation.caseSchemaStatus || '').trim().toLowerCase();

    if (schemaStatus === 'invalid') {
      return {
        tone: 'error',
        label: '先修结构',
        message: '这条用例的结构校验还没过；先修 JSON、Rubric 或顺序字段，再标记 Ready 或重新运行。',
      };
    }

    if (highestIssueSeverity === 'error') {
      return {
        tone: 'error',
        label: '先看校验提示',
        message: '这条用例还有错误级 issues；先处理详情里的校验提示，再继续后续操作。',
      };
    }

    if (latestRun && latestRun.errorMessage) {
      return {
        tone: 'error',
        label: '先看失败原因',
        message: '最近一次运行直接报错；先打开运行详情看错误和校验提示，再决定是否重试。',
      };
    }

    if (latestRun && isFailedFlag(latestRun.triggerPassed)) {
      return {
        tone: 'error',
        label: '先看触发失败',
        message: '最近一次没有成功加载目标 skill；优先检查用户任务输入、加载方式和失败诊断。',
      };
    }

    if (latestRun && getExecutionOutcomeState(latestRun) === 'fail') {
      return {
        tone: 'error',
        label: '优先重试失败 case',
        message: '最近执行结果未达预期；先看运行详情里的步骤、工具和 judge 提示，再决定如何修。',
      };
    }

    if (latestRun && getExecutionOutcomeState(latestRun) === 'review') {
      return {
        tone: 'pending',
        label: '待复核',
        message: '最近一次结果需要人工复核；先展开运行详情看 validation、judge 和回归信息。',
      };
    }

    if (highestIssueSeverity === 'needs-review' || highestIssueSeverity === 'warning' || validation.derivedFromLegacy === true) {
      return {
        tone: highestIssueSeverity === 'needs-review' ? 'pending' : 'warning',
        label: validation.derivedFromLegacy === true ? '建议补齐 canonical 字段' : '先看提示再继续',
        message: validation.derivedFromLegacy === true
          ? '这条 case 还是 legacy 映射结构，建议顺手补成 canonical 字段，减少后续漂移。'
          : '这条用例有提示级校验项；先看详情里的 issues，确认无误后再继续。',
      };
    }

    if (testCase.caseStatus !== 'ready') {
      return {
        tone: 'pending',
        label: '下一步',
        message: '这条用例还是 Draft；确认 prompt、目标和期望结构后，再标记 Ready。',
      };
    }

    if (!latestRun) {
      return {
        tone: 'success',
        label: '可以开跑',
        message: '这条用例已经 Ready 但还没跑过；可以先单条运行，确认顺手后再批量跑。',
      };
    }

    return {
      tone: 'success',
      label: '继续巡检',
      message: '最近结果看起来正常；可以继续批量运行，或者切到回归对比看不同模型 / Prompt Version。',
    };
  }

  function renderStatusCallout(container, callout) {
    if (!container) {
      return;
    }
    container.classList.remove(
      'skill-test-status-callout-error',
      'skill-test-status-callout-warning',
      'skill-test-status-callout-pending',
      'skill-test-status-callout-success'
    );
    if (!callout) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    const tone = callout.tone || 'pending';
    container.classList.add(`skill-test-status-callout-${tone}`);
    container.innerHTML = `
      <div class="skill-test-status-callout-label">${escapeHtml(callout.label || '当前建议')}</div>
      <p class="section-hint">${escapeHtml(callout.message || '')}</p>
    `;
    container.classList.remove('hidden');
  }

  function scheduleSkillTestStickyOffsetSync() {
    window.requestAnimationFrame(() => {
      const toolbarPanel = dom.toolbarPanel;
      if (!toolbarPanel) return;
      const visible = toolbarPanel.getClientRects().length > 0;
      const offset = visible ? Math.ceil(toolbarPanel.getBoundingClientRect().height + 20) : 0;
      document.documentElement.style.setProperty('--skill-tests-toolbar-offset', `${offset}px`);
    });
  }

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
      scheduleSkillTestStickyOffsetSync();
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
    renderIssuePanel(dom.detailIssues, []);
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
  window.addEventListener('resize', scheduleSkillTestStickyOffsetSync);

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
      state.selectedCaseId = '';
      state.testCases = [];
      state.casesLoadError = '';
      renderIssuePanel(dom.createIssues, []);
      persistSelections();
      renderSelectedSkillOverview();
      renderCaseList();
      hideDetail();
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
        return;
      }
      if (action === 'retry-load') {
        loadTestCases();
      }
    });
  }

  // ---- Test Cases ----
  async function loadTestCases() {
    if (!state.selectedSkillId) {
      state.testCases = [];
      state.selectedCaseId = '';
      state.casesLoading = false;
      state.casesLoadError = '';
      state.casesLastLoadedAt = '';
      renderSelectedSkillOverview();
      renderCaseList();
      hideDetail();
      return;
    }

    const requestedSkillId = state.selectedSkillId;
    state.casesLoading = true;
    state.casesLoadError = '';
    renderSelectedSkillOverview();
    renderCaseList();

    try {
      const data = await fetchJson(`/api/skills/${encodeURIComponent(requestedSkillId)}/test-cases`);
      if (state.selectedSkillId !== requestedSkillId) {
        return;
      }
      state.testCases = Array.isArray(data.cases) ? data.cases : [];
      if (state.selectedCaseId && !state.testCases.some((tc) => tc.id === state.selectedCaseId)) {
        state.selectedCaseId = '';
      }
      state.casesLoading = false;
      state.casesLoadError = '';
      state.casesLastLoadedAt = new Date().toISOString();
      renderSelectedSkillOverview();
      renderCaseList();
      syncDetailPanel();
    } catch (err) {
      if (state.selectedSkillId !== requestedSkillId) {
        return;
      }
      state.casesLoading = false;
      state.casesLoadError = '加载当前 Skill 的用例失败，请重试。';
      renderSelectedSkillOverview();
      renderCaseList();
      showToast('加载测试用例失败: ' + (err.message || err));
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
      const runResult = await fetchJson(
        `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/${encodeURIComponent(caseId)}/run`,
        { method: 'POST', body: getRunOptions() }
      );
      const runValidation = readRunValidation(runResult);
      const runIssues = runValidation.issues;
      const runMessage = runIssues.length > 0
        ? `测试运行完成（${buildIssueSummary(runIssues)}）`
        : '测试运行完成';
      showToast(runMessage);
      renderIssuePanel(dom.detailIssues, runIssues, '运行返回校验提示');
      await Promise.all([loadTestCases(), loadSummary()]);
      if (runIssues.length > 0) {
        renderIssuePanel(dom.detailIssues, runIssues, '运行返回校验提示');
      }
      if (options.scrollIntoView && dom.detailPanel && !dom.detailPanel.classList.contains('hidden')) {
        dom.detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return true;
    } catch (err) {
      const issues = extractIssuesFromError(err);
      renderIssuePanel(dom.detailIssues, issues, '运行失败校验提示');
      const issueMessage = buildIssueToastMessage('运行失败，', issues);
      showToast(issueMessage || ('运行失败: ' + (err.message || err)));
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
      dom.selectedSummary.textContent = '这里会显示当前 Skill 的用例数量、草稿/Ready 分布、刷新状态和下一步建议。';
      renderStatusCallout(dom.selectedStatusCallout, {
        tone: 'pending',
        label: '先选一个 Skill',
        message: '先在顶部选择 Skill，下面的列表、详情和概览建议才会一起联动。',
      });
      return;
    }

    if (state.casesLoading && state.testCases.length === 0) {
      dom.selectedHighlights.innerHTML = '<span class="tag tag-pending">正在加载当前 Skill 用例...</span>';
      dom.selectedSummary.textContent = '正在拉取这个 Skill 的用例、状态和最近表现。';
      renderStatusCallout(dom.selectedStatusCallout, {
        tone: 'pending',
        label: '正在刷新当前 Skill',
        message: '正在同步这组 case 的列表、状态和最近结果；等一会儿就能继续巡检。',
      });
      return;
    }

    if (state.casesLoadError && state.testCases.length === 0) {
      dom.selectedHighlights.innerHTML = '<span class="tag tag-error">用例加载失败</span>';
      dom.selectedSummary.textContent = state.casesLoadError;
      renderStatusCallout(dom.selectedStatusCallout, {
        tone: 'error',
        label: '先重试刷新',
        message: '当前 Skill 的用例还没拉下来；先点重试拿到列表，再继续看详情或批量运行。',
      });
      return;
    }

    const totalCases = state.testCases.length;
    const draftCount = state.testCases.filter((tc) => tc.caseStatus === 'draft').length;
    const readyCount = state.testCases.filter((tc) => tc.caseStatus === 'ready').length;
    const archivedCount = state.testCases.filter((tc) => tc.caseStatus === 'archived').length;
    const recentFailing = state.testCases.filter((tc) => {
      const run = tc.latestRun || null;
      return isFailingRun(run);
    }).length;
    const neverRunCount = state.testCases.filter((tc) => !tc.latestRun).length;
    const caseValidations = state.testCases.map((tc) => readCaseValidation(tc));
    const invalidCount = caseValidations.filter((validation) => validation.caseSchemaStatus === 'invalid').length;
    const warningCount = caseValidations.filter((validation) => validation.caseSchemaStatus === 'warning').length;
    const legacyCount = caseValidations.filter((validation) => validation.derivedFromLegacy === true).length;
    const selectedSummary = state.summary.find((entry) => entry.skillId === state.selectedSkillId) || null;
    const triggerRate = selectedSummary && selectedSummary.triggerRate != null
      ? `${Math.round(selectedSummary.triggerRate * 100)}%`
      : '—';
    const executionRate = selectedSummary && selectedSummary.executionRate != null
      ? `${Math.round(selectedSummary.executionRate * 100)}%`
      : '—';
    const casesRefreshLabel = formatRefreshTime(state.casesLastLoadedAt);
    const summaryRefreshLabel = formatRefreshTime(state.summaryLastLoadedAt);
    const listRefreshTag = state.casesLoading
      ? '<span class="tag tag-pending">列表刷新中...</span>'
      : (state.casesLoadError ? '<span class="tag tag-error">列表刷新失败</span>' : '');

    dom.selectedHighlights.innerHTML = [
      `<span class="tag">共 ${totalCases} 条</span>`,
      `<span class="tag tag-pending">Draft ${draftCount}</span>`,
      `<span class="tag tag-success">Ready ${readyCount}</span>`,
      `<span class="tag">Archived ${archivedCount}</span>`,
      `<span class="tag">可批量运行 ${readyCount}</span>`,
      `<span class="tag">最近失败 ${recentFailing}</span>`,
      neverRunCount > 0 ? `<span class="tag">未运行 ${neverRunCount}</span>` : '',
      invalidCount > 0 ? `<span class="tag tag-error">结构异常 ${invalidCount}</span>` : '',
      warningCount > 0 ? `<span class="tag tag-pending">结构提示 ${warningCount}</span>` : '',
      legacyCount > 0 ? `<span class="tag">Legacy ${legacyCount}</span>` : '',
      casesRefreshLabel ? `<span class="tag">列表更新 ${escapeHtml(casesRefreshLabel)}</span>` : '',
      summaryRefreshLabel ? `<span class="tag">概览更新 ${escapeHtml(summaryRefreshLabel)}</span>` : '',
      listRefreshTag,
    ].filter(Boolean).join('');

    const filterHint = state.searchQuery || state.validityFilter !== 'all'
      ? `当前筛选后显示 ${getFilteredCases().length} 条；`
      : '';
    const refreshHint = state.casesLoadError
      ? `最近一次列表刷新失败，当前仍显示${casesRefreshLabel ? `${casesRefreshLabel} 的` : '上一次成功加载的'}结果；`
      : (casesRefreshLabel ? `列表最近一次成功刷新在 ${casesRefreshLabel}；` : '');
    const summaryHint = summaryRefreshLabel ? `全局概览更新在 ${summaryRefreshLabel}；` : '';
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
    dom.selectedSummary.textContent = `${refreshHint}${summaryHint}${filterHint}当前 Skill 的加载成功率 ${triggerRate}，执行通过率 ${executionRate}。${nextStep}`;

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
    } else if (state.casesLoadError) {
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
    renderStatusCallout(dom.selectedStatusCallout, overviewCallout);
  }

  function getFilteredCases() {
    return state.testCases.filter((tc) => {
      const matchesQuery = !state.searchQuery || [
        tc.id,
        getCasePrompt(tc),
        tc.note,
        tc.expectedBehavior,
        tc.expectedGoal,
        getExpectedStepsSearchText(tc.expectedSteps),
        getExpectedToolsSearchText(tc.expectedTools),
        tc.caseStatus,
        tc.loadingMode,
      ].some((value) => String(value || '').toLowerCase().includes(state.searchQuery));

      const latestRun = tc.latestRun || null;
      const matchesValidity = state.validityFilter === 'all'
        || tc.caseStatus === state.validityFilter
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

    if (state.casesLoading && state.testCases.length === 0) {
      dom.caseList.innerHTML = `
        <div class="empty-state compact-empty-state">
          <p class="section-hint">正在加载测试用例...</p>
        </div>
      `;
      return;
    }

    if (state.casesLoadError && state.testCases.length === 0) {
      dom.caseList.innerHTML = `
        <div class="empty-state compact-empty-state">
          <p class="section-hint">${escapeHtml(state.casesLoadError)}</p>
          <div class="panel-actions skill-test-empty-actions">
            <button class="ghost-button" type="button" data-st-case-action="retry-load">重试</button>
          </div>
        </div>
      `;
      return;
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
              <button class="ghost-button" type="button" data-st-case-action="generate">AI 生成测试用例</button>
              <button class="ghost-button" type="button" data-st-case-action="open-create">手动创建</button>
            </div>
          </div>
        `;
      return;
    }

    dom.caseList.innerHTML = '';

    if (state.casesLoading || state.casesLoadError) {
      const banner = document.createElement('div');
      const casesRefreshLabel = formatRefreshTime(state.casesLastLoadedAt);
      banner.className = `skill-test-inline-banner ${state.casesLoadError ? 'skill-test-inline-banner-error' : 'skill-test-inline-banner-pending'}`;
      banner.innerHTML = state.casesLoadError
        ? `
          <p class="section-hint">列表刷新失败，当前仍显示${casesRefreshLabel ? `${escapeHtml(casesRefreshLabel)} 的` : '上一次成功加载的'}结果。</p>
          <div class="panel-actions">
            <button class="ghost-button" type="button" data-st-case-action="retry-load">重试</button>
          </div>
        `
        : `<p class="section-hint">列表刷新中${casesRefreshLabel ? `，当前先显示 ${escapeHtml(casesRefreshLabel)} 的结果。` : '，你可以先查看已加载结果。'}</p>`;
      dom.caseList.appendChild(banner);
    }

    for (const tc of filteredCases) {
      const card = document.createElement('article');
      card.className = 'skill-test-case-card' + (tc.id === state.selectedCaseId ? ' agent-card-selected' : '');
      card.dataset.caseId = tc.id;

      const validityMeta = getCaseStatusMeta(tc.caseStatus);
      const caseValidation = readCaseValidation(tc);
      const readinessMeta = getCaseReadinessMeta(tc, caseValidation);
      const latestRunMeta = getLatestRunStatusMeta(tc.latestRun);
      const schemaStatusMeta = getCaseSchemaStatusMeta(caseValidation.caseSchemaStatus);
      const loadingModeLabel = getLoadingModeLabel(tc.loadingMode);
      const expectedToolsText = formatExpectedTools(tc.expectedTools);
      const lastOutcome = getLastOutcomeSummary(tc.latestRun);
      const goalSummary = clipText(tc.expectedGoal || tc.expectedBehavior || tc.note || '生成后先进入 draft，等待你修改。', 90);
      const latestSummary = clipText(lastOutcome, 96);
      const caseIdentity = tc.id ? `#${tc.id.slice(0, 8)}` : '未命名';
      const recentRunLabel = tc.latestRun && tc.latestRun.createdAt
        ? `最近运行 ${new Date(tc.latestRun.createdAt).toLocaleString()}`
        : '还没跑过';
      const validationSummary = caseValidation.issues.length > 0
        ? `用例校验 ${buildIssueSummary(caseValidation.issues)}`
        : caseValidation.derivedFromLegacy === true
          ? '用例由 legacy 结构映射而来'
          : '';
      const schemaTag = schemaStatusMeta && caseValidation.caseSchemaStatus !== 'valid'
        ? `<span class="tag ${schemaStatusMeta.className}">${escapeHtml(schemaStatusMeta.label)}</span>`
        : '';
      const caseCallout = getCaseActionCallout(tc, caseValidation);
      const calloutHtml = caseCallout
        ? `
        <div class="skill-test-case-callout skill-test-status-callout skill-test-status-callout-${caseCallout.tone}">
          <div class="skill-test-status-callout-label">${escapeHtml(caseCallout.label)}</div>
          <p class="section-hint">${escapeHtml(caseCallout.message)}</p>
        </div>
      `
        : '';

      card.innerHTML = `
        <div class="skill-test-case-card-head">
          <div>
            <div class="skill-test-case-card-id">${escapeHtml(caseIdentity)}</div>
            <div class="skill-test-case-card-meta">${escapeHtml(loadingModeLabel)}</div>
          </div>
          <div class="skill-test-case-card-tags">
            <span class="tag ${validityMeta.className}">${validityMeta.label}</span>
            <span class="tag ${readinessMeta.className}">${escapeHtml(readinessMeta.label)}</span>
            ${latestRunMeta ? `<span class="tag ${latestRunMeta.className}">${escapeHtml(latestRunMeta.label)}</span>` : ''}
            ${schemaTag}
          </div>
        </div>
        <p class="skill-test-case-card-prompt">${escapeHtml(clipText(getCasePrompt(tc), 120))}</p>
        <div class="skill-test-case-card-meta">${escapeHtml(recentRunLabel)}</div>
        <div class="skill-test-case-card-meta">${escapeHtml(goalSummary)}</div>
        <div class="skill-test-case-card-meta">${escapeHtml(clipText(expectedToolsText, 120))}</div>
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
        selectCase(tc.id, { detailTab: 'overview', scrollIntoView: true });
      });

      const runButton = document.createElement('button');
      runButton.type = 'button';
      runButton.className = 'mini-action';
      runButton.textContent = isFailingRun(tc.latestRun) ? '重试' : '运行';
      runButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        selectCase(tc.id, { detailTab: 'runs', scrollIntoView: true });
        await runTestCase(tc.id, {
          button: runButton,
          idleLabel: runButton.textContent || '运行',
          busyLabel: '运行中...',
          detailTab: 'runs',
          scrollIntoView: true,
        });
      });

      const statusButton = document.createElement('button');
      statusButton.type = 'button';
      statusButton.className = 'mini-action';
      statusButton.textContent = tc.caseStatus === 'ready' ? '改回 Draft' : (caseValidation.caseSchemaStatus === 'invalid' ? '修好后再 Ready' : '标记 Ready');
      statusButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await toggleCaseStatus(tc);
        } catch (err) {
          const issues = extractIssuesFromError(err);
          if (tc.id === state.selectedCaseId) {
            renderIssuePanel(dom.detailIssues, issues, '切换状态失败校验提示');
          }
          const issueMessage = buildIssueToastMessage('切换状态失败，', issues);
          showToast(issueMessage || ('切换状态失败: ' + (err.message || err)));
        }
      });

      actions.appendChild(viewButton);
      actions.appendChild(runButton);
      actions.appendChild(statusButton);
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
    const caseValidation = readCaseValidation(tc);
    const readinessMeta = getCaseReadinessMeta(tc, caseValidation);
    const latestRunMeta = getLatestRunStatusMeta(tc.latestRun);
    const schemaStatusMeta = getCaseSchemaStatusMeta(caseValidation.caseSchemaStatus);
    if (dom.detailCaseId) dom.detailCaseId.textContent = tc.id;
    if (dom.detailMeta) {
      dom.detailMeta.innerHTML = `
        <span class="tag">${escapeHtml(getLoadingModeLabel(tc.loadingMode))}</span>
        <span class="tag ${readinessMeta.className}">${escapeHtml(readinessMeta.label)}</span>
        ${latestRunMeta ? `<span class="tag ${latestRunMeta.className}">${escapeHtml(latestRunMeta.label)}</span>` : ''}
        ${schemaStatusMeta && caseValidation.caseSchemaStatus === 'warning' ? `<span class="tag ${schemaStatusMeta.className}">${escapeHtml(schemaStatusMeta.label)}</span>` : ''}
        ${caseValidation.derivedFromLegacy === true ? '<span class="tag tag-pending">Legacy 映射</span>' : ''}
        ${tc.note ? `<span class="tag">${escapeHtml(clipText(tc.note, 36))}</span>` : ''}
      `;
    }
    if (dom.detailLastOutcome) {
      dom.detailLastOutcome.textContent = getLastOutcomeSummary(tc.latestRun);
    }
    if (dom.detailPrompt) dom.detailPrompt.value = getCasePrompt(tc);
    if (dom.detailGoal) dom.detailGoal.value = tc.expectedGoal || '';
    if (dom.detailBehavior) dom.detailBehavior.value = tc.expectedBehavior || '';
    if (dom.detailStepsJson) dom.detailStepsJson.value = stringifyJsonPretty(tc.expectedSteps || []);
    if (dom.detailToolsJson) dom.detailToolsJson.value = stringifyJsonPretty(tc.expectedTools || []);
    if (dom.detailSequenceJson) dom.detailSequenceJson.value = stringifyJsonPretty(tc.expectedSequence || []);
    if (dom.detailRubricJson) dom.detailRubricJson.value = stringifyJsonPretty(tc.evaluationRubric || {});
    if (dom.detailNote) {
      dom.detailNote.value = tc.note || '';
    }
    if (dom.detailExpectedBehavior) {
      dom.detailExpectedBehavior.textContent = tc.expectedGoal || tc.expectedBehavior || 'Dynamic 模式主要关注能否成功加载目标 skill。';
    }
    if (dom.detailExpectedTools) {
      dom.detailExpectedTools.textContent = formatExpectedTools(tc.expectedTools);
    }
    if (dom.detailValidity) {
      const validityMeta = getCaseStatusMeta(tc.caseStatus);
      dom.detailValidity.className = 'tag ' + validityMeta.className;
      dom.detailValidity.textContent = validityMeta.label;
    }
    if (dom.detailValidityHelp) {
      dom.detailValidityHelp.textContent = getCaseStatusHelpText(tc);
    }
    renderStatusCallout(dom.detailStatusCallout, getCaseActionCallout(tc, caseValidation));
    if (dom.detailToggleStatusButton) {
      dom.detailToggleStatusButton.textContent = tc.caseStatus === 'ready'
        ? '改回 Draft'
        : (caseValidation.caseSchemaStatus === 'invalid' ? '修好后再 Ready' : '标记 Ready');
    }
    if (dom.detailRunButton) {
      dom.detailRunButton.textContent = isFailingRun(tc.latestRun) ? '重试运行' : '运行测试';
    }

    renderIssuePanel(dom.detailIssues, caseValidation.issues, '用例校验提示');

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
    renderStatusCallout(dom.detailStatusCallout, null);
    renderIssuePanel(dom.detailIssues, []);
    if (dom.detailRunButton) {
      dom.detailRunButton.textContent = '运行测试';
    }
    if (dom.detailToggleStatusButton) {
      dom.detailToggleStatusButton.textContent = '标记 Ready';
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

  function stringifyJsonPretty(value) {
    try {
      return JSON.stringify(value == null ? null : value, null, 2);
    } catch {
      return '';
    }
  }

  async function toggleCaseStatus(testCase) {
    if (!state.selectedSkillId || !testCase || !testCase.id) return;
    const action = testCase.caseStatus === 'ready' ? 'mark-draft' : 'mark-ready';
    const nextLabel = action === 'mark-ready' ? 'Ready' : 'Draft';
    await fetchJson(
      `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/${encodeURIComponent(testCase.id)}/${action}`,
      { method: 'POST' }
    );
    showToast(`已切换为 ${nextLabel}`);
    await Promise.all([loadTestCases(), loadSummary()]);
    selectCase(testCase.id, { detailTab: state.activeDetailTab });
  }

  async function saveCurrentCase() {
    if (!state.selectedSkillId || !state.selectedCaseId) return;
    const selectedCase = state.testCases.find((tc) => tc.id === state.selectedCaseId);
    if (!selectedCase) return;

    const expectedStepsText = dom.detailStepsJson ? dom.detailStepsJson.value.trim() : '';
    const expectedSteps = parseStructuredArray(expectedStepsText);

    const expectedToolsText = dom.detailToolsJson ? dom.detailToolsJson.value.trim() : '';
    const expectedTools = parseStructuredExpectedTools(expectedToolsText);

    const expectedSequenceText = dom.detailSequenceJson ? dom.detailSequenceJson.value.trim() : '';
    const expectedSequence = parseStructuredArray(expectedSequenceText);

    const evaluationRubricText = dom.detailRubricJson ? dom.detailRubricJson.value.trim() : '';
    const evaluationRubric = parseStructuredObject(evaluationRubricText);

    const localIssues = mergeIssues(
      expectedStepsText && !expectedSteps
        ? [buildLocalValidationIssue('expected_steps_required', 'expectedSteps', 'Expected Steps JSON 需要是数组')]
        : [],
      expectedToolsText && !expectedTools
        ? [buildLocalValidationIssue('expected_tools_invalid', 'expectedTools', 'Expected Tools JSON 需要是数组')]
        : [],
      expectedSequenceText && !expectedSequence
        ? [buildLocalValidationIssue('expected_sequence_invalid', 'expectedSequence', '关键顺序 JSON 需要是数组')]
        : [],
      evaluationRubricText && !evaluationRubric
        ? [buildLocalValidationIssue('evaluation_rubric_invalid', 'evaluationRubric', '评估 Rubric JSON 需要是对象')]
        : []
    );

    if (localIssues.length > 0) {
      throw buildLocalValidationError('保存前校验失败', localIssues);
    }

    const prompt = dom.detailPrompt ? dom.detailPrompt.value.trim() : getCasePrompt(selectedCase);
    const body = {
      userPrompt: prompt,
      triggerPrompt: prompt,
      expectedGoal: dom.detailGoal ? dom.detailGoal.value.trim() : selectedCase.expectedGoal,
      expectedBehavior: dom.detailBehavior ? dom.detailBehavior.value.trim() : selectedCase.expectedBehavior,
      expectedSteps: expectedSteps || [],
      expectedTools: expectedTools || [],
      expectedSequence: expectedSequence || [],
      evaluationRubric: evaluationRubric || {},
      note: dom.detailNote ? dom.detailNote.value.trim() : selectedCase.note,
      loadingMode: selectedCase.loadingMode,
      caseStatus: selectedCase.caseStatus,
    };

    const result = await fetchJson(
      `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/${encodeURIComponent(state.selectedCaseId)}`,
      { method: 'PATCH', body }
    );
    const saveIssues = normalizeIssueList(result && result.issues);
    const saveMessage = saveIssues.length > 0
      ? `草稿已保存（${buildIssueSummary(saveIssues)}）`
      : '草稿已保存';
    showToast(saveMessage);
    await Promise.all([loadTestCases(), loadSummary()]);
    selectCase(state.selectedCaseId, { detailTab: 'details' });
    renderIssuePanel(dom.detailIssues, saveIssues, '保存返回校验提示');
    return saveIssues;
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

      const triggerTag = run.verdict
        ? ''
        : isPassedFlag(run.triggerPassed)
          ? '<span class="tag tag-success">已加载 skill</span>'
          : isFailedFlag(run.triggerPassed)
            ? '<span class="tag tag-error">未加载 skill</span>'
            : '<span class="tag tag-pending">加载结果待定</span>';

      const execTag = run.verdict
        ? (run.verdict === 'pass'
          ? '<span class="tag tag-success">Full 执行通过</span>'
          : run.verdict === 'borderline'
            ? '<span class="tag tag-pending">Full 待复核</span>'
            : '<span class="tag tag-error">Full 执行失败</span>')
        : (run.executionPassed === null || typeof run.executionPassed === 'undefined'
          ? '<span class="tag tag-pending">未评估执行</span>'
          : isPassedFlag(run.executionPassed)
            ? '<span class="tag tag-success">工具执行符合预期</span>'
            : isFailedFlag(run.executionPassed)
              ? '<span class="tag tag-error">工具执行未达预期</span>'
              : '<span class="tag tag-pending">执行结果待定</span>');

      const accuracy =
        run.toolAccuracy != null ? `<span class="tag">工具命中 ${(run.toolAccuracy * 100).toFixed(0)}%</span>` : '';

      const tools =
        Array.isArray(run.actualTools) && run.actualTools.length > 0
          ? `<div class="agent-meta">工具: ${run.actualTools.map((toolName) => escapeHtml(toolName)).join(', ')}</div>`
          : '';

      let triggerFailHint = '';
      if (!run.verdict && isFailedFlag(run.triggerPassed)) {
        triggerFailHint = '<div class="run-item-warning">⚠ 这次没有加载到目标 skill，可点「查看详情」看模型实际做了什么</div>';
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
    const payload = data && typeof data === 'object' ? data : {};
    const debug = payload.debug || {};
    const result = payload.result || {};
    const run = payload.run && typeof payload.run === 'object' ? payload.run : {};
    const fullEvaluation = result && result.evaluation && typeof result.evaluation === 'object'
      ? result.evaluation
      : (run.evaluation && typeof run.evaluation === 'object' ? run.evaluation : null);
    const triggerEvaluation = result.triggerEvaluation || null;
    const aiJudge = fullEvaluation && fullEvaluation.aiJudge
      ? fullEvaluation.aiJudge
      : (triggerEvaluation && triggerEvaluation.aiJudge ? triggerEvaluation.aiJudge : null);
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
    const runValidation = readRunValidation(data);

    let html = '';

    if (runValidation.issues.length > 0 || runValidation.caseSchemaStatus || runValidation.derivedFromLegacy === true) {
      const schemaStatusMeta = getCaseSchemaStatusMeta(runValidation.caseSchemaStatus);
      html += '<div class="run-detail-section">';
      html += '<div class="section-label">运行校验提示</div>';
      if (schemaStatusMeta) {
        html += `<span class="tag ${schemaStatusMeta.className}">${escapeHtml(schemaStatusMeta.label)}</span>`;
      }
      if (runValidation.derivedFromLegacy === true) {
        html += ' <span class="tag tag-pending">Derived From Legacy</span>';
      }
      if (runValidation.issues.length > 0) {
        const issueToneClass = getIssuePanelToneClass(runValidation.issues);
        html += `<div class="skill-test-issues skill-test-issues-inline${issueToneClass ? ` ${issueToneClass}` : ''}">${buildIssuePanelHtml(runValidation.issues, '运行校验') || ''}</div>`;
      }
      html += '</div>';
    }

    // ---- Output text ----
    if (debug.outputText) {
      html += '<div class="run-detail-section">';
      html += '<div class="section-label">模型输出</div>';
      html += `<pre class="run-detail-pre">${escapeHtml(debug.outputText)}</pre>`;
      html += '</div>';
    }

    if (fullEvaluation) {
      const dimensions = fullEvaluation && fullEvaluation.dimensions && typeof fullEvaluation.dimensions === 'object'
        ? fullEvaluation.dimensions
        : null;
      const verdictLabel = fullEvaluation.verdict === 'pass'
        ? '<span class="tag tag-success">Pass</span>'
        : fullEvaluation.verdict === 'borderline'
          ? '<span class="tag tag-pending">Borderline</span>'
          : '<span class="tag tag-error">Fail</span>';
      const judgeStatusMeta = getFullJudgeStatusMeta(fullEvaluation.aiJudge && fullEvaluation.aiJudge.status);
      html += '<div class="run-detail-section">';
      html += '<div class="section-label">Full 模式多维评估</div>';
      html += `${verdictLabel}`;
      if (judgeStatusMeta) {
        html += ` <span class="tag ${judgeStatusMeta.className}">${escapeHtml(judgeStatusMeta.label)}</span>`;
      }
      if (fullEvaluation.summary) {
        html += `<div class="agent-meta">${escapeHtml(fullEvaluation.summary)}</div>`;
      }
      if (dimensions) {
        const orderedDimensionKeys = Object.keys(FULL_DIMENSION_LABELS);
        const extraDimensionKeys = Object.keys(dimensions).filter((key) => !orderedDimensionKeys.includes(key));
        for (const key of [...orderedDimensionKeys, ...extraDimensionKeys]) {
          if (!(key in dimensions)) {
            continue;
          }
          const value = dimensions[key];
          const score = value && typeof value === 'object'
            ? formatRunDetailPercent(value.score)
            : formatRunDetailPercent(value);
          const reason = value && typeof value === 'object' ? String(value.reason || '').trim() : '';
          const role = value && typeof value === 'object'
            ? String(value.role || '').trim().toLowerCase()
            : '';
          html += '<div class="run-detail-tool">';
          html += '<div class="run-detail-tag-row">';
          html += `<span class="tag">${escapeHtml(FULL_DIMENSION_LABELS[key] || key)}</span>`;
          html += `<span class="agent-meta">${escapeHtml(score)}</span>`;
          if (role === 'supporting') {
            html += '<span class="tag">辅证</span>';
          }
          html += '</div>';
          if (reason) {
            html += `<div class="agent-meta">${escapeHtml(reason)}</div>`;
          }
          html += '</div>';
        }
      } else {
        html += '<div class="agent-meta">本次 run 未返回 dimensions 详情。</div>';
      }
      if (Array.isArray(fullEvaluation.missingTools) && fullEvaluation.missingTools.length > 0) {
        html += `<div class="agent-meta">缺少工具：${escapeHtml(fullEvaluation.missingTools.join(' / '))}</div>`;
      }
      if (Array.isArray(fullEvaluation.unexpectedTools) && fullEvaluation.unexpectedTools.length > 0) {
        html += `<div class="agent-meta">额外工具：${escapeHtml(fullEvaluation.unexpectedTools.join(' / '))}</div>`;
      }
      if (Array.isArray(fullEvaluation.failedCalls) && fullEvaluation.failedCalls.length > 0) {
        html += '<div class="run-detail-subsection">';
        html += '<div class="agent-meta">失败工具调用</div>';
        html += '<ul class="run-detail-list">';
        for (const failedCall of fullEvaluation.failedCalls) {
          const toolName = failedCall && failedCall.tool ? String(failedCall.tool) : 'unknown';
          const reason = failedCall && failedCall.reason ? String(failedCall.reason) : 'tool call failed';
          html += `<li><span class="tag">${escapeHtml(toolName)}</span> ${escapeHtml(reason)}</li>`;
        }
        html += '</ul>';
        html += '</div>';
      }
      html += '</div>';

      const stepResults = Array.isArray(fullEvaluation.steps) ? fullEvaluation.steps : [];
      const missingSteps = fullEvaluation.missingSteps && typeof fullEvaluation.missingSteps === 'object'
        ? fullEvaluation.missingSteps
        : {};
      const missingRequiredSteps = normalizeRunDetailStringList(missingSteps.required);
      const missingNonRequiredSteps = normalizeRunDetailStringList(missingSteps.nonRequired);
      if (stepResults.length > 0 || missingRequiredSteps.length > 0 || missingNonRequiredSteps.length > 0) {
        html += '<div class="run-detail-section">';
        html += '<div class="section-label">步骤判定</div>';
        if (missingRequiredSteps.length > 0) {
          html += `<div class="run-detail-diag" style="color:#e53e3e">缺少必选步骤：${escapeHtml(missingRequiredSteps.join(' / '))}</div>`;
        }
        if (missingNonRequiredSteps.length > 0) {
          html += `<div class="agent-meta">缺少非必选步骤：${escapeHtml(missingNonRequiredSteps.join(' / '))}</div>`;
        }
        if (stepResults.length === 0) {
          html += '<div class="agent-meta">AI Judge 未返回步骤级结果。</div>';
        }
        for (const stepResult of stepResults) {
          const stepId = String(stepResult && (stepResult.stepId || stepResult.id) || '').trim() || 'unknown-step';
          const completed = stepResult && stepResult.completed;
          const confidence = stepResult && stepResult.confidence != null
            ? formatRunDetailPercent(stepResult.confidence)
            : '';
          const reason = String(stepResult && stepResult.reason || '').trim();
          const evidenceIds = normalizeRunDetailStringList(stepResult && stepResult.evidenceIds, 10);
          const matchedSignalIds = normalizeRunDetailStringList(stepResult && stepResult.matchedSignalIds, 10);
          const stepTag = completed === true
            ? '<span class="tag tag-success">完成</span>'
            : completed === false
              ? '<span class="tag tag-error">未完成</span>'
              : '<span class="tag tag-pending">待复核</span>';
          html += '<div class="run-detail-card">';
          html += '<div class="run-detail-tag-row">';
          html += `${stepTag} <span class="tag">${escapeHtml(stepId)}</span>`;
          if (confidence) {
            html += ` <span class="agent-meta">置信度 ${escapeHtml(confidence)}</span>`;
          }
          html += '</div>';
          if (reason) {
            html += `<div class="agent-meta">${escapeHtml(reason)}</div>`;
          }
          if (evidenceIds.length > 0) {
            html += buildRunDetailReasonListHtml('证据 ID', evidenceIds);
          }
          if (matchedSignalIds.length > 0) {
            html += buildRunDetailReasonListHtml('命中 Signal', matchedSignalIds);
          }
          html += '</div>';
        }
        html += '</div>';
      }

      const constraintChecks = Array.isArray(fullEvaluation.constraintChecks) ? fullEvaluation.constraintChecks : [];
      if (constraintChecks.length > 0) {
        html += '<div class="run-detail-section">';
        html += '<div class="section-label">关键约束检查</div>';
        for (const check of constraintChecks) {
          const constraintId = String(check && check.constraintId || '').trim() || 'unknown-constraint';
          const satisfied = check && check.satisfied;
          const reason = String(check && check.reason || '').trim();
          const evidenceIds = normalizeRunDetailStringList(check && check.evidenceIds, 10);
          const statusTag = satisfied === true
            ? '<span class="tag tag-success">满足</span>'
            : satisfied === false
              ? '<span class="tag tag-error">违反</span>'
              : '<span class="tag tag-pending">待复核</span>';
          html += '<div class="run-detail-card">';
          html += `<div class="run-detail-tag-row">${statusTag} <span class="tag">${escapeHtml(constraintId)}</span></div>`;
          if (reason) {
            html += `<div class="agent-meta">${escapeHtml(reason)}</div>`;
          }
          if (evidenceIds.length > 0) {
            html += buildRunDetailReasonListHtml('证据 ID', evidenceIds);
          }
          html += '</div>';
        }
        html += '</div>';
      }

      const aggregation = fullEvaluation.aggregation && typeof fullEvaluation.aggregation === 'object'
        ? fullEvaluation.aggregation
        : null;
      const hardFailReasons = normalizeRunDetailStringList(aggregation && aggregation.hardFailReasons);
      const borderlineReasons = normalizeRunDetailStringList(aggregation && aggregation.borderlineReasons);
      const supportingWarnings = normalizeRunDetailStringList(aggregation && aggregation.supportingWarnings);
      if (aggregation || hardFailReasons.length > 0 || borderlineReasons.length > 0 || supportingWarnings.length > 0) {
        html += '<div class="run-detail-section">';
        html += '<div class="section-label">聚合判定依据</div>';
        html += buildRunDetailReasonListHtml('Hard Fail 原因', hardFailReasons, getFullAggregationReasonLabel);
        html += buildRunDetailReasonListHtml('Borderline 原因', borderlineReasons, getFullAggregationReasonLabel);
        html += buildRunDetailReasonListHtml('辅证告警', supportingWarnings, getFullAggregationReasonLabel);
        html += '</div>';
      }

      const fullJudge = fullEvaluation.aiJudge && typeof fullEvaluation.aiJudge === 'object'
        ? fullEvaluation.aiJudge
        : null;
      if (fullJudge) {
        const statusMeta = getFullJudgeStatusMeta(fullJudge.status);
        const verdictSuggestion = String(fullJudge.verdictSuggestion || '').trim();
        const missedExpectations = normalizeRunDetailStringList(fullJudge.missedExpectations);
        html += '<div class="run-detail-section">';
        html += '<div class="section-label">AI Judge 诊断</div>';
        if (statusMeta) {
          html += `<span class="tag ${statusMeta.className}">${escapeHtml(statusMeta.label)}</span>`;
        }
        if (verdictSuggestion) {
          html += ` <span class="tag">建议：${escapeHtml(verdictSuggestion)}</span>`;
        }
        if (fullJudge.errorMessage) {
          html += `<div class="run-detail-diag" style="color:#e53e3e">${escapeHtml(String(fullJudge.errorMessage))}</div>`;
        }
        if (missedExpectations.length > 0) {
          html += buildRunDetailReasonListHtml('缺失预期', missedExpectations);
        }
        if (fullJudge.status !== 'succeeded' && fullJudge.rawResponse) {
          html += '<details class="run-detail-collapse">';
          html += '<summary class="agent-meta">查看原始 judge 回包</summary>';
          html += `<pre class="run-detail-pre">${escapeHtml(String(fullJudge.rawResponse))}</pre>`;
          html += '</details>';
        }
        html += '</div>';
      }
    }

    const matchedSignals = Array.isArray(triggerEvaluation && triggerEvaluation.matchedSignalIds)
      ? triggerEvaluation.matchedSignalIds
      : (Array.isArray(triggerEvaluation && triggerEvaluation.matchedSignals) ? triggerEvaluation.matchedSignals : []);

    if (triggerEvaluation && triggerEvaluation.mode !== 'full' && (matchedSignals.length > 0 || aiJudge)) {
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
      if (matchedSignals.length > 0) {
        html += `<div class="agent-meta">命中信号：${escapeHtml(matchedSignals.join(' / '))}</div>`;
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

    if (run && !run.verdict && isFailedFlag(run.triggerPassed)) {
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
    if (session.thinking && run && (isPassedFlag(run.triggerPassed) || Boolean(run.verdict))) {
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
      dom.generateButton.disabled = true;
      dom.generateButton.textContent = 'AI 生成中...';
      try {
        const data = await fetchJson(
          `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/generate`,
          { method: 'POST', body: { count, loadingMode, createDrafts: true, ...getRunOptions() } }
        );
        showToast(`已生成 ${data.generated || 0} 个草稿`);
        await Promise.all([loadTestCases(), loadSummary()]);
      } catch (err) {
        showToast('生成失败: ' + (err.message || err));
      } finally {
        dom.generateButton.disabled = false;
        dom.generateButton.textContent = 'AI 生成测试用例';
      }
    });
  }

  if (dom.detailSaveButton) {
    dom.detailSaveButton.addEventListener('click', async () => {
      try {
        dom.detailSaveButton.disabled = true;
        await saveCurrentCase();
      } catch (err) {
        const issues = extractIssuesFromError(err);
        renderIssuePanel(dom.detailIssues, issues, '保存失败校验提示');
        const issueMessage = buildIssueToastMessage('保存失败，', issues);
        showToast(issueMessage || ('保存失败: ' + (err.message || err)));
      } finally {
        dom.detailSaveButton.disabled = false;
      }
    });
  }

  if (dom.detailToggleStatusButton) {
    dom.detailToggleStatusButton.addEventListener('click', async () => {
      const selectedCase = state.testCases.find((tc) => tc.id === state.selectedCaseId);
      if (!selectedCase) return;
      try {
        dom.detailToggleStatusButton.disabled = true;
        await toggleCaseStatus(selectedCase);
      } catch (err) {
        const issues = extractIssuesFromError(err);
        renderIssuePanel(dom.detailIssues, issues, '切换状态失败校验提示');
        const issueMessage = buildIssueToastMessage('切换状态失败，', issues);
        showToast(issueMessage || ('切换状态失败: ' + (err.message || err)));
      } finally {
        dom.detailToggleStatusButton.disabled = false;
      }
    });
  }

  // ---- Run single ----
  if (dom.detailRunButton) {
    dom.detailRunButton.addEventListener('click', async () => {
      if (!state.selectedCaseId) return;
      await runTestCase(state.selectedCaseId, {
        button: dom.detailRunButton,
        idleLabel: dom.detailRunButton.textContent || '运行测试',
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
      if (!confirm('确认批量运行当前 Skill 下所有 Ready 用例吗？这可能需要一些时间。')) return;

      const runAllViaServerFallback = async () => {
        dom.runAllButton.disabled = true;
        try {
          const result = await fetchJson(
            `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/run-all`,
            { method: 'POST', body: getRunOptions() }
          );
          const results = Array.isArray(result.results) ? result.results : [];
          const total = Number(result.total || results.length || 0);
          const triggerOk = results.reduce((count, item) => count + (item && item.run && isPassedFlag(item.run.triggerPassed) ? 1 : 0), 0);
          const execOk = results.reduce((count, item) => count + (getExecutionOutcomeState(item && item.run) === 'pass' ? 1 : 0), 0);
          showToast(`批量运行完成：${total} 个用例，加载成功 ${triggerOk}/${total || 1}，执行达标 ${execOk}/${total || 1}`);
          await Promise.all([loadTestCases(), loadSummary()]);
        } catch (err) {
          const message = err && err.message ? String(err.message) : String(err || '');
          if (message.includes('No test cases to run')) {
            showToast('没有 Ready 状态的测试用例');
          } else {
            showToast('批量运行失败: ' + message);
          }
        } finally {
          dom.runAllButton.disabled = false;
          dom.runAllButton.textContent = '批量运行 Ready 用例';
        }
      };

      let caseList = [];
      let useServerFallback = false;
      try {
        const caseData = await fetchJson(`/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases`);
        caseList = (Array.isArray(caseData.cases) ? caseData.cases : []).filter(
          c => c.caseStatus === 'ready'
        );
      } catch {
        useServerFallback = true;
      }

      if (useServerFallback) {
        await runAllViaServerFallback();
        return;
      }

      if (caseList.length === 0) {
        showToast('没有 Ready 状态的测试用例');
        return;
      }

      dom.runAllButton.disabled = true;

      let progressContainer = dom.runProgress || document.getElementById('st-run-progress');
      if (!progressContainer) {
        progressContainer = document.createElement('div');
        progressContainer.id = 'st-run-progress';
        progressContainer.className = 'run-progress-container';
        const toolbarPanel = dom.runAllButton.closest('.skill-tests-toolbar-panel') || dom.runAllButton.parentElement;
        if (toolbarPanel) {
          toolbarPanel.appendChild(progressContainer);
        }
      }
      progressContainer.classList.remove('hidden');
      progressContainer.innerHTML = `
        <div class="run-progress-bar">
          <div class="run-progress-fill" style="width:0%"></div>
        </div>
        <div class="run-progress-text">0 / ${caseList.length} — 准备中...</div>
      `;
      scheduleSkillTestStickyOffsetSync();

      let completed = 0;
      let triggerOk = 0;
      let execOk = 0;

      try {
        for (const tc of caseList) {
          updateProgress(progressContainer, completed, caseList.length, `运行: ${clipText(getCasePrompt(tc), 30)}`);

          try {
            const result = await fetchJson(
              `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/${encodeURIComponent(tc.id)}/run`,
              { method: 'POST', body: getRunOptions() }
            );
            if (result.run) {
              if (isPassedFlag(result.run.triggerPassed)) triggerOk++;
              if (getExecutionOutcomeState(result.run) === 'pass') execOk++;
            }
          } catch (err) {
            void err;
          }

          completed++;
        }

        updateProgress(progressContainer, completed, caseList.length, '完成!');
        showToast(`批量运行完成：${completed} 个用例，加载成功 ${triggerOk}/${completed}，执行达标 ${execOk}/${completed}`);
        await Promise.all([loadTestCases(), loadSummary()]);
      } catch (err) {
        showToast('批量运行失败: ' + (err.message || err));
      } finally {
        dom.runAllButton.disabled = false;
        dom.runAllButton.textContent = '批量运行 Ready 用例';
        // Keep progress visible for 3 seconds then fade
        setTimeout(() => {
          if (progressContainer) progressContainer.classList.add('hidden');
          scheduleSkillTestStickyOffsetSync();
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
        const promptIssues = [buildLocalValidationIssue('user_prompt_required', 'userPrompt', '用户任务输入不能为空')];
        renderIssuePanel(dom.createIssues, promptIssues, '创建前校验提示');
        const issueMessage = buildIssueToastMessage('创建前校验失败，', promptIssues);
        showToast(issueMessage || '用户任务输入不能为空');
        return;
      }

      const toolsStr = dom.createTools ? dom.createTools.value.trim() : '';
      const expectedTools = toolsStr ? toolsStr.split(/[,，\s]+/).filter(Boolean) : [];
      const structuredToolsText = dom.createToolSpecs ? dom.createToolSpecs.value.trim() : '';
      const structuredTools = parseStructuredExpectedTools(structuredToolsText);
      const expectedBehavior = dom.createBehavior ? dom.createBehavior.value.trim() : '';
      const expectedGoal = dom.createGoal ? dom.createGoal.value.trim() : '';
      const expectedStepsText = dom.createSteps ? dom.createSteps.value.trim() : '';
      const expectedSteps = parseStructuredArray(expectedStepsText);
      const expectedSequenceText = dom.createSequence ? dom.createSequence.value.trim() : '';
      const expectedSequence = parseStructuredArray(expectedSequenceText);
      const evaluationRubricText = dom.createRubric ? dom.createRubric.value.trim() : '';
      const evaluationRubric = parseStructuredObject(evaluationRubricText);

      const localIssues = mergeIssues(
        structuredToolsText && !structuredTools
          ? [buildLocalValidationIssue('expected_tools_invalid', 'expectedTools', 'Structured expectedTools JSON 需要是数组')]
          : [],
        expectedStepsText && !expectedSteps
          ? [buildLocalValidationIssue('expected_steps_required', 'expectedSteps', 'Expected Steps JSON 需要是数组')]
          : [],
        expectedSequenceText && !expectedSequence
          ? [buildLocalValidationIssue('expected_sequence_invalid', 'expectedSequence', '关键顺序 JSON 需要是数组')]
          : [],
        evaluationRubricText && !evaluationRubric
          ? [buildLocalValidationIssue('evaluation_rubric_invalid', 'evaluationRubric', '评估 Rubric JSON 需要是对象')]
          : []
      );
      if (localIssues.length > 0) {
        renderIssuePanel(dom.createIssues, localIssues, '创建前校验提示');
        const issueMessage = buildIssueToastMessage('创建前校验失败，', localIssues);
        showToast(issueMessage || '创建前校验失败，请修正结构化 JSON 字段');
        return;
      }

      if (dom.createSubmitButton) {
        dom.createSubmitButton.disabled = true;
        dom.createSubmitButton.textContent = '创建中...';
      }
      try {
        const createResult = await fetchJson(`/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases`, {
          method: 'POST',
          body: {
            userPrompt: prompt,
            triggerPrompt: prompt,
            loadingMode: dom.createLoadingMode ? dom.createLoadingMode.value : 'dynamic',
            expectedTools: [...expectedTools, ...(structuredTools || [])],
            expectedSteps: expectedSteps || [],
            expectedBehavior,
            expectedGoal,
            expectedSequence: expectedSequence || [],
            evaluationRubric: evaluationRubric || {},
            caseStatus: 'draft',
            note: dom.createNote ? dom.createNote.value.trim() : '',
          },
        });
        const createIssues = normalizeIssueList(createResult && createResult.issues);
        const createdCaseId = createResult && createResult.testCase && typeof createResult.testCase.id === 'string'
          ? createResult.testCase.id
          : '';
        const createdMessage = createIssues.length > 0
          ? `测试用例已创建（${buildIssueSummary(createIssues)}）`
          : '测试用例已创建为 draft';
        showToast(createdMessage);
        if (createIssues.length > 0) {
          renderIssuePanel(dom.createIssues, createIssues, '创建返回校验提示');
        } else {
          renderIssuePanel(dom.createIssues, []);
        }
        if (dom.createPrompt) dom.createPrompt.value = '';
        if (dom.createToolSpecs) dom.createToolSpecs.value = '';
        if (dom.createGoal) dom.createGoal.value = '';
        if (dom.createSteps) dom.createSteps.value = '';
        if (dom.createSequence) dom.createSequence.value = '';
        if (dom.createRubric) dom.createRubric.value = '';
        if (dom.createBehavior) dom.createBehavior.value = '';
        if (dom.createNote) dom.createNote.value = '';
        await Promise.all([loadTestCases(), loadSummary()]);
        if (createdCaseId) {
          selectCase(createdCaseId, { detailTab: 'details' });
        }
      } catch (err) {
        const issues = extractIssuesFromError(err);
        renderIssuePanel(dom.createIssues, issues, '创建失败校验提示');
        const issueMessage = buildIssueToastMessage('创建失败，', issues);
        showToast(issueMessage || ('创建失败: ' + (err.message || err)));
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
    state.summaryLoading = true;
    state.summaryLoadError = '';
    renderSummary();
    try {
      const data = await fetchJson('/api/skill-test-summary');
      state.summary = Array.isArray(data.summary) ? data.summary : [];
      state.summaryLoading = false;
      state.summaryLoadError = '';
      state.summaryLastLoadedAt = new Date().toISOString();
      renderSummary();
    } catch {
      state.summaryLoading = false;
      state.summaryLoadError = '加载全部 Skill 概览失败，请重试。';
      renderSummary();
    }
  }

  function renderSummary() {
    if (!dom.summaryBody) return;
    renderSelectedSkillOverview();
    const summaryRefreshLabel = formatRefreshTime(state.summaryLastLoadedAt);
    if (state.summaryLoading && state.summary.length === 0) {
      if (dom.summaryHighlights) {
        dom.summaryHighlights.innerHTML = '<span class="tag tag-pending">正在加载 Skill 测试概览...</span>';
      }
      dom.summaryBody.innerHTML = '<p class="section-hint">加载中...</p>';
      return;
    }
    if (state.summaryLoadError && state.summary.length === 0) {
      if (dom.summaryHighlights) {
        dom.summaryHighlights.innerHTML = '<span class="tag tag-error">Skill 概览加载失败</span>';
      }
      renderRetryState(dom.summaryBody, state.summaryLoadError, loadSummary);
      return;
    }
    if (state.summary.length === 0) {
      if (dom.summaryHighlights) {
        dom.summaryHighlights.innerHTML = '<span class="tag tag-pending">还没有可展示的 skill 测试结果</span>';
      }
      dom.summaryBody.innerHTML = '<p class="section-hint">暂无测试数据；先选一个 Skill 生成或手动创建用例，再回来这里看整体概览。</p>';
      return;
    }

    const totals = state.summary.reduce((acc, entry) => {
      acc.totalCases += Number(entry.totalCases || 0);
      acc.totalRuns += Number(entry.totalRuns || 0);
      acc.draft += Number((entry.casesByStatus && entry.casesByStatus.draft) || 0);
      acc.ready += Number((entry.casesByStatus && entry.casesByStatus.ready) || 0);
      acc.archived += Number((entry.casesByStatus && entry.casesByStatus.archived) || 0);
      acc.triggerPassed += Number(entry.triggerPassedCount || 0);
      acc.executionPassed += Number(entry.executionPassedCount || 0);
      return acc;
    }, { totalCases: 0, totalRuns: 0, draft: 0, ready: 0, archived: 0, triggerPassed: 0, executionPassed: 0 });

    if (dom.summaryHighlights) {
      const triggerRate = totals.totalRuns > 0 ? Math.round((totals.triggerPassed / totals.totalRuns) * 100) : 0;
      const executionRate = totals.totalRuns > 0 ? Math.round((totals.executionPassed / totals.totalRuns) * 100) : 0;
      const refreshTag = summaryRefreshLabel ? `<span class="tag">最近刷新 ${escapeHtml(summaryRefreshLabel)}</span>` : '';
      const loadingTag = state.summaryLoading
        ? '<span class="tag tag-pending">概览刷新中...</span>'
        : (state.summaryLoadError ? '<span class="tag tag-error">概览刷新失败</span>' : '');
      dom.summaryHighlights.innerHTML = `
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
    if (state.summaryLoadError) {
      html += `
        <div class="skill-test-inline-banner skill-test-inline-banner-error">
          <p class="section-hint">概览刷新失败，当前仍显示${summaryRefreshLabel ? `${escapeHtml(summaryRefreshLabel)} 的` : '上一次成功加载的'}结果。</p>
          <div class="panel-actions">
            <button class="ghost-button" type="button" data-st-summary-retry="true">重试</button>
          </div>
        </div>
      `;
    } else if (state.summaryLoading) {
      html += `<div class="skill-test-inline-banner skill-test-inline-banner-pending"><p class="section-hint">概览刷新中${summaryRefreshLabel ? `，当前先显示 ${escapeHtml(summaryRefreshLabel)} 的结果。` : '，你可以先查看已加载结果。'}</p></div>`;
    }
    html += '<div class="table-scroll"><table class="summary-table"><thead><tr>';
    html += '<th>Skill</th><th>用例</th><th>运行</th>';
    html += '<th>状态</th><th>加载成功</th><th>执行通过</th><th>目标达成</th><th>工具成功</th>';
    html += '</tr></thead><tbody>';

    for (const entry of state.summary) {
      const triggerRate = entry.triggerRate != null ? (entry.triggerRate * 100).toFixed(1) + '%' : '—';
      const execRate = entry.executionRate != null ? (entry.executionRate * 100).toFixed(1) + '%' : '—';
      const goalAchievement = entry.avgGoalAchievement != null ? (entry.avgGoalAchievement * 100).toFixed(1) + '%' : '—';
      const toolSuccess = entry.avgToolCallSuccessRate != null ? (entry.avgToolCallSuccessRate * 100).toFixed(1) + '%' : '—';
      const draftCount = Number((entry.casesByStatus && entry.casesByStatus.draft) || 0);
      const readyCount = Number((entry.casesByStatus && entry.casesByStatus.ready) || 0);
      const archivedCount = Number((entry.casesByStatus && entry.casesByStatus.archived) || 0);

      html += `<tr>`;
      html += `<td>${escapeHtml(entry.skillId)}</td>`;
      html += `<td>${entry.totalCases}</td>`;
      html += `<td>${entry.totalRuns}</td>`;
      html += `<td>Draft ${draftCount} / Ready ${readyCount} / Archived ${archivedCount}</td>`;
      html += `<td>${triggerRate}</td>`;
      html += `<td>${execRate}</td>`;
      html += `<td>${goalAchievement}</td>`;
      html += `<td>${toolSuccess}</td>`;
      html += `</tr>`;
    }

    html += '</tbody></table></div>';
    dom.summaryBody.innerHTML = html;
    const retryButton = dom.summaryBody.querySelector('[data-st-summary-retry="true"]');
    if (retryButton) {
      retryButton.addEventListener('click', loadSummary);
    }
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

  function getExpectedStepsSearchText(expectedSteps) {
    return Array.isArray(expectedSteps)
      ? expectedSteps.map((entry) => {
          if (!entry || typeof entry !== 'object') return '';
          return [entry.id, entry.title, entry.expectedBehavior].filter(Boolean).join(' ');
        }).filter(Boolean).join(' ')
      : '';
  }

  function parseStructuredArray(value) {
    const text = String(value || '').trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function parseStructuredExpectedTools(value) {
    return parseStructuredArray(value);
  }

  function parseStructuredObject(value) {
    const text = String(value || '').trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
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

  function getCaseStatusMeta(caseStatus) {
    if (caseStatus === 'ready') {
      return { label: 'Ready', className: 'tag-success' };
    }
    if (caseStatus === 'archived') {
      return { label: 'Archived', className: 'tag' };
    }
    return { label: 'Draft', className: 'tag-pending' };
  }

  function getCaseStatusHelpText(testCase) {
    if (testCase.caseStatus === 'ready') {
      return '这条用例已确认可纳入批量运行；后续主要看稳定性和回归表现。';
    }
    if (testCase.caseStatus === 'archived') {
      return '这条用例已归档，不会再进入批量运行。';
    }
    return '这条用例当前是 draft；先改 prompt / 目标 / 工具，再标记 ready。';
  }

  function isPassedFlag(value) {
    return value === true || value === 1;
  }

  function isFailedFlag(value) {
    return value === false || value === 0;
  }

  function getExecutionOutcomeState(run) {
    if (!run) return 'unknown';
    if (run.verdict === 'pass') return 'pass';
    if (run.verdict === 'fail') return 'fail';
    if (run.verdict === 'borderline') return 'review';
    if (isPassedFlag(run.executionPassed)) return 'pass';
    if (isFailedFlag(run.executionPassed)) return 'fail';
    return 'unknown';
  }

  function isFailingRun(run) {
    return Boolean(run) && (isFailedFlag(run.triggerPassed) || getExecutionOutcomeState(run) === 'fail' || Boolean(run.errorMessage));
  }

  function getLastOutcomeSummary(run) {
    if (!run) return '还没有运行记录';
    if (run.errorMessage) return `最近失败：${run.errorMessage}`;
    if (run.verdict) {
      const summary = run.evaluation && run.evaluation.summary ? `：${run.evaluation.summary}` : '';
      if (run.verdict === 'pass') return `最近运行：Full 模式通过${summary}`;
      if (run.verdict === 'borderline') return `最近运行：Full 模式待复核${summary}`;
      if (run.verdict === 'fail') return `最近失败：Full 模式未达标${summary}`;
    }
    if (isFailedFlag(run.triggerPassed)) return '最近失败：没有成功加载目标 skill';
    if (isFailedFlag(run.executionPassed)) return '最近失败：执行结果未达标';
    if (isPassedFlag(run.triggerPassed) && run.executionPassed === null) return '最近运行：Dynamic 模式已成功加载 skill';
    if (isPassedFlag(run.executionPassed)) return '最近运行：执行结果达标';
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
