// Trusted pre-turn SQLite source reader. This is NOT an agent authorization
// API. The caller supplies the already file-authorized, locked project policy.
// Never discover a DB/path, read private bodies, truncate history or log errors.
import crypto from 'node:crypto';
import { prepareEvaluationCallbackTrace } from './evaluation-trace';
import { isRoutableConversationAgent } from '../../roles/system-actor-catalog';
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const keys = ['projectId', 'conversationId', 'turnId', 'agentId', 'userMessageId', 'assistantMessageId'];
const unavailable = () => { throw Error('callback_source_unavailable'); };

/** Returns only a fully validated, immutable string packet or null. Permission
 * is explicit and independent of directory consent. Source queries are one
 * synchronous read transaction (no await); this is a SQLite snapshot, NOT an
 * atomic snapshot with the separately observed worktree/session.
 */
export function readPreTurnCallbackInput(store: any, input: any, policy: any): any {
  // Before touching the source DB, including its property getter.
  if (policy?.status !== 'enabled' || policy.callbackInputAuthorized !== true
    || policy.projectId !== input?.projectId || !keys.every(k => id(input?.[k]))
    || input.userMessageId === input.assistantMessageId
    || input.callbackUserMessage?.id !== input.userMessageId || !id(input.callbackUserMessage?.turnId)
    || typeof input.callbackUserMessage?.content !== 'string') return null;
  try {
    const db = store?.db;
    if (!db || db.inTransaction) return null; // never borrow a writable transaction
    return db.transaction(() => {
      // Project scope before any text or role configuration is selected. Public
      // metadata is independently authorized, bounded and later secret-scanned.
      const head = db.prepare(`SELECT id, project_scope_id, type, length(CAST(metadata_json AS BLOB)) AS bytes, length(CAST(title AS BLOB)) AS titleBytes
        FROM chat_conversations WHERE id = ?`).get(input.conversationId);
      if (!head || head.project_scope_id !== input.projectId || head.type !== 'standard' || head.bytes > 65536 || head.titleBytes > 1024) unavailable();
      // Deliberately conservative: ANY private mailbox in this Room or pending
      // delegation involving this Room blocks v1, without selecting their bodies.
      if (db.prepare('SELECT 1 FROM chat_private_messages WHERE conversation_id = ? LIMIT 1').get(input.conversationId)
        || db.prepare(`SELECT 1 FROM chat_agent_delegations WHERE (requester_conversation_id = ? OR recipient_conversation_id = ?)
          AND status IN ('queued', 'running', 'awaiting') LIMIT 1`).get(input.conversationId, input.conversationId)) unavailable();
      // Bound raw text+metadata before loading content. SQL functions inspect
      // only metadata for unsupported state. Never silently filter private rows.
      const stats = db.prepare(`SELECT COUNT(*) AS count,
        COALESCE(SUM(length(CAST(content AS BLOB)) + length(CAST(metadata_json AS BLOB))), 0) AS bytes,
        MAX(CASE WHEN json_valid(metadata_json) = 0 THEN 1 ELSE
          CASE WHEN (json_extract(metadata_json, '$.privateOnly') IS NOT NULL AND json_extract(metadata_json, '$.privateOnly') NOT IN (0, ''))
            OR lower(trim(COALESCE(json_extract(metadata_json, '$.visibility'), ''))) = 'private'
            OR (json_extract(metadata_json, '$.delegationId') IS NOT NULL AND json_extract(metadata_json, '$.delegationId') <> '')
            OR (json_extract(metadata_json, '$.crossConversationDeliveryId') IS NOT NULL AND json_extract(metadata_json, '$.crossConversationDeliveryId') <> '')
            OR json_type(metadata_json, '$.contentBlocks') NOT IN ('array', 'null')
            OR EXISTS (SELECT 1 FROM json_each(metadata_json, '$.contentBlocks') block
              WHERE COALESCE(json_extract(block.value, '$.type'), '') <> 'text')
            OR (json_extract(metadata_json, '$.attachments') IS NOT NULL AND json_extract(metadata_json, '$.attachments') NOT IN ('[]', ''))
            OR (json_extract(metadata_json, '$.imageIds') IS NOT NULL AND json_extract(metadata_json, '$.imageIds') NOT IN ('[]', ''))
            OR (json_extract(metadata_json, '$.images') IS NOT NULL AND json_extract(metadata_json, '$.images') NOT IN ('[]', ''))
          THEN 1 ELSE 0 END END) AS unsupported
        FROM chat_messages WHERE conversation_id = ?`).get(input.conversationId);
      if (!stats || stats.count < 2 || stats.count > 2049 || stats.bytes > 2 * 1024 * 1024 || stats.unsupported) unavailable();
      const people = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(a.name AS BLOB)) + length(CAST(COALESCE(a.description, '') AS BLOB))), 0) AS bytes
        FROM chat_conversation_agents ca JOIN chat_agents a ON a.id = ca.agent_id WHERE ca.conversation_id = ?`).get(input.conversationId);
      if (!people || people.count < 1 || people.count > 32 || people.bytes > 32 * (128 + 4096)) unavailable();
      const participants = db.prepare(`SELECT a.id, a.name, COALESCE(a.description, '') AS description FROM chat_conversation_agents ca
        JOIN chat_agents a ON a.id = ca.agent_id WHERE ca.conversation_id = ?
        ORDER BY ca.sort_order ASC, ca.created_at ASC, a.created_at ASC LIMIT 33`).all(input.conversationId);
      if (!participants.length || participants.length > 32 || !participants.every(isRoutableConversationAgent)) unavailable();
      const rows = db.prepare(`SELECT id, turn_id AS turnId, role, agent_id AS agentId, sender_name AS senderName, content, status, created_at AS createdAt,
        COALESCE(json_extract(metadata_json, '$.toolBridge.lastPublicPostedAt'), '') AS publicPostedAt,
        COALESCE(json_extract(metadata_json, '$.toolBridge.publicPostCount'), 0) AS publicPostCount,
        COALESCE(json_extract(metadata_json, '$.toolBridge.lastPublicMode'), '') AS publicPostMode,
        COALESCE(json_extract(metadata_json, '$.mentions'), '[]') AS mentions
        FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`).all(input.conversationId);
      const assistant = rows.find((r: any) => r.id === input.assistantMessageId);
      if (!assistant || assistant.role !== 'assistant' || assistant.agentId !== input.agentId || assistant.turnId !== input.turnId
        || assistant.status !== 'queued' || assistant.content !== 'Thinking...' || assistant.publicPostCount !== 0 || assistant.publicPostedAt !== '') unavailable();
      const messages = rows.filter((r: any) => r !== assistant).map((r: any) => ({ ...r, mentions: JSON.parse(r.mentions) }));
      const user = messages.find((r: any) => r.id === input.userMessageId);
      // Accepted-message and execution turns are distinct in queued routing.
      // Bind the user to its own executor snapshot, not the assistant's turn.
      if (!user || user.role !== 'user' || user.turnId !== input.callbackUserMessage.turnId
        || !['id', 'content', 'senderName', 'status', 'createdAt', 'turnId'].every(k => input.callbackUserMessage[k] === undefined
          || input.callbackUserMessage[k] === user[k])) unavailable();
      const room = db.prepare('SELECT title, type, metadata_json FROM chat_conversations WHERE id = ?').get(input.conversationId);
      const association = Object.fromEntries(keys.map(k => [k, input[k]]));
      const trace = JSON.stringify({ schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association,
        assistantCreatedAt: assistant.createdAt, conversation: { title: room.title, type: room.type, metadata: JSON.parse(room.metadata_json) },
        participants, publicMessages: messages, privateMessages: [], pendingDelegations: [] });
      const expectedTraceHash = crypto.createHash('sha256').update(trace).digest('hex');
      prepareEvaluationCallbackTrace(trace, expectedTraceHash, association);
      return { trace, expectedTraceHash };
    })();
  } catch { return null; } // fixed missing dimension, never raw exception/content/hash
}
