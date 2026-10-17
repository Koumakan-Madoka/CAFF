// Pure lexical selection, NOT authorization or pointer discovery. Persisted by
// management; every actual native read must still verify the independent pin.
import path from 'node:path';
const key = (p: string) => path.win32.resolve(p).toLowerCase();
const under = (root: string, target: string) => target === root || target.startsWith(root.endsWith('\\') ? root : `${root}\\`);
const invalid = () => { throw Object.assign(new Error('capture_external_git_selection_invalid'), { code: 'capture_external_git_selection_invalid' }); };
function absolute(value: any): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value !== value.trim()
    || /[\x00-\x1f\x7f\ufeff]/.test(value) || !/^[a-z]:[\\/]/i.test(value)) return invalid();
  return path.win32.resolve(value);
}
export function normalizeWindowsExternalGitSelection(value: any, scope: any): any[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return invalid();
  const result: any[] = [], seen = new Set<string>();
  const exact = (list: any, root: string) => Array.isArray(list) && list.some((p: any) =>
    typeof p === 'string' && /^[a-z]:[\\/]/i.test(p) && key(p) === key(root));
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 3
      || !['worktree', 'metadataRoot', 'commonRoot'].every(k => Object.hasOwn(entry, k))) return invalid();
    const worktree = absolute(entry.worktree), metadataRoot = absolute(entry.metadataRoot), commonRoot = absolute(entry.commonRoot);
    if (seen.has(key(worktree)) || !exact(scope?.authorizedDirs, worktree)
      || !exact(scope?.authorizedInputDirs, metadataRoot) || !exact(scope?.authorizedInputDirs, commonRoot)
      || key(metadataRoot) === key(commonRoot) || under(key(worktree), key(metadataRoot)) || under(key(worktree), key(commonRoot))) return invalid();
    seen.add(key(worktree)); result.push({ worktree, metadataRoot, commonRoot });
  }
  // Stable across reorder/casing of the lookup, but preserve chosen literal root
  // spelling for native alias checks; no realpath or directory access here.
  return result.sort((a, b) => key(a.worktree).localeCompare(key(b.worktree)));
}
export function selectWindowsExternalGit(policy: any, targetDir: string): any {
  const selections = normalizeWindowsExternalGitSelection(policy.windowsExternalGit, policy);
  const entry = selections.find(s => key(s.worktree) === key(targetDir));
  return entry ? { metadataRoot: entry.metadataRoot, commonRoot: entry.commonRoot } : undefined;
}
