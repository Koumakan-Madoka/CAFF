// Trusted file-only worker. No SQLite, model, agent, shell or target-tree reads.
import { saveSealedCase, sealFailureCodes, validateSealRequest } from './sealed-case';
import { withDelegatedProjectWriteLock } from './project-write-lock';
let length = 0;
const chunks: Buffer[] = [];
process.stdin.on('data', (data: Buffer) => {
  length += data.length;
  if (length > 16384) { process.exit(2); return; }
  chunks.push(data);
});
process.stdin.on('end', () => {
  let response: any;
  try {
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const request = validateSealRequest(envelope.request);
    const result = withDelegatedProjectWriteLock(request.captureRoot, request.association.projectId, envelope.lockOwner,
      () => saveSealedCase({ ...request, trajectory: envelope.request.trajectory }));
    response = { ok: true, result };
  }
  catch (error: any) { response = { ok: false, code: sealFailureCodes.includes(error?.code) ? error.code : 'seal_write_failed' }; }
  process.stdout.write(JSON.stringify(response));
});
process.stdin.on('error', () => process.exit(2));
