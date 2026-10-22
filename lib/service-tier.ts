// Closed projections only: never persist provider bodies, credentials, error
// text, arbitrary catalog data, or an execution tier inferred from token cost.
const STATUSES = new Set(['requested', 'disabled', 'out_of_scope', 'unsupported', 'error']);
const SUPPORT_SOURCES = new Set(['catalog', 'allowlist', 'out_of_scope', 'account_changed']);
const LABELS: Record<string, string> = {
  requested: 'Fast 已请求 · 执行未确认',
  disabled: 'Fast 关闭',
  out_of_scope: 'Fast 未请求 · 通道不适用',
  unsupported: 'Fast 未请求 · 模型不支持',
  error: 'Fast 未请求 · 注入异常',
};

export function normalizeServiceTierRequest(value: any) {
  if (!value || typeof value !== 'object' || !STATUSES.has(value.status)) return null;
  if (value.status === 'requested' && value.serviceTierRequested !== 'priority') return null;
  const supportSource = SUPPORT_SOURCES.has(value.supportSource) ? String(value.supportSource) : null;
  return {
    status: String(value.status),
    supportSource,
    serviceTierRequested: value.status === 'requested' ? 'priority' : null,
    // pi-ai 0.85.1 exposes neither response tier nor a reliable cost side channel.
    serviceTierObserved: null,
    executionConfirmed: false,
    label: LABELS[value.status],
    detail: `请求前钩子：${value.status}；支持判定：${supportSource || '未探测'}。注入记录不证明送达、接受或后端执行档位；成本沿用 pi-ai 估算，不代表订阅用量。`,
  };
}

export function createServiceTierState(configured: any = false) {
  return {
    configured: configured === true,
    requestCount: 0,
    priorityRequestCount: 0,
    skippedRequestCount: 0,
    errorCount: 0,
    supportSources: new Set<string>(),
    lastRequest: null as ReturnType<typeof normalizeServiceTierRequest>,
  };
}

export function recordServiceTierRequest(state: ReturnType<typeof createServiceTierState>, value: any) {
  const request = normalizeServiceTierRequest(value);
  if (!request) return null;
  state.requestCount += 1;
  if (request.serviceTierRequested === 'priority') state.priorityRequestCount += 1;
  else state.skippedRequestCount += 1;
  if (request.status === 'error') state.errorCount += 1;
  if (request.supportSource) state.supportSources.add(request.supportSource);
  state.lastRequest = request;
  return request;
}

export function normalizeServiceTierSummary(value: any) {
  if (!value || value.schemaVersion !== 1 || typeof value.configured !== 'boolean') return null;
  const counts = ['requestCount', 'priorityRequestCount', 'skippedRequestCount', 'errorCount'];
  if (counts.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
  if (value.requestCount !== value.priorityRequestCount + value.skippedRequestCount || value.errorCount > value.skippedRequestCount) return null;
  const supportSources = [...new Set<string>((Array.isArray(value.supportSources) ? value.supportSources : [])
    .filter((source: any) => SUPPORT_SOURCES.has(source)))].sort();
  const lastRequest = normalizeServiceTierRequest(value.lastRequest);
  const label = value.requestCount === 0
    ? value.configured ? 'Fast 已配置 · 尚未请求' : 'Fast 关闭 · 尚未请求'
    : value.priorityRequestCount > 0
      ? value.skippedRequestCount > 0 ? 'Fast 部分请求 · 执行未确认' : LABELS.requested
      : lastRequest?.label || 'Fast 未请求';
  return {
    schemaVersion: 1,
    configured: value.configured,
    requestCount: value.requestCount,
    priorityRequestCount: value.priorityRequestCount,
    skippedRequestCount: value.skippedRequestCount,
    errorCount: value.errorCount,
    supportSources,
    lastRequest,
    serviceTierRequested: value.priorityRequestCount > 0 ? 'priority' : null,
    serviceTierObserved: null,
    executionConfirmed: false,
    label,
    detail: `配置：${value.configured ? '开启' : '关闭'}；请求前钩子 ${value.requestCount} 次，priority ${value.priorityRequestCount} 次，未注入 ${value.skippedRequestCount} 次，异常 ${value.errorCount} 次；支持判定：${supportSources.join(', ') || '未探测'}。不含传输重试次数，不证明后端执行档位；成本沿用 pi-ai 估算，不代表订阅用量。`,
  };
}

export function snapshotServiceTier(state: ReturnType<typeof createServiceTierState>) {
  // Counts are before_provider_request invocations (including compaction), not
  // wire attempts: transport retries reuse the post-hook body.
  return normalizeServiceTierSummary({ schemaVersion: 1, ...state, supportSources: [...state.supportSources] })!;
}
