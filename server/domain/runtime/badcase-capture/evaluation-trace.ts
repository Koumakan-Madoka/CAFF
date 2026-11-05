// Explicit, versioned callback INPUT state, not Inspector data or recorded tool
// responses. No DB/path discovery, authorization, persistence or execution here.
import crypto from 'node:crypto';
import { containsSecretSentinel } from './secrets';
const fail = (code = 'evaluation_trace_invalid') => Object.assign(Error(code), { code });
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: any, keys: string[]) => object(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const text = (v: any, max: number, empty = false) => typeof v === 'string' && (empty || v.trim().length > 0)
  && Buffer.byteLength(v) <= max && !v.includes('\0') && Buffer.from(v).toString('utf8') === v;
const date = (v: any) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const associationKeys = ['projectId', 'conversationId', 'turnId', 'agentId', 'userMessageId', 'assistantMessageId'];
function sensitive(v: any, depth = 0): boolean {
  if (depth > 32) throw fail('evaluation_trace_limit');
  if (typeof v === 'string') {
    if (v.includes('\0') || Buffer.from(v).toString('utf8') !== v || containsSecretSentinel(v)
      || /\b(?:bearer\s+\S+|(?:authorization|cookie|password|passwd|secret|[A-Z0-9_]*api[_-]?key|[A-Z_]*TOKEN)\s*["']?\s*[:=]\s*["']?\S+)/iu.test(v)) return true;
    const trimmed = v.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let decoded; try { decoded = JSON.parse(trimmed); } catch { return false; }
      return sensitive(decoded, depth + 1);
    }
  } else if (Array.isArray(v)) return v.some(e => sensitive(e, depth + 1));
  else if (object(v)) {
    if (v.privateOnly === true || v.visibility === 'private' || v.role === 'private') return true;
    return Object.entries(v).some(([key, value]) => {
      const k = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      return ((/(password|passwd|secret|authorization|cookie|apikey|accesstoken|authtoken|callbacktoken|credential)/.test(k) || k === 'token')
        && value !== '' && value !== null) || sensitive(key, depth + 1) || sensitive(value, depth + 1);
    });
  }
  return false;
}
export const callbackOmissionCounts = ['privateMessages', 'delegations', 'delegationMessages', 'mediaParts', 'truncatedMessages', 'truncatedBytes', 'unsupportedMessages', 'metadataOmitted'];
export function validateCallbackOmissions(value: any) {
  if (!exact(value, [...callbackOmissionCounts, 'roomHistoryUnavailable'])
    || !callbackOmissionCounts.every(k => Number.isSafeInteger(value[k]) && value[k] >= 0)
    || typeof value.roomHistoryUnavailable !== 'boolean') throw fail();
  return value;
}

/** Trusted callers supply independently authorized pre-turn state and exact
 * association/hash. A hash is integrity, NOT proof of origin or consent. Missing
 * private/delegation/attachment semantics must never be silently approximated.
 * This v1 supports public TEXT messages only, no private state or delegations.
 */
export function prepareEvaluationCallbackTrace(raw: any, expectedHash: any, expectedAssociation: any) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4 * 1024 * 1024) throw fail('evaluation_trace_limit');
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)
    || crypto.createHash('sha256').update(raw).digest('hex') !== expectedHash) throw fail('evaluation_trace_hash_mismatch');
  let v: any; try { v = JSON.parse(raw); } catch { throw fail(); }
  const bestEffort = v?.schemaVersion === 2 && v?.kind === 'caff-evaluation-callback-input-v2';
  if (bestEffort) validateCallbackOmissions(v.omissions);
  if (!exact(v, ['schemaVersion', 'kind', 'association', 'assistantCreatedAt', 'conversation', 'participants', 'publicMessages', 'privateMessages', 'pendingDelegations', ...(bestEffort ? ['omissions'] : [])])
    || !bestEffort && (v.schemaVersion !== 1 || v.kind !== 'caff-evaluation-callback-input-v1')
    || !exact(v.association, associationKeys) || !associationKeys.every(k => id(v.association[k]))
    || !exact(expectedAssociation, associationKeys) || !associationKeys.every(k => v.association[k] === expectedAssociation[k])) throw fail('evaluation_trace_association_mismatch');
  if (!Array.isArray(v.privateMessages) || !Array.isArray(v.pendingDelegations)) throw fail();
  if (v.privateMessages.length || v.pendingDelegations.length) throw fail('evaluation_trace_state_unsupported');
  if (!exact(v.conversation, ['title', 'type', 'metadata']) || !text(v.conversation.title, 1024)
    || v.conversation.type !== 'standard' || !object(v.conversation.metadata)
    || !Array.isArray(v.participants) || v.participants.length < 1 || v.participants.length > 32
    || !Array.isArray(v.publicMessages) || v.publicMessages.length < 1 || v.publicMessages.length > 2048) throw fail();
  const agents = new Map<string, any>();
  for (const p of v.participants) {
    if (!exact(p, ['id', 'name', 'description']) || !id(p.id) || !text(p.name, 128)
      || p.name.trim() !== p.name || !text(p.description, 4096, true) || p.description.trim() !== p.description || agents.has(p.id)) throw fail();
    agents.set(p.id, p);
  }
  const active = agents.get(v.association.agentId);
  if (!active) throw fail('evaluation_trace_association_mismatch');
  const messages = new Map<string, any>(); let previous = '', previousId = '';
  for (const m of v.publicMessages) {
    if (!exact(m, ['id', 'turnId', 'role', 'agentId', 'senderName', 'content', 'status', 'createdAt',
      'publicPostedAt', 'publicPostCount', 'publicPostMode', 'mentions']) || !id(m.id) || !id(m.turnId)
      || !['user', 'assistant', 'system'].includes(m.role) || !text(m.senderName, 128) || m.senderName.trim() !== m.senderName || !text(m.content, 32768, true)
      || !['completed', 'failed', 'cancelled', 'interrupted'].includes(m.status) || !date(m.createdAt) || m.createdAt < previous
      || (m.createdAt === previous && m.id <= previousId)
      || (m.publicPostedAt !== '' && !date(m.publicPostedAt)) || !Number.isSafeInteger(m.publicPostCount)
      || m.publicPostCount < 0 || m.publicPostCount > 1000000 || !['', 'replace', 'append'].includes(m.publicPostMode)
      || !Array.isArray(m.mentions) || m.mentions.length > 32 || !m.mentions.every(id)
      || (m.role === 'assistant' ? !agents.has(m.agentId) : m.agentId !== null)
      || messages.has(m.id) || m.id === v.association.assistantMessageId) throw fail();
    messages.set(m.id, m); previous = m.createdAt; previousId = m.id;
  }
  if (!date(v.assistantCreatedAt) || v.assistantCreatedAt < previous
    || (v.assistantCreatedAt === previous && v.association.assistantMessageId <= previousId)) throw fail();
  const user = messages.get(v.association.userMessageId);
  // association.turnId belongs to the executing assistant; queued users keep
  // their original accepted-message turnId, already validated as a public row.
  if (!user || user.role !== 'user' || !user.content.trim()) throw fail('evaluation_trace_association_mismatch');
  // v2 public text is intentionally NOT classified by appearance. Its trusted
  // capture boundary redacts only known host literals; schema/hash checks stay.
  if (!bestEffort && sensitive(v)) throw fail('evaluation_trace_sensitive');
  return { trace: v, seed: { conversationId: v.association.conversationId, turnId: v.association.turnId,
    agent: { id: active.id, name: active.name }, userMessage: { id: user.id, content: user.content }, assistantMessageId: v.association.assistantMessageId },
    receipt: { kind: 'evaluation-callback-trace-receipt-v1', traceHash: expectedHash,
      association: { ...v.association }, publicMessageCount: v.publicMessages.length, participantCount: v.participants.length,
      privateStateSupported: false, faithfulReplay: false, strictEvalEligible: false,
      ...(bestEffort ? { omissions: { ...v.omissions }, roomHistoryUnavailable: v.omissions.roomHistoryUnavailable } : {}) } };
}
