import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ServerResponse } from 'node:http';

import config = require('../app/config');
import { sendText } from './response';

export type StaticFileServeOptions = {
  publicDir?: string;
};

function isPathWithin(parentDir: string, targetPath: string) {
  const relative = path.relative(parentDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveContentType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.html') {
    return 'text/html; charset=utf-8';
  }

  if (ext === '.css') {
    return 'text/css; charset=utf-8';
  }

  if (ext === '.js') {
    return 'application/javascript; charset=utf-8';
  }

  return 'application/octet-stream';
}

export function serveStaticFile(res: ServerResponse, pathname: string, options: StaticFileServeOptions = {}) {
  const publicDir = path.resolve(options.publicDir || config.PUBLIC_DIR);
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const normalizedPath = path
    .normalize(requestedPath)
    .replace(/^(\.\.[\\/])+/, '')
    .replace(/^[\\/]+/, '');
  const absolutePath = path.join(publicDir, normalizedPath);

  if (!isPathWithin(publicDir, absolutePath)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let filePath = absolutePath;

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    sendText(res, 404, 'Not Found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': resolveContentType(filePath),
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}
