// Separate immutable request/result packets, not repeated in every Wiki snapshot.
// Same-OS-user trusted directories, atomic no-replace claims; not a filesystem sandbox.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveWikiStorageOptions } from './wiki-data-directory';
import { wikiRunHash } from './wiki-run-replay';
const fail = (code: string) => Object.assign(Error(code), { code });
const MAX = 128 * 1024 * 1024;
// Current B7 accounting is a read-only projection. In particular, legacy
// unreached/countAsFailure results keep their original bytes and hashes.
export function projectWikiRunAccounting(rows: any[], dehydrations: any[] = []) {
  const normalized = rows.map(({ countAsFailure: _legacy, ...row }) => {
    const current = dehydrations.find(d => d.caseId === row.caseId && d.traceHash === row.traceHash)?.decision;
    return { ...row, status: row.status === 'unreached' ? 'invalid' : row.status,
      ...(current?.level === 'reference' && current.supersedesDecisionHash === row.decisionHash
        ? { excludedReason: 'user_reclassified_reference', supersededByDecisionHash: current.hash } : {}) };
  });
  return normalized.map(row => {
    const originals = normalized.filter(r => !r.excludedReason && r.variant?.kind === 'original'
      && r.caseId === row.caseId && r.traceHash === row.traceHash && r.decisionHash === row.decisionHash);
    const baselineStatus = originals.some(r => r.status === 'reached') ? 'valid_output'
      : originals.some(r => r.status === 'reserved') ? 'pending' : originals.length ? 'no_valid_output' : 'not_run';
    return { ...row, accountingPolicy: 'single-call-valid-output-v2',
      eligibleForScoring: !row.excludedReason && row.status === 'reached', baselineStatus,
      caseEligibleForGateAndScreen: !row.excludedReason && baselineStatus === 'valid_output' };
  });
}
export function createWikiRunStore(input: any) {
  const options = resolveWikiStorageOptions(input), root = options.globalRoot;
  if (typeof root !== 'string' || !path.isAbsolute(root) || !path.isAbsolute(options.sourceWorktree || '')) throw fail('wiki_root_required');
  const relative = path.relative(options.sourceWorktree, root);
  if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw fail('wiki_storage_inside_source');
  const directory = path.join(root, 'run-replays');
  const validId = (id: string) => { if (!/^[a-f0-9]{64}$/.test(id)) throw fail('wiki_run_record_invalid'); return id; };
  function readFile(id: string, result = false): any {
    try {
      const file = path.join(directory, validId(id) + (result ? '.result.json' : '.json'));
      const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || st.size > MAX) throw Error();
      const bytes = fs.readFileSync(file); if (bytes.length > MAX) throw Error();
      const envelope = JSON.parse(bytes.toString('utf8')), value = envelope[result ? 'result' : 'reservation'];
      if (envelope.schemaVersion !== 1 || value?.id !== id || envelope.hash !== wikiRunHash(value)) throw Error();
      if (!result && wikiRunHash(value.request) !== id) throw Error();
      return value;
    } catch (e: any) { if (e.code === 'ENOENT') return null; throw fail('wiki_run_record_invalid'); }
  }
  function publish(id: string, key: string, value: any) {
    const file = path.join(directory, validId(id) + (key === 'result' ? '.result.json' : '.json'));
    const bytes = JSON.stringify({ schemaVersion: 1, hash: wikiRunHash(value), [key]: value }) + '\n';
    if (Buffer.byteLength(bytes) > MAX) throw fail('wiki_run_record_too_large');
    fs.mkdirSync(directory, { recursive: true });
    const temp = file + '.tmp-' + crypto.randomUUID();
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(temp, file);
    } catch (e: any) { throw fail(e.code === 'EEXIST' ? 'wiki_run_already_reserved' : 'wiki_run_write_failed'); }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  function read(id: string) {
    const reservation = readFile(id); if (!reservation) throw fail('wiki_run_not_found');
    const result = readFile(id, true);
    if (result && (result.requestHash !== id || result.caseId !== reservation.request.metadata.caseId
      || result.decisionHash !== reservation.request.metadata.decisionHash)) throw fail('wiki_run_record_invalid');
    return { reservation, result };
  }
  return {
    reserve(request: any) {
      if (request?.kind !== 'wikiskill-run-request' || request.schemaVersion !== 1) throw fail('wiki_run_record_invalid');
      const id = wikiRunHash(request), reservation = { schemaVersion: 1, id, createdAt: new Date().toISOString(), request: structuredClone(request) };
      publish(id, 'reservation', reservation); return reservation;
    },
    finish(id: string, value: any) {
      const { reservation, result } = read(id); if (result) throw fail('wiki_run_already_reserved');
      const r = { schemaVersion: 1, id, requestHash: id, caseId: reservation.request.metadata.caseId, decisionHash: reservation.request.metadata.decisionHash,
        finishedAt: new Date().toISOString(), ...structuredClone(value) };
      publish(id, 'result', r); return r;
    },
    read,
    list(caseId?: string) {
      let names: string[]; try { names = fs.readdirSync(directory); } catch (e: any) { if (e.code === 'ENOENT') return []; throw fail('wiki_run_record_invalid'); }
      const rows = names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => read(n.slice(0, 64))).filter(v => caseId === undefined || v.reservation.request.metadata.caseId === caseId)
        .map(({ reservation: r, result: v }) => ({ id: r.id, caseId: r.request.metadata.caseId, caseNumber: r.request.metadata.caseNumber,
          traceHash: r.request.metadata.traceHash, decisionHash: r.request.metadata.decisionHash, variant: r.request.variant,
          model: r.request.model, thinking: r.request.thinking, createdAt: r.createdAt, status: v?.outcome?.status || 'reserved',
          resultHash: v ? wikiRunHash(v) : null, modelCalls: v?.modelCalls ?? null, toolExecutions: v?.toolExecutions ?? null }));
      return projectWikiRunAccounting(rows);
    },
  };
}
