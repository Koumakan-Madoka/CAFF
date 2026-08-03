import { LEGACY_SYSTEM_ROLE_IDS } from '../../server/domain/roles/system-role-catalog';

const LEGACY_SYSTEM_ROLE_ID_SET = new Set(LEGACY_SYSTEM_ROLE_IDS);

export class ChatRoleIdentityRepository {
  getStatement: any;
  saveCustomStatement: any;
  retireCustomStatement: any;

  constructor(db: any) {
    this.getStatement = db.prepare(`
      SELECT *
      FROM chat_role_identities
      WHERE role_id = ?
      LIMIT 1
    `);
    this.saveCustomStatement = db.prepare(`
      INSERT INTO chat_role_identities (
        role_id,
        display_name_snapshot,
        avatar_data_url_snapshot,
        accent_color_snapshot,
        origin_kind,
        model_family_snapshot,
        lifecycle_state,
        retired_reason,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'custom', NULL, 'active', NULL, ?, ?)
      ON CONFLICT(role_id) DO UPDATE SET
        display_name_snapshot = excluded.display_name_snapshot,
        avatar_data_url_snapshot = excluded.avatar_data_url_snapshot,
        accent_color_snapshot = excluded.accent_color_snapshot,
        updated_at = excluded.updated_at
      WHERE chat_role_identities.origin_kind = 'custom'
        AND chat_role_identities.lifecycle_state = 'active'
    `);
    this.retireCustomStatement = db.prepare(`
      UPDATE chat_role_identities
      SET
        lifecycle_state = 'retired',
        retired_reason = ?,
        updated_at = ?
      WHERE role_id = ?
        AND origin_kind = 'custom'
        AND lifecycle_state = 'active'
    `);
  }

  get(roleId: string) {
    return this.getStatement.get(roleId);
  }

  saveActiveCustom(payload: any) {
    if (LEGACY_SYSTEM_ROLE_ID_SET.has(String(payload.id || '').trim())) {
      const error: any = new Error('Role identity cannot be reused');
      error.code = 'role_identity_not_reusable';
      throw error;
    }
    const existing = this.get(payload.id);
    if (existing && (existing.origin_kind !== 'custom' || existing.lifecycle_state !== 'active')) {
      const error: any = new Error('Role identity cannot be reused');
      error.code = 'role_identity_not_reusable';
      throw error;
    }
    this.saveCustomStatement.run(
      payload.id,
      payload.name,
      payload.avatarDataUrl || null,
      payload.accentColor || null,
      payload.createdAt,
      payload.updatedAt
    );
    return this.get(payload.id);
  }

  retireActiveCustom(roleId: string, reason: string, updatedAt: string) {
    const result = this.retireCustomStatement.run(reason, updatedAt, roleId);
    return Number(result.changes || 0) > 0 ? this.get(roleId) : null;
  }
}

export function createChatRoleIdentityRepository(db: any) {
  return new ChatRoleIdentityRepository(db);
}
