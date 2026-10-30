import fs from 'node:fs';
import path from 'node:path';

export type WakeupSettingsIssue = { file: string; kind: 'bash_allow' | 'additional_directories' | 'unreadable' | 'invalid_json' };
type SettingsStatus = { available: true; reasonCode: ''; issue?: undefined }
  | { available: false; reasonCode: 'planner_wakeup_settings_unsafe'; issue: WakeupSettingsIssue };

// Inspect only the settings the *child* loads, never CAFF's own HOME/config.
// No content, rule, parse exception or other field is returned in diagnostics.
export function checkPlannerWakeupSettings(options: {
  env: NodeJS.ProcessEnv; platform?: NodeJS.Platform; managedSettingsDir?: string;
}): SettingsStatus {
  const platform = options.platform || process.platform;
  const value = (name: string) => options.env[platform === 'win32'
    ? Object.keys(options.env).find(key => key.toUpperCase() === name.toUpperCase()) || name : name];
  const configDir = value('CLAUDE_CONFIG_DIR') || path.join(value(platform === 'win32' ? 'USERPROFILE' : 'HOME') || '', '.claude');
  const managedDir = options.managedSettingsDir ?? (platform === 'win32' ? 'C:\\Program Files\\ClaudeCode'
    : platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code');
  const unsafe = (file: string, kind: WakeupSettingsIssue['kind']): SettingsStatus => ({
    available: false, reasonCode: 'planner_wakeup_settings_unsafe', issue: { file, kind },
  });
  const files = [path.join(configDir, 'settings.json'), path.join(managedDir, 'managed-settings.json')];
  const fragments = path.join(managedDir, 'managed-settings.d');
  try {
    files.push(...fs.readdirSync(fragments).filter(name => name.toLowerCase().endsWith('.json')).sort().map(name => path.join(fragments, name)));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') return unsafe(fragments, 'unreadable');
  }
  for (const file of files) {
    // lstat distinguishes a missing file from an existing dangling link.
    try { fs.lstatSync(file); }
    catch (error: any) { if (error?.code === 'ENOENT') continue; return unsafe(file, 'unreadable'); }
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { return unsafe(file, 'unreadable'); }
    let settings: any;
    try { settings = JSON.parse(text); }
    catch { return unsafe(file, 'invalid_json'); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return unsafe(file, 'invalid_json');
    const permissions = settings.permissions;
    if (Array.isArray(permissions?.allow) && permissions.allow.some((rule: unknown) =>
      typeof rule === 'string' && rule.split('(', 1)[0].replace(/\s/g, '') === 'Bash')) return unsafe(file, 'bash_allow');
    if (Array.isArray(permissions?.additionalDirectories) && permissions.additionalDirectories.length) return unsafe(file, 'additional_directories');
  }
  return { available: true, reasonCode: '' };
}
