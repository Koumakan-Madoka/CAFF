// Trusted host-only safety controller. It does not load credentials, invoke a
// model, discover config, retry, or publish formal gate/test evidence. Adapters
// must wrap EACH actual worker/judge exchange, not an entire agent turn, and
// propagate its signal to their transport. One exchange must never hide retries.
// Token limits are reported-usage STOP LINES, not predicted billing hard caps:
// a single approved request can cross a line; no subsequent request may start.
const fs = require('node:fs'), path = require('node:path');
const { wikiValueHash } = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric');
const fail = code => Object.assign(Error(code), { code });
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k))
    || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw fail('wiki_precheck_budget_invalid');
}
function approval(value) {
  const { planHash, limits, stopFile } = value;
  if (typeof planHash !== 'string' || !/^[a-f0-9]{64}$/.test(planHash) || typeof stopFile !== 'string' || !path.isAbsolute(stopFile)) throw fail('wiki_precheck_budget_invalid');
  exact(limits, ['maxRequests', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens', 'maxDurationMs']);
  if (Object.values(limits).some(v => !Number.isSafeInteger(v) || v < 1) || limits.maxRequests > 4096 || limits.maxDurationMs > 10800000) throw fail('wiki_precheck_budget_invalid');
  return { kind: 'wiki-original-precheck-approval-v1', planHash, limits: structuredClone(limits), stopFile: path.resolve(stopFile) };
}
function precheckApprovalHash(value) {
  exact(value, ['planHash', 'limits', 'stopFile'], ['confirmed', 'approvalHash']);
  return wikiValueHash(approval(value));
}
function measuredUsage(value) {
  if (!value || !FIELDS.every(k => Number.isSafeInteger(value[k]) && value[k] >= 0)) return null;
  const total = value.input + value.output + value.cacheRead + value.cacheWrite;
  if (!Number.isSafeInteger(total) || total !== value.totalTokens) return null;
  return Object.fromEntries(FIELDS.map(k => [k, value[k]]));
}
function createPrecheckBudget(value, dependencies = {}) {
  exact(value, ['planHash', 'limits', 'stopFile', 'confirmed', 'approvalHash']);
  const fixed = approval(value), expected = precheckApprovalHash(value);
  // No listeners/timers, auth reads, reservation or exchange before confirmation.
  // This is an operator acknowledgement bound to the exact plan and limits, not
  // cryptographic proof of user consent; the trusted CLI is responsible for it.
  if (value.confirmed !== true || value.approvalHash !== expected) throw fail('wiki_precheck_confirmation_required');
  const limits = fixed.limits, now = dependencies.now || (() => performance.now()), events = dependencies.events || process;
  const stat = dependencies.stat || fs.lstatSync, repeat = dependencies.setInterval || setInterval, cancel = dependencies.clearInterval || clearInterval;
  const started = now(), controller = new AbortController(), requests = [], totals = Object.fromEntries(FIELDS.map(k => [k, 0]));
  let reason = null, closed = false, busy = false, unknown = 0;
  function stop(code) { reason ??= code; controller.abort(); }
  function record(event) {
    try { dependencies.onEvent?.(structuredClone({ ...event, approvalHash: expected })); }
    catch { stop('evidence_write_failed'); throw fail('wiki_precheck_evidence_write_failed'); }
  }
  function check() {
    if (reason) return false;
    if (closed) stop('closed');
    else if (now() - started >= limits.maxDurationMs) stop('time_limit');
    else {
      try { stat(fixed.stopFile); stop('operator_stop'); }
      catch (e) { if (e.code !== 'ENOENT') stop('stop_check_failed'); }
    }
    return !reason;
  }
  const interrupt = () => stop('operator_interrupted');
  events.on('SIGINT', interrupt);
  const timer = repeat(check, 100); timer.unref?.();
  function tokenStops() {
    if (totals.input + totals.cacheRead + totals.cacheWrite >= limits.maxInputTokens) stop('input_token_limit');
    else if (totals.output >= limits.maxOutputTokens) stop('output_token_limit');
    else if (totals.totalTokens >= limits.maxTotalTokens) stop('total_token_limit');
    else if (requests.length >= limits.maxRequests) stop('request_limit');
  }
  return {
    check,
    signal: controller.signal,
    snapshot() {
      return structuredClone({ planHash: fixed.planHash, limits, approvalHash: expected, requests: requests.length, workerRequests: requests.filter(r => r.kind === 'worker').length,
        judgeRequests: requests.filter(r => r.kind === 'judge').length, unknownRequests: unknown, inFlight: busy,
        knownUsage: totals, usageComplete: requests.length > 0 && !busy && unknown === 0, reason,
        elapsedMs: Math.max(0, now() - started), exchanges: requests });
    },
    async request(kind, send, measure) {
      if (!['worker', 'judge'].includes(kind) || typeof send !== 'function' || typeof measure !== 'function') throw fail('wiki_precheck_budget_invalid');
      if (!check()) throw fail('wiki_precheck_stopped');
      if (busy) throw fail('wiki_precheck_request_busy');
      if (requests.length >= limits.maxRequests) { stop('request_limit'); throw fail('wiki_precheck_stopped'); }
      busy = true;
      const row = { index: requests.length + 1, kind, status: 'pending', usage: null }; requests.push(row);
      let recordedFinish = false;
      try {
        // A caller's durable writer (fsync before returning) can fail closed
        // BEFORE network. This event intentionally contains no model content.
        record({ event: 'request_reserved', index: row.index, kind });
        if (!check()) throw fail('wiki_precheck_stopped');
        // Do not race an abort with settlement: the transport must be cancelled
        // and awaited; a cancelled/unknown request must not become zero usage.
        const result = await send(controller.signal), usage = measuredUsage(measure(result));
        if (!usage || FIELDS.some(k => !Number.isSafeInteger(totals[k] + usage[k]))) {
          row.status = 'unknown'; unknown++; stop('usage_unknown');
        } else {
          row.status = 'known'; row.usage = usage;
          for (const k of FIELDS) totals[k] += usage[k];
          check(); tokenStops();
        }
        recordedFinish = true; record({ event: 'request_finished', ...row, reason });
        return result; // Caller retains raw (already redacted) evidence separately.
      } catch {
        if (row.status === 'pending') { row.status = 'unknown'; unknown++; }
        stop('usage_unknown');
        if (!recordedFinish) { try { record({ event: 'request_finished', ...row, reason }); } catch {} }
        // Never surface external exception messages, paths, bodies or credentials.
        throw fail('wiki_precheck_exchange_failed');
      } finally { busy = false; }
    },
    close() {
      if (closed) return;
      closed = true; cancel(timer); events.removeListener('SIGINT', interrupt);
      if (busy) stop('closed');
    },
  };
}
module.exports = { precheckApprovalHash, createPrecheckBudget };
