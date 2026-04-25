import * as fs from 'node:fs';

import type { ServerResponse } from 'node:http';

import { createHttpError } from './http-errors';

const ERROR_DETAIL_KEYS = ['issues', 'references', 'caseSchemaStatus', 'derivedFromLegacy'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeErrorDetailValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    if (depth >= 5) {
      return [];
    }

    return value
      .map((entry) => sanitizeErrorDetailValue(entry, seen, depth + 1))
      .filter((entry) => entry !== undefined);
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  if (depth >= 5) {
    return {};
  }

  seen.add(value);
  const sanitized: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    const safeValue = sanitizeErrorDetailValue(entry, seen, depth + 1);
    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }

  seen.delete(value);
  return sanitized;
}

export function buildErrorJsonPayload(error: unknown) {
  const errorValue = error as any;
  const payload: Record<string, unknown> = {
    error: (errorValue && errorValue.message) || 'Internal server error',
  };

  if (!Number.isInteger(errorValue && errorValue.statusCode)) {
    return payload;
  }

  for (const key of ERROR_DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(errorValue, key)) {
      continue;
    }

    const safeValue = sanitizeErrorDetailValue(errorValue[key]);
    if (safeValue !== undefined) {
      payload[key] = safeValue;
    }
  }

  return payload;
}

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType = 'text/plain; charset=utf-8'
) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendTextDownload(
  res: ServerResponse,
  body: string,
  fileName: string,
  contentType = 'text/plain; charset=utf-8'
) {
  const safeFileName = sanitizeDownloadFileName(fileName, 'download.txt');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodeURIComponent(safeFileName)}`,
  });
  res.end(body);
}

function sanitizeDownloadFileName(value: string, fallback = 'session.jsonl') {
  const normalized = String(value || '')
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '-');

  return normalized || fallback;
}

export function sendFileDownload(
  res: ServerResponse,
  filePath: string,
  fileName: string,
  contentType = 'application/x-ndjson; charset=utf-8'
) {
  const stats = fs.statSync(filePath);

  if (!stats.isFile()) {
    throw createHttpError(404, 'Requested session export was not found');
  }

  const safeFileName = sanitizeDownloadFileName(fileName, filePath.split(/[\\/]+/).pop() || 'session.jsonl');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': stats.size,
    'Content-Disposition': `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodeURIComponent(safeFileName)}`,
  });

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
}
