const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// ADR 0002 keeps the planner skill in the repository, so every clone receives
// it. Only portable content may live there: one machine's paths, rooms,
// projects and identities belong in the planner's local overlay
// (~/.caff-ops/local.md), which never enters git.
const ROOT = path.resolve(__dirname, '..', '..');
const SKILL_DIR = path.join(ROOT, '.claude', 'skills', 'caff-ops');

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

const files = listFiles(SKILL_DIR);
const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

const LOCAL_DATA = [
  ['a drive-letter path', /\b[A-Za-z]:[\\/]/],
  ['a named home directory', /[\\/](?:Users|home)[\\/][^\\/\s<>"'`]+/i],
  ['an instance identifier', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['an e-mail address other than an agent identity', /[\w.+-]+@(?!caff\.local\b)[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+/],
];

test('planner skill carries no machine-local paths, instance IDs or personal addresses', () => {
  const findings = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      for (const [label, pattern] of LOCAL_DATA) {
        if (pattern.test(line)) findings.push(`${relative(file)}:${index + 1} has ${label}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.equal(findings.length, 0, ['move machine-specific content to ~/.caff-ops/local.md:', ...findings].join('\n'));
});

test('planner skill references only files it ships', () => {
  // Own files are named through ${CLAUDE_SKILL_DIR} or a relative Markdown link,
  // so a script kept in the local overlay cannot be referenced by accident.
  const missing = [];
  for (const file of files.filter((name) => name.endsWith('.md'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [, target] of text.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([^\s"'`)]+)/g)) {
      if (!fs.existsSync(path.join(SKILL_DIR, target))) missing.push(`${relative(file)} -> \${CLAUDE_SKILL_DIR}/${target}`);
    }
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), target))) missing.push(`${relative(file)} -> ${target}`);
    }
  }
  assert.equal(missing.length, 0, missing.join('\n'));
});

test('planner skill scripts parse', () => {
  const scripts = files.filter((name) => /\.[cm]?js$/.test(name));
  assert.ok(scripts.length > 0);
  for (const script of scripts) execFileSync(process.execPath, ['--check', script], { stdio: 'pipe' });
});

test('planner skill is discoverable by Claude Code and absent from the in-room agent skill root', () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
  assert.ok(frontmatter, 'SKILL.md starts with YAML frontmatter');
  assert.match(frontmatter[1], /^name: caff-ops$/m);
  assert.match(frontmatter[1], /^description: \S/m);
  // In-room pi agents discover .agents/skills; the planner manual is for the planner only.
  assert.equal(fs.existsSync(path.join(ROOT, '.agents', 'skills', 'caff-ops')), false);
});
