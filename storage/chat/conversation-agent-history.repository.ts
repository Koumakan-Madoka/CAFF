export class ChatConversationAgentHistoryRepository {
  insertStatement: any;
  listByConversationStatement: any;

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
}

export function createChatConversationAgentHistoryRepository(db: any) {
  return new ChatConversationAgentHistoryRepository(db);
}
