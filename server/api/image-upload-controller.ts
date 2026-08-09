import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRawRequestBody } from '../http/request-body';
import { sendJson } from '../http/response';
import { parseMultipart } from '../http/multipart';
import { MAX_IMAGES_PER_UPLOAD } from '../../lib/image-constants';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

const MAX_UPLOAD_BODY_BYTES = 64 * 1024 * 1024;

function sendUploadError(res: ServerResponse, outcome: { statusCode: number; code: string; reason: string }) {
  sendJson(res, outcome.statusCode, {
    error: {
      code: outcome.code,
      message: outcome.reason,
    },
  });
}

export function createImageUploadController(options: any) {
  const uploadService = options.uploadService;
  const store = options.store;

  const handle: RouteHandler<ApiContext> = async ({ req, res, pathname }) => {
    const configMatch = pathname.match(/^\/api\/image-upload\/config$/);

    if (configMatch) {
      if (req.method !== 'GET') {
        throw createHttpError(405, 'Method not allowed');
      }

      sendJson(res, 200, {
        maxImageBytes: options.maxImageBytes,
        maxImagesPerUpload: MAX_IMAGES_PER_UPLOAD,
        maxImagesPerMessage: options.maxImagesPerMessage,
        maxImageWidth: options.maxImageWidth,
        maxImageHeight: options.maxImageHeight,
        maxImagePixels: options.maxImagePixels,
        allowedMimeTypes: options.allowedMimeTypes,
      });
      return true;
    }

    const uploadMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/images$/);

    if (uploadMatch && req.method === 'POST') {
      const conversationId = decodeURIComponent(uploadMatch[1]);
      const conversation = store.getConversation(conversationId);

      if (!conversation) {
        throw createHttpError(404, '会话不存在');
      }

      const contentType = String(req.headers['content-type'] || '');
      const rawBody = await readRawRequestBody(req, { bodyLimit: MAX_UPLOAD_BODY_BYTES });
      const parsed = parseMultipart(rawBody, contentType);

      if (parsed.ok === false) {
        const failure = parsed as { ok: false; reason: string };
        sendUploadError(res, { statusCode: 400, code: failure.reason, reason: failure.reason });
        return true;
      }

      const parsedOk = parsed as { ok: true; fields: Record<string, string>; files: Array<{ fieldName: string; fileName: string; mimeType: string; content: Buffer }> };

      const clientRequestId = String(parsedOk.fields.client_request_id || '').trim();

      if (!clientRequestId) {
        sendUploadError(res, {
          statusCode: 400,
          code: 'CLIENT_REQUEST_ID_REQUIRED',
          reason: 'client_request_id is required',
        });
        return true;
      }

      const candidates = parsedOk.files.map((file) => ({
        fieldName: file.fieldName,
        fileName: file.fileName,
        mimeType: file.mimeType,
        content: file.content,
      }));

      const outcome = await uploadService.upload(conversationId, clientRequestId, candidates);

      if (outcome.kind === 'ok') {
        sendJson(res, 200, { images: outcome.images });
        return true;
      }

      if (outcome.kind === 'in_progress') {
        res.setHeader('Retry-After', String(Math.ceil(outcome.retryAfterMs / 1000)));
        sendJson(res, 202, {
          error: {
            code: 'UPLOAD_IN_PROGRESS',
            message: 'Upload already in progress for this client_request_id; retry shortly',
          },
          retryAfterMs: outcome.retryAfterMs,
        });
        return true;
      }

      if (outcome.kind === 'conflict') {
        sendJson(res, 409, {
          error: {
            code: 'UPLOAD_IDEMPOTENCY_CONFLICT',
            message: 'The payload changed for this client_request_id; use a new client_request_id',
          },
          existingImages: outcome.existingImages,
        });
        return true;
      }

      sendUploadError(res, outcome);
      return true;
    }

    return false;
  };

  return { handle };
}
