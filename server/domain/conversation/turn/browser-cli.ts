const path = require('node:path');

function normalizeEnvPath(value: any, rootDir: string) {
  const rawPath = String(value || '').trim();

  if (!rawPath) {
    return '';
  }

  return path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(rootDir, rawPath);
}

export function resolveBrowserCliPath(options: any = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const rootDir = path.resolve(String(options.rootDir || process.cwd()).trim() || process.cwd());

  return normalizeEnvPath(env.CAFF_BROWSER_CLI_PATH, rootDir);
}

export function createBrowserCliSessionName(conversationId: any, agentId: any) {
  const normalized = `caff-${conversationId || 'conversation'}-${agentId || 'agent'}`
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return normalized.slice(0, 120) || 'caff-browser';
}
