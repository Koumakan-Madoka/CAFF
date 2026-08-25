const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createSseBus } = require('../../build/server/http/sse-bus');

const KIB = 1024;
const MIB = 1024 * 1024;
const MAX_BUFFER_BYTES = 2 * MIB;

function createFakeReq() {
  return new EventEmitter();
}

function createFakeRes({ highWaterMark = 16 * KIB } = {}) {
  const res = new EventEmitter();
  res.writableLength = 0;
  res.writableEnded = false;
  res.destroyed = false;
  res.acceptedFrames = [];
  res.write = (chunk) => {
    const text = String(chunk);
    res.acceptedFrames.push(text);
    res.writableLength += Buffer.byteLength(text);
    return res.writableLength <= highWaterMark;
  };
  res.writeHead = () => {};
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null && chunk !== '') {
      res.write(chunk);
    }
    res.writableEnded = true;
  };
  res.destroy = () => {
    res.destroyed = true;
  };
  res.simulateDrain = () => {
    res.writableLength = 0;
    res.emit('drain');
  };
  return res;
}

function openClient(bus, overrides = {}) {
  const req = createFakeReq();
  const res = createFakeRes({ highWaterMark: overrides.highWaterMark });
  bus.openStream(req, res, {
    conversationId: overrides.conversationId || 'conv-1',
    initialEvents: overrides.initialEvents,
  });
  return { req, res };
}

function joinedFrames(res) {
  return res.acceptedFrames.join('');
}

function countEventFrames(res, eventName) {
  const matches = joinedFrames(res).match(new RegExp(`^event: ${eventName}\\n`, 'gm'));
  return matches ? matches.length : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('healthy burst frames are FIFO queued while blocked and flushed in order after drain', () => {
  const bus = createSseBus({ drainDeadlineMs: 5000 });
  const { res } = openClient(bus);

  // Frame A: 256KiB exceeds the 16KiB high-water mark -> write returns false -> blocked.
  bus.broadcast('data', { text: 'A'.repeat(256 * KIB) });
  assert.equal(countEventFrames(res, 'data'), 1);
  assert.equal(bus.getStats().backpressuredClients, 1);

  // While blocked, frame B must be queued, not written directly.
  bus.broadcast('data', { text: 'B'.repeat(256 * KIB) });
  assert.equal(countEventFrames(res, 'data'), 1, 'queued frame must not be written while blocked');
  const statsWhileBlocked = bus.getStats();
  assert.ok(statsWhileBlocked.queuedFrameBytes > 0, 'queued frame bytes must be accounted');
  assert.equal(statsWhileBlocked.writableBytes, res.writableLength);

  // Drain flushes the FIFO in order without duplicates. The flushed frame's
  // own write returns false again (256KiB > 16KiB hwm), so the client enters a
  // new blocked episode.
  res.simulateDrain();
  assert.equal(countEventFrames(res, 'data'), 2);

  const joined = joinedFrames(res);
  const indexA = joined.indexOf('A'.repeat(256 * KIB));
  const indexB = joined.indexOf('B'.repeat(256 * KIB));
  assert.ok(indexA !== -1 && indexB !== -1 && indexA < indexB, 'FIFO order must be preserved');
  assert.equal(bus.getStats().activeClients, 1);
  assert.equal(bus.getStats().backpressuredClients, 1);

  // Once fully drained the client is healthy again.
  res.simulateDrain();
  assert.equal(bus.getStats().backpressuredClients, 0);
  assert.equal(bus.getStats().queuedFrameBytes, 0);
  assert.equal(bus.getStats().activeClients, 1);
});

test('permanently blocked client is removed at the 2 MiB combined budget', () => {
  const bus = createSseBus();
  const { res } = openClient(bus);

  // 10 x 256KiB frames with no drain: direct write until false, then FIFO queue.
  for (let i = 0; i < 10; i += 1) {
    bus.broadcast('data', { text: 'x'.repeat(256 * KIB) });
  }

  const stats = bus.getStats();
  assert.equal(stats.activeClients, 0, 'client must be removed once the combined budget is exceeded');
  assert.equal(
    res.destroyed,
    true,
    'budget removal must physically destroy the stalled stream so its accepted writable buffer is released, not just end() it'
  );
  assert.equal(stats.disconnects.byteBudget, 1);

  // Bytes actually handed to the socket before removal stay within the budget.
  assert.ok(Buffer.byteLength(joinedFrames(res)) <= MAX_BUFFER_BYTES);
});

test('single frame larger than 2 MiB removes the client before that frame is written', () => {
  const bus = createSseBus();
  const { res } = openClient(bus);

  bus.broadcast('data', { text: 'x'.repeat(MAX_BUFFER_BYTES + 1024) });

  const stats = bus.getStats();
  assert.equal(stats.activeClients, 0);
  assert.equal(countEventFrames(res, 'data'), 0, 'oversize frame must never be written');
  assert.equal(
    res.destroyed,
    true,
    'oversize-frame removal must physically destroy the stream, not just end() it'
  );
  assert.equal(stats.disconnects.byteBudget, 1);
});

test('blocked client that never drains is removed after the drain deadline', async () => {
  const bus = createSseBus({ drainDeadlineMs: 60 });
  const { res } = openClient(bus);

  bus.broadcast('data', { text: 'x'.repeat(256 * KIB) });
  assert.equal(bus.getStats().backpressuredClients, 1);

  await delay(200);
  const stats = bus.getStats();
  assert.equal(stats.activeClients, 0, 'deadline expiry must remove the client');
  assert.equal(stats.disconnects.drainTimeout, 1);
  assert.equal(
    res.destroyed,
    true,
    'drain-deadline removal must physically destroy the stalled stream so its accepted writable buffer is released'
  );
});

test('each new blocked episode re-arms the drain deadline', async () => {
  const bus = createSseBus({ drainDeadlineMs: 120 });
  const { res } = openClient(bus);

  bus.broadcast('data', { text: 'x'.repeat(256 * KIB) });
  await delay(50);
  res.simulateDrain();
  assert.equal(bus.getStats().activeClients, 1);

  // Old deadline would have fired by now (170ms into first episode).
  await delay(120);
  assert.equal(bus.getStats().activeClients, 1, 'deadline must be cleared on drain');

  // Second blocked episode gets a fresh deadline.
  bus.broadcast('data', { text: 'y'.repeat(256 * KIB) });
  assert.equal(bus.getStats().backpressuredClients, 1);
  await delay(60);
  assert.equal(bus.getStats().activeClients, 1, 'still within the second episode window');

  await delay(150);
  const stats = bus.getStats();
  assert.equal(stats.activeClients, 0, 're-armed deadline must eventually remove the client');
  assert.equal(stats.disconnects.drainTimeout, 1);
});

test('keepalive pings share the same backpressure accounting', async () => {
  const bus = createSseBus({ keepAliveMs: 20, drainDeadlineMs: 5000 });
  const { res } = openClient(bus);

  bus.broadcast('data', { text: 'x'.repeat(256 * KIB) });
  await delay(70);

  assert.equal(countEventFrames(res, 'ping'), 0, 'pings must be queued, not written, while blocked');
  assert.ok(bus.getStats().queuedFrameBytes > 0);

  res.simulateDrain();
  assert.ok(countEventFrames(res, 'ping') >= 1, 'queued pings must flush after drain');
  assert.equal(bus.getStats().activeClients, 1);
});

test('initial events share the same backpressure accounting', () => {
  const bus = createSseBus({ drainDeadlineMs: 5000 });
  const { res } = openClient(bus, {
    highWaterMark: 16,
    initialEvents: [
      { eventName: 'first', payload: { text: 'A'.repeat(256 * KIB) } },
      { eventName: 'second', payload: { text: 'B'.repeat(256 * KIB) } },
    ],
  });

  assert.equal(countEventFrames(res, 'first'), 1);
  assert.equal(countEventFrames(res, 'second'), 0, 'second initial event must queue behind the blocked stream');

  res.simulateDrain();
  assert.equal(countEventFrames(res, 'second'), 1);
  assert.equal(bus.getStats().activeClients, 1);
});

test('broadcast still filters by conversationId', () => {
  const bus = createSseBus();
  const inScope = openClient(bus, { conversationId: 'conv-a' });
  const outOfScope = openClient(bus, { conversationId: 'conv-b' });

  bus.broadcast('data', { conversationId: 'conv-a', text: 'hello' });

  assert.ok(joinedFrames(inScope.res).includes('hello'));
  assert.ok(!joinedFrames(outOfScope.res).includes('hello'));
});

test('100 connect/close cycles leave zero clients, queues, listeners, or timers', async () => {
  const bus = createSseBus({ keepAliveMs: 10, drainDeadlineMs: 80 });
  const tracked = [];

  for (let i = 0; i < 100; i += 1) {
    const { req, res } = openClient(bus, { conversationId: `conv-${i % 3}` });
    tracked.push(res);
    if (i % 2 === 0) {
      bus.broadcast('data', { conversationId: `conv-${i % 3}`, text: 'x'.repeat(256 * KIB) });
    }
    req.emit('close');
  }

  const stats = bus.getStats();
  assert.equal(stats.activeClients, 0);
  assert.equal(stats.queuedFrameBytes, 0);
  assert.equal(stats.backpressuredClients, 0);

  for (const res of tracked) {
    assert.equal(res.listenerCount('drain'), 0, 'drain listeners must be removed');
    assert.equal(res.listenerCount('close'), 0, 'close listeners must be removed');
    assert.equal(res.listenerCount('error'), 0, 'error listeners must be removed');
  }

  // Close must clear any armed drain deadlines (no post-close timeout removals).
  await delay(250);
  const afterStats = bus.getStats();
  assert.equal(afterStats.activeClients, 0);
  assert.equal(afterStats.disconnects.drainTimeout, 0, 'armed deadlines must be cleared on close');

  bus.closeAll();
});
