function normalizeWorkspaceOperationRow(row: any) {
  if (!row) {
    return null;
  }
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    kind: String(row.kind),
    oldBranch: String(row.old_branch),
    newBranch: String(row.new_branch),
    fingerprint: row.fingerprint || null,
    status: String(row.status),
    errorCode: row.error_code || null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class ChatWorkspaceOperationRepository {
  insertStatement: any;
  pendingForConversationStatement: any;
  getByIdStatement: any;
  completeStatement: any;
  failStatement: any;
  failPendingForConversationStatement: any;

  constructor(db: any) {
    this.insertStatement = db.prepare(`
      INSERT INTO chat_workspace_operations (
        id, conversation_id, kind, old_branch, new_branch,
        fingerprint, status, error_code, created_at, updated_at
      ) VALUES (
        @id, @conversationId, @kind, @oldBranch, @newBranch,
        @fingerprint, 'pending', NULL, @now, @now
      )
    `);
    this.pendingForConversationStatement = db.prepare(`
      SELECT *
      FROM chat_workspace_operations
      WHERE conversation_id = @conversationId
        AND status = 'pending'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    this.getByIdStatement = db.prepare(`
      SELECT *
      FROM chat_workspace_operations
      WHERE id = @id
      LIMIT 1
    `);
    this.completeStatement = db.prepare(`
      UPDATE chat_workspace_operations
      SET status = 'completed',
          updated_at = @updatedAt
      WHERE id = @id
        AND status = 'pending'
    `);
    this.failStatement = db.prepare(`
      UPDATE chat_workspace_operations
      SET status = 'failed',
          error_code = @errorCode,
          updated_at = @updatedAt
      WHERE id = @id
        AND status = 'pending'
    `);
    this.failPendingForConversationStatement = db.prepare(`
      UPDATE chat_workspace_operations
      SET status = 'failed',
          error_code = @errorCode,
          updated_at = @updatedAt
      WHERE conversation_id = @conversationId
        AND status = 'pending'
    `);
  }

  create(payload: any) {
    this.insertStatement.run({
      id: payload.id,
      conversationId: payload.conversationId,
      kind: payload.kind,
      oldBranch: payload.oldBranch,
      newBranch: payload.newBranch,
      fingerprint: payload.fingerprint || null,
      now: payload.now,
    });
    return this.getPendingForConversation(payload.conversationId);
  }

  getPendingForConversation(conversationId: string) {
    return normalizeWorkspaceOperationRow(
      this.pendingForConversationStatement.get({ conversationId })
    );
  }

  getById(id: string) {
    return normalizeWorkspaceOperationRow(this.getByIdStatement.get({ id }));
  }

  complete(id: string, updatedAt: string) {
    return Number(this.completeStatement.run({ id, updatedAt }).changes || 0);
  }

  fail(id: string, errorCode: string, updatedAt: string) {
    return Number(this.failStatement.run({ id, errorCode: String(errorCode || 'workspace_operation_failed').slice(0, 200), updatedAt }).changes || 0);
  }

  failPendingForConversation(conversationId: string, errorCode: string, updatedAt: string) {
    return Number(this.failPendingForConversationStatement.run({
      conversationId,
      errorCode: String(errorCode || 'workspace_operation_failed').slice(0, 200),
      updatedAt,
    }).changes || 0);
  }
}

export function createChatWorkspaceOperationRepository(db: any) {
  return new ChatWorkspaceOperationRepository(db);
}
