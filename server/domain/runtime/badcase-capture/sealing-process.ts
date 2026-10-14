import path from 'node:path';
import { spawn } from 'node:child_process';
import { readSealedCase, sealFailureCodes, validateSealRequest, trajectorySummary } from './sealed-case';
const fail = (code: string) => Object.assign(Error(code), { code });
let active = 0;
export async function sealCheckpointAsync(request: any): Promise<any> {
  const clean = { ...validateSealRequest(request), trajectory: trajectorySummary(request.trajectory) };
  const bytes = JSON.stringify(clean);
  if (Buffer.byteLength(bytes) > 16384) throw fail('seal_record_invalid');
  if (active >= 2) throw fail('seal_busy');
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=192', path.join(__dirname, 'sealing-worker.js')], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let reason = '', count = 0;
      const chunks: Buffer[] = [];
      const stop = (code: string) => { reason ||= code; try { child.kill('SIGKILL'); } catch {} };
      const timer = setTimeout(() => stop('seal_timeout'), 30000);
      child.on('error', () => stop('seal_process_failed'));
      child.stdin.on('error', () => {});
      const consume = (chunk: Buffer, stdout: boolean) => {
        count += chunk.length;
        if (count > 65536 + 1024) { stop('seal_output_limit'); return; }
        if (stdout && !reason) chunks.push(chunk);
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
      child.stdin.end(bytes);
    });
  } finally { active--; }
}
