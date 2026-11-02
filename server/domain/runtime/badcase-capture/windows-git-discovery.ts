// Management-only suggestions, NOT grants or capture capability. Every read
// uses an already independently pinned root. A pointer may propose the NEXT
// root for human confirmation, but may never be followed as read authority.
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { prepareWindowsMetadataScope } from './windows-estimate';
import { encodeWindowsHelperRequest, invokeWindowsGitHelper } from './windows-helper';
import { readWindowsGitMetadataInput } from './windows-git-input';
import { containsSecretSentinel } from './secrets';
const fail = (reason: string) => ({ ok: false, reason });
const key = (p: string) => path.win32.resolve(p).toLowerCase();
const within = (root: string, p: string) => key(p) === key(root) || key(p).startsWith(key(root) + '\\');
function pointer(bytes: any, base: string, marker = false): string {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32768 || containsSecretSentinel(bytes)) throw Error('pointer');
  let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r?\n$/, '');
  if (marker) { if (!text.startsWith('gitdir: ')) throw Error('pointer'); text = text.slice(8); }
  if (!text || text !== text.trim() || /[\x00-\x1f\x7f\ufeff]/.test(text)
    || /^[\\/]/.test(text) || (/^[a-z]:/i.test(text) && !/^[a-z]:[\\/]/i.test(text))) throw Error('pointer');
  const root = path.win32.resolve(base, text);
  if (!encodeWindowsHelperRequest({ version: 1, op: 'identity', root })) throw Error('pointer');
  return root;
}
export async function discoverWindowsGitDependencies(value: any = {}): Promise<any> {
  if (process.platform !== 'win32') return fail('git_discovery_windows_only');
  const deadline = performance.now() + 25000;
  try {
    const options = structuredClone(value);
    const scope = prepareWindowsMetadataScope(options);
    if (!scope.ok) return fail(scope.reason);
    // Existing audited metadata-only Git operation: it may enumerate the
    // authorized worktree and read its Git classification sources, never
    // ordinary file contents or a target named by the .git file.
    // This explicit management action separately confirms reading .git's
    // bounded classification sources (never archiving .git). File collection
    // exclusions remain unchanged; no other exclusion/private guard is relaxed.
    const excluded = scope.request.excluded.filter((p: string) => p.toLowerCase() !== '.git');
    const metadata = await invokeWindowsGitHelper('python', scope.helperPath, { ...scope.request, excluded, op: 'gitMetadata' }, deadline);
    if (performance.now() >= deadline) return fail('git_discovery_timeout');
    if (!metadata.ok) return fail(metadata.reason);
    const targetDir = scope.request.root;
    const marker = metadata.entries.find((e: any) => e.path === '.git');
    if (marker?.type === 'directory') return { ok: true, ready: true, next: null, selection: null, targetDir };
    if (marker?.type !== 'file') return fail('git_discovery_marker_missing');
    const metadataRoot = pointer(metadata.files.find((f: any) => f.path === '.git')?.content, targetDir, true);
    if (within(targetDir, metadataRoot)) return fail('git_discovery_layout_unsupported');
    const authorized = (root: string) => options.policy.authorizedInputDirs.some((p: string) => key(p) === key(root));
    if (!authorized(metadataRoot)) return { ok: true, ready: false, targetDir,
      next: { kind: 'metadata', path: metadataRoot }, selection: null };
    const read = async (name: string) => {
      const result = await readWindowsGitMetadataInput({ policy: options.policy, captureRoot: options.captureRoot,
        privateDirs: [...(options.privateDirs || []), ...(options.agentDir ? [options.agentDir] : [])],
        metadataRoot, metadataPath: name, deadline });
      if (performance.now() >= deadline) throw Error('deadline');
      if (!result.ok) return result;
      return { ok: true, path: pointer(result.content, metadataRoot) };
    };
    const backlink = await read('gitdir');
    if (!backlink.ok) return fail(backlink.reason);
    if (key(backlink.path) !== key(path.win32.join(targetDir, '.git'))) return fail('git_discovery_backlink_mismatch');
    const common = await read('commondir');
    if (!common.ok) return fail(common.reason);
    const commonRoot = common.path;
    if (within(targetDir, commonRoot) || key(commonRoot) === key(metadataRoot)) return fail('git_discovery_layout_unsupported');
    const selection = { worktree: targetDir, metadataRoot, commonRoot };
    // Even when both roots are already granted, this does not persist a binding
    // or validate classification/enable support. The capture path revalidates
    // all pointers, roots and supported grammar independently on every turn.
    return { ok: true, ready: authorized(commonRoot), targetDir, selection,
      next: authorized(commonRoot) ? null : { kind: 'common', path: commonRoot } };
  } catch { return fail(performance.now() >= deadline ? 'git_discovery_timeout' : 'git_discovery_unavailable'); }
}
