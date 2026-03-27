const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_MAX_INDEX_PATHS = 40;

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
    const stat = safeStat(jsonlPath);
    if (stat && stat.isFile() && stat.size > 0) {
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
  const projectDir = findTrellisProjectRoot(startDir);

  if (!projectDir) {
    return '';
  }

  const trellisDir = path.join(projectDir, '.trellis');
  const workflowPath = path.join(trellisDir, 'workflow.md');
  const workflow = readTextFile(workflowPath, maxWorkflowChars);
  const task = buildTaskStatus(projectDir, trellisDir);
  const prd = task.prdPath ? readTextFile(task.prdPath, maxPrdChars) : '';
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
  lines.push('Workflow (from .trellis/workflow.md):');
  lines.push(workflow ? workflow : '[no workflow.md found]');
  lines.push('');
  lines.push('Available spec index files (read the relevant ones before coding):');
  lines.push(formatPathHints(specIndexes));
  return lines.join('\n');
}
