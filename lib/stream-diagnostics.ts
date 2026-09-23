// A content-free projection of parent-observed IPC, never a liveness policy.
export const DIAGNOSTIC_LIMITS = Object.freeze({
  recentEvents: 32,
  scanCodeUnits: 4096,
  eventKinds: 48,
  snapshotBytes: 32768,
  intervalMs: 30000,
  minIntervalMs: 1000,
});
const EVENTS = new Set([
  'agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  'bash_execution_start', 'bash_execution_update', 'bash_execution_end',
  'auto_retry_start', 'auto_retry_end', 'auto_compaction_start', 'auto_compaction_end',
  'queue_update',
]);
const UPDATES = new Set([
  'start', 'text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta',
  'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done', 'error',
]);
const REASONS = new Set(['initial', 'pi_event', 'recovery_request', 'recovery_started']);
const add = (a: number, b = 1) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const whitespace = /\s/u;
type Phase = 'waiting' | 'unknown' | 'thinking' | 'output' | 'tool';

export class StreamDiagnostics {
  private phase: Phase = 'waiting';
  private phaseSince: number;
  private lastPiEventAt: number | null = null;
  private lastDeltaAt: number | null = null;
  private lastNonWhitespaceAt: number | null = null;
  private maxPiEventGapMs = 0;
  private lastRefreshAt: number | null = null;
  private lastRefreshReason: string | null = null;
  private lastHeartbeatAt: number | null = null;
  private heartbeatCount = 0;
  private eventCount = 0;
  private eventCounts: Record<string, number> = {};
  private refreshCounts: Record<string, number> = {};
  private recent: Array<Record<string, any>> = [];
  private delta = { count: 0, empty: 0, whitespaceOnly: 0, codeUnits: 0, scannedCodeUnits: 0, nonWhitespaceCodeUnits: 0, unscannedCodeUnits: 0 };

  constructor(private startedAt: number) { this.phaseSince = startedAt; }

  private push(record: Record<string, any>) {
    if (this.recent.length === DIAGNOSTIC_LIMITS.recentEvents) this.recent.shift();
    this.recent.push(record);
  }

  observe(event: any, at: number) {
    // Never stringify arbitrary values or keep labels supplied by a provider/tool.
    const outer = typeof event?.type === 'string' && event.type.length <= 40 ? event.type : '';
    const update = typeof event?.assistantMessageEvent?.type === 'string' && event.assistantMessageEvent.type.length <= 40 ? event.assistantMessageEvent.type : '';
    const type = outer === 'message_update'
      ? `message_update:${UPDATES.has(update) ? update : 'other'}`
      : EVENTS.has(outer) ? outer : 'other';
    this.eventCount = add(this.eventCount);
    this.eventCounts[type] = add(this.eventCounts[type] || 0);
    if (this.lastPiEventAt !== null) this.maxPiEventGapMs = Math.max(this.maxPiEventGapMs, Math.max(0, at - this.lastPiEventAt));
    this.lastPiEventAt = at;
    let phase = this.phase;
    if (outer === 'message_start' && event.message?.role === 'assistant') phase = 'unknown';
    if (outer === 'agent_start' || outer === 'auto_retry_start') phase = 'waiting';
    if (['agent_end', 'turn_end', 'message_end', 'auto_retry_end', 'tool_execution_end', 'bash_execution_end', 'auto_compaction_start', 'auto_compaction_end'].includes(outer)) phase = 'unknown';
    if (['tool_execution_start', 'tool_execution_update', 'bash_execution_start', 'bash_execution_update'].includes(outer)) phase = 'tool';
    if (outer === 'message_update') {
      if (['thinking_start', 'thinking_delta'].includes(update)) phase = 'thinking';
      else if (['text_start', 'text_delta', 'toolcall_start', 'toolcall_delta'].includes(update)) phase = 'output';
      else if (['thinking_end', 'text_end', 'toolcall_end', 'done', 'error'].includes(update)) phase = 'unknown';
    }
    if (phase !== this.phase) { this.phase = phase; this.phaseSince = at; }
    const record: Record<string, any> = { at, type, phase: this.phase };
    if (outer === 'message_update' && ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(update)) {
      const text = event.assistantMessageEvent.delta;
      if (typeof text === 'string') {
        const length = text.length;
        const scanned = Math.min(length, DIAGNOSTIC_LIMITS.scanCodeUnits);
        let nonWhitespace = 0;
        for (let i = 0; i < scanned; i++) if (!whitespace.test(text[i])) nonWhitespace++;
        this.delta.count = add(this.delta.count);
        this.delta.codeUnits = add(this.delta.codeUnits, length);
        this.delta.scannedCodeUnits = add(this.delta.scannedCodeUnits, scanned);
        this.delta.nonWhitespaceCodeUnits = add(this.delta.nonWhitespaceCodeUnits, nonWhitespace);
        this.delta.unscannedCodeUnits = add(this.delta.unscannedCodeUnits, length - scanned);
        if (!length) this.delta.empty = add(this.delta.empty);
        if (length > 0 && scanned === length && !nonWhitespace) this.delta.whitespaceOnly = add(this.delta.whitespaceOnly);
        this.lastDeltaAt = at;
        if (nonWhitespace > 0) this.lastNonWhitespaceAt = at;
        Object.assign(record, { codeUnits: length, scannedCodeUnits: scanned, nonWhitespaceCodeUnits: nonWhitespace });
      }
    }
    this.push(record);
  }

  refresh(reason: string, at: number) {
    if (!REASONS.has(reason)) return;
    this.lastRefreshAt = at;
    this.lastRefreshReason = reason;
    this.refreshCounts[reason] = add(this.refreshCounts[reason] || 0);
    this.push({ at, type: 'progress_refresh', reason });
  }

  heartbeat(at: number) {
    this.lastHeartbeatAt = at;
    this.heartbeatCount = add(this.heartbeatCount);
  }

  snapshot(at: number) {
    return {
      version: 1, startedAt: this.startedAt, capturedAt: at,
      phase: this.phase, phaseSince: this.phaseSince,
      lastPiEventAt: this.lastPiEventAt, lastDeltaAt: this.lastDeltaAt,
      lastNonWhitespaceAt: this.lastNonWhitespaceAt, maxPiEventGapMs: this.maxPiEventGapMs,
      lastRefreshAt: this.lastRefreshAt, lastRefreshReason: this.lastRefreshReason,
      lastHeartbeatAt: this.lastHeartbeatAt, heartbeatCount: this.heartbeatCount,
      eventCount: this.eventCount, eventCounts: { ...this.eventCounts }, refreshCounts: { ...this.refreshCounts },
      delta: { ...this.delta }, recent: this.recent.map(record => ({ ...record })),
    };
  }
}
