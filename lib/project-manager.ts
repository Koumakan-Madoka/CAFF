const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function nowIso() {
  return new Date().toISOString();
}

function safeReadJson(filePath: any, fallback: any) {
  const resolved = path.resolve(String(filePath || '').trim());

  if (!resolved || !fs.existsSync(resolved)) {
    return fallback;
  }

  try {
    const text = fs.readFileSync(resolved, 'utf8');
    if (!text.trim()) {
      return fallback;
    }
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: any, value: any) {
  const resolved = path.resolve(String(filePath || '').trim());
  if (!resolved) {
    return;
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const tmpPath = `${resolved}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, resolved);
}

function normalizeProjectPath(value: any) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  return path.resolve(normalized);
}

function normalizeProjectName(value: any, fallback: any) {
  const normalized = String(value || '').trim();
  if (normalized) {
    return normalized;
  }

  const fallbackValue = String(fallback || '').trim();
  return fallbackValue || 'Project';
}

function getProjectNameFromPath(projectPath: any) {
  const resolved = normalizeProjectPath(projectPath);
  if (!resolved) {
    return '';
  }

  const base = path.basename(resolved);
  return base || resolved;
}

function isSamePath(left: any, right: any) {
  const resolvedLeft = normalizeProjectPath(left);
  const resolvedRight = normalizeProjectPath(right);

  if (!resolvedLeft || !resolvedRight) {
    return false;
  }

  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function sanitizeProjectRecord(project: any) {
  if (!project || typeof project !== 'object') {
    return null;
  }

  const projectId = String(project.id || '').trim();
  const projectPath = normalizeProjectPath(project.path);
  const projectName = normalizeProjectName(project.name, getProjectNameFromPath(projectPath));

  if (!projectId || !projectPath) {
    return null;
  }

  return {
    id: projectId,
    name: projectName,
    path: projectPath,
    createdAt: String(project.createdAt || '').trim() || nowIso(),
    updatedAt: String(project.updatedAt || '').trim() || nowIso(),
    lastOpenedAt: String(project.lastOpenedAt || '').trim() || '',
  };
}

function defaultConfig() {
  return {
    version: 1,
    activeProjectId: '',
    projects: [],
    updatedAt: nowIso(),
  };
}

export class ProjectManager {
  [key: string]: any;
  constructor(options: any = {}) {
    const normalizedOptions = options && typeof options === 'object' ? options : {};

    this.agentDir = path.resolve(String(normalizedOptions.agentDir || '').trim() || process.cwd());
    this.configPath = path.resolve(this.agentDir, 'projects.json');
    this.cache = null;

    const initialProjectDir = normalizeProjectPath(normalizedOptions.initialProjectDir);
    if (initialProjectDir) {
      const hasConfigFile = fs.existsSync(this.configPath);

      if (!hasConfigFile) {
        this.ensureProject({ path: initialProjectDir });
        this.ensureActiveProjectByPath(initialProjectDir);
      }
    }
  }

  loadConfig(force = false) {
    if (!force && this.cache) {
      return this.cache;
    }

    const parsed = safeReadJson(this.configPath, defaultConfig());
    const normalized = {
      ...defaultConfig(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
    };

    const projects = (Array.isArray(normalized.projects) ? normalized.projects : [])
      .map(sanitizeProjectRecord)
      .filter(Boolean);

    const activeProjectId = String(normalized.activeProjectId || '').trim();
    const activeValid = activeProjectId && projects.some((project: any) => project && project.id === activeProjectId);

    const next = {
      version: 1,
      activeProjectId: activeValid ? activeProjectId : projects[0] ? projects[0].id : '',
      projects,
      updatedAt: String(normalized.updatedAt || '').trim() || nowIso(),
    };

    this.cache = next;
    return next;
  }

  saveConfig(nextConfig: any) {
    const normalized = nextConfig && typeof nextConfig === 'object' ? nextConfig : defaultConfig();
    const configToWrite = {
      version: 1,
      activeProjectId: String(normalized.activeProjectId || '').trim(),
      projects: Array.isArray(normalized.projects) ? normalized.projects : [],
      updatedAt: nowIso(),
    };

    writeJsonAtomic(this.configPath, configToWrite);
    this.cache = configToWrite;
    return configToWrite;
  }

  listProjects() {
    const config = this.loadConfig();
    return Array.isArray(config.projects) ? config.projects.slice() : [];
  }

  getActiveProjectId() {
    const config = this.loadConfig();
    return String(config.activeProjectId || '').trim();
  }

  getActiveProject() {
    const config = this.loadConfig();
    const activeId = String(config.activeProjectId || '').trim();
    return (Array.isArray(config.projects) ? config.projects : []).find((project: any) => project && project.id === activeId) || null;
  }

  ensureProject(input: any = {}) {
    const config = this.loadConfig();
    const projectPath = normalizeProjectPath(input.path);

    if (!projectPath) {
      return null;
    }

    const existing = (Array.isArray(config.projects) ? config.projects : []).find((project: any) => isSamePath(project && project.path, projectPath));

    if (existing) {
      return existing;
    }

    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      const error: any = new Error('Project path does not exist or is not a folder');
      error.statusCode = 400;
      throw error;
    }

    const createdAt = nowIso();
    const project = {
      id: `project-${randomUUID()}`,
      name: normalizeProjectName(input.name, getProjectNameFromPath(projectPath)),
      path: projectPath,
      createdAt,
      updatedAt: createdAt,
      lastOpenedAt: createdAt,
    };

    const nextConfig = {
      ...config,
      projects: [...(Array.isArray(config.projects) ? config.projects : []), project],
      updatedAt: createdAt,
    };

    this.saveConfig(nextConfig);
    return project;
  }

  removeProject(projectId: any) {
    const normalizedId = String(projectId || '').trim();
    const config = this.loadConfig();
    const projects = Array.isArray(config.projects) ? config.projects : [];

    if (!normalizedId) {
      return config;
    }

    const nextProjects = projects.filter((project: any) => project && project.id !== normalizedId);
    const nextActive =
      config.activeProjectId === normalizedId ? (nextProjects[0] ? nextProjects[0].id : '') : config.activeProjectId;

    return this.saveConfig({
      ...config,
      activeProjectId: nextActive,
      projects: nextProjects,
    });
  }

  ensureActiveProjectByPath(projectPath: any) {
    const resolvedPath = normalizeProjectPath(projectPath);
    const config = this.loadConfig();

    if (!resolvedPath) {
      return config;
    }

    const existing = (Array.isArray(config.projects) ? config.projects : []).find((project: any) => isSamePath(project && project.path, resolvedPath));

    if (!existing) {
      return config;
    }

    return this.setActiveProject(existing.id);
  }

  setActiveProject(projectId: any) {
    const normalizedId = String(projectId || '').trim();
    const config = this.loadConfig();
    const projects = Array.isArray(config.projects) ? config.projects : [];

    if (!normalizedId) {
      return config;
    }

    const target = projects.find((project: any) => project && project.id === normalizedId);

    if (!target) {
      const error: any = new Error('Project not found');
      error.statusCode = 404;
      throw error;
    }

    const projectPath = normalizeProjectPath(target.path);

    if (!projectPath || !fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      const error: any = new Error('Project path does not exist or is not a folder');
      error.statusCode = 400;
      throw error;
    }

    const timestamp = nowIso();
    const nextProjects = projects.map((project: any) => {
      if (!project || project.id !== normalizedId) {
        return project;
      }

      return {
        ...project,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      };
    });

    return this.saveConfig({
      ...config,
      activeProjectId: normalizedId,
      projects: nextProjects,
    });
  }
}

export function createProjectManager(options: any = {}) {
  return new ProjectManager(options);
}
