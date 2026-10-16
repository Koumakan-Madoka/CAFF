// Trusted internal approval/egress binding, NOT a human-authentication or paid
// launch surface. No production routes, Docker, SDK or credential issuer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { planEvaluation, createEvaluationLedger } from './evaluation-plan';
import { recordEvaluationApproval, readEvaluationRecord, dispatchRecordedEvaluation, EvaluationDispatch } from './evaluation-record';
import { chatCompletionsSettings, dispatchChatCompletions, toolChatCompletionsSettings, dispatchToolChatCompletions } from './chat-completions-protocol';
import { httpsExchangeEndpoint, createHttpsExchange, HttpsCredentialLease } from './https-exchange';
import { containsSecretSentinel } from './secrets';

const exact = (v: any, names: string[]) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join('|') === [...names].sort().join('|');
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function canonical(v: any): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function fail(kind: string): never { throw Object.assign(Error('model_binding_' + kind), { code: 'model_binding_' + kind }); }
const integer = (v: any, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const LIMIT = 16384;
/** Plan.model.settingsHash is this COMPOSITE hash, not the wire settings hash.
 * Distinct names prevent silently reinterpreting historical protocol-only plans.
 */
export function modelBinding(value: unknown) {
  try {
    const v = value as any;
    const withTools = v !== null && typeof v === 'object' && Object.hasOwn(v, 'tools');
    if (!exact(v, ['settings', 'endpoint', 'maxRequests', ...(withTools ? ['tools'] : [])]) || !integer(v.maxRequests, 1, 1000)) fail('invalid');
    const toolProfile = withTools ? toolChatCompletionsSettings({ settings: v.settings, tools: v.tools }) : undefined;
    const s = toolProfile || chatCompletionsSettings(v.settings), e = httpsExchangeEndpoint(v.endpoint);
    if (s.settings.maxRequestBytes !== e.endpoint.maxRequestBytes || s.settings.maxResponseBytes !== e.endpoint.maxResponseBytes) fail('invalid');
    const { protocol: _s, ...settings } = s.settings, { protocol: _e, ...endpoint } = e.endpoint;
    // No tools property is added to legacy configurations: their canonical bytes
    // and historical hashes are unchanged. Tools always require a new plan.
    const config = { settings, endpoint, maxRequests: v.maxRequests, ...(toolProfile ? { tools: toolProfile.tools } : {}) };
    const binding = { schemaVersion: 1 as const, kind: toolProfile ? 'evaluation-tool-model-binding-v1' as const : 'evaluation-model-binding-v1' as const, config,
      settingsHash: s.settingsHash, endpointHash: e.endpointHash, perRequestReserveMicroUsd: s.perRequestReserveMicroUsd };
    return { ...binding, bindingHash: hash(canonical(binding)) };
  } catch { fail('invalid'); }
}
function bind(spec: unknown, config: unknown) {
  const plan = planEvaluation(spec), binding = modelBinding(config), s = plan.spec, c = binding.config;
  if (s.model.provider !== c.settings.provider || s.model.id !== c.settings.model || s.model.settingsHash !== binding.bindingHash
    || binding.perRequestReserveMicroUsd > s.perRunLimitMicroUsd || c.endpoint.timeoutMs > s.timeoutMs
    || containsSecretSentinel(JSON.stringify(s))) fail('invalid');
  return { plan, binding };
}
function directory(dir: string) { if (!fs.lstatSync(dir).isDirectory()) fail('record_invalid'); }
function location(root: string, id: string) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
    || containsSecretSentinel(id)) fail('invalid');
  directory(root);
  return path.join(root, 'model-bindings', hash(id) + '.json');
}
function read(file: string) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.size < 2n || before.size > BigInt(LIMIT)) fail('record_invalid');
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.size !== before.size) fail('record_invalid');
    const size = Number(st.size); // bounded above before conversion; identity stays bigint
    const buffer = Buffer.alloc(size + 1); let n = 0;
    while (n < buffer.length) { const got = fs.readSync(fd, buffer, n, buffer.length - n, n); if (!got) break; n += got; }
    const bytes = buffer.subarray(0, n), text = bytes.toString('utf8');
    if (n !== size || !Buffer.from(text).equals(bytes)) fail('record_invalid');
    return JSON.parse(text);
  } finally { fs.closeSync(fd); }
}
function write(file: string, value: any) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > LIMIT) fail('invalid');
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (canonical(read(file)) !== canonical(value)) fail('write_failed');
  } catch (e: any) {
    // Only an exact retry may reuse an existing immutable archive. Never repair
    // partial data. No approval is written after an unacknowledged write/fsync.
    if (e?.code !== 'EEXIST' || canonical(read(file)) !== canonical(value)) fail('write_failed');
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* failed closed */ } } }
}
/** Caller must have independently authenticated/reviewed the FULL plan+binding.
 * This records an attestation only, just like recordEvaluationApproval.
 */
export function recordBoundModelApproval(root: string, spec: unknown, config: unknown, approval: unknown) {
  try {
    const { plan, binding } = bind(spec, config), a = copy(approval) as any;
    createEvaluationLedger(plan, a, Date.now()); // validate before creating ANY child
    const file = location(root, a.approvalId), dir = path.dirname(file);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    directory(dir);
    write(file, { schemaVersion: 1, approval: a, binding }); // durable review data FIRST
    recordEvaluationApproval(root, plan.spec, a);
    return readBoundModelApproval(root, a.approvalId);
  } catch { fail('record_invalid'); }
}
/** Read-only reconstruction. Orphan binding without valid approval is not usable. */
export function readBoundModelApproval(root: string, approvalId: string) {
  try {
    const file = location(root, approvalId); directory(path.dirname(file));
    const stored = read(file);
    if (!exact(stored, ['schemaVersion', 'approval', 'binding']) || stored.schemaVersion !== 1) fail('record_invalid');
    // Guard the original coordinator's own root/evaluation layers as well.
    directory(path.join(root, 'evaluations')); directory(path.join(root, 'evaluations', hash(approvalId)));
    const report = readEvaluationRecord(root, approvalId), { binding } = bind(report.ledger.spec, stored.binding?.config);
    if (canonical(stored.binding) !== canonical(binding) || canonical(stored.approval) !== canonical(report.approval)) fail('record_invalid');
    return { schemaVersion: 1, binding, report, paidAuthorization: false, executionVerified: false, strictEvalEligible: false };
  } catch { fail('record_invalid'); }
}
/** The only dispatch entry here owns the original approval claim. No public
 * adapter accepting an arbitrary old/unresolved run reservation is provided.
 * execute is TRUSTED: it still owns isolated launcher, input fidelity and score.
 * The send closure must stay in its trusted supervisor, never in tested code.
 */
export async function dispatchBoundModelEvaluation(root: string, approvalId: string,
  execute: (run: EvaluationDispatch, send: (body: Buffer) => Promise<Buffer>) => Promise<unknown>,
  credential: (endpointHash: string) => HttpsCredentialLease) {
  const initial = readBoundModelApproval(root, approvalId);
  let lastAt = initial.report.recordedAt;
  const clock = () => {
    const now = Date.now();
    if (!integer(now, lastAt, initial.report.approval.expiresAt - 1)) fail('expired');
    lastAt = now; return now;
  };
  clock();
  if (typeof execute !== 'function' || typeof credential !== 'function') fail('invalid');
  // Each callback is reached only after the original durable outer reservation.
  return dispatchRecordedEvaluation(root, approvalId, async request => {
    const run = copy(request), started = performance.now(), expiresAt = Math.min(run.expiresAt, clock() + run.timeoutMs);
    const guard = () => {
      if (clock() >= expiresAt || performance.now() - started >= run.timeoutMs) fail('expired');
      const current = readBoundModelApproval(root, approvalId), r = current.report;
      if (canonical(current.binding) !== canonical(initial.binding) || canonical(r.approval) !== canonical(initial.report.approval)
        || r.ledger.planHash !== run.planHash || r.ledger.state !== 'reserved' || r.dispatchState !== 'unresolved'
        || r.reason !== 'unfinished' || r.ledger.runs.at(-1)?.runId !== run.runId) fail('inactive');
      const plan = planEvaluation(r.ledger.spec), expected = plan.runs.find(v => v.runId === run.runId);
      if (!expected || canonical(run) !== canonical({ ...expected, planHash: plan.planHash,
        timeoutMs: plan.spec.timeoutMs, perRunLimitMicroUsd: plan.spec.perRunLimitMicroUsd,
        approvalId, expiresAt: r.approval.expiresAt })) fail('inactive');
      clock(); // IO can cross the absolute deadline
      if (Date.now() >= expiresAt || performance.now() - started >= run.timeoutMs) fail('expired');
    };
    guard();
    const b = initial.binding, c = b.config;
    const exchange = createHttpsExchange(c.endpoint, scope => {
      guard(); if (scope !== b.endpointHash) fail('inactive');
      const lease = credential(scope);
      if (lease instanceof Promise) { void lease.catch(() => {}); fail('invalid'); }
      if (!exact(lease, ['value', 'expiresAt'])) fail('invalid');
      const value = lease.value, until = lease.expiresAt;
      guard(); // callback may take time or alter storage; revalidate before dial
      if (!integer(until, 1)) fail('invalid');
      return { value, expiresAt: Math.min(until, expiresAt) };
    });
    let result: any;
    const dispatch = Object.hasOwn(c, 'tools') ? dispatchToolChatCompletions : dispatchChatCompletions;
    const profile = Object.hasOwn(c, 'tools') ? { settings: c.settings, tools: c.tools } : c.settings;
    const egress = await dispatch(root, {
      approvalId, planHash: run.planHash, runId: run.runId, provider: c.settings.provider, model: c.settings.model,
      settingsHash: b.settingsHash, expiresAt, maxRequests: c.maxRequests,
      maxRequestBytes: c.settings.maxRequestBytes, maxResponseBytes: c.settings.maxResponseBytes,
      timeoutMs: c.endpoint.timeoutMs, perRequestReserveMicroUsd: b.perRequestReserveMicroUsd, runLimitMicroUsd: run.perRunLimitMicroUsd,
    }, profile, async send => { result = await execute(copy(run), send); }, exchange);
    guard();
    // Do not let a trusted scorer underreport the request ledger or turn unknown
    // costs/failed requests/zero model calls into a completed scored evaluation.
    if (egress.reason !== 'completed' || egress.state !== 'finished' || egress.requests.length === 0 || egress.unknownCostRequests !== 0
      || !exact(result, ['runId', 'status', 'costMicroUsd', 'outputHash', 'score']) || result.runId !== run.runId
      || result.status !== 'completed' || result.costMicroUsd !== egress.knownCostMicroUsd) fail('unresolved');
    return copy(result); // original ledger validates output hash and score schema
  });
}
