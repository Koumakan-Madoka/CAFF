// Deliberately small shell grammar: inspect text only. Never spawn/read/expand.
// Target-named unsupported syntax is unknown; unrelated commands need no argument validation.
import type { WikiToolCheck } from './wiki-tool-check';
import { publicMessage } from './wiki-run-replay';
export type WikiParsedToolCall = { kind: 'other' } | { kind: 'unknown' }
  | { kind: 'target'; parameters: Record<string, unknown> };
interface Word { text: string; raw: string; dynamic: boolean; pipe?: boolean }
const unknown: WikiParsedToolCall = { kind: 'unknown' }, other: WikiParsedToolCall = { kind: 'other' };
function words(command: string): Word[] | null {
  const result: Word[] = []; let i = 0;
  while (i < command.length) {
    if (/[ \t]/.test(command[i])) { i++; continue; }
    if (command[i] === '|') { result.push({ text: '|', raw: '|', dynamic: false, pipe: true }); i++; continue; }
    const start = i; let text = '', dynamic = false, quote = '';
    while (i < command.length) {
      const ch = command[i];
      if (!quote && /[ \t|]/.test(ch)) break;
      if (!quote && /[\r\n;&<>()*?\[\]{}~]/.test(ch)) return null;
      if (ch === "'" && quote !== '"' || ch === '"' && quote !== "'") {
        quote = quote ? '' : ch; i++; continue;
      }
      if (ch === '\\' && quote !== "'") {
        const next = command[++i];
        if (next === undefined || /[\r\n]/.test(next)) return null;
        // Bash double quotes only remove backslashes before these four chars.
        if (quote === '"' && !/[$`"\\]/.test(next)) text += '\\';
        text += next; i++; continue;
      }
      if (quote !== "'" && /[$`]/.test(ch)) dynamic = true;
      text += ch; i++;
    }
    if (quote) return null;
    result.push({ text, raw: command.slice(start, i), dynamic });
    if (result.length > 512) return null;
  }
  return result;
}
const bridgePath = (s: string) => s === '$CAFF_CHAT_TOOLS_PATH' || /^(?:\.\/)?build\/lib\/agent-chat-tools\.js$/.test(s);
function jsonDisplayOnly(script: string): boolean {
  // Recognize the production stdout-only wrapper, not arbitrary JavaScript.
  // Closed grammar: accumulate stdin, JSON.parse, project properties, stringify.
  const compact = script.replace(/[ \t\r\n]/g, '');
  const match = /^let([a-z])="";process\.stdin\.on\("data",([a-z])=>\1\+=\2\)(?:\.on|;process\.stdin\.on)\("end",\(\)=>\{(?:if\(!\1\)process\.exit\(1\);)?const([a-z])=JSON\.parse\(\1\);console\.log\(JSON\.stringify\(\{([^{}]+)\},null,2\)\);\}\);?$/.exec(compact);
  if (!match) return false;
  const field = new RegExp(String.raw`^[A-Za-z][A-Za-z0-9_]*:${match[3]}(?:\??\.[A-Za-z][A-Za-z0-9_]*)+$`);
  return match[4].split(',').every(value => field.test(value));
}
function parseBash(command: string, target: WikiToolCheck['target']): WikiParsedToolCall {
  // D3: only target-call arguments require parsing. Do not invalidate normal
  // continuation (compounds/pipelines/scripts included) or expand hidden names.
  if (!command.includes(target.name)) return other;
  // The historical public-reply grammar already understands its quoted heredoc.
  if (target.name !== 'send-public' && publicMessage({ name: 'bash', arguments: { command } }) !== null) return other;
  if (!command.trim() || command.length > 1024 * 1024 || command.includes('\0')) return unknown;
  const tokens = words(command.trim());
  if (!tokens || !tokens.length) return unknown;
  const pipe = tokens.findIndex(t => t.pipe), head = pipe < 0 ? tokens : tokens.slice(0, pipe);
  const nodeBridge = head[0]?.text === 'node' && bridgePath(head[1]?.text);
  if (!nodeBridge) return unknown;
  if (head.length < 3 || head[0].dynamic || head[2].dynamic || head[2].pipe
    || head[1].dynamic && !['"$CAFF_CHAT_TOOLS_PATH"', '$CAFF_CHAT_TOOLS_PATH'].includes(head[1].raw)) return unknown;
  const name = head[2].text;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name)) return unknown;
  // Recognized other bridge subcommands are unrelated even with file/stdin or
  // dynamic argument values. Validate parameters and output tails only below.
  if (name !== target.name) return other;
  if (pipe >= 0) {
    // Production #23/#24 pipe the inline result to a literal JSON display script.
    // Inspect the inline invocation, never run or interpret the display script.
    const tail = tokens.slice(pipe + 1);
    if (tail.length !== 3 || tail[0].text !== 'node' || tail[1].text !== '-e' || tail.some(t => t.pipe || t.dynamic)
      || !/^['"]/.test(tail[2].raw) || !jsonDisplayOnly(tail[2].text)) return unknown;
  }
  const parameters: Record<string, unknown> = Object.create(null);
  for (let i = 3; i < head.length; i += 2) {
    const flag = head[i], value = head[i + 1];
    if (flag.dynamic || !/^--[A-Za-z][A-Za-z0-9_-]*$/.test(flag.text) || !value || value.dynamic || value.pipe
      || value.text.startsWith('--') || /(?:^--|-)(?:stdin|file)(?:-|$)/.test(flag.text) || Object.hasOwn(parameters, flag.text.slice(2))) return unknown;
    parameters[flag.text.slice(2)] = value.text;
  }
  return { kind: 'target', parameters };
}
export function parseWikiToolCall(call: any, target: WikiToolCheck['target']): WikiParsedToolCall {
  if (!call || typeof call.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(call.name)
    || !call.arguments || Object.getPrototypeOf(call.arguments) !== Object.prototype) return unknown;
  if (target.kind === 'native') {
    return call.name === target.name ? { kind: 'target', parameters: call.arguments } : other;
  }
  if (call.name !== 'bash') return other;
  return typeof call.arguments?.command === 'string' ? parseBash(call.arguments.command, target) : unknown;
}
