import { MAX_CONVERSATION_MESSAGE_DELETE_BATCH_SIZE } from '../../lib/conversation-message-deletion-contract';
import {
  DEFAULT_PROMPT_HISTORY_LIMIT,
  MAX_PROMPT_HISTORY_LIMIT,
  MAX_RUNTIME_MESSAGE_ID_PROJECTION,
} from '../../lib/conversation-hydration-contract';

function normalizeMessageSearchQuery(value: any) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function extractMessageSearchTerms(value: any) {
  const source = normalizeMessageSearchQuery(value);
  if (!source) {
    return [];
  }

  const seen = new Set();
  const terms = [];
  const tokens = source.match(/[\p{L}\p{N}_-]+/gu) || [];

  for (const token of tokens) {
    const normalizedToken = String(token || '').trim();

    if (!normalizedToken || seen.has(normalizedToken)) {
      continue;
    }

    seen.add(normalizedToken);
    terms.push(normalizedToken);
  }

  if (terms.length === 0) {
    terms.push(source);
  }

  return terms;
}

function buildFtsMatchQuery(value: any) {
  const terms = extractMessageSearchTerms(value);
  if (terms.length === 0) {
    return '';
  }

  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ');
}

function escapeLikePattern(value: any) {
  return String(value || '').replace(/([%_\\])/g, '\\$1');
}

function normalizeMessageSearchFilter(value: any) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeMessageSearchFilters(options: any = {}) {
  return {
    speaker: normalizeMessageSearchFilter(options.speaker || options.senderName || options.sender),
    agentId: normalizeMessageSearchFilter(options.agentId || options.agentID),
  };
}

function hasMessageSearchFilters(filters: any = {}) {
  return Boolean((filters && filters.speaker) || (filters && filters.agentId));
}

const DEFAULT_MESSAGE_PAGE_LIMIT = 50;
const MAX_MESSAGE_PAGE_LIMIT = 100;

function normalizeMessageIds(value: any) {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((messageId: any) => String(messageId || '').trim())
        .filter(Boolean)
    )
  ).slice(0, MAX_CONVERSATION_MESSAGE_DELETE_BATCH_SIZE);
}

function normalizeRuntimeMessageIds(value: any) {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((messageId: any) => String(messageId || '').trim())
        .filter(Boolean)
    )
  ).slice(0, MAX_RUNTIME_MESSAGE_ID_PROJECTION);
}

function normalizePromptHistoryLimit(value: any) {
  if (value === undefined || value === null) {
    return DEFAULT_PROMPT_HISTORY_LIMIT;
  }

  if (!Number.isInteger(value) || value < 0 || value > MAX_PROMPT_HISTORY_LIMIT) {
    throw new RangeError(`Prompt history limit must be an integer between 0 and ${MAX_PROMPT_HISTORY_LIMIT}`);
  }

  return value;
}

function normalizeMessagePageLimit(value: any) {
  const limit = value === undefined ? DEFAULT_MESSAGE_PAGE_LIMIT : value;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE_LIMIT) {
    throw new RangeError(`Message page limit must be an integer between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`);
  }

  return limit;
}

function normalizeMessagePageCursor(value: any) {
  if (value === undefined || value === null) {
    return null;
  }

  const createdAt = value && typeof value.createdAt === 'string' ? value.createdAt.trim() : '';
  const id = value && typeof value.id === 'string' ? value.id.trim() : '';

  if (!createdAt || !id) {
    throw new TypeError('Message page before cursor must include createdAt and id');
  }

  return { createdAt, id };
}

export class ChatMessageRepository {
  db: any;
  insertStatement: any;
  listByConversationStatement: any;
  pageByConversationStatement: any;
  pageBeforeConversationStatement: any;
  getStatement: any;
  getByClientRequestStatement: any;
  updateStatement: any;
  appendTextStatement: any;
  findCompletedCrossConversationReplyStatement: any;
  countByRoleStatement: any;
  searchLikeStatements: Map<number, any>;
  hasSearchTableCache: boolean | null;
  searchFtsStatement: any;

  constructor(db: any) {
    this.db = db;
    this.insertStatement = db.prepare(`
      INSERT INTO chat_messages (
        id,
        conversation_id,
        turn_id,
        role,
        agent_id,
        sender_name,
        content,
        status,
        task_id,
        run_id,
        error_message,
        metadata_json,
        client_request_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getByClientRequestStatement = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE conversation_id = ? AND client_request_id = ?
      LIMIT 1
    `);
    this.listByConversationStatement = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `);
    this.pageByConversationStatement = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `);
    this.pageBeforeConversationStatement = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE conversation_id = ?
        AND (created_at, id) < (?, ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `);
    this.getStatement = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE id = ?
      LIMIT 1
    `);
    this.updateStatement = db.prepare(`
      UPDATE chat_messages
      SET
        content = ?,
        status = ?,
        task_id = ?,
        run_id = ?,
        error_message = ?,
        metadata_json = ?
      WHERE id = ?
    `);
    this.appendTextStatement = db.prepare(`
      UPDATE chat_messages
      SET content = COALESCE(content, '') || ?
      WHERE id = ?
    `);
    this.findCompletedCrossConversationReplyStatement = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE conversation_id = ?
        AND agent_id = ?
        AND role = 'assistant'
        AND status = 'completed'
        AND (? = '' OR created_at >= ?)
        AND metadata_json LIKE ? ESCAPE '\\'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `);
    this.countByRoleStatement = db.prepare(`
      SELECT COUNT(*) AS message_count
      FROM chat_messages
      WHERE conversation_id = ? AND role = ?
    `);
    this.searchLikeStatements = new Map();
    this.hasSearchTableCache = null;
    this.searchFtsStatement = null;
  }

  create(payload: any) {
    this.insertStatement.run(
      payload.id,
      payload.conversationId,
      payload.turnId,
      payload.role,
      payload.agentId || null,
      payload.senderName,
      payload.content || '',
      payload.status || 'completed',
      payload.taskId || null,
      payload.runId || null,
      payload.errorMessage || null,
      payload.metadataJson,
      payload.clientRequestId || null,
      payload.createdAt
    );

    return this.get(payload.id);
  }

  getByClientRequestId(conversationId: string, clientRequestId: string) {
    const normalizedConversationId = String(conversationId || '').trim();
    const normalizedClientRequestId = String(clientRequestId || '').trim();

    if (!normalizedConversationId || !normalizedClientRequestId) {
      return null;
    }

    return this.getByClientRequestStatement.get(normalizedConversationId, normalizedClientRequestId) || null;
  }

  findCompletedCrossConversationReply(payload: any) {
    const deliveryId = String(payload && payload.deliveryId || '').trim();
    const conversationId = String(payload && payload.conversationId || '').trim();
    const agentId = String(payload && payload.agentId || '').trim();
    const startedAt = String(payload && payload.startedAt || '').trim();

    if (!deliveryId || !conversationId || !agentId) {
      return null;
    }

    return this.findCompletedCrossConversationReplyStatement.get(
      conversationId,
      agentId,
      startedAt,
      startedAt,
      `%"crossConversationDeliveryId":"${escapeLikePattern(deliveryId)}"%`
    ) || null;
  }

  countByRole(conversationId: string, role: string) {
    const row = this.countByRoleStatement.get(String(conversationId || ''), String(role || ''));
    return Number(row && row.message_count) || 0;
  }

  listByConversationId(conversationId: string) {
    return this.listByConversationStatement.all(conversationId);
  }

  listConversationIdsWithPendingUserMessages() {
    return this.db
      .prepare(`
        SELECT DISTINCT m.conversation_id
        FROM chat_messages m
        JOIN chat_conversations c ON c.id = m.conversation_id
        LEFT JOIN chat_messages cursor_message
          ON cursor_message.conversation_id = m.conversation_id
         AND cursor_message.id = CASE
           WHEN json_valid(c.metadata_json) = 1
           THEN COALESCE(json_extract(c.metadata_json, '$.conversationTurnQueue.lastConsumedUserMessageId'), '')
           ELSE ''
         END
        WHERE m.role = 'user'
          AND (
            json_valid(m.metadata_json) = 0
            OR COALESCE(json_extract(m.metadata_json, '$.dispatchLane'), '') <> 'side'
          )
          AND (
            CASE
              WHEN json_valid(c.metadata_json) = 1
               AND json_type(c.metadata_json, '$.conversationTurnQueue.lastConsumedUserMessageId') IS NOT NULL
              THEN (
                cursor_message.id IS NULL
                OR m.created_at > cursor_message.created_at
                OR (m.created_at = cursor_message.created_at AND m.id > cursor_message.id)
              )
              ELSE NOT EXISTS (
                SELECT 1
                FROM chat_messages later_message
                WHERE later_message.conversation_id = m.conversation_id
                  AND later_message.role <> 'user'
                  AND (
                    later_message.created_at > m.created_at
                    OR (later_message.created_at = m.created_at AND later_message.id > m.id)
                  )
              )
            END
          )
      `)
      .all()
      .map((row: any) => String(row.conversation_id || '').trim())
      .filter(Boolean);
  }

  inferLastConsumedUserMessageId(conversationId: string) {
    const row = this.db.prepare(`
      SELECT user_message.id
      FROM chat_messages user_message
      WHERE user_message.conversation_id = ?
        AND user_message.role = 'user'
        AND (user_message.created_at, user_message.id) < (
          SELECT non_user.created_at, non_user.id
          FROM chat_messages non_user
          WHERE non_user.conversation_id = ?
            AND non_user.role <> 'user'
          ORDER BY non_user.created_at DESC, non_user.id DESC
          LIMIT 1
        )
      ORDER BY user_message.created_at DESC, user_message.id DESC
      LIMIT 1
    `).get(conversationId, conversationId);

    return row && row.id ? String(row.id).trim() : '';
  }

  listPendingMainUserMessages(conversationId: string, afterMessageId: string = '', options: any = {}) {
    const normalizedConversationId = String(conversationId || '').trim();
    const normalizedAfterMessageId = String(afterMessageId || '').trim();
    const limit = Number.isInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, MAX_RUNTIME_MESSAGE_ID_PROJECTION)
      : -1;

    if (!normalizedConversationId) {
      return [];
    }

    return this.db.prepare(`
      WITH cursor_message AS (
        SELECT created_at, id
        FROM chat_messages
        WHERE conversation_id = @conversationId AND id = @afterMessageId
        LIMIT 1
      )
      SELECT message.*
      FROM chat_messages message
      WHERE message.conversation_id = @conversationId
        AND message.role = 'user'
        AND (
          json_valid(message.metadata_json) = 0
          OR COALESCE(json_extract(message.metadata_json, '$.dispatchLane'), '') <> 'side'
        )
        AND (
          @afterMessageId = ''
          OR NOT EXISTS (SELECT 1 FROM cursor_message)
          OR (message.created_at, message.id) > (
            SELECT created_at, id FROM cursor_message
          )
        )
      ORDER BY message.created_at ASC, message.id ASC
      LIMIT @limit
    `).all({
      conversationId: normalizedConversationId,
      afterMessageId: normalizedAfterMessageId,
      limit,
    });
  }

  findPreviousUserMessageId(conversationId: string, before: any) {
    const normalizedConversationId = String(conversationId || '').trim();
    const createdAt = String(before && before.createdAt || '').trim();
    const id = String(before && before.id || '').trim();

    if (!normalizedConversationId || !createdAt || !id) {
      return null;
    }

    return this.db.prepare(`
      SELECT id
      FROM chat_messages
      WHERE conversation_id = ?
        AND role = 'user'
        AND (created_at, id) < (?, ?)
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(normalizedConversationId, createdAt, id) || null;
  }

  findLatestPublicCompletedAssistantReplyAgentId(conversationId: string, participantAgentIds: string[]) {
    const normalizedConversationId = String(conversationId || '').trim();
    const normalizedAgentIds = normalizeRuntimeMessageIds(participantAgentIds);

    if (!normalizedConversationId || normalizedAgentIds.length === 0) {
      return null;
    }

    return this.db.prepare(`
      SELECT message.agent_id
      FROM chat_messages message
      WHERE message.conversation_id = @conversationId
        AND message.role = 'assistant'
        AND message.status = 'completed'
        AND TRIM(message.content) <> ''
        AND message.agent_id IN (SELECT value FROM json_each(@participantAgentIds))
        AND (
          CASE
            WHEN json_valid(message.metadata_json) = 0 THEN 0
            WHEN json_type(message.metadata_json, '$.privateOnly') IS NULL THEN 0
            WHEN json_type(message.metadata_json, '$.privateOnly') IN ('null', 'false') THEN 0
            WHEN json_type(message.metadata_json, '$.privateOnly') = 'true' THEN 1
            WHEN json_type(message.metadata_json, '$.privateOnly') IN ('integer', 'real')
              THEN COALESCE(json_extract(message.metadata_json, '$.privateOnly'), 0) <> 0
            WHEN json_type(message.metadata_json, '$.privateOnly') = 'text'
              THEN LENGTH(COALESCE(json_extract(message.metadata_json, '$.privateOnly'), '')) > 0
            ELSE 1
          END
        ) = 0
        AND NOT (
          json_valid(message.metadata_json) = 1
          AND json_type(message.metadata_json, '$.visibility') = 'text'
          AND LOWER(TRIM(COALESCE(json_extract(message.metadata_json, '$.visibility'), ''))) = 'private'
        )
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT 1
    `).get({
      conversationId: normalizedConversationId,
      participantAgentIds: JSON.stringify(normalizedAgentIds),
    }) || null;
  }

  listPromptMessages(conversationId: string, options: any = {}) {
    const normalizedConversationId = String(conversationId || '').trim();
    const historyLimit = normalizePromptHistoryLimit(options.historyLimit);
    const currentTurnId = String(options.currentTurnId || '').trim();
    const requiredMessageIds = normalizeRuntimeMessageIds(options.requiredMessageIds);
    const before = options.before && typeof options.before === 'object'
      ? {
          createdAt: String(options.before.createdAt || '').trim(),
          id: String(options.before.id || '').trim(),
        }
      : { createdAt: '', id: '' };

    if (!normalizedConversationId) {
      return [];
    }

    return this.db.prepare(`
      WITH recent_history_ids AS (
        SELECT id
        FROM chat_messages
        WHERE conversation_id = @conversationId
          AND @historyLimit > 0
          AND (@currentTurnId = '' OR turn_id IS NULL OR turn_id <> @currentTurnId)
          AND (
            @beforeCreatedAt = ''
            OR created_at < @beforeCreatedAt
            OR (created_at = @beforeCreatedAt AND id < @beforeId)
          )
        ORDER BY created_at DESC, id DESC
        LIMIT @historyLimit
      ), selected_ids AS (
        SELECT id FROM recent_history_ids
        UNION
        SELECT id
        FROM chat_messages
        WHERE conversation_id = @conversationId
          AND @currentTurnId <> ''
          AND turn_id = @currentTurnId
        UNION
        SELECT id
        FROM chat_messages
        WHERE conversation_id = @conversationId
          AND id IN (SELECT value FROM json_each(@requiredMessageIds))
      )
      SELECT message.*
      FROM chat_messages message
      JOIN selected_ids selected ON selected.id = message.id
      ORDER BY message.created_at ASC, message.id ASC
    `).all({
      conversationId: normalizedConversationId,
      historyLimit,
      currentTurnId,
      requiredMessageIds: JSON.stringify(requiredMessageIds),
      beforeCreatedAt: before.createdAt,
      beforeId: before.id,
    });
  }

  listSideDispatchRecoveryMessages() {
    return this.db.prepare(`
      SELECT source_message.*
      FROM chat_messages source_message
      WHERE source_message.role = 'user'
        AND json_valid(source_message.metadata_json) = 1
        AND COALESCE(json_extract(source_message.metadata_json, '$.dispatchLane'), '') = 'side'
        AND NOT EXISTS (
          SELECT 1
          FROM chat_messages reply_message
          WHERE reply_message.conversation_id = source_message.conversation_id
            AND reply_message.role = 'assistant'
            AND reply_message.status IN ('completed', 'failed')
            AND json_valid(reply_message.metadata_json) = 1
            AND COALESCE(json_extract(reply_message.metadata_json, '$.triggeredByMessageId'), '') = source_message.id
        )
      ORDER BY source_message.created_at ASC, source_message.id ASC
    `).all();
  }

  listAssistantRepliesForSourceMessage(conversationId: string, sourceMessageId: string) {
    const normalizedConversationId = String(conversationId || '').trim();
    const normalizedSourceMessageId = String(sourceMessageId || '').trim();

    if (!normalizedConversationId || !normalizedSourceMessageId) {
      return [];
    }

    return this.db.prepare(`
      SELECT reply_message.*
      FROM chat_messages reply_message
      WHERE reply_message.conversation_id = ?
        AND reply_message.role = 'assistant'
        AND json_valid(reply_message.metadata_json) = 1
        AND COALESCE(json_extract(reply_message.metadata_json, '$.triggeredByMessageId'), '') = ?
      ORDER BY reply_message.created_at ASC, reply_message.id ASC
    `).all(normalizedConversationId, normalizedSourceMessageId);
  }

  listPageByConversationId(conversationId: string, options: any = {}) {
    const limit = normalizeMessagePageLimit(options.limit);
    const before = normalizeMessagePageCursor(options.before);
    const rows = before
      ? this.pageBeforeConversationStatement.all(conversationId, before.createdAt, before.id, limit + 1)
      : this.pageByConversationStatement.all(conversationId, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).reverse();
    const oldest = items[0] || null;

    return {
      items,
      nextBefore: hasMore && oldest
        ? {
            createdAt: oldest.created_at,
            id: oldest.id,
          }
        : null,
      hasMore,
    };
  }

  get(messageId: string) {
    return this.getStatement.get(messageId);
  }

  listByIds(messageIds: string[]) {
    const normalizedMessageIds = normalizeMessageIds(messageIds);

    if (normalizedMessageIds.length === 0) {
      return [];
    }

    return this.db
      .prepare(`
        SELECT *
        FROM chat_messages
        WHERE id IN (SELECT value FROM json_each(?))
        ORDER BY created_at ASC, id ASC
      `)
      .all(JSON.stringify(normalizedMessageIds));
  }

  listRuntimeByIdsForConversation(conversationId: string, messageIds: string[]) {
    const normalizedConversationId = String(conversationId || '').trim();
    const normalizedMessageIds = normalizeRuntimeMessageIds(messageIds);

    if (!normalizedConversationId || normalizedMessageIds.length === 0) {
      return [];
    }

    return this.db
      .prepare(`
        SELECT *
        FROM chat_messages
        WHERE conversation_id = ?
          AND id IN (SELECT value FROM json_each(?))
        ORDER BY created_at ASC, id ASC
      `)
      .all(normalizedConversationId, JSON.stringify(normalizedMessageIds));
  }

  deleteByIdsForConversation(conversationId: string, messageIds: string[]) {
    const normalizedMessageIds = normalizeMessageIds(messageIds);

    if (normalizedMessageIds.length === 0) {
      return 0;
    }

    return this.db
      .prepare(`
        DELETE FROM chat_messages
        WHERE conversation_id = ?
          AND id IN (SELECT value FROM json_each(?))
      `)
      .run(conversationId, JSON.stringify(normalizedMessageIds)).changes;
  }

  update(messageId: string, payload: any) {
    this.updateStatement.run(
      payload.content,
      payload.status,
      payload.taskId,
      payload.runId,
      payload.errorMessage || null,
      payload.metadataJson,
      messageId
    );

    return this.get(messageId);
  }

  appendText(messageId: string, delta: string) {
    this.appendTextStatement.run(delta, messageId);
    return this.get(messageId);
  }

  hasMessageSearchTable() {
    if (this.hasSearchTableCache !== null) {
      return this.hasSearchTableCache;
    }

    const row = this.db
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'chat_message_search'
        LIMIT 1
      `)
      .get();

    this.hasSearchTableCache = Boolean(row && row.name);
    return this.hasSearchTableCache;
  }

  ensureSearchFtsStatement() {
    if (this.searchFtsStatement) {
      return this.searchFtsStatement;
    }

    this.searchFtsStatement = this.db.prepare(`
      SELECT
        message_id,
        conversation_id,
        turn_id,
        role,
        agent_id,
        sender_name,
        content,
        status,
        created_at,
        snippet(chat_message_search, 6, '[', ']', '…', 18) AS snippet,
        bm25(chat_message_search) AS score
      FROM chat_message_search
      WHERE chat_message_search MATCH ?
        AND conversation_id = ?
        AND status = 'completed'
        AND content <> ''
        AND (? = '' OR sender_name = ? COLLATE NOCASE OR agent_id = ? COLLATE NOCASE)
        AND (? = '' OR agent_id = ? COLLATE NOCASE)
      ORDER BY score ASC, created_at DESC
      LIMIT ?
    `);

    return this.searchFtsStatement;
  }

  ensureSearchLikeStatement(termCount: number) {
    const normalizedTermCount = Number.isInteger(termCount) && termCount > 0 ? termCount : 0;
    const cached = this.searchLikeStatements.get(normalizedTermCount);

    if (cached) {
      return cached;
    }

    const termClauses = [];
    for (let index = 0; index < normalizedTermCount; index += 1) {
      termClauses.push(`
        (
          content LIKE ? ESCAPE '\\'
          OR sender_name LIKE ? ESCAPE '\\'
        )
      `);
    }

    const termClauseSql = termClauses.length > 0 ? `AND ${termClauses.join(' AND ')}` : '';
    const statement = this.db.prepare(`
      SELECT
        id AS message_id,
        conversation_id,
        turn_id,
        role,
        agent_id,
        sender_name,
        content,
        status,
        created_at,
        content AS snippet
      FROM chat_messages
      WHERE conversation_id = ?
        AND status = 'completed'
        AND content <> ''
        AND (? = '' OR sender_name = ? COLLATE NOCASE OR agent_id = ? COLLATE NOCASE)
        AND (? = '' OR agent_id = ? COLLATE NOCASE)
        ${termClauseSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `);

    this.searchLikeStatements.set(normalizedTermCount, statement);
    return statement;
  }

  searchWithLikeFallback(conversationId: string, query: string, limit: number, filters: any = {}) {
    const terms = query ? extractMessageSearchTerms(query) : [];
    const statement = this.ensureSearchLikeStatement(terms.length);
    const speaker = normalizeMessageSearchFilter(filters.speaker);
    const agentId = normalizeMessageSearchFilter(filters.agentId);
    const params: any[] = [conversationId, speaker, speaker, speaker, agentId, agentId];

    for (const term of terms) {
      const likePattern = `%${escapeLikePattern(term)}%`;
      params.push(likePattern, likePattern);
    }

    params.push(limit);
    return statement.all(...params);
  }

  searchByConversationId(conversationId: string, options: any = {}) {
    const query = normalizeMessageSearchQuery(options.query);
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 5;
    const filters = normalizeMessageSearchFilters(options);
    const diagnostics: any[] = [];

    if (!query && !hasMessageSearchFilters(filters)) {
      return {
        searchMode: 'unavailable',
        rows: [],
        filters,
        diagnostics: [{ code: 'query_required', message: 'query or speaker filter is required' }],
      };
    }

    const ftsQuery = buildFtsMatchQuery(query);
    if (ftsQuery && this.hasMessageSearchTable()) {
      try {
        const rows = this
          .ensureSearchFtsStatement()
          .all(ftsQuery, conversationId, filters.speaker, filters.speaker, filters.speaker, filters.agentId, filters.agentId, limit);
        if (rows.length > 0) {
          return {
            searchMode: 'fts5',
            rows,
            filters,
            diagnostics,
          };
        }

        diagnostics.push({
          code: 'fts5_no_match_fallback',
          message: 'FTS5 returned no results; using LIKE fallback',
        });
      } catch (error) {
        diagnostics.push({
          code: 'fts5_query_failed',
          message: error && (error as any).message ? String((error as any).message) : 'FTS5 query failed',
        });
      }
    } else if (query && !this.hasMessageSearchTable()) {
      diagnostics.push({
        code: 'fts5_unavailable',
        message: 'FTS5 search table is unavailable; using LIKE fallback',
      });
    }

    const rows = this.searchWithLikeFallback(conversationId, query, limit, filters);

    return {
      searchMode: query ? 'like' : 'filtered',
      rows,
      filters,
      diagnostics,
    };
  }
}

export function createChatMessageRepository(db: any) {
  return new ChatMessageRepository(db);
}
