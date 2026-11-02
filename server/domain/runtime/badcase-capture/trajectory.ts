import { containsSecretSentinel } from './secrets';

// Read-only, INTERNAL source adapter for future sealing. Not Inspector output,
// not a replay input and not a complete trajectory. No paths are opened and no
// blobs are written here. Call only from an authorized sealing orchestration.
const fail = (code: string) => Object.assign(new Error(code), { code });
const keys = ['projectId', 'conversationId', 'messageId', 'turnId', 'agentId', 'taskId', 'checkpointId', 'runId'];
const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
const terminalMessage = ['completed', 'failed', 'cancelled', 'interrupted'];
const terminalExecution = ['succeeded', 'completed', 'failed', 'cancelled', 'interrupted', 'timed_out'];
const eventTypes = "('agent_tool_call', 'agent_reply_terminating')";
export const trajectoryFailureCodes = Object.freeze(['trajectory_invalid_input', 'trajectory_association_mismatch', 'trajectory_not_terminal',
  'trajectory_private_content', 'trajectory_sensitive_content', 'trajectory_invalid_source', 'trajectory_limit_exceeded',
  'trajectory_trigger_unverified', 'trajectory_unavailable']);
const knownCodes = new Set(trajectoryFailureCodes);

function parse(value: any) {
  if (typeof value !== 'string') throw fail('trajectory_invalid_source');
  try { return JSON.parse(value); } catch { throw fail('trajectory_invalid_source'); }
}
function metadata(value: any) {
  const parsed = parse(value);
  if (!object(parsed)) throw fail('trajectory_invalid_source');
  return parsed;
}
function privateMetadata(value: any) {
  if (value.privateOnly === true || value.visibility === 'private' || value.role === 'private') throw fail('trajectory_private_content');
}

// Reject whole evidence, never redact or persist it then try to scrub. This is
// a conservative known-pattern filter, NOT a proof that arbitrary prose lacks
// credentials/private information. The caller must retain that limitation.
function checkContent(value: any, depth = 0): void {
  if (depth > 64) throw fail('trajectory_limit_exceeded');
  if (typeof value === 'string') {
    if (value.includes('\0') || containsSecretSentinel(value)
      || /\b(?:bearer\s+\S+|(?:authorization|cookie|password|passwd|secret|api[_-]?key|[A-Z_]*TOKEN)\s*["']?\s*[:=]\s*["']?\S+)/iu.test(value)) {
      throw fail('trajectory_sensitive_content');
    }
    // JSON nested in tool output can otherwise hide a short credential value
    // behind escaped quotes. Decode and inspect without rewriting good input.
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let nested;
      try { nested = JSON.parse(trimmed); } catch { return; }
      checkContent(nested, depth + 1);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) checkContent(entry, depth + 1);
  } else if (object(value)) {
    privateMetadata(value);
    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (/(password|passwd|secret|authorization|cookie|apikey|accesstoken|authtoken|callbacktoken|credential)/.test(normalized)
        || normalized === 'token') {
        if (entry !== null && entry !== '') throw fail('trajectory_sensitive_content');
      }
      if (['tool', 'toolName', 'name'].includes(key) && ['send-private', 'read-context', 'send_private', 'read_context'].includes(String(entry))) {
        throw fail('trajectory_private_content');
      }
      checkContent(key, depth + 1);
      checkContent(entry, depth + 1);
    }
  }
}

// Shared with the process boundary so malformed requests never open a DB.
export function validateTrajectoryRequest(options: any) {
  const input = options?.association;
  if (!object(input) || Object.keys(input).some(key => !keys.includes(key))
    || keys.some(key => key === 'runId' ? !Number.isSafeInteger(input[key]) || input[key] <= 0
      : typeof input[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input[key]))) throw fail('trajectory_invalid_input');
  const association = { ...input };
  const limits = options?.limits || {};
  const maxEvents = limits.maxEvents ?? 10000, maxBytes = limits.maxBytes ?? 4 * 1024 * 1024;
  if (!object(limits) || Object.keys(limits).some(key => !['maxEvents', 'maxBytes'].includes(key))
    || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) throw fail('trajectory_invalid_input');
  return { association, limits: { maxEvents, maxBytes } };
}

export function readBadcaseTrajectory(options: any) {
  const { association, limits: { maxEvents, maxBytes } } = validateTrajectoryRequest(options);
  const db = options?.db;
  try {
    // A single SQLite read transaction pins DB reads, not files, the running
    // agent or the environment. Do not promote it to strict-eval consistency.
    return db.transaction(() => {
      const get = (sql: string, params: any) => db.prepare(sql).get(params);
      const conversation = get('SELECT project_scope_id FROM chat_conversations WHERE id=@conversationId', { conversationId: association.conversationId });
      const messageParams = { messageId: association.messageId };
      const messageSize = get('SELECT length(CAST(metadata_json AS BLOB)) AS bytes FROM chat_messages WHERE id=@messageId', messageParams);
      if (messageSize?.bytes > 65536) throw fail('trajectory_limit_exceeded');
      const message = get(`SELECT conversation_id, turn_id, agent_id, task_id, run_id, role, status, metadata_json
        FROM chat_messages WHERE id=@messageId`, messageParams);
      if (!conversation || conversation.project_scope_id !== association.projectId || !message
        || message.conversation_id !== association.conversationId || message.turn_id !== association.turnId
        || message.agent_id !== association.agentId || message.task_id !== association.taskId || message.run_id !== association.runId
        || message.role !== 'assistant') throw fail('trajectory_association_mismatch');
      const messageMeta = metadata(message.metadata_json);
      privateMetadata(messageMeta);
      if (messageMeta.badcaseCheckpointId !== association.checkpointId) throw fail('trajectory_association_mismatch');
      if (!terminalMessage.includes(message.status)) throw fail('trajectory_not_terminal');

      const taskParams = { taskId: association.taskId }, runParams = { runId: association.runId };
      // Byte preflight is in SQLite, before transferring arbitrarily large text
      // to JS. All subsequent reads share the same database snapshot.
      const taskSizes = get(`SELECT length(CAST(metadata_json AS BLOB)) AS metadataBytes,
        coalesce(length(CAST(output_text AS BLOB)),0) + coalesce(length(CAST(error_message AS BLOB)),0) AS bytes
        FROM a2a_tasks WHERE id=@taskId`, taskParams);
      const runSizes = get('SELECT coalesce(length(CAST(assistant_errors_json AS BLOB)),0) AS bytes FROM runs WHERE id=@runId', runParams);
      if (!taskSizes || !runSizes) throw fail('trajectory_association_mismatch');
      if (taskSizes.metadataBytes > 65536 || taskSizes.bytes + runSizes.bytes > maxBytes) throw fail('trajectory_limit_exceeded');
      const task = get('SELECT id, run_id, kind, status, metadata_json, output_text, error_message FROM a2a_tasks WHERE id=@taskId', taskParams);
      const run = get('SELECT id, task_id, status, assistant_errors_json FROM runs WHERE id=@runId', runParams);
      const taskMeta = metadata(task.metadata_json);
      privateMetadata(taskMeta);
      if (task.run_id !== association.runId || task.kind !== 'conversation_agent_reply' || run.task_id !== association.taskId
        || ['conversationId', 'turnId', 'agentId'].some(key => taskMeta[key] !== association[key])) throw fail('trajectory_association_mismatch');
      if (!terminalExecution.includes(task.status) || !terminalExecution.includes(run.status)) throw fail('trajectory_not_terminal');
      // Do not follow session paths or context lineage. Verify only the direct
      // triggering message; more distant private ancestry remains unproven.
      if (taskMeta.triggeredByMessageId) {
        if (typeof taskMeta.triggeredByMessageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(taskMeta.triggeredByMessageId)) throw fail('trajectory_trigger_unverified');
        const params = { messageId: taskMeta.triggeredByMessageId };
        const size = get('SELECT length(CAST(metadata_json AS BLOB)) AS bytes FROM chat_messages WHERE id=@messageId', params);
        if (!size || size.bytes > 65536) throw fail('trajectory_trigger_unverified');
        const trigger = get('SELECT conversation_id, role, metadata_json FROM chat_messages WHERE id=@messageId', params);
        if (!trigger || trigger.conversation_id !== association.conversationId) throw fail('trajectory_trigger_unverified');
        if (trigger.role === 'private') throw fail('trajectory_private_content');
        privateMetadata(metadata(trigger.metadata_json));
      }
      const stats = get(`SELECT count(*) AS total,
        sum(CASE WHEN event_type IN ${eventTypes} THEN 1 ELSE 0 END) AS selected,
        sum(CASE WHEN event_type IN ${eventTypes} THEN coalesce(length(CAST(event_json AS BLOB)),0)
          + length(CAST(event_type AS BLOB)) + length(CAST(created_at AS BLOB)) ELSE 0 END) AS bytes
        FROM a2a_task_events WHERE task_id=@taskId`, taskParams);
      if (stats.selected > maxEvents || Number(stats.bytes || 0) + taskSizes.bytes + runSizes.bytes > maxBytes) throw fail('trajectory_limit_exceeded');
      const rows = db.prepare(`SELECT id, event_type, event_json, created_at FROM a2a_task_events
        WHERE task_id=@taskId AND event_type IN ${eventTypes} ORDER BY id ASC LIMIT @limit`)
        .all({ ...taskParams, limit: maxEvents + 1 });
      if (rows.length !== Number(stats.selected || 0) || rows.length > maxEvents) throw fail('trajectory_invalid_source');
      const events = rows.map((row: any) => {
        const payload = metadata(row.event_json);
        // Event attribution, when present, cannot contradict the frozen source.
        if (payload.assistantMessageId && payload.assistantMessageId !== association.messageId
          || ['conversationId', 'turnId', 'agentId'].some(key => payload[key] && payload[key] !== association[key])) throw fail('trajectory_association_mismatch');
        return { id: row.id, type: row.event_type, createdAt: row.created_at, payload };
      });
      const result = {
        schemaVersion: 1, kind: 'badcase-database-trajectory', association,
        databaseConsistent: true, complete: false, strictEvalEligible: false,
        contentPolicy: 'reject_known_sensitive_and_private_markers',
        incompleteReasons: ['post_turn_session_not_archived', 'context_snapshot_not_archived', 'usage_not_archived',
          'timeline_not_archived', 'attachments_not_archived', 'private_ancestry_not_verified', 'no_independent_consistency_evidence',
          ...(stats.total > rows.length ? ['other_task_events_not_archived'] : [])],
        task: { id: task.id, runId: task.run_id, status: task.status, output: task.output_text, error: task.error_message },
        run: { id: run.id, taskId: run.task_id, status: run.status, assistantErrors: run.assistant_errors_json === null ? null : parse(run.assistant_errors_json) },
        totalTaskEventCount: stats.total, archivedEventCount: rows.length, events,
      };
      // Only inspect fields actually returned. Task metadata/session paths and
      // run prompt are deliberately not part of this bounded DB evidence.
      checkContent({ task: result.task, run: result.run, events: result.events });
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) throw fail('trajectory_limit_exceeded');
      return result;
    })();
  } catch (failure: any) {
    if (knownCodes.has(failure?.code)) throw fail(failure.code);
    throw fail('trajectory_unavailable');
  }
}
