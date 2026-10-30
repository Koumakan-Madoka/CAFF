import path from 'node:path';

export function plannerError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

// Construct, never subtract. Do not include source values in any diagnostic.
export function buildPlannerEnvironment(options: {
  source?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; baseUrl: string;
  roomId?: string; credentialPath?: string | null; interactive?: boolean;
}): NodeJS.ProcessEnv {
  const source = options.source || process.env;
  const windows = (options.platform || process.platform) === 'win32';
  const env: NodeJS.ProcessEnv = {};
  const names = ['PATH', 'HOME', ...(windows
    ? ['SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
    : ['XDG_STATE_HOME', 'TMPDIR'])];
  const proxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  names.push(...proxies, ...(!windows ? proxies.map(k => k.toLowerCase()) : []));
  for (const name of names) {
    const key = Object.hasOwn(source, name) ? name : windows
      ? Object.keys(source).find(k => k.toUpperCase() === name.toUpperCase()) : undefined;
    if (key && typeof source[key] === 'string') env[name] = source[key];
  }
  if (!env.PATH || (windows ? !env.SystemRoot || !env.USERPROFILE : !env.HOME)) {
    throw plannerError('planner_environment_invalid');
  }
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT = '1';
  env.CAFF_BASE_URL = options.baseUrl;
  if (options.roomId) env.CAFF_ROOM_ID = options.roomId;
  if (options.credentialPath) {
    if (!path.isAbsolute(options.credentialPath)) throw plannerError('planner_environment_invalid');
    env.CAFF_PLANNER_CREDENTIAL_FILE = options.credentialPath;
  }
  if (options.interactive) {
    env.TERM = 'xterm-256color'; env.COLORTERM = 'truecolor';
    // Pin fullscreen without recording early PTY stops as shared boot failures.
    // Print wake-ups and version probes deliberately omit this generated flag.
    env.CLAUDE_CODE_NO_FLICKER = '1';
  }
  return env;
}
