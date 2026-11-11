// Read one exact immutable comparison, including older records outside the
// page's latest-20 window. No wiki-store dependency and no path from HTTP.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { containsSecretSentinel } from './secrets';
import { WIKI_COMPARISON_V2_MAX_BYTES } from './wiki-comparison-scoring';
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (value: any) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function readWikiComparisonRecord(globalRoot: string, comparisonId: string, project: (input: any) => any): any {
  if (!path.isAbsolute(globalRoot) || !/^comparison-[a-f0-9]{64}$/.test(comparisonId)) throw fail('wiki_comparison_invalid');
  const filename = comparisonId.slice('comparison-'.length) + '.json';
  try {
    const file = path.join(globalRoot, 'comparisons', filename), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > WIKI_COMPARISON_V2_MAX_BYTES) throw Error();
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')), { id, createdAt, ...payload } = envelope.record;
    if (stat.size > (['wiki-staged-batch-comparison-v2', 'wiki-mode-holdout-comparison-v1'].includes(payload.kind) ? WIKI_COMPARISON_V2_MAX_BYTES : 512 * 1024)
      || envelope.schemaVersion !== 1 || envelope.checksum !== hash(envelope.record)
      || id !== comparisonId || id !== 'comparison-' + hash(payload)
      || typeof createdAt !== 'string' || new Date(createdAt).toISOString() !== createdAt
      || JSON.stringify(project(payload)) !== JSON.stringify(payload)
      || containsSecretSentinel(JSON.stringify(envelope.record))) throw Error();
    return envelope.record;
  } catch (e: any) {
    throw fail(e.code === 'ENOENT' ? 'wiki_comparison_not_found' : 'wiki_comparison_record_invalid');
  }
}
