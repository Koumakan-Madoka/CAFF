// Turn time breakdown persistence (contract
// docs/engineering/backend/turn-time-breakdown.md §7). Three tables:
// per-step classification rows, per-message live summaries, and the JEV
// classification cache. Rows are plain snake_case sqlite records; the JEV
// cache accessors translate to the camelCase entry shape the §6 adapter
// contract promises ({category, subcategory, runKind, confidence}).

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value: any) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

export class TurnTimeBreakdownRepository {
  db: any;
  upsertStepStatement: any;
  listStepsStatement: any;
  getOpenStepByCallIdStatement: any;
  getStepStatement: any;
  getSummaryStatement: any;
  upsertSummaryStatement: any;
  getJevCacheStatement: any;
  setJevCacheStatement: any;
  countJevCacheStatement: any;
  clearJevCacheStatement: any;

  constructor(db: any) {
    this.db = db;
    this.upsertStepStatement = db.prepare(`
      INSERT INTO chat_turn_time_steps (
        task_id, message_id, step_key, tool_name, category, subcategory,
        classified_by, jev_status, confidence, started_at, ended_at,
        duration_ms, run_kind, run_failed, run_count_full, run_count_targeted,
        write_scope, payload_json, created_at, updated_at
      ) VALUES (
        @taskId, @messageId, @stepKey, @toolName, @category, @subcategory,
        @classifiedBy, @jevStatus, @confidence, @startedAt, @endedAt,
        @durationMs, @runKind, @runFailed, @runCountFull, @runCountTargeted,
        @writeScope, @payloadJson, @createdAt, @updatedAt
      )
      ON CONFLICT(task_id, step_key) DO UPDATE SET
        message_id = excluded.message_id,
        tool_name = excluded.tool_name,
        category = excluded.category,
        subcategory = excluded.subcategory,
        classified_by = excluded.classified_by,
        jev_status = excluded.jev_status,
        confidence = excluded.confidence,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        duration_ms = excluded.duration_ms,
        run_kind = excluded.run_kind,
        run_failed = excluded.run_failed,
        run_count_full = excluded.run_count_full,
        run_count_targeted = excluded.run_count_targeted,
        -- Sparse writes (JEV resolution, timing refresh, §4 orphan merge)
        -- must not wash a stored scope back to NULL ≈ repo; only an
        -- explicit scope overwrites, same guard as payload_json.
        write_scope = COALESCE(excluded.write_scope, chat_turn_time_steps.write_scope),
        payload_json = COALESCE(excluded.payload_json, chat_turn_time_steps.payload_json),
        updated_at = excluded.updated_at
    `);
    this.listStepsStatement = db.prepare(`
      SELECT *
      FROM chat_turn_time_steps
      WHERE task_id = ?
      ORDER BY started_at ASC, id ASC
    `);
    this.getOpenStepByCallIdStatement = db.prepare(`
      SELECT *
      FROM chat_turn_time_steps
      WHERE task_id = ? AND step_key = ? AND ended_at IS NULL
      LIMIT 1
    `);
    this.getStepStatement = db.prepare(`
      SELECT *
      FROM chat_turn_time_steps
      WHERE task_id = ? AND step_key = ?
      LIMIT 1
    `);
    this.getSummaryStatement = db.prepare(`
      SELECT *
      FROM chat_turn_time_summaries
      WHERE message_id = ?
      LIMIT 1
    `);
    this.upsertSummaryStatement = db.prepare(`
      INSERT INTO chat_turn_time_summaries (
        message_id, task_id, conversation_id, status,
        turn_started_at, turn_ended_at, category_ms_json, metrics_json,
        parse_offset, assistant_count, computed_at
      ) VALUES (
        @messageId, @taskId, @conversationId, @status,
        @turnStartedAt, @turnEndedAt, @categoryMsJson, @metricsJson,
        @parseOffset, @assistantCount, @computedAt
      )
      ON CONFLICT(message_id) DO UPDATE SET
        task_id = excluded.task_id,
        conversation_id = excluded.conversation_id,
        status = excluded.status,
        turn_started_at = excluded.turn_started_at,
        turn_ended_at = excluded.turn_ended_at,
        category_ms_json = excluded.category_ms_json,
        metrics_json = excluded.metrics_json,
        parse_offset = excluded.parse_offset,
        assistant_count = excluded.assistant_count,
        computed_at = excluded.computed_at
    `);
    this.getJevCacheStatement = db.prepare(`
      SELECT category, subcategory, run_kind, confidence
      FROM jev_classification_cache
      WHERE cache_key = ?
      LIMIT 1
    `);
    this.setJevCacheStatement = db.prepare(`
      INSERT INTO jev_classification_cache (
        cache_key, category, subcategory, run_kind, confidence, created_at
      ) VALUES (
        @cacheKey, @category, @subcategory, @runKind, @confidence, @createdAt
      )
      ON CONFLICT(cache_key) DO UPDATE SET
        category = excluded.category,
        subcategory = excluded.subcategory,
        run_kind = excluded.run_kind,
        confidence = excluded.confidence
    `);
    this.countJevCacheStatement = db.prepare(`
      SELECT count(*) AS entry_count
      FROM jev_classification_cache
    `);
    this.clearJevCacheStatement = db.prepare(`
      DELETE FROM jev_classification_cache
    `);
  }

  // Upserts one classified step. Missing optional fields normalize to null so
  // a later, richer write (session backfill timing, JEV resolution) fully
  // replaces a sparse live row.
  upsertStep(step: any) {
    const now = nowIso();
    const runCounts = step && step.testRunCounts && typeof step.testRunCounts === 'object'
      ? step.testRunCounts
      : null;

    this.upsertStepStatement.run({
      taskId: String(step.taskId),
      messageId: step.messageId ? String(step.messageId) : null,
      stepKey: String(step.stepKey),
      toolName: String(step.toolName || 'tool'),
      category: String(step.category),
      subcategory: step.subcategory ? String(step.subcategory) : null,
      classifiedBy: String(step.classifiedBy),
      jevStatus: step.jevStatus ? String(step.jevStatus) : null,
      confidence: Number.isFinite(step.confidence) ? step.confidence : null,
      startedAt: step.startedAt ? String(step.startedAt) : now,
      endedAt: step.endedAt ? String(step.endedAt) : null,
      durationMs: Number.isFinite(step.durationMs) ? Math.max(0, Math.round(step.durationMs)) : null,
      runKind: step.runKind ? String(step.runKind) : null,
      runFailed: step.runFailed === true ? 1 : step.runFailed === false ? 0 : null,
      runCountFull: runCounts && Number.isFinite(runCounts.full) ? runCounts.full : null,
      runCountTargeted: runCounts && Number.isFinite(runCounts.targeted) ? runCounts.targeted : null,
      // §5 write scope must survive the storage round-trip: firstWriteMs
      // (§2) counts only repo-scope writes, so a dropped scope would
      // silently count sandbox/temp scratch as a repo write.
      writeScope: step.writeScope ? String(step.writeScope) : null,
      payloadJson: step.payloadJson ? String(step.payloadJson) : null,
      createdAt: now,
      updatedAt: now,
    });
  }

  listSteps(taskId: any) {
    return this.listStepsStatement.all(String(taskId || ''));
  }

  // §4 cross-chunk merge: an incremental pass can see the toolResult of a
  // step whose tool_call an earlier pass already stored as open. The orphan
  // result joins the stored row instead of becoming a second row.
  findOpenStep(taskId: any, stepKey: any) {
    return this.getOpenStepByCallIdStatement.get(String(taskId || ''), String(stepKey || '')) || null;
  }

  getStep(taskId: any, stepKey: any) {
    return this.getStepStatement.get(String(taskId || ''), String(stepKey || '')) || null;
  }

  // Steps awaiting (or worth retrying) JEV resolution: timeout/error (§6
  // retry semantics) plus orphaned `pending` rows whose async resolution
  // never landed (e.g. process restart) — payload_json carries their
  // classifier input so the retry needs no session re-parse.
  listJevRetrySteps(taskId: any) {
    return this.db.prepare(`
      SELECT *
      FROM chat_turn_time_steps
      WHERE task_id = ? AND jev_status IN ('pending', 'timeout', 'error')
      ORDER BY started_at ASC, id ASC
    `).all(String(taskId || ''));
  }

  getSummary(messageId: any) {
    const row = this.getSummaryStatement.get(String(messageId || ''));

    if (!row) {
      return null;
    }

    return {
      messageId: row.message_id,
      taskId: row.task_id,
      conversationId: row.conversation_id,
      status: row.status,
      turnStartedAt: row.turn_started_at,
      turnEndedAt: row.turn_ended_at,
      categoryMs: parseJson(row.category_ms_json) || {},
      metrics: parseJson(row.metrics_json) || {},
      parseOffset: Number.isSafeInteger(row.parse_offset) ? row.parse_offset : null,
      assistantCount: Number.isSafeInteger(row.assistant_count) ? row.assistant_count : null,
      computedAt: row.computed_at,
    };
  }

  upsertSummary(summary: any) {
    this.upsertSummaryStatement.run({
      messageId: String(summary.messageId),
      taskId: String(summary.taskId),
      conversationId: String(summary.conversationId),
      status: String(summary.status),
      turnStartedAt: summary.turnStartedAt ? String(summary.turnStartedAt) : null,
      turnEndedAt: summary.turnEndedAt ? String(summary.turnEndedAt) : null,
      categoryMsJson: JSON.stringify(summary.categoryMs || {}),
      metricsJson: JSON.stringify(summary.metrics || {}),
      parseOffset: Number.isSafeInteger(summary.parseOffset) ? summary.parseOffset : null,
      assistantCount: Number.isSafeInteger(summary.assistantCount) ? summary.assistantCount : null,
      computedAt: summary.computedAt ? String(summary.computedAt) : nowIso(),
    });
  }

  // §6 cache adapter: returns the camelCase entry shape
  // {category, subcategory, runKind, confidence} or null on miss.
  getJevCacheEntry(cacheKey: any) {
    const row = this.getJevCacheStatement.get(String(cacheKey || ''));

    if (!row || !row.category) {
      return null;
    }

    return {
      category: row.category,
      subcategory: row.subcategory || null,
      runKind: row.run_kind || null,
      confidence: Number.isFinite(row.confidence) ? row.confidence : null,
    };
  }

  setJevCacheEntry(cacheKey: any, entry: any) {
    if (!entry || !entry.category) {
      return;
    }

    this.setJevCacheStatement.run({
      cacheKey: String(cacheKey || ''),
      category: String(entry.category),
      subcategory: entry.subcategory ? String(entry.subcategory) : null,
      runKind: entry.runKind ? String(entry.runKind) : null,
      confidence: Number.isFinite(entry.confidence) ? entry.confidence : null,
      createdAt: nowIso(),
    });
  }

  countJevCacheEntries() {
    const row = this.countJevCacheStatement.get();
    return row && Number.isFinite(row.entry_count) ? row.entry_count : 0;
  }

  // Clears the classification cache only (§6 UI). Already-classified steps
  // in chat_turn_time_steps keep their category — the cache is a shortcut,
  // not the record.
  clearJevCache() {
    const result = this.clearJevCacheStatement.run();
    return Number.isFinite(result && result.changes) ? result.changes : 0;
  }
}

export function createTurnTimeBreakdownRepository(db: any) {
  return new TurnTimeBreakdownRepository(db);
}
