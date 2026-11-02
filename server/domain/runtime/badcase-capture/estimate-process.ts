// Management estimates run outside the HTTP event loop, including capability
// probes/statx and Python's synchronous walk. This is trusted capture plumbing,
// NOT an agent replay runtime or a sandbox. No model/agent is started here.
import path from 'node:path';
import { spawn } from 'node:child_process';

let active = 0;
const MAX_ACTIVE = 2;

export async function runEstimateProcess(request: any, options: any = {}): Promise<any> {
  const startedAt = Date.now();
  const fail = (reason: string) => ({ ok: false, reason, fileCount: 0, totalBytes: 0, durationMs: Date.now() - startedAt });
  // Process-group termination is a Linux contract, not a Windows tree-kill
  // approximation. Other platforms already lack constrained capture support.
  if (process.platform !== 'linux') return fail(`capture_unavailable:safe_read_capability_missing:${process.platform}`);
  if (active >= MAX_ACTIVE) return fail('estimate_busy');
  active++;
  try {
    return await new Promise(resolve => {
      const timeoutMs = Math.max(1, Math.min(Number(options.timeoutMs) || 30000, 30000));
      const maxOutputBytes = Math.max(1, Math.min(Number(options.maxOutputBytes) || 4 * 1024 * 1024, 4 * 1024 * 1024));
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, ['--max-old-space-size=128', options.workerPath || path.join(__dirname, 'estimate-worker.js')], {
          detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
      } catch { resolve(fail('estimate_process_failed')); return; }
      let reason = '';
      let outputBytes = 0;
      const chunks: Buffer[] = [];
      const killGroup = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error: any) {
          if (error?.code !== 'ESRCH') reason = 'estimate_cleanup_failed';
        }
      };
      const stop = (why: string) => {
        if (!reason) reason = why;
        killGroup();
      };
      const timer = setTimeout(() => stop('estimate_timeout'), timeoutMs);
      child.on('error', () => stop('estimate_process_failed'));
      child.stdin!.on('error', () => { /* early exits are checked on close */ });
      child.stdout!.on('data', (bytes: Buffer) => {
        outputBytes += bytes.length;
        if (outputBytes > maxOutputBytes) { stop('estimate_output_limit'); return; }
        chunks.push(bytes);
        // Internal test observer; never supplied from HTTP or persisted policy.
        options.onOutput?.(bytes);
      });
      // Discard diagnostics rather than archiving potentially private paths.
      child.stderr!.on('data', (bytes: Buffer) => {
        outputBytes += bytes.length;
        if (outputBytes > maxOutputBytes) stop('estimate_output_limit');
      });
      // 'close', not 'exit': wait until killed helpers release inherited pipes.
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        killGroup();
        if (reason) { resolve(fail(reason)); return; }
        if (code !== 0) { resolve(fail('estimate_process_failed')); return; }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!result || typeof result.ok !== 'boolean' || !Number.isSafeInteger(result.fileCount)
            || result.fileCount < 0 || !Number.isSafeInteger(result.totalBytes) || result.totalBytes < 0
            || (result.ok && typeof result.complete !== 'boolean')) throw Error('invalid');
          resolve({ ...result, durationMs: Date.now() - startedAt });
        } catch { resolve(fail('estimate_output_invalid')); }
      });
      try { child.stdin!.end(JSON.stringify(request)); }
      catch { stop('estimate_input_invalid'); }
    });
  } finally { active--; }
}
