// Trusted, protocol-neutral per-request coordinator. NO network, credentials,
// provider adapter, Docker or paid approval. A future adapter must validate the
// body/model/settings and independently establish the declared worst-case cost.
// This does not make arbitrary transports safe or turn declarations into proof.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { containsSecretSentinel } from './secrets';
import { modelIdentifier } from './model-identifier';
const digest = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const integer = (v: any, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const exact = (v: any, keys: string[]) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const hash = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function fail(code: string): never { throw Object.assign(Error('model_egress_' + code), { code: 'model_egress_' + code }); }
export interface ModelEgressPolicy {
  approvalId: string; planHash: string; runId: string;
  provider: string; model: string; settingsHash: string; expiresAt: number;
  maxRequests: number; maxRequestBytes: number; maxResponseBytes: number; timeoutMs: number;
  perRequestReserveMicroUsd: number; runLimitMicroUsd: number;
}
function policy(value: any): ModelEgressPolicy {
  if (!exact(value, ['approvalId', 'planHash', 'runId', 'provider', 'model', 'settingsHash', 'expiresAt',
    'maxRequests', 'maxRequestBytes', 'maxResponseBytes', 'timeoutMs', 'perRequestReserveMicroUsd', 'runLimitMicroUsd'])
    || ![value.approvalId, value.provider].every(id) || !modelIdentifier(value.model)
    || ![value.planHash, value.runId, value.settingsHash].every(digest)
    || !integer(value.expiresAt, 1) || !integer(value.maxRequests, 1, 1000)
    || !integer(value.maxRequestBytes, 1, 4 * 1024 * 1024) || !integer(value.maxResponseBytes, 1, 4 * 1024 * 1024)
    || !integer(value.timeoutMs, 1, 300000) || !integer(value.runLimitMicroUsd, 1, 1e12)
    || !integer(value.perRequestReserveMicroUsd, 1, value.runLimitMicroUsd)
    || containsSecretSentinel(JSON.stringify(value))) fail('policy_invalid');
  // Fixed property order: equivalent caller objects bind to the same declaration.
  const { approvalId, planHash, runId, provider, model, settingsHash, expiresAt, maxRequests,
    maxRequestBytes, maxResponseBytes, timeoutMs, perRequestReserveMicroUsd, runLimitMicroUsd } = value;
  return { approvalId, planHash, runId, provider, model, settingsHash, expiresAt, maxRequests,
    maxRequestBytes, maxResponseBytes, timeoutMs, perRequestReserveMicroUsd, runLimitMicroUsd };
}
function location(root: string, runId: string) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !digest(runId)) fail('record_invalid');
  return path.join(root, 'model-egress', runId);
}
function directory(p: string) {
  try { if (fs.lstatSync(p).isDirectory()) return; } catch { /* fixed error, no filesystem details */ }
  fail('record_invalid');
}
function read(p: string): any {
  const st = fs.lstatSync(p, { bigint: true });
  if (!st.isFile() || st.size < 2n || st.size > 4096n) fail('record_invalid');
  const fd = fs.openSync(p, 'r');
  try {
    const s = fs.fstatSync(fd, { bigint: true });
    if (!s.isFile() || s.dev !== st.dev || s.ino !== st.ino || s.size !== st.size) fail('record_invalid');
    const size = Number(st.size); // size bounded above, identity retained as bigint
    const b = Buffer.alloc(size + 1); let n = 0;
    while (n < b.length) { const got = fs.readSync(fd, b, n, b.length - n, n); if (!got) break; n += got; }
    if (n !== size) fail('record_invalid');
    const bytes = b.subarray(0, n), text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) fail('record_invalid');
    return JSON.parse(text);
  } finally { fs.closeSync(fd); }
}
function write(p: string, value: any) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(p, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (JSON.stringify(read(p)) !== JSON.stringify(value)) fail('write_failed');
  } catch { fail('write_failed'); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already failed closed */ } } }
}
const name = (n: number, kind: string) => String(n).padStart(4, '0') + '.' + kind + '.json';
// Diagnostic labels only, never exception text/properties, response data or an
// authority to retry/score/refund. WeakMap avoids reading untrusted getters.
const failureStages = ['https_credential', 'https_connect', 'https_peer', 'https_status', 'https_headers', 'https_body',
  'https_cancelled', 'protocol_request', 'protocol_exchange', 'protocol_collect', 'protocol_decode', 'protocol_response',
  'protocol_response_envelope', // retain legacy records; no retroactive reclassification
  'protocol_response_envelope_keys', 'protocol_response_envelope_id', 'protocol_response_envelope_object',
  'protocol_response_envelope_created', 'protocol_response_envelope_model', 'protocol_response_envelope_fingerprint',
  'protocol_response_envelope_service_tier', 'protocol_response_envelope_choices',
  'protocol_response_choice', // retain old coarse choice records unchanged
  'protocol_response_choice_keys', 'protocol_response_choice_index', 'protocol_response_choice_finish',
  'protocol_response_choice_truncated', 'protocol_response_choice_logprobs', 'protocol_response_choice_message_keys',
  'protocol_response_choice_message_reasoning', 'protocol_response_choice_role', 'protocol_response_choice_content',
  'protocol_response_choice_refusal', 'protocol_response_choice_annotations', 'protocol_response_choice_reasoning_invalid',
  'protocol_response_usage', // retain coarse bounds/arithmetic and old records
  'protocol_response_usage_prompt_details', 'protocol_response_usage_cached_tokens',
  'protocol_response_usage_completion_details', 'protocol_response_usage_reasoning_tokens'] as const;
export type ModelFailureStage = typeof failureStages[number];
const failureLabels = new WeakMap<object, ModelFailureStage>();
export function labelModelFailure(error: Error, stage: ModelFailureStage): Error {
  if (failureStages.includes(stage)) failureLabels.set(error, stage);
  return error;
}
export function modelFailureStage(error: unknown): ModelFailureStage | undefined {
  return ((typeof error === 'object' && error !== null) || typeof error === 'function') ? failureLabels.get(error) : undefined;
}
const statuses = ['completed', 'transport_failed', 'invalid_response', 'cost_unknown', 'cost_limit_exceeded', 'timeout'] as const;
type Status = typeof statuses[number];
interface Reservation { sequence: number; requestId: string; at: number; requestHash: string; requestBytes: number }
interface Result { sequence: number; at: number; status: Status; costMicroUsd: number | null; responseHash: string | null; responseBytes: number | null; failureStage?: ModelFailureStage }
const reasons = [...statuses.filter(s => s !== 'completed'), 'completed', 'driver_failed', 'driver_detached', 'budget_exhausted',
  'request_limit', 'approval_expired', 'clock_invalid'];
function requestId(p: ModelEgressPolicy, n: number) { return hash(JSON.stringify({ policy: p, sequence: n })); }
/** Read-only, no recovery/retry. A reservation may be active or crash-orphaned. */
export function readModelEgress(root: string, runId: string) {
  try {
    const dir = location(root, runId); directory(root); directory(path.dirname(dir)); directory(dir);
    const initial = read(path.join(dir, 'policy.json'));
    if (!exact(initial, ['schemaVersion', 'policy', 'recordedAt']) || initial.schemaVersion !== 1) fail('record_invalid');
    const p = policy(initial.policy);
    if (p.runId !== runId || !integer(initial.recordedAt, 0, p.expiresAt - 1)) fail('record_invalid');
    const names = fs.readdirSync(dir).sort();
    if (names.length > 2002 || names.some(n => !['policy.json', 'finish.json'].includes(n) && !/^\d{4}\.(reserve|result)\.json$/.test(n))) fail('record_invalid');
    const reserves = names.filter(n => n.endsWith('.reserve.json'));
    const rows: (Reservation & { status: 'reserved' | Status; costMicroUsd: number | null; responseHash: string | null; responseBytes: number | null; failureStage?: ModelFailureStage })[] = [];
    let at = initial.recordedAt, stopped: string | null = null;
    for (let i = 0; i < reserves.length; i++) {
      if (stopped || reserves[i] !== name(i + 1, 'reserve') || i >= p.maxRequests
        || (i + 1) * p.perRequestReserveMicroUsd > p.runLimitMicroUsd) fail('record_invalid');
      const r = read(path.join(dir, reserves[i])) as Reservation;
      if (!exact(r, ['sequence', 'requestId', 'at', 'requestHash', 'requestBytes']) || r.sequence !== i + 1
        || r.requestId !== requestId(p, i + 1) || !integer(r.at, at, p.expiresAt - 1)
        || !digest(r.requestHash) || !integer(r.requestBytes, 1, p.maxRequestBytes)) fail('record_invalid');
      at = r.at;
      const row: typeof rows[number] = { ...r, status: 'reserved', costMicroUsd: null, responseHash: null, responseBytes: null };
      if (names.includes(name(i + 1, 'result'))) {
        const s = read(path.join(dir, name(i + 1, 'result'))) as Result;
        if (!exact(s, ['sequence', 'at', 'status', 'costMicroUsd', 'responseHash', 'responseBytes', ...(Object.hasOwn(s, 'failureStage') ? ['failureStage'] : [])])
          || (Object.hasOwn(s, 'failureStage') && (s.status !== 'transport_failed' || !failureStages.includes(s.failureStage!))) || s.sequence !== i + 1
          || !integer(s.at, at) || !statuses.includes(s.status)
          || (s.status !== 'timeout' && s.at >= p.expiresAt)) fail('record_invalid');
        at = s.at;
        if (s.status === 'completed') {
          if (!integer(s.costMicroUsd, 0, p.perRequestReserveMicroUsd) || !digest(s.responseHash)
            || !integer(s.responseBytes, 0, p.maxResponseBytes)) fail('record_invalid');
        } else {
          if (s.responseHash !== null || s.responseBytes !== null) fail('record_invalid');
          if (s.status === 'cost_limit_exceeded') { if (!integer(s.costMicroUsd, p.perRequestReserveMicroUsd + 1, 1e12)) fail('record_invalid'); }
          else if (s.costMicroUsd !== null) fail('record_invalid');
          stopped = s.status;
        }
        Object.assign(row, { status: s.status, costMicroUsd: s.costMicroUsd, responseHash: s.responseHash, responseBytes: s.responseBytes,
          ...(s.failureStage === undefined ? {} : { failureStage: s.failureStage }) });
      } else if (i !== reserves.length - 1) fail('record_invalid');
      rows.push(row);
    }
    if (names.filter(n => n.endsWith('.result.json')).some(n => !names.includes(n.replace('.result.', '.reserve.')))) fail('record_invalid');
    let reason: string | null = null;
    const unresolved = rows.some(r => r.status === 'reserved');
    if (names.includes('finish.json')) {
      const f = read(path.join(dir, 'finish.json'));
      if (!exact(f, ['reason', 'at']) || !integer(f.at, at) || !reasons.includes(f.reason)) fail('record_invalid');
      reason = f.reason;
      if (stopped ? reason !== stopped : statuses.includes(reason as Status) && reason !== 'completed') fail('record_invalid');
      if (reason === 'completed' && unresolved) fail('record_invalid');
      if (reason === 'budget_exhausted' && (rows.length + 1) * p.perRequestReserveMicroUsd <= p.runLimitMicroUsd) fail('record_invalid');
      if (reason === 'request_limit' && rows.length !== p.maxRequests) fail('record_invalid');
      if (reason === 'approval_expired' && f.at < p.expiresAt) fail('record_invalid');
    }
    return { schemaVersion: 1, policy: p, recordedAt: initial.recordedAt,
      state: reason !== null && !unresolved ? 'finished' : 'unresolved', reason, requests: rows,
      committedMicroUsd: rows.length * p.perRequestReserveMicroUsd,
      knownCostMicroUsd: rows.reduce((n, r) => n + (r.costMicroUsd ?? 0), 0),
      unknownCostRequests: rows.filter(r => r.costMicroUsd === null).length,
      paidAuthorization: false, executionVerified: false, strictEvalEligible: false };
  } catch { fail('record_invalid'); }
}
export interface ModelEgressRequest {
  requestId: string; provider: string; model: string; settingsHash: string; body: Buffer; signal: AbortSignal;
}
/**
 * One immutable run claim, single in-flight request, no refunds/retries/restart.
 * Transport must honor AbortSignal; we JOIN it even if it ignores abort. This is
 * not a wall-clock bound, cost guarantee, token counter or network firewall.
 */
export async function dispatchModelEgress(root: string, input: unknown,
  drive: (send: (body: Buffer) => Promise<Buffer>) => Promise<unknown>,
  transport: (request: ModelEgressRequest) => Promise<unknown>) {
  const p = policy(input), dir = location(root, p.runId), recordedAt = Date.now();
  if (!integer(recordedAt, 0, p.expiresAt - 1) || typeof drive !== 'function' || typeof transport !== 'function') fail('policy_invalid');
  directory(root);
  try { fs.mkdirSync(path.dirname(dir), { mode: 0o700 }); }
  catch (e: any) { if (e.code !== 'EEXIST') fail('write_failed'); }
  directory(path.dirname(dir));
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (e: any) { fail(e.code === 'EEXIST' ? 'already_claimed' : 'write_failed'); }
  write(path.join(dir, 'policy.json'), { schemaVersion: 1, policy: p, recordedAt });
  let sequence = 0, lastAt = recordedAt, reason: string | null = null, broken = false, closed = false;
  let pending: Promise<Buffer> | null = null;
  function clock() {
    const now = Date.now();
    if (!integer(now, lastAt)) { reason = 'clock_invalid'; fail('clock_invalid'); }
    lastAt = now;
    if (now >= p.expiresAt) { reason = 'approval_expired'; fail('approval_expired'); }
    return now;
  }
  function persist(file: string, value: any) {
    try { write(path.join(dir, file), value); }
    catch { broken = true; fail('write_failed'); }
  }
  async function perform(body: Buffer) {
    const at = clock();
    if (sequence >= p.maxRequests) { reason = 'request_limit'; fail('request_limit'); }
    if ((sequence + 1) * p.perRequestReserveMicroUsd > p.runLimitMicroUsd) { reason = 'budget_exhausted'; fail('budget_exhausted'); }
    sequence++;
    const reservation: Reservation = { sequence, requestId: requestId(p, sequence), at, requestHash: hash(body), requestBytes: body.length };
    persist(name(sequence, 'reserve'), reservation); clock(); // IO can cross expiry; no dispatch then.
    const controller = new AbortController(), started = performance.now();
    let expired = false, result: any, transportFailed = false, failureStage: ModelFailureStage | undefined;
    const timeout = Math.min(p.timeoutMs, p.expiresAt - lastAt);
    const timer = setTimeout(() => { expired = true; controller.abort(); }, timeout);
    try { result = await transport({ requestId: reservation.requestId, provider: p.provider, model: p.model,
      settingsHash: p.settingsHash, body, signal: controller.signal }); }
    catch (e) { transportFailed = true; failureStage = modelFailureStage(e); }
    finally { clearTimeout(timer); }
    // Timers can be delayed by sync work. Never accept a late success. Do not
    // persist transport exceptions or result bodies (even when malformed).
    const now = Date.now();
    let status: Status, cost: number | null = null, response: Buffer | null = null;
    if (!integer(now, lastAt)) { reason = 'clock_invalid'; fail('clock_invalid'); }
    lastAt = now;
    if (expired || performance.now() - started >= timeout || now >= p.expiresAt) status = 'timeout';
    else if (transportFailed) status = 'transport_failed';
    else {
      // Snapshot untrusted receipt properties once. Accessor/proxy exceptions
      // must not escape and let a driver catch/retry an unsettled reservation.
      try {
        if (!exact(result, ['body', 'costMicroUsd'])) throw Error();
        const bytes = result.body, actualCost = result.costMicroUsd;
        if (!Buffer.isBuffer(bytes) || bytes.length > p.maxResponseBytes
          || !(actualCost === null || integer(actualCost, 0, 1e12))) throw Error();
        if (actualCost === null) status = 'cost_unknown';
        else if (actualCost > p.perRequestReserveMicroUsd) { status = 'cost_limit_exceeded'; cost = actualCost; }
        else { status = 'completed'; cost = actualCost; response = Buffer.from(bytes); }
      } catch { status = 'invalid_response'; cost = null; response = null; }
    }
    if (status !== 'completed') reason = status;
    const receipt: Result = { sequence, at: now, status, costMicroUsd: cost,
      responseHash: response === null ? null : hash(response), responseBytes: response?.length ?? null,
      ...(status === 'transport_failed' && failureStage !== undefined ? { failureStage } : {}) };
    persist(name(sequence, 'result'), receipt);
    if (status !== 'completed') fail(status);
    return response!;
  }
  function send(value: Buffer): Promise<Buffer> {
    if (closed || broken || reason) return Promise.reject(Object.assign(Error('model_egress_stopped'), { code: 'model_egress_stopped' }));
    if (pending) return Promise.reject(Object.assign(Error('model_egress_busy'), { code: 'model_egress_busy' }));
    if (!Buffer.isBuffer(value) || !value.length || value.length > p.maxRequestBytes || containsSecretSentinel(value))
      return Promise.reject(Object.assign(Error('model_egress_request_invalid'), { code: 'model_egress_request_invalid' }));
    // Copy before async dispatch; install pending before invoking trusted code.
    const bytes = Buffer.from(value);
    const task = Promise.resolve().then(() => perform(bytes)); pending = task;
    // Observe detached failures so they cannot become unhandled process errors.
    task.then(() => { if (pending === task) pending = null; }, () => { if (pending === task) pending = null; });
    return task;
  }
  let driverFailed = false;
  try { await drive(send); } catch { driverFailed = true; }
  closed = true;
  const detached = pending !== null;
  if (pending) { try { await pending; } catch { /* reason/broken is sticky */ } }
  if (broken) fail('write_failed'); // do not repair uncertain writes or add finish
  const now = Date.now();
  if (!integer(now, lastAt)) reason ??= 'clock_invalid';
  else lastAt = now;
  // Clock rollback recorded at last observed time, never fabricate a new time.
  persist('finish.json', { reason: reason ?? (driverFailed ? 'driver_failed' : detached ? 'driver_detached' : 'completed'), at: lastAt });
  return readModelEgress(root, p.runId);
}
