import path from 'node:path';
import { plannerError } from './embedded-planner-env';

// M4a is a proposal for the real-CLI gate, NOT a launch path or verification
// switch. M4b must not enable unattended runs merely because argv tests pass.
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
