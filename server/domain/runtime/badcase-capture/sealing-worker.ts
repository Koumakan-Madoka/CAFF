// Trusted file-only worker. No SQLite, model, agent, shell or target-tree reads.
import { saveSealedCase, sealFailureCodes } from './sealed-case';
let length = 0;
const chunks: Buffer[] = [];
process.stdin.on('data', (data: Buffer) => {
  length += data.length;
  if (length > 16384) { process.exit(2); return; }
  chunks.push(data);
});
process.stdin.on('end', () => {
  let response: any;
  try { response = { ok: true, result: saveSealedCase(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }; }
  catch (error: any) { response = { ok: false, code: sealFailureCodes.includes(error?.code) ? error.code : 'seal_write_failed' }; }
  process.stdout.write(JSON.stringify(response));
});
process.stdin.on('error', () => process.exit(2));
