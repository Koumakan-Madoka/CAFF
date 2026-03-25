const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const HOST = process.env.CHAT_APP_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.CHAT_APP_PORT || '3100', 10);
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024;

module.exports = {
  DEFAULT_BODY_LIMIT,
  HOST,
  PORT,
  PUBLIC_DIR,
  ROOT_DIR,
};
