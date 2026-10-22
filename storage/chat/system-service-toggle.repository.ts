// Generic per-service on/off toggles (chat_system_service_toggles, contract
// §6). Unlike chat_system_service_configs (shaped for the Recovery Scribe's
// provider/model/thinking), this table carries no payload: an ABSENT row is
// the default-off state, so the migration never seeds rows.

export class ChatSystemServiceToggleRepository {
  db: any;
  getStatement: any;
  upsertStatement: any;

  constructor(db: any) {
    this.db = db;
    this.getStatement = db.prepare(`
      SELECT *
      FROM chat_system_service_toggles
      WHERE service_type = ?
      LIMIT 1
    `);
    this.upsertStatement = db.prepare(`
      INSERT INTO chat_system_service_toggles (
        service_type,
        enabled,
        updated_at
      ) VALUES (
        @serviceType,
        @enabled,
        @updatedAt
      )
      ON CONFLICT(service_type) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
      RETURNING *
    `);
  }

  get(serviceType: string) {
    return this.getStatement.get(serviceType) || null;
  }

  setEnabled(serviceType: string, enabled: boolean, updatedAt: string) {
    return this.upsertStatement.get({
      serviceType,
      enabled: enabled ? 1 : 0,
      updatedAt,
    });
  }
}

export function createChatSystemServiceToggleRepository(db: any) {
  return new ChatSystemServiceToggleRepository(db);
}
