// @ts-check

const state = {
  cases: [],
  selectedCaseId: null,
  selectedCase: null,
};

const shared = window.CaffShared || {};
const fetchJson = shared.fetchJson;

const dom = {
  refreshButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('refresh-button')),
  runBatchButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('run-batch-button')),
  caseCount: /** @type {HTMLElement | null} */ (document.getElementById('case-count')),
  caseList: /** @type {HTMLDivElement | null} */ (document.getElementById('case-list')),
  editorTitle: /** @type {HTMLElement | null} */ (document.getElementById('editor-title')),
  editorMeta: /** @type {HTMLElement | null} */ (document.getElementById('editor-meta')),
  copyAToBButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('copy-a-to-b-button')),
  saveButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('save-button')),
  runBButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('run-b-button')),
  noteInput: /** @type {HTMLInputElement | null} */ (document.getElementById('note-input')),
  promptA: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('prompt-a')),
  outputA: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('output-a')),
  promptB: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('prompt-b')),
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

  if (dom.caseCount) {
    dom.caseCount.textContent = `${state.cases.length} cases`;
  }

  if (state.cases.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact-empty-state';
    empty.textContent = '暂无记录。回到聊天工作台，在 AI 消息旁点击“记录”即可加入错题本。';
    dom.caseList.appendChild(empty);
    return;
  }

  state.cases.forEach((item) => {
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
    meta.textContent = `${formatDateTime(item.createdAt)} · ${item.provider || 'default'}:${item.model || 'default'}${
      item.b && item.b.status ? ` · B=${item.b.status}` : ''
    }`;

    left.append(title, meta);

    const badge = document.createElement('span');
    badge.className = 'mini-badge';
    badge.textContent = item.b && item.b.status ? String(item.b.status) : 'A';

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

  if (!dom.editorMeta || !dom.promptA || !dom.outputA || !dom.promptB || !dom.outputB || !dom.noteInput || !dom.bMeta || !dom.bMetrics) {
    return;
  }

  dom.bMetrics.innerHTML = '';

  if (!item) {
    dom.editorMeta.textContent = '从左侧选择一条记录';
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

  dom.editorMeta.textContent = `${item.id} · ${item.agentName || item.agentId || ''} · ${formatDateTime(item.createdAt)}`;

  dom.noteInput.value = item.note || '';
  dom.promptA.value = item.promptA || '';
  dom.outputA.value = item.outputA || '';
  dom.promptB.value = item.promptB || '';
  dom.outputB.value = item.outputB || '';

  const b = item.b || {};
  const bResult = b.result && typeof b.result === 'object' ? b.result : null;

  if (b && b.status) {
    dom.bMeta.textContent = `${b.status}${b.taskId ? ` · task=${b.taskId}` : ''}${b.runId ? ` · run=${b.runId}` : ''}`;
  } else {
    dom.bMeta.textContent = '尚未运行';
  }

  if (b && b.errorMessage) {
    dom.bMetrics.appendChild(metricChip('error', b.errorMessage));
  }

  if (bResult) {
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
