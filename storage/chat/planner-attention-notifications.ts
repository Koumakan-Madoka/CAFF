import * as path from 'node:path';

// Subscriptions own the only strong listener references. File channels are
// shared across SQLite connections; in-memory databases use object identity.
type Subscription = { db: any; callback: () => void };
const files = new Map<string, Set<Subscription>>();
const memory = new WeakMap<object, Set<Subscription>>();
const pending = new WeakMap<object, number>();
function fileKey(db: any) {
  if (!db.name || db.name === ':memory:') return null;
  const name = path.resolve(db.name);
  return process.platform === 'win32' ? name.toLowerCase() : name;
}
function listeners(db: any, create = false) {
  const key = fileKey(db), collection = key ? files.get(key) : memory.get(db);
  if (collection || !create) return collection;
  const next = new Set<Subscription>();
  if (key) files.set(key, next); else memory.set(db, next);
  return next;
}
export function subscribePlannerAttention(db: any, callback: () => void) {
  const collection = listeners(db, true)!;
  const subscription = { db, callback };
  collection.add(subscription);
  return () => {
    collection.delete(subscription);
    if (!collection.size) { const key = fileKey(db); if (key) files.delete(key); else memory.delete(db); }
  };
}
export function plannerAttentionVersion(db: any): number {
  return Number(db.prepare('SELECT revision FROM chat_planner_attention_changes WHERE singleton=1').get().revision);
}
export function notifyPlannerAttentionAfterCommit(db: any) {
  const expected = plannerAttentionVersion(db);
  if (pending.has(db)) { pending.set(db, Math.min(pending.get(db)!, expected)); return; }
  pending.set(db, expected);
  queueMicrotask(() => {
    const minimum = pending.get(db)!; pending.delete(db);
    // All synchronous outer transactions have returned by this microtask.
    // A rollback restores the revision too, so it cannot publish a wakeup.
    for (const subscription of [...(listeners(db) || [])]) {
      const reader = subscription.db;
      // The producer may already be closed. Verify commit through each live
      // subscriber connection rather than trusting a closed writer's state.
      if (reader.open && !reader.inTransaction && plannerAttentionVersion(reader) >= minimum) subscription.callback();
    }
  });
}
