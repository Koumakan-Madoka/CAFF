const fs = require('node:fs');
const path = require('node:path');

const RESERVED_SKILL_FILES = new Set(['SKILL.md', 'agents/openai.yaml']);

function createSkillRegistryError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sanitizeSkillId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeSkillFilePath(value) {
  const normalized = path.posix.normalize(String(value || '').trim().replace(/\\/g, '/')).replace(/^\/+/, '');

  if (!normalized || normalized === '.' || normalized.endsWith('/')) {
    throw createSkillRegistryError(400, 'Skill file path is required');
  }

  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw createSkillRegistryError(400, 'Invalid skill file path');
  }

  return normalized;
}

function isReservedSkillFile(relativePath) {
  return RESERVED_SKILL_FILES.has(relativePath);
}

function quoteYamlString(value) {
  return JSON.stringify(String(value || ''));
}

function splitFrontmatter(content) {
  const source = String(content || '');

  if (!source.startsWith('---\n')) {
    return {
      frontmatter: '',
      body: source.trim(),
    };
  }

  const endIndex = source.indexOf('\n---\n', 4);

  if (endIndex === -1) {
    return {
      frontmatter: '',
      body: source.trim(),
    };
  }

  return {
    frontmatter: source.slice(4, endIndex),
    body: source.slice(endIndex + 5).trim(),
  };
}

function parseFrontmatterValue(value) {
  const trimmed = String(value || '').trim();

  if (!trimmed) {
    return '';
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed.replace(/^'/, '"').replace(/'$/, '"'));
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}

function parseFrontmatter(frontmatter) {
  const result = {
    name: '',
    description: '',
  };

  for (const line of String(frontmatter || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);

    if (!match) {
      continue;
    }

    const key = match[1];
    const value = parseFrontmatterValue(match[2]);

    if (key === 'name' || key === 'description') {
      result[key] = value;
    }
  }

  return result;
}

function buildSkillMarkdown({ name, description, body }) {
  return [
    '---',
    `name: ${quoteYamlString(name)}`,
    `description: ${quoteYamlString(description)}`,
    '---',
    '',
    String(body || '').trim(),
    '',
  ].join('\n');
}

function listRelativeFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const stack = [''];

  while (stack.length > 0) {
    const currentRelative = stack.pop();
    const currentPath = path.join(rootDir, currentRelative);

    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const relativePath = currentRelative ? path.join(currentRelative, entry.name) : entry.name;

      if (entry.isDirectory()) {
        stack.push(relativePath);
        continue;
      }

      files.push(relativePath.replace(/\\/g, '/'));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function pruneEmptyDirectories(startDir, stopDir) {
  let currentDir = startDir;
  const finalStopDir = path.resolve(stopDir);

  while (currentDir && path.resolve(currentDir).startsWith(finalStopDir) && path.resolve(currentDir) !== finalStopDir) {
    if (!fs.existsSync(currentDir) || !fs.statSync(currentDir).isDirectory()) {
      break;
    }

    if (fs.readdirSync(currentDir).length > 0) {
      break;
    }

    fs.rmSync(currentDir, { recursive: true, force: true });
    currentDir = path.dirname(currentDir);
  }
}

class SkillRegistry {
  constructor({ agentDir }) {
    this.agentDir = path.resolve(agentDir);
    this.skillsDir = path.join(this.agentDir, 'skills');
    fs.mkdirSync(this.skillsDir, { recursive: true });
  }

  resolveSkillDir(skillId) {
    return path.join(this.skillsDir, sanitizeSkillId(skillId));
  }

  ensureSkill(skillId) {
    const normalizedId = sanitizeSkillId(skillId);

    if (!normalizedId) {
      throw createSkillRegistryError(400, 'Skill id is required');
    }

    const skillDir = this.resolveSkillDir(normalizedId);
    const skillFilePath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillFilePath)) {
      throw createSkillRegistryError(404, 'Skill not found');
    }

    return {
      skillId: normalizedId,
      skillDir,
      skillFilePath,
    };
  }

  resolveSkillFile(skillId, filePath) {
    const { skillId: normalizedId, skillDir } = this.ensureSkill(skillId);
    const relativePath = normalizeSkillFilePath(filePath);
    const fullPath = path.resolve(skillDir, relativePath);
    const relativeFromSkillDir = path.relative(skillDir, fullPath);

    if (!relativeFromSkillDir || relativeFromSkillDir.startsWith('..') || path.isAbsolute(relativeFromSkillDir)) {
      throw createSkillRegistryError(400, 'Invalid skill file path');
    }

    return {
      skillId: normalizedId,
      skillDir,
      relativePath,
      fullPath,
    };
  }

  listSkills() {
    if (!fs.existsSync(this.skillsDir)) {
      return [];
    }

    return fs
      .readdirSync(this.skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.getSkill(entry.name))
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }

  getSkill(skillId) {
    const normalizedId = sanitizeSkillId(skillId);

    if (!normalizedId) {
      return null;
    }

    const skillDir = this.resolveSkillDir(normalizedId);
    const skillFilePath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillFilePath)) {
      return null;
    }

    const skillMarkdown = fs.readFileSync(skillFilePath, 'utf8');
    const { frontmatter, body } = splitFrontmatter(skillMarkdown);
    const metadata = parseFrontmatter(frontmatter);
    const openaiYamlPath = path.join(skillDir, 'agents', 'openai.yaml');
    const openaiYaml = fs.existsSync(openaiYamlPath) ? fs.readFileSync(openaiYamlPath, 'utf8') : '';
    const files = listRelativeFiles(skillDir);

    return {
      id: normalizedId,
      name: metadata.name || normalizedId,
      description: metadata.description || '',
      body,
      skillMarkdown,
      openaiYaml,
      path: skillDir,
      files,
      hasOpenAiYaml: Boolean(openaiYaml),
    };
  }

  resolveSkills(skillIds) {
    const seen = new Set();
    const resolved = [];

    for (const rawId of Array.isArray(skillIds) ? skillIds : []) {
      const skillId = sanitizeSkillId(rawId);

      if (!skillId || seen.has(skillId)) {
        continue;
      }

      const skill = this.getSkill(skillId);

      if (!skill) {
        continue;
      }

      seen.add(skillId);
      resolved.push(skill);
    }

    return resolved;
  }

  saveSkill(input = {}) {
    const name = String(input.name || '').trim();
    const description = String(input.description || '').trim();
    const body = String(input.body || '').trim();
    const normalizedId = sanitizeSkillId(input.id || name);

    if (!normalizedId) {
      throw createSkillRegistryError(400, 'Skill id is required');
    }

    if (!name) {
      throw createSkillRegistryError(400, 'Skill name is required');
    }

    if (!description) {
      throw createSkillRegistryError(400, 'Skill description is required');
    }

    if (!body) {
      throw createSkillRegistryError(400, 'Skill body is required');
    }

    const skillDir = this.resolveSkillDir(normalizedId);
    const skillFilePath = path.join(skillDir, 'SKILL.md');
    const openaiYaml = String(input.openaiYaml || '').trim();

    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      skillFilePath,
      buildSkillMarkdown({
        name,
        description,
        body,
      }),
      'utf8'
    );

    const agentsDir = path.join(skillDir, 'agents');
    const openaiYamlPath = path.join(agentsDir, 'openai.yaml');

    if (openaiYaml) {
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(openaiYamlPath, `${openaiYaml}\n`, 'utf8');
    } else if (fs.existsSync(openaiYamlPath)) {
      fs.rmSync(openaiYamlPath, { force: true });

      if (fs.existsSync(agentsDir) && fs.readdirSync(agentsDir).length === 0) {
        fs.rmSync(agentsDir, { recursive: true, force: true });
      }
    }

    return this.getSkill(normalizedId);
  }

  getSkillFile(skillId, filePath) {
    const target = this.resolveSkillFile(skillId, filePath);

    if (isReservedSkillFile(target.relativePath)) {
      throw createSkillRegistryError(400, 'Use the main skill form to edit this file');
    }

    if (!fs.existsSync(target.fullPath)) {
      throw createSkillRegistryError(404, 'Skill file not found');
    }

    if (fs.statSync(target.fullPath).isDirectory()) {
      throw createSkillRegistryError(400, 'Folders cannot be opened in the web editor');
    }

    const buffer = fs.readFileSync(target.fullPath);

    if (buffer.includes(0)) {
      throw createSkillRegistryError(415, 'Binary files are not supported in the web editor');
    }

    return {
      path: target.relativePath,
      content: buffer.toString('utf8'),
    };
  }

  saveSkillFile(skillId, filePath, content) {
    const target = this.resolveSkillFile(skillId, filePath);

    if (isReservedSkillFile(target.relativePath)) {
      throw createSkillRegistryError(400, 'Use the main skill form to edit this file');
    }

    fs.mkdirSync(path.dirname(target.fullPath), { recursive: true });
    fs.writeFileSync(target.fullPath, String(content || ''), 'utf8');

    return {
      skill: this.getSkill(target.skillId),
      file: this.getSkillFile(target.skillId, target.relativePath),
    };
  }

  deleteSkillFile(skillId, filePath) {
    const target = this.resolveSkillFile(skillId, filePath);

    if (isReservedSkillFile(target.relativePath)) {
      throw createSkillRegistryError(400, 'Use the main skill form to edit this file');
    }

    if (!fs.existsSync(target.fullPath)) {
      throw createSkillRegistryError(404, 'Skill file not found');
    }

    if (fs.statSync(target.fullPath).isDirectory()) {
      throw createSkillRegistryError(400, 'Folders cannot be deleted in the web editor');
    }

    fs.rmSync(target.fullPath, { force: true });
    pruneEmptyDirectories(path.dirname(target.fullPath), target.skillDir);

    return {
      deletedPath: target.relativePath,
      skill: this.getSkill(target.skillId),
    };
  }

  deleteSkill(skillId) {
    const normalizedId = sanitizeSkillId(skillId);

    if (!normalizedId) {
      return false;
    }

    const skillDir = this.resolveSkillDir(normalizedId);

    if (!fs.existsSync(skillDir)) {
      return false;
    }

    fs.rmSync(skillDir, { recursive: true, force: true });
    return true;
  }
}

function createSkillRegistry(options) {
  return new SkillRegistry(options);
}

module.exports = {
  SkillRegistry,
  createSkillRegistry,
  normalizeSkillFilePath,
  sanitizeSkillId,
};
