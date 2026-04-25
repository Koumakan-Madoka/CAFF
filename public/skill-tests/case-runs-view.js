// @ts-check

(function registerSkillTestCaseRunsView() {
  const skillTests = window.CaffSkillTests || (window.CaffSkillTests = {});

  skillTests.createCaseRunsViewHelpers = function createCaseRunsViewHelpers(deps = {}) {
    const escapeHtml = typeof deps.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '');
    const fetchJson = typeof deps.fetchJson === 'function'
      ? deps.fetchJson
      : async () => {
        throw new Error('Missing fetchJson');
      };
    const getSelectedSkillId = typeof deps.getSelectedSkillId === 'function'
      ? deps.getSelectedSkillId
      : () => '';
    const showToast = typeof deps.showToast === 'function'
      ? deps.showToast
      : () => {};
    const downloadJsonFile = typeof deps.downloadJsonFile === 'function'
      ? deps.downloadJsonFile
      : () => {};
    const exportSkillTestRunSession = typeof deps.exportSkillTestRunSession === 'function'
      ? deps.exportSkillTestRunSession
      : () => {};
    const buildStatusTagHtml = typeof deps.buildStatusTagHtml === 'function'
      ? deps.buildStatusTagHtml
      : () => '';
    const buildRunOutcomeTagHtml = typeof deps.buildRunOutcomeTagHtml === 'function'
      ? deps.buildRunOutcomeTagHtml
      : () => '';
    const buildEnvironmentStatusTagHtml = typeof deps.buildEnvironmentStatusTagHtml === 'function'
      ? deps.buildEnvironmentStatusTagHtml
      : () => '';
    const buildEnvironmentBuildTagHtml = typeof deps.buildEnvironmentBuildTagHtml === 'function'
      ? deps.buildEnvironmentBuildTagHtml
      : () => '';
    const buildRunSummarySectionHtml = typeof deps.buildRunSummarySectionHtml === 'function'
      ? deps.buildRunSummarySectionHtml
      : () => '';
    const buildToolTracePanelHtml = typeof deps.buildToolTracePanelHtml === 'function'
      ? deps.buildToolTracePanelHtml
      : () => '';
    const liveRunStatusLabel = typeof deps.liveRunStatusLabel === 'function'
      ? deps.liveRunStatusLabel
      : () => '运行状态';
    const liveChainRunStatusLabel = typeof deps.liveChainRunStatusLabel === 'function'
      ? deps.liveChainRunStatusLabel
      : () => '链运行状态';
    const liveRunTone = typeof deps.liveRunTone === 'function'
      ? deps.liveRunTone
      : () => 'neutral';
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
    const readEnvironmentBuildResultFromEvaluation = typeof deps.readEnvironmentBuildResultFromEvaluation === 'function'
      ? deps.readEnvironmentBuildResultFromEvaluation
      : () => null;
    const buildEnvironmentRequirementListHtml = typeof deps.buildEnvironmentRequirementListHtml === 'function'
      ? deps.buildEnvironmentRequirementListHtml
      : () => '';
    const buildEnvironmentCommandSectionHtml = typeof deps.buildEnvironmentCommandSectionHtml === 'function'
      ? deps.buildEnvironmentCommandSectionHtml
      : () => '';
    const buildEnvironmentCacheDetailsHtml = typeof deps.buildEnvironmentCacheDetailsHtml === 'function'
      ? deps.buildEnvironmentCacheDetailsHtml
      : () => '';
    const buildEnvironmentBuildDetailsHtml = typeof deps.buildEnvironmentBuildDetailsHtml === 'function'
      ? deps.buildEnvironmentBuildDetailsHtml
      : () => '';
    const normalizeRunDetailStringList = typeof deps.normalizeRunDetailStringList === 'function'
      ? deps.normalizeRunDetailStringList
      : () => [];
    const formatRunDetailPercent = typeof deps.formatRunDetailPercent === 'function'
      ? deps.formatRunDetailPercent
      : (value) => String(value == null ? 'n/a' : value);
    const getFullAggregationReasonLabel = typeof deps.getFullAggregationReasonLabel === 'function'
      ? deps.getFullAggregationReasonLabel
      : (value) => String(value || '');
    const getFullJudgeStatusMeta = typeof deps.getFullJudgeStatusMeta === 'function'
      ? deps.getFullJudgeStatusMeta
      : () => null;
    const buildRunDetailReasonListHtml = typeof deps.buildRunDetailReasonListHtml === 'function'
      ? deps.buildRunDetailReasonListHtml
      : () => '';
    const readRunValidation = typeof deps.readRunValidation === 'function'
      ? deps.readRunValidation
      : () => ({ issues: [], caseSchemaStatus: '', derivedFromLegacy: null });
    const getIssuePanelToneClass = typeof deps.getIssuePanelToneClass === 'function'
      ? deps.getIssuePanelToneClass
      : () => '';
    const buildIssuePanelHtml = typeof deps.buildIssuePanelHtml === 'function'
      ? deps.buildIssuePanelHtml
      : () => '';
    const getCaseSchemaStatusMeta = typeof deps.getCaseSchemaStatusMeta === 'function'
      ? deps.getCaseSchemaStatusMeta
      : () => null;
    const buildRunDetailTrace = typeof deps.buildRunDetailTrace === 'function'
      ? deps.buildRunDetailTrace
      : () => null;
    const openCaseLiveRun = typeof deps.openCaseLiveRun === 'function'
      ? deps.openCaseLiveRun
      : () => false;
    const getLiveCaseActionLabel = typeof deps.getLiveCaseActionLabel === 'function'
      ? deps.getLiveCaseActionLabel
      : (hasLiveRun) => hasLiveRun ? '查看实时调用' : '切到当前步骤';
    const fullDimensionLabels = deps.fullDimensionLabels && typeof deps.fullDimensionLabels === 'object'
      ? deps.fullDimensionLabels
      : {};

    function bindRunSessionExportButtons(container) {
      if (!container || typeof container.querySelectorAll !== 'function') {
        return;
      }
      container.querySelectorAll('[data-run-session-export-id]').forEach((button) => {
        button.addEventListener('click', () => {
          exportSkillTestRunSession(button.getAttribute('data-run-session-export-id'));
        });
      });
    }

    function buildChainRunStatusTag(status) {
      const normalized = String(status || '').trim().toLowerCase();
      if (normalized === 'passed') return '<span class="tag tag-success">链运行通过</span>';
      if (normalized === 'failed') return '<span class="tag tag-error">链运行失败</span>';
      if (normalized === 'partial') return '<span class="tag tag-pending">链运行部分完成</span>';
      if (normalized === 'aborted') return '<span class="tag tag-error">链运行中止</span>';
      if (normalized === 'running') return '<span class="tag tag-pending">链运行中</span>';
      return '<span class="tag tag-pending">链运行待定</span>';
    }

    function buildChainStepStatusTag(status) {
      const normalized = String(status || '').trim().toLowerCase();
      if (normalized === 'passed') return '<span class="tag tag-success">passed</span>';
      if (normalized === 'continued') return '<span class="tag tag-pending">continued</span>';
      if (normalized === 'failed') return '<span class="tag tag-error">failed</span>';
      if (normalized === 'skipped') return '<span class="tag tag-pending">skipped</span>';
      if (normalized === 'running') return '<span class="tag tag-pending">running</span>';
      if (normalized === 'aborted') return '<span class="tag tag-error">aborted</span>';
      return `<span class="tag tag-pending">${escapeHtml(normalized || 'pending')}</span>`;
    }

    function renderChainRunStepsHtml(steps) {
      if (!Array.isArray(steps) || steps.length === 0) {
        return '<p class="section-hint">这次链运行还没有 step 审计。</p>';
      }

      let html = '';
      for (const step of steps) {
        const runId = String(step && step.skillTestRunId || '').trim();
        const stepStatus = String(step && step.status || '').trim().toLowerCase();
        const stepCaseId = String(step && step.testCaseId || '').trim();
        const canOpenLiveRun = !runId && stepStatus === 'running' && stepCaseId;
        const artifactCount = Array.isArray(step && step.artifactRefs) ? step.artifactRefs.length : 0;
        html += '<div class="run-detail-card">';
        html += '<div class="run-detail-tag-row">';
        html += `${buildChainStepStatusTag(step && step.status)} <span class="tag">#${escapeHtml(String(step && step.sequenceIndex || 0))}</span> <span class="tag">${escapeHtml(step && (step.title || step.testCaseId) || 'chain step')}</span>`;
        if (runId) {
          html += ` <span class="agent-meta">run ${escapeHtml(runId)}</span>`;
        }
        if (artifactCount > 0) {
          html += ` <span class="tag">artifacts ${escapeHtml(String(artifactCount))}</span>`;
        }
        html += '</div>';
        if (step && step.summary) {
          html += `<div class="agent-meta">${escapeHtml(step.summary)}</div>`;
        }
        if (step && step.errorMessage) {
          html += `<div class="agent-meta" style="color:#e53e3e">${escapeHtml(step.errorMessage)}</div>`;
        }
        if (runId || canOpenLiveRun) {
          html += '<div class="run-item-actions" style="margin-top:0.4rem">';
          if (runId) {
            html += `<button type="button" class="mini-action" data-chain-step-run-detail-id="${escapeHtml(runId)}">查看调用步骤</button>`;
            html += `<button type="button" class="mini-action" style="margin-left:6px" data-run-session-export-id="${escapeHtml(runId)}">导出 Session</button>`;
          }
          if (canOpenLiveRun) {
            html += `<button type="button" class="mini-action"${runId ? ' style="margin-left:6px"' : ''} data-chain-step-live-case-id="${escapeHtml(stepCaseId)}">${escapeHtml(getLiveCaseActionLabel(true))}</button>`;
          }
          html += '</div>';
        }
        html += '</div>';
      }
      return html;
    }

    function bindChainRunStepActions(container) {
      if (!container || typeof container.querySelectorAll !== 'function') return;
      container.querySelectorAll('[data-chain-step-run-detail-id]').forEach((button) => {
        button.addEventListener('click', () => {
          const runId = button.getAttribute('data-chain-step-run-detail-id');
          const card = button.closest('.run-detail-card') || container;
          void toggleRunDetail(card, runId);
        });
      });
      container.querySelectorAll('[data-chain-step-live-case-id]').forEach((button) => {
        button.addEventListener('click', () => {
          const caseId = button.getAttribute('data-chain-step-live-case-id');
          if (!openCaseLiveRun(caseId)) {
            showToast('这一步的实时调用还没准备好，请稍后再试');
          }
        });
      });
      bindRunSessionExportButtons(container);
    }

    function summarizeChainPollutionChange(change) {
      if (typeof change === 'string') {
        return change;
      }
      if (!change || typeof change !== 'object') {
        return '';
      }
      const parts = [];
      if (change.kind) parts.push(String(change.kind));
      if (change.label) parts.push(String(change.label));
      if (change.table) parts.push(`table=${String(change.table)}`);
      if (change.path) parts.push(String(change.path));
      if (change.message) parts.push(String(change.message));
      return parts.join(' · ');
    }

    function renderChainPollutionCheckHtml(pollutionCheck) {
      if (!pollutionCheck || typeof pollutionCheck !== 'object' || !pollutionCheck.checked) {
        return '';
      }
      const changes = Array.isArray(pollutionCheck.changes) ? pollutionCheck.changes : [];
      const tagClass = pollutionCheck.ok ? 'tag-success' : 'tag-error';
      let html = '<div class="run-detail-section">';
      html += '<div class="section-label">隔离污染检查</div>';
      html += `<span class="tag ${tagClass}">${pollutionCheck.ok ? 'clean' : 'polluted'}</span> `;
      html += `<span class="tag">changes ${escapeHtml(String(pollutionCheck.changeCount || changes.length || 0))}</span>`;
      if (changes.length > 0) {
        html += '<ul class="run-detail-list">';
        for (const change of changes.slice(0, 12)) {
          const summary = summarizeChainPollutionChange(change) || JSON.stringify(change);
          html += `<li>${escapeHtml(summary)}</li>`;
        }
        if (changes.length > 12) {
          html += `<li>${escapeHtml(`另有 ${changes.length - 12} 条变化，下载 JSON 查看完整内容`)}</li>`;
        }
        html += '</ul>';
      }
      html += '</div>';
      return html;
    }

    async function toggleChainRunDetail(rowEl, chainRunId) {
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
        const data = await fetchJson(`/api/skills/${encodeURIComponent(getSelectedSkillId())}/test-chains/${encodeURIComponent(chainRunId)}`);
        renderChainRunDetailPanel(panel, data);
      } catch (err) {
        panel.innerHTML = `<p class="section-hint" style="color:#e53e3e">加载失败: ${escapeHtml(String(err && err.message || err))}</p>`;
      }
    }

    function renderChainRunDetailPanel(panel, data) {
      const payload = data && typeof data === 'object' ? data : {};
      const chainRun = payload.chainRun && typeof payload.chainRun === 'object' ? payload.chainRun : {};
      const steps = Array.isArray(payload.steps) ? payload.steps : [];
      const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];

      let html = buildRunSummarySectionHtml({
        title: '链运行摘要',
        tags: [
          buildStatusTagHtml(chainRun.status, liveChainRunStatusLabel(chainRun.status)),
          `<span class="tag">steps ${escapeHtml(String(chainRun.lastCompletedStepIndex || 0))}/${escapeHtml(String(chainRun.totalSteps || 0))}</span>`,
          chainRun.bootstrapStatus ? `<span class="tag">bootstrap ${escapeHtml(String(chainRun.bootstrapStatus))}</span>` : '',
          chainRun.teardownStatus ? `<span class="tag">teardown ${escapeHtml(String(chainRun.teardownStatus))}</span>` : '',
        ],
        metaParts: [
          chainRun.startedAt ? new Date(chainRun.startedAt).toLocaleString() : '',
          chainRun.exportChainId ? String(chainRun.exportChainId) : '',
        ],
        notes: chainRun.errorMessage
          ? [{ text: String(chainRun.errorMessage || ''), tone: 'error' }]
          : [],
      });

      html += renderChainPollutionCheckHtml(chainRun.pollutionCheck);

      if (warnings.length > 0) {
        html += '<div class="run-detail-section">';
        html += '<div class="section-label">提醒</div>';
        html += '<ul class="run-detail-list">';
        for (const warning of warnings) {
          html += `<li><span class="tag">${escapeHtml(String(warning.code || 'warning'))}</span> ${escapeHtml(String(warning.message || ''))}</li>`;
        }
        html += '</ul></div>';
      }

      html += '<div class="run-detail-section">';
      html += '<div class="section-label">步骤</div>';
      html += renderChainRunStepsHtml(steps);
      html += '</div>';

      panel.innerHTML = html;
      bindChainRunStepActions(panel);
    }

    function buildSingleRunCardHtml(run) {
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

      const accuracy = run.toolAccuracy != null
        ? `<span class="tag">工具命中 ${(run.toolAccuracy * 100).toFixed(0)}%</span>`
        : '';
      const environmentTagMeta = getEnvironmentStatusMeta(run.environmentStatus);
      const environmentTag = environmentTagMeta
        ? `<span class="tag ${environmentTagMeta.className}">${escapeHtml(environmentTagMeta.label)}</span>`
        : '';
      const environmentBuildResult = readEnvironmentBuildResultFromEvaluation(run.evaluation);
      const environmentBuildTagMeta = getEnvironmentBuildStatusMeta(environmentBuildResult && environmentBuildResult.status);
      const environmentBuildTag = environmentBuildTagMeta
        ? `<span class="tag ${environmentBuildTagMeta.className}">${escapeHtml(environmentBuildTagMeta.label)}</span>`
        : '';

      const tools = Array.isArray(run.actualTools) && run.actualTools.length > 0
        ? `<div class="agent-meta">工具: ${run.actualTools.map((toolName) => escapeHtml(toolName)).join(', ')}</div>`
        : '';

      let triggerFailHint = '';
      if (!run.verdict && isFailedFlag(run.triggerPassed)) {
        triggerFailHint = '<div class="run-item-warning">⚠ 这次没有加载到目标 skill，可点「查看详情」看模型实际做了什么</div>';
      }

      const runModelMeta = [run.provider, run.model].filter(Boolean).join(' / ');
      const runPromptVersion = run.promptVersion ? ` · ${run.promptVersion}` : '';

      return `
        <div class="run-item-header">
          ${triggerTag} ${execTag} ${environmentTag} ${environmentBuildTag} ${accuracy}
          <span class="agent-meta">${run.createdAt ? new Date(run.createdAt).toLocaleString() : ''}${runModelMeta ? ` · ${escapeHtml(runModelMeta)}` : ''}${runPromptVersion ? escapeHtml(runPromptVersion) : ''}</span>
        </div>
        ${tools}
        ${triggerFailHint}
        ${run.errorMessage ? `<div class="agent-meta" style="color:#e53e3e">${escapeHtml(run.errorMessage)}</div>` : ''}
      `;
    }

    function appendRunActions(row, run) {
      const actionsBar = document.createElement('div');
      actionsBar.className = 'run-item-actions';
      actionsBar.style.marginTop = '0.4rem';

      const detailBtn = document.createElement('button');
      detailBtn.className = 'mini-action';
      detailBtn.textContent = '查看详情';
      detailBtn.addEventListener('click', () => {
        void toggleRunDetail(row, run.id);
      });

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'mini-action';
      downloadBtn.textContent = '下载 JSON';
      downloadBtn.style.marginLeft = '6px';
      downloadBtn.addEventListener('click', async () => {
        try {
          const detail = await fetchJson(`/api/skill-test-runs/${encodeURIComponent(run.id)}`);
          downloadJsonFile(detail, `skill-test-run-${run.id}.json`);
          showToast('已下载');
        } catch (err) {
          showToast('下载失败: ' + (err && err.message || err));
        }
      });

      const sessionBtn = document.createElement('button');
      sessionBtn.className = 'mini-action';
      sessionBtn.textContent = '导出 Session';
      sessionBtn.style.marginLeft = '6px';
      sessionBtn.title = '导出本次 run 的原始 session JSONL，便于查看 agent 在沙盒内的具体行为';
      sessionBtn.addEventListener('click', () => {
        exportSkillTestRunSession(run.id);
      });

      actionsBar.appendChild(detailBtn);
      actionsBar.appendChild(downloadBtn);
      actionsBar.appendChild(sessionBtn);
      row.appendChild(actionsBar);
    }

    function renderCaseRuns(container, runs, options = {}) {
      if (!container) return;
      const chainRuns = Array.isArray(options.chainRuns) ? options.chainRuns : [];
      const chainRunRequest = options.chainRunRequest && typeof options.chainRunRequest === 'object'
        ? options.chainRunRequest
        : null;
      if (runs.length === 0 && chainRuns.length === 0) {
        container.innerHTML = `
          <div class="empty-state compact-empty-state">
            <p class="section-hint">这条用例还没有运行记录；点上方“运行测试”或“按链运行”就能在这里看到失败原因和诊断信息。</p>
          </div>
        `;
        return;
      }

      container.innerHTML = '';

      if (chainRuns.length > 0) {
        const heading = document.createElement('p');
        heading.className = 'section-hint';
        heading.textContent = `链运行历史 · ${chainRunRequest && chainRunRequest.chainId ? chainRunRequest.chainId : '未命名链'}`;
        container.appendChild(heading);

        for (const chainRun of chainRuns) {
          const row = document.createElement('div');
          row.className = 'run-item';
          const warningTag = Array.isArray(chainRun.warningFlags) && chainRun.warningFlags.length > 0
            ? `<span class="tag tag-pending">${chainRun.warningFlags.length} 条提醒</span>`
            : '';
          const failedStepText = chainRun.failedStepIndex ? ` · 失败于 #${chainRun.failedStepIndex}` : '';
          row.innerHTML = `
            <div class="run-item-header">
              ${buildChainRunStatusTag(chainRun.status)}
              <span class="tag">steps ${escapeHtml(String(chainRun.lastCompletedStepIndex || 0))}/${escapeHtml(String(chainRun.totalSteps || 0))}</span>
              <span class="tag">bootstrap ${escapeHtml(String(chainRun.bootstrapStatus || 'pending'))}</span>
              <span class="tag">teardown ${escapeHtml(String(chainRun.teardownStatus || 'pending'))}</span>
              ${warningTag}
              <span class="agent-meta">${chainRun.startedAt ? new Date(chainRun.startedAt).toLocaleString() : ''}${failedStepText}</span>
            </div>
            ${chainRun.errorMessage ? `<div class="agent-meta" style="color:#e53e3e">${escapeHtml(chainRun.errorMessage)}</div>` : ''}
          `;

          const actionsBar = document.createElement('div');
          actionsBar.className = 'run-item-actions';
          actionsBar.style.marginTop = '0.4rem';

          const detailBtn = document.createElement('button');
          detailBtn.className = 'mini-action';
          detailBtn.textContent = '查看链详情';
          detailBtn.addEventListener('click', () => {
            void toggleChainRunDetail(row, chainRun.id);
          });

          const downloadBtn = document.createElement('button');
          downloadBtn.className = 'mini-action';
          downloadBtn.textContent = '下载 JSON';
          downloadBtn.addEventListener('click', async () => {
            try {
              const detail = await fetchJson(`/api/skills/${encodeURIComponent(getSelectedSkillId())}/test-chains/${encodeURIComponent(chainRun.id)}`);
              downloadJsonFile(detail, `skill-test-chain-run-${chainRun.id}.json`);
              showToast('已下载');
            } catch (err) {
              showToast('下载失败: ' + (err && err.message || err));
            }
          });

          actionsBar.appendChild(detailBtn);
          actionsBar.appendChild(downloadBtn);
          row.appendChild(actionsBar);

          const inlineSteps = Array.isArray(chainRun.steps) ? chainRun.steps : [];
          if (inlineSteps.length > 0) {
            const stepsPanel = document.createElement('div');
            stepsPanel.className = 'run-detail-section';
            stepsPanel.innerHTML = `<div class="section-label">步骤明细</div>${renderChainRunStepsHtml(inlineSteps)}`;
            row.appendChild(stepsPanel);
            bindChainRunStepActions(stepsPanel);
          }

          container.appendChild(row);
        }
      }

      if (runs.length > 0 && chainRuns.length > 0) {
        const secondaryHeading = document.createElement('p');
        secondaryHeading.className = 'section-hint';
        secondaryHeading.textContent = '单用例运行历史';
        container.appendChild(secondaryHeading);
      }

      for (const run of runs) {
        const row = document.createElement('div');
        row.className = 'run-item';
        row.innerHTML = buildSingleRunCardHtml(run);
        appendRunActions(row, run);
        container.appendChild(row);
      }
    }

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
        panel.innerHTML = `<p class="section-hint" style="color:#e53e3e">加载失败: ${escapeHtml(String(err && err.message || err))}</p>`;
      }
    }

    function renderRunDetailPanel(panel, data) {
      const payload = data && typeof data === 'object' ? data : {};
      const debug = payload.debug || {};
      const result = payload.result || {};
      const run = payload.run && typeof payload.run === 'object' ? payload.run : {};
      const evaluationPayload = result && result.evaluation && typeof result.evaluation === 'object'
        ? result.evaluation
        : (run.evaluation && typeof run.evaluation === 'object' ? run.evaluation : null);
      const fullEvaluation = evaluationPayload
        && (
          typeof evaluationPayload.verdict === 'string'
          || (evaluationPayload.dimensions && typeof evaluationPayload.dimensions === 'object')
          || Array.isArray(evaluationPayload.steps)
          || Array.isArray(evaluationPayload.constraintChecks)
          || (evaluationPayload.aiJudge && typeof evaluationPayload.aiJudge === 'object')
        )
        ? evaluationPayload
        : null;
      const environmentEvaluation = evaluationPayload && evaluationPayload.environment && typeof evaluationPayload.environment === 'object'
        ? evaluationPayload.environment
        : null;
      const environmentBuildResult = readEnvironmentBuildResultFromEvaluation(evaluationPayload);
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
      const trace = buildRunDetailTrace(payload.trace, debug, run);
      const runValidation = readRunValidation(data);
      const runModelMeta = [run.provider, run.model].filter(Boolean).join(' / ');

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

      const environmentRequirements = environmentEvaluation && environmentEvaluation.requirements && typeof environmentEvaluation.requirements === 'object'
        ? environmentEvaluation.requirements
        : { satisfied: [], missing: [], unsupported: [] };
      const environmentAdvice = environmentEvaluation && environmentEvaluation.advice && typeof environmentEvaluation.advice === 'object'
        ? environmentEvaluation.advice
        : null;
      const environmentCache = environmentEvaluation && environmentEvaluation.cache && typeof environmentEvaluation.cache === 'object'
        ? environmentEvaluation.cache
        : null;
      const environmentSource = environmentEvaluation && environmentEvaluation.source && typeof environmentEvaluation.source === 'object'
        ? environmentEvaluation.source
        : null;
      const environmentStatus = String(environmentEvaluation && environmentEvaluation.status || run.environmentStatus || '').trim().toLowerCase();
      const showEnvironmentSection = Boolean(environmentEvaluation) && (
        (environmentStatus && environmentStatus !== 'skipped')
        || (Array.isArray(environmentRequirements.satisfied) && environmentRequirements.satisfied.length > 0)
        || (Array.isArray(environmentRequirements.missing) && environmentRequirements.missing.length > 0)
        || (Array.isArray(environmentRequirements.unsupported) && environmentRequirements.unsupported.length > 0)
        || (environmentEvaluation.bootstrap && Array.isArray(environmentEvaluation.bootstrap.commands) && environmentEvaluation.bootstrap.commands.length > 0)
        || (environmentEvaluation.verify && Array.isArray(environmentEvaluation.verify.commands) && environmentEvaluation.verify.commands.length > 0)
        || environmentAdvice
        || environmentCache
      );

      html += buildRunSummarySectionHtml({
        title: '运行摘要',
        tags: [
          buildStatusTagHtml(run.status || (fullEvaluation ? 'completed' : ''), liveRunStatusLabel(run.status || 'completed')),
          buildRunOutcomeTagHtml(run, fullEvaluation),
          buildEnvironmentStatusTagHtml(environmentStatus),
          buildEnvironmentBuildTagHtml(environmentBuildResult),
          trace && trace.summary && trace.summary.totalSteps > 0
            ? `<span class="tag">步骤 ${escapeHtml(String(trace.summary.totalSteps))}</span>`
            : '',
        ],
        metaParts: [
          run.createdAt ? new Date(run.createdAt).toLocaleString() : '',
          runModelMeta,
          run.promptVersion ? `prompt ${run.promptVersion}` : '',
        ],
        notes: run.errorMessage ? [{ text: String(run.errorMessage || ''), tone: 'error' }] : [],
      });

      if (showEnvironmentSection) {
        const environmentStatusMeta = getEnvironmentStatusMeta(environmentStatus);
        const environmentPhase = String(environmentEvaluation && environmentEvaluation.phase || run.environmentPhase || '').trim();
        const environmentReason = String(environmentEvaluation && environmentEvaluation.reason || '').trim();
        html += '<div class="run-detail-section">';
        html += '<div class="section-label">环境预检 / 安装链</div>';
        if (environmentStatusMeta) {
          html += `<span class="tag ${environmentStatusMeta.className}">${escapeHtml(environmentStatusMeta.label)}</span>`;
        }
        if (environmentPhase) {
          html += ` <span class="tag">${escapeHtml(environmentPhase)}</span>`;
        }
        if (environmentAdvice && environmentAdvice.target) {
          html += ` <span class="tag">${escapeHtml(String(environmentAdvice.target || 'TESTING.md'))}</span>`;
        }
        if (environmentSource && environmentSource.testingDocUsed) {
          html += ' <span class="tag">来自 TESTING.md</span>';
        }
        if (environmentReason) {
          html += `<div class="${environmentStatus && environmentStatus !== 'passed' ? 'run-detail-diag' : 'agent-meta'}">${escapeHtml(environmentReason)}</div>`;
        }
        if (environmentSource && environmentSource.testingDocUsed && environmentSource.testingDocPath) {
          html += `<div class="agent-meta">配置来源：${escapeHtml(String(environmentSource.testingDocPath || 'TESTING.md'))}</div>`;
        }
        html += buildEnvironmentCacheDetailsHtml(environmentCache);
        html += buildEnvironmentRequirementListHtml('已满足依赖', environmentRequirements.satisfied);
        html += buildEnvironmentRequirementListHtml('缺失依赖', environmentRequirements.missing);
        html += buildEnvironmentRequirementListHtml('已知限制', environmentRequirements.unsupported);
        html += buildEnvironmentCommandSectionHtml('Bootstrap', environmentEvaluation.bootstrap);
        html += buildEnvironmentCommandSectionHtml('Verify', environmentEvaluation.verify);
        if (environmentAdvice) {
          html += '<details class="run-detail-collapse">';
          html += `<summary class="agent-meta">${escapeHtml(String(environmentAdvice.summary || `查看 ${environmentAdvice.target || 'TESTING.md'} 建议 patch`))}</summary>`;
          if (environmentAdvice.mode) {
            html += `<div class="agent-meta">模式：${escapeHtml(String(environmentAdvice.mode || 'suggest-patch'))}</div>`;
          }
          if (environmentAdvice.target) {
            html += `<div class="agent-meta">目标文件：${escapeHtml(String(environmentAdvice.target || 'TESTING.md'))}</div>`;
          }
          if (environmentAdvice.patch) {
            html += `<pre class="run-detail-pre">${escapeHtml(String(environmentAdvice.patch || ''))}</pre>`;
          }
          html += '</details>';
        }
        html += '</div>';
      }

      html += buildEnvironmentBuildDetailsHtml(environmentBuildResult);

      if (trace && ((trace.summary && trace.summary.totalSteps > 0) || (trace.failureContext && trace.failureContext.text))) {
        const traceStatus = String(trace.summary && trace.summary.status || run.status || '').trim();
        const traceTone = liveRunTone(traceStatus);
        const tracePills = [
          trace.summary && trace.summary.totalSteps > 0
            ? `<span class="message-tool-trace-pill time">步骤 ${escapeHtml(String(trace.summary.totalSteps))}</span>`
            : '',
          trace.summary && trace.summary.sessionToolCount > 0
            ? `<span class="message-tool-trace-pill duration">session ${escapeHtml(String(trace.summary.sessionToolCount))}</span>`
            : '',
          trace.summary && trace.summary.bridgeToolCount > 0
            ? `<span class="message-tool-trace-pill duration">bridge ${escapeHtml(String(trace.summary.bridgeToolCount))}</span>`
            : '',
        ].filter(Boolean);
        html += buildToolTracePanelHtml({
          sectionLabel: '工具时间线',
          helperText: '这里显示 agent 在这一步 run 里的具体调用顺序。',
          trace,
          status: traceStatus || run.status || 'completed',
          statusLabel: liveRunStatusLabel(traceStatus || run.status || 'completed'),
          tone: traceTone,
          extraPills: tracePills,
          notes: trace.failureContext && trace.failureContext.text
            ? [`<div class="message-tool-trace-note failed">${escapeHtml(trace.failureContext.text)}</div>`]
            : [],
          emptyLabel: '本次 run 没有持久化到工具时间线。',
        });
      }

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
          const orderedDimensionKeys = Object.keys(fullDimensionLabels);
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
            html += `<span class="tag">${escapeHtml(fullDimensionLabels[key] || key)}</span>`;
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
            ...toolEvents.map((eventEntry) => (eventEntry.payload && eventEntry.payload.tool) || 'unknown'),
            ...sessionToolCalls.map((toolCall) => toolCall.toolName || 'unknown'),
          ];
          html += `<div class="run-detail-diag">模型调用了以下工具，但均未触发目标 skill: <strong>${escapeHtml(allTools.join(', '))}</strong></div>`;
        }
        if (session.thinking) {
          html += '<div class="section-label" style="margin-top:0.4rem">模型思考过程</div>';
          html += `<pre class="run-detail-pre run-detail-thinking">${escapeHtml(session.thinking)}</pre>`;
        }
        html += '</div>';
      }

      if (toolEvents.length > 0) {
        html += '<div class="run-detail-section">';
        html += '<div class="section-label">回调工具调用</div>';
        for (const ev of toolEvents) {
          const eventPayload = ev.payload || {};
          html += '<div class="run-detail-tool">';
          html += `<span class="tag">${escapeHtml(eventPayload.tool || 'unknown')}</span>`;
          if (eventPayload.status) html += ` <span class="agent-meta">${escapeHtml(eventPayload.status)}</span>`;
          if (eventPayload.request) html += `<pre class="run-detail-pre">${escapeHtml(JSON.stringify(eventPayload.request, null, 2))}</pre>`;
          html += '</div>';
        }
        html += '</div>';
      }

      if (sessionToolCalls.length > 0) {
        html += '<div class="run-detail-section">';
        html += '<div class="section-label">内置工具调用</div>';
        for (const toolCall of sessionToolCalls) {
          html += '<div class="run-detail-tool">';
          html += `<span class="tag">${escapeHtml(toolCall.toolName || 'unknown')}</span>`;
          if (toolCall.arguments && Object.keys(toolCall.arguments).length > 0) {
            html += `<pre class="run-detail-pre">${escapeHtml(JSON.stringify(toolCall.arguments, null, 2))}</pre>`;
          }
          html += '</div>';
        }
        html += '</div>';
      }

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

    return {
      renderCaseRuns,
      renderRunDetailPanel,
    };
  };
})();
