export class ChatConversationAgentHistoryRepository {
  insertStatement: any;
  listByConversationStatement: any;
  snapshotActiveRoleStatement: any;

  constructor(db: any) {
    this.insertStatement = db.prepare(`
      INSERT INTO chat_conversation_agent_history (
        conversation_id,
        role_id,
        display_name_snapshot,
        role_kind_snapshot,
        model_family_snapshot,
        model_profile_id_snapshot,
        conversation_skills_json,
        sort_order,
        joined_at,
        retired_at,
        retired_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.listByConversationStatement = db.prepare(`
      SELECT *
      FROM chat_conversation_agent_history
      WHERE conversation_id = ?
      ORDER BY sort_order ASC, retired_at ASC, role_id ASC
    `);
    this.snapshotActiveRoleStatement = db.prepare(`
      INSERT INTO chat_conversation_agent_history (
        conversation_id,
        role_id,
        display_name_snapshot,
        role_kind_snapshot,
        model_family_snapshot,
        model_profile_id_snapshot,
        conversation_skills_json,
        sort_order,
        joined_at,
        retired_at,
        retired_reason
      )
      SELECT
        ca.conversation_id,
        ca.agent_id,
        a.name,
        a.role_kind,
        a.model_family,
        ca.model_profile_id,
        ca.conversation_skills_json,
        ca.sort_order,
        ca.created_at,
        ?,
        ?
      FROM chat_conversation_agents ca
      JOIN chat_agents a ON a.id = ca.agent_id
      WHERE ca.agent_id = ?
    `);
  }

  create(payload: any) {
    this.insertStatement.run(
      payload.conversationId,
      payload.roleId,
      payload.displayNameSnapshot,
      payload.roleKindSnapshot,
      payload.modelFamilySnapshot || null,
      payload.modelProfileIdSnapshot || null,
      payload.conversationSkillsJson || null,
      payload.sortOrder,
      payload.joinedAt || null,
      payload.retiredAt,
      payload.retiredReason
    );
  }

  listByConversationId(conversationId: string) {
    return this.listByConversationStatement.all(conversationId);
  }

  snapshotActiveRole(roleId: string, retiredAt: string, retiredReason: string) {
    const result = this.snapshotActiveRoleStatement.run(retiredAt, retiredReason, roleId);
    return Number(result.changes || 0);
  }
}

export function createChatConversationAgentHistoryRepository(db: any) {
  return new ChatConversationAgentHistoryRepository(db);
}
