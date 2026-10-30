import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { plannerError } from './embedded-planner-env';
import { launchPlannerPty } from './embedded-planner-pty';

export const MINIMUM_PLANNER_CLI = '2.1.310';
export type PlannerCli = { file: string; prefix: string[] };

function resolveNpmPlannerEntry(shim: string): string {
  try {
    const pkg = fs.realpathSync(path.join(path.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code'));
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    const bin = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.claude;
    if (typeof bin !== 'string' || !bin.trim() || bin.includes('\0') || path.win32.isAbsolute(bin) || path.posix.isAbsolute(bin)) throw new Error();
    const within = (file: string) => {
      const relative = path.relative(pkg, file);
      return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    const candidate = path.resolve(pkg, bin.replace(/\\/g, path.sep));
    if (!within(candidate)) throw new Error();
    const entry = fs.realpathSync(candidate);
    if (!within(entry) || !fs.statSync(entry).isFile()) throw new Error();
    return entry;
  } catch { throw plannerError('planner_cli_launch_unsupported'); }
}

export function resolvePlannerCli(options: { override?: string; env?: NodeJS.ProcessEnv }): PlannerCli {
  const env = options.env || process.env;
  const override = options.override;
  const pathValue = env.PATH || env.Path || '';
  const candidates = override ? [path.resolve(override)] : pathValue.split(path.delimiter).filter(Boolean)
    .flatMap(dir => process.platform === 'win32' ? [path.join(dir, 'claude.exe'), path.join(dir, 'claude.cmd')]
      : [path.join(dir, 'claude')]);
  for (let candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    // Read the npm package's declared bin; never parse or execute the shim.
    const npmShim = /\.cmd$/i.test(candidate);
    if (npmShim) candidate = resolveNpmPlannerEntry(candidate);
    if (/\.(?:js|cjs|mjs)$/i.test(candidate)) return { file: process.execPath, prefix: [candidate] };
    if (npmShim && !/\.exe$/i.test(candidate)) throw plannerError('planner_cli_launch_unsupported');
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
