// Lifecycle-only reconciliation. The caller must own the database exclusively
// and stop admission/settle live writers before invoking this transaction.
export function reconcileInterruptedRuns(db: any, reason: string, failMessage: (id: string) => void,
  terminalTask?: (before: any, next: any, interrupted: boolean) => void) {
  return db.transaction(() => {
    const endedAt = new Date().toISOString();
    const messages = db.prepare(`
      SELECT id, task_id, run_id FROM chat_messages
      WHERE role = 'assistant' AND status IN ('queued', 'running', 'streaming')
    `).all();
    // A new chat database need not have run tables yet. Do not create or alter
    // any schema solely for reconciliation.
    const hasTable = (name: string) => Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(name));
    const runs = hasTable('runs')
      ? db.prepare("SELECT id, task_id FROM runs WHERE status = 'running'").all()
      : [];
    const runIds = Array.from(new Set([
      ...runs.map((run: any) => run.id), ...messages.map((message: any) => message.run_id).filter(Boolean),
    ]));
    const taskIds = Array.from(new Set([
      ...runs.map((run: any) => run.task_id), ...messages.map((message: any) => message.task_id),
    ].filter(Boolean)));

    for (const message of messages) failMessage(message.id);

    if (runs.length > 0) {
      db.prepare(`UPDATE runs SET status = 'failed', error_message = ?, ended_at = ?
        WHERE status = 'running'`).run(reason, endedAt);
    }

    let tasks = 0;
    if (hasTable('a2a_tasks')) {
      // Include root/parent tasks, not just the leaf reply task. Recovery may
      // already have finalized a stale side reply before its run was created;
      // that message's still-active task must also be settled. UNION (rather
      // than UNION ALL) also bounds malformed cyclic parent links.
      const changedTasks = db.prepare(`
        WITH RECURSIVE linked(id, parent_task_id) AS (
          SELECT id, parent_task_id FROM a2a_tasks
          WHERE id IN (SELECT value FROM json_each(@taskIds))
             OR run_id IN (SELECT value FROM json_each(@runIds))
             OR (status IN ('queued', 'running') AND id IN (
               SELECT task_id FROM chat_messages WHERE role = 'assistant' AND task_id IS NOT NULL
             ))
          UNION
          SELECT parent.id, parent.parent_task_id FROM a2a_tasks parent
          JOIN linked child ON child.parent_task_id = parent.id
        )
        UPDATE a2a_tasks SET status = 'failed', error_message = @reason,
          ended_at = @endedAt, updated_at = @endedAt
        WHERE status IN ('queued', 'running') AND id IN (SELECT id FROM linked)
        RETURNING id, kind, status, metadata_json, artifact_summary_json, ended_at
      `).all({ taskIds: JSON.stringify(taskIds), runIds: JSON.stringify(runIds), reason, endedAt });
      tasks = changedTasks.length;
      for (const next of changedTasks) terminalTask?.({ ...next, status: 'running' }, next, true);
    }
    return { messages: messages.length, runs: runs.length, tasks };
  })();
}
