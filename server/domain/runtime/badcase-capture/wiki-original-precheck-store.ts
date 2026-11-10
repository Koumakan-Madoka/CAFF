// Trusted operator evidence, intentionally outside Wiki snapshots, comparisons
// and HTTP execution. Reservation BEFORE network, final packet AFTER execution;
// neither is ever overwritten. A crash-left reservation is unknown, not a retry.
// Integrity checks detect corrupt packets, not edits by a hostile same-OS user.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveWikiStorageOptions } from './wiki-data-directory';
import { wikiValueHash } from './wiki-rubric';
import { validateWikiOriginalPrecheckPlan, summarizeWikiOriginalPrecheck, type WikiOriginalPrecheckPlan, type WikiOriginalPrecheckOutcome } from './wiki-original-precheck';
const fail = (code = 'wiki_original_precheck_record_invalid') => Object.assign(Error(code), { code });
function check(v: unknown): asserts v { if (!v) throw fail(); }
function exact(v: any, keys: string[]) { check(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.sort().join(',')); }
function identifier(v: any) {
  if (typeof v !== 'string' || !/^precheck-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)) throw fail('wiki_original_precheck_invalid');
  return v;
}
function timestamp(v: any) { check(typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v); }
const MAX = 128 * 1024;
export function createWikiOriginalPrecheckStore(input: any) {
  const scope = resolveWikiStorageOptions(input), root = scope.globalRoot;
  if (!path.isAbsolute(root || '') || !path.isAbsolute(scope.sourceWorktree || '')) throw fail('wiki_root_required');
  const relative = path.relative(path.resolve(scope.sourceWorktree), path.resolve(root));
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw fail('wiki_storage_inside_source');
  const directory = path.join(root, 'original-prechecks');
  function location(id: string, result = false) { return path.join(directory, identifier(id) + (result ? '.result.json' : '.json')); }
  function packet(id: string, key: 'reservation' | 'result'): any {
    const file = location(id, key === 'result');
    try {
      const stat = fs.lstatSync(file); check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX);
      const bytes = fs.readFileSync(file); check(bytes.length <= MAX);
      const envelope = JSON.parse(bytes.toString('utf8')); exact(envelope, ['schemaVersion', 'hash', key]);
      const value = envelope[key]; check(envelope.schemaVersion === 1 && value?.id === id && envelope.hash === wikiValueHash(value));
      return value;
    } catch (e: any) { if (e.code === 'ENOENT') return null; throw fail(); }
  }
  function read(id: string) {
    const reservation = packet(id, 'reservation');
    if (!reservation) throw fail('wiki_original_precheck_not_found');
    try {
      exact(reservation, ['kind', 'id', 'createdAt', 'plan']); timestamp(reservation.createdAt);
      check(reservation.kind === 'wiki-original-precheck-reservation-v1');
      const plan = validateWikiOriginalPrecheckPlan(reservation.plan), result = packet(id, 'result');
      if (result) {
        exact(result, ['kind', 'id', 'finishedAt', 'planHash', 'status', 'reason', 'runs', 'summary']); timestamp(result.finishedAt);
        check(result.kind === 'wiki-original-precheck-result-v1' && result.planHash === plan.planHash && result.finishedAt >= reservation.createdAt);
        const summary = summarizeWikiOriginalPrecheck(plan, { status: result.status, reason: result.reason, runs: result.runs });
        check(wikiValueHash(summary) === wikiValueHash(result.summary));
      }
      return { reservation: structuredClone(reservation), result: result ? structuredClone(result) : null };
    } catch { throw fail(); }
  }
  function publish(id: string, key: 'reservation' | 'result', value: any) {
    const file = location(id, key === 'result'), bytes = JSON.stringify({ schemaVersion: 1, hash: wikiValueHash(value), [key]: value }) + '\n';
    check(Buffer.byteLength(bytes) <= MAX); fs.mkdirSync(directory, { recursive: true });
    const temporary = file + '.tmp-' + crypto.randomUUID();
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(temporary, file); // Atomic no-replace publication, including a competing finish.
    } catch (e: any) {
      throw fail(e.code === 'EEXIST' ? 'wiki_original_precheck_already_finished' : 'wiki_original_precheck_write_failed');
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  return {
    read,
    reserve(value: WikiOriginalPrecheckPlan) {
      const plan = validateWikiOriginalPrecheckPlan(value), id = 'precheck-' + crypto.randomUUID();
      const reservation = { kind: 'wiki-original-precheck-reservation-v1', id, createdAt: new Date().toISOString(), plan };
      publish(id, 'reservation', reservation); return structuredClone(reservation);
    },
    finish(id: string, outcome: WikiOriginalPrecheckOutcome) {
      const { reservation, result: existing } = read(id);
      if (existing) throw fail('wiki_original_precheck_already_finished');
      const saved = structuredClone(outcome), summary = summarizeWikiOriginalPrecheck(reservation.plan, saved);
      const result = { kind: 'wiki-original-precheck-result-v1', id, finishedAt: new Date().toISOString(), planHash: reservation.plan.planHash,
        ...saved, summary };
      publish(id, 'result', result); return structuredClone(result);
    },
    list(caseId?: string) {
      if (caseId !== undefined && (typeof caseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(caseId))) throw fail('wiki_original_precheck_invalid');
      let files: string[]; try { files = fs.readdirSync(directory); } catch (e: any) { if (e.code === 'ENOENT') return []; throw fail(); }
      const ids = new Set<string>();
      for (const file of files.filter(f => f.endsWith('.json'))) {
        check(/^precheck-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\.result)?\.json$/.test(file));
        ids.add(file.replace(/(?:\.result)?\.json$/, ''));
      }
      return [...ids].map(read).filter(r => caseId === undefined || r.reservation.plan.caseId === caseId)
        .sort((a, b) => b.reservation.createdAt.localeCompare(a.reservation.createdAt) || a.reservation.id.localeCompare(b.reservation.id));
    },
  };
}
