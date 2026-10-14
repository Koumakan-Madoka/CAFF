import { readBadcaseTrajectoryAsync } from './trajectory-process';
import { trajectoryFailureCodes } from './trajectory';
import { sealCheckpointAsync } from './sealing-process';
import { readSealedCase, sealFailureCodes, trajectorySummary } from './sealed-case';
const associationFailures = ['flag_seal_association_incomplete', 'flag_seal_association_mismatch', 'flag_not_found', 'flag_record_invalid', 'flag_message_not_found', 'flag_message_not_terminal'];
const processFailures = ['seal_busy', 'seal_timeout', 'seal_process_failed', 'seal_output_limit', 'seal_output_invalid'];
const failed = (state: string, reason: string) => ({ state, reason, checkpointSaved: false, complete: false,
  captured: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false });
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
      return { ...marked, seal };
    },
  };
}
