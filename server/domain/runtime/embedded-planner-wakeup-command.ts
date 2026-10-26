import path from 'node:path';
import { plannerError } from './embedded-planner-env';

// Original M4a candidate is retained for reproducible gate fixtures. Runtime
// uses only buildVerifiedPlannerWakeup, pinned to the 2026-10-26 CLI gate.
export function buildPlannerWakeupCandidate(options: { sessionId: string; appendPrompt: string; nodePath?: string; adapterPath?: string }) {
  const quotePath = (value: string) => {
    if ((!path.isAbsolute(value) && !path.win32.isAbsolute(value)) || /[\u0000-\u001f\u007f'"$`;&|<>()*?\[\],]/.test(value) || value.length > 4096) throw plannerError('planner_wakeup_prefix_invalid');
    return "'" + value.replace(/\\/g, '/') + "'";
  };
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(options.sessionId) || Buffer.byteLength(options.appendPrompt) > 16384) throw plannerError('planner_wakeup_prompt_invalid');
  const adapterPrefix = quotePath(options.nodePath || process.execPath) + ' ' + quotePath(options.adapterPath || path.resolve(__dirname, '../../../lib/caff.js'));
  const tools = 'Read,Glob,Grep,Bash';
  const allowedTools = ['Read','Glob','Grep', ...['state','goal read','attention read*','goal action --json *','owner message --json *','wakeup finish --attempt * --json *'].map(suffix => `Bash(${adapterPrefix} ${suffix})`)].join(',');
  const disallowedTools = 'Write,Edit,NotebookEdit,MultiEdit,PowerShell,Agent,Task,Skill,WebFetch,WebSearch,ToolSearch,mcp__*';
  const args = ['-p', '--resume', options.sessionId, '--verbose', '--output-format', 'stream-json', '--max-turns', '12',
    '--append-system-prompt', options.appendPrompt, '--tools', tools, '--allowedTools', allowedTools, '--disallowedTools', disallowedTools,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  return { verified: false as const, adapterPrefix, tools, allowedTools, disallowedTools, args };
}

export function buildVerifiedPlannerWakeup(options: Parameters<typeof buildPlannerWakeupCandidate>[0] & { version: string }) {
  try {
    if (!/^2\.1\.(0|[1-9][0-9]*)$/.test(options.version) || Number(options.version.split('.')[2]) < 310) throw new Error();
    const candidate = buildPlannerWakeupCandidate(options);
    if (/\s/.test((options.nodePath || process.execPath)) || /\s/.test(options.adapterPath || path.resolve(__dirname, '../../../lib/caff.js'))) throw new Error();
    return { ...candidate, verified: true as const, args: [...candidate.args, '--permission-mode', 'dontAsk'] };
  } catch { throw plannerError('planner_wakeup_tools_unverified'); }
}
