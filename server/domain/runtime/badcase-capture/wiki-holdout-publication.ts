// Trusted v4 gate/full publication. New records require current independent
// admission; exact historical reads never migrate or refresh qualifications.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWikiStore } from './wiki-store';
import { withProjectWriteLock } from './project-write-lock';
import { containsSecretSentinel } from './secrets';
import { wikiValueHash, resolveFrozenWikiRubric } from './wiki-rubric';
import { planWikiHoldoutGate } from './wiki-holdout-gate';
import { createWikiOriginalPrecheckStore } from './wiki-original-precheck-store';
import { createWikiPipelinePrecheckStore, readWikiPipelineInputs } from './wiki-pipeline-prechecks';
import { verifyWikiRunPublication } from './wiki-run-comparison-verification';
import { WIKI_COMPARISON_V2_MAX_BYTES, wikiObjectiveAssertionIds, wikiObjectiveRules } from './wiki-comparison-scoring';
import { readWikiComparisonRecord } from './wiki-comparison-record';
import { projectStagedResult } from './wiki-staged-result';
import { planWikiHoldoutValidation } from './wiki-holdout-validation';
import { projectWikiHoldoutUsageHistory } from './wiki-holdout-usage';
import { wikiComparisonTotals } from './wiki-comparison-totals';
const fail = (code = 'wiki_comparison_invalid') => Object.assign(Error(code), { code });
function check(v: unknown): asserts v { if (!v) throw fail(); }
const hash = (v: any) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = (a: any, b: any) => wikiValueHash(a) === wikiValueHash(b);
export function saveWikiHoldoutComparison(options: any, payload: any) {
  check(['wiki-mode-holdout-comparison-v1', 'wiki-mode-holdout-comparison-v2'].includes(payload.kind));
  const wiki = createWikiStore(options), contentHash = hash(payload), directory = path.join(options.globalRoot, 'comparisons');
  const target = path.join(directory, contentHash + '.json');
  return withProjectWriteLock(options.globalRoot, 'global-wiki', () => {
    const state = wiki.read(), existing = fs.existsSync(target), candidate = state.candidates.find((c: any) => c.id === payload.candidate.id);
    check(candidate?.kind === 'global-wiki-candidate-v1' && candidate.status === 'confirmed' && candidate.target.kind === 'global-system-prompt');
    for (const key of Object.keys(payload.candidate)) check(JSON.stringify(candidate[key]) === JSON.stringify(payload.candidate[key]));
    if (!existing) {
      const input = { state, targetEntryId: payload.evaluation.targetEntryId,
        records: createWikiOriginalPrecheckStore(options).list(), replayChecks: readWikiPipelineInputs(state, createWikiPipelinePrecheckStore(options)) };
      check(same(planWikiHoldoutGate(input), payload.experiment.gate));
      if (payload.kind === 'wiki-mode-holdout-comparison-v2') {
        const selection = payload.experiment.validation, { repeats, degradationThreshold, maxEstimatedTokens } = selection.policy;
        check(same(planWikiHoldoutValidation({ ...input, seed: selection.seed, history: projectWikiHoldoutUsageHistory({ state, records: input.records, replayChecks: input.replayChecks }),
          policy: { repeats, degradationThreshold, maxEstimatedTokens }, skippedCaseIds: selection.cases.filter((c: any) => c.skipped).map((c: any) => c.caseId) }), selection));
      }
    }
    for (const c of payload.cases) {
      const source = state.cases.find((s: any) => s.id === c.sourceCaseId), selected = payload.experiment.cases.find((s: any) => s.caseId === c.sourceCaseId);
      check(source && selected && source.split === c.split && (selected.stage === 'validation' || selected.originalSplit === source.split));
      if (c.rubric) check(same(resolveFrozenWikiRubric(state, source.id, c.rubric.hash), c.rubric));
      else { check(!c.runs.length && c.comparison === null && ['unsupported', 'not-run'].includes(c.status)); continue; }
      if (selected.execution.level === 'run') {
        verifyWikiRunPublication(wiki, options, payload, c, source, candidate); continue;
      }
      const replay = state.replayCases.find((r: any) => r.sourceCaseId === source.id);
      check(source.sealedCheckpointId && replay && replay.id === c.replayId && replay.request.association.checkpointId === source.sealedCheckpointId
        && replay.split === source.split && (selected.stage === 'validation' || replay.category === c.category)
        && c.comparison?.checkpointHash === replay.checkpointHash && c.comparison.rulesHash === hash(replay.rules)
        && same(c.hardAssertionIds, wikiObjectiveAssertionIds(replay.rules)) && selected.hardAssertionsHash === wikiValueHash(wikiObjectiveRules(replay.rules))
        && selected.sceneHash === wikiValueHash({ checkpointHash: replay.checkpointHash, fixture: replay.fixture, commonInputHash: c.comparison.commonInputHash ?? null }));
    }
    const read = () => readWikiComparisonRecord(options.globalRoot, 'comparison-' + contentHash, v => projectStagedResult(v, wikiComparisonTotals));
    if (existing) return read();
    const record = { id: 'comparison-' + contentHash, createdAt: new Date().toISOString(), ...payload };
    const bytes = JSON.stringify({ schemaVersion: 1, checksum: hash(record), record }) + '\n';
    check(!containsSecretSentinel(bytes) && Buffer.byteLength(bytes) <= WIKI_COMPARISON_V2_MAX_BYTES);
    const temp = target + '.tmp-' + crypto.randomUUID();
    try {
      fs.mkdirSync(directory, { recursive: true });
      const fd = fs.openSync(temp, 'wx', 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(temp, target);
    } catch { throw fail('wiki_comparison_write_failed'); }
    finally { try { fs.unlinkSync(temp); } catch {} }
    return read();
  });
}
