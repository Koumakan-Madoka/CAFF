// Small, content-free project status. Read without a Git scan or CAS reads;
// room checkpoints and failures must not disappear behind a root-only pointer.
import path from 'node:path';
import { pathsEqual } from './capture-policy';
import { knownCaptureKeyValues } from './git-snapshot';
import { redactKnownKeyValues } from './secrets';
const nonnegative = (v: any) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const duration = (v: any) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

export function checkpointCaptureMetrics(cp: any): any {
  const stats = cp.stats || {}, kinds = stats.blobBytesByKind, names = ['files', 'session', 'replay', 'shared'];
  const validKinds = kinds && names.every(k => nonnegative(kinds[k]) !== null)
    && names.reduce((sum, k) => sum + kinds[k], 0) === nonnegative(stats.newBlobBytes);
  return { checkpointId: cp.checkpointId, targetDir: cp.targetDir, createdAt: cp.createdAt,
    totalNewBytes: nonnegative(stats.totalNewBytes), newBlobBytes: nonnegative(stats.newBlobBytes), newManifestBytes: nonnegative(stats.newManifestBytes),
    blobBytesByKind: validKinds ? Object.fromEntries(names.map(k => [k, kinds[k]])) : null,
    sessionBytes: nonnegative(stats.sessionBytes), preparationDurationMs: cp.schemaVersion === 2 || cp.integrity?.platform === 'win32'
      ? duration(stats.durationMs) : null };
}

// Status is administrative metadata (like policy), not another checkpoint or
// a CAS/retention reference. Its tiny file is outside computeUsage's payloads.
export function recordCaptureResult(options: any, input: any, outcome: any): void {
  const store = options.store, projectId = String(input.projectId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return;
  if (['policy_not_enabled', 'repository_not_covered', 'target_not_repository_root', 'project_root_missing'].includes(outcome.reason)) return;
  try {
    const previous = options.enrichment ? store.loadCaptureResult(projectId) : null;
    // A slow SDK initialization may finish after another turn checkpoint. Do
    // not replace that newer attempt's status with this older enrichment.
    if (options.enrichment && previous && previous.checkpointId !== input.checkpointId) return;
    const cp = outcome.checkpoint, targetDir = cp?.targetDir || path.resolve(String(input.targetDir || '.'));
    if (outcome.reason === 'not_git_repository') {
      const project = typeof options.getProject === 'function' ? options.getProject(projectId) : null;
      const root = project?.path || store.loadPolicy(projectId).authorizedDirs[0];
      if (!root || !pathsEqual(root, targetDir)) return; // unrelated non-Git cwd is not a capture attempt
    }
    const captured = outcome.captured === true && !!cp;
    const counts = cp?.stats || {}, inventory = cp?.gitSnapshot?.skillInventoryStatus;
    const status = !captured ? 'failed' : inventory === 'pending' ? 'pending_skills' : counts.skippedCount > 0 ? 'partial' : 'captured';
    const metrics = captured ? checkpointCaptureMetrics(cp) : { checkpointId: '', targetDir,
      totalNewBytes: null, newBlobBytes: null, newManifestBytes: null, blobBytesByKind: null, sessionBytes: null, preparationDurationMs: duration(outcome.durationMs) };
    const result = { ...metrics, createdAt: new Date().toISOString(), captured, status,
      reason: captured ? '' : /^[a-z][a-z0-9_:.-]{0,127}$/.test(outcome.reason) ? outcome.reason : 'git_snapshot_unavailable',
      fileCount: nonnegative(counts.fileCount), skippedCount: nonnegative(counts.skippedCount),
      skillInventoryStatus: ['pending', 'loaded', 'unavailable'].includes(inventory) ? inventory : null };
    const keys = typeof options.getKnownKeyValues === 'function' ? options.getKnownKeyValues() : knownCaptureKeyValues(options.agentDir);
    store.saveCaptureResult(projectId, JSON.parse(redactKnownKeyValues(Buffer.from(JSON.stringify(result)), keys).content.toString('utf8')));
  } catch { /* status write failures never invalidate a durable checkpoint or block a turn */ }
}
