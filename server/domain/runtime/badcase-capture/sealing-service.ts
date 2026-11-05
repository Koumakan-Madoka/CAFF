import { readBadcaseTrajectoryAsync } from './trajectory-process';
import { trajectoryFailureCodes } from './trajectory';
import { sealCheckpointAsync } from './sealing-process';
import { readSealedCase, sealFailureCodes, trajectorySummary } from './sealed-case';
const associationFailures = ['flag_seal_association_incomplete', 'flag_seal_association_mismatch', 'flag_not_found', 'flag_record_invalid', 'flag_message_not_found', 'flag_message_not_terminal'];
const processFailures = ['seal_busy', 'seal_timeout', 'seal_process_failed', 'seal_output_limit', 'seal_output_invalid', 'seal_lock_release_failed', 'capture_lock_invalid'];
const failed = (state: string, reason: string) => ({ state, reason, checkpointSaved: false, complete: false,
  captured: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false });
function messageExcerpt(value: any) {
  if (typeof value !== 'string') throw Object.assign(Error('wiki_source_invalid'), { code: 'wiki_source_invalid' });
  if (Buffer.byteLength(value) <= 32768) return { text: value, truncated: false };
  let text = '', size = 0;
  for (const char of value) { size += Buffer.byteLength(char); if (size > 32768) break; text += char; }
  return { text, truncated: true };
}
// POST owns the asynchronous operation. A disconnected client does not cancel
// it; restart queries are read-only and an explicit same-text retry is safe.
// Tests may inject adapters; neither HTTP nor persisted input controls them.
export function createBadcaseSealingService(options: any) {
  const flags = options.flags, store = options.captureStore;
  const inFlight = new Map<string, Promise<any>>();
  const readTrajectory = options.readTrajectory || readBadcaseTrajectoryAsync;
  const sealCheckpoint = options.sealCheckpoint || sealCheckpointAsync;
  function request(scope: any, flag: any) {
    return { captureRoot: store.captureRoot, flagId: flag.flagId, association: flags.resolveSealAssociation(scope) };
  }
  function failure(error: any) {
    const code = error?.code;
    if (associationFailures.includes(code)) return failed('unavailable', code);
    return failed('failed', [...sealFailureCodes, ...processFailures].includes(code) ? code : 'seal_write_failed');
  }
  return {
    get(scope: any) {
      const flag = flags.get(scope);
      if (!flag) return { flag: null, seal: null };
      try {
        const req = request(scope, flag);
        return { flag, seal: readSealedCase(req) || failed(inFlight.has(flag.flagId) ? 'saving' : 'not_saved', 'seal_not_published') };
      } catch (error) { return { flag, seal: failure(error) }; }
    },
    async mark(input: any) {
      // Annotation failures retain their existing HTTP error semantics. No seal
      // dependency can roll back or hide a successfully persisted annotation.
      const marked = flags.mark(input);
      // Freeze before the first await: a resumed session, source deletion or
      // slow checkpoint seal cannot change the packet selected at first mark.
      let trace;
      if (typeof options.freezeTrace === 'function') {
        try { trace = options.freezeTrace(input, marked.flag, marked.created); }
        catch { trace = { error: 'wiki_trace_unavailable' }; }
      }
      const key = marked.flag.flagId;
      if (!inFlight.has(key)) {
        const task = Promise.resolve().then(async () => {
          try {
            const req = request(input, marked.flag);
            const previous = readSealedCase(req);
            let trajectory = previous?.trajectory;
            if (!previous) {
              try {
                const result = await readTrajectory({ databasePath: options.databasePath, association: req.association });
                trajectory = trajectorySummary({ reason: 'trajectory_provenance_unverified', totalTaskEventCount: result.totalTaskEventCount, selectedEventCount: result.archivedEventCount });
              } catch (error: any) {
                trajectory = trajectorySummary({ reason: trajectoryFailureCodes.includes(error?.code) ? error.code : 'trajectory_unavailable' });
              }
              // Recheck the live source after await, before any archive writes.
              const current = request(input, marked.flag);
              if (JSON.stringify(current.association) !== JSON.stringify(req.association)) throw Object.assign(Error('flag_seal_association_mismatch'), { code: 'flag_seal_association_mismatch' });
            }
            return await sealCheckpoint({ ...req, trajectory });
          } catch (error) { return failure(error); }
        });
        inFlight.set(key, task);
        void task.finally(() => { if (inFlight.get(key) === task) inFlight.delete(key); });
      }
      const seal = await inFlight.get(key);
      let wikiCase;
      if (options.wikiStore) {
        try {
          const message = options.chatStore?.getMessage(input.messageId);
          if (!message) throw Object.assign(Error('wiki_source_invalid'), { code: 'wiki_source_invalid' });
          const conversation = options.chatStore?.getConversationWithoutMessages(input.conversationId);
          const excerpt = messageExcerpt(message.content);
          wikiCase = options.wikiStore.addMarkedCase({ source: { projectId: input.projectId, conversationId: input.conversationId,
            conversationTitle: conversation?.title || '未命名房间', messageId: input.messageId, agentId: message.agentId },
            role: message.agentId, actual: input.actual, expected: input.expected, createdAt: marked.flag.createdAt,
            sealedCheckpointId: seal?.checkpointSaved === true ? seal.association.checkpointId : null,
            message: excerpt.text, traceExcerpt: '', traceState: 'missing', messageTruncated: excerpt.truncated, traceTruncated: false });
        } catch {
          // Annotation and seal are already durable. Never hide their success
          // or leak dependency details if secondary Wiki ingestion fails.
          wikiCase = { error: 'wiki_case_unavailable' };
        }
      }
      return { ...marked, ...(wikiCase ? { wikiCase } : {}), ...(trace ? { trace } : {}), seal };
    },
  };
}
