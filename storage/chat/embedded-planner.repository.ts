import { randomUUID } from 'node:crypto';
import { plannerError } from '../../server/domain/runtime/embedded-planner-env';

export type EmbeddedPlannerMetadata = { version: 1; sessionId: string; launchAttempted: boolean; wakeupsEnabled: boolean };
const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Only constructed when the feature is enabled. A durable lease is an uncertainty
// fence, not a PID lease: never kill/reuse an old PID after a crash. An orphaned
// lease requires user-assisted verification/repair; a fresh map is not evidence.
export class EmbeddedPlannerRepository {
  constructor(private store: any) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS chat_embedded_planner_leases (
      conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE, lease_id TEXT NOT NULL UNIQUE
    )`);
  }
  read(roomId: string): EmbeddedPlannerMetadata | null {
    const room = this.store.getConversationWithoutMessages(roomId);
    if (!room) throw plannerError('planner_room_missing');
    const meta = room.metadata?.embeddedPlanner;
    if (meta === undefined) return null;
    if (!meta || meta.version !== 1 || !validUuid.test(meta.sessionId) || typeof meta.launchAttempted !== 'boolean'
      || typeof meta.wakeupsEnabled !== 'boolean') throw plannerError('planner_session_unavailable');
    return meta;
  }
  pendingCount(roomId: string, goalId: string | null): number {
    return this.store.db.prepare('SELECT count(*) AS n FROM chat_planner_attention WHERE conversation_id=? AND goal_id=? AND resolved_at IS NULL')
      .get(roomId, goalId || '').n;
  }
  leaseCount(): number { return this.store.db.prepare('SELECT count(*) AS n FROM chat_embedded_planner_leases').get().n; }
  hasLease(roomId: string): boolean { return !!this.store.db.prepare('SELECT 1 FROM chat_embedded_planner_leases WHERE conversation_id=?').get(roomId); }
  claim(roomId: string): { metadata: EmbeddedPlannerMetadata; first: boolean; leaseId: string } {
    return this.store.db.transaction(() => {
      if (this.hasLease(roomId)) throw plannerError('planner_process_exit_unconfirmed');
      const previous = this.read(roomId);
      const meta: EmbeddedPlannerMetadata = previous || { version: 1, sessionId: randomUUID(), launchAttempted: false, wakeupsEnabled: false };
      const first = !meta.launchAttempted;
      const metadata = { ...meta, launchAttempted: true };
      // json_set modifies only this namespace, preserving current Goal/workspace.
      this.store.db.prepare("UPDATE chat_conversations SET metadata_json=json_set(COALESCE(metadata_json,'{}'), '$.embeddedPlanner', json(?)) WHERE id=?")
        .run(JSON.stringify(metadata), roomId);
      const leaseId = randomUUID();
      this.store.db.prepare('INSERT INTO chat_embedded_planner_leases VALUES (?,?,?)').run(roomId, metadata.sessionId, leaseId);
      return { metadata, first, leaseId };
    })();
  }
  release(roomId: string, leaseId: string): void {
    this.store.db.prepare('DELETE FROM chat_embedded_planner_leases WHERE conversation_id=? AND lease_id=?').run(roomId, leaseId);
  }
}
