const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  createConversationPlanController,
} = require('../../build/server/api/conversation-plan-controller');

async function invoke(controller, options = {}) {
  const pathname = options.pathname || '/api/conversations/root/plan';
  const req = new PassThrough();
  req.method = options.method || 'GET';
  req.headers = { 'content-type': 'application/json' };
  const state = { body: '', statusCode: 0 };
  const res = {
    writeHead(statusCode) {
      state.statusCode = statusCode;
    },
    end(chunk = '') {
      state.body = String(chunk || '');
    },
  };
  const requestUrl = new URL(`http://127.0.0.1${pathname}`);
  const handledPromise = controller({ req, res, pathname: requestUrl.pathname, requestUrl });
  req.end(JSON.stringify(options.body || {}));
  const handled = await handledPromise;

  return {
    handled,
    statusCode: state.statusCode,
    json: state.body ? JSON.parse(state.body) : {},
  };
}

function samplePlan() {
  return {
    id: 'plan-1',
    ownerConversationId: 'root',
    status: 'draft',
    version: 1,
    doc: { nodes: [{ id: 'n1', title: 'Design', goal: 'g', status: 'pending', depends_on: [] }] },
    activatedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('plan controller: GET returns the tree-shared plan', async () => {
  const calls = [];
  const controller = createConversationPlanController({
    store: {
      getPlanForConversation(conversationId) {
        calls.push(conversationId);
        return { ownerConversationId: 'root', plan: samplePlan() };
      },
    },
  });

  const response = await invoke(controller, { pathname: '/api/conversations/child/plan' });
  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0], 'child');
  assert.equal(response.json.plan.id, 'plan-1');
  assert.equal(response.json.ownerConversationId, 'root');
});

test('plan controller: GET on unrelated paths is not handled', async () => {
  const controller = createConversationPlanController({ store: {} });
  const response = await invoke(controller, { pathname: '/api/conversations/root' });
  assert.equal(response.handled, false);
});

test('plan controller: PUT validates body and broadcasts the update', async () => {
  const calls = [];
  const events = [];
  const controller = createConversationPlanController({
    store: {
      savePlanForConversation(conversationId, payload) {
        calls.push({ conversationId, payload });
        return { ownerConversationId: 'root', plan: { ...samplePlan(), version: 2 }, warnings: [] };
      },
    },
    broadcastEvent(eventName, payload) {
      events.push({ eventName, payload });
    },
  });

  const doc = { nodes: [{ id: 'n1', depends_on: [] }] };
  const response = await invoke(controller, {
    method: 'PUT',
    body: { doc, version: 1 },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls[0], { conversationId: 'root', payload: { doc, version: 1 } });
  assert.equal(response.json.plan.version, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventName, 'conversation_plan_updated');
  assert.equal(events[0].payload.plan.version, 2);
});

test('plan controller: PUT rejects unknown fields and missing doc', async () => {
  const controller = createConversationPlanController({
    store: {
      savePlanForConversation() {
        throw new Error('should not be called');
      },
    },
  });

  await assert.rejects(
    invoke(controller, { method: 'PUT', body: { doc: {}, bogus: 1 } }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    invoke(controller, { method: 'PUT', body: { version: 1 } }),
    (error) => error.statusCode === 400
  );
});

test('plan controller: activate and revert delegate and broadcast', async () => {
  const calls = [];
  const events = [];
  const controller = createConversationPlanController({
    store: {
      activatePlanForConversation(conversationId) {
        calls.push(['activate', conversationId]);
        return { ownerConversationId: 'root', plan: { ...samplePlan(), status: 'active', version: 2 } };
      },
      revertPlanForConversation(conversationId) {
        calls.push(['revert', conversationId]);
        return { ownerConversationId: 'root', plan: { ...samplePlan(), status: 'draft', version: 3 } };
      },
    },
    broadcastEvent(eventName, payload) {
      events.push({ eventName, payload });
    },
  });

  const activated = await invoke(controller, {
    method: 'POST',
    pathname: '/api/conversations/child/plan/activate',
  });
  assert.equal(activated.statusCode, 200);
  assert.equal(activated.json.plan.status, 'active');

  const reverted = await invoke(controller, {
    method: 'POST',
    pathname: '/api/conversations/child/plan/revert',
  });
  assert.equal(reverted.statusCode, 200);
  assert.equal(reverted.json.plan.status, 'draft');

  assert.deepEqual(calls, [['activate', 'child'], ['revert', 'child']]);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.eventName === 'conversation_plan_updated'));
});

test('plan controller: wrong method on plan action is not handled', async () => {
  const controller = createConversationPlanController({ store: {} });
  const response = await invoke(controller, {
    method: 'GET',
    pathname: '/api/conversations/root/plan/activate',
  });
  assert.equal(response.handled, false);
});

test('plan controller: mutations pass the trusted user actor (D15 REST channel)', async () => {
  const calls = [];
  const controller = createConversationPlanController({
    store: {
      savePlanForConversation(conversationId, payload, options) {
        calls.push(['save', conversationId, options]);
        return { ownerConversationId: 'root', plan: samplePlan(), warnings: [] };
      },
      activatePlanForConversation(conversationId, actor) {
        calls.push(['activate', conversationId, actor]);
        return { ownerConversationId: 'root', plan: { ...samplePlan(), status: 'active', version: 2 } };
      },
      revertPlanForConversation(conversationId, actor) {
        calls.push(['revert', conversationId, actor]);
        return { ownerConversationId: 'root', plan: samplePlan() };
      },
    },
  });

  await invoke(controller, { method: 'PUT', body: { doc: { nodes: [] }, version: 1 } });
  await invoke(controller, { method: 'POST', pathname: '/api/conversations/root/plan/activate' });
  await invoke(controller, { method: 'POST', pathname: '/api/conversations/root/plan/revert' });

  assert.deepEqual(calls[0], ['save', 'root', { actor: { type: 'user' } }]);
  assert.deepEqual(calls[1], ['activate', 'root', { type: 'user' }]);
  assert.deepEqual(calls[2], ['revert', 'root', { type: 'user' }]);
});
