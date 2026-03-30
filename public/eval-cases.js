// @ts-check

const state = {
  cases: [],
  selectedCaseId: null,
  selectedCase: null,
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
  saveButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('save-button')),
  runBButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('run-b-button')),
  noteInput: /** @type {HTMLInputElement | null} */ (document.getElementById('note-input')),
  caseMetrics: /** @type {HTMLElement | null} */ (document.getElementById('case-metrics')),
  promptA: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('prompt-a')),
  outputA: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('output-a')),
  promptB: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('prompt-b')),
  aMetrics: /** @type {HTMLElement | null} */ (document.getElementById('a-metrics')),
  bMeta: /** @type {HTMLElement | null} */ (document.getElementById('b-meta')),
  bMetrics: /** @type {HTMLElement | null} */ (document.getElementById('b-metrics')),
  outputB: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('output-b')),
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

function metricChip(label, value, hint = '') {
  const chip = document.createElement('span');
  chip.className = 'file-chip';
  chip.textContent = `${label}: ${value}`;
  if (hint) {
    chip.title = hint;
  }
  return chip;
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
    const expText = expPublic || expPrivate ? ` · exp pub=${expPublic || '-'} pri=${expPrivate || '-'}` : '';

    meta.textContent = `${formatDateTime(item.createdAt)} · ${item.provider || 'default'}:${item.model || 'default'}${expText}`;

    const preview = document.createElement('p');
    preview.className = 'conversation-preview';
    preview.textContent = clipText(item.note || '（无备注）', 120);

    left.append(title, meta, preview);

    const badge = document.createElement('span');
    badge.className = 'mini-badge';

    const bStatus = item.b && item.b.status ? String(item.b.status).trim() : '';

    if (bStatus === 'succeeded') {
      badge.classList.add('success');
      badge.textContent = 'B ✓';
    } else if (bStatus === 'failed') {
      badge.classList.add('danger');
      badge.textContent = 'B ✗';
    } else {
      badge.classList.add('warn');
      badge.textContent = '待跑';
    }

    row.append(left, badge);

    row.addEventListener('click', async () => {
      state.selectedCaseId = item.id;
      try {
        await fetchSelectedCase();
      } catch (error) {
        showToast(error && error.message ? error.message : '加载失败');
      }
      renderAll();
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
    !dom.bMetrics
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
    dom.bMeta.textContent = '尚未运行';
    dom.copyAToBButton && (dom.copyAToBButton.disabled = true);
    dom.saveButton && (dom.saveButton.disabled = true);
    dom.runBButton && (dom.runBButton.disabled = true);
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

  const expMap = expectationsMap(item);
  const expPublic = expMap ? String(expMap['send-public'] || '').trim() : '';
  const expPrivate = expMap ? String(expMap['send-private'] || '').trim() : '';

  dom.caseMetrics.append(
    metricChip('agent', agentLabel),
    metricChip('model', `${item.provider || 'default'}:${item.model || 'default'}`),
    metricChip('promptVersion', item.promptVersion || 'n/a'),
    metricChip('send-public', expPublic || 'n/a'),
    metricChip('send-private', expPrivate || 'n/a')
  );

  if (item.modelProfileId) {
    dom.caseMetrics.appendChild(metricChip('modelProfileId', item.modelProfileId));
  }

  const observedA = item.a && typeof item.a === 'object' ? item.a : null;
  const verdictA = evaluateAgainstExpectations(expMap, observedA);

  if (observedA) {
    const hint = verdictA.ok === false ? `违背 expectations：${verdictA.violations.join(', ')}` : '';
    dom.aMetrics.append(
      metricChip('A verdict', verdictA.ok === null ? 'n/a' : verdictA.ok ? 'OK' : 'FAIL', hint),
      metricChip('publicToolUsed', String(Boolean(observedA.publicToolUsed))),
      metricChip('publicPostCount', formatNumber(observedA.publicPostCount)),
      metricChip('privatePostCount', formatNumber(observedA.privatePostCount)),
      metricChip('privateHandoffCount', formatNumber(observedA.privateHandoffCount))
    );
  } else {
    dom.aMetrics.appendChild(metricChip('A verdict', 'n/a', '旧记录可能缺少 A 侧观测字段，或对应 chat message 已不存在。'));
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
        verdictB.ok === false ? `违背 expectations：${verdictB.violations.join(', ')}` : ''
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

  dom.copyAToBButton && (dom.copyAToBButton.disabled = false);
  dom.saveButton && (dom.saveButton.disabled = false);
  dom.runBButton && (dom.runBButton.disabled = false);
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
  if (state.cases.length === 0) {
    showToast('暂无记录可运行');
    return;
  }

  const ids = state.cases.map((item) => (item && item.id ? String(item.id) : '')).filter(Boolean);
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

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
  });
}

if (dom.saveButton) {
  dom.saveButton.addEventListener('click', async () => {
    try {
      await saveSelectedCase();
      showToast('已保存');
    } catch (error) {
      showToast(error && error.message ? error.message : '保存失败');
    }

    renderAll();
  });
}

if (dom.runBButton) {
  dom.runBButton.addEventListener('click', async () => {
    const previousText = dom.runBButton ? dom.runBButton.textContent : '';
    if (dom.runBButton) {
      dom.runBButton.disabled = true;
      dom.runBButton.textContent = '运行中...';
    }

    try {
      await runSelectedCaseB();
      showToast('B 已完成');
    } catch (error) {
      showToast(error && error.message ? error.message : '运行失败');
    } finally {
      if (dom.runBButton) {
        dom.runBButton.disabled = false;
        dom.runBButton.textContent = previousText;
      }
    }

    renderAll();
  });
}

bootstrap();
