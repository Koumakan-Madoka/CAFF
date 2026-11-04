// Operator-only progress projection. Not the formal gate/test result store and
// never a prompt-adoption decision. No replies, paths, credentials or file bytes.
import fs from 'node:fs';
import path from 'node:path';
import { resolveWikiStorageOptions } from './wiki-data-directory';
import crypto from 'node:crypto';
import { createWikiStore } from './wiki-store';
import { withProjectWriteLock } from './project-write-lock';
import { containsSecretSentinel } from './secrets';
const fail = (code = 'wiki_execution_invalid') => Object.assign(Error(code), { code });
function check(value: any): asserts value { if (!value) throw fail(); }
const digest = (value: any) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function id(value: any) { check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)); return value; }
function hash(value: any) { check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); return value; }
function count(value: any) { check(Number.isSafeInteger(value) && value >= 0); return value; }
function reason(value: any) { return /^(evaluation|wiki)_[a-z_]{1,100}$/.test(value || '') ? value : 'evaluation_failed'; }
function projectPlan(value: any) {
  check(['sealed-original-replay-v1', 'sealed-prompt-comparison-v1'].includes(value?.kind));
  check(['openai-codex/gpt-6.1-sol', 'deepseek/deepseek-v4-flash', 'opencode-go/deepseek-v4.1-flash'].includes(value.model));
  const variants = value.variants || ['original', 'candidate'];
  check(JSON.stringify(variants) === JSON.stringify(value.kind === 'sealed-original-replay-v1' ? ['original'] : ['original', 'candidate']));
  const repeats = count(value.repeats); check(repeats >= 1 && repeats <= 20);
  const modelConfig = value.model === 'openai-codex/gpt-6.1-sol'
    ? { api: 'openai-codex-responses', thinking: 'xhigh', fast: false, transport: 'sse' } : null;
  if (modelConfig) for (const [key, expected] of Object.entries(modelConfig)) check(value.modelConfig?.[key] === expected);
  return { kind: value.kind, model: value.model, modelConfig, variants: [...variants], repeats, caseId: id(value.caseId),
    checkpointId: value.checkpointId == null ? null : id(value.checkpointId), checkpointHash: hash(value.checkpointHash), rulesHash: hash(value.rulesHash) };
}
function projectRun(value: any) {
  check(['original', 'candidate'].includes(value.variant) && ['pass', 'fail', 'error'].includes(value.status));
  const iteration = count(value.iteration); check(iteration >= 1 && iteration <= 25);
  check(Number.isFinite(value.durationMs) && value.durationMs >= 0 && (value.status === 'error' || value.cleaned === true));
  check(value.reason === undefined || typeof value.reason === 'string');
  const usage = value.tokenUsage;
  return { variant: value.variant, iteration, status: value.status, cleaned: value.cleaned === true, durationMs: value.durationMs,
    reason: value.reason === undefined ? null : reason(value.reason.startsWith('evaluation_') || value.reason.startsWith('wiki_') ? value.reason : 'evaluation_' + value.reason),
    knownTokens: usage?.knownTokens == null ? null : count(usage.knownTokens.totalTokens),
    modelCallsKnown: usage ? count(usage.knownCalls) + count(usage.callsWithoutUsage) : null,
    usageComplete: usage?.complete === true };
}
function summarize(plan: any, runs: any[]) {
  const sum = runs.reduce((n, r) => n + (r.knownTokens || 0), 0), safe = Number.isSafeInteger(sum);
  return { plannedRuns: plan.variants.length * plan.repeats, completedRuns: runs.length,
    knownTokens: safe && runs.some(r => r.knownTokens !== null) ? sum : null,
    usageComplete: safe && runs.length > 0 && runs.every(r => r.usageComplete),
    totals: Object.fromEntries(plan.variants.map((v: string) => {
      const rows = runs.filter(r => r.variant === v);
      const passed = rows.filter(r => r.status === 'pass').length, failed = rows.filter(r => r.status === 'fail').length, errors = rows.filter(r => r.status === 'error').length;
      return [v, { planned: plan.repeats, attempted: rows.length, passed, failed, errors, notRun: Math.max(0, plan.repeats - passed - failed) }];
    })) };
}
export function createWikiExecutionStore(options: any) {
  options = resolveWikiStorageOptions(options);
  const wiki = createWikiStore(options), directory = path.join(options.globalRoot, 'executions');
  function readFile(recordId: string) {
    try {
      check(/^execution-[a-f0-9-]{36}$/.test(recordId));
      const file = path.join(directory, recordId + '.json'), stat = fs.lstatSync(file);
      check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024);
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8')), record = envelope.record;
      check(envelope.schemaVersion === 1 && envelope.checksum === digest(record) && record.id === recordId);
      check(['running', 'completed', 'stopped', 'failed'].includes(record.status));
      check(new Date(record.createdAt).toISOString() === record.createdAt && new Date(record.updatedAt).toISOString() === record.updatedAt);
      check(Object.keys(record).sort().join(',') === 'conclusion,createdAt,current,id,plan,planHash,reason,runs,status,summary,updatedAt');
      check(JSON.stringify(projectPlan(record.plan)) === JSON.stringify(record.plan)); hash(record.planHash);
      check(Array.isArray(record.runs) && record.runs.length <= 45);
      const slots = new Map<string, number>();
      for (const run of record.runs) {
        check(Object.keys(run).sort().join(',') === 'cleaned,durationMs,iteration,knownTokens,modelCallsKnown,reason,status,usageComplete,variant');
        check(record.plan.variants.includes(run.variant) && ['pass', 'fail', 'error'].includes(run.status));
        const expected = (slots.get(run.variant) || 0) + 1; check(run.iteration === expected && expected <= record.plan.repeats); slots.set(run.variant, expected);
        check(typeof run.cleaned === 'boolean' && typeof run.usageComplete === 'boolean' && Number.isFinite(run.durationMs) && run.durationMs >= 0);
        if (run.knownTokens !== null) count(run.knownTokens); if (run.modelCallsKnown !== null) count(run.modelCallsKnown);
        check(run.reason === null || reason(run.reason) === run.reason);
      }
      check(record.current === null || record.status === 'running' && Object.keys(record.current).sort().join(',') === 'iteration,variant'
        && record.plan.variants.includes(record.current.variant) && record.current.iteration === (slots.get(record.current.variant) || 0) + 1
        && record.current.iteration <= record.plan.repeats);
      check(record.reason === null || reason(record.reason) === record.reason);
      check(record.conclusion === (record.status === 'running' ? null : record.status !== 'completed' ? 'incomplete'
        : record.plan.variants.length === 1 ? 'original_observation_only' : 'literal_comparison_only'));
      check(record.status !== 'completed' || record.current === null && record.runs.length === record.plan.variants.length * record.plan.repeats && record.runs.every((r: any) => r.status !== 'error'));
      check(JSON.stringify(summarize(record.plan, record.runs)) === JSON.stringify(record.summary));
      check(!containsSecretSentinel(JSON.stringify(record)));
      return record;
    } catch { throw fail('wiki_execution_record_invalid'); }
  }
  function write(record: any, first = false) {
    check(!containsSecretSentinel(JSON.stringify(record)));
    const file = path.join(directory, record.id + '.json'), temp = file + '.tmp-' + crypto.randomUUID();
    try {
      fs.mkdirSync(directory, { recursive: true });
      const bytes = JSON.stringify({ schemaVersion: 1, checksum: digest(record), record }) + '\n'; check(Buffer.byteLength(bytes) <= 64 * 1024);
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (first) fs.linkSync(temp, file); else fs.renameSync(temp, file);
    } catch { throw fail('wiki_execution_write_failed'); }
    finally { try { fs.unlinkSync(temp); } catch {} }
    return record;
  }
  function update(recordId: string, action: (record: any) => void) {
    return withProjectWriteLock(options.globalRoot, 'global-wiki', () => {
      const record = readFile(recordId); check(record.status === 'running'); action(record);
      record.updatedAt = new Date().toISOString(); record.summary = summarize(record.plan, record.runs); return write(record);
    });
  }
  return {
    read() {
      wiki.read(); // Enforce the same global-root/source-worktree layout boundary.
      let names: string[];
      try { names = fs.readdirSync(directory); } catch (e: any) { if (e.code === 'ENOENT') return []; throw fail('wiki_execution_record_invalid'); }
      if (names.some(n => n.endsWith('.json') && !/^execution-[a-f0-9-]{36}\.json$/.test(n))) throw fail('wiki_execution_record_invalid');
      return names.filter(n => /^execution-[a-f0-9-]{36}\.json$/.test(n)).map(n => readFile(n.slice(0, -5)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 20);
    },
    start(input: any) {
      const plan = projectPlan(input);
      return withProjectWriteLock(options.globalRoot, 'global-wiki', () => {
        wiki.read(); const now = new Date().toISOString();
        return write({ id: 'execution-' + crypto.randomUUID(), createdAt: now, updatedAt: now, status: 'running', plan, planHash: digest(input),
          current: null, runs: [], summary: summarize(plan, []), reason: null, conclusion: null }, true);
      });
    },
    heartbeat(recordId: string) { return update(recordId, () => {}); },
    event(recordId: string, event: any) {
      if (!['run_start', 'run'].includes(event?.event)) return;
      return update(recordId, record => {
        const expected = record.runs.filter((r: any) => r.variant === event.variant).length + 1;
        check(record.plan.variants.includes(event.variant) && event.iteration === expected && expected <= record.plan.repeats);
        if (event.event === 'run_start') { check(record.current === null); record.current = { variant: event.variant, iteration: event.iteration }; }
        else { check(record.current?.variant === event.variant && record.current?.iteration === event.iteration); record.runs.push(projectRun(event)); record.current = null; }
      });
    },
    finish(recordId: string, result: any) {
      return update(recordId, record => {
        check(result.model === record.plan.model && result.kind === record.plan.kind && typeof result.completed === 'boolean');
        check(!result.completed || record.current === null && record.runs.length === record.summary.plannedRuns && record.runs.every((r: any) => r.status !== 'error'));
        record.status = result.completed ? 'completed' : 'stopped'; record.current = null;
        record.conclusion = !result.completed ? 'incomplete' : record.plan.variants.length === 1 ? 'original_observation_only' : 'literal_comparison_only';
      });
    },
    fail(recordId: string, code: string) { return update(recordId, record => { record.status = 'failed'; record.current = null; record.reason = reason(code); record.conclusion = 'incomplete'; }); },
  };
}
