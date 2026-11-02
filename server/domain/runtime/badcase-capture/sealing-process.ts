import path from 'node:path';
import { spawn } from 'node:child_process';
import { readSealedCase, sealFailureCodes, validateSealRequest, trajectorySummary } from './sealed-case';
import { acquireProjectWriteLease } from './project-write-lock';
const fail = (code: string) => Object.assign(Error(code), { code });
let active = 0;
// Options are trusted test hooks only, never HTTP/DB/policy input.
export async function sealCheckpointAsync(request: any, options: any = {}): Promise<any> {
  const clean = { ...validateSealRequest(request), trajectory: trajectorySummary(request.trajectory) };
  if (Buffer.byteLength(JSON.stringify(clean)) + 128 > 16384) throw fail('seal_record_invalid');
  if (active >= 2) throw fail('seal_busy');
  const bounded = (value: any, ceiling: number) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, ceiling) : ceiling;
  const timeoutMs = bounded(options.timeoutMs, 30000);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
  const lease = acquireProjectWriteLease(clean.captureRoot, clean.association.projectId);
  active++;
  try {
    const bytes = JSON.stringify({ request: clean, lockOwner: lease.owner });
    return await new Promise((resolve, reject) => {
      const child = (() => {
        try { return spawn(process.execPath, ['--max-old-space-size=192', options.workerPath || path.join(__dirname, 'sealing-worker.js')], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch { throw fail('seal_process_failed'); }
      })();
      let reason = '', count = 0;
      const chunks: Buffer[] = [];
      const stop = (code: string) => { reason ||= code; try { child.kill('SIGKILL'); } catch {} };
      const timer = setTimeout(() => stop('seal_timeout'), timeoutMs);
      child.on('error', () => stop('seal_process_failed'));
      child.stdin.on('error', () => {});
      child.on('spawn', () => { try { options.onSpawn?.(child.pid); } catch { stop('seal_process_failed'); } });
      const consume = (chunk: Buffer, stdout: boolean) => {
        count += chunk.length;
        if (count > 65536 + 1024) { stop('seal_output_limit'); return; }
        if (stdout && !reason) {
          chunks.push(chunk);
          try { options.onOutput?.(chunk); } catch { stop('seal_process_failed'); }
        }
      };
      child.stdout.on('data', data => consume(data, true));
      child.stderr.on('data', data => consume(data, false));
      child.on('close', code => {
        clearTimeout(timer);
        if (reason || code !== 0) { reject(fail(reason || 'seal_process_failed')); return; }
        try {
          const output = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (output?.ok === false && sealFailureCodes.includes(output.code)) { reject(fail(output.code)); return; }
          const stored = readSealedCase(clean);
          if (output?.ok !== true || !stored || JSON.stringify(output.result) !== JSON.stringify(stored)) throw Error();
          resolve(stored);
        } catch { reject(fail('seal_output_invalid')); }
      });
      try { child.stdin.end(bytes); } catch { stop('seal_process_failed'); }
    });
  } finally {
    // All spawned-child outcomes settle on close, not kill/error/exit. Only
    // this supervisor owns release; a killed worker cannot strand this lock.
    try { lease.release(); }
    catch { throw fail('seal_lock_release_failed'); }
    finally { active--; }
  }
}
