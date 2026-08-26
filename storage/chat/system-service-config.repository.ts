export class ChatSystemServiceConfigRepository {
  db: any;
  getStatement: any;
  upsertStatement: any;

  constructor(db: any) {
    this.db = db;
    this.getStatement = db.prepare(`
      SELECT *
      FROM chat_system_service_configs
      WHERE service_type = ?
      LIMIT 1
    `);
    this.upsertStatement = db.prepare(`
      INSERT INTO chat_system_service_configs (
        service_type,
        enabled,
        provider,
        model,
        thinking,
        timeout_ms,
        created_at,
        updated_at
      ) VALUES (
        @serviceType,
        @enabled,
        @provider,
        @model,
        @thinking,
        @timeoutMs,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(service_type) DO UPDATE SET
        enabled = excluded.enabled,
        provider = excluded.provider,
        model = excluded.model,
        thinking = excluded.thinking,
        timeout_ms = excluded.timeout_ms,
        updated_at = excluded.updated_at
      RETURNING *
    `);
  }

  get(serviceType: string) {
    return this.getStatement.get(serviceType) || null;
  }

  upsert(payload: any) {
    return this.upsertStatement.get(payload);
  }
}

export function createChatSystemServiceConfigRepository(db: any) {
  return new ChatSystemServiceConfigRepository(db);
}
