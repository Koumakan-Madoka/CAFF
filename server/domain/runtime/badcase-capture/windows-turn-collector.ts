// Windows service collector. Management enable requires its separate supported
// host environment and classified metadata estimate, never a raw capacity scan.
// Bounded local/external Git limitations remain: no ambient global Git or
// independent consistency proof; deletion history requires a comparable prior
// checkpoint and ASCII namespace. Never advertise complete.
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { withAsyncProjectWriteLease } from './project-write-lock';
import { readWindowsGitFileCandidateAsync } from './windows-git-candidate';
import { prepareWindowsReplayInput } from './windows-replay-input';
import { selectWindowsExternalGit } from './windows-external-selection';
import { publishPreparedCheckpoint } from './checkpoint-publication';
import { WINDOWS_HELPER_SOURCE_SHA256 } from './windows-helper-source';

export function createWindowsTurnCollector(options: any = {}): any {
  const store = options.store;
  const readCallbackInput = options.readCallbackInput;
  const checkEnvironment = options.checkEnvironment;
  // Static trusted host configuration, not invocation-controlled exclusions.
  const agentDir = options.agentDir, privateDirs = structuredClone(options.privateDirs === undefined ? [] : options.privateDirs);
  return { async captureTurnCheckpoint(value: any = {}): Promise<any> {
    const started = performance.now(), deadline = started + 25000;
    const failed = (reason: string) => ({ captured: false, checkpointId: '', reason, durationMs: performance.now() - started });
    if (process.platform !== 'win32') return failed('windows_required');
    if (!store?.captureRoot) return failed('store_unavailable');
    try {
      // Latch ALL invocation data before first await, not just session path.
      const input = structuredClone(value), projectId = input.projectId;
      if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)
        || typeof input.targetDir !== 'string' || !/^[a-z]:[\\/]/i.test(input.targetDir)
        || !path.win32.isAbsolute(input.targetDir)
        || !['fresh', 'resume'].includes(input.deliveryMode)) return failed('windows_capture_input_invalid');
      const targetDir = path.win32.resolve(input.targetDir);
      // Project lock spans all helper awaits AND durable publication. Other
      // requests never gain ambient reentry; helpers settle through real close.
      const outcome = await withAsyncProjectWriteLease(store.captureRoot, projectId, async writeSync => {
        const policy = structuredClone(store.loadPolicy(projectId));
        if (policy.status !== 'enabled') return failed('policy_not_enabled');
        if (typeof checkEnvironment === 'function' && checkEnvironment() !== true) return failed('windows_git_environment_unsupported');
        if (performance.now() >= deadline) return failed('windows_capture_timeout');
        const files = await readWindowsGitFileCandidateAsync({ policy, targetDir, captureRoot: store.captureRoot,
          agentDir, privateDirs, deadline, externalGit: selectWindowsExternalGit(policy, targetDir) });
        if (performance.now() >= deadline) return failed('windows_capture_timeout');
        if (!files.ok) return failed(files.reason);
        if (typeof checkEnvironment === 'function' && checkEnvironment() !== true) return failed('windows_git_environment_unsupported');
        // Native file-root/pin/whole-tree checks succeeded under this lease.
        // Never trust a caller-supplied callback packet when a source is wired.
        if (typeof readCallbackInput === 'function') input.callbackInput = readCallbackInput(input, policy);
        const prepared = await prepareWindowsReplayInput({ input, policy, authorizedRoot: targetDir,
          captureRoot: store.captureRoot, privateDirs, deadline });
        if (performance.now() >= deadline) return failed('windows_capture_timeout');
        if (!prepared.ok) return failed(prepared.reason);
        const secretExcludedPaths = Object.keys(files.files).filter(p => files.files[p].secretExcluded === true).sort();
        const replayInput = prepared.replayInput;
        // A complete input validation must not erase the file candidate's
        // missing classification/environment/consistency dimensions.
        replayInput.complete = false;
        replayInput.incompleteReasons = [...new Set([...replayInput.incompleteReasons, 'windows_capture_subset_unverified',
          ...(secretExcludedPaths.length ? ['files_contain_secret'] : [])])];
        if (secretExcludedPaths.length) replayInput.secretExcludedPaths = secretExcludedPaths;
        const blobs = new Map(files.blobs);
        for (const plan of prepared.plans) blobs.set(plan.hash, plan.content);
        // Compare only same-scope native observations under this project lease.
        // A file omitted by Git rules/secret scanning is NOT necessarily absent.
        // Windows Unicode case equivalence is not JS casefold: infer nothing
        // unless the entire current namespace and prior filenames are ASCII.
        const observation = files.observation;
        const scopeHash = typeof observation?.scopeHash === 'string' && /^[a-f0-9]{64}$/.test(observation.scopeHash)
          ? observation.scopeHash : '';
        const previous = store.loadLatestCheckpoint(projectId, targetDir);
        const priorFiles = previous?.files;
        const ascii = (p: any) => typeof p === 'string' && p.length > 0 && !/[^\x20-\x7e]/.test(p);
        const comparable = !!scopeHash && Array.isArray(observation?.presentPaths) && observation.presentPaths.every(ascii)
          && previous?.schemaVersion === 1 && previous.projectId === projectId
          && typeof previous.targetDir === 'string' && path.win32.resolve(previous.targetDir) === targetDir
          && typeof previous.checkpointId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(previous.checkpointId)
          && previous.integrity?.platform === 'win32' && previous.integrity.windowsObservationScopeHash === scopeHash
          && priorFiles && typeof priorFiles === 'object' && !Array.isArray(priorFiles) && Object.keys(priorFiles).every(ascii);
        const present = new Set<string>(comparable ? observation.presentPaths.map((p: string) => p.toLowerCase()) : []);
        const historical: string[] = comparable ? Object.keys(priorFiles).filter(p => priorFiles[p]?.type === 'file'
          && priorFiles[p].secretExcluded !== true && !present.has(p.toLowerCase())) : [];
        const indexedVerified = files.indexDeletionsVerified === true && Array.isArray(files.indexDeletions);
        const priorSecrets = new Set<string>(comparable ? Object.keys(priorFiles).filter(p => priorFiles[p]?.secretExcluded === true)
          .map(p => p.toLowerCase()) : []);
        // Index evidence is relative to the verified current index, not a prior
        // checkpoint. Never let it reintroduce a known comparable secret path.
        const indexed: string[] = indexedVerified ? files.indexDeletions.filter((p: string) => !priorSecrets.has(p.toLowerCase())) : [];
        const deletions = [...new Map([...historical, ...indexed].map(p => [p.toLowerCase(), p])).values()]
          .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        const manifestHash = crypto.createHash('sha256').update(JSON.stringify({
          files: Object.keys(files.files).sort().map(p => [p, files.files[p].hash || '', files.files[p].size || 0,
            files.files[p].secretExcluded === true]), deletions,
        })).digest('hex');
        const limitations = files.limitations.filter((s: string) => !['windows_turn_collector_not_connected',
          'session_and_invocation_not_collected', 'deletion_history_not_collected'].includes(s));
        limitations.push(...(typeof checkEnvironment === 'function' ? ['global_git_config_explicitly_disabled_in_host_runtime'] : []),
          'deletion_history_only_from_comparable_previous_checkpoint',
          ...(indexedVerified ? [] : ['tracked_deletions_before_first_checkpoint_not_inferred']),
          'known_comparable_secrets_and_type_replacements_not_inferred', ...(comparable ? [] : ['deletion_history_baseline_unavailable']));
        const checkpoint = {
          schemaVersion: 1, checkpointId: crypto.randomUUID(), projectId, targetDir,
          conversationId: String(input.conversationId || ''), turnId: String(input.turnId || ''), agentId: String(input.agentId || ''),
          createdAt: new Date().toISOString(), status: 'staged', files: files.files, deletions, skipped: [], uncaptured: [],
          gitMetadata: files.classification,
          integrity: { algorithm: 'sha256', manifestHash, helperSha256: WINDOWS_HELPER_SOURCE_SHA256, platform: 'win32',
            windowsObservationScopeHash: scopeHash, deletionHistoryBaselineId: comparable ? previous.checkpointId : '',
            indexedDeletionEvidence: indexedVerified ? 'verified_index_visible_ascii_v1' : '',
            knownLimitations: [...new Set([...limitations,
              ...(typeof readCallbackInput === 'function' ? ['callback_sqlite_snapshot_not_atomic_with_files'] : [])])] },
          consistency: { evidence: 'content-verified', atomicityGuaranteed: false, secondScanMode: 'full-hash', retries: 0, differingPaths: [] },
          replayInput, environment: input.environment || {}, strictEvalEligible: false,
          strictEvalBlockedReason: 'no_independent_consistency_evidence',
          stats: { fileCount: Object.keys(files.files).length,
            totalBytes: Object.values(files.files).reduce((sum: number, f: any) => sum + f.size, 0),
            secretExcludedFiles: secretExcludedPaths.length, durationMs: performance.now() - started },
        };
        // Last observed deadline is BEFORE publication. Synchronous CAS/JSON
        // writes are non-preemptible; once committed do not pretend rollback.
        if (performance.now() >= deadline) return failed('windows_capture_timeout');
        if (typeof checkEnvironment === 'function' && checkEnvironment() !== true) return failed('windows_git_environment_unsupported');
        return writeSync(() => publishPreparedCheckpoint({ store, checkpoint, blobs }));
      });
      // Lease cleanup must also succeed before a checkpoint association escapes.
      return { ...outcome, durationMs: performance.now() - started };
    } catch (error: any) {
      return failed(error?.code === 'capture_writer_busy' ? 'capture_writer_busy' : 'windows_capture_unavailable');
    }
  } };
}
