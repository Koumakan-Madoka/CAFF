const path = require('node:path');

export const ROOT_DIR = path.resolve(__dirname, '..', '..');
export const HOST = process.env.CHAT_APP_HOST || '127.0.0.1';
export const PORT = Number.parseInt(process.env.CHAT_APP_PORT || '3100', 10);
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024;
