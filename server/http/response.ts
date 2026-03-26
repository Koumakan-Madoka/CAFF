import * as fs from 'node:fs';

import type { ServerResponse } from 'node:http';

import { createHttpError } from './http-errors';

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
