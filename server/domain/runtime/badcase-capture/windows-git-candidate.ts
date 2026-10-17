// Internal LOCAL Git subset prototype, NOT a turn collector/enable capability.
// No Git execution, implicit global config reads, external gitdir expansion,
// install/re-pin, persistence or fallback to the unclassified all-file reader.
// Requires visible canonical .git directory/config/index and verified local
// grammar. Missing/unsupported classification blocks ordinary content reads.
import { prepareWindowsMetadataScope } from './windows-estimate';
import { invokeWindowsHelper, invokeWindowsGitHelper, encodeWindowsHelperRequest } from './windows-helper';
const { performance } = require('node:perf_hooks');
import { parseGitIndex, parseGitConfigSubset, parseGitignoreRules, classifyWalkEntries } from './git-classify';
import { matchesRelativePattern } from './capture-policy';
import { containsSecretSentinel } from './secrets';
const { TextDecoder } = require('node:util');
const crypto = require('node:crypto');
const fail = (reason: string) => ({ ok: false, reason });
const isGit = (p: string) => p === '.git' || p.startsWith('.git/');
const signature = (result: any) => crypto.createHash('sha256').update(JSON.stringify({
  entries: result.entries, files: result.files.map((f: any) => ({
    path: f.path, size: f.size, sha256: f.sha256, identity: f.identity,
  })),
})).digest('hex');
const tree = (result: any) => JSON.stringify(result.entries.filter((e: any) => !isGit(e.path)));

function classify(metadata: any, included: string[]): any {
  const entries = new Map<string, any>(metadata.entries.map((e: any) => [e.path, e]));
  if (entries.get('.git')?.type !== 'directory' || entries.has('.git/commondir')) return fail('git_metadata_unsupported');
  const sources = new Map<string, any>(metadata.files.map((f: any) => [f.path, f]));
  const config = sources.get('.git/config'), index = sources.get('.git/index');
  if (!config || !index) return fail('git_metadata_missing');
  // Classification bytes are not CAS plans. Reject any secret before parsing;
  // never return their hashes, identities, content or interpreter error text.
  if (metadata.files.some((f: any) => containsSecretSentinel(f.content))) return fail('git_metadata_secret_excluded');
  const text = (f: any) => new TextDecoder('utf-8', { fatal: true }).decode(f.content);
  const subset = parseGitConfigSubset(text(config));
  if (!subset.verified || subset.hasInclude || subset.excludesFile
      || (subset.objectFormat && !['sha1', 'sha256'].includes(subset.objectFormat))) return fail('git_metadata_unsupported');
  const parsed = parseGitIndex(index.content, subset.objectFormat === 'sha256' ? 32 : 20, { stageZero: true });
  if (!parsed.ok) return fail('git_index_invalid');
  const modes = new Map<string, number>();
  for (const e of parsed.entries) {
    // Reject stages/duplicate or nonportable paths; no case folding/8.3 guess.
    // Symlink checkout semantics are not supported by this Windows candidate.
    if (![0o100644, 0o100755].includes(e.mode) || modes.has(e.path)
        || !encodeWindowsHelperRequest({ version: 1, op: 'selectedSnapshot', root: 'C:/validation',
          expected: metadata.identity, excluded: [], paths: [e.path] })) return fail('git_index_invalid');
    modes.set(e.path, e.mode);
  }
  const gitignoreByDir = new Map<string, any>(), globalIgnoreSources: any[] = [];
  for (const file of metadata.files) {
    if (file.path === '.git/info/exclude' || (!isGit(file.path) && file.path.split('/').at(-1) === '.gitignore')) {
      const rules = parseGitignoreRules(text(file));
      if (!(rules as any).verified) return fail('git_ignore_unverified');
      if (file.path === '.git/info/exclude') globalIgnoreSources.push({ base: '', rules });
      else gitignoreByDir.set(file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '', rules);
    }
  }
  const classification = classifyWalkEntries(metadata.entries.filter((e: any) => !isGit(e.path)).map((e: any) => ({
    path: e.path, type: e.type === 'directory' ? 'dir' : 'file',
  })), { tracked: new Set(modes.keys()), applyIgnore: true, gitignoreByDir, globalIgnoreSources,
    isIncludedIgnored: (p: string) => matchesRelativePattern(p, included) });
  const paths = classification.candidates.map((e: any) => e.path).sort((a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return { ok: true, paths, modes };
}

// One shared state machine: async may not relax classification or bypass a
// failed phase by retrying through the legacy synchronous transport.
function* candidateSteps(options: any): Generator<any, any, any> {
    const plan = prepareWindowsMetadataScope(options);
    if (!plan.ok) return fail(plan.reason);
    const included = options.policy?.includedIgnoredPatterns;
    if (!Array.isArray(included) || included.some((p: any) => typeof p !== 'string' || !p
        || !encodeWindowsHelperRequest({ ...plan.request, op: 'selectedSnapshot',
          paths: [p.replace(/\\/g, '/').replace(/\/(\*\*|\*)$/, '')] }))) return fail('git_policy_invalid');
    const request = { ...plan.request, op: 'gitMetadata' };
    const before = yield { helperPath: plan.helperPath, request };
    if (!before.ok) return fail(before.reason);
    const selected = classify(before, included);
    if (!selected.ok) return selected;
    const selection = { ...plan.request, op: 'selectedSnapshot', paths: selected.paths };
    if (!encodeWindowsHelperRequest(selection)) return fail('git_selection_limit');
    const snapshot = yield { helperPath: plan.helperPath, request: selection };
    if (!snapshot.ok) return fail(snapshot.reason);
    // Compare full non-Git manifests, not just selected files. No CAS plans
    // survive an add/delete/identity/metadata change across classification.
    if (tree(before) !== tree(snapshot)) return fail('git_metadata_changed');
    const after = yield { helperPath: plan.helperPath, request };
    if (!after.ok) return fail(after.reason);
    if (signature(before) !== signature(after)) return fail('git_metadata_changed');
    const files: any = Object.create(null), blobs = new Map<string, any>();
    for (const file of snapshot.files) {
      const mode = selected.modes.get(file.path) || 0o100644;
      if (containsSecretSentinel(file.content)) files[file.path] = { type: 'file', size: Number(file.size), mode, secretExcluded: true };
      else {
        files[file.path] = { type: 'file', size: Number(file.size), mode, hash: file.sha256 };
        if (!blobs.has(file.sha256)) {
          const owned = Buffer.alloc(file.content.length); file.content.copy(owned); blobs.set(file.sha256, owned);
        }
      }
    }
    return { ok: true, reason: '', files, blobs, classification: 'bounded_local_git_subset_v1',
      complete: false, strictEvalEligible: false, captureAvailable: false,
      limitations: ['no_atomic_snapshot', 'no_independent_consistency_evidence', 'metadata_aba_residual',
        'known_sensitive_names_excluded', 'ambient_global_git_excludes_not_read',
        'external_gitdir_and_unverified_config_blocked', 'excluded_git_metadata_not_overridden',
        'untracked_windows_mode_synthesized_0644', 'deletion_history_not_collected', 'empty_directories_not_restored',
        'session_and_invocation_not_collected', 'windows_turn_collector_not_connected'] };
}

// Legacy internal synchronous entry retains its per-child 25s limits. Not used
// as a fallback by async; neither entry is connected to turn/API/enable paths.
export function readWindowsGitFileCandidate(options: any): any {
  try {
    const steps = candidateSteps(options);
    let state = steps.next();
    while (!state.done) {
      state = steps.next(invokeWindowsHelper('python', state.value.helperPath, state.value.request));
    }
    return state.value;
  } catch { return fail('windows_git_candidate_unavailable'); }
}

export async function readWindowsGitFileCandidateAsync(options: any): Promise<any> {
  // Observed monotonic deadline includes scope compilation, wire validation,
  // classification and owned-blob construction, not three fresh child budgets.
  // Synchronous fs/parsing cannot be preempted; late completion is rejected.
  const deadline = performance.now() + 25000;
  try {
    const steps = candidateSteps(options);
    let state = steps.next();
    while (true) {
      if (performance.now() >= deadline) return fail('git_capture_timeout');
      if (state.done) {
        if (state.value.ok) state.value.limitations.push('async_git_chain_25s_observed_deadline');
        return state.value;
      }
      const result = await invokeWindowsGitHelper('python', state.value.helperPath, state.value.request, deadline);
      if (performance.now() >= deadline) return fail('git_capture_timeout');
      state = steps.next(result);
    }
  } catch { return fail('windows_git_candidate_unavailable'); }
}
