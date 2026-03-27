const fs = require('node:fs');
const path = require('node:path');

const RESERVED_SKILL_FILES = new Set(['SKILL.md', 'agents/openai.yaml']);

function createSkillRegistryError(statusCode: any, message: any) {
  const error = new Error(message) as any;
  error.statusCode = statusCode;
  return error;
}

export function sanitizeSkillId(value: any) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeSkillFilePath(value: any) {
  const normalized = path.posix.normalize(String(value || '').trim().replace(/\\/g, '/')).replace(/^\/+/, '');

  if (!normalized || normalized === '.' || normalized.endsWith('/')) {
    throw createSkillRegistryError(400, 'Skill file path is required');
  }

  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw createSkillRegistryError(400, 'Invalid skill file path');
  }

  return normalized;
}

function isReservedSkillFile(relativePath: any) {
  return RESERVED_SKILL_FILES.has(relativePath);
}

function quoteYamlString(value: any) {
  return JSON.stringify(String(value || ''));
}

function splitFrontmatter(content: any) {
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

function parseFrontmatterValue(value: any) {
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

function parseFrontmatter(frontmatter: any) {
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

function buildSkillMarkdown({ name, description, body }: any) {
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

function listRelativeFiles(rootDir: any) {
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

  return files.sort((left: any, right: any) => left.localeCompare(right));
}

function pruneEmptyDirectories(startDir: any, stopDir: any) {
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

export class SkillRegistry {
  [key: string]: any;
  constructor(options: any = {}) {
    const normalizedOptions = options && typeof options === 'object' ? options : {};
    const agentDir = normalizedOptions.agentDir;

    this.agentDir = path.resolve(agentDir);
    this.skillsDir = path.join(this.agentDir, 'skills');
    this.externalSkillsDirs = [];

    const extraSkillDirs = Array.isArray(normalizedOptions.extraSkillDirs) ? normalizedOptions.extraSkillDirs : [];

    for (const candidate of extraSkillDirs) {
      const normalized = String(candidate || '').trim();
      if (!normalized) {
        continue;
      }

      const resolved = path.resolve(normalized);
      if (resolved === this.skillsDir) {
        continue;
      }

      this.externalSkillsDirs.push(resolved);
    }

    fs.mkdirSync(this.skillsDir, { recursive: true });
  }

  normalizeExtraSkillDirs(extraSkillDirs: any) {
    const normalized = [];
    const seen = new Set();

    for (const candidate of Array.isArray(extraSkillDirs) ? extraSkillDirs : []) {
      const value = String(candidate || '').trim();
      if (!value) {
        continue;
      }

      const resolved = path.resolve(value);
      if (resolved === this.skillsDir) {
        continue;
      }

      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      normalized.push(resolved);
    }

    return normalized;
  }

  setExternalSkillDirs(extraSkillDirs: any) {
    this.externalSkillsDirs = this.normalizeExtraSkillDirs(extraSkillDirs);
  }

  resolveExternalSkillRoots(options: any = {}) {
    if (options && typeof options === 'object' && Array.isArray(options.extraSkillDirs)) {
      return this.normalizeExtraSkillDirs(options.extraSkillDirs);
    }

    return Array.isArray(this.externalSkillsDirs) ? this.externalSkillsDirs : [];
  }

  resolveSkillDir(skillId: any) {
    return path.join(this.skillsDir, sanitizeSkillId(skillId));
  }

  resolveExternalSkillDir(rootDir: any, skillId: any) {
    return path.join(String(rootDir || ''), sanitizeSkillId(skillId));
  }

  resolveSkillLocation(skillId: any, options: any = {}) {
    const normalizedId = sanitizeSkillId(skillId);

    if (!normalizedId) {
      return null;
    }

    const skillDir = this.resolveSkillDir(normalizedId);
    const skillFilePath = path.join(skillDir, 'SKILL.md');

    if (fs.existsSync(skillFilePath)) {
      return {
        skillId: normalizedId,
        skillDir,
        skillFilePath,
        readOnly: false,
        source: 'local',
      };
    }

    for (const rootDir of this.resolveExternalSkillRoots(options)) {
      const externalDir = this.resolveExternalSkillDir(rootDir, normalizedId);
      const externalSkillFilePath = path.join(externalDir, 'SKILL.md');

      if (!fs.existsSync(externalSkillFilePath)) {
        continue;
      }

      return {
        skillId: normalizedId,
        skillDir: externalDir,
        skillFilePath: externalSkillFilePath,
        readOnly: true,
        source: rootDir,
      };
    }

    return null;
  }

  ensureSkill(skillId: any, options: any = {}) {
    const normalizedId = sanitizeSkillId(skillId);

    if (!normalizedId) {
      throw createSkillRegistryError(400, 'Skill id is required');
    }

    const location = this.resolveSkillLocation(normalizedId, options);

    if (!location) {
      throw createSkillRegistryError(404, 'Skill not found');
    }

    return location;
  }

  resolveSkillFile(skillId: any, filePath: any, options: any = {}) {
    const { skillId: normalizedId, skillDir, readOnly, source } = this.ensureSkill(skillId, options);
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
      readOnly: Boolean(readOnly),
      source,
    };
  }

  listSkillIdsInRoot(rootDir: any) {
    const resolvedRoot = path.resolve(String(rootDir || ''));

    if (!resolvedRoot || !fs.existsSync(resolvedRoot)) {
      return [];
    }

    try {
      return fs
        .readdirSync(resolvedRoot, { withFileTypes: true })
        .filter((entry: any) => entry.isDirectory())
        .map((entry: any) => entry.name)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  listSkills(options: any = {}) {
    const seen = new Set();
    const collected = [];

    for (const skillId of this.listSkillIdsInRoot(this.skillsDir)) {
      const skill = this.getSkill(skillId, options);
      if (!skill || !skill.id || seen.has(skill.id)) {
        continue;
      }
      seen.add(skill.id);
      collected.push(skill);
    }

    for (const rootDir of this.resolveExternalSkillRoots(options)) {
      for (const skillId of this.listSkillIdsInRoot(rootDir)) {
        const normalizedId = sanitizeSkillId(skillId);
        if (!normalizedId || seen.has(normalizedId)) {
          continue;
        }
        const skill = this.getSkill(normalizedId, options);
        if (!skill || !skill.id || seen.has(skill.id)) {
          continue;
        }
        seen.add(skill.id);
        collected.push(skill);
      }
    }

    return collected.sort((left: any, right: any) => left.name.localeCompare(right.name, 'zh-CN'));
  }

  getSkill(skillId: any, options: any = {}) {
    const location = this.resolveSkillLocation(skillId, options);

    if (!location) {
      return null;
    }

    const skillMarkdown = fs.readFileSync(location.skillFilePath, 'utf8');
    const { frontmatter, body } = splitFrontmatter(skillMarkdown);
    const metadata = parseFrontmatter(frontmatter);
    const openaiYamlPath = path.join(location.skillDir, 'agents', 'openai.yaml');
    const openaiYaml = fs.existsSync(openaiYamlPath) ? fs.readFileSync(openaiYamlPath, 'utf8') : '';
    const files = listRelativeFiles(location.skillDir);

    return {
      id: location.skillId,
      name: metadata.name || location.skillId,
      description: metadata.description || '',
      body,
      skillMarkdown,
      openaiYaml,
      path: location.skillDir,
      files,
      hasOpenAiYaml: Boolean(openaiYaml),
      readOnly: Boolean(location.readOnly),
      source: location.source,
    };
  }

  resolveSkills(skillIds: any, options: any = {}) {
    const seen = new Set();
    const resolved = [];

    for (const rawId of Array.isArray(skillIds) ? skillIds : []) {
      const skillId = sanitizeSkillId(rawId);

      if (!skillId || seen.has(skillId)) {
        continue;
      }

      const skill = this.getSkill(skillId, options);

      if (!skill) {
        continue;
      }

      seen.add(skillId);
      resolved.push(skill);
    }

    return resolved;
  }

  saveSkill(input: any = {}) {
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

  getSkillFile(skillId: any, filePath: any) {
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

  saveSkillFile(skillId: any, filePath: any, content: any) {
    const target = this.resolveSkillFile(skillId, filePath);

    if (target.readOnly) {
      throw createSkillRegistryError(409, 'Skill is read-only (managed outside the local skill sandbox)');
    }

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

  deleteSkillFile(skillId: any, filePath: any) {
    const target = this.resolveSkillFile(skillId, filePath);

    if (target.readOnly) {
      throw createSkillRegistryError(409, 'Skill is read-only (managed outside the local skill sandbox)');
    }

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

  deleteSkill(skillId: any) {
    const normalizedId = sanitizeSkillId(skillId);

    if (!normalizedId) {
      return false;
    }

    const location = this.resolveSkillLocation(normalizedId);

    if (location && location.readOnly) {
      throw createSkillRegistryError(409, 'Skill is read-only (managed outside the local skill sandbox)');
    }

    const skillDir = this.resolveSkillDir(normalizedId);

    if (!fs.existsSync(skillDir)) {
      return false;
    }

    fs.rmSync(skillDir, { recursive: true, force: true });
    return true;
  }
}

export function createSkillRegistry(options: any) {
  return new SkillRegistry(options);
}
