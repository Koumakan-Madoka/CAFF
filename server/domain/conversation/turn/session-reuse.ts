const { summarizeTokenUsage } = require('../../runtime/token-usage');

const DEFAULT_REUSE_MAX_USAGE_RATIO = 0.5;
const DEFAULT_REUSE_MAX_IDLE_MS = 60 * 60 * 1000;
const DEFAULT_REUSE_BUSY_STALE_MS = 2 * 60 * 60 * 1000;

function normalizeBooleanFlag(value: any) {
  const normalized = String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeRatio(value: any, fallback: number) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return fallback;
  }

  return parsed;
}

function normalizePositiveInteger(value: any, fallback: number) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

// Phase 1: reuse is a pure optimization behind a flag that defaults OFF. Any
// uncertainty in the decision path falls back to the legacy behavior (fresh
// session + full history injection).
export function resolveSessionReuseConfig(env: any = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  return {
    enabled: normalizeBooleanFlag(source.PI_CHAT_SESSION_REUSE_ENABLED),
    maxUsageRatio: normalizeRatio(source.PI_CHAT_SESSION_REUSE_MAX_USAGE_RATIO, DEFAULT_REUSE_MAX_USAGE_RATIO),
    maxIdleMs: normalizePositiveInteger(source.PI_CHAT_SESSION_REUSE_MAX_IDLE_MS, DEFAULT_REUSE_MAX_IDLE_MS),
    busyStaleMs: normalizePositiveInteger(source.PI_CHAT_SESSION_REUSE_BUSY_STALE_MS, DEFAULT_REUSE_BUSY_STALE_MS),
  };
}

export function resolveSessionReuseContextWindow(modelCatalog: any, provider: any, model: any) {
  const options =
    modelCatalog && typeof modelCatalog.getOptions === 'function'
      ? modelCatalog.getOptions()
      : Array.isArray(modelCatalog)
        ? modelCatalog
        : [];
  const normalizedProvider = String(provider || '').trim();
  const normalizedModel = String(model || '').trim();

  if (!normalizedProvider || !normalizedModel) {
    return null;
  }

  for (const option of options) {
    if (!option || String(option.provider || '').trim() !== normalizedProvider) {
      continue;
    }
    if (String(option.model || '').trim() !== normalizedModel) {
      continue;
    }
    const contextWindow = Number(option.contextWindow);
    return Number.isInteger(contextWindow) && contextWindow > 0 ? contextWindow : null;
  }

  return null;
}

// The reuse ratio is based on the LAST assistant call's input tokens (≈ current
// session context size), not an aggregate over the run.
export function extractLastCallInputTokens(usageCalls: any) {
  const calls = Array.isArray(usageCalls) ? usageCalls : [];

  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    const rawUsage = call && typeof call.usage === 'object' && !Array.isArray(call.usage) ? call.usage : call;
    const tokenUsage = summarizeTokenUsage(rawUsage);

    if (tokenUsage && tokenUsage.inputTokens !== null && tokenUsage.inputTokens !== undefined) {
      return tokenUsage.inputTokens;
    }
  }

  return null;
}

function normalizeOrderedMessages(messages: any) {
  return (Array.isArray(messages) ? messages : []).filter((message: any) =>
    Boolean(message && String(message.id || '').trim())
  );
}

export function buildSessionReuseCursorSnapshot(messages: any) {
  const ordered = normalizeOrderedMessages(messages);

  if (ordered.length === 0) {
    return null;
  }

  let maxUpdatedAt = '';
  for (const message of ordered) {
    const updatedAt = String(message.updatedAt || message.createdAt || '');
    if (updatedAt > maxUpdatedAt) {
      maxUpdatedAt = updatedAt;
    }
  }

  return {
    cursorMessageId: String(ordered[ordered.length - 1].id),
    cursorMessageCount: ordered.length,
    cursorFirstMessageId: String(ordered[0].id),
    cursorMaxUpdatedAt: maxUpdatedAt || null,
  };
}

export function partitionMessagesAtCursor(messages: any, cursorMessageId: any) {
  const ordered = normalizeOrderedMessages(messages);
  const cursorId = String(cursorMessageId || '').trim();

  if (!cursorId) {
    return null;
  }

  const cursorIndex = ordered.findIndex((message: any) => String(message.id) === cursorId);

  if (cursorIndex === -1) {
    return null;
  }

  return {
    upToCursor: ordered.slice(0, cursorIndex + 1),
    delta: ordered.slice(cursorIndex + 1),
  };
}

// Cheap consistency proof that the history already injected into the cached
// session was not edited or deleted afterwards. Any mismatch means the provider
// session now contains content that no longer matches the room truth and can
// never be corrected, so the session must be poisoned instead of reused.
export function verifySessionReuseCursor(row: any, messages: any) {
  const partition = partitionMessagesAtCursor(messages, row && row.cursorMessageId);

  if (!partition) {
    return { ok: false, reason: 'cursor_message_missing' };
  }

  const expectedCount = Number.isInteger(row.cursorMessageCount) ? row.cursorMessageCount : 0;
  if (partition.upToCursor.length !== expectedCount) {
    return { ok: false, reason: 'cursor_count_mismatch' };
  }

  const firstMessageId = partition.upToCursor.length > 0 ? String(partition.upToCursor[0].id) : null;
  if ((row.cursorFirstMessageId || null) !== firstMessageId) {
    return { ok: false, reason: 'cursor_first_message_mismatch' };
  }

  let maxUpdatedAt = '';
  for (const message of partition.upToCursor) {
    const updatedAt = String(message.updatedAt || message.createdAt || '');
    if (updatedAt > maxUpdatedAt) {
      maxUpdatedAt = updatedAt;
    }
  }

  if ((row.cursorMaxUpdatedAt || null) !== (maxUpdatedAt || null)) {
    return { ok: false, reason: 'cursor_history_mutated' };
  }

  return { ok: true, reason: '', delta: partition.delta };
}

export function isSessionReuseBusyStale(row: any, config: any, now: any) {
  if (!row || row.state !== 'busy') {
    return false;
  }

  const updatedAtMs = Date.parse(String(row.updatedAt || ''));
  const nowMs = Date.parse(String(now || ''));

  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) {
    return true;
  }

  return nowMs - updatedAtMs > config.busyStaleMs;
}

// Pure decision over an already-loaded row. Returns { reuse, reason, delta? };
// callers persist side effects (claim / poison) after consulting this result.
export function evaluateSessionReuse({ row, staticSegmentHash, config, now, messages }: any) {
  if (!row) {
    return { reuse: false, reason: 'no_prior_session' };
  }

  if (row.state === 'poisoned') {
    return { reuse: false, reason: 'poisoned' };
  }

  if (row.state === 'busy') {
    return { reuse: false, reason: 'busy' };
  }

  if (row.state !== 'reusable') {
    return { reuse: false, reason: 'unknown_state' };
  }

  if (!row.sessionName || !row.sessionPath) {
    return { reuse: false, reason: 'session_reference_missing' };
  }

  if (!row.staticSegmentHash || row.staticSegmentHash !== staticSegmentHash) {
    return { reuse: false, reason: 'static_hash_mismatch' };
  }

  if (row.usageRatio === null || row.usageRatio === undefined) {
    return { reuse: false, reason: 'usage_snapshot_missing' };
  }

  if (row.usageRatio >= config.maxUsageRatio) {
    return { reuse: false, reason: 'usage_ratio_above_threshold' };
  }

  const lastReplyMs = Date.parse(String(row.lastReplyAt || ''));
  const nowMs = Date.parse(String(now || ''));

  if (!Number.isFinite(lastReplyMs) || !Number.isFinite(nowMs)) {
    return { reuse: false, reason: 'last_reply_timestamp_missing' };
  }

  if (nowMs - lastReplyMs > config.maxIdleMs) {
    return { reuse: false, reason: 'idle_timeout' };
  }

  const cursorCheck = verifySessionReuseCursor(row, messages);

  if (!cursorCheck.ok) {
    return { reuse: false, reason: cursorCheck.reason, poison: true };
  }

  if (!cursorCheck.delta || cursorCheck.delta.length === 0) {
    return { reuse: false, reason: 'no_delta_messages' };
  }

  return { reuse: true, reason: 'reused', delta: cursorCheck.delta };
}
