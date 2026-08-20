import { MAX_CONVERSATION_MESSAGE_DELETE_BATCH_SIZE } from '../../lib/conversation-message-deletion-contract';

function normalizeBatchRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    batchId: row.batch_id,
    conversationId: row.conversation_id,
    clientRequestId: row.client_request_id,
    requestFingerprint: row.request_fingerprint,
    expectedCount: row.expected_count,
    status: row.status,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    rejectedReason: row.rejected_reason,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function normalizeUploadRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    imageId: row.image_id,
    batchId: row.batch_id,
    status: row.status,
    slot: row.slot,
    fileName: row.file_name,
    storedPath: row.stored_path,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    attachedMessageId: row.attached_message_id,
    attachedAt: row.attached_at,
    integrityStatus: row.integrity_status,
    integrityError: row.integrity_error,
    createdAt: row.created_at,
    ttlExpiresAt: row.ttl_expires_at,
  };
}

export class ImageUploadRepository {
  db: any;
  createBatchStatement: any;
  getBatchByKeyStatement: any;
  getBatchByIdStatement: any;
  takeoverLeaseStatement: any;
  completeBatchStatement: any;
  rejectBatchStatement: any;
  insertChildStatement: any;
  listChildrenByBatchStatement: any;
  recycleByMessageStatement: any;
  purgeByConversationStatement: any;
  purgeBatchesByConversationStatement: any;
  countChildrenByBatchStatement: any;
    listStagedExpiredStatement: any;
    listByConversationStatement: any;
    listBatchesByConversationStatement: any;
    getChildStatement: any;
    markBatchConsumedStatement: any;
    listPendingBatchesStatement: any;
    listUnconsumedCompleteBatchesStatement: any;
    purgeBatchTransaction: any;
    listAllBatchesStatement: any;

  constructor(db: any) {
    this.db = db;
    this.createBatchStatement = db.prepare(`
      INSERT INTO image_upload_batches (
        batch_id,
        conversation_id,
        client_request_id,
        request_fingerprint,
        expected_count,
        status,
        lease_token,
        lease_expires_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);
    this.getBatchByKeyStatement = db.prepare(`
      SELECT *
      FROM image_upload_batches
      WHERE conversation_id = ? AND client_request_id = ?
      LIMIT 1
    `);
    this.getBatchByIdStatement = db.prepare(`
      SELECT *
      FROM image_upload_batches
      WHERE batch_id = ?
      LIMIT 1
    `);
    this.takeoverLeaseStatement = db.prepare(`
      UPDATE image_upload_batches
      SET lease_token = ?, lease_expires_at = ?
      WHERE batch_id = ? AND status = 'pending' AND lease_expires_at < ?
        AND request_fingerprint = ? AND expected_count = ?
    `);
    this.completeBatchStatement = db.prepare(`
      UPDATE image_upload_batches
      SET status = 'complete', completed_at = ?, lease_token = NULL, lease_expires_at = NULL
      WHERE batch_id = ? AND status = 'pending' AND lease_token = ?
    `);
    this.rejectBatchStatement = db.prepare(`
      UPDATE image_upload_batches
      SET status = 'rejected', rejected_reason = ?
      WHERE batch_id = ? AND status = 'pending' AND lease_token = ?
    `);
    this.insertChildStatement = db.prepare(`
      INSERT INTO image_uploads (
        image_id,
        batch_id,
        status,
        slot,
        file_name,
        stored_path,
        mime_type,
        width,
        height,
        size_bytes,
        integrity_status,
        created_at
      ) VALUES (?, ?, 'staged', ?, ?, ?, ?, ?, ?, ?, 'ok', ?)
    `);
    this.listChildrenByBatchStatement = db.prepare(`
      SELECT *
      FROM image_uploads
      WHERE batch_id = ?
      ORDER BY slot ASC
    `);
    this.getChildStatement = db.prepare(`
      SELECT *
      FROM image_uploads
      WHERE image_id = ?
      LIMIT 1
    `);
    this.recycleByMessageStatement = db.prepare(`
      UPDATE image_uploads
      SET
        status = 'recycled',
        attached_message_id = NULL,
        attached_at = NULL,
        ttl_expires_at = ?
      WHERE attached_message_id = ? AND status = 'attached'
    `);
    this.purgeByConversationStatement = db.prepare(`
      DELETE FROM image_uploads
      WHERE batch_id IN (SELECT batch_id FROM image_upload_batches WHERE conversation_id = ?)
    `);
    this.purgeBatchesByConversationStatement = db.prepare(`
      DELETE FROM image_upload_batches WHERE conversation_id = ?
    `);
    this.countChildrenByBatchStatement = db.prepare(`
      SELECT COUNT(*) AS count FROM image_uploads WHERE batch_id = ?
    `);
    this.listStagedExpiredStatement = db.prepare(`
      SELECT *
      FROM image_uploads
      WHERE status = 'staged' AND created_at < ?
    `);
    this.listByConversationStatement = db.prepare(`
      SELECT *
      FROM image_uploads
      WHERE batch_id IN (SELECT batch_id FROM image_upload_batches WHERE conversation_id = ?)
    `);
    this.listBatchesByConversationStatement = db.prepare(`
      SELECT *
      FROM image_upload_batches
      WHERE conversation_id = ?
    `);
    this.markBatchConsumedStatement = db.prepare(`
      UPDATE image_upload_batches
      SET consumed_at = ?
      WHERE batch_id = ? AND status = 'complete'
    `);
    this.listPendingBatchesStatement = db.prepare(`
      SELECT *
      FROM image_upload_batches
      WHERE status = 'pending'
    `);
    this.listUnconsumedCompleteBatchesStatement = db.prepare(`
      SELECT *
      FROM image_upload_batches
      WHERE status = 'complete' AND consumed_at IS NULL AND completed_at < ?
    `);
    this.listAllBatchesStatement = db.prepare(`
      SELECT *
      FROM image_upload_batches
    `);
    this.purgeBatchTransaction = db.transaction((batchId: string) => {
      db.prepare('DELETE FROM image_uploads WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM image_upload_batches WHERE batch_id = ?').run(batchId);
    });
  }

  createBatch(payload: any) {
    this.createBatchStatement.run(
      payload.batchId,
      payload.conversationId,
      payload.clientRequestId,
      payload.requestFingerprint,
      payload.expectedCount,
      payload.leaseToken,
      payload.leaseExpiresAt,
      payload.createdAt
    );

    return this.getBatchById(payload.batchId);
  }

  getBatchByKey(conversationId: string, clientRequestId: string) {
    return normalizeBatchRow(this.getBatchByKeyStatement.get(conversationId, clientRequestId));
  }

  getBatchById(batchId: string) {
    return normalizeBatchRow(this.getBatchByIdStatement.get(batchId));
  }

  takeoverLease(batchId: string, newToken: string, newExpiry: string, now: string, requestFingerprint: string, expectedCount: number) {
    const result = this.takeoverLeaseStatement.run(newToken, newExpiry, batchId, now, requestFingerprint, expectedCount);
    return result.changes > 0;
  }

  completeBatch(batchId: string, leaseToken: string, completedAt: string) {
    const result = this.completeBatchStatement.run(completedAt, batchId, leaseToken);
    return result.changes > 0;
  }

  rejectBatch(batchId: string, reason: string, leaseToken: string) {
    const result = this.rejectBatchStatement.run(reason, batchId, leaseToken);
    return result.changes > 0;
  }

  insertChild(payload: any) {
    this.insertChildStatement.run(
      payload.imageId,
      payload.batchId,
      payload.slot,
      payload.fileName || null,
      payload.storedPath,
      payload.mimeType || null,
      payload.width || null,
      payload.height || null,
      payload.sizeBytes || null,
      payload.createdAt
    );

    return this.getChild(payload.imageId);
  }

  getChild(imageId: string) {
    return normalizeUploadRow(this.getChildStatement.get(imageId));
  }

  listChildrenByBatch(batchId: string) {
    return this.listChildrenByBatchStatement.all(batchId).map(normalizeUploadRow);
  }

  listAttachedByMessageIds(messageIds: string[]) {
    const safeIds = Array.from(
      new Set((Array.isArray(messageIds) ? messageIds : []).map((value) => String(value || '').trim()).filter(Boolean))
    ).slice(0, MAX_CONVERSATION_MESSAGE_DELETE_BATCH_SIZE);

    if (safeIds.length === 0) {
      return [];
    }

    return this.db
      .prepare(`
        SELECT *
        FROM image_uploads
        WHERE attached_message_id IN (SELECT value FROM json_each(?))
        ORDER BY batch_id ASC, slot ASC
      `)
      .all(JSON.stringify(safeIds))
      .map(normalizeUploadRow);
  }

  listChildrenByIds(imageIds: string[]) {
    const safeIds = (Array.isArray(imageIds) ? imageIds : []).filter(Boolean).slice(0, 8);

    if (safeIds.length === 0) {
      return [];
    }

    const placeholders = safeIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM image_uploads WHERE image_id IN (${placeholders})`)
      .all(...safeIds);

    return rows.map(normalizeUploadRow);
  }

  attachChildren(imageIds: string[], conversationId: string, messageId: string, attachedAt: string) {
    const safeIds = (Array.isArray(imageIds) ? imageIds : []).filter(Boolean).slice(0, 8);

    if (safeIds.length === 0) {
      return 0;
    }

    const placeholders = safeIds.map(() => '?').join(',');
    const result = this.db
      .prepare(`
        UPDATE image_uploads
        SET
          status = 'attached',
          attached_message_id = ?,
          attached_at = ?
        WHERE image_id IN (${placeholders})
          AND status = 'staged'
          AND attached_message_id IS NULL
          AND batch_id IN (SELECT batch_id FROM image_upload_batches WHERE conversation_id = ?)
      `)
      .run(messageId, attachedAt, ...safeIds, conversationId);

    return result.changes;
  }

  recycleByMessage(messageId: string, ttlExpiresAt: string) {
    const result = this.recycleByMessageStatement.run(ttlExpiresAt, messageId);
    return result.changes;
  }

  purgeByConversation(conversationId: string) {
    const childrenResult = this.purgeByConversationStatement.run(conversationId);
    const batchesResult = this.purgeBatchesByConversationStatement.run(conversationId);
    return {
      children: childrenResult.changes,
      batches: batchesResult.changes,
    };
  }

  countChildrenByBatch(batchId: string) {
    return Number(this.countChildrenByBatchStatement.get(batchId)?.count || 0);
  }

  listStagedExpired(now: string) {
    return this.listStagedExpiredStatement.all(now).map(normalizeUploadRow);
  }

  listByConversation(conversationId: string) {
    return this.listByConversationStatement.all(conversationId).map(normalizeUploadRow);
  }

  listBatchesByConversation(conversationId: string) {
    return this.listBatchesByConversationStatement.all(conversationId).map(normalizeBatchRow);
  }

  markBatchConsumed(batchId: string, consumedAt: string) {
    const result = this.markBatchConsumedStatement.run(consumedAt, batchId);
    return result.changes > 0;
  }

  listPendingBatches() {
    return this.listPendingBatchesStatement.all().map(normalizeBatchRow);
  }

  listUnconsumedCompleteBatches(completedBefore: string) {
    return this.listUnconsumedCompleteBatchesStatement.all(completedBefore).map(normalizeBatchRow);
  }

  listAllBatches() {
    return this.listAllBatchesStatement.all().map(normalizeBatchRow);
  }

  purgeBatch(batchId: string) {
    this.purgeBatchTransaction(batchId);
  }

  deleteAttachedByMessageIds(messageIds: string[]) {
    const safeIds = Array.from(
      new Set((Array.isArray(messageIds) ? messageIds : []).map((value) => String(value || '').trim()).filter(Boolean))
    ).slice(0, MAX_CONVERSATION_MESSAGE_DELETE_BATCH_SIZE);

    if (safeIds.length === 0) {
      return 0;
    }

    return this.db
      .prepare(`DELETE FROM image_uploads WHERE attached_message_id IN (SELECT value FROM json_each(?))`)
      .run(JSON.stringify(safeIds)).changes;
  }

  deleteBatchesByIds(batchIds: string[]) {
    const safeIds = Array.from(
      new Set((Array.isArray(batchIds) ? batchIds : []).map((value) => String(value || '').trim()).filter(Boolean))
    ).slice(0, MAX_CONVERSATION_MESSAGE_DELETE_BATCH_SIZE);

    if (safeIds.length === 0) {
      return 0;
    }

    return this.db
      .prepare(`DELETE FROM image_upload_batches WHERE batch_id IN (SELECT value FROM json_each(?))`)
      .run(JSON.stringify(safeIds)).changes;
  }

  deleteChild(imageId: string) {
    return this.db.prepare('DELETE FROM image_uploads WHERE image_id = ?').run(imageId).changes;
  }

  markIntegrityFailure(imageId: string, integrityError: string, failedAt: string) {
    const result = this.db
      .prepare(`
        UPDATE image_uploads
        SET integrity_status = 'missing_file', integrity_error = ?
        WHERE image_id = ? AND integrity_status = 'ok'
      `)
      .run(integrityError || null, imageId);
    return result.changes;
  }
}

export function createImageUploadRepository(db: any) {
  return new ImageUploadRepository(db);
}
