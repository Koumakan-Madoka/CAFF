// Pure manifest checks shared by sealed preparation and the disposable worker.
// Never reads current source paths or overrides the native SDK resource loader.
import crypto from 'node:crypto';
import path from 'node:path';
import { isSafeRelativePath as validPath } from './replay-path';
export const PROJECT_CONTEXT_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];
export const PROJECT_SKILL_ROOTS = ['.agents/skills', '.pi/skills'];
const fail = () => new Error('replay_project_resources_invalid');
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
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
function resourceFiles(filePaths: any, files: any[], maxFiles = 1024) {
  if (!Array.isArray(filePaths) || filePaths.length > maxFiles || filePaths.some(p => !validPath(p) || !isProjectResourcePath(p))
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
  if (manifest?.kind === 'replay-captured-project-resources-v1') return validateCapturedProjectResources(manifest, files);
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
    contextFile: manifest.contextFile, skillPaths: [...manifest.skillPaths],
    ...(Array.isArray(manifest.contextFiles) ? { contextFiles: [...manifest.contextFiles] } : {}) };
}
export function projectResourcesReceiptMatches(summary: any, receipt: any): boolean {
  return receipt?.verified === true && ['kind', 'manifestHash', 'fileCount', 'contextFile'].every(k => receipt[k] === summary[k])
    && JSON.stringify(receipt.skillPaths) === JSON.stringify(summary.skillPaths)
    && receipt.loadedContextFiles === (summary.contextFiles ? summary.contextFiles.length : summary.contextFile ? 1 : 0)
    && Number.isSafeInteger(receipt.loadedSkills) && receipt.loadedSkills >= 0 && receipt.loadedSkills <= summary.fileCount;
}
export function verifyLoadedProjectResources(manifest: any, files: any[], loader: any, cwd: string) {
  validateProjectResources(manifest, files);
  const context = loader.getAgentsFiles().agentsFiles, skills = loader.getSkills().skills;
  const contextPaths = manifest.contextFiles || (manifest.contextFile ? [manifest.contextFile] : []);
  if (!Array.isArray(context) || !Array.isArray(skills) || context.length !== contextPaths.length) throw fail();
  const recordFor = (p: any) => typeof p === 'string' && p.startsWith(cwd + '/') && manifest.files.find((f: any) => cwd + '/' + f.path === p);
  for (const entry of context) {
    const record = recordFor(entry.path);
    if (!record || !contextPaths.includes(record.path) || typeof entry.content !== 'string'
      || ![hash(entry.content), hash('\uFEFF' + entry.content)].includes(record.sha256)) throw fail();
  }
  if (skills.some((skill: any) => !recordFor(skill.filePath)) || new Set(skills.map((s: any) => s.filePath)).size !== skills.length) throw fail();
  if (manifest.kind === 'replay-captured-project-resources-v1') {
    const actual = skills.map((s: any) => ({ path: s.filePath.slice(cwd.length + 1), name: s.name })).sort(byPath);
    const expected = manifest.skills.filter((s: any) => s.origins.includes('sdk')).map((s: any) => ({ path: s.path, name: s.sdkName })).sort(byPath);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw fail();
  }
  return { ...projectResourcesSummary(manifest), verified: true, loadedContextFiles: context.length, loadedSkills: skills.length };
}

const MIRROR = '.caff-replay-skills/';
const byPath = (a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const capturedContent = (m: any) => ({ kind: 'replay-captured-project-resources-v1', files: m.files, skillPaths: m.skillPaths,
  contextFile: m.contextFile, skills: m.skills, ...(Array.isArray(m.contextFiles) ? { contextFiles: m.contextFiles } : {}) });

// Host-only preparation: receive materialized archived bytes, never open an
// original skill path. Reuse the normal file transport for detached mirrors;
// prompt-only resources stay outside SDK discovery roots and explicit paths.
export function prepareCapturedProjectResources(declaration: any, files: any[], config: any, checkpoint: any, materialized: any) {
  if (declaration?.kind !== 'portable-captured-project-resources-v1' || declaration.schemaVersion !== 1 || declaration.supported !== true
    || JSON.stringify(declaration.skillPaths) !== JSON.stringify(config.additionalSkillPaths)
    || files.some(f => f.path === MIRROR.slice(0, -1) || f.path.startsWith(MIRROR))) throw fail();
  const cwdRecords = resourceFiles(declaration.filePaths, files, 8192), snapshot = checkpoint.gitSnapshot;
  if (!Array.isArray(snapshot.sdkLoadedSkills) || !Array.isArray(snapshot.promptLoadedSkills) || snapshot.skillInventoryStatus !== 'loaded') throw fail();
  const paths = /^[A-Za-z]:[\\/]/.test(checkpoint.targetDir) ? path.win32 : path.posix;
  const normalized = (p: any) => {
    if (typeof p !== 'string' || !paths.isAbsolute(p)) throw fail();
    return paths.normalize(p).replaceAll('\\', '/');
  };
  const transported = [...files], bindings: any[] = [], locations = new Map<string, string>(), records = new Map<string, any>(cwdRecords.map(f => [f.path, f]));
  const add = (name: string, entry: any) => {
    if (!validPath(name)) throw fail();
    const existing = transported.find(f => f.path === name);
    if (existing && existing.sha256 !== entry.hash) throw fail();
    if (!existing) transported.push({ path: name, base64: entry.content.toString('base64'), sha256: entry.hash, mode: entry.mode,
      ...(entry.secretRedacted ? { secretRedacted: true } : {}) });
    records.set(name, { path: name, sha256: entry.hash });
  };
  for (const skill of materialized.projectSkills) {
    const root = normalized(skill.originalPath), prefix = skill.internal ? skill.relativePath : MIRROR + skill.relativePath;
    if (prefix) bindings.push({ sourcePath: skill.originalPath, relativePath: prefix });
    for (const [name, entry] of Object.entries(skill.files) as any[]) {
      const dest = skill.rootKind === 'file' ? prefix : [prefix, name].filter(Boolean).join('/');
      const original = skill.rootKind === 'file' ? root : root + '/' + name;
      if (locations.has(original) && locations.get(original) !== dest) throw fail();
      locations.set(original, dest); add(dest, entry);
    }
  }
  const observed = new Map<string, any>();
  for (const [origin, list] of [['sdk', snapshot.sdkLoadedSkills], ['prompt', snapshot.promptLoadedSkills]] as const) {
    for (const entry of list) {
      const dest = locations.get(normalized(entry.filePath)); if (!dest || typeof entry.name !== 'string') throw fail();
      let skill = observed.get(dest);
      if (!skill) { skill = { path: dest, name: entry.name, origins: [] }; observed.set(dest, skill); }
      if (skill.origins.includes(origin)) throw fail();
      skill.origins.push(origin); skill[origin + 'Name'] = entry.name;
    }
  }
  const skills = [...observed.values()].sort(byPath), skillPaths = skills.filter(s => s.origins.includes('sdk')).map(s => s.path);
  const portableGaps: any[] = [];
  const contexts: string[] | undefined = Array.isArray(snapshot.loadedContexts) ? [] : undefined;
  for (const context of snapshot.loadedContexts || []) {
    const dest = locations.get(normalized(context.filePath));
    if (!dest) portableGaps.push({ path: context.filePath, reason: 'context_file_not_archived' });
    else if (!contexts!.includes(dest)) contexts!.push(dest);
  }
  const content = capturedContent({ files: [...records.values()].sort(byPath), skillPaths, skills,
    contextFile: PROJECT_CONTEXT_NAMES.find(p => declaration.filePaths.includes(p)) || null,
    ...(contexts ? { contextFiles: contexts } : {}) });
  const manifest = { ...content, manifestHash: hash(JSON.stringify(content)) };
  validateCapturedProjectResources(manifest, transported);
  return { manifest, files: transported.sort(byPath), bindings, portableGaps };
}

function validateCapturedProjectResources(manifest: any, files: any[]) {
  if (!Array.isArray(manifest.files) || manifest.files.length > 8192 || !Array.isArray(manifest.skills) || manifest.skills.length > 8192
    || !Array.isArray(manifest.skillPaths) || manifest.contextFile !== null && !PROJECT_CONTEXT_NAMES.includes(manifest.contextFile)
    || hash(JSON.stringify(capturedContent(manifest))) !== manifest.manifestHash) throw fail();
  if (manifest.contextFiles !== undefined && (!Array.isArray(manifest.contextFiles) || manifest.contextFiles.length > 8192
    || new Set(manifest.contextFiles).size !== manifest.contextFiles.length
    || manifest.contextFiles.some((p: any) => !validPath(p) || !manifest.files.some((f: any) => f.path === p)))) throw fail();
  const indexed = new Map(files.map(f => [f.path, f]));
  const names = manifest.files.map((f: any) => f.path);
  if (new Set(names).size !== names.length || JSON.stringify(names) !== JSON.stringify([...names].sort())) throw fail();
  for (const f of manifest.files) if (!validPath(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256) || indexed.get(f.path)?.sha256 !== f.sha256) throw fail();
  // Preserve the old rejection of unarchived settings/extensions/context while
  // permitting only explicitly manifested detached skill trees.
  const cwdPaths = files.filter(f => isProjectResourcePath(f.path)).map(f => f.path).sort();
  resourceFiles(cwdPaths, files, 8192);
  if (cwdPaths.some(p => !names.includes(p)) || manifest.contextFile !== (PROJECT_CONTEXT_NAMES.find(p => cwdPaths.includes(p)) || null)) throw fail();
  const skillNames = new Set<string>();
  for (const s of manifest.skills) {
    if (!validPath(s.path) || !names.includes(s.path) || skillNames.has(s.path) || typeof s.name !== 'string'
      || !Array.isArray(s.origins) || !s.origins.length || new Set(s.origins).size !== s.origins.length
      || s.origins.some((o: any) => !['sdk', 'prompt'].includes(o) || typeof s[o + 'Name'] !== 'string')) throw fail();
    skillNames.add(s.path);
  }
  if (JSON.stringify(manifest.skillPaths) !== JSON.stringify(manifest.skills.filter((s: any) => s.origins.includes('sdk')).map((s: any) => s.path))) throw fail();
  return manifest;
}

/** Worker-only SDK facade: install the captured context view before the host
 * creates the session/system prompt. It never reads original or ambient paths.
 * Old manifests without an observed list retain their native loader behavior. */
export function sdkWithCapturedContexts(sdk: any, manifest: any, files: any[], cwd: string, readContent?: (name: string) => Buffer) {
  if (!Array.isArray(manifest?.contextFiles)) return sdk;
  const context = manifest.contextFiles.map((name: string) => {
    const record = files.find(f => f.path === name);
    if (!record || !validPath(name)) throw fail();
    const bytes = readContent ? readContent(name) : Buffer.from(record.base64, 'base64'), content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes) || hash(content) !== record.sha256 || content.includes('\0')) throw fail();
    return { path: cwd + '/' + name, content: content.replace(/^\uFEFF/, '') };
  });
  return { ...sdk, async createAgentSessionServices(options: any) {
    const services = await sdk.createAgentSessionServices(options);
    services.resourceLoader.getAgentsFiles = () => ({ agentsFiles: context.map((entry: any) => ({ ...entry })) });
    return services;
  } };
}
