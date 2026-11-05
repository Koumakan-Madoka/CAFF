// Best-effort public TEXT projection for Git snapshots only. Never selects a
// private/delegation body or follows attachment paths. Legacy source is separate.
import crypto from 'node:crypto';
import { isRoutableConversationAgent } from '../../roles/system-actor-catalog';
import { prepareEvaluationCallbackTrace } from './evaluation-trace';
const fail = () => { throw Error('callback_source_unavailable'); };
const terminal = ['completed', 'failed', 'cancelled', 'interrupted'];
const keys = ['projectId', 'conversationId', 'turnId', 'agentId', 'userMessageId', 'assistantMessageId'];
// False for malformed/ambiguous metadata too: never load a possibly private body.
const publicRow = `CASE WHEN json_valid(metadata_json) AND json_type(metadata_json) = 'object' THEN
  COALESCE(json_extract(metadata_json, '$.privateOnly'), 0) IN (0, '')
  AND lower(trim(COALESCE(json_extract(metadata_json, '$.visibility'), ''))) <> 'private'
  AND COALESCE(json_extract(metadata_json, '$.delegationId'), '') = ''
  AND COALESCE(json_extract(metadata_json, '$.crossConversationDeliveryId'), '') = '' ELSE 0 END`;
const projection = `SELECT id, turn_id AS turnId, role, agent_id AS agentId, sender_name AS senderName,
  substr(content, -32768) AS content, length(CAST(content AS BLOB)) AS originalBytes, status, created_at AS createdAt,
  COALESCE(json_extract(metadata_json, '$.toolBridge.lastPublicPostedAt'), '') AS publicPostedAt,
  COALESCE(json_extract(metadata_json, '$.toolBridge.publicPostCount'), 0) AS publicPostCount,
  COALESCE(json_extract(metadata_json, '$.toolBridge.lastPublicMode'), '') AS publicPostMode,
  substr(COALESCE(json_extract(metadata_json, '$.mentions'), '[]'), 1, 8192) AS mentions,
  CASE WHEN json_type(metadata_json, '$.contentBlocks') = 'array' THEN
    (SELECT count(*) FROM json_each(metadata_json, '$.contentBlocks') b WHERE
      CASE WHEN b.type = 'object' THEN COALESCE(json_extract(b.value, '$.type'), '') ELSE '' END <> 'text') ELSE 0 END
  + CASE WHEN json_type(metadata_json, '$.attachments') = 'array' THEN json_array_length(metadata_json, '$.attachments') ELSE 0 END
  + CASE WHEN json_type(metadata_json, '$.imageIds') = 'array' THEN json_array_length(metadata_json, '$.imageIds') ELSE 0 END
  + CASE WHEN json_type(metadata_json, '$.images') = 'array' THEN json_array_length(metadata_json, '$.images') ELSE 0 END AS mediaParts
  FROM chat_messages`;
function tail(text: string, max: number) {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let start = bytes.length - max;
  while ((bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
export function readPublicCallbackInputV2(db: any, input: any): any {
  const room = db.prepare(`SELECT title, type, metadata_json, project_scope_id FROM chat_conversations
    WHERE id = ? AND project_scope_id = ? AND type = 'standard'`).get(input.conversationId, input.projectId);
  if (!room || room.project_scope_id !== input.projectId || room.type !== 'standard') fail();
  const assistant = db.prepare(`SELECT id, role, agent_id AS agentId, turn_id AS turnId, status, content, created_at AS createdAt,
    metadata_json FROM chat_messages WHERE conversation_id = ? AND id = ?`).get(input.conversationId, input.assistantMessageId);
  if (!assistant || assistant.role !== 'assistant' || assistant.agentId !== input.agentId || assistant.turnId !== input.turnId
    || assistant.status !== 'queued' || assistant.content !== 'Thinking...') fail();
  const meta = JSON.parse(assistant.metadata_json);
  if (meta.toolBridge?.publicPostCount || meta.toolBridge?.lastPublicPostedAt) fail();
  const before = `conversation_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))`;
  const args = [input.conversationId, assistant.createdAt, assistant.createdAt, assistant.id];
  // Compare the trusted current user snapshot before truncating its text. SQL
  // equality avoids loading a second unbounded copy of that already-owned text.
  const snapshot = input.callbackUserMessage;
  const user = db.prepare(`${projection} WHERE ${before} AND (${publicRow}) AND id = ? AND role = 'user'
    AND content = ? AND turn_id = ?`).get(...args, input.userMessageId, snapshot.content, snapshot.turnId);
  if (!user || !terminal.includes(user.status) || !['senderName', 'status', 'createdAt'].every(k => snapshot[k] === undefined || snapshot[k] === user[k])) fail();
  const participants = db.prepare(`SELECT a.id, a.name, COALESCE(a.description, '') AS description FROM chat_conversation_agents ca
    JOIN chat_agents a ON a.id = ca.agent_id WHERE ca.conversation_id = ?
    ORDER BY ca.sort_order ASC, ca.created_at ASC, a.created_at ASC LIMIT 33`).all(input.conversationId);
  if (!participants.length || participants.length > 32 || !participants.every(isRoutableConversationAgent)) fail();
  const stats = db.prepare(`SELECT count(*) AS total, COALESCE(sum(${publicRow}), 0) AS publicCount,
    COALESCE(sum(CASE WHEN json_valid(metadata_json) THEN CASE WHEN
      COALESCE(json_extract(metadata_json, '$.privateOnly'), 0) NOT IN (0, '')
      OR lower(trim(COALESCE(json_extract(metadata_json, '$.visibility'), ''))) = 'private' THEN 1 ELSE 0 END ELSE 0 END), 0) AS privateCount,
    COALESCE(sum(CASE WHEN json_valid(metadata_json) THEN CASE WHEN
      COALESCE(json_extract(metadata_json, '$.delegationId'), '') <> '' OR COALESCE(json_extract(metadata_json, '$.crossConversationDeliveryId'), '') <> '' THEN 1 ELSE 0 END ELSE 0 END), 0) AS delegationCount,
    COALESCE(sum(CASE WHEN json_valid(metadata_json) THEN CASE WHEN json_type(metadata_json) <> 'object' THEN 1 ELSE 0 END ELSE 1 END), 0) AS invalidMetadataCount
    FROM chat_messages WHERE ${before}`).get(...args);
  const omissions = { privateMessages: db.prepare('SELECT count(*) AS n FROM chat_private_messages WHERE conversation_id = ? AND created_at <= ?').get(input.conversationId, assistant.createdAt).n + stats.privateCount,
    delegations: db.prepare('SELECT count(*) AS n FROM chat_agent_delegations WHERE (requester_conversation_id = ? OR recipient_conversation_id = ?) AND created_at <= ?').get(input.conversationId, input.conversationId, assistant.createdAt).n,
    delegationMessages: stats.delegationCount, mediaParts: 0, truncatedMessages: 0, truncatedBytes: 0, unsupportedMessages: stats.invalidMetadataCount,
    metadataOmitted: 0, roomHistoryUnavailable: false };
  const candidates = db.prepare(`${projection} WHERE ${before} AND (${publicRow}) ORDER BY created_at DESC, id DESC LIMIT 2048`).all(...args);
  const messages: any[] = []; let bytes = 0;
  const add = (row: any, required = false) => {
    if (!terminal.includes(row.status)) { omissions.unsupportedMessages++; return true; }
    let mentions: any; try { mentions = JSON.parse(row.mentions); } catch { mentions = []; }
    if (!Array.isArray(mentions)) mentions = [];
    const content = tail(row.content, 32768);
    const { originalBytes, mediaParts, ...m } = row;
    Object.assign(m, { content, mentions });
    const size = Buffer.byteLength(JSON.stringify(m));
    if (!required && (messages.length >= 2048 || bytes + size > 2 * 1024 * 1024)) return false;
    messages.push(m); bytes += size; omissions.mediaParts += mediaParts;
    omissions.truncatedBytes += Math.max(0, originalBytes - Buffer.byteLength(content));
    return true;
  };
  add(user, true); // reserve current user even if newer messages fill the window
  for (const row of candidates) if (row.id !== user.id && !add(row)) break;
  omissions.truncatedMessages = Math.max(0, stats.publicCount - messages.length - (omissions.unsupportedMessages - stats.invalidMetadataCount));
  messages.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
  let metadata: any = {};
  if (Buffer.byteLength(room.metadata_json) <= 65536) { try { metadata = JSON.parse(room.metadata_json); } catch { omissions.metadataOmitted++; } }
  else omissions.metadataOmitted++;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) { metadata = {}; omissions.metadataOmitted++; }
  const association = Object.fromEntries(keys.map(k => [k, input[k]]));
  const trace = JSON.stringify({ schemaVersion: 2, kind: 'caff-evaluation-callback-input-v2', association,
    assistantCreatedAt: assistant.createdAt, conversation: { title: tail(room.title, 1024), type: room.type, metadata },
    participants, publicMessages: messages, privateMessages: [], pendingDelegations: [], omissions });
  const expectedTraceHash = crypto.createHash('sha256').update(trace).digest('hex');
  prepareEvaluationCallbackTrace(trace, expectedTraceHash, association);
  return { trace, expectedTraceHash };
}
