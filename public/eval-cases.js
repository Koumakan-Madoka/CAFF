// @ts-check

const state = {
  cases: [],
  selectedCaseId: null,
  selectedCase: null,
  dirty: false,
  filters: {
    query: '',
    status: 'all',
  },
};

const shared = window.CaffShared || {};
const fetchJson = shared.fetchJson;

const dom = {
  refreshButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('refresh-button')),
  runBatchButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('run-batch-button')),
  filterForm: /** @type {HTMLFormElement | null} */ (document.getElementById('filter-form')),
  searchInput: /** @type {HTMLInputElement | null} */ (document.getElementById('search-input')),
  statusFilter: /** @type {HTMLSelectElement | null} */ (document.getElementById('status-filter')),
  caseCount: /** @type {HTMLElement | null} */ (document.getElementById('case-count')),
  caseList: /** @type {HTMLDivElement | null} */ (document.getElementById('case-list')),
  editorTitle: /** @type {HTMLElement | null} */ (document.getElementById('editor-title')),
  editorMeta: /** @type {HTMLElement | null} */ (document.getElementById('editor-meta')),
  copyAToBButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-a-to-b-button')),
  copyPromptAButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-prompt-a-button')),
  copyPromptBButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-prompt-b-button')),
  copyOutputAButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-output-a-button')),
  copyOutputBButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-output-b-button')),
  saveButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('save-button')),
  runBButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('run-b-button')),
  noteInput: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('note-input')),
  caseMetrics: /** @type {HTMLElement | null} */ (document.getElementById('case-metrics')),
  promptA: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('prompt-a')),
  outputA: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('output-a')),
  promptB: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('prompt-b')),
  aMetrics: /** @type {HTMLElement | null} */ (document.getElementById('a-metrics')),
  aThinking: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('a-thinking')),
  aToolCalls: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('a-tool-calls')),
  aErrors: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('a-errors')),
  aToolEvents: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('a-tool-events')),
  aRawMessages: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('a-raw-messages')),
  copyAThinkingButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-a-thinking-button')),
  copyAToolCallsButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-a-tool-calls-button')),
  copyAErrorsButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-a-errors-button')),
  copyAToolEventsButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-a-tool-events-button')),
  copyARawMessagesButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-a-raw-messages-button')),
  bMeta: /** @type {HTMLElement | null} */ (document.getElementById('b-meta')),
  bMetrics: /** @type {HTMLElement | null} */ (document.getElementById('b-metrics')),
  outputB: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('output-b')),
  bPublicPosts: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('b-public-posts')),
  bPrivatePosts: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('b-private-posts')),
  bRawReply: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('b-raw-reply')),
  bThinking: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('b-thinking')),
  bToolCalls: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('b-tool-calls')),
  bErrors: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('b-errors')),
  bToolEvents: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('b-tool-events')),
  bRawMessages: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('b-raw-messages')),
  copyBPublicPostsButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-b-public-posts-button')),
  copyBPrivatePostsButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-b-private-posts-button')),
  copyBRawReplyButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-b-raw-reply-button')),
  copyBThinkingButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-b-thinking-button')),
  copyBToolCallsButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-b-tool-calls-button')),
  copyBErrorsButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-b-errors-button')),
  copyBToolEventsButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-b-tool-events-button')),
  copyBRawMessagesButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-b-raw-messages-button')),
  toast: /** @type {HTMLElement | null} */ (document.getElementById('toast')),
};

const toast =
  typeof shared.createToastController === 'function' ? shared.createToastController(dom.toast) : { show() {} };

function showToast(message) {
  toast.show(message);
}

function clipText(text, maxLength = 140) {
  const value = String(text || '').trim();

  if (!value) {
    return '';
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(value) : 'n/a';
}

function formatPercent(value, fractionDigits = 1) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return `${(value * 100).toFixed(fractionDigits)}%`;
}

function metricChip(label, value, hint = '', variant = '') {
  const chip = document.createElement('span');
  chip.className = `file-chip${variant ? ` ${variant}` : ''}`;
  chip.textContent = `${label}: ${value}`;
  if (hint) {
    chip.title = hint;
  }
  return chip;
}

function formatExpectation(value) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    return 'n/a';
  }

  if (normalized === 'required') {
    return '必需';
  }

  if (normalized === 'optional') {
    return '可选';
  }

  if (normalized === 'forbidden') {
    return '禁止';
  }

  return normalized;
}

function expectationsMap(item) {
  const expectations = item && item.expectations && typeof item.expectations === 'object' ? item.expectations : null;

  if (!expectations) {
    return null;
  }

  const map =
    expectations.expectations && typeof expectations.expectations === 'object' ? expectations.expectations : null;

  return map || null;
}

function evaluateAgainstExpectations(expMap, observed) {
  if (!expMap || !observed) {
    return { ok: null, violations: [] };
  }

  const violations = [];
  const expPublic = String(expMap['send-public'] || '').trim();
  const expPrivate = String(expMap['send-private'] || '').trim();
  const usedPublic = Boolean(observed.publicToolUsed);
  const usedPrivate = Number(observed.privatePostCount || 0) > 0;

  if (expPublic === 'required' && !usedPublic) {
    violations.push('miss send-public');
  } else if (expPublic === 'forbidden' && usedPublic) {
    violations.push('leak send-public');
  }

  if (expPrivate === 'required' && !usedPrivate) {
    violations.push('miss send-private');
  } else if (expPrivate === 'forbidden' && usedPrivate) {
    violations.push('unexpected send-private');
  }

  return { ok: violations.length === 0, violations };
}

function formatPosts(value) {
  const posts = Array.isArray(value) ? value : [];

  if (posts.length === 0) {
    return '';
  }

  return posts
    .map((item, index) => {
      const content = String(item || '');
      return `#${index + 1}\n${content}`;
    })
    .join('\n\n---\n\n');
}

function formatJson(value) {
  if (value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || '');
  }
}

function updateDirtyUi() {
  if (!dom.saveButton) {
    return;
  }

  dom.saveButton.textContent = state.dirty ? '保存*' : '保存';
}

function syncDirtyState() {
  const item = state.selectedCase;

  if (!item || !dom.promptB || !dom.noteInput) {
    state.dirty = false;
    updateDirtyUi();
    return;
  }

  const promptDirty = dom.promptB.value !== String(item.promptB || '');
  const noteDirty = dom.noteInput.value !== String(item.note || '');
  state.dirty = promptDirty || noteDirty;
  updateDirtyUi();
}

async function copyToClipboard(text) {
  const value = String(text || '');

  if (!value.trim()) {
    showToast('暂无内容可复制');
    return;
  }

  try {
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      showToast('已复制');
      return;
    }
  } catch {
    // ignore
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('已复制');
  } catch {
    showToast('复制失败');
  }
}

function filteredCaseList() {
  const query = String(state.filters.query || '').trim().toLowerCase();
  const status = String(state.filters.status || 'all').trim();

  return (Array.isArray(state.cases) ? state.cases : []).filter((item) => {
    if (!item) {
      return false;
    }

    const bStatus = item.b && item.b.status ? String(item.b.status).trim() : '';

    if (status === 'pending' && bStatus) {
      return false;
    }

    if (status === 'succeeded' && bStatus !== 'succeeded') {
      return false;
    }

    if (status === 'failed' && bStatus !== 'failed') {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = [
      item.id,
      item.agentId,
      item.agentName,
      item.note,
      item.provider,
      item.model,
      item.promptVersion,
      item.modelProfileId,
      item.conversationId,
      item.turnId,
      item.messageId,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(query);
  });
}

function ensureSelectedCase() {
  if (state.selectedCaseId && state.cases.some((item) => item && item.id === state.selectedCaseId)) {
    return;
  }

  state.selectedCaseId = state.cases[0] ? state.cases[0].id : null;
}

async function fetchCaseList() {
  if (typeof fetchJson !== 'function') {
    throw new Error('API client 未加载');
  }

  const payload = await fetchJson('/api/eval-cases');
  state.cases = Array.isArray(payload && payload.cases) ? payload.cases : [];
  ensureSelectedCase();
}

async function fetchSelectedCase() {
  if (!state.selectedCaseId) {
    state.selectedCase = null;
    return;
  }

  const payload = await fetchJson(`/api/eval-cases/${encodeURIComponent(state.selectedCaseId)}`);
  state.selectedCase = payload && payload.case ? payload.case : null;
}

async function refreshAll() {
  await fetchCaseList();
  await fetchSelectedCase();
}

function renderCaseList() {
  if (!dom.caseList) {
    return;
  }

  dom.caseList.innerHTML = '';

  const cases = filteredCaseList();

  if (dom.caseCount) {
    dom.caseCount.textContent = `${cases.length}/${state.cases.length} cases`;
  }

  if (state.cases.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact-empty-state';
    empty.textContent = '暂无记录。回到聊天工作台，在 AI 消息旁点击“记录”即可加入错题本。';
    dom.caseList.appendChild(empty);
    return;
  }

  if (cases.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact-empty-state';
    empty.textContent = '没有匹配的记录，尝试清空搜索或切换状态筛选。';
    dom.caseList.appendChild(empty);
    return;
  }

  cases.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'agent-list-item compact';
    row.dataset.id = item.id;
    row.classList.toggle('active', item.id === state.selectedCaseId);

    const left = document.createElement('div');
    left.style.display = 'grid';
    left.style.gap = '0.12rem';

    const title = document.createElement('strong');
    const agentLabel = item.agentName || item.agentId || 'Agent';
    title.textContent = agentLabel;

    const meta = document.createElement('div');
    meta.className = 'muted';

    const expMap = expectationsMap(item);
    const expPublic = expMap ? String(expMap['send-public'] || '').trim() : '';
    const expPrivate = expMap ? String(expMap['send-private'] || '').trim() : '';
    const expText =
      expPublic || expPrivate ? ` · 期望 公=${formatExpectation(expPublic)} 私=${formatExpectation(expPrivate)}` : '';

    meta.textContent = `${formatDateTime(item.createdAt)} · ${item.provider || 'default'}:${item.model || 'default'}${expText}`;

    const preview = document.createElement('p');
    preview.className = 'conversation-preview';
    preview.textContent = clipText(item.note || '（无备注）', 120);

    left.append(title, meta, preview);

    const badge = document.createElement('span');
    badge.className = 'mini-badge';

    const bStatus = item.b && item.b.status ? String(item.b.status).trim() : '';
    const bResult = item.b && item.b.result && typeof item.b.result === 'object' ? item.b.result : null;
    const verdictB = evaluateAgainstExpectations(expMap, bResult);
    const hasPromptB = Boolean(String(item.promptB || '').trim());

    if (bStatus === 'succeeded') {
      if (verdictB.ok === false) {
        badge.classList.add('danger');
        badge.textContent = 'FAIL';
        badge.title = verdictB.violations.length > 0 ? `违背 expectations：${verdictB.violations.join(', ')}` : '';
      } else if (verdictB.ok === true) {
        badge.classList.add('success');
        badge.textContent = 'OK';
      } else {
        badge.classList.add('success');
        badge.textContent = 'B ✓';
      }
    } else if (bStatus === 'failed') {
      badge.classList.add('danger');
      badge.textContent = 'B ✗';
    } else {
      badge.classList.add('warn');
      badge.textContent = hasPromptB ? '待跑' : '无B';
      badge.title = hasPromptB ? '' : '缺少 B prompt；请先在右侧填写并保存（或 A 复制到 B）。';
    }

    row.append(left, badge);

    row.addEventListener('click', async () => {
      if (item.id === state.selectedCaseId) {
        return;
      }

      if (state.dirty) {
        const proceed = window.confirm('当前有未保存的修改，切换记录会丢失这些修改。是否继续？');

        if (!proceed) {
          return;
        }
      }

      state.selectedCaseId = item.id;
      try {
        await fetchSelectedCase();
      } catch (error) {
        showToast(error && error.message ? error.message : '加载失败');
      }
      state.dirty = false;
      renderAll();

      const studio = document.querySelector('.panel-studio');
      if (studio && typeof studio.scrollTo === 'function') {
        studio.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });

    dom.caseList.appendChild(row);
  });
}

function renderEditor() {
  const item = state.selectedCase;

  if (
    !dom.editorMeta ||
    !dom.promptA ||
    !dom.outputA ||
    !dom.promptB ||
    !dom.outputB ||
    !dom.noteInput ||
    !dom.caseMetrics ||
    !dom.aMetrics ||
    !dom.bMeta ||
    !dom.bMetrics ||
    !dom.bPublicPosts ||
    !dom.bPrivatePosts ||
    !dom.bRawReply ||
    !dom.aThinking ||
    !dom.aToolCalls ||
    !dom.aErrors ||
    !dom.aToolEvents ||
    !dom.aRawMessages ||
    !dom.bThinking ||
    !dom.bToolCalls ||
    !dom.bErrors ||
    !dom.bToolEvents ||
    !dom.bRawMessages
  ) {
    return;
  }

  dom.caseMetrics.innerHTML = '';
  dom.aMetrics.innerHTML = '';
  dom.bMetrics.innerHTML = '';

  if (!item) {
    dom.editorMeta.textContent = '从左侧选择一条记录';
    if (dom.editorTitle) {
      dom.editorTitle.textContent = 'A/B 对比';
    }
    dom.promptA.value = '';
    dom.outputA.value = '';
    dom.promptB.value = '';
    dom.outputB.value = '';
    dom.noteInput.value = '';
    dom.bPublicPosts.value = '';
    dom.bPrivatePosts.value = '';
    dom.bRawReply.value = '';
    dom.aThinking.value = '';
    dom.aToolCalls.value = '';
    dom.aErrors.value = '';
    dom.aToolEvents.value = '';
    dom.aRawMessages.value = '';
    dom.bThinking.value = '';
    dom.bToolCalls.value = '';
    dom.bErrors.value = '';
    dom.bToolEvents.value = '';
    dom.bRawMessages.value = '';
    dom.bMeta.textContent = '尚未运行';
    dom.copyAToBButton && (dom.copyAToBButton.disabled = true);
    dom.copyPromptAButton && (dom.copyPromptAButton.disabled = true);
    dom.copyPromptBButton && (dom.copyPromptBButton.disabled = true);
    dom.copyOutputAButton && (dom.copyOutputAButton.disabled = true);
    dom.copyOutputBButton && (dom.copyOutputBButton.disabled = true);
    dom.copyBPublicPostsButton && (dom.copyBPublicPostsButton.disabled = true);
    dom.copyBPrivatePostsButton && (dom.copyBPrivatePostsButton.disabled = true);
    dom.copyBRawReplyButton && (dom.copyBRawReplyButton.disabled = true);
    dom.copyAThinkingButton && (dom.copyAThinkingButton.disabled = true);
    dom.copyAToolCallsButton && (dom.copyAToolCallsButton.disabled = true);
    dom.copyAErrorsButton && (dom.copyAErrorsButton.disabled = true);
    dom.copyAToolEventsButton && (dom.copyAToolEventsButton.disabled = true);
    dom.copyARawMessagesButton && (dom.copyARawMessagesButton.disabled = true);
    dom.copyBThinkingButton && (dom.copyBThinkingButton.disabled = true);
    dom.copyBToolCallsButton && (dom.copyBToolCallsButton.disabled = true);
    dom.copyBErrorsButton && (dom.copyBErrorsButton.disabled = true);
    dom.copyBToolEventsButton && (dom.copyBToolEventsButton.disabled = true);
    dom.copyBRawMessagesButton && (dom.copyBRawMessagesButton.disabled = true);
    dom.saveButton && (dom.saveButton.disabled = true);
    dom.runBButton && (dom.runBButton.disabled = true);
    state.dirty = false;
    updateDirtyUi();
    return;
  }

  const agentLabel = item.agentName || item.agentId || 'Agent';

  if (dom.editorTitle) {
    dom.editorTitle.textContent = `A/B 对比 · ${agentLabel}`;
  }

  dom.editorMeta.textContent = `${item.id} · ${item.agentName || item.agentId || ''} · ${formatDateTime(item.createdAt)}`;

  dom.noteInput.value = item.note || '';
  dom.promptA.value = item.promptA || '';
  dom.outputA.value = item.outputA || '';
  dom.promptB.value = item.promptB || '';
  dom.outputB.value = item.outputB || '';

  const aSession =
    item.aSession && typeof item.aSession === 'object'
      ? item.aSession
      : item.aDebug && item.aDebug.session && typeof item.aDebug.session === 'object'
        ? item.aDebug.session
        : null;

  const aDebugTask = item.aDebug && item.aDebug.task && typeof item.aDebug.task === 'object' ? item.aDebug.task : null;
  const aChat = item.aChat && typeof item.aChat === 'object' ? item.aChat : null;

  dom.aThinking.value = aSession ? String(aSession.thinking || '') : '';
  dom.aToolCalls.value = aSession ? formatJson(aSession.toolCalls) : '';
  dom.aRawMessages.value = aSession ? formatJson(aSession.assistantMessagesTail) : '';
  dom.aToolEvents.value = item.aDebug ? formatJson(item.aDebug.toolCalls) : '';

  dom.aErrors.value = [
    aChat
      ? `chat.status=${aChat.status || ''}\nchat.errorMessage=${aChat.errorMessage || ''}\nchat.runId=${aChat.runId || ''}\nchat.sessionPath=${aChat.sessionPath || ''}`
      : '',
    aDebugTask
      ? `task.status=${aDebugTask.status || ''}\ntask.errorMessage=${aDebugTask.errorMessage || ''}\ntask.runId=${aDebugTask.runId || ''}\ntask.sessionPath=${aDebugTask.sessionPath || ''}`
      : '',
    aSession
      ? `session.stopReason=${aSession.stopReason || ''}\nsession.errorMessage=${aSession.errorMessage || ''}\nsession.provider=${aSession.provider || ''}\nsession.model=${aSession.model || ''}\nsession.api=${aSession.api || ''}\nsession.responseId=${aSession.responseId || ''}\nassistantErrors=${Array.isArray(aSession.assistantErrors) ? aSession.assistantErrors.join(' | ') : ''}\nusage=${aSession.usage ? JSON.stringify(aSession.usage) : ''}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  const expMap = expectationsMap(item);
  const expPublic = expMap ? String(expMap['send-public'] || '').trim() : '';
  const expPrivate = expMap ? String(expMap['send-private'] || '').trim() : '';

  dom.caseMetrics.append(
    metricChip('agent', agentLabel),
    metricChip('model', `${item.provider || 'default'}:${item.model || 'default'}`),
    metricChip('promptVersion', item.promptVersion || 'n/a'),
    metricChip('send-public', formatExpectation(expPublic)),
    metricChip('send-private', formatExpectation(expPrivate))
  );

  if (item.modelProfileId) {
    dom.caseMetrics.appendChild(metricChip('modelProfileId', item.modelProfileId));
  }

  const observedA = item.a && typeof item.a === 'object' ? item.a : null;
  const verdictA = evaluateAgainstExpectations(expMap, observedA);

  if (observedA) {
    const hint = verdictA.ok === false ? `违背 expectations：${verdictA.violations.join(', ')}` : '';
    dom.aMetrics.append(
      metricChip(
        'A verdict',
        verdictA.ok === null ? 'n/a' : verdictA.ok ? 'OK' : 'FAIL',
        hint,
        verdictA.ok === null ? 'warn' : verdictA.ok ? 'success' : 'danger'
      ),
      metricChip('publicToolUsed', String(Boolean(observedA.publicToolUsed))),
      metricChip('publicPostCount', formatNumber(observedA.publicPostCount)),
      metricChip('privatePostCount', formatNumber(observedA.privatePostCount)),
      metricChip('privateHandoffCount', formatNumber(observedA.privateHandoffCount))
    );
  } else {
    dom.aMetrics.appendChild(
      metricChip('A verdict', 'n/a', '旧记录可能缺少 A 侧观测字段，或对应 chat message 已不存在。', 'warn')
    );
  }

  const b = item.b || {};
  const bResult = b.result && typeof b.result === 'object' ? b.result : null;
  const verdictB = evaluateAgainstExpectations(expMap, bResult);

  if (b && b.status) {
    dom.bMeta.textContent = `${b.status}${b.taskId ? ` · task=${b.taskId}` : ''}${b.runId ? ` · run=${b.runId}` : ''}`;
  } else {
    dom.bMeta.textContent = '尚未运行';
  }

  if (b && b.errorMessage) {
    dom.bMetrics.appendChild(metricChip('error', b.errorMessage));
  }

  if (bResult) {
    dom.bMetrics.appendChild(
      metricChip(
        'B verdict',
        verdictB.ok === null ? 'n/a' : verdictB.ok ? 'OK' : 'FAIL',
        verdictB.ok === false ? `违背 expectations：${verdictB.violations.join(', ')}` : '',
        verdictB.ok === null ? 'warn' : verdictB.ok ? 'success' : 'danger'
      )
    );
    dom.bMetrics.append(
      metricChip(
        'publicToolUsed',
        String(Boolean(bResult.publicToolUsed)),
        '是否调用过 public 工具（如 send-public）。用于判断“是否通过工具发言”。'
      ),
      metricChip('publicPostCount', formatNumber(bResult.publicPostCount)),
      metricChip('privatePostCount', formatNumber(bResult.privatePostCount)),
      metricChip('privateHandoffCount', formatNumber(bResult.privateHandoffCount)),
      metricChip('publicPosts', formatNumber(Array.isArray(bResult.publicPosts) ? bResult.publicPosts.length : 0)),
      metricChip('privatePosts', formatNumber(Array.isArray(bResult.privatePosts) ? bResult.privatePosts.length : 0))
    );
  }

  dom.bPublicPosts.value = bResult ? formatPosts(bResult.publicPosts) : '';
  dom.bPrivatePosts.value = bResult ? formatPosts(bResult.privatePosts) : '';
  dom.bRawReply.value = bResult ? String(bResult.rawReply || '') : '';

  const bSession =
    item.bDebug && item.bDebug.session && typeof item.bDebug.session === 'object' ? item.bDebug.session : null;
  const bDebugTask = item.bDebug && item.bDebug.task && typeof item.bDebug.task === 'object' ? item.bDebug.task : null;

  dom.bThinking.value = bSession ? String(bSession.thinking || '') : '';
  dom.bToolCalls.value = bSession ? formatJson(bSession.toolCalls) : '';
  dom.bRawMessages.value = bSession ? formatJson(bSession.assistantMessagesTail) : '';
  dom.bToolEvents.value = item.bDebug ? formatJson(item.bDebug.toolCalls) : '';

  dom.bErrors.value = [
    bDebugTask
      ? `task.status=${bDebugTask.status || ''}\ntask.errorMessage=${bDebugTask.errorMessage || ''}\ntask.runId=${bDebugTask.runId || ''}\ntask.sessionPath=${bDebugTask.sessionPath || ''}`
      : '',
    bSession
      ? `session.stopReason=${bSession.stopReason || ''}\nsession.errorMessage=${bSession.errorMessage || ''}\nsession.provider=${bSession.provider || ''}\nsession.model=${bSession.model || ''}\nsession.api=${bSession.api || ''}\nsession.responseId=${bSession.responseId || ''}\nassistantErrors=${Array.isArray(bSession.assistantErrors) ? bSession.assistantErrors.join(' | ') : ''}\nusage=${bSession.usage ? JSON.stringify(bSession.usage) : ''}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  dom.copyAToBButton && (dom.copyAToBButton.disabled = false);
  dom.copyPromptAButton && (dom.copyPromptAButton.disabled = false);
  dom.copyPromptBButton && (dom.copyPromptBButton.disabled = false);
  dom.copyOutputAButton && (dom.copyOutputAButton.disabled = false);
  dom.copyOutputBButton && (dom.copyOutputBButton.disabled = false);
  dom.copyBPublicPostsButton && (dom.copyBPublicPostsButton.disabled = false);
  dom.copyBPrivatePostsButton && (dom.copyBPrivatePostsButton.disabled = false);
  dom.copyBRawReplyButton && (dom.copyBRawReplyButton.disabled = false);
  dom.copyAThinkingButton && (dom.copyAThinkingButton.disabled = false);
  dom.copyAToolCallsButton && (dom.copyAToolCallsButton.disabled = false);
  dom.copyAErrorsButton && (dom.copyAErrorsButton.disabled = false);
  dom.copyAToolEventsButton && (dom.copyAToolEventsButton.disabled = false);
  dom.copyARawMessagesButton && (dom.copyARawMessagesButton.disabled = false);
  dom.copyBThinkingButton && (dom.copyBThinkingButton.disabled = false);
  dom.copyBToolCallsButton && (dom.copyBToolCallsButton.disabled = false);
  dom.copyBErrorsButton && (dom.copyBErrorsButton.disabled = false);
  dom.copyBToolEventsButton && (dom.copyBToolEventsButton.disabled = false);
  dom.copyBRawMessagesButton && (dom.copyBRawMessagesButton.disabled = false);
  dom.saveButton && (dom.saveButton.disabled = false);
  dom.runBButton && (dom.runBButton.disabled = false);

  state.dirty = false;
  updateDirtyUi();
}

function renderAll() {
  renderCaseList();
  renderEditor();
}

async function saveSelectedCase() {
  const item = state.selectedCase;

  if (!item) {
    return;
  }

  if (!dom.promptB || !dom.noteInput) {
    return;
  }

  const payload = await fetchJson(`/api/eval-cases/${encodeURIComponent(item.id)}`, {
    method: 'PATCH',
    body: {
      promptB: dom.promptB.value,
      note: dom.noteInput.value,
    },
  });

  state.selectedCase = payload && payload.case ? payload.case : state.selectedCase;
  await fetchCaseList();
}

async function runSelectedCaseB() {
  const item = state.selectedCase;

  if (!item) {
    return;
  }

  if (!dom.promptB) {
    return;
  }

  const prompt = String(dom.promptB.value || '').trim();

  if (!prompt) {
    showToast('请先填写 B prompt');
    return;
  }

  const payload = await fetchJson(`/api/eval-cases/${encodeURIComponent(item.id)}/run`, {
    method: 'POST',
    body: {
      prompt,
    },
  });

  state.selectedCase = payload && payload.case ? payload.case : state.selectedCase;
  await fetchCaseList();
}

async function runBatchB() {
  const candidates = filteredCaseList();

  if (candidates.length === 0) {
    showToast('当前筛选下暂无记录可运行');
    return;
  }

  const runnable = candidates.filter((item) => Boolean(String(item && item.promptB ? item.promptB : '').trim()));
  const missingPrompt = candidates.length - runnable.length;

  if (runnable.length === 0) {
    showToast(missingPrompt > 0 ? '当前筛选下的记录都缺少 B prompt（请先填写并保存）' : '当前筛选下暂无可运行记录');
    return;
  }

  const ids = runnable.map((item) => String(item.id)).filter(Boolean);
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  if (missingPrompt > 0) {
    skipped += missingPrompt;
  }

  for (let index = 0; index < ids.length; index += 1) {
    const caseId = ids[index];

    if (dom.runBatchButton) {
      dom.runBatchButton.textContent = `批量运行中 ${index + 1}/${ids.length}`;
    }

    try {
      await fetchJson(`/api/eval-cases/${encodeURIComponent(caseId)}/run`, {
        method: 'POST',
      });
      succeeded += 1;
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error || 'Unknown error');

      if (/prompt is required/i.test(message) || message.includes('prompt')) {
        skipped += 1;
      } else {
        failed += 1;
      }
    }
  }

  await refreshAll();
  renderAll();
  showToast(`批量完成：成功 ${succeeded} · 跳过 ${skipped} · 失败 ${failed}`);
}

async function bootstrap() {
  try {
    await refreshAll();
  } catch (error) {
    showToast(error && error.message ? error.message : '加载失败');
  }

  renderAll();
}

if (dom.refreshButton) {
  dom.refreshButton.addEventListener('click', () => {
    if (state.dirty) {
      const proceed = window.confirm('当前有未保存的修改，刷新会丢失这些修改。是否继续？');

      if (!proceed) {
        return;
      }
    }

    bootstrap();
  });
}

if (dom.filterForm) {
  dom.filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
  });
}

if (dom.searchInput) {
  dom.searchInput.addEventListener('input', () => {
    state.filters.query = dom.searchInput ? dom.searchInput.value : '';
    renderCaseList();
  });
}

if (dom.statusFilter) {
  dom.statusFilter.addEventListener('change', () => {
    state.filters.status = dom.statusFilter ? dom.statusFilter.value : 'all';
    renderCaseList();
  });
}

if (dom.runBatchButton) {
  dom.runBatchButton.addEventListener('click', async () => {
    if (state.dirty) {
      const proceed = window.confirm('当前有未保存的修改，批量运行会刷新页面数据并丢失这些修改。是否继续？');

      if (!proceed) {
        return;
      }
    }

    const previousText = dom.runBatchButton ? dom.runBatchButton.textContent : '';

    dom.runBatchButton.disabled = true;

    try {
      await runBatchB();
    } catch (error) {
      showToast(error && error.message ? error.message : '批量运行失败');
    } finally {
      dom.runBatchButton.disabled = false;
      dom.runBatchButton.textContent = previousText;
    }
  });
}

if (dom.copyAToBButton) {
  dom.copyAToBButton.addEventListener('click', () => {
    if (!state.selectedCase || !dom.promptA || !dom.promptB) {
      return;
    }

    dom.promptB.value = dom.promptA.value;
    syncDirtyState();
  });
}

if (dom.copyPromptAButton) {
  dom.copyPromptAButton.addEventListener('click', () => {
    copyToClipboard(dom.promptA ? dom.promptA.value : '');
  });
}

if (dom.copyPromptBButton) {
  dom.copyPromptBButton.addEventListener('click', () => {
    copyToClipboard(dom.promptB ? dom.promptB.value : '');
  });
}

if (dom.copyOutputAButton) {
  dom.copyOutputAButton.addEventListener('click', () => {
    copyToClipboard(dom.outputA ? dom.outputA.value : '');
  });
}

if (dom.copyOutputBButton) {
  dom.copyOutputBButton.addEventListener('click', () => {
    copyToClipboard(dom.outputB ? dom.outputB.value : '');
  });
}

if (dom.copyBPublicPostsButton) {
  dom.copyBPublicPostsButton.addEventListener('click', () => {
    copyToClipboard(dom.bPublicPosts ? dom.bPublicPosts.value : '');
  });
}

if (dom.copyBPrivatePostsButton) {
  dom.copyBPrivatePostsButton.addEventListener('click', () => {
    copyToClipboard(dom.bPrivatePosts ? dom.bPrivatePosts.value : '');
  });
}

if (dom.copyBRawReplyButton) {
  dom.copyBRawReplyButton.addEventListener('click', () => {
    copyToClipboard(dom.bRawReply ? dom.bRawReply.value : '');
  });
}

if (dom.copyAThinkingButton) {
  dom.copyAThinkingButton.addEventListener('click', () => {
    copyToClipboard(dom.aThinking ? dom.aThinking.value : '');
  });
}

if (dom.copyAToolCallsButton) {
  dom.copyAToolCallsButton.addEventListener('click', () => {
    copyToClipboard(dom.aToolCalls ? dom.aToolCalls.value : '');
  });
}

if (dom.copyAErrorsButton) {
  dom.copyAErrorsButton.addEventListener('click', () => {
    copyToClipboard(dom.aErrors ? dom.aErrors.value : '');
  });
}

if (dom.copyAToolEventsButton) {
  dom.copyAToolEventsButton.addEventListener('click', () => {
    copyToClipboard(dom.aToolEvents ? dom.aToolEvents.value : '');
  });
}

if (dom.copyARawMessagesButton) {
  dom.copyARawMessagesButton.addEventListener('click', () => {
    copyToClipboard(dom.aRawMessages ? dom.aRawMessages.value : '');
  });
}

if (dom.copyBThinkingButton) {
  dom.copyBThinkingButton.addEventListener('click', () => {
    copyToClipboard(dom.bThinking ? dom.bThinking.value : '');
  });
}

if (dom.copyBToolCallsButton) {
  dom.copyBToolCallsButton.addEventListener('click', () => {
    copyToClipboard(dom.bToolCalls ? dom.bToolCalls.value : '');
  });
}

if (dom.copyBErrorsButton) {
  dom.copyBErrorsButton.addEventListener('click', () => {
    copyToClipboard(dom.bErrors ? dom.bErrors.value : '');
  });
}

if (dom.copyBToolEventsButton) {
  dom.copyBToolEventsButton.addEventListener('click', () => {
    copyToClipboard(dom.bToolEvents ? dom.bToolEvents.value : '');
  });
}

if (dom.copyBRawMessagesButton) {
  dom.copyBRawMessagesButton.addEventListener('click', () => {
    copyToClipboard(dom.bRawMessages ? dom.bRawMessages.value : '');
  });
}

if (dom.promptB) {
  dom.promptB.addEventListener('input', () => {
    syncDirtyState();
  });
}

if (dom.noteInput) {
  dom.noteInput.addEventListener('input', () => {
    syncDirtyState();
  });
}

if (dom.saveButton) {
  dom.saveButton.addEventListener('click', async () => {
    let saved = false;

    try {
      await saveSelectedCase();
      showToast('已保存');
      state.dirty = false;
      saved = true;
    } catch (error) {
      showToast(error && error.message ? error.message : '保存失败');
    }

    if (saved) {
      renderAll();
    } else {
      syncDirtyState();
    }
  });
}

if (dom.runBButton) {
  dom.runBButton.addEventListener('click', async () => {
    const previousText = dom.runBButton ? dom.runBButton.textContent : '';
    if (dom.runBButton) {
      dom.runBButton.disabled = true;
      dom.runBButton.textContent = '运行中...';
    }

    let succeeded = false;

    try {
      await runSelectedCaseB();
      showToast('B 已完成');
      state.dirty = false;
      succeeded = true;
    } catch (error) {
      showToast(error && error.message ? error.message : '运行失败');
    } finally {
      if (dom.runBButton) {
        dom.runBButton.disabled = false;
        dom.runBButton.textContent = previousText;
      }
    }

    if (succeeded) {
      renderAll();
    } else {
      syncDirtyState();
    }
  });
}

bootstrap();
