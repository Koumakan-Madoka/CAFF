const test = require('node:test');
const assert = require('node:assert/strict');
const { importTextCases } = require('../../scripts/badcase-capture/import-text-cases.cjs');
const selected = (id = 'message-a') => ({ conversationId: 'room-a', messageId: id, actual: 'missing check', expected: 'verify before reporting' });
function fixture(overrides = {}) {
  const calls = [], batches = [];
  const message = { id: 'message-a', conversationId: 'room-a', role: 'assistant', agentId: 'role-family-gpt', status: 'completed', content: 'claimed done', ...overrides.message };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const u = new URL(url);
    assert.equal(u.origin, 'http://127.0.0.1:3100'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    if (u.pathname.endsWith('/tool-trace')) return new Response(JSON.stringify({ trace: { steps: [] } }), { status: overrides.traceStatus || 200 });
    if (u.pathname.endsWith('/messages')) {
      const older = u.searchParams.has('before');
      return new Response(JSON.stringify(older || !overrides.paginate ? { items: [message], hasMore: false, nextCursor: null } : { items: [], hasMore: true, nextCursor: 'older' }));
    }
    return new Response(JSON.stringify({ conversation: { id: 'room-a', title: '来源房间标题', projectScopeId: 'source-project' } }));
  };
  const store = { addTextCases(batch) { batches.push(batch); return { created: batch.length, cases: batch, revision: 1 }; } };
  return { calls, batches, store, fetchImpl };
}

test('confirmed import uses only GET on fixed 3100 API and stores text, not a replay checkpoint', async () => {
  const h = fixture({ paginate: true });
  await importTextCases({ selections: [selected()], confirmed: true, store: h.store, fetchImpl: h.fetchImpl });
  assert.equal(h.calls.length, 4); assert.equal(h.batches.length, 1);
  const c = h.batches[0][0];
  assert.equal(c.source.projectId, 'source-project'); assert.equal(c.source.messageId, 'message-a');
  assert.equal(c.source.conversationTitle, '来源房间标题');
  assert.equal(c.role, 'GPT'); assert.equal(c.message, 'claimed done'); assert.equal(c.traceState, 'available');
  assert.equal(c.checkpointId, undefined); assert.equal(c.expected, selected().expected);
  assert.deepEqual(Object.keys(h.calls[0].options).sort(), ['method', 'redirect', 'signal']);
});

test('unconfirmed or unsafe selections reject before network access or persistence', async () => {
  for (const options of [{ confirmed: false }, { selections: [{ ...selected(), messageId: '../secret' }] }, { selections: [{ ...selected(), expected: '' }] }, { selections: [{ ...selected(), origin: 'http://evil.invalid' }] }]) {
    const h = fixture();
    await assert.rejects(() => importTextCases({ selections: [selected()], confirmed: true, store: h.store, fetchImpl: h.fetchImpl, ...options }));
    assert.equal(h.calls.length, 0); assert.equal(h.batches.length, 0);
  }
});

test('missing trace is explicit, while HTTP failures do not silently become missing trace', async () => {
  const h = fixture({ traceStatus: 404 });
  await importTextCases({ selections: [selected()], confirmed: true, store: h.store, fetchImpl: h.fetchImpl });
  assert.equal(h.batches[0][0].traceState, 'missing'); assert.equal(h.batches[0][0].traceExcerpt, '');
  for (const traceStatus of [403, 500]) {
    const f = fixture({ traceStatus });
    await assert.rejects(() => importTextCases({ selections: [selected()], confirmed: true, store: f.store, fetchImpl: f.fetchImpl }));
    assert.equal(f.batches.length, 0);
  }
});

test('wrong role, ownership, nonterminal messages, secrets, and unavailable messages never import', async () => {
  for (const message of [{ agentId: 'role-family-kimi' }, { role: 'user' }, { status: 'streaming' }, { conversationId: 'other-room' }, { id: 'absent' }, { content: 'sk-FAKE_SENTINEL_123456' }]) {
    const h = fixture({ message });
    await assert.rejects(() => importTextCases({ selections: [selected()], confirmed: true, store: h.store, fetchImpl: h.fetchImpl }));
    assert.equal(h.batches.length, 0);
  }
});

test('if any requested message is unavailable, the entire import waits rather than publishing a partial batch', async () => {
  const h = fixture();
  await assert.rejects(() => importTextCases({ selections: [selected(), selected('absent')], confirmed: true, store: h.store, fetchImpl: h.fetchImpl }));
  assert.equal(h.batches.length, 0);
});

test('API import composes with the real external store and a rebuilt store keeps text-only provenance', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wiki-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { captureRoot: path.join(root, 'capture'), sourceWorktree: path.join(root, 'source'), projectId: 'collection-project' };
  const h = fixture(), store = createWikiStore(options);
  const first = await importTextCases({ selections: [selected()], confirmed: true, store, fetchImpl: h.fetchImpl });
  assert.equal(first.created, 1); assert.equal(first.cases[0].replayable, false);
  assert.equal(first.cases[0].source.projectId, 'source-project');
  const rebuilt = createWikiStore(options);
  assert.equal(rebuilt.read().cases[0].source.origin, 'http://127.0.0.1:3100');
  const repeated = await importTextCases({ selections: [selected()], confirmed: true, store: rebuilt, fetchImpl: h.fetchImpl });
  assert.equal(repeated.created, 0); assert.equal(repeated.revision, first.revision);
});

test('long public messages are explicitly excerpted, and source error bodies are never exposed', async () => {
  const h = fixture({ message: { content: '字'.repeat(20000) } });
  await importTextCases({ selections: [selected()], confirmed: true, store: h.store, fetchImpl: h.fetchImpl });
  assert.equal(h.batches[0][0].messageTruncated, true); assert.ok(Buffer.byteLength(h.batches[0][0].message) <= 32768);
  const f = fixture();
  await assert.rejects(() => importTextCases({ selections: [selected()], confirmed: true, store: f.store,
    fetchImpl: async () => new Response('private error body', { status: 500 }) }), e => e.message === 'wiki_source_unavailable');
});
