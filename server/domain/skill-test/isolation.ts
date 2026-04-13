// @ts-nocheck
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHttpError } = require('../../http/http-errors');
const { createChatAppStore } = require('../../../lib/chat-app-store');
const { resolveSqliteFileUriPath } = require('../../../storage/sqlite/connection');
const {
  ensureAgentSandbox,
  resolveAgentPrivateDir,
  resolveAgentSandboxDir,
} = require('../conversation/turn/agent-sandbox');

const DEFAULT_ALLOWED_BRIDGE_TOOLS = [
  'send-public',
  'send-private',
  'read-context',
  'list-participants',
  'search-messages',
  'list-memories',
  'save-memory',
  'update-memory',
  'forget-memory',
  'trellis-init',
  'trellis-write',
];

const DEFAULT_DRIVER_NAME = 'opensandbox';
const DEFAULT_EGRESS_MODE = 'deny';
const DEFAULT_TRELLIS_MODE = 'none';
const DEFAULT_ISOLATION_MODE = 'legacy-local';
const SNAPSHOT_IGNORED_DIR_NAMES = new Set(['workspace']);

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePathForJson(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function normalizeToolName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'participants') {
    return 'list-participants';
  }
  return normalized;
}

function clipText(value, maxLength = 200) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function hashBuffer(buffer) {
  return nodeCrypto.createHash('sha1').update(buffer).digest('hex');
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  return fallback;
}

function normalizeAllowedBridgeTools(value) {
  const seen = new Set();
  const tools = [];
  for (const entry of Array.isArray(value) ? value : DEFAULT_ALLOWED_BRIDGE_TOOLS) {
    const normalized = normalizeToolName(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    tools.push(normalized);
  }
  return tools;
}

function resolveSkillTestCaseRoot(rootDir) {
  const baseRoot = String(rootDir || '').trim() || path.join(os.tmpdir(), 'caff-skill-test-isolation');
  ensureDirectory(baseRoot);
  return fs.mkdtempSync(path.join(baseRoot, 'case-'));
}

function copyFile(sourcePath, targetPath) {
  ensureDirectory(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function assertNotSymlink(absolutePath, stat, reason) {
  if (stat && stat.isSymbolicLink && stat.isSymbolicLink()) {
    throw createHttpError(400, `${String(reason || 'Skill test isolation refuses to follow symlinks').trim()}: ${normalizePathForJson(absolutePath)}`);
  }
}

function copyDirectoryRecursive(sourceDir, targetDir, options = {}) {
  const sourcePath = path.resolve(String(sourceDir || ''));
  const targetPath = path.resolve(String(targetDir || ''));
  const filter = typeof options.filter === 'function' ? options.filter : null;

  if (!fs.existsSync(sourcePath)) {
    return [];
  }

  const copied = [];
  const stack = [''];

  while (stack.length > 0) {
    const relativePath = stack.pop() || '';
    const absolutePath = path.join(sourcePath, relativePath);
    const stat = fs.lstatSync(absolutePath);
    assertNotSymlink(absolutePath, stat, 'Skill test isolation snapshot copy refuses symlinks');

    if (filter && filter(relativePath, absolutePath, stat) === false) {
      continue;
    }

    if (stat.isDirectory()) {
      ensureDirectory(path.join(targetPath, relativePath));
      for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
        const nextRelative = relativePath ? path.join(relativePath, entry.name) : entry.name;
        stack.push(nextRelative);
      }
      continue;
    }

    const targetFilePath = path.join(targetPath, relativePath);
    copyFile(absolutePath, targetFilePath);
    copied.push(normalizePathForJson(relativePath));
  }

  return copied.sort((left, right) => left.localeCompare(right));
}

function buildMinimalTrellisFixture(projectDir, options = {}) {
  const root = path.resolve(projectDir);
  const taskName = String(options.taskName || 'skill-test-fixture').trim() || 'skill-test-fixture';
  const developerName = String(options.developerName || 'Skill Test').trim() || 'Skill Test';
  const taskDir = path.join(root, '.trellis', 'tasks', taskName);

  ensureDirectory(path.join(root, '.trellis', 'spec'));
  ensureDirectory(taskDir);

  fs.writeFileSync(path.join(root, '.trellis', 'workflow.md'), '# Workflow\n\nSkill test fixture workflow.\n', 'utf8');
  fs.writeFileSync(path.join(root, '.trellis', 'config.yaml'), 'session_commit_message: "chore: skill-test fixture"\n', 'utf8');
  fs.writeFileSync(path.join(root, '.trellis', '.current-task'), `${taskName}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '.trellis', '.developer'), `name=${developerName}\ninitialized_at=${nowIso()}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '.trellis', 'spec', 'index.md'), '# Spec Index\n\n- skill test fixture\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'prd.md'), '# Fixture PRD\n\nSkill test fixture task.\n', 'utf8');
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({
      name: taskName,
      title: 'Skill Test Fixture',
      status: 'ready',
      createdAt: nowIso(),
    }, null, 2) + '\n',
    'utf8'
  );
  fs.writeFileSync(path.join(taskDir, 'implement.jsonl'), JSON.stringify({ type: 'fixture', createdAt: nowIso() }) + '\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'check.jsonl'), JSON.stringify({ type: 'fixture', createdAt: nowIso() }) + '\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'spec.jsonl'), JSON.stringify({ type: 'fixture', createdAt: nowIso() }) + '\n', 'utf8');
}

function resolveCurrentTaskName(projectDir) {
  const currentTaskPath = path.join(String(projectDir || ''), '.trellis', '.current-task');
  try {
    return String(fs.readFileSync(currentTaskPath, 'utf8') || '').trim();
  } catch {
    return '';
  }
}

function copyReadonlyTrellisSnapshot(liveProjectDir, caseProjectDir) {
  const liveRoot = path.resolve(String(liveProjectDir || ''));
  const liveTrellisDir = path.join(liveRoot, '.trellis');

  if (!fs.existsSync(liveTrellisDir)) {
    return [];
  }

  const liveTrellisStat = fs.lstatSync(liveTrellisDir);
  assertNotSymlink(liveTrellisDir, liveTrellisStat, 'Skill test readonlySnapshot refuses symlinked .trellis roots');
  if (!liveTrellisStat.isDirectory()) {
    return [];
  }

  const currentTaskName = resolveCurrentTaskName(liveRoot);
  const copied = [];
  const staticFiles = [
    'workflow.md',
    'config.yaml',
    '.current-task',
    '.developer',
    'spec',
  ];

  for (const relativePath of staticFiles) {
    const sourcePath = path.join(liveTrellisDir, relativePath);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    const targetPath = path.join(caseProjectDir, '.trellis', relativePath);
    const stat = fs.lstatSync(sourcePath);
    assertNotSymlink(sourcePath, stat, 'Skill test readonlySnapshot refuses symlinked Trellis entries');
    if (stat.isDirectory()) {
      copied.push(...copyDirectoryRecursive(sourcePath, targetPath, {
        filter(relative, absolutePath, relativeStat) {
          if (!relative) {
            return true;
          }
          const firstSegment = normalizePathForJson(relative).split('/')[0];
          if (relativeStat.isDirectory() && SNAPSHOT_IGNORED_DIR_NAMES.has(firstSegment)) {
            return false;
          }
          return true;
        },
      }).map((entry) => normalizePathForJson(path.join(relativePath, entry))));
      continue;
    }

    copyFile(sourcePath, targetPath);
    copied.push(normalizePathForJson(relativePath));
  }

  if (currentTaskName) {
    const liveTaskDir = path.join(liveTrellisDir, 'tasks', currentTaskName);
    if (fs.existsSync(liveTaskDir)) {
      const liveTaskStat = fs.lstatSync(liveTaskDir);
      assertNotSymlink(liveTaskDir, liveTaskStat, 'Skill test readonlySnapshot refuses symlinked Trellis task directories');
      if (liveTaskStat.isDirectory()) {
        copied.push(...copyDirectoryRecursive(liveTaskDir, path.join(caseProjectDir, '.trellis', 'tasks', currentTaskName)).map((entry) => (
          normalizePathForJson(path.join('tasks', currentTaskName, entry))
        )));
      }
    }
  }

  return copied.sort((left, right) => left.localeCompare(right));
}

function materializeTrellisMode(caseProjectDir, liveProjectDir, trellisMode) {
  const normalizedMode = String(trellisMode || DEFAULT_TRELLIS_MODE).trim().toLowerCase() || DEFAULT_TRELLIS_MODE;

  if (normalizedMode === 'none') {
    return { mode: normalizedMode, copiedFiles: [] };
  }

  if (normalizedMode === 'fixture') {
    buildMinimalTrellisFixture(caseProjectDir);
    return { mode: normalizedMode, copiedFiles: ['.trellis'] };
  }

  if (normalizedMode === 'readonlysnapshot') {
    return {
      mode: normalizedMode,
      copiedFiles: copyReadonlyTrellisSnapshot(liveProjectDir, caseProjectDir),
    };
  }

  if (normalizedMode === 'liveexplicit') {
    return { mode: normalizedMode, copiedFiles: [] };
  }

  return { mode: DEFAULT_TRELLIS_MODE, copiedFiles: [] };
}

function snapshotSymlinkEntry(filePath, stat = null) {
  try {
    const linkStat = stat || fs.lstatSync(filePath);
    const linkTarget = fs.readlinkSync(filePath);
    const buffer = Buffer.from(String(linkTarget || ''), 'utf8');
    return {
      type: 'symlink',
      size: buffer.length,
      mtimeMs: linkStat.mtimeMs,
      sha1: hashBuffer(buffer),
    };
  } catch {
    return null;
  }
}

function snapshotFileEntry(filePath, stat = null) {
  try {
    const fileStat = stat || fs.lstatSync(filePath);
    if (fileStat.isSymbolicLink()) {
      return snapshotSymlinkEntry(filePath, fileStat);
    }
    const buffer = fs.readFileSync(filePath);
    return {
      type: 'file',
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      sha1: hashBuffer(buffer),
    };
  } catch {
    return null;
  }
}

function snapshotDirectoryEntries(rootDir) {
  const entries = {};
  const stack = [''];

  while (stack.length > 0) {
    const relativePath = stack.pop() || '';
    const absolutePath = path.join(rootDir, relativePath);
    let stat = null;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
        const nextRelative = relativePath ? path.join(relativePath, entry.name) : entry.name;
        stack.push(nextRelative);
      }
      continue;
    }

    const fileEntry = snapshotFileEntry(absolutePath, stat);
    if (!fileEntry) {
      continue;
    }
    entries[normalizePathForJson(relativePath)] = fileEntry;
  }

  return entries;
}

function capturePathSnapshot(label, targetPath) {
  const resolvedPath = path.resolve(String(targetPath || ''));
  const snapshot = {
    label,
    path: resolvedPath,
    normalizedPath: normalizePathForJson(resolvedPath),
    exists: false,
    type: 'missing',
    entries: {},
  };

  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return snapshot;
  }

  const stat = fs.lstatSync(resolvedPath);
  snapshot.exists = true;
  snapshot.type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file';

  if (stat.isDirectory()) {
    snapshot.entries = snapshotDirectoryEntries(resolvedPath);
    snapshot.fileCount = Object.keys(snapshot.entries).length;
    return snapshot;
  }

  snapshot.entries = { '.': snapshotFileEntry(resolvedPath, stat) };
  snapshot.fileCount = snapshot.entries['.'] ? 1 : 0;
  return snapshot;
}

function comparePathSnapshots(before, after) {
  const changes = [];
  if (!before && !after) {
    return changes;
  }

  if (Boolean(before && before.exists) !== Boolean(after && after.exists) || String(before && before.type || '') !== String(after && after.type || '')) {
    changes.push({
      label: after && after.label ? after.label : before && before.label ? before.label : 'target',
      path: after && after.normalizedPath ? after.normalizedPath : before && before.normalizedPath ? before.normalizedPath : '',
      kind: 'target-changed',
      before: before && before.exists ? before.type : 'missing',
      after: after && after.exists ? after.type : 'missing',
    });
    return changes;
  }

  const beforeEntries = before && before.entries && typeof before.entries === 'object' ? before.entries : {};
  const afterEntries = after && after.entries && typeof after.entries === 'object' ? after.entries : {};
  const keys = [...new Set([...Object.keys(beforeEntries), ...Object.keys(afterEntries)])].sort((left, right) => left.localeCompare(right));

  for (const key of keys) {
    const beforeEntry = beforeEntries[key] || null;
    const afterEntry = afterEntries[key] || null;
    if (!beforeEntry && afterEntry) {
      changes.push({
        label: after.label,
        path: normalizePathForJson(path.join(after.normalizedPath, key === '.' ? '' : key)),
        kind: 'added',
      });
      continue;
    }
    if (beforeEntry && !afterEntry) {
      changes.push({
        label: before.label,
        path: normalizePathForJson(path.join(before.normalizedPath, key === '.' ? '' : key)),
        kind: 'removed',
      });
      continue;
    }
    if (!beforeEntry || !afterEntry) {
      continue;
    }
    if (beforeEntry.type !== afterEntry.type || beforeEntry.sha1 !== afterEntry.sha1 || beforeEntry.size !== afterEntry.size) {
      changes.push({
        label: after.label,
        path: normalizePathForJson(path.join(after.normalizedPath, key === '.' ? '' : key)),
        kind: 'modified',
        beforeSha1: beforeEntry.sha1,
        afterSha1: afterEntry.sha1,
      });
    }
  }

  return changes;
}

function capturePollutionTargets(targets) {
  return (Array.isArray(targets) ? targets : []).map((target) => capturePathSnapshot(target.label, target.path));
}

function comparePollutionTargets(beforeSnapshots, afterSnapshots) {
  const beforeList = Array.isArray(beforeSnapshots) ? beforeSnapshots : [];
  const afterList = Array.isArray(afterSnapshots) ? afterSnapshots : [];
  const changes = [];

  for (let index = 0; index < Math.max(beforeList.length, afterList.length); index += 1) {
    changes.push(...comparePathSnapshots(beforeList[index], afterList[index]));
  }

  return {
    checked: true,
    ok: changes.length === 0,
    changeCount: changes.length,
    changes: changes.slice(0, 50),
  };
}

function normalizeSkillTestIsolationOptions(input = {}, options = {}) {
  const value = isPlainObject(input) ? input : {};
  const driverAvailable = normalizeBoolean(options.driverAvailable, false);
  const requestedMode = String(
    value.mode || value.isolationMode || value.kind || options.defaultMode || DEFAULT_ISOLATION_MODE
  ).trim().toLowerCase() || DEFAULT_ISOLATION_MODE;
  const mode = requestedMode === 'isolated' ? 'isolated' : 'legacy-local';
  const publishGate = normalizeBoolean(value.publishGate || value.publish_gate, false);
  const driver = String(value.driver || value.driverName || DEFAULT_DRIVER_NAME).trim().toLowerCase() || DEFAULT_DRIVER_NAME;
  const trellisMode = String(value.trellisMode || value.trellis_mode || DEFAULT_TRELLIS_MODE).trim().toLowerCase() || DEFAULT_TRELLIS_MODE;
  const egressMode = String(value.egressMode || value.egress_mode || DEFAULT_EGRESS_MODE).trim().toLowerCase() || DEFAULT_EGRESS_MODE;
  const allowLiveTrellis = normalizeBoolean(options.allowLiveTrellis, false);

  if (mode === 'isolated' && !driverAvailable) {
    throw createHttpError(503, `Isolated skill testing requires the ${driver} driver, but it is not configured`);
  }

  if (publishGate && mode !== 'isolated') {
    throw createHttpError(400, 'Publish-gate skill testing requires isolated mode');
  }

  if (!['none', 'fixture', 'readonlysnapshot', 'liveexplicit'].includes(trellisMode)) {
    throw createHttpError(400, 'trellisMode must be one of: none, fixture, readonlySnapshot, liveExplicit');
  }

  if (trellisMode === 'liveexplicit' && !allowLiveTrellis) {
    throw createHttpError(400, 'trellisMode liveExplicit requires explicit manual opt-in');
  }

  if (!['deny', 'allow'].includes(egressMode)) {
    throw createHttpError(400, 'egressMode must be one of: deny, allow');
  }

  return {
    mode,
    notIsolated: mode !== 'isolated',
    driver,
    publishGate,
    trellisMode,
    egressMode,
    allowedBridgeTools: normalizeAllowedBridgeTools(value.allowedBridgeTools || value.allowedTools),
  };
}

function normalizeExecutionEvidence(input = {}, fallback = {}) {
  const value = isPlainObject(input) ? input : {};
  const runtime = String(value.runtime || value.mode || fallback.runtime || 'host').trim().toLowerCase() || 'host';
  const normalizedRuntime = runtime === 'sandbox' ? 'sandbox' : 'host';
  const adapterStartRun = normalizeBoolean(
    value.adapterStartRun,
    fallback.adapterStartRun !== undefined ? fallback.adapterStartRun : normalizedRuntime === 'sandbox'
  );
  const preparedOnly = normalizeBoolean(
    value.preparedOnly,
    fallback.preparedOnly !== undefined ? fallback.preparedOnly : normalizedRuntime !== 'sandbox'
  );
  const reason = clipText(
    value.reason || fallback.reason || (
      normalizedRuntime === 'sandbox'
        ? 'Execution is delegated to the isolation adapter startRun implementation'
        : 'Isolation prepared case resources, then execution continued on the host runtime'
    ),
    240
  );

  return {
    runtime: normalizedRuntime,
    preparedOnly,
    adapterStartRun,
    reason,
  };
}

function normalizeEgressEvidence(input = {}, fallback = {}) {
  const value = isPlainObject(input) ? input : {};
  const mode = String(value.mode || fallback.mode || DEFAULT_EGRESS_MODE).trim().toLowerCase() || DEFAULT_EGRESS_MODE;
  const enforced = normalizeBoolean(value.enforced, fallback.enforced !== undefined ? fallback.enforced : false);
  const fallbackScope = enforced ? 'sandbox' : 'record-only';
  const scope = clipText(
    String(value.scope || fallback.scope || fallbackScope).trim().toLowerCase() || fallbackScope,
    80
  );
  const reason = clipText(
    value.reason || fallback.reason || (
      enforced
        ? 'Network policy is enforced by the isolation adapter'
        : 'Requested egress policy is recorded in evidence but not actively enforced by the current adapter'
    ),
    240
  );

  return {
    mode,
    enforced,
    scope,
    reason,
  };
}

function createPolicyRejectRecorder(sharedRejects) {
  const rejectList = Array.isArray(sharedRejects) ? sharedRejects : [];
  return {
    rejects: rejectList,
    allowedTools: DEFAULT_ALLOWED_BRIDGE_TOOLS,
    record(toolName, reason, details = {}) {
      rejectList.push({
        toolName: normalizeToolName(toolName),
        reason: clipText(reason, 240),
        details: isPlainObject(details) ? details : {},
        createdAt: nowIso(),
      });
    },
  };
}

function seedIsolatedConversationStore(store, input = {}) {
  const agentId = String(input.agentId || 'skill-test-agent').trim() || 'skill-test-agent';
  const agentName = String(input.agentName || 'Skill Test Agent').trim() || 'Skill Test Agent';
  const conversationId = String(input.conversationId || `skill-test-${agentId}`).trim() || `skill-test-${agentId}`;
  const promptUserMessage = input.promptUserMessage && typeof input.promptUserMessage === 'object'
    ? input.promptUserMessage
    : null;

  if (!store.getAgent(agentId)) {
    store.saveAgent({
      id: agentId,
      name: agentName,
      personaPrompt: 'Skill test isolated agent.',
    });
  }

  if (!store.getConversation(conversationId)) {
    store.createConversation({
      id: conversationId,
      title: `Skill Test ${conversationId}`,
      participants: [agentId],
    });
  }

  if (promptUserMessage && promptUserMessage.id && !store.getMessage(promptUserMessage.id)) {
    store.createMessage({
      id: String(promptUserMessage.id).trim(),
      conversationId,
      turnId: String(promptUserMessage.turnId || input.turnId || 'skill-test-turn').trim() || 'skill-test-turn',
      role: 'user',
      senderName: String(promptUserMessage.senderName || 'TestUser').trim() || 'TestUser',
      content: promptUserMessage.content !== undefined ? promptUserMessage.content : '',
      status: String(promptUserMessage.status || 'completed').trim() || 'completed',
      createdAt: String(promptUserMessage.createdAt || nowIso()).trim() || nowIso(),
    });
  }
}

function snapshotSkillIntoAgentDir(skill, agentDir) {
  if (!skill || !skill.path) {
    return null;
  }

  const skillId = String(skill.id || '').trim();
  const sourceSkillDir = path.resolve(String(skill.path || '').trim());
  const skillFilePath = path.join(sourceSkillDir, 'SKILL.md');
  if (!skillId || !fs.existsSync(sourceSkillDir) || !fs.existsSync(skillFilePath)) {
    return null;
  }

  const targetSkillDir = path.join(agentDir, 'skills', skillId);
  copyDirectoryRecursive(sourceSkillDir, targetSkillDir);
  return {
    ...skill,
    path: targetSkillDir,
  };
}

function appendSqlitePollutionTargets(targets, label, sqlitePath) {
  const rawPath = String(sqlitePath || '').trim();
  if (!rawPath || rawPath === ':memory:') {
    return;
  }

  const normalizedPath = resolveSqliteFileUriPath(rawPath) || path.resolve(rawPath);
  if (!normalizedPath || normalizedPath === ':memory:') {
    return;
  }

  targets.push({ label, path: normalizedPath });
  targets.push({ label: `${label}-wal`, path: `${normalizedPath}-wal` });
}

function buildPollutionWatchTargets(input = {}) {
  const targets = [];
  const liveProjectDir = String(input.liveProjectDir || '').trim();
  const liveAgentDir = String(input.liveAgentDir || '').trim();
  const liveDatabasePath = String(input.liveDatabasePath || '').trim();
  const agent = input.agent && typeof input.agent === 'object' ? input.agent : null;
  const skill = input.skill && typeof input.skill === 'object' ? input.skill : null;

  if (liveProjectDir) {
    targets.push({ label: 'live-trellis', path: path.join(liveProjectDir, '.trellis') });
  }

  if (liveAgentDir) {
    targets.push({ label: 'shared-skills-root', path: path.join(liveAgentDir, 'skills') });
  }

  appendSqlitePollutionTargets(targets, 'live-chat-store', liveDatabasePath);

  if (liveAgentDir && agent) {
    targets.push({ label: 'live-agent-private-dir', path: resolveAgentPrivateDir(liveAgentDir, agent) });
  }

  if (skill && skill.path) {
    targets.push({ label: 'target-skill-dir', path: skill.path });
  }

  return targets;
}

function buildLegacyIsolationEvidence(input = {}) {
  return {
    mode: 'legacy-local',
    notIsolated: true,
    publishGate: normalizeBoolean(input.publishGate, false),
    driver: {
      name: 'legacy-local',
      version: '',
    },
    sandboxId: '',
    runId: String(input.runId || '').trim(),
    caseId: String(input.caseId || '').trim(),
    trellisMode: String(input.trellisMode || DEFAULT_TRELLIS_MODE).trim() || DEFAULT_TRELLIS_MODE,
    egressMode: 'host',
    toolPolicy: {
      allowedTools: normalizeAllowedBridgeTools(input.allowedBridgeTools),
      rejects: Array.isArray(input.rejects) ? input.rejects.slice() : [],
    },
    execution: {
      runtime: 'host',
      preparedOnly: false,
      adapterStartRun: false,
      reason: 'Legacy-local mode executes directly on the host runtime',
    },
    egress: {
      mode: 'host',
      enforced: false,
      scope: 'host',
      reason: 'Legacy-local mode does not apply a sandbox network policy',
    },
    resources: {
      projectDir: normalizePathForJson(input.projectDir),
      sandboxDir: normalizePathForJson(input.sandboxDir),
      privateDir: normalizePathForJson(input.privateDir),
      sqlitePath: normalizePathForJson(input.sqlitePath),
      skillPath: input.skill && input.skill.path ? normalizePathForJson(input.skill.path) : '',
    },
    pollutionCheck: {
      checked: false,
      ok: false,
      changeCount: 0,
      changes: [],
    },
    cleanup: {
      ok: true,
      error: '',
    },
    unsafe: false,
    unsafeReasons: ['not_isolated'],
    createdAt: nowIso(),
    finishedAt: nowIso(),
  };
}

function createSkillTestIsolationDriver(options = {}) {
  const createStore = typeof options.createChatAppStore === 'function' ? options.createChatAppStore : createChatAppStore;
  const openSandboxFactory = typeof options.openSandboxFactory === 'function' ? options.openSandboxFactory : null;
  const defaultMode = String(options.defaultMode || (openSandboxFactory ? 'isolated' : DEFAULT_ISOLATION_MODE)).trim().toLowerCase() || DEFAULT_ISOLATION_MODE;

  return {
    normalizeOptions(input = {}) {
      return normalizeSkillTestIsolationOptions(input, {
        driverAvailable: Boolean(openSandboxFactory),
        defaultMode,
        allowLiveTrellis: options.allowLiveTrellis === true,
      });
    },

    async createCaseContext(input = {}) {
      const isolation = normalizeSkillTestIsolationOptions(input.isolation || {}, {
        driverAvailable: Boolean(openSandboxFactory),
        defaultMode,
        allowLiveTrellis: options.allowLiveTrellis === true,
      });
      const agent = input.agent && typeof input.agent === 'object'
        ? input.agent
        : {
            id: String(input.agentId || 'skill-test-agent').trim() || 'skill-test-agent',
            name: String(input.agentName || 'Skill Test Agent').trim() || 'Skill Test Agent',
          };
      const policyRejects = [];
      const toolPolicy = createPolicyRejectRecorder(policyRejects);
      toolPolicy.allowedTools = isolation.allowedBridgeTools.slice();

      if (isolation.mode !== 'isolated') {
        const sandbox = ensureAgentSandbox(String(input.liveAgentDir || '').trim(), agent);
        return {
          isolation,
          store: input.liveStore || null,
          agentDir: String(input.liveAgentDir || '').trim(),
          sqlitePath: String(input.liveDatabasePath || '').trim(),
          sandbox,
          projectDir: String(input.liveProjectDir || '').trim(),
          skill: input.skill || null,
          toolPolicy,
          extraEnv: {},
          startRun: null,
          async finalize() {
            return buildLegacyIsolationEvidence({
              runId: input.runId,
              caseId: input.caseId,
              trellisMode: isolation.trellisMode,
              publishGate: isolation.publishGate,
              allowedBridgeTools: isolation.allowedBridgeTools,
              rejects: policyRejects,
              projectDir: input.liveProjectDir,
              sandboxDir: sandbox.sandboxDir,
              privateDir: sandbox.privateDir,
              sqlitePath: input.liveDatabasePath,
              skill: input.skill,
            });
          },
        };
      }

      const caseRoot = resolveSkillTestCaseRoot(options.caseRootDir);
      const caseAgentDir = path.join(caseRoot, 'agent');
      const caseProjectDir = isolation.trellisMode === 'liveexplicit'
        ? path.resolve(String(input.liveProjectDir || '').trim())
        : path.join(caseRoot, 'project');
      const caseOutputsDir = path.join(caseRoot, 'outputs');
      const caseSqlitePath = path.join(caseRoot, 'store', 'chat.sqlite');
      const pollutionTargets = buildPollutionWatchTargets({
        liveProjectDir: input.liveProjectDir,
        liveAgentDir: input.liveAgentDir,
        liveDatabasePath: input.liveDatabasePath,
        agent,
        skill: input.skill,
      });
      const pollutionBefore = capturePollutionTargets(pollutionTargets);

      ensureDirectory(caseAgentDir);
      ensureDirectory(caseOutputsDir);
      if (isolation.trellisMode !== 'liveexplicit') {
        ensureDirectory(caseProjectDir);
      }
      ensureDirectory(path.dirname(caseSqlitePath));

      const sandbox = ensureAgentSandbox(caseAgentDir, agent);
      const isolatedStore = createStore({ agentDir: caseAgentDir, sqlitePath: caseSqlitePath });
      seedIsolatedConversationStore(isolatedStore, {
        agentId: agent.id,
        agentName: agent.name,
        conversationId: input.conversationId,
        turnId: input.turnId,
        promptUserMessage: input.promptUserMessage,
      });
      const isolatedSkill = snapshotSkillIntoAgentDir(input.skill, caseAgentDir) || input.skill || null;
      const trellisMaterialization = materializeTrellisMode(caseProjectDir, input.liveProjectDir, isolation.trellisMode);
      const adapter = await Promise.resolve(openSandboxFactory({
        driverName: DEFAULT_DRIVER_NAME,
        isolation,
        caseId: String(input.caseId || '').trim(),
        runId: String(input.runId || '').trim(),
        caseRoot,
        agentDir: caseAgentDir,
        projectDir: caseProjectDir,
        sandboxDir: sandbox.sandboxDir,
        privateDir: sandbox.privateDir,
        sqlitePath: caseSqlitePath,
        outputDir: caseOutputsDir,
        skillPath: isolatedSkill && isolatedSkill.path ? isolatedSkill.path : '',
      })) || {};
      const driverName = String(adapter.driverName || DEFAULT_DRIVER_NAME).trim() || DEFAULT_DRIVER_NAME;
      const driverVersion = String(adapter.driverVersion || '').trim();
      const sandboxId = String(adapter.sandboxId || `opensandbox-${nodeCrypto.randomUUID()}`).trim();
      const execution = normalizeExecutionEvidence(adapter.execution, {
        runtime: typeof adapter.startRun === 'function' ? 'sandbox' : 'host',
        preparedOnly: typeof adapter.startRun !== 'function',
        adapterStartRun: typeof adapter.startRun === 'function',
        reason: typeof adapter.startRun === 'function'
          ? 'Execution is delegated to the isolation adapter startRun implementation'
          : 'Isolation adapter prepared case resources, then controller fell back to the host startRun implementation',
      });
      const egress = normalizeEgressEvidence(adapter.egress, {
        mode: isolation.egressMode,
        enforced: false,
        scope: 'record-only',
        reason: 'Requested egress policy is recorded in isolation evidence but not actively enforced by the current adapter',
      });
      const createdAt = nowIso();

      return {
        isolation,
        store: isolatedStore,
        agentDir: caseAgentDir,
        sqlitePath: caseSqlitePath,
        sandbox,
        projectDir: caseProjectDir,
        outputDir: caseOutputsDir,
        skill: isolatedSkill,
        toolPolicy,
        extraEnv: {
          PI_AGENT_SANDBOX_DIR: sandbox.sandboxDir,
          PI_AGENT_PRIVATE_DIR: sandbox.privateDir,
          PI_SQLITE_PATH: caseSqlitePath,
          CAFF_TRELLIS_PROJECT_DIR: caseProjectDir,
          CAFF_SKILL_TEST_CASE_ROOT: caseRoot,
          CAFF_SKILL_TEST_OUTPUT_DIR: caseOutputsDir,
          CAFF_SKILL_TEST_ISOLATION_MODE: isolation.mode,
          CAFF_SKILL_TEST_TRELLIS_MODE: isolation.trellisMode,
          CAFF_SKILL_TEST_EGRESS_MODE: isolation.egressMode,
          ...(isolatedSkill && isolatedSkill.path ? { CAFF_SKILL_TEST_SKILL_PATH: normalizePathForJson(path.join(isolatedSkill.path, 'SKILL.md')) } : {}),
          ...(isPlainObject(adapter.extraEnv) ? adapter.extraEnv : {}),
        },
        startRun: typeof adapter.startRun === 'function' ? adapter.startRun : null,
        async finalize() {
          const finishedAt = nowIso();
          const pollutionAfter = capturePollutionTargets(pollutionTargets);
          const pollutionCheck = comparePollutionTargets(pollutionBefore, pollutionAfter);
          let cleanupError = '';

          try {
            if (isolatedStore && typeof isolatedStore.close === 'function') {
              isolatedStore.close();
            }
          } catch (error) {
            cleanupError = clipText(error && error.message ? error.message : String(error || 'Failed to close isolated store'), 300);
          }

          try {
            if (adapter && typeof adapter.cleanup === 'function') {
              await Promise.resolve(adapter.cleanup());
            }
          } catch (error) {
            cleanupError = cleanupError || clipText(error && error.message ? error.message : String(error || 'Failed to cleanup sandbox driver'), 300);
          }

          try {
            fs.rmSync(caseRoot, { recursive: true, force: true });
          } catch (error) {
            cleanupError = cleanupError || clipText(error && error.message ? error.message : String(error || 'Failed to cleanup case root'), 300);
          }

          const unsafeReasons = [];
          if (!pollutionCheck.ok) {
            unsafeReasons.push('pollution_check_failed');
          }
          if (isolation.publishGate && execution.runtime !== 'sandbox') {
            unsafeReasons.push('execution_not_sandboxed');
          }
          if (isolation.publishGate && isolation.egressMode === 'deny' && egress.enforced !== true) {
            unsafeReasons.push('egress_not_enforced');
          }
          if (cleanupError) {
            unsafeReasons.push('cleanup_failed');
          }

          return {
            mode: isolation.mode,
            notIsolated: false,
            publishGate: isolation.publishGate,
            driver: {
              name: driverName,
              version: driverVersion,
            },
            sandboxId,
            runId: String(input.runId || '').trim(),
            caseId: String(input.caseId || '').trim(),
            trellisMode: isolation.trellisMode,
            egressMode: isolation.egressMode,
            toolPolicy: {
              allowedTools: isolation.allowedBridgeTools.slice(),
              rejects: policyRejects.slice(),
            },
            execution,
            egress,
            resources: {
              caseRoot: normalizePathForJson(caseRoot),
              projectDir: normalizePathForJson(caseProjectDir),
              sandboxDir: normalizePathForJson(sandbox.sandboxDir),
              privateDir: normalizePathForJson(sandbox.privateDir),
              outputDir: normalizePathForJson(caseOutputsDir),
              sqlitePath: normalizePathForJson(caseSqlitePath),
              skillPath: isolatedSkill && isolatedSkill.path ? normalizePathForJson(isolatedSkill.path) : '',
              trellisFilesCopied: trellisMaterialization.copiedFiles,
              ...(isPlainObject(adapter && adapter.resources) ? adapter.resources : {}),
            },
            pollutionCheck,
            cleanup: {
              ok: !cleanupError,
              error: cleanupError,
            },
            unsafe: unsafeReasons.length > 0,
            unsafeReasons,
            createdAt,
            finishedAt,
          };
        },
      };
    },
  };
}

function buildSkillTestIsolationIssues(isolationEvidence) {
  if (!isolationEvidence || typeof isolationEvidence !== 'object') {
    return [];
  }

  const issues = [];

  if (isolationEvidence.notIsolated) {
    issues.push({
      code: 'skill_test_not_isolated',
      severity: 'warning',
      path: 'isolation',
      message: 'Run used legacy-local mode and cannot serve as isolated publish-gate evidence',
    });
  }

  if (Array.isArray(isolationEvidence.toolPolicy && isolationEvidence.toolPolicy.rejects) && isolationEvidence.toolPolicy.rejects.length > 0) {
    issues.push({
      code: 'skill_test_policy_rejects_present',
      severity: 'warning',
      path: 'isolation.toolPolicy.rejects',
      message: `Tool policy rejected ${isolationEvidence.toolPolicy.rejects.length} request(s) during the run`,
    });
  }

  if (isolationEvidence.mode === 'isolated' && isolationEvidence.execution && isolationEvidence.execution.runtime !== 'sandbox') {
    issues.push({
      code: 'skill_test_execution_not_sandboxed',
      severity: isolationEvidence.publishGate ? 'error' : 'warning',
      path: 'isolation.execution',
      message: clipText(isolationEvidence.execution.reason || 'Run executed on the host runtime instead of inside the isolation backend', 240),
    });
  }

  if (isolationEvidence.mode === 'isolated' && isolationEvidence.egress && isolationEvidence.egress.mode === 'deny' && isolationEvidence.egress.enforced !== true) {
    issues.push({
      code: 'skill_test_egress_not_enforced',
      severity: isolationEvidence.publishGate ? 'error' : 'warning',
      path: 'isolation.egress',
      message: clipText(isolationEvidence.egress.reason || 'Run requested deny egress mode without an enforced network policy', 240),
    });
  }

  if (isolationEvidence.pollutionCheck && isolationEvidence.pollutionCheck.checked && isolationEvidence.pollutionCheck.ok === false) {
    issues.push({
      code: 'skill_test_pollution_detected',
      severity: 'error',
      path: 'isolation.pollutionCheck',
      message: 'Live project or shared state changed during an isolated skill test run',
    });
  }

  if (isolationEvidence.cleanup && isolationEvidence.cleanup.ok === false) {
    issues.push({
      code: 'skill_test_cleanup_failed',
      severity: 'error',
      path: 'isolation.cleanup',
      message: clipText(isolationEvidence.cleanup.error || 'Isolated skill test cleanup failed', 240),
    });
  }

  return issues;
}

function getSkillTestIsolationFailureMessage(isolationEvidence) {
  if (!isolationEvidence || typeof isolationEvidence !== 'object') {
    return 'Skill test isolation failed';
  }

  const unsafeReasons = Array.isArray(isolationEvidence.unsafeReasons) ? isolationEvidence.unsafeReasons : [];

  if (unsafeReasons.includes('execution_not_sandboxed')) {
    return 'Skill test publish-gate requires sandbox execution, but the run executed on the host runtime';
  }

  if (unsafeReasons.includes('egress_not_enforced')) {
    return 'Skill test publish-gate requires enforced deny-egress policy, but the current adapter only recorded the request';
  }

  if (isolationEvidence.pollutionCheck && isolationEvidence.pollutionCheck.ok === false) {
    return 'Skill test isolation detected live-state pollution';
  }

  if (isolationEvidence.cleanup && isolationEvidence.cleanup.ok === false) {
    return `Skill test isolation cleanup failed: ${clipText(isolationEvidence.cleanup.error || 'unknown error', 200)}`;
  }

  return 'Skill test isolation failed';
}

export {
  DEFAULT_ALLOWED_BRIDGE_TOOLS,
  buildSkillTestIsolationIssues,
  createSkillTestIsolationDriver,
  getSkillTestIsolationFailureMessage,
  normalizeSkillTestIsolationOptions,
};
