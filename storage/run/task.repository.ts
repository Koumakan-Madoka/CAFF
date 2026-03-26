const TASK_UPDATE_COLUMN_MAP: Record<string, string> = {
  parentTaskId: 'parent_task_id',
  parentRunId: 'parent_run_id',
  runId: 'run_id',
  kind: 'kind',
  title: 'title',
  status: 'status',
  assignedAgent: 'assigned_agent',
  assignedRole: 'assigned_role',
  provider: 'provider',
  model: 'model',
  requestedSession: 'requested_session',
  sessionPath: 'session_path',
  inputText: 'input_text',
  outputText: 'output_text',
  errorMessage: 'error_message',
  metadataJson: 'metadata_json',
  artifactSummaryJson: 'artifact_summary_json',
  startedAt: 'started_at',
  endedAt: 'ended_at',
};

function nowIso() {
  return new Date().toISOString();
}

export class RunTaskRepository {
  db: any;
  insertTaskStatement: any;
  insertEventStatement: any;
  insertArtifactStatement: any;
  getTaskStatement: any;
  listByParentStatement: any;
  listEventsStatement: any;

  constructor(db: any) {
    this.db = db;
    this.insertTaskStatement = db.prepare(`
      INSERT INTO a2a_tasks (
        id,
        parent_task_id,
        parent_run_id,
        run_id,
        kind,
        title,
        status,
        assigned_agent,
        assigned_role,
        provider,
        model,
        requested_session,
        session_path,
        input_text,
        output_text,
        error_message,
        metadata_json,
        artifact_summary_json,
        created_at,
        updated_at,
        started_at,
        ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertEventStatement = db.prepare(`
      INSERT INTO a2a_task_events (
        task_id,
        event_type,
        event_json,
        created_at
      ) VALUES (?, ?, ?, ?)
    `);
    this.insertArtifactStatement = db.prepare(`
      INSERT INTO a2a_artifacts (
        task_id,
        kind,
        name,
        mime_type,
        content_text,
        uri,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getTaskStatement = db.prepare(`
      SELECT *
      FROM a2a_tasks
      WHERE id = ?
      LIMIT 1
    `);
    this.listByParentStatement = db.prepare(`
      SELECT *
      FROM a2a_tasks
      WHERE parent_task_id IS ?
      ORDER BY created_at ASC, id ASC
    `);
    this.listEventsStatement = db.prepare(`
      SELECT *
      FROM a2a_task_events
      WHERE task_id = ?
      ORDER BY created_at ASC, id ASC
    `);
  }

  create(payload: any) {
    this.insertTaskStatement.run(
      payload.taskId,
      payload.parentTaskId || null,
      payload.parentRunId || null,
      payload.runId || null,
      payload.kind || 'task',
      payload.title || null,
      payload.status || 'queued',
      payload.assignedAgent || null,
      payload.assignedRole || null,
      payload.provider || null,
      payload.model || null,
      payload.requestedSession || null,
      payload.sessionPath || null,
      payload.inputText || null,
      payload.outputText || null,
      payload.errorMessage || null,
      payload.metadataJson,
      payload.artifactSummaryJson,
      payload.createdAt,
      payload.updatedAt,
      payload.startedAt || null,
      payload.endedAt || null
    );

    return this.get(payload.taskId);
  }

  update(taskId: string, updates: Record<string, any> = {}) {
    const assignments: string[] = [];
    const values: any[] = [];

    for (const [key, columnName] of Object.entries(TASK_UPDATE_COLUMN_MAP)) {
      if (!Object.prototype.hasOwnProperty.call(updates, key)) {
        continue;
      }

      assignments.push(`${columnName} = ?`);
      values.push(updates[key]);
    }

    assignments.push('updated_at = ?');
    values.push(nowIso(), taskId);

    const statement = this.db.prepare(`
      UPDATE a2a_tasks
      SET ${assignments.join(', ')}
      WHERE id = ?
    `);

    statement.run(...values);
    return this.get(taskId);
  }

  appendEvent(taskId: string, eventType: string, eventJson: string | null, createdAt: string) {
    this.insertEventStatement.run(taskId, eventType, eventJson, createdAt);
  }

  addArtifact(taskId: string, payload: any) {
    this.insertArtifactStatement.run(
      taskId,
      payload.kind || 'text',
      payload.name || null,
      payload.mimeType || null,
      payload.contentText || null,
      payload.uri || null,
      payload.metadataJson,
      payload.createdAt
    );
  }

  get(taskId: string) {
    return this.getTaskStatement.get(taskId);
  }

  listByParent(parentTaskId: string | null = null) {
    return this.listByParentStatement.all(parentTaskId);
  }

  listEvents(taskId: string) {
    return this.listEventsStatement.all(taskId);
  }
}

export function createRunTaskRepository(db: any) {
  return new RunTaskRepository(db);
}
