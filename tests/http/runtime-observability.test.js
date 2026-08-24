const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRuntimeObservabilityController,
} = require('../../build/server/api/runtime-observability-controller');

function createContext({ method = 'GET', pathname = '/api/runtime/stats' } = {}) {
  const state = { body: '', statusCode: 0, headers: {} };
  const res = {
    writeHead(statusCode, headers) {
      state.statusCode = statusCode;
      state.headers = headers || {};
    },
    end(body = '') {
      state.body = String(body || '');
    },
  };

  return {
    req: { method },
    res,
    pathname,
    requestUrl: new URL(`http://127.0.0.1${pathname}`),
    state,
  };
}

test('runtime stats endpoint returns the observability snapshot', async () => {
  const controller = createRuntimeObservabilityController({
    getSnapshot: () => ({
      timestamp: '2026-08-24T12:00:00.000Z',
      memory: {
        timestamp: '2026-08-24T12:00:00.000Z',
        heapUsedBytes: 1024,
        heapTotalBytes: 2048,
        rssBytes: 4096,
        externalBytes: 512,
        arrayBuffersBytes: 256,
      },
      counters: {
        turns: { activeTurns: 0, activeQueues: 0, activeAgentSlots: 0 },
        invocations: { activeInvocations: 0 },
        sse: {
          activeClients: 0,
          backpressuredClients: 0,
          queuedFrameBytes: 0,
          writableBytes: 0,
          disconnects: { byteBudget: 0, drainTimeout: 0 },
        },
      },
      memoryHistory: [],
    }),
  });

  const context = createContext();

  assert.equal(await controller(context), true);
  assert.equal(context.state.statusCode, 200);

  const payload = JSON.parse(context.state.body);
  assert.equal(payload.memory.rssBytes, 4096);
  assert.equal(payload.counters.turns.activeTurns, 0);
  assert.equal(payload.counters.invocations.activeInvocations, 0);
  assert.equal(payload.counters.sse.activeClients, 0);
});

test('runtime stats endpoint ignores other routes and methods', async () => {
  const controller = createRuntimeObservabilityController({
    getSnapshot: () => ({ counters: {} }),
  });

  assert.equal(await controller(createContext({ pathname: '/api/health' })), false);
  assert.equal(await controller(createContext({ pathname: '/api/runtime/other' })), false);
  assert.equal(await controller(createContext({ method: 'POST' })), false);
});

test('runtime stats endpoint fails closed when observability is not configured', async () => {
  const controller = createRuntimeObservabilityController({});
  const context = createContext();

  await assert.rejects(
    () => controller(context),
    (error) => {
      assert.equal(error.statusCode, 501);
      assert.ok(typeof error.message === 'string' && error.message.length > 0);
      return true;
    }
  );
});
