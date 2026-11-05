// The repository snapshot is already published before startRun. Enrich that
// same staged checkpoint after SDK discovery but before its first prompt.
// No second Git scan, no new checkpoint, no claim of atomic consistency.
import path from 'node:path';
import { collectLoadedProjectSkills, knownCaptureKeyValues } from './git-snapshot';
import { checkpointBlobHashes } from './checkpoint-retention';
import { withProjectWriteLock } from './project-write-lock';
import { redactKnownKeyValues } from './secrets';
import { recordCaptureResult } from './capture-result';
import { CAPTURE_TIME_LIMIT_MS, createCaptureTimeBudget } from './capture-time-budget';
const jsonBytes = (value: any) => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);

export function captureLoadedProjectSkills(options: any, input: any): any {
  const store = options.store, projectId = String(input?.projectId || ''), checkpointId = String(input?.checkpointId || '');
  const fail = (reason: string) => ({ captured: false, checkpointId: '', reason });
  if (![projectId, checkpointId].every(id => /^[A-Za-z0-9_-]{1,128}$/.test(id))) return fail('checkpoint_missing');
  try {
    return withProjectWriteLock(store.captureRoot, projectId, () => {
      const policy = store.loadPolicy(projectId);
      if (policy.status !== 'enabled') return fail('policy_not_enabled');
      let cp = store.loadCheckpoint(projectId, checkpointId);
      if (cp?.schemaVersion !== 2 || cp.projectId !== projectId || cp.status !== 'staged') return fail('checkpoint_missing');
      if (cp.gitSnapshot.skillInventoryStatus !== 'pending') return { captured: true, checkpointId, checkpoint: cp, reason: '' };
      const started = Date.now(), oldBytes = jsonBytes(cp), oldStats = { ...cp.stats }, oldHashes = new Set(checkpointBlobHashes(cp));
      const budget = createCaptureTimeBudget({ captureNow: options.captureNow,
        captureTimeLimitMs: cp.gitSnapshot.captureTimeRemainingMs ?? Math.max(0, CAPTURE_TIME_LIMIT_MS - cp.stats.durationMs) });
      const keys = typeof options.getKnownKeyValues === 'function' ? options.getKnownKeyValues() : knownCaptureKeyValues(options.agentDir);
      const available = Array.isArray(input.skills);
      const collected = collectLoadedProjectSkills({ skills: available ? input.skills : [], contextFiles: input.contextFiles, knownKeyValues: keys, budget });
      // Same resource bytes may serve both origins, but replay must not turn a
      // prompt-only skill into a newly SDK-discovered skill. Never infer these
      // source lists from an older caller's already-merged inventory.
      const originInventory = (list: any): any[] | undefined => {
        if (!Array.isArray(list)) return undefined;
        const indexed = new Map<string, any>(collected.loadedSkills.map((s: any) => [s.filePath, s]));
        const selected = new Map<string, any>();
        for (const skill of list) {
          if (typeof skill?.filePath !== 'string' || !path.isAbsolute(skill.filePath)) return undefined;
          const filePath = path.resolve(skill.filePath), record = indexed.get(filePath);
          if (!record) return undefined;
          selected.set(filePath, { ...record, name: String(skill.name || '') });
        }
        return [...selected.values()];
      };
      const sdkLoadedSkills = originInventory(input.sdkSkills), promptLoadedSkills = originInventory(input.promptSkills);
      cp.gitSnapshot = { ...cp.gitSnapshot, loadedSkills: collected.loadedSkills, projectSkills: collected.projectSkills,
        ...(collected.loadedContexts === undefined ? {} : { loadedContexts: collected.loadedContexts }),
        ...(sdkLoadedSkills === undefined ? {} : { sdkLoadedSkills }), ...(promptLoadedSkills === undefined ? {} : { promptLoadedSkills }),
        captureTimeRemainingMs: collected.captureTimeRemainingMs,
        skillInventoryStatus: available ? 'loaded' : 'unavailable' };
      cp.uncaptured.push(...collected.uncaptured);
      if (!available) cp.uncaptured.push({ path: '.', scope: 'sdk', reason: 'project_skills_unavailable' });
      cp.skipped = cp.uncaptured;
      const reasons = cp.replayInput.incompleteReasons.filter((r: string) => r !== 'project_skills_pending');
      if (!available) reasons.push('project_skills_unavailable');
      if (collected.uncaptured.length && !reasons.includes('files_uncaptured')) reasons.push('files_uncaptured');
      if (collected.uncaptured.some((g: any) => g.reason === 'capture_time_limit')) reasons.push('capture_time_limit');
      cp.replayInput.incompleteReasons = [...new Set(reasons)];
      cp.replayInput.complete = cp.replayInput.incompleteReasons.length === 0;
      const missing = new Map<string, Buffer>();
      let extraReferencedBytes = 0;
      for (const [digest, bytes] of collected.blobs as Map<string, Buffer>) {
        if (!store.hasBlob(projectId, digest)) missing.set(digest, bytes);
        if (!oldHashes.has(digest)) extraReferencedBytes += bytes.length;
      }
      const newBlobBytes = [...missing.values()].reduce((sum, b) => sum + b.length, 0);
      cp.stats = { ...cp.stats, totalBytes: cp.stats.totalBytes + extraReferencedBytes,
        skippedCount: cp.uncaptured.length, loadedSkillCount: collected.loadedSkills.length,
        skillCaptureDurationMs: Date.now() - started, durationMs: cp.stats.durationMs + Date.now() - started,
        newBlobBytes: oldStats.newBlobBytes + newBlobBytes,
        blobBytesByKind: { ...oldStats.blobBytesByKind, files: oldStats.blobBytesByKind.files + newBlobBytes } };
      cp = JSON.parse(redactKnownKeyValues(Buffer.from(JSON.stringify(cp)), keys).content.toString('utf8'));
      // Stats include the enrichment delta as well as the original publication.
      // Use the actual JSON width; this is accounting, not an atomicity claim.
      let stable = false;
      for (let i = 0; i < 16; i++) {
        const delta = jsonBytes(cp) - oldBytes;
        const manifest = oldStats.newManifestBytes + delta, total = oldStats.totalNewBytes + newBlobBytes + delta;
        if (cp.stats.newManifestBytes === manifest && cp.stats.totalNewBytes === total) { stable = true; break; }
        cp.stats.newManifestBytes = manifest; cp.stats.totalNewBytes = total;
      }
      if (!stable) return fail('checkpoint_write_failed');
      const delta = jsonBytes(cp) - oldBytes;
      if (store.computeUsage(projectId).totalBytes + newBlobBytes + Math.max(0, delta) > policy.stagingQuotaBytes) return fail('quota_exceeded');
      for (const [digest, bytes] of missing) store.writeBlob(projectId, digest, bytes);
      store.saveCheckpoint(projectId, cp);
      const result = { captured: true, checkpointId, checkpoint: cp, reason: '' };
      recordCaptureResult({ ...options, enrichment: true }, input, result);
      return result;
    });
  } catch { return fail('project_skills_unavailable'); } // never block or leak content into logs
}
