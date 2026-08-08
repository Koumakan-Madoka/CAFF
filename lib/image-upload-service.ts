import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGES_PER_UPLOAD,
  MAX_IMAGE_WIDTH,
  MAX_IMAGE_HEIGHT,
  STAGED_IMAGE_TTL_MS,
  UPLOAD_LEASE_TTL_MS,
  UPLOAD_RETRY_AFTER_MS,
} = require('./image-constants');
const { parseImageHeader } = require('./image-header-parser');

export type UploadCandidate = {
  fieldName: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
};

export type UploadServiceOptions = {
  store: any;
  uploadsDir: string;
};

export type UploadOutcome =
  | {
      kind: 'ok';
      images: Array<{ imageId: string }>;
    }
  | {
      kind: 'in_progress';
      retryAfterMs: number;
    }
  | {
      kind: 'conflict';
      existingImages: Array<{ imageId: string }>;
    }
  | {
      kind: 'error';
      statusCode: number;
      code: string;
      reason: string;
    };

export class ImageUploadService {
  store: any;
  uploadsDir: string;
  inFlight: Map<string, Promise<UploadOutcome>>;

  constructor(options: UploadServiceOptions) {
    this.store = options.store;
    this.uploadsDir = options.uploadsDir;
    this.inFlight = new Map();
  }

  computeRequestFingerprint(candidates: UploadCandidate[]) {
    const hash = createHash('sha256');
    hash.update(String(candidates.length));
    hash.update('\0');

    for (const candidate of candidates) {
      hash.update(candidate.mimeType);
      hash.update('\0');
      hash.update(String(candidate.content.length));
      hash.update('\0');
      hash.update(candidate.content);
      hash.update('\0');
    }

    return hash.digest('hex');
  }

  normalizeFileName(fileName: string) {
    const base = String(fileName || '').replace(/\\/g, '/').split('/').pop() || '';
    return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  }

  validateCandidate(candidate: UploadCandidate) {
    if (candidate.content.length === 0) {
      return { code: 'EMPTY_FILE', reason: 'Image file is empty' };
    }

    if (candidate.content.length > MAX_IMAGE_BYTES) {
      return { code: 'FILE_TOO_LARGE', reason: `Image exceeds ${MAX_IMAGE_BYTES} bytes` };
    }

    if (!ALLOWED_IMAGE_MIME_TYPES.includes(candidate.mimeType)) {
      return { code: 'MIME_NOT_ALLOWED', reason: `MIME type ${candidate.mimeType} is not allowed` };
    }

    const parsed = parseImageHeader(candidate.content);

    if (!parsed.ok) {
      return { code: parsed.reason, reason: `Image header rejected: ${parsed.reason}` };
    }

    if (parsed.header.width > MAX_IMAGE_WIDTH || parsed.header.height > MAX_IMAGE_HEIGHT) {
      return {
        code: 'DIMENSIONS_EXCEEDED',
        reason: `Image dimensions ${parsed.header.width}x${parsed.header.height} exceed limit`,
      };
    }

    if (parsed.header.pixelCount > MAX_IMAGE_PIXELS) {
      return {
        code: 'PIXEL_COUNT_EXCEEDED',
        reason: `Image pixel count ${parsed.header.pixelCount} exceeds ${MAX_IMAGE_PIXELS}`,
      };
    }

    const normalized = this.normalizeFileName(candidate.fileName);

    if (!normalized) {
      return { code: 'INVALID_FILE_NAME', reason: 'File name is invalid' };
    }

    return null;
  }

  rejectPendingBatch(batchId: string, code: string, reason: string) {
    try {
      this.store.rejectImageUploadBatch(batchId, code, new Date().toISOString());
    } catch {}
  }

  cleanupDirectory(dir: string) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  async upload(conversationId: string, clientRequestId: string, candidates: UploadCandidate[]): Promise<UploadOutcome> {
    if (!clientRequestId) {
      return { kind: 'error', statusCode: 400, code: 'CLIENT_REQUEST_ID_REQUIRED', reason: 'client_request_id is required' };
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { kind: 'error', statusCode: 400, code: 'NO_FILES', reason: 'No image files provided' };
    }

    if (candidates.length > MAX_IMAGES_PER_UPLOAD) {
      return {
        kind: 'error',
        statusCode: 400,
        code: 'TOO_MANY_FILES',
        reason: `Max ${MAX_IMAGES_PER_UPLOAD} images per upload`,
      };
    }

    const requestFingerprint = this.computeRequestFingerprint(candidates);
    const existingBatch = this.store.getImageUploadBatchByKey(conversationId, clientRequestId);

    if (existingBatch && existingBatch.status === 'complete') {
      if (existingBatch.requestFingerprint === requestFingerprint) {
        const children = this.store.listImageUploadsByBatch(existingBatch.batchId);
        return {
          kind: 'ok',
          images: children.map((child: any) => ({ imageId: child.imageId })),
        };
      }

      return {
        kind: 'conflict',
        existingImages: this.store.listImageUploadsByBatch(existingBatch.batchId).map((child: any) => ({
          imageId: child.imageId,
        })),
      };
    }

    if (existingBatch && existingBatch.status === 'rejected') {
      return {
        kind: 'error',
        statusCode: 409,
        code: 'UPLOAD_REJECTED_PREVIOUSLY',
        reason: existingBatch.rejectedReason,
      };
    }

    const inFlightPromise = this.inFlight.get(clientRequestId);

    if (inFlightPromise) {
      return inFlightPromise;
    }

    const run = this.performUpload(conversationId, clientRequestId, requestFingerprint, candidates);
    this.inFlight.set(clientRequestId, run);

    try {
      const outcome = await run;
      return outcome;
    } finally {
      this.inFlight.delete(clientRequestId);
    }
  }

  async performUpload(
    conversationId: string,
    clientRequestId: string,
    requestFingerprint: string,
    candidates: UploadCandidate[]
  ): Promise<UploadOutcome> {
    let batch = this.store.getImageUploadBatchByKey(conversationId, clientRequestId);

    if (batch && batch.status === 'pending') {
      const leaseActive = batch.leaseExpiresAt && new Date(batch.leaseExpiresAt).getTime() > Date.now();

      if (leaseActive) {
        return {
          kind: 'in_progress',
          retryAfterMs: UPLOAD_RETRY_AFTER_MS,
        };
      }

      const newToken = randomUUID();
      const tookOver = this.store.takeoverImageUploadLease(
        batch.batchId,
        newToken,
        new Date(Date.now() + UPLOAD_LEASE_TTL_MS).toISOString(),
        new Date().toISOString()
      );

      if (!tookOver) {
        return {
          kind: 'in_progress',
          retryAfterMs: UPLOAD_RETRY_AFTER_MS,
        };
      }

      batch = this.store.getImageUploadBatch(batch.batchId);
    }

    if (!batch) {
      batch = this.store.createImageUploadBatch({
        conversationId,
        clientRequestId,
        requestFingerprint,
        expectedCount: candidates.length,
        leaseExpiresAt: new Date(Date.now() + UPLOAD_LEASE_TTL_MS).toISOString(),
      });
    }

    const leaseToken = batch.leaseToken;
    const validationErrors: Array<{ index: number; code: string; reason: string }> = [];

    for (let i = 0; i < candidates.length; i += 1) {
      const error = this.validateCandidate(candidates[i]);

      if (error) {
        validationErrors.push({ index: i, ...error });
      }
    }

    if (validationErrors.length > 0) {
      const first = validationErrors[0];
      this.rejectPendingBatch(batch.batchId, first.code, first.reason);
      this.cleanupUploadArtifacts(batch.batchId, leaseToken);
      return {
        kind: 'error',
        statusCode: 400,
        code: first.code,
        reason: first.reason,
      };
    }

    const tempDir = path.join(this.uploadsDir, '.tmp', batch.batchId, leaseToken);
    const finalDir = path.join(this.uploadsDir, batch.batchId);

    try {
      this.cleanupDirectory(tempDir);
      fs.mkdirSync(tempDir, { recursive: true });

      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        const safeFileName = this.normalizeFileName(candidate.fileName);
        const writtenName = `${i}-${safeFileName}`;
        fs.writeFileSync(path.join(tempDir, writtenName), candidate.content);
      }

      fs.mkdirSync(path.dirname(finalDir), { recursive: true });
      fs.renameSync(tempDir, finalDir);
    } catch (error) {
      this.cleanupUploadArtifacts(batch.batchId, leaseToken);
      return {
        kind: 'error',
        statusCode: 500,
        code: 'STORAGE_FAILURE',
        reason: String((error as Error).message || error),
      };
    }

    const nowIso = new Date().toISOString();
    const children = [];

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const parsed = parseImageHeader(candidate.content);
      const header = parsed.ok ? parsed.header : null;
      const safeFileName = this.normalizeFileName(candidate.fileName);
      const storedPath = `/uploads/${batch.batchId}/${i}-${safeFileName}`;

      children.push({
        imageId: randomUUID(),
        batchId: batch.batchId,
        slot: i,
        fileName: safeFileName,
        storedPath,
        mimeType: candidate.mimeType,
        width: header ? header.width : null,
        height: header ? header.height : null,
        sizeBytes: candidate.content.length,
      });
    }

    try {
      this.store.finalizeImageUploadBatch({
        batchId: batch.batchId,
        leaseToken,
        completedAt: nowIso,
        children,
      });
    } catch (error) {
      const code = (error as any).code || '';

      if (code === 'IMAGE_BATCH_FENCED') {
        this.cleanupUploadArtifacts(batch.batchId, leaseToken);
        return {
          kind: 'in_progress',
          retryAfterMs: UPLOAD_RETRY_AFTER_MS,
        };
      }

      throw error;
    }

    const completedChildren = this.store.listImageUploadsByBatch(batch.batchId);
    return {
      kind: 'ok',
      images: completedChildren.map((child: any) => ({ imageId: child.imageId })),
    };
  }

  cleanupUploadArtifacts(batchId: string, leaseToken?: string) {
    if (leaseToken) {
      this.cleanupDirectory(path.join(this.uploadsDir, '.tmp', batchId, leaseToken));
      return;
    }

    this.cleanupDirectory(path.join(this.uploadsDir, '.tmp', batchId));
    this.cleanupDirectory(path.join(this.uploadsDir, batchId));
  }

  private finalDirFor(batchId: string) {
    return path.join(this.uploadsDir, batchId);
  }

  private verifyFinalDir(batchId: string, expectedCount: number): boolean {
    const finalDir = this.finalDirFor(batchId);

    if (!fs.existsSync(finalDir)) {
      return false;
    }

    let entries: string[];

    try {
      entries = fs.readdirSync(finalDir);
    } catch {
      return false;
    }

    if (entries.length !== expectedCount) {
      return false;
    }

    for (let slot = 0; slot < expectedCount; slot += 1) {
      const match = entries.find((name) => name.startsWith(`${slot}-`));

      if (!match) {
        return false;
      }

      const fullPath = path.join(finalDir, match);

      let content: Buffer;

      try {
        content = fs.readFileSync(fullPath);
      } catch {
        return false;
      }

      const parsed = parseImageHeader(content);

      if (!parsed.ok) {
        return false;
      }
    }

    return true;
  }

  reconcilePendingBatches(now = new Date().toISOString()) {
    const pending = this.store.listPendingImageUploadBatches();

    for (const batch of pending) {
      const complete = this.verifyFinalDir(batch.batchId, batch.expectedCount);

      if (complete) {
        const children: Array<any> = [];
        const finalDir = this.finalDirFor(batch.batchId);

        let entries: string[] = [];

        try {
          entries = fs.readdirSync(finalDir);
        } catch {}

        for (let slot = 0; slot < batch.expectedCount; slot += 1) {
          const match = entries.find((name) => name.startsWith(`${slot}-`));

          if (!match) {
            continue;
          }

          const fullPath = path.join(finalDir, match);
          const content = fs.readFileSync(fullPath);
          const parsed = parseImageHeader(content);
          const header = parsed.ok ? parsed.header : null;

          children.push({
            imageId: randomUUID(),
            batchId: batch.batchId,
            slot,
            fileName: match.replace(/^\d+-/, ''),
            storedPath: `/uploads/${batch.batchId}/${match}`,
            mimeType: 'application/octet-stream',
            width: header ? header.width : null,
            height: header ? header.height : null,
            sizeBytes: content.length,
          });
        }

        if (children.length !== batch.expectedCount) {
          this.cleanupDirectory(this.finalDirFor(batch.batchId));
          continue;
        }

        try {
          this.store.finalizeImageUploadBatch({
            batchId: batch.batchId,
            leaseToken: batch.leaseToken,
            completedAt: now,
            children,
          });
        } catch (error) {
          if ((error as any).code === 'IMAGE_BATCH_FENCED') {
            this.cleanupDirectory(this.finalDirFor(batch.batchId));
          }
        }
      } else {
        this.cleanupDirectory(this.finalDirFor(batch.batchId));
      }
    }
  }

  gcUnconsumedCompleteBatches(ttlMs = STAGED_IMAGE_TTL_MS, now = new Date().toISOString()) {
    const threshold = new Date(new Date(now).getTime() - ttlMs).toISOString();
    const expired = this.store.listUnconsumedCompleteImageUploadBatches(threshold);

    for (const batch of expired) {
      this.cleanupDirectory(this.finalDirFor(batch.batchId));
      this.store.purgeImageUploadBatch(batch.batchId);
    }

    return expired.length;
  }

  cleanupOrphanFiles() {
    const knownBatchIds = new Set(this.store.listAllImageUploadBatches().map((batch: any) => batch.batchId));

    if (!fs.existsSync(this.uploadsDir)) {
      return 0;
    }

    let removed = 0;

    for (const entry of fs.readdirSync(this.uploadsDir)) {
      if (entry === '.tmp') {
        continue;
      }

      if (!knownBatchIds.has(entry)) {
        this.cleanupDirectory(path.join(this.uploadsDir, entry));
        removed += 1;
      }
    }

    return removed;
  }

  reconcile(now = new Date().toISOString()) {
    this.reconcilePendingBatches(now);
    this.gcUnconsumedCompleteBatches(STAGED_IMAGE_TTL_MS, now);
    return this.cleanupOrphanFiles();
  }
}

export function createImageUploadService(options: UploadServiceOptions) {
  return new ImageUploadService(options);
}
