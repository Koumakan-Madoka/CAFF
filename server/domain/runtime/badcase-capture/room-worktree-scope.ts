// Ephemeral Windows project-consent inheritance. Constructor-owned Room/project
// records, not invocation paths, select the repository. Never persist new pins,
// execute Git or follow a gitfile outside its own .git/worktrees/<id>.
import path from 'node:path';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { prepareWindowsMetadataScope } from './windows-estimate';
import { invokeWindowsIdentityHelper, isWindowsGitStatePath } from './windows-helper';
import { readWindowsGitMetadataInput, readWindowsGitStateInput } from './windows-git-input';
import { parseGitConfigSubset } from './git-classify';
import { containsSecretSentinel } from './secrets';
const key = (p: string) => path.win32.resolve(p).toLowerCase();
const under = (root: string, p: string) => key(p) === key(root) || key(p).startsWith(key(root) + '\\');
const fail = (reason: string) => ({ ok: false, reason: `room_worktree_${reason}` });
const sameIdentity = (a: any, b: any) => a && b && ['volumeSerial', 'fileId', 'creationTime'].every(k => a[k] === b[k]);
const text = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
function pointer(bytes: any, base: string, marker = false): string {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32768 || containsSecretSentinel(bytes)) throw Error();
  let value = text(bytes).replace(/\r?\n$/, '');
  if (marker) { if (!value.startsWith('gitdir: ')) throw Error(); value = value.slice(8); }
  if (!value || value !== value.trim() || /[\x00-\x1f\x7f\ufeff]/.test(value)
    || /^[\\/]/.test(value) || (/^[a-z]:/i.test(value) && !/^[a-z]:[\\/]/i.test(value))) throw Error();
  return path.win32.resolve(base, value);
}
async function readHead(metadataRoot: string, commonRoot: string, read: any, digits: number): Promise<string> {
  const hash = new RegExp(`^[a-f0-9]{${digits}}$`), head = text(await read(metadataRoot, 'HEAD', true)).replace(/\r?\n$/, '');
  if (hash.test(head)) return head; // detached worktree
  if (!head.startsWith('ref: refs/heads/')) throw Error();
  const ref = head.slice(5);
  if (!isWindowsGitStatePath(ref)) throw Error();
  // The native protocol validates the Git ref grammar, canonical spelling and
  // every ancestor, never follows a symlink or a second symbolic ref.
  try {
    fs.lstatSync(path.win32.join(commonRoot, ref));
    const loose = text(await read(commonRoot, ref, true)).replace(/\r?\n$/, '');
    if (!hash.test(loose)) throw Error();
    return loose;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error; // only absence permits packed refs
  }
  const packed = text(await read(commonRoot, 'packed-refs', true));
  const matches: string[] = [];
  for (const line of packed.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('^') && hash.test(line.slice(1))) continue;
    const space = line.indexOf(' ');
    if (space < 0 || !hash.test(line.slice(0, space)) || /\s/.test(line.slice(space + 1))) throw Error();
    if (line.slice(space + 1) === ref) matches.push(line.slice(0, space));
  }
  if (matches.length !== 1) throw Error();
  return matches[0];
}

export function createRoomWorktreeScopeResolver(trusted: any = {}) {
  const store = trusted.chatStore, getProject = trusted.getProject;
  return async function derive(value: any): Promise<any> {
    if (process.platform !== 'win32') return fail('windows_required');
    try {
      const { input, policy, targetDir, captureRoot, agentDir, privateDirs, deadline } = value;
      if (policy.status !== 'enabled' || policy.projectId !== input.projectId) return fail('policy_not_enabled');
      if (typeof store?.getConversationWithoutMessages !== 'function' || typeof getProject !== 'function') return fail('source_unavailable');
      const room = structuredClone(store.getConversationWithoutMessages(input.conversationId));
      const project = structuredClone(getProject(input.projectId));
      const bound = (r: any) => r?.id === input.conversationId && r.type === 'standard' && r.projectScopeId === input.projectId
        && typeof r.worktreePath === 'string' && !!r.branch && !!r.workspaceBaseSha
        && !Object.hasOwn(r.metadata || {}, 'dagNodeGoalBinding') && key(r.worktreePath) === key(targetDir);
      if (!bound(room)) return fail('not_bound');
      if (project?.id !== input.projectId || typeof project.path !== 'string' || !/^[a-z]:[\\/]/i.test(project.path)) return fail('project_invalid');
      const root = path.win32.resolve(project.path), commonRoot = path.win32.join(root, '.git');
      if (!policy.authorizedDirs.some((p: string) => key(p) === key(root)) || under(root, targetDir)) return fail('project_root_required');
      // Preserve canonical/private-root/exclusion checks and compare the native
      // project identity to its ORIGINAL saved pin. No re-authorization of it.
      const scope = prepareWindowsMetadataScope({ policy, targetDir: root, captureRoot, agentDir, privateDirs });
      if (!scope.ok) return fail(scope.reason);
      const identity = async (dir: string) => {
        const r = await invokeWindowsIdentityHelper('python', scope.helperPath, { version: 1, op: 'identity', root: dir }, deadline);
        if (performance.now() >= deadline || !r.ok) throw Error();
        return r.identity;
      };
      const rootIdentity = await identity(root);
      if (!sameIdentity(rootIdentity, scope.request.expected)) return fail('project_root_replaced');
      const gitStat = fs.lstatSync(commonRoot);
      if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) return fail('project_root_required');
      const derived = structuredClone(policy), targetIdentity = await identity(targetDir);
      derived.authorizedDirs.push(targetDir);
      derived.authorizedDirPins[key(targetDir)] = { realpath: targetDir, identity: targetIdentity };
      const targetScope = prepareWindowsMetadataScope({ policy: derived, targetDir, captureRoot, agentDir, privateDirs });
      if (!targetScope.ok) return fail(targetScope.reason);
      const pinInput = async (dir: string) => {
        derived.authorizedInputDirs = [...new Set([...derived.authorizedInputDirs, dir])];
        derived.authorizedInputPins[key(dir)] = { realpath: dir, identity: await identity(dir) };
      };
      // Marker-only authority is local to this read. Do NOT turn file-root
      // inheritance into a general session/input grant on the worktree.
      const markerPolicy = { ...derived, authorizedInputDirs: [targetDir], authorizedInputPins: {
        [key(targetDir)]: { realpath: targetDir, identity: targetIdentity } } };
      const read = async (metadataRoot: string, metadataPath: string, state = false) => {
        const reader = state ? readWindowsGitStateInput : readWindowsGitMetadataInput;
        const r = await reader({ policy: metadataPath === '.git' ? markerPolicy : derived,
          metadataRoot, metadataPath, captureRoot, privateDirs: [...(privateDirs || []), ...(agentDir ? [agentDir] : [])], deadline });
        if (performance.now() >= deadline || !r.ok) throw Error();
        return r.content;
      };
      const marker = await read(targetDir, '.git', true), metadataRoot = pointer(marker, targetDir, true);
      const relative = path.win32.relative(path.win32.join(commonRoot, 'worktrees'), metadataRoot);
      if (!relative || relative === '.' || relative === '..' || /[\\/]/.test(relative) || path.win32.isAbsolute(relative)) return fail('gitdir_outside_repository');
      await pinInput(commonRoot); await pinInput(metadataRoot);
      const backlink = await read(metadataRoot, 'gitdir'), common = await read(metadataRoot, 'commondir');
      // This is Git's worktree-list registration: a native ordinary admin
      // directory directly in .git/worktrees, a HEAD, and a matching backlink.
      // Check BOTH directions without running Git or enumerating other Rooms.
      if (key(pointer(common, metadataRoot)) !== key(commonRoot)
        || key(pointer(backlink, metadataRoot)) !== key(path.win32.join(targetDir, '.git'))) return fail('git_pointer_mismatch');
      const config = await read(commonRoot, 'config');
      const subset = parseGitConfigSubset(text(config), { allowIgnoreCase: true });
      if (!subset.verified || subset.hasInclude || subset.excludesFile
        || (subset.objectFormat && !['sha1', 'sha256'].includes(subset.objectFormat))) return fail('git_config_unsupported');
      const digits = subset.objectFormat === 'sha256' ? 64 : 40;
      const head = await readHead(metadataRoot, commonRoot, read, digits);
      derived.windowsExternalGit = [...derived.windowsExternalGit, { worktree: targetDir, metadataRoot, commonRoot }];
      return { ok: true, policy: derived, evidence: { repositoryRoot: root, metadataRoot, commonRoot, head }, async revalidate() {
        try {
          if (!sameIdentity(await identity(root), rootIdentity) || !marker.equals(await read(targetDir, '.git', true))
            || !backlink.equals(await read(metadataRoot, 'gitdir')) || !common.equals(await read(metadataRoot, 'commondir'))
            || !config.equals(await read(commonRoot, 'config')) || await readHead(metadataRoot, commonRoot, read, digits) !== head) return false;
          // Live source checks LAST: no helper await between these checks and
          // the caller's synchronous publication under the project lease.
          const currentProject = getProject(input.projectId);
          return performance.now() < deadline && currentProject?.id === input.projectId && typeof currentProject.path === 'string'
            && key(currentProject.path) === key(root) && bound(store.getConversationWithoutMessages(input.conversationId));
        } catch { return false; }
      } };
    } catch { return fail(performance.now() >= value.deadline ? 'timeout' : 'scope_unavailable'); }
  };
}
