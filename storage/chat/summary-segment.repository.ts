const {
  escapeSummaryMemoryLikePattern,
  extractSummaryMemorySearchTerms,
  normalizeSummaryMemorySearchQuery,
} = require('../../lib/summary-memory-query');

function normalizeSummarySearchQuery(value: any) {
  return normalizeSummaryMemorySearchQuery(value);
}

function extractSummarySearchTerms(value: any) {
  return extractSummaryMemorySearchTerms(value, { maxTerms: 8 });
}

function escapeLikePattern(value: any) {
  return escapeSummaryMemoryLikePattern(value);
}

export class ChatSummarySegmentRepository {
  db: any;
  upsertStatement: any;
  getBySourceDigestIdStatement: any;
  deleteBySourceDigestIdStatement: any;
  deleteByConversationIdStatement: any;
  healthStatement: any;
  latestStatement: any;
  searchStatements: Map<string, any>;

  constructor(db: any) {
    this.db = db;
    this.upsertStatement = db.prepare(`
      INSERT INTO chat_summary_segments (
        id,
        conversation_id,
        source_digest_id,
        source_kind,
        conversation_title,
        task_name,
        summary,
        facts_json,
        decisions_json,
        open_questions_json,
        next_actions_json,
        artifacts_json,
        trigger_reason,
        message_count,
        from_message_id,
        to_message_id,
        created_by,
        segment_created_at,
        segment_updated_at,
        metadata_json,
        search_text,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_digest_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        source_kind = excluded.source_kind,
        conversation_title = excluded.conversation_title,
        task_name = excluded.task_name,
        summary = excluded.summary,
        facts_json = excluded.facts_json,
        decisions_json = excluded.decisions_json,
        open_questions_json = excluded.open_questions_json,
        next_actions_json = excluded.next_actions_json,
        artifacts_json = excluded.artifacts_json,
        trigger_reason = excluded.trigger_reason,
        message_count = excluded.message_count,
        from_message_id = excluded.from_message_id,
        to_message_id = excluded.to_message_id,
        created_by = excluded.created_by,
        segment_created_at = excluded.segment_created_at,
        segment_updated_at = excluded.segment_updated_at,
        metadata_json = excluded.metadata_json,
        search_text = excluded.search_text,
        updated_at = excluded.updated_at
    `);
    this.getBySourceDigestIdStatement = db.prepare(`
      SELECT *
      FROM chat_summary_segments
      WHERE source_digest_id = ?
      LIMIT 1
    `);
    this.deleteBySourceDigestIdStatement = db.prepare(`
      DELETE FROM chat_summary_segments
      WHERE source_digest_id = ?
    `);
    this.deleteByConversationIdStatement = db.prepare(`
      DELETE FROM chat_summary_segments
      WHERE conversation_id = ?
    `);
    this.healthStatement = db.prepare(`
      SELECT
        COUNT(*) AS segment_count,
        MAX(segment_updated_at) AS latest_segment_updated_at
      FROM chat_summary_segments
    `);
    this.latestStatement = db.prepare(`
      SELECT *
      FROM chat_summary_segments
      ORDER BY segment_updated_at DESC, updated_at DESC, id DESC
      LIMIT 1
    `);
    this.searchStatements = new Map();
  }

  upsert(payload: any) {
    this.upsertStatement.run(
      payload.id,
      payload.conversationId,
      payload.sourceDigestId,
      payload.sourceKind,
      payload.conversationTitle,
      payload.taskName,
      payload.summary,
      payload.factsJson,
      payload.decisionsJson,
      payload.openQuestionsJson,
      payload.nextActionsJson,
      payload.artifactsJson,
      payload.triggerReason || null,
      payload.messageCount || 0,
      payload.fromMessageId || null,
      payload.toMessageId || null,
      payload.createdBy || null,
      payload.segmentCreatedAt,
      payload.segmentUpdatedAt,
      payload.metadataJson,
      payload.searchText,
      payload.createdAt,
      payload.updatedAt
    );

    return this.getBySourceDigestId(payload.sourceDigestId);
  }

  getBySourceDigestId(sourceDigestId: string) {
    return this.getBySourceDigestIdStatement.get(sourceDigestId);
  }

  deleteBySourceDigestId(sourceDigestId: string) {
    this.deleteBySourceDigestIdStatement.run(sourceDigestId);
  }

  deleteByConversationId(conversationId: string) {
    this.deleteByConversationIdStatement.run(conversationId);
  }

  getHealthSnapshot() {
    const row = this.healthStatement.get() || {};
    const latest = this.latestStatement.get() || null;

    return {
      tableExists: true,
      segmentCount: Number(row.segment_count || 0),
      latestSegmentUpdatedAt: row.latest_segment_updated_at || '',
      latestSegment: latest,
    };
  }

  ensureSearchStatement(termCount: number, excludeConversation: boolean, filterTaskName: boolean, filterSourceKind: boolean, filterConversationTitle: boolean, filterUpdatedAfter: boolean, filterUpdatedBefore: boolean) {
    const normalizedTermCount = Number.isInteger(termCount) && termCount > 0 ? termCount : 0;
    const key = [
      normalizedTermCount,
      excludeConversation ? 'exclude' : 'all',
      filterTaskName ? 'task' : 'any-task',
      filterSourceKind ? 'kind' : 'any-kind',
      filterConversationTitle ? 'title' : 'any-title',
      filterUpdatedAfter ? 'updated-after' : 'any-start',
      filterUpdatedBefore ? 'updated-before' : 'any-end',
    ].join(':');
    const cached = this.searchStatements.get(key);

    if (cached) {
      return cached;
    }

    const scoreClauses = [];
    const matchClauses = [];
    for (let index = 0; index < normalizedTermCount; index += 1) {
      scoreClauses.push(`CASE WHEN search_text LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END`);
      matchClauses.push(`search_text LIKE ? ESCAPE '\\'`);
    }

    const scoreSql = scoreClauses.length > 0 ? `(${scoreClauses.join(' + ')}) AS score` : `0 AS score`;
    const termClauseSql = matchClauses.length > 0 ? `AND (${matchClauses.join(' OR ')})` : '';
    const excludeClauseSql = excludeConversation ? `AND conversation_id <> ?` : '';
    const taskClauseSql = filterTaskName ? `AND task_name LIKE ? ESCAPE '\\'` : '';
    const sourceKindClauseSql = filterSourceKind ? `AND source_kind = ?` : '';
    const conversationTitleClauseSql = filterConversationTitle ? `AND conversation_title LIKE ? ESCAPE '\\'` : '';
    const updatedAfterClauseSql = filterUpdatedAfter ? `AND segment_updated_at >= ?` : '';
    const updatedBeforeClauseSql = filterUpdatedBefore ? `AND segment_updated_at <= ?` : '';
    const statement = this.db.prepare(`
      SELECT *, ${scoreSql}
      FROM chat_summary_segments
      WHERE summary <> ''
        ${excludeClauseSql}
        ${taskClauseSql}
        ${sourceKindClauseSql}
        ${conversationTitleClauseSql}
        ${updatedAfterClauseSql}
        ${updatedBeforeClauseSql}
        ${termClauseSql}
      ORDER BY score DESC, segment_updated_at DESC, updated_at DESC, id DESC
      LIMIT ?
    `);

    this.searchStatements.set(key, statement);
    return statement;
  }

  search(options: any = {}) {
    const query = normalizeSummarySearchQuery(options.query);
    const terms: string[] = extractSummarySearchTerms(query);
    const requestedLimit = Number.parseInt(String(options.limit || ''), 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 15) : 5;
    const excludeConversationId = String(options.excludeConversationId || '').trim();
    const taskName = normalizeSummarySearchQuery(options.taskName || options.task);
    const sourceKind = String(options.sourceKind || options.kind || '').trim();
    const conversationTitle = normalizeSummarySearchQuery(options.conversationTitle || options.title || options.conversation);
    const updatedAfter = String(options.updatedAfter || options.since || options.from || options.fromDate || '').trim();
    const updatedBefore = String(options.updatedBefore || options.until || options.to || options.toDate || '').trim();
    const statement = this.ensureSearchStatement(terms.length, Boolean(excludeConversationId), Boolean(taskName), Boolean(sourceKind), Boolean(conversationTitle), Boolean(updatedAfter), Boolean(updatedBefore));
    const termPatterns = terms.map((term) => `%${escapeLikePattern(term)}%`);
    const params: any[] = [...termPatterns];

    if (excludeConversationId) {
      params.push(excludeConversationId);
    }

    if (taskName) {
      params.push(`%${escapeLikePattern(taskName)}%`);
    }

    if (sourceKind) {
      params.push(sourceKind);
    }

    if (conversationTitle) {
      params.push(`%${escapeLikePattern(conversationTitle)}%`);
    }

    if (updatedAfter) {
      params.push(updatedAfter);
    }

    if (updatedBefore) {
      params.push(updatedBefore);
    }

    params.push(...termPatterns);
    params.push(limit);

    return {
      query,
      terms,
      searchMode: terms.length > 0 ? 'like_scored_or' : 'like_latest',
      rows: statement.all(...params),
      diagnostics: query ? [] : [{ code: 'query_empty', message: 'No query terms were provided; returning latest summary segments' }],
    };
  }
}

export function createChatSummarySegmentRepository(db: any) {
  return new ChatSummarySegmentRepository(db);
}
