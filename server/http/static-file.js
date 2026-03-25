const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_DIR } = require('../app/config');
const { sendText } = require('./response');

function isPathWithin(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveContentType(filePath) {
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

function serveStaticFile(res, pathname, options = {}) {
  const publicDir = path.resolve(options.publicDir || PUBLIC_DIR);
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

module.exports = {
  serveStaticFile,
};
