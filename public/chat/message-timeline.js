// @ts-check

(function registerMessageTimelineModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createMessageTimelineRenderer = function createMessageTimelineRenderer({ dom, helpers }) {
    const {
      agentById,
      buildAgentAvatarElement,
      canInspectToolTrace,
      displayedMessageBody,
      formatDateTime,
      isPrivateTimelineMessage,
      liveStageForMessage,
      liveStageLabel,
      messageSessionInfo,
      privateRecipientNames,
      renderMessageBody,
      timelineMessagesForConversation,
      toolTraceSignatureForMessage,
      toolTraceStateForMessage,
    } = helpers;

    const TRACE_SCROLL_STEP_LIMIT = 8;

    function formatDuration(durationMs) {
      const value = Number(durationMs || 0);

      if (!Number.isFinite(value) || value <= 0) {
        return '';
      }

      if (value < 1000) {
        return `${Math.round(value)}ms`;
      }

      return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}s`;
    }

    function appendLiveToolRotor(container, label) {
      const rotor = document.createElement('span');
      const text = document.createElement('span');

      rotor.className = 'message-tool-live-rotor';
      rotor.setAttribute('aria-hidden', 'true');
      rotor.textContent = '↻';
      text.textContent = label;
      container.append(rotor, text);
    }

    function createTracePill(label, tone = 'neutral', options = {}) {
      const pill = document.createElement('span');
      pill.className = `message-tool-trace-pill ${tone}`;

      if (options && options.live) {
        pill.classList.add('live');
        appendLiveToolRotor(pill, label);
      } else {
        pill.textContent = label;
      }

      return pill;
    }

    function formatTracePayload(value) {
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

    function formatInlineTraceText(value, maxLength = 180) {
      const text = formatTracePayload(value)
        .replace(/\s+/g, ' ')
        .trim();

      if (!text) {
        return '';
      }

      if (text.length <= maxLength) {
        return text;
      }

      return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
    }

    function hasDisplayableTraceDetail(value) {
      if (value == null) {
        return false;
      }

      if (typeof value === 'string') {
        return value.trim() !== '';
      }

      if (typeof value === 'number' || typeof value === 'boolean') {
        return true;
      }

      if (Array.isArray(value)) {
        return value.some((entry) => hasDisplayableTraceDetail(entry));
      }

      if (typeof value === 'object') {
        const entries = Object.values(value);

        if (entries.length === 0) {
          return false;
        }

        return entries.some((entry) => hasDisplayableTraceDetail(entry));
      }

      return String(value).trim() !== '';
    }

    function traceToneForStatus(status) {
      if (status === 'failed') {
        return 'failed';
      }

      if (status === 'succeeded') {
        return 'success';
      }

      if (status === 'running') {
        return 'running';
      }

      return 'neutral';
    }

    function traceSourceLabel(step) {
      if (step && step.kind === 'session') {
        return 'pi-mono';
      }

      if (step && step.kind === 'bridge') {
        return '聊天桥';
      }

      return '工具事件';
    }

    function appendTracePayload(container, label, value, tone = 'neutral') {
      const text = formatTracePayload(value);

      if (!text) {
        return;
      }

      const payloadWrap = document.createElement('div');
      const payloadLabel = document.createElement('div');
      const payload = document.createElement('pre');

      payloadWrap.className = 'message-tool-trace-payload-wrap';
      payloadLabel.className = 'message-tool-trace-payload-label';
      payload.className = `message-tool-trace-payload ${tone}`;
      payloadLabel.textContent = label;
      payload.textContent = text;

      payloadWrap.append(payloadLabel, payload);
      container.appendChild(payloadWrap);
    }

    function traceFailureContext(trace) {
      return trace && trace.failureContext && typeof trace.failureContext === 'object' ? trace.failureContext : null;
    }

    function traceActivity(trace) {
      const directActivity = trace && trace.activity && typeof trace.activity === 'object' ? trace.activity : null;

      if (directActivity) {
        return directActivity;
      }

      const summary = trace && trace.summary && typeof trace.summary === 'object' ? trace.summary : null;
      const steps = trace && Array.isArray(trace.steps) ? trace.steps.filter(Boolean) : [];
      const summaryStatus = String(summary && summary.status ? summary.status : '').trim().toLowerCase();
      const runningStep =
        steps
          .slice()
          .reverse()
          .find((step) => {
            const status = String(step && step.status ? step.status : '').trim().toLowerCase();
            return status === 'running' || status === 'queued';
          }) || null;

      if (runningStep && runningStep.toolName) {
        return {
          status: summaryStatus || 'running',
          hasCurrentTool: true,
          currentToolName: String(runningStep.toolName),
          currentStepId: String(runningStep.stepId || ''),
          currentStepKind: String(runningStep.kind || ''),
          inferred: false,
          label: `当前工具：${runningStep.toolName}`,
        };
      }

      if (summaryStatus !== 'running') {
        return null;
      }

      const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
      const inferredToolName =
        lastStep && lastStep.kind === 'session' ? String(lastStep.bridgeToolHint || lastStep.toolName || '').trim() : '';

      if (!inferredToolName) {
        return null;
      }

      return {
        status: 'running',
        hasCurrentTool: true,
        currentToolName: inferredToolName,
        currentStepId: String(lastStep.stepId || ''),
        currentStepKind: String(lastStep.bridgeToolHint ? 'bridge' : lastStep.kind || 'session'),
        inferred: true,
        label: `当前工具：${inferredToolName}`,
      };
    }

    function liveStageActivity(stage) {
      if (!stage) {
        return null;
      }

      const currentToolName = stage.currentToolName ? String(stage.currentToolName).trim() : '';

      if (!currentToolName) {
        return null;
      }

      return {
        status: String(stage.status || 'running').trim().toLowerCase() || 'running',
        hasCurrentTool: true,
        currentToolName,
        currentStepId: String(stage.currentToolStepId || ''),
        currentStepKind: String(stage.currentToolKind || 'session'),
        inferred: Boolean(stage.currentToolInferred),
        label: `当前工具：${currentToolName}`,
      };
    }

    function allTraceSteps(trace) {
      if (!trace) {
        return [];
      }

      if (Array.isArray(trace.steps) && trace.steps.length > 0) {
        return trace.steps.filter(Boolean);
      }

      return [].concat(
        Array.isArray(trace.sessionToolCalls) ? trace.sessionToolCalls.filter(Boolean) : [],
        Array.isArray(trace.bridgeToolEvents) ? trace.bridgeToolEvents.filter(Boolean) : []
      );
    }

    function findCurrentTraceStep(trace, liveStage) {
      const steps = allTraceSteps(trace);
      const liveStepId = liveStage && liveStage.currentToolStepId ? String(liveStage.currentToolStepId).trim() : '';

      if (liveStepId) {
        const exactLiveStep = steps.find((step) => String(step && step.stepId ? step.stepId : '').trim() === liveStepId) || null;

        if (exactLiveStep) {
          return exactLiveStep;
        }
      }

      const activity = liveStageActivity(liveStage) || traceActivity(trace);
      const activityStepId = activity && activity.currentStepId ? String(activity.currentStepId).trim() : '';

      if (activityStepId) {
        const exactActivityStep =
          steps.find((step) => String(step && step.stepId ? step.stepId : '').trim() === activityStepId) || null;

        if (exactActivityStep) {
          return exactActivityStep;
        }
      }

      const runningStep =
        steps
          .slice()
          .reverse()
          .find((step) => {
            const status = String(step && step.status ? step.status : '').trim().toLowerCase();
            return status === 'running' || status === 'queued';
          }) || null;

      if (runningStep) {
        return runningStep;
      }

      const currentToolName = activity && activity.currentToolName ? String(activity.currentToolName).trim() : '';

      if (!currentToolName) {
        return null;
      }

      return (
        steps
          .slice()
          .reverse()
          .find((step) => String(step && step.toolName ? step.toolName : '').trim() === currentToolName) || null
      );
    }

    function buildLiveTraceCommandDetail(step) {
      if (!step) {
        return null;
      }

      const requestSummary = step && step.requestSummary !== undefined ? step.requestSummary : null;

      if (requestSummary && typeof requestSummary === 'object' && !Array.isArray(requestSummary)) {
        if (typeof requestSummary.command === 'string' && requestSummary.command.trim()) {
          return {
            label: '当前命令',
            text: requestSummary.command.trim(),
          };
        }

        if (typeof requestSummary.path === 'string' && requestSummary.path.trim()) {
          return {
            label: '当前路径',
            text: requestSummary.path.trim(),
          };
        }

        if (Array.isArray(requestSummary.paths) && requestSummary.paths.length > 0) {
          return {
            label: '当前路径',
            text: requestSummary.paths.join('\n'),
          };
        }
      }

      if (typeof requestSummary === 'string' && requestSummary.trim()) {
        return {
          label: '当前命令',
          text: requestSummary.trim(),
        };
      }

      const partialJson = step && step.partialJson ? String(step.partialJson).trim() : '';

      if (partialJson) {
        return {
          label: '局部参数',
          text: partialJson,
        };
      }

      if (hasDisplayableTraceDetail(requestSummary)) {
        return {
          label: '参数摘要',
          text: formatTracePayload(requestSummary),
        };
      }

      return null;
    }

    function buildTraceLiveSpotlight(trace, liveStage, summaryWrap, toggleButton) {
      const activity = liveStageActivity(liveStage) || traceActivity(trace);

      if (!activity || !activity.hasCurrentTool || !activity.currentToolName) {
        return null;
      }

      const currentStep = findCurrentTraceStep(trace, liveStage);
      const commandDetail = buildLiveTraceCommandDetail(currentStep);
      const panel = document.createElement('div');
      const eyebrow = document.createElement('div');
      const titleRow = document.createElement('div');
      const title = document.createElement('div');
      const meta = document.createElement('div');
      const detailWrap = document.createElement('div');
      const detailLabel = document.createElement('div');
      const detailBody = document.createElement('pre');
      const footer = document.createElement('div');
      const actionRow = document.createElement('div');
      const kindTone = activity.currentStepKind === 'bridge' ? 'neutral' : 'success';

      panel.className = `message-tool-trace-live-panel ${activity.status === 'running' ? 'running' : ''}`.trim();
      eyebrow.className = 'message-tool-trace-live-eyebrow';
      titleRow.className = 'message-tool-trace-live-title-row';
      title.className = 'message-tool-trace-live-title';
      meta.className = 'message-tool-trace-live-meta';
      detailWrap.className = 'message-tool-trace-live-command';
      detailLabel.className = 'message-tool-trace-live-command-label';
      detailBody.className = 'message-tool-trace-live-command-body';
      footer.className = 'message-tool-trace-live-footer';
      actionRow.className = 'message-tool-trace-live-actions';
      eyebrow.textContent = '当前调用工具';

      if (activity.status === 'running') {
        appendLiveToolRotor(title, activity.currentToolName);
      } else {
        title.textContent = activity.currentToolName;
      }

      meta.appendChild(createTracePill(activity.status === 'running' ? '实时中' : '已记录', activity.status === 'running' ? 'running' : 'success'));
      meta.appendChild(createTracePill(activity.currentStepKind === 'bridge' ? '聊天桥' : 'pi-mono', kindTone));

      if (activity.inferred) {
        meta.appendChild(createTracePill('推断', 'neutral'));
      }

      detailLabel.textContent = commandDetail ? commandDetail.label : '当前命令';
      detailBody.textContent = commandDetail ? commandDetail.text : '等待这一步的命令摘要…';

      titleRow.append(title, meta);
      detailWrap.append(detailLabel, detailBody);
      footer.appendChild(summaryWrap);

      if (toggleButton) {
        actionRow.appendChild(toggleButton);
        footer.appendChild(actionRow);
      }

      panel.append(eyebrow, titleRow, detailWrap, footer);

      return panel;
    }

    function traceStepCount(trace) {
      const traceSteps = trace && Array.isArray(trace.steps) ? trace.steps : [];

      if (traceSteps.length > 0) {
        return traceSteps.length;
      }

      const sessionSteps = trace && Array.isArray(trace.sessionToolCalls) ? trace.sessionToolCalls : [];
      const bridgeSteps = trace && Array.isArray(trace.bridgeToolEvents) ? trace.bridgeToolEvents : [];
      return sessionSteps.length + bridgeSteps.length;
    }

    function buildTraceToggleButton(messageId, isOpen, options = {}) {
      const button = document.createElement('button');
      const prominent = Boolean(options && options.prominent);

      button.type = 'button';
      button.className = prominent ? 'message-tool-trace-toggle message-tool-trace-toggle-prominent' : 'message-tool-trace-toggle ghost-button';
      button.dataset.messageId = messageId;
      button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      button.textContent = prominent ? (isOpen ? '收起工具链路' : '展开完整工具链路') : isOpen ? '收起工具链路' : '查看工具链路';
      return button;
    }

    function buildTraceCopyButton(messageId) {
      const button = document.createElement('button');

      button.type = 'button';
      button.className = 'message-tool-trace-copy-button ghost-button';
      button.dataset.messageId = messageId;
      button.textContent = '复制错误上下文';
      return button;
    }

    function buildTraceActivityNote(trace, liveStage) {
      const activity = liveStageActivity(liveStage) || traceActivity(trace);

      if (!activity || !activity.hasCurrentTool || !activity.label) {
        return null;
      }

      const note = document.createElement('div');
      note.className = `message-tool-trace-note ${activity.status === 'running' ? 'running is-live' : ''}`.trim();

      if (activity.status === 'running') {
        appendLiveToolRotor(note, activity.inferred ? `${activity.label}（推断）` : activity.label);
      } else {
        note.textContent = activity.inferred ? `${activity.label}（推断）` : activity.label;
      }

      return note;
    }

    function buildTraceFailureNote(trace) {
      const failureContext = traceFailureContext(trace);

      if (!failureContext || !failureContext.hasFailure) {
        return null;
      }

      const traceSteps = trace && Array.isArray(trace.steps) ? trace.steps : [];
      const bridgeSteps = trace && Array.isArray(trace.bridgeToolEvents) ? trace.bridgeToolEvents : [];
      const sessionSteps = trace && Array.isArray(trace.sessionToolCalls) ? trace.sessionToolCalls : [];
      const failedStep = (traceSteps.length > 0 ? traceSteps : bridgeSteps.concat(sessionSteps)).find(
        (step) => step && step.status === 'failed'
      ) || null;
      const taskErrorText = trace && trace.task && trace.task.errorMessage ? formatInlineTraceText(trace.task.errorMessage) : '';
      const failureContextText = failureContext && failureContext.text ? formatInlineTraceText(failureContext.text) : '';
      const failureText = failedStep
        ? formatInlineTraceText(
            failedStep.errorSummary || failedStep.resultSummary || failedStep.requestSummary || failedStep.partialJson || ''
          )
        : taskErrorText;
      const note = document.createElement('div');

      note.className = 'message-tool-trace-note failed';

      if (failedStep && failureText) {
        note.textContent = `失败步骤：${failedStep.toolName || 'tool'} · ${failureText}`;
        return note;
      }

      if (failedStep) {
        note.textContent = `失败步骤：${failedStep.toolName || 'tool'}，请查看高亮节点。`;
        return note;
      }

      if (taskErrorText) {
        note.textContent = `任务失败：${taskErrorText}`;
        return note;
      }

      if (failureContext && failureContext.source === 'session' && failureContextText) {
        note.textContent = `会话失败：${failureContextText}`;
        return note;
      }

      if (failureContextText) {
        note.textContent = `失败上下文：${failureContextText}`;
        return note;
      }

      note.textContent = '存在失败步骤，请查看高亮节点。';
      return note;
    }

    function buildTraceStep(step, index, isLastStep) {
      const article = document.createElement('article');
      const rail = document.createElement('div');
      const indexBadge = document.createElement('span');
      const line = document.createElement('span');
      const content = document.createElement('div');
      const header = document.createElement('div');
      const titleWrap = document.createElement('div');
      const eyebrow = document.createElement('div');
      const title = document.createElement('div');
      const meta = document.createElement('div');
      const toolName = step && step.toolName ? String(step.toolName) : 'tool';
      const status = step && step.status ? String(step.status) : 'observed';
      const tone = traceToneForStatus(status);
      const duration = formatDuration(step && step.durationMs);
      const stepLeadParts = [traceSourceLabel(step)];
      const failureText =
        status === 'failed'
          ? formatInlineTraceText(
              step && (step.errorSummary || step.resultSummary || step.requestSummary || step.partialJson)
                ? step.errorSummary || step.resultSummary || step.requestSummary || step.partialJson
                : ''
            )
          : '';

      if (step && step.kind === 'session' && !step.createdAt) {
        stepLeadParts.push('顺序还原');
      }

      if (step && step.toolCallId) {
        stepLeadParts.push(`#${String(step.toolCallId).slice(0, 12)}`);
      }

      article.className = `message-tool-trace-step ${tone} ${step && step.kind ? String(step.kind) : 'observed'}${
        isLastStep ? ' last' : ''
      }`;
      article.dataset.stepId = step && step.stepId ? String(step.stepId) : '';
      rail.className = 'message-tool-trace-step-rail';
      indexBadge.className = 'message-tool-trace-step-index';
      line.className = 'message-tool-trace-step-line';
      content.className = 'message-tool-trace-step-main';
      header.className = 'message-tool-trace-step-header';
      titleWrap.className = 'message-tool-trace-step-title-wrap';
      eyebrow.className = 'message-tool-trace-step-eyebrow';
      title.className = 'message-tool-trace-step-title';
      meta.className = 'message-tool-trace-step-meta';

      indexBadge.textContent = String(index + 1);
      eyebrow.textContent = stepLeadParts.join(' · ');
      title.textContent = toolName;
      meta.appendChild(createTracePill(status, tone, { live: status === 'running' }));

      if (duration) {
        meta.appendChild(createTracePill(duration, 'duration'));
      }

      if (step && step.createdAt) {
        meta.appendChild(createTracePill(formatDateTime(step.createdAt), 'time'));
      }

      if (step && step.kind === 'session' && step.bridgeToolHint) {
        meta.appendChild(createTracePill(`触发 ${step.bridgeToolHint}`, 'neutral'));
      }

      if (step && step.kind === 'bridge' && step.linkedFromStepId) {
        meta.appendChild(createTracePill('桥接确认', 'neutral'));
      }

      titleWrap.append(eyebrow, title);
      header.append(titleWrap, meta);
      rail.append(indexBadge, line);
      content.appendChild(header);

      if (failureText) {
        const alert = document.createElement('div');
        alert.className = 'message-tool-trace-step-alert';
        alert.textContent = failureText;
        content.appendChild(alert);
      }

      appendTracePayload(content, '输入摘要', step && step.requestSummary ? step.requestSummary : null, 'request');
      appendTracePayload(content, '输出摘要', step && step.resultSummary ? step.resultSummary : null, 'result');
      appendTracePayload(content, '错误摘要', step && step.errorSummary ? step.errorSummary : null, 'failed');
      appendTracePayload(content, '局部参数', step && step.partialJson ? step.partialJson : '', 'request');
      article.append(rail, content);

      return article;
    }

    function buildTraceSection(titleText, steps, startIndex = 0) {
      const section = document.createElement('section');
      const header = document.createElement('div');
      const title = document.createElement('div');
      const meta = document.createElement('div');
      const timeline = document.createElement('div');
      const failedCount = steps.filter((step) => step && step.status === 'failed').length;
      const hasRunning = steps.some((step) => step && step.status === 'running');

      section.className = 'message-tool-trace-section';
      header.className = 'message-tool-trace-section-header';
      title.className = 'message-tool-trace-section-title';
      meta.className = 'message-tool-trace-section-meta';
      timeline.className = 'message-tool-trace-section-steps';
      title.textContent = titleText;

      meta.appendChild(createTracePill(`${steps.length} 步`, 'neutral'));

      if (failedCount > 0) {
        meta.appendChild(createTracePill(`${failedCount} 失败`, 'failed'));
      } else if (hasRunning) {
        meta.appendChild(createTracePill('进行中', 'running', { live: true }));
      } else {
        meta.appendChild(createTracePill('已记录', 'success'));
      }

      steps.forEach((step, index) => {
        timeline.appendChild(buildTraceStep(step, startIndex + index, index === steps.length - 1));
      });

      header.append(title, meta);
      section.append(header, timeline);
      return section;
    }

    function captureTraceViewportState(container) {
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

    function restoreTraceViewportState(container, snapshot) {
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

    function syncToolTraceSection(container, message, liveStage) {
      const shouldShow = canInspectToolTrace(message);

      if (!shouldShow) {
        container.className = 'message-tool-trace hidden';
        container.replaceChildren();
        return;
      }

      const traceState = toolTraceStateForMessage(message.id) || {
        open: false,
        status: 'idle',
        errorMessage: '',
        data: null,
      };
      const preservedViewport = captureTraceViewportState(container);
      const trace = traceState && traceState.data ? traceState.data : null;
      const summary = trace && trace.summary ? trace.summary : null;
      const traceSteps = trace && Array.isArray(trace.steps) ? trace.steps : [];
      const sessionSteps = trace && Array.isArray(trace.sessionToolCalls) ? trace.sessionToolCalls : [];
      const bridgeSteps = trace && Array.isArray(trace.bridgeToolEvents) ? trace.bridgeToolEvents : [];
      const header = document.createElement('div');
      const summaryWrap = document.createElement('div');
      const children = [];

      container.className = `message-tool-trace${traceState.open ? ' open' : ''}`;
      header.className = 'message-tool-trace-header';
      summaryWrap.className = 'message-tool-trace-summary';

      const liveActivity = liveStageActivity(liveStage);
      const activity = liveActivity || traceActivity(trace);
      const shouldShowLiveSpotlight = Boolean(activity && activity.hasCurrentTool && activity.currentToolName);

      if (summary) {
        const summaryTone = summary.status === 'failed' ? 'failed' : summary.status === 'running' ? 'running' : 'success';
        summaryWrap.appendChild(createTracePill(`${summary.totalSteps} 步`, 'neutral'));
        summaryWrap.appendChild(createTracePill(summary.status === 'failed' ? '有失败' : summary.status === 'running' ? '进行中' : '已完成', summaryTone));

        if (!shouldShowLiveSpotlight && activity && activity.hasCurrentTool && activity.currentToolName) {
          summaryWrap.appendChild(createTracePill(`当前：${activity.currentToolName}`, 'running', { live: true }));
        }

        if (summary.failedSteps > 0) {
          summaryWrap.appendChild(createTracePill(`${summary.failedSteps} 失败`, 'failed'));
        }

        if (summary.bridgeToolCount > 0) {
          summaryWrap.appendChild(createTracePill(`${summary.bridgeToolCount} bridge`, 'neutral'));
        }

        if (summary.sessionToolCount > 0) {
          summaryWrap.appendChild(createTracePill(`${summary.sessionToolCount} pi`, 'neutral'));
        }

        if (summary.totalDurationMs > 0) {
          summaryWrap.appendChild(createTracePill(formatDuration(summary.totalDurationMs), 'duration'));
        }

        if (summary.hasRetries) {
          summaryWrap.appendChild(createTracePill(`${summary.retryCount} 重试`, 'running'));
        }
      } else if (traceState.status === 'loading') {
        summaryWrap.appendChild(createTracePill('载入工具链路中', 'running'));
      } else if (traceState.status === 'error') {
        summaryWrap.appendChild(createTracePill(traceState.errorMessage || '工具链路加载失败', 'failed'));
      } else if (message.status === 'queued' || message.status === 'streaming') {
        summaryWrap.appendChild(createTracePill('等待工具链路', 'running'));
      } else {
        summaryWrap.appendChild(createTracePill('暂无工具记录', 'neutral'));
      }

      if (!summary && !shouldShowLiveSpotlight && liveActivity && liveActivity.hasCurrentTool && liveActivity.currentToolName) {
        summaryWrap.appendChild(createTracePill(`当前：${liveActivity.currentToolName}`, 'running', { live: true }));
      }

      const liveSpotlight = shouldShowLiveSpotlight
        ? buildTraceLiveSpotlight(trace, liveStage, summaryWrap, buildTraceToggleButton(message.id, traceState.open, { prominent: true }))
        : null;

      if (liveSpotlight) {
        header.append(liveSpotlight);
      } else {
        header.append(buildTraceToggleButton(message.id, traceState.open), summaryWrap);
      }
      children.push(header);

      if (traceState.open) {
        const details = document.createElement('div');
        details.className = 'message-tool-trace-details';

        if (traceState.status === 'loading' && !trace) {
          const loading = document.createElement('div');
          loading.className = 'message-tool-trace-note';
          loading.textContent = '正在整理这条回复背后的工具步骤…';
          details.appendChild(loading);
        } else if (traceState.status === 'error' && !trace) {
          const error = document.createElement('div');
          const errorRow = document.createElement('div');
          error.className = 'message-tool-trace-note failed';
          error.textContent = traceState.errorMessage || '工具链路加载失败';
          errorRow.className = 'message-tool-trace-note-row';
          errorRow.append(error, buildTraceCopyButton(message.id));
          details.appendChild(errorRow);
        } else {
          const activityNote = buildTraceActivityNote(trace, liveStage);
          const failureNote = buildTraceFailureNote(trace);
          const stepsViewport = document.createElement('div');
          const shouldScrollSteps = traceStepCount(trace) > TRACE_SCROLL_STEP_LIMIT;
          let stepIndex = 0;

          stepsViewport.className = 'message-tool-trace-steps-viewport';
          if (shouldScrollSteps) {
            stepsViewport.classList.add('scrollable');
          }

          if (activityNote && !liveSpotlight) {
            details.appendChild(activityNote);
          }

          if (trace && trace.session) {
            const sessionMeta = document.createElement('div');
            const metaBits = [
              trace.session.provider || '',
              trace.session.model || '',
              trace.session.stopReason ? `stop=${trace.session.stopReason}` : '',
            ].filter(Boolean);

            sessionMeta.className = 'message-tool-trace-note';
            sessionMeta.textContent = metaBits.length > 0 ? `会话摘要：${metaBits.join(' · ')}` : '会话摘要已就绪';
            details.appendChild(sessionMeta);
          }

          if (failureNote) {
            const failureRow = document.createElement('div');
            failureRow.className = 'message-tool-trace-note-row';
            failureRow.append(failureNote, buildTraceCopyButton(message.id));
            details.appendChild(failureRow);
          }

          if (traceSteps.length > 0) {
            stepsViewport.appendChild(buildTraceSection('完整时间线', traceSteps, stepIndex));
            stepIndex += traceSteps.length;
          } else {
            if (sessionSteps.length > 0) {
              stepsViewport.appendChild(buildTraceSection('pi-mono 工具', sessionSteps, stepIndex));
              stepIndex += sessionSteps.length;
            }

            if (bridgeSteps.length > 0) {
              stepsViewport.appendChild(buildTraceSection('聊天桥工具', bridgeSteps, stepIndex));
              stepIndex += bridgeSteps.length;
            }
          }

          if (traceSteps.length === 0 && sessionSteps.length === 0 && bridgeSteps.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'message-tool-trace-note';
            empty.textContent = '这条消息目前还没有结构化工具事件。';
            stepsViewport.appendChild(empty);
          }

          details.appendChild(stepsViewport);
        }

        children.push(details);
      }

      container.replaceChildren(...children);
      container.classList.toggle('hidden', false);
      restoreTraceViewportState(container, preservedViewport);
    }

    function createMessageCard(message, conversationId, agents, activeTurn, activeAgentSlots) {
      const card = document.createElement('article');
      const meta = document.createElement('div');
      const sender = document.createElement('span');
      const time = document.createElement('span');
      const body = document.createElement('div');
      const liveHint = document.createElement('div');
      const toolTrace = document.createElement('section');

      meta.className = 'message-meta';
      sender.className = 'message-sender';
      time.className = 'message-time';
      body.className = 'message-body';
      liveHint.className = 'message-live-hint hidden';
      toolTrace.className = 'message-tool-trace hidden';

      meta.append(sender, time);
      card.append(meta, toolTrace, body, liveHint);
      syncMessageCard(card, message, conversationId, agents, activeTurn, activeAgentSlots);

      return card;
    }

    function syncMessageCard(card, message, conversationId, agents, activeTurn, activeAgentSlots) {
      const agent = message.agentId
        ? (Array.isArray(agents) ? agents.find((item) => item.id === message.agentId) : null) || agentById(message.agentId)
        : null;
      const liveStage = isPrivateTimelineMessage(message)
        ? null
        : liveStageForMessage(conversationId || (message && message.conversationId) || '', activeTurn, activeAgentSlots, message.id);
      const liveLabel = liveStageLabel(liveStage);
      const bodyText = displayedMessageBody(message, liveStage);
      const sessionInfo = messageSessionInfo(message);
      const recipients = privateRecipientNames(message);
      const privacyLabel =
        isPrivateTimelineMessage(message) && recipients.length > 0 ? `Private -> ${recipients.join(', ')}` : 'Private';
      const traceSignature = toolTraceSignatureForMessage(message);
      const signature = [
        message.id,
        message.role,
        message.senderName || '',
        message.createdAt || '',
        message.status || '',
        bodyText,
        message.errorMessage || '',
        agent && agent.accentColor ? agent.accentColor : '',
        agent && agent.avatarDataUrl ? agent.avatarDataUrl : '',
        liveLabel,
        liveStage && liveStage.status ? liveStage.status : '',
        liveStage && liveStage.currentToolName ? liveStage.currentToolName : '',
        liveStage && liveStage.currentToolKind ? liveStage.currentToolKind : '',
        liveStage && liveStage.currentToolStepId ? liveStage.currentToolStepId : '',
        liveStage && liveStage.currentToolStartedAt ? liveStage.currentToolStartedAt : '',
        liveStage && liveStage.currentToolInferred ? 'inferred' : 'direct',
        privacyLabel,
        sessionInfo.sessionPath,
        sessionInfo.sessionName,
        sessionInfo.canExport ? 'exportable' : 'locked',
        traceSignature,
      ].join('\u001f');

      if (card.dataset.renderSignature === signature) {
        return;
      }

      card.dataset.messageId = message.id;
      card.dataset.renderSignature = signature;
      card.className = `message-card ${message.role}`;
      card.classList.toggle('failed', message.status === 'failed');

      if (agent && agent.accentColor) {
        card.style.setProperty('--agent-color', agent.accentColor);
      } else {
        card.style.removeProperty('--agent-color');
      }

      const sender = card.querySelector('.message-sender');
      const time = card.querySelector('.message-time');
      const body = card.querySelector('.message-body');
      const liveHint = card.querySelector('.message-live-hint');
      const toolTrace = card.querySelector('.message-tool-trace');

      sender.textContent = '';

      if (message.role !== 'user' && agent) {
        sender.appendChild(buildAgentAvatarElement(agent, 'tiny'));

        if (message.role === 'assistant') {
          const exportButton = document.createElement('button');
          exportButton.type = 'button';
          exportButton.className = 'message-export-button ghost-button';
          exportButton.dataset.messageId = message.id;
          exportButton.disabled = !sessionInfo.canExport;
          exportButton.textContent = '\u5bfc\u51fa';
          exportButton.title = sessionInfo.canExport
            ? '\u5bfc\u51fa\u8fd9\u6761 AI \u6d88\u606f\u7684\u4f1a\u8bdd\u8f68\u8ff9'
            : '\u8fd9\u6761\u6d88\u606f\u7684\u4f1a\u8bdd\u8f68\u8ff9\u6682\u65f6\u4e0d\u53ef\u5bfc\u51fa';
          sender.appendChild(exportButton);

          const recordButton = document.createElement('button');
          recordButton.type = 'button';
          recordButton.className = 'message-export-button ghost-button message-record-button';
          recordButton.dataset.messageId = message.id;
          const terminalStatus = !message.status || message.status === 'completed' || message.status === 'failed';
          const canRecord = Boolean(message.taskId) && terminalStatus;
          recordButton.disabled = !canRecord;
          recordButton.textContent = '\u8bb0\u5f55';
          recordButton.title = message.taskId
            ? '\u8bb0\u5f55\u8fd9\u6761 AI \u56de\u590d\u7684\u8f93\u5165 prompt/\u4e0a\u4e0b\u6587\uff0c\u7528\u4e8e\u9519\u9898\u672c A/B \u6d4b\u8bd5'
            : '\u8fd9\u6761\u6d88\u606f\u6682\u65f6\u6ca1\u6709 taskId\uff0c\u65e0\u6cd5\u8bb0\u5f55';
          if (message.taskId && !terminalStatus) {
            recordButton.title =
              '\u8be5\u6761 AI \u6d88\u606f\u8fd8\u672a\u5b8c\u6210\uff0c\u8bf7\u7b49\u5f85\u5b8c\u6210\u540e\u518d\u8bb0\u5f55';
          }
          sender.appendChild(recordButton);
        }
      }

      const senderLabel = document.createElement('span');
      senderLabel.className = 'message-sender-label';
      senderLabel.textContent = message.role === 'user' ? 'You' : message.senderName;
      sender.appendChild(senderLabel);

      if (isPrivateTimelineMessage(message)) {
        const privacyBadge = document.createElement('span');
        privacyBadge.className = 'message-privacy-badge';
        privacyBadge.textContent = privacyLabel;
        sender.appendChild(privacyBadge);
      }

      time.textContent = formatDateTime(message.createdAt);
      renderMessageBody(body, bodyText, agents);
      syncToolTraceSection(toolTrace, message, liveStage);

      if (liveHint) {
        const shouldShowLiveHint = Boolean(liveLabel);
        liveHint.textContent = '';

        if (shouldShowLiveHint) {
          liveHint.classList.add('is-live');
          appendLiveToolRotor(liveHint, liveLabel);
        } else {
          liveHint.classList.remove('is-live');
        }

        liveHint.classList.toggle('hidden', !shouldShowLiveHint);
      }

      card.classList.toggle('live-preview', Boolean(liveLabel));
      card.classList.toggle('streaming', liveStage ? liveStage.status === 'running' : message.status === 'streaming');
      card.classList.toggle('queued', liveStage ? liveStage.status === 'queued' : message.status === 'queued');
      card.classList.toggle('terminating', liveStage ? liveStage.status === 'terminating' : false);
    }

    function render(conversation, activeTurn, activeAgentSlots = []) {
      const messages = timelineMessagesForConversation(conversation);
      const hasMessages = messages.length > 0;

      if (!hasMessages) {
        if (dom.messageList.childElementCount === 1 && dom.messageList.firstElementChild.classList.contains('empty-state')) {
          return;
        }

        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent =
          conversation && (conversation.type === 'who_is_undercover' || conversation.type === 'werewolf')
            ? '\u5f00\u59cb\u65b0\u4e00\u5c40\u540e\uff0c\u540e\u7aef\u4f1a\u81ea\u52a8\u63a8\u8fdb\u6574\u5c40\u5bf9\u8bdd\u3002'
            : '\u53d1\u9001\u4e00\u6761\u6d88\u606f\uff0c\u5f00\u59cb\u591a\u4eba\u683c\u8ba8\u8bba\u3002';
        dom.messageList.replaceChildren(empty);
        return;
      }

      const existingCards = Array.from(dom.messageList.querySelectorAll('.message-card'));
      const hasOnlyMessageCards = existingCards.length === dom.messageList.childElementCount;
      const matchesExistingPrefix =
        hasOnlyMessageCards &&
        existingCards.every((card, index) => card.dataset.messageId === (messages[index] ? messages[index].id : undefined));

      if (matchesExistingPrefix && existingCards.length === messages.length) {
        existingCards.forEach((card, index) => {
          syncMessageCard(card, messages[index], conversation.id, conversation.agents, activeTurn, activeAgentSlots);
        });
        return;
      }

      if (matchesExistingPrefix && existingCards.length < messages.length) {
        existingCards.forEach((card, index) => {
          syncMessageCard(card, messages[index], conversation.id, conversation.agents, activeTurn, activeAgentSlots);
        });

        messages.slice(existingCards.length).forEach((message) => {
          dom.messageList.appendChild(createMessageCard(message, conversation.id, conversation.agents, activeTurn, activeAgentSlots));
        });
        return;
      }

      const fragment = document.createDocumentFragment();
      messages.forEach((message) => {
        fragment.appendChild(createMessageCard(message, conversation.id, conversation.agents, activeTurn, activeAgentSlots));
      });
      dom.messageList.replaceChildren(fragment);
    }

    return {
      render,
    };
  };
})();
