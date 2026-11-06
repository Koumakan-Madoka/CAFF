// Small immutable page-status records. Only the offline operator calls cache*;
// HTTP uses read* exclusively (no archive restore, prefix build, mkdir or git).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveWikiStorageOptions } from './wiki-data-directory';
import { withProjectWriteLock } from './project-write-lock';
import { wikiRunHash } from './wiki-run-replay';
import { wikiSourceFamily } from './wiki-evaluation-suite';
import { wikiGoalCaseNumber } from './wiki-suite';
import { inspectWikiPipelineInputs } from './wiki-pipeline';

// Bump whenever sealed-input/prefix support rules change. Old records survive.
export const WIKI_PIPELINE_PRECHECK_RULES = 'sealed-prefix-precheck-v1';
const fail = () => Object.assign(Error('wiki_pipeline_precheck_invalid'), { code: 'wiki_pipeline_precheck_invalid' });
const hash = (s: any) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function identity(value: any, rules: string) {
  if (!/^[a-z0-9-]{1,96}$/.test(rules) || !value || (value.level === 'trace'
    ? Object.keys(value).sort().join('|') !== 'checkpointHash|level|replayId' || !hash(value.checkpointHash) || typeof value.replayId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.replayId)
    : value.level !== 'run' || Object.keys(value).sort().join('|') !== 'decisionHash|level|traceHash' || !hash(value.traceHash) || !hash(value.decisionHash))) throw fail();
  return value.level === 'trace' ? { rules, level: 'trace', replayId: value.replayId, checkpointHash: value.checkpointHash }
    : { rules, level: 'run', traceHash: value.traceHash, decisionHash: value.decisionHash };
}
function result(value: any) {
  if (value?.status === 'supported') return { status: 'supported' };
  if (value?.status === 'unsupported' && /^(?:replay|wiki_(?:run|trace|dehydration))_[a-z_]+$/.test(value.reason || '')) return { status: 'unsupported', reason: value.reason };
  throw fail();
}
export function createWikiPipelinePrecheckStore(input: any, rules = WIKI_PIPELINE_PRECHECK_RULES) {
  const scope = resolveWikiStorageOptions(input), root = scope.globalRoot;
  if (!path.isAbsolute(root || '') || !path.isAbsolute(scope.sourceWorktree || '')) throw fail();
  const relative = path.relative(scope.sourceWorktree, root);
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw fail();
  const directory = path.join(root, 'pipeline-prechecks');
  function location(key: any) {
    const binding = identity(key, rules), id = wikiRunHash(binding);
    return { binding, id, file: path.join(directory, id + '.json') };
  }
  function read(key: any): any {
    const { binding, file } = location(key);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw fail();
      const bytes = fs.readFileSync(file); if (bytes.length > 8192) throw fail();
      const envelope = JSON.parse(bytes.toString('utf8')), record = envelope.record;
      if (envelope.schemaVersion !== 1 || !record || envelope.hash !== wikiRunHash(record)
        || JSON.stringify(record.identity) !== JSON.stringify(binding)
        || JSON.stringify(result(record.result)) !== JSON.stringify(record.result)) throw fail();
      return structuredClone(record.result);
    } catch (e: any) { if (e.code === 'ENOENT') return null; throw fail(); }
  }
  return { read, getOrCompute(key: any, compute: () => any) {
    const { binding, id, file } = location(key), existing = read(key);
    if (existing) return existing;
    // Cross-process exclusion BEFORE expensive work. Crash-left locks fail closed;
    // no request handler acquires this lock or recovers/recomputes a record.
    return withProjectWriteLock(root, 'precheck-' + id, () => {
      const raced = read(key); if (raced) return raced;
      const checked = result(compute()), record = { identity: binding, result: checked };
      fs.mkdirSync(directory, { recursive: true });
      const temporary = file + '.tmp-' + crypto.randomUUID();
      try {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, hash: wikiRunHash(record), record }) + '\n'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.linkSync(temporary, file); // Never replace an immutable result.
      } finally { try { fs.unlinkSync(temporary); } catch {} }
      return checked;
    });
  } };
}
function inputs(state: any) {
  return state.cases.flatMap((c: any) => {
    if (wikiSourceFamily(c) !== 'GPT' || [4, 10, 14].includes(wikiGoalCaseNumber(c.id)!)) return [];
    if (c.sealedCheckpointId) {
      const replay = state.replayCases?.find((r: any) => r.sourceCaseId === c.id && r.request?.association?.checkpointId === c.sealedCheckpointId);
      return [{ c, level: 'trace', key: replay ? { level: 'trace', replayId: replay.id, checkpointHash: replay.checkpointHash } : null,
        metadata: replay ? { checkpointHash: replay.checkpointHash } : {} }];
    }
    const decision = (state.dehydrations || []).findLast((r: any) => r.caseId === c.id && r.traceHash === c.traceBundle?.hash)?.decision;
    return decision?.level === 'run' ? [{ c, level: 'run', key: { level: 'run', traceHash: c.traceBundle?.hash, decisionHash: decision.hash },
      metadata: { traceHash: c.traceBundle?.hash, decisionHash: decision.hash, cutStep: decision.cutStep } }] : [];
  });
}
export function readWikiPipelineInputs(state: any, cache: ReturnType<typeof createWikiPipelinePrecheckStore>) {
  return inputs(state).map(({ c, level, key, metadata }: any) => {
    let checked;
    try { checked = key ? cache.read(key) : null; } catch { checked = null; }
    return { caseId: c.id, level, ...metadata, ...(checked || { status: 'pending' }) };
  });
}
// Explicitly outside the HTTP path. Trace restores and run prefix reads/builds
// happen only on a cache miss while the per-identity operator lock is held.
export function cacheWikiPipelineInputs(state: any, readers: any) {
  return inputs(state).map(({ c, level, key, metadata }: any) => {
    if (!key || level === 'trace' && typeof readers.inspectReplay !== 'function') return { caseId: c.id, level, status: 'pending' };
    const checked = readers.cache.getOrCompute(key, () => inspectWikiPipelineInputs({ ...state, cases: [c] }, readers)[0]);
    return { caseId: c.id, level, ...metadata, ...checked };
  });
}
