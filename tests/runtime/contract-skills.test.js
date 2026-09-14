const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CONTRACT_SKILL_IDS,
  resolveContractSkillPaths,
} = require('../../build/lib/contract-skills');

test('contract skill allowlist is the reviewed six-skill set in a stable order', () => {
  assert.deepEqual(CONTRACT_SKILL_IDS, [
    'caff-workflow',
    'create-command',
    'dag-planning',
    'grill-with-docs',
    'grilling',
    'domain-modeling',
  ]);
});

test('contract skill paths map to the repo .agents/skills root', () => {
  const repoRoot = path.resolve('some', 'repo', 'root');
  assert.deepEqual(resolveContractSkillPaths(repoRoot), CONTRACT_SKILL_IDS.map((skillId) =>
    path.join(repoRoot, '.agents', 'skills', skillId)
  ));
});

test('contract skill paths fall back to the process cwd anchor', () => {
  assert.deepEqual(resolveContractSkillPaths(), resolveContractSkillPaths(process.cwd()));
  assert.deepEqual(resolveContractSkillPaths('   '), resolveContractSkillPaths(process.cwd()));
});

test('every allowlisted contract skill exists in the running repository tree', () => {
  // DD-3: the allowlist is code and must track the tracked skill set. A skill
  // promoted into .agents/skills without being allowlisted (or vice versa)
  // fails here so the drift is caught by review, not by a missing prompt
  // section at runtime.
  for (const skillPath of resolveContractSkillPaths()) {
    assert.equal(
      fs.existsSync(path.join(skillPath, 'SKILL.md')),
      true,
      `expected contract skill at ${skillPath}`
    );
  }
});
