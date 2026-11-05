import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { collectGitSnapshot, inspectSnapshotRepository, knownCaptureKeyValues } from './git-snapshot';
import { pathsEqual } from './capture-policy';
import { redactKnownKeyValues } from './secrets';
import { prepareReplayInput } from './replay-input-preparation';
import { publishPreparedCheckpoint } from './checkpoint-publication';
import { withAsyncProjectWriteLease } from './project-write-lock';
import { recordCaptureResult } from './capture-result';

export function createGitTurnCollector(options: any): any {
  const store = options.store;
  return { async captureTurnCheckpoint(input: any = {}): Promise<any> {
    const started = Date.now();
    const failed = (reason: string) => ({ captured: false, checkpointId: '', reason, durationMs: Date.now() - started });
    const projectId = String(input.projectId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return failed('project_id_missing');
    try {
      // Disabled means no Git command, key inventory, skill read or file scan.
      if (store.loadPolicy(projectId).status !== 'enabled') return failed('policy_not_enabled');
      const outcome = await withAsyncProjectWriteLease(store.captureRoot, projectId, async writeSync => {
        const policy = store.loadPolicy(projectId);
        if (policy.status !== 'enabled') return failed('policy_not_enabled');
        const project = typeof options.getProject === 'function' ? options.getProject(projectId) : null;
        const root = project?.path || policy.authorizedDirs[0];
        if (!root) return failed('project_root_missing');
        const targetDir = path.resolve(String(input.targetDir || '.'));
        const source = await inspectSnapshotRepository(root), target = await inspectSnapshotRepository(targetDir);
        if (!target.ok) return failed(target.reason);
        if (!source.ok || !pathsEqual(source.commonDir, target.commonDir)) return failed('repository_not_covered');
        const knownKeyValues = typeof options.getKnownKeyValues === 'function'
          ? options.getKnownKeyValues() : knownCaptureKeyValues(options.agentDir);
        const collected = await collectGitSnapshot({ targetDir, knownKeyValues, excludedPatterns: policy.excludedPatterns,
          sdkStartConfig: input.harness?.configSnapshot?.sdkStartConfig, projectSkillPaths: input.projectSkillPaths });
        if (!collected.ok) return failed(collected.reason);
        let callbackInput: any;
        if (typeof options.readCallbackInput === 'function') {
          try { callbackInput = options.readCallbackInput(input, policy); } catch { callbackInput = null; }
        }
        const preparedInput = typeof options.readCallbackInput === 'function' ? { ...input, callbackInput } : input;
        const { replayInput, plans } = prepareReplayInput(preparedInput, input.deliveryMode === 'resume' ? 'resume' : 'fresh', targetDir, filename => {
          try { return { ok: true, content: fs.readFileSync(filename) }; }
          catch { return { ok: false, reason: 'session_unreadable' }; }
        }, { knownKeyValues });
        if (collected.uncaptured.length) {
          replayInput.complete = false; replayInput.incompleteReasons.push('files_uncaptured');
        }
        if (input.projectSkillsPending === true) {
          collected.gitSnapshot.skillInventoryStatus = 'pending';
          replayInput.complete = false; replayInput.incompleteReasons.push('project_skills_pending');
        }
        for (const plan of plans) collected.blobs.set(plan.hash, plan.content);
        const cp: any = {
          schemaVersion: 2, checkpointId: crypto.randomUUID(), projectId, targetDir,
          conversationId: String(input.conversationId || ''), turnId: String(input.turnId || ''), agentId: String(input.agentId || ''),
          createdAt: new Date().toISOString(), status: 'staged', files: collected.files, deletions: collected.deletions,
          uncaptured: collected.uncaptured, skipped: collected.uncaptured, gitSnapshot: collected.gitSnapshot,
          integrity: { algorithm: 'sha256', platform: process.platform, knownLimitations: ['best_effort_git_snapshot', 'no_atomic_snapshot',
            'source_repository_required_for_replay', 'index_staging_not_preserved', 'submodules_and_nested_repositories_not_supported'] },
          consistency: { evidence: 'best-effort', atomicityGuaranteed: false, secondScanMode: 'none', retries: 0 },
          replayInput, environment: input.environment || {}, strictEvalEligible: false,
          strictEvalBlockedReason: 'no_independent_consistency_evidence',
          stats: { fileCount: collected.gitSnapshot.baseFileCount + Object.values(collected.files).filter((f: any) => f.origin === 'untracked').length,
            overlayFileCount: Object.keys(collected.files).length,
            totalBytes: [...collected.blobs.values()].reduce((sum: number, bytes: any) => sum + bytes.length, 0),
            skippedCount: collected.uncaptured.length, durationMs: Date.now() - started },
        };
        // Sanitize metadata too (e.g. known values in config/run labels), not
        // arbitrary patterns. Original key values are never a manifest field.
        const safeCheckpoint = JSON.parse(redactKnownKeyValues(Buffer.from(JSON.stringify(cp)), knownKeyValues).content.toString('utf8'));
        return writeSync(() => publishPreparedCheckpoint({ store, checkpoint: safeCheckpoint, blobs: collected.blobs }));
      });
      const result = { ...outcome, durationMs: Date.now() - started };
      recordCaptureResult(options, input, result);
      return result;
    } catch {
      const result = failed('git_snapshot_unavailable');
      recordCaptureResult(options, input, result);
      return result; // never expose content/keys or block the turn
    }
  } };
}
