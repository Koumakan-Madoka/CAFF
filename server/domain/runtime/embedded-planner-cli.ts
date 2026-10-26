import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { plannerError } from './embedded-planner-env';
import { launchPlannerPty } from './embedded-planner-pty';

export const MINIMUM_PLANNER_CLI = '2.1.310';
export type PlannerCli = { file: string; prefix: string[] };

export function resolvePlannerCli(options: { override?: string; env?: NodeJS.ProcessEnv }): PlannerCli {
  const env = options.env || process.env;
  const override = options.override;
  const pathValue = env.PATH || env.Path || '';
  const candidates = override ? [path.resolve(override)] : pathValue.split(path.delimiter).filter(Boolean)
    .flatMap(dir => process.platform === 'win32' ? [path.join(dir, 'claude.exe'), path.join(dir, 'claude.cmd')]
      : [path.join(dir, 'claude')]);
  for (let candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    // Support the standard npm installation without executing/parsing its shell shim.
    if (/\.cmd$/i.test(candidate)) {
      const entry = path.join(path.dirname(candidate), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (!fs.existsSync(entry)) throw plannerError('planner_cli_launch_unsupported');
      candidate = entry;
    }
    if (/\.(?:js|cjs)$/i.test(candidate)) return { file: process.execPath, prefix: [candidate] };
    if (/\.(?:ps1|bat)$/i.test(candidate)) throw plannerError('planner_cli_launch_unsupported');
    if (process.platform === 'win32' && !/\.exe$/i.test(candidate)) throw plannerError('planner_cli_launch_unsupported');
    return { file: candidate, prefix: [] };
  }
  throw plannerError('planner_cli_missing');
}

export async function probePlannerCli(cli: PlannerCli, env: NodeJS.ProcessEnv, options: { timeoutMs?: number } = {}): Promise<string> {
  // The probe uses the same parent-death/tree guardian as an interactive CLI.
  // It owns the startup admission slot; no room launches are admitted yet.
  const startedAt = performance.now();
  const child = await launchPlannerPty({ cli, env, cwd: process.cwd(), args: ['--version'], cols: 120, rows: 30 });
  return new Promise((resolve, reject) => {
    let size = 0, output = '', failure = '';
    const timer = setTimeout(() => { failure = 'planner_cli_probe_timeout'; child.stop(); }, Math.max(0, (options.timeoutMs ?? 5000) - (performance.now() - startedAt)));
    const uncertainTimer = setTimeout(() => { child.stop(); reject(plannerError('planner_cli_probe_timeout')); }, (options.timeoutMs ?? 5000) + 11000);
    child.on('data', (data: string) => {
      size += Buffer.byteLength(data);
      if (size > 8192) { failure = 'planner_cli_version_invalid'; child.stop(); }
      else output += data;
    });
    child.once('uncertain', () => { clearTimeout(timer); clearTimeout(uncertainTimer); reject(plannerError('planner_cli_launch_unsupported')); });
    child.once('exit', ({ exitCode }: { exitCode: number }) => {
      clearTimeout(timer); clearTimeout(uncertainTimer);
      if (failure) return reject(plannerError(failure));
      const text = stripVTControlCharacters(output.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')).trim();
      const match = /^(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?\s*$/.exec(text);
      if (exitCode !== 0 || !match) return reject(plannerError('planner_cli_version_invalid'));
      const numbers = match.slice(1).map(Number);
      if (numbers.some(n => !Number.isSafeInteger(n))) return reject(plannerError('planner_cli_version_invalid'));
      const [a,b,c] = numbers;
      if (a < 2 || (a === 2 && (b < 1 || (b === 1 && c < 310)))) return reject(plannerError('planner_cli_version_unsupported'));
      resolve(numbers.join('.'));
    });
  });
}
