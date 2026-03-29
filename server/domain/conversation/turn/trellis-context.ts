const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_MAX_INDEX_PATHS = 40;
const DEFAULT_MAX_CONTEXT_FILES = 12;
const DEFAULT_MAX_CONTEXT_FILE_CHARS = 1200;
const DEFAULT_MAX_CONTEXT_TOTAL_CHARS = 6000;

function clipText(value: any, maxChars = DEFAULT_MAX_CHARS) {
  const text = String(value || '');

  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return '';
  }

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars - 14)}\n\n...[truncated]`;
}

function readTextFile(filePath: any, maxChars = DEFAULT_MAX_CHARS) {
  const resolved = path.resolve(String(filePath || '').trim());

  if (!resolved || !fs.existsSync(resolved)) {
    return '';
  }

  try {
    const stat = safeStat(resolved);

    if (!stat || !stat.isFile()) {
      return '';
    }

    const maxBytes = Math.max(0, Number.isInteger(maxChars) ? maxChars : DEFAULT_MAX_CHARS) * 4 + 128;

    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      return '';
    }

    if (stat.size <= maxBytes) {
      return clipText(fs.readFileSync(resolved, 'utf8'), maxChars);
    }

    const fd = fs.openSync(resolved, 'r');

    try {
      const buffer = Buffer.allocUnsafe(Math.min(maxBytes, stat.size));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return clipText(buffer.subarray(0, bytesRead).toString('utf8'), maxChars);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readJsonlEntries(filePath: any, maxEntries = DEFAULT_MAX_CONTEXT_FILES) {
  const raw = readTextFile(filePath, Math.max(4096, Math.min(DEFAULT_MAX_CHARS, maxEntries * 512)));
  if (!raw) {
    return { entries: [], totalLines: 0, parseErrors: 0, invalidEntries: 0 };
  }

  const lines = raw.split(/\r?\n/);
  const entries: any[] = [];
  let totalLines = 0;
  let parseErrors = 0;
  let invalidEntries = 0;

  for (const line of lines) {
    if (entries.length >= maxEntries) {
      break;
    }

    const trimmed = String(line || '').trim();
    if (!trimmed) {
      continue;
    }

    totalLines += 1;

    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') {
        invalidEntries += 1;
        continue;
      }

      const fileRef = String(parsed.file || parsed.path || '').trim();
      if (!fileRef) {
        invalidEntries += 1;
        continue;
      }

      const entryType = String(parsed.type || '').trim() || 'file';
      const reason = String(parsed.reason || '').trim();
      entries.push({ file: fileRef, type: entryType, reason });
    } catch {
      parseErrors += 1;
    }
  }

  return { entries, totalLines, parseErrors, invalidEntries };
}

function normalizeTaskRef(taskRef: any) {
  let normalized = String(taskRef || '').trim();
  if (!normalized) {
    return '';
  }

  const pathObj = path.isAbsolute(normalized) ? { absolute: true } : null;
  if (pathObj) {
    return normalized;
  }

  normalized = normalized.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  if (normalized.startsWith('tasks/')) {
    return `.trellis/${normalized}`;
  }

  return normalized;
}

function resolveTaskDir(projectDir: any, trellisDir: any, taskRef: any) {
  const normalized = normalizeTaskRef(taskRef);
  if (!normalized) {
    return '';
  }

  const resolvedProjectDir = path.resolve(String(projectDir || '').trim());
  const resolvedTrellisDir = path.resolve(String(trellisDir || '').trim());
  const tasksRootDir = path.join(resolvedTrellisDir, 'tasks');

  let candidateDir = '';

  if (path.isAbsolute(normalized)) {
    candidateDir = path.resolve(normalized);
  } else if (normalized.startsWith('.trellis/')) {
    candidateDir = path.resolve(resolvedProjectDir, normalized);
  } else {
    candidateDir = path.resolve(tasksRootDir, normalized);
  }

  if (!isPathWithinDir(tasksRootDir, candidateDir)) {
    return '';
  }

  const candidateStat = safeStat(candidateDir);

  if (candidateStat && candidateStat.isDirectory()) {
    const realTasksRootDir = safeRealpath(tasksRootDir) || tasksRootDir;
    const realCandidateDir = safeRealpath(candidateDir) || candidateDir;

    if (!isPathWithinDir(realTasksRootDir, realCandidateDir)) {
      return '';
    }
  }

  return candidateDir;
}

function safeStat(filePath: any) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeRealpath(filePath: any) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return '';
  }
}

function isPathWithinDir(rootDir: any, candidatePath: any) {
  const resolvedRoot = path.resolve(String(rootDir || '').trim());
  const resolvedCandidate = path.resolve(String(candidatePath || '').trim());

  if (!resolvedRoot || !resolvedCandidate) {
    return false;
  }

  const rootKey = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const candidateKey = process.platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;

  const relative = path.relative(rootKey, candidateKey);

  if (!relative) {
    return true;
  }

  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveProjectRelativePath(projectDir: any, fileRef: any) {
  const resolvedProjectDir = path.resolve(String(projectDir || '').trim());
  let normalized = String(fileRef || '').trim();
  if (!resolvedProjectDir || !normalized) {
    return null;
  }

  if (path.isAbsolute(normalized)) {
    return null;
  }

  normalized = normalized.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  if (!normalized || normalized === '.' || normalized === '..') {
    return null;
  }

  const absolutePath = path.resolve(resolvedProjectDir, normalized);

  if (!isPathWithinDir(resolvedProjectDir, absolutePath)) {
    return null;
  }

  const stat = safeStat(absolutePath);
  if (!stat) {
    return null;
  }

  const realProjectDir = safeRealpath(resolvedProjectDir) || resolvedProjectDir;
  const realAbsolutePath = safeRealpath(absolutePath) || absolutePath;

  if (!isPathWithinDir(realProjectDir, realAbsolutePath)) {
    return null;
  }

  return {
    absolutePath,
    displayPath: normalized,
    stat,
  };
}

function listMarkdownFilesInDir(dirPath: string, maxFiles: number, maxDepth = 3) {
  const results: string[] = [];

  function visit(currentDir: string, depth: number) {
    if (results.length >= maxFiles || depth > maxDepth) {
      return;
    }

    let entries: any[] = [];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) {
        return;
      }

      if (entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!entry.name.toLowerCase().endsWith('.md')) {
        continue;
      }

      results.push(fullPath);
    }
  }

  visit(dirPath, 0);
  return results;
}

function buildJsonlContextReport(projectDir: any, jsonlPath: any, options: any = {}) {
  const resolvedProjectDir = path.resolve(String(projectDir || '').trim());
  const resolvedJsonlPath = path.resolve(String(jsonlPath || '').trim());

  if (!resolvedProjectDir || !resolvedJsonlPath) {
    return { context: '', stats: null, warnings: [] };
  }

  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_CONTEXT_FILES;
  const maxFileChars = Number.isInteger(options.maxFileChars) ? options.maxFileChars : DEFAULT_MAX_CONTEXT_FILE_CHARS;
  const maxTotalChars = Number.isInteger(options.maxTotalChars) ? options.maxTotalChars : DEFAULT_MAX_CONTEXT_TOTAL_CHARS;
  const maxDirFiles = Number.isInteger(options.maxDirFiles) ? options.maxDirFiles : Math.max(0, Math.floor(maxFiles / 2));

  const jsonl = readJsonlEntries(resolvedJsonlPath, maxFiles);
  const entries = jsonl.entries;
  if (entries.length === 0) {
    return {
      context: '',
      stats: {
        parsedEntries: 0,
        referencedLines: jsonl.totalLines,
        loadedFiles: 0,
        skippedEntries: 0,
        parseErrors: jsonl.parseErrors,
        invalidEntries: jsonl.invalidEntries,
        truncated: false,
      },
      warnings: [],
    };
  }

  const sections: string[] = [];
  let remainingChars = Math.max(0, maxTotalChars);
  let emittedFiles = 0;
  let skippedEntries = 0;
  let truncated = false;
  const skippedFiles: string[] = [];

  for (const entry of entries) {
    if (emittedFiles >= maxFiles || remainingChars <= 0) {
      if (remainingChars <= 0) {
        truncated = true;
      }
      break;
    }

    const entryType = String(entry && entry.type ? entry.type : 'file')
      .trim()
      .toLowerCase();

    const resolved = resolveProjectRelativePath(resolvedProjectDir, entry.file);
    if (!resolved) {
      skippedEntries += 1;
      if (skippedFiles.length < 8) {
        skippedFiles.push(String(entry.file || '').trim());
      }
      continue;
    }

    if (entryType === 'directory' || entryType === 'dir') {
      if (!resolved.stat.isDirectory()) {
        skippedEntries += 1;
        continue;
      }

      const files = listMarkdownFilesInDir(resolved.absolutePath, Math.max(0, maxDirFiles));
      if (files.length === 0) {
        skippedEntries += 1;
        continue;
      }
      for (const filePath of files) {
        if (emittedFiles >= maxFiles || remainingChars <= 0) {
          if (remainingChars <= 0) {
            truncated = true;
          }
          break;
        }

        const relative = path.relative(resolvedProjectDir, filePath).replace(/\\/g, '/');
        const perFileChars = Math.max(0, Math.min(maxFileChars, remainingChars));
        if (perFileChars <= 0) {
          break;
        }

        const content = readTextFile(filePath, perFileChars);
        if (!content) {
          continue;
        }

        sections.push(`=== ${relative} ===\n${content}`);
        remainingChars -= content.length;
        emittedFiles += 1;
      }

      continue;
    }

    if (!resolved.stat.isFile()) {
      skippedEntries += 1;
      continue;
    }

    const perFileChars = Math.max(0, Math.min(maxFileChars, remainingChars));
    if (perFileChars <= 0) {
      truncated = true;
      break;
    }

    const content = readTextFile(resolved.absolutePath, perFileChars);
    if (!content) {
      skippedEntries += 1;
      continue;
    }

    const reasonSuffix = entry.reason ? ` (${entry.reason})` : '';
    sections.push(`=== ${resolved.displayPath}${reasonSuffix} ===\n${content}`);
    remainingChars -= content.length;
    emittedFiles += 1;
  }

  const warnings: string[] = [];
  if (jsonl.parseErrors > 0) {
    warnings.push(`JSON parse errors: ${jsonl.parseErrors}`);
  }
  if (jsonl.invalidEntries > 0) {
    warnings.push(`Invalid JSONL entries: ${jsonl.invalidEntries}`);
  }
  if (skippedEntries > 0) {
    const examples = skippedFiles.filter(Boolean);
    warnings.push(`Skipped entries: ${skippedEntries}${examples.length > 0 ? ` (examples: ${examples.join(', ')})` : ''}`);
  }
  if (truncated) {
    warnings.push('Context truncated to fit limits');
  }

  return {
    context: sections.join('\n\n'),
    stats: {
      parsedEntries: entries.length,
      referencedLines: jsonl.totalLines,
      loadedFiles: emittedFiles,
      skippedEntries,
      parseErrors: jsonl.parseErrors,
      invalidEntries: jsonl.invalidEntries,
      truncated,
    },
    warnings,
  };
}

function buildJsonlContext(projectDir: any, jsonlPath: any, options: any = {}) {
  return buildJsonlContextReport(projectDir, jsonlPath, options).context;
}

function jsonlHasUsableEntries(projectDir: any, jsonlPath: any) {
  const stat = safeStat(jsonlPath);
  if (!stat || !stat.isFile() || stat.size <= 0) {
    return false;
  }

  const jsonl = readJsonlEntries(jsonlPath, 24);

  for (const entry of jsonl.entries) {
    const resolved = resolveProjectRelativePath(projectDir, entry.file);
    if (resolved) {
      return true;
    }
  }

  return false;
}

function buildTaskStatus(projectDir: any, trellisDir: any) {
  const currentTaskPath = path.join(trellisDir, '.current-task');
  const currentTaskRef = readTextFile(currentTaskPath, 4096).trim();

  if (!currentTaskRef) {
    return {
      statusText: 'Status: NO ACTIVE TASK\nNext: Describe what you want to work on',
      taskDir: '',
      prdPath: '',
    };
  }

  const taskDir = resolveTaskDir(projectDir, trellisDir, currentTaskRef);

  if (!taskDir || !fs.existsSync(taskDir) || !safeStat(taskDir)?.isDirectory()) {
    return {
      statusText: `Status: STALE POINTER\nTask: ${normalizeTaskRef(currentTaskRef)}\nNext: Task directory not found or is outside project scope`,
      taskDir: '',
      prdPath: '',
    };
  }

  const taskJsonPath = path.join(taskDir, 'task.json');
  let taskTitle = normalizeTaskRef(currentTaskRef);
  let taskStatus = 'unknown';

  if (fs.existsSync(taskJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        taskTitle = parsed.title || parsed.name || taskTitle;
        taskStatus = parsed.status || taskStatus;
      }
    } catch {}
  }

  if (taskStatus === 'completed') {
    return {
      statusText: `Status: COMPLETED\nTask: ${taskTitle}\nNext: Archive the task or start a new task`,
      taskDir,
      prdPath: path.join(taskDir, 'prd.md'),
    };
  }

  const prdPath = path.join(taskDir, 'prd.md');
  const hasPrd = fs.existsSync(prdPath);

  let hasContext = false;
  for (const jsonlName of ['implement.jsonl', 'check.jsonl', 'spec.jsonl']) {
    const jsonlPath = path.join(taskDir, jsonlName);
    if (jsonlHasUsableEntries(projectDir, jsonlPath)) {
      hasContext = true;
      break;
    }
  }

  if (!hasPrd) {
    return {
      statusText: `Status: NOT READY\nTask: ${taskTitle}\nMissing: prd.md not created\nNext: Write PRD, then configure context`,
      taskDir,
      prdPath,
    };
  }

  if (!hasContext) {
    return {
      statusText: `Status: NOT READY\nTask: ${taskTitle}\nMissing: Context not configured (no jsonl files)\nNext: Configure task context before implementing`,
      taskDir,
      prdPath,
    };
  }

  return {
    statusText: `Status: READY\nTask: ${taskTitle}\nNext: Continue with implement or check`,
    taskDir,
    prdPath,
  };
}

function findTrellisProjectRoot(startDir: any, maxDepth = 10) {
  let currentDir = path.resolve(String(startDir || '').trim() || process.cwd());

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const trellisDir = path.join(currentDir, '.trellis');
    const stat = safeStat(trellisDir);
    if (stat && stat.isDirectory()) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (!parentDir || parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  return '';
}

function listSpecIndexPaths(projectDir: any, trellisDir: any, maxPaths = DEFAULT_MAX_INDEX_PATHS) {
  const specDir = path.join(trellisDir, 'spec');
  const stat = safeStat(specDir);
  if (!stat || !stat.isDirectory()) {
    return [];
  }

  const results: string[] = [];

  function visit(dir: string, depth: number) {
    if (results.length >= maxPaths || depth > 4) {
      return;
    }

    let entries: any[] = [];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const indexPath = path.join(dir, 'index.md');
    if (fs.existsSync(indexPath)) {
      results.push(path.relative(projectDir, indexPath).replace(/\\/g, '/'));
      if (results.length >= maxPaths) {
        return;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith('.')) {
        continue;
      }
      visit(path.join(dir, entry.name), depth + 1);
      if (results.length >= maxPaths) {
        return;
      }
    }
  }

  visit(specDir, 0);
  return results.sort((left, right) => left.localeCompare(right, 'en'));
}

function formatPathHints(lines: string[]) {
  const items = (Array.isArray(lines) ? lines : []).filter(Boolean);
  if (items.length === 0) {
    return '- none';
  }

  return items.map((item) => `- ${item}`).join('\n');
}

export function buildTrellisPromptContext(options: any = {}) {
  const startDir = options.startDir || process.cwd();
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS;
  const maxWorkflowChars = Number.isInteger(options.maxWorkflowChars) ? options.maxWorkflowChars : Math.min(12000, maxChars);
  const maxPrdChars = Number.isInteger(options.maxPrdChars) ? options.maxPrdChars : Math.min(8000, maxChars);
  const maxContextFiles = Number.isInteger(options.maxContextFiles) ? options.maxContextFiles : DEFAULT_MAX_CONTEXT_FILES;
  const maxContextFileChars = Number.isInteger(options.maxContextFileChars)
    ? options.maxContextFileChars
    : DEFAULT_MAX_CONTEXT_FILE_CHARS;
  const maxContextTotalChars = Number.isInteger(options.maxContextTotalChars)
    ? options.maxContextTotalChars
    : Math.min(DEFAULT_MAX_CONTEXT_TOTAL_CHARS, Math.max(0, maxChars));
  const projectDir = findTrellisProjectRoot(startDir);

  if (!projectDir) {
    return '';
  }

  const trellisDir = path.join(projectDir, '.trellis');
  const workflowPath = path.join(trellisDir, 'workflow.md');
  const workflow = readTextFile(workflowPath, maxWorkflowChars);
  const task = buildTaskStatus(projectDir, trellisDir);
  const prd = task.prdPath ? readTextFile(task.prdPath, maxPrdChars) : '';
  const taskContextSourcePath = task.taskDir ? path.join(task.taskDir, 'implement.jsonl') : '';
  const taskContextFallbackPath = task.taskDir ? path.join(task.taskDir, 'spec.jsonl') : '';
  const implementContextReport =
    taskContextSourcePath && fs.existsSync(taskContextSourcePath)
      ? buildJsonlContextReport(projectDir, taskContextSourcePath, {
          maxFiles: maxContextFiles,
          maxFileChars: maxContextFileChars,
          maxTotalChars: maxContextTotalChars,
        })
      : null;
  const specContextReport =
    (!implementContextReport || !implementContextReport.context) && taskContextFallbackPath && fs.existsSync(taskContextFallbackPath)
      ? buildJsonlContextReport(projectDir, taskContextFallbackPath, {
          maxFiles: maxContextFiles,
          maxFileChars: maxContextFileChars,
          maxTotalChars: maxContextTotalChars,
        })
      : null;
  const activeContextReport =
    implementContextReport && implementContextReport.context
      ? { report: implementContextReport, sourcePath: taskContextSourcePath }
      : specContextReport && specContextReport.context
        ? { report: specContextReport, sourcePath: taskContextFallbackPath }
        : implementContextReport
          ? { report: implementContextReport, sourcePath: taskContextSourcePath }
          : specContextReport
            ? { report: specContextReport, sourcePath: taskContextFallbackPath }
            : null;
  const activeTaskContext = activeContextReport && activeContextReport.report ? activeContextReport.report.context : '';
  const activeTaskContextSource =
    activeContextReport && activeContextReport.sourcePath
      ? path.relative(projectDir, activeContextReport.sourcePath).replace(/\\/g, '/')
      : '';
  const activeTaskContextWarnings =
    activeContextReport && activeContextReport.report && Array.isArray(activeContextReport.report.warnings)
      ? activeContextReport.report.warnings.filter(Boolean)
      : [];
  const specIndexes = listSpecIndexPaths(projectDir, trellisDir);

  const pythonHint =
    process.platform === 'win32'
      ? 'Note: Windows detected. If Trellis docs/scripts mention `python3`, use `python` instead.'
      : '';

  const lines = [];
  lines.push(`Trellis detected in project: ${projectDir}`);
  if (pythonHint) {
    lines.push(pythonHint);
  }
  lines.push('');
  lines.push('Task status:');
  lines.push(task.statusText);
  lines.push('');
  lines.push('Active PRD (if any):');
  lines.push(prd ? prd : '[no prd.md found]');
  lines.push('');
  lines.push('Active JSONL context (from current task):');
  if (activeContextReport) {
    lines.push(activeTaskContextSource ? `Source: ${activeTaskContextSource}` : 'Source: [unknown]');
    if (activeTaskContextWarnings.length > 0) {
      lines.push('Warnings:');
      lines.push(activeTaskContextWarnings.map((warning) => `- ${warning}`).join('\n'));
      lines.push('');
    }
    lines.push(activeTaskContext ? activeTaskContext : '[no JSONL context loaded]');
  } else {
    lines.push('[no JSONL files found]');
  }
  lines.push('');
  lines.push('Workflow (from .trellis/workflow.md):');
  lines.push(workflow ? workflow : '[no workflow.md found]');
  lines.push('');
  lines.push('Available spec index files (read the relevant ones before coding):');
  lines.push(formatPathHints(specIndexes));
  return lines.join('\n');
}
