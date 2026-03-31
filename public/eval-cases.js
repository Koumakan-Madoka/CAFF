// @ts-check

const state = {
  cases: [],
  selectedCaseId: null,
  selectedCase: null,
  runs: [],
  selectedRunId: null,
  selectedRun: null,
  modelOptions: [],
  batchModelKeys: [],
  dirty: false,
  filters: {
    query: '',
    status: 'all',
  },
};

const shared = window.CaffShared || {};
const fetchJson = shared.fetchJson;
const modelOptionUtils = shared.modelOptions || {};

const dom = {
  refreshButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('refresh-button')),
  runBatchButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('run-batch-button')),
  clearRunSelectionButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('clear-run-selection-button')),
  batchVariant: /** @type {HTMLSelectElement | null} */ (document.getElementById('batch-variant')),
  batchRepeats: /** @type {HTMLInputElement | null} */ (document.getElementById('batch-repeats')),
  batchModels: /** @type {HTMLSelectElement | null} */ (document.getElementById('batch-models')),
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
  runSummary: /** @type {HTMLElement | null} */ (document.getElementById('run-summary')),
  runList: /** @type {HTMLDivElement | null} */ (document.getElementById('run-list')),
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
      const content =
        item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'content')
          ? String(item.content || '')
          : String(item || '');
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

function modelOptionKey(provider, model) {
  if (modelOptionUtils && typeof modelOptionUtils.modelOptionKey === 'function') {
    return modelOptionUtils.modelOptionKey(provider, model);
  }

  return `${String(provider || '').trim()}\u001f${String(model || '').trim()}`;
}

function parseModelOptionKey(key) {
  const [provider, model] = String(key || '').split('\u001f');

  return {
    provider: String(provider || '').trim(),
    model: String(model || '').trim(),
  };
}

function buildModelOptionLabel(option) {
  if (modelOptionUtils && typeof modelOptionUtils.buildModelOptionLabel === 'function') {
    return modelOptionUtils.buildModelOptionLabel(option);
  }

  if (!option) {
    return '系统默认模型';
  }

  const provider = String(option.provider || '').trim();
  const model = String(option.model || '').trim();
  return String(option.label || (provider ? `${provider} / ${model}` : model)).trim() || '系统默认模型';
}

function fillBatchModelSelect(currentProvider = '', currentModel = '') {
  if (!dom.batchModels) {
    return;
  }

  const select = dom.batchModels;
  const options = Array.isArray(state.modelOptions) ? state.modelOptions : [];
  const currentKey = currentModel ? modelOptionKey(currentProvider, currentModel) : '';
  const desired =
    Array.isArray(state.batchModelKeys) && state.batchModelKeys.length > 0
      ? state.batchModelKeys.filter(Boolean)
      : currentKey
        ? [currentKey]
        : [];

  select.innerHTML = '';

  const seen = new Set();

  options.forEach((option) => {
    if (!option || !option.key || seen.has(option.key)) {
      return;
    }

    seen.add(option.key);

    const element = document.createElement('option');
    element.value = option.key;
    element.textContent = buildModelOptionLabel(option);
    element.selected = desired.includes(option.key);
    select.appendChild(element);
  });

  if (currentKey && !seen.has(currentKey)) {
    const parsed = parseModelOptionKey(currentKey);
    const element = document.createElement('option');
    element.value = currentKey;
    element.textContent = parsed.provider ? `${parsed.provider} / ${parsed.model}` : parsed.model;
    element.selected = desired.includes(currentKey) || desired.length === 0;
    select.appendChild(element);
    seen.add(currentKey);
  }

  desired.forEach((key) => {
    if (!key || seen.has(key)) {
      return;
    }

    const parsed = parseModelOptionKey(key);

    if (!parsed.model) {
      return;
    }

    const element = document.createElement('option');
    element.value = key;
    element.textContent = parsed.provider ? `${parsed.provider} / ${parsed.model}` : parsed.model;
    element.selected = true;
    select.appendChild(element);
    seen.add(key);
  });

  if (select.selectedOptions.length === 0 && select.options.length > 0) {
    const fallback = currentKey ? Array.from(select.options).find((option) => option.value === currentKey) : null;

    if (fallback) {
      fallback.selected = true;
    } else {
      select.options[0].selected = true;
    }
  }

  state.batchModelKeys = Array.from(select.selectedOptions)
    .map((option) => String(option.value || '').trim())
    .filter(Boolean);
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

async function fetchModelOptions() {
  if (Array.isArray(state.modelOptions) && state.modelOptions.length > 0) {
    return;
  }

  if (typeof fetchJson !== 'function') {
    throw new Error('API client 未加载');
  }

  const payload = await fetchJson('/api/bootstrap');
  state.modelOptions = Array.isArray(payload && payload.modelOptions) ? payload.modelOptions : [];
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

async function fetchSelectedRuns() {
  if (!state.selectedCaseId) {
    state.runs = [];
    return;
  }

  const payload = await fetchJson(`/api/eval-cases/${encodeURIComponent(state.selectedCaseId)}/runs`);
  state.runs = Array.isArray(payload && payload.runs) ? payload.runs : [];
}

async function fetchRunDetail(runId) {
  const normalized = String(runId || '').trim();

  if (!normalized) {
    return null;
  }

  const payload = await fetchJson(`/api/eval-case-runs/${encodeURIComponent(normalized)}`);
  return payload && payload.run ? payload.run : null;
}

async function selectRun(runId) {
  const normalized = String(runId || '').trim();

  if (!normalized) {
    state.selectedRunId = null;
    state.selectedRun = null;
    renderAll();
    return;
  }

  state.selectedRunId = normalized;
  state.selectedRun = null;
  renderAll();

  try {
    state.selectedRun = await fetchRunDetail(normalized);
  } catch (error) {
    state.selectedRunId = null;
    state.selectedRun = null;
    showToast(error && error.message ? error.message : '加载失败');
  }

  renderAll();
}

async function refreshAll() {
  await fetchCaseList();
  await fetchSelectedCase();
  await fetchSelectedRuns();
  state.selectedRunId = null;
  state.selectedRun = null;
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
        await fetchSelectedRuns();
        state.selectedRunId = null;
        state.selectedRun = null;
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

function normalizeRunVariant(value) {
  const normalized = String(value || '').trim().toUpperCase();

  if (normalized === 'A') {
    return 'A';
  }

  if (normalized === 'B') {
    return 'B';
  }

  return normalized || '?';
}

function renderRunHistory() {
  if (!dom.runSummary || !dom.runList) {
    return;
  }

  dom.runSummary.innerHTML = '';
  dom.runList.innerHTML = '';

  if (dom.clearRunSelectionButton) {
    dom.clearRunSelectionButton.classList.toggle('hidden', !state.selectedRunId);
  }

  const item = state.selectedCase;

  if (!item) {
    if (dom.runBatchButton) {
      dom.runBatchButton.disabled = true;
    }

    const empty = document.createElement('div');
    empty.className = 'empty-state compact-empty-state';
    empty.textContent = '选择左侧记录后，可在此批量测试并查看重放历史。';
    dom.runList.appendChild(empty);
    return;
  }

  if (dom.runBatchButton) {
    dom.runBatchButton.disabled = false;
  }

  const runs = Array.isArray(state.runs) ? state.runs : [];
  const expMap = expectationsMap(item);

  dom.runSummary.appendChild(metricChip('runs', formatNumber(runs.length), '该错题的重放次数（包含 A/B）。'));

  const modelCount = new Set(
    runs
      .map((run) => modelOptionKey(run && run.provider ? run.provider : '', run && run.model ? run.model : ''))
      .filter((key) => key && key !== '\u001f')
  ).size;

  dom.runSummary.appendChild(metricChip('models', formatNumber(modelCount), 'run 历史中出现过的 provider:model 数量。'));

  ['A', 'B'].forEach((variant) => {
    const variantRuns = runs.filter((run) => normalizeRunVariant(run && run.variant ? run.variant : '') === variant);
    const total = variantRuns.length;
    const succeeded = variantRuns.filter((run) => String(run && run.status ? run.status : '').trim() === 'succeeded').length;
    const toolUsed = variantRuns.filter((run) => Boolean(run && run.result && run.result.publicToolUsed)).length;

    dom.runSummary.append(
      metricChip(`${variant} succ`, formatPercent(total ? succeeded / total : Number.NaN), `${succeeded}/${total} succeeded`),
      metricChip(
        `${variant} tool`,
        formatPercent(total ? toolUsed / total : Number.NaN),
        'publicToolUsed 命中率：用于衡量“是否按预期通过工具发言”。'
      )
    );
  });

  if (runs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact-empty-state';
    empty.textContent = '暂无重放记录。可先在上方选择变体与次数，然后点击“开始批量测试”。';
    dom.runList.appendChild(empty);
    return;
  }

  runs.forEach((run) => {
    const row = document.createElement('div');
    row.className = 'agent-list-item compact';
    row.dataset.id = run.id;
    row.classList.toggle('active', run.id === state.selectedRunId);

    const left = document.createElement('div');
    left.style.display = 'grid';
    left.style.gap = '0.12rem';

    const title = document.createElement('strong');
    const runVariant = normalizeRunVariant(run && run.variant ? run.variant : '');
    const runStatus = String(run && run.status ? run.status : '').trim() || 'unknown';
    title.textContent = `${runVariant} · ${runStatus}`;

    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `${formatDateTime(run.createdAt)} · ${run.provider || item.provider || 'default'}:${run.model || item.model || 'default'}`;

    const preview = document.createElement('p');
    preview.className = 'conversation-preview';
    const previewText =
      String(run && run.outputText ? run.outputText : '').trim() ||
      (run && run.errorMessage ? `error: ${run.errorMessage}` : '(empty)');
    preview.textContent = clipText(previewText, 120);

    left.append(title, meta, preview);

    const badge = document.createElement('span');
    badge.className = 'mini-badge';

    const runResult = run && run.result && typeof run.result === 'object' ? run.result : null;
    const verdict = evaluateAgainstExpectations(expMap, runResult);
    const isLoading = run.id === state.selectedRunId && !state.selectedRun;

    if (isLoading) {
      badge.classList.add('busy');
      badge.textContent = '加载中';
    } else if (runStatus === 'succeeded') {
      if (verdict.ok === false) {
        badge.classList.add('danger');
        badge.textContent = 'FAIL';
        badge.title = verdict.violations.length > 0 ? `违背 expectations：${verdict.violations.join(', ')}` : '';
      } else if (verdict.ok === true) {
        badge.classList.add('success');
        badge.textContent = 'OK';
      } else {
        badge.classList.add('success');
        badge.textContent = `${runVariant} ✓`;
      }
    } else if (runStatus === 'failed') {
      badge.classList.add('danger');
      badge.textContent = `${runVariant} ✗`;
    } else {
      badge.classList.add('warn');
      badge.textContent = runVariant;
    }

    row.append(left, badge);

    row.addEventListener('click', () => {
      if (!run || !run.id) {
        return;
      }

      selectRun(run.id);
    });

    dom.runList.appendChild(row);
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
    if (dom.batchModels) {
      dom.batchModels.innerHTML = '';
      dom.batchModels.disabled = true;
    }
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
    renderRunHistory();
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

  if (dom.batchModels) {
    dom.batchModels.disabled = false;
    fillBatchModelSelect(item.provider || '', item.model || '');
  }

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

  const selectedRun = state.selectedRun && typeof state.selectedRun === 'object' ? state.selectedRun : null;
  const selectedResult = selectedRun && selectedRun.result && typeof selectedRun.result === 'object' ? selectedRun.result : null;
  const selectedDebug = selectedRun && selectedRun.debug && typeof selectedRun.debug === 'object' ? selectedRun.debug : null;

  const b = item.b || {};
  const bResult = b.result && typeof b.result === 'object' ? b.result : null;

  const activeVariant = selectedRun ? String(selectedRun.variant || '').trim() : 'B';
  const activeStatus = selectedRun ? String(selectedRun.status || '').trim() : String(b.status || '').trim();
  const activeTaskId = selectedRun ? String(selectedRun.taskId || '').trim() : String(b.taskId || '').trim();
  const activeRunId = selectedRun ? selectedRun.runId : b.runId;
  const activeErrorMessage = selectedRun ? String(selectedRun.errorMessage || '') : String(b.errorMessage || '');
  const activeOutputText = selectedRun ? String(selectedRun.outputText || '') : String(item.outputB || '');
  const activeResult = selectedRun ? selectedResult : bResult;
  const activeDebug = selectedRun ? selectedDebug : item.bDebug;
  const verdictActive = evaluateAgainstExpectations(expMap, activeResult);

  dom.outputB.value = activeOutputText;

  if (activeStatus) {
    const createdAt = selectedRun && selectedRun.createdAt ? formatDateTime(selectedRun.createdAt) : '';
    const modelLabel =
      selectedRun && (selectedRun.model || selectedRun.provider)
        ? `${selectedRun.provider || 'default'}:${selectedRun.model || 'default'}`
        : '';

    dom.bMeta.textContent = `${activeVariant}${createdAt ? ` · ${createdAt}` : ''}${modelLabel ? ` · ${modelLabel}` : ''} · ${activeStatus}${activeTaskId ? ` · task=${activeTaskId}` : ''}${activeRunId ? ` · run=${activeRunId}` : ''}`;
  } else {
    dom.bMeta.textContent = selectedRun ? `${activeVariant} · 未获取到状态` : '尚未运行';
  }

  if (activeErrorMessage) {
    dom.bMetrics.appendChild(metricChip('error', activeErrorMessage));
  }

  if (activeResult) {
    dom.bMetrics.appendChild(
      metricChip(
        `${activeVariant} verdict`,
        verdictActive.ok === null ? 'n/a' : verdictActive.ok ? 'OK' : 'FAIL',
        verdictActive.ok === false ? `违背 expectations：${verdictActive.violations.join(', ')}` : '',
        verdictActive.ok === null ? 'warn' : verdictActive.ok ? 'success' : 'danger'
      )
    );
    dom.bMetrics.append(
      metricChip(
        'publicToolUsed',
        String(Boolean(activeResult.publicToolUsed)),
        '是否调用过 public 工具（如 send-public）。用于判断“是否通过工具发言”。'
      ),
      metricChip('publicPostCount', formatNumber(activeResult.publicPostCount)),
      metricChip('privatePostCount', formatNumber(activeResult.privatePostCount)),
      metricChip('privateHandoffCount', formatNumber(activeResult.privateHandoffCount)),
      metricChip('publicPosts', formatNumber(Array.isArray(activeResult.publicPosts) ? activeResult.publicPosts.length : 0)),
      metricChip('privatePosts', formatNumber(Array.isArray(activeResult.privatePosts) ? activeResult.privatePosts.length : 0))
    );
  }

  dom.bPublicPosts.value = activeResult ? formatPosts(activeResult.publicPosts) : '';
  dom.bPrivatePosts.value = activeResult ? formatPosts(activeResult.privatePosts) : '';
  dom.bRawReply.value = activeResult ? String(activeResult.rawReply || '') : '';

  const bSession = activeDebug && activeDebug.session && typeof activeDebug.session === 'object' ? activeDebug.session : null;
  const bDebugTask = activeDebug && activeDebug.task && typeof activeDebug.task === 'object' ? activeDebug.task : null;

  dom.bThinking.value = bSession ? String(bSession.thinking || '') : '';
  dom.bToolCalls.value = bSession ? formatJson(bSession.toolCalls) : '';
  dom.bRawMessages.value = bSession ? formatJson(bSession.assistantMessagesTail) : '';
  dom.bToolEvents.value = activeDebug ? formatJson(activeDebug.toolCalls) : '';

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
  renderRunHistory();
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
  await fetchSelectedRuns();
  state.selectedRunId = null;
  state.selectedRun = null;
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
  await fetchSelectedRuns();
  state.selectedRunId = null;
  state.selectedRun = null;
}

function normalizeBatchRepeats(value, fallback = 3) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.max(parsed, 1), 20);
}

async function runBatchSelectedCase() {
  const item = state.selectedCase;

  if (!item) {
    showToast('请先选择一条错题记录');
    return;
  }

  const repeats = normalizeBatchRepeats(dom.batchRepeats ? dom.batchRepeats.value : 3, 3);

  if (dom.batchRepeats) {
    dom.batchRepeats.value = String(repeats);
  }

  const mode = dom.batchVariant ? String(dom.batchVariant.value || 'AB').trim().toUpperCase() : 'AB';
  const variants = [];

  if (mode === 'A' || mode === 'AB') {
    variants.push('A');
  }

  if (mode === 'B' || mode === 'AB') {
    variants.push('B');
  }

  if (variants.length === 0) {
    variants.push('B');
  }

  const promptB = dom.promptB ? String(dom.promptB.value || '').trim() : String(item.promptB || '').trim();

  if (variants.includes('B') && !promptB) {
    showToast('请先填写 B prompt');
    return;
  }

  const defaultKey = item.model ? modelOptionKey(item.provider || '', item.model || '') : '';
  const selectedKeys =
    Array.isArray(state.batchModelKeys) && state.batchModelKeys.length > 0
      ? state.batchModelKeys.filter(Boolean)
      : defaultKey
        ? [defaultKey]
        : [];

  const selectedModels = selectedKeys
    .map((key) => {
      const option = Array.isArray(state.modelOptions) ? state.modelOptions.find((item) => item && item.key === key) : null;
      const parsed = parseModelOptionKey(key);

      return {
        key,
        provider: option ? String(option.provider || '').trim() : parsed.provider,
        model: option ? String(option.model || '').trim() : parsed.model,
        label: option ? buildModelOptionLabel(option) : parsed.provider ? `${parsed.provider} / ${parsed.model}` : parsed.model,
      };
    })
    .filter((item) => item && (item.model || item.provider));

  if (selectedModels.length === 0) {
    selectedModels.push({
      key: defaultKey,
      provider: String(item.provider || '').trim(),
      model: String(item.model || '').trim(),
      label: item.provider ? `${item.provider}:${item.model}` : String(item.model || 'default'),
    });
  }

  const total = repeats * variants.length * selectedModels.length;
  let succeeded = 0;
  let failed = 0;
  let seq = 0;

  for (const modelSpec of selectedModels) {
    const modelLabel = modelSpec.provider ? `${modelSpec.provider}:${modelSpec.model}` : modelSpec.model || 'default';

    for (let round = 0; round < repeats; round += 1) {
      for (let index = 0; index < variants.length; index += 1) {
        const variant = variants[index];
        seq += 1;

        if (dom.runBatchButton) {
          dom.runBatchButton.textContent = `批量测试 ${seq}/${total} (${variant} · ${modelLabel})`;
        }

        try {
          const body = {
            variant,
            provider: modelSpec.provider,
            model: modelSpec.model,
            prompt: variant === 'A' ? undefined : dom.promptB ? dom.promptB.value : String(item.promptB || ''),
          };

          await fetchJson(`/api/eval-cases/${encodeURIComponent(item.id)}/run`, {
            method: 'POST',
            body,
          });
          succeeded += 1;
        } catch {
          failed += 1;
        }
      }
    }
  }

  await refreshAll();
  renderAll();
  showToast(`批量完成（${selectedModels.length} models）：成功 ${succeeded} · 失败 ${failed}`);
}

async function bootstrap() {
  try {
    await fetchModelOptions();
  } catch {
    state.modelOptions = [];
  }

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

if (dom.batchModels) {
  dom.batchModels.addEventListener('change', () => {
    state.batchModelKeys = Array.from(dom.batchModels ? dom.batchModels.selectedOptions : [])
      .map((option) => String(option.value || '').trim())
      .filter(Boolean);
  });
}

if (dom.runBatchButton) {
  dom.runBatchButton.addEventListener('click', async () => {
    if (state.dirty) {
      const proceed = window.confirm('当前有未保存的修改，批量测试会刷新页面数据并丢失这些修改。是否继续？');

      if (!proceed) {
        return;
      }
    }

    const previousText = dom.runBatchButton ? dom.runBatchButton.textContent : '';

    dom.runBatchButton.disabled = true;

    try {
      await runBatchSelectedCase();
    } catch (error) {
      showToast(error && error.message ? error.message : '批量测试失败');
    } finally {
      dom.runBatchButton.disabled = false;
      dom.runBatchButton.textContent = previousText;
    }
  });
}

if (dom.clearRunSelectionButton) {
  dom.clearRunSelectionButton.addEventListener('click', () => {
    state.selectedRunId = null;
    state.selectedRun = null;
    renderAll();
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
