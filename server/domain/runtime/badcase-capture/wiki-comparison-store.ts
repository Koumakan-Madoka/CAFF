// Host-only global result summaries. Full replies/files/model-call evidence stay
// in the operator's JSONL, not the page or wiki snapshots. Same-OS-user trust.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWikiStore } from './wiki-store';
import { withProjectWriteLock } from './project-write-lock';
import { containsSecretSentinel } from './secrets';

const variants = ['original', 'candidate'];
const categories = ['reproduction', 'probe', 'control'];
const fail = (code = 'wiki_comparison_invalid') => Object.assign(Error(code), { code });
const hash = (value: any) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_BYTES = 512 * 1024;
function check(condition: any): asserts condition { if (!condition) throw fail(); }
function identifier(value: any) { check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)); return value; }
function digest(value: any) { check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); return value; }
function count(value: any) { check(Number.isSafeInteger(value) && value >= 0); return value; }
function code(value: any) { check(typeof value === 'string' && /^[a-z_]{1,100}$/.test(value)); return value; }
function ids(values: any) {
  check(Array.isArray(values) && values.length <= 1000);
  const result = values.map(identifier); check(new Set(result).size === result.length); return result;
}
export function wikiComparisonTotals(cases: any[], repeats: number) {
  return Object.fromEntries(variants.map(variant => {
    const rows = cases.flatMap(c => c.runs || []).filter(r => r.variant === variant), planned = cases.length * repeats;
    const passed = rows.filter(r => r.status === 'pass').length, failed = rows.filter(r => r.status === 'fail').length, errors = rows.filter(r => r.status === 'error').length;
    return [variant, { planned, attempted: rows.length, passed, failed, errors, notRun: planned - rows.length,
      scored: passed + failed, passRate: passed + failed ? passed / (passed + failed) : null, plannedPassRate: planned ? passed / planned : null }];
  }));
}
// Allowlist projection: never serialize arbitrary worker text, paths, file bytes,
// usage objects, Docker inspect, or caller-supplied aggregate counters.
function projectResult(input: any): any {
  check(input?.kind === 'wiki-global-batch-comparison-v1' && input.scope === 'global' && input.model === 'deepseek/deepseek-v4-flash');
  const repeats = count(input.repeats); check(repeats >= 1 && repeats <= 20);
  const candidate = input.candidate;
  check(candidate && typeof input.completed === 'boolean' && typeof input.callsUnavailable === 'boolean');
  const split = { caseIds: ids(input.split?.caseIds), trainCaseIds: ids(input.split?.trainCaseIds), testCaseIds: ids(input.split?.testCaseIds) };
  check(split.trainCaseIds.length + split.testCaseIds.length === split.caseIds.length
    && split.caseIds.every(id => split.trainCaseIds.includes(id) !== split.testCaseIds.includes(id)));
  check(Array.isArray(input.cases) && input.cases.length >= 1 && input.cases.length <= 20);
  const seen = new Set();
  const cases = input.cases.map((c: any) => {
    const sourceCaseId = identifier(c.sourceCaseId); check(!seen.has(sourceCaseId)); seen.add(sourceCaseId);
    check(['train', 'test'].includes(c.split) && categories.includes(c.category) && ['completed', 'error', 'unsupported', 'not-run'].includes(c.status));
    check((c.split === 'test') === split.testCaseIds.includes(sourceCaseId));
    check(Array.isArray(c.runs) && c.runs.length <= 2 * repeats && typeof c.callsUnavailable === 'boolean');
    const slots = new Set();
    const runs = c.runs.map((r: any) => {
      check(variants.includes(r.variant) && ['pass', 'fail', 'error'].includes(r.status));
      const iteration = count(r.iteration), slot = r.variant + ':' + iteration;
      check(iteration >= 1 && iteration <= repeats && !slots.has(slot)); slots.add(slot);
      return { variant: r.variant, iteration, status: r.status, ...(r.reason === undefined ? {} : { reason: code(r.reason) }),
        replySource: ['public', 'internal', 'none'].includes(r.replySource) ? r.replySource : 'unknown', cleaned: r.cleaned === true };
    });
    check(c.status !== 'completed' || runs.length === 2 * repeats && runs.every((r: any) => r.status !== 'error'));
    check(c.status !== 'error' || runs.some((r: any) => r.status === 'error'));
    check(!['unsupported', 'not-run'].includes(c.status) || !runs.length);
    const comparison = c.comparison ? Object.fromEntries(['checkpointId', 'checkpointHash', 'rulesHash', 'planHash'].filter(k => c.comparison[k] !== undefined)
      .map(k => [k, k === 'checkpointId' ? identifier(c.comparison[k]) : digest(c.comparison[k])])) : null;
    const record = { sourceCaseId, split: c.split, category: c.category, status: c.status,
      replayId: c.replayId ? identifier(c.replayId) : null, comparison,
      ...(c.reason === undefined ? {} : { reason: code(c.reason) }), runs,
      modelCallsKnown: count(c.modelCallsKnown), callsUnavailable: c.callsUnavailable };
    return { ...record, totals: wikiComparisonTotals([record], repeats) };
  });
  check(split.testCaseIds.every(id => seen.has(id)));
  check(input.completed === cases.every((c: any) => c.status === 'completed'));
  const modelCallsKnown = cases.reduce((n: number, c: any) => n + c.modelCallsKnown, 0), callsUnavailable = cases.some((c: any) => c.callsUnavailable);
  check(input.modelCallsKnown === modelCallsKnown && input.callsUnavailable === callsUnavailable);
  const preparedReplayableCount = count(input.preparedReplayableCount); check(preparedReplayableCount <= cases.length);
  const disclosures = ids(input.disclosures);
  check(disclosures.includes('baseline_screening_selection_bias') && disclosures.includes('only_reporting_failures_reproduced'));
  return { kind: input.kind, scope: 'global', executionId: identifier(input.executionId), planHash: digest(input.planHash), configHash: digest(input.configHash),
    runtimeHash: input.runtimeHash === null ? null : digest(input.runtimeHash), model: input.model,
    candidate: { id: identifier(candidate.id), targetId: identifier(candidate.targetId), baseHash: digest(candidate.baseHash),
      candidateHash: digest(candidate.candidateHash), versionId: identifier(candidate.versionId), entryIds: ids(candidate.entryIds) },
    repeats, split, additionalTrainingCaseIds: ids(input.additionalTrainingCaseIds), excludedSplitTrainingCaseIds: ids(input.excludedSplitTrainingCaseIds),
    wikiTrainingCount: count(input.wikiTrainingCount), preparedReplayableCount, disclosures, completed: input.completed, cases,
    totals: wikiComparisonTotals(cases, repeats),
    bySplit: Object.fromEntries(['train', 'test'].map(s => [s, wikiComparisonTotals(cases.filter((c: any) => c.split === s), repeats)])),
    byCategory: Object.fromEntries(categories.map(k => [k, wikiComparisonTotals(cases.filter((c: any) => c.category === k), repeats)])),
    modelCallsKnown, callsUnavailable };
}
export function createWikiComparisonStore(options: any) {
  check(options?.globalRoot !== undefined);
  const wiki = createWikiStore(options), directory = path.join(options.globalRoot, 'comparisons');
  function readFile(name: string) {
    try {
      const file = path.join(directory, name), stat = fs.lstatSync(file); check(stat.isFile() && stat.size <= MAX_BYTES);
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8')), { id, createdAt, ...payload } = envelope.record;
      check(envelope.schemaVersion === 1 && envelope.checksum === hash(envelope.record));
      check(id === 'comparison-' + hash(payload) && name === hash(payload) + '.json');
      check(typeof createdAt === 'string' && new Date(createdAt).toISOString() === createdAt);
      check(JSON.stringify(projectResult(payload)) === JSON.stringify(payload));
      check(!containsSecretSentinel(JSON.stringify(envelope.record)));
      return envelope.record;
    } catch { throw fail('wiki_comparison_record_invalid'); }
  }
  return {
    read() {
      let names: string[];
      try { names = fs.readdirSync(directory); } catch (e: any) { if (e.code === 'ENOENT') return []; throw fail('wiki_comparison_record_invalid'); }
      if (names.some(n => n.endsWith('.json') && !/^[a-f0-9]{64}\.json$/.test(n))) throw fail('wiki_comparison_record_invalid');
      return names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(readFile)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 20);
    },
    save(input: any) {
      const payload = projectResult(input), contentHash = hash(payload), name = contentHash + '.json';
      return withProjectWriteLock(options.globalRoot, 'global-wiki', () => {
        const state = wiki.read(), candidate = state.candidates.find((c: any) => c.id === payload.candidate.id);
        check(candidate?.kind === 'global-wiki-candidate-v1' && candidate.status === 'confirmed' && candidate.target.kind === 'global-system-prompt');
        for (const k of Object.keys(payload.candidate)) check(JSON.stringify(candidate[k]) === JSON.stringify(payload.candidate[k]));
        for (const k of Object.keys(payload.split)) check(JSON.stringify(state.replaySplit?.[k]) === JSON.stringify(payload.split[k]));
        for (const c of payload.cases) {
          const source = state.cases.find((s: any) => s.id === c.sourceCaseId), replay = state.replayCases.find((s: any) => s.sourceCaseId === c.sourceCaseId);
          check(source && source.split === c.split);
          if (c.replayId) check(replay?.id === c.replayId && replay.category === c.category && replay.split === c.split);
          else check(c.status === 'unsupported' && !replay);
        }
        const target = path.join(directory, name);
        if (fs.existsSync(target)) return readFile(name);
        const record = { id: 'comparison-' + contentHash, createdAt: new Date().toISOString(), ...payload };
        const bytes = JSON.stringify({ schemaVersion: 1, checksum: hash(record), record }) + '\n';
        check(!containsSecretSentinel(bytes) && Buffer.byteLength(bytes) <= MAX_BYTES);
        const temp = target + '.tmp-' + crypto.randomUUID();
        try {
          fs.mkdirSync(directory, { recursive: true });
          const fd = fs.openSync(temp, 'wx', 0o600);
          try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.linkSync(temp, target); // No overwrite; unknown write results require readback, not rerunning models.
        } catch { throw fail('wiki_comparison_write_failed'); }
        finally { try { fs.unlinkSync(temp); } catch {} }
        return record;
      });
    },
  };
}
