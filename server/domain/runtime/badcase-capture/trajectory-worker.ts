// Trusted, one-shot archival source reader, NOT an agent runtime. No migrations,
// ChatStore constructor, shell, model or filesystem/session traversal is run.
import fs from 'node:fs';
import path from 'node:path';
import { readBadcaseTrajectory, trajectoryFailureCodes, validateTrajectoryRequest } from './trajectory';
const Database = require('better-sqlite3');

let length = 0;
const chunks: Buffer[] = [];
process.stdin.on('data', (chunk: Buffer) => {
  length += chunk.length;
  if (length > 16384) { process.exit(2); return; }
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  let db: any;
  let response: any;
  try {
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const validated = validateTrajectoryRequest(request);
    if (typeof request.databasePath !== 'string' || !path.isAbsolute(request.databasePath)
      || !fs.statSync(request.databasePath).isFile()) throw new Error('invalid database');
    // File must exist; never create a database or run schema migrations here.
    db = new Database(request.databasePath, { readonly: true, fileMustExist: true, timeout: 1000 });
    db.pragma('query_only = ON');
    response = { ok: true, result: readBadcaseTrajectory({ db, ...validated }) };
  } catch (error: any) {
    response = { ok: false, code: trajectoryFailureCodes.includes(error?.code) ? error.code : 'trajectory_unavailable' };
  } finally {
    try { db?.close(); }
    catch { response = { ok: false, code: 'trajectory_unavailable' }; }
  }
  process.stdout.write(JSON.stringify(response));
  // Parent waits for close and exit code: output followed by native abort is
  // NOT success. Let Node exit naturally; no process.exit(0) hides teardown.
});
process.stdin.on('error', () => process.exit(2));
