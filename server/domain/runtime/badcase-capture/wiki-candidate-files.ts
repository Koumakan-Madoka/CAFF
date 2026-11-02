// Read only registered sealed snapshots for candidate leakage checks. Never
// read live worktrees, restore files, execute code, or acquire model credentials.
import crypto from 'node:crypto';
import { createCaptureStore } from './capture-store';
import { createCheckpointRetentionStore } from './checkpoint-retention';
import { readSealedCase, validateSealRequest } from './sealed-case';
import { containsSecretSentinel } from './secrets';
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
export function collectWikiCandidateFiles(state: any): any[] {
  try {
    const files: any[] = []; let total = 0;
    for (const replay of state.replayCases || []) {
      const { captureRoot, association, flagId } = validateSealRequest(replay.request);
      const sealed = readSealedCase({ captureRoot, association, flagId });
      if (!sealed) throw Error();
      const store = createCaptureStore({ captureRoot });
      const retained = createCheckpointRetentionStore({ captureStore: store }).get({
        ...Object.fromEntries(['projectId', 'checkpointId', 'conversationId', 'turnId', 'agentId'].map(k => [k, association[k]])), referenceId: sealed.referenceId,
      });
      if (!retained || hash(JSON.stringify(retained.checkpoint)) !== replay.checkpointHash) throw Error();
      const blobs = new Map<string, Buffer>();
      for (const digest of retained.blobHashes) {
        const bytes = store.readBlob(association.projectId, digest);
        if (!Buffer.isBuffer(bytes) || hash(bytes) !== digest || containsSecretSentinel(bytes)) throw Error();
        total += bytes.length;
        if (total > 4 * 1024 * 1024) throw Error();
        blobs.set(digest, bytes);
      }
      for (const name of Object.keys(retained.checkpoint.files).sort()) {
        const f = retained.checkpoint.files[name], bytes = blobs.get(f.hash);
        if (f.type !== 'file' || f.secretExcluded || !bytes || bytes.length !== f.size) throw Error();
        files.push({ path: replay.id + '/' + name, base64: bytes.toString('base64'), sha256: f.hash });
        if (files.length > 1024) throw Error();
      }
    }
    return files;
  } catch { throw Object.assign(Error('wiki_candidate_anchor_unsupported'), { code: 'wiki_candidate_anchor_unsupported' }); }
}
