// Per-service credentials (chat_system_service_credentials, contract §6).
// This table holds the JEV API key in plaintext (user-ruled: a loopback-only
// local tool stores it no worse than .env.local on the same disk). The key
// is WRITE-ONLY: it must never appear in any API response, error body, log
// line, or event payload — reads happen only inside the resolver, the client
// factory, and the status surface (which reads a boolean, never the value).
//
// Deliberately separate from chat_system_service_toggles: the toggle table's
// invariant is "absent row = off", while a credential row exists whether or
// not the switch is on. Two tables keep "row exists" unambiguous.

export class ChatSystemServiceCredentialRepository {
  db: any;
  getStatement: any;
  upsertStatement: any;

  constructor(db: any) {
    this.db = db;
    this.getStatement = db.prepare(`
      SELECT service_type, api_key, base_url, model, updated_at
      FROM chat_system_service_credentials
      WHERE service_type = ?
      LIMIT 1
    `);
    this.upsertStatement = db.prepare(`
      INSERT INTO chat_system_service_credentials (
        service_type,
        api_key,
        base_url,
        model,
        updated_at
      ) VALUES (
        @serviceType,
        @apiKey,
        @baseUrl,
        @model,
        @updatedAt
      )
      ON CONFLICT(service_type) DO UPDATE SET
        api_key = excluded.api_key,
        base_url = excluded.base_url,
        model = excluded.model,
        updated_at = excluded.updated_at
    `);
  }

  get(serviceType: string) {
    return this.getStatement.get(serviceType) || null;
  }

  // Full-row write: callers compose the next row via read-modify-write at
  // the store layer, so "leave unchanged" vs "clear" never collide with
  // NULL semantics here.
  save(serviceType: string, row: { apiKey: string | null; baseUrl: string | null; model: string | null }, updatedAt: string) {
    this.upsertStatement.run({
      serviceType,
      apiKey: row.apiKey,
      baseUrl: row.baseUrl,
      model: row.model,
      updatedAt,
    });
  }
}

export function createChatSystemServiceCredentialRepository(db: any) {
  return new ChatSystemServiceCredentialRepository(db);
}
