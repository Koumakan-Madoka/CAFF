// Shared by chat-only startup migration and the first run-store migration.
// No output/error/input/session/trace columns are needed for monitoring.
export const PLANNER_TERMINAL_FILTER = `parent_task_id IS NULL
  AND kind IN ('conversation_turn', 'conversation_side_dispatch')
  AND status IN ('succeeded', 'failed', 'cancelled')`;
export const PLANNER_ROOM_EXPRESSION = `json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END, '$.conversationId')`;
export function ensurePlannerTerminalIndex(db: any) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='a2a_tasks'").get()) return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_a2a_tasks_planner_terminal ON a2a_tasks (
    ${PLANNER_ROOM_EXPRESSION}, COALESCE(ended_at, updated_at) DESC, id DESC
  ) WHERE ${PLANNER_TERMINAL_FILTER}`);
}
export function readPlannerTerminalHeader(db: any, conversationId: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='a2a_tasks'").get()) return null;
  return db.prepare(`SELECT substr(id, 1, 513) AS taskId,
    CASE WHEN json_type(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END, '$.turnId')='text'
      THEN substr(json_extract(metadata_json, '$.turnId'), 1, 513) ELSE NULL END AS turnId,
    status, substr(started_at, 1, 80) AS startedAt, substr(COALESCE(ended_at, updated_at), 1, 80) AS finishedAt
    FROM a2a_tasks WHERE ${PLANNER_TERMINAL_FILTER} AND ${PLANNER_ROOM_EXPRESSION} = ?
    ORDER BY COALESCE(ended_at, updated_at) DESC, id DESC LIMIT 1`).get(conversationId) || null;
}
