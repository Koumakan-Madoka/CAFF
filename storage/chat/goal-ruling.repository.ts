import { createHash } from 'node:crypto';

// Stable JSON makes idempotence independent of property insertion order. Never
// normalize legacy principals: absence/unknown attribution must stay absence.
function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createGoalRulingRepository(db: any) {
  const insert = db.prepare(`INSERT INTO chat_goal_rulings
    (id, conversation_id, goal_id, goal_revision, outcome, ruled_at, ruling_json)
    VALUES (@id, @conversationId, @goalId, @goalRevision, @outcome, @ruledAt, @rulingJson)
    ON CONFLICT(id) DO NOTHING`);
  const get = db.prepare('SELECT conversation_id, ruling_json FROM chat_goal_rulings WHERE id = ?');
  const list = db.prepare('SELECT ruling_json FROM chat_goal_rulings WHERE conversation_id = ? ORDER BY sequence LIMIT ?');
  function append(conversationId: string, metadata: any, legacyStage = '') {
    const ruling = metadata?.sessionGoalRuling;
    const snapshot = ruling?.proposalSnapshot || ruling?.proposal_snapshot;
    const proposalId = ruling?.proposalId || ruling?.proposal_id;
    if (!ruling || !['accepted', 'rejected', 'superseded'].includes(ruling.outcome)
      || !proposalId || snapshot?.id !== proposalId
      || !['set', 'revise', 'pause', 'resume', 'complete', 'clear'].includes(ruling.action)
      || !snapshot || snapshot.action !== ruling.action || !(ruling.ruledAt || ruling.ruled_at)) return;
    const rulingJson = stableJson(ruling);
    const id = typeof ruling.id === 'string' && ruling.id.trim() ? ruling.id
      : `legacy_ruling_${createHash('sha256').update(conversationId + '\0' + rulingJson).digest('hex')}`;
    const existing = get.get(id);
    if (existing) {
      if (existing.conversation_id !== conversationId || existing.ruling_json !== rulingJson) {
        if (!legacyStage) throw new Error('Goal ruling history identity cannot be overwritten');
        // Only an already-present legacy snapshot may be skipped. Do not log
        // its contents or catch database failures. New rulings stay strict.
        console.warn(JSON.stringify({ code: 'goal_ruling_legacy_conflict', stage: legacyStage, conversationId }));
      }
      return;
    }
    const goal = metadata?.sessionGoal;
    insert.run({ id, conversationId,
      goalId: Object.hasOwn(ruling, 'goalId') ? ruling.goalId : goal?.goalId || null,
      goalRevision: Object.hasOwn(ruling, 'goalRevision') ? ruling.goalRevision : Number(goal?.revision || 0),
      outcome: ruling.outcome, ruledAt: ruling.ruledAt || ruling.ruled_at, rulingJson });
    const stored = get.get(id);
    if (stored.conversation_id !== conversationId || stored.ruling_json !== rulingJson) {
      throw new Error('Goal ruling history identity cannot be overwritten');
    }
  }
  return {
    append(conversationId: string, metadata: any) { append(conversationId, metadata); },
    archiveTransition(conversationId: string, previousMetadata: any, nextMetadata: any) {
      // An unchanged legacy/anomalous projection is not a new ruling. Apart
      // from avoiding duplicate inserts, this keeps unrelated Room writes
      // usable without letting an explicitly changed record overwrite history.
      if (stableJson(previousMetadata?.sessionGoalRuling) === stableJson(nextMetadata?.sessionGoalRuling)) return;
      append(conversationId, previousMetadata, 'previous_snapshot');
      append(conversationId, nextMetadata);
    },
    list(conversationId: string, limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid Goal ruling history limit');
      return list.all(conversationId, limit).map((row: any) => JSON.parse(row.ruling_json));
    },
    backfill() {
      db.transaction(() => {
        // Metadata-only upgrade: no message bodies and no historical replay.
        const page = db.prepare('SELECT id, metadata_json FROM chat_conversations WHERE id > ? ORDER BY id LIMIT 100');
        let after = '';
        for (;;) {
          // Finish each SELECT before writing (better-sqlite3 disallows
          // writes during an active iterator); cap the in-memory batch.
          const rows = page.all(after);
          if (rows.length === 0) break;
          for (const row of rows) {
            let metadata;
            try { metadata = JSON.parse(row.metadata_json || '{}'); } catch { continue; }
            append(row.id, metadata, 'backfill');
          }
          after = rows[rows.length - 1].id;
        }
      })();
    },
  };
}
