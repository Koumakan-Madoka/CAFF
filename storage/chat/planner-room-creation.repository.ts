import { createHttpError } from '../../server/http/http-errors';
const { readConversationTitleSource } = require('../../lib/conversation-title-source');

type Retry = { plannerId: string; key: string; digest: string };
export function createPlannerRoomCreationRepository(db: any) {
  const get = db.prepare(`SELECT r.*, c.id AS live_room_id FROM chat_planner_room_creations r
    LEFT JOIN chat_conversations c ON c.id=r.conversation_id WHERE r.planner_id=@plannerId AND r.idempotency_key=@key`);
  const insert = db.prepare(`INSERT INTO chat_planner_room_creations
    (planner_id,idempotency_key,request_digest,conversation_id,response_json,created_at)
    VALUES (@plannerId,@key,@digest,@conversationId,@responseJson,@createdAt)`);
  function validate(retry: Retry) {
    if (!retry || typeof retry.plannerId !== 'string' || !retry.plannerId.trim()
      || typeof retry.key !== 'string' || !retry.key.trim() || retry.key.length > 200 || !/^[a-f0-9]{64}$/.test(retry.digest)) {
      throw new Error('Invalid internal planner Room creation retry context');
    }
  }
  function replay(retry: Retry) {
    validate(retry);
    const row = get.get(retry); if (!row) return null;
    if (row.request_digest !== retry.digest) {
      throw createHttpError(409, 'Room creation key was used for different caller intent', { code: 'idempotency_key_conflict' });
    }
    if (row.deleted_at || !row.live_room_id) {
      throw createHttpError(410, 'Previously created conversation was deleted', { code: 'conversation_gone' });
    }
    return { replayed: true, response: JSON.parse(row.response_json) };
  }
  const create = db.transaction((retry: Retry, createRoom: () => any) => {
    const old = replay(retry); if (old) return old;
    const room = createRoom();
    const response = { conversationId: room.id, title: room.title, titleSource: readConversationTitleSource(room.metadata),
      projectScopeId: room.projectScopeId, modeId: room.type };
    insert.run({ ...retry, conversationId: room.id, responseJson: JSON.stringify(response), createdAt: new Date().toISOString() });
    return { replayed: false, response };
  });
  return {
    replay,
    // Acquire the write lock BEFORE the second lookup. Independent connections
    // cannot both miss the key and commit different Rooms. Nested Room/roster
    // writes are savepoints on this same connection, not an after-commit receipt.
    create(retry: Retry, createRoom: () => any) { return create.immediate(retry, createRoom); },
  };
}
