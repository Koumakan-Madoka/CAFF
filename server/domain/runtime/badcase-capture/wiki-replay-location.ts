// Host-only migration indirection. Replay records/IDs and their path-bound
// content hashes remain byte-identical. A migrated collection never falls back
// to an old capture root if its copied evidence is absent or damaged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateSealRequest } from './sealed-case';
const fail = () => Object.assign(Error('wiki_migration_location_invalid'), { code: 'wiki_migration_location_invalid' });
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
export function resolveWikiReplayRequest(options: any, input: any) {
  const request = validateSealRequest(input);
  if (options?.globalRoot === undefined) return request;
  if (!path.isAbsolute(options.globalRoot)) throw fail();
  const file = path.join(options.globalRoot, 'capture-locations.json');
  let stat;
  try { stat = fs.lstatSync(file); } catch (e: any) {
    if (e.code === 'ENOENT' && !fs.existsSync(path.resolve(options.globalRoot, '..', 'wiki-migration.json'))) return request;
    throw fail();
  }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw Error();
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')), record = envelope.record;
    if (envelope.schemaVersion !== 1 || envelope.checksum !== hash(JSON.stringify(record))
      || !record || Object.keys(record).sort().join(',') !== 'kind,roots' || record.kind !== 'wiki-capture-locations-v1'
      || !Array.isArray(record.roots) || record.roots.length > 100) throw Error();
    const local = path.resolve(options.globalRoot, '..', 'badcase-capture'), names = new Set();
    let result = path.resolve(request.captureRoot) === local ? local : null;
    for (const r of record.roots) {
      if (!r || Object.keys(r).sort().join(',') !== 'directory,sourceRoot' || !path.isAbsolute(r.sourceRoot || '')
        || r.sourceRoot.includes('\0') || path.resolve(r.sourceRoot) !== r.sourceRoot || names.has(r.sourceRoot) || r.directory !== hash(r.sourceRoot)) throw Error();
      names.add(r.sourceRoot);
      const copied = path.join(local, 'imports', r.directory);
      if (path.resolve(request.captureRoot) === r.sourceRoot || path.resolve(request.captureRoot) === copied) result = copied;
    }
    if (!result) throw Error();
    return { ...request, captureRoot: result };
  } catch { throw fail(); }
}
