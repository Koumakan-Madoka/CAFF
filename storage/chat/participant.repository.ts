export class ChatParticipantRepository {
  deleteByConversationStatement: any;
  insertStatement: any;
  listByConversationStatement: any;

  constructor(db: any) {
    this.deleteByConversationStatement = db.prepare(`
      DELETE FROM chat_conversation_agents
      WHERE conversation_id = ?
    `);
    this.insertStatement = db.prepare(`
      INSERT INTO chat_conversation_agents (
        conversation_id,
        agent_id,
        model_profile_id,
        conversation_skills_json,
        sort_order,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.listByConversationStatement = db.prepare(`
      SELECT
        a.*,
        ca.sort_order,
        ca.model_profile_id AS selected_model_profile_id,
        ca.conversation_skills_json
      FROM chat_conversation_agents ca
      JOIN chat_agents a ON a.id = ca.agent_id
      WHERE ca.conversation_id = ?
      ORDER BY ca.sort_order ASC, ca.created_at ASC, a.created_at ASC
    `);
  }

  listByConversationId(conversationId: string) {
    return this.listByConversationStatement.all(conversationId);
  }

  replaceForConversation(conversationId: string, participants: any[]) {
    this.deleteByConversationStatement.run(conversationId);

    participants.forEach((participant, index) => {
      this.insertStatement.run(
        conversationId,
        participant.agentId,
        participant.modelProfileId || null,
        participant.conversationSkillsJson,
        index,
        participant.createdAt
      );
    });
  }
}

export function createChatParticipantRepository(db: any) {
  return new ChatParticipantRepository(db);
}
