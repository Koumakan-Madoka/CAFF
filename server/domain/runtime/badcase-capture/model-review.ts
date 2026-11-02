// Dedicated local review declarations. No launcher, credential source or paid
// permission. Trusted registry digests are NOT proof of captured material.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { planEvaluation } from './evaluation-plan';
import { modelBinding, recordBoundModelApproval, readBoundModelApproval } from './model-binding';
import { containsSecretSentinel } from './secrets';
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const exact = (v: any, keys: string[]) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
function fail(kind: string): never { throw Object.assign(Error('model_review_' + kind), { code: 'model_review_' + kind }); }
function id(v: any): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v) || containsSecretSentinel(v)) fail('invalid');
  return v;
}
const uuid = (v: any) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const flags = { mode: 'model-configuration-review', launchAvailable: false, paidAuthorization: false,
  materialVerified: false, executionVerified: false, strictEvalEligible: false } as const;
/** Registry is operator-owned, immutable for this instance, max 64 entries.
 * No browser-provided endpoint/spec/filesystem paths. Confirm only a fresh ticket.
 */
export function createModelReviewService({ root, entries }: { root: string; entries: unknown }) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Array.isArray(entries) || entries.length > 64) fail('invalid');
  const registry = new Map<string, { projectId: string; id: string; plan: ReturnType<typeof planEvaluation>; binding: ReturnType<typeof modelBinding> }>();
  for (const entry of entries) {
    if (!exact(entry, ['projectId', 'id', 'spec', 'config'])) fail('invalid');
    const projectId = id(entry.projectId), name = id(entry.id), key = projectId + '/' + name;
    const plan = planEvaluation(entry.spec), binding = modelBinding(entry.config), s = plan.spec, c = binding.config;
    if (registry.has(key) || s.model.provider !== c.settings.provider || s.model.id !== c.settings.model
      || s.model.settingsHash !== binding.bindingHash || binding.perRequestReserveMicroUsd > s.perRunLimitMicroUsd
      || c.endpoint.timeoutMs > s.timeoutMs || containsSecretSentinel(JSON.stringify(s))) fail('invalid');
    registry.set(key, { projectId, id: name, plan, binding });
  }
  type Ticket = { projectId: string; entryId: string; approvalId: string; createdAt: number; expiresAt: number;
    plan: ReturnType<typeof planEvaluation>; binding: ReturnType<typeof modelBinding> };
  const tickets = new Map<string, Ticket>();
  let lastAt = 0;
  function clock() {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < lastAt || now > Number.MAX_SAFE_INTEGER - 300000) fail('clock_invalid');
    lastAt = now; return now;
  }
  function scope(projectId: string, create = false) {
    const dir = path.join(root, hash(id(projectId)));
    for (const d of [root, dir]) {
      if (create) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(d).isDirectory()) fail('record_invalid');
    }
    return dir;
  }
  function envelope(projectId: string, stored: ReturnType<typeof readBoundModelApproval>) {
    return { schemaVersion: 1, projectId, ...flags, binding: stored.binding, report: stored.report };
  }
  return {
    // Only configured project IDs are enumerated. Historical read takes an ID
    // explicitly; registry changes must not replace or hide the persisted text.
    projects() { return [...new Set([...registry.values()].map(e => e.projectId))]; },
    list(projectId: string) {
      id(projectId);
      return { schemaVersion: 1, projectId, ...flags, entries: [...registry.values()].filter(e => e.projectId === projectId).map(e => ({ id: e.id })) };
    },
    preview(projectId: string, body: unknown) {
      id(projectId);
      if (!exact(body, ['entryId'])) fail('invalid');
      const entryId = id((body as any).entryId), e = registry.get(projectId + '/' + entryId);
      if (!e) fail('missing');
      const now = clock();
      for (const [key, t] of tickets) if (now >= t.expiresAt) tickets.delete(key);
      if (tickets.size >= 64) fail('busy');
      const ticket = { projectId, entryId, approvalId: crypto.randomUUID(), createdAt: now, expiresAt: now + 300000,
        plan: e.plan, binding: e.binding };
      tickets.set(ticket.approvalId, ticket);
      return copy({ schemaVersion: 1, ...ticket, ...flags });
    },
    approve(projectId: string, body: unknown) {
      id(projectId);
      if (!exact(body, ['confirmed', 'approvalId', 'planHash', 'bindingHash']) || (body as any).confirmed !== true) fail('invalid');
      const b = body as any, t = tickets.get(b.approvalId), now = clock();
      if (!t || t.projectId !== projectId || now >= t.expiresAt || b.planHash !== t.plan.planHash || b.bindingHash !== t.binding.bindingHash) fail('stale');
      try {
        // Both immutable full texts are persisted by the original binding writer;
        // tickets survive successful confirmation only until their fixed expiry.
        const saved = recordBoundModelApproval(scope(projectId, true), t.plan.spec, t.binding.config,
          { confirmed: true, approvalId: t.approvalId, planHash: t.plan.planHash, expiresAt: t.expiresAt });
        return envelope(projectId, saved);
      } catch { fail('record_invalid'); }
    },
    read(projectId: string, approvalId: string) {
      id(projectId); if (!uuid(approvalId)) fail('invalid');
      try { return envelope(projectId, readBoundModelApproval(scope(projectId), approvalId)); }
      catch { fail('record_invalid'); }
    },
  };
}
