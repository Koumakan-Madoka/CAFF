const assert = require('node:assert/strict');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { createConversationsController } = require('../../build/server/api/conversations-controller');

function request(body) {
  let payload = null;
  return {
    req: { method: 'POST' },
    res: {},
    pathname: '/api/conversations',
    requestUrl: new URL('http://localhost/api/conversations'),
    readBody: body,
    send(value) { payload = value; },
    get payload() { return payload; },
  };
}

test('conversation creation requires project and mode before persistence', async () => {
  const calls = [];
  const controller = createConversationsController({
    store: {
      createConversation() { calls.push('create'); },
      listConversations() { return []; },
    },
    modeStore: { get(id) { return id === 'coding' ? { id, skillIds: [] } : null; } },
    projectManager: { listProjects() { return [{ id: 'project-1', path: '/repo' }]; } },
    roleService: { validateConversationParticipants(input) { return input.participants; } },
  });
  const req = new PassThrough();
  req.method = 'POST';
  req.end(JSON.stringify({ title: 'Room', modeId: 'coding', participants: [{ agentId: 'a' }] }));
  const context = request({ title: 'Room', modeId: 'coding', participants: [{ agentId: 'a' }] });
  context.req = req;
  await assert.rejects(
    () => controller(context),
    (error) => error && error.code === 'room_project_required'
  );
  assert.deepEqual(calls, []);
});
