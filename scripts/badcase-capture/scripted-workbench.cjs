// Opt-in trusted-operator capability, NOT wired into the production app. The
// operator supplies scoped materials and a dedicated restored-daemon transport;
// browsers can select IDs only. No daemon creation, paid models, or path inputs.
const crypto = require('node:crypto');
const { createEvaluationAdminService } = require('../../build/server/domain/runtime/badcase-capture/evaluation-admin');
const { prepareScriptedEvaluation } = require('./scripted-evaluation.cjs');
const { dispatchApprovedScriptedEvaluation } = require('./approved-scripted-evaluation.cjs');
const { prepareOfflineTask } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const { saveReviewArchive, readReviewArchive } = require('./review-archive.cjs');
const copy = v => JSON.parse(JSON.stringify(v));
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
function fail(code) { throw Object.assign(Error(code), { code }); }
function identifier(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v); }
function createScriptedWorkbench({ root, materials, runProbe }) {
  if (!Array.isArray(materials) || materials.length > 64 || typeof runProbe !== 'function') fail('evaluation_workbench_invalid');
  const registry = copy(materials), seen = new Set();
  for (const m of registry) {
    if (!exact(m, ['id', 'projectId', 'request', 'image', 'sources', 'roles', 'rule']) || !identifier(m.id) || !identifier(m.projectId)
      || m.request?.association?.projectId !== m.projectId || seen.has(m.projectId + ':' + m.id)) fail('evaluation_workbench_invalid');
    // Reuse the Docker boundary's image schema without executing anything. An
    // empty trusted file is sufficient for this pure validation call; no host
    // paths or extra image fields may reach the human review projection.
    try { prepareOfflineTask({ image: m.image, entrypoint: 'validate.cjs', timeoutMs: 1,
      files: [{ path: 'validate.cjs', base64: '', sha256: hash('') }] }); }
    catch { fail('evaluation_workbench_invalid'); }
    seen.add(m.projectId + ':' + m.id);
  }
  const admin = createEvaluationAdminService({ root }), tickets = new Map();
  let active = false;
  function ticket(projectId, body) {
    if (!identifier(projectId) || !exact(body, ['confirmed', 'approvalId', 'planHash', 'reviewHash']) || body.confirmed !== true) fail('evaluation_workbench_invalid');
    const t = tickets.get(body.approvalId), now = Date.now();
    if (!t || t.projectId !== projectId || t.planHash !== body.planHash || t.reviewHash !== body.reviewHash
      || !Number.isSafeInteger(now) || now < t.createdAt || now >= t.expiresAt) fail('evaluation_review_stale');
    return t;
  }
  return {
    admin,
    materials(projectId) {
      if (!identifier(projectId)) fail('evaluation_workbench_invalid');
      return { mode: 'offline-scripted-workbench', projectId, paidAuthorization: false,
        materials: registry.filter(m => m.projectId === projectId).map(m => ({ id: m.id })) };
    },
    preview(projectId, body) {
      if (!identifier(projectId) || !exact(body, ['materialId', 'repetitions'])
        || !Number.isSafeInteger(body.repetitions) || body.repetitions < 1 || body.repetitions > 10) fail('evaluation_workbench_invalid');
      const m = registry.find(m => m.projectId === projectId && m.id === body.materialId);
      if (!m) fail('evaluation_material_missing');
      const now = Date.now();
      if (!Number.isSafeInteger(now) || now < 0) fail('evaluation_clock_invalid');
      for (const [id, t] of tickets) if (now >= t.expiresAt) tickets.delete(id);
      if (tickets.size >= 64) fail('evaluation_preview_busy');
      // Preparation validates archives and retained CAS, and can create a
      // protective reference. Cancel does not release it or authorize GC.
      let prepared;
      try { prepared = prepareScriptedEvaluation(m.request, m.image, m.sources, m.roles, m.rule, body.repetitions); }
      catch { fail('evaluation_material_invalid'); }
      const p = admin.preview(projectId, { spec: prepared.plan.spec }), review = prepared.review;
      const reviewHash = hash(JSON.stringify(review));
      tickets.set(p.approvalId, { projectId, material: m, planHash: p.plan.planHash, reviewHash,
        createdAt: p.createdAt, expiresAt: p.expiresAt, attempted: false, review: copy(review), spec: copy(p.plan.spec) });
      return copy({ ...p, materialId: m.id, review, reviewHash });
    },
    approve(projectId, body) {
      const t = ticket(projectId, body);
      // Save projection BEFORE acknowledging approval. A crash/expiry may leave
      // an orphan projection, never an automatic approval or launch. Exact retry
      // may reuse a complete file; partial/conflicting files are not repaired.
      saveReviewArchive(root, { schemaVersion: 1, projectId, approvalId: body.approvalId,
        materialId: t.material.id, createdAt: t.createdAt, expiresAt: t.expiresAt,
        reviewHash: t.reviewHash, review: t.review }, t.spec);
      return admin.approve(projectId, { confirmed: true, approvalId: body.approvalId, planHash: body.planHash });
    },
    readReview(projectId, approvalId) {
      const envelope = admin.read(projectId, approvalId);
      return { ...envelope, reviewArchive: readReviewArchive(root, projectId, approvalId, envelope.report) };
    },
    async start(projectId, body) {
      const t = ticket(projectId, body);
      if (t.attempted) fail('evaluation_start_attempted');
      if (active) fail('evaluation_workbench_busy');
      // No queue, automatic retries or background job reconciliation. An HTTP
      // disconnect does NOT cancel the runner; GET is the recovery path. Restart
      // loses tickets, not records/claims, and cannot restart an old approval.
      t.attempted = true; active = true;
      try {
        const m = t.material, saved = admin.read(projectId, body.approvalId).report;
        if (saved.approval.planHash !== t.planHash || saved.approval.expiresAt !== t.expiresAt) fail('evaluation_review_stale');
        const archived = readReviewArchive(root, projectId, body.approvalId, saved);
        if (archived.reviewHash !== t.reviewHash || archived.materialId !== m.id
          || JSON.stringify(archived.review) !== JSON.stringify(t.review)) fail('evaluation_review_stale');
        // Runner re-reads and revalidates materials as well. This extra binding
        // pins the UI's reviewed count/plan, not just the stored plan. Same-user
        // edits in between these checks remain outside the atomicity guarantee.
        return await dispatchApprovedScriptedEvaluation({ root, projectId, approvalId: body.approvalId,
          request: m.request, image: m.image, sources: m.sources, roles: m.roles, rule: m.rule }, runProbe);
      } catch { fail('evaluation_start_failed'); }
      finally { active = false; }
    },
  };
}
module.exports = { createScriptedWorkbench };
