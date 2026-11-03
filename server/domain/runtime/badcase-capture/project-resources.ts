// Pure manifest checks shared by sealed preparation and the disposable worker.
// Never reads current source paths or overrides the native SDK resource loader.
import crypto from 'node:crypto';
import path from 'node:path';
export const PROJECT_CONTEXT_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];
export const PROJECT_SKILL_ROOTS = ['.agents/skills', '.pi/skills'];
const fail = () => new Error('replay_project_resources_invalid');
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const validPath = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9_.@/-]+$/.test(v)
  && v.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git');
export function isProjectResourcePath(name: string): boolean {
  return PROJECT_CONTEXT_NAMES.includes(name) || PROJECT_SKILL_ROOTS.some(root => name.startsWith(root + '/'));
}
export function relativeProjectSkillPaths(config: any): string[] {
  if (!config || typeof config.cwd !== 'string' || !Array.isArray(config.additionalSkillPaths)) throw fail();
  const paths = /^[A-Za-z]:[\\/]/.test(config.cwd) ? path.win32 : path.posix;
  if (!paths.isAbsolute(config.cwd)) throw fail();
  return config.additionalSkillPaths.map((p: any) => {
    if (typeof p !== 'string' || !paths.isAbsolute(p)) throw fail();
    const relative = paths.relative(config.cwd, p).replaceAll('\\', '/');
    if (!validPath(relative) || !PROJECT_SKILL_ROOTS.some(root => relative === root || relative.startsWith(root + '/'))) throw fail();
    return relative;
  });
}
function resourceFiles(filePaths: any, files: any[]) {
  if (!Array.isArray(filePaths) || filePaths.length > 1024 || filePaths.some(p => !validPath(p) || !isProjectResourcePath(p))
    || new Set(filePaths).size !== filePaths.length || JSON.stringify([...filePaths].sort()) !== JSON.stringify(filePaths)
    || !Array.isArray(files) || files.some(f => {
      if (typeof f?.path !== 'string') return true;
      const root = f.path.split('/')[0], lower = root.toLowerCase();
      return (lower === '.pi' || lower === '.agents') && (root !== lower || !f.path.startsWith(root + '/skills/'))
        || PROJECT_CONTEXT_NAMES.some(n => n.toLowerCase() === lower) && !PROJECT_CONTEXT_NAMES.includes(root);
    })) throw fail();
  const actual = files.filter(f => isProjectResourcePath(f.path)).map(f => ({ path: f.path, sha256: f.sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (JSON.stringify(actual.map(f => f.path)) !== JSON.stringify(filePaths) || actual.some(f => !/^[a-f0-9]{64}$/.test(f.sha256))) throw fail();
  return actual;
}
export function prepareProjectResources(declaration: any, files: any[], config: any) {
  if (!declaration || Object.keys(declaration).sort().join(',') !== 'filePaths,kind,schemaVersion,skillPaths,supported'
    || declaration.kind !== 'portable-project-resources-v1' || declaration.schemaVersion !== 1 || declaration.supported !== true
    || !Array.isArray(declaration.skillPaths) || declaration.skillPaths.length > 256
    || JSON.stringify(declaration.skillPaths) !== JSON.stringify(relativeProjectSkillPaths(config))) throw fail();
  const records = resourceFiles(declaration.filePaths, files);
  const content = { kind: 'replay-project-resources-v1', files: records, skillPaths: [...declaration.skillPaths],
    contextFile: PROJECT_CONTEXT_NAMES.find(p => declaration.filePaths.includes(p)) || null };
  return { ...content, manifestHash: hash(JSON.stringify(content)) };
}
export function validateProjectResources(manifest: any, files: any[]) {
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'contextFile,files,kind,manifestHash,skillPaths'
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.skillPaths)) throw fail();
  const config = { cwd: '/work/restored', additionalSkillPaths: manifest.skillPaths?.map((p: any) => '/work/restored/' + p) };
  const expected = prepareProjectResources({ schemaVersion: 1, kind: 'portable-project-resources-v1', supported: true,
    filePaths: manifest.files.map((f: any) => f.path), skillPaths: manifest.skillPaths }, files, config);
  // Compare selected fields, never rely on caller JSON key order.
  if (manifest.kind !== expected.kind || manifest.contextFile !== expected.contextFile || manifest.manifestHash !== expected.manifestHash
    || JSON.stringify(manifest.files) !== JSON.stringify(expected.files)) throw fail();
  return expected;
}
export function projectResourcesSummary(manifest: any) {
  return { kind: manifest.kind, manifestHash: manifest.manifestHash, fileCount: manifest.files.length,
    contextFile: manifest.contextFile, skillPaths: [...manifest.skillPaths] };
}
export function projectResourcesReceiptMatches(summary: any, receipt: any): boolean {
  return receipt?.verified === true && ['kind', 'manifestHash', 'fileCount', 'contextFile'].every(k => receipt[k] === summary[k])
    && JSON.stringify(receipt.skillPaths) === JSON.stringify(summary.skillPaths)
    && receipt.loadedContextFiles === (summary.contextFile ? 1 : 0)
    && Number.isSafeInteger(receipt.loadedSkills) && receipt.loadedSkills >= 0 && receipt.loadedSkills <= summary.fileCount;
}
export function verifyLoadedProjectResources(manifest: any, files: any[], loader: any, cwd: string) {
  validateProjectResources(manifest, files);
  const context = loader.getAgentsFiles().agentsFiles, skills = loader.getSkills().skills;
  if (!Array.isArray(context) || !Array.isArray(skills) || context.length !== (manifest.contextFile ? 1 : 0)) throw fail();
  const recordFor = (p: any) => typeof p === 'string' && p.startsWith(cwd + '/') && manifest.files.find((f: any) => cwd + '/' + f.path === p);
  for (const entry of context) {
    const record = recordFor(entry.path);
    if (!record || record.path !== manifest.contextFile || typeof entry.content !== 'string'
      || ![hash(entry.content), hash('\uFEFF' + entry.content)].includes(record.sha256)) throw fail();
  }
  if (skills.some((skill: any) => !recordFor(skill.filePath)) || new Set(skills.map((s: any) => s.filePath)).size !== skills.length) throw fail();
  return { ...projectResourcesSummary(manifest), verified: true, loadedContextFiles: context.length, loadedSkills: skills.length };
}
