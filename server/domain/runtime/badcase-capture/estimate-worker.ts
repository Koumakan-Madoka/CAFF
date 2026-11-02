// Dedicated trusted management child. Keep the existing same-fd constrained
// collector unchanged; all its blocking probes and enumeration happen here.
import { createBadcaseCaptureService } from './index';

if (require.main === module) {
  const chunks: Buffer[] = [];
  let size = 0;
  process.stdin.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 65536) { process.exitCode = 1; process.stdin.destroy(); return; }
    chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof input.captureRoot !== 'string' || typeof input.projectId !== 'string' || typeof input.targetDir !== 'string') {
        throw Error('invalid_input');
      }
      const service = createBadcaseCaptureService({ captureRoot: input.captureRoot });
      process.stdout.write(JSON.stringify(service.estimateDirectory(input.projectId, input.targetDir)));
    } catch { process.exitCode = 1; }
  });
}
