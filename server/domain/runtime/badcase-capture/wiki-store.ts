// Small, operator-owned WikiSkill collection. Uses the existing capture writer
// lock and external capture root, never the chat/production database. Every
// mutation publishes a new immutable snapshot; reviewed entries are frozen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withProjectWriteLock } from './project-write-lock';
import { containsSecretSentinel } from './secrets';
import { buildWikiCandidate, resolveWikiCandidate } from './wiki-candidate';
import { planReplaySplit } from './wiki-split';

const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const MODEL = 'deepseek/deepseek-v4-flash';
const MAX_BYTES = 8 * 1024 * 1024;
const ENTRY_FIELDS = ['title', 'failureMode', 'symptoms', 'rootCauseHypothesis', 'guideline', 'caseIds'];
function shape(value: any, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw fail('wiki_invalid_input');
}
function id(value: any): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw fail('wiki_invalid_identifier');
  return value;
}
function text(value: any, maxBytes: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0') || Buffer.byteLength(value) > maxBytes) throw fail('wiki_invalid_text');
  if (containsSecretSentinel(value)) throw fail('wiki_contains_secret');
  return value;
}
function ids(value: any, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 1000) throw fail('wiki_invalid_case_ids');
  const result = value.map(id);
  if (new Set(result).size !== result.length) throw fail('wiki_invalid_case_ids');
  return result;
}
function entry(value: any, allowed: Set<string>) {
  shape(value, ENTRY_FIELDS);
  const fields = Object.fromEntries(ENTRY_FIELDS.slice(0, -1).map(k => [k, text(value[k], k === 'title' ? 1024 : 8192)]));
  if ([...fields.guideline].length > 300) throw fail('wiki_guideline_too_long');
  const caseIds = ids(value.caseIds);
  if (caseIds.some(k => !allowed.has(k))) throw fail('wiki_unknown_case');
  return { ...fields, caseIds };
}
function textCase(value: any) {
  shape(value, ['source', 'role', 'actual', 'expected', 'message', 'traceExcerpt', 'traceState', 'messageTruncated', 'traceTruncated']);
  shape(value.source, ['origin', 'projectId', 'conversationId', 'messageId', 'agentId']);
  const s = value.source;
  if (s.origin !== 'http://127.0.0.1:3100' || s.agentId !== 'role-family-gpt' || value.role !== 'GPT') throw fail('wiki_source_invalid');
  const source = { origin: s.origin, projectId: s.projectId === null ? null : id(s.projectId), conversationId: id(s.conversationId), messageId: id(s.messageId), agentId: s.agentId };
  if (!['available', 'missing'].includes(value.traceState) || typeof value.messageTruncated !== 'boolean' || typeof value.traceTruncated !== 'boolean') throw fail('wiki_invalid_input');
  const message = text(value.message, 32768, true), traceExcerpt = text(value.traceExcerpt, 32768, true);
  if (value.traceState === 'missing' && (traceExcerpt !== '' || value.traceTruncated)) throw fail('wiki_invalid_input');
  // Text-only cases are never upgraded to replayable merely because the source
  // message happens to reference a checkpoint in a different instance.
  return { id: `text-${hash(JSON.stringify(source))}`, kind: 'text-only', role: 'GPT', split: 'train', replayable: false,
    source, actual: text(value.actual, 8192), expected: text(value.expected, 8192), message, traceExcerpt,
    traceState: value.traceState, messageTruncated: value.messageTruncated, traceTruncated: value.traceTruncated };
}

export function createWikiStore(options: any) {
  if (!options || !path.isAbsolute(options.captureRoot || '') || !path.isAbsolute(options.sourceWorktree || '')) throw fail('wiki_root_required');
  const captureRoot = path.resolve(options.captureRoot), source = path.resolve(options.sourceWorktree), projectId = id(options.projectId);
  const relative = path.relative(source, captureRoot);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) throw fail('wiki_storage_inside_source');
  // Directory ancestors are same-OS-user trusted, as in capture-store; this is
  // not a filesystem sandbox or support for symlink/path-swap configurations.
  // Wiki records embed their own text, not CAS references. Keep them outside
  // the checkpoint inventory: existing expiry/GC only owns projects/<id>/CAS.
  const directory = path.join(captureRoot, 'wiki', projectId, 'snapshots');
  const fresh = () => ({ schemaVersion: 1, projectId, revision: 0, cases: [] as any[], versions: [] as any[], candidates: [] as any[], replaySplit: null });
  function read(): any {
    let names: string[];
    try { names = fs.readdirSync(directory); }
    catch (e: any) { if (e.code === 'ENOENT') return fresh(); throw fail('wiki_record_invalid'); }
    if (names.some(n => n.endsWith('.json') && !/^\d{12}\.json$/.test(n))) throw fail('wiki_record_invalid');
    const latest = names.filter(n => /^\d{12}\.json$/.test(n)).sort().at(-1);
    if (!latest) return fresh();
    try {
      const fd = fs.openSync(path.join(directory, latest), 'r'); let bytes: Buffer;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_BYTES) throw Error();
        bytes = fs.readFileSync(fd);
      } finally { fs.closeSync(fd); }
      if (bytes.length > MAX_BYTES) throw Error();
      const envelope = JSON.parse(bytes.toString('utf8')), record = envelope.record;
      if (envelope.schemaVersion !== 1 || !record || record.schemaVersion !== 1 || record.projectId !== projectId
        || record.revision !== Number(latest.slice(0, 12)) || !Number.isSafeInteger(record.revision) || record.revision < 1
        || !Array.isArray(record.cases) || !Array.isArray(record.versions) || envelope.checksum !== hash(JSON.stringify(record))) throw Error();
      // Backward-compatible read of snapshots written before candidate support.
      if (record.candidates === undefined) record.candidates = [];
      if (!Array.isArray(record.candidates)) throw Error();
      if (record.replaySplit === undefined) record.replaySplit = null;
      if (record.replaySplit !== null && (typeof record.replaySplit !== 'object' || Array.isArray(record.replaySplit))) throw Error();
      return record;
    } catch { throw fail('wiki_record_invalid'); }
  }
  function publish(record: any) {
    const serialized = JSON.stringify(record);
    if (containsSecretSentinel(serialized)) throw fail('wiki_contains_secret');
    const bytes = JSON.stringify({ schemaVersion: 1, checksum: hash(serialized), record }) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES || record.revision > 999999999999) throw fail('wiki_collection_too_large');
    const target = path.join(directory, String(record.revision).padStart(12, '0') + '.json'), temp = target + '.tmp-' + crypto.randomUUID();
    try {
      fs.mkdirSync(directory, { recursive: true });
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(temp, target); // Atomic no-replace; never overwrite a snapshot.
    } catch { throw fail('wiki_write_failed'); }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  function change(action: (state: any) => { changed: boolean; value: any }) {
    return withProjectWriteLock(captureRoot, projectId, () => {
      const state = read(), result = action(state);
      if (result.changed) { state.revision++; publish(state); }
      return { value: result.value, revision: state.revision };
    });
  }
  return {
    read,
    addTextCases(values: any[]) {
      if (!Array.isArray(values) || !values.length || values.length > 20) throw fail('wiki_invalid_input');
      const normalized = values.map(textCase);
      const result = change(state => {
        const now = new Date().toISOString(), batch: any[] = []; let created = 0;
        for (const candidate of normalized) {
          const existing = state.cases.find((c: any) => c.id === candidate.id);
          if (existing) {
            // The operator may have frozen this source case into the holdout
            // set. Reimport never resets that local selection to training.
            const { createdAt, split, ...content } = existing, { split: initialSplit, ...original } = candidate;
            if (JSON.stringify(content) !== JSON.stringify(original)) throw fail('wiki_case_conflict');
            batch.push(existing);
          } else {
            const saved = { ...candidate, createdAt: now }; state.cases.push(saved); batch.push(saved); created++;
          }
        }
        return { changed: created > 0, value: { created, cases: batch } };
      });
      return { ...result.value, revision: result.revision };
    },
    setReplaySplit(input: any) {
      shape(input, ['caseIds']);
      const plan = planReplaySplit(input.caseIds);
      return change(state => {
        if (state.replaySplit) {
          if (state.replaySplit.id !== plan.id) throw fail('wiki_split_frozen');
          return { changed: false, value: state.replaySplit };
        }
        if (plan.caseIds.some(id => !state.cases.some((c: any) => c.id === id && c.role === 'GPT'))) throw fail('wiki_unknown_case');
        // Even a rejected/draft version means the model already saw that case.
        // Do not relabel exposed training data as an untouched test set.
        if (state.versions.some((v: any) => v.caseIds.some((id: string) => plan.testCaseIds.includes(id)))) throw fail('wiki_split_training_conflict');
        for (const c of state.cases) if (plan.caseIds.includes(c.id)) c.split = plan.testCaseIds.includes(c.id) ? 'test' : 'train';
        const saved = { ...plan, createdAt: new Date().toISOString() }; state.replaySplit = saved;
        return { changed: true, value: saved };
      }).value;
    },
    saveDraft(input: any) {
      shape(input, ['caseIds', 'model', 'entries', 'unclassified']);
      const caseIds = ids(input.caseIds), allowed = new Set(caseIds);
      if (input.model !== MODEL || !Array.isArray(input.entries) || input.entries.length > 100 || !Array.isArray(input.unclassified)) throw fail('wiki_invalid_input');
      const entries = input.entries.map((e: any) => entry(e, allowed));
      const assigned = new Set(entries.flatMap((e: any) => e.caseIds));
      const unclassified = input.unclassified.map((u: any) => {
        shape(u, ['caseId', 'reason']); const caseId = id(u.caseId);
        if (!allowed.has(caseId) || assigned.has(caseId)) throw fail('wiki_invalid_coverage');
        return { caseId, reason: text(u.reason, 2048) };
      });
      if (new Set(unclassified.map((u: any) => u.caseId)).size !== unclassified.length
        || caseIds.some(c => !assigned.has(c) && !unclassified.some((u: any) => u.caseId === c))) throw fail('wiki_invalid_coverage');
      return change(state => {
        const cases = caseIds.map(k => state.cases.find((c: any) => c.id === k && c.split === 'train' && c.role === 'GPT'));
        if (cases.some(c => !c)) throw fail('wiki_unknown_training_case');
        const version = { id: `wiki-${state.revision + 1}`, createdAt: new Date().toISOString(), model: MODEL, role: 'GPT',
          caseIds, trainingHash: hash(JSON.stringify(cases)), entries: entries.map((e: any, i: number) => ({ id: `entry-${i + 1}`, ...e, status: 'draft' })), unclassified };
        state.versions.push(version);
        return { changed: true, value: version };
      }).value;
    },
    createCandidate(input: any) {
      return change(state => {
        const candidate = buildWikiCandidate(state, input);
        const existing = state.candidates.find((c: any) => c.id === candidate.id);
        if (existing) return { changed: false, value: existing };
        const saved = { ...candidate, status: 'draft', createdAt: new Date().toISOString() };
        state.candidates.push(saved);
        return { changed: true, value: saved };
      }).value;
    },
    confirmCandidate(input: any) {
      shape(input, ['candidateId', 'candidateRoleHash', 'expectedRevision']);
      const candidateId = id(input.candidateId);
      if (!Number.isSafeInteger(input.expectedRevision) || !/^[a-f0-9]{64}$/.test(input.candidateRoleHash)) throw fail('wiki_candidate_invalid');
      return change(state => {
        if (state.revision !== input.expectedRevision) throw fail('wiki_revision_conflict');
        const current = state.candidates.find((c: any) => c.id === candidateId);
        if (!current || current.candidateRoleHash !== input.candidateRoleHash) throw fail('wiki_candidate_not_found');
        // Revalidate approved sources and all currently imported expectations.
        // File contents were scanned at generation and are scanned again from
        // each sealed input by the evaluation gate, never fetched from live cwd.
        resolveWikiCandidate({ ...state, candidates: [{ ...current, status: 'confirmed' }] }, current.id, current.anchor.originalRoleHash, []);
        if (current.status === 'confirmed') return { changed: false, value: current };
        current.status = 'confirmed'; current.confirmedAt = new Date().toISOString();
        return { changed: true, value: current };
      }).value;
    },
    review(input: any) {
      shape(input, ['versionId', 'entryId', 'expectedRevision', 'patch', 'decision']);
      const versionId = id(input.versionId), entryId = id(input.entryId);
      if (!Number.isSafeInteger(input.expectedRevision) || (!input.patch && !input.decision)
        || (input.decision !== undefined && !['approved', 'rejected'].includes(input.decision))) throw fail('wiki_invalid_input');
      if (input.patch !== undefined) shape(input.patch, ENTRY_FIELDS);
      return change(state => {
        if (state.revision !== input.expectedRevision) throw fail('wiki_revision_conflict');
        const version = state.versions.find((v: any) => v.id === versionId), current = version?.entries.find((e: any) => e.id === entryId);
        if (!current) throw fail('wiki_entry_not_found');
        if (current.status !== 'draft') throw fail('wiki_entry_reviewed');
        const fields = Object.fromEntries(ENTRY_FIELDS.map(k => [k, current[k]]));
        // Changing membership would invalidate whole-version coverage. This
        // minimal review editor supports prose edits only; regenerate to regroup.
        if (input.patch?.caseIds !== undefined) throw fail('wiki_membership_edit_unsupported');
        const revised = entry({ ...fields, ...input.patch }, new Set(version.caseIds));
        Object.assign(current, revised);
        if (input.decision) { current.status = input.decision; current.reviewedAt = new Date().toISOString(); }
        return { changed: true, value: current };
      }).value;
    },
  };
}
