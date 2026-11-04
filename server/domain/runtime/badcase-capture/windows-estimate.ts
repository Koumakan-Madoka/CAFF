// Windows pre-enable metadata preview, NOT capture. Only exact persisted native
// roots; never follow an alias as the helper target, enumerate using Node,
// read content, install or
// re-pin. The estimate protocol enforces versioned sensitive-name pruning at
// every depth BEFORE opening children. Unknown secret names are not detectable
// from metadata; this preview must not be promoted to a content collector.
const path = require('node:path');
const fs = require('node:fs');
import { WINDOWS_HELPER_SOURCE_SHA256 } from './windows-helper-source';
import { encodeWindowsHelperRequest, invokeWindowsHelper, invokeWindowsEstimateHelper } from './windows-helper';

const fail = (reason: string) => ({ ok: false, reason, fileCount: 0, totalBytes: 0 });
const normalized = (p: string) => path.win32.resolve(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const under = (root: string, target: string) => target === root || target.startsWith(`${root}/`);

// Internal scope compiler shared with the unconnected file-candidate adapter.
// It always creates an estimate request; a caller cannot change the operation
// or inject a path selector through options. Native identity is never re-pinned.
export function prepareWindowsMetadataScope(options: any): any {
  if (process.platform !== 'win32') return fail('windows_required');
  const policy = options.policy;
  const target = options.targetDir;
  if (typeof target !== 'string' || !path.win32.isAbsolute(target)) return fail('target_dir_missing');
  const root = path.win32.resolve(target);
  const key = normalized(root);
  const dirs = Array.isArray(policy?.authorizedDirs) ? policy.authorizedDirs : [];
  const dir = dirs.find((value: any) => typeof value === 'string' && normalized(value) === key);
  if (!dir) return fail(dirs.some((value: any) => typeof value === 'string' && under(normalized(value), key))
    ? 'target_must_be_authorized_root' : 'dir_not_authorized');
  const pin = policy?.authorizedDirPins?.[path.win32.resolve(dir).toLowerCase()];
  if (!pin?.identity || typeof pin.realpath !== 'string' || normalized(pin.realpath) !== key) {
    return fail('authorized_root_unpinned');
  }
  if (typeof options.captureRoot !== 'string' || !path.win32.isAbsolute(options.captureRoot)) {
    return fail('windows_estimate_policy_invalid');
  }
  if (!Array.isArray(policy.excludedPatterns)) return fail('windows_estimate_policy_invalid');
  const excluded: string[] = [];
  for (const value of policy.excludedPatterns) {
    if (typeof value !== 'string') return fail('windows_estimate_policy_invalid');
    // Existing policy semantics are exact paths/component prefixes, NOT glob.
    const literal = value.replace(/\\/g, '/').replace(/\/(?:\*\*|\*)$/, '');
    if (!literal || /[*?]/.test(literal)) return fail('windows_estimate_policy_invalid');
    excluded.push(literal);
  }
  if (!encodeWindowsHelperRequest({ version: 1, op: 'estimate', root, expected: pin.identity, excluded })) {
    return fail('windows_estimate_policy_invalid');
  }
  // Metadata-only canonical-name check: reject root aliases, do NOT replace
  // the literal helper target with realpath (which could erase a junction).
  // Protected TCB directory aliases contribute BOTH literal and canonical
  // exclusions; a private/storage alias may point back into the worktree.
  try {
    if (normalized(fs.realpathSync.native(root)) !== key) return fail('estimate_scope_rejected');
  } catch { return fail('estimate_scope_unverifiable'); }
  if (options.privateDirs !== undefined && (!Array.isArray(options.privateDirs)
    || options.privateDirs.some((p: any) => typeof p !== 'string' || !p))) return fail('windows_estimate_policy_invalid');
  const protectedRoots = [options.captureRoot, options.agentDir, ...(options.privateDirs || []),
    process.env.PI_AGENT_SANDBOX_DIR, process.env.PI_AGENT_PRIVATE_DIR].filter(Boolean);
  for (const protectedRoot of protectedRoots) {
    if (typeof protectedRoot !== 'string' || !/^[a-z]:[\\/]/i.test(protectedRoot)
        || !path.win32.isAbsolute(protectedRoot)) return fail('windows_estimate_policy_invalid');
    const literal = path.win32.resolve(protectedRoot);
    const variants = [literal];
    try { variants.push(fs.realpathSync.native(literal)); }
    catch (error: any) { if (error?.code !== 'ENOENT') return fail('estimate_scope_unverifiable'); }
    for (const absolute of variants) {
      const guard = normalized(absolute);
      if (under(guard, key)) return fail('estimate_scope_rejected');
      if (under(key, guard)) excluded.push(path.win32.relative(root, absolute).replace(/\\/g, '/'));
    }
  }
  const request = { version: 1, op: 'estimate', root, expected: pin.identity, excluded: [...new Set(excluded)] };
  if (!encodeWindowsHelperRequest(request)) return fail('windows_estimate_policy_invalid');
  return { ok: true, request, helperPath: path.join(options.captureRoot, 'windows-authorization-helper',
    `windows_read.${WINDOWS_HELPER_SOURCE_SHA256}.py`) };
}

function summarize(result: any): any {
  if (!result.ok) return fail(result.reason || 'windows_estimate_unavailable');
  let total = 0n, count = 0;
  for (const entry of result.entries) {
    if (entry.type === 'file') { total += BigInt(entry.size); count++; }
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return fail('estimate_size_overflow');
  return { ok: true, reason: '', authorized: true, complete: true, uncaptured: [],
    fileCount: count, totalBytes: Number(total), includesIgnored: true,
    captureAvailable: false, exclusionPolicy: 'windows-metadata-v1',
    limitations: ['no_atomic_snapshot', 'ignored_included', 'known_sensitive_names_excluded',
      'content_not_scanned', 'session_image_and_manifest_costs_excluded', 'windows_collector_not_ready'] };
}

export function estimateWindowsDirectory(options: any): any {
  try {
    const plan = prepareWindowsMetadataScope(options);
    if (!plan.ok) return plan;
    // Explicit authorization installed this exact source. Preview may NOT
    // install/repair/re-authorize it. Fixed PATH python is trusted host TCB;
    // python3-only installations fail closed, never silently switch runtimes.
    return summarize(invokeWindowsHelper('python', plan.helperPath, plan.request));
  } catch { return fail('windows_estimate_unavailable'); }
}

export async function estimateWindowsDirectoryAsync(options: any): Promise<any> {
  try {
    const plan = prepareWindowsMetadataScope(options);
    if (!plan.ok) return plan;
    return summarize(await invokeWindowsEstimateHelper('python', plan.helperPath, plan.request, options.deadline));
  } catch { return fail('windows_estimate_unavailable'); }
}
