const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createAgentToolsController } = require('../../build/server/api/agent-tools-controller');
const {
  createConversationDeliveriesController,
} = require('../../build/server/api/conversation-deliveries-controller');

async function invoke(controller, options = {}) {
  const method = options.method || 'GET';
  const pathname = options.pathname || '/api/conversation-deliveries/delivery-1';
  const req = new PassThrough();
  req.method = method;
  req.headers = options.body === undefined ? {} : { 'content-type': 'application/json' };
  const state = { body: '', headers: {}, statusCode: 0 };
  const res = {
    writeHead(statusCode, headers) {
      state.statusCode = statusCode;
      state.headers = headers || {};
    },
    end(chunk = '') {
      state.body = String(chunk || '');
    },
  };
  const requestUrl = new URL(`http://127.0.0.1${pathname}`);
  const handledPromise = controller({ req, res, pathname: requestUrl.pathname, requestUrl });
  req.end(options.body === undefined ? '' : JSON.stringify(options.body));
  const handled = await handledPromise;

  return {
    handled,
    statusCode: state.statusCode,
    json: state.body ? JSON.parse(state.body) : {},
  };
}

function createStoreFixture() {
  const delivery = {
    id: 'delivery-1',
    kind: 'request',
    sourceConversationId: 'source-conversation',
    targetConversationId: 'target-conversation',
    targetMessageId: 'target-message',
    sourceReceiptMessageId: 'source-receipt',
    dispatchStatus: 'failed',
    responseStatus: 'cancelled',
  };
  const responseDelivery = {
    id: 'response-delivery',
    replyToDeliveryId: delivery.id,
    targetMessageId: 'response-message',
  };
  const messages = new Map([
    ['target-message', { id: 'target-message', role: 'external_agent' }],
    ['source-receipt', { id: 'source-receipt', role: 'system' }],
    ['response-message', { id: 'response-message', role: 'external_agent' }],
  ]);

  return {
    delivery,
    getCrossConversationDelivery(deliveryId) {
      return deliveryId === delivery.id ? delivery : null;
    },
    getCrossConversationResponseDelivery(deliveryId) {
      return deliveryId === delivery.id ? responseDelivery : null;
    },
    getMessage(messageId) {
      return messages.get(messageId) || null;
    },
    listCrossConversationDeliveryEvents(deliveryId) {
      return deliveryId === delivery.id
        ? [{ id: 1, deliveryId, eventType: 'dispatch_failed' }]
        : [];
    },
  };
}

test('agent delivery HTTP routes forward notify and request bodies to the invocation bridge', async () => {
  const calls = [];
  const controller = createAgentToolsController({
    agentToolBridge: {
      handleConversationNotify(body) {
        calls.push({ kind: 'notify', body });
        return { ok: true, delivery: { id: 'notify-delivery' } };
      },
      handleConversationRequest(body) {
        calls.push({ kind: 'request', body });
        return { ok: true, delivery: { id: 'request-delivery' } };
      },
    },
  });

  const notify = await invoke(controller, {
    method: 'POST',
    pathname: '/api/agent-tools/conversation-notify',
    body: {
      invocationId: 'invocation-1',
      callbackToken: 'token-1',
      targetConversationId: 'target-conversation',
      targetAgentId: 'target-agent',
      content: 'Notify the target.',
      idempotencyKey: 'notify-key',
    },
  });
  const request = await invoke(controller, {
    method: 'POST',
    pathname: '/api/agent-tools/conversation-request',
    body: {
      invocationId: 'invocation-1',
      callbackToken: 'token-1',
      targetConversationId: 'target-conversation',
      targetAgentId: 'target-agent',
      content: 'Request a response.',
      idempotencyKey: 'request-key',
      deadlineSeconds: 45,
    },
  });

  assert.equal(notify.statusCode, 200);
  assert.equal(request.statusCode, 200);
  assert.deepEqual(calls.map((call) => call.kind), ['notify', 'request']);
  assert.equal(calls[1].body.deadlineSeconds, 45);

  await assert.rejects(
    () => invoke(controller, {
      method: 'POST',
      pathname: '/api/agent-tools/conversation-notify',
      body: {
        invocationId: 'invocation-1',
        callbackToken: 'token-1',
        targetConversationId: 'target-conversation',
        targetAgentId: 'target-agent',
        content: 'Spoofed source must be rejected at the HTTP edge.',
        idempotencyKey: 'notify-spoofed-source',
        sourceConversationId: 'spoofed-source',
      },
    }),
    (error) => error && error.statusCode === 400
      && error.issues[0].code === 'cross_conversation_unknown_field'
  );
});

test('operator delivery GET returns the durable row, projections, response, and append-only events', async () => {
  const store = createStoreFixture();
  const controller = createConversationDeliveriesController({ store, deliveryWorker: {} });

  const response = await invoke(controller);

  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.delivery.id, 'delivery-1');
  assert.equal(response.json.targetMessage.id, 'target-message');
  assert.equal(response.json.sourceReceipt.id, 'source-receipt');
  assert.equal(response.json.responseDelivery.id, 'response-delivery');
  assert.equal(response.json.responseMessage.id, 'response-message');
  assert.deepEqual(response.json.events.map((event) => event.eventType), ['dispatch_failed']);

  await assert.rejects(
    () => invoke(controller, { pathname: '/api/conversation-deliveries/missing-delivery' }),
    (error) => error && error.statusCode === 404
      && error.issues[0].code === 'cross_conversation_delivery_not_found'
  );
});

test('operator retry and cancel validate exact bodies and delegate state transitions to the worker', async () => {
  const store = createStoreFixture();
  const calls = [];
  const available = [];
  const controller = createConversationDeliveriesController({
    store,
    deliveryWorker: {
      async retry(deliveryId, reason) {
        calls.push({ action: 'retry', deliveryId, reason });
        store.delivery.dispatchStatus = 'queued';
        return store.delivery;
      },
      async cancel(deliveryId, reason) {
        calls.push({ action: 'cancel', deliveryId, reason });
        store.delivery.dispatchStatus = 'cancelled';
        return store.delivery;
      },
    },
    onDeliveryAvailable(delivery) {
      available.push(delivery.id);
    },
  });

  const retried = await invoke(controller, {
    method: 'POST',
    pathname: '/api/conversation-deliveries/delivery-1/retry',
    body: { reason: 'Retry after a deterministic pre-start failure' },
  });
  const cancelled = await invoke(controller, {
    method: 'POST',
    pathname: '/api/conversation-deliveries/delivery-1/cancel',
    body: { reason: 'Operator cancelled the queued delivery' },
  });

  assert.equal(retried.json.delivery.dispatchStatus, 'queued');
  assert.equal(cancelled.json.delivery.dispatchStatus, 'cancelled');
  assert.deepEqual(calls.map((call) => call.action), ['retry', 'cancel']);
  assert.deepEqual(available, ['delivery-1']);

  await assert.rejects(
    () => invoke(controller, {
      method: 'POST',
      pathname: '/api/conversation-deliveries/delivery-1/retry',
      body: { reason: 'Retry', sourceConversationId: 'spoofed-source' },
    }),
    (error) => error && error.statusCode === 400 && error.issues[0].code === 'unknown_field'
  );
});
