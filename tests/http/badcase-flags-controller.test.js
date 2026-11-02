const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { createBadcaseFlagsController } = require('../../build/server/api/badcase-flags-controller');
const { createBadcaseFlagService } = require('../../build/server/domain/runtime/badcase-capture/badcase-flags');
const { createCaptureStore } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { createChatAppStore } = require('../../build/lib/chat-app-store');

const endpoint = '/api/projects/project-a/conversations/room-a/messages/message-a/badcase-flag';
const body = { confirmed: true, actual: 'wrong file', expected: 'selected file' };
async function invoke(controller, payload, overrides = {}) {
  const req = new PassThrough();
  req.method = payload === undefined ? 'GET' : 'POST';
  req.headers = { host: '127.0.0.1:4313', 'content-type': 'application/json', origin: 'http://127.0.0.1:4313', 'x-caff-csrf-token': 'test-csrf', ...overrides.headers };
  req.socket = { remoteAddress: overrides.remoteAddress || '127.0.0.1' };
  let result;
  const res = { writeHead(status) { this.status = status; }, end(bytes) { result = { status: this.status, body: JSON.parse(bytes) }; } };
  const pending = controller({ req, res, pathname: overrides.pathname || endpoint });
  req.end(payload === undefined ? undefined : JSON.stringify(payload));
  assert.equal(await pending, true);
  return result;
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-flag-api-'));
  const dbOptions = { agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') };
  let chat = createChatAppStore(dbOptions);
  t.after(() => { chat.close(); fs.rmSync(root, { recursive: true, force: true }); });
  chat.saveCustomRoleConfig({ id: 'agent-a', name: 'Flag test', personaPrompt: 'test' });
  chat.createConversation({ id: 'room-a', title: 'Flags', participants: ['agent-a'], projectScopeId: 'project-a' });
  const message = { id: 'message-a', conversationId: 'room-a', role: 'assistant', status: 'completed', turnId: 'turn-a', agentId: 'agent-a', runId: 101, metadata: { badcaseCheckpointId: 'checkpoint-a' }, content: 'never copy this message' };
  chat.createMessage(message);
  const captureRoot = path.join(root, 'cas');
  const captureStore = createCaptureStore({ captureRoot });
  captureStore.saveCheckpoint('project-a', { checkpointId: 'checkpoint-a', projectId: 'project-a', conversationId: 'room-a', turnId: 'turn-a', agentId: 'agent-a' });
  const options = { captureRoot, captureStore, chatStore: chat };
  const controllerOptions = { service: createBadcaseFlagService(options), projectManager: { listProjects: () => [{ id: 'project-a' }, { id: 'project-b' }] }, host: '127.0.0.1', port: 4313, csrfToken: 'test-csrf' };
  const controller = createBadcaseFlagsController(controllerOptions);
  return { root, captureRoot, captureStore, options, controllerOptions, controller, message, chat: () => chat,
    rebuild() { chat.close(); chat = createChatAppStore(dbOptions); return createBadcaseFlagsController({ ...controllerOptions, service: createBadcaseFlagService({ ...options, chatStore: chat }) }); },
    record() { const dir = path.join(captureRoot, 'projects/project-a/flags'); return path.join(dir, fs.readdirSync(dir).find(n => n.endsWith('.json'))); } };
}
const rejects = (fn, code, status = 422) => assert.rejects(fn, e => e.statusCode === status && e.issues?.[0]?.code === code);

test('API marks once, persists through SQLite/service rebuild, and never claims a seal', async t => {
  const h = setup(t);
  assert.deepEqual((await invoke(h.controller)).body, { flag: null });
  const first = await invoke(h.controller, body);
  assert.equal(first.status, 201); assert.equal(first.body.created, true);
  assert.equal(first.body.flag.runId, 101); assert.equal(first.body.flag.checkpointId, 'checkpoint-a');
  assert.equal(first.body.flag.sealState, 'pending'); assert.equal(first.body.flag.captured, false);
  const rebuilt = h.rebuild();
  assert.deepEqual((await invoke(rebuilt)).body.flag, first.body.flag);
  const second = await invoke(rebuilt, body);
  assert.equal(second.status, 200); assert.equal(second.body.created, false); assert.deepEqual(second.body.flag, first.body.flag);
  await rejects(() => invoke(rebuilt, { ...body, actual: 'different' }), 'flag_already_exists', 409);
  assert.equal(fs.readdirSync(path.dirname(h.record())).length, 1);
  assert.doesNotMatch(fs.readFileSync(h.record(), 'utf8'), /never copy this message/);
});
test('guard, confirmation and field whitelist reject before calling the flag service', async t => {
  const h = setup(t); let calls = 0;
  const controller = createBadcaseFlagsController({ ...h.controllerOptions, service: { get() { calls++; }, mark() { calls++; } } });
  await rejects(() => invoke(controller, body, { headers: { 'x-caff-csrf-token': '' } }), 'badcase_flag_csrf_invalid', 403);
  await rejects(() => invoke(controller, body, { headers: { origin: 'http://evil.invalid' } }), 'badcase_flag_origin_mismatch', 403);
  await rejects(() => invoke(controller, body, { headers: { 'content-type': 'text/plain' } }), 'badcase_flag_json_required', 415);
  await rejects(() => invoke(controller, undefined, { remoteAddress: '192.0.2.1' }), 'badcase_flag_local_only', 403);
  await rejects(() => invoke(controller, undefined, { headers: { host: 'evil.invalid' } }), 'badcase_flag_host_mismatch', 403);
  await rejects(() => invoke(controller, { ...body, confirmed: false }), 'badcase_flag_confirmation_required');
  for (const extra of [{ runId: 101 }, { checkpointId: 'checkpoint-a' }, { captured: true }, { projectId: 'project-b' }]) {
    await rejects(() => invoke(controller, { ...body, ...extra }), 'badcase_flag_unknown_field');
  }
  for (const payload of [null, [], 'text']) await rejects(() => invoke(controller, payload), 'badcase_flag_invalid_body');
  await rejects(() => invoke(controller, body, { pathname: endpoint.replace('project-a', 'absent') }), 'badcase_flag_project_missing', 404);
  assert.equal(calls, 0);
});
test('project and message association, terminal state and manifest mismatch remain server-authoritative', async t => {
  const h = setup(t);
  await rejects(() => invoke(h.controller, body, { pathname: endpoint.replace('project-a', 'project-b') }), 'flag_message_not_found', 404);
  await rejects(() => invoke(h.controller, body, { pathname: endpoint.replace('message-a', 'absent') }), 'flag_message_not_found', 404);
  h.chat().updateMessage('message-a', { status: 'streaming' });
  await rejects(() => invoke(h.controller, body), 'flag_message_not_terminal', 409);
  h.chat().updateMessage('message-a', { status: 'completed' });
  h.captureStore.loadCheckpoint = () => ({ checkpointId: 'checkpoint-a', projectId: 'project-b' });
  await rejects(() => invoke(h.controller, body), 'flag_checkpoint_mismatch', 409);
});
test('missing, throwing or absent checkpoint store permits a missing-evidence mark, not success of capture', async t => {
  for (const kind of ['missing', 'throw', 'absent']) {
    const h = setup(t);
    if (kind === 'absent') h.options.captureStore = undefined;
    else h.captureStore.loadCheckpoint = () => { if (kind === 'throw') throw new Error('private-path-must-not-leak'); return null; };
    const controller = createBadcaseFlagsController({ ...h.controllerOptions, service: createBadcaseFlagService(h.options) });
    const { flag } = (await invoke(controller, body)).body;
    assert.equal(flag.checkpointState, 'missing_or_unreadable'); assert.equal(flag.captured, false);
    assert.ok(flag.missingEvidence.includes('checkpoint_unavailable'));
  }
});
test('historical missing turn or agent is classified as incomplete, but known association mismatch still rejects', async t => {
  for (const field of ['turnId', 'agentId']) {
    const h = setup(t);
    const options = { ...h.options, chatStore: { getConversationWithoutMessages: () => ({ projectScopeId: 'project-a' }), getMessage: () => ({ ...h.message, [field]: null }) } };
    const controller = createBadcaseFlagsController({ ...h.controllerOptions, service: createBadcaseFlagService(options) });
    const { flag } = (await invoke(controller, body)).body;
    assert.equal(flag.checkpointState, 'association_incomplete'); assert.equal(flag.captured, false);
    assert.ok(flag.missingEvidence.includes('checkpoint_unavailable'));
    assert.equal(flag.checkpointId, 'checkpoint-a');
  }
  const h = setup(t);
  const options = { ...h.options, chatStore: { getConversationWithoutMessages: () => ({ projectScopeId: 'project-a' }), getMessage: () => ({ ...h.message, turnId: null }) } };
  h.captureStore.loadCheckpoint = () => ({ checkpointId: 'checkpoint-a', projectId: 'project-b' });
  await rejects(() => invoke(createBadcaseFlagsController({ ...h.controllerOptions, service: createBadcaseFlagService(options) }), body), 'flag_checkpoint_mismatch', 409);
});
test('deleted source is explicitly unavailable; API does not erase or expose orphaned flags', async t => {
  const h = setup(t); await invoke(h.controller, body); const file = h.record(); const bytes = fs.readFileSync(file);
  h.chat().deleteConversationMessages('room-a', ['message-a']);
  await rejects(() => invoke(h.controller), 'flag_message_not_found', 404);
  await rejects(() => invoke(h.controller, body), 'flag_message_not_found', 404);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
test('corrupt record yields explicit error, never absence or overwrite', async t => {
  const h = setup(t); await invoke(h.controller, body);
  const file = h.record(); fs.writeFileSync(file, '{broken');
  await rejects(() => invoke(h.controller), 'flag_record_invalid', 409);
  await rejects(() => invoke(h.controller, body), 'flag_record_invalid', 409);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('disk failure yields sanitized failure; retry creates once', async t => {
  const h = setup(t); const original = fs.linkSync;
  try {
    fs.linkSync = (from, to) => { if (String(to).startsWith(h.captureRoot)) throw Error('private-storage-path'); return original(from, to); };
    await rejects(() => invoke(h.controller, body), 'flag_write_failed', 503);
    assert.equal((await invoke(h.controller)).body.flag, null);
  } finally { fs.linkSync = original; }
  assert.equal((await invoke(h.controller, body)).status, 201);
});
test('unexpected service failures never expose raw messages or arbitrary codes', async t => {
  const h = setup(t);
  const service = { get() { throw Object.assign(Error('private-storage-path'), { code: 'flag_private-data' }); }, mark() { throw Error('private-storage-path'); } };
  const controller = createBadcaseFlagsController({ ...h.controllerOptions, service });
  for (const payload of [undefined, body]) await rejects(() => invoke(controller, payload), 'badcase_flag_unavailable', 503);
});
