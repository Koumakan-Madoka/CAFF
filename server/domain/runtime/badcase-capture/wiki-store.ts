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
import { assignPatternQuotaSplit, planReplaySplit } from './wiki-split';
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
  shape(value.source, ['origin', 'projectId', 'conversationId', 'conversationTitle', 'messageId', 'agentId']);
  const s = value.source;
  if (s.origin !== 'http://127.0.0.1:3100' || s.agentId !== 'role-family-gpt' || value.role !== 'GPT') throw fail('wiki_source_invalid');
  const source = { origin: s.origin, projectId: s.projectId === null ? null : id(s.projectId), conversationId: id(s.conversationId),
    conversationTitle: s.conversationTitle === undefined ? '' : text(s.conversationTitle, 1024, true), messageId: id(s.messageId), agentId: s.agentId };
  if (!['available', 'missing'].includes(value.traceState) || typeof value.messageTruncated !== 'boolean' || typeof value.traceTruncated !== 'boolean') throw fail('wiki_invalid_input');
  const message = text(value.message, 32768, true), traceExcerpt = text(value.traceExcerpt, 32768, true);
  if (value.traceState === 'missing' && (traceExcerpt !== '' || value.traceTruncated)) throw fail('wiki_invalid_input');
  // Text-only cases are never upgraded to replayable merely because the source
  // message happens to reference a checkpoint in a different instance.
  const identity = { origin: source.origin, projectId: source.projectId, conversationId: source.conversationId, messageId: source.messageId, agentId: source.agentId };
  return { id: `text-${hash(JSON.stringify(identity))}`, kind: 'text-only', role: 'GPT', split: 'train', replayable: false,
    source, actual: text(value.actual, 8192), expected: text(value.expected, 8192), message, traceExcerpt,
    traceState: value.traceState, messageTruncated: value.messageTruncated, traceTruncated: value.traceTruncated };
}
function markedCase(value: any) {
  shape(value, ['source', 'role', 'actual', 'expected', 'message', 'traceExcerpt', 'traceState', 'messageTruncated', 'traceTruncated', 'sealedCheckpointId', 'createdAt']);
  shape(value.source, ['projectId', 'conversationId', 'conversationTitle', 'messageId', 'agentId']);
  const s = value.source;
  const source = { origin: 'local-mark', projectId: s.projectId === null ? null : id(s.projectId), conversationId: id(s.conversationId),
    conversationTitle: text(s.conversationTitle, 1024), messageId: id(s.messageId), agentId: id(s.agentId) };
  if (!['available', 'missing'].includes(value.traceState) || typeof value.messageTruncated !== 'boolean' || typeof value.traceTruncated !== 'boolean') throw fail('wiki_invalid_input');
  const message = text(value.message, 32768, true), traceExcerpt = text(value.traceExcerpt, 32768, true);
  if (value.traceState === 'missing' && (traceExcerpt !== '' || value.traceTruncated)) throw fail('wiki_invalid_input');
  if (value.createdAt !== undefined && (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)))) throw fail('wiki_invalid_input');
  const caseId = `marked-${hash(JSON.stringify({ projectId: source.projectId, conversationId: source.conversationId, messageId: source.messageId }))}`;
  return { id: caseId, kind: 'marked-badcase', role: text(value.role, 128), split: null, replayable: false, source,
    ...(value.createdAt === undefined ? {} : { createdAt: new Date(value.createdAt).toISOString() }),
    sealedCheckpointId: value.sealedCheckpointId == null ? null : id(value.sealedCheckpointId),
    actual: text(value.actual, 8192), expected: text(value.expected, 8192), message, traceExcerpt,
    traceState: value.traceState, messageTruncated: value.messageTruncated, traceTruncated: value.traceTruncated };
}
function initialMemberships(state: any, caseId: string) {
  const version = state.versions.at(-1), memberships: any[] = [];
  for (const e of version?.entries || []) if (e.status === 'approved' && e.caseIds.includes(caseId)) {
    memberships.push({ entryId: e.id, source: 'version', at: e.reviewedAt || version.createdAt });
  }
  return { version, memberships };
}
function caseStateView(state: any, caseId: string) {
  const c = state.cases.find((item: any) => item.id === caseId);
  if (!c) throw fail('wiki_unknown_case');
  if (c.split === null) return { caseId, status: 'pending-preclassification', memberships: [], reason: '', updatedAt: c.createdAt };
  if (c.split !== 'train') {
    if (c.preclassification) {
      const confirmed = (state.classifications || []).find((v: any) => v.caseId === caseId);
      return { caseId, status: confirmed ? 'classification-confirmed' : 'classification-pending',
        memberships: confirmed?.entryId ? [{ entryId: confirmed.entryId, source: confirmed.source, at: confirmed.confirmedAt }] : [],
        reason: confirmed ? '' : c.preclassification.reason, updatedAt: confirmed?.confirmedAt || c.preclassification.createdAt };
    }
    return { caseId, status: 'holdout', memberships: [], reason: c.split === 'gate' ? '门槛用例不参与归纳' : '测试用例不参与归纳', updatedAt: c.createdAt };
  }
  const override = (state.caseStates || []).find((item: any) => item.caseId === caseId);
  if (override) return { caseId, status: override.memberships.length ? 'assigned' : override.status,
    memberships: structuredClone(override.memberships), reason: override.reason || '', updatedAt: override.updatedAt };
  const { version, memberships } = initialMemberships(state, caseId);
  if (memberships.length) return { caseId, status: 'assigned', memberships, reason: '', updatedAt: memberships.map(m => m.at).sort().at(-1) };
  const unclassified = version?.unclassified?.find((u: any) => u.caseId === caseId);
  return { caseId, status: unclassified ? 'unfit' : 'pending', memberships: [], reason: unclassified?.reason || '', updatedAt: version?.createdAt || c.createdAt };
}
function saveCaseState(state: any, value: any) {
  const index = state.caseStates.findIndex((item: any) => item.caseId === value.caseId);
  const saved = { caseId: value.caseId, status: value.status, memberships: structuredClone(value.memberships || []), reason: value.reason || '', updatedAt: value.updatedAt };
  if (index < 0) state.caseStates.push(saved); else state.caseStates[index] = saved;
}
function saveClassification(state: any, caseId: string, entryId: string | null, source: string, now: string) {
  const value = { caseId, entryId, source, confirmedAt: now };
  const i = state.classifications.findIndex((v: any) => v.caseId === caseId);
  if (i < 0) state.classifications.push(value); else state.classifications[i] = value;
}
function appendEvent(state: any, event: any) {
  const saved = { id: `event-${state.revision + 1}-${state.events.length + 1}`, createdAt: new Date().toISOString(), ...event };
  state.events.push(saved); return saved;
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
  const fresh = () => ({ schemaVersion: 1, ...identity, revision: 0, cases: [] as any[], versions: [] as any[], candidates: [] as any[], replayCases: [] as any[], replaySplit: null,
    suggestions: [] as any[], caseStates: [] as any[], inductionRuns: [] as any[], events: [] as any[], classifications: [] as any[] });
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
      for (const field of ['suggestions', 'caseStates', 'inductionRuns', 'events', 'classifications']) {
        if (record[field] === undefined) record[field] = [];
        if (!Array.isArray(record[field])) throw Error();
      }
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
        const now = new Date().toISOString(), batch: any[] = []; let created = 0, updated = 0;
        for (const candidate of normalized) {
          const existing = state.cases.find((c: any) => c.id === candidate.id);
          if (existing) {
            // The operator may have frozen this source case into the holdout
            // set. Reimport never resets that local selection to training.
            // A room title is additive display provenance, never case identity.
            if (!existing.source.conversationTitle && candidate.source.conversationTitle) {
              existing.source.conversationTitle = candidate.source.conversationTitle; updated++;
            }
            const { createdAt, split, ...content } = existing, { split: initialSplit, ...original } = candidate;
            if (JSON.stringify(content) !== JSON.stringify(original)) throw fail('wiki_case_conflict');
            batch.push(existing);
          } else {
            const saved = { ...candidate, createdAt: now }; state.cases.push(saved); batch.push(saved); created++;
          }
        }
        return { changed: created + updated > 0, value: { created, updated, cases: batch } };
      });
      return { ...result.value, revision: result.revision };
    },
    addMarkedCase(value: any) {
      if (!global) throw fail('wiki_global_required');
      const candidate = markedCase(value);
      const result = change(state => {
        const existing = state.cases.find((c: any) => c.id === candidate.id
          || (c.source.conversationId === candidate.source.conversationId && c.source.messageId === candidate.source.messageId));
        if (existing) {
          if (existing.actual !== candidate.actual || existing.expected !== candidate.expected) throw fail('wiki_case_conflict');
          // A successful seal retry can supply evidence before allocation only;
          // after freezing, neither the old group nor its inputs are rewritten.
          if (existing.split === null && !existing.sealedCheckpointId && candidate.sealedCheckpointId) {
            existing.sealedCheckpointId = candidate.sealedCheckpointId;
            return { changed: true, value: { created: false, case: existing } };
          }
          return { changed: false, value: { created: false, case: existing } };
        }
        const now = candidate.createdAt || new Date().toISOString(), saved = { ...candidate, createdAt: now };
        state.cases.push(saved);
        appendEvent(state, { type: 'case-marked', caseIds: [saved.id], split: saved.split });
        return { changed: true, value: { created: true, case: saved } };
      });
      return { ...result.value, revision: result.revision };
    },
    backfillConversationTitles(values: any[]) {
      if (!global || !Array.isArray(values) || !values.length || values.length > 1000) throw fail('wiki_invalid_input');
      const updates = values.map(value => {
        shape(value, ['conversationId', 'conversationTitle']);
        return { conversationId: id(value.conversationId), conversationTitle: text(value.conversationTitle, 1024) };
      });
      if (new Set(updates.map(u => u.conversationId)).size !== updates.length) throw fail('wiki_invalid_input');
      const result = change(state => {
        let updated = 0;
        for (const update of updates) {
          const matches = state.cases.filter((c: any) => c.source.conversationId === update.conversationId);
          if (!matches.length) throw fail('wiki_unknown_case');
          for (const c of matches) {
            if (c.source.conversationTitle === update.conversationTitle) continue;
            if (c.source.conversationTitle) throw fail('wiki_case_conflict');
            c.source.conversationTitle = update.conversationTitle; updated++;
          }
        }
        return { changed: updated > 0, value: { updated } };
      });
      return { ...result.value, revision: result.revision };
    },
    getCaseStates() {
      const state = read();
      return state.cases.map((c: any) => caseStateView(state, c.id));
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
    recordPreclassification(input: any, expectedRevision?: number) {
      return this.recordInduction(input, expectedRevision, 'preclassification');
    },
    recordInduction(input: any, expectedRevision?: number, phase = 'induction') {
      shape(input, ['caseIds', 'model', 'proof', 'results']);
      const caseIds = ids(input.caseIds), selected = new Set(caseIds);
      if (caseIds.length > 20 || input.model !== MODEL || !Array.isArray(input.results) || input.results.length !== caseIds.length) throw fail('wiki_invalid_input');
      shape(input.proof, ['inputHash', 'calls', 'cleaned', 'isolation', 'containerId']);
      if (typeof input.proof.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.proof.inputHash)
        || !Array.isArray(input.proof.calls) || input.proof.cleaned !== true) throw fail('wiki_invalid_input');
      return change(state => {
        if (expectedRevision !== undefined && state.revision !== expectedRevision) throw fail('wiki_revision_conflict');
        const preclassify = phase === 'preclassification';
        for (const caseId of caseIds) {
          const c = state.cases.find((item: any) => item.id === caseId);
          if (!c || (preclassify ? c.split !== null || c.kind !== 'marked-badcase'
            : c.split !== 'train' || caseStateView(state, caseId).status !== 'pending')) throw fail('wiki_not_pending');
        }
        // A preclassification run owns the complete pending batch, never a
        // caller-chosen subset that could change quota allocation order.
        if (preclassify && state.cases.some((c: any) => c.split === null && !selected.has(c.id))) throw fail('wiki_not_pending');
        const base = state.versions.at(-1), approved = new Set((base?.entries || []).filter((e: any) => e.status === 'approved').map((e: any) => e.id));
        const seen = new Set(), normalized = input.results.map((r: any) => {
          shape(r, ['caseId', 'kind', 'entryId', 'reason', 'confidence', 'proposal']);
          const caseId = id(r.caseId);
          if (!selected.has(caseId) || seen.has(caseId) || !['assign', 'new', 'none'].includes(r.kind)) throw fail('wiki_model_output_invalid');
          seen.add(caseId);
          const reason = text(r.reason, 2048), confidence = text(r.confidence, 32);
          if (r.kind === 'assign') {
            if (!approved.has(r.entryId) || r.proposal !== undefined) throw fail('wiki_model_output_invalid');
            return { caseId, kind: r.kind, entryId: id(r.entryId), reason, confidence };
          }
          if (r.kind === 'none') {
            if (r.entryId !== undefined || r.proposal !== undefined) throw fail('wiki_model_output_invalid');
            return { caseId, kind: r.kind, reason, confidence };
          }
          if (preclassify) {
            // Classification is not wiki induction: no new-pattern prose may
            // be learned from the still-unallocated batch.
            if (r.entryId !== undefined || r.proposal !== undefined) throw fail('wiki_model_output_invalid');
            return { caseId, kind: r.kind, reason, confidence };
          }
          const proposal = entry(r.proposal, selected);
          if (!proposal.caseIds.includes(caseId) || r.entryId !== undefined) throw fail('wiki_model_output_invalid');
          return { caseId, kind: r.kind, reason, confidence, proposal };
        });
        if (seen.size !== caseIds.length) throw fail('wiki_model_output_invalid');
        const now = new Date().toISOString();
        const run: any = { id: `induction-${state.revision + 1}-${hash(JSON.stringify({ caseIds, results: normalized, inputHash: input.proof.inputHash })).slice(0, 16)}`,
          createdAt: now, phase, model: MODEL, caseIds: [...caseIds], inputHash: input.proof.inputHash,
          calls: structuredClone(input.proof.calls), cleaned: true,
          ...(input.proof.containerId === undefined ? {} : { containerId: text(input.proof.containerId, 128) }),
          ...(input.proof.isolation === undefined ? {} : { isolation: structuredClone(input.proof.isolation) }) };
        if (preclassify) {
          const ordered = caseIds.map(k => state.cases.find((c: any) => c.id === k)).sort((a: any, b: any) =>
            a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
          for (const c of ordered) {
            const r = normalized.find((v: any) => v.caseId === c.id)!;
            let split: 'train' | 'gate' | 'test' = 'train';
            if (r.kind === 'assign' && c.sealedCheckpointId) {
              const linked = new Set(base.entries.find((e: any) => e.id === r.entryId && e.status === 'approved').caseIds);
              const counts = { train: 0, gate: 0, test: 0 };
              for (const previous of state.cases) if (Object.hasOwn(counts, previous.split)
                && (previous.preclassification?.entryId === r.entryId || linked.has(previous.id))) counts[previous.split as keyof typeof counts]++;
              split = assignPatternQuotaSplit(counts);
            }
            c.split = split;
            c.preclassification = { ...structuredClone(r), runId: run.id, createdAt: now };
            appendEvent(state, { type: 'case-preclassified', caseIds: [c.id], runId: run.id, split, kind: r.kind, reason: r.reason, ...(r.entryId ? { entryId: r.entryId } : {}) });
          }
        }
        const trainingCaseIds = caseIds.filter(k => state.cases.find((c: any) => c.id === k).split === 'train');
        let nextEntry = 1 + state.versions.flatMap((v: any) => v.entries).reduce((max: number, e: any) => {
          const match = /^entry-(\d+)$/.exec(e.id); return Math.max(max, match ? Number(match[1]) : 0);
        }, 0);
        const proposalEntries = new Map();
        for (const r of normalized.filter((item: any) => item.kind === 'new' && !preclassify)) {
          const key = JSON.stringify(r.proposal);
          if (!proposalEntries.has(key)) proposalEntries.set(key, { id: `entry-${nextEntry++}`, proposal: r.proposal, suggestionCaseIds: [] });
          proposalEntries.get(key).suggestionCaseIds.push(r.caseId);
        }
        const suggestions = normalized.filter((r: any) => !(preclassify && r.kind === 'new')).map((r: any) => {
          const proposalEntry = r.kind === 'new' ? [...proposalEntries.values()].find((p: any) => JSON.stringify(p.proposal) === JSON.stringify(r.proposal)) : null;
          return { id: `suggestion-${hash(run.id + '\0' + r.caseId + '\0' + r.kind).slice(0, 24)}`, runId: run.id, caseId: r.caseId,
            kind: r.kind, ...(r.kind === 'none' ? {} : { entryId: r.kind === 'new' ? proposalEntry.id : r.entryId }),
            reason: r.reason, confidence: r.confidence, status: 'pending', createdAt: now };
        });
        let version: any = null;
        if (proposalEntries.size) {
          const allCaseIds = [...new Set([...(base?.caseIds || []), ...trainingCaseIds])];
          const entries = structuredClone(base?.entries || []);
          for (const p of proposalEntries.values()) {
            const suggestionIds = suggestions.filter((s: any) => s.kind === 'new' && s.entryId === p.id).map((s: any) => s.id);
            entries.push({ id: p.id, ...structuredClone(p.proposal), status: 'draft', suggestionIds, createdAt: now });
          }
          const covered = new Set(entries.flatMap((e: any) => e.caseIds));
          const unclassified = allCaseIds.filter((caseId: string) => !covered.has(caseId)).map((caseId: string) => {
            const previous = base?.unclassified?.find((u: any) => u.caseId === caseId);
            const result = normalized.find((r: any) => r.caseId === caseId);
            return { caseId, reason: previous?.reason || result?.reason || '归属建议待确认' };
          });
          version = { id: `wiki-${state.revision + 1}`, createdAt: now, model: MODEL, role: base?.role || 'global', kind: 'incremental-induction',
            caseIds: allCaseIds, trainingHash: hash(JSON.stringify(allCaseIds)), entries, unclassified, inductionRunId: run.id };
          state.versions.push(version); run.versionId = version.id;
        }
        for (const r of normalized.filter((v: any) => trainingCaseIds.includes(v.caseId))) {
          const current = caseStateView(state, r.caseId);
          saveCaseState(state, { caseId: r.caseId, status: preclassify && r.kind === 'new' ? 'pending' : r.kind === 'none' ? 'unfit' : 'suggested',
            memberships: current.memberships, reason: r.reason, updatedAt: now });
        }
        state.suggestions.push(...suggestions); state.inductionRuns.push(run);
        appendEvent(state, { type: preclassify ? 'preclassification-run' : 'induction-run', runId: run.id, caseIds: [...caseIds], ...(version ? { versionId: version.id } : {}) });
        return { changed: true, value: { run, suggestions, version } };
      }).value;
    },
    resolveSuggestion(input: any) {
      shape(input, ['suggestionId', 'decision', 'expectedRevision']);
      const suggestionId = id(input.suggestionId);
      if (!['accepted', 'rejected'].includes(input.decision) || !Number.isSafeInteger(input.expectedRevision)) throw fail('wiki_invalid_input');
      return change(state => {
        if (state.revision !== input.expectedRevision) throw fail('wiki_revision_conflict');
        const suggestion = state.suggestions.find((s: any) => s.id === suggestionId);
        if (!suggestion) throw fail('wiki_suggestion_not_found');
        if (suggestion.status !== 'pending') throw fail('wiki_suggestion_resolved');
        if (suggestion.kind === 'new') throw fail('wiki_suggestion_review_required');
        const current = caseStateView(state, suggestion.caseId), now = new Date().toISOString();
        const c = state.cases.find((v: any) => v.id === suggestion.caseId);
        if (c.split !== 'train') {
          if (!c.preclassification || suggestion.kind !== 'assign') throw fail('wiki_unknown_training_case');
          if (input.decision === 'accepted') {
            if (!state.versions.at(-1)?.entries.some((e: any) => e.id === suggestion.entryId && e.status === 'approved')) throw fail('wiki_entry_not_found');
            saveClassification(state, c.id, suggestion.entryId, 'model-confirmed', now);
          }
          suggestion.status = input.decision; suggestion.resolvedAt = now;
          appendEvent(state, { type: input.decision === 'accepted' ? 'classification-confirmed' : 'classification-rejected', caseIds: [c.id], suggestionId, entryId: suggestion.entryId });
          return { changed: true, value: suggestion };
        }
        if (input.decision === 'accepted' && suggestion.kind === 'assign') {
          const approved = state.versions.at(-1)?.entries.some((e: any) => e.id === suggestion.entryId && e.status === 'approved');
          if (!approved) throw fail('wiki_entry_not_found');
          if (!current.memberships.some((m: any) => m.entryId === suggestion.entryId)) current.memberships.push({ entryId: suggestion.entryId, source: 'model-confirmed', at: now });
          current.status = 'assigned'; current.reason = '';
        } else if (input.decision === 'accepted' && suggestion.kind === 'none') current.status = 'unfit';
        else { current.status = current.memberships.length ? 'assigned' : 'pending'; current.reason = input.decision === 'rejected' ? '建议已否决，可手动归入或重新归纳' : current.reason; }
        current.updatedAt = now; saveCaseState(state, current);
        suggestion.status = input.decision; suggestion.resolvedAt = now;
        appendEvent(state, { type: input.decision === 'accepted' ? 'suggestion-confirmed' : 'suggestion-rejected', suggestionId, caseIds: [suggestion.caseId], ...(suggestion.entryId ? { entryId: suggestion.entryId } : {}) });
        return { changed: true, value: suggestion };
      }).value;
    },
    assignCase(input: any) {
      shape(input, ['caseId', 'entryId', 'expectedRevision']);
      const caseId = id(input.caseId);
      if (input.entryId !== null) id(input.entryId);
      if (!Number.isSafeInteger(input.expectedRevision)) throw fail('wiki_invalid_input');
      return change(state => {
        if (state.revision !== input.expectedRevision) throw fail('wiki_revision_conflict');
        const current = caseStateView(state, caseId);
        if (current.status === 'holdout') throw fail('wiki_unknown_training_case');
        if (current.status === 'pending-preclassification') throw fail('wiki_not_pending');
        const now = new Date().toISOString();
        const c = state.cases.find((v: any) => v.id === caseId);
        if (c.split !== 'train') {
          if (!c.preclassification) throw fail('wiki_unknown_training_case');
          if (input.entryId !== null && !state.versions.at(-1)?.entries.some((e: any) => e.id === input.entryId && e.status === 'approved')) throw fail('wiki_entry_not_found');
          saveClassification(state, caseId, input.entryId, 'manual', now);
          for (const suggestion of state.suggestions.filter((s: any) => s.caseId === caseId && s.status === 'pending')) { suggestion.status = 'rejected'; suggestion.resolvedAt = now; }
          appendEvent(state, { type: 'classification-confirmed', caseIds: [caseId], entryId: input.entryId, source: 'manual' });
          return { changed: true, value: caseStateView(state, caseId) };
        }
        if (input.entryId === null) {
          current.memberships = []; current.status = 'pending'; current.reason = '已手动移出模式';
        } else {
          const approved = state.versions.at(-1)?.entries.some((e: any) => e.id === input.entryId && e.status === 'approved');
          if (!approved) throw fail('wiki_entry_not_found');
          current.memberships = [{ entryId: input.entryId, source: 'manual', at: now }]; current.status = 'assigned'; current.reason = '';
        }
        current.updatedAt = now; saveCaseState(state, current);
        appendEvent(state, { type: input.entryId === null ? 'manual-removed' : 'manual-assigned', caseIds: [caseId], ...(input.entryId ? { entryId: input.entryId } : {}) });
        return { changed: true, value: caseStateView(state, caseId) };
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
        if (state.cases.some((c: any) => c.kind === 'marked-badcase' && plan.caseIds.includes(c.id))) throw fail('wiki_split_frozen');
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
        || !['wrong_tool_target', 'multiple_patterns'].includes(input.reason)) throw fail('wiki_candidate_invalid');
      return change(state => {
        if (state.revision !== input.expectedRevision) throw fail('wiki_revision_conflict');
        const current = state.candidates.find((c: any) => c.id === candidateId && c.kind === 'global-wiki-candidate-v1');
        if (!current || current.candidateHash !== input.candidateHash) throw fail('wiki_candidate_not_found');
        if (input.reason === 'multiple_patterns' && current.entryIds.length <= 1) throw fail('wiki_candidate_invalid');
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
        if (input.decision) {
          current.status = input.decision; current.reviewedAt = new Date().toISOString();
          // A model-proposed pattern still uses the normal draft review API.
          // Only its approval confirms the associated membership suggestions.
          for (const suggestionId of current.suggestionIds || []) {
            const suggestion = state.suggestions.find((s: any) => s.id === suggestionId && s.kind === 'new');
            if (!suggestion || suggestion.status !== 'pending') continue;
            const now = current.reviewedAt, view = caseStateView(state, suggestion.caseId);
            if (input.decision === 'approved') {
              if (!view.memberships.some((m: any) => m.entryId === current.id)) view.memberships.push({ entryId: current.id, source: 'model-confirmed', at: now });
              view.status = 'assigned'; view.reason = '';
            } else {
              view.memberships = view.memberships.filter((m: any) => m.entryId !== current.id);
              view.status = view.memberships.length ? 'assigned' : 'pending'; view.reason = '新模式草稿已驳回';
            }
            view.updatedAt = now; saveCaseState(state, view);
            suggestion.status = input.decision === 'approved' ? 'accepted' : 'rejected'; suggestion.resolvedAt = now;
            appendEvent(state, { type: input.decision === 'approved' ? 'suggestion-confirmed' : 'suggestion-rejected', suggestionId, caseIds: [suggestion.caseId], entryId: current.id });
          }
        }
        return { changed: true, value: current };
      }).value;
    },
  };
}
