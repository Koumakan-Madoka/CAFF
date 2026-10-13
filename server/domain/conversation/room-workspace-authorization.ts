import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 1000;

// Execution failures in this set are transient: no Git or DB mutation happened,
// so the card returns to pending and the user can retry it once the blocker clears.
const RETRYABLE_DECIDE_ERROR_CODES = new Set(['room_workspace_execution_active']);

function text(value: unknown) {
  return String(value || '').trim();
}

function previewFingerprint(preview: any) {
  const canonical = JSON.stringify({
    kind: text(preview && preview.kind) || 'bind',
    conversationId: text(preview && preview.conversationId),
    projectScopeId: text(preview && preview.projectScopeId),
    repositoryPath: text(preview && preview.repositoryPath),
    baseBranch: text(preview && preview.baseBranch),
    baseSha: text(preview && preview.baseSha),
    branch: text(preview && preview.branch),
    newBranch: text(preview && preview.newBranch),
    worktreePath: text(preview && preview.worktreePath),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function authorizationError(statusCode: number, code: string, message: string) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.issues = [{ code, message }];
  return error;
}

export class RoomWorkspaceAuthorizationStore {
  records = new Map<string, any>();
  ttlMs: number;

  constructor(options: any = {}) {
    const ttlMs = Number(options.ttlMs);
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs >= 30_000 ? Math.min(ttlMs, 60 * 60 * 1000) : DEFAULT_TTL_MS;
  }

  issue({ conversation, preview, invocationId, sourceMessageId, now = Date.now() }: any) {
    this.expire(now);
    const conversationId = text(conversation && conversation.id) || text(preview && preview.conversationId);
    const projectScopeId = text(conversation && conversation.projectScopeId) || text(preview && preview.projectScopeId);
    if (!conversationId || !projectScopeId || !preview) {
      return null;
    }
    // A bound Room cannot issue another bind card, but it may issue a rename card.
    if (preview.alreadyBound && text(preview.kind) !== 'rename') {
      return null;
    }

    const fingerprint = previewFingerprint(preview);
    for (const record of this.records.values()) {
      if (
        record.status === 'pending'
        && record.conversationId === conversationId
        && record.fingerprint === fingerprint
      ) {
        return this.publicRecord(record);
      }
    }

    // A new plan supersedes every still-pending card of this Room: an old card can
    // never execute a plan the user has already replaced.
    for (const record of this.records.values()) {
      if (record.status === 'pending' && record.conversationId === conversationId) {
        record.status = 'superseded';
        record.decidedAt = new Date(now).toISOString();
      }
    }

    if (this.records.size >= MAX_PENDING) {
      this.expire(now, true);
    }
    const createdAt = new Date(now).toISOString();
    const record = {
      id: `workspace-auth-${randomUUID()}`,
      token: randomUUID() + randomUUID(),
      conversationId,
      projectScopeId,
      invocationId: text(invocationId) || null,
      sourceMessageId: text(sourceMessageId) || null,
      fingerprint,
      preview,
      status: 'pending',
      createdAt,
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      decidedAt: null,
      errorCode: null,
    };
    this.records.set(record.id, record);
    return this.publicRecord(record);
  }

  publicRecord(record: any) {
    if (!record) return null;
    return {
      id: record.id,
      conversationId: record.conversationId,
      projectScopeId: record.projectScopeId,
      kind: text(record.preview.kind) || 'bind',
      branch: record.preview.branch,
      newBranch: record.preview.newBranch || null,
      worktreePath: record.preview.worktreePath,
      repositoryPath: record.preview.repositoryPath,
      baseBranch: record.preview.baseBranch,
      baseSha: record.preview.baseSha,
      status: record.status,
      errorCode: record.errorCode,
      sourceMessageId: record.sourceMessageId || null,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      fingerprint: record.fingerprint,
      decidedAt: record.decidedAt,
    };
  }

  clientRecord(record: any, { includeToken = true }: { includeToken?: boolean } = {}) {
    const result = this.publicRecord(record);
    if (!result) return null;
    return includeToken ? { ...result, token: record.token } : result;
  }

  getForClient(id: unknown, token: unknown, conversationId: unknown, now = Date.now()) {
    const record = this.records.get(text(id));
    if (!record || record.token !== text(token) || record.conversationId !== text(conversationId)) {
      throw authorizationError(404, 'room_workspace_authorization_not_found', 'Workspace authorization request not found');
    }
    if (record.status === 'pending' && Date.parse(record.expiresAt) <= now) {
      record.status = 'expired';
      record.decidedAt = new Date(now).toISOString();
      throw authorizationError(410, 'room_workspace_authorization_expired', 'Workspace authorization request expired');
    }
    this.expire(now);
    if (record.status !== 'pending') {
      const cause = record.status === 'failed' && record.errorCode
        ? ` (previous attempt failed: ${record.errorCode})`
        : '';
      throw authorizationError(
        409,
        'room_workspace_authorization_decided',
        `Workspace authorization request is already decided${cause}; ask the Agent to request a new authorization card`
      );
    }
    return record;
  }

  listForClient(conversationId: unknown, now = Date.now()) {
    const normalizedConversationId = text(conversationId);
    this.expire(now);
    return Array.from(this.records.values())
      .filter((record: any) => record.conversationId === normalizedConversationId)
      .map((record: any) => this.clientRecord(record, { includeToken: record.status === 'pending' }));
  }

  async decide({ id, token, conversationId, decision, fingerprint, execute, now = Date.now() }: any) {
    const record = this.getForClient(id, token, conversationId, now);
    if (text(fingerprint) !== record.fingerprint) {
      throw authorizationError(409, 'room_workspace_authorization_stale', 'Workspace preview changed; request a new authorization card');
    }
    if (decision === 'rejected') {
      record.status = 'rejected';
      record.decidedAt = new Date(now).toISOString();
      return { record: this.publicRecord(record), result: null };
    }
    if (decision !== 'accepted') {
      throw authorizationError(400, 'room_workspace_authorization_invalid_decision', 'Decision must be accepted or rejected');
    }
    if (typeof execute !== 'function') {
      throw new Error('Workspace authorization execution is required');
    }
    record.status = 'consuming';
    try {
      const result = await execute(record.preview, record);
      record.status = 'accepted';
      record.decidedAt = new Date().toISOString();
      return { record: this.publicRecord(record), result };
    } catch (error: any) {
      // A transient failure (for example another execution active in the Room)
      // happened before any Git or DB mutation, so the card stays pending and
      // the user can retry the same card once the blocker clears.
      const retryable = RETRYABLE_DECIDE_ERROR_CODES.has(String(error && error.code));
      if (retryable) {
        record.status = 'pending';
        record.errorCode = text(error && error.code) || null;
        record.decidedAt = null;
      } else {
        record.status = 'failed';
        record.errorCode = text(error && error.code) || 'room_workspace_bind_failed';
        record.decidedAt = new Date().toISOString();
      }
      // Surface the terminal record so callers can broadcast the new card state.
      if (error && typeof error === 'object') {
        error.authorizationRecord = this.publicRecord(record);
      }
      throw error;
    }
  }

  expire(now = Date.now(), force = false) {
    for (const [id, record] of this.records) {
      if (record.status === 'pending' && (force || Date.parse(record.expiresAt) <= now)) {
        record.status = 'expired';
        record.decidedAt = new Date(now).toISOString();
      }
      if (record.status !== 'pending' && record.status !== 'consuming' && Date.parse(record.decidedAt || record.expiresAt) + this.ttlMs < now) {
        this.records.delete(id);
      }
    }
  }
}

export { previewFingerprint };
