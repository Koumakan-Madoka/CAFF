// MVP capability declaration, not a general dependency archiver or a strict
// replay certificate. Inspect fixed resource names only; never read external
// instructions/settings. Non-default resources are simply unsupported.
import fs from 'node:fs';
import path from 'node:path';
export function inspectPortableAgentConfig(config: any) {
  const result = { schemaVersion: 1, kind: 'portable-default-resources-v1', supported: false };
  try {
    if (!config || config.resume !== false || config.thinking !== 'off' || config.fast === true
      || config.retireUserScopeSkills !== true || !path.isAbsolute(config.cwd) || !path.isAbsolute(config.agentDir)
      || !Array.isArray(config.extensionPaths) || config.extensionPaths.length !== 1
      || !config.extensionPaths[0].replaceAll('\\', '/').endsWith('/lib/pi-extensions/caff-capabilities.mjs')
      || !Array.isArray(config.additionalSkillPaths)) return result;
    const present = (p: string) => { try { fs.lstatSync(p); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } };
    for (const name of ['settings.json', 'SYSTEM.md', 'APPEND_SYSTEM.md', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'extensions', 'prompts']) {
      if (present(path.join(config.agentDir, name))) return result;
    }
    if (config.additionalSkillPaths.some((p: string) => !path.isAbsolute(p) || present(p))) return result;
    if (present(path.join(config.cwd, '.pi')) || present(path.join(config.cwd, '.agents'))) return result;
    // Parent context/resources are not part of the captured worktree. Do not
    // replace them with an empty loader or silently omit their instructions.
    let parent = path.dirname(config.cwd);
    for (;;) {
      for (const name of ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.agents']) if (present(path.join(parent, name))) return result;
      const next = path.dirname(parent); if (next === parent) break; parent = next;
    }
    return { ...result, supported: true };
  } catch { return result; }
}
