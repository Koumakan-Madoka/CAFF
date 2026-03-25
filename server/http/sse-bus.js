const { randomUUID } = require('node:crypto');

function createSseBus(options = {}) {
  const keepAliveMs = Number.isFinite(options.keepAliveMs) && options.keepAliveMs > 0 ? options.keepAliveMs : 15000;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const clients = new Map();
  let nextEventId = 1;

  function writeEvent(res, eventName, payload) {
    const eventId = nextEventId;
    nextEventId += 1;

    res.write(`id: ${eventId}\n`);

    if (eventName) {
      res.write(`event: ${eventName}\n`);
    }

    const body = JSON.stringify(payload);

    for (const line of body.split('\n')) {
      res.write(`data: ${line}\n`);
    }

    res.write('\n');
  }

  function removeClient(clientId) {
    const client = clients.get(clientId);

    if (!client) {
      return;
    }

    if (client.keepAliveTimer) {
      clearInterval(client.keepAliveTimer);
    }

    clients.delete(clientId);
  }

  function broadcast(eventName, payload) {
    for (const client of clients.values()) {
      if (client.conversationId && payload && payload.conversationId && client.conversationId !== payload.conversationId) {
        continue;
      }

      try {
        writeEvent(client.res, eventName, payload);
      } catch {
        try {
          client.res.end();
        } catch {}

        removeClient(client.id);
      }
    }
  }

  function openStream(req, res, options = {}) {
    const clientId = randomUUID();
    const conversationId = String(options.conversationId || '').trim();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    const keepAliveTimer = setInterval(() => {
      try {
        writeEvent(res, 'ping', { timestamp: now() });
      } catch {}
    }, keepAliveMs);

    if (typeof keepAliveTimer.unref === 'function') {
      keepAliveTimer.unref();
    }

    const client = {
      id: clientId,
      conversationId,
      keepAliveTimer,
      res,
    };

    clients.set(clientId, client);

    for (const event of Array.isArray(options.initialEvents) ? options.initialEvents : []) {
      writeEvent(res, event && event.eventName ? event.eventName : '', event ? event.payload : null);
    }

    req.on('close', () => {
      removeClient(clientId);
    });
  }

  function closeAll() {
    for (const client of clients.values()) {
      if (client.keepAliveTimer) {
        clearInterval(client.keepAliveTimer);
      }

      try {
        client.res.end();
      } catch {}
    }

    clients.clear();
  }

  return {
    broadcast,
    closeAll,
    openStream,
    writeEvent,
  };
}

module.exports = {
  createSseBus,
};
