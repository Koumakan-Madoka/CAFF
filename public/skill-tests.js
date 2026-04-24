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

  function triggerBrowserDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadJsonFile(payload, fileName) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    triggerBrowserDownload(blob, fileName);
  }

  function parseDownloadFileName(headerValue, fallbackFileName) {
    const raw = String(headerValue || '').trim();
    if (!raw) {
      return fallbackFileName;
    }

    const utf8Match = raw.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match && utf8Match[1]) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch (_decodeError) {
      }
    }

    const plainMatch = raw.match(/filename="?([^";]+)"?/i);
    return plainMatch && plainMatch[1] ? plainMatch[1] : fallbackFileName;
  }

  async function downloadResponseFile(url, fallbackFileName) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const errorPayload = await response.json();
        if (errorPayload && errorPayload.error) {
          message = String(errorPayload.error);
        }
      } catch (_jsonError) {
        try {
          const errorText = await response.text();
          if (errorText) {
            message = errorText;
          }
        } catch (_textError) {
        }
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const fileName = parseDownloadFileName(response.headers.get('content-disposition'), fallbackFileName);
    triggerBrowserDownload(blob, fileName);
  }

  async function exportSkillTestRunSession(runId) {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId) {
      showToast('导出失败: 缺少 run id');
      return;
    }

    try {
      await downloadResponseFile(
        `/api/skill-test-runs/${encodeURIComponent(normalizedRunId)}/session-export`,
        `skill-test-run-${normalizedRunId}-session.jsonl`
      );
      showToast('已导出 Session');
    } catch (err) {
      showToast('导出失败: ' + (err.message || err));
    }
  }

  function bindRunSessionExportButtons(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    container.querySelectorAll('[data-run-session-export-id]').forEach((button) => {
      button.addEventListener('click', () => {
        exportSkillTestRunSession(button.getAttribute('data-run-session-export-id'));
      });
    });
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
    isolationModeSelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-isolation-mode')),
    trellisModeSelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-trellis-mode')),
    trellisModeHelp: /** @type {HTMLElement | null} */ (document.getElementById('st-trellis-mode-help')),
    egressModeSelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-egress-mode')),
    chainStopPolicySelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-chain-stop-policy')),
    environmentBuildImageField: /** @type {HTMLElement | null} */ (document.getElementById('st-environment-build-image-field')),
    environmentBuildImageInput: /** @type {HTMLInputElement | null} */ (document.getElementById('st-environment-build-image')),
    environmentBuildImageHelp: /** @type {HTMLElement | null} */ (document.getElementById('st-environment-build-image-help')),
    runSettingsHint: /** @type {HTMLElement | null} */ (document.getElementById('st-run-settings-hint')),
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
    caseChainFilter: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-case-chain-filter')),
    // Detail panel
    detailEmpty: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-empty')),
    detailPanel: /** @type {HTMLElement | null} */ (document.getElementById('st-detail')),
    detailCaseId: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-case-id')),
    detailMeta: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-meta')),
    detailLastOutcome: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-last-outcome')),
    detailChainSummary: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-chain-summary')),
    detailPrompt: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-prompt')),
    detailGoal: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-goal')),
    detailBehavior: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-behavior')),
    detailStepsJson: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-steps-json')),
    detailToolsJson: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-tools-json')),
    detailSequenceJson: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-sequence-json')),
    detailRubricJson: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-rubric-json')),
    detailEnvironmentJson: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-environment-json')),
    detailNote: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-detail-note')),
    detailExpectedBehavior: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-expected-behavior')),
    detailExpectedTools: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-expected-tools')),
    detailEnvironmentSummary: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-environment-summary')),
    detailValidity: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-validity')),
    detailValidityHelp: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-validity-help')),
    detailStatusCallout: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-status-callout')),
    detailIssues: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-issues')),
    detailSaveButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-save-btn')),
    detailToggleStatusButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-toggle-status-btn')),
    detailRunButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-run-btn')),
    detailRunChainButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-run-chain-btn')),
    detailDownloadButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-download-btn')),
    detailDeleteButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('st-detail-delete-btn')),
    detailRegression: /** @type {HTMLElement | null} */ (document.getElementById('st-detail-regression')),
    liveRun: /** @type {HTMLDivElement | null} */ (document.getElementById('st-live-run')),
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
    createTestType: /** @type {HTMLSelectElement | null} */ (document.getElementById('st-create-test-type')),
    createTools: /** @type {HTMLInputElement | null} */ (document.getElementById('st-create-tools')),
    createToolSpecs: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-tool-specs')),
    createGoal: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-goal')),
    createSteps: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-steps')),
    createSequence: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-sequence')),
    createRubric: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-rubric')),
    createEnvironmentJson: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('st-create-environment-json')),
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
    chainFilter: 'all',
    activeDetailTab: 'overview',
    casesLoading: false,
    casesLoadError: '',
    casesLastLoadedAt: '',
    environmentAssets: [],
    environmentAssetsLoadError: '',
    environmentAssetsLastLoadedAt: '',
    summaryLoading: false,
    summaryLoadError: '',
    summaryLastLoadedAt: '',
    skillTestEventSource: null,
    liveSkillRunsByCaseId: new Map(),
    liveSkillRunCaseIdByMessageId: new Map(),
    liveSkillChainRunsByChainRunId: new Map(),
    liveSkillChainRunIdByExportChainId: new Map(),
  };
  let syncSelectedCaseRunsAutoRefresh = () => {};
  let scheduleSelectedCaseRunsRefresh = (_caseId, _options = {}) => {};

  function readInitialSkillTestDeepLink() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const tab = String(params.get('tab') || params.get('panel') || '').trim();
      const skillId = String(params.get('skillId') || params.get('skill') || '').trim();
      const caseId = String(params.get('caseId') || params.get('case') || '').trim();
      const rawDetailTab = String(params.get('detailTab') || 'overview').trim() || 'overview';
      const detailTab = ['overview', 'details', 'runs', 'regression'].includes(rawDetailTab) ? rawDetailTab : 'overview';
      const openSkillTests = tab === 'panel-skill-tests' || tab === 'skill-tests' || Boolean(skillId || caseId);
      return { openSkillTests, skillId, caseId, detailTab };
    } catch {
      return { openSkillTests: false, skillId: '', caseId: '', detailTab: 'overview' };
    }
  }

  let pendingSkillTestDeepLink = readInitialSkillTestDeepLink();

  function emptyTraceSummary() {
    return {
      totalSteps: 0,
      sessionToolCount: 0,
      bridgeToolCount: 0,
      failedSteps: 0,
      succeededSteps: 0,
      totalDurationMs: 0,
      retryCount: 0,
      hasRetries: false,
      status: 'idle',
    };
  }

  function emptyTraceActivity() {
    return {
      status: 'idle',
      hasCurrentTool: false,
      currentToolName: '',
      currentStepId: '',
      currentStepKind: '',
      inferred: false,
      label: '',
    };
  }

  function hasOwn(value, key) {
    return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
  }

  function normalizeToolTraceStepStatus(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'succeeded' || normalized === 'completed' || normalized === 'ok') return 'succeeded';
    if (normalized === 'failed' || normalized === 'error' || normalized === 'timeout') return 'failed';
    if (normalized === 'running' || normalized === 'queued' || normalized === 'pending') return normalized;
    return normalized || 'observed';
  }

  function mergeToolTraceStep(existingStep, incomingStep) {
    const nextStep = {
      ...(existingStep && typeof existingStep === 'object' ? existingStep : {}),
      ...(incomingStep && typeof incomingStep === 'object' ? incomingStep : {}),
    };
    const existingStatus = normalizeToolTraceStepStatus(existingStep && existingStep.status ? existingStep.status : '');
    const incomingStatus = normalizeToolTraceStepStatus(incomingStep && incomingStep.status ? incomingStep.status : '');
    const stepKind = String(nextStep && nextStep.kind ? nextStep.kind : '').trim();
    if (stepKind === 'session' && incomingStatus === 'observed' && existingStatus === 'running') {
      nextStep.status = 'running';
    } else {
      nextStep.status = incomingStatus || existingStatus || 'observed';
    }
    return nextStep;
  }

  function rebuildLiveRunTrace(trace) {
    const nextTrace = trace && typeof trace === 'object'
      ? trace
      : {
          message: null,
          task: null,
          session: null,
          sessionToolCalls: [],
          bridgeToolEvents: [],
          steps: [],
          summary: emptyTraceSummary(),
          activity: emptyTraceActivity(),
          failureContext: null,
        };
    const steps = Array.isArray(nextTrace.steps) ? nextTrace.steps.filter(Boolean) : [];
    const mergedSteps = [];
    const stepIndexById = new Map();
    for (const rawStep of steps) {
      const stepId = String(rawStep && rawStep.stepId ? rawStep.stepId : '').trim() || `tool-step-${mergedSteps.length + 1}`;
      const nextStep = {
        ...rawStep,
        stepId,
        kind: rawStep && rawStep.kind ? String(rawStep.kind) : 'session',
        status: normalizeToolTraceStepStatus(rawStep && rawStep.status ? rawStep.status : ''),
      };
      const existingIndex = stepIndexById.get(stepId);
      if (existingIndex === undefined) {
        stepIndexById.set(stepId, mergedSteps.length);
        mergedSteps.push(nextStep);
      } else {
        mergedSteps[existingIndex] = mergeToolTraceStep(mergedSteps[existingIndex], nextStep);
      }
    }
    const sessionSteps = mergedSteps.filter((step) => step && step.kind === 'session');
    const bridgeSteps = mergedSteps.filter((step) => step && step.kind === 'bridge');
    const failedSteps = mergedSteps.filter((step) => normalizeToolTraceStepStatus(step && step.status) === 'failed');
    const runningStep = mergedSteps.slice().reverse().find((step) => {
      const status = normalizeToolTraceStepStatus(step && step.status ? step.status : '');
      return status === 'running' || status === 'queued';
    }) || null;
    const summaryStatus = failedSteps.length > 0
      ? 'failed'
      : runningStep || String(nextTrace && nextTrace.task && nextTrace.task.status || '').trim().toLowerCase() === 'running'
        ? 'running'
        : mergedSteps.length > 0
          ? 'succeeded'
          : 'idle';
    nextTrace.steps = mergedSteps.map((step, index) => ({ ...step, timelineIndex: index }));
    nextTrace.sessionToolCalls = sessionSteps;
    nextTrace.bridgeToolEvents = bridgeSteps;
    nextTrace.summary = {
      totalSteps: mergedSteps.length,
      sessionToolCount: sessionSteps.length,
      bridgeToolCount: bridgeSteps.length,
      failedSteps: failedSteps.length,
      succeededSteps: bridgeSteps.filter((step) => normalizeToolTraceStepStatus(step && step.status) === 'succeeded').length,
      totalDurationMs: bridgeSteps.reduce((sum, step) => {
        const value = Number(step && step.durationMs);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0),
      retryCount: 0,
      hasRetries: false,
      status: summaryStatus,
    };
    if (runningStep && runningStep.toolName) {
      nextTrace.activity = {
        status: summaryStatus,
        hasCurrentTool: true,
        currentToolName: String(runningStep.toolName),
        currentStepId: String(runningStep.stepId || ''),
        currentStepKind: String(runningStep.kind || ''),
        inferred: false,
        label: `当前工具：${runningStep.toolName}`,
      };
    } else {
      nextTrace.activity = {
        ...emptyTraceActivity(),
        status: summaryStatus,
      };
    }
    return nextTrace;
  }

  function buildRunDetailTraceFromDebug(debug, run) {
    const debugPayload = debug && typeof debug === 'object' ? debug : {};
    const session = debugPayload.session && typeof debugPayload.session === 'object' ? debugPayload.session : {};
    const toolEvents = Array.isArray(debugPayload.toolCalls) ? debugPayload.toolCalls : [];
    const sessionToolCalls = Array.isArray(session.toolCalls) ? session.toolCalls : [];
    if (toolEvents.length === 0 && sessionToolCalls.length === 0) {
      return null;
    }

    const steps = [];
    for (let index = 0; index < sessionToolCalls.length; index += 1) {
      const toolCall = sessionToolCalls[index] && typeof sessionToolCalls[index] === 'object' ? sessionToolCalls[index] : {};
      const toolCallId = String(toolCall.toolCallId || '').trim();
      steps.push({
        stepId: toolCallId ? `session-${toolCallId}` : `debug-session-${index + 1}`,
        kind: 'session',
        toolCallId,
        toolName: String(toolCall.toolName || '').trim() || 'tool',
        status: 'observed',
        requestSummary: toolCall.arguments !== undefined ? toolCall.arguments : null,
      });
    }

    for (let index = 0; index < toolEvents.length; index += 1) {
      const eventEntry = toolEvents[index] && typeof toolEvents[index] === 'object' ? toolEvents[index] : {};
      const payload = eventEntry.payload && typeof eventEntry.payload === 'object' ? eventEntry.payload : {};
      steps.push({
        stepId: String(payload.toolCallId || eventEntry.createdAt || `debug-bridge-${index + 1}`).trim(),
        kind: 'bridge',
        toolCallId: String(payload.toolCallId || '').trim(),
        toolName: String(payload.tool || payload.toolName || '').trim() || 'tool',
        status: normalizeToolTraceStepStatus(payload.status),
        createdAt: String(eventEntry.createdAt || '').trim(),
        durationMs: Number.isFinite(Number(payload.durationMs)) ? Number(payload.durationMs) : null,
        requestSummary: payload.request !== undefined ? payload.request : null,
        resultSummary: payload.result !== undefined ? payload.result : null,
        errorSummary: payload.error !== undefined ? payload.error : null,
      });
    }

    const failureText = String(run && run.errorMessage || '').trim();
    return rebuildLiveRunTrace({
      message: null,
      task: null,
      session: null,
      sessionToolCalls: [],
      bridgeToolEvents: [],
      steps,
      summary: emptyTraceSummary(),
      activity: emptyTraceActivity(),
      failureContext: failureText
        ? {
            hasFailure: true,
            source: 'message',
            stepId: '',
            toolName: '',
            text: failureText,
          }
        : null,
    });
  }

  function buildRunDetailTrace(tracePayload, debug, run) {
    const storedTrace = tracePayload && typeof tracePayload === 'object'
      ? rebuildLiveRunTrace(tracePayload)
      : null;
    if (storedTrace && ((storedTrace.summary && storedTrace.summary.totalSteps > 0) || (storedTrace.failureContext && storedTrace.failureContext.text))) {
      return storedTrace;
    }
    return buildRunDetailTraceFromDebug(debug, run) || storedTrace;
  }

  function resolveLiveRunOutputText(payload, existingOutputText, phase) {
    if (hasOwn(payload, 'outputText')) {
      return String(payload.outputText || '');
    }
    if ((phase === 'output_delta' || phase === 'assistant_text_delta') && hasOwn(payload, 'delta')) {
      return `${String(existingOutputText || '')}${String(payload.delta || '')}`;
    }
    if (phase === 'started') {
      return '';
    }
    return String(existingOutputText || '');
  }

  function createLiveSkillRun(payload = {}) {
    const messageId = String(payload.messageId || '').trim();
    const taskId = String(payload.taskId || '').trim();
    const phase = String(payload.phase || '').trim().toLowerCase();
    return {
      caseId: String(payload.caseId || '').trim(),
      skillId: String(payload.skillId || '').trim(),
      loadingMode: String(payload.loadingMode || '').trim(),
      testType: String(payload.testType || '').trim(),
      conversationId: String(payload.conversationId || '').trim(),
      turnId: String(payload.turnId || '').trim(),
      taskId,
      messageId,
      runId: payload.runId || null,
      provider: String(payload.provider || '').trim(),
      model: String(payload.model || '').trim(),
      promptVersion: String(payload.promptVersion || '').trim(),
      status: String(payload.status || 'running').trim() || 'running',
      executionRuntime: String(payload.executionRuntime || '').trim(),
      progressLabel: String(payload.progressLabel || '').trim(),
      createdAt: String(payload.createdAt || '').trim(),
      finishedAt: String(payload.finishedAt || '').trim(),
      outputText: resolveLiveRunOutputText(payload, '', phase),
      errorMessage: String(payload.errorMessage || '').trim(),
      trace: rebuildLiveRunTrace(payload.trace || {
        message: messageId ? { id: messageId, status: 'streaming', taskId, runId: payload.runId || null, createdAt: String(payload.createdAt || '').trim() } : null,
        task: taskId ? { id: taskId, status: 'running', runId: payload.runId || null } : null,
        session: null,
        sessionToolCalls: [],
        bridgeToolEvents: [],
        steps: [],
        summary: emptyTraceSummary(),
        activity: emptyTraceActivity(),
        failureContext: null,
      }),
    };
  }

  function finalizeLiveSkillRunSteps(liveRun) {
    if (!liveRun || !liveRun.trace || !Array.isArray(liveRun.trace.steps)) {
      return;
    }
    const fallbackStatus = liveRun.status === 'failed' ? 'failed' : 'succeeded';
    liveRun.trace.steps = liveRun.trace.steps.map((step) => {
      if (!step || normalizeToolTraceStepStatus(step.status) !== 'running') {
        return step;
      }
      return { ...step, status: fallbackStatus };
    });
    liveRun.trace = rebuildLiveRunTrace(liveRun.trace);
  }

  function isTerminalLiveRunStatus(status) {
    const normalized = String(status || '').trim().toLowerCase();
    return normalized === 'completed' || normalized === 'succeeded' || normalized === 'failed';
  }

  function applyLiveSkillRunPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const caseId = String(payload.caseId || '').trim();
    if (!caseId) {
      return;
    }
    const phase = String(payload.phase || '').trim().toLowerCase();
    const existing = state.liveSkillRunsByCaseId.get(caseId) || null;
    const nextRun = existing ? {
      ...existing,
      ...payload,
      ...(phase === 'started' ? { outputText: '', errorMessage: '', finishedAt: '' } : {}),
      status: String(payload.status || existing.status || '').trim() || existing.status,
      outputText: resolveLiveRunOutputText(payload, existing.outputText, phase),
      errorMessage: payload.errorMessage !== undefined ? String(payload.errorMessage || '') : phase === 'started' ? '' : existing.errorMessage,
      finishedAt: payload.finishedAt !== undefined ? String(payload.finishedAt || '') : phase === 'started' ? '' : existing.finishedAt,
      trace: rebuildLiveRunTrace(payload.trace || existing.trace),
    } : createLiveSkillRun(payload);

    const previousMessageId = existing && existing.messageId ? String(existing.messageId).trim() : '';
    const nextMessageId = nextRun.messageId ? String(nextRun.messageId).trim() : '';
    const terminalPhase = phase === 'completed' || phase === 'failed';

    state.liveSkillRunsByCaseId.set(caseId, nextRun);
    if (previousMessageId && (previousMessageId !== nextMessageId || terminalPhase)) {
      state.liveSkillRunCaseIdByMessageId.delete(previousMessageId);
    }
    if (nextMessageId && !terminalPhase) {
      state.liveSkillRunCaseIdByMessageId.set(nextMessageId, caseId);
    }

    if (terminalPhase) {
      finalizeLiveSkillRunSteps(nextRun);
    }

    renderLiveSkillRun();
    scheduleSelectedCaseRunsRefresh(caseId, { force: terminalPhase });
    syncSelectedCaseRunsAutoRefresh();
  }

  function applyLiveSkillToolEvent(payload) {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const messageId = String(payload.messageId || payload.assistantMessageId || '').trim();
    if (!messageId) {
      return;
    }
    const caseId = state.liveSkillRunCaseIdByMessageId.get(messageId);
    if (!caseId) {
      return;
    }
    const liveRun = state.liveSkillRunsByCaseId.get(caseId);
    const step = payload.step && typeof payload.step === 'object' ? { ...payload.step } : null;
    if (!liveRun || !step) {
      return;
    }
    if (String(liveRun.messageId || '').trim() !== messageId) {
      return;
    }
    const liveRunStatus = String(liveRun.status || '').trim().toLowerCase();
    if (liveRunStatus === 'completed' || liveRunStatus === 'succeeded' || liveRunStatus === 'failed') {
      return;
    }

    const trace = rebuildLiveRunTrace(liveRun.trace);
    if (!trace.message) {
      trace.message = { id: messageId, status: 'streaming', taskId: liveRun.taskId || null, runId: liveRun.runId || null, createdAt: liveRun.createdAt || '' };
    }
    if (!trace.task && liveRun.taskId) {
      trace.task = { id: liveRun.taskId, status: liveRunStatus === 'terminating' ? 'terminating' : 'running', runId: liveRun.runId || null };
    }
    const stepId = String(step.stepId || '').trim();
    const existingIndex = stepId ? trace.steps.findIndex((entry) => entry && entry.stepId === stepId) : -1;
    if (payload.phase === 'started' && step.kind === 'session') {
      trace.steps = trace.steps.map((entry) => {
        if (!entry || entry.kind !== 'session' || normalizeToolTraceStepStatus(entry.status) !== 'running' || entry.stepId === stepId) {
          return entry;
        }
        return { ...entry, status: 'observed' };
      });
    }
    if (existingIndex === -1) {
      trace.steps.push(step);
    } else {
      trace.steps[existingIndex] = mergeToolTraceStep(trace.steps[existingIndex], step);
    }
    liveRun.trace = rebuildLiveRunTrace(trace);
    state.liveSkillRunsByCaseId.set(caseId, liveRun);
    renderLiveSkillRun();
  }

  function getSelectedLiveSkillChainRun() {
    if (!state.selectedCaseId) {
      return null;
    }
    const selectedCase = state.testCases.find((testCase) => testCase && testCase.id === state.selectedCaseId) || null;
    const chainRunRequest = getCaseChainRunRequest(selectedCase);
    const exportChainId = chainRunRequest && chainRunRequest.exportChainId ? String(chainRunRequest.exportChainId).trim() : '';
    if (!exportChainId) {
      return null;
    }
    const chainRunId = state.liveSkillChainRunIdByExportChainId.get(exportChainId);
    return chainRunId ? state.liveSkillChainRunsByChainRunId.get(chainRunId) || null : null;
  }

  function isLiveSkillRunActive(liveRun) {
    const status = String(liveRun && liveRun.status || '').trim().toLowerCase();
    return status === 'running' || status === 'terminating' || status === 'pending';
  }

  function hasSelectedCaseLiveRun() {
    if (!state.selectedCaseId) {
      return false;
    }
    return isLiveSkillRunActive(state.liveSkillRunsByCaseId.get(state.selectedCaseId) || null);
  }

  function hasSelectedCaseLiveChainRun() {
    const liveChainRun = getSelectedLiveSkillChainRun();
    const status = String(liveChainRun && liveChainRun.status || liveChainRun && liveChainRun.chainRun && liveChainRun.chainRun.status || '').trim().toLowerCase();
    return status === 'running' || status === 'pending';
  }

  function normalizeLiveSkillChainRunPayload(payload) {
    const chainRun = payload && payload.chainRun && typeof payload.chainRun === 'object' ? payload.chainRun : {};
    const chainRunId = String(payload && (payload.chainRunId || payload.id) || chainRun.id || '').trim();
    const exportChainId = String(payload && payload.exportChainId || chainRun.exportChainId || '').trim();
    const phase = String(payload && payload.phase || '').trim().toLowerCase();
    const status = String(payload && payload.status || chainRun.status || (phase === 'failed' ? 'failed' : 'running')).trim() || 'running';
    return {
      chainRunId,
      exportChainId,
      skillId: String(payload && payload.skillId || chainRun.skillId || '').trim(),
      phase,
      status,
      progressLabel: String(payload && payload.progressLabel || '').trim(),
      runnerStage: String(payload && payload.runnerStage || '').trim(),
      chainRun: {
        ...chainRun,
        id: chainRunId || chainRun.id || '',
        exportChainId,
        status,
      },
      steps: Array.isArray(payload && payload.steps) ? payload.steps : null,
      warnings: Array.isArray(payload && payload.warnings) ? payload.warnings : null,
      issues: Array.isArray(payload && payload.issues) ? payload.issues : null,
      pollUrl: String(payload && payload.pollUrl || '').trim(),
      currentStepId: String(payload && payload.currentStepId || '').trim(),
      currentStepIndex: Number(payload && payload.currentStepIndex || chainRun.currentStepIndex || 0) || 0,
      currentTestCaseId: String(payload && payload.currentTestCaseId || '').trim(),
      updatedAt: String(payload && payload.updatedAt || new Date().toISOString()).trim(),
    };
  }

  function applyLiveSkillChainRunPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const normalized = normalizeLiveSkillChainRunPayload(payload);
    if (!normalized.chainRunId || !normalized.exportChainId) {
      return;
    }
    if (normalized.skillId && state.selectedSkillId && normalized.skillId !== state.selectedSkillId) {
      return;
    }

    const existing = state.liveSkillChainRunsByChainRunId.get(normalized.chainRunId) || null;
    const existingChainRun = existing && existing.chainRun && typeof existing.chainRun === 'object' ? existing.chainRun : {};
    const next = {
      ...(existing || {}),
      ...normalized,
      chainRun: {
        ...existingChainRun,
        ...normalized.chainRun,
      },
      steps: normalized.steps || (existing && Array.isArray(existing.steps) ? existing.steps : []),
      warnings: normalized.warnings || (existing && Array.isArray(existing.warnings) ? existing.warnings : []),
      issues: normalized.issues || (existing && Array.isArray(existing.issues) ? existing.issues : []),
    };

    state.liveSkillChainRunsByChainRunId.set(normalized.chainRunId, next);
    state.liveSkillChainRunIdByExportChainId.set(normalized.exportChainId, normalized.chainRunId);
    renderLiveSkillRun();
    const terminalStatus = ['passed', 'failed', 'partial', 'aborted'].includes(String(next.status || '').trim().toLowerCase());
    const selectedCase = state.selectedCaseId
      ? state.testCases.find((testCase) => testCase && testCase.id === state.selectedCaseId) || null
      : null;
    const selectedChainRunRequest = getCaseChainRunRequest(selectedCase);
    const selectedExportChainId = selectedChainRunRequest && selectedChainRunRequest.exportChainId
      ? String(selectedChainRunRequest.exportChainId).trim()
      : '';
    const affectsSelectedCase = Boolean(state.selectedCaseId)
      && (selectedExportChainId === normalized.exportChainId || state.selectedCaseId === String(next.currentTestCaseId || '').trim());
    if (affectsSelectedCase) {
      scheduleSelectedCaseRunsRefresh(state.selectedCaseId, { force: terminalStatus });
    }
    syncSelectedCaseRunsAutoRefresh();
  }

  function reconcileLiveSkillChainRunFromFinalResult(exportChainId, result) {
    const payload = result && typeof result === 'object' ? result : {};
    const chainRun = payload.chainRun && typeof payload.chainRun === 'object' ? payload.chainRun : null;
    if (!chainRun) {
      return;
    }
    const status = String(chainRun.status || '').trim().toLowerCase();
    applyLiveSkillChainRunPayload({
      ...payload,
      chainRun,
      exportChainId: exportChainId || chainRun.exportChainId || '',
      chainRunId: chainRun.id || '',
      phase: status === 'passed' || status === 'partial' ? 'completed' : status === 'running' ? 'progress' : 'failed',
      status: status || 'completed',
      progressLabel: status === 'passed'
        ? '链运行完成。'
        : status === 'partial'
          ? '链运行部分完成。'
          : status === 'failed' || status === 'aborted'
            ? (chainRun.errorMessage || '链运行失败。')
            : '',
    });
  }

  function liveChainRunTone(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'failed' || normalized === 'aborted') return 'failed';
    if (normalized === 'passed') return 'success';
    if (normalized === 'partial') return 'running';
    if (normalized === 'running' || normalized === 'pending') return 'running';
    return 'neutral';
  }

  function liveChainRunStatusLabel(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'passed') return '链运行通过';
    if (normalized === 'failed') return '链运行失败';
    if (normalized === 'partial') return '链运行部分完成';
    if (normalized === 'aborted') return '链运行中止';
    if (normalized === 'running') return '链运行中';
    return '链运行待定';
  }

  function getLiveCaseActionLabel(hasLiveRun) {
    return hasLiveRun ? '查看实时调用' : '切到当前步骤';
  }

  function buildLiveSkillChainRunHtml(liveChainRun) {
    const chainRun = liveChainRun && liveChainRun.chainRun && typeof liveChainRun.chainRun === 'object' ? liveChainRun.chainRun : {};
    const steps = Array.isArray(liveChainRun && liveChainRun.steps) ? liveChainRun.steps : [];
    const warnings = Array.isArray(liveChainRun && liveChainRun.warnings) ? liveChainRun.warnings : [];
    const status = String(liveChainRun && liveChainRun.status || chainRun.status || '').trim() || 'running';
    const tone = liveChainRunTone(status);
    const currentStepIndex = Number(liveChainRun && liveChainRun.currentStepIndex || chainRun.currentStepIndex || 0) || 0;
    const progressLabel = String(liveChainRun && liveChainRun.progressLabel || '').trim();
    const stepCards = steps.length > 0
      ? steps.map((step) => {
          const stepStatus = String(step && step.status || '').trim().toLowerCase() || 'pending';
          const stepTone = stepStatus === 'failed' || stepStatus === 'aborted'
            ? 'failed'
            : stepStatus === 'running'
              ? 'running'
              : stepStatus === 'passed'
                ? 'success'
                : 'neutral';
          const sequenceIndex = Number(step && step.sequenceIndex || 0) || 0;
          const title = String(step && (step.title || step.testCaseId) || 'chain step').trim();
          const summary = String(step && (step.summary || step.errorMessage) || '').trim();
          const stepCaseId = String(step && step.testCaseId || '').trim();
          const hasLiveRun = Boolean(stepCaseId && state.liveSkillRunsByCaseId.get(stepCaseId));
          const isCurrent = currentStepIndex > 0 && sequenceIndex === currentStepIndex && status === 'running';
          const liveActionLabel = getLiveCaseActionLabel(hasLiveRun);
          const liveAction = stepCaseId && (isCurrent || hasLiveRun)
            ? `<div class="run-item-actions" style="margin-top:0.4rem"><button type="button" class="mini-action" data-live-chain-step-case-id="${escapeHtml(stepCaseId)}">${liveActionLabel}</button></div>`
            : '';
          return `<article class="message-tool-trace-step ${stepTone}${isCurrent ? ' last' : ''}" data-step-id="chain-step-${escapeHtml(String(step && step.id || sequenceIndex || ''))}">
            <div class="message-tool-trace-step-rail"><div class="message-tool-trace-step-index">${escapeHtml(String(sequenceIndex || '—'))}</div><div class="message-tool-trace-step-line"></div></div>
            <div class="message-tool-trace-step-main">
              <div class="message-tool-trace-step-header">
                <div class="message-tool-trace-step-title-wrap">
                  <div class="message-tool-trace-step-eyebrow">chain step</div>
                  <div class="message-tool-trace-step-title">${escapeHtml(title)}</div>
                </div>
                <div class="message-tool-trace-step-meta"><span class="message-tool-trace-pill ${stepTone}">${escapeHtml(stepStatus)}</span></div>
              </div>
              ${summary ? `<div class="message-tool-trace-note${stepStatus === 'failed' ? ' failed' : ''}">${escapeHtml(summary)}</div>` : ''}
              ${liveAction}
            </div>
          </article>`;
        }).join('')
      : `<div class="message-tool-trace-note">${escapeHtml(progressLabel || '等待链步骤事件…')}</div>`;
    const warningText = warnings.length > 0
      ? `<div class="message-tool-trace-note">提醒：${escapeHtml(String(warnings.length))} 条；请在链详情中查看。</div>`
      : '';
    const errorText = chainRun.errorMessage
      ? `<div class="message-tool-trace-note failed">错误：${escapeHtml(String(chainRun.errorMessage || ''))}</div>`
      : '';
    const summaryHtml = buildRunSummarySectionHtml({
      title: '链运行摘要',
      tags: [
        buildStatusTagHtml(status, liveChainRunStatusLabel(status)),
        `<span class="tag">steps ${escapeHtml(String(chainRun.lastCompletedStepIndex || 0))}/${escapeHtml(String(chainRun.totalSteps || steps.length || 0))}</span>`,
        chainRun.bootstrapStatus ? `<span class="tag">bootstrap ${escapeHtml(String(chainRun.bootstrapStatus))}</span>` : '',
        chainRun.teardownStatus ? `<span class="tag">teardown ${escapeHtml(String(chainRun.teardownStatus))}</span>` : '',
      ],
      metaParts: [
        chainRun.startedAt ? new Date(chainRun.startedAt).toLocaleString() : '',
        chainRun.exportChainId ? String(chainRun.exportChainId) : '',
      ],
    });

    return `
      ${summaryHtml}
      <section class="message-tool-trace open">
        <div class="message-tool-trace-header">
          <div class="message-tool-trace-summary">
            <span class="message-tool-trace-pill ${tone}">${escapeHtml(liveChainRunStatusLabel(status))}</span>
            <span class="message-tool-trace-pill time">steps ${escapeHtml(String(chainRun.lastCompletedStepIndex || 0))}/${escapeHtml(String(chainRun.totalSteps || steps.length || 0))}</span>
            ${chainRun.bootstrapStatus ? `<span class="message-tool-trace-pill duration">bootstrap ${escapeHtml(String(chainRun.bootstrapStatus))}</span>` : ''}
            ${chainRun.teardownStatus ? `<span class="message-tool-trace-pill duration">teardown ${escapeHtml(String(chainRun.teardownStatus))}</span>` : ''}
          </div>
        </div>
        <div class="message-tool-trace-details">
          ${progressLabel ? `<div class="message-tool-trace-note">${escapeHtml(progressLabel)}</div>` : ''}
          ${warningText}
          ${errorText}
          <section class="message-tool-trace-section">
            <div class="message-tool-trace-section-header">
              <div class="message-tool-trace-section-title">链步骤</div>
              <div class="message-tool-trace-section-meta"></div>
            </div>
            <div class="message-tool-trace-steps-viewport scrollable">
              <div class="message-tool-trace-section-steps">${stepCards}</div>
            </div>
          </section>
        </div>
      </section>
    `;
  }

  function liveRunTone(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'failed') return 'failed';
    if (normalized === 'running' || normalized === 'terminating') return 'running';
    if (normalized === 'completed' || normalized === 'succeeded') return 'success';
    return 'neutral';
  }

  function liveRunStatusLabel(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'failed') return '运行失败';
    if (normalized === 'running') return '运行中';
    if (normalized === 'terminating') return '收尾中';
    if (normalized === 'completed' || normalized === 'succeeded') return '运行完成';
    return '等待中';
  }

  const skillTestUiModules = window.CaffSkillTests || {};
  if (typeof skillTestUiModules.createPanelStateViewHelpers !== 'function') {
    throw new Error('Missing skill-test panel state helpers');
  }
  const panelStateViewHelpers = skillTestUiModules.createPanelStateViewHelpers({
    escapeHtml,
  });
  const buildCompactEmptyStateHtml = panelStateViewHelpers.buildCompactEmptyStateHtml;
  const buildInlineBannerHtml = panelStateViewHelpers.buildInlineBannerHtml;
  const renderLoadingState = panelStateViewHelpers.renderLoadingState;
  const renderRetryState = panelStateViewHelpers.renderRetryState;

  if (typeof skillTestUiModules.createSummaryViewHelpers !== 'function') {
    throw new Error('Missing skill-test summary view helpers');
  }
  const summaryViewHelpers = skillTestUiModules.createSummaryViewHelpers({
    escapeHtml,
    formatRefreshTime,
    renderRetryState,
    renderLoadingState,
    buildCompactEmptyStateHtml,
    buildInlineBannerHtml,
  });

  if (typeof skillTestUiModules.createSelectedSkillOverviewViewHelpers !== 'function') {
    throw new Error('Missing skill-test selected skill overview helpers');
  }
  const selectedSkillOverviewViewHelpers = skillTestUiModules.createSelectedSkillOverviewViewHelpers({
    escapeHtml,
    formatRefreshTime,
    renderStatusCallout,
    isFailingRun,
    readCaseValidation,
    getSkillTestChainPlanningMeta,
  });

  if (typeof skillTestUiModules.createRunDetailViewHelpers !== 'function') {
    throw new Error('Missing skill-test run detail helpers');
  }
  const runDetailViewHelpers = skillTestUiModules.createRunDetailViewHelpers({
    escapeHtml,
    rebuildLiveRunTrace,
    buildToolTraceStepsHtml,
    liveRunTone,
    liveRunStatusLabel,
    getExecutionOutcomeState,
    isPassedFlag,
    isFailedFlag,
    getEnvironmentStatusMeta,
    getEnvironmentBuildStatusMeta,
  });
  const getRunStatusTagMeta = runDetailViewHelpers.getRunStatusTagMeta;
  const buildStatusTagHtml = runDetailViewHelpers.buildStatusTagHtml;
  const buildRunOutcomeTagHtml = runDetailViewHelpers.buildRunOutcomeTagHtml;
  const buildEnvironmentStatusTagHtml = runDetailViewHelpers.buildEnvironmentStatusTagHtml;
  const buildEnvironmentBuildTagHtml = runDetailViewHelpers.buildEnvironmentBuildTagHtml;
  const buildRunSummarySectionHtml = runDetailViewHelpers.buildRunSummarySectionHtml;
  const buildToolTracePanelHtml = runDetailViewHelpers.buildToolTracePanelHtml;

  if (typeof skillTestUiModules.createEnvironmentViewHelpers !== 'function') {
    throw new Error('Missing skill-test environment view helpers');
  }
  const environmentViewHelpers = skillTestUiModules.createEnvironmentViewHelpers({
    escapeHtml,
    clipText,
    isEnvironmentConfigEnabled,
    getEnvironmentStatusMeta,
    getEnvironmentCacheStatusMeta,
    getEnvironmentBuildStatusMeta,
    readEnvironmentBuildResultFromEvaluation,
    getEnvironmentBuildResultSummary,
  });
  const getEnvironmentBuildRunOutcomeSummary = environmentViewHelpers.getEnvironmentBuildRunOutcomeSummary;
  const formatEnvironmentRequirementLabel = environmentViewHelpers.formatEnvironmentRequirementLabel;
  const getEnvironmentRunOutcomeSummary = environmentViewHelpers.getEnvironmentRunOutcomeSummary;
  const formatEnvironmentConfigSummary = environmentViewHelpers.formatEnvironmentConfigSummary;
  const getEnvironmentConfigSearchText = environmentViewHelpers.getEnvironmentConfigSearchText;
  const buildEnvironmentRequirementListHtml = environmentViewHelpers.buildEnvironmentRequirementListHtml;
  const buildEnvironmentCommandSectionHtml = environmentViewHelpers.buildEnvironmentCommandSectionHtml;
  const buildEnvironmentCacheDetailsHtml = environmentViewHelpers.buildEnvironmentCacheDetailsHtml;
  const buildEnvironmentBuildDetailsHtml = environmentViewHelpers.buildEnvironmentBuildDetailsHtml;

  function liveRunPendingLabel(liveRun) {
    if (liveRun && liveRun.progressLabel) {
      return String(liveRun.progressLabel);
    }
    const runtime = String(liveRun && liveRun.executionRuntime ? liveRun.executionRuntime : '').trim().toLowerCase();
    const status = String(liveRun && liveRun.status ? liveRun.status : '').trim().toLowerCase();
    if (status === 'terminating') {
      return '正在收尾…';
    }
    if (status === 'failed') {
      return '运行失败；结束前没有收到实时工具事件。';
    }
    if (status === 'completed' || status === 'succeeded') {
      return '运行完成；本次没有收到实时工具事件。';
    }
    if (runtime === 'sandbox') {
      return '正在准备 sandbox runner…';
    }
    return '正在等待工具调用…';
  }

  function formatTracePayloadText(value) {
    if (value == null || value === '') {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function buildToolTraceStepsHtml(trace, emptyLabel) {
    const normalizedTrace = rebuildLiveRunTrace(trace);
    return Array.isArray(normalizedTrace.steps) && normalizedTrace.steps.length > 0
      ? normalizedTrace.steps.map((step, index, arr) => {
          const stepTone = normalizeToolTraceStepStatus(step && step.status) === 'failed'
            ? 'failed'
            : normalizeToolTraceStepStatus(step && step.status) === 'running'
              ? 'running'
              : 'success';
          const requestText = formatTracePayloadText(step && step.requestSummary !== undefined ? step.requestSummary : null);
          const resultText = formatTracePayloadText(
            step && step.errorSummary !== undefined && step.errorSummary !== null && step.errorSummary !== ''
              ? step.errorSummary
              : step && step.resultSummary !== undefined
                ? step.resultSummary
                : step && step.partialJson
                  ? step.partialJson
                  : ''
          );
          return `<article class="message-tool-trace-step ${stepTone}${index === arr.length - 1 ? ' last' : ''}" data-step-id="${escapeHtml(step && step.stepId ? String(step.stepId) : `tool-step-${index + 1}`)}">
            <div class="message-tool-trace-step-rail"><div class="message-tool-trace-step-index">${index + 1}</div><div class="message-tool-trace-step-line"></div></div>
            <div class="message-tool-trace-step-main">
              <div class="message-tool-trace-step-header">
                <div class="message-tool-trace-step-title-wrap">
                  <div class="message-tool-trace-step-eyebrow">${escapeHtml(step && step.kind ? String(step.kind) : 'tool')}</div>
                  <div class="message-tool-trace-step-title">${escapeHtml(step && step.toolName ? String(step.toolName) : 'tool')}</div>
                </div>
                <div class="message-tool-trace-step-meta"><span class="message-tool-trace-pill ${stepTone}">${escapeHtml(normalizeToolTraceStepStatus(step && step.status))}</span></div>
              </div>
              ${requestText ? `<div class="message-tool-trace-payload-wrap"><div class="message-tool-trace-payload-label">输入</div><pre class="message-tool-trace-payload">${escapeHtml(requestText)}</pre></div>` : ''}
              ${resultText ? `<div class="message-tool-trace-payload-wrap"><div class="message-tool-trace-payload-label">输出</div><pre class="message-tool-trace-payload${stepTone === 'failed' ? ' failed' : ''}">${escapeHtml(resultText)}</pre></div>` : ''}
            </div>
          </article>`;
        }).join('')
      : `<div class="message-tool-trace-note">${escapeHtml(emptyLabel || '本次没有持久化工具时间线。')}</div>`;
  }

  function captureElementScrollState(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const distanceFromBottom = Math.max(0, maxScrollTop - element.scrollTop);

    return {
      scrollTop: element.scrollTop,
      stickToBottom: distanceFromBottom <= 24,
    };
  }

  function restoreElementScrollState(element, snapshot) {
    if (!(element instanceof HTMLElement) || !snapshot) {
      return;
    }

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = snapshot.stickToBottom
      ? maxScrollTop
      : Math.max(0, Math.min(snapshot.scrollTop, maxScrollTop));
  }

  function captureLiveTraceViewportState(container) {
    if (!container) {
      return null;
    }

    const viewport = container.querySelector('.message-tool-trace-steps-viewport.scrollable');
    if (!(viewport instanceof HTMLElement)) {
      return null;
    }

    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const distanceFromBottom = Math.max(0, maxScrollTop - viewport.scrollTop);
    const viewportTop = viewport.getBoundingClientRect().top;
    const stepElements = Array.from(viewport.querySelectorAll('.message-tool-trace-step'));
    let anchorStepId = '';
    let anchorOffset = 0;

    for (const stepElement of stepElements) {
      if (!(stepElement instanceof HTMLElement)) {
        continue;
      }
      const rect = stepElement.getBoundingClientRect();
      if (rect.bottom <= viewportTop) {
        continue;
      }
      anchorStepId = stepElement.dataset.stepId || '';
      anchorOffset = rect.top - viewportTop;
      break;
    }

    return {
      scrollTop: viewport.scrollTop,
      stickToBottom: distanceFromBottom <= 24,
      anchorStepId,
      anchorOffset,
    };
  }

  function restoreLiveTraceViewportState(container, snapshot) {
    if (!container || !snapshot) {
      return;
    }

    const viewport = container.querySelector('.message-tool-trace-steps-viewport.scrollable');
    if (!(viewport instanceof HTMLElement)) {
      return;
    }

    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (snapshot.stickToBottom) {
      viewport.scrollTop = maxScrollTop;
      return;
    }

    if (snapshot.anchorStepId) {
      const anchorStep = Array.from(viewport.querySelectorAll('.message-tool-trace-step')).find(
        (stepElement) => stepElement instanceof HTMLElement && stepElement.dataset.stepId === snapshot.anchorStepId
      );
      if (anchorStep instanceof HTMLElement) {
        const targetScrollTop = anchorStep.offsetTop - snapshot.anchorOffset;
        viewport.scrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));
        return;
      }
    }

    viewport.scrollTop = Math.max(0, Math.min(snapshot.scrollTop, maxScrollTop));
  }

  function bindLiveSkillRunActions(container) {
    if (!container || typeof container.querySelectorAll !== 'function') {
      return;
    }
    container.querySelectorAll('[data-live-chain-step-case-id]').forEach((button) => {
      button.addEventListener('click', () => {
        openCaseLiveRun(button.getAttribute('data-live-chain-step-case-id'));
      });
    });
  }

  function renderLiveSkillRun() {
    const container = dom.liveRun;
    if (!container) {
      return;
    }
    const preservedContainerScroll = captureElementScrollState(container);
    const preservedViewport = captureLiveTraceViewportState(container);
    const liveRun = state.selectedCaseId ? state.liveSkillRunsByCaseId.get(state.selectedCaseId) || null : null;
    const liveChainRun = getSelectedLiveSkillChainRun();
    if (!liveRun && !liveChainRun) {
      container.innerHTML = '';
      container.classList.add('hidden');
      return;
    }
    const chainHtml = liveChainRun ? buildLiveSkillChainRunHtml(liveChainRun) : '';
    if (!liveRun) {
      container.classList.remove('hidden');
      container.innerHTML = chainHtml;
      bindLiveSkillRunActions(container);
      restoreElementScrollState(container, preservedContainerScroll);
      restoreLiveTraceViewportState(container, preservedViewport);
      return;
    }
    const trace = rebuildLiveRunTrace(liveRun.trace);
    const activity = trace.activity || emptyTraceActivity();
    const tone = liveRunTone(liveRun.status);
    const outputText = liveRun.outputText
      ? `<div class="message-tool-trace-note">模型输出：${escapeHtml(clipText(liveRun.outputText, 800))}</div>`
      : '';
    const errorText = liveRun.errorMessage
      ? `<div class="message-tool-trace-note failed">错误：${escapeHtml(liveRun.errorMessage)}</div>`
      : '';
    const liveSummaryHtml = buildRunSummarySectionHtml({
      title: '运行中摘要',
      tags: [
        buildStatusTagHtml(liveRun.status, liveRunStatusLabel(liveRun.status)),
        trace.summary && trace.summary.totalSteps > 0 ? `<span class="tag">步骤 ${escapeHtml(String(trace.summary.totalSteps))}</span>` : '',
        activity && activity.hasCurrentTool && activity.currentToolName ? `<span class="tag tag-pending">当前 ${escapeHtml(activity.currentToolName)}</span>` : '',
      ],
      metaParts: [
        liveRun.createdAt ? new Date(liveRun.createdAt).toLocaleString() : '',
        [liveRun.provider, liveRun.model].filter(Boolean).join(' / '),
        liveRun.promptVersion ? `prompt ${liveRun.promptVersion}` : '',
      ],
    });
    const liveTraceHtml = buildToolTracePanelHtml({
      sectionLabel: '工具时间线',
      helperText: '这里显示 agent 在这次运行里的实时调用顺序。',
      trace,
      status: liveRun.status,
      statusLabel: liveRunStatusLabel(liveRun.status),
      tone,
      extraPills: [
        activity && activity.hasCurrentTool && activity.currentToolName
          ? `<span class="message-tool-trace-pill running">当前：${escapeHtml(activity.currentToolName)}</span>`
          : '',
        trace.summary && trace.summary.totalSteps > 0
          ? `<span class="message-tool-trace-pill time">步骤 ${escapeHtml(String(trace.summary.totalSteps))}</span>`
          : '',
      ],
      notes: [
        liveRun.progressLabel ? `<div class="message-tool-trace-note">${escapeHtml(String(liveRun.progressLabel))}</div>` : '',
        outputText,
        errorText,
      ],
      emptyLabel: liveRunPendingLabel(liveRun),
    });

    container.classList.remove('hidden');
    container.innerHTML = `${chainHtml}${liveSummaryHtml}${liveTraceHtml}`;
    bindLiveSkillRunActions(container);
    restoreElementScrollState(container, preservedContainerScroll);
    restoreLiveTraceViewportState(container, preservedViewport);
  }

  function connectSkillTestEventStream() {
    if (state.skillTestEventSource || typeof window.EventSource !== 'function') {
      return;
    }
    const source = new window.EventSource('/api/events');
    state.skillTestEventSource = source;
    source.addEventListener('skill_test_run_event', (event) => {
      try {
        applyLiveSkillRunPayload(JSON.parse(event.data));
      } catch (_runEventParseError) {}
    });
    source.addEventListener('skill_test_chain_run_event', (event) => {
      try {
        applyLiveSkillChainRunPayload(JSON.parse(event.data));
      } catch (_chainEventParseError) {}
    });
    source.addEventListener('conversation_tool_event', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (!payload || !payload.conversationId || !String(payload.conversationId).startsWith('skill-test-')) {
          return;
        }
        applyLiveSkillToolEvent(payload);
      } catch (_toolEventParseError) {}
    });
  }

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

  function isEnvironmentConfigEnabled(config) {
    return Boolean(config && typeof config === 'object' && config.enabled === true);
  }

  function getEnvironmentStatusMeta(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (normalized === 'passed') {
      return { label: '环境通过', className: 'tag-success' };
    }
    if (normalized === 'skipped') {
      return { label: '环境跳过', className: 'tag-pending' };
    }
    if (normalized === 'runtime_unsupported') {
      return { label: '运行时不支持', className: 'tag-error' };
    }
    if (normalized === 'env_missing') {
      return { label: '环境缺失', className: 'tag-error' };
    }
    if (normalized === 'env_install_failed') {
      return { label: '安装失败', className: 'tag-error' };
    }
    if (normalized === 'env_verify_failed') {
      return { label: '验证失败', className: 'tag-error' };
    }
    return { label: `环境 ${normalized}`, className: 'tag' };
  }

  function getEnvironmentCacheStatusMeta(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (normalized === 'restored') {
      return { label: 'Cache 已恢复', className: 'tag-success' };
    }
    if (normalized === 'saved') {
      return { label: 'Cache 已保存', className: 'tag-success' };
    }
    if (normalized === 'miss') {
      return { label: 'Cache Miss', className: 'tag-pending' };
    }
    if (normalized === 'restore_failed') {
      return { label: 'Cache 恢复失败', className: 'tag-error' };
    }
    if (normalized === 'save_failed') {
      return { label: 'Cache 保存失败', className: 'tag-error' };
    }
    if (normalized === 'disabled') {
      return { label: 'Cache 关闭', className: 'tag' };
    }
    return { label: `Cache ${normalized}`, className: 'tag' };
  }

  function getEnvironmentBuildStatusMeta(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (normalized === 'image_built') {
      return { label: '镜像已构建', className: 'tag-success' };
    }
    if (normalized === 'manifest_ready') {
      return { label: 'manifest 已生成', className: 'tag-pending' };
    }
    if (normalized === 'image_build_failed') {
      return { label: '镜像构建失败', className: 'tag-error' };
    }
    return { label: `环境资产 ${normalized}`, className: 'tag' };
  }

  function readEnvironmentBuildResultFromEvaluation(evaluation) {
    const payload = evaluation && typeof evaluation === 'object' ? evaluation : null;
    return payload && payload.environmentBuild && typeof payload.environmentBuild === 'object'
      ? payload.environmentBuild
      : null;
  }

  function getEnvironmentBuildResultSummary(buildResult) {
    if (!buildResult || typeof buildResult !== 'object') {
      return '';
    }
    const status = String(buildResult.status || '').trim().toLowerCase();
    const asset = buildResult.asset && typeof buildResult.asset === 'object' ? buildResult.asset : {};
    const image = String(buildResult.image || asset.image || '').trim();
    const suggestedImage = String(buildResult.suggestedImage || buildResult.suggested_image || '').trim();
    const manifestPath = String(buildResult.manifestPath || buildResult.manifest_path || asset.manifestPath || '').trim();
    const error = clipText(String(buildResult.error || '').trim(), 140);
    if (status === 'image_built') {
      return image ? `镜像已构建：${image}` : '镜像已构建';
    }
    if (status === 'image_build_failed') {
      return error ? `镜像构建失败：${error}` : '镜像构建失败';
    }
    if (status === 'manifest_ready') {
      const suffix = suggestedImage ? `；建议镜像 ${suggestedImage}` : (manifestPath ? `：${manifestPath}` : '');
      return `manifest 已生成${suffix}`;
    }
    const statusMeta = getEnvironmentBuildStatusMeta(status);
    if (statusMeta) {
      return statusMeta.label;
    }
    return manifestPath ? `manifest：${manifestPath}` : '';
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
    const environmentMeta = getEnvironmentStatusMeta(run.environmentStatus);
    if (environmentMeta && String(run.environmentStatus || '').trim().toLowerCase() !== 'passed' && String(run.environmentStatus || '').trim().toLowerCase() !== 'skipped') {
      return environmentMeta;
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
    if (environmentMeta && String(run.environmentStatus || '').trim().toLowerCase() === 'passed') {
      return environmentMeta;
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

    if (latestRun && latestRun.environmentStatus && !['passed', 'skipped'].includes(String(latestRun.environmentStatus).trim().toLowerCase())) {
      return {
        tone: 'error',
        label: '先看环境链',
        message: '最近一次卡在 preflight / bootstrap / verify；先看运行详情里的环境状态、命令结果和 TESTING.md 建议 patch。',
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
      restoreSelections();
      connectSkillTestEventStream();
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
    syncSelectedCaseRunsAutoRefresh();
    if (nextTab === 'runs' && state.selectedCaseId) {
      scheduleSelectedCaseRunsRefresh(state.selectedCaseId, { force: true });
    }
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

  function openCaseLiveRun(caseId) {
    const normalizedCaseId = String(caseId || '').trim();
    if (!normalizedCaseId) {
      return false;
    }
    const targetCase = state.testCases.find((testCase) => testCase && testCase.id === normalizedCaseId) || null;
    if (!targetCase) {
      return false;
    }
    selectCase(normalizedCaseId, { detailTab: 'runs', scrollIntoView: true });
    return true;
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
  const LS_KEY_ISOLATION_MODE = 'caff_skill_test_isolation_mode';
  const LS_KEY_TRELLIS_MODE = 'caff_skill_test_trellis_mode';
  const LS_KEY_EGRESS_MODE = 'caff_skill_test_egress_mode';
  const LS_KEY_CHAIN_STOP_POLICY = 'caff_skill_test_chain_stop_policy';
  const LS_KEY_ENVIRONMENT_BUILD_IMAGE = 'caff_skill_test_environment_build_image';
  const DEFAULT_UI_ISOLATION_MODE = 'isolated';
  const DEFAULT_UI_TRELLIS_MODE = 'none';
  const DEFAULT_UI_EGRESS_MODE = 'deny';
  const DEFAULT_UI_CHAIN_STOP_POLICY = 'stop_on_failure';

  function normalizeUiIsolationMode(value) {
    return String(value || '').trim().toLowerCase() === 'legacy-local' ? 'legacy-local' : DEFAULT_UI_ISOLATION_MODE;
  }

  function normalizeUiTrellisMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'fixture') return 'fixture';
    if (normalized === 'readonlysnapshot') return 'readonlySnapshot';
    return DEFAULT_UI_TRELLIS_MODE;
  }

  function normalizeUiEgressMode(value) {
    return String(value || '').trim().toLowerCase() === 'allow' ? 'allow' : DEFAULT_UI_EGRESS_MODE;
  }

  function normalizeUiChainStopPolicy(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'stop_on_failure_goal_threshold' || normalized === 'goal_threshold') {
      return 'stop_on_failure_goal_threshold';
    }
    return DEFAULT_UI_CHAIN_STOP_POLICY;
  }

  function getIsolationModeLabel(mode) {
    return normalizeUiIsolationMode(mode) === 'legacy-local' ? 'legacy-local（本地调试）' : 'isolated（隔离）';
  }

  function getTrellisModeLabel(mode) {
    const normalized = normalizeUiTrellisMode(mode);
    if (normalized === 'fixture') return 'fixture（最小 Trellis）';
    if (normalized === 'readonlySnapshot') return 'readonlySnapshot（只读快照）';
    return 'none（无 Trellis）';
  }

  function getEgressModeLabel(mode) {
    return normalizeUiEgressMode(mode) === 'allow' ? 'allow（允许外连）' : 'deny（禁止外连）';
  }

  function getChainStopPolicyLabel(policy) {
    return normalizeUiChainStopPolicy(policy) === 'stop_on_failure_goal_threshold'
      ? 'goal threshold（goalAchievement ≥ 0.8 时继续）'
      : 'strict（只有 verdict=pass 才继续）';
  }

  function getTrellisModeHelpText(isolationMode, trellisMode) {
    if (normalizeUiIsolationMode(isolationMode) !== 'isolated') {
      return 'legacy-local 不会提供 Trellis fixture 或 snapshot；这个选项只在 isolated 模式下生效。';
    }
    const normalized = normalizeUiTrellisMode(trellisMode);
    if (normalized === 'fixture') {
      return 'fixture：给最小可用的 .trellis 样板，适合 before-dev、trellis-write 这类稳定测试。';
    }
    if (normalized === 'readonlySnapshot') {
      return 'readonlySnapshot：给接近真实项目的只读快照，读取更像真环境，但写入仍只留在 case 世界。';
    }
    return 'none：不给 .trellis，适合普通 skill，或验证这个 skill 不该依赖 Trellis。';
  }

  function readRunIsolationSettings() {
    const isolationMode = normalizeUiIsolationMode(dom.isolationModeSelect ? dom.isolationModeSelect.value : DEFAULT_UI_ISOLATION_MODE);
    return {
      isolationMode,
      trellisMode: normalizeUiTrellisMode(dom.trellisModeSelect ? dom.trellisModeSelect.value : DEFAULT_UI_TRELLIS_MODE),
      egressMode: normalizeUiEgressMode(dom.egressModeSelect ? dom.egressModeSelect.value : DEFAULT_UI_EGRESS_MODE),
    };
  }

  function readRunChainSettings() {
    return {
      stopPolicy: normalizeUiChainStopPolicy(dom.chainStopPolicySelect ? dom.chainStopPolicySelect.value : DEFAULT_UI_CHAIN_STOP_POLICY),
    };
  }

  function getSelectedTestCase() {
    return state.testCases.find((tc) => tc && tc.id === state.selectedCaseId) || null;
  }

  function isEnvironmentBuildCase(testCase) {
    return String(testCase && testCase.testType || '').trim() === 'environment-build';
  }

  function readEnvironmentBuildUiSettings(testCase) {
    if (!isEnvironmentBuildCase(testCase)) {
      return null;
    }
    return {
      enabled: true,
      buildImage: Boolean(dom.environmentBuildImageInput && dom.environmentBuildImageInput.checked),
    };
  }

  function getRunButtonLabel(testCase) {
    if (!isEnvironmentBuildCase(testCase)) {
      return isFailingRun(testCase && testCase.latestRun) ? '重试运行' : '运行测试';
    }
    const buildImage = Boolean(dom.environmentBuildImageInput && dom.environmentBuildImageInput.checked);
    if (buildImage) {
      return isFailingRun(testCase && testCase.latestRun) ? '重试构建镜像' : '运行并构建镜像';
    }
    return isFailingRun(testCase && testCase.latestRun) ? '重试生成 manifest' : '生成 manifest';
  }

  function syncEnvironmentBuildRunUi(testCase = null) {
    const active = isEnvironmentBuildCase(testCase);
    const buildImage = Boolean(dom.environmentBuildImageInput && dom.environmentBuildImageInput.checked);
    if (dom.environmentBuildImageField) {
      dom.environmentBuildImageField.classList.toggle('hidden', !active);
    }
    if (dom.environmentBuildImageInput) {
      dom.environmentBuildImageInput.disabled = !active;
    }
    if (dom.environmentBuildImageHelp) {
      dom.environmentBuildImageHelp.textContent = active
        ? (buildImage ? '本次运行会先生成 manifest，再自动从 manifest 构建干净环境镜像。' : '本次运行只生成 manifest；后续普通 execution 绑定前还需要构建镜像。')
        : '仅 environment-build 用例生效；关闭时只生成 manifest。';
    }
    if (dom.detailRunButton && testCase) {
      dom.detailRunButton.textContent = getRunButtonLabel(testCase);
      dom.detailRunButton.title = active
        ? (buildImage ? '运行环境构建用例，并在 verify 通过后自动 build image。' : '运行环境构建用例，只写出 environment-manifest.json。')
        : '';
    }
  }

  function syncRunSettingsUi() {
    const settings = readRunIsolationSettings();
    const isolated = settings.isolationMode === 'isolated';

    if (dom.trellisModeSelect) {
      dom.trellisModeSelect.disabled = !isolated;
    }
    if (dom.egressModeSelect) {
      dom.egressModeSelect.disabled = !isolated;
    }
    if (dom.trellisModeHelp) {
      dom.trellisModeHelp.textContent = getTrellisModeHelpText(settings.isolationMode, settings.trellisMode);
    }
    if (dom.runSettingsHint) {
      const chainPolicyLabel = getChainStopPolicyLabel(readRunChainSettings().stopPolicy);
      if (!isolated) {
        dom.runSettingsHint.textContent = `当前运行默认：legacy-local（仅本地调试）；链继续策略 ${chainPolicyLabel}。它不会 materialize Trellis fixture，也不能作为隔离证据。`;
      } else if (settings.trellisMode === 'fixture') {
        dom.runSettingsHint.textContent = `当前运行默认：${getIsolationModeLabel(settings.isolationMode)} / ${getTrellisModeLabel(settings.trellisMode)} / ${getEgressModeLabel(settings.egressMode)} / ${chainPolicyLabel}。适合 before-dev、trellis-write 这类要最小 .trellis 的稳定测试。`;
      } else if (settings.trellisMode === 'readonlySnapshot') {
        dom.runSettingsHint.textContent = `当前运行默认：${getIsolationModeLabel(settings.isolationMode)} / ${getTrellisModeLabel(settings.trellisMode)} / ${getEgressModeLabel(settings.egressMode)} / ${chainPolicyLabel}。适合贴近真实 .trellis/spec 的回归，写操作只会留在 case 世界。`;
      } else {
        dom.runSettingsHint.textContent = `当前运行默认：${getIsolationModeLabel(settings.isolationMode)} / ${getTrellisModeLabel(settings.trellisMode)} / ${getEgressModeLabel(settings.egressMode)} / ${chainPolicyLabel}。普通 skill 建议保持 none；Trellis 类 skill 可切到 fixture 或 readonlySnapshot。`;
      }
    }
    syncEnvironmentBuildRunUi(getSelectedTestCase());
    scheduleSkillTestStickyOffsetSync();
  }

  function persistSelections() {
    try {
      if (dom.agentSelect) localStorage.setItem(LS_KEY_AGENT, dom.agentSelect.value);
      if (dom.modelSelect) localStorage.setItem(LS_KEY_MODEL, dom.modelSelect.value);
      if (dom.skillSelect) localStorage.setItem(LS_KEY_SKILL, dom.skillSelect.value);
      if (dom.promptVersionInput) localStorage.setItem(LS_KEY_PROMPT_VERSION, dom.promptVersionInput.value);
      if (dom.isolationModeSelect) localStorage.setItem(LS_KEY_ISOLATION_MODE, normalizeUiIsolationMode(dom.isolationModeSelect.value));
      if (dom.trellisModeSelect) localStorage.setItem(LS_KEY_TRELLIS_MODE, normalizeUiTrellisMode(dom.trellisModeSelect.value));
      if (dom.egressModeSelect) localStorage.setItem(LS_KEY_EGRESS_MODE, normalizeUiEgressMode(dom.egressModeSelect.value));
      if (dom.chainStopPolicySelect) localStorage.setItem(LS_KEY_CHAIN_STOP_POLICY, normalizeUiChainStopPolicy(dom.chainStopPolicySelect.value));
      if (dom.environmentBuildImageInput) localStorage.setItem(LS_KEY_ENVIRONMENT_BUILD_IMAGE, dom.environmentBuildImageInput.checked ? 'true' : 'false');
    } catch { /* ignore */ }
  }

  function restoreSelections() {
    try {
      const savedAgent = localStorage.getItem(LS_KEY_AGENT);
      const savedModel = localStorage.getItem(LS_KEY_MODEL);
      const savedPromptVersion = localStorage.getItem(LS_KEY_PROMPT_VERSION);
      const savedIsolationMode = localStorage.getItem(LS_KEY_ISOLATION_MODE);
      const savedTrellisMode = localStorage.getItem(LS_KEY_TRELLIS_MODE);
      const savedEgressMode = localStorage.getItem(LS_KEY_EGRESS_MODE);
      const savedChainStopPolicy = localStorage.getItem(LS_KEY_CHAIN_STOP_POLICY);
      const savedEnvironmentBuildImage = localStorage.getItem(LS_KEY_ENVIRONMENT_BUILD_IMAGE);
      if (savedAgent != null && dom.agentSelect) dom.agentSelect.value = savedAgent;
      if (savedModel != null && dom.modelSelect) dom.modelSelect.value = savedModel;
      if (savedPromptVersion != null && dom.promptVersionInput) dom.promptVersionInput.value = savedPromptVersion;
      if (savedIsolationMode != null && dom.isolationModeSelect) dom.isolationModeSelect.value = normalizeUiIsolationMode(savedIsolationMode);
      if (savedTrellisMode != null && dom.trellisModeSelect) dom.trellisModeSelect.value = normalizeUiTrellisMode(savedTrellisMode);
      if (savedEgressMode != null && dom.egressModeSelect) dom.egressModeSelect.value = normalizeUiEgressMode(savedEgressMode);
      if (savedChainStopPolicy != null && dom.chainStopPolicySelect) dom.chainStopPolicySelect.value = normalizeUiChainStopPolicy(savedChainStopPolicy);
      if (savedEnvironmentBuildImage != null && dom.environmentBuildImageInput) dom.environmentBuildImageInput.checked = savedEnvironmentBuildImage === 'true';
    } catch { /* ignore */ }
    syncRunSettingsUi();
  }

  function applyPendingSkillTestDeepLink() {
    if (!pendingSkillTestDeepLink || !pendingSkillTestDeepLink.skillId || !dom.skillSelect) return false;
    const skillId = pendingSkillTestDeepLink.skillId;
    if (!state.skills.some((skill) => skill.id === skillId)) {
      return false;
    }
    dom.skillSelect.value = skillId;
    state.selectedCaseId = pendingSkillTestDeepLink.caseId || '';
    switchDetailTab(pendingSkillTestDeepLink.detailTab || 'overview');
    pendingSkillTestDeepLink = null;
    return true;
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

  function handleRunSettingChange() {
    syncRunSettingsUi();
    persistSelections();
    renderSelectedSkillOverview();
  }

  // Persist on change
  if (dom.agentSelect) dom.agentSelect.addEventListener('change', persistSelections);
  if (dom.modelSelect) dom.modelSelect.addEventListener('change', persistSelections);
  if (dom.promptVersionInput) dom.promptVersionInput.addEventListener('change', persistSelections);
  if (dom.isolationModeSelect) dom.isolationModeSelect.addEventListener('change', handleRunSettingChange);
  if (dom.trellisModeSelect) dom.trellisModeSelect.addEventListener('change', handleRunSettingChange);
  if (dom.egressModeSelect) dom.egressModeSelect.addEventListener('change', handleRunSettingChange);
  if (dom.chainStopPolicySelect) dom.chainStopPolicySelect.addEventListener('change', handleRunSettingChange);
  if (dom.environmentBuildImageInput) dom.environmentBuildImageInput.addEventListener('change', handleRunSettingChange);

  function getRunOptions(context = {}) {
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

    const isolationSettings = readRunIsolationSettings();
    opts.isolationMode = isolationSettings.isolationMode;
    if (isolationSettings.isolationMode === 'isolated') {
      opts.trellisMode = isolationSettings.trellisMode;
      opts.egressMode = isolationSettings.egressMode;
    }
    const chainSettings = readRunChainSettings();
    opts.stopPolicy = chainSettings.stopPolicy;
    const targetCase = context && context.testCase ? context.testCase : null;
    const environmentBuildSettings = readEnvironmentBuildUiSettings(targetCase);
    if (environmentBuildSettings) {
      opts.environmentBuild = environmentBuildSettings;
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
    const restored = applyPendingSkillTestDeepLink() || restoreSelectedSkill();
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

  if (dom.caseChainFilter) {
    dom.caseChainFilter.addEventListener('change', () => {
      state.chainFilter = dom.caseChainFilter.value || 'all';
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
        state.chainFilter = 'all';
        if (dom.searchInput) dom.searchInput.value = '';
        if (dom.validityFilter) dom.validityFilter.value = 'all';
        if (dom.caseChainFilter) dom.caseChainFilter.value = 'all';
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
      state.environmentAssets = [];
      state.selectedCaseId = '';
      state.casesLoading = false;
      state.casesLoadError = '';
      state.casesLastLoadedAt = '';
      state.environmentAssetsLoadError = '';
      state.environmentAssetsLastLoadedAt = '';
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
      const [data, environmentAssetData] = await Promise.all([
        fetchJson(`/api/skills/${encodeURIComponent(requestedSkillId)}/test-cases`),
        fetchJson(`/api/skills/${encodeURIComponent(requestedSkillId)}/environment-assets`).catch((error) => ({ __error: error })),
      ]);
      if (state.selectedSkillId !== requestedSkillId) {
        return;
      }
      state.testCases = Array.isArray(data.cases) ? data.cases : [];
      if (environmentAssetData && environmentAssetData.__error) {
        state.environmentAssets = [];
        state.environmentAssetsLoadError = '共享环境资产刷新失败';
        state.environmentAssetsLastLoadedAt = '';
      } else {
        state.environmentAssets = Array.isArray(environmentAssetData && environmentAssetData.assets) ? environmentAssetData.assets : [];
        state.environmentAssetsLoadError = '';
        state.environmentAssetsLastLoadedAt = new Date().toISOString();
      }
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

  function reconcileLiveSkillRunFromFinalResult(caseId, runResult) {
    const liveRun = state.liveSkillRunsByCaseId.get(caseId);
    if (!liveRun) {
      return;
    }
    const resultPayload = runResult && typeof runResult === 'object' ? runResult : {};
    const run = resultPayload.run && typeof resultPayload.run === 'object' ? resultPayload.run : null;
    if (!run) {
      return;
    }
    const normalizedStatus = String(run.status || '').trim().toLowerCase();
    const nextStatus = normalizedStatus === 'failed'
      ? 'failed'
      : (normalizedStatus === 'completed' || normalizedStatus === 'succeeded' ? 'succeeded' : '');
    if (!nextStatus) {
      return;
    }
    if (isTerminalLiveRunStatus(liveRun.status) && String(liveRun.finishedAt || '').trim()) {
      return;
    }
    applyLiveSkillRunPayload({
      caseId,
      phase: nextStatus === 'failed' ? 'failed' : 'completed',
      status: nextStatus,
      progressLabel: '',
      errorMessage: String(run.errorMessage || liveRun.errorMessage || ''),
      finishedAt: String(run.createdAt || liveRun.finishedAt || new Date().toISOString()),
    });
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
      const selectedCase = state.testCases.find((tc) => tc && tc.id === caseId) || null;
      const runResult = await fetchJson(
        `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases/${encodeURIComponent(caseId)}/run`,
        { method: 'POST', body: getRunOptions({ testCase: selectedCase }) }
      );
      reconcileLiveSkillRunFromFinalResult(caseId, runResult);
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

  async function runTestChain(testCase, options = {}) {
    const chainRunRequest = getCaseChainRunRequest(testCase);
    if (!state.selectedSkillId || !testCase || !chainRunRequest || !chainRunRequest.exportChainId) {
      showToast('当前用例没有可运行的链');
      return false;
    }
    if (!chainRunRequest.eligible) {
      showToast('当前链还不是可运行的 full + execution 集合');
      return false;
    }

    const button = options.button || null;
    const idleLabel = options.idleLabel || (button ? button.textContent : '按链运行');
    const busyLabel = options.busyLabel || '链运行中...';

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
      const result = await fetchJson(
        `/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-chains/run`,
        {
          method: 'POST',
          body: {
            exportChainId: chainRunRequest.exportChainId,
            caseIds: chainRunRequest.caseIds,
            ...getRunOptions(),
          },
        }
      );
      reconcileLiveSkillChainRunFromFinalResult(chainRunRequest.exportChainId, result);
      const chainStatus = result && result.chainRun && result.chainRun.status
        ? String(result.chainRun.status)
        : 'completed';
      const warnings = Array.isArray(result && result.warnings) ? result.warnings : [];
      showToast(`链运行完成：${chainStatus}${warnings.length > 0 ? `（${warnings.length} 条提醒）` : ''}`);
      await Promise.all([loadTestCases(), loadSummary()]);
      if (state.selectedCaseId) {
        await caseDetailDataViewHelpers.loadCaseRuns(state.selectedCaseId);
      }
      return true;
    } catch (err) {
      const issues = extractIssuesFromError(err);
      renderIssuePanel(dom.detailIssues, issues, '链运行失败校验提示');
      const issueMessage = buildIssueToastMessage('链运行失败，', issues);
      showToast(issueMessage || ('链运行失败: ' + (err.message || err)));
      return false;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = idleLabel;
      }
    }
  }

  function renderSelectedSkillOverview() {
    const runSettings = readRunIsolationSettings();
    selectedSkillOverviewViewHelpers.renderSelectedSkillOverview({
      selectedHighlights: dom.selectedHighlights,
      selectedSummary: dom.selectedSummary,
      selectedStatusCallout: dom.selectedStatusCallout,
    }, {
      selectedSkillId: state.selectedSkillId,
      testCases: state.testCases,
      casesLoading: state.casesLoading,
      casesLoadError: state.casesLoadError,
      casesLastLoadedAt: state.casesLastLoadedAt,
      summary: state.summary,
      summaryLastLoadedAt: state.summaryLastLoadedAt,
      environmentAssets: state.environmentAssets,
      environmentAssetsLoadError: state.environmentAssetsLoadError,
      environmentAssetsLastLoadedAt: state.environmentAssetsLastLoadedAt,
      searchQuery: state.searchQuery,
      validityFilter: state.validityFilter,
      chainFilter: state.chainFilter,
      filteredCaseCount: getFilteredCases().length,
      runSettings,
      runLabels: {
        isolationModeLabel: getIsolationModeLabel(runSettings.isolationMode),
        trellisModeLabel: getTrellisModeLabel(runSettings.trellisMode),
        egressModeLabel: getEgressModeLabel(runSettings.egressMode),
      },
    });
  }

  function getFilteredCases() {
    return state.testCases.filter((tc) => {
      const chainMeta = getSkillTestChainPlanningMeta(tc);
      const chainCase = Boolean(chainMeta.exportChainId && chainMeta.sequenceIndex != null);
      const matchesQuery = !state.searchQuery || [
        tc.id,
        getCasePrompt(tc),
        tc.note,
        tc.expectedBehavior,
        tc.expectedGoal,
        getExpectedStepsSearchText(tc.expectedSteps),
        getExpectedToolsSearchText(tc.expectedTools),
        getEnvironmentConfigSearchText(tc.environmentConfig),
        tc.caseStatus,
        tc.loadingMode,
        chainMeta.chainId,
        chainMeta.exportChainId,
        chainCase ? 'chain' : 'single',
      ].some((value) => String(value || '').toLowerCase().includes(state.searchQuery));

      const latestRun = tc.latestRun || null;
      const matchesValidity = state.validityFilter === 'all'
        || tc.caseStatus === state.validityFilter
        || (state.validityFilter === 'failing' && isFailingRun(latestRun));
      const matchesChain = state.chainFilter === 'all'
        || (state.chainFilter === 'chain' && chainCase)
        || (state.chainFilter === 'single' && !chainCase);

      return matchesQuery && matchesValidity && matchesChain;
    });
  }

  async function runCaseFromList(testCase, button) {
    if (!testCase || !testCase.id) {
      return;
    }
    selectCase(testCase.id, { detailTab: 'runs', scrollIntoView: true });
    await runTestCase(testCase.id, {
      button,
      idleLabel: button && button.textContent ? button.textContent : '运行',
      busyLabel: '运行中...',
      detailTab: 'runs',
      scrollIntoView: true,
    });
  }

  async function toggleCaseStatusFromList(testCase) {
    if (!testCase || !testCase.id) {
      return;
    }
    try {
      await caseFormViewHelpers.toggleCaseStatus(testCase);
    } catch (err) {
      const issues = extractIssuesFromError(err);
      if (testCase.id === state.selectedCaseId) {
        renderIssuePanel(dom.detailIssues, issues, '切换状态失败校验提示');
      }
      const issueMessage = buildIssueToastMessage('切换状态失败，', issues);
      showToast(issueMessage || ('切换状态失败: ' + (err.message || err)));
    }
  }

  function renderCaseList() {
    caseListViewHelpers.renderCaseList(
      {
        caseList: dom.caseList,
        caseCount: dom.caseCount,
        filterCount: dom.filterCount,
      },
      {
        selectedSkillId: state.selectedSkillId,
        testCases: state.testCases,
        filteredCases: getFilteredCases(),
        selectedCaseId: state.selectedCaseId,
        casesLoading: state.casesLoading,
        casesLoadError: state.casesLoadError,
        casesLastLoadedAt: state.casesLastLoadedAt,
      },
      {
        onSelectCase: (caseId, options) => {
          selectCase(caseId, options);
        },
        onRunCase: (testCase, button) => runCaseFromList(testCase, button),
        onToggleCaseStatus: (testCase) => toggleCaseStatusFromList(testCase),
      }
    );
  }

  function getSkillTestChainPlanningMeta(testCase) {
    const sourceMetadata = testCase && testCase.sourceMetadata && typeof testCase.sourceMetadata === 'object'
      ? testCase.sourceMetadata
      : null;
    const designMetadata = sourceMetadata && sourceMetadata.skillTestDesign && typeof sourceMetadata.skillTestDesign === 'object'
      ? sourceMetadata.skillTestDesign
      : null;
    const chainPlanning = designMetadata && designMetadata.chainPlanning && typeof designMetadata.chainPlanning === 'object'
      ? designMetadata.chainPlanning
      : null;
    const exportChainId = String(chainPlanning && chainPlanning.exportChainId || '').trim();
    const sequenceIndex = Number(chainPlanning && chainPlanning.sequenceIndex);
    const dependsOnCaseIds = Array.isArray(chainPlanning && chainPlanning.dependsOnCaseIds)
      ? chainPlanning.dependsOnCaseIds.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    return {
      exportChainId,
      chainId: String(chainPlanning && (chainPlanning.chainId || chainPlanning.exportChainId) || '').trim(),
      sequenceIndex: Number.isInteger(sequenceIndex) && sequenceIndex > 0 ? sequenceIndex : null,
      dependsOnCaseIds,
      loadingMode: String(testCase && testCase.loadingMode || '').trim().toLowerCase(),
      testType: String(testCase && testCase.testType || '').trim().toLowerCase(),
    };
  }

  function getChainCasesForExportChain(exportChainId) {
    const normalizedExportChainId = String(exportChainId || '').trim();
    if (!normalizedExportChainId) {
      return [];
    }
    const seenCaseIds = new Set();
    return state.testCases
      .filter((testCase) => getSkillTestChainPlanningMeta(testCase).exportChainId === normalizedExportChainId)
      .slice()
      .sort((left, right) => {
        const leftSequence = getSkillTestChainPlanningMeta(left).sequenceIndex || 0;
        const rightSequence = getSkillTestChainPlanningMeta(right).sequenceIndex || 0;
        if (leftSequence !== rightSequence) {
          return leftSequence - rightSequence;
        }
        const leftId = String(left && left.id || '').trim();
        const rightId = String(right && right.id || '').trim();
        return leftId.localeCompare(rightId);
      })
      .filter((testCase) => {
        const caseId = String(testCase && testCase.id || '').trim();
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

  function isRunnableChainCaseSet(chainCases, exportChainId) {
    if (!Array.isArray(chainCases) || chainCases.length === 0 || !exportChainId) {
      return false;
    }
    const sequenceOwners = new Set();
    const orderedSequenceIndexes = [];
    for (const entry of chainCases) {
      const entryMeta = getSkillTestChainPlanningMeta(entry);
      if (
        entryMeta.exportChainId !== exportChainId
        || entryMeta.sequenceIndex == null
        || entryMeta.loadingMode !== 'full'
        || entryMeta.testType !== 'execution'
      ) {
        return false;
      }
      if (sequenceOwners.has(entryMeta.sequenceIndex)) {
        return false;
      }
      sequenceOwners.add(entryMeta.sequenceIndex);
      orderedSequenceIndexes.push(entryMeta.sequenceIndex);
    }
    orderedSequenceIndexes.sort((left, right) => left - right);
    return orderedSequenceIndexes.every((sequenceIndex, index) => sequenceIndex === index + 1);
  }

  function getCaseChainRunRequest(testCase) {
    if (!testCase) {
      return null;
    }
    const chainMeta = getSkillTestChainPlanningMeta(testCase);
    if (!chainMeta.exportChainId) {
      return null;
    }
    const chainCases = getChainCasesForExportChain(chainMeta.exportChainId);
    if (chainCases.length === 0) {
      return null;
    }
    return {
      exportChainId: chainMeta.exportChainId,
      chainId: chainMeta.chainId || chainMeta.exportChainId,
      caseIds: chainCases.map((entry) => entry.id),
      chainCases,
      eligible: isRunnableChainCaseSet(chainCases, chainMeta.exportChainId),
    };
  }

  if (typeof skillTestUiModules.createChainRailViewHelpers !== 'function') {
    throw new Error('Missing skill-test chain rail helpers');
  }
  const chainRailViewHelpers = skillTestUiModules.createChainRailViewHelpers({
    getSkillTestChainPlanningMeta,
    getChainCasesForExportChain,
    getLiveRunForCaseId: (caseId) => state.liveSkillRunsByCaseId.get(caseId) || null,
    isFailingRun,
    isPassedFlag,
    clipText,
    escapeHtml,
    getCasePrompt,
  });
  const isChainCase = chainRailViewHelpers.isChainCase;
  const getChainCaseView = chainRailViewHelpers.getChainCaseView;
  const getChainRailNodeState = chainRailViewHelpers.getChainRailNodeState;
  const getChainRailDescriptors = chainRailViewHelpers.getChainRailDescriptors;
  const buildChainRailHtml = chainRailViewHelpers.buildChainRailHtml;

  if (typeof skillTestUiModules.createCaseListViewHelpers !== 'function') {
    throw new Error('Missing skill-test case list view helpers');
  }
  const caseListViewHelpers = skillTestUiModules.createCaseListViewHelpers({
    escapeHtml,
    clipText,
    formatRefreshTime,
    buildCompactEmptyStateHtml,
    buildInlineBannerHtml,
    getChainCaseView,
    buildChainRailHtml,
    getCaseStatusMeta,
    readCaseValidation,
    getCaseReadinessMeta,
    getLatestRunStatusMeta,
    getLoadingModeLabel,
    formatExpectedTools,
    isEnvironmentConfigEnabled,
    formatEnvironmentConfigSummary,
    getLastOutcomeSummary,
    getCasePrompt,
    buildIssueSummary,
    getCaseSchemaStatusMeta,
    getCaseActionCallout,
    isFailingRun,
  });

  if (typeof skillTestUiModules.createCaseRunsViewHelpers !== 'function') {
    throw new Error('Missing skill-test case runs view helpers');
  }
  const caseRunsViewHelpers = skillTestUiModules.createCaseRunsViewHelpers({
    escapeHtml,
    fetchJson,
    getSelectedSkillId: () => state.selectedSkillId,
    showToast,
    downloadJsonFile,
    exportSkillTestRunSession,
    buildStatusTagHtml,
    buildRunOutcomeTagHtml,
    buildEnvironmentStatusTagHtml,
    buildEnvironmentBuildTagHtml,
    buildRunSummarySectionHtml,
    buildToolTracePanelHtml,
    liveRunStatusLabel,
    liveChainRunStatusLabel,
    liveRunTone,
    isPassedFlag,
    isFailedFlag,
    getEnvironmentStatusMeta,
    getEnvironmentBuildStatusMeta,
    readEnvironmentBuildResultFromEvaluation,
    buildEnvironmentRequirementListHtml,
    buildEnvironmentCommandSectionHtml,
    buildEnvironmentCacheDetailsHtml,
    buildEnvironmentBuildDetailsHtml,
    normalizeRunDetailStringList,
    formatRunDetailPercent,
    getFullAggregationReasonLabel,
    getFullJudgeStatusMeta,
    buildRunDetailReasonListHtml,
    readRunValidation,
    getIssuePanelToneClass,
    buildIssuePanelHtml,
    getCaseSchemaStatusMeta,
    buildRunDetailTrace,
    openCaseLiveRun,
    getLiveCaseActionLabel,
    fullDimensionLabels: FULL_DIMENSION_LABELS,
  });
  const renderCaseRuns = caseRunsViewHelpers.renderCaseRuns;

  if (typeof skillTestUiModules.createCaseDetailViewHelpers !== 'function') {
    throw new Error('Missing skill-test case detail view helpers');
  }
  const caseDetailViewHelpers = skillTestUiModules.createCaseDetailViewHelpers({
    escapeHtml,
    clipText,
    getLoadingModeLabel,
    getCaseReadinessMeta,
    getLatestRunStatusMeta,
    getCaseSchemaStatusMeta,
    getCasePrompt,
    formatExpectedTools,
    formatEnvironmentConfigSummary,
    getCaseStatusMeta,
    getCaseStatusHelpText,
    renderStatusCallout,
    getCaseActionCallout,
    syncEnvironmentBuildRunUi,
    renderIssuePanel,
    readCaseValidation,
    getChainCaseView,
    buildChainRailHtml,
    isEnvironmentConfigEnabled,
    getCaseChainRunRequest,
    getChainStopPolicyLabel,
    readRunChainSettings,
    getLastOutcomeSummary,
  });

  if (typeof skillTestUiModules.createCaseDetailDataViewHelpers !== 'function') {
    throw new Error('Missing skill-test case detail data helpers');
  }
  const caseDetailDataViewHelpers = skillTestUiModules.createCaseDetailDataViewHelpers({
    fetchJson,
    getSelectedSkillId: () => state.selectedSkillId,
    getSelectedCaseId: () => state.selectedCaseId,
    getActiveDetailTab: () => state.activeDetailTab,
    findCaseById: (caseId) => state.testCases.find((tc) => tc.id === caseId) || null,
    getCaseChainRunRequest,
    renderCaseRuns,
    renderCaseRegression: caseDetailViewHelpers.renderCaseRegression,
    renderRetryState,
    renderLoadingState,
    hasSelectedCaseLiveRun,
    hasSelectedCaseLiveChainRun,
    detailRunsElement: dom.detailRuns,
    detailRegressionElement: dom.detailRegression,
  });
  syncSelectedCaseRunsAutoRefresh = caseDetailDataViewHelpers.syncLiveRunsAutoRefresh;
  scheduleSelectedCaseRunsRefresh = caseDetailDataViewHelpers.scheduleCaseRunsRefresh;

  if (typeof skillTestUiModules.createCaseFormViewHelpers !== 'function') {
    throw new Error('Missing skill-test case form helpers');
  }
  const caseFormViewHelpers = skillTestUiModules.createCaseFormViewHelpers({
    fetchJson,
    showToast,
    renderIssuePanel,
    extractIssuesFromError,
    buildIssueToastMessage,
    getSelectedSkillId: () => state.selectedSkillId,
    getSelectedCaseId: () => state.selectedCaseId,
    getActiveDetailTab: () => state.activeDetailTab,
    findSelectedCase: () => state.testCases.find((tc) => tc.id === state.selectedCaseId) || null,
    getCasePrompt,
    parseStructuredArray,
    parseStructuredExpectedTools,
    parseStructuredObject,
    mergeIssues,
    buildLocalValidationIssue,
    buildLocalValidationError,
    normalizeIssueList,
    buildIssueSummary,
    shouldIncludeExpectedSteps,
    loadTestCases,
    loadSummary,
    selectCase,
  });
  caseFormViewHelpers.bindDetailFormActions(dom);

  function renderDetail(tc) {
    caseDetailViewHelpers.renderDetail(dom, tc, {
      onRenderLiveRun: renderLiveSkillRun,
      onLoadCaseRuns: caseDetailDataViewHelpers.loadCaseRuns,
      onLoadCaseRegression: caseDetailDataViewHelpers.loadCaseRegression,
    });
  }

  function hideDetail() {
    caseDetailViewHelpers.hideDetail(dom, { switchDetailTab });
  }

  function syncDetailPanel() {
    if (!state.selectedCaseId) {
      hideDetail();
      syncSelectedCaseRunsAutoRefresh();
      return;
    }
    const selectedCase = state.testCases.find((tc) => tc.id === state.selectedCaseId);
    if (!selectedCase) {
      hideDetail();
      syncSelectedCaseRunsAutoRefresh();
      return;
    }
    renderDetail(selectedCase);
    syncSelectedCaseRunsAutoRefresh();
  }

  function shouldIncludeExpectedSteps(loadingMode, expectedSteps) {
    return loadingMode === 'full' || (Array.isArray(expectedSteps) && expectedSteps.length > 0);
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

  if (dom.detailRunChainButton) {
    dom.detailRunChainButton.addEventListener('click', async () => {
      if (!state.selectedCaseId) return;
      const selectedCase = state.testCases.find((tc) => tc.id === state.selectedCaseId);
      if (!selectedCase) return;
      await runTestChain(selectedCase, {
        button: dom.detailRunChainButton,
        idleLabel: dom.detailRunChainButton.textContent || '按链运行',
        busyLabel: '链运行中...',
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
        downloadJsonFile({ testCaseId: state.selectedCaseId, runs: enriched }, `skill-test-case-${state.selectedCaseId}-runs.json`);
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
      const environmentConfigText = dom.createEnvironmentJson ? dom.createEnvironmentJson.value.trim() : '';
      const environmentConfig = parseStructuredObject(environmentConfigText);

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
          : [],
        environmentConfigText && !environmentConfig
          ? [buildLocalValidationIssue('environment_config_invalid', 'environmentConfig', 'Environment Config JSON 需要是对象')]
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
        const loadingMode = dom.createLoadingMode ? dom.createLoadingMode.value : 'dynamic';
        const selectedTestType = dom.createTestType ? dom.createTestType.value : 'auto';
        const testType = selectedTestType && selectedTestType !== 'auto'
          ? selectedTestType
          : (loadingMode === 'full' ? 'execution' : 'trigger');
        const createBody = {
          userPrompt: prompt,
          triggerPrompt: prompt,
          loadingMode,
          testType,
          expectedTools: [...expectedTools, ...(structuredTools || [])],
          expectedBehavior,
          expectedGoal,
          expectedSequence: expectedSequence || [],
          evaluationRubric: evaluationRubric || {},
          environmentConfig: environmentConfig || {},
          caseStatus: 'draft',
          note: dom.createNote ? dom.createNote.value.trim() : '',
        };
        if (shouldIncludeExpectedSteps(loadingMode, expectedSteps)) {
          createBody.expectedSteps = expectedSteps || [];
        }
        const createResult = await fetchJson(`/api/skills/${encodeURIComponent(state.selectedSkillId)}/test-cases`, {
          method: 'POST',
          body: createBody,
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
        if (dom.createTestType) dom.createTestType.value = 'auto';
        if (dom.createToolSpecs) dom.createToolSpecs.value = '';
        if (dom.createGoal) dom.createGoal.value = '';
        if (dom.createSteps) dom.createSteps.value = '';
        if (dom.createSequence) dom.createSequence.value = '';
        if (dom.createRubric) dom.createRubric.value = '';
        if (dom.createEnvironmentJson) dom.createEnvironmentJson.value = '';
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
    summaryViewHelpers.renderSummary(
      {
        summaryBody: dom.summaryBody,
        summaryHighlights: dom.summaryHighlights,
      },
      {
        summary: state.summary,
        summaryLoading: state.summaryLoading,
        summaryLoadError: state.summaryLoadError,
        summaryLastLoadedAt: state.summaryLastLoadedAt,
      },
      {
        onRenderSelectedSkillOverview: renderSelectedSkillOverview,
        onRetry: loadSummary,
      }
    );
  }

  if (dom.refreshSummaryButton) {
    dom.refreshSummaryButton.addEventListener('click', loadSummary);
  }

  // ---- Utilities ----
  function getTestTypeLabel(testType) {
    if (testType === 'environment-build') return '环境构建';
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
    const environmentBuildSummary = getEnvironmentBuildRunOutcomeSummary(run);
    const environmentBuildResult = readEnvironmentBuildResultFromEvaluation(run && run.evaluation);
    const environmentBuildStatus = String(environmentBuildResult && environmentBuildResult.status || '').trim().toLowerCase();
    if (environmentBuildSummary && environmentBuildStatus === 'image_build_failed') return `最近失败：${environmentBuildSummary}`;
    if (run.errorMessage) return `最近失败：${run.errorMessage}`;
    if (environmentBuildSummary) return `最近运行：${environmentBuildSummary}`;
    const environmentSummary = getEnvironmentRunOutcomeSummary(run);
    const environmentStatus = String(run.environmentStatus || '').trim().toLowerCase();
    if (environmentSummary && environmentStatus && environmentStatus !== 'passed' && environmentStatus !== 'skipped') {
      return `最近失败：${environmentSummary}`;
    }
    if (run.verdict) {
      const summary = run.evaluation && run.evaluation.summary ? `：${run.evaluation.summary}` : '';
      if (run.verdict === 'pass') return `最近运行：Full 模式通过${summary}${environmentSummary && environmentStatus === 'passed' ? `；${environmentSummary}` : ''}`;
      if (run.verdict === 'borderline') return `最近运行：Full 模式待复核${summary}${environmentSummary && environmentStatus === 'passed' ? `；${environmentSummary}` : ''}`;
      if (run.verdict === 'fail') return `最近失败：Full 模式未达标${summary}`;
    }
    if (isFailedFlag(run.triggerPassed)) return '最近失败：没有成功加载目标 skill';
    if (isFailedFlag(run.executionPassed)) return '最近失败：执行结果未达标';
    if (environmentSummary && environmentStatus === 'passed') return `最近运行：${environmentSummary}`;
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

  if (pendingSkillTestDeepLink && pendingSkillTestDeepLink.openSkillTests) {
    switchTab('panel-skill-tests');
  }
})();
