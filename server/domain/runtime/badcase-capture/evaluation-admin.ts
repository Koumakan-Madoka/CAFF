// Local, same-OS-user OFFLINE approval declarations, never a launcher or paid
// authorization. Preview accepts digest declarations, NOT verified case material.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { planEvaluation } from './evaluation-plan';
import { readEvaluationRecord, recordEvaluationApproval } from './evaluation-record';
import { containsSecretSentinel } from './secrets';
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const exact = (v: any, keys: string[]) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function fail(code: string): never { throw Object.assign(Error(code), { code }); }
function project(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('evaluation_admin_invalid');
  return crypto.createHash('sha256').update(value).digest('hex');
}
function offline(spec: unknown) {
  const plan = planEvaluation(spec), s = plan.spec;
  if (s.model.provider !== 'caff-offline-scripted' || s.model.id !== 'tool-loop-v1'
    || s.evaluator.id !== 'file-sha256-v1' || s.roleId !== 'offline-diagnostic-role'
    || s.timeoutMs !== 25000 || s.perRunLimitMicroUsd !== 1 || s.totalLimitMicroUsd !== s.repetitions * 2
    || containsSecretSentinel(JSON.stringify(s))) fail('evaluation_offline_only');
  return plan;
}
export function createEvaluationAdminService({ root }: { root: string }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('evaluation_admin_invalid');
  type Preview = { projectId: string; approvalId: string; createdAt: number; expiresAt: number; plan: ReturnType<typeof planEvaluation> };
  const previews = new Map<string, Preview>();
  function recordRoot(projectId: string, create = false) {
    const dir = path.join(root, project(projectId));
    // Storage ancestors remain same-user TCB. Refuse links in our own two levels.
    for (const d of [root, dir]) {
      if (create) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(d).isDirectory()) fail('evaluation_record_invalid');
    }
    return dir;
  }
  const envelope = (projectId: string, report: ReturnType<typeof readEvaluationRecord>) => ({
    schemaVersion: 1, projectId, mode: 'offline-scripted-declaration', launchAvailable: false,
    paidAuthorization: false, materialVerified: false, report,
  });
  return {
    preview(projectId: string, body: unknown) {
      project(projectId);
      if (!exact(body, ['spec'])) fail('evaluation_admin_invalid');
      const plan = offline((body as any).spec), now = Date.now();
      if (!Number.isSafeInteger(now) || now < 0) fail('evaluation_clock_invalid');
      for (const [id, p] of previews) if (now >= p.expiresAt) previews.delete(id);
      if (previews.size >= 64) fail('evaluation_preview_busy');
      const p = { projectId, approvalId: crypto.randomUUID(), createdAt: now, expiresAt: now + 300000, plan };
      previews.set(p.approvalId, p);
      return copy({ ...p, mode: 'offline-scripted-declaration', launchAvailable: false, paidAuthorization: false, materialVerified: false });
    },
    approve(projectId: string, body: unknown) {
      project(projectId);
      if (!exact(body, ['confirmed', 'approvalId', 'planHash']) || (body as any).confirmed !== true) fail('evaluation_admin_invalid');
      const b = body as any, p = previews.get(b.approvalId), now = Date.now();
      if (!p || p.projectId !== projectId || p.plan.planHash !== b.planHash || !Number.isSafeInteger(now)
        || now < p.createdAt || now >= p.expiresAt) fail('evaluation_preview_stale');
      // Keep ticket until expiry for exact network retries. A restart discards
      // tickets, not records; GET is the only recovery path, never automatic replay.
      const report = recordEvaluationApproval(recordRoot(projectId, true), p.plan.spec,
        { confirmed: true, approvalId: p.approvalId, planHash: p.plan.planHash, expiresAt: p.expiresAt });
      return envelope(projectId, report);
    },
    read(projectId: string, approvalId: string) {
      project(projectId);
      if (typeof approvalId !== 'string' || !/^[a-f0-9-]{36}$/.test(approvalId)) fail('evaluation_admin_invalid');
      try {
        const report = readEvaluationRecord(recordRoot(projectId), approvalId);
        offline(report.ledger.spec); // paid/foreign record cannot be projected as an offline approval
        return envelope(projectId, report);
      } catch { fail('evaluation_record_invalid'); }
    },
  };
}
