// Internal fixed external-Git-file read. NOT external Git classification,
// discovery, collector/enable wiring or archival. Each metadataRoot must itself
// be explicitly authorized/pinned as an input root (not just a worktree or a
// parent). The six fixed paths are validated by BOTH host and native protocol.
// Binary index bytes are preserved; pointers/config directives are never followed.
import path from 'node:path';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { WINDOWS_HELPER_SOURCE_SHA256 } from './windows-helper-source';
import { encodeWindowsHelperRequest, invokeWindowsGitInputHelper, invokeWindowsGitStateHelper } from './windows-helper';
import { containsSecretSentinel } from './secrets';
const fail = (reason: string) => ({ ok: false, reason });
const absolute = (p: any) => typeof p === 'string' && /^[a-z]:[\\/]/i.test(p);
const normalized = (p: string) => path.win32.resolve(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const under = (root: string, target: string) => target === root || target.startsWith(`${root}/`);

export function readWindowsGitMetadataInput(options: any = {}): Promise<any> {
  return readInput(options, 'gitInput');
}
// Separate capability for the trusted Room scope compiler. The native protocol
// independently caps .git/HEAD/branch/packed-refs to 1 MiB, never follows refs.
export function readWindowsGitStateInput(options: any = {}): Promise<any> {
  return readInput(options, 'gitState');
}
async function readInput(options: any, op: string): Promise<any> {
  const started = performance.now();
  if (options.deadline !== undefined && (typeof options.deadline !== 'number' || !Number.isFinite(options.deadline))) return fail('git_input_deadline_invalid');
  const deadline = Math.min(started + 25000, options.deadline ?? Infinity);
  if (started >= deadline) return fail('git_input_timeout');
  if (process.platform !== 'win32') return fail('windows_required');
  try {
    if (!absolute(options.metadataRoot) || !absolute(options.captureRoot)) return fail('git_input_not_authorized');
    const root = path.win32.resolve(options.metadataRoot), rootKey = normalized(root), policy = options.policy;
    const dirs = Array.isArray(policy?.authorizedInputDirs) ? policy.authorizedInputDirs : [];
    // Exact independent root only. Never infer commonDir, worktrees/id or a
    // parent authorization from pointer contents or ordinary worktree grants.
    const dir = dirs.find((p: any) => absolute(p) && normalized(p) === rootKey);
    if (!dir) return fail('git_input_not_authorized');
    const pin = policy?.authorizedInputPins?.[path.win32.resolve(dir).toLowerCase()];
    if (!pin?.identity || !absolute(pin.realpath) || normalized(pin.realpath) !== rootKey) return fail('git_input_root_unpinned');
    const request = { version: 1, op, root, expected: structuredClone(pin.identity), path: options.metadataPath };
    if (!encodeWindowsHelperRequest(request)) return fail('git_input_not_authorized');
    const target = path.win32.join(root, request.path), targetKey = normalized(target);
    // Canonical metadata is used only to REJECT aliases; NT receives literal
    // root and the fixed relative name, preserving all reparse boundaries.
    if (normalized(fs.realpathSync.native(root)) !== rootKey
      || normalized(fs.realpathSync.native(target)) !== targetKey) return fail('git_input_scope_rejected');
    if (options.privateDirs !== undefined && (!Array.isArray(options.privateDirs)
      || options.privateDirs.some((p: any) => !absolute(p)))) return fail('git_input_scope_rejected');
    const guards = [options.captureRoot, ...(options.privateDirs || []),
      process.env.PI_AGENT_SANDBOX_DIR, process.env.PI_AGENT_PRIVATE_DIR].filter(Boolean);
    for (const guard of guards) {
      if (!absolute(guard)) return fail('git_input_scope_rejected');
      const literal = path.win32.resolve(guard), variants = [literal];
      try { variants.push(fs.realpathSync.native(literal)); }
      catch (error: any) { if (error?.code !== 'ENOENT') return fail('git_input_scope_rejected'); }
      if (variants.some(p => under(normalized(p), targetKey))) return fail('git_input_scope_rejected');
    }
    if (performance.now() >= deadline) return fail('git_input_timeout');
    const helperPath = path.join(options.captureRoot, 'windows-authorization-helper', `windows_read.${WINDOWS_HELPER_SOURCE_SHA256}.py`);
    const helper = op === 'gitState' ? invokeWindowsGitStateHelper : invokeWindowsGitInputHelper;
    const result = await helper('python', helperPath, request, deadline);
    if (performance.now() >= deadline) return fail('git_input_timeout');
    if (!result.ok || !Buffer.isBuffer(result.file?.content)) return fail('git_input_unavailable');
    const bytes = result.file.content;
    if (containsSecretSentinel(bytes)) return fail('git_input_contains_secret');
    // No UTF8 coercion: classification must independently parse text/index and
    // reject unsupported semantics. No hashes/identity escape rejected input.
    const owned = Buffer.alloc(bytes.length); bytes.copy(owned);
    if (performance.now() >= deadline) return fail('git_input_timeout');
    return { ok: true, reason: '', content: owned };
  } catch { return fail('git_input_unavailable'); }
}
