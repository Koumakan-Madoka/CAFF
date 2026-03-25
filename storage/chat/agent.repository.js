class ChatAgentRepository {
  constructor(db) {
    this.getStatement = db.prepare(`
      SELECT *
      FROM chat_agents
      WHERE id = ?
      LIMIT 1
    `);
    this.listStatement = db.prepare(`
      SELECT *
      FROM chat_agents
      ORDER BY created_at ASC, id ASC
    `);
    this.insertStatement = db.prepare(`
      INSERT INTO chat_agents (
        id,
        name,
        sandbox_name,
        description,
        avatar_data_url,
        persona_prompt,
        provider,
        model,
        thinking,
        accent_color,
        skills_json,
        model_profiles_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateStatement = db.prepare(`
      UPDATE chat_agents
      SET
        name = ?,
        sandbox_name = ?,
        description = ?,
        avatar_data_url = ?,
        persona_prompt = ?,
        provider = ?,
        model = ?,
        thinking = ?,
        accent_color = ?,
        skills_json = ?,
        model_profiles_json = ?,
        updated_at = ?
      WHERE id = ?
    `);
    this.deleteStatement = db.prepare('DELETE FROM chat_agents WHERE id = ?');
  }

  get(agentId) {
    return this.getStatement.get(agentId);
  }

  list() {
    return this.listStatement.all();
  }

  save(payload) {
    const existing = this.get(payload.id);

    if (existing) {
      this.updateStatement.run(
        payload.name,
        payload.sandboxName || null,
        payload.description,
        payload.avatarDataUrl,
        payload.personaPrompt,
        payload.provider,
        payload.model,
        payload.thinking,
        payload.accentColor,
        payload.skillsJson,
        payload.modelProfilesJson,
        payload.updatedAt,
        payload.id
      );
    } else {
      this.insertStatement.run(
        payload.id,
        payload.name,
        payload.sandboxName || null,
        payload.description,
        payload.avatarDataUrl,
        payload.personaPrompt,
        payload.provider,
        payload.model,
        payload.thinking,
        payload.accentColor,
        payload.skillsJson,
        payload.modelProfilesJson,
        payload.createdAt,
        payload.updatedAt
      );
    }

    return this.get(payload.id);
  }

  delete(agentId) {
    this.deleteStatement.run(agentId);
  }
}

function createChatAgentRepository(db) {
  return new ChatAgentRepository(db);
}

module.exports = {
  ChatAgentRepository,
  createChatAgentRepository,
};
