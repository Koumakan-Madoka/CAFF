// Trusted internal coordinator, NOT a human-authentication or paid-launch API.
// The executor is injected trusted code; this module neither launches pi nor
// verifies Docker/egress/scorer evidence. Records contain no raw model output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { planEvaluation, createEvaluationLedger } from './evaluation-plan';

const exact = (v: any, keys: string[]) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
function fail(code: string): never { throw Object.assign(Error(code), { code }); }
function canonical(v: any): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const time = (v: any) => Number.isSafeInteger(v) && v >= 0;
function wallClock(min: number) {
  const at = Date.now();
  if (!time(at) || at < min) fail('evaluation_clock_invalid');
  return at;
}
function location(root: string, id: string) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id)) fail('evaluation_record_invalid');
  return path.join(root, 'evaluations', crypto.createHash('sha256').update(id).digest('hex'));
}
function directory(dir: string) {
  if (!fs.lstatSync(dir).isDirectory()) fail('evaluation_record_invalid');
}
function readJson(file: string, limit = 65536): any {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.size < 2n || stat.size > BigInt(limit)) fail('evaluation_record_invalid');
  const fd = fs.openSync(file, 'r');
  try {
    const actual = fs.fstatSync(fd, { bigint: true });
    if (!actual.isFile() || actual.size !== stat.size || actual.ino !== stat.ino || actual.dev !== stat.dev) fail('evaluation_record_invalid');
    const size = Number(stat.size); // bounded size only, never round device/inode identity
    const bytes = Buffer.alloc(size + 1); let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!n) break;
      length += n;
    }
    if (length !== size) fail('evaluation_record_invalid');
    const data = bytes.subarray(0, length), text = data.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(data)) fail('evaluation_record_invalid');
    return JSON.parse(text);
  } finally { fs.closeSync(fd); }
}
function writeJson(file: string, value: any, exclusiveCode = 'evaluation_record_write_failed') {
  let fd: number;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error: any) { fail(error?.code === 'EEXIST' ? exclusiveCode : 'evaluation_record_write_failed'); }
  try {
    fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd);
  } catch { fail('evaluation_record_write_failed'); }
  finally { try { fs.closeSync(fd); } catch { fail('evaluation_record_write_failed'); } }
  // Partial writes and unacknowledged fsync stay in place. Never remove a claim,
  // truncate a journal, or infer that an unacknowledged dispatch did not occur.
}
type Ledger = ReturnType<typeof createEvaluationLedger>;
type Plan = ReturnType<typeof planEvaluation>;
type Event = { kind: 'reserve'; at: number } | { kind: 'result'; at: number; result: unknown }
  | { kind: 'finish'; at: number; reason: 'complete' | 'stopped' | 'approval_expired' | 'dispatch_failed' | 'invalid_result' };
interface Stored {
  schemaVersion: 1; recordedAt: number; spec: Plan['spec'];
  approval: { confirmed: true; planHash: string; approvalId: string; expiresAt: number };
}
interface Loaded {
  record: Stored; plan: Plan; ledger: Ledger; claimed: boolean; lastAt: number;
  count: number; finish: Extract<Event, { kind: 'finish' }> | null;
}
function load(dir: string, id: string): Loaded {
  try {
    directory(path.dirname(dir)); directory(dir);
    const record = readJson(path.join(dir, 'approval.json')) as Stored;
    if (!exact(record, ['schemaVersion', 'recordedAt', 'spec', 'approval']) || record.schemaVersion !== 1
      || !time(record.recordedAt) || record.approval?.approvalId !== id) fail('evaluation_record_invalid');
    const plan = planEvaluation(record.spec), ledger = createEvaluationLedger(plan, record.approval, record.recordedAt);
    const names = fs.readdirSync(dir).sort();
    if (names.length > 404 || names.some(n => n !== 'approval.json' && n !== 'claim.json' && !/^\d{4}\.json$/.test(n))) fail('evaluation_record_invalid');
    const claimed = names.includes('claim.json'); let lastAt = record.recordedAt;
    if (claimed) {
      const claim = readJson(path.join(dir, 'claim.json'), 1024);
      if (!exact(claim, ['planHash', 'at']) || claim.planHash !== plan.planHash || !time(claim.at) || claim.at < lastAt) fail('evaluation_record_invalid');
      lastAt = claim.at;
    }
    const events = names.filter(n => /^\d{4}\.json$/.test(n));
    if (events.length && !claimed) fail('evaluation_record_invalid');
    let finish: Loaded['finish'] = null;
    for (let i = 0; i < events.length; i++) {
      if (finish || events[i] !== eventName(i + 1)) fail('evaluation_record_invalid');
      const e = readJson(path.join(dir, events[i]), 4096) as Event;
      if (!time(e?.at) || e.at < lastAt) fail('evaluation_record_invalid');
      lastAt = e.at;
      if (e.kind === 'reserve' && exact(e, ['kind', 'at'])) ledger.reserve(e.at);
      else if (e.kind === 'result' && exact(e, ['kind', 'at', 'result'])) ledger.settle(e.result);
      else if (e.kind === 'finish' && exact(e, ['kind', 'at', 'reason'])) {
        const report = ledger.report();
        const valid = e.reason === 'complete' ? report.state === 'complete'
          : e.reason === 'stopped' ? report.state === 'stopped'
          : e.reason === 'approval_expired' ? e.at >= record.approval.expiresAt && ['ready', 'reserved', 'stopped'].includes(report.state)
          : ['dispatch_failed', 'invalid_result'].includes(e.reason) && report.state === 'reserved';
        if (!valid) fail('evaluation_record_invalid');
        finish = e;
      } else fail('evaluation_record_invalid');
    }
    return { record, plan, ledger, claimed, lastAt, count: events.length, finish };
  } catch { fail('evaluation_record_invalid'); }
}
function eventName(index: number) { return String(index).padStart(4, '0') + '.json'; }
function report(state: Loaded) {
  const ledger = state.ledger.report();
  return copy({ schemaVersion: 1, recordedAt: state.record.recordedAt, approval: state.record.approval, consumed: state.claimed,
    // 'unresolved' includes a live in-flight executor as well as a crashed one.
    // No PID/age heuristic claims that an external process is stopped.
    dispatchState: !state.claimed ? 'approved' : !state.finish || ledger.state === 'reserved' ? 'unresolved' : 'finished',
    reason: state.finish?.reason ?? (state.claimed ? 'unfinished' : null), ledger });
}
/** Persist only an already-authorized caller's attestation. No UI/auth in here. */
export function recordEvaluationApproval(root: string, spec: unknown, approval: unknown) {
  const plan = planEvaluation(spec);
  const id = (approval as any)?.approvalId, dir = location(root, id);
  const parent = path.dirname(dir);
  try { fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); directory(parent); }
  catch { fail('evaluation_record_write_failed'); }
  if (fs.existsSync(dir)) {
    const previous = load(dir, id);
    if (canonical(previous.record.spec) !== canonical(plan.spec) || canonical(previous.record.approval) !== canonical(approval)) fail('evaluation_approval_conflict');
    return report(previous);
  }
  const recordedAt = wallClock(0);
  createEvaluationLedger(plan, approval, recordedAt); // validate before creating the immutable approval directory
  const record = { schemaVersion: 1, recordedAt, spec: plan.spec, approval: copy(approval) };
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch { fail('evaluation_record_write_failed'); }
  writeJson(path.join(dir, 'approval.json'), record);
  return report(load(dir, id));
}
/** Read-only reconstruction; never creates missing files or resets partial data. */
export function readEvaluationRecord(root: string, approvalId: string) {
  return report(load(location(root, approvalId), approvalId));
}
export interface EvaluationDispatch {
  runId: string; planHash: string; variant: 'baseline' | 'candidate'; repetition: number;
  commonHash: string; roleHash: string; timeoutMs: number; perRunLimitMicroUsd: number;
  approvalId: string; expiresAt: number;
}
/**
 * At-most-one dispatch sequence per approval in this trusted storage root.
 * Executor must own container isolation, expiry/timeout/egress and scorer safety.
 * No cancellation guarantee, retry/resume, paid authorization or output capture.
 */
export async function dispatchRecordedEvaluation(root: string, approvalId: string,
  execute: (request: EvaluationDispatch) => Promise<unknown>) {
  const dir = location(root, approvalId), state = load(dir, approvalId);
  if (state.claimed) fail('evaluation_already_consumed');
  if (typeof execute !== 'function') fail('evaluation_executor_invalid');
  const at = wallClock(state.lastAt);
  writeJson(path.join(dir, 'claim.json'), { planHash: state.plan.planHash, at }, 'evaluation_already_consumed');
  state.claimed = true; state.lastAt = at;
  function append(e: Event) {
    writeJson(path.join(dir, eventName(state.count + 1)), e);
    state.count++; state.lastAt = e.at;
  }
  function finish(reason: Extract<Event, { kind: 'finish' }>['reason']) {
    const event: Extract<Event, { kind: 'finish' }> = { kind: 'finish', at: wallClock(state.lastAt), reason };
    append(event); state.finish = event;
    return report(load(dir, approvalId));
  }
  while (state.ledger.report().state === 'ready') {
    const reservedAt = wallClock(state.lastAt), run = state.ledger.reserve(reservedAt);
    // Also persist null reservations: replay must reproduce expiry/budget stops.
    append({ kind: 'reserve', at: reservedAt });
    if (!run) return finish(state.ledger.report().stopReason === 'approval_expired' ? 'approval_expired' : 'stopped');
    // Disk IO can outlive approval. Recheck immediately before invoking adapter;
    // adapter must repeat the deadline gate at actual asynchronous model egress.
    if (wallClock(state.lastAt) >= state.record.approval.expiresAt) return finish('approval_expired');
    let result: unknown;
    try {
      result = await execute(copy({ runId: run.runId, planHash: state.plan.planHash, variant: run.variant,
        repetition: run.repetition, commonHash: run.commonHash, roleHash: run.roleHash,
        timeoutMs: state.plan.spec.timeoutMs, perRunLimitMicroUsd: state.plan.spec.perRunLimitMicroUsd,
        approvalId, expiresAt: state.record.approval.expiresAt }));
    } catch { return finish('dispatch_failed'); }
    // Validate via the same state machine before persisting. No exception text,
    // raw output, malformed fields or unverified synthetic failure is archived.
    try { state.ledger.settle(result); }
    catch { return finish('invalid_result'); }
    append({ kind: 'result', at: wallClock(state.lastAt), result: copy(result) });
  }
  return finish(state.ledger.report().state === 'complete' ? 'complete' : 'stopped');
}
