// @ts-check

const state = {
  report: null,
  selectedAgentId: null,
};

const shared = window.CaffShared || {};
const fetchJson = shared.fetchJson;

const dom = {
  refreshButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('refresh-button')),
  filterForm: /** @type {HTMLFormElement | null} */ (document.getElementById('filter-form')),
  sinceInput: /** @type {HTMLInputElement | null} */ (document.getElementById('since-input')),
  untilInput: /** @type {HTMLInputElement | null} */ (document.getElementById('until-input')),
  clearFilterButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('clear-filter-button')),
  agentCount: /** @type {HTMLElement | null} */ (document.getElementById('agent-count')),
  agentList: /** @type {HTMLDivElement | null} */ (document.getElementById('agent-list')),
  reportMeta: /** @type {HTMLElement | null} */ (document.getElementById('report-meta')),
  selectedAgentMeta: /** @type {HTMLElement | null} */ (document.getElementById('selected-agent-meta')),
  agentReport: /** @type {HTMLElement | null} */ (document.getElementById('agent-report')),
  toolReport: /** @type {HTMLElement | null} */ (document.getElementById('tool-report')),
  toast: /** @type {HTMLElement | null} */ (document.getElementById('toast')),
};

const toast =
  typeof shared.createToastController === 'function' ? shared.createToastController(dom.toast) : { show() {} };

function showToast(message) {
  toast.show(message);
}

function formatPercent(value, fractionDigits = 1) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return `${(value * 100).toFixed(fractionDigits)}%`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(value) : 'n/a';
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

function selectedReport() {
  return state.report && typeof state.report === 'object' ? state.report : null;
}

function listAgents(report) {
  return Array.isArray(report && report.agents) ? report.agents : [];
}

function listTools(report) {
  return Array.isArray(report && report.tools) ? report.tools : [];
}

function agentById(agentId) {
  const report = selectedReport();
  if (!report) {
    return null;
  }

  return listAgents(report).find((agent) => agent && agent.agentId === agentId) || null;
}

function ensureSelectedAgent() {
  const report = selectedReport();
  const agents = listAgents(report);

  if (state.selectedAgentId && agentById(state.selectedAgentId)) {
    return;
  }

  state.selectedAgentId = agents[0] ? agents[0].agentId : null;
}

function queryFilters() {
  const since = dom.sinceInput ? dom.sinceInput.value : '';
  const until = dom.untilInput ? dom.untilInput.value : '';
  const query = new URLSearchParams();

  if (since) {
    query.set('since', since);
  }

  if (until) {
    query.set('until', until);
  }

  return query;
}

async function refreshReport() {
  if (typeof fetchJson !== 'function') {
    showToast('API client 未加载');
    return;
  }

  const query = queryFilters();
  const url = query.toString() ? `/api/metrics/agent?${query.toString()}` : '/api/metrics/agent';

  const report = await fetchJson(url);
  state.report = report;
  ensureSelectedAgent();
}

function renderAgentList() {
  if (!dom.agentList) {
    return;
  }

  const report = selectedReport();
  const agents = listAgents(report);

  if (dom.agentCount) {
    dom.agentCount.textContent = `${agents.length} agents`;
  }

  dom.agentList.innerHTML = '';

  if (agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact-empty-state';
    empty.textContent = '暂无数据。先在聊天工作台跑几轮 Agent 对话后再来看。';
    dom.agentList.appendChild(empty);
    return;
  }

  agents.forEach((agent) => {
    const item = document.createElement('div');
    item.className = 'agent-list-item compact';
    item.dataset.id = agent.agentId;

    if (agent.agentId === state.selectedAgentId) {
      item.classList.add('active');
    }

    const left = document.createElement('div');
    left.style.display = 'grid';
    left.style.gap = '0.12rem';

    const title = document.createElement('strong');
    title.textContent = agent.agentName ? `${agent.agentName}` : agent.agentId;

    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `turns=${agent.turns} · toolChatRate=${formatPercent(agent.toolChatRate)}`;

    left.append(title, meta);

    const badge = document.createElement('span');
    badge.className = 'mini-badge';
    badge.textContent = formatPercent(agent.toolChatRate, 0);

    item.append(left, badge);

    item.addEventListener('click', () => {
      state.selectedAgentId = agent.agentId;
      renderAll();
    });

    dom.agentList.appendChild(item);
  });
}

function renderMeta() {
  if (!dom.reportMeta) {
    return;
  }

  const report = selectedReport();

  if (!report) {
    dom.reportMeta.textContent = '加载中...';
    return;
  }

  const parts = [
    report.generatedAt ? `Generated: ${formatDateTime(report.generatedAt)}` : '',
    report.since || report.until ? `Range: ${report.since || '-inf'} .. ${report.until || '+inf'}` : 'Range: all',
  ].filter(Boolean);

  dom.reportMeta.textContent = parts.join(' · ');
}

const TOOL_CHAT_RATE_HINT =
  '工具聊天率：turn 维度，public 工具（如 send-public）被调用过的 turn 占比。用于监控 Agent 是否按预期通过工具把最终回复发到聊天室。';
const PRIVATE_TOOL_RATE_HINT =
  '私聊工具率：turn 维度，private 工具被调用过的 turn 占比。用于监控私有输出/私聊指令是否走对通道。';
const SEND_PUBLIC_RECALL_HINT =
  '提示词回归：当 expectations 标记 send-public=required 时，实际调用 public 工具的比例（tp/required）。';
const SEND_PUBLIC_FPR_HINT =
  '提示词回归：当 expectations 标记 send-public=forbidden 时，仍调用 public 工具的比例（fp/forbidden，越低越好）。';
const SEND_PRIVATE_RECALL_HINT =
  '提示词回归：当 expectations 标记 send-private=required 时，实际调用 private 工具的比例（tp/required）。';
const TOOL_SUMMARY_HINT =
  'successRate：工具调用成功率（更多用于定位工具链路稳定性/参数问题）。p50/p95：工具耗时分位数，用于定位慢工具、超时与重试。';

function metricChip(label, value, hint = '') {
  const chip = document.createElement('span');
  chip.className = 'file-chip';
  chip.textContent = `${label}: ${value}`;

  if (hint) {
    chip.title = hint;
  }

  return chip;
}

function renderSelectedAgent() {
  if (!dom.agentReport || !dom.selectedAgentMeta) {
    return;
  }

  const report = selectedReport();
  const agents = listAgents(report);

  dom.agentReport.innerHTML = '';

  if (agents.length === 0) {
    dom.selectedAgentMeta.textContent = '暂无数据';
    return;
  }

  const agent = state.selectedAgentId ? agentById(state.selectedAgentId) : null;

  if (!agent) {
    dom.selectedAgentMeta.textContent = '从左侧选择一个 Agent';
    return;
  }

  dom.selectedAgentMeta.textContent = `${agent.agentId}${agent.agentName ? ` · ${agent.agentName}` : ''}`;

  dom.agentReport.append(
    metricChip('turns', formatNumber(agent.turns), '统计时间范围内，该 Agent 产生的 assistant turn 数（记录条数）。'),
    metricChip('toolChatRate', formatPercent(agent.toolChatRate), TOOL_CHAT_RATE_HINT),
    metricChip('privateToolRate', formatPercent(agent.privateToolRate), PRIVATE_TOOL_RATE_HINT),
    metricChip('send-public recall', formatPercent(agent.sendPublic && agent.sendPublic.recall), SEND_PUBLIC_RECALL_HINT),
    metricChip('send-public fpr', formatPercent(agent.sendPublic && agent.sendPublic.falsePositiveRate), SEND_PUBLIC_FPR_HINT),
    metricChip('send-private recall', formatPercent(agent.sendPrivate && agent.sendPrivate.recall), SEND_PRIVATE_RECALL_HINT),
    metricChip(
      'missingExpectations',
      formatNumber(agent.missingExpectations),
      '缺失 expectations 的 turn 数：这些 turn 无法计算 send-public/send-private 回归指标。'
    ),
    metricChip('public posts', formatNumber(agent.publicPostCount), '统计范围内 public 工具调用次数（按 post 计数，不是 turn）。'),
    metricChip('private posts', formatNumber(agent.privatePostCount), '统计范围内 private 工具调用次数（按 post 计数，不是 turn）。'),
    metricChip('private handoffs', formatNumber(agent.privateHandoffCount), '统计范围内 private handoff 次数。')
  );
}

function renderToolReport() {
  if (!dom.toolReport) {
    return;
  }

  const report = selectedReport();
  const tools = listTools(report);

  dom.toolReport.innerHTML = '';

  if (tools.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '暂无工具调用记录。';
    dom.toolReport.appendChild(empty);
    return;
  }

  tools.slice(0, 18).forEach((tool) => {
    const label = tool.tool || 'unknown';
    const summary = `ok=${tool.succeeded}/${tool.calls} · success=${formatPercent(tool.successRate, 0)} · p50=${formatNumber(tool.p50Ms)}ms · p95=${formatNumber(tool.p95Ms)}ms`;
    dom.toolReport.appendChild(metricChip(label, summary, TOOL_SUMMARY_HINT));
  });
}

function renderAll() {
  renderMeta();
  renderAgentList();
  renderSelectedAgent();
  renderToolReport();
}

async function bootstrap() {
  try {
    await refreshReport();
    renderAll();
  } catch (error) {
    showToast(error && error.message ? error.message : '加载报表失败');
    renderAll();
  }
}

if (dom.refreshButton) {
  dom.refreshButton.addEventListener('click', () => {
    bootstrap();
  });
}

if (dom.filterForm) {
  dom.filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    bootstrap();
  });
}

if (dom.clearFilterButton) {
  dom.clearFilterButton.addEventListener('click', () => {
    if (dom.sinceInput) {
      dom.sinceInput.value = '';
    }
    if (dom.untilInput) {
      dom.untilInput.value = '';
    }
    bootstrap();
  });
}

bootstrap();
