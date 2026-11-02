// Internal connection prototype, NOT a turn collector or an enable capability.
// Reads a bounded, policy-rooted native candidate into memory; no persistence,
// project policy changes, retries, session reads or caller-supplied file paths.
// Until Git/ignored classification is implemented, this must NOT be wired into
// ordinary turn collection: metadata-v1 pruning includes otherwise ignored files.
import { prepareWindowsMetadataScope } from './windows-estimate';
import { invokeWindowsHelper } from './windows-helper';
import { containsSecretSentinel } from './secrets';

export function readWindowsFileCandidate(options: any): any {
  const fail = (reason: string) => ({ ok: false, reason });
  try {
    const plan = prepareWindowsMetadataScope(options);
    if (!plan.ok) return fail(plan.reason);
    const result = invokeWindowsHelper('python', plan.helperPath, { ...plan.request, op: 'snapshot' });
    if (!result.ok) return fail(result.reason);
    // Transport validates ALL bytes/identities/lengths/hashes before any file
    // is exposed. Apply the existing full-byte sentinel before returning plans
    // to a trusted CAS writer. No hash/identity of a secret file is retained.
    const files: any = Object.create(null), blobs = new Map<string, any>();
    for (const file of result.files) {
      if (containsSecretSentinel(file.content)) {
        files[file.path] = { type: 'file', size: Number(file.size), mode: 0o100644, secretExcluded: true };
      } else {
        files[file.path] = { type: 'file', size: Number(file.size), mode: 0o100644, hash: file.sha256 };
        if (!blobs.has(file.sha256)) {
          // A wire subarray shares the ENTIRE response backing allocation,
          // including any excluded secrets. Do not return that backing buffer
          // (or a pooled copy) as a CAS plan. alloc() owns only these safe bytes.
          const owned = Buffer.alloc(file.content.length);
          file.content.copy(owned);
          blobs.set(file.sha256, owned);
        }
      }
    }
    return { ok: true, reason: '', files, blobs,
      consistency: { method: 'windows_two_content_reads_three_metadata_walks_v1', detectedChange: false },
      complete: false, strictEvalEligible: false, captureAvailable: false,
      limitations: ['no_atomic_snapshot', 'no_independent_consistency_evidence', 'metadata_aba_residual',
        'known_sensitive_names_excluded', 'git_ignored_classification_not_implemented',
        'windows_mode_synthesized_0644', 'empty_directories_not_restored',
        'session_and_invocation_not_collected', 'windows_turn_collector_not_connected'] };
  } catch { return fail('windows_candidate_unavailable'); }
}
