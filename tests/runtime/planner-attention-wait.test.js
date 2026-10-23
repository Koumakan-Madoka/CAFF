const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), test = require('node:test');
const { createPlannerAttentionWait } = require('../../build/server/domain/conversation/planner-attention-wait');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createPlannerAttentionController } = require('../../build/server/api/planner-attention-controller');
const { EventEmitter } = require('node:events');
const immediate = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-attention-wait-unit-'));
  const store = createChatAppStore({ agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const room = store.createConversation({ title: 'Wait unit', participants: ['role-family-gpt'] });
  const append = (sourceId = 'source') => store.plannerAttentionRepository.append({ conversationId: room.id,
    goalId: 'synthetic-goal', goalRevision: 1, kind: 'turn_failed', sourceId, summary: 'Synthetic failure', createdAt: new Date().toISOString() });
  return { store, room, append };
}

test('wait closes the read/subscribe gap and removes a synchronously completed subscription', async () => {
  let ready = false, subscribed = 0, removed = 0;
  const item = { sequence: 1 };
  const store = { getPlannerAttentionVersion: () => 0,
    listPlannerAttention: () => ({ items: ready ? [item] : [], nextCursor: ready ? 1 : 0, highWatermark: ready ? 1 : 0, hasMore: false }),
    subscribePlannerAttention: () => { subscribed++; ready = true; return () => { removed++; }; } };
  const service = createPlannerAttentionWait(store);
  const result = await service.wait({}, 1);
  assert.deepEqual(result.items, [item]); assert.equal(result.timedOut, false);
  assert.equal(subscribed, 1); assert.equal(removed, 1); assert.equal(service.getStats().pending, 0);
  service.close();
});

test('missing bounded wait capabilities fail closed without hydrating conversations', async () => {
  const store = { listConversations: () => { assert.fail('must not hydrate'); } };
  const service = createPlannerAttentionWait(store);
  await assert.rejects(service.wait(), e => e.statusCode === 501 && e.code === 'planner_projection_unavailable');
  assert.equal(service.getStats().pending, 0);
});

test('aborted wait releases subscription/timers and closed service cannot register more waiters', async () => {
  let listeners = 0;
  const service = createPlannerAttentionWait({ getPlannerAttentionVersion: () => 0,
    listPlannerAttention: () => ({ items: [], highWatermark: 0, nextCursor: 0, hasMore: false }),
    subscribePlannerAttention: () => { listeners++; return () => { listeners--; }; } });
  const abort = new AbortController(), pending = service.wait({}, 300, abort.signal);
  assert.equal(service.getStats().pending, 1); abort.abort(); await assert.rejects(pending);
  assert.equal(service.getStats().pending, 0); assert.equal(listeners, 0);
  service.close(); await assert.rejects(service.wait(), e => e.code === 'planner_wait_closed');
});

test('controller notices a disconnect that happened before it attached listeners', async () => {
  const req = Object.assign(new EventEmitter(), { method: 'GET', aborted: true });
  const res = Object.assign(new EventEmitter(), { destroyed: true, writableEnded: false });
  let seenAborted = false;
  const handle = createPlannerAttentionController({ store: { listPlannerAttention() {} },
    waitService: { async wait(query, timeout, signal) { seenAborted = signal.aborted; return { items: [] }; } } });
  await handle({ req, res, pathname: '/api/planner/attention/wait',
    requestUrl: new URL('http://127.0.0.1/api/planner/attention/wait'), principal: { kind: 'planner' } });
  assert.equal(seenAborted, true);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});

test('attention notifications observe only committed state; rollback publishes nothing', async t => {
  const f = fixture(t), observed = [];
  const unsubscribe = f.store.subscribePlannerAttention(() => {
    assert.equal(f.store.db.inTransaction, false);
    observed.push(f.store.listPlannerAttention().items.length);
  });
  t.after(unsubscribe);
  const version = f.store.getPlannerAttentionVersion();
  assert.throws(() => f.store.db.transaction(() => { f.append('rolled-back'); throw new Error('Synthetic rollback'); })(), /Synthetic rollback/);
  await immediate(); assert.deepEqual(observed, []); assert.equal(f.store.getPlannerAttentionVersion(), version);
  f.store.db.transaction(() => { f.append('committed'); assert.deepEqual(observed, []); })();
  await immediate(); assert.deepEqual(observed, [1]);
  assert.ok(f.store.getPlannerAttentionVersion() > version);
});

test('committed SQLite revision polling covers a missing in-process notification channel', async t => {
  const f = fixture(t);
  const service = createPlannerAttentionWait({ listPlannerAttention: query => f.store.listPlannerAttention(query),
    getPlannerAttentionVersion: () => f.store.getPlannerAttentionVersion(), subscribePlannerAttention: () => () => {} });
  t.after(() => service.close());
  const pending = service.wait({}, 1); f.append();
  const result = await pending;
  assert.equal(result.timedOut, false); assert.equal(result.items.length, 1);
  assert.equal(service.getStats().pending, 0);
});

test('resolved status waiter re-queries its original creation cursor instead of silently skipping old resolutions', async t => {
  const f = fixture(t), item = f.append();
  const service = createPlannerAttentionWait(f.store); t.after(() => service.close());
  const pending = service.wait({ after: 0, status: 'resolved' }, 1);
  f.store.resolvePlannerAttention(item.sequence, { reason: 'Reviewed', principal: { kind: 'planner', plannerId: 'local-planner', plannerName: 'Synthetic' } });
  const result = await pending;
  assert.equal(result.timedOut, false); assert.equal(result.items[0].sequence, item.sequence);
  assert.equal(result.items[0].resolution, 'acknowledged');
});
