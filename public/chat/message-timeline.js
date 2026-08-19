// @ts-check

(function registerMessageTimelineModule() {
  const chat = window.CaffChat || (window.CaffChat = {});
  const shared = window.CaffShared || {};
  const digestUtils = shared.conversationDigest;
  const crossConversationUi = chat.crossConversationUi;
  const messageImages = chat.messageImages;

  if (!crossConversationUi) {
    throw new Error('CaffChat.crossConversationUi helper is required');
  }

  if (!messageImages) {
    throw new Error('CaffChat.messageImages helper is required');
  }

  chat.createMessageTimelineRenderer = function createMessageTimelineRenderer({ dom, helpers, showToast }) {
    const {
      agentById,
      buildAgentAvatarElement,
      canInspectToolTrace,
      conversationSummaries,
      crossConversationBundleForMessage,
      displayedMessageBody,
      digestStatusForConversation,
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

    function normalizeTokenCount(value) {
      if (value === null || value === undefined || value === '') {
        return null;
      }

      const count = Number(value);

      if (!Number.isFinite(count) || count < 0) {
        return null;
      }

      return Math.round(count);
    }

    function normalizeCostAmount(value) {
      if (value === null || value === undefined || value === '') {
        return null;
      }

      const amount = Number(value);

      if (!Number.isFinite(amount) || amount < 0) {
        return null;
      }

      return amount;
    }

    function pickTokenCount(usage, keys) {
      if (!usage || typeof usage !== 'object') {
        return null;
      }

      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(usage, key)) {
          const count = normalizeTokenCount(usage[key]);

          if (count !== null) {
            return count;
          }
        }
      }

      return null;
    }

    function pickCostAmount(cost, keys) {
      if (!cost || typeof cost !== 'object') {
        return null;
      }

      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(cost, key)) {
          const amount = normalizeCostAmount(cost[key]);

          if (amount !== null) {
            return amount;
          }
        }
      }

      return null;
    }

    function messageTokenUsage(message) {
      if (!message || message.role !== 'assistant') {
        return null;
      }

      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      const normalizedUsage = metadata && metadata.tokenUsage && typeof metadata.tokenUsage === 'object' && !Array.isArray(metadata.tokenUsage)
        ? metadata.tokenUsage
        : null;
      const rawUsage = metadata && metadata.usage && typeof metadata.usage === 'object' && !Array.isArray(metadata.usage)
        ? metadata.usage
        : null;

      if (!normalizedUsage && !rawUsage) {
        return null;
      }

      const usageSources = [normalizedUsage, rawUsage].filter(Boolean);
      const rawOnlySources = [rawUsage].filter(Boolean);
      const outputTokens = pickTokenCountFromSources(usageSources, [
        'outputTokens',
        'output_tokens',
        'completionTokens',
        'completion_tokens',
        'completion',
        'output',
      ]);
      const cacheReadTokens = pickTokenCountFromSources(usageSources, [
        'cacheReadTokens',
        'cache_read_tokens',
        'cacheRead',
        'cache_read',
        'cachedTokens',
        'cached_tokens',
      ]);
      const cacheWriteTokens = pickTokenCountFromSources(usageSources, [
        'cacheWriteTokens',
        'cache_write_tokens',
        'cacheWrite',
        'cache_write',
        'cacheCreationTokens',
        'cache_creation_tokens',
        'cache_creation_input_tokens',
      ]);
      const normalizedInputTokens = pickTokenCountFromSources([normalizedUsage].filter(Boolean), ['inputTokens', 'input_tokens']);
      const uncachedInputTokens = pickTokenCountFromSources(usageSources, [
        'uncachedInputTokens',
        'uncached_input_tokens',
      ]) ?? pickTokenCountFromSources(rawOnlySources, [
        'inputTokens',
        'input_tokens',
        'promptTokens',
        'prompt_tokens',
        'prompt',
        'input',
      ]) ?? (cacheReadTokens === null && cacheWriteTokens === null ? normalizedInputTokens : null);
      const inputTokens = uncachedInputTokens !== null
        ? uncachedInputTokens + (cacheReadTokens || 0) + (cacheWriteTokens || 0)
        : normalizedInputTokens;
      const explicitTotalTokens = pickTokenCountFromSources(usageSources, ['totalTokens', 'total_tokens', 'total']);
      const totalTokens = explicitTotalTokens !== null
        ? explicitTotalTokens
        : inputTokens !== null || outputTokens !== null
          ? (inputTokens || 0) + (outputTokens || 0)
          : null;
      const costSources = [normalizedUsage, rawUsage && rawUsage.cost].filter(Boolean);
      const inputCostUsd = pickCostAmountFromSources(costSources, ['inputUsd', 'inputUSD', 'inputCostUsd', 'input_cost_usd', 'inputCost', 'input_cost', 'input']);
      const outputCostUsd = pickCostAmountFromSources(costSources, ['outputUsd', 'outputUSD', 'outputCostUsd', 'output_cost_usd', 'outputCost', 'output_cost', 'output']);
      const cacheReadCostUsd = pickCostAmountFromSources(costSources, ['cacheReadUsd', 'cacheReadUSD', 'cacheReadCostUsd', 'cache_read_cost_usd', 'cacheReadCost', 'cache_read_cost', 'cacheRead', 'cache_read']);
      const cacheWriteCostUsd = pickCostAmountFromSources(costSources, ['cacheWriteUsd', 'cacheWriteUSD', 'cacheWriteCostUsd', 'cache_write_cost_usd', 'cacheWriteCost', 'cache_write_cost', 'cacheWrite', 'cache_write']);
      const explicitTotalCostUsd = pickCostAmountFromSources(costSources, ['totalUsd', 'totalUSD', 'totalCostUsd', 'total_cost_usd', 'totalCost', 'total_cost', 'total']);
      const totalCostUsd = explicitTotalCostUsd !== null
        ? explicitTotalCostUsd
        : inputCostUsd !== null || outputCostUsd !== null || cacheReadCostUsd !== null || cacheWriteCostUsd !== null
          ? (inputCostUsd || 0) + (outputCostUsd || 0) + (cacheReadCostUsd || 0) + (cacheWriteCostUsd || 0)
          : null;

      if (inputTokens === null && outputTokens === null && totalTokens === null && cacheReadTokens === null && cacheWriteTokens === null && totalCostUsd === null) {
        return null;
      }

      const modelUsageSummary = metadata && metadata.modelUsage && metadata.modelUsage.modelCallCount !== undefined
        ? metadata.modelUsage
        : null;
      const modelCallCount = modelUsageSummary && Number.isFinite(Number(modelUsageSummary.modelCallCount))
        ? Number(modelUsageSummary.modelCallCount)
        : null;
      const coldStartModelCallCount = modelUsageSummary && Number.isFinite(Number(modelUsageSummary.coldStartModelCallCount))
        ? Number(modelUsageSummary.coldStartModelCallCount)
        : null;
      const postColdModelCallCount = modelUsageSummary && Number.isFinite(Number(modelUsageSummary.postColdModelCallCount))
        ? Number(modelUsageSummary.postColdModelCallCount)
        : null;
      const providerMissCount = modelUsageSummary && Number.isFinite(Number(modelUsageSummary.providerMissCount))
        ? Number(modelUsageSummary.providerMissCount)
        : null;

      return {
        inputTokens,
        uncachedInputTokens,
        outputTokens,
        totalTokens,
        cacheReadTokens,
        cacheWriteTokens,
        inputCostUsd,
        outputCostUsd,
        cacheReadCostUsd,
        cacheWriteCostUsd,
        totalCostUsd,
        modelCallCount,
        coldStartModelCallCount,
        postColdModelCallCount,
        providerMissCount,
      };
    }

    function pickTokenCountFromSources(sources, keys) {
      for (const source of sources) {
        const count = pickTokenCount(source, keys);

        if (count !== null) {
          return count;
        }
      }

      return null;
    }

    function pickCostAmountFromSources(sources, keys) {
      for (const source of sources) {
        const amount = pickCostAmount(source, keys);

        if (amount !== null) {
          return amount;
        }
      }

      return null;
    }

    function formatTokenCount(count) {
      const value = Number(count || 0);

      if (!Number.isFinite(value) || value < 0) {
        return '';
      }

      if (value < 1000) {
        return String(Math.round(value));
      }

      if (value < 1000000) {
        return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
      }

      return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}m`;
    }

    function formatUsdCost(amount) {
      const value = Number(amount || 0);

      if (!Number.isFinite(value) || value <= 0) {
        return '';
      }

      return `$${value < 0.0001 ? value.toFixed(6) : value.toFixed(4)}`;
    }

    function formatTokenUsageRatio(numerator, denominator) {
      if (numerator === null || denominator === null || denominator <= 0) {
        return '';
      }

      return `${Math.round((numerator / denominator) * 100)}%`;
    }

    function formatTokenUsageLabel(usage) {
      if (!usage) {
        return '';
      }

      const primary = usage.totalTokens !== null ? usage.totalTokens : usage.outputTokens !== null ? usage.outputTokens : usage.inputTokens;
      const formatted = formatTokenCount(primary);
      const cost = formatUsdCost(usage.totalCostUsd);

      if (!formatted && !cost) {
        return '';
      }

      const parts = [];

      if (usage.modelCallCount !== null) {
        parts.push(`${usage.modelCallCount} 次模型调用`);
      }

      if (formatted) {
        parts.push(`消耗 ${formatted} token`);
      } else if (cost) {
        parts.push('花费');
      }

      if (cost) {
        parts.push(cost);
      }

      if (usage.cacheReadTokens !== null) {
        const cacheRead = formatTokenCount(usage.cacheReadTokens) || '0';
        const ratio = formatTokenUsageRatio(usage.cacheReadTokens, usage.totalTokens);
        parts.push(ratio ? `命中 ${cacheRead} (${ratio})` : `命中 ${cacheRead}`);
      }

      if (usage.providerMissCount !== null && usage.postColdModelCallCount !== null) {
        parts.push(`provider miss ${usage.providerMissCount}/${usage.postColdModelCallCount} 次模型调用`);
      }

      return parts.join(' · ');
    }

    function formatTokenUsageTitle(usage) {
      if (!usage) {
        return '';
      }

      const parts = [];

      if (usage.inputTokens !== null) {
        parts.push(`输入 ${formatTokenCount(usage.inputTokens)}`);
      }

      if (usage.uncachedInputTokens !== null && usage.cacheReadTokens !== null) {
        parts.push(`非缓存输入 ${formatTokenCount(usage.uncachedInputTokens)}`);
      }

      if (usage.outputTokens !== null) {
        parts.push(`输出 ${formatTokenCount(usage.outputTokens)}`);
      }

      if (usage.totalTokens !== null) {
        parts.push(`总计 ${formatTokenCount(usage.totalTokens)}`);
      }

      const totalCost = formatUsdCost(usage.totalCostUsd);

      if (totalCost) {
        parts.push(`花费 ${totalCost}`);
      }

      if (usage.cacheReadTokens !== null) {
        const ratio = formatTokenUsageRatio(usage.cacheReadTokens, usage.totalTokens);
        parts.push(`缓存命中 ${formatTokenCount(usage.cacheReadTokens)}${ratio ? ` (${ratio})` : ''}`);
      }

      if (usage.cacheWriteTokens !== null) {
        parts.push(`缓存写入 ${formatTokenCount(usage.cacheWriteTokens)}`);
      }

      if (usage.modelCallCount !== null && usage.providerMissCount !== null) {
        const coldStartCount = usage.coldStartModelCallCount !== null ? usage.coldStartModelCallCount : Math.max(usage.modelCallCount - (usage.postColdModelCallCount || 0), 0);
        parts.push(`模型调用 ${usage.modelCallCount} 次，冷启动 ${coldStartCount} 次，冷启动外 ${usage.postColdModelCallCount || 0} 次，provider miss ${usage.providerMissCount}`);
      }

      if (usage.inputCostUsd !== null || usage.outputCostUsd !== null || usage.cacheReadCostUsd !== null || usage.cacheWriteCostUsd !== null) {
        const costParts = [];

        if (usage.inputCostUsd !== null) {
          costParts.push(`输入 ${formatUsdCost(usage.inputCostUsd) || '$0.0000'}`);
        }

        if (usage.outputCostUsd !== null) {
          costParts.push(`输出 ${formatUsdCost(usage.outputCostUsd) || '$0.0000'}`);
        }

        if (usage.cacheReadCostUsd !== null) {
          costParts.push(`缓存读取 ${formatUsdCost(usage.cacheReadCostUsd) || '$0.0000'}`);
        }

        if (usage.cacheWriteCostUsd !== null) {
          costParts.push(`缓存写入 ${formatUsdCost(usage.cacheWriteCostUsd) || '$0.0000'}`);
        }

        if (costParts.length > 0) {
          parts.push(`费用明细 ${costParts.join(' / ')}`);
        }
      }

      return parts.length > 0 ? parts.join(' · ') : '';
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

    function createCrossConversationAction(label, action, options = {}) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cross-conversation-action ghost-button';
      button.dataset.crossConversationAction = action;
      if (options.deliveryId) button.dataset.deliveryId = options.deliveryId;
      if (options.conversationId) button.dataset.conversationId = options.conversationId;
      button.textContent = label;
      return button;
    }

    function syncCrossConversationPanel(panel, message, bundle) {
      const summaries = typeof conversationSummaries === 'function' ? conversationSummaries() : [];
      const delivery = bundle && bundle.delivery ? bundle.delivery : null;
      const receipt = crossConversationUi.receiptModel(message, delivery, summaries);
      const provenance = crossConversationUi.provenanceModel(message, summaries);
      const birth = crossConversationUi.birthModel(message, summaries, delivery);
      panel.replaceChildren();
      panel.className = 'cross-conversation-panel hidden';

      if (receipt) {
        panel.className = 'cross-conversation-panel cross-conversation-receipt-panel';
        const summary = document.createElement('div');
        summary.className = 'cross-conversation-summary';
        const title = document.createElement('div');
        title.className = 'cross-conversation-title';
        const eyebrow = document.createElement('span');
        eyebrow.className = 'eyebrow';
        eyebrow.textContent = receipt.kindLabel;
        const target = document.createElement('strong');
        target.textContent = receipt.targetTitle || receipt.targetConversationId;
        title.append(eyebrow, target);
        const status = createTracePill(receipt.view.label, receipt.view.tone, { live: receipt.view.live });
        status.classList.add('cross-conversation-status');
        summary.append(title, status);
        panel.appendChild(summary);

        if (receipt.view.failed) {
          const error = document.createElement('p');
          error.className = 'cross-conversation-error';
          error.textContent = receipt.view.errorMessage || '投递没有完成，请检查目标 Agent 状态后重试。';
          panel.appendChild(error);
        }

        const actions = document.createElement('div');
        actions.className = 'cross-conversation-actions';
        if (receipt.view.canRetry) {
          actions.appendChild(createCrossConversationAction('重试', 'retry', { deliveryId: receipt.deliveryId }));
        }
        if (receipt.view.canCancel) {
          actions.appendChild(createCrossConversationAction('取消', 'cancel', { deliveryId: receipt.deliveryId }));
        }
        actions.appendChild(createCrossConversationAction('前往会话', 'jump', {
          deliveryId: receipt.deliveryId,
          conversationId: receipt.jumpConversationId,
        }));
        panel.appendChild(actions);
        return { receipt, provenance: null, birth: null };
      }

      if (provenance) {
        panel.className = 'cross-conversation-panel cross-conversation-provenance';
        const backlink = createCrossConversationAction(provenance.label, 'jump', {
          deliveryId: provenance.deliveryId,
          conversationId: provenance.backlinkConversationId,
        });
        backlink.classList.add('cross-conversation-backlink');
        const context = document.createElement('span');
        context.className = 'cross-conversation-context';
        context.textContent = [provenance.kindLabel, provenance.sourceAgentName].filter(Boolean).join(' · ');
        panel.append(backlink, context);
        return { receipt: null, provenance, birth: null };
      }

      if (birth) {
        panel.className = 'cross-conversation-panel cross-conversation-birth';
        const summary = document.createElement('div');
        summary.className = 'cross-conversation-summary';
        const text = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = `由 ${birth.sourceTitle} 派生`;
        const notice = document.createElement('p');
        notice.textContent = birth.notice;
        text.append(title, notice);
        const status = createTracePill(birth.view.label, birth.view.tone, { live: birth.view.live });
        status.classList.add('cross-conversation-status');
        summary.append(text, status);
        panel.appendChild(summary);
        if (birth.view.failed) {
          const error = document.createElement('p');
          error.className = 'cross-conversation-error';
          error.textContent = birth.view.errorMessage || '主理 Agent 没有启动，请检查可用性后重试。';
          panel.appendChild(error);
        }
        const actions = document.createElement('div');
        actions.className = 'cross-conversation-actions';
        if (birth.view.canRetry) {
          actions.appendChild(createCrossConversationAction('重试', 'retry', { deliveryId: birth.deliveryId }));
        }
        if (birth.view.canCancel) {
          actions.appendChild(createCrossConversationAction('取消', 'cancel', { deliveryId: birth.deliveryId }));
        }
        actions.appendChild(createCrossConversationAction('返回父会话', 'jump', {
          deliveryId: birth.deliveryId,
          conversationId: birth.backlinkConversationId,
        }));
        panel.appendChild(actions);
        return { receipt: null, provenance: null, birth };
      }

      return { receipt: null, provenance: null, birth: null };
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
      const timelineEvents = trace && Array.isArray(trace.timelineEvents) ? trace.timelineEvents : [];

      if (timelineEvents.length > 0) {
        return timelineEvents.length;
      }

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
      button.textContent = prominent ? (isOpen ? '收起观测时间线' : '展开观测时间线') : isOpen ? '收起观测时间线' : '查看观测时间线';
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

    function modelUsageCallsForTrace(trace) {
      return trace && Array.isArray(trace.modelUsageCalls)
        ? trace.modelUsageCalls.filter((call) => call && call.tokenUsage && typeof call.tokenUsage === 'object')
        : [];
    }

    function modelUsageSummaryForTrace(trace) {
      const calls = modelUsageCallsForTrace(trace);
      const primarySummary = trace && trace.modelUsageSummary && typeof trace.modelUsageSummary === 'object'
        ? trace.modelUsageSummary
        : null;
      const summaryFallback = trace && trace.summary && typeof trace.summary === 'object'
        ? trace.summary
        : null;
      const summaryFallbackHasCounts = summaryFallback && (
        Number(summaryFallback.modelCallCount) > 0 ||
        Number(summaryFallback.coldStartModelCallCount) > 0 ||
        Number(summaryFallback.postColdModelCallCount) > 0 ||
        Number(summaryFallback.providerMissCount) > 0
      );
      const explicitSummary = primarySummary || (summaryFallback && (summaryFallbackHasCounts || calls.length === 0) ? summaryFallback : null);

      if (explicitSummary) {
        const modelCallCount = Number(explicitSummary.modelCallCount);
        const coldStartModelCallCount = Number(explicitSummary.coldStartModelCallCount);
        const postColdModelCallCount = Number(explicitSummary.postColdModelCallCount);
        const providerMissCount = Number(explicitSummary.providerMissCount);

        return {
          modelCallCount: Number.isFinite(modelCallCount) ? modelCallCount : 0,
          coldStartModelCallCount: Number.isFinite(coldStartModelCallCount) ? coldStartModelCallCount : 0,
          postColdModelCallCount: Number.isFinite(postColdModelCallCount) ? postColdModelCallCount : 0,
          providerMissCount: Number.isFinite(providerMissCount) ? providerMissCount : 0,
        };
      }

      const coldStartModelCallCount = calls.filter((call) => call.isColdStart || call.coldStart).length;
      const postColdModelCallCount = calls.filter((call) => !(call.isColdStart || call.coldStart)).length;
      const providerMissCount = calls.filter((call) => call.providerMiss).length;

      return {
        modelCallCount: calls.length,
        coldStartModelCallCount,
        postColdModelCallCount,
        providerMissCount,
      };
    }

    function formatModelUsageCallBits(call) {
      const tokenUsage = call && call.tokenUsage ? call.tokenUsage : {};
      const bits = [];
      const inputTokens = normalizeTokenCount(tokenUsage.inputTokens);
      const uncachedInputTokens = normalizeTokenCount(tokenUsage.uncachedInputTokens);
      const outputTokens = normalizeTokenCount(tokenUsage.outputTokens);
      const totalTokens = normalizeTokenCount(tokenUsage.totalTokens);
      const cacheReadTokens = normalizeTokenCount(tokenUsage.cacheReadTokens);
      const cacheWriteTokens = normalizeTokenCount(tokenUsage.cacheWriteTokens);
      const totalCostUsd = normalizeCostAmount(tokenUsage.totalCostUsd);
      const hitRatio = cacheReadTokens !== null ? formatTokenUsageRatio(cacheReadTokens, totalTokens) : '';

      if (inputTokens !== null) {
        bits.push(`输入 ${formatTokenCount(inputTokens)}`);
      }

      if (uncachedInputTokens !== null) {
        bits.push(`非缓存 ${formatTokenCount(uncachedInputTokens)}`);
      }

      if (outputTokens !== null) {
        bits.push(`输出 ${formatTokenCount(outputTokens)}`);
      }

      if (cacheReadTokens !== null) {
        bits.push(`缓存读 ${formatTokenCount(cacheReadTokens)}${hitRatio ? ` / 命中率 ${hitRatio}` : ''}`);
      }

      if (cacheWriteTokens !== null && cacheWriteTokens > 0) {
        bits.push(`缓存写 ${formatTokenCount(cacheWriteTokens)}`);
      }

      if (totalCostUsd !== null) {
        bits.push(`花费 ${formatUsdCost(totalCostUsd) || '$0.0000'}`);
      }

      return bits;
    }

    function traceTimelineEventsForTrace(trace) {
      const explicitEvents = trace && Array.isArray(trace.timelineEvents)
        ? trace.timelineEvents.filter((event) => event && typeof event === 'object')
        : [];

      if (explicitEvents.length > 0) {
        return explicitEvents;
      }

      const normalizeSequence = (value) => {
        const sequence = Number(value);
        return Number.isFinite(sequence) && sequence > 0 ? Math.round(sequence) : null;
      };
      const traceSteps = trace && Array.isArray(trace.steps) ? trace.steps : [];
      const sessionSteps = trace && Array.isArray(trace.sessionToolCalls) ? trace.sessionToolCalls : [];
      const bridgeSteps = trace && Array.isArray(trace.bridgeToolEvents) ? trace.bridgeToolEvents : [];
      const toolSteps = traceSteps.length > 0 ? traceSteps : sessionSteps.concat(bridgeSteps);
      const toolEvents = toolSteps.map((step, index) => ({
        ...step,
        eventType: 'tool_execution',
        toolExecutionSequence: index + 1,
      }));
      const modelEvents = modelUsageCallsForTrace(trace).map((call, index) => {
        const sequence = normalizeSequence(call && call.sequence) || index + 1;
        return {
          ...call,
          eventType: 'model_call',
          stepId: `model-call-${sequence}`,
          modelCallSequence: sequence,
        };
      });

      if (modelEvents.length === 0) {
        return toolEvents.map((event, index) => ({ ...event, timelineIndex: index }));
      }

      const timelineEvents = [];
      const usedToolIndexes = new Set();

      modelEvents.forEach((modelEvent) => {
        const sequence = normalizeSequence(modelEvent.modelCallSequence);
        timelineEvents.push(modelEvent);
        toolEvents.forEach((toolEvent, index) => {
          if (usedToolIndexes.has(index) || normalizeSequence(toolEvent.modelCallSequence) !== sequence) {
            return;
          }

          usedToolIndexes.add(index);
          timelineEvents.push(toolEvent);
        });
      });

      toolEvents.forEach((toolEvent, index) => {
        if (!usedToolIndexes.has(index)) {
          timelineEvents.push(toolEvent);
        }
      });

      return timelineEvents.map((event, index) => ({ ...event, timelineIndex: index }));
    }

    function buildModelCallTraceStep(call, index, isLastStep) {
      const article = document.createElement('article');
      const rail = document.createElement('div');
      const indexBadge = document.createElement('span');
      const line = document.createElement('span');
      const content = document.createElement('div');
      const callHeader = document.createElement('div');
      const titleWrap = document.createElement('div');
      const eyebrow = document.createElement('div');
      const callTitle = document.createElement('div');
      const callMeta = document.createElement('div');
      const detail = document.createElement('div');
      const sequence = Number.isFinite(Number(call && call.sequence))
        ? Number(call.sequence)
        : Number.isFinite(Number(call && call.modelCallSequence))
          ? Number(call.modelCallSequence)
          : index + 1;
      const tokenUsage = call && call.tokenUsage ? call.tokenUsage : {};
      const isColdStart = Boolean(call && (call.coldStart || call.isColdStart));
      const tone = call && call.providerMiss ? 'failed' : isColdStart ? 'neutral' : 'success';
      const statusText = call && call.providerMiss ? 'provider miss' : isColdStart ? '冷启动' : '缓存命中';
      const stopReason = call && call.stopReason ? String(call.stopReason) : '';
      const bits = formatModelUsageCallBits(call);
      const outputTokens = normalizeTokenCount(tokenUsage.outputTokens);
      const cacheReadTokens = normalizeTokenCount(tokenUsage.cacheReadTokens);
      const totalCostUsd = normalizeCostAmount(tokenUsage.totalCostUsd);

      article.className = `message-tool-trace-step ${tone} model-call${isLastStep ? ' last' : ''}`;
      article.dataset.stepId = call && call.stepId ? String(call.stepId) : `model-call-${sequence}`;
      rail.className = 'message-tool-trace-step-rail';
      indexBadge.className = 'message-tool-trace-step-index';
      line.className = 'message-tool-trace-step-line';
      content.className = 'message-tool-trace-step-main';
      callHeader.className = 'message-tool-trace-step-header';
      titleWrap.className = 'message-tool-trace-step-title-wrap';
      eyebrow.className = 'message-tool-trace-step-eyebrow';
      callTitle.className = 'message-tool-trace-step-title';
      callMeta.className = 'message-tool-trace-step-meta';
      detail.className = 'message-tool-trace-note';

      indexBadge.textContent = String(index + 1);
      eyebrow.textContent = [`模型调用 #${sequence}`, stopReason ? `stop=${stopReason}` : ''].filter(Boolean).join(' · ');
      callTitle.textContent = statusText;
      callMeta.appendChild(createTracePill(statusText, tone));

      if (outputTokens !== null) {
        callMeta.appendChild(createTracePill(`输出 ${formatTokenCount(outputTokens)}`, 'neutral'));
      }

      if (cacheReadTokens !== null) {
        const ratio = formatTokenUsageRatio(cacheReadTokens, normalizeTokenCount(tokenUsage.totalTokens));
        callMeta.appendChild(createTracePill(`缓存读 ${formatTokenCount(cacheReadTokens)}${ratio ? ` (${ratio})` : ''}`, cacheReadTokens > 0 ? 'success' : 'failed'));
      }

      if (totalCostUsd !== null) {
        callMeta.appendChild(createTracePill(formatUsdCost(totalCostUsd) || '$0.0000', 'duration'));
      }

      detail.textContent = bits.length > 0 ? bits.join(' · ') : '该次模型调用没有可展示的 token 用量。';
      titleWrap.append(eyebrow, callTitle);
      callHeader.append(titleWrap, callMeta);
      rail.append(indexBadge, line);
      content.append(callHeader, detail);
      article.append(rail, content);
      return article;
    }

    function buildTraceTimelineSection(trace, events) {
      const section = document.createElement('section');
      const header = document.createElement('div');
      const title = document.createElement('div');
      const meta = document.createElement('div');
      const timeline = document.createElement('div');
      const summary = trace && trace.summary ? trace.summary : null;
      const modelSummary = modelUsageSummaryForTrace(trace);
      const toolExecutionCount = summary && Number.isFinite(Number(summary.toolExecutionCount))
        ? Number(summary.toolExecutionCount)
        : events.filter((event) => event && event.eventType !== 'model_call').length;
      const failedCount = events.filter((event) => event && event.eventType !== 'model_call' && event.status === 'failed').length;
      const hasRunning = events.some((event) => event && event.eventType !== 'model_call' && (event.status === 'running' || event.status === 'queued'));
      const missCount = Number(modelSummary.providerMissCount || 0);

      section.className = 'message-tool-trace-section';
      header.className = 'message-tool-trace-section-header';
      title.className = 'message-tool-trace-section-title';
      meta.className = 'message-tool-trace-section-meta';
      timeline.className = 'message-tool-trace-section-steps';
      title.textContent = '本次回复观测时间线';

      if (modelSummary.modelCallCount > 0) {
        meta.appendChild(createTracePill(`${modelSummary.modelCallCount} 次模型调用`, 'neutral'));
      }

      meta.appendChild(createTracePill(`${toolExecutionCount} 次工具执行`, 'neutral'));

      if (modelSummary.postColdModelCallCount > 0) {
        meta.appendChild(createTracePill(`provider miss ${missCount}/${modelSummary.postColdModelCallCount} 次模型调用`, missCount > 0 ? 'failed' : 'success'));
      }

      if (failedCount > 0) {
        meta.appendChild(createTracePill(`${failedCount} 工具失败`, 'failed'));
      } else if (hasRunning) {
        meta.appendChild(createTracePill('工具进行中', 'running', { live: true }));
      }

      events.forEach((event, eventIndex) => {
        if (event && event.eventType === 'model_call') {
          timeline.appendChild(buildModelCallTraceStep(event, eventIndex, eventIndex === events.length - 1));
          return;
        }

        timeline.appendChild(buildTraceStep(event, eventIndex, eventIndex === events.length - 1));
      });

      header.append(title, meta);
      section.append(header, timeline);
      return section;
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
      const toolExecutionSequence = Number.isFinite(Number(step && step.toolExecutionSequence)) ? Number(step.toolExecutionSequence) : null;
      const modelCallSequence = Number.isFinite(Number(step && step.modelCallSequence)) ? Number(step.modelCallSequence) : null;
      const stepLeadParts = [toolExecutionSequence ? `工具执行 #${toolExecutionSequence}` : '', traceSourceLabel(step)].filter(Boolean);
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

      if (modelCallSequence) {
        meta.appendChild(createTracePill(`由模型调用 #${modelCallSequence} 触发`, 'neutral'));
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
      const traceTimelineEvents = traceTimelineEventsForTrace(trace);
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
        if (summary.modelCallCount > 0) {
          summaryWrap.appendChild(createTracePill(`模型调用 ${summary.modelCallCount} 次`, 'neutral'));
        }

        summaryWrap.appendChild(createTracePill(`工具执行 ${summary.toolExecutionCount || summary.totalSteps || 0} 次`, 'neutral'));
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

        if (summary.postColdModelCallCount > 0) {
          const missCount = Number(summary.providerMissCount || 0);
          summaryWrap.appendChild(createTracePill(`provider miss ${missCount}/${summary.postColdModelCallCount} 次模型调用`, missCount > 0 ? 'failed' : 'success'));
        }
      } else if (traceState.status === 'loading') {
        summaryWrap.appendChild(createTracePill('载入观测时间线中', 'running'));
      } else if (traceState.status === 'error') {
        summaryWrap.appendChild(createTracePill(traceState.errorMessage || '观测时间线加载失败', 'failed'));
      } else if (message.status === 'queued' || message.status === 'streaming') {
        summaryWrap.appendChild(createTracePill('等待观测时间线', 'running'));
      } else {
        summaryWrap.appendChild(createTracePill('暂无观测记录', 'neutral'));
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
          loading.textContent = '正在整理这条回复背后的观测时间线…';
          details.appendChild(loading);
        } else if (traceState.status === 'error' && !trace) {
          const error = document.createElement('div');
          const errorRow = document.createElement('div');
          error.className = 'message-tool-trace-note failed';
          error.textContent = traceState.errorMessage || '观测时间线加载失败';
          errorRow.className = 'message-tool-trace-note-row';
          errorRow.append(error, buildTraceCopyButton(message.id));
          details.appendChild(errorRow);
        } else {
          const activityNote = buildTraceActivityNote(trace, liveStage);
          const failureNote = buildTraceFailureNote(trace);
          const stepsViewport = document.createElement('div');
          const shouldScrollSteps = traceStepCount(trace) > TRACE_SCROLL_STEP_LIMIT;

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

          if (traceTimelineEvents.length > 0) {
            stepsViewport.appendChild(buildTraceTimelineSection(trace, traceTimelineEvents));
          }

          if (traceTimelineEvents.length === 0) {
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

    function digestSectionItems(value) {
      return digestUtils && typeof digestUtils.sectionItems === 'function' ? digestUtils.sectionItems(value) : [];
    }

    function digestMessageRangeText(digest) {
      return digestUtils && typeof digestUtils.messageRangeText === 'function' ? digestUtils.messageRangeText(digest) : '';
    }

    const digestSourceLocator = digestUtils.createDigestSourceLocator({ dom, showToast });

    function appendDigestResultSection(container, label, items) {
      const normalizedItems = digestSectionItems(items);

      if (normalizedItems.length === 0) {
        return;
      }

      const title = document.createElement('h3');
      title.className = 'conversation-digest-section-title';
      title.textContent = label;

      const list = document.createElement('ul');
      list.className = 'conversation-digest-section-list';

      for (const item of normalizedItems) {
        const row = document.createElement('li');
        row.textContent = item;
        list.appendChild(row);
      }

      container.append(title, list);
    }

    function syncDigestResultBody(container, digest) {
      container.textContent = '';
      container.classList.remove('plain-text');

      const card = document.createElement('article');
      const header = document.createElement('div');
      const titleWrap = document.createElement('div');
      const eyebrow = document.createElement('p');
      const range = document.createElement('p');
      const kindHelp = document.createElement('p');
      const provenance = document.createElement('p');
      const actions = document.createElement('div');
      const locateButton = document.createElement('button');
      const summary = document.createElement('p');
      const kindLabel = digestUtils.digestKindLabel(digest);
      const sourceCount = digest && digest.kind === 'rollup' && Array.isArray(digest.sourceDigestIds) ? digest.sourceDigestIds.length : 0;
      const sourceText = sourceCount > 0 ? ` · 来自 ${sourceCount} 条详细摘要` : '';
      const provenanceParts = [];

      card.className = 'conversation-digest-card timeline-digest-card';
      header.className = 'conversation-digest-card-header';
      eyebrow.className = 'eyebrow';
      range.className = 'muted';
      kindHelp.className = 'muted tiny-meta';
      provenance.className = 'muted tiny-meta';
      actions.className = 'conversation-digest-card-actions';
      locateButton.className = 'secondary-button compact-icon-button';
      locateButton.type = 'button';
      locateButton.textContent = '定位首条';
      locateButton.disabled = !String(digest && digest.messageRange && digest.messageRange.fromMessageId || '').trim();
      locateButton.title = locateButton.disabled
        ? '这条摘要暂时没有可定位的首条消息'
        : '滚动到这条摘要覆盖范围的第一条消息';
      locateButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        digestSourceLocator.focusSourceMessage(digest);
      });

      eyebrow.textContent = `${kindLabel}完成`;
      kindHelp.textContent = digestUtils.digestKindHelp(digest);
      range.textContent = `${digestMessageRangeText(digest) || (digest && digest.id) || 'Digest'}${sourceText}`;

      if (digest && digest.triggerReason) {
        provenanceParts.push(`触发：${digest.triggerReason}`);
      }
      if (digest && digest.createdBy) {
        provenanceParts.push(`来源：${digest.createdBy}`);
      }
      provenance.textContent = provenanceParts.join(' · ');

      titleWrap.append(eyebrow, range, kindHelp);
      if (provenanceParts.length > 0) {
        titleWrap.appendChild(provenance);
      }
      actions.appendChild(locateButton);
      header.append(titleWrap, actions);

      summary.className = 'conversation-digest-summary';
      summary.textContent = String(digest && digest.summary || '').trim();

      card.append(header, summary);
      appendDigestResultSection(card, '决策', digest && digest.decisions);
      appendDigestResultSection(card, '事实', digest && digest.facts);
      appendDigestResultSection(card, '未解决问题', digest && digest.openQuestions);
      appendDigestResultSection(card, '下一步', digest && digest.nextActions);
      appendDigestResultSection(card, '产物', digest && digest.artifacts);
      container.appendChild(card);
    }

    function createMessageCard(message, conversationId, agents, activeTurn, activeAgentSlots) {
      const card = document.createElement('article');
      const meta = document.createElement('div');
      const sender = document.createElement('span');
      const time = document.createElement('span');
      const body = document.createElement('div');
      const crossConversationPanel = document.createElement('div');
      const liveHint = document.createElement('div');
      const toolTrace = document.createElement('section');
      const imageGallery = document.createElement('div');

      meta.className = 'message-meta';
      sender.className = 'message-sender';
      time.className = 'message-time';
      body.className = 'message-body';
      crossConversationPanel.className = 'cross-conversation-panel hidden';
      liveHint.className = 'message-live-hint hidden';
      toolTrace.className = 'message-tool-trace hidden';
      imageGallery.className = 'message-images';
      imageGallery.hidden = true;

      meta.append(sender, time);
      card.append(meta, crossConversationPanel, toolTrace, imageGallery, body, liveHint);
      syncMessageCard(card, message, conversationId, agents, activeTurn, activeAgentSlots);

      return card;
    }

    function syncMessageCard(card, message, conversationId, agents, activeTurn, activeAgentSlots) {
      const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      const digestResult = metadata && metadata.digestResult && typeof metadata.digestResult === 'object' ? metadata.digestResult : null;
      const isDigestStatusMessage = Boolean(metadata && metadata.digestStatus);
      const isDigestResultMessage = Boolean(digestResult);
      const agent = message.agentId
        ? (Array.isArray(agents) ? agents.find((item) => item.id === message.agentId) : null) || agentById(message.agentId)
        : null;
      const liveStage = isPrivateTimelineMessage(message) || isDigestStatusMessage || isDigestResultMessage
        ? null
        : liveStageForMessage(conversationId || (message && message.conversationId) || '', activeTurn, activeAgentSlots, message.id);
      const liveLabel = isDigestStatusMessage ? '摘要整理中' : liveStageLabel(liveStage);
      const bodyText = displayedMessageBody(message, liveStage);
      const sessionInfo = messageSessionInfo(message);
      const contextSnapshot = metadata && metadata.agentContextSnapshot && typeof metadata.agentContextSnapshot === 'object'
        ? metadata.agentContextSnapshot
        : null;
      const tokenUsage = messageTokenUsage(message);
      const crossConversationBundle = typeof crossConversationBundleForMessage === 'function'
        ? crossConversationBundleForMessage(message)
        : null;
      const crossConversationDelivery = crossConversationBundle && crossConversationBundle.delivery
        ? crossConversationBundle.delivery
        : null;
      const tokenUsageLabel = formatTokenUsageLabel(tokenUsage);
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
        contextSnapshot && contextSnapshot.snapshotId ? contextSnapshot.snapshotId : '',
        tokenUsageLabel,
        tokenUsage && tokenUsage.inputTokens !== null ? tokenUsage.inputTokens : '',
        tokenUsage && tokenUsage.uncachedInputTokens !== null ? tokenUsage.uncachedInputTokens : '',
        tokenUsage && tokenUsage.outputTokens !== null ? tokenUsage.outputTokens : '',
        tokenUsage && tokenUsage.totalTokens !== null ? tokenUsage.totalTokens : '',
        tokenUsage && tokenUsage.cacheReadTokens !== null ? tokenUsage.cacheReadTokens : '',
        tokenUsage && tokenUsage.cacheWriteTokens !== null ? tokenUsage.cacheWriteTokens : '',
        tokenUsage && tokenUsage.totalCostUsd !== null ? tokenUsage.totalCostUsd : '',
        tokenUsage && tokenUsage.inputCostUsd !== null ? tokenUsage.inputCostUsd : '',
        tokenUsage && tokenUsage.outputCostUsd !== null ? tokenUsage.outputCostUsd : '',
        tokenUsage && tokenUsage.cacheReadCostUsd !== null ? tokenUsage.cacheReadCostUsd : '',
        tokenUsage && tokenUsage.cacheWriteCostUsd !== null ? tokenUsage.cacheWriteCostUsd : '',
        digestResult ? JSON.stringify(digestResult) : '',
        metadata && metadata.crossConversation ? JSON.stringify(metadata.crossConversation) : '',
        crossConversationDelivery ? JSON.stringify([
          crossConversationDelivery.id,
          crossConversationDelivery.messageStatus,
          crossConversationDelivery.dispatchStatus,
          crossConversationDelivery.responseStatus,
          crossConversationDelivery.lastErrorCode,
          crossConversationDelivery.lastErrorMessage,
          crossConversationDelivery.updatedAt,
        ]) : '',
        messageImages.imageBlockSignature(message),
        traceSignature,
      ].join('\u001f');

      if (card.dataset.renderSignature === signature) {
        return;
      }

      card.dataset.messageId = message.id;
      card.dataset.renderSignature = signature;
      card.className = `message-card ${message.role}`;
      card.classList.toggle('failed', message.status === 'failed');
      card.classList.toggle('digest-status', isDigestStatusMessage);
      card.classList.toggle('digest-result', isDigestResultMessage);

      if (agent && agent.accentColor) {
        card.style.setProperty('--agent-color', agent.accentColor);
      } else {
        card.style.removeProperty('--agent-color');
      }

      const sender = card.querySelector('.message-sender');
      const time = card.querySelector('.message-time');
      const body = card.querySelector('.message-body');
      const crossConversationPanel = card.querySelector('.cross-conversation-panel');
      const liveHint = card.querySelector('.message-live-hint');
      const toolTrace = card.querySelector('.message-tool-trace');
      const imageGallery = card.querySelector('.message-images');

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

          const contextButton = document.createElement('button');
          contextButton.type = 'button';
          contextButton.className = 'message-context-button ghost-button';
          contextButton.dataset.messageId = message.id;
          contextButton.disabled = !contextSnapshot;
          contextButton.textContent = '\u4e0a\u4e0b\u6587';
          contextButton.title = contextSnapshot
            ? '\u67e5\u770b\u8fd9\u4e2a Agent turn \u5b9e\u9645\u6ce8\u5165\u7684\u4e0a\u4e0b\u6587\u5206\u533a'
            : '\u8fd9\u6761\u6d88\u606f\u6682\u65e0\u4e0a\u4e0b\u6587\u5feb\u7167';
          sender.appendChild(contextButton);
        }
      }

      const senderLabel = document.createElement('span');
      senderLabel.className = 'message-sender-label';
      senderLabel.textContent = message.role === 'user'
        ? metadata && metadata.goalAutoContinue
          ? message.senderName || 'Goal Runner'
          : 'You'
        : message.senderName;
      sender.appendChild(senderLabel);

      if (isPrivateTimelineMessage(message)) {
        const privacyBadge = document.createElement('span');
        privacyBadge.className = 'message-privacy-badge';
        privacyBadge.textContent = privacyLabel;
        sender.appendChild(privacyBadge);
      }

      time.textContent = '';

      const crossConversationModels = syncCrossConversationPanel(
        crossConversationPanel,
        message,
        crossConversationBundle
      );
      card.classList.toggle('cross-conversation-receipt', Boolean(crossConversationModels.receipt));
      card.classList.toggle('cross-conversation-provenance-message', Boolean(crossConversationModels.provenance));
      card.classList.toggle('conversation-spawn-birth', Boolean(crossConversationModels.birth));

      const timestampLabel = document.createElement('span');
      timestampLabel.textContent = formatDateTime(message.createdAt);
      time.appendChild(timestampLabel);

      if (tokenUsageLabel) {
        const tokenBadge = document.createElement('span');
        tokenBadge.className = 'message-token-usage';
        tokenBadge.textContent = tokenUsageLabel;
        tokenBadge.title = formatTokenUsageTitle(tokenUsage);
        time.appendChild(tokenBadge);
      }

      body.classList.toggle('digest-result-body', isDigestResultMessage);
      body.classList.toggle('hidden', Boolean(crossConversationModels.receipt));
      messageImages.syncMessageImages(imageGallery, message);
      imageGallery.hidden = imageGallery.hidden || Boolean(crossConversationModels.receipt) || isDigestResultMessage;
      if (isDigestResultMessage) {
        syncDigestResultBody(body, digestResult);
      } else {
        renderMessageBody(body, bodyText, agents);
      }
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

    function clipDigestStatusPreview(value, maxLength = 900) {
      const text = String(value || '').trim();

      if (text.length <= maxLength) {
        return text;
      }

      return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
    }

    function digestStatusTimelineContent(status) {
      const pendingCount = Math.max(0, Number(status.pendingExperienceDraftCount || 0));
      const countSuffix = pendingCount > 0 ? `（${pendingCount} 条经验草稿）` : '';
      const lines = [`${status.message || '正在整理本轮经验，并写入会话摘要…'}${countSuffix}`];
      const model = status.model && typeof status.model === 'object' ? status.model : null;
      const modelTrace = status.modelTrace && typeof status.modelTrace === 'object' ? status.modelTrace : null;

      if (model) {
        const label = model.label || [model.provider, model.model].filter(Boolean).join('/');
        const modelBits = [label, model.thinking ? `thinking=${model.thinking}` : ''].filter(Boolean);
        if (modelBits.length > 0) {
          lines.push('', `模型：${modelBits.join(' · ')}`);
        }
      }

      if (modelTrace) {
        const eventCount = Math.max(0, Number(modelTrace.eventCount || 0));
        if (eventCount > 0) {
          lines.push(`模型更新：${eventCount} 次`);
        }

        const thinkingPreview = clipDigestStatusPreview(modelTrace.thinkingPreview, 700);
        if (thinkingPreview) {
          lines.push('', '思考预览：', thinkingPreview);
        }

        const outputPreview = clipDigestStatusPreview(modelTrace.outputPreview, 900);
        if (outputPreview) {
          lines.push('', '输出预览：', outputPreview);
        }
      }

      return lines.join('\n');
    }

    function digestStatusTimelineMessage(conversation) {
      const status = conversation && typeof digestStatusForConversation === 'function'
        ? digestStatusForConversation(conversation.id)
        : null;

      if (!status || status.status !== 'running') {
        return null;
      }

      return {
        id: `digest-status:${conversation.id}`,
        role: 'system',
        senderName: '会话摘要',
        content: digestStatusTimelineContent(status),
        status: 'streaming',
        createdAt: status.updatedAt || new Date().toISOString(),
        metadata: {
          digestStatus: true,
        },
      };
    }

    function digestTimestamp(digest) {
      const timestamp = Date.parse(String(digest && (digest.updatedAt || digest.compactedAt || digest.createdAt) || ''));
      return Number.isFinite(timestamp) ? timestamp : 0;
    }

    function latestUpdatedDigestForConversation(conversation) {
      const digests = digestUtils && typeof digestUtils.digestsForConversation === 'function'
        ? digestUtils.digestsForConversation(conversation)
        : [];

      if (digests.length === 0) {
        return null;
      }

      return digests.reduce((latest, digest) => {
        if (!latest) {
          return digest;
        }

        return digestTimestamp(digest) >= digestTimestamp(latest) ? digest : latest;
      }, null);
    }

    function digestResultTimelineMessage(conversation) {
      const digest = latestUpdatedDigestForConversation(conversation);

      if (!digest || !digest.id) {
        return null;
      }

      const kindLabel = digestUtils.digestKindLabel(digest);

      return {
        id: `digest-result:${digest.id}`,
        role: 'system',
        senderName: '会话摘要',
        content: digest.summary,
        status: 'completed',
        createdAt: digest.updatedAt || digest.compactedAt || digest.createdAt,
        metadata: {
          digestResult: digest,
          digestResultKindLabel: kindLabel,
        },
      };
    }

    function timelineMessageTimestamp(message) {
      const timestamp = Date.parse(String(message && message.createdAt || ''));
      return Number.isFinite(timestamp) ? timestamp : 0;
    }

    function compareTimelineMessages(left, right) {
      const leftTime = timelineMessageTimestamp(left);
      const rightTime = timelineMessageTimestamp(right);

      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }

      const leftId = left && left.id ? String(left.id) : '';
      const rightId = right && right.id ? String(right.id) : '';
      return leftId.localeCompare(rightId);
    }

    function mergeDigestTimelineMessage(baseMessages, digestMessage) {
      if (!digestMessage) {
        return baseMessages;
      }

      return baseMessages.concat(digestMessage).sort(compareTimelineMessages);
    }

    function render(conversation, activeTurn, activeAgentSlots = []) {
      const messageContainer = dom.messageTimeline || dom.messageList;
      const baseMessages = timelineMessagesForConversation(conversation);
      const digestStatusMessage = digestStatusTimelineMessage(conversation);
      const digestResultMessage = digestStatusMessage ? null : digestResultTimelineMessage(conversation);
      const messages = mergeDigestTimelineMessage(baseMessages, digestStatusMessage || digestResultMessage);
      const hasMessages = messages.length > 0;

      if (!hasMessages) {
        if (messageContainer.childElementCount === 1 && messageContainer.firstElementChild.classList.contains('empty-state')) {
          return;
        }

        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '\u53d1\u9001\u4e00\u6761\u6d88\u606f\uff0c\u5f00\u59cb\u591a Agent \u534f\u4f5c\u3002';
        messageContainer.replaceChildren(empty);
        return;
      }

      const existingCards = Array.from(messageContainer.querySelectorAll('.message-card'));
      const hasOnlyMessageCards = existingCards.length === messageContainer.childElementCount;
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
          messageContainer.appendChild(createMessageCard(message, conversation.id, conversation.agents, activeTurn, activeAgentSlots));
        });
        return;
      }

      const fragment = document.createDocumentFragment();
      messages.forEach((message) => {
        fragment.appendChild(createMessageCard(message, conversation.id, conversation.agents, activeTurn, activeAgentSlots));
      });
      messageContainer.replaceChildren(fragment);
    }

    return {
      render,
    };
  };
})();
