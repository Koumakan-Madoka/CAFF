// Bounded Git file-candidate used by the Windows service collector. Management
// enable stays closed; this is not a complete capture capability.
// No Git execution, implicit global config reads or pointer-derived authorization,
// install/re-pin, persistence or fallback to the unclassified all-file reader.
// Requires visible canonical .git metadata and verified config/index grammar.
// External layout is opt-in with TWO exact independent input roots. Missing or
// unsupported classification blocks ordinary content reads.
import path from 'node:path';
import { readWindowsGitMetadataInput } from './windows-git-input';
import { prepareWindowsMetadataScope } from './windows-estimate';
import { invokeWindowsHelper, invokeWindowsGitHelper, encodeWindowsHelperRequest } from './windows-helper';
const { performance } = require('node:perf_hooks');
import { parseGitIndex, parseGitConfigSubset, parseGitignoreRules, classifyWalkEntries } from './git-classify';
import { matchesRelativePattern } from './capture-policy';
import { containsSecretSentinel } from './secrets';
import { WINDOWS_HELPER_SOURCE_SHA256 } from './windows-helper-source';
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

// Git's ASCII case folding is byte-wise, NOT JS/NT Unicode case folding. In
// ignorecase mode reject non-ASCII paths/patterns and ambiguous component casing
// (including two index parent spellings). This projection is classification
// only: exact native selectors and persisted paths always retain disk spelling.
function asciiPathSet(paths: string[]): boolean {
  if (paths.length > 100000) return false;
  const spellings = new Map<string, string>(), full = new Set<string>();
  for (const p of paths) {
    if (Buffer.byteLength(p) > 32768 || /[^\x00-\x7f]/.test(p) || full.has(p.toLowerCase())) return false;
    full.add(p.toLowerCase());
    const parts = p.split('/');
    if (parts.length > 64) return false;
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'), key = prefix.toLowerCase();
      if (spellings.has(key) && spellings.get(key) !== prefix) return false;
      spellings.set(key, prefix);
    }
  }
  return true;
}

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
  const subset = parseGitConfigSubset(text(config), { allowIgnoreCase: true });
  if (!subset.verified || subset.hasInclude || subset.excludesFile
      || (subset.objectFormat && !['sha1', 'sha256'].includes(subset.objectFormat))) return fail('git_metadata_unsupported');
  const parsed = parseGitIndex(index.content, subset.objectFormat === 'sha256' ? 32 : 20, { stageZero: true });
  if (!parsed.ok) return fail('git_index_invalid');
  const ignoreCase = subset.ignoreCase === true;
  if (ignoreCase && (!asciiPathSet(metadata.entries.map((e: any) => e.path))
    || !asciiPathSet(parsed.entries.map((e: any) => e.path))
    || metadata.entries.some((e: any) => e.path.split('/').at(-1).toLowerCase() === '.gitignore'
      && e.path.split('/').at(-1) !== '.gitignore'))) return fail('git_ignorecase_unverified');
  const key = (p: string) => ignoreCase ? p.toLowerCase() : p;
  const canonicalPaths = new Map<string, string>(metadata.entries.map((e: any) => [key(e.path), e.path]));
  const modes = new Map<string, number>();
  for (const e of parsed.entries) {
    // Reject stages/duplicate or nonportable paths; no native alias/8.3 guess.
    // Symlink checkout semantics are not supported by this Windows candidate.
    if (![0o100644, 0o100755].includes(e.mode) || modes.has(key(e.path))
        || !encodeWindowsHelperRequest({ version: 1, op: 'selectedSnapshot', root: 'C:/validation',
          expected: metadata.identity, excluded: [], paths: [e.path] })) return fail('git_index_invalid');
    modes.set(key(e.path), e.mode);
  }
  const gitignoreByDir = new Map<string, any>(), globalIgnoreSources: any[] = [];
  for (const file of metadata.files) {
    if (file.path === '.git/info/exclude' || (!isGit(file.path) && file.path.split('/').at(-1) === '.gitignore')) {
      const sourceText = text(file);
      // Character-class range endpoints need Git's casefold wildmatch rules;
      // lowercasing e.g. [A-z] is NOT equivalent. Reject rather than overclaim.
      if (ignoreCase && (/[^\x00-\x7f]/.test(sourceText) || sourceText.includes('['))) return fail('git_ignorecase_unverified');
      const rules = parseGitignoreRules(ignoreCase ? sourceText.toLowerCase() : sourceText);
      if (!(rules as any).verified) return fail('git_ignore_unverified');
      if (file.path === '.git/info/exclude') globalIgnoreSources.push({ base: '', rules });
      else gitignoreByDir.set(file.path.includes('/') ? key(file.path.slice(0, file.path.lastIndexOf('/'))) : '', rules);
    }
  }
  const classification = classifyWalkEntries(metadata.entries.filter((e: any) => !isGit(e.path)).map((e: any) => ({
    path: key(e.path), type: e.type === 'directory' ? 'dir' : 'file',
  })), { tracked: new Set(modes.keys()), applyIgnore: true, gitignoreByDir, globalIgnoreSources,
    isIncludedIgnored: (p: string) => matchesRelativePattern(canonicalPaths.get(p), included) });
  const paths = classification.candidates.map((e: any) => canonicalPaths.get(e.path)!).sort((a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return { ok: true, paths, ignoreCase, modes: new Map(paths.map((p: string) => [p, modes.get(key(p)) || 0o100644])) };
}

const rootKey = (p: string) => path.win32.resolve(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const within = (root: string, target: string) => target === root || target.startsWith(`${root}/`);

// Explicit, independently authorized roots only. Parsed pointers are comparisons,
// NEVER lookup keys, grants or helper targets. The reader still verifies literal
// scope, protected roots and the original native pin on EVERY external read.
function externalBinding(options: any, metadata: any): any {
  const roots = options.externalGit;
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)
    || Object.keys(roots).length !== 2 || !['metadataRoot', 'commonRoot'].every(k => Object.hasOwn(roots, k))) return fail('git_external_not_authorized');
  const authorized = options.policy?.authorizedInputDirs, pins = options.policy?.authorizedInputPins;
  const work = rootKey(options.targetDir);
  for (const root of [roots.metadataRoot, roots.commonRoot]) {
    if (typeof root !== 'string' || !/^[a-z]:[\\/]/i.test(root)
      || !Array.isArray(authorized) || !authorized.some((p: any) => typeof p === 'string' && /^[a-z]:[\\/]/i.test(p) && rootKey(p) === rootKey(root))) return fail('git_external_not_authorized');
    const pin = pins?.[path.win32.resolve(root).toLowerCase()];
    if (!pin || typeof pin.realpath !== 'string' || !/^[a-z]:[\\/]/i.test(pin.realpath)
      || rootKey(pin.realpath) !== rootKey(root) || within(work, rootKey(root))
      || !encodeWindowsHelperRequest({ version: 1, op: 'gitInput', root, expected: pin.identity, path: 'index' })) return fail('git_external_not_authorized');
  }
  if (rootKey(roots.metadataRoot) === rootKey(roots.commonRoot)) return fail('git_external_not_authorized');
  const marker = metadata.files.find((f: any) => f.path === '.git');
  if (metadata.entries.find((e: any) => e.path === '.git')?.type !== 'file' || !marker
    || !pointerMatches(marker.content, options.targetDir, roots.metadataRoot, true)) return fail('git_external_pointer_invalid');
  return { ok: true, roots };
}

function pointerMatches(bytes: any, base: string, expected: string, gitfile = false): boolean {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > 32768 || containsSecretSentinel(bytes)) return false;
    let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r?\n$/, '');
    if (gitfile) { if (!text.startsWith('gitdir: ')) return false; text = text.slice(8); }
    if (!text || text !== text.trim() || /[\x00-\x1f\x7f\ufeff]/.test(text)
      || /^[\\/]/.test(text) || (/^[a-z]:/i.test(text) && !/^[a-z]:[\\/]/i.test(text))) return false;
    return rootKey(path.win32.resolve(base, text)) === rootKey(expected);
  } catch { return false; }
}

// All five sources are required in this bounded subset. Missing info/exclude
// blocks rather than guessing absence; worktreeConfig/includes/global ignores
// remain unsupported. No optional-file discovery or implicit ambient reads.
function* externalSources(options: any, roots: any): Generator<any, any, any> {
  const sources = new Map<string, any>();
  let totalBytes = 0;
  for (const name of ['commondir', 'gitdir', 'config', 'index', 'info/exclude']) {
    const root = ['commondir', 'gitdir', 'index'].includes(name) ? roots.metadataRoot : roots.commonRoot;
    const result = yield { gitInput: { metadataRoot: root, metadataPath: name } };
    if (!result.ok || !Buffer.isBuffer(result.content)) return fail('git_external_input_unavailable');
    totalBytes += result.content.length;
    if (totalBytes > 128 * 1024 * 1024) return fail('git_external_input_limit');
    if (containsSecretSentinel(result.content)) return fail('git_metadata_secret_excluded');
    sources.set(name, result.content);
    if (name === 'commondir' && !pointerMatches(result.content, roots.metadataRoot, roots.commonRoot)) return fail('git_external_pointer_invalid');
    if (name === 'gitdir' && !pointerMatches(result.content, roots.metadataRoot, path.win32.join(options.targetDir, '.git'))) return fail('git_external_pointer_invalid');
  }
  return { ok: true, sources };
}
const externalSignature = (sources: Map<string, any>) => JSON.stringify([...sources].map(([name, bytes]) => [name, crypto.createHash('sha256').update(bytes).digest('hex')]));
function classificationView(metadata: any, sources: Map<string, any>): any {
  return { ...metadata, entries: [...metadata.entries.filter((e: any) => !isGit(e.path)), { path: '.git', type: 'directory' }],
    files: [...metadata.files.filter((f: any) => !isGit(f.path)), ...['config', 'index', 'info/exclude'].map(name => ({ path: `.git/${name}`, content: sources.get(name) }))] };
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
    let external: any = null, externalBefore: any = null;
    if (options.externalGit !== undefined || before.entries.find((e: any) => e.path === '.git')?.type === 'file') {
      // An unselected gitfile keeps the legacy fail-closed behavior.
      if (options.externalGit === undefined) return fail('git_metadata_unsupported');
      external = externalBinding(options, before);
      if (!external.ok) return external;
      externalBefore = yield* externalSources(options, external.roots);
      if (!externalBefore.ok) return externalBefore;
    }
    const selected = classify(external ? classificationView(before, externalBefore.sources) : before, included);
    if (!selected.ok) return selected;
    if (external) {
      externalBefore.signature = externalSignature(externalBefore.sources);
      externalBefore.sources.clear(); // retain only digests across ordinary content capture
    }
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
    if (external) {
      const checked = externalBinding(options, after);
      if (!checked.ok) return checked;
      const externalAfter = yield* externalSources(options, external.roots);
      if (!externalAfter.ok) return externalAfter;
      if (externalBefore.signature !== externalSignature(externalAfter.sources)) return fail('git_metadata_changed');
    }
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
    // Ephemeral FULL observed namespace (including ignored/secret files and
    // directories), never the content selection. The scope binds the original
    // root identity, literal target, compiled exclusions and native prune code.
    // Emit only after every revalidation; no new atomic/ABA claim is implied.
    const observation = {
      scopeHash: crypto.createHash('sha256').update(JSON.stringify({ request: plan.request,
        helperSha256: WINDOWS_HELPER_SOURCE_SHA256 })).digest('hex'),
      presentPaths: before.entries.filter((e: any) => !isGit(e.path)).map((e: any) => e.path),
    };
    return { ok: true, reason: '', files, blobs, observation, classification: external ? 'bounded_external_git_subset_v1' : 'bounded_local_git_subset_v1',
      complete: false, strictEvalEligible: false, captureAvailable: false,
      limitations: ['no_atomic_snapshot', 'no_independent_consistency_evidence', 'metadata_aba_residual',
        'known_sensitive_names_excluded', 'ambient_global_git_excludes_not_read',
        ...(selected.ignoreCase ? ['windows_ignorecase_ascii_projection'] : []),
        ...(external ? ['external_roots_explicitly_selected_and_pinned', 'external_info_exclude_required', 'external_cross_read_identity_aba_residual']
          : ['external_gitdir_and_unverified_config_blocked']), 'excluded_git_metadata_not_overridden',
        'untracked_windows_mode_synthesized_0644', 'deletion_history_not_collected', 'empty_directories_not_restored',
        'session_and_invocation_not_collected', 'windows_turn_collector_not_connected'] };
}

// Legacy internal synchronous entry retains its per-child 25s limits. Not used
// as a fallback by async; only async is used by the Windows service collector.
export function readWindowsGitFileCandidate(options: any): any {
  try {
    if (options.externalGit !== undefined) return fail('git_external_async_required');
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
  const started = performance.now();
  if (options.deadline !== undefined && (typeof options.deadline !== 'number' || !Number.isFinite(options.deadline))) return fail('git_capture_deadline_invalid');
  const deadline = Math.min(started + 25000, options.deadline ?? Infinity);
  if (started >= deadline) return fail('git_capture_timeout');
  try {
    // Lock selected roots, pins, policy and worktree before the first await.
    options = structuredClone(options);
    const steps = candidateSteps(options);
    let state = steps.next();
    while (true) {
      if (performance.now() >= deadline) return fail('git_capture_timeout');
      if (state.done) {
        if (state.value.ok) state.value.limitations.push('async_git_chain_25s_observed_deadline');
        return state.value;
      }
      const result = state.value.gitInput
        ? await readWindowsGitMetadataInput({ ...state.value.gitInput, policy: options.policy,
          captureRoot: options.captureRoot, privateDirs: [...(options.privateDirs || []), ...(options.agentDir ? [options.agentDir] : [])], deadline })
        : await invokeWindowsGitHelper('python', state.value.helperPath, state.value.request, deadline);
      if (performance.now() >= deadline) return fail('git_capture_timeout');
      state = steps.next(result);
    }
  } catch { return fail('windows_git_candidate_unavailable'); }
}
