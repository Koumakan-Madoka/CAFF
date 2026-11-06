// Safe progress for the trusted staged CLI. Full attempts/replies remain in the
// operator JSONL; only the separately validated comparison is a formal result.
import fs from 'node:fs';
import path from 'node:path';
import { resolveWikiStorageOptions } from './wiki-data-directory';
import crypto from 'node:crypto';
import { createWikiStore } from './wiki-store';
import { withProjectWriteLock } from './project-write-lock';
import { containsSecretSentinel } from './secrets';
import { validateWikiExperimentPlan } from './wiki-experiment-plan';
const fail = (code = 'wiki_execution_invalid') => Object.assign(Error(code), { code });
function check(v: any): asserts v { if (!v) throw fail(); }
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const digest = (v: any) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const id = (v: any) => { check(typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)); return v; };
const count = (v: any) => { check(Number.isSafeInteger(v) && v >= 0); return v; };
const reason = (v: any) => /^(evaluation|wiki)_[a-z_]{1,100}$/.test(v || '') ? v : 'evaluation_failed';
const variants = ['original', 'candidate'];
function projectPlan(v: any) {
  const v2 = v?.kind === 'wiki-staged-batch-comparison-v2';
  check((v2 || v?.kind === 'wiki-staged-batch-comparison-v1') && v.model === 'openai-codex/gpt-6.1-sol' && v.repeats === 10);
  const modelConfig = { api: 'openai-codex-responses', thinking: 'xhigh', fast: false, transport: 'sse', credentialDelivery: 'host-only-mailbox' };
  check(same(v.modelConfig, modelConfig));
  check(Array.isArray(v.cases) && v.cases.length > 0 && v.cases.length <= 20);
  const cases = v.cases.map((c: any) => {
    check(['gate', 'test'].includes(c.stage) && ['reproduction', 'probe', 'control'].includes(c.category) && typeof c.reportOnly === 'boolean');
    return { sourceCaseId: id(c.sourceCaseId), stage: c.stage, category: c.category, reportOnly: c.reportOnly };
  });
  check(new Set(cases.map((c: any) => c.sourceCaseId)).size === cases.length);
  const experimentHash = v2 ? (v.experiment === undefined ? v.experimentHash : validateWikiExperimentPlan(v.experiment).planHash) : undefined;
  if (v2) check(typeof experimentHash === 'string' && /^[a-f0-9]{64}$/.test(experimentHash) && (v.scoringKind === undefined || v.scoringKind === 'wiki-score-v2'));
  return { kind: v.kind, model: v.model, modelConfig, variants: [...variants], repeats: 10, cases,
    ...(v2 ? { scoringKind: 'wiki-score-v2', experimentHash } : {}) };
}
const empty = (planned: number) => ({ planned, attempted: 0, passed: 0, failed: 0, errors: 0, notRun: planned });
function summarize(record: any) {
  const sum = (rows: any[]) => Object.fromEntries(variants.map(v => [v, rows.reduce((s, c) => {
    for (const k of Object.keys(s)) s[k] += c.totals[v][k]; return s;
  }, empty(0))]));
  const totals: any = sum(record.cases), knownTokens = record.cases.reduce((n: number, c: any) => n + (c.knownTokens || 0), 0);
  check(Number.isSafeInteger(knownTokens));
  return { plannedRuns: totals.original.planned + totals.candidate.planned, completedRuns: totals.original.attempted + totals.candidate.attempted,
    knownTokens: record.cases.some((c: any) => c.knownTokens !== null) ? knownTokens : null,
    usageComplete: record.cases.some((c: any) => c.totals.original.attempted + c.totals.candidate.attempted > 0) && record.cases.every((c: any) => c.usageComplete),
    totals, byStage: Object.fromEntries(['gate', 'test'].map(s => [s, sum(record.cases.filter((c: any) => c.stage === s))])) };
}
function validate(record: any) {
  check(Object.keys(record).sort().join(',') === 'cases,comparisonId,createdAt,current,gateOutcome,id,plan,planHash,reason,status,summary,updatedAt');
  check(/^batch-execution-[a-f0-9-]{36}$/.test(record.id) && /^[a-f0-9]{64}$/.test(record.planHash));
  check(new Date(record.createdAt).toISOString() === record.createdAt && new Date(record.updatedAt).toISOString() === record.updatedAt);
  check(['running', 'completed', 'stopped', 'failed'].includes(record.status) && (record.reason === null || reason(record.reason) === record.reason));
  check(same(projectPlan(record.plan), record.plan) && Array.isArray(record.cases) && record.cases.length === record.plan.cases.length);
  for (const [i, c] of record.cases.entries()) {
    check(Object.keys(c).sort().join(',') === 'knownTokens,reportOnly,sourceCaseId,stage,status,totals,usageComplete');
    for (const k of ['sourceCaseId', 'stage', 'reportOnly']) check(c[k] === record.plan.cases[i][k]);
    check(['pending', 'completed', 'error', 'unsupported', 'not-run'].includes(c.status) && typeof c.usageComplete === 'boolean');
    if (c.knownTokens !== null) count(c.knownTokens);
    check(Object.keys(c.totals).join(',') === variants.join(','));
    for (const v of variants) {
      const t = c.totals[v]; check(Object.keys(t).sort().join(',') === Object.keys(empty(0)).sort().join(','));
      Object.values(t).forEach(count);
      check(t.planned === (c.reportOnly ? 0 : 10) && t.attempted === t.passed + t.failed + t.errors && t.notRun === t.planned - t.passed - t.failed);
      check(c.status !== 'completed' || t.notRun === 0);
      check(!c.reportOnly || t.attempted === 0);
    }
    check(c.totals.original.attempted + c.totals.candidate.attempted <= 25);
  }
  check(record.gateOutcome === null || ['accepted', 'rejected', 'indeterminate'].includes(record.gateOutcome));
  check(record.comparisonId === null || id(record.comparisonId));
  if (record.status === 'completed') check(['accepted', 'rejected'].includes(record.gateOutcome) && record.comparisonId !== null
    && record.cases.filter((c: any) => !c.reportOnly && (c.stage === 'gate' || record.gateOutcome === 'accepted')).every((c: any) => c.status === 'completed'));
  if (record.current !== null) {
    const current = record.current, c = record.cases.find((r: any) => r.sourceCaseId === current.sourceCaseId);
    check(Object.keys(current).sort().join(',') === 'iteration,sourceCaseId,stage,variant' && record.status === 'running' && c && !c.reportOnly && c.status === 'pending');
    check(current.stage === c.stage && variants.includes(current.variant) && current.iteration === c.totals[current.variant].attempted + 1 && c.totals[current.variant].notRun > 0);
    check(c.stage === 'gate' ? record.gateOutcome === null : record.gateOutcome === 'accepted');
  }
  check(same(record.summary, summarize(record)) && !containsSecretSentinel(JSON.stringify(record)));
}
export function createWikiBatchExecutionStore(options: any) {
  options = resolveWikiStorageOptions(options);
  const wiki = createWikiStore(options), directory = path.join(options.globalRoot, 'batch-executions');
  function readFile(recordId: string) {
    try {
      check(/^batch-execution-[a-f0-9-]{36}$/.test(recordId));
      const file = path.join(directory, recordId + '.json'), stat = fs.lstatSync(file);
      check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024);
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      check(envelope.schemaVersion === 1 && envelope.record.id === recordId && envelope.checksum === digest(envelope.record)); validate(envelope.record); return envelope.record;
    } catch { throw fail('wiki_execution_record_invalid'); }
  }
  function write(record: any, first = false) {
    record.summary = summarize(record); validate(record);
    const file = path.join(directory, record.id + '.json'), temp = file + '.tmp-' + crypto.randomUUID();
    try {
      fs.mkdirSync(directory, { recursive: true });
      const bytes = JSON.stringify({ schemaVersion: 1, checksum: digest(record), record }) + '\n'; check(Buffer.byteLength(bytes) <= 64 * 1024);
      const fd = fs.openSync(temp, 'wx', 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (first) fs.linkSync(temp, file); else fs.renameSync(temp, file);
    } catch { throw fail('wiki_execution_write_failed'); } finally { try { fs.unlinkSync(temp); } catch {} }
    return record;
  }
  const update = (recordId: string, action: (r: any) => void) => withProjectWriteLock(options.globalRoot, 'global-wiki', () => {
    const r = readFile(recordId); check(r.status === 'running'); action(r); r.updatedAt = new Date().toISOString(); return write(r);
  });
  return {
    read() {
      wiki.read(); let names: string[];
      try { names = fs.readdirSync(directory); } catch (e: any) { if (e.code === 'ENOENT') return []; throw fail('wiki_execution_record_invalid'); }
      if (names.some(n => n.endsWith('.json') && !/^batch-execution-[a-f0-9-]{36}\.json$/.test(n))) throw fail('wiki_execution_record_invalid');
      return names.filter(n => /^batch-execution-[a-f0-9-]{36}\.json$/.test(n)).map(n => readFile(n.slice(0, -5)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 20);
    },
    start(input: any) {
      const plan = projectPlan(input); check(/^[a-f0-9]{64}$/.test(input.planHash));
      return withProjectWriteLock(options.globalRoot, 'global-wiki', () => {
        wiki.read(); const now = new Date().toISOString();
        return write({ id: 'batch-execution-' + crypto.randomUUID(), createdAt: now, updatedAt: now, status: 'running', plan, planHash: input.planHash,
          current: null, gateOutcome: null, comparisonId: null, reason: null,
          cases: plan.cases.map((c: any) => ({ sourceCaseId: c.sourceCaseId, stage: c.stage, reportOnly: c.reportOnly, status: 'pending', knownTokens: null, usageComplete: true,
            totals: Object.fromEntries(variants.map(v => [v, empty(c.reportOnly ? 0 : 10)])) })) }, true);
      });
    },
    heartbeat(recordId: string) { return update(recordId, () => {}); },
    event(recordId: string, e: any) {
      if (!['run_start', 'run', 'case_summary', 'gate_decision'].includes(e?.event)) return;
      return update(recordId, r => {
        if (e.event === 'gate_decision') {
          check(r.current === null && r.gateOutcome === null && ['accepted', 'rejected', 'indeterminate'].includes(e.gateDecision?.outcome));
          check(r.cases.filter((c: any) => c.stage === 'gate').every((c: any) => c.status !== 'pending'));
          r.gateOutcome = e.gateDecision.outcome; return;
        }
        const c = r.cases.find((c: any) => c.sourceCaseId === e.sourceCaseId); check(c && c.status === 'pending' && (e.stage === undefined || e.stage === c.stage));
        if (e.event === 'case_summary') {
          check(['completed', 'error', 'unsupported', 'not-run'].includes(e.status));
          if (r.current?.sourceCaseId === c.sourceCaseId) r.current = null;
          c.status = e.status; return;
        }
        check(!c.reportOnly && variants.includes(e.variant) && (c.stage === 'gate' ? r.gateOutcome === null : r.gateOutcome === 'accepted'));
        const t = c.totals[e.variant]; check(e.iteration === t.attempted + 1 && t.notRun > 0);
        if (e.event === 'run_start') {
          check(r.current === null && c.totals.original.attempted + c.totals.candidate.attempted < 25);
          r.current = { sourceCaseId: c.sourceCaseId, stage: c.stage, variant: e.variant, iteration: e.iteration }; return;
        }
        check(r.current?.sourceCaseId === c.sourceCaseId && r.current.variant === e.variant && r.current.iteration === e.iteration && ['pass', 'fail', 'error'].includes(e.status));
        t.attempted++; t[e.status === 'pass' ? 'passed' : e.status === 'fail' ? 'failed' : 'errors']++; t.notRun = t.planned - t.passed - t.failed;
        const tokens = e.tokenUsage?.knownTokens?.totalTokens;
        if (tokens != null) { count(tokens); c.knownTokens = (c.knownTokens || 0) + tokens; }
        c.usageComplete &&= e.tokenUsage?.complete === true; r.current = null;
      });
    },
    // Call only after the independently validated result has been saved. A page
    // write failure must never restart a paid run to repair the projection.
    finish(recordId: string, saved: any) {
      return update(recordId, r => {
        check(saved.model === r.plan.model && saved.planHash === r.planHash && typeof saved.completed === 'boolean' && saved.gateDecision?.outcome === r.gateOutcome);
        check(r.current === null && r.cases.every((c: any) => c.status !== 'pending'));
        if (r.plan.scoringKind === 'wiki-score-v2') check(saved.kind === r.plan.kind && saved.experiment?.planHash === r.plan.experimentHash);
        r.comparisonId = id(saved.id); r.status = saved.completed ? 'completed' : 'stopped';
      });
    },
    fail(recordId: string, code: string) { return update(recordId, r => { r.status = 'failed'; r.current = null; r.reason = reason(code); }); },
  };
}
