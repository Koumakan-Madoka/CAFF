import { randomUUID } from 'node:crypto';
import { createHttpError } from '../../server/http/http-errors';

export type AttentionKind = 'proposal_pending' | 'budget_exhausted' | 'failure_paused'
  | 'owner_removed' | 'goal_completed' | 'turn_failed';
export type AttentionOccurrence = {
  conversationId: string;
  goalId: string | null;
  goalRevision: number;
  kind: AttentionKind;
  sourceId: string;
  summary: string;
  failedAgentIds?: string[];
  lane?: 'main' | 'side';
  createdAt: string;
};
export type AttentionQuery = { after?: number; limit?: number; conversationId?: string; status?: 'all' | 'unresolved' | 'resolved' };

function project(row: any) {
  if (!row) return null;
  return {
    sequence: Number(row.sequence), conversationId: row.conversation_id,
    goalId: row.goal_id, goalRevision: row.goal_revision, kind: row.kind,
    sourceId: row.source_id, summary: row.summary, createdAt: row.created_at,
    resolvedAt: row.resolved_at, resolution: row.resolution,
    ...(row.kind === 'turn_failed' ? { failedAgentIds: JSON.parse(row.failed_agent_ids_json || '["unknown"]'),
      ...(row.lane ? { lane: row.lane } : {}) } : {}),
    ...(row.resolved_by_json ? { resolvedBy: JSON.parse(row.resolved_by_json) } : {}),
  };
}

export function validateAttentionQuery(query: AttentionQuery = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw createHttpError(400, 'Invalid attention query', { code: 'attention_query_invalid' });
  }
  const { after = 0, limit = 100, conversationId, status = 'all' } = query;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || !['all', 'unresolved', 'resolved'].includes(status)
    || (conversationId !== undefined && (typeof conversationId !== 'string' || !conversationId.trim()))) {
    throw createHttpError(400, 'Invalid attention query', { code: 'attention_query_invalid' });
  }
  return { after, limit, conversationId, status };
}

// Occurrence data never changes. The only UPDATE is an unresolved -> resolved
// CAS. Callers compose transitions with Goal/ruling/task writes on this SAME db.
export function createPlannerAttentionRepository(db: any) {
  const get = db.prepare('SELECT * FROM chat_planner_attention WHERE sequence = ?');
  const getSource = db.prepare(`SELECT * FROM chat_planner_attention
    WHERE conversation_id = ? AND kind = ? AND source_id = ?`);
  const insert = db.prepare(`INSERT INTO chat_planner_attention
    (conversation_id, goal_id, goal_revision, kind, source_id, summary, created_at, failed_agent_ids_json, lane)
    VALUES (@conversationId, @goalId, @goalRevision, @kind, @sourceId, @summary, @createdAt, @failedAgentIdsJson, @lane)
    ON CONFLICT(conversation_id, kind, source_id) DO NOTHING`);
  const resolve = db.prepare(`UPDATE chat_planner_attention SET resolved_at=@at,
    resolution=@resolution, resolved_by_json=@principalJson, resolution_reason=@reason
    WHERE sequence=@sequence AND resolved_at IS NULL`);
  const watermark = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'chat_planner_attention'");
  const counts = db.prepare(`SELECT conversation_id, COUNT(*) AS count FROM chat_planner_attention
    WHERE resolved_at IS NULL GROUP BY conversation_id`);
  const resolveGoal = db.prepare(`UPDATE chat_planner_attention SET resolved_at=@at,
    resolution=@resolution, resolved_by_json='{"kind":"system"}'
    WHERE conversation_id=@conversationId AND goal_id=@goalId AND resolved_at IS NULL`);
  const resolveKind = db.prepare(`UPDATE chat_planner_attention SET resolved_at=@at,
    resolution=@resolution, resolved_by_json='{"kind":"system"}'
    WHERE conversation_id=@conversationId AND goal_id=@goalId AND kind=@kind AND resolved_at IS NULL`);
  const getCondition = db.prepare('SELECT goal_id, source_id FROM chat_planner_attention_conditions WHERE conversation_id=? AND kind=?');
  const putCondition = db.prepare(`INSERT INTO chat_planner_attention_conditions (conversation_id, kind, goal_id, source_id)
    VALUES (@conversationId, @kind, @goalId, @sourceId)
    ON CONFLICT(conversation_id, kind) DO UPDATE SET goal_id=excluded.goal_id, source_id=excluded.source_id`);
  const clearCondition = db.prepare('DELETE FROM chat_planner_attention_conditions WHERE conversation_id=? AND kind=?');
  const clearGoalConditions = db.prepare('DELETE FROM chat_planner_attention_conditions WHERE conversation_id=? AND goal_id=?');

  function append(input: AttentionOccurrence) {
    const old = getSource.get(input.conversationId, input.kind, input.sourceId);
    if (old) return project(old);
    const summary = Array.from(input.summary).slice(0, 500).join('');
    insert.run({ ...input, summary, failedAgentIdsJson: input.failedAgentIds ? JSON.stringify(input.failedAgentIds) : null,
      lane: input.lane || null });
    return project(getSource.get(input.conversationId, input.kind, input.sourceId));
  }

  function resolveItem(sequence: number, resolution: string, principal: any, at: string, reason: string | null = null) {
    resolve.run({ sequence, resolution, principalJson: JSON.stringify(principal), at, reason });
    return project(get.get(sequence));
  }

  const list = db.transaction((query: AttentionQuery = {}) => {
    const { after, limit, conversationId, status } = validateAttentionQuery(query);
    // Single SQLite snapshot for the page and watermark (including tombstoned
    // sequence gaps after Room deletion). Never derive the cursor from MAX(row).
    const highWatermark = Number(watermark.get()?.seq || 0);
    const rows = db.prepare(`SELECT * FROM chat_planner_attention
      WHERE sequence > @after AND sequence <= @highWatermark
      ${conversationId !== undefined ? 'AND conversation_id = @conversationId' : ''}
      ${status === 'unresolved' ? 'AND resolved_at IS NULL' : status === 'resolved' ? 'AND resolved_at IS NOT NULL' : ''}
      ORDER BY sequence LIMIT @take`).all({ after, highWatermark, conversationId: conversationId ?? null, take: limit + 1 });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(project);
    const nextCursor = hasMore ? items[items.length - 1].sequence : Math.max(after, highWatermark);
    return { items, nextCursor, highWatermark, hasMore };
  });

  return {
    // Checking first avoids burning AUTOINCREMENT values for unrelated Room
    // writes/reconciliation. The unique source constraint is the final guard.
    append,
    ensureCondition(input: Omit<AttentionOccurrence, 'sourceId'>) {
      const previous = getCondition.get(input.conversationId, input.kind);
      const sourceId = previous?.goal_id === input.goalId ? previous.source_id : `incident_${randomUUID()}`;
      if (!previous || previous.goal_id !== input.goalId) putCondition.run({ ...input, sourceId });
      return append({ ...input, sourceId });
    },
    clearCondition(conversationId: string, kind: AttentionKind) { clearCondition.run(conversationId, kind); },
    clearGoalConditions(conversationId: string, goalId: string) { clearGoalConditions.run(conversationId, goalId); },
    resolveKind(conversationId: string, goalId: string, kind: AttentionKind, resolution: string, at: string) {
      resolveKind.run({ conversationId, goalId, kind, resolution, at });
    },
    get(sequence: number) { return project(get.get(sequence)); },
    findSource(conversationId: string, kind: AttentionKind, sourceId: string) {
      return project(getSource.get(conversationId, kind, sourceId));
    },
    resolveGoal(conversationId: string, goalId: string, resolution: string, at: string) {
      resolveGoal.run({ conversationId, goalId, resolution, at });
    },
    resolveSuccessfulTurn(conversationId: string, goalId: string, lane: string, agentId: string, at: string) {
      if (!agentId || agentId === 'unknown') return;
      db.prepare(`UPDATE chat_planner_attention SET resolved_at=@at, resolution='turn_succeeded',
        resolved_by_json='{"kind":"system"}' WHERE conversation_id=@conversationId AND goal_id=@goalId
        AND kind='turn_failed' AND lane=@lane AND failed_agent_ids_json=@agentJson AND resolved_at IS NULL`)
        .run({ conversationId, goalId, lane, agentJson: JSON.stringify([agentId]), at });
    },
    resolve: resolveItem,
    acknowledge: db.transaction((sequence: number, input: any = {}) => {
      if (typeof input.reason !== 'string' || !input.reason.trim()) {
        throw createHttpError(400, 'Attention acknowledgement requires a reason', { code: 'attention_reason_required' });
      }
      const item = project(get.get(sequence));
      if (!item) throw createHttpError(404, 'Attention item not found', { code: 'attention_not_found' });
      if (item.resolvedAt) return item;
      if (!['goal_completed', 'turn_failed'].includes(item.kind)) {
        throw createHttpError(409, 'Handle the underlying attention condition first', { code: 'attention_condition_active' });
      }
      return resolveItem(sequence, 'acknowledged', input.principal, new Date().toISOString(), input.reason.trim());
    }),
    list,
    counts() { return Object.fromEntries(counts.all().map((row: any) => [row.conversation_id, Number(row.count)])); },
  };
}
