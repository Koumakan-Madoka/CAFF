// Operator-owned WikiSkill collection, never the chat/production database.
// globalRoot selects the project-independent store. Legacy captureRoot/projectId
// remains available to read/migrate existing collections and old replay records.
// Every mutation publishes an immutable snapshot; reviewed entries are frozen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withProjectWriteLock } from './project-write-lock';
import { containsSecretSentinel } from './secrets';
import { buildWikiCandidate, resolveWikiCandidate } from './wiki-candidate';
import { planReplaySplit } from './wiki-split';
import { validateSealRequest } from './sealed-case';
import { buildGlobalWikiCandidate, resolveGlobalWikiCandidate } from './wiki-global-candidate';

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
  const global = options?.globalRoot !== undefined;
  const root = global ? options.globalRoot : options?.captureRoot;
  if (!options || !path.isAbsolute(root || '') || !path.isAbsolute(options.sourceWorktree || '')) throw fail('wiki_root_required');
  if (global && options.projectId !== undefined) throw fail('wiki_global_project_unsupported');
  const captureRoot = path.resolve(root), projectId = global ? null : id(options.projectId);
  const sources = [options.sourceWorktree, ...(options.sourceWorktrees || [])];
  for (const source of sources) {
    if (!path.isAbsolute(source)) throw fail('wiki_root_required');
    const relative = path.relative(path.resolve(source), captureRoot);
    if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) throw fail('wiki_storage_inside_source');
  }
  // Directory ancestors are same-OS-user trusted, as in capture-store; this is
  // not a filesystem sandbox or support for symlink/path-swap configurations.
  // Wiki records embed their own text, not CAS references. Keep them outside
  // the checkpoint inventory: existing expiry/GC only owns projects/<id>/CAS.
  const directory = global ? path.join(captureRoot, 'snapshots') : path.join(captureRoot, 'wiki', projectId!, 'snapshots');
  const identity = global ? { scope: 'global' } : { projectId };
  const fresh = () => ({ schemaVersion: 1, ...identity, revision: 0, cases: [] as any[], versions: [] as any[], candidates: [] as any[], replayCases: [] as any[], replaySplit: null });
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
      if (envelope.schemaVersion !== 1 || !record || record.schemaVersion !== 1
        || (global ? record.scope !== 'global' || record.projectId !== undefined : record.projectId !== projectId)
        || record.revision !== Number(latest.slice(0, 12)) || !Number.isSafeInteger(record.revision) || record.revision < 1
        || !Array.isArray(record.cases) || !Array.isArray(record.versions) || envelope.checksum !== hash(JSON.stringify(record))) throw Error();
      // Backward-compatible read of snapshots written before candidate support.
      if (record.candidates === undefined) record.candidates = [];
      if (!Array.isArray(record.candidates)) throw Error();
      // Do not normalize legacy project records with a new field: their
      // migration checksum predates replay registration and must stay stable.
      if (record.replayCases === undefined && global) record.replayCases = [];
      if (record.replayCases !== undefined && !Array.isArray(record.replayCases)) throw Error();
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
    // Reuse the existing lock primitive under this independent root; the fixed
    // lock key is not a project association and is never stored in wiki data.
    return withProjectWriteLock(captureRoot, global ? 'global-wiki' : projectId!, () => {
      const state = read(), result = action(state);
      if (result.changed) { state.revision++; publish(state); }
      return { value: result.value, revision: state.revision };
    });
  }
  return {
    read,
    migrateProjectCollection(legacyOptions: any) {
      if (!global || legacyOptions?.globalRoot !== undefined) throw fail('wiki_migration_invalid');
      const legacy = createWikiStore(legacyOptions).read();
      if (!legacy.revision) throw fail('wiki_migration_empty');
      const migration = { projectId: legacy.projectId, revision: legacy.revision, checksum: hash(JSON.stringify(legacy)) };
      return change(state => {
        if (state.migration?.checksum === migration.checksum) return { changed: false, value: { migrated: false, migration } };
        // This MVP migrates one existing collection into a fresh global store.
        // Merging unrelated histories/ID collisions is explicitly unsupported.
        if (state.revision !== 0) throw fail('wiki_migration_conflict');
        const { projectId: oldProject, revision: oldRevision, ...content } = legacy;
        Object.assign(state, content, identity, { revision: oldRevision, migration });
        return { changed: true, value: { migrated: true, migration } };
      });
    },
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
    // Trusted operator registration, not a user report and not a claim that a
    // historical text-only source had a checkpoint. The CLI verifies the sealed
    // closure/rules first; every evaluation must verify it again before launch.
    addReplayCase(input: any) { return this.addReplayCases([input])[0]; },
    addReplayCases(inputs: any[]) {
      if (!global) throw fail('wiki_global_required');
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 20) throw fail('wiki_invalid_input');
      const contents = inputs.map(input => {
        shape(input, ['sourceCaseId', 'category', 'task', 'fixture', 'request', 'rules', 'checkpointHash']);
        const sourceCaseId = id(input.sourceCaseId), task = text(input.task, 32768);
        if (!['reproduction', 'probe', 'control'].includes(input.category)) throw fail('wiki_invalid_input');
        shape(input.fixture, ['commit', 'sourceCommit', 'sourceSubdirectory', 'filesHash']);
        const fixture = structuredClone(input.fixture);
        if (![fixture.commit, fixture.sourceCommit].every(v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v))
          || typeof fixture.filesHash !== 'string' || !/^[a-f0-9]{64}$/.test(fixture.filesHash)
          || typeof input.checkpointHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.checkpointHash)) throw fail('wiki_invalid_input');
        id(fixture.sourceSubdirectory);
        const request = validateSealRequest(structuredClone(input.request));
        const rules = structuredClone(input.rules);
        if (!rules || !['read-only-files-v1', 'file-literals-v1'].includes(rules.kind)) throw fail('wiki_invalid_input');
        return { sourceCaseId, category: input.category, task, fixture, request, rules, checkpointHash: input.checkpointHash };
      });
      return change(state => {
        if (!state.replaySplit) throw fail('wiki_replay_split_required');
        let changed = false;
        const savedCases = contents.map(content => {
          const { sourceCaseId, request } = content;
          const source = state.cases.find((c: any) => c.id === sourceCaseId);
          if (!source) throw fail('wiki_unknown_case');
          const existing = state.replayCases.find((c: any) => c.sourceCaseId === sourceCaseId);
          if (existing) {
            if (existing.contentHash !== hash(JSON.stringify(content))) throw fail('wiki_replay_conflict');
            return existing;
          }
          if (state.replayCases.some((c: any) => c.request.captureRoot === request.captureRoot
            && c.request.association.projectId === request.association.projectId
            && c.request.association.checkpointId === request.association.checkpointId)) throw fail('wiki_replay_conflict');
          const saved = { id: `replay-${hash(JSON.stringify(content))}`, kind: 'sealed-replay', replayable: true,
            ...content, contentHash: hash(JSON.stringify(content)), split: source.split, source: source.source, createdAt: new Date().toISOString() };
          state.replayCases.push(saved); changed = true;
          return saved;
        });
        return { changed, value: savedCases };
      }).value;
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
    createGlobalCandidate(input: any, expectedRevision?: number) {
      return change(state => {
        if (expectedRevision !== undefined && state.revision !== expectedRevision) throw fail('wiki_revision_conflict');
        const candidate = buildGlobalWikiCandidate(state, input);
        const existing = state.candidates.find((c: any) => c.id === candidate.id);
        if (existing) return { changed: false, value: existing };
        const saved = { ...candidate, status: 'draft', createdAt: new Date().toISOString() };
        state.candidates.push(saved);
        return { changed: true, value: saved };
      }).value;
    },
    deprecateGlobalCandidate(input: any) {
      shape(input, ['candidateId', 'candidateHash', 'expectedRevision', 'reason']);
      const candidateId = id(input.candidateId);
      if (!Number.isSafeInteger(input.expectedRevision) || !/^[a-f0-9]{64}$/.test(input.candidateHash)
        || input.reason !== 'wrong_tool_target') throw fail('wiki_candidate_invalid');
      return change(state => {
        if (state.revision !== input.expectedRevision) throw fail('wiki_revision_conflict');
        const current = state.candidates.find((c: any) => c.id === candidateId && c.kind === 'global-wiki-candidate-v1');
        if (!current || current.candidateHash !== input.candidateHash) throw fail('wiki_candidate_not_found');
        if (current.status === 'deprecated') return { changed: false, value: current };
        if (current.status !== 'draft') throw fail('wiki_candidate_invalid');
        current.status = 'deprecated'; current.deprecatedAt = new Date().toISOString(); current.deprecationReason = input.reason;
        return { changed: true, value: current };
      }).value;
    },
    confirmGlobalCandidate(input: any) {
      shape(input, ['candidateId', 'candidateHash', 'expectedRevision', 'files']);
      const candidateId = id(input.candidateId);
      if (!Number.isSafeInteger(input.expectedRevision) || !/^[a-f0-9]{64}$/.test(input.candidateHash)) throw fail('wiki_candidate_invalid');
      return change(state => {
        if (state.revision !== input.expectedRevision) throw fail('wiki_revision_conflict');
        const current = state.candidates.find((c: any) => c.id === candidateId && c.kind === 'global-wiki-candidate-v1');
        if (!current || current.candidateHash !== input.candidateHash) throw fail('wiki_candidate_not_found');
        if (current.status === 'deprecated') throw fail('wiki_candidate_deprecated');
        resolveGlobalWikiCandidate({ ...state, candidates: [{ ...current, status: 'confirmed' }] }, current.id, current.targetId, current.baseHash, input.files);
        if (current.status === 'confirmed') return { changed: false, value: current };
        current.status = 'confirmed'; current.confirmedAt = new Date().toISOString();
        return { changed: true, value: current };
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
