const path = require('node:path');
const { openSqliteDatabase, resolveSqlitePath } = require('../storage/sqlite/connection');
const { migrateRunSchema } = require('../storage/sqlite/migrations');
const { createRunSessionRepository } = require('../storage/run/session.repository');
const { createRunRepository } = require('../storage/run/run.repository');
const { createRunTaskRepository } = require('../storage/run/task.repository');

function nowIso() {
  return new Date().toISOString();
}

function deriveSessionName(sessionPath: any, agentDir: any) {
  if (!sessionPath) {
    return '';
  }

  const normalizedSessionPath = path.resolve(sessionPath);
  const namedSessionDir = path.resolve(agentDir, 'named-sessions');
  const sessionDir = path.dirname(normalizedSessionPath);

  if (sessionDir !== namedSessionDir) {
    return '';
  }

  if (!normalizedSessionPath.endsWith('.jsonl')) {
    return path.basename(normalizedSessionPath);
  }

  return path.basename(normalizedSessionPath, '.jsonl');
}

function serializeJson(value: any) {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value === undefined ? null : value);
}

function parseJson(value: any) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeSessionPath(sessionPath: any) {
  if (!sessionPath) {
    return null;
  }

  return path.resolve(sessionPath);
}

/**
 * @param {Record<string, any>} [updates]
 */
function normalizeTaskUpdates(updates: any = {}) {
  const normalized = { ...updates };

  if (Object.prototype.hasOwnProperty.call(normalized, 'sessionPath')) {
    normalized.sessionPath = normalizeSessionPath(normalized.sessionPath);
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'metadata')) {
    normalized.metadataJson = serializeJson(normalized.metadata);
    delete normalized.metadata;
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'artifactSummary')) {
    normalized.artifactSummaryJson = serializeJson(normalized.artifactSummary);
    delete normalized.artifactSummary;
  }

  return normalized;
}

function normalizeTaskRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    metadata: parseJson(row.metadata_json),
    artifactSummary: parseJson(row.artifact_summary_json),
  };
}

export class SqliteRunStore {
  [key: string]: any;
  constructor({ agentDir, sqlitePath }: any) {
    const connection = openSqliteDatabase({ agentDir, sqlitePath });

    this.agentDir = connection.agentDir;
    this.databasePath = connection.databasePath;
    this.db = connection.db;

    migrateRunSchema(this.db);

    this.sessionRepository = createRunSessionRepository(this.db);
    this.runRepository = createRunRepository(this.db);
    this.taskRepository = createRunTaskRepository(this.db);
  }

  ensureSession(sessionPath: any) {
    if (!sessionPath) {
      return null;
    }

    const timestamp = nowIso();
    const normalizedSessionPath = path.resolve(sessionPath);

    return this.sessionRepository.ensure({
      agentDir: this.agentDir,
      sessionPath: normalizedSessionPath,
      sessionName: deriveSessionName(normalizedSessionPath, this.agentDir),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  startRun({
    sessionPath,
    requestedSession,
    requestedResume,
    provider,
    model,
    thinking,
    prompt,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    terminateGraceMs,
    cwd,
    parentRunId,
    taskId,
    taskKind,
    taskRole,
    metadata,
  }: any) {
    const sessionId = this.ensureSession(sessionPath);
    const normalizedSessionPath = normalizeSessionPath(sessionPath);
    const startedAt = nowIso();
    const runId = this.runRepository.create({
      sessionId,
      sessionPath: normalizedSessionPath,
      requestedSession: requestedSession || null,
      requestedResume: requestedResume ? 1 : 0,
      agentDir: this.agentDir,
      cwd,
      provider: provider || null,
      model: model || null,
      thinking: thinking || null,
      prompt,
      promptLength: prompt.length,
      timeoutMs: null,
      idleTimeoutMs: null,
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      terminateGraceMs,
      parentRunId: parentRunId || null,
      taskId: taskId || null,
      taskKind: taskKind || null,
      taskRole: taskRole || null,
      runMetadataJson: serializeJson(metadata),
      status: 'running',
      startedAt,
    });

    if (sessionId) {
      this.sessionRepository.touch(sessionId, {
        lastRunId: runId,
        updatedAt: nowIso(),
      });
    }

    return {
      runId,
      sessionId,
      databasePath: this.databasePath,
    };
  }

  finishRun(runId: any, result: any) {
    if (!runId) {
      return;
    }

    const assistantErrors = Array.isArray(result.assistantErrors) ? result.assistantErrors : [];

    this.runRepository.finish(runId, {
      status: result.status,
      endedAt: nowIso(),
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      terminationType: result.terminationType ?? null,
      terminationSignal: result.terminationSignal ?? null,
      errorMessage: result.errorMessage ?? null,
      reply: result.reply ?? null,
      replyLength: typeof result.reply === 'string' ? result.reply.length : 0,
      stderrTail: result.stderrTail ?? null,
      parseErrors: result.parseErrors || 0,
      assistantErrorsJson: JSON.stringify(assistantErrors),
    });
  }

  createTask(task: any) {
    const {
      taskId,
      parentTaskId,
      parentRunId,
      runId,
      kind,
      title,
      status,
      assignedAgent,
      assignedRole,
      provider,
      model,
      requestedSession,
      sessionPath,
      inputText,
      outputText,
      errorMessage,
      metadata,
      artifactSummary,
      startedAt,
      endedAt,
    } = task || {};
    const createdAt = nowIso();

    return normalizeTaskRow(
      this.taskRepository.create({
        taskId,
        parentTaskId,
        parentRunId,
        runId,
        kind,
        title,
        status,
        assignedAgent,
        assignedRole,
        provider,
        model,
        requestedSession,
        sessionPath: normalizeSessionPath(sessionPath),
        inputText,
        outputText,
        errorMessage,
        metadataJson: serializeJson(metadata),
        artifactSummaryJson: serializeJson(artifactSummary),
        createdAt,
        updatedAt: createdAt,
        startedAt: startedAt || null,
        endedAt: endedAt || null,
      })
    );
  }

  updateTask(taskId: any, updates: any = {}) {
    return normalizeTaskRow(this.taskRepository.update(taskId, normalizeTaskUpdates(updates)));
  }

  appendTaskEvent(taskId: any, eventType: any, payload: any) {
    this.taskRepository.appendEvent(taskId, eventType, serializeJson(payload), nowIso());
  }

  addArtifact(taskId: any, artifact: any = {}) {
    this.taskRepository.addArtifact(taskId, {
      kind: artifact.kind || 'text',
      name: artifact.name || null,
      mimeType: artifact.mimeType || null,
      contentText: artifact.contentText || null,
      uri: artifact.uri || null,
      metadataJson: serializeJson(artifact.metadata),
      createdAt: nowIso(),
    });
  }

  getTask(taskId: any) {
    return normalizeTaskRow(this.taskRepository.get(taskId));
  }

  listTasksByParent(parentTaskId: any = null) {
    return this.taskRepository.listByParent(parentTaskId).map(normalizeTaskRow);
  }

  listTaskEvents(taskId: any) {
    return this.taskRepository.listEvents(taskId).map((row: any) => ({
      ...row,
      payload: parseJson(row.event_json),
    }));
  }

  close() {
    this.db.close();
  }
}

export function createSqliteRunStore(options: any) {
  return new SqliteRunStore(options);
}

export { resolveSqlitePath };
