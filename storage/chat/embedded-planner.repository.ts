import { randomUUID } from 'node:crypto';
import { plannerError } from '../../server/domain/runtime/embedded-planner-env';
import { migrateEmbeddedPlannerLeaseSchema } from '../sqlite/migrations';

export type EmbeddedPlannerMetadata = { version: 1; sessionId: string; launchAttempted: boolean; wakeupsEnabled: boolean };
const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validPlannerGuardianPid(pid: unknown): pid is number {
  return Number.isSafeInteger(pid) && Number(pid) > 0 && Number(pid) <= 0x7fffffff;
}

// Only constructed when enabled. PID is absence evidence only, never permission
// to kill. Live/reused, unknown and pre-migration PID leases remain fenced.
export class EmbeddedPlannerRepository {
  constructor(private store: any) { migrateEmbeddedPlannerLeaseSchema(store.db); }

  recordGuardian(roomId: string, leaseId: string, pid: number): void {
    if (!validPlannerGuardianPid(pid)) throw plannerError('planner_process_exit_unconfirmed');
    const result = this.store.db.prepare(`UPDATE chat_embedded_planner_leases SET guardian_pid=?
      WHERE conversation_id=? AND lease_id=? AND (guardian_pid IS NULL OR guardian_pid=?)`).run(pid, roomId, leaseId, pid);
    if (result.changes !== 1) throw plannerError('planner_process_exit_unconfirmed');
  }
  reconcileLeases(options: { probe?: (pid: number, signal: 0) => unknown; log?: (entry: object) => void } = {}): void {
    const probe = options.probe || ((pid, signal) => process.kill(pid, signal));
    const log = options.log || ((entry: object) => console.info(JSON.stringify(entry)));
    const page = this.store.db.prepare(`SELECT conversation_id, lease_id, guardian_pid FROM chat_embedded_planner_leases
      WHERE conversation_id>? ORDER BY conversation_id LIMIT 100`);
    let after = '';
    while (true) {
      // Finish each bounded read before writing; better-sqlite3 forbids writes
      // while a statement iterator on the same connection is active.
      const leases = page.all(after);
      for (const lease of leases) {
        if (!validPlannerGuardianPid(lease.guardian_pid)) continue;
        let absent = false;
        try { probe(lease.guardian_pid, 0); }
        catch (error: any) { absent = error?.code === 'ESRCH'; }
        if (absent && this.release(lease.conversation_id, lease.lease_id)) {
          log({ event: 'planner_lease_released', conversationId: lease.conversation_id, reasonCode: 'planner_guardian_absent' });
        }
      }
      if (leases.length < 100) break;
      after = leases[leases.length - 1].conversation_id;
    }
  }
  repair(roomId: string): boolean {
    return this.store.db.prepare('DELETE FROM chat_embedded_planner_leases WHERE conversation_id=?').run(roomId).changes === 1;
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
      this.store.db.prepare('INSERT INTO chat_embedded_planner_leases (conversation_id, session_id, lease_id) VALUES (?,?,?)').run(roomId, metadata.sessionId, leaseId);
      return { metadata, first, leaseId };
    })();
  }
  release(roomId: string, leaseId: string): boolean {
    return this.store.db.prepare('DELETE FROM chat_embedded_planner_leases WHERE conversation_id=? AND lease_id=?').run(roomId, leaseId).changes === 1;
  }
}
