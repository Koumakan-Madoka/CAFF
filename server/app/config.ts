const path = require('node:path');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3100;
const DEFAULT_PROTOCOL = 'http';

function normalizeText(value: any) {
  return String(value || '').trim();
}

function normalizePort(value: any, fallback = DEFAULT_PORT) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value: any) {
  return normalizeText(value).replace(/\/+$/u, '');
}

function isWildcardHost(host: string) {
  const normalized = normalizeText(host).toLowerCase();
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

function isLoopbackHost(host: string) {
  const normalized = normalizeText(host).toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

function formatUrlHost(host: string) {
  const normalized = normalizeText(host);
  if (!normalized) {
    return '';
  }
  if (normalized.includes(':') && !normalized.startsWith('[') && !normalized.endsWith(']')) {
    return `[${normalized}]`;
  }
  return normalized;
}

export function resolveSkillTestOpenSandboxChatApiUrl(input: any = {}) {
  const explicitUrl = normalizeBaseUrl(input.explicitUrl);
  if (explicitUrl) {
    return explicitUrl;
  }

  const advertisedUrl = normalizeBaseUrl(input.advertisedUrl);
  if (advertisedUrl) {
    return advertisedUrl;
  }

  const host = normalizeText(input.host);
  if (!host || isWildcardHost(host) || isLoopbackHost(host)) {
    return '';
  }

  const protocol = normalizeText(input.protocol).toLowerCase() || DEFAULT_PROTOCOL;
  const port = normalizePort(input.port, DEFAULT_PORT);
  return `${protocol}://${formatUrlHost(host)}:${port}`;
}

export const ROOT_DIR = path.resolve(__dirname, '..', '..');
export const HOST = normalizeText(process.env.CHAT_APP_HOST) || DEFAULT_HOST;
export const PORT = normalizePort(process.env.CHAT_APP_PORT, DEFAULT_PORT);
export const CHAT_APP_ADVERTISE_URL = normalizeBaseUrl(process.env.CHAT_APP_ADVERTISE_URL);
export const SKILL_TEST_OPENSANDBOX_CHAT_API_URL = resolveSkillTestOpenSandboxChatApiUrl({
  explicitUrl: process.env.CAFF_SKILL_TEST_OPENSANDBOX_CHAT_API_URL,
  advertisedUrl: CHAT_APP_ADVERTISE_URL,
  host: HOST,
  port: PORT,
  protocol: DEFAULT_PROTOCOL,
});
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024;
