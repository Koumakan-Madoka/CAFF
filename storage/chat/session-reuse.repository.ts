function normalizeReuseRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    profileId: row.profile_id,
    state: row.state,
    sessionName: row.session_name || null,
    sessionPath: row.session_path || null,
    staticSegmentHash: row.static_segment_hash || null,
    cursorMessageId: row.cursor_message_id || null,
    cursorMessageCount: Number.isInteger(row.cursor_message_count) ? row.cursor_message_count : 0,
    cursorFirstMessageId: row.cursor_first_message_id || null,
    cursorMaxUpdatedAt: row.cursor_max_updated_at || null,
    lastRunId: row.last_run_id === null || row.last_run_id === undefined ? null : row.last_run_id,
    lastAssistantMessageId: row.last_assistant_message_id || null,
    usageInputTokens: row.usage_input_tokens === null || row.usage_input_tokens === undefined ? null : row.usage_input_tokens,
    usageContextWindow:
      row.usage_context_window === null || row.usage_context_window === undefined ? null : row.usage_context_window,
    usageRatio: row.usage_ratio === null || row.usage_ratio === undefined ? null : row.usage_ratio,
    lastReplyAt: row.last_reply_at || null,
    poisonReason: row.poison_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeId(value: any, fieldName: string) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    throw new TypeError(`${fieldName} is required`);
  }

  return normalized;
}

export class ChatSessionReuseRepository {
  db: any;
  getStatement: any;
  claimStatement: any;
  poisonStatement: any;
  markReusableStatement: any;

  constructor(db: any) {
    this.db = db;
    this.getStatement = db.prepare(`
      SELECT *
      FROM chat_agent_session_reuse
      WHERE conversation_id = ? AND agent_id = ? AND profile_id = ?
      LIMIT 1
    `);
    // The same UPDATE guards both the persisted reuse snapshot and the live
    // chat_messages prefix represented by that snapshot. SQLite therefore
    // cannot interleave an edit/delete between cursor verification and the
    // reusable -> busy flip.
    this.claimStatement = db.prepare(`
      UPDATE chat_agent_session_reuse
      SET state = 'busy',
          last_run_id = @lastRunId,
          updated_at = @now
      WHERE conversation_id = @conversationId
        AND agent_id = @agentId
        AND profile_id = @profileId
        AND state = 'reusable'
        AND static_segment_hash = @expectedHash
        AND cursor_message_id = @expectedCursorMessageId
        AND cursor_message_count = @expectedCursorMessageCount
        AND cursor_first_message_id = @expectedCursorFirstMessageId
        AND cursor_max_updated_at = @expectedCursorMaxUpdatedAt
        AND EXISTS (
          SELECT 1
          FROM chat_messages AS cursor_message
          WHERE cursor_message.conversation_id = @conversationId
            AND cursor_message.id = @expectedCursorMessageId
        )
        AND (
          SELECT COUNT(*)
          FROM chat_messages AS prefix_message
          WHERE prefix_message.conversation_id = @conversationId
            AND (
              prefix_message.created_at < (
                SELECT cursor_message.created_at
                FROM chat_messages AS cursor_message
                WHERE cursor_message.conversation_id = @conversationId
                  AND cursor_message.id = @expectedCursorMessageId
              )
              OR (
                prefix_message.created_at = (
                  SELECT cursor_message.created_at
                  FROM chat_messages AS cursor_message
                  WHERE cursor_message.conversation_id = @conversationId
                    AND cursor_message.id = @expectedCursorMessageId
                )
                AND prefix_message.id <= @expectedCursorMessageId
              )
            )
        ) = @expectedCursorMessageCount
        AND (
          SELECT first_message.id
          FROM chat_messages AS first_message
          WHERE first_message.conversation_id = @conversationId
          ORDER BY first_message.created_at ASC, first_message.id ASC
          LIMIT 1
        ) = @expectedCursorFirstMessageId
        AND (
          SELECT MAX(COALESCE(prefix_message.updated_at, prefix_message.created_at))
          FROM chat_messages AS prefix_message
          WHERE prefix_message.conversation_id = @conversationId
            AND (
              prefix_message.created_at < (
                SELECT cursor_message.created_at
                FROM chat_messages AS cursor_message
                WHERE cursor_message.conversation_id = @conversationId
                  AND cursor_message.id = @expectedCursorMessageId
              )
              OR (
                prefix_message.created_at = (
                  SELECT cursor_message.created_at
                  FROM chat_messages AS cursor_message
                  WHERE cursor_message.conversation_id = @conversationId
                    AND cursor_message.id = @expectedCursorMessageId
                )
                AND prefix_message.id <= @expectedCursorMessageId
              )
            )
        ) = @expectedCursorMaxUpdatedAt
    `);
    this.poisonStatement = db.prepare(`
      UPDATE chat_agent_session_reuse
      SET state = 'poisoned',
          poison_reason = @poisonReason,
          updated_at = @now
      WHERE conversation_id = @conversationId
        AND agent_id = @agentId
        AND profile_id = @profileId
    `);
    // A busy row belongs to the provider session that claimed it. Completion
    // may settle that same session, but a concurrent fresh fallback has a
    // distinct session name and must not release or replace the active claim.
    this.markReusableStatement = db.prepare(`
      INSERT INTO chat_agent_session_reuse (
        conversation_id,
        agent_id,
        profile_id,
        state,
        session_name,
        session_path,
        static_segment_hash,
        cursor_message_id,
        cursor_message_count,
        cursor_first_message_id,
        cursor_max_updated_at,
        last_run_id,
        last_assistant_message_id,
        usage_input_tokens,
        usage_context_window,
        usage_ratio,
        last_reply_at,
        poison_reason,
        created_at,
        updated_at
      ) VALUES (
        @conversationId,
        @agentId,
        @profileId,
        'reusable',
        @sessionName,
        @sessionPath,
        @staticSegmentHash,
        @cursorMessageId,
        @cursorMessageCount,
        @cursorFirstMessageId,
        @cursorMaxUpdatedAt,
        @lastRunId,
        @lastAssistantMessageId,
        @usageInputTokens,
        @usageContextWindow,
        @usageRatio,
        @lastReplyAt,
        NULL,
        @now,
        @now
      )
      ON CONFLICT(conversation_id, agent_id, profile_id) DO UPDATE SET
        state = 'reusable',
        session_name = excluded.session_name,
        session_path = excluded.session_path,
        static_segment_hash = excluded.static_segment_hash,
        cursor_message_id = excluded.cursor_message_id,
        cursor_message_count = excluded.cursor_message_count,
        cursor_first_message_id = excluded.cursor_first_message_id,
        cursor_max_updated_at = excluded.cursor_max_updated_at,
        last_run_id = excluded.last_run_id,
        last_assistant_message_id = excluded.last_assistant_message_id,
        usage_input_tokens = excluded.usage_input_tokens,
        usage_context_window = excluded.usage_context_window,
        usage_ratio = excluded.usage_ratio,
        last_reply_at = excluded.last_reply_at,
        poison_reason = NULL,
        updated_at = excluded.updated_at
      WHERE chat_agent_session_reuse.state <> 'busy'
         OR chat_agent_session_reuse.session_name = excluded.session_name
      RETURNING *
    `);
  }

  get(conversationId: any, agentId: any, profileId: any) {
    return normalizeReuseRow(
      this.getStatement.get(
        normalizeId(conversationId, 'conversationId'),
        normalizeId(agentId, 'agentId'),
        normalizeId(profileId || 'default', 'profileId')
      )
    );
  }

  // Returns the post-claim row when the guarded flip succeeded, or null when
  // the row or its live message-prefix fingerprint changed concurrently.
  claim(payload: any) {
    const expectedCursorMessageCount = Number(payload.expectedCursorMessageCount);
    if (!Number.isInteger(expectedCursorMessageCount) || expectedCursorMessageCount <= 0) {
      throw new TypeError('expectedCursorMessageCount must be a positive integer');
    }

    const result = this.claimStatement.run({
      conversationId: normalizeId(payload.conversationId, 'conversationId'),
      agentId: normalizeId(payload.agentId, 'agentId'),
      profileId: normalizeId(payload.profileId || 'default', 'profileId'),
      expectedHash: normalizeId(payload.expectedHash, 'expectedHash'),
      expectedCursorMessageId: normalizeId(payload.expectedCursorMessageId, 'expectedCursorMessageId'),
      expectedCursorMessageCount,
      expectedCursorFirstMessageId: normalizeId(
        payload.expectedCursorFirstMessageId,
        'expectedCursorFirstMessageId'
      ),
      expectedCursorMaxUpdatedAt: normalizeId(
        payload.expectedCursorMaxUpdatedAt,
        'expectedCursorMaxUpdatedAt'
      ),
      lastRunId: payload.lastRunId === null || payload.lastRunId === undefined ? null : payload.lastRunId,
      now: normalizeId(payload.now, 'now'),
    });

    if (!result || result.changes !== 1) {
      return null;
    }

    return this.get(payload.conversationId, payload.agentId, payload.profileId);
  }

  // Restores a previously claimed row back to its reusable snapshot. Used when
  // a run is claimed but aborts before the provider session is touched, so the
  // cached session is still clean.
  restoreReusable(snapshot: any, now: any) {
    if (!snapshot || snapshot.state !== 'reusable') {
      throw new TypeError('restoreReusable requires the pre-claim reusable row snapshot');
    }

    return normalizeReuseRow(
      this.markReusableStatement.get({
        conversationId: normalizeId(snapshot.conversationId, 'conversationId'),
        agentId: normalizeId(snapshot.agentId, 'agentId'),
        profileId: normalizeId(snapshot.profileId || 'default', 'profileId'),
        sessionName: snapshot.sessionName,
        sessionPath: snapshot.sessionPath,
        staticSegmentHash: snapshot.staticSegmentHash,
        cursorMessageId: snapshot.cursorMessageId,
        cursorMessageCount: snapshot.cursorMessageCount,
        cursorFirstMessageId: snapshot.cursorFirstMessageId,
        cursorMaxUpdatedAt: snapshot.cursorMaxUpdatedAt,
        lastRunId: snapshot.lastRunId,
        lastAssistantMessageId: snapshot.lastAssistantMessageId,
        usageInputTokens: snapshot.usageInputTokens,
        usageContextWindow: snapshot.usageContextWindow,
        usageRatio: snapshot.usageRatio,
        lastReplyAt: snapshot.lastReplyAt,
        now: normalizeId(now, 'now'),
      })
    );
  }

  markReusable(payload: any) {
    return normalizeReuseRow(
      this.markReusableStatement.get({
        conversationId: normalizeId(payload.conversationId, 'conversationId'),
        agentId: normalizeId(payload.agentId, 'agentId'),
        profileId: normalizeId(payload.profileId || 'default', 'profileId'),
        sessionName: normalizeId(payload.sessionName, 'sessionName'),
        sessionPath: normalizeId(payload.sessionPath, 'sessionPath'),
        staticSegmentHash: normalizeId(payload.staticSegmentHash, 'staticSegmentHash'),
        cursorMessageId: normalizeId(payload.cursorMessageId, 'cursorMessageId'),
        cursorMessageCount: Number.isInteger(payload.cursorMessageCount) ? payload.cursorMessageCount : 0,
        cursorFirstMessageId: payload.cursorFirstMessageId || null,
        cursorMaxUpdatedAt: payload.cursorMaxUpdatedAt || null,
        lastRunId: payload.lastRunId === null || payload.lastRunId === undefined ? null : payload.lastRunId,
        lastAssistantMessageId: payload.lastAssistantMessageId || null,
        usageInputTokens:
          payload.usageInputTokens === null || payload.usageInputTokens === undefined ? null : payload.usageInputTokens,
        usageContextWindow:
          payload.usageContextWindow === null || payload.usageContextWindow === undefined
            ? null
            : payload.usageContextWindow,
        usageRatio: payload.usageRatio === null || payload.usageRatio === undefined ? null : payload.usageRatio,
        lastReplyAt: payload.lastReplyAt || null,
        now: normalizeId(payload.now, 'now'),
      })
    );
  }

  markPoisoned(conversationId: any, agentId: any, profileId: any, poisonReason: any, now: any) {
    this.poisonStatement.run({
      conversationId: normalizeId(conversationId, 'conversationId'),
      agentId: normalizeId(agentId, 'agentId'),
      profileId: normalizeId(profileId || 'default', 'profileId'),
      poisonReason: normalizeId(poisonReason, 'poisonReason'),
      now: normalizeId(now, 'now'),
    });
  }
}

export function createChatSessionReuseRepository(db: any) {
  return new ChatSessionReuseRepository(db);
}
