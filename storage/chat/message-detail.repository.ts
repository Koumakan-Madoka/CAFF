import { MAX_CONTEXT_SNAPSHOT_PAGE_LIMIT, retainModelUsageCalls } from '../../lib/message-detail-contract';
import { normalizeObservabilityTimeline } from '../../lib/observability-timeline';

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

function normalizePageLimit(value: any) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONTEXT_SNAPSHOT_PAGE_LIMIT) {
    throw new RangeError(
      `Context snapshot page limit must be an integer between 1 and ${MAX_CONTEXT_SNAPSHOT_PAGE_LIMIT}`
    );
  }
  return value;
}

function normalizePageCursor(value: any) {
  if (value === undefined || value === null) {
    return null;
  }

  const createdAt = String(value && value.createdAt || '').trim();
  const id = String(value && value.id || '').trim();
  if (!createdAt || !id) {
    throw new TypeError('Context snapshot page cursor must include createdAt and id');
  }
  return { createdAt, id };
}

export class ChatMessageDetailRepository {
  db: any;
  currentContextSnapshotStatement: any;
  upsertContextSnapshotStatement: any;
  upsertModelUsageStatement: any;
  getContextSnapshotStatement: any;
  getModelUsageStatement: any;
  upsertObservabilityTimelineStatement: any;
  getObservabilityTimelineStatement: any;

  constructor(db: any) {
    this.db = db;
    this.currentContextSnapshotStatement = db.prepare(`
      SELECT 1 AS present
      FROM chat_message_context_snapshots
      WHERE message_id = ? AND snapshot_id = ?
      LIMIT 1
    `);
    this.upsertContextSnapshotStatement = db.prepare(`
      INSERT INTO chat_message_context_snapshots (
        message_id, conversation_id, turn_id, agent_id, snapshot_id,
        snapshot_json, summary_json, created_at, updated_at
      ) VALUES (
        @messageId, @conversationId, @turnId, @agentId, @snapshotId,
        @snapshotJson, @summaryJson, @createdAt, @updatedAt
      )
      ON CONFLICT(message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        turn_id = excluded.turn_id,
        agent_id = excluded.agent_id,
        snapshot_id = excluded.snapshot_id,
        snapshot_json = excluded.snapshot_json,
        summary_json = excluded.summary_json,
        updated_at = excluded.updated_at
    `);
    this.upsertModelUsageStatement = db.prepare(`
      INSERT INTO chat_message_model_usage_calls (
        message_id, conversation_id, turn_id, agent_id, model_call_count,
        cold_start_model_call_count, post_cold_model_call_count,
        provider_miss_count, calls_json, calls_truncated,
        retained_call_count, dropped_call_count, created_at, updated_at
      ) VALUES (
        @messageId, @conversationId, @turnId, @agentId, @modelCallCount,
        @coldStartModelCallCount, @postColdModelCallCount,
        @providerMissCount, @callsJson, @callsTruncated,
        @retainedCallCount, @droppedCallCount, @createdAt, @updatedAt
      )
      ON CONFLICT(message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        turn_id = excluded.turn_id,
        agent_id = excluded.agent_id,
        model_call_count = excluded.model_call_count,
        cold_start_model_call_count = excluded.cold_start_model_call_count,
        post_cold_model_call_count = excluded.post_cold_model_call_count,
        provider_miss_count = excluded.provider_miss_count,
        calls_json = excluded.calls_json,
        calls_truncated = excluded.calls_truncated,
        retained_call_count = excluded.retained_call_count,
        dropped_call_count = excluded.dropped_call_count,
        updated_at = excluded.updated_at
    `);
    this.getContextSnapshotStatement = db.prepare(`
      SELECT
        CASE
          WHEN detail.message_id IS NOT NULL THEN detail.snapshot_json
          WHEN json_valid(message.metadata_json) = 1
            THEN json_extract(message.metadata_json, '$.agentContextSnapshot')
          ELSE NULL
        END AS snapshot_json,
        CASE WHEN detail.message_id IS NOT NULL THEN 'table' ELSE 'metadata' END AS detail_source
      FROM chat_messages message
      LEFT JOIN chat_message_context_snapshots detail ON detail.message_id = message.id
      WHERE message.id = ? AND message.role = 'assistant'
      LIMIT 1
    `);
    this.getModelUsageStatement = db.prepare(`
      SELECT
        detail.message_id AS detail_message_id,
        detail.model_call_count,
        detail.cold_start_model_call_count,
        detail.post_cold_model_call_count,
        detail.provider_miss_count,
        detail.calls_json,
        detail.calls_truncated,
        detail.retained_call_count,
        detail.dropped_call_count,
        CASE
          WHEN detail.message_id IS NULL AND json_valid(message.metadata_json) = 1
            THEN json_extract(message.metadata_json, '$.modelUsage')
          ELSE NULL
        END AS legacy_model_usage_json
      FROM chat_messages message
      LEFT JOIN chat_message_model_usage_calls detail ON detail.message_id = message.id
      WHERE message.id = ? AND message.role = 'assistant'
      LIMIT 1
    `);
    this.getObservabilityTimelineStatement = db.prepare(`
      SELECT *
      FROM chat_message_observability_timelines
      WHERE message_id = ?
      LIMIT 1
    `);
    this.upsertObservabilityTimelineStatement = db.prepare(`
      INSERT INTO chat_message_observability_timelines (
        message_id, conversation_id, turn_id, agent_id,
        total_event_count, retained_event_count, dropped_event_count,
        events_truncated, events_json, model_call_count,
        cold_start_model_call_count, post_cold_model_call_count,
        provider_miss_count, tool_execution_count,
        failed_tool_execution_count, total_tool_duration_ms,
        created_at, updated_at
      ) VALUES (
        @messageId, @conversationId, @turnId, @agentId,
        @totalEventCount, @retainedEventCount, @droppedEventCount,
        @eventsTruncated, @eventsJson, @modelCallCount,
        @coldStartModelCallCount, @postColdModelCallCount,
        @providerMissCount, @toolExecutionCount,
        @failedToolExecutionCount, @totalToolDurationMs,
        @createdAt, @updatedAt
      )
      ON CONFLICT(message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        turn_id = excluded.turn_id,
        agent_id = excluded.agent_id,
        total_event_count = excluded.total_event_count,
        retained_event_count = excluded.retained_event_count,
        dropped_event_count = excluded.dropped_event_count,
        events_truncated = excluded.events_truncated,
        events_json = excluded.events_json,
        model_call_count = excluded.model_call_count,
        cold_start_model_call_count = excluded.cold_start_model_call_count,
        post_cold_model_call_count = excluded.post_cold_model_call_count,
        provider_miss_count = excluded.provider_miss_count,
        tool_execution_count = excluded.tool_execution_count,
        failed_tool_execution_count = excluded.failed_tool_execution_count,
        total_tool_duration_ms = excluded.total_tool_duration_ms,
        updated_at = excluded.updated_at
    `);
  }

  hasContextSnapshot(messageId: string, snapshotId: string) {
    return Boolean(this.currentContextSnapshotStatement.get(
      String(messageId || '').trim(),
      String(snapshotId || '').trim()
    ));
  }

  upsertContextSnapshot(payload: any) {
    this.upsertContextSnapshotStatement.run(payload);
  }

  upsertModelUsage(payload: any) {
    this.upsertModelUsageStatement.run(payload);
  }

  upsertObservabilityTimeline(payload: any) {
    this.upsertObservabilityTimelineStatement.run(payload);
  }

  getContextSnapshot(messageId: string) {
    const row = this.getContextSnapshotStatement.get(String(messageId || '').trim());
    return row ? parseJson(row.snapshot_json) : null;
  }

  getModelUsage(messageId: string) {
    const row = this.getModelUsageStatement.get(String(messageId || '').trim());
    if (!row) {
      return null;
    }
    if (!row.detail_message_id) {
      return {
        source: 'metadata',
        modelUsage: parseJson(row.legacy_model_usage_json),
      };
    }
    const calls = parseJson(row.calls_json);
    const retained = retainModelUsageCalls({
      modelCallCount: Number(row.model_call_count || 0),
      coldStartModelCallCount: Number(row.cold_start_model_call_count || 0),
      postColdModelCallCount: Number(row.post_cold_model_call_count || 0),
      providerMissCount: Number(row.provider_miss_count || 0),
      calls: Array.isArray(calls) ? calls : [],
    });
    return {
      source: 'table',
      modelUsage: retained
        ? {
            ...retained,
            callsTruncated: Boolean(row.calls_truncated) || retained.callsTruncated,
            retainedCallCount: retained.calls.length,
            droppedCallCount: Number(row.dropped_call_count || 0)
              + Math.max(0, (Array.isArray(calls) ? calls.length : 0) - retained.calls.length),
          }
        : {
        modelCallCount: Number(row.model_call_count || 0),
        coldStartModelCallCount: Number(row.cold_start_model_call_count || 0),
        postColdModelCallCount: Number(row.post_cold_model_call_count || 0),
        providerMissCount: Number(row.provider_miss_count || 0),
        calls: [],
        callsTruncated: false,
        retainedCallCount: 0,
        droppedCallCount: 0,
      },
    };
  }

  getObservabilityTimeline(messageId: string) {
    const row = this.getObservabilityTimelineStatement.get(String(messageId || '').trim());
    if (!row) {
      return null;
    }
    return normalizeObservabilityTimeline({
      events: parseJson(row.events_json),
      totalEventCount: Number(row.total_event_count || 0),
      modelCallCount: Number(row.model_call_count || 0),
      coldStartModelCallCount: Number(row.cold_start_model_call_count || 0),
      postColdModelCallCount: Number(row.post_cold_model_call_count || 0),
      providerMissCount: Number(row.provider_miss_count || 0),
      toolExecutionCount: Number(row.tool_execution_count || 0),
      failedToolExecutionCount: Number(row.failed_tool_execution_count || 0),
      totalToolDurationMs: Number(row.total_tool_duration_ms || 0),
    });
  }

  listContextSnapshotPage(conversationId: string, options: any = {}) {
    const normalizedConversationId = String(conversationId || '').trim();
    const limit = normalizePageLimit(options.limit);
    const before = normalizePageCursor(options.before);
    if (!normalizedConversationId) {
      return { items: [], nextBefore: null, hasMore: false };
    }

    const rows = this.db.prepare(`
      SELECT
        message.id AS message_id,
        message.created_at,
        CASE
          WHEN detail.message_id IS NOT NULL THEN detail.summary_json
          WHEN json_valid(message.metadata_json) = 1
            THEN json_extract(message.metadata_json, '$.agentContextSnapshot')
          ELSE NULL
        END AS snapshot_json
      FROM chat_messages message
      LEFT JOIN chat_message_context_snapshots detail ON detail.message_id = message.id
      WHERE message.conversation_id = @conversationId
        AND message.role = 'assistant'
        AND (
          detail.message_id IS NOT NULL
          OR (
            json_valid(message.metadata_json) = 1
            AND json_type(message.metadata_json, '$.agentContextSnapshot') = 'object'
          )
        )
        AND (
          @beforeCreatedAt = ''
          OR message.created_at < @beforeCreatedAt
          OR (message.created_at = @beforeCreatedAt AND message.id < @beforeId)
        )
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT @rowLimit
    `).all({
      conversationId: normalizedConversationId,
      beforeCreatedAt: before ? before.createdAt : '',
      beforeId: before ? before.id : '',
      rowLimit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const oldest = selected[selected.length - 1] || null;

    return {
      items: selected
        .map((row: any) => parseJson(row.snapshot_json))
        .filter(Boolean),
      nextBefore: hasMore && oldest
        ? { createdAt: oldest.created_at, id: oldest.message_id }
        : null,
      hasMore,
    };
  }
}

export function createChatMessageDetailRepository(db: any) {
  return new ChatMessageDetailRepository(db);
}
