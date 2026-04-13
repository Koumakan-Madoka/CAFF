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

export class ChatMessageRepository {
  db: any;
  insertStatement: any;
  listByConversationStatement: any;
  getStatement: any;
  updateStatement: any;
  appendTextStatement: any;
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
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.listByConversationStatement = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
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
      payload.createdAt
    );

    return this.get(payload.id);
  }

  listByConversationId(conversationId: string) {
    return this.listByConversationStatement.all(conversationId);
  }

  get(messageId: string) {
    return this.getStatement.get(messageId);
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
