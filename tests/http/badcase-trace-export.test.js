const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { buildWikiTraceBundle } = require('../../build/server/domain/runtime/badcase-capture/wiki-trace');
const { createBadcaseWikiController } = require('../../build/server/api/badcase-wiki-controller');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-export-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source'), host: '127.0.0.1', port: 4313 };
  const store = createWikiStore(options), c = store.addMarkedCase({ source: { projectId: 'p', conversationId: 'room', conversationTitle: 'room', messageId: 'message', agentId: 'gpt' },
    role: 'GPT', actual: 'wrong', expected: 'right', message: 'reply', sealedCheckpointId: null, traceState: 'missing', traceExcerpt: '', traceTruncated: false, messageTruncated: false }).case;
  const packet = buildWikiTraceBundle({ source: c.source, origin: 'mark', frozenAt: '2026-11-05T00:00:00Z', message: { content: 'reply ``` injection <script>literal</script>' },
    checkpoint: { checkpointId: 'cp', files: { 'only-name.txt': { type: 'file', size: 42, content: 'NEVER INCLUDE FILE BYTES' } }, skipped: [{ path: 'skip' }] },
    snapshot: { archiveContext: { sections: [{ sectionKey: 'harness_prompt', content: 'saved system' }] } } });
  const controller = createBadcaseWikiController(options);
  async function get(ext, req = {}) {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(text) { this.text = text; } };
    const handled = await controller({ req: { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:4313' }, ...req }, res,
      pathname: `/api/wikiskill/cases/${c.id}/trace/export.${ext}` });
    return { handled, ...res };
  }
  return { store, c, packet, get };
}
test('JSON and Markdown downloads contain exactly the frozen packet, are read-only and scene-manifest-only', async t => {
  const h = setup(t);
  assert.equal(h.packet.scene.metadataStatus, 'missing');
  assert.ok(h.packet.missingReasons.includes('scene_git_snapshot_missing'));
  h.store.freezeCaseTrace(h.c.id, h.packet); const revision = h.store.read().revision;
  const json = await h.get('json'); assert.equal(json.handled, true); assert.equal(json.status, 200);
  assert.deepEqual(JSON.parse(json.text), h.packet); assert.match(json.headers['Content-Disposition'], /attachment;.*\.json/);
  assert.equal(json.headers['Cache-Control'], 'no-store'); assert.equal(Buffer.byteLength(json.text), json.headers['Content-Length']);
  const md = await h.get('md'); assert.equal(md.status, 200); assert.match(md.headers['Content-Type'], /text\/markdown/);
  for (const label of ['上下文', '轨迹', '现场', '包信息']) assert.ok(md.text.includes(label));
  const blocks = [...md.text.matchAll(/^(`{3,})json\n([\s\S]*?)\n\1$/gm)].map(m => JSON.parse(m[2]));
  const restored = { ...blocks[0], context: blocks[1], steps: blocks.slice(2, 2 + h.packet.steps.length), metrics: blocks.at(-2), scene: blocks.at(-1) };
  assert.deepEqual(restored, h.packet);
  assert.doesNotMatch(json.text + md.text, /NEVER INCLUDE FILE BYTES/); assert.equal(h.store.read().revision, revision);
});
test('missing packets are explicit errors, remote callers rejected and POST cannot export', async t => {
  const h = setup(t); await assert.rejects(h.get('json'), e => e.statusCode === 404 && e.issues[0].code === 'wiki_trace_missing');
  await assert.rejects(h.get('md', { socket: { remoteAddress: '10.0.0.1' } }), e => [403,404].includes(e.statusCode));
  assert.equal((await h.get('json', { method: 'POST' })).handled, false);
  assert.equal((await h.get('txt')).handled, false);
});
