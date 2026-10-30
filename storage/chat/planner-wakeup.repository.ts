import { randomUUID } from 'node:crypto';
import { createHttpError } from '../../server/http/http-errors';
import { EmbeddedPlannerRepository } from './embedded-planner.repository';
export const WAKEUP_KINDS = ['proposal_pending', 'budget_exhausted', 'failure_paused', 'owner_removed', 'turn_failed'];
const terminal = ['succeeded', 'needs_user', 'unresolved', 'unknown', 'failed', 'interrupted'];
function error(status: number, code: string): never { throw createHttpError(status, 'Planner wake-up request rejected', { code }); }
export function validateWakeupItems(items: any) {
  if (!Array.isArray(items) || !items.length || items.length > 100)
    error(400, 'planner_wakeup_receipt_invalid');
  const seen = new Set<number>();
  return items.map((item: any) => {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join() !== 'disposition,reason,sequence' || !Number.isSafeInteger(item.sequence) || item.sequence < 1
      || seen.has(item.sequence) || !['handled', 'needs_user', 'no_action'].includes(item.disposition) || typeof item.reason !== 'string' || !item.reason.trim()
      || [...item.reason].length > 500 || /[\p{Cc}\u2028\u2029]/u.test(item.reason) || Buffer.from(item.reason).toString('utf8') !== item.reason)
      error(400, 'planner_wakeup_receipt_invalid');
    seen.add(item.sequence);
    return { sequence: item.sequence, disposition: item.disposition, reason: item.reason };
  }).sort((a: any, b: any) => a.sequence - b.sequence);
}
function project(r: any): any {
  if (!r)
    return null;
  return { sequence: r.sequence, id: r.id, conversationId: r.conversation_id, goalId: r.goal_id, goalRevision: r.goal_revision, source: r.source, status: r.status,
    reservedAt: new Date(r.reserved_at).toISOString(), startedAt: r.started_at === null ? null : new Date(r.started_at).toISOString(), finishedAt: r.finished_at === null ? null : new Date(r.finished_at).toISOString(),
    reasonCode: r.reason_code, exitCode: r.exit_code, summary: r.summary, retainedBytes: r.transcript_expired ? 0 : r.retained_bytes, droppedBytes: r.dropped_bytes, truncated: r.dropped_bytes > 0, transcriptExpired: !!r.transcript_expired };
}
export class PlannerWakeupRepository {
  private db: any;
  private sessions: EmbeddedPlannerRepository;
  private now: () => number;
  private redact: (text: string) => string;
  constructor(private store: any, options: {
    now?: () => number;
    redact?: (text: string) => string;
  } = {}) {
    this.db = store.db;
    this.sessions = new EmbeddedPlannerRepository(store);
    this.now = options.now || Date.now;
    this.redact = options.redact || (s => s);
    this.db.exec(`CREATE TABLE IF NOT EXISTS chat_planner_wakeups (
   sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
   goal_id TEXT NOT NULL,goal_revision INTEGER NOT NULL,session_id TEXT NOT NULL,source TEXT NOT NULL,reserved_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,
   status TEXT NOT NULL,reason_code TEXT,exit_code INTEGER,receipt_json TEXT,summary TEXT NOT NULL DEFAULT '',next_chunk INTEGER NOT NULL DEFAULT 0,
   total_bytes INTEGER NOT NULL DEFAULT 0,retained_bytes INTEGER NOT NULL DEFAULT 0,head_bytes INTEGER NOT NULL DEFAULT 0,dropped_bytes INTEGER NOT NULL DEFAULT 0,transcript_expired INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS chat_planner_wakeups_quota ON chat_planner_wakeups(conversation_id,reserved_at);
   CREATE INDEX IF NOT EXISTS chat_planner_wakeups_page ON chat_planner_wakeups(conversation_id,sequence);
   CREATE TABLE IF NOT EXISTS chat_planner_wakeup_items (
   attempt_id TEXT NOT NULL REFERENCES chat_planner_wakeups(id) ON DELETE CASCADE,conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
   goal_id TEXT NOT NULL,attention_sequence INTEGER NOT NULL,disposition TEXT,reason TEXT,
   PRIMARY KEY(attempt_id,attention_sequence),UNIQUE(conversation_id,goal_id,attention_sequence));
   CREATE TABLE IF NOT EXISTS chat_planner_wakeup_chunks (
   attempt_id TEXT NOT NULL REFERENCES chat_planner_wakeups(id) ON DELETE CASCADE,sequence INTEGER NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,bytes INTEGER NOT NULL,head INTEGER NOT NULL,
   PRIMARY KEY(attempt_id,sequence));`);
  }
  context(roomId: string): any {
    const room = this.store.getConversationWithoutMessages(roomId);
    if (!room)
      return null;
    const m = room.metadata || {}, goal = m.sessionGoal, meta = this.sessions.read(roomId), b = m.sessionGoalPlannerBinding;
    if (!meta?.wakeupsEnabled || !meta.launchAttempted || !goal?.goalId || !['active', 'paused'].includes(goal.status) || m.dagNodeGoalBinding
      || b?.goalId !== goal.goalId || b?.plannerId !== 'local-planner')
      return null;
    return { room, goal, metadata: meta };
  }
  toggle(roomId: string, enabled: boolean) {
    if (typeof enabled !== 'boolean')
      error(400, 'planner_wakeup_toggle_invalid');
    return this.db.transaction(() => {
      const old = this.sessions.read(roomId);
      const meta = old || { version: 1, sessionId: randomUUID(), launchAttempted: false, wakeupsEnabled: false };
      this.db.prepare("UPDATE chat_conversations SET metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.embeddedPlanner',json(?)) WHERE id=?").run(JSON.stringify({ ...meta, wakeupsEnabled: enabled }), roomId);
      return { enabled };
    }).immediate();
  }
  rooms(after = '', limit = 100): string[] {
    return this.db.prepare("SELECT id FROM chat_conversations WHERE id>? AND json_extract(metadata_json,'$.embeddedPlanner.wakeupsEnabled')=1 ORDER BY id LIMIT ?").all(after, limit).map((r: any) => r.id);
  }
  quota(roomId: string) {
    const r = this.db.prepare('SELECT count(*) AS n,min(reserved_at) AS first FROM chat_planner_wakeups WHERE conversation_id=? AND reserved_at>=?').get(roomId, this.now() - 3600000);
    return { used: r.n, limit: 4, nextEligibleAt: r.n >= 4 ? new Date(r.first + 3600001).toISOString() : null };
  }
  pending(roomId: string, goalId: string, limit = 100): any[] {
    return this.db.prepare(`SELECT a.* FROM chat_planner_attention a WHERE a.conversation_id=? AND a.goal_id=? AND a.resolved_at IS NULL
   AND a.kind IN ('proposal_pending','budget_exhausted','failure_paused','owner_removed','turn_failed')
   AND NOT EXISTS(SELECT 1 FROM chat_planner_wakeup_items i WHERE i.conversation_id=a.conversation_id AND i.goal_id=a.goal_id AND i.attention_sequence=a.sequence)
   ORDER BY a.sequence LIMIT ?`).all(roomId, goalId, limit).map((r: any) => ({ sequence: r.sequence, goalId: r.goal_id, goalRevision: r.goal_revision, kind: r.kind, sourceId: r.source_id, summary: [...r.summary].slice(0, 500).join(''), createdAt: r.created_at,
      ...(r.failed_agent_ids_json ? { failedAgentIds: JSON.parse(r.failed_agent_ids_json) } : {}), ...(r.lane ? { lane: r.lane } : {}) }));
  }
  counts(roomId: string, goalId: string | null) {
    const pendingCount = goalId ? this.db.prepare('SELECT count(*) AS n FROM chat_planner_attention WHERE conversation_id=? AND goal_id=? AND resolved_at IS NULL').get(roomId, goalId).n : 0;
    const needsUserCount = goalId ? this.db.prepare("SELECT count(*) AS n FROM chat_planner_wakeup_items i JOIN chat_planner_attention a ON a.sequence=i.attention_sequence WHERE i.conversation_id=? AND i.goal_id=? AND a.resolved_at IS NULL AND i.disposition='needs_user'").get(roomId, goalId).n : 0;
    return { pendingCount, needsUserCount };
  }
  reserve(roomId: string, source: 'live' | 'catch_up', selected?: number[]) {
    return this.db.transaction(() => {
      const c = this.context(roomId);
      if (!c || this.quota(roomId).used >= 4 || this.db.prepare("SELECT 1 FROM chat_planner_wakeups WHERE conversation_id=? AND status IN ('reserved','running')").get(roomId))
        return null;
      let items = this.pending(roomId, c.goal.goalId);
      if (selected)
        items = items.filter(i => selected.includes(i.sequence));
      if (!items.length)
        return null;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO chat_planner_wakeups(id,conversation_id,goal_id,goal_revision,session_id,source,reserved_at,status) VALUES(?,?,?,?,?,?,?,'reserved')`).run(id, roomId, c.goal.goalId, c.goal.revision, c.metadata.sessionId, source, this.now());
      const insert = this.db.prepare('INSERT INTO chat_planner_wakeup_items(attempt_id,conversation_id,goal_id,attention_sequence) VALUES(?,?,?,?)');
      for (const item of items)
        insert.run(id, roomId, c.goal.goalId, item.sequence);
      return { ...this.get(roomId, id), sessionId: c.metadata.sessionId, items };
    }).immediate();
  }
  start(id: string) { this.db.prepare("UPDATE chat_planner_wakeups SET status='running',started_at=? WHERE id=? AND status='reserved'").run(this.now(), id); }
  get(roomId: string, id: string) { return project(this.db.prepare('SELECT * FROM chat_planner_wakeups WHERE id=? AND conversation_id=?').get(id, roomId)); }
  finish(roomId: string, id: string, input: any) {
    const items = validateWakeupItems(input).map((i: any) => ({ ...i, reason: this.redact(i.reason) }));
    const canonical = JSON.stringify(items);
    return this.db.transaction(() => {
      const a = this.db.prepare('SELECT * FROM chat_planner_wakeups WHERE id=? AND conversation_id=?').get(id, roomId);
      if (!a)
        error(404, 'planner_wakeup_not_found');
      const expected = this.db.prepare('SELECT * FROM chat_planner_wakeup_items WHERE attempt_id=? ORDER BY attention_sequence').all(id);
      if (items.length !== expected.length || items.some((v: any, i: number) => v.sequence !== expected[i].attention_sequence))
        error(400, 'planner_wakeup_membership_invalid');
      if (a.receipt_json && a.receipt_json !== canonical)
        error(409, 'planner_wakeup_receipt_conflict');
      if (!a.receipt_json) {
        if (a.status !== 'running')
          error(409, 'planner_wakeup_not_active');
        for (const item of items) {
          const row = this.db.prepare('SELECT resolved_at FROM chat_planner_attention WHERE sequence=? AND conversation_id=? AND goal_id=?').get(item.sequence, roomId, a.goal_id);
          const disposition = item.disposition === 'handled' && !row?.resolved_at ? 'unresolved' : item.disposition;
          this.db.prepare('UPDATE chat_planner_wakeup_items SET disposition=?,reason=? WHERE attempt_id=? AND attention_sequence=?').run(disposition, item.reason, id, item.sequence);
        }
        this.db.prepare('UPDATE chat_planner_wakeups SET receipt_json=? WHERE id=?').run(canonical, id);
        const result = this.db.prepare('SELECT attention_sequence AS sequence,disposition,reason FROM chat_planner_wakeup_items WHERE attempt_id=? ORDER BY attention_sequence').all(id);
        this.append(id, 'receipt', JSON.stringify({ items: result }));
      }
      return { items: this.db.prepare('SELECT attention_sequence AS sequence,disposition,reason FROM chat_planner_wakeup_items WHERE attempt_id=? ORDER BY attention_sequence').all(id) };
    }).immediate();
  }
  end(id: string, outcome: {
    exitCode?: number | null;
    resultSeen?: boolean;
    reasonCode?: string;
  }) {
    this.db.transaction(() => {
      const a = this.db.prepare('SELECT * FROM chat_planner_wakeups WHERE id=?').get(id);
      if (!a || terminal.includes(a.status))
        return;
      const items = this.db.prepare('SELECT disposition FROM chat_planner_wakeup_items WHERE attempt_id=?').all(id);
      const missing = outcome.reasonCode === 'planner_session_unavailable';
      if (missing)
        this.db.prepare("UPDATE chat_planner_wakeup_items SET disposition='needs_user',reason='Session may be unavailable; user recovery required' WHERE attempt_id=? AND disposition IS NULL").run(id);
      const status = missing ? 'needs_user' : outcome.reasonCode === 'planner_wakeup_interrupted' ? 'interrupted' : outcome.reasonCode || outcome.exitCode !== 0 ? 'failed' : !outcome.resultSeen || !a.receipt_json ? 'unknown' : items.some((i: any) => i.disposition === 'needs_user') ? 'needs_user' : items.some((i: any) => i.disposition !== 'handled') ? 'unresolved' : 'succeeded';
      this.db.prepare('UPDATE chat_planner_wakeups SET status=?,reason_code=?,exit_code=?,finished_at=?,summary=? WHERE id=?').run(status, outcome.reasonCode || null, outcome.exitCode ?? null, this.now(), `${status}; ${items.length} attention items`, id);
    }).immediate();
  }
  interrupt() { this.db.prepare("UPDATE chat_planner_wakeups SET status='interrupted',reason_code='planner_wakeup_interrupted',finished_at=?,summary='Interrupted by server restart' WHERE status IN ('reserved','running')").run(this.now()); }
  append(id: string, kind: string, text: string) {
    text = this.redact(text);
    this.db.transaction(() => {
      const a = this.db.prepare('SELECT * FROM chat_planner_wakeups WHERE id=?').get(id);
      if (!a || a.transcript_expired)
        return;
      let part = '', size = 0, head = a.head_bytes, seq = a.next_chunk, total = a.total_bytes, retained = a.retained_bytes;
      const flush = () => {
        if (!part) return;
        const isHead = total + size <= 65536;
        this.db.prepare('INSERT INTO chat_planner_wakeup_chunks(attempt_id,sequence,kind,text,bytes,head) VALUES(?,?,?,?,?,?)').run(id, ++seq, kind, part, size, isHead ? 1 : 0);
        total += size;
        retained += size;
        if (isHead) head += size;
        part = '';
        size = 0;
      };
      for (const char of text) {
        const n = Buffer.byteLength(char), limit = Math.min(8192, total < 65536 ? 65536 - total : 8192);
        if (size + n > limit)
          flush();
        part += char;
        size += n;
        if (size >= Math.min(8192, total < 65536 ? 65536 - total : 8192))
          flush();
      }
      flush();
      while (retained - head > 983040) {
        const old = this.db.prepare('SELECT sequence,bytes FROM chat_planner_wakeup_chunks WHERE attempt_id=? AND head=0 ORDER BY sequence LIMIT 1').get(id);
        if (!old)
          break;
        this.db.prepare('DELETE FROM chat_planner_wakeup_chunks WHERE attempt_id=? AND sequence=?').run(id, old.sequence);
        retained -= old.bytes;
      }
      this.db.prepare('UPDATE chat_planner_wakeups SET next_chunk=?,head_bytes=?,total_bytes=?,retained_bytes=?,dropped_bytes=? WHERE id=?').run(seq, head, total, retained, total - retained, id);
    }).immediate();
  }
  list(roomId: string, before = Number.MAX_SAFE_INTEGER, limit = 20) {
    return this.db.transaction(() => { const rows = this.db.prepare('SELECT * FROM chat_planner_wakeups WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(roomId, before, limit + 1); const items = rows.slice(0, limit).map(project); return { items, hasMore: rows.length > limit, nextBefore: items.length ? items[items.length - 1].sequence : null }; })();
  }
  detail(roomId: string, id: string, after = 0, limit = 50) {
    return this.db.transaction(() => {
      const summary = this.get(roomId, id);
      if (!summary)
        error(404, 'planner_wakeup_not_found');
      const rows = summary.transcriptExpired ? [] : this.db.prepare('SELECT sequence,kind,text FROM chat_planner_wakeup_chunks WHERE attempt_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id, after, limit + 1);
      const chunks: any[] = [];
      let bytes = Buffer.byteLength(JSON.stringify(summary)) + 1024;
      for (const r of rows.slice(0, limit)) {
        const n = Buffer.byteLength(JSON.stringify(r));
        if (bytes + n > 126000)
          break;
        chunks.push(r);
        bytes += n;
      }
      return { summary, chunks, nextAfter: chunks.length ? chunks[chunks.length - 1].sequence : after, hasMore: rows.length > chunks.length, truncated: summary.truncated, transcriptExpired: summary.transcriptExpired };
    })();
  }
  cleanup() {
    const cutoff = this.now() - 30 * 86400000;
    this.db.transaction(() => {
      this.db.prepare('UPDATE chat_planner_wakeups SET transcript_expired=1 WHERE id IN (SELECT id FROM chat_planner_wakeups WHERE finished_at<? AND transcript_expired=0 LIMIT 20)').run(cutoff);
      this.db.prepare('DELETE FROM chat_planner_wakeup_chunks WHERE rowid IN (SELECT c.rowid FROM chat_planner_wakeup_chunks c JOIN chat_planner_wakeups a ON a.id=c.attempt_id WHERE a.transcript_expired=1 LIMIT 100)').run();
    }).immediate();
  }
}
