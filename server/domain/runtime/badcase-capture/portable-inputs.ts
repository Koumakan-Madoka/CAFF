// Capability declaration, not a strict certificate or an external-file reader.
// Inventory in-project resources without reading their content. Replay requires
// every declared file from the independently authorized checkpoint, never cwd.
import fs from 'node:fs';
import path from 'node:path';
import { isSafeRelativePath } from './replay-path';
import { PROJECT_CONTEXT_NAMES, PROJECT_SKILL_ROOTS, relativeProjectSkillPaths } from './project-resources';
export function supportsPortableThinking(config: any): boolean {
  return config?.thinking === 'off' || (config?.thinking === 'xhigh'
    && config?.provider === 'openai-codex' && config?.model === 'gpt-6.1-sol');
}
export function supportsPortableExtensions(config: any): boolean {
  return Array.isArray(config?.extensionPaths) && config.extensionPaths.length === 1
    && typeof config.extensionPaths[0] === 'string'
    && config.extensionPaths[0].replaceAll('\\', '/').endsWith('/lib/pi-extensions/caff-capabilities.mjs');
}
export function inspectPortableAgentConfig(config: any, options: { archivedSkills?: boolean } = {}) {
  if (options.archivedSkills === true) return inspectPortableGitConfig(config);
  const result = { schemaVersion: 1, kind: 'portable-default-resources-v1', supported: false };
  try {
    if (!config || typeof config.resume !== 'boolean' || !supportsPortableThinking(config) || config.fast === true
      || config.retireUserScopeSkills !== true || !path.isAbsolute(config.cwd) || !path.isAbsolute(config.agentDir)
      || !Array.isArray(config.extensionPaths) || config.extensionPaths.length !== 1
      || !config.extensionPaths[0].replaceAll('\\', '/').endsWith('/lib/pi-extensions/caff-capabilities.mjs')
      || !Array.isArray(config.additionalSkillPaths)) return result;
    const present = (p: string) => { try { fs.lstatSync(p); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } };
    for (const name of ['settings.json', 'SYSTEM.md', 'APPEND_SYSTEM.md', ...PROJECT_CONTEXT_NAMES, 'extensions', 'prompts']) {
      if (present(path.join(config.agentDir, name))) return result;
    }
    // Parent context/resources are not captured. Conservative even when a Git
    // boundary could suppress some ancestor skills; never drop ancestor text.
    let parent = path.dirname(config.cwd);
    for (;;) {
      for (const name of [...PROJECT_CONTEXT_NAMES, '.agents']) if (present(path.join(parent, name))) return result;
      const next = path.dirname(parent); if (next === parent) break; parent = next;
    }
    const filePaths: string[] = []; let entries = 0;
    const inventory = (relative: string, depth = 0) => {
      if (++entries > (options.archivedSkills ? 16384 : 2048) || depth > 32 || !isSafeRelativePath(relative)) throw Error();
      const target = path.join(config.cwd, relative), st = fs.lstatSync(target);
      if (st.isSymbolicLink()) throw Error();
      if (st.isDirectory()) { for (const name of fs.readdirSync(target).sort()) inventory(relative + '/' + name, depth + 1); }
      else if (st.isFile() && filePaths.length < (options.archivedSkills ? 8192 : 1024)) filePaths.push(relative);
      else throw Error();
    };
    const rootNames = fs.readdirSync(config.cwd);
    // Use actual directory spellings: probing both .md/.MD aliases duplicates
    // the same file on Windows and invents a second resource on Linux replay.
    if (rootNames.some(name => PROJECT_CONTEXT_NAMES.some(n => n.toLowerCase() === name.toLowerCase()) && !PROJECT_CONTEXT_NAMES.includes(name))) return result;
    for (const name of rootNames.filter(name => PROJECT_CONTEXT_NAMES.includes(name))) {
      if (!fs.lstatSync(path.join(config.cwd, name)).isFile()) return result;
      inventory(name);
    }
    let hasProjectRoots = false;
    for (const root of ['.pi', '.agents']) if (present(path.join(config.cwd, root))) {
      const st = fs.lstatSync(path.join(config.cwd, root));
      if (!st.isDirectory() || st.isSymbolicLink() || fs.readdirSync(path.join(config.cwd, root)).some(name => name !== 'skills')) return result;
      hasProjectRoots = true;
      const skills = root + '/skills';
      if (present(path.join(config.cwd, skills))) {
        if (!fs.lstatSync(path.join(config.cwd, skills)).isDirectory()) return result;
        inventory(skills);
      }
    }
    const existingSkillPaths = config.additionalSkillPaths.some((p: string) => {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw Error(); return present(p);
    });
    if (!hasProjectRoots && filePaths.length === 0 && !existingSkillPaths) return { ...result, supported: true };
    const skillPaths = relativeProjectSkillPaths(config);
    // Explicit roots must be ordinary project paths too, including ancestors.
    for (const relative of skillPaths) {
      const parts = relative.split('/');
      for (let i = 2; i <= parts.length; i++) {
        const target = path.join(config.cwd, ...parts.slice(0, i));
        if (present(target) && fs.lstatSync(target).isSymbolicLink()) return result;
      }
    }
    if (filePaths.some(p => !PROJECT_CONTEXT_NAMES.includes(p) && !PROJECT_SKILL_ROOTS.some(root => p.startsWith(root + '/')))) return result;
    return { schemaVersion: 1, kind: 'portable-project-resources-v1', supported: true, filePaths: filePaths.sort(), skillPaths };
  } catch { return result; }
}

// v2 keeps structural/model gates, but ordinary resource omissions are data.
// Enumeration is read-only; SDK-observed bytes are archived at beforePrompt.
function inspectPortableGitConfig(config: any): any {
  const rejected = { schemaVersion: 1, kind: 'portable-default-resources-v1', supported: false };
  if (!config || typeof config.resume !== 'boolean' || !supportsPortableThinking(config) || !supportsPortableExtensions(config)
    || config.retireUserScopeSkills !== true || !path.isAbsolute(config.cwd || '') || !path.isAbsolute(config.agentDir || '')
    || !Array.isArray(config.additionalSkillPaths) || config.additionalSkillPaths.some((p: any) => typeof p !== 'string' || !path.isAbsolute(p))) return rejected;
  const portableGaps: any[] = [], filePaths: string[] = [];
  const gap = (p: string, reason: string) => { if (!portableGaps.some(g => g.path === p && g.reason === reason)) portableGaps.push({ path: p, reason }); };
  if (config.fast === true) gap('.', 'fast_mode_not_replayed');
  const present = (p: string) => { try { return fs.lstatSync(p); } catch (e: any) { if (e.code !== 'ENOENT') gap(p, 'resource_unreadable'); return null; } };
  for (const name of ['settings.json', 'SYSTEM.md', 'APPEND_SYSTEM.md', ...PROJECT_CONTEXT_NAMES, 'extensions', 'prompts']) {
    const p = path.join(config.agentDir, name); if (present(p)) gap(p, 'agent_resource_not_archived');
  }
  for (let parent = path.dirname(config.cwd);;) {
    for (const name of [...PROJECT_CONTEXT_NAMES, '.agents']) { const p = path.join(parent, name); if (present(p)) gap(p, 'ancestor_resource_unverified'); }
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
  let entries = 0;
  const inventory = (name: string, depth = 0) => {
    if (++entries > 16384 || depth > 32 || filePaths.length >= 8192) { gap(name, 'resource_inventory_limit'); return; }
    if (!isSafeRelativePath(name)) { gap(name, 'resource_path_invalid'); return; }
    const p = path.join(config.cwd, name), stat = present(p); if (!stat) return;
    if (stat.isSymbolicLink()) { gap(name, 'resource_link_skipped'); return; }
    if (stat.isDirectory()) {
      let children: string[]; try { children = fs.readdirSync(p).sort(); } catch { gap(name, 'resource_unreadable'); return; }
      for (const child of children) inventory(name + '/' + child, depth + 1);
    } else if (stat.isFile()) filePaths.push(name); else gap(name, 'resource_special_file');
  };
  let roots: string[] = []; try { roots = fs.readdirSync(config.cwd); } catch { gap('.', 'resource_inventory_unavailable'); }
  for (const name of roots.filter(n => PROJECT_CONTEXT_NAMES.some(p => p.toLowerCase() === n.toLowerCase()))) {
    const stat = present(path.join(config.cwd, name));
    if (!PROJECT_CONTEXT_NAMES.includes(name) || !stat?.isFile() || stat.isSymbolicLink()) gap(name, 'project_resource_not_replayed');
    else inventory(name);
  }
  for (const root of ['.pi', '.agents']) {
    const stat = present(path.join(config.cwd, root)); if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) { gap(root, 'resource_link_skipped'); continue; }
    let children: string[]; try { children = fs.readdirSync(path.join(config.cwd, root)); } catch { gap(root, 'resource_unreadable'); continue; }
    for (const name of children) {
      if (name === 'skills') inventory(root + '/skills'); else gap(root + '/' + name, 'project_resource_not_replayed');
    }
  }
  return { schemaVersion: 1, kind: 'portable-captured-project-resources-v1', supported: true,
    filePaths: filePaths.sort(), skillPaths: [...config.additionalSkillPaths], ...(portableGaps.length ? { portableGaps } : {}) };
}
