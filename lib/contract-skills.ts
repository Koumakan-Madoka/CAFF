import path from 'node:path';

// DD-3 of docs/engineering/skills/skill-scoping.md: the contract layer is an
// explicit allowlist carried as code (not configuration), so it only changes
// through review. These six skills ride along with every CAFF agent run via
// `resourceLoaderOptions.additionalSkillPaths`, independent of the session
// project cwd, so the contract layer survives cwd switches to other projects.
export const CONTRACT_SKILL_IDS: string[] = [
  'caff-workflow',
  'create-command',
  'dag-planning',
  'grill-with-docs',
  'grilling',
  'domain-modeling',
];

// The anchor is the CAFF repository root of the running server instance.
// This matches the existing runtime anchors (`DEFAULT_AGENT_DIR` and pi's
// cwd fallback both resolve against the server process cwd), so worktree and
// acceptance instances pick up their own tracked `.agents/skills` copies.
export function resolveContractSkillPaths(repoRoot?: string): string[] {
  const root = path.resolve(String(repoRoot || '').trim() || process.cwd());
  const skillsRoot = path.join(root, '.agents', 'skills');

  return CONTRACT_SKILL_IDS.map((skillId) => path.join(skillsRoot, skillId));
}
